import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NexusContext } from "../src/context";
import { appRoutes } from "../src/http/routes/apps";
import { dataRoutes } from "../src/http/routes/data";
import { authRoutes } from "../src/http/routes/auth";
import { buildServer } from "../src/http/server";
import { AppManager } from "../src/services/apps";
import { GatewayService } from "../src/services/gateway";
import { createContext, tempHome } from "./helpers";
import { ownerClient } from "./helpers-http";

let ctx: NexusContext;
let app: FastifyInstance;
let apps: AppManager;
let home: string;
let dispose: () => void;
let call: Awaited<ReturnType<typeof ownerClient>>;

/** Tiny dependency-free app that reports what Nexus gave it. */
const SERVER_JS = `
const http = require("http");
const fs = require("fs");
http.createServer((req, res) => {
  if (req.url === "/health") return res.end("ok");
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({
    version: VERSION,
    db: process.env.DATABASE_URL ? process.env.DATABASE_URL.replace(/:[^:@]+@/, ":***@") : null,
    jwtLength: (process.env.JWT_SECRET || "").length,
    uploadDirWritable: (() => { try { fs.writeFileSync(require("path").join(process.env.UPLOAD_DIR, "t.txt"), "x"); return true; } catch { return false; } })(),
    nexusToken: (process.env.NEXUS_API_TOKEN || "").startsWith("nxs_"),
    stripe: process.env.STRIPE_API_KEY || null,
  }));
}).listen(Number(process.env.PORT), "127.0.0.1");
`;

function project(dir: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
}

function get(port: number, host: string, path = "/"): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path, headers: { Host: host } }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode!, body }));
      })
      .on("error", reject);
  });
}

