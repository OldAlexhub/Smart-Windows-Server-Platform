import { newId, NexusError, type FriendlyProblem } from "@nexus/shared";
import type { Migration, StateStore } from "@nexus/state";
import type { Dataset } from "./duck";
import type { StepEnvironment, StepMetrics } from "./executor";
import type { ParamValue } from "./params";

export const runMigrations: Migration[] = [
  {
    id: "pipelines/002_runs",
    up: `CREATE TABLE pipeline_runs (
      id TEXT PRIMARY KEY,
      pipeline_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      status TEXT NOT NULL,
      trigger TEXT NOT NULL,
      requested_by TEXT,
      params TEXT NOT NULL,
      logical_time TEXT NOT NULL,
      test_rows INTEGER,
      resumed_from TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      error TEXT,
      problem TEXT
    );
    CREATE INDEX pipeline_runs_by_pipeline ON pipeline_runs (pipeline_id, started_at DESC);
    CREATE TABLE pipeline_run_steps (
      run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
      step_id TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      step_hash TEXT,
      started_at TEXT,
      finished_at TEXT,
      metrics TEXT,
      output TEXT,
      state TEXT,
      warnings TEXT,
      error TEXT,
      PRIMARY KEY (run_id, step_id)
    );`,
  },
  {
    id: "pipelines/003_step_environment",
    up: `ALTER TABLE pipeline_run_steps ADD COLUMN environment TEXT`,
  },
];

export type RunStatus = "running" | "succeeded" | "failed" | "partial" | "cancelled";
export type StepStatus = "pending" | "running" | "retrying" | "succeeded" | "failed" | "skipped" | "reused" | "cancelled";
export type RunTrigger = "manual" | "schedule" | "api" | "upstream" | "file" | "test" | "resume";

export interface StepRun {
  stepId: string;
  status: StepStatus;
  attempts: number;
  stepHash: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  metrics: StepMetrics | null;
  output: Dataset | null;
  state: Record<string, unknown> | null;
  warnings: string[];
  error: string | null;
  environment: StepEnvironment | null;
}

export interface PipelineRun {
  id: string;
  pipelineId: string;
  version: number;
  status: RunStatus;
  trigger: RunTrigger;
  requestedBy: string | null;
  params: Record<string, ParamValue>;
  /** The moment the run represents ({{run.date}}); kept when a failed run is resumed. */
  logicalTime: string;
  testRows: number | null;
  resumedFrom: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  error: string | null;
  problem: FriendlyProblem | null;
  steps: StepRun[];
}

const json = <T>(v: string | null): T | null => (v ? (JSON.parse(v) as T) : null);
const ms = (a: string | null, b: string | null) => (a && b ? Date.parse(b) - Date.parse(a) : null);

/** Every run and every step of every run — the pipeline's history, and the checkpoints to resume from. */
export class RunStore {
  constructor(private readonly store: StateStore) {
    store.migrate(runMigrations);
  }

  create(r: { pipelineId: string; version: number; trigger: RunTrigger; requestedBy: string | null; params: Record<string, ParamValue>; logicalTime: string; testRows: number | null; resumedFrom: string | null; stepIds: string[] }): string {
    const id = newId();
    this.store.transaction(() => {
      this.store.run(
        "INSERT INTO pipeline_runs (id, pipeline_id, version, status, trigger, requested_by, params, logical_time, test_rows, resumed_from, started_at) VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?)",
        [id, r.pipelineId, r.version, r.trigger, r.requestedBy, JSON.stringify(r.params), r.logicalTime, r.testRows, r.resumedFrom, new Date().toISOString()],
      );
      for (const s of r.stepIds) this.store.run("INSERT INTO pipeline_run_steps (run_id, step_id, status) VALUES (?, ?, 'pending')", [id, s]);
    });
    return id;
  }

  updateStep(runId: string, stepId: string, patch: Partial<Omit<StepRun, "stepId" | "durationMs">>): void {
    const cols: string[] = [];
    const vals: (string | number | null)[] = [];
    const set = (c: string, v: string | number | null) => (cols.push(`${c} = ?`), vals.push(v));
    if (patch.status) set("status", patch.status);
    if (patch.attempts !== undefined) set("attempts", patch.attempts);
    if (patch.stepHash !== undefined) set("step_hash", patch.stepHash);
    if (patch.startedAt !== undefined) set("started_at", patch.startedAt);
    if (patch.finishedAt !== undefined) set("finished_at", patch.finishedAt);
    if (patch.metrics !== undefined) set("metrics", patch.metrics ? JSON.stringify(patch.metrics) : null);
    if (patch.output !== undefined) set("output", patch.output ? JSON.stringify(patch.output) : null);
    if (patch.state !== undefined) set("state", patch.state ? JSON.stringify(patch.state) : null);
    if (patch.warnings !== undefined) set("warnings", JSON.stringify(patch.warnings));
    if (patch.error !== undefined) set("error", patch.error);
    if (patch.environment !== undefined) set("environment", patch.environment ? JSON.stringify(patch.environment) : null);
    if (!cols.length) return;
    this.store.run(`UPDATE pipeline_run_steps SET ${cols.join(", ")} WHERE run_id = ? AND step_id = ?`, [...vals, runId, stepId]);
  }

