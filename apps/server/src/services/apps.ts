import { execFile } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_POLICY } from "@nexus/backups";
import { analyzeProject, parseDotenv, primary, type ProjectAnalysis } from "@nexus/detection";
import { planDatabaseWiring, planDocumentWiring, type ConnectionInfo } from "@nexus/database";
import { sourceChangesSince, type DeploymentRecord } from "@nexus/deployment";
import { explainError } from "@nexus/logs";
import type { GatewaySite } from "@nexus/network";
import { normalizeDomain } from "@nexus/network";
import { AppSupervisor, buildIsolatedEnv, HealthMonitor, killTree, resolveCommand, runToCompletion, substituteArgs, type AppProcessConfig } from "@nexus/runtime";

import { DEFAULT_APP_SCOPES } from "@nexus/security";
import {
  BRAND,
  NexusError,
  randomToken,
  slugify,
  type AccessMode,
  type AppStatus,
  type AppSummary,
  type FriendlyProblem,
  type ResourcePolicy,
} from "@nexus/shared";
import type { Migration } from "@nexus/state";
import { fromJson, toJson } from "@nexus/state";
import type { NexusContext } from "../context";
import type { GatewayService } from "./gateway";
import type { JobHandle } from "./jobs";

/** When a process started (ms since epoch), or null if it isn't running. */
function processCreationTime(pid: number): Promise<number | null> {
  if (process.platform !== "win32") return Promise.resolve(null);
  const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${Math.floor(pid)}"; if ($p) { [DateTimeOffset]::new($p.CreationDate).ToUnixTimeMilliseconds() }`;
  return new Promise((resolve) =>
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 15_000 }, (_e, out) => {
      const n = Number(String(out ?? "").trim());
      resolve(Number.isFinite(n) && n > 0 ? n : null);
    }),
  );
}

