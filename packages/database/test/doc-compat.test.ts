import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoClient, ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StateStore } from "@nexus/state";
import { SecretVault } from "@nexus/security";
import { PortAllocator } from "@nexus/network";
import { CompatibleDocumentEngine, DocumentDatabaseManager, FerretDbFleet, locateFerretDb, type PostgresEngine } from "@nexus/database";
import { PG_BIN, startTestCluster } from "./pg-harness";

const FERRET = locateFerretDb({ bundledRoots: [join(__dirname, "..", "..", "..", "vendor", "ferretdb")] });

describe.runIf(!!FERRET && !!PG_BIN)("MongoDB compatibility layer in front of FerretDB", () => {
  let pg: PostgresEngine;
  let disposePg: () => Promise<void>;
  let engine: CompatibleDocumentEngine;
  let mgr: DocumentDatabaseManager;
  let client: MongoClient;
  const dir = mkdtempSync(join(tmpdir(), "nexus-compat-"));
  const owner = new ObjectId();
  const other = new ObjectId();

  beforeAll(async () => {
    ({ engine: pg, dispose: disposePg } = await startTestCluster());
    const store = StateStore.memory();
    const vault = SecretVault.withKey(store, randomBytes(32));
    const base = 30000 + Math.floor(Math.random() * 9000);
    const ports = new PortAllocator(store, { rangeStart: base, rangeEnd: base + 50 });
    const fleet = new FerretDbFleet({ bin: FERRET!, pgPort: () => pg.port, stateDir: join(dir, "state") });
    engine = new CompatibleDocumentEngine(fleet, async (db, ours) => (await ports.ensureAvailable("ferretdb-engine", db, ours)).port);
    mgr = new DocumentDatabaseManager(store, vault, pg, engine, ports);
    const { connection } = await mgr.createDatabase({ displayName: "Site", appId: "site" });
    client = new MongoClient(connection!.url, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    const db = client.db("site");
    await db.collection("visitors").insertMany([
      { owner, visitCount: 3, totalEngagementMs: 45_000, city: "Cairo" },
      { owner, visitCount: 1, totalEngagementMs: 10_000, city: "" },
      { owner: other, visitCount: 7, totalEngagementMs: 90_000, city: null },
      { owner: other, visitCount: 1, totalEngagementMs: 31_000, city: "Unknown" },
    ]);
    await db.collection("owners").insertMany([{ _id: owner, name: "Mohamed" }, { _id: other, name: "Guest" }]);
  }, 180_000);

  afterAll(async () => {
    await client?.close();
    await engine?.stop();
    await disposePg?.();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }, 60_000);

  it("runs a $group with $cond (which FerretDB doesn't implement) — the app gets MongoDB's answer", async () => {
    const [summary] = await client
      .db("site")
      .collection("visitors")
      .aggregate([
        {
          $group: {
            _id: null,
            totalUniqueVisitors: { $sum: 1 },
            totalVisits: { $sum: "$visitCount" },
            returningVisitors: { $sum: { $cond: [{ $gt: ["$visitCount", 1] }, 1, 0] } },
            engagedVisitors: { $sum: { $cond: [{ $gte: ["$totalEngagementMs", 30000] }, 1, 0] } },
            cityResolvedVisitors: { $sum: { $cond: [{ $and: [{ $ne: ["$city", null] }, { $ne: ["$city", ""] }, { $ne: ["$city", "Unknown"] }] }, 1, 0] } },
          },
        },
      ])
      .toArray();
    expect(summary).toEqual({ _id: null, totalUniqueVisitors: 4, totalVisits: 12, returningVisitors: 2, engagedVisitors: 3, cityResolvedVisitors: 1 });
  }, 60_000);

  it("keeps a leading $match, groups by ObjectId and joins with $lookup", async () => {
    const rows = await client
      .db("site")
      .collection("visitors")
      .aggregate([
        { $match: { visitCount: { $gte: 1 } } },
        { $group: { _id: "$owner", visits: { $sum: "$visitCount" }, returning: { $sum: { $cond: [{ $gt: ["$visitCount", 1] }, 1, 0] } } } },
        { $lookup: { from: "owners", localField: "_id", foreignField: "_id", as: "who" } },
        { $project: { _id: 0, name: { $arrayElemAt: ["$who.name", 0] }, visits: 1, returning: 1 } },
        { $sort: { visits: -1 } },
      ])
      .toArray();
    expect(rows).toEqual([
      { visits: 8, returning: 1, name: "Guest" },
      { visits: 4, returning: 1, name: "Mohamed" },
    ]);
    expect(engine.stats("docs_site")?.emulated).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it("passes everything FerretDB supports straight through (no emulation)", async () => {
    const before = engine.stats("docs_site")!.emulated;
    const c = client.db("site").collection("visitors");
    expect(await c.countDocuments({ visitCount: 1 })).toBe(2);
    expect(await c.aggregate([{ $group: { _id: null, n: { $sum: 1 } } }]).toArray()).toEqual([{ _id: null, n: 4 }]);
    await c.updateOne({ city: "Cairo" }, { $inc: { visitCount: 1 } });
    expect((await c.findOne({ city: "Cairo" }))?.visitCount).toBe(4);
    expect(engine.stats("docs_site")!.emulated).toBe(before);
  }, 60_000);

  it("also stands in for find, distinct and count when FerretDB can't run them", async () => {
    const c = client.db("site").collection("visitors");
    const before = engine.stats("docs_site")!.emulated;
    // $expr compares two fields of the same document: not implemented in FerretDB 1.x.
    const heavy = await c.find({ $expr: { $gt: ["$totalEngagementMs", { $multiply: ["$visitCount", 10_000] }] } }, { projection: { _id: 0, city: 1 } }).sort({ city: 1 }).toArray();
    // Engagement above 10 s per visit: Cairo (45 s / 4 visits), the null city (90 s / 7), Unknown (31 s / 1).
    expect(heavy).toEqual([{ city: null }, { city: "Cairo" }, { city: "Unknown" }]);
    const counted = await c.countDocuments({ $expr: { $gte: ["$visitCount", 3] } });
    const owners = await c.distinct("owner", { $expr: { $gt: ["$visitCount", 1] } });
    expect({ counted, owners: owners.length }).toEqual({ counted: 2, owners: 2 });
    expect(engine.stats("docs_site")!.emulated).toBeGreaterThan(before);
  }, 60_000);

  it("never emulates writing stages", async () => {
    const out = client
      .db("site")
      .collection("visitors")
      .aggregate([{ $group: { _id: null, x: { $sum: { $cond: [true, 1, 0] } } } }, { $out: "copy" }])
      .toArray();
    await expect(out).rejects.toThrow();
  }, 60_000);
});
