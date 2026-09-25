import { z } from "zod";
import type { RouteModule } from "../server";
import { requirePermission } from "../auth";
import type { DatabaseLinkService } from "../../services/database-links";

const params = z.object({ kind: z.enum(["tables", "documents"]), id: z.string().min(1) });

/** Database page › "Connect from another server" (private network only). */
export function databaseLinkRoutes(links: DatabaseLinkService): RouteModule {
  return (app, ctx) => {
    const audit = (by: { id: string; displayName: string }, action: string, id: string) =>
      ctx.audit.record({ actor: { type: "user", id: by.id, name: by.displayName }, action, target: { type: "database", id } });

    app.get("/api/v1/database-links/:kind/:id", async (req) => {
      const { kind, id } = params.parse(req.params);
      const reveal = (req.query as { reveal?: string }).reveal === "1";
      const user = requirePermission(req, reveal ? "server.settings" : "server.view");
      if (reveal) audit(user, "database.link.reveal", id);
      return links.status(kind, id, reveal);
    });

    app.post("/api/v1/database-links/:kind/:id", async (req) => {
      const { kind, id } = params.parse(req.params);
      const user = requirePermission(req, "server.settings");
      const r = await links.enable(kind, id);
      audit(user, "database.link.enable", id);
      return r;
    });

    app.delete("/api/v1/database-links/:kind/:id", async (req) => {
      const { kind, id } = params.parse(req.params);
      const user = requirePermission(req, "server.settings");
      await links.disable(kind, id);
      audit(user, "database.link.disable", id);
      return { ok: true };
    });

    app.post("/api/v1/database-links/:kind/:id/rotate", async (req) => {
      const { kind, id } = params.parse(req.params);
      const user = requirePermission(req, "server.settings");
      const r = await links.rotate(kind, id);
      audit(user, "database.link.rotate", id);
      return r;
    });
  };
}
