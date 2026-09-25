import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { constantTimeEqual, permissionsFor, RateLimiter } from "@nexus/security";
import { BRAND, NexusError, randomToken } from "@nexus/shared";
import type { RouteModule } from "../server";
import { requireRemoteAdminRequest, requireUser, SESSION_COOKIE, setSessionCookie, isPrivateNetworkRequest } from "../auth";

const MFA_TTL_MS = 5 * 60_000;

/**
 * Sign-in:
 *  - Local: the desktop app proves it runs on this computer with the local token file.
 *  - Password (+ TOTP): for other users and for remote administration (MFA is mandatory remotely).
 */
export const authRoutes: RouteModule = (app, ctx) => {
  const loginLimiter = new RateLimiter(10, 10 / 60); // 10 attempts, refilling 10/min per IP
  const pendingMfa = new Map<
    string,
    { userId: string; expires: number; remote: boolean; remoteRevision: string | null; attempts: number }
  >();

  const discardExpiredChallenges = () => {
    const now = Date.now();
    for (const [token, pending] of pendingMfa) if (pending.expires < now) pendingMfa.delete(token);
  };

  app.get("/api/v1/health", async () => ({
    status: "ok",
    product: BRAND.productName,
    setupCompleted: ctx.setupCompleted,
  }));

  app.post("/api/v1/auth/local", async (req, reply) => {
    const { token } = z.object({ token: z.string().min(10) }).parse(req.body);
    if (req.remote) throw NexusError.forbidden("Local sign-in only works on this computer.");
    if (!constantTimeEqual(token, ctx.localToken)) {
      ctx.audit.record({
        actor: { type: "user", name: "local" },
        action: "auth.local",
        outcome: "denied",
        ip: req.clientIp,
      });
      throw NexusError.unauthorized("This sign-in link is no longer valid. Open Nexus again from the Start menu.");
    }
    const owner = ctx.users.list().find((u) => u.role === "owner")!;
    const s = ctx.users.createSession(owner.id, {
      method: "local_trust",
      ip: req.clientIp,
      userAgent: req.headers["user-agent"] ?? "",
      remote: false,
    });
    setSessionCookie(reply, s.token, s.expiresAt, false);
    ctx.audit.record({
      actor: { type: "user", id: owner.id, name: owner.displayName },
      action: "auth.local",
      ip: req.clientIp,
    });
    return { ok: true };
  });

  app.post("/api/v1/auth/login", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const body = z
      .object({ username: z.string().min(1).max(64), password: z.string().min(1).max(256) })
      .parse(req.body);
    discardExpiredChallenges();
    const remoteRevision = req.remote ? (requireRemoteAdminRequest(ctx, req).authRevision ?? null) : null;
    const rl = loginLimiter.take(req.clientIp);
    if (!rl.allowed) throw new NexusError("rate_limited", "Too many sign-in attempts. Please wait a minute.");
    const gate = ctx.guard.check(body.username, req.clientIp);
    if (!gate.allowed) {
      throw new NexusError(
        "rate_limited",
        `Sign-in is paused for this account after several failed attempts. Try again in ${Math.ceil(gate.retryAfterMs / 60_000)} minutes.`,
      );
    }
    const result = await ctx.users.verifyCredentials(body.username, body.password);
    if (result.status === "invalid") {
      ctx.guard.recordFailure(body.username, req.clientIp);
      ctx.audit.record({
        actor: { type: "user", name: body.username },
        action: "auth.login",
        outcome: "denied",
        ip: req.clientIp,
      });
      throw NexusError.unauthorized("That username and password don't match.");
    }
    const userId = result.status === "ok" ? result.user.id : result.userId;
    const user = ctx.users.require(userId);
    if (req.remote && !user.mfaEnabled) {
      throw NexusError.forbidden("Two-step verification must be set up on this computer before signing in remotely.");
    }
    if (result.status === "mfa_required") {
      const pending = randomToken(24);
      pendingMfa.set(pending, {
        userId,
        expires: Date.now() + MFA_TTL_MS,
        remote: req.remote,
        remoteRevision,
        attempts: 0,
      });
      return { mfaRequired: true, pendingToken: pending };
    }
    return finishLogin(userId, req, reply);
  });

  app.post("/api/v1/auth/mfa", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const body = z.object({ pendingToken: z.string(), code: z.string().min(6).max(20) }).parse(req.body);
    const rl = loginLimiter.take(req.clientIp);
    if (!rl.allowed) throw new NexusError("rate_limited", "Too many sign-in attempts. Please wait a minute.");
    const p = pendingMfa.get(body.pendingToken);
    const remoteRevision = req.remote ? (requireRemoteAdminRequest(ctx, req).authRevision ?? null) : null;
    if (!p || p.expires < Date.now() || p.remote !== req.remote || p.remoteRevision !== remoteRevision) {
      if (p) pendingMfa.delete(body.pendingToken);
      throw NexusError.unauthorized("Please sign in again.");
    }
    const user = ctx.users.require(p.userId);
    const gate = ctx.guard.check(user.username, req.clientIp);
    if (!gate.allowed) {
      pendingMfa.delete(body.pendingToken);
      throw new NexusError(
        "rate_limited",
        `Sign-in is paused for this account. Try again in ${Math.ceil(gate.retryAfterMs / 60_000)} minutes.`,
      );
    }
    const r = ctx.users.completeMfa(p.userId, body.code);
    if (r.status !== "ok") {
      p.attempts += 1;
      ctx.guard.recordFailure(user.username, req.clientIp);
      ctx.audit.record({
        actor: { type: "user", id: user.id, name: user.displayName },
        action: "auth.mfa",
        outcome: "denied",
        ip: req.clientIp,
      });
      if (p.attempts >= 5) pendingMfa.delete(body.pendingToken);
      throw NexusError.unauthorized("That code didn't work. Codes change every 30 seconds.");
    }
    pendingMfa.delete(body.pendingToken);
    return finishLogin(p.userId, req, reply, true);
  });

  function finishLogin(userId: string, req: FastifyRequest, reply: FastifyReply, mfaVerified = false) {
    const user = ctx.users.require(userId);
    const risk = ctx.guard.recordSuccess({
      userId,
      username: user.username,
      ip: req.clientIp,
      userAgent: req.headers["user-agent"] ?? "",
      remote: req.remote,
    });
    const s = ctx.users.createSession(userId, {
      method: mfaVerified ? "mfa" : "password",
      audience: "management",
      ip: req.clientIp,
      userAgent: req.headers["user-agent"] ?? "",
      remote: req.remote,
    });
    // Through the private network the connection is already encrypted by WireGuard (plain http there).
    setSessionCookie(reply, s.token, s.expiresAt, req.remote && !isPrivateNetworkRequest(ctx, req));
    ctx.audit.record({
      actor: { type: "user", id: userId, name: user.displayName },
      action: "auth.login",
      ip: req.clientIp,
      details: { remote: req.remote, risk: risk.level },
    });
    if (risk.level !== "none")
      ctx.activity.add("warning", `Unusual sign-in for ${user.displayName}: ${risk.signals.join("; ")}`);
    return { ok: true };
  }

  app.post("/api/v1/auth/logout", async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) ctx.users.revokeSession(token);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/v1/auth/me", async (req) => {
    const { user, session } = requireUser(req);
    return {
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        mfaEnabled: user.mfaEnabled,
        appRoles: user.appRoles,
      },
      permissions: permissionsFor(user),
      remote: session.remote,
      setupCompleted: ctx.setupCompleted,
    };
  });
};
