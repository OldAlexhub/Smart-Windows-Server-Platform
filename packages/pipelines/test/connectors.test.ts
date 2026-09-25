import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "@nexus/state";
import { BUILTIN_CONNECTORS, BUILTIN_TRANSFORMS, ExecutorRegistry, normalizePipeline, PipelineEngine, StepError, type ConnectorServices, type PipelineInput } from "@nexus/pipelines";
import type { PostgresEngine } from "@nexus/database";
import { PG_BIN, startTestCluster } from "../../database/test/pg-harness";

const EXT_DIR = join(__dirname, "..", "..", "..", "vendor", "duckdb-extensions", "1.5.5");
const hasExtensions = existsSync(join(EXT_DIR, "postgres_scanner.duckdb_extension"));

const root = mkdtempSync(join(tmpdir(), "nexus-conn-"));
const data = join(root, "data");
const forbidden = join(root, "nexus-home");
const storageRoot = join(root, "storage");
mkdirSync(data, { recursive: true });
mkdirSync(forbidden, { recursive: true });
writeFileSync(join(forbidden, "master.key"), "id\n1\n");

let pg: PostgresEngine | null = null;
let disposePg: (() => Promise<void>) | null = null;
const url = (db: string) => `postgresql://nexus_admin:test-superuser-password-123@127.0.0.1:${pg!.port}/${db}`;
const secrets: Record<string, string> = { "shop-api": "Bearer s3cret" };
let storageWriteCalls = 0;

const services: ConnectorServices = {
  extension: (name) => join(EXT_DIR, `${name}.duckdb_extension`),
  async database(ref) {
    if ("secret" in ref) return { url: secrets[ref.secret]!, label: "the external database" };
    return { url: url(ref.database.toLowerCase()), label: ref.database };
  },
  warehouse: async () => ({ url: url("warehouse"), label: "the Warehouse" }),
  storageFile: (app, path, access) => {
    if (access === "write") storageWriteCalls++;
    const full = resolve(storageRoot, app, path);
    mkdirSync(join(storageRoot, app), { recursive: true });
    return full;
  },
  checkPath(path) {
    if (resolve(path).toLowerCase().startsWith(forbidden.toLowerCase())) throw new StepError("Nexus's own files can't be used in pipelines.");
  },
  secret: (name) => secrets[name],
};

let delays: number[] = [];
const engine = () =>
  new PipelineEngine({ store: StateStore.memory(), workRoot: join(root, "runs"), executors: new ExecutorRegistry([...BUILTIN_TRANSFORMS, ...BUILTIN_CONNECTORS]), services, sleep: async (ms) => void delays.push(ms) });
let seq = 0;
const run = (def: PipelineInput, opts: Parameters<PipelineEngine["start"]>[1] = {}, e = engine()) => e.start({ id: `c${++seq}`, version: 1, definition: normalizePipeline(def) }, opts).done;

beforeEach(() => {
  delays = [];
  storageWriteCalls = 0;
});
afterAll(async () => {
  await disposePg?.();
  rmSync(root, { recursive: true, force: true });
}, 60_000);

