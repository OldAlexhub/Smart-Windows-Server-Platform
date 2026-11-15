import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";
import { newId, NexusError, silentLogger, slugify, type Logger } from "@nexus/shared";
import type { Migration, StateStore } from "@nexus/state";
import { DecryptStream, EncryptStream } from "./crypto-stream";
import { selectForDeletion, type BackupPolicy, type RetentionPolicy } from "./policy";
import { snapshotDirectory } from "./snapshot";

export const backupMigrations: Migration[] = [
  {
    id: "backups/001_backups",
    up: `CREATE TABLE backups (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      finished_at TEXT,
      trigger TEXT NOT NULL,
      status TEXT NOT NULL,
      path TEXT,
      size INTEGER,
      sha256 TEXT,
      contents TEXT NOT NULL,
      error TEXT,
      duration_ms INTEGER
    );
    CREATE INDEX backups_app ON backups(app_id, created_at);
    CREATE TABLE backup_policies (
      app_id TEXT PRIMARY KEY,
      policy TEXT NOT NULL
    );`,
  },
];

export interface PgDumpConfig {
  binDir: string;
  host: string;
  port: number;
  user: string;
  password: string;
}

/** Everything that makes up one application, for backup. */
export interface BackupTarget {
  appId: string;
  appName: string;
  database: { dbName: string } | null;
  /** Document (MongoDB) database; `exportTo` writes its collections into the given folder. */
  documents?: { dbName: string; exportTo: (dir: string) => Promise<unknown> } | null;
  /** Named folders to include, e.g. { name: "storage", path: "D:\\Nexus\\Storage\\taxiops" }. */
  fileDirs: { name: string; path: string; snapshot?: boolean }[];
  /** App settings including secrets; protected by backup encryption. */
  config: Record<string, unknown>;
  validateFiles?: (filesDirectory: string) => void;
}

export interface BackupContents {
  database: boolean;
  files: boolean;
  config: boolean;
  application?: boolean;
}

export interface BackupRecord {
  id: string;
  appId: string;
  createdAt: string;
  finishedAt: string | null;
  trigger: "scheduled" | "manual" | "pre-restore";
  status: "running" | "succeeded" | "failed";
  path: string | null;
  size: number | null;
  sha256: string | null;
  contents: BackupContents;
  error: string | null;
  durationMs: number | null;
}

export interface BackupManifest {
  format: "nexus-backup";
  version: 1;
  id: string;
  appId: string;
  appName: string;
  createdAt: string;
  database: { dbName: string; file: string; format: "pg_dump-custom" } | null;
  /** Absent in backups made before document databases existed. */
  documents?: { dbName: string; dir: string; format: "nexus-documents" } | null;
  files: string[];
  config: string | null;
}

export function validateBackupManifest(value: unknown): BackupManifest {
  const m = value as BackupManifest;
  if (!m || m.format !== "nexus-backup" || m.version !== 1 || typeof m.appId !== "string" ||
      !Array.isArray(m.files) || m.files.some((name) => typeof name !== "string" || !/^[a-z0-9_-]+$/i.test(name)) ||
      new Set(m.files).size !== m.files.length || (m.config !== null && m.config !== "config/app.json") ||
      (m.database && (m.database.file !== "database.dump" || m.database.format !== "pg_dump-custom")) ||
      (m.documents && (m.documents.dir !== "documents" || m.documents.format !== "nexus-documents"))) {
    throw new Error("The backup manifest is invalid or contains unsafe paths.");
  }
  return m;
}

export interface ProtectionStatus {
  protected: boolean;
  latest: BackupRecord | null;
  contents: BackupContents;
  message: string;
}

function run(file: string, args: string[], env: Record<string, string>, timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) =>
    execFile(file, args, { windowsHide: true, timeout: timeoutMs, env: { ...process.env, ...env }, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: `${stdout}${stderr}` }),
    ),
  );
}

const exe = (n: string) => (process.platform === "win32" ? `${n}.exe` : n);

/**
 * Creates encrypted, self-contained backups of applications: database (pg_dump), files,
 * and configuration in one ".nxb" file. Backups are verified after writing. Deleting backups
 * only ever happens through the retention policy — never by the AI.
 */