async function waitJob(id: string) {
  for (let i = 0; i < 2400; i++) {
    const r = await call("GET", `/api/v1/jobs/${id}`);
    if (["succeeded", "failed", "waiting_for_input"].includes(r.body.status)) return r.body;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error("job timeout");
}

let gwPorts: { httpPort: number; httpsPort: number; localPort: number };

beforeAll(async () => {
  const t = tempHome();
  home = t.home;
  dispose = t.dispose;
  ctx = await createContext(home, { setup: true });
  gwPorts = {
    httpPort: await ctx.ports.allocate("test", "http"),
    httpsPort: await ctx.ports.allocate("test", "https"),
    localPort: await ctx.ports.allocate("test", "local"),
  };
  ctx.settings.set("gateway", { ...gwPorts, insecureHttp: true, manageFirewall: false });
  const gateway = new GatewayService(ctx);
  apps = new AppManager(ctx, gateway);
  app = await buildServer(ctx, [authRoutes, appRoutes(apps), dataRoutes]);
  call = await ownerClient(app, ctx);

  project(join(home, "src", "TaxiOpsBackend"), {
    "package.json": JSON.stringify({ name: "taxiops-backend", version: "1.4.7", scripts: { start: "node server.js" }, dependencies: {} }),
    ".env.example": "DATABASE_URL=postgres://postgres:postgres@localhost:5432/taxiops\nJWT_SECRET=\nUPLOAD_DIR=./uploads\nSTRIPE_API_KEY=\n",
    ".env": "DATABASE_URL=postgres://old:old@localhost:5432/old\nPORT=5000\nJWT_SECRET=do-not-import-managed-secrets\nSTRIPE_API_KEY=sk_test_from_env\n",
    "server.js": SERVER_JS.replace("VERSION", '"1.4.7"') + "\nfunction routes(app) { app.get('/health', () => {}); }\n",
  });
}, 240_000);

afterAll(async () => {
  await app.close();
  await ctx.shutdown();
  dispose();
}, 120_000);

describe("Add Application → deploy (primary scenario, dependency-free app)", () => {
  it("analyzes the folder in plain language", async () => {
    const r = await call("POST", "/api/v1/apps/analyze", { path: join(home, "src", "TaxiOpsBackend") });
    expect(r.status).toBe(200);
    // DATABASE_URL, JWT_SECRET, UPLOAD_DIR, STRIPE_API_KEY, PORT (Nexus's own NEXUS_* variables aren't counted)
    expect(r.body.findings).toEqual(["Node.js backend", "PostgreSQL database", "File uploads", "5 settings"]);
    expect(r.body.settingsNeeded).toEqual([{ name: "STRIPE_API_KEY", required: false, secret: true, exampleValue: null }]);
    expect(r.body.envFile).toEqual({ files: [".env"], settings: [{ name: "STRIPE_API_KEY", secret: true }] });
    expect(JSON.stringify(r.body)).not.toContain("sk_test_from_env");
    expect(r.body.analysis.health).toMatchObject({ mode: "automatic", candidate: { path: "/health", evidence: "Node.js route in server.js" }, endpoint: null });
  });

  it("creates the database, connects, deploys, configures access and verifies", async () => {
    const created = await call("POST", "/api/v1/apps", {
      sourceDir: join(home, "src", "TaxiOpsBackend"),
      name: "TaxiOps",
      data: { mode: "new", databaseName: "TaxiOps" },
      access: "internet",
      domain: "taxiops.test.example",
      importEnvFile: true,
    });
    expect(created.status).toBe(200);
    expect(created.body.appId).toBe("taxiops");
    const job = await waitJob(created.body.jobId);
    expect(job.problem ?? null).toBeNull();
    expect(job.status).toBe("succeeded");
    expect(job.steps.map((s: { key: string; status: string }) => `${s.key}:${s.status}`)).toEqual([
      "analyze:done",
      "database:done",
      "connect:done",
      "prepare:done",
      "migrate:skipped",
      "start:done",
      "network:done",
      "verify:done",
      "backups:done",
    ]);
    expect(job.result.checks.map((c: { label: string; ok: boolean }) => `${c.label}:${c.ok}`)).toEqual([
      "Application:true",
      "Database:true",
      "Storage:true",
      "Health checks:true",
      "HTTPS:true",
    ]);

    // Reached through the gateway on the app's local address and its public domain.
    const local = await get(gwPorts.localPort, "taxiops.nexus.localhost");
    expect(local.status).toBe(200);
    const seen = JSON.parse(local.body);
    expect(seen.db).toMatch(/^postgres:\/\/taxiops_taxiops:\*\*\*@127\.0\.0\.1:\d+\/taxiops$/);
    expect(seen.jwtLength).toBeGreaterThanOrEqual(40); // generated secret
    expect(seen.uploadDirWritable).toBe(true); // persistent upload folder
    expect(seen.nexusToken).toBe(true);
    expect(seen.stripe).toBe("sk_test_from_env"); // imported before the first start
    expect(seen.db).not.toContain("/old"); // Nexus-managed database settings are never overridden by .env
    expect(ctx.vault.get("app:taxiops/env/JWT_SECRET")).not.toBe("do-not-import-managed-secrets");
    const pub = await get(gwPorts.httpPort, "taxiops.test.example");
    expect(JSON.parse(pub.body).version).toBe("1.4.7");

    const list = await call("GET", "/api/v1/apps");
    expect(list.body[0]).toMatchObject({ name: "TaxiOps", status: "running", accessMode: "internet", externalUrl: "https://taxiops.test.example", currentRelease: "v1.4.7" });
    expect(ctx.activity.list().map((a) => a.message)).toContain("TaxiOps deployed successfully.");
  }, 300_000);

  it("stores user-provided secrets safely and applies them on restart", async () => {
    expect((await call("PUT", "/api/v1/apps/taxiops/settings/STRIPE_API_KEY", { value: "sk_live_123456" })).status).toBe(200);
    const view = await call("GET", "/api/v1/apps/taxiops/settings");
    expect(view.body.find((s: { name: string }) => s.name === "STRIPE_API_KEY")).toMatchObject({ value: "••••••••", secret: true });
    expect((await call("POST", "/api/v1/apps/taxiops/restart")).body).toEqual({ status: "running" });
    expect(JSON.parse((await get(gwPorts.localPort, "taxiops.nexus.localhost")).body).stripe).toBe("sk_live_123456");
  }, 60_000);

  it("supports a user-configured health endpoint without restarting the app", async () => {
    const before = (await call("GET", "/api/v1/apps/taxiops/developer")).body.pid;
    const saved = await call("PUT", "/api/v1/apps/taxiops/health", { mode: "custom", path: "/health" });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ restartNeeded: false, health: { mode: "custom", endpoint: { path: "/health", source: "user", validated: true } } });
    const detail = await call("GET", "/api/v1/apps/taxiops");
    expect(detail.body.analysis.health.endpoint).toMatchObject({ path: "/health", source: "user" });
    expect((await call("GET", "/api/v1/apps/taxiops/developer")).body.pid).toBe(before);
  });

  it("stop and start", async () => {
    await call("POST", "/api/v1/apps/taxiops/stop");
    expect((await call("GET", "/api/v1/apps/taxiops")).body.status).toBe("stopped");
    expect((await get(gwPorts.localPort, "taxiops.nexus.localhost")).status).toBe(503);
    expect((await call("POST", "/api/v1/apps/taxiops/start")).body).toEqual({ status: "running" });
  }, 60_000);

  it("redeploys a new version and rolls back", async () => {
    project(join(home, "src", "TaxiOpsBackend"), {
      "package.json": JSON.stringify({ name: "taxiops-backend", version: "1.4.8", scripts: { start: "node server.js" }, dependencies: {} }),
      "server.js": SERVER_JS.replace("VERSION", '"1.4.8"'),
    });
    const job = await waitJob((await call("POST", "/api/v1/apps/taxiops/deploy")).body.jobId);
    expect(job.status).toBe("succeeded");
    expect(JSON.parse((await get(gwPorts.localPort, "taxiops.nexus.localhost")).body).version).toBe("1.4.8");
    expect((await call("GET", "/api/v1/apps/taxiops")).body.analysis.health.endpoint).toMatchObject({ path: "/health", source: "user" });

    const detail = await call("GET", "/api/v1/apps/taxiops");
    expect(detail.body.deployments.map((d: { version: string; status: string }) => `${d.version}:${d.status}`)).toEqual(["v1.4.8:active", "v1.4.7:superseded"]);
    const previous = detail.body.deployments[1].id;
    expect((await call("POST", "/api/v1/apps/taxiops/rollback", { deploymentId: previous })).body).toEqual({ status: "running" });
    expect(JSON.parse((await get(gwPorts.localPort, "taxiops.nexus.localhost")).body).version).toBe("1.4.7");
  }, 300_000);

  it("asks one question when database settings are ambiguous", async () => {
    project(join(home, "src", "Billing"), {
      "package.json": JSON.stringify({ name: "billing", scripts: { start: "node server.js" }, dependencies: {} }),
      ".env.example": "FLEET_DATABASE_URL=\nBILLING_DB_HOST=\nBILLING_DB_NAME=\nBILLING_DB_USER=\nBILLING_DB_PASSWORD=\n",
      "server.js": "require('http').createServer((q,s)=>s.end(JSON.stringify({host:process.env.BILLING_DB_HOST||null,fleet:process.env.FLEET_DATABASE_URL||null}))).listen(+process.env.PORT,'127.0.0.1')",
    });
    const created = await call("POST", "/api/v1/apps", { sourceDir: join(home, "src", "Billing"), data: { mode: "new" }, access: "private" });
    let job = await waitJob(created.body.jobId);
    expect(job.status).toBe("waiting_for_input");
    expect(job.question.prompt).toBe("We found two possible database configurations. Which one does Billing use for its own data?");
    const deploying = await call("GET", "/api/v1/apps/billing");
    expect(deploying.body).toMatchObject({ status: "deploying", deploymentJobId: created.body.jobId });
    const billing = job.question.choices.find((c: { value: string }) => c.value === "BILLING");
    await call("POST", `/api/v1/jobs/${job.id}/answer`, { questionId: job.question.id, value: billing.value });
    job = await waitJob(job.id);
    expect(job.status).toBe("succeeded");
    expect((await call("GET", "/api/v1/apps/billing")).body.deploymentJobId).toBeNull();
    const seen = JSON.parse((await get(gwPorts.localPort, "billing.nexus.localhost")).body);
    expect(seen).toEqual({ host: "127.0.0.1", fleet: null });
  }, 300_000);

  it("removing an app requires typing its name and keeps its database", async () => {
    expect((await call("DELETE", "/api/v1/apps/billing", { confirmation: "yes" })).status).toBe(400);
    expect((await call("DELETE", "/api/v1/apps/billing", { confirmation: "Billing" })).status).toBe(200);
    expect(ctx.databases!.list().some((d) => d.name === "Billing")).toBe(true);
  }, 60_000);

  it("browses folders for the Add Application picker", async () => {
    const r = await call("GET", `/api/v1/fs/browse?path=${encodeURIComponent(join(home, "src"))}`);
    expect(r.body.entries.map((e: { name: string; isProject: boolean }) => `${e.name}:${e.isProject}`).sort()).toEqual(["Billing:true", "TaxiOpsBackend:true"]);
  });
});

