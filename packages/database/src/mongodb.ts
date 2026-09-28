import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join, resolve, sep } from "node:path";
import { MongoClient } from "mongodb";
import { NexusError, silentLogger, type Logger } from "@nexus/shared";
import type { DocumentEngine } from "./ferretdb";

export interface MongoDbBinaries {
  exe: string;
  version: string;
  source: "bundled" | "configured";
}

/** Finds a Nexus-bundled or administrator-configured MongoDB Community Server. */
export function locateMongoDb(opts: { configured?: string | null; bundledRoots?: string[] } = {}): MongoDbBinaries | null {
  if (opts.configured && existsSync(opts.configured)) {
    return { exe: opts.configured, version: opts.configured.match(/(\d+\.\d+\.\d+)/)?.[1] ?? "unknown", source: "configured" };
  }
  for (const root of opts.bundledRoots ?? []) {
    if (!existsSync(root)) continue;
    const versions = readdirSync(root)
      .filter((v) => existsSync(join(root, v, "bin", "mongod.exe")))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    if (versions[0]) return { exe: join(root, versions[0], "bin", "mongod.exe"), version: versions[0], source: "bundled" };
  }
  return null;
}

export interface MongoDbEngineCredentials {
  username: string;
  password: string;
  keyFile: string;
}

export interface MongoDbFleetOptions {
  bin: MongoDbBinaries;
  stateDir: string;
  credentials: (databaseKey: string) => MongoDbEngineCredentials;
  logger?: Logger;
}

