import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NexusContext } from "../src/context";
import { createNexusServer, type NexusServices } from "../src/app";
import { createContext, tempHome } from "./helpers";
import { ownerClient } from "./helpers-http";

let ctx: NexusContext;
let app: FastifyInstance;
let services: NexusServices;
let dispose: () => void;
let call: Awaited<ReturnType<typeof ownerClient>>;
const tokenOf = (appId: string) => ctx.vault.get(`app:${appId}/nexus-token`)!;

async function deployStatic(home: string, name: string): Promise<string> {
  const dir = join(home, "src", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), `<h1>${name}</h1>`);
  const r = await call("POST", "/api/v1/apps", { sourceDir: dir, data: { mode: "none" }, access: "private" });
  for (let i = 0; i < 600; i++) {
    const j = await call("GET", `/api/v1/jobs/${r.body.jobId}`);
    if (j.body.status === "succeeded") return r.body.appId;
    if (j.body.status === "failed") throw new Error(JSON.stringify(j.body.problem));
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error("timeout");
}

let taxi: string;
let finance: string;

beforeAll(async () => {
  const t = tempHome();
  dispose = t.dispose;
  ctx = await createContext(t.home, { setup: true });
  ctx.settings.set("gateway", { httpPort: await ctx.ports.allocate("t", "h"), httpsPort: await ctx.ports.allocate("t", "s"), localPort: await ctx.ports.allocate("t", "l"), insecureHttp: true, manageFirewall: false });
  ({ app, services } = await createNexusServer(ctx));
  call = await ownerClient(app, ctx);
  taxi = await deployStatic(t.home, "TaxiOps");
  finance = await deployStatic(t.home, "Finance");
}, 300_000);

afterAll(async () => {
  await app.close();
  await ctx.shutdown();
  dispose();
}, 120_000);

const bearer = (appId: string) => ({ authorization: `Bearer ${tokenOf(appId)}` });

