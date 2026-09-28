import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Decimal128, MongoClient, ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PortAllocator } from "@nexus/network";
import { SecretVault } from "@nexus/security";
import { StateStore } from "@nexus/state";
import {
  DocumentDatabaseManager,
  locateMongoDb,
  MongoDbFleet,
  mongoAdminSecret,
  mongoKeyFileSecret,
  type ConnectionInfo,
} from "@nexus/database";

const MONGO = locateMongoDb({ bundledRoots: [join(__dirname, "..", "..", "..", "vendor", "mongodb")] });

describe("MongoDB replica-set engine basics", () => {
  it("locates the newest bundle and binds replica sets to loopback", () => {
    const dir = mkdtempSync(join(tmpdir(), "nexus-mongo-bin-"));
    try {
      mkdirSync(join(dir, "8.0.5", "bin"), { recursive: true });
      mkdirSync(join(dir, "8.0.26", "bin"), { recursive: true });
      writeFileSync(join(dir, "8.0.5", "bin", "mongod.exe"), "");
      writeFileSync(join(dir, "8.0.26", "bin", "mongod.exe"), "");
      expect(locateMongoDb({ bundledRoots: [dir] })).toMatchObject({ version: "8.0.26", source: "bundled" });
      expect(MongoDbFleet.args({ dbPath: "D:\\data", port: 43123, replicaSet: "nexus_abc", logPath: "D:\\mongo.log", keyFile: "D:\\key" })).toEqual(expect.arrayContaining([
        "--bind_ip", "127.0.0.1", "--replSet", "nexus_abc", "--auth", "--keyFile", "D:\\key",
      ]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.runIf(!!MONGO)("managed MongoDB replica sets", () => {
  const dir = mkdtempSync(join(tmpdir(), "nexus-mongodb-"));
  let store: StateStore;
  let vault: SecretVault;
  let fleet: MongoDbFleet;
  let manager: DocumentDatabaseManager;
  let connection: ConnectionInfo;
  let databaseId: string;

  beforeAll(() => {
    store = StateStore.memory();
    vault = SecretVault.withKey(store, randomBytes(32));
    const base = 30000 + Math.floor(Math.random() * 9000);
    const ports = new PortAllocator(store, { rangeStart: base, rangeEnd: base + 100 });
    fleet = new MongoDbFleet({
      bin: MONGO!,
      stateDir: join(dir, "state"),
      credentials: (key) => ({
        username: "nexus_admin",
        password: vault.require(mongoAdminSecret(key)),
        keyFile: vault.require(mongoKeyFileSecret(key)),
      }),
    });
    manager = new DocumentDatabaseManager(store, vault, null, null, ports, fleet);
  });

  afterAll(async () => {
    await fleet?.stop();
    store?.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }, 60_000);

  it("creates a private authenticated replica set", async () => {
    const created = await manager.createDatabase({ displayName: "Orders", appId: "shop" });
    databaseId = created.database.id;
    connection = created.connection!;
    expect(created.database).toMatchObject({ provider: "mongodb", transactions: true, dbName: "orders", appIds: ["shop"] });
    expect(connection.url).toContain("replicaSet=nexus_");
    expect(connection.url).toContain("directConnection=true");

    const client = new MongoClient(connection.url, { serverSelectionTimeoutMS: 10_000 });
    await client.connect();
    try {
      const hello = await client.db("admin").command({ hello: 1 });
      expect(hello).toMatchObject({ isWritablePrimary: true });
      expect(hello.setName).toMatch(/^nexus_[0-9a-f]{16}$/);
    } finally {
      await client.close();
    }
  }, 120_000);

  it("commits and rolls back real multi-document transactions", async () => {
    const client = new MongoClient(connection.url, { serverSelectionTimeoutMS: 10_000 });
    await client.connect();
    try {
      const db = client.db(connection.database);
      const session = client.startSession();
      try {
        await session.withTransaction(async () => {
          await db.collection("orders").insertOne({ order: 1 }, { session });
          await db.collection("ledger").insertOne({ order: 1, amount: 25 }, { session });
        });
        expect(await db.collection("orders").countDocuments({ order: 1 })).toBe(1);
        expect(await db.collection("ledger").countDocuments({ order: 1 })).toBe(1);

        await expect(session.withTransaction(async () => {
          await db.collection("orders").insertOne({ order: 2 }, { session });
          await db.collection("ledger").insertOne({ order: 2, amount: 90 }, { session });
          throw new Error("cancel order");
        })).rejects.toThrow("cancel order");
        expect(await db.collection("orders").countDocuments({ order: 2 })).toBe(0);
        expect(await db.collection("ledger").countDocuments({ order: 2 })).toBe(0);
      } finally {
        await session.endSession();
      }
    } finally {
      await client.close();
    }
  }, 120_000);

  it("preserves native BSON values and data across a restart", async () => {
    const id = new ObjectId();
    const at = new Date("2026-09-28T12:34:56.789Z");
    const amount = Decimal128.fromString("1234567890.123456789012345678");
    let client = new MongoClient(connection.url, { serverSelectionTimeoutMS: 10_000 });
    await client.connect();
    await client.db(connection.database).collection("types").insertOne({ _id: id, at, amount });
    await client.close();

    await fleet.stopOne(`mongo_${connection.database}`);
    await manager.ensureRunning(databaseId);
    client = new MongoClient(connection.url, { serverSelectionTimeoutMS: 10_000 });
    await client.connect();
    try {
      const found = await client.db(connection.database).collection("types").findOne({ _id: id });
      expect(found?._id).toEqual(id);
      expect(found?.at).toEqual(at);
      expect((found?.amount as Decimal128).toString()).toBe(amount.toString());
    } finally {
      await client.close();
    }
  }, 120_000);

  it("rotates and revokes per-application credentials", async () => {
    const old = connection;
    connection = await manager.rotatePassword(databaseId, "shop");
    expect(connection.password).not.toBe(old.password);
    expect((await manager.testConnection(old)).ok).toBe(false);
    expect(await manager.testConnection(connection)).toEqual({ ok: true });
    await manager.revokeAppAccess(databaseId, "shop");
    expect((await manager.testConnection(connection)).ok).toBe(false);
    expect(manager.require(databaseId).appIds).toEqual([]);
  }, 120_000);

  it("removes the isolated replica set when the database is deleted", async () => {
    await manager.dropDatabase(databaseId, "Orders");
    expect(manager.get(databaseId)).toBeUndefined();
    expect(fleet.running()).toEqual([]);
  }, 60_000);
});
