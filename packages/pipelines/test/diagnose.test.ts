import { describe, expect, it } from "vitest";
import { diagnoseRun, missingColumns, normalizePipeline, similarity, type PipelineRun, type StepRun } from "@nexus/pipelines";

const pipeline = normalizePipeline({
  name: "Provider performance",
  steps: [
    { id: "trips", uses: "postgres.read", with: { connection: { database: "TaxiOps" }, table: "trips" } },
    { id: "analysis", name: "Provider analysis", uses: "r", with: { script: "C:\\Analytics\\operations.R" } },
    { id: "load", uses: "warehouse.write", with: { table: "provider_performance" } },
  ],
});

const cols = (...names: string[]) => ({ path: "x", rows: 10, bytes: 1, columns: names.map((name) => ({ name, type: "VARCHAR" })) });
const step = (stepId: string, patch: Partial<StepRun> = {}): StepRun => ({ stepId, status: "succeeded", attempts: 1, stepHash: null, startedAt: null, finishedAt: null, durationMs: null, metrics: null, output: null, state: null, warnings: [], error: null, environment: null, ...patch });
const run = (steps: StepRun[], patch: Partial<PipelineRun> = {}): PipelineRun => ({ id: "r", pipelineId: "p", version: 1, status: "failed", trigger: "schedule", requestedBy: null, params: {}, logicalTime: "", testRows: null, resumedFrom: null, startedAt: "2026-09-02", finishedAt: null, durationMs: null, error: "x", problem: null, steps, ...patch });

describe("run diagnosis", () => {
  it("finds the missing column in SQL, Python, R and DuckDB wordings", () => {
    expect(missingColumns(`The script refers to "provider_id", which doesn't exist — the incoming data may not have a column called provider_id.`)).toEqual(["provider_id"]);
    expect(missingColumns(`column "fare" does not exist`)).toEqual(["fare"]);
    expect(missingColumns(`Referenced column "fare" not found in FROM clause!`)).toEqual(["fare"]);
    expect(missingColumns(`KeyError: 'status'`)).toEqual(["status"]);
    expect(missingColumns("Error in dplyr::filter(): object 'provider_id' not found")).toEqual(["provider_id"]);
  });

  it("recognises renames by their names", () => {
    expect(similarity("provider_id", "provider_code")).toBeGreaterThan(0.4);
    expect(similarity("provider_id", "fare")).toBeLessThan(0.4);
  });

  it("explains the spec's example: the source renamed provider_id to provider_code", () => {
    const lastGood = run([step("trips", { output: cols("trip_id", "provider_id", "fare") }), step("analysis"), step("load")], { status: "succeeded", startedAt: "2026-09-01" });
    const failed = run([
      step("trips", { output: cols("trip_id", "provider_code", "fare") }),
      step("analysis", { status: "failed", error: `The script refers to "provider_id", which doesn't exist — the incoming data may not have a column called provider_id.` }),
      step("load", { status: "skipped" }),
    ]);
    const d = diagnoseRun(pipeline, failed, lastGood)!;
    expect(d).toMatchObject({
      stepId: "analysis",
      title: "The incoming data changed",
      summary: "The data coming into Provider analysis no longer contains provider_id. It now has provider_code instead — the source probably renamed provider_id to provider_code.",
      schemaChange: { missing: ["provider_id"], added: ["provider_code"], likelyRenames: [{ from: "provider_id", to: "provider_code" }] },
    });
    expect(d.suggestions[0]).toBe("Update Provider analysis to use provider_code instead of provider_id, or rename the column back where the data comes from.");
  });

  it("tells apart a column that never existed (a mistake in the step)", () => {
    const failed = run([step("trips", { output: cols("trip_id", "provider", "fare") }), step("analysis", { status: "failed", error: `column "provider_name" does not exist` }), step("load", { status: "skipped" })]);
    const d = diagnoseRun(pipeline, failed, null)!;
    expect(d.title).toBe("Provider analysis uses a column the data doesn't have");
    expect(d.suggestions[0]).toBe("Did you mean provider?");
  });

  it("recognises unavailable sources, bad credentials, quality failures and stopped runs", () => {
    const src = (error: string) => diagnoseRun(pipeline, run([step("trips", { status: "failed", error, attempts: 3 }), step("analysis", { status: "skipped" }), step("load", { status: "skipped" })]), null)!;
    expect(src("TaxiOps isn't reachable right now.")).toMatchObject({ title: "A system it depends on wasn't available", details: ["It was tried 3 times."] });
    expect(src("TaxiOps refused the connection details. Check the saved credentials.").title).toBe("The login details didn't work");
    expect(src("The table trips doesn't exist in TaxiOps.").title).toBe("The source wasn't there");
    const stopped = diagnoseRun(pipeline, run([step("trips"), step("analysis", { status: "cancelled" }), step("load", { status: "cancelled" })], { error: "The run took longer than its time limit and was stopped." }), null)!;
    expect(stopped.title).toBe("The run was stopped");
    expect(diagnoseRun(pipeline, run([step("trips")], { status: "succeeded" }), null)).toBeNull();
  });
});
