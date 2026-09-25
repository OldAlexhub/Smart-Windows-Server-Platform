import { join } from "node:path";
import { DEFAULT_POLICY, isOverdue, resetSchemaSql, type BackupPolicy, type BackupTarget, type RestorePart, type RestoreTarget } from "@nexus/backups";
import { NexusError } from "@nexus/shared";
import type { NexusContext } from "../context";
import type { AppManager } from "./apps";

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
    const db = app.databaseId ? this.ctx.databases?.get(app.databaseId) : null;
    const docDb = app.documentDatabaseId ? this.ctx.documents?.get(app.documentDatabaseId) : null;
    const secrets: Record<string, string> = {};
    for (const s of this.ctx.vault.list(`app:${appId}`)) secrets[s.name] = this.ctx.vault.get(s.name)!;
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
      fileDirs: this.ctx.dataPaths ? [{ name: "storage", path: join(this.ctx.dataPaths.files, appId) }] : [],
      // Everything needed to rebuild the app elsewhere; protected by backup encryption.
      config: { app: { ...app, analysis: undefined }, secrets },
    };
  }

  expectedContents(appId: string) {
    const app = this.apps.require(appId);
    return { database: !!app.databaseId || !!app.documentDatabaseId, files: false, config: true };
  }

  async backupNow(appId: string, trigger: "manual" | "scheduled" = "manual") {
    if (!this.ctx.backups) throw NexusError.conflict("Backups are not available yet.");
    if (this.running.has(appId)) throw NexusError.conflict("A backup of this application is already running.");
    this.running.add(appId);
    try {
      const b = await this.ctx.backups.backup(this.target(appId), trigger);
      this.ctx.backups.applyRetention(appId, this.policy(appId).retention);
      const app = this.apps.require(appId);
      if (trigger === "manual") this.ctx.activity.add("success", `${app.name} backup completed.`, appId);
      return b;
    } catch (e) {
      this.ctx.activity.add("problem", `${this.apps.get(appId)?.name ?? appId} backup failed: ${(e as Error).message}`, appId);
      throw e;
    } finally {
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
    await this.apps.stop(appId);
    try {
      const result = await this.ctx.restore!.restore(backupId, parts, target, confirmation);
      if (result.config && (result.config as { secrets?: Record<string, string> }).secrets) {
        for (const [name, value] of Object.entries((result.config as { secrets: Record<string, string> }).secrets)) {
          if (name.startsWith(`app:${appId}/env/`)) this.ctx.vault.set(name, value, `app:${appId}`);
        }
      }
      this.ctx.activity.add("success", `${app.name} restored to ${new Date(b.createdAt).toLocaleString()}.`, appId);
      return result;
    } finally {
      if (wasRunning) await this.apps.start(appId).catch(() => undefined);
    }
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
      const last = this.ctx.backups.list(app.id).find((b) => b.trigger === "scheduled" && b.status === "succeeded");
      const lastAt = last ? new Date(last.createdAt) : null;
      const [h, m] = policy.time.split(":").map(Number) as [number, number];
      const scheduledToday = new Date(now);
      scheduledToday.setHours(h, m, 0, 0);
      const dueToday = policy.frequency === "daily" && now >= scheduledToday && (!lastAt || lastAt < scheduledToday);
      // After a failure, wait longer before each retry (15 min, 30 min, 1 h … up to 6 h) instead of
      // trying — and reporting — every minute.
      const since = this.ctx.backups.list(app.id).filter((b) => b.trigger === "scheduled" && (!lastAt || new Date(b.createdAt) > lastAt));
      const failures = since.filter((b) => b.status === "failed");
      const lastFailure = failures.map((b) => new Date(b.createdAt)).sort((a, b) => b.getTime() - a.getTime())[0];
      if (lastFailure && now.getTime() - lastFailure.getTime() < Math.min(6 * 3_600_000, 15 * 60_000 * 2 ** (failures.length - 1))) continue;
      if (dueToday || isOverdue(policy, lastAt, now)) {
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
