import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StateStore } from "@nexus/state";
import { SecretVault } from "@nexus/security";
import { csvCell, databaseStats, DatabaseManager, DataBrowser, type PostgresEngine } from "@nexus/database";
import { PG_BIN, startTestCluster } from "./pg-harness";

describe("csvCell", () => {
  it("quotes and neutralises formulas", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvCell("=HYPERLINK(evil)")).toBe("'=HYPERLINK(evil)");
    expect(csvCell(null)).toBe("");
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
  });
});

describe.runIf(!!PG_BIN)("DataBrowser (real PostgreSQL)", () => {
  let engine: PostgresEngine;
  let dispose: () => Promise<void>;
  let dbs: DatabaseManager;
  let browser: DataBrowser;
  let dbId: string;

  beforeAll(async () => {
    ({ engine, dispose } = await startTestCluster());
    const store = StateStore.memory();
    dbs = new DatabaseManager(store, SecretVault.withKey(store, randomBytes(32)), engine);
    const { database } = await dbs.createDatabase({ displayName: "TaxiOps", appId: "taxiops" });
    dbId = database.id;
    await dbs.withOwner(dbId, async (c) => {
      await c.query(`CREATE TABLE drivers (
        driver_id serial PRIMARY KEY, driver_name text NOT NULL, vehicle_number text,
        balance numeric(10,2) NOT NULL DEFAULT 0, last_payment date)`);
      await c.query(`INSERT INTO drivers (driver_name, vehicle_number, balance, last_payment) VALUES
        ('Ann Lee','TX-100', 620.50,'2026-07-01'), ('Bob Stone','TX-101', 120.00,'2026-09-01'),
        ('Cara Diaz','TX-102', 980.00, NULL), ('Dan Wu','TX-103', 0, '2026-09-20')`);
      await c.query("CREATE TABLE audit_events (at timestamptz DEFAULT now(), note text)");
      await c.query("ANALYZE");
    });
  }, 180_000);
  afterAll(async () => dispose?.(), 60_000);

  it("reports database stats", async () => {
    const s = await databaseStats(engine, "taxiops");
    expect(s.status).toBe("healthy");
    expect(s.tableCount).toBe(2);
    expect(s.sizeBytes).toBeGreaterThan(1000);
    expect((await databaseStats(engine, "no_such_db")).status).toBe("offline");
  });

  it("lists tables with editability", async () => {
    const t = await browser_().listTables(dbId);
    expect(t.map((x) => [x.name, x.editable, x.columnCount])).toEqual([
      ["audit_events", false, 2],
      ["drivers", true, 5],
    ]);
  });

  it("browses with paging, sorting, search and filters", async () => {
    const b = browser_();
    const page = await b.browse(dbId, "drivers", { pageSize: 2, page: 2 });
    expect(page.total).toBe(4);
    expect(page.rows.map((r) => r.driver_name)).toEqual(["Cara Diaz", "Dan Wu"]);

    const sorted = await b.browse(dbId, "drivers", { sort: { column: "balance", direction: "desc" } });
    expect(sorted.rows[0]!.driver_name).toBe("Cara Diaz");

    expect((await b.browse(dbId, "drivers", { search: "tx-101" })).rows.map((r) => r.driver_name)).toEqual(["Bob Stone"]);
    expect((await b.browse(dbId, "drivers", { search: "620" })).total).toBe(1); // numbers are searchable too

    // "Show drivers owing more than $500"
    const owing = await b.browse(dbId, "drivers", { filters: [{ column: "balance", op: "gt", value: 500 }] });
    expect(owing.rows.map((r) => r.driver_name).sort()).toEqual(["Ann Lee", "Cara Diaz"]);
    expect((await b.browse(dbId, "drivers", { filters: [{ column: "last_payment", op: "is_null" }] })).total).toBe(1);
    expect((await b.browse(dbId, "drivers", { filters: [{ column: "last_payment", op: "lt", value: "2026-08-01" }] })).total).toBe(1);
  });

  it("rejects unknown tables/columns (no SQL injection)", async () => {
    const b = browser_();
    await expect(b.browse(dbId, "drivers; DROP TABLE drivers", {})).rejects.toThrow(/not found/);
    await expect(b.browse(dbId, "drivers", { sort: { column: "balance; DROP TABLE drivers", direction: "asc" } })).rejects.toThrow(/no column/);
    await expect(b.browse(dbId, "drivers", { search: "'; DROP TABLE drivers; --" })).resolves.toMatchObject({ total: 0 });
    expect((await b.browse(dbId, "drivers")).total).toBe(4);
  });

  it("adds, edits and deletes single records by primary key", async () => {
    const b = browser_();
    const added = await b.insertRow(dbId, "drivers", { driver_name: "Eve Ng", vehicle_number: "TX-104" });
    expect(added).toMatchObject({ driver_name: "Eve Ng", balance: "0.00" });
    const updated = await b.updateRow(dbId, "drivers", { driver_id: added.driver_id }, { balance: 55.25 });
    expect(updated.balance).toBe("55.25");
    await b.deleteRow(dbId, "drivers", { driver_id: added.driver_id });
    expect((await b.browse(dbId, "drivers")).total).toBe(4);
    await expect(b.updateRow(dbId, "audit_events", { at: "x" }, { note: "y" })).rejects.toThrow(/no primary key/);
    await expect(b.deleteRow(dbId, "drivers", {})).rejects.toThrow(/Missing driver_id/);
  });

  it("exports the filtered view as CSV", async () => {
    let csv = "";
    for await (const chunk of browser_().exportCsv(dbId, "drivers", { filters: [{ column: "balance", op: "gt", value: 500 }], sort: { column: "driver_id", direction: "asc" } })) csv += chunk;
    expect(csv.split("\r\n")).toEqual([
      "driver_id,driver_name,vehicle_number,balance,last_payment",
      expect.stringMatching(/^1,Ann Lee,TX-100,620\.50,2026-07-01/),
      expect.stringMatching(/^3,Cara Diaz,TX-102,980\.00,$/),
      "",
    ]);
  });

  function browser_() {
    return (browser ??= new DataBrowser(dbs));
  }
});
