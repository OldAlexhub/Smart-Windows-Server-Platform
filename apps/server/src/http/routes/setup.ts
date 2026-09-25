import { z } from "zod";
import type { RouteModule } from "../server";
import { requirePermission } from "../auth";
import { applySetup, recommendation, runHardwareCheck } from "../../services/setup";

const pathSchema = z.string().min(3).max(260).regex(/^[A-Za-z]:\\/, "Use a full Windows path like D:\\Nexus");

export const setupRoutes: RouteModule = (app, ctx) => {
  app.get("/api/v1/setup/status", async (req) => {
    requirePermission(req, "server.view");
    return { completed: ctx.setupCompleted, hardwareChecked: !!ctx.hardware };
  });

  app.post("/api/v1/setup/check", async (req) => {
    requirePermission(req, "server.settings");
    return runHardwareCheck(ctx);
  });

  app.get("/api/v1/setup/recommendation", async (req) => {
    requirePermission(req, "server.settings");
    return recommendation(ctx);
  });

  app.post("/api/v1/setup/apply", async (req) => {
    const user = requirePermission(req, "server.settings");
    const body = z
      .object({
        paths: z
          .object({ apps: pathSchema, database: pathSchema, files: pathSchema, backups: pathSchema, ai: pathSchema })
          .partial()
          .optional(),
        aiEnabled: z.boolean().optional(),
      })
      .parse(req.body ?? {});
    await applySetup(ctx, body);
    ctx.audit.record({ actor: { type: "user", id: user.id, name: user.displayName }, action: "setup.apply", ip: req.clientIp });
    return { completed: true };
  });

  app.get("/api/v1/hardware", async (req) => {
    requirePermission(req, "server.view");
    return { hardware: ctx.hardware };
  });
};
