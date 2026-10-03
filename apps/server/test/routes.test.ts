import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { base32Decode, totpCode } from "@nexus/security";
import type { NexusContext } from "../src/context";
import { createNexusServer, type NexusServices } from "../src/app";
import { createContext, tempHome } from "./helpers";
import { CSRF, ownerClient } from "./helpers-http";

let ctx: NexusContext;
let app: FastifyInstance;
let services: NexusServices;
let home: string;
let dispose: () => void;
let call: Awaited<ReturnType<typeof ownerClient>>;

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
  ctx = await createContext(home, { setup: true, managementPort: 7780 });
  ctx.settings.set("gateway", {
    httpPort: await ctx.ports.allocate("t", "h"),
    httpsPort: await ctx.ports.allocate("t", "s"),
    localPort: await ctx.ports.allocate("t", "l"),
    insecureHttp: true,
    manageFirewall: false,
  });
  ({ app, services } = await createNexusServer(ctx));
  call = await ownerClient(app, ctx);

  const src = join(home, "src", "Fleet");
  mkdirSync(src, { recursive: true });
  writeFileSync(
    join(src, "package.json"),
    JSON.stringify({ name: "fleet", scripts: { start: "node server.js" }, dependencies: {} }),
  );
  writeFileSync(join(src, ".env.example"), "DATABASE_URL=postgres://x@localhost/fleet\n");
  writeFileSync(
    join(src, "server.js"),
    "require('http').createServer((q,s)=>{console.error('Error: connect ECONNREFUSED 127.0.0.1:5432');s.end('ok')}).listen(+process.env.PORT,'127.0.0.1')",
  );
  const created = await call("POST", "/api/v1/apps", {
    sourceDir: src,
    data: { mode: "new", databaseName: "Fleet" },
    access: "private",
  });
  const job = await waitJob(created.body.jobId);
  if (job.status !== "succeeded") throw new Error(JSON.stringify(job.problem));
  const db = ctx.databases!.findByApp("fleet")!;
  await ctx.databases!.withOwner(db.id, async (c) => {
    await c.query(
      "CREATE TABLE drivers (driver_id serial PRIMARY KEY, driver_name text NOT NULL, balance numeric(10,2) DEFAULT 0)",
    );
    await c.query("INSERT INTO drivers (driver_name, balance) VALUES ('Ann', 620.5), ('Bob', 120), ('Cara', 980)");
  });
}, 300_000);

afterAll(async () => {
  await app.close();
  await ctx.shutdown();
  dispose();
}, 120_000);

describe("database routes", () => {
  it("lists databases with stats and protection", async () => {
    const r = await call("GET", "/api/v1/databases");
    expect(r.body).toHaveLength(1);
    expect(r.body[0]).toMatchObject({
      name: "Fleet",
      status: "healthy",
      tableCount: 1,
      ownerAppIds: ["fleet"],
      protected: false,
    });
  });

  it("browses, filters, edits, and exports without SQL", async () => {
    const id = ctx.databases!.findByApp("fleet")!.id;
    expect((await call("GET", `/api/v1/databases/${id}/tables`)).body[0]).toMatchObject({
      name: "drivers",
      editable: true,
    });
    const filters = encodeURIComponent(JSON.stringify([{ column: "balance", op: "gt", value: 500 }]));
    const owing = await call("GET", `/api/v1/databases/${id}/tables/drivers?filters=${filters}&sort=driver_name`);
    expect(owing.body.rows.map((r: { driver_name: string }) => r.driver_name)).toEqual(["Ann", "Cara"]);
    const added = await call("POST", `/api/v1/databases/${id}/tables/drivers/rows`, { values: { driver_name: "Dan" } });
    expect(added.body.driver_name).toBe("Dan");
    await call("PATCH", `/api/v1/databases/${id}/tables/drivers/rows`, {
      key: { driver_id: added.body.driver_id },
      changes: { balance: 42 },
    });
    expect(
      (
        await call("DELETE", `/api/v1/databases/${id}/tables/drivers/rows`, {
          key: { driver_id: added.body.driver_id },
        })
      ).status,
    ).toBe(400); // needs confirmation
    expect(
      (
        await call("DELETE", `/api/v1/databases/${id}/tables/drivers/rows`, {
          key: { driver_id: added.body.driver_id },
          confirmed: true,
        })
      ).status,
    ).toBe(200);
    const csv = await app.inject({
      url: `/api/v1/databases/${id}/tables/drivers/export.csv`,
      headers: { cookie: (await login()).cookie },
    });
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
    expect(csv.body.split("\r\n")[0]).toBe("driver_id,driver_name,balance");
    expect(
      ctx.audit
        .query({ action: "data." })
        .map((a) => a.action)
        .sort(),
    ).toEqual(["data.delete", "data.insert", "data.update"]);
  });

  it("refuses to delete a database still used by an app", async () => {
    const id = ctx.databases!.findByApp("fleet")!.id;
    expect((await call("DELETE", `/api/v1/databases/${id}`, { confirmation: "Fleet" })).status).toBe(409);
  });
});

