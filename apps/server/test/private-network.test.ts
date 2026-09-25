import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { base32Decode, totpCode } from "@nexus/security";
import type { NexusContext } from "../src/context";
import { authRoutes } from "../src/http/routes/auth";
import { privateNetworkRoutes } from "../src/http/routes/private-network";
import { buildServer } from "../src/http/server";
import { AppManager } from "../src/services/apps";
import { GatewayService } from "../src/services/gateway";
import { PrivateNetworkService } from "../src/services/private-network";
import { createContext, tempHome } from "./helpers";
import { ownerClient } from "./helpers-http";

const STRONG = "correct horse battery staple";
const CSRF = { "x-nexus-request": "1" };
const MARKER = "0123456789abcdefghijklmnopqrstuv";
/** What the gateway adds for a device on the private network. */
const THROUGH_PN = { "x-forwarded-for": "10.73.0.2", "x-nexus-remote": "1", "x-nexus-private-network": MARKER };

let ctx: NexusContext;
let app: FastifyInstance;
let dispose: () => void;
let gateway: GatewayService;
const savedPf = process.env.ProgramFiles;

beforeAll(async () => {
  const t = tempHome();
  dispose = t.dispose;
  ctx = await createContext(t.home, { setup: true });
  gateway = new GatewayService(ctx);
  const pn = new PrivateNetworkService(ctx, gateway, new AppManager(ctx, gateway));
  app = await buildServer(ctx, [authRoutes, privateNetworkRoutes(pn)]);
}, 240_000);

afterAll(async () => {
  process.env.ProgramFiles = savedPf;
  await app?.close();
  await ctx?.shutdown();
  dispose?.();
}, 120_000);

const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers["set-cookie"]).split(";")[0]!;

describe("private network (WireGuard)", () => {
  it("asks to install WireGuard first, in plain words", async () => {
    process.env.ProgramFiles = "C:\\nonexistent-pf";
    const call = await ownerClient(app, ctx);
    const r = await call("POST", "/api/v1/network/private/enable");
    expect(r.status).toBe(409);
    expect(r.body.error.problem.title).toBe("Install WireGuard first");
    expect((await call("GET", "/api/v1/network/private")).body).toMatchObject({ wireguardInstalled: false, enabled: false, devices: [] });
    process.env.ProgramFiles = savedPf;
  });

  it("devices on it sign in with password + two-step code; the marker can't be faked", async () => {
    const user = await ctx.users.createUser({ username: "pnadmin", displayName: "PN Admin", role: "administrator", password: STRONG });
    const { secret } = ctx.users.beginMfaEnrollment(user.id, "Nexus");
    ctx.users.confirmMfaEnrollment(user.id, totpCode(base32Decode(secret), Date.now()));
    const login = (headers: Record<string, string>) => app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { ...CSRF, ...headers }, payload: { username: "pnadmin", password: STRONG } });

    // Remote administration is off and the private network isn't on: refused.
    expect((await login(THROUGH_PN)).statusCode).toBe(403);

    ctx.settings.set("privateNetwork", { enabled: true, authRevision: "1" });
    ctx.vault.set("system/private-network/marker", MARKER, "system");
    // A wrong marker is just an ordinary remote request (and remote administration is off).
    expect((await login({ ...THROUGH_PN, "x-nexus-private-network": "guessed-guessed-guessed-guessed" })).statusCode).toBe(403);

    const step1 = await login(THROUGH_PN);
    expect(step1.json()).toMatchObject({ mfaRequired: true });
    const step2 = await app.inject({ method: "POST", url: "/api/v1/auth/mfa", headers: { ...CSRF, ...THROUGH_PN }, payload: { pendingToken: step1.json().pendingToken, code: totpCode(base32Decode(secret), Date.now() + 30_000) } });
    expect(step2.statusCode).toBe(200);
    // Plain http inside the WireGuard tunnel: the cookie can't require https there.
    expect(String(step2.headers["set-cookie"])).not.toMatch(/Secure/);
    const cookie = cookieOf(step2);
    expect((await app.inject({ url: "/api/v1/auth/me", headers: { cookie, ...THROUGH_PN } })).json()).toMatchObject({ remote: true, user: { username: "pnadmin" } });
    // The same session without the marker (e.g. copied to the public internet) is useless.
    expect((await app.inject({ url: "/api/v1/auth/me", headers: { cookie, "x-forwarded-for": "203.0.113.5", "x-nexus-remote": "1" } })).statusCode).toBeOneOf([401, 403]);

    // Switching the private network off ends it.
    ctx.settings.set("privateNetwork", { enabled: false, authRevision: "2" });
    expect((await app.inject({ url: "/api/v1/auth/me", headers: { cookie, ...THROUGH_PN } })).statusCode).toBeOneOf([401, 403]);
  });

  it("gives the gateway a port per app and one for the control center, reachable only from the network", async () => {
    ctx.settings.set("privateNetwork", { enabled: true, subnet: { base: "10.73.0" }, authRevision: "3" });
    const cfg = await gateway.config();
    expect(cfg.privateNetwork).toMatchObject({ subnetCidr: "10.73.0.0/24", marker: MARKER, controlPort: expect.any(Number), sites: [] });
    ctx.settings.set("privateNetwork", { enabled: false });
    expect((await gateway.config()).privateNetwork).toBeNull();
  });
});
