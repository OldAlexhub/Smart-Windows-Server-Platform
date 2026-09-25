import { mkdirSync, writeFileSync } from "node:fs";
import { ObjectId } from "mongodb";
import http from "node:http";
import { dirname, join } from "node:path";
import type { FastifyInstance } from "fastify";
import { MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NexusContext } from "../src/context";
import { appRoutes } from "../src/http/routes/apps";
import { authRoutes } from "../src/http/routes/auth";
import { dataRoutes } from "../src/http/routes/data";
import { documentRoutes } from "../src/http/routes/documents";
import { repairRoutes } from "../src/http/routes/repairs";
import { buildServer } from "../src/http/server";
import { AppManager } from "../src/services/apps";
import { BackupService } from "../src/services/backups";
import { GatewayService } from "../src/services/gateway";
import { createContext, tempHome } from "./helpers";
import { ownerClient } from "./helpers-http";

let ctx: NexusContext;
let app: FastifyInstance;
let apps: AppManager;
let home: string;
let dispose: () => void;
let call: Awaited<ReturnType<typeof ownerClient>>;

/** Dependency-free app that reports the MongoDB address Nexus gave it. */
const SERVER_JS = `
const http = require("http");
http.createServer((req, res) => {
  if (req.url === "/health") return res.end("ok");
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ mongo: process.env.MONGO_URI || null }));
}).listen(Number(process.env.PORT), "127.0.0.1");
`;

function getJson(port: number): Promise<{ mongo: string | null }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: "/" }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve(JSON.parse(body)));
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

beforeAll(async () => {
  const t = tempHome();
  home = t.home;
  dispose = t.dispose;
  ctx = await createContext(home, { setup: true });
  ctx.settings.set("gateway", {
    httpPort: await ctx.ports.allocate("test", "http"),
    httpsPort: await ctx.ports.allocate("test", "https"),
    localPort: await ctx.ports.allocate("test", "local"),
    insecureHttp: true,
    manageFirewall: false,
  });
  const gateway = new GatewayService(ctx);
  apps = new AppManager(ctx, gateway);
  const services = { apps, gateway } as unknown as Parameters<typeof repairRoutes>[0];
  app = await buildServer(ctx, [authRoutes, appRoutes(apps), repairRoutes(services), dataRoutes, documentRoutes]);
  call = await ownerClient(app, ctx);

  const dir = join(home, "src", "Shop");
  for (const [rel, content] of Object.entries({
    "package.json": JSON.stringify({ name: "shop", scripts: { start: "node server.js" }, dependencies: {} }),
    ".env.example": "MONGO_URI=mongodb://localhost:27017/shop\n",
    "server.js": SERVER_JS,
  })) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
}, 240_000);

afterAll(async () => {
  await app?.close();
  await ctx?.shutdown();
  dispose?.();
}, 120_000);

describe("MongoDB applications get a document database automatically", () => {
  it("does not start the document server until something needs it", () => {
    expect(ctx.documents).not.toBeNull();
    expect(ctx.documents!.list()).toEqual([]);
    expect(ctx.documentEngine!.running()).toEqual([]);
  });

  it("explains what it found in plain language", async () => {
    const r = await call("POST", "/api/v1/apps/analyze", { path: join(home, "src", "Shop") });
    expect(r.body.findings).toContain("Document database (MongoDB)");
    expect(r.body.warnings).toEqual([]);
  });

  it("creates the database, wires MONGO_URI, deploys and verifies", async () => {
    const created = await call("POST", "/api/v1/apps", { sourceDir: join(home, "src", "Shop"), name: "Shop", data: { mode: "new" }, access: "private" });
    expect(created.status).toBe(200);
    const job = await waitJob(created.body.jobId);
    expect(job.problem ?? null).toBeNull();
    expect(job.status).toBe("succeeded");
    expect(job.result.checks.find((c: { label: string }) => c.label === "Document database")).toMatchObject({ ok: true, detail: "Connected" });

    const rec = apps.require("shop");
    expect(rec.databaseId).toBeNull();
    expect(rec.documentDatabaseId).toBe(ctx.documents!.list()[0]!.id);

    // The running app received its own credentials, and they work for its own database only.
    const port = ctx.ports.get("app:shop", "http")!;
    const { mongo } = await getJson(port);
    expect(mongo).toMatch(/^mongodb:\/\/d_shop_shop:[A-Za-z0-9]{32}@127\.0\.0\.1:\d+\/shop\?authMechanism=PLAIN/);
    const c = new MongoClient(mongo!, { serverSelectionTimeoutMS: 5000 });
    await c.connect();
    try {
      await c.db("shop").collection("orders").insertOne({ sku: "A1", qty: 2 });
      expect(await c.db("shop").collection("orders").countDocuments()).toBe(1);
      // It sees only its own database: every document database has its own private endpoint.
      const dbs = await c.db("admin").command({ listDatabases: 1, nameOnly: true });
      expect(dbs.databases.map((d: { name: string }) => d.name)).toEqual(["shop"]);
    } finally {
      await c.close();
    }
  }, 240_000);

  it("shows the connection in Advanced › Developer with secrets hidden", async () => {
    const r = await call("GET", "/api/v1/apps/shop/developer");
    expect(r.body.database).toMatchObject({ engine: "mongodb", database: "shop", password: "••••••••" });
    expect(r.body.database.url).toContain(":••••••••@");
    expect(r.body.managedVariables).toContain("MONGO_URI");
  });

  it("Repair Connection issues new credentials and the app keeps working", async () => {
    const before = (await getJson(ctx.ports.get("app:shop", "http")!)).mongo;
    const r = await call("POST", "/api/v1/repairs", { id: "database.repair-connection", appId: "shop" });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const after = (await getJson(ctx.ports.get("app:shop", "http")!)).mongo;
    expect(after).not.toBe(before);
    expect(await ctx.documents!.testConnection(ctx.documents!.connectionInfo(apps.require("shop").documentDatabaseId!, "shop"))).toEqual({ ok: true });
  }, 120_000);
});

