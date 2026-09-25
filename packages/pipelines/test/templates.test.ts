import { describe, expect, it } from "vitest";
import { describeTemplates, INTENTS, instantiateTemplate, TEMPLATES, toYaml } from "@nexus/pipelines";

/** Plausible answers for every question a template can ask. */
const ANSWERS: Record<string, string> = {
  database: "TaxiOps",
  table: "trips",
  target: "analytics.trips",
  file: "C:\\Data\\trips.xlsx",
  folder: "C:\\Exports\\",
  url: "https://api.example.com/trips",
  records: "data.items",
  secret: "trips_api",
  script: "C:\\Pipelines\\clean.py",
  column: "updated_at",
  key: "id",
};

describe("pipeline templates", () => {
  it("offers every template from the spec, each tied to a Create Pipeline choice", () => {
    expect(TEMPLATES.map((t) => t.name)).toEqual([
      "Database → Warehouse",
      "Excel → Database",
      "Excel → Warehouse",
      "API → Database",
      "API → Warehouse",
      "CSV → PostgreSQL",
      "PostgreSQL → Parquet",
      "Python Transformation",
      "R Transformation",
      "Database Backup Export",
      "Daily Incremental Load",
      "Monthly Historical Snapshot",
    ]);
    const intents = new Set(INTENTS.map((i) => i.id));
    for (const t of TEMPLATES) for (const i of t.intents) expect(intents.has(i)).toBe(true);
    for (const i of INTENTS) expect(TEMPLATES.some((t) => t.intents.includes(i.id))).toBe(true);
    expect(describeTemplates()[0]).not.toHaveProperty("build");
  });

  it("turns plain answers into valid pipelines", () => {
    for (const t of TEMPLATES) {
      const answers = { ...ANSWERS, ...(t.id === "r-transformation" ? { script: "C:\\Analytics\\operations.R" } : {}), ...(t.id.startsWith("csv") ? { file: "C:\\Data\\trips_*.csv" } : {}) };
      const p = instantiateTemplate(t.id, answers);
      expect(p.steps.length, t.id).toBeGreaterThanOrEqual(2);
      expect(p.order.length).toBe(p.steps.length);
    }
  });

  it("builds exactly what each choice means", () => {
    const inc = instantiateTemplate("daily-incremental-load", ANSWERS);
    expect(inc.schedule).toEqual({ type: "daily", at: "02:00" });
    expect(inc.steps[0]!.with).toMatchObject({ table: "trips", incremental: { column: "updated_at" } });
    expect(inc.steps[1]!.with).toMatchObject({ mode: "upsert", key: ["id"] });

    const snap = instantiateTemplate("monthly-historical-snapshot", ANSWERS);
    expect(snap.schedule).toEqual({ type: "monthly", day: 1, at: "03:00" });
    expect(snap.steps.map((s) => s.uses)).toEqual(["postgres.read", "transform", "warehouse.write"]);

    const api = instantiateTemplate("api-to-warehouse", { ...ANSWERS, header: "X-Api-Key" });
    expect(api.steps[0]!.with).toMatchObject({ records: "data.items", secretHeaders: { "X-Api-Key": "trips_api" } });

    const pq = instantiateTemplate("postgresql-to-parquet", ANSWERS);
    expect(pq.schedule).toEqual({ type: "manual" });
    expect(pq.steps[1]!.with.path).toBe("C:\\Exports\\trips_{{run.date}}.parquet");

    const named = instantiateTemplate("r-transformation", { ...ANSWERS, script: "C:\\Analytics\\operations.R", name: "Provider performance", time: "" });
    expect(named).toMatchObject({ name: "Provider performance", schedule: { type: "manual" } });
    expect(named.steps.map((s) => s.uses)).toEqual(["postgres.read", "r", "warehouse.write"]);
    expect(toYaml(named)).toContain("uses: r");
  });

  it("asks for missing answers in plain words", () => {
    expect(() => instantiateTemplate("excel-to-database", { file: "C:\\x.xlsx" })).toThrow('Please fill in "Database".');
    expect(() => instantiateTemplate("excel-to-database", { ...ANSWERS, mode: "merge" })).toThrow('"Each run" must be one of');
    expect(() => instantiateTemplate("nope", {})).toThrow("Template was not found.");
  });
});
