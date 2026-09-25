import type { FastifyInstance } from "fastify";
import { MongoClient } from "mongodb";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inSubnet, SubnetRelay } from "@nexus/network";
import type { NexusContext } from "../src/context";
import { authRoutes } from "../src/http/routes/auth";
import { databaseLinkRoutes } from "../src/http/routes/database-links";
import { buildServer } from "../src/http/server";
import { AppManager } from "../src/services/apps";
import { DatabaseLinkService } from "../src/services/database-links";
import { GatewayService } from "../src/services/gateway";
import { PrivateNetworkService } from "../src/services/private-network";
import { createContext, tempHome } from "./helpers";
import { ownerClient } from "./helpers-http";

describe("private-network relay", () => {
  it("knows which addresses are inside the network", () => {
    expect(inSubnet("10.73.0.2", "10.73.0.0/24")).toBe(true);
    expect(inSubnet("::ffff:10.73.0.9", "10.73.0.0/24")).toBe(true);
    expect(inSubnet("10.73.1.2", "10.73.0.0/24")).toBe(false);
    expect(inSubnet("192.168.0.9", "10.73.0.0/24")).toBe(false);
    expect(inSubnet("garbage", "10.73.0.0/24")).toBe(false);
  });

  it("hangs up on anyone outside the network", async () => {
    const refused: string[] = [];
    const relay = new SubnetRelay({ listenPort: 0, allowCidr: "10.73.0.0/24", target: async () => ({ host: "127.0.0.1", port: 1 }), onRefused: (a) => refused.push(a) });
    // listenPort 0 isn't used by start(); pick a free one instead.
    const port = 40000 + Math.floor(Math.random() * 2000);
    (relay as unknown as { opts: { listenPort: number } }).opts.listenPort = port;
    await relay.start();
    const net = await import("node:net");
    await new Promise<void>((resolve) => {
      const s = net.createConnection(port, "127.0.0.1");
      s.on("close", () => resolve());
      s.on("error", () => resolve());
    });
    await relay.stop();
    expect(refused.length).toBe(1);
  });
});

let ctx: NexusContext;
let app: FastifyInstance;
let dispose: () => void;
let call: Awaited<ReturnType<typeof ownerClient>>;

beforeAll(async () => {
  const t = tempHome();
  dispose = t.dispose;
  ctx = await createContext(t.home, { setup: true });
  const gateway = new GatewayService(ctx);
  const links = new DatabaseLinkService(ctx, new PrivateNetworkService(ctx, gateway, new AppManager(ctx, gateway)));
  ctx.onStop(() => links.stop());
  app = await buildServer(ctx, [authRoutes, databaseLinkRoutes(links)]);
  call = await ownerClient(app, ctx);
}, 240_000);

afterAll(async () => {
  await app?.close();
  await ctx?.shutdown();
  dispose?.();
}, 120_000);

describe("connect to a database from another server (private network only)", () => {
  it("needs the private network first", async () => {
    const { database } = await ctx.databases!.createDatabase({ displayName: "Shop" });
    const r = await call("GET", `/api/v1/database-links/tables/${database.id}`);
    expect(r.body).toMatchObject({ available: false, enabled: false });
    expect(r.body.blocker).toMatch(/private network first/);
    expect((await call("POST", `/api/v1/database-links/tables/${database.id}`)).status).toBe(409);
  });

  it("shares a table database: its own login, this database only, new password, stop sharing", async () => {
    // For the test, this computer's loopback plays the private network.
    ctx.settings.set("privateNetwork", { enabled: true, subnet: { base: "127.0.0" } });
    const shop = ctx.databases!.list().find((d) => d.name === "Shop")!;
    const other = (await ctx.databases!.createDatabase({ displayName: "Payroll" })).database;
    await ctx.databases!.withOwner(shop.id, (c) => c.query("CREATE TABLE items (id int primary key, name text); INSERT INTO items VALUES (1, 'Lamp')"));

    const shared = await call("POST", `/api/v1/database-links/tables/${shop.id}`);
    expect(shared.status).toBe(200);
    expect(shared.body.url).toMatch(/^postgres:\/\/[^:]+:[^@•]+@127\.0\.0\.1:\d+\/shop$/);
    expect((await call("GET", `/api/v1/database-links/tables/${shop.id}`)).body.url).toContain("••••••••");

    const q = async (url: string, sql: string) => {
      const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
      await c.connect();
      try {
        return (await c.query(sql)).rows;
      } finally {
        await c.end();
      }
    };
    expect(await q(shared.body.url, "SELECT name FROM items")).toEqual([{ name: "Lamp" }]);
    // The link's login can't open another database through the same relay.
    await expect(q(shared.body.url.replace(/\/shop$/, `/${other.dbName}`), "SELECT 1")).rejects.toThrow(/permission denied|not permitted|no pg_hba|authentication/i);

    const rotated = await call("POST", `/api/v1/database-links/tables/${shop.id}/rotate`);
    await expect(q(shared.body.url, "SELECT 1")).rejects.toThrow(/password authentication failed/);
    expect(await q(rotated.body.url, "SELECT count(*)::int AS n FROM items")).toEqual([{ n: 1 }]);

    expect((await call("DELETE", `/api/v1/database-links/tables/${shop.id}`)).status).toBe(200);
    await expect(q(rotated.body.url, "SELECT 1")).rejects.toThrow();
    expect((await call("GET", `/api/v1/database-links/tables/${shop.id}`)).body.enabled).toBe(false);
  }, 120_000);

  it.runIf(() => !!ctx.documents)("shares a document database through the compatibility layer", async () => {
    const docs = ctx.documents!;
    const { database } = await docs.createDatabase({ displayName: "Site" });
    const shared = await call("POST", `/api/v1/database-links/documents/${database.id}`);
    expect(shared.body.url).toMatch(/^mongodb:\/\/.+@127\.0\.0\.1:\d+\/site\?authMechanism=PLAIN/);
    const c = new MongoClient(shared.body.url, { serverSelectionTimeoutMS: 5000 });
    await c.connect();
    try {
      const col = c.db("site").collection("visits");
      await col.insertMany([{ n: 3 }, { n: 1 }]);
      // $cond in $group works here too (emulated by Nexus).
      expect(await col.aggregate([{ $group: { _id: null, many: { $sum: { $cond: [{ $gt: ["$n", 1] }, 1, 0] } } } }]).toArray()).toEqual([{ _id: null, many: 1 }]);
    } finally {
      await c.close();
    }
    await call("DELETE", `/api/v1/database-links/documents/${database.id}`);
  }, 180_000);
});
