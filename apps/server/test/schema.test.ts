import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCreateTable } from "@nexus/database";
import type { NexusContext } from "../src/context";
import { authRoutes } from "../src/http/routes/auth";
import { schemaRoutes } from "../src/http/routes/schema";
import { buildServer } from "../src/http/server";
import { createContext, tempHome } from "./helpers";
import { ownerClient } from "./helpers-http";

let ctx: NexusContext;
let app: FastifyInstance;
let dispose: () => void;
let call: Awaited<ReturnType<typeof ownerClient>>;
let dbId: string;

const customers = {
  name: "customers",
  description: "People who buy from the shop",
  columns: [
    { name: "id", kind: "auto_id" },
    { name: "name", kind: "text", required: true },
    { name: "email", kind: "email", unique: true },
    { name: "created_at", kind: "timestamp", required: true, default: "now" },
  ],
};
const orders = {
  name: "orders",
  columns: [
    { name: "id", kind: "auto_id" },
    { name: "customer_id", kind: "big_integer", required: true, references: { table: "customers", column: "id", onDelete: "cascade" } },
    { name: "total", kind: "money", required: true, default: "0" },
    { name: "paid", kind: "boolean", default: "no" },
  ],
};

beforeAll(async () => {
  const t = tempHome();
  dispose = t.dispose;
  ctx = await createContext(t.home, { setup: true });
  app = await buildServer(ctx, [authRoutes, schemaRoutes]);
  call = await ownerClient(app, ctx);
  dbId = (await ctx.databases!.createDatabase({ displayName: "Shop" })).database.id;
}, 240_000);

afterAll(async () => {
  await app?.close();
  await ctx?.shutdown();
  dispose?.();
}, 120_000);

describe("table designer", () => {
  it("explains mistakes in plain words", () => {
    expect(() => buildCreateTable({ name: "Bad Name!", columns: [{ name: "id", kind: "auto_id" }] })).toThrow(/lowercase letters, numbers and underscores/);
    expect(() => buildCreateTable({ name: "notes", columns: [{ name: "body", kind: "text" }] })).toThrow(/Choose a key column/);
    expect(() => buildCreateTable({ name: "t", columns: [{ name: "id", kind: "auto_id" }, { name: "n", kind: "integer", default: "abc" }] })).toThrow(/must be a number/);
    expect(() => buildCreateTable({ name: "t", columns: [{ name: "id", kind: "auto_id" }, { name: "id", kind: "text" }] })).toThrow(/two columns called id/);
    expect(() => buildCreateTable({ name: "customers", columns: [{ name: "id", kind: "auto_id" }] }, ["customers"])).toThrow(/already exists/);
  });

  it("shows the SQL, then creates linked tables that enforce their rules", async () => {
    const preview = await call("POST", `/api/v1/databases/${dbId}/tables/preview`, customers);
    expect(preview.body.sql).toContain(`"id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL`);
    expect(preview.body.sql).toContain(`"created_at" timestamptz NOT NULL DEFAULT now()`);
    expect(preview.body.sql).toContain(`"email" text UNIQUE`);

    // A link to a table that doesn't exist yet is explained.
    const early = await call("POST", `/api/v1/databases/${dbId}/tables/create`, orders);
    expect(early.status).toBe(400);
    expect(early.body.error.message).toMatch(/linked table doesn't exist yet/);

    expect((await call("POST", `/api/v1/databases/${dbId}/tables/create`, customers)).status).toBe(200);
    const created = await call("POST", `/api/v1/databases/${dbId}/tables/create`, orders);
    expect(created.status).toBe(200);
    expect(created.body.sql).toContain(`CREATE INDEX "orders_customer_id_idx"`);

    await ctx.databases!.withOwner(dbId, async (c) => {
      const { rows } = await c.query(`INSERT INTO customers (name, email) VALUES ('Ada', 'ada@example.com') RETURNING id, created_at`);
      expect(rows[0].id).toBe("1");
      expect(rows[0].created_at).toBeInstanceOf(Date);
      await expect(c.query(`INSERT INTO customers (name, email) VALUES ('Bob', 'not-an-email')`)).rejects.toThrow(/customers_email_email/);
      await expect(c.query(`INSERT INTO customers (email) VALUES ('x@y.z')`)).rejects.toThrow(/null value/);
      await c.query(`INSERT INTO orders (customer_id) VALUES (1)`);
      expect((await c.query(`SELECT total, paid FROM orders`)).rows[0]).toEqual({ total: "0.00", paid: false });
      await expect(c.query(`INSERT INTO orders (customer_id) VALUES (99)`)).rejects.toThrow(/foreign key/);
      await c.query(`DELETE FROM customers WHERE id = 1`); // cascade removes the order
      expect((await c.query(`SELECT count(*)::int AS n FROM orders`)).rows[0].n).toBe(0);
    });
  }, 60_000);

  it("draws the blueprint: tables, keys, links, indexes and descriptions", async () => {
    const bp = await call("GET", `/api/v1/databases/${dbId}/blueprint`);
    expect(bp.body.database).toMatchObject({ name: "Shop", engine: "PostgreSQL", dbName: "shop" });
    expect(bp.body.schema.relations).toEqual([{ from: { table: "orders", column: "customer_id" }, to: { table: "customers", column: "id" }, onDelete: "cascade" }]);
    const cust = bp.body.schema.tables.find((t: { name: string }) => t.name === "customers");
    expect(cust.description).toBe("People who buy from the shop");
    expect(cust.columns.map((c: { name: string; primaryKey: boolean; unique: boolean }) => [c.name, c.primaryKey, c.unique])).toEqual([["id", true, false], ["name", false, false], ["email", false, true], ["created_at", false, false]]);
    expect(cust.columns[0].default).toBe("auto number");
    const ord = bp.body.schema.tables.find((t: { name: string }) => t.name === "orders");
    expect(ord.columns.find((c: { name: string }) => c.name === "customer_id").references).toEqual({ table: "customers", column: "id", onDelete: "cascade" });
    expect(ord.indexes.map((i: { name: string }) => i.name)).toContain("orders_customer_id_idx");
    expect(bp.body.connections).toEqual([]);
  });
});
