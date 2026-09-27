import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  BUILTIN_CONNECTORS,
  BUILTIN_TRANSFORMS,
  ExecutorRegistry,
  notificationsForRun,
  PipelineEngine,
  PipelineRunHistory,
  PipelineScheduler,
  PipelineStore,
  pythonStep,
  PythonEnvironments,
  RLibraries,
  RLocator,
  rStep,
  StepError,
  type ConnectorServices,
  type PipelineRecord,
  type PipelineRun,
  type RunTrigger,
} from "@nexus/pipelines";
import { NexusError } from "@nexus/shared";
import type { NexusContext } from "../context";
import type { NotificationService } from "./notifications";

const SECRET_PREFIX = "pipelines/secret/";
const WEBHOOK_SETTING = (id: string) => `pipelines.webhook.${id}`;
const WAREHOUSE_SETTING = "pipelines.warehouseDatabaseId";
/** The pseudo-application that owns the pipelines' database logins. */
const PIPELINES_APP = "pipelines";

export interface StartRunRequest {
  params?: Record<string, unknown>;
  testRows?: number | null;
  trigger: RunTrigger;
  requestedBy: string | null;
}

/**
 * Pipelines inside the Core Service: the definitions, the engine that runs them, the scheduler,
 * and everything steps need from Nexus — databases, the Warehouse, storage, secrets and a path policy.
 */
export class PipelineService {
  readonly store: PipelineStore;
  private engineInstance: PipelineEngine | null = null;
  private schedulerInstance: PipelineScheduler | null = null;

  constructor(
    private readonly ctx: NexusContext,
    private readonly notifications: NotificationService | null = null,
  ) {
    this.store = new PipelineStore(ctx.store);
  }

  get available(): boolean {
    return !!this.ctx.dataPaths;
  }

  /** Where run folders (step data, logs) and script environments live: next to the other data folders. */
  get workRoot(): string {
    const dp = this.ctx.dataPaths;
    if (!dp) throw NexusError.conflict("Pipelines are available once setup is complete.");
    return join(dirname(resolve(dp.files)), "Pipelines");
  }

  get engine(): PipelineEngine {
    if (!this.engineInstance) {
      const helpersDir = this.ctx.opts.paths.helpersDir;
      const cuda = () => !!this.ctx.hardware?.cuda.available;
      const executors = new ExecutorRegistry([...BUILTIN_TRANSFORMS, ...BUILTIN_CONNECTORS]);
      if (helpersDir) {
        executors.register(pythonStep(new PythonEnvironments(join(this.workRoot, "environments", "python"), this.ctx.pythonLocator()), { helpersDir, cudaAvailable: cuda }));
        executors.register(rStep(new RLocator(), new RLibraries(join(this.workRoot, "environments", "r"), helpersDir), { helpersDir, cudaAvailable: cuda }));
      }
      this.engineInstance = new PipelineEngine({
        store: this.ctx.store,
        workRoot: join(this.workRoot, "runs"),
        executors,
        services: this.connectorServices(),
        logger: this.ctx.log.child({ module: "pipelines" }),
        onEvent: (e) => {
          if (e.type !== "run" || e.status === "started" || e.status === "running") return;
          void this.notifyFinished(e.pipelineId, e.runId).catch((err) => this.ctx.log.error("pipeline notification failed", { err }));
          void this.schedulerInstance?.pipelineFinished({ pipelineId: e.pipelineId, runId: e.runId, status: e.status }).catch((err) => this.ctx.log.error("pipeline dependency update failed", { err }));
        },
      });
    }
    return this.engineInstance;
  }

  /** Tells people what matters about a finished run (failures, recoveries, unusual runs, data quality). */
  private async notifyFinished(pipelineId: string, runId: string): Promise<void> {
    const pipeline = this.store.get(pipelineId);
    if (!pipeline) return;
    const run = this.engine.runs.require(runId);
    const previous = this.engine.runs.list(pipelineId, 30);
    for (const n of notificationsForRun(pipeline, run, previous)) {
      if (this.notifications) await this.notifications.publish({ severity: n.severity, source: "pipeline", title: n.title, message: n.message, link: `/pipelines/${pipeline.id}/runs/${run.id}` });
      else this.ctx.activity.add(n.severity === "critical" ? "problem" : n.severity === "warning" ? "warning" : "info", `${n.title}. ${n.message}`);
    }
  }

