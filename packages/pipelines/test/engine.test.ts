import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "@nexus/state";
import {
  BUILTIN_TRANSFORMS,
  ExecutorRegistry,
  normalizePipeline,
  PipelineEngine,
  retryDelayMs,
  StepError,
  writeDataset,
  type PipelineInput,
  type StepExecutor,
} from "@nexus/pipelines";

const root = mkdtempSync(join(tmpdir(), "nexus-pipe-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Test sources: csv.read produces rows from inline SQL named by its `path`. */
const DATA: Record<string, string> = {
  "trips.csv": `SELECT * FROM (VALUES (1, 'Completed', 'A', 12.5), (2, 'Completed', 'B', 20.0), (3, 'Cancelled', 'A', 0.0), (4, 'Completed', 'A', 7.5), (4, 'Completed', 'A', 7.5)) t(trip_id, status, provider_id, fare)`,
  "providers.csv": `SELECT * FROM (VALUES ('A', 'Alpha Cabs'), ('B', 'Beta Rides')) p(id, name)`,
};
let sourceCalls: Record<string, number> = {};
const fakeCsv: StepExecutor = {
  kind: "csv.read",
  async run(ctx) {
    const name = String(ctx.config.path);
    sourceCalls[name] = (sourceCalls[name] ?? 0) + 1;
    const sb = await ctx.sandbox();
    try {
      const limit = ctx.testRows ? ` LIMIT ${ctx.testRows}` : "";
      return { output: await writeDataset(sb, `${DATA[name]}${limit}`, ctx.outputPath) };
    } finally {
      sb.close();
    }
  },
};

/** A step whose behaviour each test controls (used as "rest.read" / "file.write"). */
let flaky: { failures: number; error: () => Error; calls: number } = { failures: 0, error: () => new Error("x"), calls: 0 };
const fakeApi: StepExecutor = {
  kind: "rest.read",
  async run(ctx) {
    flaky.calls++;
    if (flaky.calls <= flaky.failures) throw flaky.error();
    const sb = await ctx.sandbox();
    try {
      return { output: await writeDataset(sb, "SELECT 1 AS id, 'ok' AS status", ctx.outputPath) };
    } finally {
      sb.close();
    }
  },
};
let sinkBehaviour: "ok" | "fail" | "hang" = "ok";
let sinkCalls = 0;
const fakeSink: StepExecutor = {
  kind: "file.write",
  run: (ctx) =>
    new Promise((resolve, reject) => {
      sinkCalls++;
      if (ctx.testRows !== null) return resolve({ output: null, metrics: { rowsWritten: 0, extra: { wouldWrite: ctx.inputs[0]!.dataset.rows } } });
      if (sinkBehaviour === "fail") return reject(new StepError("The export folder is read-only."));
      if (sinkBehaviour === "hang") return ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason));
      resolve({ output: null, metrics: { rowsWritten: ctx.inputs[0]!.dataset.rows } });
    }),
};

let delays: number[] = [];
function engine(store = StateStore.memory()) {
  return new PipelineEngine({
    store,
    workRoot: join(root, "runs"),
    executors: new ExecutorRegistry([...BUILTIN_TRANSFORMS, fakeCsv, fakeApi, fakeSink]),
    sleep: async (ms) => void delays.push(ms),
  });
}
let seq = 0;
const pipeline = (def: PipelineInput, id = `p${++seq}`) => ({ id, version: 1, definition: normalizePipeline(def) });

beforeEach(() => {
  sourceCalls = {};
  flaky = { failures: 0, error: () => new Error("x"), calls: 0 };
  sinkBehaviour = "ok";
  sinkCalls = 0;
  delays = [];
});

