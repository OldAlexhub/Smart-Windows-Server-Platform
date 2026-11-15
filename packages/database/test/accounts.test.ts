import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StateStore } from "@nexus/state";
import { SecretVault } from "@nexus/security";
import { DatabaseManager, DatabaseAccountManager, type PostgresEngine } from "@nexus/database";
import { PG_BIN, startTestCluster } from "./pg-harness";

describe.runIf(!!PG_BIN)("isolated human database accounts (real PostgreSQL)", () => {
  let engine: PostgresEngine, dispose: () => Promise<void>, dbs: DatabaseManager, accounts: DatabaseAccountManager, store: StateStore;
  let id: string, other: string, reader: { username: string; password: string }, writer: { username: string; password: string };
  async function connect(account: typeof reader, database = "products") {
    const client = new pg.Client({ host: "127.0.0.1", port: engine.port, user: account.username, password: account.password, database, connectionTimeoutMillis: 3000 });
    try { await client.connect(); return client; } catch (error) { await client.end(); throw error; }
  }
  beforeAll(async () => {
    ({ engine, dispose } = await startTestCluster()); store = StateStore.memory();
    const vault = SecretVault.withKey(store, randomBytes(32)); dbs = new DatabaseManager(store, vault, engine); await dbs.hardenCluster();
    id = (await dbs.createDatabase({ displayName: "Products" })).database.id;
    other = (await dbs.createDatabase({ displayName: "Private" })).database.id;
    accounts = new DatabaseAccountManager(store, vault, engine, dbs);
    await dbs.withOwner(id, (c) => c.query("CREATE TABLE products (id serial primary key, name text); INSERT INTO products(name) VALUES ('first')"));
    reader = await accounts.create(id, { username: "report_reader", mode: "read-only" });
    writer = await accounts.create(id, { username: "product_editor", mode: "read-write" });
  }, 180_000);
  afterAll(async () => { await dispose?.(); store?.close(); }, 60_000);
  it("restricts the reader to one database and never lets it assume the owner role", async () => {
    const c = await connect(reader);
    try {
      expect((await c.query("SELECT name FROM products")).rows).toEqual([{ name: "first" }]);
      await expect(c.query("INSERT INTO products(name) VALUES ('bad')")).rejects.toThrow(/permission denied/);
      await expect(c.query("SET ROLE products_owner")).rejects.toThrow(/permission denied/);
      await expect(c.query("DROP TABLE products")).rejects.toThrow();
    } finally { await c.end(); }
    for (const database of ["private", "postgres", "template1"]) await expect(connect(reader, database)).rejects.toThrow(/permission denied|CONNECT/);
  });
  it("allows data writes and future tables, but no schema administration", async () => {
    await dbs.withOwner(id, (c) => c.query("CREATE TABLE future (id serial primary key, value text)"));
    const c = await connect(writer);
    try {
      await c.query("INSERT INTO future(value) VALUES ('new')");
      await expect(c.query("CREATE TABLE forbidden (x int)")).rejects.toThrow(/permission denied/);
      await expect(c.query("DROP TABLE future")).rejects.toThrow();
    } finally { await c.end(); }
    const r = await connect(reader); try { expect((await r.query("SELECT value FROM future")).rows[0].value).toBe("new"); } finally { await r.end(); }
  });
  it("scopes rotation, invalidates old passwords, and revokes active sessions without losing data", async () => {
    await expect(accounts.rotate(other, reader.username)).rejects.toThrow(/not found/);
    const before = reader; reader = await accounts.rotate(id, reader.username);
    await expect(connect(before)).rejects.toThrow(/authentication/);
    const c = await connect(reader); c.on("error", () => {});
    await accounts.revoke(id, reader.username);
    await expect(c.query("SELECT 1")).rejects.toThrow(); await c.end();
    await expect(connect(reader)).rejects.toThrow();
    expect(await dbs.withOwner(id, async (c) => (await c.query("SELECT count(*)::int AS n FROM products")).rows[0].n)).toBe(1);
    expect(JSON.stringify(accounts.list(id))).not.toContain(writer.password);
  });
  it("rejects reserved and injected usernames", async () => {
    for (const username of ["postgres", "nexus_admin", "pg_reader", "x'; DROP DATABASE products;--"]) await expect(accounts.create(id, { username, mode: "read-only" })).rejects.toThrow();
  });
  it("reapplies active accounts after schema replacement and keeps revoked accounts disabled", async () => {
    await dbs.withOwner(id, (c) => c.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public AUTHORIZATION products_owner; REVOKE ALL ON SCHEMA public FROM PUBLIC; CREATE TABLE restored (id serial primary key, value text)"));
    await accounts.reapply(id);
    const c = await connect(writer);
    try { await c.query("INSERT INTO restored(value) VALUES ('after restore')"); } finally { await c.end(); }
    await expect(connect(reader)).rejects.toThrow();
    await dbs.dropDatabase(id, "Products");
    expect(await engine.adminQuery("SELECT 1 FROM pg_roles WHERE rolname = $1", [writer.username])).toEqual([]);
  });
});