  /** Starts scheduled, file-arrival and after-upstream runs. */
  startScheduler(): void {
    if (this.schedulerInstance || !this.available) return;
    this.schedulerInstance = new PipelineScheduler({
      store: this.ctx.store,
      pipelines: this.store,
      run: (pipeline, request) => void this.engine.start(pipeline, { trigger: request.trigger, logicalTime: request.logicalTime, requestedBy: null }),
      isRunning: (id) => this.engine.isRunning(id),
      checkFilePath: (pattern) => this.checkPath(pattern, "read"),
      logger: this.ctx.log.child({ module: "pipeline-scheduler" }),
    });
    this.schedulerInstance.start();
    this.ctx.onStop(() => this.schedulerInstance?.stop());
  }

  get scheduler(): PipelineScheduler | null {
    return this.schedulerInstance;
  }

  history(): PipelineRunHistory {
    return new PipelineRunHistory(this.engine.runs);
  }

  // ------------------------------------------------------------------ runs

  /**
   * Starts a run. API, webhook and app-token callers can only run pipelines that have been switched
   * on (approved); people may also test-run or run a pipeline that is still off.
   */
  run(idOrSlug: string, req: StartRunRequest): { runId: string; pipeline: PipelineRecord } {
    const p = this.store.require(idOrSlug);
    if (!p.enabled && req.trigger === "api") throw NexusError.conflict(`${p.name} is switched off. Turn it on before other applications can start it.`);
    const testRows = req.testRows ?? null;
    const { runId } = this.engine.start(p, { params: req.params, testRows, trigger: testRows ? "test" : req.trigger, requestedBy: req.requestedBy });
    return { runId, pipeline: p };
  }

  wait(runId: string): Promise<PipelineRun> {
    return this.engine.wait(runId);
  }

  // ------------------------------------------------------------------ webhooks

  /** Creates (or replaces) the pipeline's webhook secret. Shown once; only its hash is kept. */
  issueWebhook(idOrSlug: string): { url: string; token: string } {
    const p = this.store.require(idOrSlug);
    const token = `nxw_${randomBytes(24).toString("base64url")}`;
    this.ctx.settings.set(WEBHOOK_SETTING(p.id), { hash: sha256(token), createdAt: new Date().toISOString() });
    return { url: `/api/v1/hooks/pipelines/${p.slug}`, token };
  }

  webhookInfo(idOrSlug: string): { enabled: boolean; createdAt: string | null; url: string } {
    const p = this.store.require(idOrSlug);
    const w = this.ctx.settings.get<{ hash: string; createdAt: string } | null>(WEBHOOK_SETTING(p.id), null);
    return { enabled: !!w, createdAt: w?.createdAt ?? null, url: `/api/v1/hooks/pipelines/${p.slug}` };
  }

  revokeWebhook(idOrSlug: string): void {
    const p = this.store.require(idOrSlug);
    this.ctx.settings.delete(WEBHOOK_SETTING(p.id));
  }

