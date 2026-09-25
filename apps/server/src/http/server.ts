import { existsSync } from "node:fs";
import { join } from "node:path";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { RateLimiter } from "@nexus/security";
import { isNexusError, NexusError } from "@nexus/shared";
import type { NexusContext } from "../context";
import { clientIp, CSRF_HEADER, isRemoteRequest, requireRemoteAdminRequest, resolvePrincipal } from "./auth";

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

  const apiLimiter = new RateLimiter(600, 10); // bursts of 600, 10 req/s sustained per client
  app.decorateRequest("principal", null);
  app.decorateRequest("remote", false);
  app.decorateRequest("clientIp", "");

  app.addHook("onRequest", async (req, reply) => {
    req.remote = isRemoteRequest(req);
    req.clientIp = clientIp(req);
    req.principal = resolvePrincipal(ctx, req);
    const path = req.url.split("?")[0]!;
    if (!path.startsWith("/api/") && !path.startsWith("/.nexus/")) return; // static UI

    const rl = apiLimiter.take(`${req.clientIp}`);
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
        if (origin && new URL(origin).host !== host) throw NexusError.forbidden("Cross-site sign-in is not allowed.");
      } else if (req.headers[CSRF_HEADER] !== "1") {
        throw NexusError.forbidden("This request is missing its security header.");
      }
    }
    if (!req.principal && !PUBLIC.some((re) => re.test(path))) throw NexusError.unauthorized();
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
