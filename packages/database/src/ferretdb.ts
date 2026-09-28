import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { NexusError, silentLogger, type Logger } from "@nexus/shared";

// ------------------------------------------------------------------ binaries

export interface FerretBinaries {
  exe: string;
  version: string;
  /** "bundled" = built and shipped with Nexus; "configured" = an administrator chose this file. */
  source: "bundled" | "configured";
}

/**
 * FerretDB (Apache-2.0) speaks the MongoDB protocol and stores documents in PostgreSQL. Nexus ships
 * its own build (components/ferretdb/<ver>/ferretdb.exe); an administrator may point to another.
 */
export function locateFerretDb(opts: { configured?: string | null; bundledRoots?: string[] } = {}): FerretBinaries | null {
  if (opts.configured && existsSync(opts.configured)) return { exe: opts.configured, version: opts.configured.match(/(\d+\.\d+\.\d+)/)?.[1] ?? "unknown", source: "configured" };
  for (const root of opts.bundledRoots ?? []) {
    if (!existsSync(root)) continue;
    const versions = readdirSync(root)
      .filter((v) => existsSync(join(root, v, "ferretdb.exe")))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    if (versions[0]) return { exe: join(root, versions[0], "ferretdb.exe"), version: versions[0], source: "bundled" };
  }
  return null;
}

// ------------------------------------------------------------------ engine

/**
 * What document databases need from an engine: a MongoDB-protocol endpoint for each database.
 * FerretDbFleet is the implementation; the interface keeps the manager independent of it.
 */
export interface DocumentEngine {
  readonly kind: "ferretdb" | "mongodb";
  readonly version: string;
  /** Makes sure the endpoint for this PostgreSQL database is running on `port`. */
  ensure(pgDatabase: string, port: number): Promise<void>;
  /** Stops one database's endpoint (before deleting it). */
  stopOne(pgDatabase: string): Promise<void>;
  running(): string[];
  stop(): Promise<void>;
}

export interface FleetOptions {
  bin: FerretBinaries;
  /** PostgreSQL port (read each time: the database server can move to another port). */
  pgPort: () => number;
  stateDir: string;
  logger?: Logger;
}

function portOpen(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host: "127.0.0.1", port });
    const done = (ok: boolean) => (s.destroy(), resolve(ok));
    s.setTimeout(timeoutMs, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

function killPid(pid: number): void {
  try {
    process.kill(pid);
  } catch {
    /* already gone */
  }
}

/**
 * One FerretDB process per document database, each serving only that database's PostgreSQL
 * database. Separate processes mean one application can't even see another's collection names.
 * FerretDB keeps no data of its own (everything is in PostgreSQL), so a process left behind by a
 * crash is simply replaced, and a crashed process is restarted on next use.
 */
export class FerretDbFleet implements DocumentEngine {
  readonly kind = "ferretdb" as const;
  private readonly procs = new Map<string, { child: ChildProcess; port: number }>();
  private readonly starting = new Map<string, Promise<void>>();
  private readonly log: Logger;
  private stopping = false;

  constructor(private readonly opts: FleetOptions) {
    this.log = opts.logger ?? silentLogger;
    mkdirSync(opts.stateDir, { recursive: true });
  }

  get version(): string {
    return this.opts.bin.version;
  }

  running(): string[] {
    return [...this.procs.keys()];
  }

  /** Command line for one database's endpoint: loopback only, no telemetry, PostgreSQL does the auth. */
  static args(o: { pgPort: number; pgDatabase: string; port: number; stateDir: string }): string[] {
    return [
      "--handler=postgresql",
      `--postgresql-url=postgres://127.0.0.1:${o.pgPort}/${o.pgDatabase}`,
      `--listen-addr=127.0.0.1:${o.port}`,
      "--telemetry=disable",
      // No metrics/debug web server (it would also clash between processes on its fixed port).
      "--debug-addr=-",
      `--state-dir=${o.stateDir}`,
      "--log-level=warn",
    ];
  }

  ensure(pgDatabase: string, port: number): Promise<void> {
    const current = this.procs.get(pgDatabase);
    if (current && current.port === port && current.child.exitCode === null) return Promise.resolve();
    let job = this.starting.get(pgDatabase);
    if (!job) {
      job = this.start(pgDatabase, port).finally(() => this.starting.delete(pgDatabase));
      this.starting.set(pgDatabase, job);
    }
    return job;
  }

  private async start(pgDatabase: string, port: number): Promise<void> {
    this.stopping = false;
    const old = this.procs.get(pgDatabase);
    if (old) {
      old.child.kill();
      this.procs.delete(pgDatabase);
    }
    const dir = join(this.opts.stateDir, pgDatabase);
    mkdirSync(dir, { recursive: true });
    // A process from an earlier Nexus run (crash) holds no data: replace it.
    const pidFile = join(dir, "ferretdb.pid");
    if (existsSync(pidFile)) {
      killPid(Number(readFileSync(pidFile, "utf8")));
      rmSync(pidFile, { force: true });
      for (let i = 0; i < 20 && (await portOpen(port)); i++) await new Promise((r) => setTimeout(r, 100));
    }
    if (await portOpen(port)) {
      throw new NexusError("infrastructure", "Another program is using the document database's private port.", {
        problem: {
          title: "Document database port in use",
          summary: `Port ${port} is taken by another program, so the document database can't start.`,
          checks: [{ label: `Port ${port}`, status: "failed" }],
          repair: { id: "documents.start", label: "Try Again", requiresConfirmation: false },
        },
      });
    }
    const child = spawn(this.opts.bin.exe, FerretDbFleet.args({ pgPort: this.opts.pgPort(), pgDatabase, port, stateDir: dir }), { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr!.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)));
    if (child.pid) writeFileSync(pidFile, String(child.pid));
    this.procs.set(pgDatabase, { child, port });
    let exited = false;
    child.once("exit", (code) => {
      exited = true;
      if (this.procs.get(pgDatabase)?.child === child) this.procs.delete(pgDatabase);
      rmSync(pidFile, { force: true });
      if (!this.stopping) this.log.warn("document database endpoint stopped", { pgDatabase, code, stderr: stderr.slice(-500) });
    });
    for (let i = 0; i < 100 && !exited; i++) {
      if (await portOpen(port)) {
        this.log.info("document database endpoint started", { pgDatabase, port });
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    child.kill();
    throw new NexusError("infrastructure", "The document database could not start.", {
      problem: { title: "Document database did not start", summary: "Nexus tried to start the document database but it did not come online.", checks: [{ label: "Document database", status: "failed" }], technical: stderr, repair: { id: "documents.start", label: "Try Again", requiresConfirmation: false } },
    });
  }

  async stopOne(pgDatabase: string): Promise<void> {
    const p = this.procs.get(pgDatabase);
    if (!p) return;
    this.procs.delete(pgDatabase);
    await new Promise<void>((resolve) => {
      if (p.child.exitCode !== null) return resolve();
      p.child.once("exit", () => resolve());
      p.child.kill();
      setTimeout(resolve, 5000).unref();
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.all([...this.procs.keys()].map((k) => this.stopOne(k)));
  }
}
