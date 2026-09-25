import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StateStore } from "@nexus/state";
import { SecretVault } from "@nexus/security";
import { DatabaseManager, generateDbPassword, type ConnectionInfo, type PostgresEngine } from "@nexus/database";
import { PG_BIN, startTestCluster } from "./pg-harness";

describe("generateDbPassword", () => {
  it("is long, random and URL-safe", () => {
    const a = generateDbPassword();
    expect(a).toHaveLength(32);
    expect(a).toMatch(/^[A-Za-z0-9]+$/);
    expect(encodeURIComponent(a)).toBe(a);
    expect(new Set(Array.from({ length: 50 }, () => generateDbPassword())).size).toBe(50);
  });
});

async function connect(info: ConnectionInfo, database = info.database) {
  const c = new pg.Client({ host: info.host, port: info.port, user: info.user, password: info.password, database, connectionTimeoutMillis: 5000 });
  await c.connect();
  return c;
}

describe.runIf(!!PG_BIN)("DatabaseManager (real PostgreSQL)", () => {
  let engine: PostgresEngine;
  let dispose: () => Promise<void>;
  let mgr: DatabaseManager;
  let vault: SecretVault;
  let store: StateStore;

  beforeAll(async () => {
    ({ engine, dispose } = await startTestCluster());
    store = StateStore.memory();
    vault = SecretVault.withKey(store, randomBytes(32));
    mgr = new DatabaseManager(store, vault, engine);
    await mgr.hardenCluster();
  }, 180_000);
  afterAll(async () => dispose?.(), 60_000);

  it("creates a database, its roles and app credentials from just a name", async () => {
    const { database, connection } = await mgr.createDatabase({ displayName: "TaxiOps", appId: "taxiops" });
    expect(database).toMatchObject({ name: "TaxiOps", dbName: "taxiops", ownerRole: "taxiops_owner", readonlyRole: "taxiops_ro", appIds: ["taxiops"] });
    expect(connection!.url).toBe(`postgresql://taxiops_taxiops:${connection!.password}@127.0.0.1:${engine.port}/taxiops`);
    expect(vault.list("app:taxiops").map((s) => s.name)).toEqual([`db:${database.id}/app:taxiops/password`]);
    expect(await mgr.testConnection(connection!)).toEqual({ ok: true });

    // The app can run migrations and use its tables.
    const c = await connect(connection!);
    await c.query("CREATE TABLE drivers (id serial primary key, name text)");
    await c.query("INSERT INTO drivers (name) VALUES ('Ann')");
    const owner = await c.query("SELECT tableowner FROM pg_tables WHERE tablename = 'drivers'");
    expect(owner.rows[0].tableowner).toBe("taxiops_owner");
    await c.end();
  });

  it("app roles have least privilege", async () => {
    const info = mgr.connectionInfo(mgr.findByApp("taxiops")!.id, "taxiops");
    const c = await connect(info);
    const r = await c.query("SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user");
    expect(r.rows[0]).toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false });
    await expect(c.query("CREATE DATABASE sneaky")).rejects.toThrow(/permission denied/);
    await expect(c.query("CREATE ROLE sneaky")).rejects.toThrow(/permission denied/);
    await c.end();
    await expect(connect(info, "postgres")).rejects.toThrow(/permission denied|not have CONNECT/);
  });

  it("isolates applications from each other's databases", async () => {
    const { connection: finance } = await mgr.createDatabase({ displayName: "Finance", appId: "finance" });
    const taxi = mgr.connectionInfo(mgr.findByApp("taxiops")!.id, "taxiops");
    await expect(connect({ ...finance!, database: "taxiops" })).rejects.toThrow(/permission denied|CONNECT/);
    await expect(connect({ ...taxi, database: "finance" })).rejects.toThrow(/permission denied|CONNECT/);
  });

  it("read-only mode can read but never write", async () => {
    const id = mgr.findByApp("taxiops")!.id;
    const rows = await mgr.withReadOnly(id, async (c) => (await c.query("SELECT name FROM drivers")).rows);
    expect(rows).toEqual([{ name: "Ann" }]);
    await expect(mgr.withReadOnly(id, (c) => c.query("INSERT INTO drivers (name) VALUES ('x')"))).rejects.toThrow(/read-only transaction|permission denied/);
    await expect(mgr.withReadOnly(id, (c) => c.query("DELETE FROM drivers"))).rejects.toThrow();
    const count = await mgr.withOwner(id, async (c) => (await c.query("SELECT count(*)::int AS n FROM drivers")).rows[0].n);
    expect(count).toBe(1);
  });

  it("lets a second app share a database with its own credentials", async () => {
    const id = mgr.findByApp("taxiops")!.id;
    const reports = await mgr.grantAppAccess(id, "reports");
    expect(reports.user).toBe("taxiops_reports");
    expect(reports.password).not.toBe(mgr.connectionInfo(id, "taxiops").password);
    const c = await connect(reports);
    expect((await c.query("SELECT count(*)::int AS n FROM drivers")).rows[0].n).toBe(1);
    await c.end();
    expect(mgr.get(id)!.appIds.sort()).toEqual(["reports", "taxiops"]);
    await mgr.revokeAppAccess(id, "reports");
    expect(await mgr.testConnection(reports)).toMatchObject({ ok: false });
  });

  it("rotates passwords (Repair Connection)", async () => {
    const id = mgr.findByApp("taxiops")!.id;
    const before = mgr.connectionInfo(id, "taxiops");
    const after = await mgr.rotatePassword(id, "taxiops");
    expect(after.password).not.toBe(before.password);
    expect(await mgr.testConnection(before)).toMatchObject({ ok: false });
    expect(await mgr.testConnection(after)).toEqual({ ok: true });
  });

  it("gives unique names and refuses to drop without typed confirmation", async () => {
    const { database } = await mgr.createDatabase({ displayName: "TaxiOps" });
    expect(database.dbName).toBe("taxiops_2");
    await expect(mgr.dropDatabase(database.id, "yes")).rejects.toThrow(/Type "TaxiOps"/);
    await mgr.dropDatabase(database.id, "TaxiOps");
    expect(mgr.get(database.id)).toBeUndefined();
    const exists = await engine.adminQuery("SELECT 1 FROM pg_database WHERE datname = 'taxiops_2'");
    expect(exists).toHaveLength(0);
  });
});
