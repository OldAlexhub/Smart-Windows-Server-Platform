import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  cpSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { buildIsolatedEnv, killTree } from "@nexus/runtime";
import { NexusError, silentLogger, type Logger } from "@nexus/shared";
import { fromJson, type Migration, type StateStore } from "@nexus/state";
import {
  capabilityInfo,
  parsePluginManifest,
  PLUGIN_API_VERSION,
  PLUGIN_CAPABILITIES,
  type PluginCapability,
  type PluginManifest,
} from "./manifest";

const MANIFEST = "nexus-plugin.json";
const MAX_FILES = 10_000;
const MAX_BYTES = 512 * 1024 ** 2;
const MAX_PROTOCOL_LINE = 1024 * 1024;

export type PluginStatus = "installed" | "starting" | "running" | "stopped" | "crashed" | "tampered";

interface PluginRow {
  id: string;
  manifest: string;
  version: string;
  enabled: number;
  digest: string;
  installed_at: string;
  updated_at: string;
  last_started_at: string | null;
  status: PluginStatus;
  last_error: string | null;
}

export interface PluginInspection {
  manifest: PluginManifest;
  capabilities: ReturnType<typeof capabilityInfo>;
  digest: string;
  files: number;
  bytes: number;
  sourceLabel: string;
}

export interface PluginView {
  id: string;
  name: string;
  version: string;
  publisher: string;
  description: string;
  license: string;
  homepage: string | null;
  capabilities: ReturnType<typeof capabilityInfo>;
  enabled: boolean;
  status: PluginStatus;
  lastError: string | null;
  installedAt: string;
  updatedAt: string;
  lastStartedAt: string | null;
  logs: { at: string; level: "info" | "warning" | "error"; message: string }[];
}

export const pluginMigrations: Migration[] = [
  {
    id: "plugins/001_installed",
    up: `CREATE TABLE plugins (
      id TEXT PRIMARY KEY,
      manifest TEXT NOT NULL,
      version TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
      digest TEXT NOT NULL,
      installed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_started_at TEXT,
      status TEXT NOT NULL,
      last_error TEXT
    )`,
  },
];

export interface PluginManagerOptions {
  root: string;
  logger?: Logger;
  nodeExecutable?: string;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

class PluginProcess {
  private child: ChildProcess | null = null;
  private requestedStop = false;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(
    private readonly manifest: PluginManifest,
    private readonly folder: string,
    private readonly runtimeHome: string,
    private readonly nodeExecutable: string,
    private readonly startupTimeoutMs: number,
    private readonly requestTimeoutMs: number,
    private readonly log: (level: "info" | "warning" | "error", message: string) => void,
    private readonly exited: (unexpected: boolean, detail: string) => void,
  ) {}

