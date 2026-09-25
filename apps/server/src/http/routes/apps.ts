import { existsSync, readdirSync, statSync } from "node:fs";
import { join, parse } from "node:path";
import { z } from "zod";
import { describeComponent } from "@nexus/detection";
import { authorize, visibleAppIds } from "@nexus/security";
import { NexusError } from "@nexus/shared";
import type { RouteModule } from "../server";
import { SETTINGS } from "../../context";
import { requirePermission, requireUser } from "../auth";
import type { AppManager } from "../../services/apps";

const DB_FINDING: Record<string, string> = {
  postgresql: "PostgreSQL database",
  "unknown-sql": "PostgreSQL database",
  mongodb: "Document database (MongoDB)",
  mysql: "MySQL database",
  sqlite: "SQLite file",
  mssql: "SQL Server database",
};

const accessSchema = z.enum(["private", "internet", "authorized", "api"]);
const PROJECT_MARKERS = ["package.json", "requirements.txt", "pyproject.toml", "manage.py", "index.html", "Pipfile"];

export function appRoutes(apps: AppManager): RouteModule {
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
        database: { required: a.database.required, kind: a.database.kind, evidence: a.database.evidence },
        storage: a.storage,
        externalAccessRecommended: a.externalAccessRecommended,
        // Settings › Domains: new apps are suggested <app>.<base domain>.
        baseDomain: ctx.settings.get<string | null>(SETTINGS.baseDomain, null),
        settingsNeeded: a.env.filter((e) => !e.managed && e.category === "secret").map((e) => e.name),
        warnings: a.warnings,
        existingDatabases:
          a.database.kind === "mongodb"
            ? (ctx.documents?.list() ?? []).map((d) => ({ id: d.id, name: d.name }))
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
        analysis: { summary: a.analysis.summary, components: a.analysis.components.map((c) => ({ role: c.role, framework: c.framework, path: c.path })), healthPath: a.analysis.healthPath },
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