describe("Document database browser, import/export, backup and restore", () => {
  const base = () => `/api/v1/documents/${apps.require("shop").documentDatabaseId}`;

  it("lists document databases next to relational ones", async () => {
    const r = await call("GET", "/api/v1/databases");
    expect(r.body).toEqual([expect.objectContaining({ name: "Shop", engine: "mongodb", dbName: "shop", status: "healthy", ownerAppIds: ["shop"] })]);
    const engine = await call("GET", "/api/v1/documents/engine");
    expect(engine.body).toMatchObject({ available: true, state: "ready", engine: "FerretDB", source: "bundled" });
  });

  it("creates collections and adds, finds, edits and deletes documents", async () => {
    expect((await call("POST", `${base()}/collections`, { name: "customers" })).status).toBe(200);
    expect((await call("POST", `${base()}/collections`, { name: "system.hack" })).status).toBe(400);

    const ada = await call("POST", `${base()}/collections/customers/documents`, { document: '{"name":"Ada","since":{"$date":"2024-01-02T00:00:00Z"},"orders":3}' });
    expect(ada.status).toBe(200);
    expect(ada.body._id.$oid).toMatch(/^[0-9a-f]{24}$/);
    expect(ada.body.since).toEqual({ $date: "2024-01-02T00:00:00Z" });
    await call("POST", `${base()}/collections/customers/documents`, { document: { name: "Grace", orders: 12 } });

    const cols = await call("GET", `${base()}/collections`);
    expect(cols.body.map((c: { name: string }) => c.name)).toEqual(["customers", "orders"]);

    const found = await call("GET", `${base()}/collections/customers?filter=${encodeURIComponent('{"orders":{"$gt":5}}')}`);
    expect(found.body).toMatchObject({ total: 1, documents: [expect.objectContaining({ name: "Grace" })] });
    const bad = await call("GET", `${base()}/collections/customers?filter=${encodeURIComponent('{"$where":"sleep(10000)"}')}`);
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/run code on the server/);

    const edited = await call("PUT", `${base()}/collections/customers/documents`, { id: ada.body._id, document: { _id: { $oid: "000000000000000000000000" }, name: "Ada Lovelace", orders: 4 } });
    expect(edited.body).toMatchObject({ _id: ada.body._id, name: "Ada Lovelace", orders: 4 }); // _id can't be changed

    expect((await call("DELETE", `${base()}/collections/customers/documents`, { id: ada.body._id })).status).toBe(400); // needs confirmation
    expect((await call("DELETE", `${base()}/collections/customers/documents`, { id: ada.body._id, confirmed: true })).status).toBe(200);
    expect((await call("GET", `${base()}/collections/customers`)).body.total).toBe(1);
  });

  it("exports a collection as JSON and imports it back without duplicates", async () => {
    const exported = await call<Record<string, unknown>[]>("GET", `${base()}/collections/customers/export.json`);
    expect(exported.status).toBe(200);
    expect(exported.body).toEqual([expect.objectContaining({ name: "Grace", _id: { $oid: expect.any(String) } })]);

    const again = await call("POST", `${base()}/collections/customers/import`, { content: JSON.stringify(exported.body) });
    expect(again.body).toEqual({ inserted: 0, skipped: 1, errors: [], convertedIds: 0 });
    const lines = ['{"name":"Linus","orders":1}', '{"name":"Margaret","orders":7}', ""].join("\n");
    const fresh = await call("POST", `${base()}/collections/suppliers/import`, { content: lines, create: true });
    expect(fresh.body).toEqual({ inserted: 2, skipped: 0, errors: [], convertedIds: 0 });
    expect((await call("POST", `${base()}/collections/suppliers/import`, { content: "not json" })).status).toBe(400);
  });

  it("text ids that are ObjectIds: imported as ObjectIds, and existing ones can be converted", async () => {
    const id1 = "6a79217f0d6a7ce0393b5b38";
    const id2 = "6a79217f0d6a7ce0393b5b39";
    // A file saved from an API: ids as plain text.
    const imported = await call("POST", `${base()}/collections/projects/import`, { content: JSON.stringify([{ _id: id1, title: "TaxiTwin" }, { _id: "not-an-object-id", title: "Keep" }]), create: true });
    expect(imported.body).toMatchObject({ inserted: 2, convertedIds: 1 });
    const found = await ctx.documents!.withDatabase(apps.require("shop").documentDatabaseId!, (c) => c.db("shop").collection("projects").findOne({ _id: new ObjectId(id1) }));
    expect(found?.title).toBe("TaxiTwin");

    // Data imported earlier as text: Nexus spots it and converts it on request.
    await ctx.documents!.withDatabase(apps.require("shop").documentDatabaseId!, (c) => c.db("shop").collection("projects").insertOne({ _id: id2 as never, title: "Old import" }));
    expect((await call("GET", `${base()}/collections/projects/text-ids`)).body).toEqual({ count: 1 });
    const conv = await call("POST", `${base()}/collections/projects/convert-ids`);
    expect(conv.body).toEqual({ converted: 1, skipped: 0 });
    expect((await call("GET", `${base()}/collections/projects/text-ids`)).body).toEqual({ count: 0 });
    const converted = await ctx.documents!.withDatabase(apps.require("shop").documentDatabaseId!, (c) => c.db("shop").collection("projects").findOne({ _id: new ObjectId(id2) }));
    expect(converted?.title).toBe("Old import");
    // Text ids that aren't ObjectIds are left exactly as they are.
    const kept = await ctx.documents!.withDatabase(apps.require("shop").documentDatabaseId!, (c) => c.db("shop").collection("projects").findOne({ _id: "not-an-object-id" as never }));
    expect(kept?.title).toBe("Keep");
  });

  it("backs up the document database and restores it exactly (types and indexes included)", async () => {
    const backups = new BackupService(ctx, apps);
    const id = apps.require("shop").documentDatabaseId!;
    await ctx.documents!.withDatabase(apps.require("shop").documentDatabaseId!, (c) => c.db("shop").collection("customers").createIndex({ name: 1 }, { unique: true, name: "by_name" }));

    const b = await backups.backupNow("shop");
    expect(b.contents.database).toBe(true);
    expect(backups.expectedContents("shop").database).toBe(true);

    // Change things after the backup…
    await ctx.documents!.withDatabase(apps.require("shop").documentDatabaseId!, async (c) => {
      await c.db("shop").collection("customers").deleteMany({});
      await c.db("shop").collection("suppliers").drop();
      await c.db("shop").collection("junk").insertOne({ x: 1 });
    });

    // …then restore the database part.
    await expect(backups.restore("shop", b.id, ["database"], "wrong")).rejects.toThrow(/type the application name/);
    const r = await backups.restore("shop", b.id, ["database"], "Shop");
    expect(r.restored).toEqual(["database"]);
    expect(r.safetyBackupId).toBeTruthy();

    const cols = (await call("GET", `/api/v1/documents/${id}/collections`)).body.map((c: { name: string }) => c.name);
    expect(cols).toEqual(["customers", "orders", "projects", "suppliers"]);
    await ctx.documents!.withDatabase(apps.require("shop").documentDatabaseId!, async (c) => {
      const grace = await c.db("shop").collection("customers").findOne({ name: "Grace" });
      expect(grace?.orders).toBe(12);
      expect(grace?._id.constructor.name).toBe("ObjectId");
      const idx = await c.db("shop").collection("customers").indexes();
      expect(idx.find((i) => i.name === "by_name")).toMatchObject({ unique: true, key: { name: 1 } });
    });
    // The app's own login survived the restore.
    const info = ctx.documents!.connectionInfo(id, "shop");
    expect(await ctx.documents!.testConnection(info)).toEqual({ ok: true });
    expect(apps.status("shop")).toBe("running");
  }, 180_000);

  it("deleting a collection needs its name typed", async () => {
    expect((await call("DELETE", `${base()}/collections/suppliers`, { confirmation: "nope" })).status).toBe(400);
    expect((await call("DELETE", `${base()}/collections/suppliers`, { confirmation: "suppliers" })).status).toBe(200);
  });
});
