import { describe, expect, it } from "vitest";
import {
  detectRunAnomalies,
  PipelineRunHistory,
  summarizeRun,
  type PipelineRun,
  type StepMetrics,
  type StepRun,
} from "@nexus/pipelines";

const MB = 1024 * 1024;

function metrics(values: Partial<StepMetrics> = {}): StepMetrics {
  return { rowsIn: 0, rowsOut: null, rowsWritten: null, bytesOut: null, peakMemoryBytes: null, ...values };
}

function step(id: string, values: Partial<StepRun> & { metrics?: StepMetrics }): StepRun {
  return {
    stepId: id,
    status: "succeeded",
    attempts: 1,
    stepHash: id,
    startedAt: "2026-09-20T10:00:00.000Z",
    finishedAt: "2026-09-20T10:00:01.000Z",
    durationMs: 1_000,
    metrics: null,
    output: null,
    state: null,
    warnings: [],
    error: null,
    environment: null,
    ...values,
  };
}

function run(
  id: string,
  sequence: number,
  values: {
    duration?: number;
    rows?: number;
    memory?: number | null;
    status?: PipelineRun["status"];
    testRows?: number | null;
  } = {},
): PipelineRun {
  const duration = values.duration ?? 100_000;
  const started = new Date(Date.UTC(2026, 8, 20, 10, sequence));
  return {
    id,
    pipelineId: "pipeline-1",
    version: 1,
    status: values.status ?? "succeeded",
    trigger: values.testRows === undefined || values.testRows === null ? "schedule" : "test",
    requestedBy: null,
    params: {},
    logicalTime: started.toISOString(),
    testRows: values.testRows ?? null,
    resumedFrom: null,
    startedAt: started.toISOString(),
    finishedAt: new Date(started.getTime() + duration).toISOString(),
    durationMs: duration,
    error: null,
    problem: null,
    steps: [
      step("output", {
        metrics: metrics({
          rowsOut: values.rows ?? 1_000,
          bytesOut: 8_000,
          peakMemoryBytes: values.memory === undefined ? 128 * MB : values.memory,
        }),
      }),
    ],
  };
}

describe("pipeline run history", () => {
  it("summarizes rows, duration, bytes and peak memory without counting reused memory", () => {
    const item = run("summary", 0, { duration: 125_000 });
    item.steps = [
      step("source", { metrics: metrics({ rowsOut: 120, bytesOut: 1_200, peakMemoryBytes: 100 * MB }) }),
      step("clean", { metrics: metrics({ rowsIn: 120, rowsOut: 100, bytesOut: 900, peakMemoryBytes: 220 * MB }) }),
      step("reused", {
        status: "reused",
        metrics: metrics({ rowsIn: 100, rowsOut: 100, bytesOut: 900, peakMemoryBytes: 900 * MB }),
      }),
      step("legacy-memory", { metrics: metrics({ extra: { peakMemoryBytes: 230 * MB } }) }),
      step("save", { metrics: metrics({ rowsIn: 100, rowsWritten: 100 }) }),
    ];
    expect(summarizeRun(item)).toEqual({
      durationMs: 125_000,
      rows: 100,
      rowsProcessed: 220,
      rowsWritten: 100,
      bytesProduced: 2_100,
      peakMemoryBytes: 230 * MB,
    });
  });

  it("detects robust duration, row-count and memory anomalies without learning from tests or failures", () => {
    const baseline = [
      run("b1", 1, { duration: 98_000, rows: 980, memory: 126 * MB }),
      run("b2", 2, { duration: 100_000, rows: 1_000, memory: 128 * MB }),
      run("b3", 3, { duration: 102_000, rows: 1_020, memory: 130 * MB }),
      run("b4", 4, { duration: 99_000, rows: 990, memory: 127 * MB }),
      run("b5", 5, { duration: 101_000, rows: 1_010, memory: 129 * MB }),
      run("failed-outlier", 6, { duration: 9_000_000, rows: 1, memory: 2_000 * MB, status: "failed" }),
      run("test-outlier", 7, { duration: 9_000_000, rows: 1, memory: 2_000 * MB, testRows: 10 }),
    ];
    const anomalies = detectRunAnomalies(
      run("current", 8, { duration: 400_000, rows: 100, memory: 600 * MB }),
      baseline,
    );
    expect(anomalies.map((anomaly) => [anomaly.kind, anomaly.direction, anomaly.severity])).toEqual([
      ["duration", "high", "critical"],
      ["rows", "low", "critical"],
      ["memory", "high", "critical"],
    ]);
    expect(anomalies[1]!.message).toContain("90% lower");

    expect(
      detectRunAnomalies(run("normal", 9, { duration: 150_000, rows: 1_200, memory: 180 * MB }), baseline),
    ).toEqual([]);
    expect(
      detectRunAnomalies(run("too-early", 4, { duration: 900_000, rows: 10, memory: 900 * MB }), baseline.slice(0, 4)),
    ).toEqual([]);
  });

  it("returns newest-first history entries with anomalies based only on earlier runs", () => {
    const baseline = [0, 1, 2, 3, 4].map((index) => run(`baseline-${index}`, index));
    const current = run("current", 5, { rows: 100 });
    const newest = [current, ...baseline.slice().reverse()];
    const history = new PipelineRunHistory({ list: () => newest });
    const entries = history.list("pipeline-1", 2);
    expect(entries.map((entry) => entry.run.id)).toEqual(["current", "baseline-4"]);
    expect(entries[0]!.anomalies).toMatchObject([{ kind: "rows", direction: "low" }]);
    expect(entries[1]!.anomalies).toEqual([]); // only four earlier baselines at that point
  });
});