  get running(): boolean {
    return !!this.child && this.child.exitCode === null && !this.child.killed;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.requestedStop = false;
    mkdirSync(this.runtimeHome, { recursive: true });
    const entry = resolve(this.folder, this.manifest.entry);
    const env = buildIsolatedEnv({
      homeDir: this.runtimeHome,
      pathDirs: [dirname(this.nodeExecutable)],
      appEnv: {
        NEXUS_PLUGIN_ID: this.manifest.id,
        NEXUS_PLUGIN_PROTOCOL: String(PLUGIN_API_VERSION),
        NEXUS_PLUGIN_CAPABILITIES: this.manifest.capabilities.join(","),
      },
      port: 0,
    });
    const child = spawn(this.nodeExecutable, [entry], {
      cwd: this.folder,
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    let ready = false;
    let settleReady: (() => void) | null = null;
    let rejectReady: ((error: Error) => void) | null = null;
    const readyPromise = new Promise<void>((resolveReady, reject) => {
      settleReady = resolveReady;
      rejectReady = reject;
    });
    const failReady = (message: string) => {
      if (!ready) rejectReady?.(new Error(message));
    };

    child.once("error", (error) => failReady(`The plugin process couldn't start: ${error.message}`));
    child.once("exit", (code, signal) => {
      const unexpected = !this.requestedStop;
      const detail = `Stopped${unexpected ? " unexpectedly" : ""} (${code !== null ? `exit code ${code}` : (signal ?? "unknown")}).`;
      this.child = null;
      failReady(detail);
      this.rejectPending(new Error(detail));
      this.exited(unexpected, detail);
    });

    const stdout = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    stdout.on("line", (line) => {
      if (line.length > MAX_PROTOCOL_LINE) {
        this.log("error", "The plugin sent an oversized protocol message.");
        void this.stop();
        return;
      }
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.log(ready ? "info" : "error", line.slice(0, 2000));
        if (!ready) failReady("The plugin didn't send the required ready message.");
        return;
      }
      if (!ready) {
        const caps = Array.isArray(message.capabilities) ? message.capabilities.map(String).sort() : [];
        const expected = [...this.manifest.capabilities].sort();
        if (
          message.type !== "ready" ||
          message.protocol !== PLUGIN_API_VERSION ||
          JSON.stringify(caps) !== JSON.stringify(expected)
        ) {
          failReady("The plugin's ready message doesn't match its manifest or this Nexus plugin API version.");
          return;
        }
        ready = true;
        settleReady?.();
        return;
      }
      if (message.type === "response" && typeof message.id === "string") {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.ok === true) pending.resolve(message.result);
        else
          pending.reject(
            new Error(typeof message.error === "string" ? message.error : "The plugin couldn't complete the request."),
          );
      } else if (message.type === "log" && typeof message.message === "string") {
        const level = message.level === "error" ? "error" : message.level === "warning" ? "warning" : "info";
        this.log(level, message.message.slice(0, 2000));
      }
    });
    const stderr = createInterface({ input: child.stderr!, crlfDelay: Infinity });
    stderr.on("line", (line) => this.log("error", line.slice(0, 2000)));

    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error("The plugin didn't become ready in time.")),
        this.startupTimeoutMs,
      );
      timer.unref();
    });
    try {
      await Promise.race([readyPromise, timeout]);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async request(capability: PluginCapability, action: string, payload: unknown): Promise<unknown> {
    const child = this.child;
    if (!child?.stdin || !this.running) throw NexusError.conflict(`${this.manifest.name} isn't running.`);
    if (!this.manifest.capabilities.includes(capability))
      throw NexusError.forbidden(`${this.manifest.name} doesn't declare the ${capability} capability.`);
    if (!/^[a-z][a-z0-9.-]{1,100}$/.test(action)) throw NexusError.invalid("That plugin action name isn't valid.");
    const id = randomUUID();
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.manifest.name} didn't answer in time.`));
      }, this.requestTimeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
    });
    const line = JSON.stringify({ type: "request", id, capability, action, payload });
    if (Buffer.byteLength(line) > MAX_PROTOCOL_LINE) {
      const pending = this.pending.get(id)!;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      throw NexusError.invalid("That plugin request is too large.");
    }
    child.stdin.write(`${line}\n`);
    return response;
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child?.pid) return;
    this.requestedStop = true;
    child.stdin?.end();
    const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
    await killTree(child.pid, false);
    const timeout = new Promise<"timeout">((resolveTimeout) => {
      const timer = setTimeout(() => resolveTimeout("timeout"), 5000);
      timer.unref();
    });
    if ((await Promise.race([exited, timeout])) === "timeout") await killTree(child.pid, true);
    this.child = null;
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

/** Installs immutable local plugin copies and supervises their opt-in processes. */
export class PluginManager {
  private readonly root: string;
  private readonly packagesRoot: string;
  private readonly runtimeRoot: string;
  private readonly logger: Logger;
  private readonly nodeExecutable: string;
  private readonly startupTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly running = new Map<string, PluginProcess>();
  private readonly logs = new Map<string, PluginView["logs"]>();

  constructor(
    private readonly store: StateStore,
    options: PluginManagerOptions,
  ) {
    this.root = resolve(options.root);
    this.packagesRoot = join(this.root, "packages");
    this.runtimeRoot = join(this.root, "runtime");
    this.logger = options.logger ?? silentLogger;
    this.nodeExecutable = options.nodeExecutable ?? process.execPath;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 10_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    mkdirSync(this.packagesRoot, { recursive: true });
    mkdirSync(this.runtimeRoot, { recursive: true });
    store.migrate(pluginMigrations);
    // No process survives a service restart; enabled plugins are started explicitly by startEnabled().
    store.run("UPDATE plugins SET status = 'stopped' WHERE status IN ('starting', 'running')");
  }

  capabilities(): ReturnType<typeof capabilityInfo> {
    return capabilityInfo(Object.keys(PLUGIN_CAPABILITIES) as PluginCapability[]);
  }

