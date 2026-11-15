import { existsSync } from "node:fs";
import { join } from "node:path";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { isLoopback, RateLimiter } from "@nexus/security";
import { isNexusError, NexusError } from "@nexus/shared";
import type { NexusContext } from "../context";
import {
  clientIp,
  CSRF_HEADER,
  isPrivateNetworkRequest,
  isRemoteRequest,
  requireRemoteAdminRequest,
  resolvePrincipal,
  SESSION_COOKIE,
  setSessionCookie,
} from "./auth";

export type RouteModule = (app: FastifyInstance, ctx: NexusContext) => void | Promise<void>;

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** Endpoints that may be called without a session (they authenticate on their own). */
/** Reachable without a session. Webhooks carry their own per-pipeline secret instead. */
const PUBLIC = [
  /^\/api\/v1\/health$/,
  /^\/api\/v1\/auth\/(local|login|mfa)$/,
  /^\/api\/v1\/gateway\//,
  /^\/\.nexus\//,
  /^\/api\/v1\/hooks\//,
];
/** Called by other systems, never by a browser session, so the CSRF header doesn't apply. */
const CSRF_EXEMPT = [/^\/api\/v1\/hooks\//];
/** Public application authorization and pipeline webhooks are not control-center traffic. */
const REMOTE_NON_MANAGEMENT = [/^\/api\/v1\/gateway\//, /^\/api\/v1\/hooks\//];

export async function buildServer(
  ctx: NexusContext,
  routes: RouteModule[],
  opts: { logger?: boolean } = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 10 * 1024 * 1024, trustProxy: false });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 5 * 1024 ** 3, files: 20 } });

  const publicLimiter = new RateLimiter(600, 100);
  const userLimiter = new RateLimiter(1200, 200);
  const appLimiter = new RateLimiter(1200, 200);
  let capacityForApps = -1;
  app.decorateRequest("principal", null);
  app.decorateRequest("remote", false);
  app.decorateRequest("clientIp", "");

  app.addHook("onRequest", async (req, reply) => {
    req.remote = isRemoteRequest(req);
    req.clientIp = clientIp(req);
    const path = req.url.split("?")[0]!;
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Frame-Options", "SAMEORIGIN");
    // A hostile site resolving to loopback must not become a local management origin.
    // App sign-in pages have their own public host and are checked separately below.
    if (!req.remote && !path.startsWith("/.nexus/")) {
      let hostname = "";
      try { hostname = new URL(`http://${req.headers.host ?? ""}`).hostname.replace(/^\[|\]$/g, ""); } catch { /* refused below */ }
      if (hostname !== "localhost" && !isLoopback(hostname)) throw NexusError.forbidden("Use the local Nexus address to open the control center.");
    }
    if (!path.startsWith("/api/") && !path.startsWith("/.nexus/")) return; // static UI
    reply.header("Cache-Control", "no-store");

    // Authenticate before choosing a bucket so apps behind the same gateway do not
    // share one cap. Published application traffic never passes through this API,
    // apart from its authorization check, which uses the public abuse limit.
    req.principal = resolvePrincipal(ctx, req);
    const count = Math.max(1, ctx.appPidsProvider().length);
    if (count !== capacityForApps) {
      userLimiter.configure(Math.max(1200, count * 240), Math.max(200, count * 40));
      capacityForApps = count;
    }
    const rl = path === "/api/v1/gateway/authorize"
      ? { allowed: true, retryAfterMs: 0 }
      : req.principal?.kind === "user"
      ? userLimiter.take(req.principal.user.id)
      : req.principal?.kind === "app"
        ? appLimiter.take(req.principal.app.appId)
        : publicLimiter.take(req.clientIp);
    if (!rl.allowed) {
      reply.header("Retry-After", Math.ceil(rl.retryAfterMs / 1000));
      throw new NexusError("rate_limited", "Too many requests. Please wait a moment.");
    }
    if (
      req.remote &&
      path.startsWith("/api/v1/") &&
      req.principal?.kind !== "app" &&
      !REMOTE_NON_MANAGEMENT.some((re) => re.test(path))
    ) {
      requireRemoteAdminRequest(ctx, req);
    }
    // CSRF: cookie-authenticated changes must carry a header browsers won't send cross-site.
    // The sign-in form on an app's own domain (/.nexus/*) is a plain HTML form, so it is
    // protected by requiring a same-origin Origin header instead.
    if (MUTATING.has(req.method) && req.principal?.kind !== "app" && !CSRF_EXEMPT.some((re) => re.test(path))) {
      if (path.startsWith("/.nexus/")) {
        const origin = req.headers.origin;
        const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "");
        let sameOrigin = false;
        try {
          const parsed = new URL(origin ?? "");
          sameOrigin = ["http:", "https:"].includes(parsed.protocol) && parsed.host === host && !parsed.username && !parsed.password;
        } catch { /* malformed or absent origins fail closed */ }
        if (!sameOrigin) throw NexusError.forbidden("Cross-site sign-in is not allowed.");
      } else if (req.headers[CSRF_HEADER] !== "1") {
        throw NexusError.forbidden("This request is missing its security header.");
      } else if (req.headers["sec-fetch-site"] === "cross-site") {
        throw NexusError.forbidden("Cross-site requests are not allowed.");
      }
    }
    if (!req.principal && !PUBLIC.some((re) => re.test(path))) throw NexusError.unauthorized();
  });

  // Upgrade cookies issued by older releases and continually preserve the browser side of
  // a valid management session. Explicit logout and other cookie-writing responses win.
  app.addHook("onSend", async (req, reply, payload) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token && req.principal?.kind === "user" && !reply.hasHeader("set-cookie")) {
      setSessionCookie(reply, token, req.principal.session.expiresAt, req.remote && !isPrivateNetworkRequest(ctx, req));
    }
    return payload;
  });

  app.setErrorHandler((err, req, reply) => {
    if (isNexusError(err)) {
      if (err.httpStatus >= 500) ctx.log.error("request failed", { url: req.url, err });
      return reply
        .status(err.httpStatus)
        .send({ error: { code: err.code, message: err.message, problem: err.problem ?? null } });
    }
    if (err instanceof ZodError) {
      const first = err.issues[0];
      return reply.status(400).send({
        error: {
          code: "invalid_input",
          message: first ? `${first.path.join(".") || "Request"}: ${first.message}` : "Invalid request.",
          problem: null,
        },
      });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500)
      return reply
        .status(status)
        .send({ error: { code: "invalid_input", message: (err as Error).message, problem: null } });
    ctx.log.error("unexpected error", { url: req.url, err: err as Error });
    return reply.status(500).send({
      error: {
        code: "internal",
        message: "Something went wrong inside Nexus. The details were logged.",
        problem: null,
      },
    });
  });

  for (const r of routes) await r(app, ctx);

  // Control center UI (single-page app) — served for every non-API GET.
  const ui = ctx.opts.paths.uiDir;
  if (ui && existsSync(join(ui, "index.html"))) {
    // Wildcard serving picks up new files after a UI update without restarting the service.
    await app.register(fastifyStatic, { root: ui, prefix: "/", wildcard: true, index: false });
    app.get("/", (_req, reply) => reply.type("text/html").header("Cache-Control", "no-cache").sendFile("index.html"));
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api/"))
        return reply.type("text/html").header("Cache-Control", "no-cache").sendFile("index.html");
      return reply.status(404).send({ error: { code: "not_found", message: "Not found.", problem: null } });
    });
  } else {
    app.setNotFoundHandler((_req, reply) =>
      reply.status(404).send({ error: { code: "not_found", message: "Not found.", problem: null } }),
    );
  }
  return app;
}