export const appMigrations: Migration[] = [
  {
    id: "server/002_apps",
    up: `CREATE TABLE apps (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      source_dir TEXT NOT NULL,
      analysis TEXT NOT NULL,
      access_mode TEXT NOT NULL,
      public_hosts TEXT NOT NULL,
      data_mode TEXT NOT NULL,
      database_id TEXT,
      db_slot TEXT,
      env TEXT NOT NULL,
      resources TEXT NOT NULL,
      desired_state TEXT NOT NULL,
      problem TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  },
  {
    id: "server/003_app_processes",
    up: `CREATE TABLE app_processes (
      app_id TEXT PRIMARY KEY,
      pid INTEGER NOT NULL,
      started_at INTEGER NOT NULL
    )`,
  },
  {
    id: "server/004_app_document_db",
    up: `ALTER TABLE apps ADD COLUMN document_database_id TEXT`,
  },
];

export type DataMode = "new" | "existing" | "external" | "none";

export interface CreateAppInput {
  sourceDir: string;
  name?: string;
  data: { mode: DataMode; databaseName?: string; databaseId?: string; externalUrl?: string };
  access: AccessMode;
  domain?: string | null;
}

interface AppRow {
  id: string;
  name: string;
  source_dir: string;
  analysis: string;
  access_mode: AccessMode;
  public_hosts: string;
  data_mode: DataMode;
  database_id: string | null;
  document_database_id: string | null;
  db_slot: string | null;
  env: string;
  resources: string;
  desired_state: "running" | "stopped";
  problem: string | null;
  created_at: string;
  updated_at: string;
}

export interface AppRecord {
  id: string;
  name: string;
  sourceDir: string;
  analysis: ProjectAnalysis;
  accessMode: AccessMode;
  publicHosts: string[];
  dataMode: DataMode;
  databaseId: string | null;
  /** Document (MongoDB) database, for apps built on MongoDB. */
  documentDatabaseId: string | null;
  dbSlot: string | null;
  /** Non-secret settings. Secret values live in the vault (names listed in secretEnv). */
  env: Record<string, string>;
  resources: ResourcePolicy;
  desiredState: "running" | "stopped";
  problem: FriendlyProblem | null;
  createdAt: string;
}

export interface VerificationResult {
  label: string;
  ok: boolean;
  detail: string;
}

const AUTO_RESOURCES: ResourcePolicy = { cpuLimitPercent: "auto", memoryLimitMb: "auto", priority: "normal" };
/** Automatic updates: how often app folders are checked, and how long files must stay unchanged first. */
const AUTO_DEPLOY_CHECK_MS = 15_000;
const AUTO_DEPLOY_QUIET_MS = 20_000;
const AUTO_DEPLOY = "autoDeploy";
const DEPLOY_KEY = (appId: string) => `deployKey:${appId}`;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
/** How long the previous version keeps finishing requests after visitors are switched to the new one. */
const SWITCH_DRAIN_MS = 5_000;
/** An app that ignores PORT fails like this when its fixed port is already taken. */
const PORT_TAKEN = /EADDRINUSE|address already in use|Only one usage of each socket address/i;
const secretKey = (appId: string, name: string) => `app:${appId}/env/${name}`;

/**
 * Application Manager — turns "choose a folder, choose where data goes, choose access"
 * into a running, connected, monitored, backed-up application.
 */
export class AppManager {
  private readonly supervisors = new Map<string, AppSupervisor>();
  /** When each app's settings last changed (to tell whether the running process has them). */
  private readonly settingsChangedAt = new Map<string, number>();
  private readonly monitors = new Map<string, HealthMonitor>();
  /** The latest deploy job per app, so two updates of one app never run at once. */
  private readonly deployJobs = new Map<string, string>();
  private readonly jobApps = new Map<string, string>();
  /** Automatic updates: the newest file change already tried per app (not retried after a failure). */
  private readonly autoAttempted = new Map<string, number>();
  private autoTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly ctx: NexusContext,
    private readonly gateway: GatewayService,
  ) {
    ctx.store.migrate(appMigrations);
    ctx.appPidsProvider = () =>
      [...this.supervisors.entries()].filter(([, s]) => s.pid).map(([appId, s]) => ({ appId, pid: s.pid! }));
    gateway.setSitesProvider(() => this.gatewaySites());
    ctx.onStop(() => this.stopAll());
  }

  // ------------------------------------------------------------------ queries

  analyze(sourceDir: string): ProjectAnalysis {
    if (!existsSync(sourceDir)) throw NexusError.invalid("That folder doesn't exist.");
    return analyzeProject(sourceDir);
  }

  get(id: string): AppRecord | undefined {
    const r = this.ctx.store.get<AppRow>("SELECT * FROM apps WHERE id = ?", [id]);
    return r ? toRecord(r) : undefined;
  }

  require(id: string): AppRecord {
    const a = this.get(id);
    if (!a) throw NexusError.notFound("Application");
    return a;
  }

  list(): AppRecord[] {
    return this.ctx.store.all<AppRow>("SELECT * FROM apps ORDER BY name").map(toRecord);
  }

  status(id: string): AppStatus {
    const sup = this.supervisors.get(id);
    if (sup) return sup.status;
    const app = this.get(id);
    if (app?.problem) return "needs_attention";
    // Static sites and pure frontends have no process: the gateway serves them.
    const main = app ? primary(app.analysis.components) : undefined;
    if (app && app.desiredState === "running" && main && !main.start && this.ctx.deployments?.current(id)) return "running";
    return "stopped";
  }

  summary(app: AppRecord): AppSummary {
    const sup = this.supervisors.get(app.id);
    const usage = this.ctx.monitoring?.app(app.id);
    const current = this.ctx.deployments?.current(app.id);
    const p = primary(app.analysis.components);
    const status = this.status(app.id);
    return {
      id: app.id,
      name: app.name,
      slug: app.id,
      status,
      runtime: app.analysis.runtime,
      framework: app.analysis.summary || p?.framework || "",
      accessMode: app.accessMode,
      localUrl: this.gateway.available ? this.gateway.localUrl(app.id) : sup ? `http://127.0.0.1:${sup.port}` : "",
      externalUrl: app.accessMode !== "private" && app.publicHosts[0] ? `https://${app.publicHosts[0]}` : null,
      databaseId: app.databaseId,
      cpuPercent: usage?.cpuPercent ?? 0,
      memoryBytes: usage?.memoryBytes ?? 0,
      storageBytes: this.ctx.storage?.diskUsage(app.id) ?? 0,
      currentRelease: current?.versionLabel ?? null,
      lastDeployedAt: current?.activatedAt ?? null,
      problem: status === "needs_attention" || status === "crashed" ? (app.problem ?? (sup?.detail ? { title: `${app.name} needs attention`, summary: sup.detail, checks: [] } : null)) : null,
    };
  }

  /**
   * Changes you made that the running app doesn't have yet: files edited in its folder since the
   * current release was built (needs Deploy), or settings changed since it started (needs Restart).
   */
  pendingUpdates(): { appId: string; name: string; action: "deploy" | "restart"; reason: string; files: string[] }[] {
    const out: { appId: string; name: string; action: "deploy" | "restart"; reason: string; files: string[] }[] = [];
    for (const app of this.list()) {
      const current = this.ctx.deployments?.current(app.id);
      if (!current || !existsSync(app.sourceDir)) continue;
      const { changed } = sourceChangesSince(app.sourceDir, new Date(current.createdAt));
      if (changed.length) {
        out.push({ appId: app.id, name: app.name, action: "deploy", reason: `${changed.length} file${changed.length === 1 ? "" : "s"} changed in ${app.sourceDir} since ${current.versionLabel}`, files: changed.slice(0, 20) });
        continue;
      }
      const sup = this.supervisors.get(app.id);
      const changedAt = this.settingsChangedAt.get(app.id);
      const startedAt = sup?.startedAt ? new Date(sup.startedAt).getTime() : null;
      if (changedAt && startedAt && changedAt > startedAt) out.push({ appId: app.id, name: app.name, action: "restart", reason: "Settings changed since it started", files: [] });
    }
    return out;
  }

  /** Every address the app can be reached at, most useful first. */
  addresses(appId: string): { kind: "public" | "local" | "private-network" | "direct"; label: string; url: string; note: string }[] {
    const app = this.require(appId);
    const out: { kind: "public" | "local" | "private-network" | "direct"; label: string; url: string; note: string }[] = [];
    if (app.accessMode !== "private") {
      for (const h of app.publicHosts) out.push({ kind: "public", label: "On the internet", url: `https://${h}`, note: app.accessMode === "authorized" ? "Visitors sign in first" : app.accessMode === "api" ? "Needs an API key" : "Anyone with the address" });
    }
    if (this.gateway.available) out.push({ kind: "local", label: "On this computer", url: this.gateway.localUrl(appId), note: "Works even without internet" });
    const pn = this.ctx.settings.get<{ enabled?: boolean; subnet?: { base: string } | null }>("privateNetwork", {});
    const pnPort = this.ctx.ports.get("private-network", appId);
    if (pn.enabled && pn.subnet && pnPort) out.push({ kind: "private-network", label: "Your private network", url: `http://${pn.subnet.base}.1:${pnPort}`, note: "From your phone or laptop with WireGuard on" });
    // The port of the version running now (updates alternate between the app's two ports).
    const port = this.supervisors.get(appId)?.port ?? this.ctx.ports.get(`app:${appId}`, "http");
    if (port) out.push({ kind: "direct", label: "The app itself", url: `http://127.0.0.1:${port}`, note: "The port Nexus gives the app, on this computer only" });
    return out;
  }

  // ------------------------------------------------------------------ create & deploy

  /** Registers the app and starts the deployment job. Returns immediately. */
  create(input: CreateAppInput, actor: { id: string; name: string }): { appId: string; jobId: string } {
    if (!this.ctx.deployments) throw NexusError.conflict("Finish setting up the server first.");
    const analysis = this.analyze(input.sourceDir);
    if (analysis.components.length === 0) throw NexusError.invalid(analysis.warnings[0] ?? "Nexus couldn't recognise this project.");
    const name = (input.name ?? analysis.name).trim().slice(0, 80) || analysis.name;
    const id = this.uniqueId(name);
    const hosts = input.domain ? [normalizeDomain(input.domain)] : [];
    const now = new Date().toISOString();
    this.ctx.store.run(
      `INSERT INTO apps (id, name, source_dir, analysis, access_mode, public_hosts, data_mode, database_id, db_slot, env, resources, desired_state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, '{}', ?, 'running', ?, ?)`,
      [id, name, input.sourceDir, toJson(analysis), input.access, toJson(hosts), input.data.mode, analysis.database.kind === "mongodb" ? null : (input.data.databaseId ?? null), toJson(AUTO_RESOURCES), now, now],
    );
    this.ctx.audit.record({ actor: { type: "user", ...actor }, action: "app.create", target: { type: "app", id }, details: { source: input.sourceDir, access: input.access, data: input.data.mode } });
    const job = this.deploy(id, { data: input.data, first: true });
    return { appId: id, jobId: job.id };
  }

  /** Deploys the current contents of the app's folder as a new release. */
  deploy(appId: string, opts: { data?: CreateAppInput["data"]; first?: boolean } = {}) {
    const app = this.require(appId);
    const steps = [
      { key: "analyze", label: "Inspecting the application" },
      { key: "database", label: "Setting up the database" },
      { key: "connect", label: "Connecting the application" },
      { key: "prepare", label: "Installing components" },
      { key: "migrate", label: "Preparing database tables" },
      { key: "start", label: "Starting the application" },
      { key: "network", label: "Configuring secure access" },
      { key: "verify", label: "Testing everything" },
      { key: "backups", label: "Turning on backups" },
    ];
    const running = this.deployJobs.get(appId);
    if (running && this.ctx.jobs.get(running)?.status === "running") throw NexusError.conflict(`${app.name} is already being updated. Wait for that update to finish.`);
    const job = this.ctx.jobs.start("deploy", `Deploying ${app.name}`, steps, (job) => this.runDeploy(appId, job, opts));
    this.deployJobs.set(appId, job.id);
    this.jobApps.set(job.id, appId);
    return job;
  }

  /** Which app a deploy job belongs to (so a deploy key only sees its own app's progress). */
  jobApp(jobId: string): string | null {
    return this.jobApps.get(jobId) ?? null;
  }

  // ------------------------------------------------------------------ delivery (updates without downtime)

  /** Where uploaded versions of an app are kept. Once an app is updated by upload, this is its code. */
  uploadedSourceDir(appId: string): string {
    return join(this.ctx.deployments!.appDir(appId), "source");
  }

  /**
   * Puts a new version of the app's code in place from a .zip (from the browser, or a deploy key
   * from another computer) and deploys it without downtime. The zip may hold the project itself or
   * one folder with the project in it (as GitHub's "Download ZIP" does).
   */
  async uploadSource(appId: string, zipFile: string): Promise<{ jobId: string; files: number }> {
    const app = this.require(appId);
    const running = this.deployJobs.get(appId);
    if (running && this.ctx.jobs.get(running)?.status === "running") throw NexusError.conflict(`${app.name} is already being updated. Wait for that update to finish.`);
    const appDir = this.ctx.deployments!.appDir(appId);
    const incoming = join(appDir, `incoming-${Date.now()}`);
    mkdirSync(incoming, { recursive: true });
    try {
      await extractZip(zipFile, incoming);
      // A single folder at the top (GitHub's "Download ZIP"): the project is inside it.
      let root = incoming;
      for (;;) {
        const entries = readdirSync(root, { withFileTypes: true }).filter((e) => !e.name.startsWith("__MACOSX"));
        if (entries.length === 1 && entries[0]!.isDirectory()) root = join(root, entries[0]!.name);
        else break;
      }
      const files = countFiles(root);
      if (!files) throw NexusError.invalid("That zip file is empty.");
      const analysis = this.analyze(root);
      if (!analysis.components.length) throw NexusError.invalid(`Nexus couldn't recognise an application in that zip file. ${analysis.warnings[0] ?? "Zip the folder that holds your package.json or requirements.txt."}`);
      // Swap in the new code: the old copy is only removed once the new one is in place.
      const target = this.uploadedSourceDir(appId);
      const previous = `${target}-previous`;
      rmSync(previous, { recursive: true, force: true });
      if (existsSync(target)) renameSync(target, previous);
      renameSync(root, target);
      rmSync(previous, { recursive: true, force: true });
      if (app.sourceDir !== target) this.update(appId, { sourceDir: target });
      this.ctx.activity.add("info", `A new version of ${app.name} was uploaded (${files.toLocaleString()} files). Updating without downtime…`, appId);
      return { jobId: this.deploy(appId).id, files };
    } finally {
      rmSync(incoming, { recursive: true, force: true });
    }
  }

  /** A key that lets another computer (your laptop, a build script) push updates to this app. */
  issueDeployKey(appId: string): { key: string; url: string } {
    this.require(appId);
    const key = `nxd_${randomBytes(24).toString("base64url")}`;
    this.ctx.settings.set(DEPLOY_KEY(appId), { hash: sha256(key), createdAt: new Date().toISOString() });
    return { key, url: `/api/v1/hooks/deploy/${appId}` };
  }

  revokeDeployKey(appId: string): void {
    this.ctx.settings.delete(DEPLOY_KEY(appId));
  }

  verifyDeployKey(appId: string, key: string): boolean {
    const k = this.get(appId) ? this.ctx.settings.get<{ hash: string } | null>(DEPLOY_KEY(appId), null) : null;
    if (!k || !key) return false;
    const a = Buffer.from(k.hash, "hex");
    const b = Buffer.from(sha256(key), "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** How updates reach this app: where its code comes from, automatic updates and the deploy key. */
  delivery(appId: string) {
    const app = this.require(appId);
    const key = this.ctx.settings.get<{ createdAt: string } | null>(DEPLOY_KEY(appId), null);
    const current = this.ctx.deployments?.current(appId);
    const pending = current && existsSync(app.sourceDir) ? sourceChangesSince(app.sourceDir, new Date(current.createdAt)).changed.length : 0;
    const job = this.deployJobs.get(appId);
    return {
      source: { dir: app.sourceDir, uploaded: app.sourceDir === this.uploadedSourceDir(appId), exists: existsSync(app.sourceDir) },
      autoDeploy: this.autoDeployEnabled(appId),
      deployKey: { enabled: !!key, createdAt: key?.createdAt ?? null, url: `/api/v1/hooks/deploy/${appId}` },
      pendingChanges: pending,
      updating: job && this.ctx.jobs.get(job)?.status === "running" ? job : null,
    };
  }

  autoDeployEnabled(appId: string): boolean {
    return !!this.ctx.settings.get<Record<string, boolean>>(AUTO_DEPLOY, {})[appId];
  }

  setAutoDeploy(appId: string, enabled: boolean): void {
    this.require(appId);
    const all = { ...this.ctx.settings.get<Record<string, boolean>>(AUTO_DEPLOY, {}) };
    if (enabled) all[appId] = true;
    else delete all[appId];
    this.ctx.settings.set(AUTO_DEPLOY, all);
  }

  /**
   * Automatic updates: an app with them on is redeployed (without downtime) once files in its folder
   * have changed and then stayed quiet for a moment — so a save, a copy or a `git pull` finishes first.
   * A change whose update failed isn't retried until the files change again.
   */
  async autoDeployTick(now = Date.now()): Promise<string[]> {
    const started: string[] = [];
    for (const app of this.list()) {
      if (!this.autoDeployEnabled(app.id) || app.desiredState !== "running") continue;
      const current = this.ctx.deployments?.current(app.id);
      const running = this.deployJobs.get(app.id);
      if (!current || !existsSync(app.sourceDir) || (running && this.ctx.jobs.get(running)?.status === "running")) continue;
      const { changed, newestMs } = sourceChangesSince(app.sourceDir, new Date(current.createdAt));
      if (!changed.length || now - newestMs < AUTO_DEPLOY_QUIET_MS || (this.autoAttempted.get(app.id) ?? 0) >= newestMs) continue;
      this.autoAttempted.set(app.id, newestMs);
      this.ctx.activity.add("info", `${changed.length} file${changed.length === 1 ? "" : "s"} changed in ${app.name}'s folder. Updating it automatically, without downtime…`, app.id);
      this.ctx.audit.record({ actor: { type: "system", id: "auto-deploy", name: "Automatic updates" }, action: "app.redeploy", target: { type: "app", id: app.id }, details: { changed: changed.length } });
      started.push(this.deploy(app.id).id);
    }
    return started;
  }

  startAutoDeploy(): void {
    if (this.autoTimer) return;
    this.autoTimer = setInterval(() => void this.autoDeployTick().catch((e) => this.ctx.log.warn("automatic update check failed", { err: e as Error })), AUTO_DEPLOY_CHECK_MS);
    this.autoTimer.unref();
  }

  private async runDeploy(appId: string, job: JobHandle, opts: { data?: CreateAppInput["data"]; first?: boolean }) {
    const deployments = this.ctx.deployments!;
    let app = this.require(appId);

    // 1. Analyze (fresh — the project may have changed since it was added)
    job.step("analyze", "running");
    const analysis = this.analyze(app.sourceDir);
    this.update(appId, { analysis });
    app = this.require(appId);
    job.step("analyze", "done", analysis.summary);

    // 2. Database
    job.step("database", "running");
    let conn: ConnectionInfo | null = null;
    let docConn: ConnectionInfo | null = null;
    const data = opts.data ?? { mode: app.dataMode };
    if ((data.mode === "new" || data.mode === "existing") && analysis.database.kind === "mongodb") {
      // MongoDB apps get a document database of their own.
      const docs = await this.ctx.startDocuments();
      if (!app.documentDatabaseId) {
        if (data.mode === "new") {
          const { database, connection } = await docs.createDatabase({ displayName: data.databaseName || app.name, appId });
          this.update(appId, { documentDatabaseId: database.id });
          docConn = connection ?? (await docs.grantAppAccess(database.id, appId));
          this.ctx.activity.add("success", `${database.name} document database created.`, appId);
        } else {
          if (!data.databaseId || !docs.get(data.databaseId)) throw NexusError.invalid("Choose which document database this application should use.");
          docConn = await docs.grantAppAccess(data.databaseId, appId);
          this.update(appId, { documentDatabaseId: data.databaseId });
        }
      } else {
        docConn = await docs.grantAppAccess(app.documentDatabaseId, appId);
      }
      job.step("database", "done", docConn.database);
    } else if (data.mode === "new" || data.mode === "existing") {
      const dbs = this.ctx.databases;
      if (!dbs) throw NexusError.conflict("The database server is not available.");
      if (!app.databaseId) {
        if (data.mode === "new") {
          const { database, connection } = await dbs.createDatabase({ displayName: data.databaseName || app.name, appId });
          this.update(appId, { databaseId: database.id });
          conn = connection ?? (await dbs.grantAppAccess(database.id, appId));
          this.ctx.activity.add("success", `${database.name} database created.`, appId);
        } else {
          if (!data.databaseId) throw NexusError.invalid("Choose which database this application should use.");
          conn = await dbs.grantAppAccess(data.databaseId, appId);
          this.update(appId, { databaseId: data.databaseId });
        }
      } else {
        conn = dbs.findByApp(appId) ? dbs.connectionInfo(app.databaseId, appId) : await dbs.grantAppAccess(app.databaseId, appId);
      }
      job.step("database", "done", conn!.database);
    } else if (data.mode === "external") {
      if (data.externalUrl) this.ctx.vault.set(secretKey(appId, "DATABASE_URL"), data.externalUrl, `app:${appId}`);
      job.step("database", "done", "External database");
    } else {
      job.step("database", "skipped");
    }
    app = this.require(appId);

    // 3. Connect: database wiring (ask only when ambiguous), storage, generated secrets
    job.step("connect", "running");
    if (conn && analysis.database.required) {
      const connection = conn;
      let plan = planDatabaseWiring(analysis.database, analysis.env, connection, app.name, app.dbSlot ?? undefined);
      if (plan.status === "ambiguous") {
        const answer = await job.ask(
          plan.question,
          plan.choices.map((c) => ({ value: c.slotKey, label: c.label })),
        );
        this.update(appId, { dbSlot: answer });
        plan = planDatabaseWiring(analysis.database, analysis.env, connection, app.name, answer);
      }
      if (plan.status !== "ambiguous") job.log(plan.note);
    }
    if (docConn) job.log(planDocumentWiring(analysis.database, docConn).note);
    this.ensureGeneratedSecrets(appId, analysis);
    this.ensureAppToken(appId);
    const missing = analysis.env.filter((e) => !e.managed && e.category === "secret" && !this.hasEnv(appId, e.name));
    job.step("connect", "done", missing.length ? `Needs: ${missing.map((m) => m.name).join(", ")}` : "Connected");

    // 4. Prepare release
    job.step("prepare", "running");
    const release = await deployments.prepareRelease({
      appId,
      slug: appId,
      analysis,
      onStep: (k, s, d) => job.log(`${k}: ${s}${d ? ` — ${d}` : ""}`),
      onLine: (_s, l) => {
        job.log(l);
        this.ctx.logs.write(`deploy:${appId}`, "stdout", l);
      },
    });
    job.step("prepare", "done", release.versionLabel);

    // 5. Migrations (only when safely automatic)
    job.step("migrate", "running");
    const mig = analysis.migrations;
    if (mig?.autoRunnable && mig.command && conn) {
      const env = await this.composeEnv(appId, release, 0);
      const resolved = resolveCommand(mig.command.command, mig.command.args, deployments.runtimeFor(release));
      const main = primary(analysis.components)!;
      const cwd = main.path ? join(release.releaseDir, ...main.path.split("/")) : release.releaseDir;
      const r = await runToCompletion({ executable: resolved.executable, args: resolved.args, cwd, env: { ...env, PATH: [...resolved.pathDirs, env.PATH].join(";") }, onLine: (_s, l) => job.log(l), timeoutMs: 30 * 60_000 });
      if (r.code !== 0) {
        const problem = explainError(r.tail.join("\n"), { appName: app.name, databasePort: this.ctx.postgres?.port ?? null, databaseRunning: true });
        throw new NexusError("infrastructure", "Preparing the database tables failed.", { problem: { ...problem, title: "Database setup step failed" } });
      }
      deployments.markMigrationsRan(release.id);
      job.step("migrate", "done", mig.description);
    } else {
      job.step("migrate", "skipped", mig ? `${mig.description} — available in Settings` : undefined);
    }

    // 6. Start: the current version keeps serving until the new one works (no downtime)
    job.step("start", "running");
    const previous = deployments.current(appId);
    const wasServing = this.supervisors.get(appId)?.status === "running";
    const started = await this.startRelease(appId, release, { swap: true, onLog: (l) => job.log(l) });
    if (started !== "running") {
      const tail = this.ctx.logs.search(`app:${appId}`, { level: "problems", limit: 5 }).map((e) => e.message).join("\n");
      const problem = explainError(tail || this.supervisors.get(appId)?.detail || "", { appName: app.name, databasePort: this.ctx.postgres?.port ?? null, databaseRunning: true, credentialsValid: true });
      if (wasServing && this.supervisors.get(appId)?.status === "running") {
        // Nothing changed for visitors: report the failed update without marking the app broken.
        throw new NexusError("infrastructure", `The new version of ${app.name} didn't start, so the current version is still running.`, {
          problem: { ...problem, title: "The update didn't start (your app is still running the previous version)" },
        });
      }
      if (previous && previous.id !== release.id) {
        job.log("The new version didn't start; going back to the previous version.");
        await this.startRelease(appId, previous);
      }
      this.update(appId, { problem });
      throw new NexusError("infrastructure", `${app.name} didn't start.`, { problem });
    }
    deployments.activate(release.id);
    this.update(appId, { problem: null, desiredState: "running" });
    job.step("start", "done", release.versionLabel);

    // 7. Network
    job.step("network", "running");
    const gw = await this.gateway.sync();
    job.step("network", gw.ok ? "done" : "skipped", gw.ok ? (app.accessMode === "private" ? "This computer only" : "Secure access configured") : gw.error);

    // 8. Verify
    job.step("verify", "running");
    const checks = await this.verify(appId);
    job.step("verify", checks.every((c) => c.ok) ? "done" : "failed", checks.map((c) => `${c.label}: ${c.ok ? "OK" : c.detail}`).join(" · "));

    // 9. Backups
    job.step("backups", "running");
    if (this.ctx.backups) {
      if (!this.ctx.store.get("SELECT 1 FROM backup_policies WHERE app_id = ?", [appId])) this.ctx.backups.setPolicy(appId, DEFAULT_POLICY);
    }
    job.step("backups", "done", "Daily at 3:00 AM");

    this.ctx.activity.add("success", `${app.name} ${opts.first ? "deployed" : "updated"} successfully.`, appId);
    this.ctx.audit.record({ actor: { type: "system" }, action: "app.deploy", target: { type: "app", id: appId }, details: { release: release.versionLabel } });
    return { appId, release: release.versionLabel, summary: this.summary(this.require(appId)), checks };
  }

  // ------------------------------------------------------------------ run

  /**
   * Runs a release. With `swap` and the app already running, the update causes no downtime: the new
   * version starts next to the old one on the app's other port, and only once it answers does the
   * gateway switch to it; the old one then finishes its requests and stops. If the new version
   * doesn't come up, the old one was never touched. Apps that ignore PORT and always use the same
   * port can't run twice, so for them Nexus falls back to stop-then-start.
   */
  private async startRelease(appId: string, release: DeploymentRecord, opts: { swap?: boolean; onLog?: (line: string) => void } = {}): Promise<AppStatus> {
    const app = this.require(appId);
    const main = primary(app.analysis.components);
    const log = opts.onLog ?? (() => {});
    // Static sites have no process; the gateway serves them (switching to the new folder at once).
    if (!main || !main.start) {
      if (main && (main.role === "static" || main.role === "frontend")) return "running";
      this.update(appId, { problem: { title: `${app.name} can't start`, summary: "Nexus doesn't know how to start this application. Set a start command in Advanced settings.", checks: [] } });
      return "needs_attention";
    }
    const old = this.supervisors.get(appId);
    const live = opts.swap && old?.status === "running" ? old : null;
    if (live) {
      // The app's two ports take turns: the new version gets whichever the old one isn't using.
      const purpose = live.port === this.ctx.ports.get(`app:${appId}`, "http") ? "http-next" : "http";
      const { port } = await this.ctx.ports.ensureAvailable(`app:${appId}`, purpose);
      log(`Starting the new version on port ${port} while the current one keeps serving on ${live.port}.`);
      const output: string[] = [];
      const next = await this.launch(appId, release, port, (line) => output.length < 200 && output.push(line));
      const status = await next.start();
      if (status === "running" && (await this.answers(port, app.analysis.healthPath))) {
        if (!(await this.switchTo(appId, next, live))) {
          await next.stop();
          log("The secure gateway couldn't be updated, so visitors stay on the current version. Nothing changed; try the update again.");
          return "needs_attention";
        }
        log("Visitors are now on the new version. The previous one is finishing its requests.");
        await new Promise((r) => setTimeout(r, SWITCH_DRAIN_MS));
        await live.stop();
        return "running";
      }
      await next.stop();
      if (output.some((l) => PORT_TAKEN.test(l))) {
        // The app ignores PORT: it can't run twice, so this one update has a short restart.
        log("This app always uses the same port, so it can't run twice. Restarting it with the new version instead (a few seconds offline).");
      } else {
        log("The new version didn't start. The current version kept running, so nothing changed for visitors.");
        this.ctx.logs.write(`app:${appId}`, "system", "An update didn't start; the previous version is still running.");
        return status === "running" ? "needs_attention" : status;
      }
    }

    // Falling back from a swap: the new version takes over the port the old one frees.
    const port = live ? live.port : (await this.ctx.ports.ensureAvailable(`app:${appId}`, "http")).port;
    if (old) {
      this.monitors.get(appId)?.dispose();
      await old.stop();
    }
    const sup = await this.launch(appId, release, port);
    this.supervisors.set(appId, sup);
    const status = await sup.start();
    this.recordProcess(appId, sup);
    if (status === "running") this.watch(appId, sup);
    return status;
  }

  /** Builds the supervisor for one release on one port (not started yet). */
  private async launch(appId: string, release: DeploymentRecord, port: number, onLine?: (line: string) => void): Promise<AppSupervisor> {
    const app = this.require(appId);
    const main = primary(app.analysis.components)!;
    const env = await this.composeEnv(appId, release, port);
    const resolved = resolveCommand(main.start!.command, substituteArgs(main.start!.args, { PORT: port }), this.ctx.deployments!.runtimeFor(release));
    const cwd = main.path ? join(release.releaseDir, ...main.path.split("/")) : release.releaseDir;
    const config: AppProcessConfig = {
      appId,
      cwd,
      executable: resolved.executable,
      args: resolved.args,
      env: { ...env, ...(main.start!.env ?? {}), PATH: [...resolved.pathDirs, env.PATH].join(";") },
      port,
      resources: app.resources,
      startupTimeoutMs: 90_000,
    };
    const choice = await this.ctx.isolation.choose({});
    const sup = new AppSupervisor(config, choice.provider);
    sup.on("output", (stream, line) => {
      this.ctx.logs.write(`app:${appId}`, stream, line);
      onLine?.(line);
    });
    const redactor = this.ctx.logs.redactor(`app:${appId}`);
    for (const v of Object.values(env)) if (v.length >= 12 && /[A-Za-z]/.test(v) && /\d/.test(v)) redactor.addSecret(v);
    return sup;
  }

  /**
   * Makes `next` the app's running version: the gateway is pointed at it first, then health
   * watching and process records follow. If the gateway can't be updated, visitors are still being
   * sent to `previous`, so nothing is switched and false is returned.
   */
  private async switchTo(appId: string, next: AppSupervisor, previous: AppSupervisor): Promise<boolean> {
    this.supervisors.set(appId, next);
    const gw = await this.gateway.sync();
    if (!gw.ok && this.gateway.available) {
      this.supervisors.set(appId, previous);
      this.ctx.log.warn("update not switched: gateway could not be updated", { appId, error: gw.error });
      return false;
    }
    this.monitors.get(appId)?.dispose();
    this.monitors.delete(appId);
    this.recordProcess(appId, next);
    this.watch(appId, next);
    return true;
  }

  private recordProcess(appId: string, sup: AppSupervisor): void {
    if (sup.pid && sup.startedAt) {
      this.ctx.store.run("INSERT INTO app_processes (app_id, pid, started_at) VALUES (?, ?, ?) ON CONFLICT(app_id) DO UPDATE SET pid = excluded.pid, started_at = excluded.started_at", [appId, sup.pid, sup.startedAt]);
    }
  }

  /**
   * Whether a freshly started version really serves requests: its health page (or home page)
   * answers without a server error. Anything below 500 counts — a login redirect or a 404 on "/"
   * still means the app is up.
   */
  private async answers(port: number, healthPath: string | null): Promise<boolean> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}${healthPath ?? "/"}`, { redirect: "manual", signal: AbortSignal.timeout(5_000) });
        if (r.status < 500) return true;
      } catch {
        // not answering yet
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  private watch(appId: string, sup: AppSupervisor): void {
    const app = this.require(appId);
    const monitor = new HealthMonitor(
      sup,
      { appName: app.name, healthPath: app.analysis.healthPath, memoryLimitBytes: app.resources.memoryLimitMb === "auto" ? null : app.resources.memoryLimitMb * 1024 * 1024 },
      {
        memoryOf: (pid) => this.ctx.monitoring?.memoryOf(pid) ?? Promise.resolve(null),
        explain: () => this.ctx.logs.search(`app:${appId}`, { level: "error", limit: 1 })[0]?.message.split("\n")[0] ?? null,
      },
    );
    monitor.on("event", (e) => {
      const kind = e.kind === "recovered" ? "success" : e.kind === "gave_up" ? "problem" : "warning";
      this.ctx.activity.add(kind, e.message, appId);
      if (e.kind === "gave_up") {
        const tail = this.ctx.logs.search(`app:${appId}`, { level: "error", limit: 3 }).map((x) => x.message).join("\n");
        this.update(appId, {
          problem: explainError(tail || e.message, { appName: app.name, databasePort: this.ctx.postgres?.port ?? null, databaseRunning: true }),
        });
      }
    });
    monitor.on("probe", (p) => this.ctx.monitoring?.metrics.record(`app.${appId}.responseMs`, p.ms));
    monitor.start();
    this.monitors.set(appId, monitor);
  }

  async start(appId: string): Promise<AppStatus> {
    const current = this.ctx.deployments?.current(appId);
    if (!current) throw NexusError.conflict("This application hasn't been deployed yet.");
    this.update(appId, { desiredState: "running", problem: null });
    const status = await this.startRelease(appId, current);
    await this.gateway.sync();
    return status;
  }

  async stop(appId: string): Promise<void> {
    this.require(appId);
    this.monitors.get(appId)?.dispose();
    this.monitors.delete(appId);
    await this.supervisors.get(appId)?.stop();
    this.supervisors.delete(appId);
    this.ctx.store.run("DELETE FROM app_processes WHERE app_id = ?", [appId]);
    this.update(appId, { desiredState: "stopped" });
    await this.gateway.sync();
  }

  /** Goes back to an earlier version. Warns (and needs confirmation) if the database structure changed since. */
  async rollback(appId: string, deploymentId: string, confirmed: boolean): Promise<{ status: AppStatus; requiresConfirmation?: string }> {
    const app = this.require(appId);
    const deployments = this.ctx.deployments!;
    const target = deployments.require(deploymentId);
    if (target.appId !== appId) throw NexusError.notFound("Version");
    const check = deployments.rollbackCheck(deploymentId);
    if (!check.allowed) throw NexusError.conflict(check.reason ?? "This version can't be restored.");
    if (check.requiresConfirmation && !confirmed) return { status: this.status(appId), requiresConfirmation: check.reason! };
    const status = await this.startRelease(appId, target, { swap: true });
    if (status === "running") {
      deployments.activate(deploymentId);
      await this.gateway.sync();
      this.ctx.activity.add("info", `${app.name} rolled back to ${target.versionLabel}.`, appId);
    }
    return { status };
  }

  async restart(appId: string): Promise<AppStatus> {
    await this.stop(appId);
    return this.start(appId);
  }

  /**
   * Self-healing after an abrupt stop of Nexus: application processes from the previous run may
   * still be alive, holding ports. Stop them — but only processes whose ID *and* start time match
   * what Nexus recorded, so an unrelated program that reused the ID is never touched.
   */
  async reapOrphans(): Promise<number> {
    const rows = this.ctx.store.all<{ app_id: string; pid: number; started_at: number }>("SELECT * FROM app_processes");
    let reaped = 0;
    for (const r of rows) {
      if (this.supervisors.has(r.app_id)) continue;
      const created = await processCreationTime(r.pid);
      if (created !== null && Math.abs(created - r.started_at) < 15_000) {
        await killTree(r.pid, true);
        reaped++;
        this.ctx.log.warn("stopped a leftover application process from a previous run", { appId: r.app_id, pid: r.pid });
      }
      this.ctx.store.run("DELETE FROM app_processes WHERE app_id = ?", [r.app_id]);
    }
    return reaped;
  }

  /** Starts every app that should be running (service start-up). */
  async autostart(): Promise<void> {
    await this.reapOrphans();
    for (const app of this.list().filter((a) => a.desiredState === "running")) {
      const current = this.ctx.deployments?.current(app.id);
      if (!current) continue;
      try {
        await this.startRelease(app.id, current);
      } catch (e) {
        this.ctx.log.error("autostart failed", { appId: app.id, err: e as Error });
      }
    }
    await this.gateway.sync();
  }

  async stopAll(): Promise<void> {
    if (this.autoTimer) clearInterval(this.autoTimer);
    this.autoTimer = null;
    for (const m of this.monitors.values()) m.dispose();
    await Promise.all([...this.supervisors.values()].map((s) => s.stop()));
    this.supervisors.clear();
    this.monitors.clear();
  }

  // ------------------------------------------------------------------ settings

  async setAccess(appId: string, access: AccessMode, domain: string | null): Promise<void> {
    this.require(appId);
    const hosts = domain ? [normalizeDomain(domain)] : [];
    const conflict = this.list().find((a) => a.id !== appId && a.publicHosts.some((h) => hosts.includes(h)));
    if (conflict) throw NexusError.conflict(`${hosts[0]} is already used by ${conflict.name}.`);
    this.update(appId, { accessMode: access, publicHosts: hosts });
    await this.gateway.sync();
  }

  /** Sets a setting (e.g. STRIPE_API_KEY). Secrets go to the vault; others are stored plainly. */
  setEnv(appId: string, name: string, value: string | null): void {
    const app = this.require(appId);
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) throw NexusError.invalid("Setting names use letters, numbers and underscores.");
    if (["PORT", "HOST"].includes(name)) throw NexusError.invalid("Nexus manages this setting automatically.");
    const secret = /SECRET|PASSWORD|TOKEN|KEY|CREDENTIAL|_URL$/.test(name);
    const env = { ...app.env };
    delete env[name];
    this.ctx.vault.delete(secretKey(appId, name));
    if (value !== null) {
      if (secret) this.ctx.vault.set(secretKey(appId, name), value, `app:${appId}`);
      else env[name] = value;
    }
    this.update(appId, { env });
    this.settingsChangedAt.set(appId, Date.now());
  }

  /**
   * The settings in the app's own .env files. Nexus never copies these into a release (they hold
   * passwords), but the owner can import them: secrets go to the encrypted vault.
   */
  envFile(appId: string): { files: string[]; settings: { name: string; alreadySet: boolean }[]; values: Map<string, string> } {
    const app = this.require(appId);
    const files = [".env", ".env.production"].filter((f) => existsSync(join(app.sourceDir, f)));
    const values = new Map<string, string>();
    for (const f of files) for (const [k, v] of parseDotenv(readFileSync(join(app.sourceDir, f), "utf8"))) values.set(k, v);
    for (const k of ["PORT", "HOST"]) values.delete(k);
    const has = (name: string) => name in app.env || this.ctx.vault.has(secretKey(appId, name));
    return { files, settings: [...values.keys()].map((name) => ({ name, alreadySet: has(name) })), values };
  }

  /** Imports settings from the app's .env files (all, or the named ones). Returns what was imported. */
  importEnvFile(appId: string, names?: string[]): string[] {
    const { values } = this.envFile(appId);
    const chosen = [...values.keys()].filter((n) => !names || names.includes(n));
    for (const n of chosen) if (values.get(n)) this.setEnv(appId, n, values.get(n)!);
    return chosen.filter((n) => values.get(n));
  }

  setResources(appId: string, resources: ResourcePolicy): void {
    this.require(appId);
    this.update(appId, { resources });
  }

  /** Setting names and where they come from; secret values are masked. */
  envView(appId: string, reveal: boolean): { name: string; value: string; source: "nexus" | "you"; secret: boolean }[] {
    const app = this.require(appId);
    const out: { name: string; value: string; source: "nexus" | "you"; secret: boolean }[] = [];
    for (const [k, v] of Object.entries(app.env)) out.push({ name: k, value: v, source: "you", secret: false });
    for (const s of this.ctx.vault.list(`app:${appId}`)) {
      const m = s.name.match(/\/env\/(.+)$/);
      if (!m) continue;
      out.push({ name: m[1]!, value: reveal ? this.ctx.vault.get(s.name)! : "••••••••", source: "you", secret: true });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Technical view for Advanced › Developer. Secret values only when `reveal` (caller checks permission). */
  developerInfo(appId: string, reveal: boolean) {
    const app = this.require(appId);
    const sup = this.supervisors.get(appId);
    const release = this.ctx.deployments?.current(appId) ?? null;
    const main = primary(app.analysis.components);
    const port = this.ctx.ports.get(`app:${appId}`, "http");
    let database: { name: string; engine: "postgresql" | "mongodb"; host: string; port: number; database: string; user: string; password: string; url: string } | null = null;
    const mask = (s: string) => (reveal ? s : "••••••••");
    const view = (name: string | undefined, engine: "postgresql" | "mongodb", c: ConnectionInfo) => ({
      name: name ?? c.database,
      engine,
      host: c.host,
      port: c.port,
      database: c.database,
      user: c.user,
      password: mask(c.password),
      url: reveal ? c.url : c.url.replace(/:[^:@/]+@/, ":••••••••@"),
    });
    if (app.databaseId && this.ctx.databases) {
      database = view(this.ctx.databases.get(app.databaseId)?.name, "postgresql", this.ctx.databases.connectionInfo(app.databaseId, appId));
    } else if (app.documentDatabaseId && this.ctx.documents?.findByApp(appId)) {
      database = view(this.ctx.documents.get(app.documentDatabaseId)?.name, "mongodb", this.ctx.documents.connectionInfo(app.documentDatabaseId, appId));
    }
    const managed = [
      ...(database ? app.analysis.database.patterns.flatMap((p) => Object.values(p.vars).filter(Boolean) as string[]) : []),
      ...app.analysis.env.filter((e) => e.category === "storage").map((e) => e.name),
      "PORT",
      "HOST",
      `${BRAND.envPrefix}APP_ID`,
      `${BRAND.envPrefix}API_URL`,
      `${BRAND.envPrefix}API_TOKEN`,
      `${BRAND.envPrefix}STORAGE_URL`,
      `${BRAND.envPrefix}STORAGE_DIR`,
    ];
    return {
      appId,
      name: app.name,
      status: this.status(appId),
      runtime: app.analysis.runtime,
      framework: app.analysis.summary,
      sourceDir: app.sourceDir,
      pid: sup?.pid ?? null,
      internalAddress: port ? `127.0.0.1:${port}` : null,
      localUrl: this.gateway.available ? this.gateway.localUrl(appId) : null,
      publicHosts: app.publicHosts,
      accessMode: app.accessMode,
      isolation: sup?.isolation ?? { id: "process", label: "Isolated process" },
      release: release ? { version: release.versionLabel, dir: release.releaseDir, commit: release.sourceCommit, python: release.pythonVersion } : null,
      start: sup ? sup.command : main?.start ? { executable: main.start.command, args: main.start.args, cwd: main.path || "." } : null,
      healthPath: app.analysis.healthPath,
      migrations: app.analysis.migrations,
      resources: app.resources,
      settings: this.envView(appId, reveal),
      managedVariables: [...new Set(managed)].sort(),
      database,
      apiCredentials: this.ctx.appTokens.list(appId).map((t) => ({ id: t.id, label: t.label, scopes: t.scopes, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt, revoked: t.revoked })),
    };
  }

  async remove(appId: string, confirmation: string): Promise<void> {
    const app = this.require(appId);
    if (confirmation !== app.name) throw NexusError.invalid(`Type "${app.name}" to confirm removing this application.`);
    await this.stop(appId);
    this.ctx.appTokens.revokeAll(appId);
    this.ctx.ports.release(`app:${appId}`);
    this.revokeDeployKey(appId);
    this.setAutoDeploy(appId, false);
    // The removed app's own database logins stop working (the data itself is kept).
    if (app.databaseId) await this.ctx.databases?.revokeAppAccess(app.databaseId, appId).catch((e) => this.ctx.log.warn("could not revoke database access", { err: e as Error }));
    if (app.documentDatabaseId) await this.ctx.documents?.revokeAppAccess(app.documentDatabaseId, appId).catch((e) => this.ctx.log.warn("could not revoke document database access", { err: e as Error }));
    // The database and backups are kept on purpose; they are removed separately and explicitly.
    this.ctx.store.run("DELETE FROM apps WHERE id = ?", [appId]);
    await this.gateway.sync();
    this.ctx.activity.add("info", `${app.name} was removed. Its database and backups were kept.`);
  }

  // ------------------------------------------------------------------ verification

  async verify(appId: string): Promise<VerificationResult[]> {
    const app = this.require(appId);
    const out: VerificationResult[] = [];
    const sup = this.supervisors.get(appId);
    if (sup) {
      try {
        const r = await fetch(`http://127.0.0.1:${sup.port}${app.analysis.healthPath ?? "/"}`, { signal: AbortSignal.timeout(10_000), redirect: "manual" });
        out.push({ label: "Application", ok: r.status < 500, detail: r.status < 500 ? "Online" : `Answered with an error (${r.status})` });
      } catch (e) {
        out.push({ label: "Application", ok: false, detail: "Not answering" });
      }
    } else {
      const main = primary(app.analysis.components);
      out.push({ label: "Application", ok: !!main && !main.start, detail: main && !main.start ? "Served by the gateway" : "Not running" });
    }
    if (app.databaseId && this.ctx.databases) {
      const r = await this.ctx.databases.testConnection(this.ctx.databases.connectionInfo(app.databaseId, appId));
      out.push({ label: "Database", ok: r.ok, detail: r.ok ? "Connected" : r.error });
    }
    if (app.documentDatabaseId && this.ctx.documents?.findByApp(appId)) {
      const r = await this.ctx.documents.testConnection(this.ctx.documents.connectionInfo(app.documentDatabaseId, appId));
      out.push({ label: "Document database", ok: r.ok, detail: r.ok ? "Connected" : r.error });
    }
    if (this.ctx.storage) {
      try {
        this.ctx.storage.persistentDir(appId);
        out.push({ label: "Storage", ok: true, detail: "Connected" });
      } catch (e) {
        out.push({ label: "Storage", ok: false, detail: (e as Error).message });
      }
    }
    out.push({ label: "Health checks", ok: !!sup || !primary(app.analysis.components)?.start, detail: app.analysis.healthPath ? `Watching ${app.analysis.healthPath}` : "Watching the application" });
    if (app.accessMode !== "private" && app.publicHosts[0]) {
      out.push({ label: "HTTPS", ok: !this.gateway.lastError, detail: this.gateway.lastError ?? "Configured" });
    }
    return out;
  }

  // ------------------------------------------------------------------ environment

  /** Everything the app receives at start: database, storage, Nexus credentials, generated and user settings. */
  async composeEnv(appId: string, release: DeploymentRecord, port: number): Promise<Record<string, string>> {
    const app = this.require(appId);
    const env: Record<string, string> = {};

    // Database
    if (app.databaseId && this.ctx.databases) {
      const conn = this.ctx.databases.connectionInfo(app.databaseId, appId);
      const plan = planDatabaseWiring(app.analysis.database, app.analysis.env, conn, app.name, app.dbSlot ?? undefined);
      if (plan.status !== "ambiguous") Object.assign(env, plan.env);
    }
    if (app.documentDatabaseId && this.ctx.documents?.findByApp(appId)) {
      // The database's endpoint must be up before the app connects to it.
      await this.ctx.documents.ensureRunning(app.documentDatabaseId);
      Object.assign(env, planDocumentWiring(app.analysis.database, this.ctx.documents.connectionInfo(app.documentDatabaseId, appId)).env);
    }

    // Storage: apps that save uploads to a folder get a persistent one outside the release.
    if (this.ctx.storage) {
      const dir = this.ctx.storage.persistentDir(appId);
      for (const e of app.analysis.env.filter((x) => x.category === "storage")) env[e.name] = dir;
      env[`${BRAND.envPrefix}STORAGE_DIR`] = dir;
    }

    // Nexus services for the app
    env[`${BRAND.envPrefix}APP_ID`] = appId;
    env[`${BRAND.envPrefix}API_URL`] = `http://127.0.0.1:${this.ctx.opts.managementPort}/api/v1/app`;
    env[`${BRAND.envPrefix}STORAGE_URL`] = `http://127.0.0.1:${this.ctx.opts.managementPort}/api/v1/app/storage`;
    const token = this.ctx.vault.get(`app:${appId}/nexus-token`);
    if (token) env[`${BRAND.envPrefix}API_TOKEN`] = token;

    // User settings, then secrets (generated or supplied)
    Object.assign(env, app.env);
    for (const s of this.ctx.vault.list(`app:${appId}`)) {
      const m = s.name.match(/\/env\/(.+)$/);
      if (m) env[m[1]!] = this.ctx.vault.get(s.name)!;
    }

    const home = this.ctx.deployments!.homeDir(appId);
    return buildIsolatedEnv({ homeDir: home, pathDirs: [], appEnv: env, port });
  }

  private ensureGeneratedSecrets(appId: string, analysis: ProjectAnalysis): void {
    for (const e of analysis.env) {
      if (e.category === "secret" && e.managed && !this.hasEnv(appId, e.name)) {
        this.ctx.vault.set(secretKey(appId, e.name), randomToken(48), `app:${appId}`);
      }
    }
  }

  private ensureAppToken(appId: string): string {
    const existing = this.ctx.vault.get(`app:${appId}/nexus-token`);
    if (existing && this.ctx.appTokens.verify(existing)) return existing;
    const { token } = this.ctx.appTokens.issue(appId, "Automatic (injected by Nexus)", DEFAULT_APP_SCOPES);
    this.ctx.vault.set(`app:${appId}/nexus-token`, token, `app:${appId}`);
    return token;
  }

  private hasEnv(appId: string, name: string): boolean {
    return name in this.require(appId).env || this.ctx.vault.has(secretKey(appId, name));
  }

  // ------------------------------------------------------------------ gateway

  gatewaySites(): GatewaySite[] {
    const sites: GatewaySite[] = [];
    for (const app of this.list()) {
      const sup = this.supervisors.get(app.id);
      const release = this.ctx.deployments?.current(app.id);
      const staticComp = app.analysis.components.find((c) => (c.role === "frontend" || c.role === "static") && c.staticDir !== null);
      const staticRoot = release && staticComp ? join(release.releaseDir, ...(staticComp.staticDir ?? "").split("/").filter(Boolean)) : null;
      sites.push({
        id: app.id,
        name: app.name,
        localHost: `${app.id}.${BRAND.localDomainSuffix}`,
        publicHosts: app.accessMode === "private" ? [] : app.publicHosts,
        access: app.accessMode,
        upstreamPort: sup && sup.status === "running" ? sup.port : null,
        static: staticRoot && existsSync(staticRoot) ? { root: staticRoot, spa: staticComp!.role === "frontend" } : null,
        apiPrefix: "/api",
      });
    }
    return sites;
  }

  // ------------------------------------------------------------------ helpers

  private uniqueId(name: string): string {
    const base = slugify(name, 40);
    let id = base;
    for (let i = 2; this.get(id); i++) id = `${base}-${i}`;
    return id;
  }

  private update(
    appId: string,
    patch: Partial<{
      analysis: ProjectAnalysis;
      databaseId: string | null;
      documentDatabaseId: string | null;
      dbSlot: string | null;
      env: Record<string, string>;
      accessMode: AccessMode;
      publicHosts: string[];
      desiredState: "running" | "stopped";
      problem: FriendlyProblem | null;
      resources: ResourcePolicy;
      sourceDir: string;
    }>,
  ): void {
    const cols: string[] = [];
    const vals: (string | null)[] = [];
    const set = (c: string, v: string | null) => (cols.push(`${c} = ?`), vals.push(v));
    if (patch.analysis) set("analysis", toJson(patch.analysis));
    if (patch.databaseId !== undefined) set("database_id", patch.databaseId);
    if (patch.documentDatabaseId !== undefined) set("document_database_id", patch.documentDatabaseId);
    if (patch.dbSlot !== undefined) set("db_slot", patch.dbSlot);
    if (patch.env) set("env", toJson(patch.env));
    if (patch.accessMode) set("access_mode", patch.accessMode);
    if (patch.publicHosts) set("public_hosts", toJson(patch.publicHosts));
    if (patch.desiredState) set("desired_state", patch.desiredState);
    if (patch.problem !== undefined) set("problem", patch.problem ? toJson(patch.problem) : null);
    if (patch.resources) set("resources", toJson(patch.resources));
    if (patch.sourceDir) set("source_dir", patch.sourceDir);
    if (!cols.length) return;
    set("updated_at", new Date().toISOString());
    this.ctx.store.run(`UPDATE apps SET ${cols.join(", ")} WHERE id = ?`, [...vals, appId]);
  }
}