  async inspect(sourceDir: string): Promise<PluginInspection> {
    const source = resolve(sourceDir);
    if (within(this.root, source))
      throw NexusError.invalid("Choose the original plugin folder, not Nexus's managed plugin folder.");
    if (!existsSync(source) || !statSync(source).isDirectory()) throw NexusError.notFound("Plugin folder");
    const manifestFile = join(source, MANIFEST);
    if (!existsSync(manifestFile)) throw NexusError.invalid(`That folder has no ${MANIFEST} file.`);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(manifestFile, "utf8"));
    } catch {
      throw NexusError.invalid(`${MANIFEST} isn't valid JSON.`);
    }
    const manifest = parsePluginManifest(raw);
    const entry = resolve(source, manifest.entry);
    if (!within(source, entry) || !existsSync(entry) || !statSync(entry).isFile())
      throw NexusError.invalid(`The plugin entry file ${manifest.entry} wasn't found.`);
    const measured = await digestDirectory(source);
    return {
      manifest,
      capabilities: capabilityInfo(manifest.capabilities),
      ...measured,
      sourceLabel: basename(source),
    };
  }

  list(): PluginView[] {
    return this.store
      .all<PluginRow>("SELECT * FROM plugins ORDER BY json_extract(manifest, '$.name') COLLATE NOCASE")
      .map((row) => this.view(row));
  }

  get(id: string): PluginView | undefined {
    const row = this.row(id);
    return row ? this.view(row) : undefined;
  }

  require(id: string): PluginView {
    const plugin = this.get(id);
    if (!plugin) throw NexusError.notFound("Plugin");
    return plugin;
  }

  async install(
    sourceDir: string,
    approvedCapabilities: readonly PluginCapability[],
    confirmation: string,
  ): Promise<PluginView> {
    const inspected = await this.inspect(sourceDir);
    if (this.row(inspected.manifest.id))
      throw NexusError.conflict(`${inspected.manifest.name} is already installed. Use Update instead.`);
    if (confirmation !== inspected.manifest.name)
      throw NexusError.invalid(`Type "${inspected.manifest.name}" to confirm installing this plugin.`);
    assertApprovals(inspected.manifest, approvedCapabilities);
    const destination = this.folder(inspected.manifest.id);
    const staging = join(this.packagesRoot, `.staging-${randomUUID()}`);
    try {
      cpSync(resolve(sourceDir), staging, { recursive: true, errorOnExist: true, force: false });
      const copied = await digestDirectory(staging);
      if (copied.digest !== inspected.digest)
        throw NexusError.conflict("The plugin folder changed while Nexus was copying it. Try again.");
      renameSync(staging, destination);
      const now = new Date().toISOString();
      this.store.run(
        "INSERT INTO plugins (id, manifest, version, enabled, digest, installed_at, updated_at, status) VALUES (?, ?, ?, 0, ?, ?, ?, 'installed')",
        [
          inspected.manifest.id,
          JSON.stringify(inspected.manifest),
          inspected.manifest.version,
          inspected.digest,
          now,
          now,
        ],
      );
      this.appendLog(
        inspected.manifest.id,
        "info",
        `Installed ${inspected.manifest.name} ${inspected.manifest.version}; it is off until an administrator enables it.`,
      );
      return this.require(inspected.manifest.id);
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      if (existsSync(destination) && !this.row(inspected.manifest.id))
        rmSync(destination, { recursive: true, force: true });
      throw error;
    }
  }

  async update(
    id: string,
    sourceDir: string,
    approvedCapabilities: readonly PluginCapability[],
    confirmation: string,
  ): Promise<PluginView> {
    const before = this.requireRow(id);
    const current = parsePluginManifest(fromJson(before.manifest, null));
    if (confirmation !== current.name)
      throw NexusError.invalid(`Type "${current.name}" to confirm updating this plugin.`);
    const inspected = await this.inspect(sourceDir);
    if (inspected.manifest.id !== id) throw NexusError.invalid(`This package is ${inspected.manifest.id}, not ${id}.`);
    if (inspected.manifest.version === before.version)
      throw NexusError.invalid(`${inspected.manifest.name} ${before.version} is already installed.`);
    assertApprovals(inspected.manifest, approvedCapabilities);
    const destination = this.folder(id);
    const staging = join(this.packagesRoot, `.staging-${randomUUID()}`);
    const backup = join(this.packagesRoot, `.rollback-${randomUUID()}`);
    let swapped = false;
    await this.stop(id);
    try {
      cpSync(resolve(sourceDir), staging, { recursive: true, errorOnExist: true, force: false });
      const copied = await digestDirectory(staging);
      if (copied.digest !== inspected.digest)
        throw NexusError.conflict("The plugin folder changed while Nexus was copying it. Try again.");
      renameSync(destination, backup);
      renameSync(staging, destination);
      swapped = true;
      const now = new Date().toISOString();
      this.store.run(
        "UPDATE plugins SET manifest = ?, version = ?, digest = ?, updated_at = ?, status = 'stopped', last_error = NULL WHERE id = ?",
        [JSON.stringify(inspected.manifest), inspected.manifest.version, inspected.digest, now, id],
      );
      if (before.enabled) {
        try {
          await this.start(id);
        } catch (error) {
          await this.stop(id);
          rmSync(destination, { recursive: true, force: true });
          renameSync(backup, destination);
          swapped = false;
          this.restore(before);
          await this.start(id).catch(() => undefined);
          throw NexusError.conflict(
            `The update couldn't start, so Nexus kept ${before.version}. ${(error as Error).message}`,
          );
        }
      }
      rmSync(backup, { recursive: true, force: true });
      this.appendLog(id, "info", `Updated from ${before.version} to ${inspected.manifest.version}.`);
      return this.require(id);
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      if (swapped && existsSync(backup)) {
        rmSync(destination, { recursive: true, force: true });
        renameSync(backup, destination);
        this.restore(before);
      } else if (existsSync(backup) && !existsSync(destination)) {
        renameSync(backup, destination);
      }
      throw error;
    }
  }

  async setEnabled(id: string, enabled: boolean): Promise<PluginView> {
    const row = this.requireRow(id);
    if (!enabled) {
      this.store.run("UPDATE plugins SET enabled = 0 WHERE id = ?", [id]);
      await this.stop(id);
      return this.require(id);
    }
    this.store.run("UPDATE plugins SET enabled = 1 WHERE id = ?", [id]);
    try {
      await this.start(id);
    } catch (error) {
      if (this.requireRow(id).status !== "tampered") this.setStatus(id, "crashed", (error as Error).message);
    }
    return this.require(row.id);
  }

  async start(id: string): Promise<PluginView> {
    const row = this.requireRow(id);
    if (this.running.get(id)?.running) return this.require(id);
    const actual = await digestDirectory(this.folder(id)).catch(() => null);
    if (!actual || actual.digest !== row.digest) {
      this.setStatus(
        id,
        "tampered",
        "The installed plugin files changed after installation. Reinstall or update it before enabling it.",
      );
      throw NexusError.conflict(
        "The installed plugin files changed after installation. Reinstall or update the plugin.",
      );
    }
    const manifest = parsePluginManifest(fromJson(row.manifest, null));
    this.setStatus(id, "starting", null);
    const runtime = new PluginProcess(
      manifest,
      this.folder(id),
      join(this.runtimeRoot, id),
      this.nodeExecutable,
      this.startupTimeoutMs,
      this.requestTimeoutMs,
      (level, message) => this.appendLog(id, level, message),
      (unexpected, detail) => {
        if (this.running.get(id) === runtime) this.running.delete(id);
        if (unexpected) this.setStatus(id, "crashed", detail);
      },
    );
    this.running.set(id, runtime);
    try {
      await runtime.start();
      const now = new Date().toISOString();
      this.store.run("UPDATE plugins SET status = 'running', last_error = NULL, last_started_at = ? WHERE id = ?", [
        now,
        id,
      ]);
      this.appendLog(id, "info", "Plugin is ready.");
      return this.require(id);
    } catch (error) {
      this.running.delete(id);
      this.setStatus(id, "crashed", (error as Error).message);
      throw error;
    }
  }

  async stop(id: string): Promise<void> {
    this.requireRow(id);
    const runtime = this.running.get(id);
    if (runtime) await runtime.stop();
    this.running.delete(id);
    this.setStatus(id, "stopped", null);
  }

  async restart(id: string): Promise<PluginView> {
    const row = this.requireRow(id);
    if (!row.enabled) throw NexusError.conflict("Turn this plugin on before restarting it.");
    await this.stop(id);
    return this.start(id);
  }

  async startEnabled(): Promise<void> {
    for (const row of this.store.all<PluginRow>("SELECT * FROM plugins WHERE enabled = 1 ORDER BY id")) {
      await this.start(row.id).catch((error) =>
        this.logger.error("plugin failed to start", { pluginId: row.id, err: error as Error }),
      );
    }
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.running.keys()]) await this.stop(id).catch(() => undefined);
  }

  async request(id: string, capability: PluginCapability, action: string, payload: unknown): Promise<unknown> {
    const row = this.requireRow(id);
    const manifest = parsePluginManifest(fromJson(row.manifest, null));
    if (!manifest.capabilities.includes(capability))
      throw NexusError.forbidden(`${manifest.name} doesn't declare the ${capability} capability.`);
    let runtime = this.running.get(id);
    if (!runtime?.running) {
      if (!row.enabled) throw NexusError.conflict(`${manifest.name} is switched off.`);
      await this.start(id);
      runtime = this.running.get(id);
    }
    return runtime!.request(capability, action, payload);
  }

  async uninstall(id: string, confirmation: string): Promise<void> {
    const row = this.requireRow(id);
    const manifest = parsePluginManifest(fromJson(row.manifest, null));
    if (confirmation !== manifest.name)
      throw NexusError.invalid(`Type "${manifest.name}" to confirm removing this plugin.`);
    await this.stop(id);
    const folder = this.folder(id);
    const trash = join(this.root, `.remove-${randomUUID()}`);
    if (existsSync(folder)) renameSync(folder, trash);
    try {
      this.store.run("DELETE FROM plugins WHERE id = ?", [id]);
      rmSync(trash, { recursive: true, force: true });
      rmSync(join(this.runtimeRoot, id), { recursive: true, force: true });
      this.logs.delete(id);
    } catch (error) {
      if (existsSync(trash) && !existsSync(folder)) renameSync(trash, folder);
      throw error;
    }
  }

  private row(id: string): PluginRow | undefined {
    return this.store.get<PluginRow>("SELECT * FROM plugins WHERE id = ?", [id]);
  }

  private requireRow(id: string): PluginRow {
    const row = this.row(id);
    if (!row) throw NexusError.notFound("Plugin");
    return row;
  }

  private folder(id: string): string {
    return join(this.packagesRoot, id);
  }

  private view(row: PluginRow): PluginView {
    const manifest = parsePluginManifest(fromJson(row.manifest, null));
    return {
      id: row.id,
      name: manifest.name,
      version: row.version,
      publisher: manifest.publisher,
      description: manifest.description,
      license: manifest.license,
      homepage: manifest.homepage ?? null,
      capabilities: capabilityInfo(manifest.capabilities),
      enabled: !!row.enabled,
      status: row.status,
      lastError: row.last_error,
      installedAt: row.installed_at,
      updatedAt: row.updated_at,
      lastStartedAt: row.last_started_at,
      logs: [...(this.logs.get(row.id) ?? [])],
    };
  }

  private setStatus(id: string, status: PluginStatus, error: string | null): void {
    this.store.run("UPDATE plugins SET status = ?, last_error = ? WHERE id = ?", [status, error, id]);
    if (error) this.appendLog(id, "error", error);
  }

  private appendLog(id: string, level: "info" | "warning" | "error", message: string): void {
    const logs = this.logs.get(id) ?? [];
    logs.push({ at: new Date().toISOString(), level, message: message.replace(/[\r\n]+/g, " ").slice(0, 2000) });
    if (logs.length > 100) logs.splice(0, logs.length - 100);
    this.logs.set(id, logs);
    this.logger[level === "warning" ? "warn" : level](`plugin: ${message}`, { pluginId: id });
  }

  private restore(row: PluginRow): void {
    this.store.run(
      `UPDATE plugins SET manifest = ?, version = ?, enabled = ?, digest = ?, installed_at = ?, updated_at = ?,
       last_started_at = ?, status = ?, last_error = ? WHERE id = ?`,
      [
        row.manifest,
        row.version,
        row.enabled,
        row.digest,
        row.installed_at,
        row.updated_at,
        row.last_started_at,
        row.status,
        row.last_error,
        row.id,
      ],
    );
  }
}

function assertApprovals(manifest: PluginManifest, approved: readonly PluginCapability[]): void {
  const wanted = [...manifest.capabilities].sort();
  const got = [...new Set(approved)].sort();
  if (JSON.stringify(wanted) !== JSON.stringify(got)) {
    throw NexusError.forbidden(`Approve every capability requested by ${manifest.name} before installing it.`);
  }
}

function within(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function digestDirectory(root: string): Promise<{ digest: string; files: number; bytes: number }> {
  const paths: string[] = [];
  let bytes = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink())
        throw NexusError.invalid("Plugin packages can't contain shortcuts, symbolic links, or junctions.");
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        paths.push(full);
        bytes += stat.size;
        if (paths.length > MAX_FILES || bytes > MAX_BYTES)
          throw NexusError.invalid("This plugin package is too large (maximum 10,000 files and 512 MB).");
      }
    }
  };
  walk(root);
  paths.sort((a, b) => relative(root, a).localeCompare(relative(root, b)));
  const hash = createHash("sha256");
  for (const file of paths) {
    hash.update(relative(root, file).replace(/\\/g, "/"));
    hash.update("\0");
    for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
    hash.update("\0");
  }
  return { digest: hash.digest("hex"), files: paths.length, bytes };
}
