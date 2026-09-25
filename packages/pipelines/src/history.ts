import type { PipelineRun, RunStore } from "./runs";

export interface RunMetricsSummary {
  durationMs: number | null;
  /** Rows delivered to destinations, or the last data-producing step when there is no destination. */
  rows: number | null;
  /** Sum of rows presented to every step; useful as a work/throughput measure. */
  rowsProcessed: number;
  rowsWritten: number | null;
  bytesProduced: number;
  peakMemoryBytes: number | null;
}

export type RunAnomalyKind = "duration" | "rows" | "memory";

export interface RunAnomaly {
  kind: RunAnomalyKind;
  direction: "high" | "low";
  severity: "warning" | "critical";
  observed: number;
  baseline: number;
  changePercent: number | null;
  message: string;
}

export interface RunHistoryEntry {
  run: PipelineRun;
  metrics: RunMetricsSummary;
  anomalies: RunAnomaly[];
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/** One compact, consistent set of numbers for run-history cards and charts. */
export function summarizeRun(run: PipelineRun): RunMetricsSummary {
  const metrics = run.steps.flatMap((step) => (step.metrics ? [step.metrics] : []));
  const activeMetrics = run.steps.flatMap((step) => (step.status !== "reused" && step.metrics ? [step.metrics] : []));
  const written = activeMetrics.flatMap((metric) => (metric.rowsWritten === null ? [] : [metric.rowsWritten]));
  const lastOutput =
    [...run.steps].reverse().find((step) => step.metrics?.rowsOut !== null && step.metrics?.rowsOut !== undefined)
      ?.metrics?.rowsOut ?? null;
  const memory = activeMetrics.flatMap((metric) => {
    // Python/R stored this under `extra` before the dedicated field was introduced.
    const legacy = metric.extra?.peakMemoryBytes;
    const peak = metric.peakMemoryBytes ?? (typeof legacy === "number" ? legacy : null);
    return peak ? [peak] : [];
  });
  return {
    durationMs: run.durationMs,
    rows: written.length ? sum(written) : lastOutput,
    rowsProcessed: sum(activeMetrics.map((metric) => metric.rowsIn)),
    rowsWritten: written.length ? sum(written) : null,
    bytesProduced: sum(activeMetrics.flatMap((metric) => (metric.bytesOut === null ? [] : [metric.bytesOut]))),
    peakMemoryBytes: memory.length ? Math.max(...memory) : null,
  };
}

const completedBaseline = (runs: PipelineRun[]) =>
  runs.filter((run) => run.status === "succeeded" && run.testRows === null && run.finishedAt !== null);

function detect(
  kind: RunAnomalyKind,
  observed: number | null,
  history: PipelineRun[],
  value: (metrics: RunMetricsSummary) => number | null,
): RunAnomaly | null {
  if (observed === null) return null;
  const values = completedBaseline(history)
    .map((run) => value(summarizeRun(run)))
    .filter((item): item is number => item !== null)
    .slice(-20);
  if (values.length < 5) return null;
  const baseline = median(values);
  const deviation = median(values.map((item) => Math.abs(item - baseline)));
  const difference = observed - baseline;
  const minimum =
    kind === "rows"
      ? Math.max(10, Math.abs(baseline) * 0.5)
      : kind === "duration"
        ? Math.max(30_000, baseline * 0.75)
        : Math.max(64 * 1024 * 1024, baseline * 0.75);
  const threshold = Math.max(minimum, deviation * 3);
  if (Math.abs(difference) <= threshold || (kind !== "rows" && difference < 0)) return null;
  const direction = difference > 0 ? "high" : "low";
  const ratio = baseline ? observed / baseline : null;
  const severity = ratio !== null && (ratio >= 3 || ratio <= 0.1) ? "critical" : "warning";
  const changePercent = baseline ? Math.round((difference / baseline) * 100) : null;
  const change =
    changePercent === null
      ? "changed sharply"
      : `${Math.abs(changePercent)}% ${direction === "high" ? "higher" : "lower"}`;
  const label = kind === "duration" ? "Run time" : kind === "rows" ? "Row count" : "Memory use";
  return {
    kind,
    direction,
    severity,
    observed,
    baseline,
    changePercent,
    message: `${label} was ${change} than the recent baseline.`,
  };
}

/** Robust median/MAD-style checks; test and failed runs never teach the baseline. */
export function detectRunAnomalies(run: PipelineRun, previousRuns: PipelineRun[]): RunAnomaly[] {
  if (run.status !== "succeeded" || run.testRows !== null || !run.finishedAt) return [];
  const metrics = summarizeRun(run);
  return [
    detect("duration", metrics.durationMs, previousRuns, (item) => item.durationMs),
    detect("rows", metrics.rows, previousRuns, (item) => item.rows),
    detect("memory", metrics.peakMemoryBytes, previousRuns, (item) => item.peakMemoryBytes),
  ].filter((anomaly): anomaly is RunAnomaly => anomaly !== null);
}

/** Read model for the run-history screen. It keeps anomaly calculation deterministic and storage-free. */
export class PipelineRunHistory {
  constructor(private readonly runs: Pick<RunStore, "list">) {}

  list(pipelineId: string, limit = 50): RunHistoryEntry[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.floor(limit))) : 50;
    const newest = this.runs.list(pipelineId, Math.min(250, safeLimit + 40));
    const chronological = [...newest].reverse();
    const position = new Map(chronological.map((run, index) => [run.id, index]));
    return newest.slice(0, safeLimit).map((run) => {
      const index = position.get(run.id)!;
      return { run, metrics: summarizeRun(run), anomalies: detectRunAnomalies(run, chronological.slice(0, index)) };
    });
  }
}