function toRecord(r: AppRow): AppRecord {
  return {
    id: r.id,
    name: r.name,
    sourceDir: r.source_dir,
    analysis: fromJson<ProjectAnalysis>(r.analysis, {} as ProjectAnalysis),
    accessMode: r.access_mode,
    publicHosts: fromJson<string[]>(r.public_hosts, []),
    dataMode: r.data_mode,
    databaseId: r.database_id,
    documentDatabaseId: r.document_database_id ?? null,
    dbSlot: r.db_slot,
    env: fromJson<Record<string, string>>(r.env, {}),
    resources: fromJson<ResourcePolicy>(r.resources, AUTO_RESOURCES),
    desiredState: r.desired_state,
    problem: r.problem ? fromJson<FriendlyProblem | null>(r.problem, null) : null,
    createdAt: r.created_at,
  };
}

/** Unpacks a .zip with Windows' own tar (bsdtar), which refuses paths that would land outside `dir`. */
function extractZip(zipFile: string, dir: string): Promise<void> {
  const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  return new Promise((resolve, reject) => {
    execFile(existsSync(tar) ? tar : "tar", ["-x", "-f", zipFile, "-C", dir], { windowsHide: true, timeout: 10 * 60_000 }, (err, _out, stderr) => {
      if (err) reject(NexusError.invalid(`That file couldn't be unpacked. Make sure it's a .zip file. ${String(stderr).split("\n")[0] ?? ""}`.trim()));
      else resolve();
    });
  });
}

function countFiles(dir: string, limit = 200_000): number {
  let n = 0;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (n >= limit) return;
      if (e.isDirectory()) walk(join(d, e.name));
      else if (e.isFile()) n++;
    }
  };
  walk(dir);
  return n;
}
