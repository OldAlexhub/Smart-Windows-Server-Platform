import { z } from "zod";
import type { RouteModule } from "../server";
import { requirePermission } from "../auth";
import type { NotificationService } from "../../services/notifications";

const severity = z.enum(["info", "warning", "critical"]);

export function notificationRoutes(n: NotificationService): RouteModule {
  return (app, ctx) => {
    app.get("/api/v1/notifications", async (req) => {
      requirePermission(req, "server.view");
      const q = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), unread: z.enum(["1", "0"]).optional() }).parse(req.query);
      return { unread: n.unreadCount(), items: n.list({ limit: q.limit, unreadOnly: q.unread === "1" }) };
    });

    app.post("/api/v1/notifications/read", async (req) => {
      requirePermission(req, "server.view");
      const { id } = z.object({ id: z.string().optional() }).parse(req.body ?? {});
      n.markRead(id);
      return { unread: n.unreadCount() };
    });

    app.get("/api/v1/notifications/settings", async (req) => {
      requirePermission(req, "server.settings");
      return n.settings();
    });

    app.put("/api/v1/notifications/settings", async (req) => {
      const user = requirePermission(req, "server.settings");
      const body = z.object({ webhookUrl: z.string().max(2000).nullable().optional(), minSeverity: severity.optional() }).parse(req.body);
      const s = n.configure(body);
      ctx.audit.record({ actor: { type: "user", id: user.id, name: user.displayName }, action: "notifications.configure", details: { webhook: s.webhookConfigured, minSeverity: s.minSeverity } });
      return s;
    });

    app.post("/api/v1/notifications/test", async (req) => {
      requirePermission(req, "server.settings");
      return n.test();
    });
  };
}
