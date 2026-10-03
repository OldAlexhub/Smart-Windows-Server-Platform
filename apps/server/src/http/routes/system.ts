import { z } from "zod";
import { computeHealthScore } from "@nexus/monitoring";
import {
  detectPublicIp,
  DirectProvider,
  CloudflareTunnelProvider,
  TailscaleProvider,
  normalizeDomain,
  verifyDns,
  checkHttps,
  readGatewayLog,
} from "@nexus/network";
import { isRole, ROLES, APP_ROLES, type Role } from "@nexus/security";
import { BRAND, NexusError, randomToken } from "@nexus/shared";
import { SETTINGS } from "../../context";
import type { RouteModule } from "../server";
import { requirePermission, requireUser, type RemoteAdminSettings } from "../auth";
import type { AppManager } from "../../services/apps";
import type { AiService } from "../../services/ai";
import type { BackupService } from "../../services/backups";
import type { GatewayService } from "../../services/gateway";
import type { ReliabilityService } from "../../services/reliability";

export function systemRoutes(deps: {
  apps: AppManager;
  ai: AiService;
  backups: BackupService;
  gateway: GatewayService;
  reliability: ReliabilityService;
}): RouteModule {
  const { apps, ai, backups, gateway, reliability } = deps;
  return (app, ctx) => {
    // ---------------- dashboard ----------------
    app.get("/api/v1/dashboard", async (req) => {
      requirePermission(req, "server.view");
      const summaries = apps.list().map((a) => apps.summary(a));
      const snap = ctx.monitoring?.latest() ?? null;
      const dbList = ctx.databases?.list() ?? [];
      const documentTotal = (() => {
        try {
          return ctx.documents?.list().length ?? Number(ctx.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM docdb_databases")?.n ?? 0);
        } catch {
          return 0;
        }
      })();
      const pgState = ctx.postgres ? await ctx.postgres.state() : null;
      const unprotected = ctx.backups
        ? apps
            .list()
            .filter(
              (a) => !ctx.backups!.protection(a.id, backups.expectedContents(a.id), backups.policy(a.id)).protected,
            )
            .map((a) => a.name)
        : [];
      const storageDisks = snap?.disks ?? [];
      const health = computeHealthScore({
        apps: summaries.map((s) => ({ name: s.name, status: s.status })),
        databasesOffline:
          (pgState && pgState !== "running" ? dbList.length || 1 : 0) +
          (!ctx.documents ? documentTotal : 0),
        cpuPercent: snap?.cpuPercent ?? null,
        memoryUsedFraction: snap ? snap.memory.usedBytes / snap.memory.totalBytes : null,
        lowestDiskFreeFraction: storageDisks.length
          ? Math.min(...storageDisks.map((d) => d.freeBytes / d.totalBytes))
          : null,
        unprotectedApps: unprotected,
        externalAccessProblems:
          (gateway.lastError || gateway.problem) && summaries.some((s) => s.accessMode !== "private") ? 1 : 0,
        securityAlerts: 0,
      });
      const aiStatus = await ai.status();
      const gpu = snap?.gpus[0] ?? null;
      return {
        product: BRAND.productName,
        health,
        apps: {
          total: summaries.length,
          running: summaries.filter((s) => s.status === "running").length,
          items: summaries,
        },
        databases: {
          total: dbList.length + documentTotal,
          online: (pgState === "running" ? dbList.length : 0) + (ctx.documents ? documentTotal : 0),
        },
        storage: {
          usedBytes: storageDisks.reduce((s, d) => s + (d.totalBytes - d.freeBytes), 0),
          totalBytes: storageDisks.reduce((s, d) => s + d.totalBytes, 0),
        },
        cpuPercent: snap?.cpuPercent ?? null,
        memory: snap?.memory ?? null,
        gpu: gpu
          ? {
              name: gpu.name,
              utilizationPercent: gpu.utilizationPercent,
              memoryUsedBytes: gpu.memoryUsedBytes,
              memoryTotalBytes: gpu.memoryTotalBytes,
            }
          : null,
        externalAccess: {
          state: summaries.some((s) => s.accessMode !== "private")
            ? gateway.lastError || gateway.problem
              ? "problem"
              : "online"
            : "private",
          message: gateway.lastError ?? gateway.problem?.summary ?? null,
          problem: gateway.problem,
        },
        ai: { state: aiStatus.state, label: aiStatus.plan?.label ?? null, message: aiStatus.message },
        backups: { unprotected },
        activity: ctx.activity.list(40),
      };
    });

    app.get("/api/v1/metrics", async (req) => {
      requirePermission(req, "server.view");
      const q = z
        .object({
          key: z.string().regex(/^[a-z0-9._-]+$/i),
          rangeMinutes: z.coerce.number().int().min(1).max(1440).default(60),
        })
        .parse(req.query);
      const s = ctx.monitoring?.metrics.get(q.key);
      return { key: q.key, points: s?.range(q.rangeMinutes * 60_000) ?? [] };
    });

    app.get("/api/v1/reliability/system", async (req) => {
      requirePermission(req, "server.view");
      const { days } = z.object({ days: z.coerce.number().pipe(z.union([z.literal(7), z.literal(30)])).default(30) }).parse(req.query);
      return { days, disks: reliability.diskSummary(days) };
    });

    // ---------------- AI ----------------
    app.get("/api/v1/ai", async (req) => {
      requirePermission(req, "ai.use");
      return ai.status();
    });

    app.put("/api/v1/ai/settings", async (req) => {
      const user = requirePermission(req, "server.settings");
      const body = z
        .object({
          enabled: z.boolean().optional(),
          level: z.enum(["observe", "recommend", "execute_after_approval"]).optional(),
          preferredModel: z.string().max(100).nullable().optional(),
        })
        .parse(req.body);
      if (body.enabled !== undefined) ctx.settings.set(SETTINGS.aiEnabled, body.enabled);
      if (body.level) ctx.settings.set(SETTINGS.aiLevel, body.level);
      if (body.preferredModel !== undefined) ctx.settings.set(SETTINGS.aiModel, body.preferredModel);
      ctx.audit.record({
        actor: { type: "user", id: user.id, name: user.displayName },
        action: "ai.settings",
        details: body,
      });
      if (body.enabled) void ai.start();
      return ai.status();
    });

    app.post("/api/v1/ai/ask", async (req) => {
      requirePermission(req, "ai.use");
      const { question, history } = z
        .object({
          question: z.string().min(1).max(4000),
          history: z
            .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(4000) }))
            .max(20)
            .optional(),
        })
        .parse(req.body);
      return ai.ask(question, history ?? []);
    });

    app.get("/api/v1/ai/proposals", async (req) => {
      requirePermission(req, "ai.use");
      return ctx.aiProposals.list();
    });

    app.post("/api/v1/ai/proposals/:id/:decision", async (req) => {
      const user = requirePermission(req, "ai.approve");
      const { id, decision } = req.params as { id: string; decision: string };
      if (decision !== "approve" && decision !== "reject") throw NexusError.notFound("Action");
      const p = decision === "approve" ? ctx.aiProposals.approve(id, user.id) : ctx.aiProposals.reject(id, user.id);
      ctx.audit.record({
        actor: { type: "user", id: user.id, name: user.displayName },
        action: `ai.proposal.${decision}`,
        target: { type: "ai_proposal", id },
      });
      return p;
    });

    // ---------------- users ----------------
    app.get("/api/v1/users", async (req) => {
      requirePermission(req, "users.manage");
      return ctx.users.list();
    });

    app.post("/api/v1/users", async (req) => {
      const actor = requirePermission(req, "users.manage");
      const body = z
        .object({
          username: z.string(),
          displayName: z.string().min(1).max(80),
          role: z.string(),
          email: z.string().email().optional(),
          password: z.string().min(1).max(256).optional(),
        })
        .parse(req.body);
      if (!isRole(body.role) || body.role === "owner") throw NexusError.invalid("Choose a role.");
      const u = await ctx.users.createUser({ ...body, role: body.role as Role });
      ctx.audit.record({
        actor: { type: "user", id: actor.id, name: actor.displayName },
        action: "user.create",
        target: { type: "user", id: u.id },
        details: { role: u.role },
      });
      return u;
    });

    app.patch("/api/v1/users/:id", async (req) => {
      const actor = requirePermission(req, "users.manage");
      const { id } = req.params as { id: string };
      const body = z
        .object({
          role: z.enum(ROLES).optional(),
          disabled: z.boolean().optional(),
          serverSettingsAccess: z.boolean().optional(),
          appRoles: z.record(z.string(), z.enum(APP_ROLES).nullable()).optional(),
        })
        .parse(req.body);
      if (body.role) ctx.users.setRole(id, body.role);
      if (body.disabled !== undefined) ctx.users.setDisabled(id, body.disabled);
      if (body.serverSettingsAccess !== undefined) ctx.users.setServerSettingsAccess(id, body.serverSettingsAccess);
      for (const [appId, role] of Object.entries(body.appRoles ?? {})) ctx.users.setAppRole(id, appId, role);
      ctx.audit.record({
        actor: { type: "user", id: actor.id, name: actor.displayName },
        action: "user.update",
        target: { type: "user", id },
        details: body,
      });
      return ctx.users.require(id);
    });

    app.delete("/api/v1/users/:id", async (req) => {
      const actor = requirePermission(req, "users.manage");
      const { id } = req.params as { id: string };
      ctx.users.deleteUser(id);
      ctx.audit.record({
        actor: { type: "user", id: actor.id, name: actor.displayName },
        action: "user.delete",
        target: { type: "user", id },
      });
      return { ok: true };
    });

    app.post("/api/v1/me/password", async (req) => {
      const { user } = requireUser(req);
      const { password } = z.object({ password: z.string().min(1).max(256) }).parse(req.body);
      await ctx.users.setPassword(user.id, password);
      ctx.audit.record({ actor: { type: "user", id: user.id, name: user.displayName }, action: "user.password" });
      return { ok: true };
    });

    app.post("/api/v1/me/mfa/begin", async (req) => {
      const { user, session } = requireUser(req);
      if (session.remote) throw NexusError.forbidden("Set up two-step verification on this computer.");
      return ctx.users.beginMfaEnrollment(user.id, BRAND.productName);
    });

    app.post("/api/v1/me/mfa/confirm", async (req) => {
      const { user } = requireUser(req);
      const { code } = z.object({ code: z.string().min(6).max(8) }).parse(req.body);
      const recoveryCodes = ctx.users.confirmMfaEnrollment(user.id, code);
      ctx.audit.record({ actor: { type: "user", id: user.id, name: user.displayName }, action: "user.mfa.enable" });
      return { recoveryCodes };
    });

    app.get("/api/v1/audit", async (req) => {
      requirePermission(req, "audit.view");
      const q = z
        .object({
          targetType: z.string().optional(),
          targetId: z.string().optional(),
          limit: z.coerce.number().int().max(1000).optional(),
          beforeId: z.coerce.number().int().positive().optional(),
        })
        .parse(req.query);
      return { entries: ctx.audit.query(q), integrity: ctx.audit.verify() };
    });

    // ---------------- network & remote administration ----------------
    app.get("/api/v1/network", async (req) => {
      requirePermission(req, "server.view");
      const remoteAdmin = ctx.settings.get<RemoteAdminSettings>("remoteAdmin", { enabled: false, publicHost: null });
      const publicIp = await detectPublicIp();
      const providers = await Promise.all([
        new DirectProvider({ publicIp: async () => publicIp }).status(),
        new CloudflareTunnelProvider().status(),
        new TailscaleProvider().status(),
      ]);
      const direct = new DirectProvider();
      // The gateway's real state (actual ports, running, applied addresses) — never settings.
      const runtime = await gateway.runtime();
      const logLines = runtime.automaticHttps ? await readGatewayLog(runtime.logFile) : [];
      const sites = new Map(apps.gatewaySites().map((x) => [x.id, x]));
      const check = async (h: string, applicationRunning: boolean | null) => {
        const record = direct.dnsRecords([h], { publicIp })[0];
        const dns = record ? await verifyDns(record) : null;
        const https = await checkHttps({ hostname: h, dns, gateway: runtime, logLines, applicationRunning });
        return { dns, https, instruction: record?.instruction ?? null };
      };
      const domains = await Promise.all(
        apps
          .list()
          .filter((x) => x.accessMode !== "private")
          .flatMap((a) =>
            a.publicHosts.map(async (h) => {
              const site = sites.get(a.id);
              return { appId: a.id, appName: a.name, hostname: h, ...(await check(h, site ? site.upstreamPort !== null || !!site.static : null)) };
            }),
          ),
      );
      return {
        publicIp,
        providers,
        gateway: {
          available: runtime.installed,
          running: runtime.running,
          error: runtime.error,
          problem: runtime.problem,
          httpsPort: runtime.activeHttpsPort,
          configuredHttpsPort: runtime.configuredHttpsPort,
          usingFallbackPorts: runtime.fallback,
        },
        baseDomain: ctx.settings.get<string | null>(SETTINGS.baseDomain, null),
        remoteAdmin: {
          enabled: remoteAdmin.enabled,
          publicHost: remoteAdmin.publicHost,
          https: remoteAdmin.enabled && remoteAdmin.publicHost ? (await check(remoteAdmin.publicHost, true)).https : null,
        },
        domains,
      };
    });

    app.put("/api/v1/network/settings", async (req) => {
      const user = requirePermission(req, "network.manage");
      const body = z
        .object({
          baseDomain: z.string().max(253).nullable().optional(),
          acmeEmail: z.string().email().nullable().optional(),
        })
        .parse(req.body);
      if (body.baseDomain !== undefined)
        ctx.settings.set(SETTINGS.baseDomain, body.baseDomain ? normalizeDomain(body.baseDomain) : null);
      if (body.acmeEmail !== undefined)
        ctx.settings.set("gateway", { ...ctx.settings.get("gateway", {}), acmeEmail: body.acmeEmail });
      ctx.audit.record({
        actor: { type: "user", id: user.id, name: user.displayName },
        action: "network.settings",
        details: body,
      });
      await gateway.sync();
      return { ok: true };
    });

    /** Owner only. Remote administration needs a password and two-step verification on the Owner account first. */
    app.put("/api/v1/remote-admin", async (req) => {
      const user = requirePermission(req, "server.remote_admin");
      const body = z
        .object({ enabled: z.boolean(), publicHost: z.string().max(253).nullable().optional() })
        .parse(req.body);
      if (req.remote) throw NexusError.forbidden("Remote administration can only be changed on this computer.");
      if (body.enabled) {
        if (!user.hasPassword || !user.mfaEnabled)
          throw NexusError.conflict(
            "Set a password and turn on two-step verification before enabling remote administration.",
          );
        if (!body.publicHost)
          throw NexusError.invalid("Choose the address for remote administration, e.g. server.example.com.");
      }
      const previous = ctx.settings.get<RemoteAdminSettings>("remoteAdmin", { enabled: false, publicHost: null });
      const publicValue = {
        enabled: body.enabled,
        publicHost: body.enabled && body.publicHost ? normalizeDomain(body.publicHost) : null,
      };
      const changed = previous.enabled !== publicValue.enabled || previous.publicHost !== publicValue.publicHost;
      const value: RemoteAdminSettings = {
        ...publicValue,
        authRevision: changed || !previous.authRevision ? randomToken(18) : previous.authRevision,
      };
      ctx.settings.set("remoteAdmin", value);
      const revokedSessions = changed ? ctx.users.revokeRemoteManagementSessions() : 0;
      const applied = await gateway.sync();
      if (body.enabled && !applied.ok) {
        // Never report remote access as enabled when the secure gateway could not apply it.
        ctx.settings.set("remoteAdmin", { ...previous, authRevision: randomToken(18) });
        await gateway.sync();
        ctx.audit.record({
          actor: { type: "user", id: user.id, name: user.displayName },
          action: "remote_admin.update",
          outcome: "failure",
          details: { ...publicValue, error: applied.error ?? "Gateway configuration failed" },
        });
        throw NexusError.conflict(
          `Remote administration could not be turned on: ${applied.error ?? "the secure gateway could not apply the change"}`,
        );
      }
      ctx.audit.record({
        actor: { type: "user", id: user.id, name: user.displayName },
        action: "remote_admin.update",
        details: { ...publicValue, revokedSessions, gatewayWarning: applied.ok ? null : (applied.error ?? null) },
      });
      ctx.activity.add(
        body.enabled ? "warning" : "info",
        body.enabled ? `Remote administration turned on at ${value.publicHost}.` : "Remote administration turned off.",
      );
      if (!applied.ok)
        ctx.activity.add("warning", `Remote administration is off, but the gateway needs attention: ${applied.error}`);
      return { ...publicValue, gatewayWarning: applied.ok ? null : (applied.error ?? null) };
    });
  };
}
