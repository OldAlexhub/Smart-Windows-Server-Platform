import { describe, expect, it } from "vitest";
import { normalizePipeline, notificationsForRun, type PipelineInput, type PipelineRun, type StepRun } from "@nexus/pipelines";

const def = (extra: Partial<PipelineInput> = {}) =>
  normalizePipeline({
    name: "Nightly load",
    steps: [
      { id: "src", uses: "postgres.read", with: { connection: { database: "TaxiOps" }, table: "trips" } },
      { id: "check", uses: "validate", with: { rules: [{ column: "fare", check: "min", value: 0 }], onFailure: "warn" } },
      { id: "load", uses: "warehouse.write", with: { table: "trips" } },
    ],
    ...extra,
  });
const pipeline = (extra?: Partial<PipelineInput>) => ({ id: "p1", name: "Nightly load", definition: def(extra) });

let clock = Date.parse("2026-09-01T02:00:00Z");
function step(stepId: string, patch: Partial<StepRun> = {}): StepRun {
  return { stepId, status: "succeeded", attempts: 1, stepHash: null, startedAt: null, finishedAt: null, durationMs: null, metrics: { rowsIn: 0, rowsOut: 100, rowsWritten: stepId === "load" ? 100 : null, bytesOut: null, peakMemoryBytes: null }, output: null, state: null, warnings: [], error: null, environment: null, ...patch };
}
function run(patch: Partial<PipelineRun> & { minutes?: number } = {}): PipelineRun {
  clock += 86_400_000;
  const started = new Date(clock).toISOString();
  const minutes = patch.minutes ?? 7;
  return {
    id: `r${clock}`,
    pipelineId: "p1",
    version: 1,
    status: "succeeded",
    trigger: "schedule",
    requestedBy: null,
    params: {},
    logicalTime: started,
    testRows: null,
    resumedFrom: null,
    startedAt: started,
    finishedAt: new Date(clock + minutes * 60_000).toISOString(),
    durationMs: minutes * 60_000,
    error: null,
    problem: null,
    steps: [step("src"), step("check"), step("load")],
    ...patch,
  };
}
const failed = (error: string, failedStep = "load") =>
  run({ status: "failed", error, steps: [step("src"), step("check"), step(failedStep === "src" ? "src" : "load", { status: "failed", error: error.replace(/^.*failed: /, "") })].map((s) => (s.stepId === failedStep ? { ...s, status: "failed" as const, error: error.replace(/^.*failed: /, "") } : s)) });

describe("pipeline notifications", () => {
  it("says nothing about ordinary successes, test runs or runs someone stopped", () => {
    const ok = run();
    expect(notificationsForRun(pipeline(), ok, [])).toEqual([]);
    expect(notificationsForRun(pipeline(), run({ status: "failed", error: "x", testRows: 100, trigger: "test" }), [])).toEqual([]);
    expect(notificationsForRun(pipeline(), run({ status: "cancelled", error: "The run was cancelled." }), [])).toEqual([]);
  });

  it("reports a failure once, not again for the same problem, and again when it recovers", () => {
    const f1 = failed("load (Warehouse) failed: the table is locked");
    const [n] = notificationsForRun(pipeline(), f1, []);
    expect(n).toMatchObject({ event: "failure", severity: "critical", title: "Nightly load failed", message: "load (Warehouse) failed: the table is locked", runId: f1.id });

    const f2 = failed("load (Warehouse) failed: the table is locked");
    expect(notificationsForRun(pipeline(), f2, [f1])).toEqual([]);
    const f3 = failed("load (Warehouse) failed: disk full");
    expect(notificationsForRun(pipeline(), f3, [f2, f1])).toHaveLength(1);

    const back = run();
    expect(notificationsForRun(pipeline(), back, [f3, f2, f1])).toEqual([expect.objectContaining({ event: "recovered", severity: "info", title: "Nightly load is working again" })]);
  });

  it("calls out an unreachable source, and treats a timeout as a failure", () => {
    const down = failed("src (PostgreSQL) failed: TaxiOps isn't reachable right now.", "src");
    expect(notificationsForRun(pipeline(), down, [])[0]).toMatchObject({ event: "source_unavailable", title: "Nightly load: a data source is unavailable" });
    const slow = run({ status: "cancelled", error: "The run took longer than its time limit and was stopped." });
    expect(notificationsForRun(pipeline(), slow, [])[0]).toMatchObject({ event: "failure" });
  });

  it("respects each pipeline's choices", () => {
    const quiet = pipeline({ notifications: { onFailure: false, onSuccess: false, onAnomaly: false, onDataQuality: false } });
    expect(notificationsForRun(quiet, failed("x failed: y"), [])).toEqual([]);
    const chatty = pipeline({ notifications: { onFailure: true, onSuccess: true, onAnomaly: true, onDataQuality: true } });
    expect(notificationsForRun(chatty, run(), [])).toEqual([expect.objectContaining({ event: "success", message: "100 rows written." })]);
  });

  it("warns about data-quality problems and unusual runs", () => {
    const bad = run({ steps: [step("src"), step("check", { metrics: { rowsIn: 100, rowsOut: 100, rowsWritten: null, bytesOut: null, peakMemoryBytes: null, quality: [{ rule: "fare ≥ 0", failedRows: 3, passed: false }] } }), step("load")] });
    expect(notificationsForRun(pipeline(), bad, [])).toEqual([expect.objectContaining({ event: "data_quality", severity: "warning", message: "fare ≥ 0: 3 rows." })]);

    const history = Array.from({ length: 8 }, (_, i) => run({ minutes: 7 + (i % 2) }));
    const slowRun = run({ minutes: 31 });
    const found = notificationsForRun(pipeline(), slowRun, [...history].reverse());
    expect(found).toEqual([expect.objectContaining({ event: "anomaly", title: "Nightly load ran differently than usual" })]);
  });
});
