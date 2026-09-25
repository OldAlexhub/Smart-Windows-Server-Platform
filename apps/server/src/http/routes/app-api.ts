import { Readable } from "node:stream";
import { z } from "zod";
import { AppTokens, authorize } from "@nexus/security";
import { downloadHeaders } from "@nexus/storage";
import { BRAND, NexusError } from "@nexus/shared";
import type { RouteModule } from "../server";
import { requireApp, requirePermission, isPrivateNetworkRequest } from "../auth";
import type { AppManager } from "../../services/apps";

export const APP_SESSION_COOKIE = "nexus_app_session";

/** Minimal, self-contained sign-in page for "Authorized users only" apps (served on the app's domain). */
function loginPage(appName: string, returnTo: string, error?: string): string {
  const esc = (s: string) =>
    s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in — ${esc(appName)}</title>
<style>
:root{color-scheme:light dark;--bg:#f6f7fb;--card:#fff;--fg:#1b1d29;--muted:#667;--accent:${BRAND.accentColor}}
@media (prefers-color-scheme:dark){:root{--bg:#0f1117;--card:#181b24;--fg:#e8e9f0;--muted:#99a}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,Segoe UI,sans-serif}
form{background:var(--card);padding:32px;border-radius:16px;width:min(360px,calc(100vw - 32px));box-shadow:0 8px 30px #0002}
h1{font-size:20px;margin:0 0 4px}p{color:var(--muted);margin:0 0 20px}
label{display:block;font-size:13px;margin:12px 0 4px}input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:10px;border:1px solid #8884;background:transparent;color:inherit;font:inherit}
button{margin-top:20px;width:100%;padding:11px;border:0;border-radius:10px;background:var(--accent);color:#fff;font-weight:600;font:inherit;cursor:pointer}
.err{color:#d33;margin-top:12px;font-size:14px}
</style></head><body><form method="post" action="/.nexus/login">
<h1>${esc(appName)}</h1><p>Sign in with your ${esc(BRAND.shortName)} account to continue.</p>
<input type="hidden" name="return" value="${esc(returnTo)}">
<label for="u">Username</label><input id="u" name="username" autocomplete="username" required autofocus>
<label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required>
<label for="c">Verification code (if you use two-step verification)</label><input id="c" name="code" inputmode="numeric" autocomplete="one-time-code">
<button type="submit">Sign in</button>${error ? `<div class="err">${esc(error)}</div>` : ""}
</form></body></html>`;
}

function safeReturn(v: unknown): string {
  const s = typeof v === "string" ? v : "/";
  return s.startsWith("/") && !s.startsWith("//") && !s.startsWith("/.nexus") ? s : "/";
}

export function appApiRoutes(apps: AppManager): RouteModule {
  return async (app, ctx) => {
    // ================= App-facing API (NEXUS_API_TOKEN) =================
    const storage = () => {
      if (!ctx.storage) throw NexusError.conflict("File storage isn't available.");
      return ctx.storage;
    };

    app.get("/api/v1/app/me", async (req) => {
      const p = requireApp(req);
      return { appId: p.appId, scopes: p.scopes };
    });

    /** POST /storage — raw body upload. Headers: X-File-Name, Content-Type; ?folder= */
    // Any file type can be uploaded; the body is streamed straight to storage.
    app.addContentTypeParser("*", (_req, payload, done) => done(null, payload));
    app.post("/api/v1/app/storage", async (req) => {
      const p = AppTokens.assert(requireApp(req), "storage:write");
      const name = decodeURIComponent(String(req.headers["x-file-name"] ?? ""));
      if (!name) throw NexusError.invalid("Send the file name in the X-File-Name header.");
      const folder = (req.query as { folder?: string }).folder;
      const contentType = String(req.headers["content-type"] ?? "application/octet-stream");
      const body =
        req.body instanceof Readable
          ? req.body
          : Readable.from([
              Buffer.isBuffer(req.body)
                ? req.body
                : Buffer.from(typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? "")),
            ]);
      return storage().put(
        p.appId,
        { name, contentType, ...(folder ? { folder } : {}), createdBy: `app:${p.appId}` },
        body,
      );
    });

    app.get("/api/v1/app/storage", async (req) => {
      const p = AppTokens.assert(requireApp(req), "storage:read");
      const q = z
        .object({
          folder: z.string().optional(),
          search: z.string().max(200).optional(),
          limit: z.coerce.number().int().max(1000).optional(),
        })
        .parse(req.query);
      return storage().list(p.appId, q);
    });

    app.get("/api/v1/app/storage/:id", async (req, reply) => {
      const p = AppTokens.assert(requireApp(req), "storage:read");
      const { object, stream } = storage().open(p.appId, (req.params as { id: string }).id);
      for (const [k, v] of Object.entries(downloadHeaders(object))) reply.header(k, v);
      return reply.send(stream);
    });

    app.delete("/api/v1/app/storage/:id", async (req) => {
      const p = AppTokens.assert(requireApp(req), "storage:write");
      storage().delete(p.appId, (req.params as { id: string }).id);
      return { ok: true };
    });

    /** Apps can read their own settings at runtime (they also receive them as environment variables). */
    app.get("/api/v1/app/secrets/:name", async (req) => {
      const p = AppTokens.assert(requireApp(req), "secrets:read");
      const name = (req.params as { name: string }).name;
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) throw NexusError.invalid("Invalid setting name.");
      const value = ctx.vault.get(`app:${p.appId}/env/${name}`);
      if (value === undefined) throw NexusError.notFound(`Setting ${name}`);
      return { name, value };
    });

    app.post("/api/v1/app/logs", async (req) => {
      const p = AppTokens.assert(requireApp(req), "logs:write");
      const { level, message } = z
        .object({ level: z.enum(["info", "warning", "error"]).default("info"), message: z.string().min(1).max(32_000) })
        .parse(req.body);
      const prefix = level === "error" ? "ERROR " : level === "warning" ? "WARNING " : "";
      ctx.logs.write(`app:${p.appId}`, level === "info" ? "stdout" : "stderr", `${prefix}${message}`);
      return { ok: true };
    });

    app.get("/api/v1/app/health", async (req) => {
      const p = AppTokens.assert(requireApp(req), "health:read");
      const a = apps.require(p.appId);
      const db =
        a.databaseId && ctx.databases
          ? await ctx.databases.testConnection(ctx.databases.connectionInfo(a.databaseId, p.appId))
          : null;
      return {
        status: apps.status(p.appId),
        database: db ? (db.ok ? "connected" : "unavailable") : "none",
        storage: ctx.storage ? "connected" : "unavailable",
      };
    });

    // ================= API keys for "API access only" apps =================
    app.get("/api/v1/apps/:id/api-keys", async (req) => {
      const { id } = req.params as { id: string };
      requirePermission(req, "app.access.configure", id);
      return ctx.appTokens.list(id).filter((t) => !t.label.startsWith("Automatic"));
    });

    app.post("/api/v1/apps/:id/api-keys", async (req) => {
      const { id } = req.params as { id: string };
      const user = requirePermission(req, "app.access.configure", id);
      apps.require(id);
      const { label } = z.object({ label: z.string().min(1).max(80) }).parse(req.body);
      const t = ctx.appTokens.issue(id, label, ["gateway:api"]);
      ctx.audit.record({
        actor: { type: "user", id: user.id, name: user.displayName },
        action: "app.api_key.create",
        target: { type: "app", id },
        details: { label },
      });
      // Shown once; only a hash is stored.
      return { id: t.id, label, key: t.token };
    });

    app.delete("/api/v1/apps/:id/api-keys/:keyId", async (req) => {
      const { id, keyId } = req.params as { id: string; keyId: string };
      const user = requirePermission(req, "app.access.configure", id);
      if (!ctx.appTokens.list(id).some((t) => t.id === keyId)) throw NexusError.notFound("API key");
      ctx.appTokens.revoke(keyId);
      ctx.audit.record({
        actor: { type: "user", id: user.id, name: user.displayName },
        action: "app.api_key.revoke",
        target: { type: "app", id },
      });
      return { ok: true };
    });

    // ================= Gateway authorization (called by the gateway, loopback only) =================
    app.get("/api/v1/gateway/authorize", async (req, reply) => {
      const socket = req.socket.remoteAddress ?? "";
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(socket)) throw NexusError.forbidden();
      const { app: appId, mode } = z.object({ app: z.string(), mode: z.enum(["user", "api"]) }).parse(req.query);
      if (mode === "api") {
        const header =
          req.headers["x-api-key"] ??
          (req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : undefined);
        const principal = ctx.appTokens.verify(Array.isArray(header) ? header[0] : header);
        if (!principal || principal.appId !== appId || !principal.scopes.includes("gateway:api")) {
          return reply
            .status(401)
            .header("WWW-Authenticate", 'Bearer realm="api"')
            .send({ error: "A valid API key is required." });
        }
        reply.header("X-Nexus-Client", principal.label);
        return reply.status(200).send();
      }
      const token = req.cookies[APP_SESSION_COOKIE];
      const v = token ? ctx.users.validateSession(token) : null;
      if (v?.session.audience === "application" && authorize(v.user, "app.use", appId)) {
        reply.header("X-Nexus-User", v.user.username).header("X-Nexus-User-Id", v.user.id);
        return reply.status(200).send();
      }
      const original = String(req.headers["x-forwarded-uri"] ?? "/");
      return reply.redirect(`/.nexus/login?return=${encodeURIComponent(safeReturn(original))}`, 302);
    });

    // Sign-in pages on the application's own domain (proxied by the gateway).
    await app.register(async (sub) => {
      sub.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) =>
        done(null, Object.fromEntries(new URLSearchParams(String(body)))),
      );
      const appForHost = (host: string | undefined) =>
        apps
          .list()
          .find(
            (a) => a.accessMode === "authorized" && a.publicHosts.includes((host ?? "").split(":")[0]!.toLowerCase()),
          );

      sub.get("/.nexus/login", async (req, reply) => {
        const a = appForHost((req.headers["x-forwarded-host"] as string) ?? req.headers.host);
        if (!a) return reply.status(404).send("Not found");
        return reply
          .type("text/html")
          .header("Cache-Control", "no-store")
          .send(loginPage(a.name, safeReturn((req.query as { return?: string }).return)));
      });

      sub.post("/.nexus/login", async (req, reply) => {
        const a = appForHost((req.headers["x-forwarded-host"] as string) ?? req.headers.host);
        if (!a) return reply.status(404).send("Not found");
        const body = (req.body ?? {}) as Record<string, string>;
        const back = safeReturn(body.return);
        const fail = (msg: string) =>
          reply
            .status(401)
            .type("text/html")
            .send(loginPage(a.name, back, msg));
        const gate = ctx.guard.check(body.username ?? "", req.clientIp);
        if (!gate.allowed) return fail("Too many attempts. Please wait a few minutes.");
        const result = await ctx.users.verifyCredentials(body.username ?? "", body.password ?? "");
        let userId: string | null = result.status === "ok" ? result.user.id : null;
        const mfaVerified = result.status === "mfa_required";
        if (result.status === "mfa_required")
          userId = ctx.users.completeMfa(result.userId, body.code ?? "").status === "ok" ? result.userId : null;
        if (!userId) {
          ctx.guard.recordFailure(body.username ?? "", req.clientIp);
          return fail(
            result.status === "mfa_required"
              ? "Enter the current code from your authenticator app."
              : "That username and password don't match.",
          );
        }
        const user = ctx.users.require(userId);
        if (!authorize(user, "app.use", a.id))
          return fail(`Your account doesn't have access to ${a.name}. Ask the owner to add you.`);
        ctx.guard.recordSuccess({
          userId,
          username: user.username,
          ip: req.clientIp,
          userAgent: String(req.headers["user-agent"] ?? ""),
          remote: true,
        });
        const s = ctx.users.createSession(userId, {
          method: mfaVerified ? "mfa" : "password",
          audience: "application",
          ip: req.clientIp,
          remote: true,
        });
        reply.setCookie(APP_SESSION_COOKIE, s.token, {
          path: "/",
          httpOnly: true,
          secure: !isPrivateNetworkRequest(ctx, req),
          sameSite: "lax",
          expires: new Date(s.expiresAt),
        });
        ctx.audit.record({
          actor: { type: "user", id: userId, name: user.displayName },
          action: "app.signin",
          target: { type: "app", id: a.id },
          ip: req.clientIp,
        });
        return reply.redirect(back, 303);
      });

      sub.get("/.nexus/logout", async (req, reply) => {
        const t = req.cookies[APP_SESSION_COOKIE];
        if (t) ctx.users.revokeSession(t);
        reply.clearCookie(APP_SESSION_COOKIE, { path: "/" });
        return reply.redirect("/.nexus/login", 302);
      });
    });
  };
}
