import { block } from "./blocks";
import type { NormalizedPipeline } from "./definition";
import { detectRunAnomalies } from "./history";
import type { PipelineRun } from "./runs";

export type NotificationEvent = "failure" | "source_unavailable" | "recovered" | "success" | "anomaly" | "data_quality";
export type NotificationSeverity = "info" | "warning" | "critical";

export interface PipelineNotification {
  event: NotificationEvent;
  severity: NotificationSeverity;
  pipelineId: string;
  runId: string;
  title: string;
  message: string;
}

const SOURCE_TROUBLE = /isn't reachable|doesn't exist|didn't answer|is busy or having trouble|No files match|refused the (connection|credentials)|couldn't download/i;

const real = (r: PipelineRun) => r.testRows === null && r.trigger !== "test";
const isFailure = (r: PipelineRun) => r.status === "failed" || r.status === "partial" || (r.status === "cancelled" && /time limit/.test(r.error ?? ""));

/**
 * Decides what is worth telling people about a finished run — and what isn't:
 *  - failures (a source that couldn't be reached is called out as such), but not the same failure
 *    again and again: a pipeline that keeps failing the same way notifies once, then once more when it recovers;
 *  - unusual runs (much slower, far fewer rows, much more memory) and data-quality warnings;
 *  - plain successes only when the pipeline asks for them;
 *  - never anything for test runs or runs someone stopped on purpose.
 */
export function notificationsForRun(pipeline: { id: string; name: string; definition: NormalizedPipeline }, run: PipelineRun, previousRuns: PipelineRun[]): PipelineNotification[] {
  if (!real(run) || run.pipelineId !== pipeline.id) return [];
  const prefs = pipeline.definition.notifications;
  const history = previousRuns.filter((r) => r.id !== run.id && real(r) && r.status !== "running" && r.startedAt <= run.startedAt).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const previous = history[0] ?? null;
  const base = { pipelineId: pipeline.id, runId: run.id };
  const out: PipelineNotification[] = [];

  if (isFailure(run)) {
    if (!prefs.onFailure) return [];
    // Same failure as last time: people already know.
    if (previous && isFailure(previous) && previous.error === run.error) return [];
    const failed = run.steps.find((s) => s.status === "failed");
    const spec = failed ? block(pipeline.definition.steps.find((s) => s.id === failed.stepId)?.uses ?? "") : undefined;
    const sourceDown = !!failed && spec?.category === "source" && SOURCE_TROUBLE.test(failed.error ?? "");
    out.push({
      ...base,
      event: sourceDown ? "source_unavailable" : "failure",
      severity: run.status === "partial" ? "warning" : "critical",
      title: sourceDown ? `${pipeline.name}: a data source is unavailable` : run.status === "partial" ? `${pipeline.name} finished with problems` : `${pipeline.name} failed`,
      message: run.error ?? "The run didn't finish.",
    });
    return out;
  }

  if (run.status !== "succeeded") return [];

  if (previous && isFailure(previous) && prefs.onFailure) {
    out.push({ ...base, event: "recovered", severity: "info", title: `${pipeline.name} is working again`, message: "The latest run finished successfully after earlier failures." });
  } else if (prefs.onSuccess) {
    const rows = run.steps.reduce((n, s) => n + (s.metrics?.rowsWritten ?? 0), 0);
    out.push({ ...base, event: "success", severity: "info", title: `${pipeline.name} finished`, message: rows ? `${rows.toLocaleString("en-US")} rows written.` : "The run finished successfully." });
  }

  if (prefs.onAnomaly) {
    const anomalies = detectRunAnomalies(run, history);
    if (anomalies.length) {
      out.push({
        ...base,
        event: "anomaly",
        severity: anomalies.some((a) => a.severity === "critical") ? "critical" : "warning",
        title: `${pipeline.name} ran differently than usual`,
        message: anomalies.map((a) => a.message).join(" "),
      });
    }
  }

  if (prefs.onDataQuality) {
    const problems = run.steps.flatMap((s) => (s.metrics?.quality ?? []).filter((q) => !q.passed).map((q) => `${q.rule}: ${q.failedRows.toLocaleString("en-US")} ${q.failedRows === 1 ? "row" : "rows"}`));
    if (problems.length) out.push({ ...base, event: "data_quality", severity: "warning", title: `${pipeline.name}: data quality check found problems`, message: `${problems.join("; ")}.` });
  }
  return out;
}
