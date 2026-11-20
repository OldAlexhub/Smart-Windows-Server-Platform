import { execFile, spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import pg from "pg";
import { GiB, MiB, NexusError, silentLogger, type Logger } from "@nexus/shared";

// ------------------------------------------------------------------ binaries

export interface PostgresBinaries {
  binDir: string;
  version: string;
}

const REQUIRED = ["postgres.exe", "initdb.exe", "pg_ctl.exe", "pg_dump.exe", "pg_restore.exe"];
const exe = (name: string) => (process.platform === "win32" ? name : name.replace(/\.exe$/, ""));

function hasAll(binDir: string): boolean {
  return REQUIRED.every((f) => existsSync(join(binDir, exe(f))));
}

/**
 * Finds PostgreSQL binaries: an explicit path, Nexus's bundled copy (vendor/postgresql/<ver>),
 * or an existing PostgreSQL installation. Prefer the tested bundled version over system installs.
 */
export function locatePostgresBinaries(opts: { configured?: string | null; bundledRoots?: string[]; programFiles?: string; dataRoot?: string } = {}): PostgresBinaries | null {
  if (opts.configured && hasAll(opts.configured)) return { binDir: opts.configured, version: versionFromPath(opts.configured) };
  const candidates: PostgresBinaries[] = [];
  for (const root of opts.bundledRoots ?? []) {
    if (!existsSync(root)) continue;
    for (const v of readdirSync(root)) {
      const bin = join(root, v, "bin");
      if (hasAll(bin)) candidates.push({ binDir: bin, version: v });
    }
  }
  const bundledCount = candidates.length;
  const pf = join(opts.programFiles ?? process.env.ProgramFiles ?? "C:\\Program Files", "PostgreSQL");
  if (existsSync(pf)) {
    for (const v of readdirSync(pf)) {
      const bin = join(pf, v, "bin");
      if (hasAll(bin)) candidates.push({ binDir: bin, version: v });
    }
  }
  // An existing cluster determines its required major version. Never silently switch its data
  // to a fresh cluster simply because a bundled/system installation has a different version.
  const existing = opts.dataRoot && existsSync(opts.dataRoot)
    ? readdirSync(opts.dataRoot).filter((name) => /^pg\d+$/.test(name) && existsSync(join(opts.dataRoot!, name, "PG_VERSION")))
    : [];
  if (existing.length > 1) throw NexusError.conflict("Nexus found multiple existing database versions. Their data has been preserved; contact support to select the active database.");
  const required = existing[0]?.slice(2);
  const compatible = (items: PostgresBinaries[]) => items.filter((item) => !required || item.version.split(".")[0] === required).sort((a, b) => compareVersions(b.version, a.version));
  return compatible(candidates.slice(0, bundledCount))[0] ?? compatible(candidates.slice(bundledCount))[0] ?? null;
}

function versionFromPath(p: string): string {
  return basename(dirname(p)).match(/^(\d+(?:\.\d+)*(?:-\d+)?)/)?.[1] ?? "unknown";
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map(Number);
  const pb = b.split(/[.-]/).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// ------------------------------------------------------------------ tuning

export interface TuningInput {
  totalMemoryBytes: number;
  cpuThreads: number;
  storage: "nvme" | "ssd" | "hdd" | "unknown";
  /** Share of RAM PostgreSQL may plan around (the rest is for apps and AI). */
  memoryShare?: number;
}

/** Sensible settings derived from the hardware — nobody should have to hand-tune PostgreSQL. */
export function tunePostgres(t: TuningInput): Record<string, string | number> {
  const share = t.memoryShare ?? 0.5;
  const budget = t.totalMemoryBytes * share;
  const mb = (bytes: number) => `${Math.max(1, Math.floor(bytes / MiB))}MB`;
  const maxConnections = 200;
  const sharedBuffers = Math.min(budget * 0.25, 8 * GiB);
  const workMem = Math.max(4 * MiB, Math.min(64 * MiB, (budget * 0.25) / maxConnections));
  const fast = t.storage === "nvme" || t.storage === "ssd";
  const workers = Math.max(2, Math.min(t.cpuThreads, 32));
  return {
    max_connections: maxConnections,
    shared_buffers: mb(sharedBuffers),
    effective_cache_size: mb(budget * 0.75),
    work_mem: mb(workMem),
    maintenance_work_mem: mb(Math.min(budget / 16, 2 * GiB)),
    random_page_cost: fast ? 1.1 : 4,
    max_worker_processes: workers,
    max_parallel_workers: Math.max(2, Math.floor(workers / 2)),
    max_parallel_workers_per_gather: Math.max(1, Math.min(4, Math.floor(workers / 4))),
    wal_compression: "on",
    checkpoint_completion_target: 0.9,
    min_wal_size: "1GB",
    max_wal_size: fast ? "4GB" : "2GB",
  };
}

/** Halves shared_buffers (min 128MB); null when it can't go lower. */
export function reduceSharedBuffers(tuning: Record<string, string | number>): Record<string, string | number> | null {
  const current = Number(String(tuning.shared_buffers ?? "128MB").replace(/MB$/i, ""));
  if (!Number.isFinite(current) || current <= 128) return null;
  return { ...tuning, shared_buffers: `${Math.max(128, Math.floor(current / 2))}MB` };
}

/** The Nexus-owned part of postgresql.conf. Security settings are not negotiable. */
export function renderNexusConf(port: number, tuning: Record<string, string | number>, logDir: string): string {
  const q = (v: string | number) => (typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
  const lines = [
    "# Managed by Nexus — changes here are overwritten. Use Settings > Advanced > Database instead.",
    "listen_addresses = '127.0.0.1'",
    `port = ${port}`,
    "password_encryption = 'scram-sha-256'",
    "ssl = off # loopback only; external access never reaches PostgreSQL",
    "logging_collector = on",
    `log_directory = ${q(logDir.replace(/\\/g, "/"))}`,
    "log_filename = 'postgresql-%a.log'",
    "log_truncate_on_rotation = on",
    "log_rotation_age = '1d'",
    "log_min_duration_statement = 2000 # slow queries, used by performance insights",
    "log_connections = off",
    "shared_preload_libraries = 'pg_stat_statements'",
    "pg_stat_statements.track = top",
    ...Object.entries(tuning).map(([k, v]) => `${k} = ${q(v)}`),
  ];
  return lines.join("\n") + "\n";
}

/** Only loopback, only password (SCRAM) auth. Nothing else can connect. */
export const PG_HBA = [
  "# Managed by Nexus. PostgreSQL is reachable from this computer only.",
  "# TYPE  DATABASE  USER  ADDRESS        METHOD",
  "host    all       all   127.0.0.1/32   scram-sha-256",
  "host    all       all   ::1/128        scram-sha-256",
  "",
].join("\n");

// ------------------------------------------------------------------ engine

export interface PostgresEngineOptions {
  bin: PostgresBinaries;
  dataDir: string;
  port: number;
  superuser: string;
  superuserPassword: string;
  tuning: Record<string, string | number>;
  logger?: Logger;
}

export type EngineState = "not_initialized" | "stopped" | "running";

function run(file: string, args: string[], env?: NodeJS.ProcessEnv, timeoutMs = 120_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs, env: { ...process.env, ...env } }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      // Loader failures (including missing Windows DLLs) often produce no stdout/stderr.
      const detail = err ? `\n${basename(file)}: ${err.message}\nExit: ${err.code ?? code}${typeof err.code === "number" ? ` (0x${(err.code >>> 0).toString(16)})` : ""}${err.killed ? " (timed out or terminated)" : ""}${err.signal ? `; signal: ${err.signal}` : ""}` : "";
      resolve({ code, out: `${stdout}${stderr}${detail}` });
    });
  });
}