describe.runIf(hasExtensions)("file connectors", () => {
  beforeAll(() => {
    writeFileSync(join(data, "trips_2025_01.csv"), "trip_id,zip,fare\n1,01234,12.50\n2,99999,3.25\n");
    writeFileSync(join(data, "trips_2025_02.csv"), "trip_id,zip,fare,driver\n3,01234,8.00,Ada\n");
  });

  it("reads many CSV files at once and converts between CSV, Parquet, Excel and JSON", async () => {
    const out = (f: string) => join(data, "out", f);
    const r = await run({
      name: "Files",
      steps: [
        { id: "trips", uses: "csv.read", with: { path: join(data, "trips_*.csv") } },
        { id: "pq", uses: "file.write", with: { path: out("trips.parquet") } },
        { id: "xl", uses: "file.write", needs: ["trips"], with: { path: out("trips.xlsx") } },
        { id: "js", uses: "file.write", needs: ["trips"], with: { path: out("trips.json") } },
      ],
    });
    expect(r.status).toBe("succeeded");
    expect(r.steps[0]!.output!.rows).toBe(3);
    expect(r.steps[0]!.output!.columns.map((c) => c.name)).toEqual(["trip_id", "zip", "fare", "driver"]);
    expect(JSON.parse(readFileSync(out("trips.json"), "utf8"))).toHaveLength(3);

    const back = await run({
      name: "Read back",
      steps: [
        { id: "xl", uses: "excel.read", with: { path: out("trips.xlsx") } },
        { id: "js", uses: "json.read", with: { path: out("trips.json") } },
        { id: "pq", uses: "parquet.read", with: { path: out("trips.parquet") } },
        { id: "all", uses: "sql", needs: ["xl", "js", "pq"], with: { query: "select (select count(*) from xl)::int as xl, (select count(*) from js)::int as js, (select count(*) from pq)::int as pq" } },
      ],
    });
    expect(back.error).toBeNull();
    expect(back.status).toBe("succeeded");
    expect(back.steps.map((s) => s.output?.rows)).toEqual([3, 3, 3, 1]);
  });

  it("reports a missing source file clearly and never touches Nexus's own files", async () => {
    const missing = await run({ name: "Missing", steps: [{ id: "f", uses: "csv.read", with: { path: join(data, "nope.csv") } }] });
    expect(missing.status).toBe("failed");
    expect(missing.error).toContain("doesn't exist");
    expect(missing.problem?.title).toBe("Source file missing");

    const sneaky = await run({ name: "Sneaky", steps: [{ id: "f", uses: "csv.read", with: { path: join(forbidden, "master.key") } }] });
    expect(sneaky.error).toContain("Nexus's own files can't be used in pipelines.");
    const relative = await run({ name: "Relative", steps: [{ id: "f", uses: "csv.read", with: { path: "trips.csv" } }] });
    expect(relative.error).toContain("Use a full path");
  });

  it("reads and writes files in an application's Nexus Storage", async () => {
    mkdirSync(join(storageRoot, "shop"), { recursive: true });
    writeFileSync(join(storageRoot, "shop", "prices.csv"), "sku,price\nA,1.5\nB,2\n");
    const r = await run({
      name: "Storage",
      steps: [
        { id: "in", uses: "storage.read", with: { app: "shop", path: "prices.csv" } },
        { id: "out", uses: "storage.write", with: { app: "shop", path: "exports/prices.parquet" } },
      ],
    });
    expect(r.status).toBe("succeeded");
    expect(existsSync(join(storageRoot, "shop", "exports", "prices.parquet"))).toBe(true);
  });

  it("reads SQLite tables and queries", async () => {
    const file = join(data, "legacy.db");
    const db = new DatabaseSync(file);
    db.exec("create table customers (id integer primary key, name text); insert into customers (name) values ('Ada'), ('Grace'), ('Linus');");
    db.close();
    const r = await run({
      name: "SQLite",
      steps: [
        { id: "all", uses: "sqlite.read", with: { path: file, table: "customers" } },
        { id: "some", uses: "sqlite.read", with: { path: file, query: "select name from customers where id > 1" } },
      ],
    });
    expect(r.status).toBe("succeeded");
    expect(r.steps.map((s) => s.output!.rows)).toEqual([3, 2]);
  });

  it("loads only rows after the saved watermark from SQLite", async () => {
    const file = join(data, "incremental.db");
    const db = new DatabaseSync(file);
    db.exec("create table events (id integer primary key, value text); insert into events values (1, 'one'), (2, 'two');");
    db.close();
    const e = engine();
    const def: PipelineInput = { name: "SQLite incremental", steps: [{ id: "events", uses: "sqlite.read", with: { path: file, table: "events", incremental: { column: "id" } } }] };
    const start = () => e.start({ id: "sqlite-incremental", version: 1, definition: normalizePipeline(def) }).done;
    const first = await start();
    expect(first.steps[0]).toMatchObject({ metrics: { rowsOut: 2 }, state: { watermark: { column: "id", value: "2" } } });
    const next = new DatabaseSync(file);
    next.exec("insert into events values (3, 'three')");
    next.close();
    const second = await start();
    expect(second.steps[0]).toMatchObject({ metrics: { rowsOut: 1 }, state: { watermark: { column: "id", value: "3" } } });
  });

  it("doesn't write anything in test mode", async () => {
    const target = join(data, "test-mode.csv");
    const r = await run({ name: "Test", steps: [{ id: "trips", uses: "csv.read", with: { path: join(data, "trips_*.csv") } }, { id: "save", uses: "file.write", with: { path: target } }] }, { testRows: 2 });
    expect(r.status).toBe("succeeded");
    expect(r.steps[0]!.output!.rows).toBe(2);
    expect(r.steps[1]!.metrics).toMatchObject({ rowsWritten: 0, extra: { wouldWrite: 2 } });
    expect(existsSync(target)).toBe(false);

    const storage = await run({ name: "Storage test", steps: [{ id: "trips", uses: "csv.read", with: { path: join(data, "trips_*.csv") } }, { id: "save", uses: "storage.write", with: { app: "dry-run", path: "exports/trips.json" } }] }, { testRows: 1 });
    expect(storage.steps[1]!.metrics).toMatchObject({ rowsWritten: 0, extra: { wouldWrite: 1 } });
    expect(storageWriteCalls).toBe(0);
    expect(existsSync(join(storageRoot, "dry-run"))).toBe(false);
  });
});