describe("app-facing storage API (POST/GET/DELETE /storage)", () => {
  it("stores and serves an application's documents", async () => {
    const up = await app.inject({
      method: "POST",
      url: "/api/v1/app/storage?folder=invoices",
      headers: { ...bearer(taxi), "content-type": "application/pdf", "x-file-name": encodeURIComponent("Invoice #7.pdf") },
      payload: Buffer.from("%PDF-1.7 seven"),
    });
    expect(up.statusCode).toBe(200);
    expect(up.json()).toMatchObject({ name: "Invoice #7.pdf", folder: "invoices", contentType: "application/pdf", size: 14 });
    const id = up.json().id;
    expect((await app.inject({ url: "/api/v1/app/storage?folder=invoices", headers: bearer(taxi) })).json().objects).toHaveLength(1);
    const dl = await app.inject({ url: `/api/v1/app/storage/${id}`, headers: bearer(taxi) });
    expect(dl.body).toBe("%PDF-1.7 seven");

    // Another app cannot see or delete it — it looks like it doesn't exist.
    expect((await app.inject({ url: `/api/v1/app/storage/${id}`, headers: bearer(finance) })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/api/v1/app/storage/${id}`, headers: bearer(finance) })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/api/v1/app/storage/${id}`, headers: bearer(taxi) })).statusCode).toBe(200);
  });

  it("rejects missing or forged credentials", async () => {
    expect((await app.inject({ url: "/api/v1/app/storage" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/v1/app/storage", headers: { authorization: "Bearer nxs_forged" } })).statusCode).toBe(401);
    // A user session is not an app credential.
    expect((await call("GET", "/api/v1/app/storage")).status).toBe(401);
  });
});

describe("secrets, logs, health", () => {
  it("apps read only their own settings", async () => {
    services.apps.setEnv(taxi, "SMTP_PASSWORD", "mail-secret-123");
    expect((await app.inject({ url: "/api/v1/app/secrets/SMTP_PASSWORD", headers: bearer(taxi) })).json()).toEqual({ name: "SMTP_PASSWORD", value: "mail-secret-123" });
    expect((await app.inject({ url: "/api/v1/app/secrets/SMTP_PASSWORD", headers: bearer(finance) })).statusCode).toBe(404);
  });

  it("apps can write to their log and read their health", async () => {
    const w = await app.inject({ method: "POST", url: "/api/v1/app/logs", headers: bearer(taxi), payload: { level: "error", message: "Payment gateway timeout" } });
    expect(w.statusCode).toBe(200);
    ctx.logs.flush();
    expect(ctx.logs.search(`app:${taxi}`, { level: "error" })[0]!.message).toContain("Payment gateway timeout");
    expect((await app.inject({ url: "/api/v1/app/health", headers: bearer(taxi) })).json()).toEqual({ status: "running", database: "none", storage: "connected" });
  });
});

describe("gateway authorization", () => {
  it("API access only: valid API key for that app", async () => {
    const key = (await call("POST", `/api/v1/apps/${taxi}/api-keys`, { label: "Mobile app" })).body.key as string;
    expect(key).toMatch(/^nxs_/);
    const ok = await app.inject({ url: `/api/v1/gateway/authorize?app=${taxi}&mode=api`, headers: { "x-api-key": key } });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["x-nexus-client"]).toBe("Mobile app");
    expect((await app.inject({ url: `/api/v1/gateway/authorize?app=${finance}&mode=api`, headers: { "x-api-key": key } })).statusCode).toBe(401);
    expect((await app.inject({ url: `/api/v1/gateway/authorize?app=${taxi}&mode=api`, headers: { "x-api-key": tokenOf(taxi) } })).statusCode).toBe(401); // internal token ≠ API key
    const keys = await call("GET", `/api/v1/apps/${taxi}/api-keys`);
    expect(keys.body.map((k: { label: string }) => k.label)).toEqual(["Mobile app"]);
    await call("DELETE", `/api/v1/apps/${taxi}/api-keys/${keys.body[0].id}`);
    expect((await app.inject({ url: `/api/v1/gateway/authorize?app=${taxi}&mode=api`, headers: { "x-api-key": key } })).statusCode).toBe(401);
  });

  it("Authorized users only: sign-in page on the app's domain, per-app access", async () => {
    await call("PUT", `/api/v1/apps/${taxi}/access`, { access: "authorized", domain: "taxiops.test.example" });
    const host = { host: "taxiops.test.example", "x-forwarded-host": "taxiops.test.example", "x-forwarded-for": "198.51.100.9" };

    const unauth = await app.inject({ url: `/api/v1/gateway/authorize?app=${taxi}&mode=user`, headers: { ...host, "x-forwarded-uri": "/dispatch?day=1" } });
    expect(unauth.statusCode).toBe(302);
    expect(unauth.headers.location).toBe("/.nexus/login?return=%2Fdispatch%3Fday%3D1");
    const page = await app.inject({ url: "/.nexus/login?return=/dispatch", headers: host });
    expect(page.body).toContain("<h1>TaxiOps</h1>");

    await ctx.users.createUser({ username: "driverlead", displayName: "Driver Lead", role: "app_user", password: "correct horse battery staple" });
    const u = ctx.users.findByUsername("driverlead")!;
    const form = (extra: Record<string, string> = {}) => new URLSearchParams({ username: "driverlead", password: "correct horse battery staple", return: "/dispatch", ...extra }).toString();
    const post = (headers: Record<string, string> = {}) =>
      app.inject({ method: "POST", url: "/.nexus/login", headers: { ...host, "content-type": "application/x-www-form-urlencoded", ...headers }, payload: form() });

    const denied = await post();
    expect(denied.statusCode).toBe(401);
    expect(denied.body).toContain("doesn&#39;t have access to TaxiOps");

    ctx.users.setAppRole(u.id, taxi, "app_user");
    expect((await post({ origin: "https://evil.example" })).statusCode).toBe(403);
    const ok = await post({ origin: "https://taxiops.test.example" });
    expect(ok.statusCode).toBe(303);
    expect(ok.headers.location).toBe("/dispatch");
    const cookie = String(ok.headers["set-cookie"]).split(";")[0]!;
    expect(String(ok.headers["set-cookie"])).toMatch(/HttpOnly/);

    const authorized = await app.inject({ url: `/api/v1/gateway/authorize?app=${taxi}&mode=user`, headers: { ...host, cookie } });
    expect(authorized.statusCode).toBe(200);
    expect(authorized.headers["x-nexus-user"]).toBe("driverlead");
    // The same session gives no access to other apps.
    expect((await app.inject({ url: `/api/v1/gateway/authorize?app=${finance}&mode=user`, headers: { ...host, cookie } })).statusCode).toBe(302);
  });

  it("open redirects are not possible", async () => {
    const r = await app.inject({ url: `/api/v1/gateway/authorize?app=${taxi}&mode=user`, headers: { host: "taxiops.test.example", "x-forwarded-uri": "//evil.example/steal" } });
    expect(r.headers.location).toBe("/.nexus/login?return=%2F");
  });
});
