import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  analyzeImport,
  columnName,
  excelSheetNames,
  importFormat,
  openSandbox,
  sqlPath,
  suggestTableName,
  type ImportFileOptions,
} from "@nexus/pipelines";

const EXT_DIR = join(__dirname, "..", "..", "..", "vendor", "duckdb-extensions", "1.5.5");
const excel = join(EXT_DIR, "excel.duckdb_extension");
let roots: string[] = [];

const root = () => {
  const value = mkdtempSync(join(tmpdir(), "nexus-import-"));
  roots.push(value);
  return value;
};

const options = (dir: string, file: string, format: ImportFileOptions["format"]): ImportFileOptions => ({
  file,
  format,
  workDir: dir,
  extensions: { ...(existsSync(excel) ? { excel } : {}) },
});

afterEach(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  roots = [];
});

describe("data import analysis", () => {
  it("recognises supported files and proposes safe, unique SQL names", () => {
    expect(["orders.csv", "orders.tsv", "orders.xlsx", "orders.jsonl"].map(importFormat)).toEqual([
      "csv",
      "csv",
      "excel",
      "json",
    ]);
    expect(() => importFormat("old.xls")).toThrow("save it as .xlsx");
    expect(columnName("2024 Total %")).toBe("c_2024_total_pct");
    expect(columnName("Driver ID", new Set(["driver_id"]))).toBe("driver_id_2");
    expect(suggestTableName("Drivers export 202409.csv", null, ["drivers"])).toBe("drivers_2");
  });

  it("finds CSV columns, useful types, examples and a primary key", async () => {
    const dir = root();
    const file = join(dir, "Drivers export 202409.csv");
    writeFileSync(
      file,
      'Driver ID,Total Paid,Paid On,Active\n101,"$1,250.50",03/04/2024,yes\n102,"$22.00",04/05/2024,no\n',
    );
    const result = await analyzeImport(options(dir, file, "csv"), "Drivers export 202409.csv", []);

    expect(result).toMatchObject({ rows: 2, suggestedTable: "drivers", primaryKey: ["driver_id"] });
    expect(result.columns.map((c) => ({ name: c.name, type: c.type, format: c.format }))).toEqual([
      { name: "driver_id", type: "integer", format: null },
      { name: "total_paid", type: "decimal", format: "money" },
      { name: "paid_on", type: "date", format: "%m/%d/%Y" },
      { name: "active", type: "boolean", format: null },
    ]);
    expect(result.columns[2]!.note).toContain("month/day");
    expect(result.sample[0]).toMatchObject({ "Driver ID": "101", Active: "yes" });

    // The same upload can be analysed again after changing a wizard choice.
    await expect(analyzeImport(options(dir, file, "csv"), "Drivers export 202409.csv", [])).resolves.toMatchObject({
      rows: 2,
    });
  });

  it("keeps nested JSON values as JSON text", async () => {
    const dir = root();
    const file = join(dir, "customers.json");
    writeFileSync(
      file,
      JSON.stringify([
        { customerId: 1, name: "Ada", address: { city: "Boston" } },
        { customerId: 2, name: "Grace", address: { city: "New York" } },
      ]),
    );
    const result = await analyzeImport(options(dir, file, "json"), "customers.json", []);
    expect(result).toMatchObject({ rows: 2, suggestedTable: "customers", primaryKey: ["customer_id"] });
    expect(result.columns.find((c) => c.name === "address")).toMatchObject({
      type: "text",
      format: "json",
      note: "Nested values are kept as JSON text.",
    });
  });

  describe.runIf(existsSync(excel))("Excel imports", () => {
    it("lists and analyses workbook sheets", async () => {
      const dir = root();
      const file = join(dir, "payments.xlsx");
      const sb = await openSandbox({ directories: [dir], tempDir: join(dir, "tmp"), extensions: [excel] });
      try {
        await sb.conn.run(
          `COPY (SELECT 1 AS payment_id, 'Ada' AS customer, 12.5 AS amount) TO ${sqlPath(file)} (FORMAT xlsx, HEADER true)`,
        );
      } finally {
        sb.close();
      }
      expect(excelSheetNames(file)).toEqual(["Sheet1"]);
      await expect(analyzeImport(options(dir, file, "excel"), "payments.xlsx", [])).resolves.toMatchObject({
        rows: 1,
        sheets: ["Sheet1"],
        sheet: "Sheet1",
        primaryKey: ["payment_id"],
      });
    });
  });
});
