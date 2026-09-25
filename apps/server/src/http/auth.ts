import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { authorize, isLoopback, type AppPrincipal, type Permission, type Session, type User } from "@nexus/security";
import { NexusError } from "@nexus/shared";
import type { NexusContext } from "../context";

export const SESSION_COOKIE = "nexus_session";
export const CSRF_HEADER = "x-nexus-request";

export type Principal = { kind: "user"; user: User; session: Session } | { kind: "app"; app: AppPrincipal };

declare module "fastify" {
  interface FastifyRequest {
    principal: Principal | null;
    /** True when the request came through the gateway / from another computer. */
    remote: boolean;
    clientIp: string;
  }
}

/** Remote = not from this computer, or relayed by the gateway (which always adds forwarding headers). */
export function isRemoteRequest(req: FastifyRequest): boolean {
  const socketIp = req.socket.remoteAddress ?? "";
  return !isLoopback(socketIp) || !!req.headers["x-nexus-remote"] || !!req.headers["x-forwarded-for"];
}

export function clientIp(req: FastifyRequest): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
  // Only trust forwarding headers when the connection itself is local (i.e. from our gateway).
  return first && isLoopback(req.socket.remoteAddress ?? "") ? first : (req.socket.remoteAddress ?? "unknown");
}

export interface RemoteAdminSettings {
  enabled: boolean;
  publicHost: string | null;
  /** Rotated whenever remote administration is changed, invalidating pending sign-ins. */
  authRevision?: string;
}

const firstHeader = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? "") : (value ?? "");

function hostname(value: string): string | null {
  const input = value.trim();
  if (!/^[a-z0-9.-]+(?::\d{1,5})?$/i.test(input)) return null;
  try {
    return new URL(`https://${input}`).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

/**
 * A request from a device on Nexus's private network (WireGuard), relayed by the local gateway.
 * The gateway adds a secret marker that nobody outside can know; anything else is not trusted.
 */
export function isPrivateNetworkRequest(ctx: NexusContext, req: FastifyRequest): boolean {
  if (!isLoopback(req.socket.remoteAddress ?? "")) return false;
  if (!ctx.settings.get<{ enabled?: boolean }>("privateNetwork", {}).enabled) return false;
  const marker = ctx.vault.get("system/private-network/marker");
  const got = firstHeader(req.headers["x-nexus-private-network"]);
  return !!marker && got.length === marker.length && timingSafeEqual(Buffer.from(got), Buffer.from(marker));
}

/**
 * Remote control-center traffic is accepted only from Nexus's loopback gateway and only
 * for the hostname the Owner explicitly enabled. The gateway overwrites both marker headers.
 */
export function requireRemoteAdminRequest(ctx: NexusContext, req: FastifyRequest): RemoteAdminSettings {
  if (isPrivateNetworkRequest(ctx, req)) {
    // Devices the Owner added to the private network; sign-in still needs two-step verification.
    const pn = ctx.settings.get<{ authRevision?: string }>("privateNetwork", {});
    return { enabled: true, publicHost: null, authRevision: `private-network:${pn.authRevision ?? "0"}` };
  }
  const settings = ctx.settings.get<RemoteAdminSettings>("remoteAdmin", { enabled: false, publicHost: null });
  if (!settings.enabled || !settings.publicHost) throw NexusError.forbidden("Remote management is turned off.");
  const throughGateway =
    isLoopback(req.socket.remoteAddress ?? "") && firstHeader(req.headers["x-nexus-remote"]) === "1";
  if (!throughGateway)
    throw NexusError.forbidden("Remote management is only available through the secure Nexus gateway.");
  const requestedHost = hostname(firstHeader(req.headers["x-nexus-remote-host"]));
  if (requestedHost !== settings.publicHost.toLowerCase()) {
    throw NexusError.forbidden(`Open remote management at ${settings.publicHost}.`);
  }
  return settings;
}

/** Resolves who is calling. Never throws; authorization happens per route. */
export function resolvePrincipal(ctx: NexusContext, req: FastifyRequest): Principal | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer nxs_")) {
    const app = ctx.appTokens.verify(auth.slice(7).trim());
    return app ? { kind: "app", app } : null;
  }
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  const v = ctx.users.validateSession(token);
  if (!v) return null;
  if (v.session.audience !== "management") return null;
  // A session created locally cannot be replayed from outside, and vice versa.
  if (v.session.remote !== req.remote) return null;
  if (req.remote) {
    const ra = ctx.settings.get<RemoteAdminSettings>("remoteAdmin", { enabled: false, publicHost: null });
    if (!ra.enabled && !isPrivateNetworkRequest(ctx, req)) return null;
    // Defense in depth: a password-only session can never become a remote admin session.
    if (v.session.method !== "mfa") return null;
  }
  return { kind: "user", user: v.user, session: v.session };
}

export function requireUser(req: FastifyRequest): { user: User; session: Session } {
  const p = req.principal;
  if (!p || p.kind !== "user") throw NexusError.unauthorized();
  return p;
}

export function requirePermission(req: FastifyRequest, permission: Permission, appId?: string): User {
  const { user } = requireUser(req);
  if (!authorize(user, permission, appId)) throw NexusError.forbidden();
  return user;
}

export function requireApp(req: FastifyRequest): AppPrincipal {
  const p = req.principal;
  if (!p || p.kind !== "app") throw NexusError.unauthorized("A valid application credential is required.");
  return p.app;
}

export function setSessionCookie(reply: FastifyReply, token: string, expiresAt: number, secure: boolean): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "strict",
    secure,
    expires: new Date(expiresAt),
  });
}
