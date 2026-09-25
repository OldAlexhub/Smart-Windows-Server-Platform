import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StateStore } from "@nexus/state";
import { SecretVault } from "@nexus/security";
import { PortAllocator } from "@nexus/network";
import { DocumentDatabaseManager, FerretDbFleet, locateFerretDb, planDocumentWiring, type ConnectionInfo, type PostgresEngine } from "@nexus/database";
import type { DatabaseRequirement } from "@nexus/detection";
import { PG_BIN, startTestCluster } from "./pg-harness";

const FERRET = locateFerretDb({ bundledRoots: [join(__dirname, "..", "..", "..", "vendor", "ferretdb")] });

describe("document engine basics", () => {
  it("uses the bundled FerretDB build, or one an administrator chose", () => {
    const dir = mkdtempSync(join(tmpdir(), "nexus-fbin-"));
    try {
      mkdirSync(join(dir, "ferretdb", "1.24.2"), { recursive: true });
      writeFileSync(join(dir, "ferretdb", "1.24.2", "ferretdb.exe"), "");
      expect(locateFerretDb({ bundledRoots: [join(dir, "ferretdb")] })).toMatchObject({ version: "1.24.2", source: "bundled" });
      writeFileSync(join(dir, "ferretdb-1.25.0.exe"), "");
      expect(locateFerretDb({ configured: join(dir, "ferretdb-1.25.0.exe"), bundledRoots: [join(dir, "ferretdb")] })).toMatchObject({ version: "1.25.0", source: "configured" });
      expect(locateFerretDb({ bundledRoots: [join(dir, "none")] })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps each endpoint private: loopback only, one database, no telemetry", () => {
    const args = FerretDbFleet.args({ pgPort: 43100, pgDatabase: "docs_shop", port: 43200, stateDir: "D:\\x" });
    expect(args).toContain("--listen-addr=127.0.0.1:43200");
    expect(args).toContain("--postgresql-url=postgres://127.0.0.1:43100/docs_shop");
    expect(args).toContain("--telemetry=disable");
  });

  it("wires every MongoDB variable the app reads", () => {
    const info: ConnectionInfo = { host: "127.0.0.1", port: 43100, database: "shop", user: "d_shop_app", password: "pw", url: "mongodb://d_shop_app:pw@127.0.0.1:43100/shop?authMechanism=PLAIN" };
    const req: DatabaseRequirement = {
      required: true,
      kind: "mongodb",
      evidence: [],
      libraries: ["Mongoose"],
      patterns: [
        { kind: "url", vars: { url: "MONGO_URI" }, confidence: 0.9, sources: [] },
        { kind: "discrete", vars: { host: "MONGO_HOST", name: "MONGO_DB", password: "MONGO_PASSWORD" }, confidence: 0.7, sources: [] },
      ],
    };
    expect(planDocumentWiring(req, info).env).toEqual({ MONGO_URI: info.url, MONGO_HOST: "127.0.0.1", MONGO_DB: "shop", MONGO_PASSWORD: "pw" });
  });
});

describe.runIf(!!FERRET && !!PG_BIN)("document databases on FerretDB + PostgreSQL", () => {
  let pg: PostgresEngine;
  let disposePg: () => Promise<void>;
  let fleet: FerretDbFleet;
  let mgr: DocumentDatabaseManager;
  let store: StateStore;
  let vault: SecretVault;
  const dir = mkdtempSync(join(tmpdir(), "nexus-ferret-"));
  const client = async (url: string) => {
    const c = new MongoClient(url, { serverSelectionTimeoutMS: 5000 });
    await c.connect();
    return c;
  };

  beforeAll(async () => {
    ({ engine: pg, dispose: disposePg } = await startTestCluster());
    store = StateStore.memory();
    vault = SecretVault.withKey(store, randomBytes(32));
    const base = 30000 + Math.floor(Math.random() * 9000);
    const ports = new PortAllocator(store, { rangeStart: base, rangeEnd: base + 50 });
    fleet = new FerretDbFleet({ bin: FERRET!, pgPort: () => pg.port, stateDir: join(dir, "state") });
    mgr = new DocumentDatabaseManager(store, vault, pg, fleet, ports);
  }, 180_000);
  afterAll(async () => {
    await fleet?.stop();
    await disposePg?.();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }, 60_000);

  let shop: ConnectionInfo;
  let crm: ConnectionInfo;

  it("gives each app its own database that works with the MongoDB driver", async () => {
    const created = await mgr.createDatabase({ displayName: "Shop Orders", appId: "shop" });
    shop = created.connection!;
    expect(created.database).toMatchObject({ name: "Shop Orders", dbName: "shop_orders", engine: "mongodb", appIds: ["shop"] });
    expect(shop.url).toMatch(/^mongodb:\/\/d_shop_orders_shop:[A-Za-z0-9]{32}@127\.0\.0\.1:\d+\/shop_orders\?authMechanism=PLAIN/);
    expect(await mgr.testConnection(shop)).toEqual({ ok: true });

    const c = await client(shop.url);
    try {
      const orders = c.db("shop_orders").collection("orders");
      await orders.insertMany([{ sku: "A1", qty: 2, at: new Date("2026-01-02") }, { sku: "B2", qty: 5, tags: ["x"] }]);
      await orders.createIndex({ sku: 1 });
      await orders.updateOne({ sku: "A1" }, { $inc: { qty: 1 } });
      expect(await orders.findOne({ sku: "A1" }, { projection: { _id: 0, qty: 1 } })).toEqual({ qty: 3 });
      expect(await orders.countDocuments({ qty: { $gt: 2 } })).toBe(2);
      expect(await orders.aggregate([{ $group: { _id: null, total: { $sum: "$qty" } } }]).toArray()).toEqual([{ _id: null, total: 8 }]);
    } finally {
      await c.close();
    }
  }, 120_000);

  it("keeps apps apart: no access to another app's data or even its collection names", async () => {
    crm = (await mgr.createDatabase({ displayName: "Crm", appId: "crm" })).connection!;
    const crmClient = await client(crm.url);
    await crmClient.db("crm").collection("contacts").insertOne({ name: "Ada" });
    await crmClient.close();

    const shopClient = await client(shop.url);
    try {
      // Through its own endpoint, another name is just an empty database of its own.
      expect(await shopClient.db("crm").listCollections().toArray()).toEqual([]);
      expect((await shopClient.db("admin").command({ listDatabases: 1, nameOnly: true })).databases.map((d: { name: string }) => d.name)).not.toContain("crm");
    } finally {
      await shopClient.close();
    }
    // Using its credentials on the other database's endpoint is refused by PostgreSQL.
    const sneaky = crm.url.replace(`${crm.user}:${encodeURIComponent(crm.password)}`, `${shop.user}:${encodeURIComponent(shop.password)}`).replace("/crm?", "/crm?");
    expect((await mgr.testConnection({ ...crm, url: sneaky })).ok).toBe(false);
    expect((await mgr.testConnection({ ...shop, url: shop.url.replace(shop.password, "wrong-password-000000000000000000") })).ok).toBe(false);
  }, 120_000);

  it("lets two applications share a database and see the same documents", async () => {
    const db = mgr.findByApp("shop")!;
    const reports = await mgr.grantAppAccess(db.id, "reports");
    const c = await client(reports.url);
    try {
      expect(await c.db("shop_orders").collection("orders").countDocuments()).toBe(2);
      await c.db("shop_orders").collection("summaries").insertOne({ day: 1 });
    } finally {
      await c.close();
    }
    const s = await client(shop.url);
    try {
      expect(await s.db("shop_orders").collection("summaries").countDocuments()).toBe(1);
    } finally {
      await s.close();
    }
    expect(mgr.get(db.id)!.appIds.sort()).toEqual(["reports", "shop"]);
    // Nexus (browsing, backups) sees what the apps created.
    const names = await mgr.withDatabase(db.id, async (cl, name) => (await cl.db(name).listCollections({}, { nameOnly: true }).toArray()).map((x) => x.name).sort());
    expect(names).toEqual(["_nexus", "orders", "summaries"]);
    expect(await mgr.withDatabase(db.id, (cl, name) => cl.db(name).collection("orders").countDocuments())).toBe(2);
  }, 120_000);

  it("repairs a connection with a new password and revokes access cleanly", async () => {
    const db = mgr.findByApp("shop")!;
    const before = mgr.connectionInfo(db.id, "shop");
    const after = await mgr.rotatePassword(db.id, "shop");
    expect(after.password).not.toBe(before.password);
    expect((await mgr.testConnection(before)).ok).toBe(false);
    expect(await mgr.testConnection(after)).toEqual({ ok: true });
    await mgr.revokeAppAccess(db.id, "reports");
    expect(() => mgr.connectionInfo(db.id, "reports")).toThrow();
    shop = after;
  }, 120_000);

  it("comes back after its process stops unexpectedly, and replaces one left from an earlier run", async () => {
    const db = mgr.findByApp("shop")!;
    await mgr.ensureRunning(db.id);
    const pidFile = join(dir, "state", "docs_shop_orders", "ferretdb.pid");
    expect(existsSync(pidFile)).toBe(true);
    await fleet.stopOne("docs_shop_orders");
    expect(await mgr.testConnection(shop)).toEqual({ ok: true }); // restarted on demand

    // A second fleet (Nexus restarted) finds the old process by its pid file and replaces it.
    const fleet2 = new FerretDbFleet({ bin: FERRET!, pgPort: () => pg.port, stateDir: join(dir, "state") });
    await fleet2.ensure("docs_shop_orders", shop.port);
    const c = await client(shop.url);
    expect(await c.db("shop_orders").collection("orders").countDocuments()).toBe(2);
    await c.close();
    await fleet2.stop();
    await mgr.ensureRunning(db.id);
  }, 120_000);

  it("deletes a database only with its name typed, and nothing is left behind", async () => {
    const db = mgr.findByApp("crm")!;
    await expect(mgr.dropDatabase(db.id, "nope")).rejects.toThrow('Type "Crm"');
    await mgr.dropDatabase(db.id, "Crm");
    expect(mgr.get(db.id)).toBeUndefined();
    expect(await pg.adminQuery("select 1 from pg_database where datname = 'docs_crm'")).toEqual([]);
    expect(await pg.adminQuery("select rolname from pg_roles where rolname like 'd_crm%' or rolname = 'docs_crm_owner'")).toEqual([]);
  }, 120_000);
});
