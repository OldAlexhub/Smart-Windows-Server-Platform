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

    app.get("/api/v1/database-links/tables/:id/accounts", async (req) => {
      requirePermission(req, "server.settings");
      const { id } = req.params as { id: string };
      return links.accounts().list(id);
    });
    app.post("/api/v1/database-links/tables/:id/accounts", async (req) => {
      const user = requirePermission(req, "server.settings");
      const { id } = req.params as { id: string };
      const input = z.object({ username: z.string().min(3).max(50), password: z.string().max(128).optional(), mode: z.enum(["read-only", "read-write"]).default("read-only") }).parse(req.body);
      const account = await links.accounts().create(id, input);
      audit(user, "database.account.create", id);
      return account;
    });
    app.post("/api/v1/database-links/tables/:id/accounts/:username/password", async (req) => {
      const user = requirePermission(req, "server.settings");
      const { id, username } = req.params as { id: string; username: string };
      const { password } = z.object({ password: z.string().max(128).optional() }).parse(req.body ?? {});
      const result = await links.accounts().rotate(id, username, password);
      audit(user, "database.account.rotate", id);
      return result;
    });
    app.delete("/api/v1/database-links/tables/:id/accounts/:username", async (req) => {
      const user = requirePermission(req, "server.settings");
      const { id, username } = req.params as { id: string; username: string };
      await links.accounts().revoke(id, username);
      audit(user, "database.account.revoke", id);
      return { ok: true };
    });

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