/**
 * Runs `pg_ctl start`. The server it launches would inherit (and hold open) any output pipes,
 * making the caller wait forever — so nothing is inherited (output goes to the log file) and we
 * wait for pg_ctl's own exit.
 */
function runDetachedStart(file: string, args: string[], timeoutMs: number): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { windowsHide: true, stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill();
      resolve(-1);
    }, timeoutMs);
    child.once("error", () => {
      clearTimeout(timer);
      resolve(-1);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
  });
}

/**
 * Runs Nexus's central PostgreSQL server: one cluster, bound to 127.0.0.1 on a private port,
 * started through pg_ctl (which drops administrator rights automatically on Windows).
 */
export class PostgresEngine {
  private readonly log: Logger;
  private initializing?: Promise<void>;

  constructor(private readonly opts: PostgresEngineOptions) {
    this.log = opts.logger ?? silentLogger;
  }

  get port(): number {
    return this.opts.port;
  }
  get superuser(): string {
    return this.opts.superuser;
  }
  get version(): string {
    return this.opts.bin.version;
  }
  get dataDir(): string {
    return this.opts.dataDir;
  }
  get binDir(): string {
    return this.opts.bin.binDir;
  }

  private tool(name: string): string {
    return join(this.opts.bin.binDir, exe(`${name}.exe`));
  }