describe.runIf(hasExtensions && !!PG_BIN)("PostgreSQL and Warehouse connectors", () => {
  beforeAll(async () => {
    ({ engine: pg, dispose: disposePg } = await startTestCluster());
    await pg!.adminQuery("create database taxiops");
    await pg!.adminQuery("create database warehouse");
    await pg!.adminQuery("create table trips (id int primary key, zip text, fare numeric(10,2), status text, trip_date date)", [], "taxiops");
    await pg!.adminQuery(
      "insert into trips values (1, '01234', 12.50, 'Completed', '2025-01-05'), (2, '99999', 3.25, 'Cancelled', '2025-01-06'), (3, '01234', 8.00, 'Completed', '2025-02-01')",
      [],
      "taxiops",
    );
  }, 180_000);

  it("reads a table with exact types, and a query with parameters", async () => {
    const r = await run(
      {
        name: "PG read",
        params: [{ name: "since", type: "date" }],
        steps: [
          { id: "all", uses: "postgres.read", with: { connection: { database: "TaxiOps" }, table: "trips" } },
          { id: "recent", uses: "postgres.read", with: { connection: { database: "TaxiOps" }, query: "select id, fare from trips where trip_date >= '{{params.since}}' order by id" } },
        ],
      },
      { params: { since: "2025-01-06" } },
    );
    expect(r.status).toBe("succeeded");
    const cols = Object.fromEntries(r.steps[0]!.output!.columns.map((c) => [c.name, c.type]));
    expect(cols).toMatchObject({ id: "INTEGER", zip: "VARCHAR", fare: "DECIMAL(10,2)", trip_date: "DATE" });
    expect(r.steps[1]!.output!.rows).toBe(2);
  });

  it("loads the warehouse: create, replace (keeping views), append, upsert and new columns", async () => {
    const load = (mode: string, extra: Record<string, unknown> = {}, where = "true") =>
      run({
        name: `Load ${mode}`,
        steps: [
          { id: "src", uses: "postgres.read", with: { connection: { database: "TaxiOps" }, table: "trips" } },
          { id: "f", uses: "filter", with: { where } },
          { id: "load", uses: "warehouse.write", with: { table: "analytics.trips", mode, ...extra } },
        ],
      });
    const count = async () => Number((await pg!.adminQuery<{ n: string }>("select count(*) as n from analytics.trips", [], "warehouse"))[0]!.n);

    expect((await load("replace")).steps[2]!.metrics?.rowsWritten).toBe(3);
    await pg!.adminQuery("create view analytics.completed as select * from analytics.trips where status = 'Completed'", [], "warehouse");
    const replaced = await load("replace", {}, "status = 'Completed'");
    expect(replaced.status).toBe("succeeded");
    expect(await count()).toBe(2);
    expect((await pg!.adminQuery("select * from analytics.completed", [], "warehouse")).length).toBe(2); // the view survived

    await load("append", {}, "status = 'Cancelled'");
    expect(await count()).toBe(3);

    await pg!.adminQuery("update trips set fare = 99.99 where id = 1", [], "taxiops");
    await pg!.adminQuery("alter table trips add column driver text", [], "taxiops");
    await pg!.adminQuery("update trips set driver = 'Ada' where id = 1", [], "taxiops");
    const up = await load("upsert", { key: ["id"] }, "id in (1, 3)");
    expect(up.status).toBe("succeeded");
    expect(up.steps[2]!.metrics?.rowsWritten).toBe(2);
    const rows = await pg!.adminQuery<{ id: number; fare: string; driver: string | null }>("select id, fare::text, driver from analytics.trips order by id", [], "warehouse");
    expect(rows).toEqual([
      { id: 1, fare: "99.99", driver: "Ada" },
      { id: 2, fare: "3.25", driver: null },
      { id: 3, fare: "8.00", driver: null },
    ]);
    expect(await count()).toBe(3);
  });

  it("test mode reads a sample and leaves the warehouse untouched", async () => {
    const before = await pg!.adminQuery("select * from analytics.trips order by id", [], "warehouse");
    const r = await run(
      { name: "Test", steps: [{ id: "src", uses: "postgres.read", with: { connection: { database: "TaxiOps" }, query: "select * from trips" } }, { id: "load", uses: "warehouse.write", with: { table: "analytics.trips" } }] },
      { testRows: 1 },
    );
    expect(r.steps[0]!.output!.rows).toBe(1);
    expect(r.steps[1]!.metrics?.extra).toEqual({ wouldWrite: 1 });
    expect(await pg!.adminQuery("select * from analytics.trips order by id", [], "warehouse")).toEqual(before);
  });

  it("explains missing tables and retries an unreachable server", async () => {
    const missing = await run({ name: "Missing", steps: [{ id: "src", uses: "postgres.read", with: { connection: { database: "TaxiOps" }, table: "nope" } }] });
    expect(missing.error).toContain("The table nope doesn't exist in TaxiOps.");
    expect(missing.steps[0]!.attempts).toBe(1);

    secrets["old-server"] = "postgresql://someone:pw@127.0.0.1:1/db";
    const down = await run({ name: "Down", retry: { attempts: 2, delaySeconds: 1, backoff: "fixed" }, steps: [{ id: "src", uses: "postgres.read", with: { connection: { secret: "old-server" }, table: "trips" } }] });
    expect(down.status).toBe("failed");
    expect(down.error).toContain("isn't reachable right now");
    expect(down.steps[0]!.attempts).toBe(3);
    expect(delays).toEqual([1000, 1000]);
  });

  it("advances incremental watermarks only after a complete real run", async () => {
    await pg!.adminQuery("drop table if exists incremental_events; create table incremental_events (id int primary key, changed_at timestamptz, value text); insert into incremental_events values (1, '2025-01-01T00:00:00Z', 'one'), (2, '2025-01-02T00:00:00Z', 'two'), (3, '2025-01-03T00:00:00Z', 'three')", [], "taxiops");
    const e = engine();
    const initial = await run({ name: "Initial watermark", steps: [{ id: "changes", uses: "postgres.read", with: { connection: { database: "TaxiOps" }, table: "incremental_events", incremental: { column: "changed_at", initial: "2025-01-02T00:00:00Z" } } }] });
    expect(initial.steps[0]!.metrics?.rowsOut).toBe(1);
    const source = { id: "changes", uses: "postgres.read", with: { connection: { database: "TaxiOps" }, table: "incremental_events", incremental: { column: "changed_at" } } } as const;
    const start = (steps: PipelineInput["steps"], opts: Parameters<PipelineEngine["start"]>[1] = {}) =>
      e.start({ id: "pg-incremental", version: 1, definition: normalizePipeline({ name: "Incremental", steps }) }, opts).done;
    const watermarkTime = (run: Awaited<ReturnType<typeof start>>) => new Date(String((run.steps[0]!.state!.watermark as { value: string }).value)).toISOString();

    const first = await start([source]);
    expect(first.steps[0]).toMatchObject({ metrics: { rowsOut: 3 }, state: { watermark: { column: "changed_at" } } });
    expect(watermarkTime(first)).toBe("2025-01-03T00:00:00.000Z");

    await pg!.adminQuery("insert into incremental_events values (4, '2025-01-04T00:00:00Z', 'four'), (5, '2025-01-05T00:00:00Z', 'five')", [], "taxiops");
    const failed = await start([source, { id: "break", uses: "sql", with: { query: "select missing_column from input" } }]);
    expect(failed.status).toBe("failed");
    expect(failed.steps[0]).toMatchObject({ metrics: { rowsOut: 2 } });
    expect(watermarkTime(failed)).toBe("2025-01-05T00:00:00.000Z");

    await pg!.adminQuery("insert into incremental_events values (6, '2025-01-06T00:00:00Z', 'six')", [], "taxiops");
    const afterFailure = await start([source]);
    expect(afterFailure.steps[0]).toMatchObject({ metrics: { rowsOut: 3 } });
    expect(watermarkTime(afterFailure)).toBe("2025-01-06T00:00:00.000Z");

    await pg!.adminQuery("insert into incremental_events values (7, '2025-01-07T00:00:00Z', 'seven'), (8, '2025-01-08T00:00:00Z', 'eight')", [], "taxiops");
    const test = await start([source], { testRows: 1 });
    expect(test.steps[0]!.metrics?.rowsOut).toBe(1);
    await pg!.adminQuery("insert into incremental_events values (9, '2025-01-09T00:00:00Z', 'nine')", [], "taxiops");
    const afterTest = await start([source]);
    expect(afterTest.steps[0]).toMatchObject({ metrics: { rowsOut: 3 } });
    expect(watermarkTime(afterTest)).toBe("2025-01-09T00:00:00.000Z");
    const empty = await start([source]);
    expect(empty.steps[0]).toMatchObject({ metrics: { rowsOut: 0 } });
    expect(watermarkTime(empty)).toBe("2025-01-09T00:00:00.000Z");
  });

  it("runs table, append and view ELT inside PostgreSQL and keeps test runs read-only", async () => {
    await pg!.adminQuery("drop schema if exists elt_test cascade; create schema elt_test; create table elt_test.source (id int primary key, category text); insert into elt_test.source values (1, 'a'), (2, 'a'), (3, 'b')", [], "taxiops");
    await pg!.adminQuery("drop schema if exists elt_test cascade; create schema elt_test; create table elt_test.source (id int primary key, amount int); insert into elt_test.source values (1, 10), (2, 20)", [], "warehouse");

    const tableRun = await run({
      name: "Database ELT",
      steps: [{ id: "summary", uses: "postgres.transform", needs: [], with: { connection: { database: "TaxiOps" }, query: "select category, count(*)::int as total from elt_test.source group by category", table: "elt_test.summary", materialize: "table" } }],
    });
    expect(tableRun.status).toBe("succeeded");
    expect(tableRun.steps[0]!.metrics).toMatchObject({ rowsWritten: 2, extra: { resultRows: 2 } });
    expect(await pg!.adminQuery("select * from elt_test.summary order by category", [], "taxiops")).toEqual([{ category: "a", total: 2 }, { category: "b", total: 1 }]);

    await pg!.adminQuery("insert into elt_test.source values (4, 'b')", [], "taxiops");
    await run({ name: "Refresh ELT", steps: [{ id: "summary", uses: "postgres.transform", needs: [], with: { connection: { database: "TaxiOps" }, query: "select category, count(*)::int as total from elt_test.source group by category", table: "elt_test.summary", materialize: "table" } }] });
    expect(await pg!.adminQuery("select * from elt_test.summary order by category", [], "taxiops")).toEqual([{ category: "a", total: 2 }, { category: "b", total: 2 }]);

    await run({ name: "Append ELT", steps: [{ id: "append", uses: "postgres.transform", needs: [], with: { connection: { database: "TaxiOps" }, query: "select id from elt_test.source where id = 1", table: "elt_test.appended", materialize: "append" } }] });
    const appended = await run({ name: "Append ELT again", steps: [{ id: "append", uses: "postgres.transform", needs: [], with: { connection: { database: "TaxiOps" }, query: "select id from elt_test.source where id = 1", table: "elt_test.appended", materialize: "append" } }] });
    expect(appended.steps[0]!.metrics?.rowsWritten).toBe(1);
    expect((await pg!.adminQuery("select * from elt_test.appended", [], "taxiops")).length).toBe(2);

    const view = await run({ name: "Warehouse view", steps: [{ id: "view", uses: "warehouse.transform", needs: [], with: { query: "with totals as (select sum(amount)::int as amount from elt_test.source) select amount from totals", table: "elt_test.total_view", materialize: "view" } }] });
    expect(view.status).toBe("succeeded");
    expect(await pg!.adminQuery("select * from elt_test.total_view", [], "warehouse")).toEqual([{ amount: 30 }]);

    const preview = await run({ name: "ELT preview", steps: [{ id: "preview", uses: "warehouse.transform", needs: [], with: { query: "select * from elt_test.source", table: "elt_test.preview_should_not_exist", materialize: "table" } }] }, { testRows: 10 });
    expect(preview.status).toBe("succeeded");
    expect(preview.steps[0]).toMatchObject({ output: { rows: 2 }, metrics: { rowsOut: 2, rowsWritten: 0, extra: { wouldMaterialize: "elt_test.preview_should_not_exist" } } });
    expect((await pg!.adminQuery<{ name: string | null }>("select to_regclass('elt_test.preview_should_not_exist')::text as name", [], "warehouse"))[0]!.name).toBeNull();

    const before = (await pg!.adminQuery<{ n: string }>("select count(*)::text as n from elt_test.source", [], "taxiops"))[0]!.n;
    const refused = await run({ name: "Unsafe ELT", steps: [{ id: "unsafe", uses: "postgres.transform", needs: [], with: { connection: { database: "TaxiOps" }, query: "delete from elt_test.source returning *", table: "elt_test.bad", materialize: "table" } }] });
    expect(refused.status).toBe("failed");
    expect(refused.error).toContain("must be a SELECT query");
    expect((await pg!.adminQuery<{ n: string }>("select count(*)::text as n from elt_test.source", [], "taxiops"))[0]!.n).toBe(before);
  });
});

