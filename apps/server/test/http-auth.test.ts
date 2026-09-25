import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { base32Decode, totpCode } from "@nexus/security";
import type { NexusContext } from "../src/context";
import { buildServer } from "../src/http/server";
import { authRoutes } from "../src/http/routes/auth";
import { requireApp } from "../src/http/auth";
import { createContext, tempHome } from "./helpers";

const STRONG = "correct horse battery staple";
const REMOTE = {
  "x-forwarded-for": "203.0.113.50",
  "x-nexus-remote": "1",
  "x-nexus-remote-host": "server.example.com",
};
const CSRF = { "x-nexus-request": "1" };

let ctx: NexusContext;
let app: FastifyInstance;
let dispose: () => void;

beforeAll(async () => {
  const t = tempHome();
  dispose = t.dispose;
  ctx = await createContext(t.home);
  app = await buildServer(ctx, [
    authRoutes,
    (a) => {
      a.post("/api/v1/test/echo", async () => ({ ok: true }));
      a.get("/api/v1/test/app-only", async (req) => ({ appId: requireApp(req).appId }));
    },
  ]);
});
afterAll(async () => {
  await app.close();
  await ctx.shutdown();
  dispose();
});

const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers["set-cookie"]).split(";")[0]!;

async function localLogin(): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/local",
    headers: CSRF,
    payload: { token: ctx.localToken },
  });
  expect(res.statusCode).toBe(200);
  return cookieOf(res);
}