function portOpen(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function killPid(pid: number): void {
  try {
    process.kill(pid);
  } catch {
    // The process is already gone.
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const safeKey = (key: string) => key.replace(/[^A-Za-z0-9_.-]/g, "_");

/**
 * One isolated, single-node MongoDB replica set per Nexus document database.
 *
 * A single node is enough to provide real MongoDB transaction semantics while keeping the service
 * loopback-only. Each database gets a different port, data directory, replica-set identity,
 * keyfile, administrator credential, and set of application users.
 */
export class MongoDbFleet implements DocumentEngine {
  readonly kind = "mongodb" as const;
  private readonly procs = new Map<string, { child: ChildProcess; port: number }>();
  private readonly starting = new Map<string, Promise<void>>();
  private readonly log: Logger;
  private stopping = false;

  constructor(private readonly opts: MongoDbFleetOptions) {
    this.log = opts.logger ?? silentLogger;
    mkdirSync(opts.stateDir, { recursive: true });
  }

  get version(): string {
    return this.opts.bin.version;
  }

  running(): string[] {
    return [...this.procs.keys()];
  }

  replicaSet(databaseKey: string): string {
    return `nexus_${createHash("sha256").update(databaseKey).digest("hex").slice(0, 16)}`;
  }

  private databaseDir(databaseKey: string): string {
    return join(this.opts.stateDir, safeKey(databaseKey));
  }

  private state(databaseKey: string): { initialized: true; port: number; replicaSet: string } | null {
    const file = join(this.databaseDir(databaseKey), "state.json");
    if (!existsSync(file)) return null;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { initialized?: boolean; port?: number; replicaSet?: string };
      return parsed.initialized && Number.isInteger(parsed.port) && parsed.replicaSet
        ? { initialized: true, port: parsed.port!, replicaSet: parsed.replicaSet }
        : null;
    } catch {
      return null;
    }
  }

  static args(input: { dbPath: string; port: number; replicaSet: string; logPath: string; keyFile?: string }): string[] {
    const args = [
      "--dbpath",
      input.dbPath,
      "--port",
      String(input.port),
      "--bind_ip",
      "127.0.0.1",
      "--replSet",
      input.replicaSet,
      "--logpath",
      input.logPath,
      "--logappend",
      "--quiet",
    ];
    if (input.keyFile) args.push("--auth", "--keyFile", input.keyFile);
    return args;
  }

  ensure(databaseKey: string, port: number): Promise<void> {
    const current = this.procs.get(databaseKey);
    if (current && current.port === port && current.child.exitCode === null) return Promise.resolve();
    let job = this.starting.get(databaseKey);
    if (!job) {
      job = this.start(databaseKey, port).finally(() => this.starting.delete(databaseKey));
      this.starting.set(databaseKey, job);
    }
    return job;
  }

  private async start(databaseKey: string, port: number): Promise<void> {
    this.stopping = false;
    await this.stopOne(databaseKey);
    const dir = this.databaseDir(databaseKey);
    const dbPath = join(dir, "data");
    const logPath = join(dir, "mongod.log");
    const pidFile = join(dir, "mongod.pid");
    const keyFile = join(dir, "replica.key");
    mkdirSync(dbPath, { recursive: true });
    const credentials = this.opts.credentials(databaseKey);
    writeFileSync(keyFile, `${credentials.keyFile}\n`, { mode: 0o600 });

    if (existsSync(pidFile)) {
      killPid(Number(readFileSync(pidFile, "utf8")));
      rmSync(pidFile, { force: true });
      for (let i = 0; i < 30 && (await portOpen(port)); i++) await wait(100);
    }
    if (await portOpen(port)) throw this.portProblem(port);

    const replicaSet = this.replicaSet(databaseKey);
    const state = this.state(databaseKey);
    if (state && (state.port !== port || state.replicaSet !== replicaSet)) {
      throw new NexusError("infrastructure", "The MongoDB replica set's private port changed unexpectedly.", {
        problem: {
          title: "MongoDB replica-set address changed",
          summary: `This database was initialized on private port ${state.port}, but Nexus was asked to start it on ${port}.`,
          checks: [{ label: `Private port ${state.port}`, status: "failed", detail: "Free this port and try again; Nexus will not silently rewrite a replica-set identity." }],
        },
      });
    }

    if (!state) {
      const bootstrap = this.spawn(databaseKey, port, dbPath, replicaSet, logPath);
      try {
        await this.waitForPort(bootstrap.child, port, bootstrap.stderr);
        await this.initialize(databaseKey, port, replicaSet, credentials);
      } finally {
        await this.stopChild(bootstrap.child);
        this.procs.delete(databaseKey);
        rmSync(pidFile, { force: true });
      }
      writeFileSync(join(dir, "state.json"), JSON.stringify({ initialized: true, port, replicaSet }, null, 2));
      for (let i = 0; i < 30 && (await portOpen(port)); i++) await wait(100);
    }

    const secured = this.spawn(databaseKey, port, dbPath, replicaSet, logPath, keyFile);
    await this.waitForPort(secured.child, port, secured.stderr);
    const client = await this.adminClient(databaseKey, port);
    try {
      const hello = await client.db("admin").command({ hello: 1 });
      if (hello.setName !== replicaSet || hello.isWritablePrimary !== true) throw new Error("MongoDB replica set did not elect its primary.");
    } catch (error) {
      await this.stopOne(databaseKey);
      throw this.startProblem(secured.stderr(), error);
    } finally {
      await client.close().catch(() => undefined);
    }
    this.log.info("transactional document database started", { databaseKey, port, replicaSet });
  }

  private spawn(databaseKey: string, port: number, dbPath: string, replicaSet: string, logPath: string, keyFile?: string) {
    let stderr = "";
    const child = spawn(this.opts.bin.exe, MongoDbFleet.args({ dbPath, port, replicaSet, logPath, keyFile }), {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr!.on("data", (data: Buffer) => (stderr = (stderr + data.toString()).slice(-8000)));
    const pidFile = join(this.databaseDir(databaseKey), "mongod.pid");
    if (child.pid) writeFileSync(pidFile, String(child.pid));
    this.procs.set(databaseKey, { child, port });
    child.once("exit", (code) => {
      if (this.procs.get(databaseKey)?.child === child) this.procs.delete(databaseKey);
      rmSync(pidFile, { force: true });
      if (!this.stopping && code !== 0) this.log.warn("transactional document database stopped", { databaseKey, code, stderr: stderr.slice(-1000) });
    });
    return {
      child,
      stderr: () => {
        if (!existsSync(logPath)) return stderr;
        try {
          return `${stderr}\n${readFileSync(logPath, "utf8")}`.slice(-8000);
        } catch {
          return stderr;
        }
      },
    };
  }

  private async waitForPort(child: ChildProcess, port: number, stderr: () => string): Promise<void> {
    for (let i = 0; i < 200 && child.exitCode === null; i++) {
      if (await portOpen(port)) return;
      await wait(100);
    }
    throw this.startProblem(stderr());
  }

  private async initialize(databaseKey: string, port: number, replicaSet: string, credentials: MongoDbEngineCredentials): Promise<void> {
    const client = new MongoClient(`mongodb://127.0.0.1:${port}/admin?directConnection=true`, {
      serverSelectionTimeoutMS: 10_000,
      connectTimeoutMS: 5_000,
      appName: "nexus-bootstrap",
    });
    await client.connect();
    try {
      try {
        await client.db("admin").command({ replSetInitiate: { _id: replicaSet, members: [{ _id: 0, host: `127.0.0.1:${port}` }] } });
      } catch (error) {
        const codeName = String((error as { codeName?: string }).codeName ?? "");
        if (!/AlreadyInitialized/i.test(codeName + (error as Error).message)) throw error;
      }
      for (let i = 0; i < 200; i++) {
        const hello = await client.db("admin").command({ hello: 1 }).catch(() => null);
        if (hello?.isWritablePrimary === true && hello.setName === replicaSet) break;
        if (i === 199) throw new Error("MongoDB replica set did not elect a primary during initialization.");
        await wait(100);
      }
      try {
        await client.db("admin").command({ createUser: credentials.username, pwd: credentials.password, roles: [{ role: "root", db: "admin" }] });
      } catch (error) {
        if ((error as { code?: number }).code !== 51003 && !/already exists/i.test((error as Error).message)) throw error;
        await client.db("admin").command({ updateUser: credentials.username, pwd: credentials.password, roles: [{ role: "root", db: "admin" }] });
      }
    } finally {
      await client.close();
    }
  }

  async adminClient(databaseKey: string, port: number): Promise<MongoClient> {
    const credentials = this.opts.credentials(databaseKey);
    const url = `mongodb://${encodeURIComponent(credentials.username)}:${encodeURIComponent(credentials.password)}@127.0.0.1:${port}/admin?authSource=admin&replicaSet=${encodeURIComponent(this.replicaSet(databaseKey))}&directConnection=true`;
    const client = new MongoClient(url, { serverSelectionTimeoutMS: 10_000, connectTimeoutMS: 5_000, appName: "nexus" });
    await client.connect();
    return client;
  }

  applicationUrl(databaseKey: string, port: number, database: string, username: string, password: string): string {
    return `mongodb://${encodeURIComponent(username)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${encodeURIComponent(database)}?authSource=${encodeURIComponent(database)}&replicaSet=${encodeURIComponent(this.replicaSet(databaseKey))}&directConnection=true`;
  }

  async stopOne(databaseKey: string): Promise<void> {
    const record = this.procs.get(databaseKey);
    if (!record) return;
    this.procs.delete(databaseKey);
    await this.stopChild(record.child);
  }

  private async stopChild(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      child.once("exit", finish);
      child.kill();
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
        finish();
      }, 10_000).unref();
    });
  }

  async destroy(databaseKey: string): Promise<void> {
    await this.stopOne(databaseKey);
    const root = resolve(this.opts.stateDir);
    const target = resolve(this.databaseDir(databaseKey));
    const checkedRoot = existsSync(root) ? realpathSync(root) : root;
    const checkedTarget = existsSync(target) ? realpathSync(target) : target;
    if (!checkedTarget.startsWith(`${checkedRoot}${sep}`)) throw new Error("Refusing to remove a MongoDB directory outside the Nexus document-data root.");
    rmSync(checkedTarget, { recursive: true, force: true });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.all([...this.procs.keys()].map((key) => this.stopOne(key)));
  }

  private portProblem(port: number): NexusError {
    return new NexusError("infrastructure", "Another program is using the transactional document database's private port.", {
      problem: {
        title: "MongoDB private port in use",
        summary: `Port ${port} is already in use. Nexus kept the replica-set address unchanged to protect database identity and transaction safety.`,
        checks: [{ label: `Port ${port}`, status: "failed" }],
      },
    });
  }

  private startProblem(stderr: string, cause?: unknown): NexusError {
    return new NexusError("infrastructure", "The transactional document database could not start.", {
      cause,
      problem: {
        title: "MongoDB replica set did not start",
        summary: "Nexus could not start the private transaction-capable MongoDB service.",
        checks: [{ label: "MongoDB replica set", status: "failed" }],
        technical: stderr.slice(-4000) || (cause as Error | undefined)?.message,
      },
    });
  }
}