  isInitialized(): boolean {
    return ["PG_VERSION", "global/pg_control", "postgresql.conf", "pg_hba.conf"].every((f) => existsSync(join(this.opts.dataDir, f)));
  }

  async state(): Promise<EngineState> {
    if (!this.isInitialized()) return "not_initialized";
    const r = await run(this.tool("pg_ctl"), ["status", "-D", this.opts.dataDir]);
    return r.code === 0 ? "running" : "stopped";
  }

  /** Creates the cluster with a random superuser password (stored only in the Nexus vault). */
  async initialize(): Promise<void> {
    if (this.initializing) return this.initializing;
    this.initializing = this.initializeCluster();
    try {
      await this.initializing;
    } finally {
      this.initializing = undefined;
    }
  }

  private setupError(technical: string): NexusError {
    let summary = "Nexus could not finish preparing its database. Try setup again. If it still fails, run the Nexus installer again to repair its components.";
    if (/0xc0000135|0xc000007b|0xc0000142|ENOENT|missing.*dll/i.test(technical)) {
      summary = "A required database component could not load. Run the Nexus installer again to repair the required components automatically.";
    } else if (/ENOSPC|no space left|disk.*full|not enough space/i.test(technical)) {
      summary = "The database drive has run out of space. Free some space or choose another drive, then try again.";
    } else if (/EACCES|EPERM|permission denied|access is denied/i.test(technical)) {
      summary = "Windows blocked access to the database files. Run the Nexus installer again to repair setup, or choose another storage location.";
    }
    // Log separately: the general error serializer intentionally includes only Error's standard fields.
    const safeDetail = technical.replaceAll(this.opts.superuserPassword, "[redacted]");
    this.log.error("postgres initialization failed", { dataDir: this.opts.dataDir, technical: safeDetail });
    return new NexusError("infrastructure", "Nexus could not set up the database server.", {
      problem: { title: "Database setup could not finish", summary, checks: [], technical: safeDetail },
    });
  }

  private async initializeCluster(): Promise<void> {
    if (this.isInitialized()) return;
    let work: string | undefined;
    let pwfile: string | undefined;
    try {
      // Existing files may be recoverable user data. Never erase or replace them automatically.
      if (existsSync(this.opts.dataDir) && (lstatSync(this.opts.dataDir).isSymbolicLink() || readdirSync(this.opts.dataDir).length)) {
        throw new NexusError("infrastructure", "The existing database needs attention.", {
          problem: {
            title: "Existing database needs recovery",
            summary: "Nexus found existing database files that are incomplete. They have been preserved. Restore a backup or contact support to recover them.",
            checks: [], technical: `Incomplete database at ${this.opts.dataDir}. No existing files were changed.`,
          },
        });
      }
      // Build in a fresh sibling directory. An interrupted attempt never poisons the final folder.
      mkdirSync(dirname(this.opts.dataDir), { recursive: true });
      work = mkdtempSync(join(dirname(this.opts.dataDir), `.${basename(this.opts.dataDir)}-setup-`));
      if (process.platform === "win32") {
        // PostgreSQL drops the Administrators group from its token. Give the launching account
        // its own explicit access to this newly created folder, without granting other users access.
        const identity = await run("whoami.exe", ["/user", "/fo", "csv", "/nh"]);
        const sid = identity.out.match(/S-1-5-\d+(?:-\d+)*/)?.[0];
        if (identity.code !== 0 || !sid) throw this.setupError(`Could not identify the database service account. ${identity.out}`);
        const accounts = [...new Set([sid, "S-1-5-18", "S-1-5-32-544"])];
        const acl = await run("icacls.exe", [work, "/inheritance:r", "/grant:r", ...accounts.map((account) => `*${account}:(OI)(CI)F`), "/Q"]);
        if (acl.code !== 0) throw this.setupError(`Could not prepare database permissions. ${acl.out}`);
      }
      const staging = join(work, "data");
      pwfile = join(work, "password");
      writeFileSync(pwfile, this.opts.superuserPassword, { mode: 0o600 });
      const r = await run(
        this.tool("initdb"),
        [
          "-D",
          staging,
          "-U",
          this.opts.superuser,
          `--pwfile=${pwfile}`,
          "--auth=scram-sha-256",
          "--encoding=UTF8",
          "--locale-provider=builtin",
          "--locale=C",
          "--builtin-locale=C.UTF-8",
          "--data-checksums",
        ],
        {},
        300_000,
      );
      if (r.code !== 0) throw this.setupError(r.out);
      this.writeConfig(staging);
      // rmdir only succeeds for an empty directory; a racing writer's files are never removed.
      if (existsSync(this.opts.dataDir)) rmdirSync(this.opts.dataDir);
      renameSync(staging, this.opts.dataDir);
    } catch (e) {
      if (e instanceof NexusError) throw e;
      throw this.setupError(e instanceof Error ? `${(e as NodeJS.ErrnoException).code ?? ""}: ${e.message}` : String(e));
    } finally {
      if (pwfile) {
        try { rmSync(pwfile, { force: true }); }
        catch (e) { this.log.error("could not remove database setup password file", { err: e as Error }); }
      }
      // Failed staging folders are retained for diagnosis; a retry uses a new one.
      if (work) {
        try { if (readdirSync(work).length === 0) rmdirSync(work); }
        catch (e) { this.log.warn("could not remove empty database setup folder", { err: e as Error }); }
      }
    }
    this.log.info("postgres cluster initialized", { dataDir: this.opts.dataDir });
  }