  /** True when `token` is this pipeline's webhook secret (constant-time comparison). */
  verifyWebhook(p: PipelineRecord, token: string | undefined): boolean {
    const w = this.ctx.settings.get<{ hash: string } | null>(WEBHOOK_SETTING(p.id), null);
    if (!w || !token) return false;
    const a = Buffer.from(w.hash, "hex");
    const b = Buffer.from(sha256(token), "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  }

  // ------------------------------------------------------------------ secrets

  secretNames(): { name: string; updatedAt: string }[] {
    return this.ctx.vault
      .list("pipelines")
      .filter((s) => s.name.startsWith(SECRET_PREFIX))
      .map((s) => ({ name: s.name.slice(SECRET_PREFIX.length), updatedAt: s.updatedAt }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  setSecret(name: string, value: string): void {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) throw NexusError.invalid("Secret names use letters, numbers, dots, dashes and underscores.");
    this.ctx.vault.set(`${SECRET_PREFIX}${name}`, value, "pipelines");
  }

  deleteSecret(name: string): boolean {
    return this.ctx.vault.delete(`${SECRET_PREFIX}${name}`);
  }

  // ------------------------------------------------------------------ what steps get from Nexus

  /** Files pipelines may never read or write: Nexus's own data, keys, databases and backups. */
  checkPath(path: string, _access: "read" | "write"): void {
    const target = resolve(path).toLowerCase();
    const within = (dir: string) => {
      const rel = relative(resolve(dir).toLowerCase(), target);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    };
    const dp = this.ctx.dataPaths;
    const protectedDirs = [this.ctx.opts.paths.root, dp?.database, dp?.backups, dp?.apps, join(this.workRoot, "environments"), process.env.SystemRoot ?? "C:\\Windows"].filter((d): d is string => !!d);
    if (protectedDirs.some(within)) throw new StepError("Nexus's own folders (settings, databases, backups, applications) can't be used by pipelines. Choose another folder.");
  }

  /** A bundled DuckDB extension file (excel, postgres_scanner, sqlite_scanner), if installed. */
  extensionFile(name: string): string | undefined {
    const dir = this.ctx.component("duckdb-extensions");
    const file = dir ? join(dir, `${name}.duckdb_extension`) : null;
    return file && existsSync(file) ? file : undefined;
  }

  /** A connection URL for a Nexus database, using the pipelines' own login (which can create tables). */
  async databaseUrl(databaseId: string): Promise<string> {
    const dbs = this.ctx.databases;
    if (!dbs) throw NexusError.conflict("The database server isn't running.");
    return (await dbs.grantAppAccess(dbs.require(databaseId).id, PIPELINES_APP)).url;
  }

  private connectorServices(): ConnectorServices {
    return {
      secret: (name) => this.ctx.vault.get(`${SECRET_PREFIX}${name}`),
      checkPath: (path, access) => this.checkPath(path, access),
      extension: (name) => this.extensionFile(name),
      database: async (ref) => {
        if ("secret" in ref) {
          const url = this.ctx.vault.get(`${SECRET_PREFIX}${ref.secret}`);
          if (!url) throw new StepError(`The secret "${ref.secret}" isn't set up. Add it under Pipelines › Secrets.`);
          return { url, label: "the external database" };
        }
        const dbs = this.ctx.databases;
        if (!dbs) throw new StepError("The database server isn't running.", { transient: true });
        const wanted = ref.database.trim().toLowerCase();
        const db = dbs.list().find((d) => d.name.toLowerCase() === wanted || d.dbName === wanted);
        if (!db) throw new StepError(`There is no Nexus database called ${ref.database}.`);
        return { url: (await dbs.grantAppAccess(db.id, PIPELINES_APP)).url, label: db.name };
      },
      documentDatabase: async (ref) => {
        if ("secret" in ref) {
          const url = this.ctx.vault.get(`${SECRET_PREFIX}${ref.secret}`);
          if (!url) throw new StepError(`The secret "${ref.secret}" isn't set up. Add it under Pipelines › Secrets.`);
          return { url, label: "the external MongoDB server" };
        }
        const docs = this.ctx.documents;
        if (!docs) throw new StepError("Document databases aren't available on this server.", { transient: true });
        const wanted = ref.database.trim().toLowerCase();
        const db = docs.list().find((d) => d.name.toLowerCase() === wanted || d.dbName.toLowerCase() === wanted);
        if (!db) throw new StepError(`There is no Nexus document database called ${ref.database}.`);
        await docs.ensureRunning(db.id);
        const info = await docs.grantAppAccess(db.id, PIPELINES_APP);
        return { url: info.url, label: db.name, database: db.dbName };
      },
      warehouse: async () => {
        const dbs = this.ctx.databases;
        if (!dbs) throw new StepError("The database server isn't running.", { transient: true });
        let id = this.ctx.settings.get<string | null>(WAREHOUSE_SETTING, null);
        if (!id || !dbs.get(id)) {
          const { database } = await dbs.createDatabase({ displayName: "Warehouse" });
          id = database.id;
          this.ctx.settings.set(WAREHOUSE_SETTING, id);
          this.ctx.activity.add("success", "The Nexus Warehouse was created for your pipelines.");
        }
        return { url: (await dbs.grantAppAccess(id, PIPELINES_APP)).url, label: "the Warehouse" };
      },
      storageFile: (app, path) => {
        if (!this.ctx.storage) throw new StepError("Nexus Storage isn't available.");
        const base = this.ctx.storage.persistentDir(app);
        const full = resolve(base, path);
        const rel = relative(base, full);
        if (rel.startsWith("..") || isAbsolute(rel)) throw new StepError("That storage path points outside the application's storage.");
        return full;
      },
      notify: async (message, info) => {
        const p = this.store.get(info.pipelineId);
        const title = p?.name ?? "Pipeline";
        if (this.notifications) await this.notifications.publish({ severity: "info", source: "pipeline", title, message, link: `/pipelines/${info.pipelineId}/runs/${info.runId}` });
        else this.ctx.activity.add("info", `${title}: ${message}`);
      },
    };
  }
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
