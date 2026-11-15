import { existsSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { DEFAULT_POLICY, isBackupDue, resetSchemaSql, type BackupPolicy, type BackupTarget, type RestorePart, type RestoreTarget } from "@nexus/backups";
import { NexusError } from "@nexus/shared";
import { DatabaseAccountManager } from "@nexus/database";
import type { NexusContext } from "../context";
import type { AppManager, AppRecord } from "./apps";

/**
 * Backup orchestration: builds what to back up for each app, runs scheduled backups
 * (catching up after the computer was off), applies retention, and performs restores
 * with the app safely stopped.
 */
export class BackupService {
  private timer: NodeJS.Timeout | null = null;
  private running = new Set<string>();

  constructor(
    private readonly ctx: NexusContext,
    private readonly apps: AppManager,
  ) {}

  policy(appId: string): BackupPolicy {
    return this.ctx.backups!.policy(appId, DEFAULT_POLICY);
  }

  target(appId: string): BackupTarget {
    const app = this.apps.require(appId);
    if (app.dataMode === "external") throw NexusError.conflict("This app uses an external database. Nexus cannot label its backup complete without a supported database export. Back up that database with its provider before relying on this app's recovery.");
    const db = app.databaseId ? this.ctx.databases?.get(app.databaseId) : null;
    const docDb = app.documentDatabaseId ? this.ctx.documents?.get(app.documentDatabaseId) : null;
    const secrets: Record<string, string> = {};
    for (const s of this.ctx.vault.list(`app:${appId}`)) secrets[s.name] = this.ctx.vault.get(s.name)!;
    const storageObjects = this.ctx.store.all<{ id: string; app_id: string }>("SELECT * FROM storage_objects WHERE app_id = ?", [appId]);
    return {
      appId,
      appName: app.name,
      database: db ? { dbName: db.dbName } : null,
      documents: docDb
        ? {
            dbName: docDb.dbName,
            exportTo: async (dir: string) => {
              await this.ctx.startDocuments();
              return this.ctx.documentBrowser!.exportDatabase(docDb.id, dir);
            },
          }
        : null,
      fileDirs: [
        ...(this.ctx.dataPaths ? [{ name: "storage", path: join(this.ctx.dataPaths.files, appId), snapshot: true }] : []),
        ...(this.ctx.deployments ? [{ name: "application", path: this.ctx.deployments.appDir(appId), snapshot: true }] : []),
      ],
      // Everything needed to rebuild the app elsewhere; protected by backup encryption.
      config: {
        app, secrets,
        appRoot: this.ctx.deployments?.appDir(appId),
        deployments: this.ctx.store.all("SELECT * FROM deployments WHERE app_id = ?", [appId]),
        storageObjects,
        githubSource: this.ctx.settings.get(`githubSource:${appId}`, null),
      },
      validateFiles: (directory) => {
        for (const object of storageObjects) if (!existsSync(join(directory, "storage", "objects", object.id.slice(0, 2), object.id))) {
          throw new Error("An uploaded file was removed while the backup was being created. Retry the backup.");
        }
      },
    };
  }

  expectedContents(appId: string) {
    const app = this.apps.require(appId);
    return { database: !!app.databaseId || !!app.documentDatabaseId, files: !!this.ctx.dataPaths && existsSync(join(this.ctx.dataPaths.files, appId)), config: true, application: !!this.ctx.deployments?.current(appId) };
  }

  async backupNow(appId: string, trigger: "manual" | "scheduled" = "manual") {
    if (!this.ctx.backups) throw NexusError.conflict("Backups are not available yet.");
    if (this.running.has(appId)) throw NexusError.conflict("A backup of this application is already running.");
    this.running.add(appId);
    let unlock: (() => void) | undefined;
    try {
      unlock = this.apps.lockForBackup(appId);
      const b = await this.ctx.backups.backup(this.target(appId), trigger);
      const policy = this.policy(appId);
      this.ctx.backups.applyRetention(appId, policy.retention, new Date(), policy.replacePrevious ?? true);
      const app = this.apps.require(appId);
      if (trigger === "manual") this.ctx.activity.add("success", `${app.name} backup completed.`, appId);
      return b;
    } catch (e) {
      this.ctx.activity.add("problem", `${this.apps.get(appId)?.name ?? appId} backup failed: ${(e as Error).message}`, appId);
      throw e;
    } finally {
      unlock?.();
      this.running.delete(appId);
    }
  }

  /** Stops the app, restores the chosen parts, re-applies configuration, starts the app again. */
  async restore(appId: string, backupId: string, parts: RestorePart[] | "entire", confirmation: string) {
    const app = this.apps.require(appId);
    const b = this.ctx.backups!.require(backupId);
    if (b.appId !== appId) throw NexusError.notFound("Restore point");
    const db = app.databaseId ? this.ctx.databases?.get(app.databaseId) : null;
    const docDb = app.documentDatabaseId ? this.ctx.documents?.get(app.documentDatabaseId) : null;
    const target: RestoreTarget = {
      current: this.target(appId),
      fileDirs: this.target(appId).fileDirs,
      validateConfig: (saved) => {
        if (saved.deployments) this.restoreDeploymentState(appId, saved, true);
        if (Array.isArray(saved.storageObjects) && saved.storageObjects.some((row) => !row || row.app_id !== appId)) throw NexusError.invalid("The backup contains another application's uploads.");
        if (saved.app && (saved.app as AppRecord).id !== appId) throw NexusError.invalid("The backup contains another application's settings.");
      },
      documents: docDb
        ? {
            dbName: docDb.dbName,
            importFrom: async (dir: string) => {
              await this.ctx.startDocuments();
              return this.ctx.documentBrowser!.importDatabase(docDb.id, dir);
            },
          }
        : null,
      database: db
        ? {
            dbName: db.dbName,
            ownerRole: db.ownerRole,
            reset: async () => {
              const c = await this.ctx.postgres!.adminClient(db.dbName);
              try {
                await c.query(
                  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()",
                );
                for (const sql of resetSchemaSql(db.ownerRole, db.readonlyRole, (s) => c.escapeIdentifier(s))) await c.query(sql);
              } finally {
                await c.end();
              }
            },
          }
        : null,
    };
    const wasRunning = this.apps.status(appId) === "running";
    const unlock = this.apps.lockForBackup(appId);
    try {
      await this.apps.stop(appId);
      const result = await this.ctx.restore!.restore(backupId, parts, target, confirmation);
      if (db && result.restored.includes("database")) await new DatabaseAccountManager(this.ctx.store, this.ctx.vault, this.ctx.postgres!, this.ctx.databases!).reapply(db.id);
      const archived = result.applicationConfig ?? result.config;
      if (result.applicationConfig) this.restoreDeploymentState(appId, result.applicationConfig);
      if (result.applicationConfig && Array.isArray(result.applicationConfig.storageObjects)) {
        const columns = ["id", "app_id", "folder", "name", "content_type", "size", "sha256", "created_at", "created_by", "metadata"];
        this.ctx.store.transaction(() => {
          this.ctx.store.run("DELETE FROM storage_objects WHERE app_id = ?", [appId]);
          for (const row of result.applicationConfig!.storageObjects as Record<string, unknown>[]) {
            if (row.app_id !== appId) throw NexusError.invalid("The backup contains another application's uploads.");
            this.ctx.store.run(`INSERT INTO storage_objects (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`, columns.map((key) => (row[key] ?? null) as string | number | null));
          }
        });
      }
      if (archived?.app && (archived.app as AppRecord).analysis) this.apps.restoreBackupSettings(appId, archived.app as AppRecord, !!result.config);
      if (result.config && (result.config as { secrets?: Record<string, string> }).secrets) {
        for (const item of this.ctx.vault.list(`app:${appId}`)) if (item.name.startsWith(`app:${appId}/env/`)) this.ctx.vault.delete(item.name);
        for (const [name, value] of Object.entries((result.config as { secrets: Record<string, string> }).secrets)) {
          if (name.startsWith(`app:${appId}/env/`)) this.ctx.vault.set(name, value, `app:${appId}`);
        }
        if (result.config.githubSource && typeof result.config.githubSource === "object") {
          this.ctx.settings.set(`githubSource:${appId}`, { ...result.config.githubSource, enabled: false });
          const tokenName = `app:${appId}/github/token`;
          const token = (result.config.secrets as Record<string, string>)[tokenName];
          if (token) this.ctx.vault.set(tokenName, token, `app:${appId}`);
        }
      }
      this.ctx.activity.add("success", `${app.name} restored to ${new Date(b.createdAt).toLocaleString()}.`, appId);
      return result;
    } finally {
      if (wasRunning) await this.apps.start(appId).catch(() => undefined);
      unlock();
    }
  }

  private restoreDeploymentState(appId: string, saved: Record<string, unknown>, validateOnly = false): void {
    if (!Array.isArray(saved.deployments) || typeof saved.appRoot !== "string") throw NexusError.invalid("The backup is missing its deployment metadata.");
    const root = this.ctx.deployments!.appDir(appId);
    const columns = ["id", "app_id", "seq", "version_label", "source_dir", "source_commit", "status", "release_dir", "venv_dir", "python_version", "ran_migrations", "error", "created_at", "finished_at", "activated_at", "duration_ms", "r_script", "r_lib_dir", "r_version"];
    const rows = saved.deployments.map((value: Record<string, unknown>) => {
      if (value.app_id !== appId) throw NexusError.invalid("The backup contains another application's deployment.");
      const row = { ...value };
      for (const key of ["release_dir", "venv_dir", "r_lib_dir"]) {
        if (row[key] === null || row[key] === undefined) continue;
        if (typeof row[key] !== "string") throw NexusError.invalid("Invalid deployment path in backup.");
        const rel = relative(saved.appRoot as string, row[key] as string);
        if (rel.startsWith("..") || isAbsolute(rel)) throw NexusError.invalid("A deployment path leaves its application folder.");
        row[key] = join(root, rel);
      }
      return row;
    });
    if (validateOnly) return;
    this.ctx.store.transaction(() => {
      this.ctx.store.run("DELETE FROM deployments WHERE app_id = ?", [appId]);
      for (const row of rows) this.ctx.store.run(`INSERT INTO deployments (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`, columns.map((key) => (row[key] ?? null) as string | number | null));
    });
  }

  /** Checks every minute whether any app is due (or overdue after downtime) for a backup. */
  startScheduler(intervalMs = 60_000): void {
    const tick = async () => {
      try {
        await this.runDue(new Date());
      } catch (e) {
        this.ctx.log.warn("backup scheduler tick failed", { err: e as Error });
      }
      this.timer = setTimeout(tick, intervalMs);
      this.timer.unref();
    };
    this.timer = setTimeout(tick, 30_000);
    this.timer.unref();
    this.ctx.onStop(() => {
      if (this.timer) clearTimeout(this.timer);
    });
  }

  async runDue(now: Date): Promise<string[]> {
    if (!this.ctx.backups) return [];
    const ran: string[] = [];
    for (const app of this.apps.list()) {
      const policy = this.policy(app.id);
      if (!policy.enabled) continue;
      const last = this.ctx.backups.latestSuccessful(app.id);
      const lastAt = last ? new Date(last.createdAt) : null;
      // After a failure, wait longer before each retry (15 min, 30 min, 1 h … up to 6 h) instead of
      // trying — and reporting — every minute.
      const since = this.ctx.backups.list(app.id).filter((b) => b.trigger === "scheduled" && (!lastAt || new Date(b.createdAt) > lastAt));
      const failures = since.filter((b) => b.status === "failed");
      const lastFailure = failures.map((b) => new Date(b.createdAt)).sort((a, b) => b.getTime() - a.getTime())[0];
      if (lastFailure && now.getTime() - lastFailure.getTime() < Math.min(6 * 3_600_000, 15 * 60_000 * 2 ** (failures.length - 1))) continue;
      if (isBackupDue(policy, lastAt, now)) {
        try {
          await this.backupNow(app.id, "scheduled");
          ran.push(app.id);
        } catch {
          /* reported via activity */
        }
      }
    }
    return ran;
  }
}