describe("HTTP security", () => {
  it("health is public; everything else needs a session", async () => {
    expect((await app.inject({ url: "/api/v1/health" })).json()).toMatchObject({ status: "ok", setupCompleted: false });
    const res = await app.inject({ url: "/api/v1/auth/me" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatchObject({ code: "unauthorized", message: "Please sign in." });
  });

  it("desktop signs in with the local token; cookie is HttpOnly + SameSite=Strict", async () => {
    const bad = await app.inject({
      method: "POST",
      url: "/api/v1/auth/local",
      headers: CSRF,
      payload: { token: "wrong-token-value" },
    });
    expect(bad.statusCode).toBe(401);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/local",
      headers: CSRF,
      payload: { token: ctx.localToken },
    });
    const setCookie = String(res.headers["set-cookie"]);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    const me = await app.inject({ url: "/api/v1/auth/me", headers: { cookie: cookieOf(res) } });
    expect(me.json()).toMatchObject({ user: { role: "owner" }, remote: false });
    expect(me.json().permissions).toContain("server.recovery_key");
  });

  it("the local token never works from outside", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/local",
      headers: { ...CSRF, ...REMOTE },
      payload: { token: ctx.localToken },
    });
    expect(res.statusCode).toBe(403);
  });

  it("requires the CSRF header for changes made with a cookie", async () => {
    const cookie = await localLogin();
    expect((await app.inject({ method: "POST", url: "/api/v1/test/echo", headers: { cookie } })).statusCode).toBe(403);
    expect(
      (await app.inject({ method: "POST", url: "/api/v1/test/echo", headers: { cookie, ...CSRF } })).statusCode,
    ).toBe(200);
  });

  it("local sessions can't be replayed through the gateway", async () => {
    const cookie = await localLogin();
    const res = await app.inject({ url: "/api/v1/auth/me", headers: { cookie, ...REMOTE } });
    expect(res.statusCode).toBe(403); // remote management off
  });

  it("password sign-in with brute-force lockout", async () => {
    await ctx.users.createUser({ username: "operator1", displayName: "Op One", role: "operator", password: STRONG });
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: CSRF,
        payload: { username: "operator1", password: "wrong password!!" },
      });
      expect(r.statusCode).toBe(401);
    }
    const locked = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: CSRF,
      payload: { username: "operator1", password: STRONG },
    });
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.message).toMatch(/paused for this account/);
    ctx.guard.unlock("user:operator1");
    const ok = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: CSRF,
      payload: { username: "operator1", password: STRONG },
    });
    expect(ok.statusCode).toBe(200);
    expect(ctx.audit.query({ action: "auth.login", outcome: "denied" }).length).toBeGreaterThanOrEqual(5);
  });

  it("remote administration: off by default, then password + mandatory MFA", async () => {
    const admin = await ctx.users.createUser({
      username: "remoteadmin",
      displayName: "Remote Admin",
      role: "administrator",
      password: STRONG,
    });
    const login = () =>
      app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: { ...CSRF, ...REMOTE },
        payload: { username: "remoteadmin", password: STRONG },
      });

    ctx.settings.set("remoteAdmin", { enabled: true, publicHost: "server.example.com" });
    const wrongHost = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { ...CSRF, ...REMOTE, "x-nexus-remote-host": "other.example.com" },
      payload: { username: "remoteadmin", password: STRONG },
    });
    expect(wrongHost.statusCode).toBe(403);
    const noMfa = await login();
    expect(noMfa.statusCode).toBe(403);
    expect(noMfa.json().error.message).toMatch(/Two-step verification/);

    const { secret } = ctx.users.beginMfaEnrollment(admin.id, "Nexus");
    ctx.users.confirmMfaEnrollment(admin.id, totpCode(base32Decode(secret), Date.now()));
    const step1 = await login();
    expect(step1.json()).toMatchObject({ mfaRequired: true });
    await new Promise((r) => setTimeout(r, 10));
    const step2 = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa",
      headers: { ...CSRF, ...REMOTE },
      payload: { pendingToken: step1.json().pendingToken, code: totpCode(base32Decode(secret), Date.now() + 30_000) },
    });
    expect(step2.statusCode).toBe(200);
    const cookie = cookieOf(step2);
    expect(String(step2.headers["set-cookie"])).toMatch(/Secure/);
    const me = await app.inject({ url: "/api/v1/auth/me", headers: { cookie, ...REMOTE } });
    expect(me.json()).toMatchObject({ remote: true, user: { username: "remoteadmin" } });
    // A remote session is useless locally (and vice versa).
    expect((await app.inject({ url: "/api/v1/auth/me", headers: { cookie } })).statusCode).toBe(401);

    // Even if one were created accidentally, a password-only session is never remote-admin capable.
    const passwordOnly = ctx.users.createSession(admin.id, {
      method: "password",
      audience: "management",
      remote: true,
    });
    expect(
      (
        await app.inject({
          url: "/api/v1/auth/me",
          headers: { cookie: `nexus_session=${passwordOnly.token}`, ...REMOTE },
        })
      ).statusCode,
    ).toBe(401);

    ctx.settings.set("remoteAdmin", { enabled: false, publicHost: null });
    expect((await app.inject({ url: "/api/v1/auth/me", headers: { cookie, ...REMOTE } })).statusCode).toBe(403);
  });

  it("invalidates pending remote MFA after a settings change and limits code attempts", async () => {
    const changing = await ctx.users.createUser({
      username: "changingmfa",
      displayName: "Changing MFA",
      role: "viewer",
      password: STRONG,
    });
    const changingSecret = ctx.users.beginMfaEnrollment(changing.id, "Nexus").secret;
    ctx.users.confirmMfaEnrollment(changing.id, totpCode(base32Decode(changingSecret), Date.now()));
    const remoteA = { ...REMOTE, "x-forwarded-for": "203.0.113.51" };
    ctx.settings.set("remoteAdmin", { enabled: true, publicHost: "server.example.com", authRevision: "first" });
    const pending = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { ...CSRF, ...remoteA },
      payload: { username: changing.username, password: STRONG },
    });
    expect(pending.json()).toMatchObject({ mfaRequired: true });
    ctx.settings.set("remoteAdmin", { enabled: true, publicHost: "server.example.com", authRevision: "second" });
    const stale = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa",
      headers: { ...CSRF, ...remoteA },
      payload: { pendingToken: pending.json().pendingToken, code: totpCode(base32Decode(changingSecret), Date.now()) },
    });
    expect(stale.statusCode).toBe(401);
    expect(stale.json().error.message).toMatch(/sign in again/i);

    const limited = await ctx.users.createUser({
      username: "limitedmfa",
      displayName: "Limited MFA",
      role: "viewer",
      password: STRONG,
    });
    const limitedSecret = ctx.users.beginMfaEnrollment(limited.id, "Nexus").secret;
    ctx.users.confirmMfaEnrollment(limited.id, totpCode(base32Decode(limitedSecret), Date.now()));
    const remoteB = { ...REMOTE, "x-forwarded-for": "203.0.113.52" };
    const step1 = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { ...CSRF, ...remoteB },
      payload: { username: limited.username, password: STRONG },
    });
    const correct = totpCode(base32Decode(limitedSecret), Date.now());
    const wrong = correct === "000000" ? "111111" : "000000";
    for (let attempt = 0; attempt < 5; attempt++) {
      const denied = await app.inject({
        method: "POST",
        url: "/api/v1/auth/mfa",
        headers: { ...CSRF, ...remoteB },
        payload: { pendingToken: step1.json().pendingToken, code: wrong },
      });
      expect(denied.statusCode).toBe(401);
    }
    const exhausted = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa",
      headers: { ...CSRF, ...remoteB },
      payload: { pendingToken: step1.json().pendingToken, code: correct },
    });
    expect(exhausted.statusCode).toBe(401);
    expect(
      ctx.audit.query({ action: "auth.mfa", outcome: "denied" }).filter((entry) => entry.actorId === limited.id),
    ).toHaveLength(5);
    ctx.settings.set("remoteAdmin", { enabled: false, publicHost: null, authRevision: "off" });
  });

  it("applications authenticate with their own bearer token (no CSRF needed)", async () => {
    const { token } = ctx.appTokens.issue("taxiops", "Automatic");
    const res = await app.inject({ url: "/api/v1/test/app-only", headers: { authorization: `Bearer ${token}` } });
    expect(res.json()).toEqual({ appId: "taxiops" });
    const post = await app.inject({
      method: "POST",
      url: "/api/v1/test/echo",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(post.statusCode).toBe(200);
    expect(
      (await app.inject({ url: "/api/v1/test/app-only", headers: { authorization: "Bearer nxs_forged" } })).statusCode,
    ).toBe(401);
  });

  it("returns friendly JSON for validation errors and unknown routes", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: CSRF,
      payload: { username: "" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_input");
    const cookie = await localLogin();
    expect((await app.inject({ url: "/api/v1/nope", headers: { cookie } })).statusCode).toBe(404);
  });
});
