/**
 * PRIMARY SUCCESS SCENARIO (from the product brief):
 * An existing Express server at C:\Projects\TaxiOpsBackend → Add Application → Nexus detects
 * Express and its SQL needs → "Create New Database" → "Use outside this server: Yes" → deploy →
 * Nexus tests application, database, API, storage, HTTPS, health checks → "TaxiOps is online."
 * The user never edits .env, passwords, ports, PostgreSQL users, proxy files, firewall or certificates.
 *
 * Uses real npm packages (express, pg), a real PostgreSQL 18 and the real Caddy gateway.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNexusServer } from "../../apps/server/src/app";
import type { NexusContext } from "../../apps/server/src/context";
import { createContext, tempHome } from "../../apps/server/test/helpers";
import { ownerClient } from "../../apps/server/test/helpers-http";

const SERVER_JS = `const express = require("express");
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const app = express();
app.use(express.json());
app.get("/health", (req, res) => res.json({ ok: true }));
app.get("/api/drivers", async (req, res) => {
  const r = await pool.query("SELECT id, name, balance FROM drivers ORDER BY id");
  res.json(r.rows);
});
app.post("/api/drivers", async (req, res) => {
  const r = await pool.query("INSERT INTO drivers (name, balance) VALUES ($1, $2) RETURNING *", [req.body.name, req.body.balance ?? 0]);
  res.status(201).json(r.rows[0]);
});
const port = process.env.PORT || 3000;
app.listen(port, () => console.log("TaxiOps API listening on " + port));
`;

const MIGRATE_JS = `const { Client } = require("pg");
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query("CREATE TABLE IF NOT EXISTS drivers (id serial PRIMARY KEY, name text NOT NULL, balance numeric(10,2) NOT NULL DEFAULT 0)");
  console.log("migrated");
  await c.end();
})().catch((e) => { console.error(e); process.exit(1); });
`;

let ctx: NexusContext;
let app: FastifyInstance;
let home: string;
let dispose: () => void;
let call: Awaited<ReturnType<typeof ownerClient>>;
let gw: { httpPort: number; localPort: number };

function request(port: number, host: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      { host: "127.0.0.1", port, method, path, headers: { Host: host, ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}) } },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve({ status: res.statusCode!, json: b ? JSON.parse(b) : null }));
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

beforeAll(async () => {
  const t = tempHome();
  home = t.home;
  dispose = t.dispose;
  ctx = await createContext(home, { setup: true });
  gw = { httpPort: await ctx.ports.allocate("e2e", "http"), localPort: await ctx.ports.allocate("e2e", "local") };
  ctx.settings.set("gateway", { ...gw, httpsPort: await ctx.ports.allocate("e2e", "https"), insecureHttp: true, manageFirewall: false });
  ({ app } = await createNexusServer(ctx));
  call = await ownerClient(app, ctx);

  const src = join(home, "Projects", "TaxiOpsBackend");
  mkdirSync(src, { recursive: true });
  writeFileSync(
    join(src, "package.json"),
    JSON.stringify({ name: "taxiops-backend", version: "1.0.0", main: "server.js", scripts: { start: "node server.js", migrate: "node migrate.js" }, dependencies: { express: "^4.21.0", pg: "^8.13.0" } }, null, 2),
  );
  writeFileSync(join(src, "server.js"), SERVER_JS);
  writeFileSync(join(src, "migrate.js"), MIGRATE_JS);
  // A developer's local .env with real-looking secrets: Nexus must never copy or use it.
  writeFileSync(join(src, ".env"), "DATABASE_URL=postgres://postgres:devpassword@localhost:5432/taxiops\n");
}, 240_000);

afterAll(async () => {
  await app?.close();
  await ctx?.shutdown();
  dispose?.();
}, 120_000);

describe("Primary success scenario: Express → database → internet → online", () => {
  const src = () => join(home, "Projects", "TaxiOpsBackend");

  it("1. Add Application: Nexus detects Express and that the server needs SQL", async () => {
    const r = await call("POST", "/api/v1/apps/analyze", { path: src() });
    expect(r.body.findings).toContain("Node.js + Express backend");
    expect(r.body.findings).toContain("PostgreSQL database");
    expect(r.body.database.required).toBe(true);
    expect(r.body.externalAccessRecommended).toBe(true);
    expect(r.body.analysis.migrations).toMatchObject({ autoRunnable: true, command: { args: ["run", "migrate"] } });
  });

  it("2–9. Create New Database + internet access → deployed, tested, online", async () => {
    const created = await call("POST", "/api/v1/apps", {
      sourceDir: src(),
      name: "TaxiOps",
      data: { mode: "new", databaseName: "TaxiOps" },
      access: "internet",
      domain: "taxiops.example.com",
    });
    expect(created.status).toBe(200);
    let job: any;
    for (let i = 0; i < 3000; i++) {
      job = (await call("GET", `/api/v1/jobs/${created.body.jobId}`)).body;
      if (job.status === "succeeded" || job.status === "failed") break;
      await new Promise((r) => setTimeout(r, 200));
    }
    if (job.status !== "succeeded") throw new Error(`Deploy failed: ${JSON.stringify(job.problem)}\n${job.log.slice(-30).join("\n")}`);

    // Every step ran, including real npm install and the app's own migration.
    const steps = Object.fromEntries(job.steps.map((s: { key: string; status: string }) => [s.key, s.status]));
    expect(steps).toEqual({ analyze: "done", database: "done", connect: "done", prepare: "done", migrate: "done", start: "done", network: "done", verify: "done", backups: "done" });

    // "Nexus tests: application, database, API, storage, HTTPS, health checks"
    const checks = Object.fromEntries(job.result.checks.map((c: { label: string; ok: boolean }) => [c.label, c.ok]));
    expect(checks).toEqual({ Application: true, Database: true, Storage: true, "Health checks": true, HTTPS: true });

    // "TaxiOps is online."
    const summary = job.result.summary;
    expect(summary).toMatchObject({ name: "TaxiOps", status: "running", externalUrl: "https://taxiops.example.com", framework: "Node.js + Express backend" });
  }, 600_000);

  it("the API works end-to-end through the public address (app ↔ its own database)", async () => {
    const created = await request(gw.httpPort, "taxiops.example.com", "POST", "/api/drivers", { name: "Ann Lee", balance: 620.5 });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ name: "Ann Lee", balance: "620.50" });
    const list = await request(gw.httpPort, "taxiops.example.com", "GET", "/api/drivers");
    expect(list.json).toEqual([{ id: 1, name: "Ann Lee", balance: "620.50" }]);
    expect((await request(gw.localPort, "taxiops.nexus.localhost", "GET", "/health")).json).toEqual({ ok: true });
  });

  it("the user edited nothing: no .env copied, credentials generated and vaulted, loopback-only private port", async () => {
    const current = ctx.deployments!.current("taxiops")!;
    expect(existsSync(join(current.releaseDir, ".env"))).toBe(false);
    expect(readFileSync(join(src(), ".env"), "utf8")).toContain("devpassword"); // source untouched
    const db = ctx.databases!.findByApp("taxiops")!;
    const conn = ctx.databases!.connectionInfo(db.id, "taxiops");
    expect(conn.password).toHaveLength(32);
    expect(conn.user).toBe("taxiops_taxiops");
    const port = ctx.ports.get("app:taxiops")!;
    // A private port handed out by Nexus (test contexts use 30000–42999; the product uses 43000–43999).
    expect(port).toBeGreaterThanOrEqual(30000);
    expect(port).toBeLessThan(43000);
    const detail = await call("GET", "/api/v1/apps/taxiops");
    expect(JSON.stringify(detail.body)).not.toContain(conn.password);
    expect(detail.body.database).toMatchObject({ name: "TaxiOps" });
    expect(ctx.activity.list().map((a) => a.message)).toEqual(expect.arrayContaining(["TaxiOps database created.", "TaxiOps deployed successfully."]));
  });

  it("data survives a restart, and the database is protected by a backup", async () => {
    expect((await call("POST", "/api/v1/apps/taxiops/restart")).body).toEqual({ status: "running" });
    expect((await request(gw.httpPort, "taxiops.example.com", "GET", "/api/drivers")).json).toHaveLength(1);
    const job = (await call("POST", "/api/v1/apps/taxiops/backups")).body.jobId;
    for (let i = 0; i < 600; i++) {
      const j = (await call("GET", `/api/v1/jobs/${job}`)).body;
      if (j.status === "succeeded") break;
      if (j.status === "failed") throw new Error(JSON.stringify(j.problem));
      await new Promise((r) => setTimeout(r, 100));
    }
    const dash = await call("GET", "/api/v1/dashboard");
    expect(dash.body.backups.unprotected).toEqual([]);
    expect(dash.body.apps).toMatchObject({ total: 1, running: 1 });
  }, 120_000);
});