describe("pipeline engine", () => {
  it("runs steps in order and records rows, outputs and logs", async () => {
    const e = engine();
    const p = pipeline({
      name: "Completed trips by provider",
      params: [{ name: "status", default: "Completed" }],
      steps: [
        { id: "trips", uses: "csv.read", with: { path: "trips.csv" } },
        { id: "dedupe", uses: "deduplicate" },
        { id: "done", uses: "filter", with: { where: "status = {{params.status}}" } },
        { id: "totals", uses: "aggregate", with: { groupBy: ["provider_id"], measures: [{ name: "trips", fn: "count" }, { name: "revenue", fn: "sum", column: "fare" }] } },
        { id: "save", uses: "file.write", with: { path: "C:\\Reports\\out.csv" } },
      ],
    });
    const run = await e.start(p).done;
    expect(run.status).toBe("succeeded");
    expect(run.steps.map((s) => [s.stepId, s.status, s.metrics?.rowsOut ?? null])).toEqual([
      ["trips", "succeeded", 5],
      ["dedupe", "succeeded", 4],
      ["done", "succeeded", 3],
      ["totals", "succeeded", 2],
      ["save", "succeeded", null],
    ]);
    expect(run.steps[4]!.metrics?.rowsWritten).toBe(2);
    expect(run.steps.every((step) => step.environment?.host?.node === process.versions.node)).toBe(true);
    expect(run.steps[0]!.environment).toMatchObject({ runtime: expect.stringMatching(/^DuckDB /), packages: { "@nexus/pipelines": "0.1.0", "@duckdb/node-api": "1.5.5-r.5" } });
    expect(run.params).toEqual({ status: "Completed" });
    const logs = e.logs(run.id).map((l) => l.message);
    expect(logs).toContain("Removed 1 duplicate row.");
    expect(logs.at(-1)).toBe("Run finished successfully.");
    const history = e.history.list(p.id);
    expect(history[0]).toMatchObject({ run: { id: run.id }, metrics: { rows: 2, rowsWritten: 2, rowsProcessed: 14 }, anomalies: [] });
    const environment = e.reproducibility(run.id);
    expect(environment).toMatchObject({ format: "nexus-pipeline-environment/v1", pipelineVersion: 1, complete: true, host: { platform: process.platform, architecture: process.arch } });
    expect(environment.steps).toEqual(expect.arrayContaining([expect.objectContaining({ stepId: "trips", environment: expect.objectContaining({ host: expect.objectContaining({ node: process.versions.node }) }) })]));
  });

  it("passes parameters into SQL as values, never as SQL (safe for API callers)", async () => {
    const e = engine();
    const p = pipeline({ name: "Param", params: [{ name: "status" }], steps: [{ id: "trips", uses: "csv.read", with: { path: "trips.csv" } }, { id: "f", uses: "filter", with: { where: "status = '{{params.status}}'" } }] });
    const ok = await e.start(p, { params: { status: "Cancelled" } }).done;
    expect(ok.steps[1]!.metrics?.rowsOut).toBe(1);
    const attack = await e.start(p, { params: { status: "x' OR 1=1 --" } }).done;
    expect(attack.status).toBe("succeeded");
    expect(attack.steps[1]!.metrics?.rowsOut).toBe(0);
  });

  it("checks parameters before starting", () => {
    const e = engine();
    const p = pipeline({ name: "P", params: [{ name: "start_date", type: "date" }, { name: "limit", type: "number", default: 10 }], steps: [{ id: "a", uses: "csv.read", with: { path: "trips.csv" } }] });
    expect(() => e.start(p)).toThrow("Please provide start_date.");
    expect(() => e.start(p, { params: { start_date: "2025-02-30" } })).toThrow("start_date must be a date like 2025-01-31.");
    expect(() => e.start(p, { params: { start_date: "2025-01-31", limit: "ten" } })).toThrow("limit must be a number.");
    expect(() => e.start(p, { params: { start_date: "2025-01-31", region: "x" } })).toThrow("This pipeline has no parameter called region.");
    expect(e.runs.list(p.id)).toEqual([]);
  });

  it("runs a bounded, write-free test and previews any data-producing step", async () => {
    const e = engine();
    const p = pipeline({
      name: "Preview",
      steps: [
        { id: "trips", uses: "csv.read", with: { path: "trips.csv" } },
        { id: "done", uses: "filter", with: { where: "status = 'Completed'" } },
        { id: "save", uses: "file.write", with: { path: "preview.csv" } },
      ],
    });
    const result = await e.start(p, { testRows: 2 }).done;
    expect(result).toMatchObject({ status: "succeeded", trigger: "test", testRows: 2 });
    expect(result.steps.map((item) => item.output?.rows ?? null)).toEqual([2, 2, null]);
    expect(result.steps[2]!.metrics).toMatchObject({ rowsWritten: 0, extra: { wouldWrite: 2 } });

    const first = await e.preview(result.id, "trips", { limit: 1 });
    expect(first).toMatchObject({ totalRows: 2, offset: 0, rows: [{ trip_id: 1 }], hasMore: true });
    const second = await e.preview(result.id, "trips", { limit: 1, offset: 1 });
    expect(second).toMatchObject({ totalRows: 2, offset: 1, rows: [{ trip_id: 2 }], hasMore: false });
    expect((await e.preview(result.id, "done")).rows).toHaveLength(2);
    await expect(e.preview(result.id, "save")).rejects.toThrow("did not produce data to preview");
  });

  it("validates test limits and preserves the dry-run limit when a failed test is resumed", async () => {
    const e = engine();
    const p = pipeline({ name: "Test retry", steps: [{ id: "api", uses: "rest.read", with: { url: "https://example.com" } }, { id: "save", uses: "file.write", with: { path: "out.csv" } }] });
    for (const testRows of [0, -1, 1.5, 100_001, Number.NaN]) expect(() => e.start(p, { testRows })).toThrow("whole-number row limit");
    expect(e.runs.list(p.id)).toEqual([]);

    flaky = { failures: 1, error: () => new StepError("The sample source is temporarily malformed."), calls: 0 };
    const failed = await e.start(p, { testRows: 3 }).done;
    expect(failed).toMatchObject({ status: "failed", trigger: "test", testRows: 3 });
    flaky = { failures: 0, error: () => new Error("unused"), calls: 0 };
    const resumed = await e.start(p, { resumeFrom: failed.id }).done;
    expect(resumed).toMatchObject({ status: "succeeded", trigger: "resume", testRows: 3 });
    expect(resumed.steps[1]!.metrics).toMatchObject({ rowsWritten: 0, extra: { wouldWrite: 1 } });
    expect(() => e.start(p, { resumeFrom: failed.id, testRows: 4 })).toThrow("keeps the original test row limit");
  });

  it("joins two branches that ran side by side", async () => {
    const e = engine();
    const p = pipeline({
      name: "Join",
      steps: [
        { id: "trips", uses: "csv.read", with: { path: "trips.csv" } },
        { id: "providers", uses: "csv.read", with: { path: "providers.csv" } },
        { id: "named", uses: "join", needs: ["trips", "providers"], with: { type: "left", on: [{ left: "provider_id", right: "id" }] } },
        { id: "sum", uses: "sql", with: { query: "select name, count(*)::int as trips from input group by name order by name" } },
      ],
    });
    const run = await e.start(p).done;
    expect(run.status).toBe("succeeded");
    expect(run.steps.find((s) => s.stepId === "named")!.output!.columns.map((c) => c.name)).toEqual(["trip_id", "status", "provider_id", "fare", "id", "name"]);
    expect(run.steps.find((s) => s.stepId === "sum")!.output!.rows).toBe(2);
  });

  it("retries temporary failures with growing delays, then succeeds", async () => {
    const e = engine();
    flaky = { failures: 2, error: () => Object.assign(new Error("connect ECONNRESET"), { code: "ECONNRESET" }), calls: 0 };
    const p = pipeline({ name: "API", retry: { attempts: 3, delaySeconds: 5, backoff: "exponential" }, steps: [{ id: "api", uses: "rest.read", with: { url: "https://example.com/trips" } }] });
    const run = await e.start(p).done;
    expect(run.status).toBe("succeeded");
    expect(run.steps[0]).toMatchObject({ status: "succeeded", attempts: 3 });
    expect(delays).toEqual([5000, 10000]);
    expect(e.logs(run.id, "api").filter((l) => l.level === "warn")[0]!.message).toBe("Temporary problem: connect ECONNRESET. Trying again in 5 seconds (attempt 2 of 4).");
    expect(retryDelayMs({ attempts: 9, delaySeconds: 600, backoff: "exponential" }, 9)).toBe(3_600_000);
  });

  it("does not retry permanent failures, and stops the steps after them", async () => {
    const e = engine();
    const p = pipeline({
      name: "Broken filter",
      steps: [
        { id: "trips", uses: "csv.read", with: { path: "trips.csv" } },
        { id: "f", uses: "filter", with: { where: "provider_code = 'A'" } },
        { id: "save", uses: "file.write", with: { path: "x.csv" } },
      ],
    });
    const run = await e.start(p).done;
    expect(run.status).toBe("failed");
    expect(run.steps.map((s) => [s.stepId, s.status, s.attempts])).toEqual([
      ["trips", "succeeded", 1],
      ["f", "failed", 1],
      ["save", "skipped", 0],
    ]);
    expect(run.error).toBe('f (Filter) failed: Filter: the column "provider_code" doesn\'t exist in the incoming data.');
    expect(delays).toEqual([]);
    expect(sinkCalls).toBe(0);
  });

  it("keeps other branches going when a step may fail (continueOnError)", async () => {
    const e = engine();
    sinkBehaviour = "fail";
    const p = pipeline({
      name: "Partial",
      steps: [
        { id: "trips", uses: "csv.read", with: { path: "trips.csv" } },
        { id: "export", uses: "file.write", continueOnError: true, with: { path: "x.csv" } },
        { id: "totals", uses: "aggregate", needs: ["trips"], with: { measures: [{ name: "n", fn: "count" }] } },
      ],
    });
    const run = await e.start(p).done;
    expect(run.status).toBe("partial");
    expect(run.steps.map((s) => s.status)).toEqual(["succeeded", "failed", "succeeded"]);
  });

  it("resumes a failed run from its checkpoints instead of starting over", async () => {
    const store = StateStore.memory();
    const e = engine(store);
    sinkBehaviour = "fail";
    const def: PipelineInput = {
      name: "Resume",
      params: [{ name: "status", default: "Completed" }],
      steps: [
        { id: "trips", uses: "csv.read", with: { path: "trips.csv" } },
        { id: "done", uses: "filter", with: { where: "status = {{params.status}}" } },
        { id: "save", uses: "file.write", with: { path: "C:\\Out\\{{run.date}}.csv" } },
      ],
    };
    const p = pipeline(def);
    const failed = await e.start(p, { params: { status: "Cancelled" } }).done;
    expect(failed.status).toBe("failed");
    expect(sourceCalls["trips.csv"]).toBe(1);

    sinkBehaviour = "ok";
    const resumed = await e.start(p, { resumeFrom: failed.id }).done;
    expect(resumed).toMatchObject({ status: "succeeded", trigger: "resume", resumedFrom: failed.id, params: { status: "Cancelled" }, logicalTime: failed.logicalTime });
    expect(resumed.steps.map((s) => s.status)).toEqual(["reused", "reused", "succeeded"]);
    expect(resumed.steps[1]!.output!.rows).toBe(1);
    expect(sourceCalls["trips.csv"]).toBe(1); // not read again

    // A step changed since the failure runs again (and so does everything after it).
    sinkBehaviour = "fail";
    const failed2 = await e.start(p, { params: { status: "Completed" } }).done;
    sinkBehaviour = "ok";
    const changed = { ...p, version: 2, definition: normalizePipeline({ ...def, steps: [def.steps[0]!, { ...def.steps[1]!, with: { where: "status = {{params.status}} and fare > 10" } }, def.steps[2]!] }) };
    const resumed2 = await e.start(changed, { resumeFrom: failed2.id }).done;
    expect(resumed2.steps.map((s) => s.status)).toEqual(["reused", "succeeded", "succeeded"]);
    expect(resumed2.steps[1]!.output!.rows).toBe(2);

    expect(() => e.start(p, { resumeFrom: resumed2.id })).toThrow("Only a run that failed or was stopped can be resumed.");
  });

  it("can be cancelled while running", async () => {
    const e = engine();
    sinkBehaviour = "hang";
    const p = pipeline({ name: "Slow", steps: [{ id: "trips", uses: "csv.read", with: { path: "trips.csv" } }, { id: "save", uses: "file.write", with: { path: "x.csv" } }, { id: "after", uses: "notify", with: { message: "done" } }] });
    const { runId, done } = e.start(p);
    for (let i = 0; i < 200 && sinkCalls === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(e.isRunning(p.id)).toBe(true);
    expect(e.cancel(runId)).toBe(true);
    const run = await done;
    expect(run.status).toBe("cancelled");
    expect(run.steps.map((s) => s.status)).toEqual(["succeeded", "cancelled", "cancelled"]);
    expect(e.isRunning(p.id)).toBe(false);
  });

  it("checks data quality: fail, warn or drop", async () => {
    const e = engine();
    const rules = [
      { column: "fare", check: "min", value: 1 },
      { column: "trip_id", check: "unique" },
    ];
    const mk = (onFailure: string) =>
      pipeline({ name: "Quality", steps: [{ id: "trips", uses: "csv.read", with: { path: "trips.csv" } }, { id: "check", uses: "validate", with: { rules, onFailure } }] });
    const fail = await e.start(mk("fail")).done;
    expect(fail.status).toBe("failed");
    expect(fail.error).toContain("Data quality check failed — fare ≥ 1: 1 row fails; trip_id is unique: 2 rows fail.");
    expect(fail.problem?.checks.map((c) => c.status)).toEqual(["failed", "failed"]);

    const warn = await e.start(mk("warn")).done;
    expect(warn.status).toBe("succeeded");
    expect(warn.steps[1]!.metrics?.quality).toEqual([
      { rule: "fare ≥ 1", failedRows: 1, passed: false },
      { rule: "trip_id is unique", failedRows: 2, passed: false },
    ]);
    expect(warn.steps[1]!.output!.rows).toBe(5);

    const drop = await e.start(mk("drop")).done;
    expect(drop.steps[1]!.output!.rows).toBe(2);
    expect(drop.steps[1]!.warnings[0]).toMatch(/^Removed 3 rows that failed checks/);
  });

  it("keeps user SQL inside the run's own folder", async () => {
    const e = engine();
    const secretDir = join(root, "secret");
    mkdirSync(secretDir, { recursive: true });
    writeFileSync(join(secretDir, "master.key"), "TOPSECRET");
    const target = join(secretDir, "master.key").replace(/\\/g, "/");
    const p = pipeline({
      name: "Sneaky",
      steps: [
        { id: "trips", uses: "csv.read", with: { path: "trips.csv" } },
        { id: "peek", uses: "sql", with: { query: `select content from read_text('${target}')` } },
      ],
    });
    const run = await e.start(p).done;
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/Permission Error|Cannot access file/);
    const multi = await e.start(pipeline({ name: "Two statements", steps: [{ id: "trips", uses: "csv.read", with: { path: "trips.csv" } }, { id: "q", uses: "sql", with: { query: "select 1; select 2" } }] })).done;
    expect(multi.error).toContain("write one query");
  });

  it("marks runs interrupted by a restart so they can be resumed", async () => {
    const store = StateStore.memory();
    const e1 = engine(store);
    sinkBehaviour = "hang";
    const p = pipeline({ name: "Restart", steps: [{ id: "trips", uses: "csv.read", with: { path: "trips.csv" } }, { id: "save", uses: "file.write", with: { path: "x.csv" } }] });
    const { runId } = e1.start(p);
    for (let i = 0; i < 200 && sinkCalls === 0; i++) await new Promise((r) => setTimeout(r, 10));
    // Nexus restarts: a new engine over the same state.
    const e2 = engine(store);
    const run = e2.runs.require(runId);
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/restarted while this run was in progress/);
    expect(run.steps.map((s) => s.status)).toEqual(["succeeded", "cancelled"]);
    e1.cancel(runId);
    sinkBehaviour = "ok";
    const resumed = await e2.start(p, { resumeFrom: runId }).done;
    expect(resumed.steps.map((s) => s.status)).toEqual(["reused", "succeeded"]);
  });
});