async function login() {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/local",
    headers: CSRF,
    payload: { token: ctx.localToken },
  });
  return { cookie: String(res.headers["set-cookie"]).split(";")[0]! };
}

describe("files", () => {
  it("uploads, lists, downloads safely and deletes documents", async () => {
    const { cookie } = await login();
    const boundary = "----nexus";
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="invoice-1.pdf"',
      "Content-Type: application/pdf",
      "",
      "%PDF-1.7 invoice",
      `--${boundary}--`,
      "",
    ].join("\r\n");
    const up = await app.inject({
      method: "POST",
      url: "/api/v1/apps/fleet/files?folder=invoices",
      headers: { cookie, ...CSRF, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(up.statusCode).toBe(200);
    const fileId = up.json()[0].id;
    const list = await call("GET", "/api/v1/apps/fleet/files?folder=invoices");
    expect(list.body.objects[0]).toMatchObject({ name: "invoice-1.pdf", contentType: "application/pdf" });
    const dl = await app.inject({ url: `/api/v1/apps/fleet/files/${fileId}`, headers: { cookie } });
    expect(dl.body).toBe("%PDF-1.7 invoice");
    expect(dl.headers["x-content-type-options"]).toBe("nosniff");
    expect((await call("DELETE", `/api/v1/apps/fleet/files/${fileId}`)).status).toBe(200);
  });
});

describe("backups & restore", () => {
  it("backs up on demand, reports protection, and restores the database", async () => {
    const job = await waitJob((await call("POST", "/api/v1/apps/fleet/backups")).body.jobId);
    expect(job.status).toBe("succeeded");
    const status = await call("GET", "/api/v1/backups");
    expect(status.body[0]).toMatchObject({ appName: "Fleet", protected: true, message: "Protected" });
    const points = await call("GET", "/api/v1/apps/fleet/backups");
    expect(points.body[0]).toMatchObject({ status: "succeeded", trigger: "manual" });
    expect(points.body[0].path).toBeUndefined();

    const db = ctx.databases!.findByApp("fleet")!;
    await ctx.databases!.withOwner(db.id, (c) => c.query("DELETE FROM drivers"));
    expect(
      (
        await call("POST", "/api/v1/apps/fleet/restore", {
          backupId: points.body[0].id,
          parts: ["database"],
          confirmation: "nope",
        })
      ).status,
    ).toBe(400);
    const r = await waitJob(
      (
        await call("POST", "/api/v1/apps/fleet/restore", {
          backupId: points.body[0].id,
          parts: ["database"],
          confirmation: "Fleet",
        })
      ).body.jobId,
    );
    expect(r.status).toBe("succeeded");
    const n = await ctx.databases!.withOwner(
      db.id,
      async (c) => (await c.query("SELECT count(*)::int AS n FROM drivers")).rows[0].n,
    );
    expect(n).toBe(3);
    expect(services.apps.status("fleet")).toBe("running"); // restarted after restore
  }, 180_000);

  it("scheduled backups catch up after downtime", async () => {
    const ran = await services.backups.runDue(new Date(Date.now() + 3 * 86_400_000));
    expect(ran).toEqual(["fleet"]);
  }, 120_000);

  it("after a failed scheduled backup, waits longer before each retry instead of every minute", async () => {
    const later = Date.now() + 10 * 86_400_000; // well past the next scheduled time
    const fail = (at: number) =>
      ctx.store.run("INSERT INTO backups (id, app_id, created_at, trigger, status, contents, error) VALUES (?, 'fleet', ?, 'scheduled', 'failed', '{}', 'disk unavailable')", [`f-${at}`, new Date(at).toISOString()]);
    fail(later - 5 * 60_000); // one failure 5 minutes ago → wait 15 minutes
    expect(await services.backups.runDue(new Date(later))).toEqual([]);
    fail(later - 20 * 60_000); // two failures, the last 5 minutes ago → wait 30 minutes
    expect(await services.backups.runDue(new Date(later + 20 * 60_000))).toEqual([]);
    // Enough time since the last failure: it tries again.
    expect(await services.backups.runDue(new Date(later + 40 * 60_000))).toEqual(["fleet"]);
  }, 120_000);

  it("owner can view the recovery key", async () => {
    expect((await call("GET", "/api/v1/backups/recovery-key")).body.recoveryKey).toMatch(
      /^([0-9A-F]{8}-){7}[0-9A-F]{8}$/,
    );
  });
});

describe("logs, dashboard, AI, users", () => {
  it("shows logs and explains the latest error in plain English", async () => {
    await new Promise((r) => setTimeout(r, 300));
    await fetch(`http://127.0.0.1:${ctx.ports.get("app:fleet")}/`).catch(() => {});
    await new Promise((r) => setTimeout(r, 400));
    const logs = await call("GET", "/api/v1/apps/fleet/logs?level=problems");
    expect(logs.body.entries[0].message).toContain("ECONNREFUSED");
    const ex = await call("GET", "/api/v1/apps/fleet/logs/explain");
    expect(ex.body.problem.title).toBe("Database Connection Problem");
    expect(ex.body.problem.cause).toBe("Fleet is using an outdated database configuration.");
  });

  it("dashboard summarises everything", async () => {
    const now = new Date().toISOString();
    for (let i = 1; i <= 3; i++) {
      ctx.store.run(
        "INSERT INTO docdb_databases (id, name, db_name, pg_database, owner_role, port, created_at, provider) VALUES (?, ?, ?, ?, ?, ?, ?, 'mongodb')",
        [`dashboard-doc-${i}`, `Document ${i}`, `dashboard_doc_${i}`, `dashboard_engine_${i}`, `dashboard_owner_${i}`, 47000 + i, now],
      );
    }
    try {
      const d = await call("GET", "/api/v1/dashboard");
      expect(d.body).toMatchObject({
        apps: { total: 1, running: 1 },
        databases: { total: 4, online: 4 },
        externalAccess: { state: "private" },
      });
      expect(d.body.health.score).toBeGreaterThan(0);
      expect(d.body.activity.length).toBeGreaterThan(0);
    } finally {
      ctx.store.run("DELETE FROM docdb_databases WHERE id LIKE 'dashboard-doc-%'");
    }
  });

  it("persists application and disk reliability summaries", async () => {
    await services.reliability.sample();
    const detail = await call("GET", "/api/v1/apps/fleet");
    expect(detail.body.reliability).toMatchObject({
      databaseHealth: "healthy",
      last7Days: { uptimePercent: 100, crashes: 0 },
      last30Days: { uptimePercent: 100, restarts: expect.any(Number) },
    });
    expect(detail.body.reliability.last30Days.availabilityChecks).toBeGreaterThan(0);
    const system = await call("GET", "/api/v1/reliability/system?days=30");
    expect(system.body.days).toBe(30);
    expect(system.body.disks.length).toBeGreaterThan(0);
  });

  it("Ask Nexus answers from diagnostics when no AI model is ready", async () => {
    const r = await call("POST", "/api/v1/ai/ask", { question: "How is everything running?" });
    expect(r.body.source).toBe("diagnostics");
    expect(r.body.answer).toMatch(/1 of 1 application is running/);
  });

  it("manages users and per-app roles; audit trail is intact", async () => {
    const u = await call("POST", "/api/v1/users", {
      username: "john",
      displayName: "John",
      role: "viewer",
      password: "correct horse battery staple",
    });
    expect(u.status).toBe(200);
    const p = await call("PATCH", `/api/v1/users/${u.body.id}`, {
      appRoles: { fleet: "administrator" },
      serverSettingsAccess: false,
    });
    expect(p.body).toMatchObject({ appRoles: { fleet: "administrator" }, serverSettingsAccess: false });
    expect((await call("POST", "/api/v1/users", { username: "x2", displayName: "X", role: "owner" })).status).toBe(400);
    const audit = await call("GET", "/api/v1/audit");
    expect(audit.body.integrity.intact).toBe(true);
  });

  it("remote administration needs a password and MFA on the Owner first", async () => {
    const r = await call("PUT", "/api/v1/remote-admin", { enabled: true, publicHost: "server.example.com" });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/two-step verification/);

    const owner = ctx.users.list().find((user) => user.role === "owner")!;
    await ctx.users.setPassword(owner.id, "correct horse battery staple");
    const { secret } = ctx.users.beginMfaEnrollment(owner.id, "Nexus");
    ctx.users.confirmMfaEnrollment(owner.id, totpCode(base32Decode(secret), Date.now()));
    call = await ownerClient(app, ctx); // Setting the password correctly revoked the earlier local session.

    const enabled = await call("PUT", "/api/v1/remote-admin", { enabled: true, publicHost: "server.example.com" });
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
    expect(enabled.body).toEqual({ enabled: true, publicHost: "server.example.com", gatewayWarning: null });
    expect(enabled.body.authRevision).toBeUndefined();

    const management = ctx.users.createSession(owner.id, { method: "mfa", audience: "management", remote: true });
    const application = ctx.users.createSession(owner.id, {
      method: "password",
      audience: "application",
      remote: true,
    });
    const disabled = await call("PUT", "/api/v1/remote-admin", {
      enabled: false,
      publicHost: "server.example.com",
    });
    expect(disabled.body).toMatchObject({ enabled: false, publicHost: null });
    expect(ctx.users.validateSession(management.token)).toBeNull();
    expect(ctx.users.validateSession(application.token)?.session.audience).toBe("application");
  });
});

describe("Advanced › Developer", () => {
  it("shows technical details with secrets masked unless revealed (and audited)", async () => {
    const d = await call("GET", "/api/v1/apps/fleet/developer");
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({
      appId: "fleet",
      status: "running",
      isolation: { id: "process" },
      database: { database: "fleet", user: "fleet_fleet", password: "••••••••" },
    });
    expect(d.body.internalAddress).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(d.body.start.executable).toMatch(/node(\.exe)?$/);
    expect(d.body.managedVariables).toEqual(expect.arrayContaining(["DATABASE_URL", "PORT", "NEXUS_API_TOKEN"]));
    expect(d.body.database.url).not.toMatch(
      ctx.databases!.connectionInfo(ctx.databases!.findByApp("fleet")!.id, "fleet").password,
    );
    expect(d.body.apiCredentials[0]).toMatchObject({ label: expect.stringMatching(/^Automatic/) });

    const r = await call("GET", "/api/v1/apps/fleet/developer?reveal=1");
    expect(r.body.database.password).toHaveLength(32);
    expect(ctx.audit.query({ action: "app.secrets.reveal" })).toHaveLength(1);
  });
});
