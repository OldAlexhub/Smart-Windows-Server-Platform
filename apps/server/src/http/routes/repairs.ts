import { z } from "zod";
import { NexusError } from "@nexus/shared";
import type { RouteModule } from "../server";
import { requirePermission } from "../auth";
import type { NexusServices } from "../../app";

/**
 * One-click repairs offered by friendly problems. Only safe, well-understood actions:
 * none of them edits application code or silently changes business data. Actions that change
 * data or configuration require `confirmed: true` (the UI asks first).
 */
export function repairRoutes(s: NexusServices): RouteModule {
  return (app, ctx) => {
    app.post("/api/v1/repairs", async (req) => {
      const body = z
        .object({ id: z.string(), appId: z.string().optional(), confirmed: z.boolean().optional(), params: z.record(z.string(), z.string()).optional() })
        .parse(req.body);
      const needApp = () => {
        if (!body.appId) throw NexusError.invalid("This repair needs an application.");
        return s.apps.require(body.appId);
      };
      const needConfirm = () => {
        if (!body.confirmed) throw NexusError.invalid("Please confirm this repair first.");
      };
      const audit = (userId: string, name: string) =>
        ctx.audit.record({ actor: { type: "user", id: userId, name }, action: `repair.${body.id}`, target: body.appId ? { type: "app", id: body.appId } : undefined, ip: req.clientIp });

      switch (body.id) {
        case "gateway.retry": {
          const u = requirePermission(req, "network.manage");
          audit(u.id, u.displayName);
          const r = await s.gateway.sync();
          if (!r.ok) throw new NexusError("infrastructure", r.error ?? "The secure gateway still can't start.");
          return { ok: true, message: s.gateway.problem ? s.gateway.problem.summary : "Secure access is working." };
        }
        case "certificates.retry": {
          const u = requirePermission(req, "network.manage");
          audit(u.id, u.displayName);
          // Reload even if nothing changed: Caddy then requests certificates now instead of after its backoff.
          const r = await s.gateway.sync({ force: true });
          if (!r.ok) throw new NexusError("infrastructure", r.error ?? "The secure gateway still can't start.");
          return { ok: true, message: "Nexus asked for the certificate again. This can take a minute." };
        }
        case "database.start": {
          const u = requirePermission(req, "server.settings");
          if (!ctx.postgres) throw NexusError.conflict("The database server isn't installed.");
          audit(u.id, u.displayName);
          await ctx.postgres.start();
          if (body.appId) await s.apps.restart(body.appId);
          return { ok: true, message: "The database server is running." };
        }
        case "database.repair-connection": {
          const a = needApp();
          const u = requirePermission(req, "app.configure", a.id);
          const pgDb = a.databaseId && ctx.databases ? a.databaseId : null;
          const docDb = a.documentDatabaseId && ctx.documents ? a.documentDatabaseId : null;
          if (!pgDb && !docDb) throw NexusError.conflict(`${a.name} doesn't use a Nexus database.`);
          audit(u.id, u.displayName);
          // Fresh credentials + freshly generated settings, then restart: fixes outdated or broken configuration.
          if (pgDb) await ctx.databases!.rotatePassword(pgDb, a.id);
          if (docDb) await (await ctx.startDocuments()).rotatePassword(docDb, a.id);
          const status = await s.apps.restart(a.id);
          return { ok: status === "running", message: status === "running" ? `${a.name} is connected to its database again.` : `${a.name} restarted but still has a problem.` };
        }
        case "documents.start": {
          const u = requirePermission(req, "server.settings");
          audit(u.id, u.displayName);
          await ctx.startDocuments();
          return { ok: true, message: "The document database server is running." };
        }
        case "app.reassign-port": {
          const a = needApp();
          const u = requirePermission(req, "app.operate", a.id);
          audit(u.id, u.displayName);
          await s.apps.stop(a.id);
          ctx.ports.release(`app:${a.id}`, "http");
          const status = await s.apps.start(a.id);
          return { ok: status === "running", message: `${a.name} moved to a free port.` };
        }
        case "app.reinstall":
        case "app.run-migrations": {
          const a = needApp();
          const u = requirePermission(req, "app.deploy", a.id);
          needConfirm();
          audit(u.id, u.displayName);
          return { ok: true, jobId: s.apps.deploy(a.id).id, message: `Rebuilding ${a.name}…` };
        }
        case "app.rollback": {
          const a = needApp();
          const u = requirePermission(req, "app.deploy", a.id);
          needConfirm();
          const previous = ctx.deployments?.history(a.id).find((d) => d.status === "superseded");
          if (!previous) throw NexusError.conflict("There is no earlier version to go back to.");
          audit(u.id, u.displayName);
          const r = await s.apps.rollback(a.id, previous.id, true);
          return { ok: r.status === "running", message: `${a.name} is back on ${previous.versionLabel}.` };
        }
        case "app.raise-memory-limit": {
          const a = needApp();
          const u = requirePermission(req, "app.configure", a.id);
          needConfirm();
          audit(u.id, u.displayName);
          const current = a.resources.memoryLimitMb === "auto" ? 1024 : a.resources.memoryLimitMb;
          s.apps.setResources(a.id, { ...a.resources, memoryLimitMb: current * 2 });
          const status = await s.apps.restart(a.id);
          return { ok: status === "running", message: `${a.name} may now use up to ${(current * 2) / 1024} GB of memory.` };
        }
        default:
          throw NexusError.invalid("Nexus doesn't know how to do that repair automatically.");
      }
    });
  };
}