  /** (Re)writes Nexus-managed configuration. Called on every start so tuning follows the hardware. */
  writeConfig(dataDir = this.opts.dataDir): void {
    const confPath = join(dataDir, "postgresql.conf");
    const conf = readFileSync(confPath, "utf8");
    if (!conf.includes("include_if_exists = 'nexus.conf'")) {
      writeFileSync(confPath, `${conf}\n# Nexus\ninclude_if_exists = 'nexus.conf'\n`);
    }
    writeFileSync(join(dataDir, "nexus.conf"), renderNexusConf(this.opts.port, this.opts.tuning, join(this.opts.dataDir, "log")));
    writeFileSync(join(dataDir, "pg_hba.conf"), PG_HBA);
  }

  async start(): Promise<void> {
    if (!this.isInitialized()) await this.initialize();
    if ((await this.state()) === "running") return;
    let code = -1;
    let startup = "";
    // Self-healing: if Windows can't provide the shared memory right now (other programs,
    // AI models), start with a smaller buffer instead of not starting at all.
    for (let attempt = 0; attempt < 4; attempt++) {
      this.writeConfig();
      const logFile = join(this.opts.dataDir, "startup.log");
      rmSync(logFile, { force: true });
      code = await runDetachedStart(this.tool("pg_ctl"), ["start", "-D", this.opts.dataDir, "-w", "-t", "90", "-l", logFile], 120_000);
      if (code === 0) break;
      try {
        startup = readFileSync(logFile, "utf8").slice(-4000);
      } catch {
        startup = "";
      }
      if (!/could not create shared memory segment|could not map anonymous shared memory|error code 1450/i.test(startup)) break;
      const reduced = reduceSharedBuffers(this.opts.tuning);
      if (!reduced) break;
      this.log.warn("not enough shared memory for PostgreSQL; retrying with a smaller buffer", { shared_buffers: reduced.shared_buffers });
      this.opts.tuning = reduced;
    }
    if (code !== 0) {
      throw new NexusError("infrastructure", "The database server could not start.", {
        problem: {
          title: "Database server did not start",
          summary: "Nexus tried to start the database server but it stopped straight away.",
          checks: [{ label: "Database files", status: "ok" }, { label: "Database server", status: "failed" }],
          technical: `pg_ctl exit code ${code}\n${startup}`,
          repair: { id: "database.start", label: "Try Again", requiresConfirmation: false },
        },
      });
    }
    await this.adminQuery("CREATE EXTENSION IF NOT EXISTS pg_stat_statements");
    this.log.info("postgres started", { port: this.opts.port });
  }

  async stop(): Promise<void> {
    if ((await this.state()) !== "running") return;
    await run(this.tool("pg_ctl"), ["stop", "-D", this.opts.dataDir, "-m", "fast", "-w", "-t", "60"]);
  }

  /** Admin connection as the Nexus superuser. Never handed to applications. */
  async adminClient(database = "postgres"): Promise<pg.Client> {
    const c = new pg.Client({
      host: "127.0.0.1",
      port: this.opts.port,
      user: this.opts.superuser,
      password: this.opts.superuserPassword,
      database,
      connectionTimeoutMillis: 10_000,
      application_name: "nexus",
    });
    await c.connect();
    return c;
  }

  async adminQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params: unknown[] = [], database = "postgres"): Promise<T[]> {
    const c = await this.adminClient(database);
    try {
      return (await c.query<T>(sql, params)).rows;
    } finally {
      await c.end();
    }
  }
}