export class BackupManager {
  private readonly log: Logger;

  constructor(
    private readonly store: StateStore,
    private readonly opts: { root: string; backupKey: Buffer; pg: PgDumpConfig | null; logger?: Logger },
  ) {
    store.migrate(backupMigrations);
    this.log = opts.logger ?? silentLogger;
    mkdirSync(opts.root, { recursive: true });
  }

  get root(): string {
    return this.opts.root;
  }

  // ---------------- policies ----------------

  policy(appId: string, fallback: BackupPolicy): BackupPolicy {
    const r = this.store.get<{ policy: string }>("SELECT policy FROM backup_policies WHERE app_id = ?", [appId]);
    return r ? (JSON.parse(r.policy) as BackupPolicy) : fallback;
  }

  setPolicy(appId: string, policy: BackupPolicy): void {
    this.store.run("INSERT INTO backup_policies (app_id, policy) VALUES (?, ?) ON CONFLICT(app_id) DO UPDATE SET policy = excluded.policy", [
      appId,
      JSON.stringify(policy),
    ]);
  }

  // ---------------- backup ----------------

  async backup(target: BackupTarget, trigger: BackupRecord["trigger"] = "manual"): Promise<BackupRecord> {
    const id = newId();
    const started = Date.now();
    const createdAt = new Date(started).toISOString();
    const contents: BackupContents = {
      database: !!target.database || !!target.documents,
      files: target.fileDirs.some((d) => existsSync(d.path)),
      config: true,
      application: target.fileDirs.some((d) => d.name === "application" && existsSync(d.path)),
    };
    this.store.run("INSERT INTO backups (id, app_id, created_at, trigger, status, contents) VALUES (?, ?, ?, ?, 'running', ?)", [
      id,
      target.appId,
      createdAt,
      trigger,
      JSON.stringify(contents),
    ]);

    const staging = join(this.opts.root, ".staging", id);
    const dir = join(this.opts.root, slugify(target.appId));
    const stamp = createdAt.replace(/[:T]/g, "-").replace(/\..+$/, "");
    const finalPath = join(dir, `${slugify(target.appName)}_${stamp}_${trigger}_${id}.nxb`);
    try {
      mkdirSync(join(staging, "files"), { recursive: true });
      mkdirSync(dir, { recursive: true });
      const entries = ["manifest.json", "config"];

      if (target.database) {
        if (!this.opts.pg) throw new Error("The database server is not available.");
        const pg = this.opts.pg;
        const r = await run(
          join(pg.binDir, exe("pg_dump")),
          ["-h", pg.host, "-p", String(pg.port), "-U", pg.user, "-d", target.database.dbName, "-Fc", "-Z", "6", "-f", join(staging, "database.dump")],
          { PGPASSWORD: pg.password, PGCONNECT_TIMEOUT: "10" },
          6 * 3_600_000,
        );
        if (r.code !== 0) throw new Error(`The database could not be exported: ${r.out.trim().split("\n").pop()}`);
        entries.push("database.dump");
      }

      if (target.documents) {
        await target.documents.exportTo(join(staging, "documents"));
        entries.push("documents");
      }

      const fileNames: string[] = [];
      for (const d of target.fileDirs) {
        if (!existsSync(d.path)) continue;
        if (!/^[a-z0-9_-]+$/i.test(d.name)) throw new Error("Invalid backup folder name.");
        // A junction lets tar read the folder in place — no second copy of large file stores. Drives
        // formatted exFAT or FAT32 (common for external backup disks) can't hold junctions: copy instead.
        if (d.snapshot) {
          await snapshotDirectory(d.path, join(staging, "files", d.name));
        } else try {
          symlinkSync(d.path, join(staging, "files", d.name), "junction");
        } catch {
          rmSync(join(staging, "files", d.name), { recursive: true, force: true });
          cpSync(d.path, join(staging, "files", d.name), { recursive: true, dereference: true, preserveTimestamps: true });
        }
        fileNames.push(d.name);
      }
      if (fileNames.length) entries.push("files");
      target.validateFiles?.(join(staging, "files"));

      mkdirSync(join(staging, "config"), { recursive: true });
      writeFileSync(join(staging, "config", "app.json"), JSON.stringify(target.config, null, 2));
      const manifest: BackupManifest = {
        format: "nexus-backup",
        version: 1,
        id,
        appId: target.appId,
        appName: target.appName,
        createdAt,
        database: target.database ? { dbName: target.database.dbName, file: "database.dump", format: "pg_dump-custom" } : null,
        documents: target.documents ? { dbName: target.documents.dbName, dir: "documents", format: "nexus-documents" } : null,
        files: fileNames,
        config: "config/app.json",
      };
      writeFileSync(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2));

      const hash = createHash("sha256");
      const tap = new Transform({
        transform(chunk: Buffer, _e, cb) {
          hash.update(chunk);
          cb(null, chunk);
        },
      });
      await pipeline(
        tar.create({ cwd: staging, follow: true, portable: true, noMtime: false, gzip: true }, entries),
        new EncryptStream(this.opts.backupKey),
        tap,
        createWriteStream(`${finalPath}.part`),
      );
      renameSync(`${finalPath}.part`, finalPath);

      await this.verifyFile(finalPath);

      const size = statSync(finalPath).size;
      this.store.run("UPDATE backups SET status = 'succeeded', finished_at = ?, path = ?, size = ?, sha256 = ?, duration_ms = ? WHERE id = ?", [
        new Date().toISOString(),
        finalPath,
        size,
        hash.digest("hex"),
        Date.now() - started,
        id,
      ]);
      this.log.info("backup completed", { appId: target.appId, size, ms: Date.now() - started });
    } catch (e) {
      rmSync(`${finalPath}.part`, { force: true });
      rmSync(finalPath, { force: true });
      this.store.run("UPDATE backups SET status = 'failed', finished_at = ?, error = ?, duration_ms = ? WHERE id = ?", [
        new Date().toISOString(),
        (e as Error).message,
        Date.now() - started,
        id,
      ]);
      this.log.error("backup failed", { appId: target.appId, err: e as Error });
      throw new NexusError("infrastructure", `The backup of ${target.appName} failed: ${(e as Error).message}`, { cause: e });
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    return this.require(id);
  }

