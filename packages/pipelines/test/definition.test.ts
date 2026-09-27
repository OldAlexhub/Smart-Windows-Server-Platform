import { describe, expect, it } from "vitest";
import { StateStore } from "@nexus/state";
import { BLOCKS, diffPipelineDefinitions, normalizePipeline, parsePipelineText, PipelineStore, toYaml, validatePipeline, type PipelineInput } from "@nexus/pipelines";

/** The spec's primary R scenario: TaxiOps database → R script → Operations Warehouse. */
const R_SCENARIO = `
nexus: pipeline/v1
name: Operations Warehouse Refresh
params:
  - { name: start_date, type: date, default: "2025-01-01" }
  - { name: division, choices: [North, South] }
schedule: { type: daily, at: "04:00" }
steps:
  - id: trips
    uses: postgres.read
    with:
      connection: { database: TaxiOps }
      query: select * from trips where trip_date >= '{{params.start_date}}'
  - id: analysis
    uses: r
    with: { script: 'C:\\Analytics\\operations.R' }
  - id: load
    uses: warehouse.write
    with: { table: provider_performance, mode: replace }
`;

const issuesOf = (raw: unknown) => {
  const r = validatePipeline(raw);
  return r.ok ? [] : r.issues;
};

describe("pipeline definitions", () => {
  it("reads a pipeline file, fills in defaults and wires steps top to bottom", () => {
    const p = parsePipelineText(R_SCENARIO);
    expect(p.name).toBe("Operations Warehouse Refresh");
    expect(p.steps.map((s) => [s.id, s.needs])).toEqual([
      ["trips", []],
      ["analysis", ["trips"]],
      ["load", ["analysis"]],
    ]);
    expect(p.order).toEqual(["trips", "analysis", "load"]);
    expect(p.schedule).toEqual({ type: "daily", at: "04:00" });
    expect(p.steps[1]!.with).toEqual({ script: "C:\\Analytics\\operations.R", args: [], packages: [] });
    expect(p.steps[2]!.with).toMatchObject({ mode: "replace" });
    expect(p.retry).toEqual({ attempts: 2, delaySeconds: 60, backoff: "exponential" });
    expect(p.notifications).toMatchObject({ onFailure: true, onSuccess: false });
  });

  it("accepts the same pipeline as JSON", () => {
    const json = JSON.stringify({ name: "CSV to warehouse", steps: [{ id: "file", uses: "csv.read", with: { path: "C:\\Data\\trips_*.csv" } }, { id: "load", uses: "warehouse.write", with: { table: "trips" } }] });
    expect(parsePipelineText(json).order).toEqual(["file", "load"]);
  });

  it("supports branching graphs: two sources joined, then aggregated", () => {
    const p = parsePipelineText(`
name: Revenue by provider
steps:
  - { id: trips, uses: csv.read, with: { path: 'C:\\Data\\trips.csv' } }
  - { id: providers, uses: excel.read, with: { path: 'C:\\Data\\providers.xlsx', sheet: Providers } }
  - id: joined
    uses: join
    needs: [trips, providers]
    with: { type: left, on: [{ left: provider_id, right: id }] }
  - id: totals
    uses: aggregate
    with: { groupBy: [provider_name], measures: [{ name: trips, fn: count }, { name: revenue, fn: sum, column: fare }] }
  - { id: out, uses: file.write, with: { path: 'C:\\Reports\\revenue.parquet' } }
`);
    expect(p.order).toEqual(["trips", "providers", "joined", "totals", "out"]);
    expect(p.steps.find((s) => s.id === "totals")!.needs).toEqual(["joined"]);
  });

  it("explains every problem in plain words, naming the step", () => {
    const issues = issuesOf({
      name: "Broken",
      params: [{ name: "start_date", type: "date", default: "yesterday" }],
      steps: [
        { id: "src", uses: "csv.read", with: {} },
        { id: "src", uses: "sql", with: { query: "select 1" } },
        { id: "mystery", uses: "magic.block" },
        { id: "clean", uses: "python", with: { script: "C:\\x.py" }, needs: ["nowhere"] },
        { id: "join", uses: "join", needs: ["src"], with: { on: [{ left: "a", right: "b" }] } },
        { id: "load", uses: "warehouse.write", with: { table: "t", mode: "upsert", query: "{{params.missing}}" } },
        { id: "tmpl", uses: "filter", with: { where: "d > '{{params.nope}}' and x = '{{secrets.pw}}'" } },
      ],
    }).map((i) => `${i.path}: ${i.message}`);
    expect(issues).toEqual(
      expect.arrayContaining([
        "params.start_date: Use a date like 2025-01-31 as the default.",
        "steps.src: Two steps are called src. Give each step its own name.",
        'steps.mystery.uses: "magic.block" isn\'t a known block.',
        'steps.clean.needs: Step clean reads from "nowhere", but there is no step with that name.',
        "steps.join.needs: Join (join) takes 2 inputs, but has 1.",
        "steps.tmpl.with: {{params.nope}} refers to a parameter that isn't defined.",
        "steps.tmpl.with: {{secrets.pw}} isn't a known placeholder.",
      ]),
    );
    expect(issues).toContain("steps.src.with.path: Please fill in path.");
    expect(issues.some((i) => i.startsWith("steps.load.with") && /Upsert needs the key|query/.test(i))).toBe(true);
  });

  it("finds loops between steps", () => {
    const issues = issuesOf({
      name: "Loop",
      steps: [
        { id: "a", uses: "csv.read", with: { path: "x.csv" } },
        { id: "b", uses: "sql", needs: ["a", "c"], with: { query: "select 1" } },
        { id: "c", uses: "filter", needs: ["b"], with: { where: "true" } },
      ],
    });
    expect(issues).toEqual([{ path: "steps", message: "These steps depend on each other in a loop: b, c." }]);
  });

  it("rejects sources wired to an input and scripts with unsafe names", () => {
    expect(issuesOf({ name: "x", steps: [{ id: "a", uses: "csv.read", with: { path: "a.csv" } }, { id: "b", uses: "csv.read", needs: ["a"], with: { path: "b.csv" } }] })[0]!.message).toBe(
      "CSV file (b) takes no inputs (it's where data comes from), but has 1.",
    );
    expect(issuesOf({ name: "x", steps: [{ id: "Bad Name", uses: "notify", with: { message: "hi" } }] })[0]!.path).toBe("steps.Bad Name.id");
    expect(issuesOf({ name: "x", steps: [] })[0]!.message).toBe("A pipeline needs at least one step.");
  });

  it("lets a script run on its own with needs: [] (e.g. a Python script that calls an API itself)", () => {
    const p = parsePipelineText(`
name: Two independent parts
steps:
  - { id: files, uses: csv.read, with: { path: a.csv } }
  - { id: fetch, uses: python, needs: [], with: { script: 'C:\\Pipelines\\import_data.py' } }
  - { id: load, uses: warehouse.write, with: { table: api_data } }
`);
    expect(p.steps.map((s) => s.needs)).toEqual([[], [], ["fetch"]]);
    expect(toYaml(p)).toContain("needs: []");
    expect(parsePipelineText(toYaml(p))).toEqual(p);
  });

  it("round-trips through the file format without noise", () => {
    const p = parsePipelineText(R_SCENARIO);
    const yaml = toYaml(p);
    expect(yaml).not.toContain("retry:"); // defaults are left out
    expect(yaml).not.toContain("needs:"); // implicit wiring is left out
    expect(parsePipelineText(yaml)).toEqual(p);
  });

  it("describes every block the designer can offer", () => {
    const kinds = BLOCKS.map((b) => b.kind);
    for (const k of ["postgres.read", "mongodb.read", "csv.read", "excel.read", "json.read", "parquet.read", "rest.read", "python", "r", "sql", "filter", "join", "aggregate", "validate", "transform", "postgres.transform", "warehouse.transform", "warehouse.write", "file.write", "api.write", "notify"]) {
      expect(kinds).toContain(k);
    }
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it("validates MongoDB collection sources", () => {
    const p = parsePipelineText(`
name: MongoDB to warehouse
steps:
  - id: visits
    uses: mongodb.read
    with: { connection: { database: CustomerDocs }, collection: visits, filter: { status: active }, batchSize: 500 }
  - id: load
    uses: warehouse.write
    with: { table: analytics.visits }
`);
    expect(p.steps[0]).toMatchObject({ uses: "mongodb.read", with: { connection: { database: "CustomerDocs" }, collection: "visits", filter: { status: "active" }, batchSize: 500 } });
  });

  it("validates incremental SQL sources and in-database transforms", () => {
    const p = parsePipelineText(`
name: Incremental ELT
steps:
  - id: changes
    uses: postgres.read
    with: { connection: { database: TaxiOps }, table: events, incremental: { column: updated_at, initial: "2025-01-01" } }
  - id: summary
    uses: warehouse.transform
    needs: []
    with: { query: "select day, count(*) as events from raw.events group by day", table: analytics.daily_events, materialize: table }
`);
    expect(p.steps[0]!.with).toMatchObject({ incremental: { column: "updated_at", initial: "2025-01-01" } });
    expect(p.steps[1]).toMatchObject({ uses: "warehouse.transform", needs: [], with: { materialize: "table" } });
  });
});

describe("pipeline store and versions", () => {
  const base: PipelineInput = {
    name: "Daily Operations",
    steps: [
      { id: "src", uses: "csv.read", with: { path: "C:\\Data\\ops.csv" } },
      { id: "load", uses: "warehouse.write", with: { table: "ops" } },
    ],
  };

  it("creates pipelines switched off, with a stable address", () => {
    const store = new PipelineStore(StateStore.memory());
    const p = store.create(base, "owner");
    expect(p).toMatchObject({ slug: "daily-operations", name: "Daily Operations", enabled: false, version: 1 });
    expect(store.create(base).slug).toBe("daily-operations-2");
    expect(store.require("daily-operations").id).toBe(p.id);
    expect(store.setEnabled(p.id, true).enabled).toBe(true);
  });

  it("saves a new version only when something meaningful changed", () => {
    const store = new PipelineStore(StateStore.memory());
    const p = store.create(base, "owner");
    expect(store.update(p.id, base).changed).toBe(false);

    // Moving blocks in the designer: layout saved, no new version.
    const moved = { ...base, steps: base.steps.map((s, i) => ({ ...s, position: { x: 100 * i, y: 40 } })) };
    const r1 = store.update(p.id, moved);
    expect(r1.changed).toBe(false);
    expect(r1.pipeline.definition.steps[1]!.position).toEqual({ x: 100, y: 40 });

    const renamed = { ...moved, name: "Daily Operations Load", schedule: { type: "daily", at: "04:00" } } as PipelineInput;
    const r2 = store.update(p.id, renamed, "owner", "Run every morning");
    expect(r2).toMatchObject({ changed: true, pipeline: { version: 2, name: "Daily Operations Load", slug: "daily-operations" } });
    expect(store.versions(p.id).map((v) => [v.version, v.note])).toEqual([
      [2, "Run every morning"],
      [1, "Created"],
    ]);
    expect(store.version(p.id, 1).definition.schedule).toEqual({ type: "manual" });
  });

  it("never stores an invalid pipeline", () => {
    const store = new PipelineStore(StateStore.memory());
    expect(() => store.create({ name: "x", steps: [{ id: "a", uses: "nope" }] })).toThrow(/This pipeline has a problem:\n• steps.a.uses/);
    const p = store.create(base);
    expect(() => store.update(p.id, { ...base, steps: [] })).toThrow(/at least one step/);
    expect(store.require(p.id).version).toBe(1);
  });

  it("shows semantic diffs and rolls back by creating a new immutable version", () => {
    const store = new PipelineStore(StateStore.memory());
    const created = store.create(base, "owner");
    store.setEnabled(created.id, true);
    const changed: PipelineInput = {
      ...base,
      name: "Daily Regional Operations",
      params: [{ name: "region", default: "east" }],
      schedule: { type: "daily", at: "04:00" },
      steps: [
        { id: "src", uses: "csv.read", with: { path: "C:\\Data\\regional.csv" } },
        { id: "clean", uses: "deduplicate", with: { columns: ["trip_id"] } },
        { id: "load", uses: "warehouse.write", with: { table: "ops" } },
      ],
    };
    const version2 = store.update(created.id, changed, "editor", "Regional schedule").pipeline;
    const diff = store.diff(created.id, 1, 2);
    expect(diff).toMatchObject({ pipelineId: created.id, fromVersion: 1, toVersion: 2 });
    expect(diff.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "changed", path: "name", before: "Daily Operations", after: "Daily Regional Operations" }),
        expect.objectContaining({ kind: "added", path: "schedule.at", after: "04:00" }),
        expect.objectContaining({ kind: "added", path: "params.region" }),
        expect.objectContaining({ kind: "changed", path: "steps.src.with.path" }),
        expect.objectContaining({ kind: "added", path: "steps.clean" }),
        expect.objectContaining({ kind: "changed", path: "steps.load.needs" }),
      ]),
    );

    const moved = normalizePipeline({ ...base, steps: base.steps.map((step, index) => ({ ...step, position: { x: index * 100, y: 50 } })) });
    expect(diffPipelineDefinitions(store.version(created.id, 1).definition, moved)).toEqual([]);

    const restored = store.rollback(created.id, 1, "owner");
    expect(restored).toMatchObject({ version: 3, name: "Daily Operations", slug: created.slug, enabled: true });
    expect(store.version(created.id, 3)).toMatchObject({ restoredFrom: 1, author: "owner", note: "Rolled back to version 1" });
    expect(store.version(created.id, 2).definition.name).toBe(version2.name);
    expect(store.diff(created.id, 1).changes).toEqual([]);
    expect(() => store.rollback(created.id, 3)).toThrow("already matches version 3");
    expect(() => store.rollback(created.id, 99)).toThrow("Version 99 was not found");
  });
});
