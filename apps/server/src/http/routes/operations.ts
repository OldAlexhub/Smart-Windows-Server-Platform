import { z } from "zod";
import { downloadHeaders } from "@nexus/storage";
import { formatBytes, NexusError } from "@nexus/shared";
import type { RouteModule } from "../server";
import { requirePermission } from "../auth";
import type { AppManager } from "../../services/apps";
import type { BackupService } from "../../services/backups";
import { explainError } from "@nexus/logs";

/** Files, backups, restore and logs for each application. */
export function operationsRoutes(apps: AppManager, backups: BackupService): RouteModule {
  return (app, ctx) => {
    const storage = () => {
      if (!ctx.storage) throw NexusError.conflict("File storage isn't available yet.");
      return ctx.storage;
    };

    // ---------------- files ----------------
    app.get("/api/v1/apps/:id/files", async (req) => {
      const { id } = req.params as { id: string };
      requirePermission(req, "app.view", id);
      apps.require(id);
      const q = z.object({ folder: z.string().optional(), search: z.string().max(200).optional() }).parse(req.query);
      return { ...storage().list(id, q), usage: storage().usage(id) };
    });

    app.post("/api/v1/apps/:id/files", async (req) => {
      const { id } = req.params as { id: string };
      const user = requirePermission(req, "app.data.write", id);
      apps.require(id);
      const folder = (req.query as { folder?: string }).folder ?? "";
      const uploaded = [];
      for await (const part of req.files()) {
        uploaded.push(await storage().put(id, { name: part.filename, contentType: part.mimetype, folder, createdBy: `user:${user.id}` }, part.file));
      }
      if (!uploaded.length) throw NexusError.invalid("Choose at least one file to upload.");
      ctx.audit.record({ actor: { type: "user", id: user.id, name: user.displayName }, action: "files.upload", target: { type: "app", id }, details: { count: uploaded.length } });
      return uploaded;
    });

    app.get("/api/v1/apps/:id/files/:fileId", async (req, reply) => {
      const { id, fileId } = req.params as { id: string; fileId: string };
      requirePermission(req, "app.view", id);
      const { object, stream } = storage().open(id, fileId);
      for (const [k, v] of Object.entries(downloadHeaders(object, (req.query as { download?: string }).download !== "1"))) reply.header(k, v);
      return reply.send(stream);
    });

    app.delete("/api/v1/apps/:id/files/:fileId", async (req) => {
      const { id, fileId } = req.params as { id: string; fileId: string };
      const user = requirePermission(req, "app.data.write", id);
      storage().delete(id, fileId);
      ctx.audit.record({ actor: { type: "user", id: user.id, name: user.displayName }, action: "files.delete", target: { type: "app", id }, details: { fileId } });
      return { ok: true };
    });

    // ---------------- backups ----------------
    app.get("/api/v1/backups", async (req) => {
      requirePermission(req, "server.view");
      if (!ctx.backups) return [];
      return apps.list().map((a) => {
        const p = ctx.backups!.protection(a.id, backups.expectedContents(a.id), backups.policy(a.id));
        return { appId: a.id, appName: a.name, ...p, policy: backups.policy(a.id) };
      });
    });

    app.get("/api/v1/apps/:id/backups", async (req) => {
      const { id } = req.params as { id: string };
      requirePermission(req, "app.view", id);
      return (ctx.backups?.list(id) ?? []).map((b) => ({ ...b, path: undefined, sizeLabel: b.size ? formatBytes(b.size) : null }));
    });

    app.post("/api/v1/apps/:id/backups", async (req) => {
      const { id } = req.params as { id: string };
      const user = requirePermission(req, "app.backup", id);
      const a = apps.require(id);
      ctx.audit.record({ actor: { type: "user", id: user.id, name: user.displayName }, action: "backup.create", target: { type: "app", id } });
      const job = ctx.jobs.start("backup", `Backing up ${a.name}`, [{ key: "backup", label: "Creating an encrypted backup" }], async (j) => {
        j.step("backup", "running");
        const b = await backups.backupNow(id, "manual");
        j.step("backup", "done", b.size ? formatBytes(b.size) : undefined);
        return { backupId: b.id };
      });
      return { jobId: job.id };
    });

    app.put("/api/v1/apps/:id/backup-policy", async (req) => {
      const { id } = req.params as { id: string };
      requirePermission(req, "app.configure", id);
      const policy = z
        .object({
          enabled: z.boolean(),
          frequency: z.enum(["daily", "weekly", "custom"]),
          time: z.string().regex(/^\d{1,2}:\d{2}$/),
          weekday: z.number().int().min(0).max(6).optional(),
          intervalHours: z.number().int().min(1).max(168).optional(),
          retention: z.object({ daily: z.number().int().min(1).max(60), weekly: z.number().int().min(0).max(52), monthly: z.number().int().min(0).max(36), manual: z.number().int().min(1).max(100), preRestoreDays: z.number().int().min(1).max(365) }),
        })
        .parse(req.body);
      ctx.backups!.setPolicy(id, policy);
      return policy;
    });

    app.post("/api/v1/apps/:id/restore", async (req) => {
      const { id } = req.params as { id: string };
      const user = requirePermission(req, "app.restore", id);
      const body = z
        .object({ backupId: z.string(), parts: z.union([z.literal("entire"), z.array(z.enum(["database", "files", "config"])).min(1)]), confirmation: z.string() })
        .parse(req.body);
      const a = apps.require(id);
      if (body.confirmation.trim() !== a.name) throw NexusError.invalid(`To confirm, type the application name exactly: ${a.name}`);
      ctx.audit.record({ actor: { type: "user", id: user.id, name: user.displayName }, action: "backup.restore", target: { type: "app", id }, details: { backupId: body.backupId, parts: body.parts } });
      const job = ctx.jobs.start("restore", `Restoring ${a.name}`, [{ key: "restore", label: "Restoring (a safety backup is taken first)" }], async (j) => {
        j.step("restore", "running");
        const r = await backups.restore(id, body.backupId, body.parts, body.confirmation);
        j.step("restore", "done", `Restored: ${r.restored.join(", ")}`);
        return r;
      });
      return { jobId: job.id };
    });

    app.get("/api/v1/backups/recovery-key", async (req) => {
      const user = requirePermission(req, "server.recovery_key");
      ctx.audit.record({ actor: { type: "user", id: user.id, name: user.displayName }, action: "backup.recovery_key.view", ip: req.clientIp });
      return { recoveryKey: ctx.vault.exportRecoveryKey() };
    });

    // ---------------- logs ----------------
    app.get("/api/v1/apps/:id/logs", async (req) => {
      const { id } = req.params as { id: string };
      requirePermission(req, "app.logs", id);
      const q = z
        .object({ text: z.string().max(200).optional(), level: z.enum(["error", "warning", "info", "problems"]).optional(), limit: z.coerce.number().int().min(1).max(2000).optional(), since: z.string().optional() })
        .parse(req.query);
      return { entries: ctx.logs.search(`app:${id}`, q), counts: ctx.logs.countsFor(`app:${id}`) };
    });

    app.get("/api/v1/apps/:id/logs/explain", async (req) => {
      const { id } = req.params as { id: string };
      requirePermission(req, "app.logs", id);
      const a = apps.require(id);
      const latest = ctx.logs.search(`app:${id}`, { level: "error", limit: 1 })[0];
      if (!latest) return { problem: null, message: `${a.name} has no errors in its recent logs.` };
      return { problem: explainError(latest.message, { appName: a.name, databasePort: ctx.postgres?.port ?? null, databaseRunning: ctx.postgres ? (await ctx.postgres.state()) === "running" : null }), at: latest.t };
    });

    app.get("/api/v1/logs/system/:source", async (req) => {
      requirePermission(req, "server.settings");
      const { source } = req.params as { source: string };
      if (!/^(gateway|ai|postgres)$/.test(source)) throw NexusError.notFound("Log");
      return { entries: ctx.logs.search(`system:${source}`, { limit: 500 }) };
    });

  };
}