  finish(runId: string, status: RunStatus, error: string | null = null, problem: FriendlyProblem | null = null): void {
    this.store.run("UPDATE pipeline_runs SET status = ?, finished_at = ?, error = ?, problem = ? WHERE id = ?", [status, new Date().toISOString(), error, problem ? JSON.stringify(problem) : null, runId]);
  }

  get(runId: string): PipelineRun | undefined {
    const r = this.store.get<RunRow>("SELECT * FROM pipeline_runs WHERE id = ?", [runId]);
    return r ? this.toRun(r) : undefined;
  }

  require(runId: string): PipelineRun {
    const r = this.get(runId);
    if (!r) throw NexusError.notFound("Pipeline run");
    return r;
  }

  list(pipelineId: string, limit = 50): PipelineRun[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(250, Math.floor(limit))) : 50;
    return this.store.all<RunRow>("SELECT * FROM pipeline_runs WHERE pipeline_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?", [pipelineId, safeLimit]).map((r) => this.toRun(r));
  }

  /** The newest successful real (non-test) run. */
  lastSuccess(pipelineId: string): PipelineRun | undefined {
    const r = this.store.get<RunRow>("SELECT * FROM pipeline_runs WHERE pipeline_id = ? AND status = 'succeeded' AND test_rows IS NULL ORDER BY started_at DESC, rowid DESC LIMIT 1", [pipelineId]);
    return r ? this.toRun(r) : undefined;
  }

  /** State a step saved on its latest successful real run (incremental watermarks). */
  lastStepState(pipelineId: string, stepId: string): Record<string, unknown> | null {
    const r = this.store.get<{ state: string | null }>(
      `SELECT s.state FROM pipeline_run_steps s JOIN pipeline_runs r ON r.id = s.run_id
       WHERE r.pipeline_id = ? AND s.step_id = ? AND s.status IN ('succeeded', 'reused') AND s.state IS NOT NULL
         AND r.test_rows IS NULL AND r.status = 'succeeded'
       ORDER BY s.finished_at DESC LIMIT 1`,
      [pipelineId, stepId],
    );
    return json<Record<string, unknown>>(r?.state ?? null);
  }

  /** Runs still marked as running (after a restart they were interrupted). */
  interrupted(): string[] {
    return this.store.all<{ id: string }>("SELECT id FROM pipeline_runs WHERE status = 'running'").map((r) => r.id);
  }

  private toRun(r: RunRow): PipelineRun {
    const steps = this.store.all<StepRow>("SELECT * FROM pipeline_run_steps WHERE run_id = ? ORDER BY rowid", [r.id]).map(
      (s): StepRun => ({
        stepId: s.step_id,
        status: s.status as StepStatus,
        attempts: s.attempts,
        stepHash: s.step_hash,
        startedAt: s.started_at,
        finishedAt: s.finished_at,
        durationMs: ms(s.started_at, s.finished_at),
        metrics: json(s.metrics),
        output: json(s.output),
        state: json(s.state),
        warnings: json<string[]>(s.warnings) ?? [],
        error: s.error,
        environment: json(s.environment),
      }),
    );
    return {
      id: r.id,
      pipelineId: r.pipeline_id,
      version: r.version,
      status: r.status as RunStatus,
      trigger: r.trigger as RunTrigger,
      requestedBy: r.requested_by,
      params: JSON.parse(r.params),
      logicalTime: r.logical_time,
      testRows: r.test_rows,
      resumedFrom: r.resumed_from,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      durationMs: ms(r.started_at, r.finished_at),
      error: r.error,
      problem: json(r.problem),
      steps,
    };
  }
}

interface RunRow {
  id: string;
  pipeline_id: string;
  version: number;
  status: string;
  trigger: string;
  requested_by: string | null;
  params: string;
  logical_time: string;
  test_rows: number | null;
  resumed_from: string | null;
  started_at: string;
  finished_at: string | null;
  error: string | null;
  problem: string | null;
}

interface StepRow {
  step_id: string;
  status: string;
  attempts: number;
  step_hash: string | null;
  started_at: string | null;
  finished_at: string | null;
  metrics: string | null;
  output: string | null;
  state: string | null;
  warnings: string | null;
  error: string | null;
  environment: string | null;
}