describe("settings from the app's own .env file", () => {
  it("lists names only, imports them (secrets encrypted), and skips what Nexus manages", async () => {
    writeFileSync(join(home, "src", "TaxiOpsBackend", ".env"), "MONGO_URL=mongodb+srv://user:pw@cluster.example/\nFEATURE_FLAG=on\nPORT=5000\n# comment\n");
    const found = await call("GET", "/api/v1/apps/taxiops/env-file");
    expect(found.body).toEqual({ files: [".env"], settings: [{ name: "MONGO_URL", alreadySet: false }, { name: "FEATURE_FLAG", alreadySet: false }] });
    expect(JSON.stringify(found.body)).not.toContain("pw@");

    const imported = await call("POST", "/api/v1/apps/taxiops/env-file/import", {});
    expect(imported.body).toEqual({ imported: ["MONGO_URL", "FEATURE_FLAG"], restartNeeded: true });
    expect(ctx.vault.get("app:taxiops/env/MONGO_URL")).toBe("mongodb+srv://user:pw@cluster.example/");
    expect((await call("GET", "/api/v1/apps/taxiops/env-file")).body.settings.every((s: { alreadySet: boolean }) => s.alreadySet)).toBe(true);
  });
});

describe("deleting databases", () => {
  it("is refused while an app uses it, allowed once only pipelines or removed apps held logins", async () => {
    const appDb = (await call("GET", "/api/v1/apps/taxiops")).body.database.id as string;
    const inUse = await call("GET", `/api/v1/databases/${appDb}`);
    expect(inUse.body.usedBy).toEqual([{ id: "taxiops", name: "TaxiOps" }]);
    const refused = await call("DELETE", `/api/v1/databases/${appDb}`, { confirmation: "TaxiOps" });
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toMatch(/still used by TaxiOps/);

    // A database only the pipelines' own login touches can be deleted.
    const spare = await call("POST", "/api/v1/databases", { name: "Scratch" });
    await ctx.databases!.grantAppAccess(spare.body.id, "pipelines");
    expect((await call("GET", `/api/v1/databases/${spare.body.id}`)).body.usedBy).toEqual([]);
    expect((await call("DELETE", `/api/v1/databases/${spare.body.id}`, { confirmation: "wrong" })).status).toBe(400);
    expect((await call("DELETE", `/api/v1/databases/${spare.body.id}`, { confirmation: "Scratch" })).status).toBe(200);
    expect((await call("GET", `/api/v1/databases/${spare.body.id}`)).status).toBe(404);

    // Removing the app ends its database login; then the database can go too.
    expect((await call("DELETE", "/api/v1/apps/taxiops", { confirmation: "TaxiOps" })).status).toBe(200);
    expect(ctx.databases!.require(appDb).appIds).toEqual([]);
    expect((await call("DELETE", `/api/v1/databases/${appDb}`, { confirmation: "TaxiOps" })).status).toBe(200);
  }, 120_000);
});