  /** Decrypts and reads the archive index end-to-end; throws if anything is wrong. */
  async verifyFile(path: string, key = this.opts.backupKey): Promise<BackupManifest> {
    let manifest: BackupManifest | null = null;
    let manifestError: Error | null = null;
    const names: string[] = [];
    await pipeline(
      createReadStream(path),
      new DecryptStream(key),
      tar.list({
        onReadEntry: (entry) => {
          names.push(entry.path);
          if (entry.path === "manifest.json") {
            const chunks: Buffer[] = [];
            let bytes = 0;
            entry.on("data", (c: Buffer) => {
              bytes += c.length;
              if (bytes > 1024 * 1024) manifestError = new Error("The backup manifest is too large.");
              else chunks.push(c);
            });
            entry.on("end", () => {
              try { if (!manifestError) manifest = validateBackupManifest(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
              catch (error) { manifestError = error as Error; }
            });
          } else entry.resume();
        },
      }),
    );
    if (manifestError) throw manifestError;
    if (!manifest) throw new Error("The backup has no manifest.");
    const m = manifest as BackupManifest;
    if (m.database && !names.includes("database.dump")) throw new Error("The backup is missing its database export.");
    if (m.documents && !names.some((n) => n.replace(/\\/g, "/") === `${m.documents!.dir}/collections.json`)) {
      throw new Error("The backup is missing its document database export.");
    }
    if (m.config && !names.includes(m.config)) throw new Error("The backup is missing its configuration.");
    for (const folder of m.files) if (!names.some((name) => name.replace(/\\/g, "/").replace(/\/$/, "") === `files/${folder}`)) throw new Error(`The backup is missing its ${folder} folder.`);
    return m;
  }

  /** Decrypts and unpacks a backup into `dest` (used by restore). */
  async extract(path: string, dest: string, key = this.opts.backupKey): Promise<BackupManifest> {
    await this.verifyFile(path, key);
    mkdirSync(dest, { recursive: true });
    let unsafeEntry = false;
    await pipeline(createReadStream(path), new DecryptStream(key), tar.extract({ cwd: dest, strict: true, preservePaths: false, filter: (_path, entry) => {
      if (!("type" in entry) || (entry.type !== "File" && entry.type !== "Directory")) { unsafeEntry = true; return false; }
      return true;
    } }));
    if (unsafeEntry) throw new Error("The backup contains an unsupported linked entry.");
    return validateBackupManifest(JSON.parse(readFileSync(join(dest, "manifest.json"), "utf8")));
  }

  // ---------------- queries ----------------

  get(id: string): BackupRecord | undefined {
    const r = this.store.get<Row>("SELECT * FROM backups WHERE id = ?", [id]);
    return r ? toRecord(r) : undefined;
  }

  require(id: string): BackupRecord {
    const b = this.get(id);
    if (!b) throw NexusError.notFound("Backup");
    return b;
  }

  list(appId: string): BackupRecord[] {
    return this.store.all<Row>("SELECT * FROM backups WHERE app_id = ? ORDER BY created_at DESC", [appId]).map(toRecord);
  }

  latestSuccessful(appId: string): BackupRecord | null {
    const r = this.store.get<Row>("SELECT * FROM backups WHERE app_id = ? AND status = 'succeeded' ORDER BY created_at DESC LIMIT 1", [appId]);
    return r ? toRecord(r) : null;
  }

  /** "Protected" = a verified backup newer than 1.5× the scheduled interval, covering everything the app has. */
  protection(appId: string, expected: BackupContents, policy: BackupPolicy, now = new Date()): ProtectionStatus {
    const latest = this.latestSuccessful(appId);
    if (!latest) return { protected: false, latest: null, contents: { database: false, files: false, config: false }, message: "Not backed up yet" };
    const periodH = policy.frequency === "custom" ? policy.intervalHours ?? 24 : policy.frequency === "weekly" ? 168 : 24;
    const fresh = now.getTime() - new Date(latest.createdAt).getTime() < periodH * 1.5 * 3_600_000;
    const complete = (!expected.database || latest.contents.database) && (!expected.files || latest.contents.files) && (!expected.application || !!latest.contents.application) && latest.contents.config;
    return {
      protected: fresh && complete && policy.enabled,
      latest,
      contents: latest.contents,
      message: !policy.enabled ? "Automatic backups are off" : !fresh ? "Latest backup is out of date" : !complete ? "Latest backup is incomplete" : "Protected",
    };
  }

  /** Deletes backups outside the retention policy. Never removes the newest successful backup. */
  applyRetention(appId: string, retention: RetentionPolicy, now = new Date(), replacePrevious = false): number {
    const all = this.list(appId);
    const latest = all.find((b) => b.status === "succeeded");
    // Never remove the old good copy until a new archive has been verified successfully.
    const doomed = replacePrevious && latest
      ? all.filter((b) => b.id !== latest.id && b.status !== "running").map((b) => b.id)
      : selectForDeletion(all, retention, now);
    for (const id of doomed) {
      const b = all.find((x) => x.id === id)!;
      if (b.path) rmSync(b.path, { force: true });
      this.store.run("DELETE FROM backups WHERE id = ?", [id]);
    }
    return doomed.length;
  }
}

interface Row {
  id: string;
  app_id: string;
  created_at: string;
  finished_at: string | null;
  trigger: BackupRecord["trigger"];
  status: BackupRecord["status"];
  path: string | null;
  size: number | null;
  sha256: string | null;
  contents: string;
  error: string | null;
  duration_ms: number | null;
}

function toRecord(r: Row): BackupRecord {
  return {
    id: r.id,
    appId: r.app_id,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
    trigger: r.trigger,
    status: r.status,
    path: r.path,
    size: r.size,
    sha256: r.sha256,
    contents: JSON.parse(r.contents),
    error: r.error,
    durationMs: r.duration_ms,
  };
}
