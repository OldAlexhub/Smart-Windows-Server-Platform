import { mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
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
let home: string;
let dispose: () => void;
let call: Awaited<ReturnType<typeof ownerClient>>;
let blocker: net.Server;
let blockedPort: number;

async function waitJob(id: string) {
  for (let i = 0; i < 3000; i++) {
    const r = await call("GET", `/api/v1/jobs/${id}`);
    if (["succeeded", "failed", "waiting_for_input"].includes(r.body.status)) return r.body;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error("job timeout");
}

beforeAll(async () => {
  const t = tempHome();
  home = t.home;
  dispose = t.dispose;
  ctx = await createContext(home, { setup: true });
  // "Another program" already owns the public web port.
  blocker = net.createServer().listen(0, "0.0.0.0");
  await new Promise((r) => blocker.once("listening", r));
  blockedPort = (blocker.address() as net.AddressInfo).port;
  ctx.settings.set("gateway", { httpPort: blockedPort, httpsPort: await ctx.ports.allocate("t", "s"), localPort: await ctx.ports.allocate("t", "l"), insecureHttp: true, manageFirewall: false });
  ({ app, services } = await createNexusServer(ctx));
  call = await ownerClient(app, ctx);

  const src = join(home, "src", "Depot");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "package.json"), JSON.stringify({ name: "depot", version: "1.0.0", scripts: { start: "node server.js" }, dependencies: {} }));
  writeFileSync(join(src, ".env.example"), "DATABASE_URL=postgres://x@localhost/depot\n");
  writeFileSync(join(src, "server.js"), "require('http').createServer((q,s)=>s.end('depot '+(process.env.DATABASE_URL?'db':'nodb'))).listen(+process.env.PORT,'127.0.0.1')");
  const created = await call("POST", "/api/v1/apps", { sourceDir: src, data: { mode: "new" }, access: "internet", domain: "depot.test.example" });
  const job = await waitJob(created.body.jobId);
  if (job.status !== "succeeded") throw new Error(JSON.stringify(job.problem));
}, 300_000);

afterAll(async () => {
  blocker?.close();
  await app?.close();
  await ctx?.shutdown();
  dispose?.();
}, 120_000);

describe("gateway port conflicts", () => {
  it("keeps local access working and names the program blocking internet access", async () => {
    const net_ = await call("GET", "/api/v1/network");
    expect(net_.body.gateway.running).toBe(true);
    expect(net_.body.gateway.problem.title).toBe("Internet access is blocked by another program");
    expect(net_.body.gateway.problem.summary).toMatch(/node/i);
    // Status reports (and checks) the private port the gateway really moved to, not the configured one.
    const fallbackHttps = ctx.ports.get("gateway", "https-private");
    expect(net_.body.gateway).toMatchObject({ httpsPort: fallbackHttps, usingFallbackPorts: true });
    expect(net_.body.gateway.httpsPort).not.toBe(net_.body.gateway.configuredHttpsPort);
    expect((await services.gateway.runtime({ inspectListener: false })).activeHttpsPort).toBe(fallbackHttps);
    const domain = net_.body.domains.find((d: { hostname: string }) => d.hostname === "depot.test.example");
    expect(domain.https).toMatchObject({ hostname: "depot.test.example", httpsPort: fallbackHttps });
    const dash = await call("GET", "/api/v1/dashboard");
    expect(dash.body.externalAccess.state).toBe("problem");
    // The local address still works through the gateway.
    const local = await new Promise<string>((resolve, reject) => {
      const http = require("node:http") as typeof import("node:http");
      http.get({ host: "127.0.0.1", port: ctx.settings.get<{ localPort: number }>("gateway", { localPort: 0 }).localPort, headers: { Host: "depot.nexus.localhost" } }, (r) => {
        let b = "";
        r.on("data", (c) => (b += c));
        r.on("end", () => resolve(b));
      }).on("error", reject);
    });
    expect(local).toBe("depot db");
  });

  it("'Try Again' clears the problem once the port is free", async () => {
    await new Promise((r) => blocker.close(r));
    const r = await call("POST", "/api/v1/repairs", { id: "gateway.retry" });
    expect(r.status).toBe(200);
    const after = (await call("GET", "/api/v1/network")).body.gateway;
    expect(after.problem).toBeNull();
    expect(after).toMatchObject({ httpsPort: after.configuredHttpsPort, usingFallbackPorts: false });
  }, 60_000);
});

describe("one-click repairs", () => {
  it("Repair Connection issues fresh database credentials and restarts the app", async () => {
    const db = ctx.databases!.findByApp("depot")!;
    const before = ctx.databases!.connectionInfo(db.id, "depot").password;
    const r = await call("POST", "/api/v1/repairs", { id: "database.repair-connection", appId: "depot" });
    expect(r.body).toMatchObject({ ok: true, message: "Depot is connected to its database again." });
    expect(ctx.databases!.connectionInfo(db.id, "depot").password).not.toBe(before);
    expect(services.apps.status("depot")).toBe("running");
  }, 60_000);

  it("port reassignment restarts the app on a free port", async () => {
    const r = await call("POST", "/api/v1/repairs", { id: "app.reassign-port", appId: "depot" });
    expect(r.body.ok).toBe(true);
    expect(services.apps.status("depot")).toBe("running");
  }, 60_000);

  it("repairs that change things require confirmation; unknown repairs are refused", async () => {
    expect((await call("POST", "/api/v1/repairs", { id: "app.rollback", appId: "depot" })).body.error.message).toMatch(/confirm/);
    expect((await call("POST", "/api/v1/repairs", { id: "app.raise-memory-limit", appId: "depot" })).status).toBe(400);
    expect((await call("POST", "/api/v1/repairs", { id: "format.disk" })).status).toBe(400);
    const up = await call("POST", "/api/v1/repairs", { id: "app.raise-memory-limit", appId: "depot", confirmed: true });
    expect(up.body.message).toMatch(/up to 2 GB/);
  }, 60_000);
});

describe("leftover processes after an abrupt stop", () => {
  it("reaps the previous run's application processes (and only those)", async () => {
    const row = ctx.store.get<{ pid: number }>("SELECT pid FROM app_processes WHERE app_id = 'depot'")!;
    expect(row.pid).toBeGreaterThan(0);
    // Simulate Nexus dying: the manager forgets its processes but they keep running.
    (services.apps as unknown as { supervisors: Map<string, unknown>; monitors: Map<string, { dispose(): void }> }).monitors.forEach((m) => m.dispose());
    (services.apps as unknown as { supervisors: Map<string, unknown> }).supervisors.clear();
    const alive = () => {
      try {
        process.kill(row.pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(alive()).toBe(true);
    expect(await services.apps.reapOrphans()).toBe(1);
    await new Promise((r) => setTimeout(r, 500));
    expect(alive()).toBe(false);
    expect(await services.apps.reapOrphans()).toBe(0);
  }, 60_000);
});