describe("automatic health self-correction", () => {
  it("keeps a VDP-like HTTP server running when an inferred /health route returns 404", async () => {
    const dir = join(home, "src", "VDP");
    project(dir, {
      "package.json": JSON.stringify({ name: "vdp", version: "1.0.0", scripts: { start: "node server.js" }, dependencies: {} }),
      "server.js": `const http=require("http"); function routesThatAreNotMounted(app){ app.get("/health",()=>{}); } http.createServer((req,res)=>{res.statusCode=404;res.end("not found")}).listen(Number(process.env.PORT),"127.0.0.1");`,
    });
    const created = await call("POST", "/api/v1/apps", { sourceDir: dir, name: "vdp", data: { mode: "none" }, access: "private" });
    const job = await waitJob(created.body.jobId);
    expect(job.status).toBe("succeeded");
    let detail = await call("GET", "/api/v1/apps/vdp");
    expect(detail.body).toMatchObject({ status: "running", analysis: { health: { candidate: { path: "/health" }, endpoint: null, rejection: { path: "/health", status: 404 } } } });

    // Simulate an application stored by an older Nexus version, which only had healthPath.
    await call("POST", "/api/v1/apps/vdp/stop");
    const legacy = { ...apps.require("vdp").analysis, healthPath: "/health" } as Record<string, unknown>;
    delete legacy.health;
    ctx.store.run("UPDATE apps SET analysis = ? WHERE id = ?", [JSON.stringify(legacy), "vdp"]);
    expect((await call("POST", "/api/v1/apps/vdp/start")).body.status).toBe("running");
    const pid = (await call("GET", "/api/v1/apps/vdp/developer")).body.pid;
    const checks = await call("GET", "/api/v1/apps/vdp/verify");
    expect(checks.body[0]).toMatchObject({ label: "Application", ok: true });
    expect(checks.body[0].detail).toContain("HTTP 404");
    detail = await call("GET", "/api/v1/apps/vdp");
    expect(detail.body.analysis.health).toMatchObject({ mode: "automatic", endpoint: null, rejection: { path: "/health", status: 404 } });

    // Two continuous-monitor intervals: no restart loop and no PID change.
    await new Promise((resolve) => setTimeout(resolve, 31_000));
    expect((await call("GET", "/api/v1/apps/vdp")).body.status).toBe("running");
    expect((await call("GET", "/api/v1/apps/vdp/developer")).body.pid).toBe(pid);
  }, 180_000);
});