describe.runIf(hasExtensions)("REST API connectors", () => {
  let server: http.Server;
  let base = "";
  const received: unknown[][] = [];
  let failNext = 0;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const u = new URL(req.url!, "http://x");
      if (req.headers.authorization !== "Bearer s3cret") return void res.writeHead(401).end("{}");
      if (failNext > 0) {
        failNext--;
        return void res.writeHead(503).end("busy");
      }
      if (req.method === "POST") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => (received.push(JSON.parse(body)), res.writeHead(200, { "content-type": "application/json" }).end("{}")));
        return;
      }
      const page = Number(u.searchParams.get("page") ?? 1);
      const items = page <= 2 ? [{ id: page * 10 + 1, name: `item ${page}a` }, { id: page * 10 + 2, name: `item ${page}b` }] : [];
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: { items } }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => server.close());

  it("pages through an API with a secret header, retrying when it's busy, and posts results back", async () => {
    failNext = 1;
    const r = await run({
      name: "API",
      retry: { attempts: 2, delaySeconds: 2, backoff: "fixed" },
      steps: [
        { id: "items", uses: "rest.read", with: { url: `${base}/items`, secretHeaders: { authorization: "shop-api" }, records: "data.items", pagination: { type: "page" } } },
        { id: "send", uses: "api.write", with: { url: `${base}/import`, secretHeaders: { authorization: "shop-api" }, batchSize: 3 } },
      ],
    });
    expect(r.status).toBe("succeeded");
    expect(r.steps[0]).toMatchObject({ attempts: 2, metrics: { rowsOut: 4, extra: { pages: 3 } } });
    expect(delays).toEqual([2000]);
    expect(received.map((b) => b.length)).toEqual([3, 1]);
    expect(received[0]![0]).toEqual({ id: 11, name: "item 1a" });
  });

  it("does not retry refused credentials, and names a missing secret", async () => {
    secrets["wrong"] = "Bearer nope";
    const refused = await run({ name: "Refused", steps: [{ id: "items", uses: "rest.read", with: { url: `${base}/items`, secretHeaders: { authorization: "wrong" } } }] });
    expect(refused.error).toContain("refused the credentials (HTTP 401)");
    expect(refused.steps[0]!.attempts).toBe(1);
    const noSecret = await run({ name: "No secret", steps: [{ id: "items", uses: "rest.read", with: { url: `${base}/items`, secretHeaders: { authorization: "missing" } } }] });
    expect(noSecret.error).toContain('The secret "missing" isn\'t set up.');
  });

  it("takes exactly the requested API sample and never posts during a test run", async () => {
    const posts = received.length;
    const r = await run(
      {
        name: "API preview",
        steps: [
          { id: "items", uses: "rest.read", with: { url: `${base}/items`, secretHeaders: { authorization: "shop-api" }, records: "data.items", pagination: { type: "page" } } },
          { id: "send", uses: "api.write", with: { url: `${base}/import`, secretHeaders: { authorization: "shop-api" } } },
        ],
      },
      { testRows: 3 },
    );
    expect(r.steps[0]).toMatchObject({ output: { rows: 3 }, metrics: { rowsOut: 3, extra: { pages: 2 } } });
    expect(r.steps[1]!.metrics).toMatchObject({ rowsWritten: 0, extra: { wouldWrite: 3 } });
    expect(received).toHaveLength(posts);
  });
});
