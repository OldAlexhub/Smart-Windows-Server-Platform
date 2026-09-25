import { execFile } from "node:child_process";
import { cpSync, existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { newId, NexusError } from "@nexus/shared";
import type { BackupManager, BackupTarget, PgDumpConfig } from "./manager";

export type RestorePart = "database" | "files" | "config";

export interface RestoreTarget {
  /** The app as it is now (used for the automatic safety backup). */
  current: BackupTarget;
  database: {
    dbName: string;
    /** Role that should own restored objects (the app's owner role). */
    ownerRole: string;
    /** Empties the database (e.g. drop & recreate the public schema with the right grants). */
    reset: () => Promise<void>;
  } | null;
  /** Document (MongoDB) database; `importFrom` replaces its contents with a backup's export. */
  documents?: { dbName: string; importFrom: (dir: string) => Promise<unknown> } | null;
  /** Where each backed-up folder goes back to. */
  fileDirs: { name: string; path: string }[];
}

export interface RestoreResult {
  restored: RestorePart[];
  safetyBackupId: string | null;
  /** Configuration from the backup, for the caller to apply (it knows how to re-wire the app). */
  config: Record<string, unknown> | null;
}

function run(file: string, args: string[], env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) =>
    execFile(file, args, { windowsHide: true, timeout: 6 * 3_600_000, env: { ...process.env, ...env }, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: `${stdout}${stderr}` }),
    ),
  );
}

/**
 * Restores an application from a backup. Destructive by nature, so it:
 *  - requires the user to type the application's name,
 *  - always takes a safety backup of the current state first,
 *  - swaps file folders only after the restored copy is fully in place.
 * The caller stops the app before and starts it afterwards.
 */
export class RestoreManager {
  constructor(
    private readonly backups: BackupManager,
    private readonly pg: PgDumpConfig | null,
  ) {}

  async restore(backupId: string, parts: RestorePart[] | "entire", target: RestoreTarget, confirmation: string): Promise<RestoreResult> {
    const backup = this.backups.require(backupId);
    if (backup.status !== "succeeded" || !backup.path || !existsSync(backup.path)) {
      throw NexusError.invalid("This restore point is no longer available.");
    }
    if (confirmation.trim() !== target.current.appName) {
      throw NexusError.invalid(`To confirm, type the application name exactly: ${target.current.appName}`);
    }
    const wanted: RestorePart[] = parts === "entire" ? ["database", "files", "config"] : [...new Set(parts)];

    // 1. Safety net: capture the current state before replacing anything.
    const safety = await this.backups.backup(target.current, "pre-restore");

    const staging = join(this.backups.root, ".restore", newId());
    try {
      const manifest = await this.backups.extract(backup.path, staging);
      const restored: RestorePart[] = [];

      if (wanted.includes("database") && manifest.documents) {
        if (!target.documents) throw NexusError.invalid("This application has no document database to restore into.");
        try {
          await target.documents.importFrom(join(staging, manifest.documents.dir));
        } catch (e) {
          throw new NexusError("infrastructure", "The document database could not be restored. Your data from before the restore is kept in the safety backup.", {
            cause: e,
            problem: {
              title: "Document database restore failed",
              summary: "Nexus could not load the backup into the document database.",
              checks: [{ label: "Safety backup", status: "ok", detail: "Taken before the restore" }],
              technical: (e as Error).message,
              repair: { id: "backup.restore", label: "Restore the safety backup", requiresConfirmation: true, params: { backupId: safety.id } },
            },
          });
        }
        if (!manifest.database) restored.push("database");
      }

      if (wanted.includes("database") && (manifest.database || !manifest.documents)) {
        if (!manifest.database) throw NexusError.invalid("This backup doesn't contain a database.");
        if (!target.database || !this.pg) throw NexusError.invalid("This application has no database to restore into.");
        await target.database.reset();
        const r = await run(
          join(this.pg.binDir, process.platform === "win32" ? "pg_restore.exe" : "pg_restore"),
          [
            "-h",
            this.pg.host,
            "-p",
            String(this.pg.port),
            "-U",
            this.pg.user,
            "-d",
            target.database.dbName,
            "--no-owner",
            "--no-privileges",
            `--role=${target.database.ownerRole}`,
            "--exit-on-error",
            "--single-transaction",
            join(staging, manifest.database.file),
          ],
          { PGPASSWORD: this.pg.password },
        );
        if (r.code !== 0) {
          throw new NexusError("infrastructure", "The database could not be restored. Your data from before the restore is kept in the safety backup.", {
            problem: {
              title: "Database restore failed",
              summary: "Nexus could not load the backup into the database.",
              checks: [{ label: "Safety backup", status: "ok", detail: "Taken before the restore" }],
              technical: r.out,
              repair: { id: "backup.restore", label: "Restore the safety backup", requiresConfirmation: true, params: { backupId: safety.id } },
            },
          });
        }
        restored.push("database");
      }

      if (wanted.includes("files")) {
        for (const name of manifest.files) {
          const dest = target.fileDirs.find((d) => d.name === name);
          if (!dest) continue;
          const src = join(staging, "files", name);
          const incoming = `${dest.path}.restoring`;
          const old = `${dest.path}.before-restore`;
          rmSync(incoming, { recursive: true, force: true });
          cpSync(src, incoming, { recursive: true });
          rmSync(old, { recursive: true, force: true });
          if (existsSync(dest.path)) renameSync(dest.path, old);
          renameSync(incoming, dest.path);
          rmSync(old, { recursive: true, force: true });
        }
        restored.push("files");
      }

      let config: Record<string, unknown> | null = null;
      if (wanted.includes("config") && manifest.config) {
        config = JSON.parse(readFileSync(join(staging, manifest.config), "utf8")) as Record<string, unknown>;
        restored.push("config");
      }
      return { restored, safetyBackupId: safety.id, config };
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
}

/** SQL to empty an app database's public schema while keeping Nexus's role model intact. */
export function resetSchemaSql(ownerRole: string, readonlyRole: string, quote: (s: string) => string): string[] {
  return [
    "DROP SCHEMA IF EXISTS public CASCADE",
    `CREATE SCHEMA public AUTHORIZATION ${quote(ownerRole)}`,
    "REVOKE ALL ON SCHEMA public FROM PUBLIC",
    `GRANT USAGE ON SCHEMA public TO ${quote(readonlyRole)}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${quote(ownerRole)} IN SCHEMA public GRANT SELECT ON TABLES TO ${quote(readonlyRole)}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${quote(ownerRole)} IN SCHEMA public GRANT SELECT ON SEQUENCES TO ${quote(readonlyRole)}`,
  ];
}

