import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, parse } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { describeComponent } from "@nexus/detection";
import { authorize, visibleAppIds } from "@nexus/security";
import { NexusError } from "@nexus/shared";
import type { RouteModule } from "../server";
import { SETTINGS } from "../../context";
import { isPrivateNetworkRequest, requirePermission, requireUser } from "../auth";
import type { AppManager } from "../../services/apps";
import type { ReliabilityService } from "../../services/reliability";

const DB_FINDING: Record<string, string> = {
  postgresql: "PostgreSQL database",
  "unknown-sql": "PostgreSQL database",
  mongodb: "Document database (MongoDB)",
  mysql: "MySQL database",
  sqlite: "SQLite file",
  mssql: "SQL Server database",
};

/** Largest new version accepted by upload (dependencies are installed by Nexus, not uploaded). */
const MAX_UPLOAD_BYTES = 2 * 1024 ** 3;

const accessSchema = z.enum(["private", "internet", "authorized", "api"]);
const PROJECT_MARKERS = ["package.json", "requirements.txt", "pyproject.toml", "manage.py", "index.html", "Pipfile"];

export function appRoutes(apps: AppManager, reliability?: ReliabilityService): RouteModule {
  return (app, ctx) => {
    // ---------------- Add Application wizard ----------------

    /** Folder picker that works the same locally and remotely (no native dialog needed). */
    app.get("/api/v1/fs/browse", async (req) => {
      requirePermission(req, "apps.create");
      const { path } = z.object({ path: z.string().optional() }).parse(req.query);
      if (!path) {
        const drives = "CDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((l) => `${l}:\\`).filter((d) => existsSync(d));
        return { path: null, parent: null, entries: drives.map((d) => ({ name: d, path: d, isProject: false })) };
      }
      if (!/^[A-Za-z]:\\/.test(path)) throw NexusError.invalid("Choose a folder on this computer.");
      let names: string[];
      try {
        names = readdirSync(path);
      } catch {
        throw NexusError.invalid("Nexus can't open that folder.");
      }
      const entries = names
        .filter((n) => !n.startsWith(".") && !["node_modules", "$Recycle.Bin", "System Volume Information", "Windows"].includes(n))
        .map((n) => ({ name: n, path: join(path, n) }))
        .filter((e) => {
          try {
            return statSync(e.path).isDirectory();
          } catch {
            return false;
          }
        })
        .slice(0, 500)
        .map((e) => ({ ...e, isProject: PROJECT_MARKERS.some((m) => existsSync(join(e.path, m))) }));
      const p = parse(path);
      return { path, parent: p.dir && p.dir !== path ? p.dir : null, isProject: PROJECT_MARKERS.some((m) => existsSync(join(path, m))), entries };
    });

    /** "We found: Node.js + Express backend, React frontend, PostgreSQL requirement, …" */
    app.post("/api/v1/apps/analyze", async (req) => {
      requirePermission(req, "apps.create");
      const { path } = z.object({ path: z.string().min(3) }).parse(req.body);
      const a = apps.analyze(path);
      const findings = [
        ...a.components.map(describeComponent),
        ...(a.database.required ? [DB_FINDING[a.database.kind ?? "unknown-sql"] ?? `${a.database.kind} database`] : []),
        ...(a.storage.required ? ["File uploads"] : []),
        ...(a.env.length ? [`${a.env.length} setting${a.env.length === 1 ? "" : "s"}`] : []),
      ];
      return {
        name: a.name,
        summary: a.summary,
        findings,
        database: { required: a.database.required, kind: a.database.kind, transactions: !!a.database.transactions, evidence: a.database.evidence },
        storage: a.storage,
        externalAccessRecommended: a.externalAccessRecommended,
        // Settings › Domains: new apps are suggested <app>.<base domain>.
        baseDomain: ctx.settings.get<string | null>(SETTINGS.baseDomain, null),
        settingsNeeded: a.env
          .filter((e) => !e.managed && (e.required || e.category === "secret"))
          .map((e) => ({ name: e.name, required: e.required, secret: e.category === "secret", exampleValue: e.exampleValue })),
        envFile: apps.envFilePreview(path, a),
        warnings: a.warnings,
        existingDatabases:
          a.database.kind === "mongodb"
            ? (ctx.documents?.list() ?? []).map((d) => ({ id: d.id, name: d.name, provider: d.provider, transactions: d.transactions }))
            : (ctx.databases?.list() ?? []).map((d) => ({ id: d.id, name: d.name })),
        analysis: a,
      };
    });

    app.post("/api/v1/apps", async (req) => {
      const user = requirePermission(req, "apps.create");
      const body = z
        .object({
          sourceDir: z.string().min(3),
          name: z.string().max(80).optional(),
          data: z.object({
            mode: z.enum(["new", "existing", "external", "none"]),
            databaseName: z.string().max(80).optional(),
            databaseId: z.string().optional(),
            externalUrl: z.string().max(2000).optional(),
          }),
          access: accessSchema,
          domain: z.string().max(253).nullable().optional(),
          importEnvFile: z.boolean().optional(),
          settings: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/), z.string().max(10_000)).optional(),
        })
        .parse(req.body);
      if (body.data.mode === "new" && !authorize(user, "databases.create")) throw NexusError.forbidden("You can't create databases.");
      return apps.create(body, { id: user.id, name: user.displayName });
    });

    // ---------------- jobs ----------------

    app.get("/api/v1/jobs/:id", async (req) => {
      requireUser(req);
      const job = ctx.jobs.get((req.params as { id: string }).id);
      if (!job) throw NexusError.notFound("Task");
      return job;
    });

    app.post("/api/v1/jobs/:id/answer", async (req) => {
      requireUser(req);
      const { questionId, value } = z.object({ questionId: z.string(), value: z.string() }).parse(req.body);
      if (!ctx.jobs.answer((req.params as { id: string }).id, questionId, value)) throw NexusError.invalid("That answer isn't one of the choices.");
      return { ok: true };
    });

    // ---------------- applications ----------------

    app.get("/api/v1/apps", async (req) => {
      const { user } = requireUser(req);
      const all = apps.list();
      const visible = new Set(visibleAppIds(user, all.map((a) => a.id)));
      return all.filter((a) => visible.has(a.id)).map((a) => apps.summary(a));
    });

    app.get("/api/v1/apps/:id", async (req) => {
      const id = (req.params as { id: string }).id;
      const user = requirePermission(req, "app.view", id);
      const a = apps.require(id);
      const db = a.databaseId ? ctx.databases?.get(a.databaseId) : null;
      return {
        ...apps.summary(a),
        sourceDir: a.sourceDir,
        analysis: { summary: a.analysis.summary, components: a.analysis.components.map((c) => ({ role: c.role, framework: c.framework, path: c.path })), health: a.analysis.health },
        database: db ? { id: db.id, name: db.name } : null,
        publicHosts: a.publicHosts,
        addresses: apps.addresses(id),
        suggestedDomain: (() => {
          const base = ctx.settings.get<string | null>(SETTINGS.baseDomain, null);
          return base ? `${a.id}.${base}` : null;
        })(),
        deployments: (ctx.deployments?.history(id) ?? []).map((d) => ({
          id: d.id,
          version: d.versionLabel,
          status: d.status,
          createdAt: d.createdAt,
          activatedAt: d.activatedAt,
          commit: d.sourceCommit,
          error: d.error,
        })),
        logCounts: ctx.logs.countsFor(`app:${id}`),
        settings: authorize(user, "app.configure", id) ? apps.envView(id, false) : [],
        activity: ctx.activity.list(10, id),
        reliability: reliability?.appSummary(id) ?? null,
        deploymentJobId: apps.activeDeploymentJobId(id),
      };
    });

    for (const action of ["start", "stop", "restart"] as const) {
      app.post(`/api/v1/apps/:id/${action}`, async (req) => {
        const id = (req.params as { id: string }).id;
        const user = requirePermission(req, "app.operate", id);
        ctx.audit.record({ actor: { type: "user", id: user.id, name: user.displayName }, action: `app.${action}`, target: { type: "app", id }, ip: req.clientIp });
        if (action === "stop") {
          await apps.stop(id);
          return { status: "stopped" };
        }
        return { status: action === "start" ? await apps.start(id) : await apps.restart(id) };
      });
    }

    /** Dashboard › Refresh: changes that haven't reached the running apps yet. */
    app.get("/api/v1/apps/pending-updates", async (req) => {
      const user = requirePermission(req, "server.view");
      return apps.pendingUpdates().filter((u) => authorize(user, u.action === "deploy" ? "app.deploy" : "app.operate", u.appId));
    });

    app.post("/api/v1/apps/:id/deploy", async (req) => {
      const id = (req.params as { id: string }).id;
      const user = requirePermission(req, "app.deploy", id);
      ctx.audit.record({ actor: { type: "user", id: user.id, name: user.displayName }, action: "app.redeploy", target: { type: "app", id }, ip: req.clientIp });
      return { jobId: apps.deploy(id).id };
    });

    // ---------------- delivery: updating apps without downtime ----------------

    /** Saves an uploaded zip (browser form or raw body) next to the app, then puts it live. */
    const receiveZip = async (appId: string, stream: NodeJS.ReadableStream): Promise<{ jobId: string; files: number }> => {
      const dir = ctx.deployments!.appDir(appId);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `upload-${Date.now()}.zip`);
      let bytes = 0;
      try {
        await pipeline(
          stream,
          new Transform({
            transform(chunk: Buffer, _enc, cb) {
              bytes += chunk.length;
              if (bytes > MAX_UPLOAD_BYTES) cb(NexusError.invalid("That zip file is larger than 2 GB. Leave out node_modules, .venv and build output — Nexus installs those itself."));
              else cb(null, chunk);
            },
          }),
          createWriteStream(file),
        );
        if (!bytes) throw NexusError.invalid("No file was received.");
        return await apps.uploadSource(appId, file);
      } finally {
        rmSync(file, { force: true });
      }
    };

    // A zip sent as the raw request body (curl --data-binary, Invoke-RestMethod -InFile) is streamed to disk.
    for (const type of ["application/zip", "application/x-zip-compressed"]) {
      if (!app.hasContentTypeParser(type)) app.addContentTypeParser(type, (_req, payload, done) => done(null, payload));
    }

    app.get("/api/v1/apps/:id/delivery", async (req) => {
      const id = (req.params as { id: string }).id;
      requirePermission(req, "app.deploy", id);
      return apps.delivery(id);
    });

    app.put("/api/v1/apps/:id/auto-deploy", async (req) => {
      const id = (req.params as { id: string }).id;
      const user = requirePermission(req, "app.deploy", id);
      const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
      apps.setAutoDeploy(id, enabled);
      ctx.audit.record({ actor: { type: "user", id: user.id, name: user.displayName }, action: enabled ? "app.auto_deploy.on" : "app.auto_deploy.off", target: { type: "app", id } });
      return apps.delivery(id);
    });

    app.post("/api/v1/apps/:id/upload", async (req) => {
      const id = (req.params as { id: string }).id;
      const user = requirePermission(req, "app.deploy", id);
      apps.require(id);
      const part = await req.file({ limits: { files: 1, fileSize: MAX_UPLOAD_BYTES } });
      if (!part) throw NexusError.invalid("Choose a .zip file with the new version of your app.");
      ctx.audit.record({ actor: { type: "user", id: user.id, name: user.displayName }, action: "app.upload", target: { type: "app", id }, details: { file: part.filename }, ip: req.clientIp });
      return receiveZip(id, part.file);
    });

    app.post("/api/v1/apps/:id/deploy-key", async (req) => {
      const id = (req.params as { id: string }).id;
      const user = requirePermission(req, "app.deploy", id);
      const key = apps.issueDeployKey(id);
      ctx.audit.record({ actor: { type: "user", id: user.id, name: user.displayName }, action: "app.deploy_key.issue", target: { type: "app", id } });
      return key;
    });

    app.delete("/api/v1/apps/:id/deploy-key", async (req) => {
      const id = (req.params as { id: string }).id;
      const user = requirePermission(req, "app.deploy", id);
      apps.revokeDeployKey(id);
      ctx.audit.record({ actor: { type: "user", id: user.id, name: user.displayName }, action: "app.deploy_key.revoke", target: { type: "app", id } });
      return { ok: true };
    });

    /**
     * Deploy hook for other computers and build scripts. Authenticated by the app's deploy key
     * (Authorization: Bearer nxd_…). With a zip body (Content-Type: application/zip, or a form
     * upload) that version goes live; with no body the app's folder is redeployed. Accepted from this
     * computer and the private network only — never straight from the internet.
     */
    app.post("/api/v1/hooks/deploy/:id", async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const auth = String(req.headers.authorization ?? "");
      const key = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : String(req.headers["x-nexus-deploy-key"] ?? "");
      if (req.remote && !isPrivateNetworkRequest(ctx, req)) {
        return reply.code(403).send({ error: { code: "forbidden", message: "Deploy keys work from this computer or your private network (WireGuard) only.", problem: null } });
      }
      if (!apps.verifyDeployKey(id, key)) {
        ctx.audit.record({ actor: { type: "system", id: "deploy-key", name: "Deploy key" }, action: "app.deploy_hook", outcome: "denied", target: { type: "app", id }, ip: req.clientIp });
        return reply.code(401).send({ error: { code: "unauthorized", message: "Unknown application or wrong deploy key.", problem: null } });
      }
      ctx.audit.record({ actor: { type: "system", id: "deploy-key", name: "Deploy key" }, action: "app.deploy_hook", target: { type: "app", id }, ip: req.clientIp });
      const type = String(req.headers["content-type"] ?? "");
      let result: { jobId: string; files?: number };
      if (type.startsWith("multipart/")) {
        const part = await req.file({ limits: { files: 1, fileSize: MAX_UPLOAD_BYTES } });
        if (!part) throw NexusError.invalid("Send the .zip file in the form field \"file\".");
        result = await receiveZip(id, part.file);
      } else if (Number(req.headers["content-length"] ?? 0) > 0 || req.headers["transfer-encoding"]) {
        result = await receiveZip(id, req.body as NodeJS.ReadableStream);
      } else {
        result = { jobId: apps.deploy(id).id };
      }
      return reply.code(202).send({ ...result, status: "deploying", follow: `/api/v1/hooks/deploy/${id}/jobs/${result.jobId}` });
    });

    /** Progress of a deploy started with the deploy key (same key). */
    app.get("/api/v1/hooks/deploy/:id/jobs/:jobId", async (req, reply) => {
      const { id, jobId } = req.params as { id: string; jobId: string };
      const auth = String(req.headers.authorization ?? "");
      const key = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : String(req.headers["x-nexus-deploy-key"] ?? "");
      if ((req.remote && !isPrivateNetworkRequest(ctx, req)) || !apps.verifyDeployKey(id, key)) return reply.code(401).send({ error: { code: "unauthorized", message: "Unknown application or wrong deploy key.", problem: null } });
      const job = ctx.jobs.get(jobId);
      if (!job || apps.jobApp(jobId) !== id) return reply.code(404).send({ error: { code: "not_found", message: "No such deployment.", problem: null } });
      return { status: job.status, steps: job.steps.map((s) => ({ label: s.label, status: s.status, detail: s.detail ?? null })), problem: job.problem ?? null };
    });

    app.post("/api/v1/apps/:id/rollback", async (req) => {
      const id = (req.params as { id: string }).id;
      const user = requirePermission(req, "app.deploy", id);
      const { deploymentId, confirmed } = z.object({ deploymentId: z.string(), confirmed: z.boolean().optional() }).parse(req.body);
      const r = await apps.rollback(id, deploymentId, confirmed ?? false);
      if (!r.requiresConfirmation) ctx.audit.record({ actor: { type: "user", id: user.id, name: user.displayName }, action: "app.rollback", target: { type: "app", id }, details: { deploymentId } });
      return r;
    });

    app.put("/api/v1/apps/:id/access", async (req) => {
      const id = (req.params as { id: string }).id;
      const user = requirePermission(req, "app.access.configure", id);
      const { access, domain } = z.object({ access: accessSchema, domain: z.string().max(253).nullable().optional() }).parse(req.body);
      await apps.setAccess(id, access, domain ?? null);
      ctx.audit.record({ actor: { type: "user", id: user.id, name: user.displayName }, action: "app.access", target: { type: "app", id }, details: { access, domain } });
      return apps.summary(apps.require(id));
    });

    app.get("/api/v1/apps/:id/settings", async (req) => {
      const id = (req.params as { id: string }).id;
      requirePermission(req, "app.configure", id);
      const reveal = (req.query as { reveal?: string }).reveal === "1";
      if (reveal) requirePermission(req, "app.secrets.read", id);
      return apps.envView(id, reveal);
    });

    app.put("/api/v1/apps/:id/settings/:name", async (req) => {
      const { id, name } = req.params as { id: string; name: string };
      const user = requirePermission(req, "app.configure", id);
      const { value } = z.object({ value: z.string().max(16_384).nullable() }).parse(req.body);
      apps.setEnv(id, name, value);
      ctx.audit.record({ actor: { type: "user", id: user.id, name: user.displayName }, action: "app.setting", target: { type: "app", id }, details: { name } });
      return { ok: true, restartNeeded: true };
    });

    app.put("/api/v1/apps/:id/health", async (req) => {
      const id = (req.params as { id: string }).id;
      const user = requirePermission(req, "app.configure", id);
      const body = z.discriminatedUnion("mode", [
        z.object({ mode: z.literal("automatic") }),
        z.object({ mode: z.literal("custom"), path: z.string().min(1).max(256) }),
      ]).parse(req.body);
      const health = apps.setHealthMonitoring(id, body.mode, body.mode === "custom" ? body.path : undefined);
      ctx.audit.record({ actor: { type: "user", id: user.id, name: user.displayName }, action: "app.health_monitoring", target: { type: "app", id }, details: { mode: body.mode, path: body.mode === "custom" ? body.path : null } });
      return { health, restartNeeded: false };
    });

    /** Settings found in the app's own .env files (names only — values never leave the server). */
    app.get("/api/v1/apps/:id/env-file", async (req) => {
      const id = (req.params as { id: string }).id;
      requirePermission(req, "app.configure", id);
      const { files, settings } = apps.envFile(id);
      return { files, settings };
    });

    app.post("/api/v1/apps/:id/env-file/import", async (req) => {
      const id = (req.params as { id: string }).id;
      const user = requirePermission(req, "app.configure", id);
      const { names } = z.object({ names: z.array(z.string()).optional() }).parse(req.body ?? {});
      const imported = apps.importEnvFile(id, names);
      ctx.audit.record({ actor: { type: "user", id: user.id, name: user.displayName }, action: "app.settings.import", target: { type: "app", id }, details: { names: imported } });
      return { imported, restartNeeded: imported.length > 0 };
    });

    /** Advanced › Developer: ports, runtime, isolation, release, settings, database connection, credentials. */
    app.get("/api/v1/apps/:id/developer", async (req) => {
      const id = (req.params as { id: string }).id;
      const user = requirePermission(req, "app.configure", id);
      const reveal = (req.query as { reveal?: string }).reveal === "1";
      if (reveal) {
        requirePermission(req, "app.secrets.read", id);
        ctx.audit.record({ actor: { type: "user", id: user.id, name: user.displayName }, action: "app.secrets.reveal", target: { type: "app", id }, ip: req.clientIp });
      }
      return apps.developerInfo(id, reveal);
    });

    app.get("/api/v1/apps/:id/verify", async (req) => {
      const id = (req.params as { id: string }).id;
      requirePermission(req, "app.view", id);
      return apps.verify(id);
    });

    app.delete("/api/v1/apps/:id", async (req) => {
      const id = (req.params as { id: string }).id;
      const user = requirePermission(req, "app.delete", id);
      const { confirmation } = z.object({ confirmation: z.string() }).parse(req.body);
      await apps.remove(id, confirmation);
      ctx.audit.record({ actor: { type: "user", id: user.id, name: user.displayName }, action: "app.delete", target: { type: "app", id } });
      return { ok: true };
    });
  };
}
