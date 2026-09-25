import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { NexusError, silentLogger, type Logger } from "@nexus/shared";
import type { StateStore } from "@nexus/state";
import { block } from "./blocks";
import { canonical, type NormalizedPipeline, type RetryPolicy } from "./definition";
import { openSandbox, outputPath, sqlPath, type Dataset } from "./duck";
import { captureStepEnvironment, reproducibilityManifest, type RunReproducibilityManifest } from "./environment";
import { isTransient, RunAborted, StepError } from "./errors";
import type { EngineServices, ExecutorRegistry, LogLevel, StepContext, StepMetrics, StepResult } from "./executor";
import { PipelineRunHistory } from "./history";
import { renderConfig, resolveParams, type ParamValue, type TemplateScope } from "./params";
import { RunStore, type PipelineRun, type RunStatus, type RunTrigger, type StepRun, type StepStatus } from "./runs";

export interface EngineOptions {
  store: StateStore;
  /** Run folders (step outputs, logs) live under here. */
  workRoot: string;
  executors: ExecutorRegistry;
  services?: EngineServices;
  logger?: Logger;
  /** Independent branches run side by side, up to this many steps at once. */
  maxParallelSteps?: number;
  /** Replaceable for tests (retry delays). */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  onEvent?: (e: RunEvent) => void;
}

export type RunEvent =
  | { type: "run"; runId: string; pipelineId: string; status: RunStatus | "started" }
  | { type: "step"; runId: string; stepId: string; status: StepStatus; attempt?: number }
  | { type: "log"; runId: string; stepId: string | null; level: LogLevel; message: string; time: string };

export interface StartOptions {
  params?: Record<string, unknown>;
  trigger?: RunTrigger;
  requestedBy?: string | null;
  /** Test mode: sources read at most this many rows, destinations don't write for real. */
  testRows?: number | null;
  /** Resume a failed run: steps that already succeeded (and haven't changed) are not run again. */
  resumeFrom?: string;
  /** Scheduled runs can keep the time slot they represent after downtime. */
  logicalTime?: string;
}

export interface RunnablePipeline {
  id: string;
  version: number;
  definition: NormalizedPipeline;
}

export interface LogLine {
  time: string;
  step: string | null;
  level: LogLevel;
  message: string;
}

export interface StepDataPreview {
  runId: string;
  stepId: string;
  columns: Dataset["columns"];
  totalRows: number;
  offset: number;
  rows: Record<string, unknown>[];
  hasMore: boolean;
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });

const pad = (n: number) => String(n).padStart(2, "0");
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Delay before retry number `attempt` (1-based), capped at an hour. */
export function retryDelayMs(policy: RetryPolicy, attempt: number): number {
  const base = policy.delaySeconds * 1000;
  return Math.min(3_600_000, policy.backoff === "exponential" ? base * 2 ** (attempt - 1) : base);
}

/**
 * Runs pipelines: steps in dependency order (independent branches in parallel), each in its own
 * folder and sandbox, with retries for temporary failures, a time limit, cancellation, and
 * resume-from-checkpoint for failed runs. Every run and step is recorded in the RunStore.
 */
export class PipelineEngine {
  readonly runs: RunStore;
  readonly history: PipelineRunHistory;
  private readonly log: Logger;
  private readonly sleep: NonNullable<EngineOptions["sleep"]>;
  private readonly active = new Map<string, { pipelineId: string; controller: AbortController; done: Promise<PipelineRun> }>();

  constructor(private readonly opts: EngineOptions) {
    this.runs = new RunStore(opts.store);
    this.history = new PipelineRunHistory(this.runs);
    this.log = opts.logger ?? silentLogger;
    this.sleep = opts.sleep ?? defaultSleep;
    // Runs that were in progress when Nexus stopped can't continue; mark them so they can be resumed.
    for (const id of this.runs.interrupted()) {
      for (const s of this.runs.require(id).steps.filter((x) => x.status === "running" || x.status === "retrying" || x.status === "pending")) {
        this.runs.updateStep(id, s.stepId, { status: s.status === "pending" ? "skipped" : "cancelled", finishedAt: new Date().toISOString() });
      }
      this.runs.finish(id, "failed", "Nexus was restarted while this run was in progress. Resume it to continue where it stopped.");
    }
  }

  /**
   * Short folder names keep step files well under Windows' 260-character path limit (DuckDB can't
   * open longer paths), even when the data folder is deep. Prefixes are unique in practice.
   */
  runDir(pipelineId: string, runId: string): string {
    return join(this.opts.workRoot, pipelineId.replace(/-/g, "").slice(0, 8), runId.replace(/-/g, "").slice(0, 12));
  }

  isRunning(pipelineId: string): boolean {
    return [...this.active.values()].some((a) => a.pipelineId === pipelineId);
  }

  activeRuns(): string[] {
    return [...this.active.keys()];
  }

  /** Waits for a run started by this engine (or returns the stored result of a finished one). */
  wait(runId: string): Promise<PipelineRun> {
    return this.active.get(runId)?.done ?? Promise.resolve(this.runs.require(runId));
  }

  reproducibility(runId: string): RunReproducibilityManifest {
    return reproducibilityManifest(this.runs.require(runId));
  }

  cancel(runId: string): boolean {
    const a = this.active.get(runId);
    if (!a) return false;
    a.controller.abort(new RunAborted("cancelled"));
    return true;
  }

  /** Starts a run. Parameters are checked first, so a bad API call fails before anything is recorded. */
  start(p: RunnablePipeline, o: StartOptions = {}): { runId: string; done: Promise<PipelineRun> } {
    const def = p.definition;
    let params: Record<string, ParamValue>;
    let logicalTime = o.logicalTime ?? new Date().toISOString();
    let previous: PipelineRun | null = null;
    if (o.resumeFrom) {
      previous = this.runs.require(o.resumeFrom);
      if (previous.pipelineId !== p.id) throw NexusError.invalid("That run belongs to a different pipeline.");
      if (!["failed", "partial", "cancelled"].includes(previous.status)) throw NexusError.conflict("Only a run that failed or was stopped can be resumed.");
      params = previous.params;
      logicalTime = previous.logicalTime;
    } else {
      params = resolveParams(def.params, o.params);
    }
    const requestedTestRows = o.testRows ?? null;
    if (requestedTestRows !== null && (!Number.isInteger(requestedTestRows) || requestedTestRows < 1 || requestedTestRows > 100_000)) {
      throw NexusError.invalid("A test run needs a whole-number row limit between 1 and 100,000.");
    }
    if (previous && o.testRows !== undefined && requestedTestRows !== previous.testRows) {
      throw NexusError.invalid("A resumed run keeps the original test row limit. Start a new test run to use a different limit.");
    }
    const testRows = previous?.testRows ?? requestedTestRows;
    const runId = this.runs.create({
      pipelineId: p.id,
      version: p.version,
      trigger: o.resumeFrom ? "resume" : testRows !== null ? "test" : (o.trigger ?? "manual"),
      requestedBy: o.requestedBy ?? null,
      params,
      logicalTime,
      testRows,
      resumedFrom: previous?.id ?? null,
      stepIds: def.order,
    });
    const controller = new AbortController();
    const done = this.execute(p, runId, params, logicalTime, testRows, previous, controller).finally(() => this.active.delete(runId));
    this.active.set(runId, { pipelineId: p.id, controller, done });
    return { runId, done };
  }

  /** The run's log, optionally for one step. */
  logs(runId: string, stepId?: string): LogLine[] {
    const run = this.runs.require(runId);
    const file = join(this.runDir(run.pipelineId, runId), "log.jsonl");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as LogLine)
      .filter((l) => stepId === undefined || l.step === stepId);
  }

  /** Reads a bounded page from a completed step's Parquet output without exposing its file. */
  async preview(runId: string, stepId: string, options: { limit?: number; offset?: number } = {}): Promise<StepDataPreview> {
    const run = this.runs.require(runId);
    const step = run.steps.find((item) => item.stepId === stepId);
    if (!step) throw NexusError.notFound("Pipeline step");
    if (!step.output) throw NexusError.invalid("This step did not produce data to preview.");
    if (!existsSync(step.output.path)) throw NexusError.notFound("Step preview data");
    const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(500, Math.floor(options.limit!))) : 100;
    const offset = Number.isFinite(options.offset) ? Math.max(0, Math.min(step.output.rows, Math.floor(options.offset!))) : 0;
    const tempDir = join(this.runDir(run.pipelineId, run.id), ".preview", randomUUID());
    const sandbox = await openSandbox({ directories: [dirname(step.output.path)], tempDir, threads: 1, memoryLimitMb: 256 }).catch((error) => {
      rmSync(tempDir, { recursive: true, force: true });
      throw error;
    });
    try {
      const rows = await sandbox.rows<Record<string, unknown>>(`SELECT * FROM read_parquet(${sqlPath(step.output.path)}) LIMIT ${limit} OFFSET ${offset}`);
      return { runId, stepId, columns: step.output.columns, totalRows: step.output.rows, offset, rows, hasMore: offset + rows.length < step.output.rows };
    } finally {
      sandbox.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  // ------------------------------------------------------------------ execution

  private async execute(p: RunnablePipeline, runId: string, params: Record<string, ParamValue>, logicalTime: string, testRows: number | null, previous: PipelineRun | null, controller: AbortController): Promise<PipelineRun> {
    const def = p.definition;
    const dir = this.runDir(p.id, runId);
    mkdirSync(dir, { recursive: true });
    const emit = (e: RunEvent) => {
      try {
        this.opts.onEvent?.(e);
      } catch {
        /* a listener must never break a run */
      }
    };
    const writeLog = (stepId: string | null, level: LogLevel, message: string) => {
      const line: LogLine = { time: new Date().toISOString(), step: stepId, level, message };
      try {
        appendFileSync(join(dir, "log.jsonl"), JSON.stringify(line) + "\n");
      } catch {
        /* disk full etc.: the run result is still recorded */
      }
      emit({ type: "log", runId, stepId, level, message, time: line.time });
    };
    emit({ type: "run", runId, pipelineId: p.id, status: "started" });
    writeLog(null, "info", previous ? `Resuming the run from ${new Date(previous.startedAt).toLocaleString()}.` : testRows !== null ? `Test run with up to ${testRows.toLocaleString("en-US")} rows per source.` : "Run started.");

    const timeout = setTimeout(() => controller.abort(new RunAborted("timeout")), def.resources.timeoutMinutes * 60_000);
    timeout.unref();

    const logical = new Date(logicalTime);
    const last = this.runs.lastSuccess(p.id);
    const scope: TemplateScope = {
      params,
      values: {
        "run.id": runId,
        "run.date": localDate(logical),
        "run.time": localTime(logical),
        "run.timestamp": logical.toISOString(),
        "pipeline.name": def.name,
        "last_success.date": last ? localDate(new Date(last.logicalTime)) : null,
        "last_success.timestamp": last ? new Date(last.logicalTime).toISOString() : null,
      },
    };

    const steps = new Map(def.steps.map((s) => [s.id, s]));
    const status = new Map<string, StepStatus>(def.order.map((id) => [id, "pending"]));
    const outputs = new Map<string, Dataset | null>();
    const hashes = new Map<string, string>();
    const prevSteps = new Map((previous?.steps ?? []).map((s) => [s.stepId, s]));
    let hardFailure: { stepId: string; error: string; problem: StepError["problem"] } | null = null;
    const running = new Map<string, Promise<void>>();
    const maxParallel = Math.max(1, this.opts.maxParallelSteps ?? 2);

    const runOne = async (stepId: string) => {
      const step = steps.get(stepId)!;
      const outcome = await this.runStep({ p, runId, dir, step, params, testRows, scope, inputs: step.needs.map((n) => ({ id: n, dataset: outputs.get(n) ?? null })), inputHashes: step.needs.map((n) => hashes.get(n)!), allInputsReused: step.needs.every((n) => status.get(n) === "reused"), previous: prevSteps.get(stepId) ?? null, signal: controller.signal, writeLog, emit });
      status.set(stepId, outcome.status);
      outputs.set(stepId, outcome.output);
      hashes.set(stepId, outcome.hash);
      if (outcome.status === "failed" && !step.continueOnError && !hardFailure) hardFailure = { stepId, error: outcome.error!, problem: outcome.problem };
    };

    try {
      while ([...status.values()].includes("pending")) {
        if (controller.signal.aborted) break;
        for (const id of def.order) {
          if (status.get(id) !== "pending" || running.has(id)) continue;
          const needs = steps.get(id)!.needs.map((n) => status.get(n)!);
          if (needs.some((s) => ["failed", "skipped", "cancelled"].includes(s)) || (hardFailure && !running.has(id))) {
            status.set(id, "skipped");
            this.runs.updateStep(runId, id, { status: "skipped", error: hardFailure ? "Not run because an earlier step failed." : "Not run because a step it depends on failed." });
            emit({ type: "step", runId, stepId: id, status: "skipped" });
            continue;
          }
          if (needs.every((s) => s === "succeeded" || s === "reused") && running.size < maxParallel) {
            status.set(id, "running");
            running.set(id, runOne(id).finally(() => running.delete(id)));
          }
        }
        if (!running.size) {
          if ([...status.values()].includes("pending")) continue; // everything left will be skipped next pass
          break;
        }
        await Promise.race([...running.values()]);
      }
      await Promise.allSettled([...running.values()]);
    } finally {
      clearTimeout(timeout);
    }

    const aborted = controller.signal.aborted ? (controller.signal.reason as RunAborted) : null;
    for (const [id, s] of status) {
      if (s === "pending" || s === "running") {
        status.set(id, aborted ? "cancelled" : "skipped");
        this.runs.updateStep(runId, id, { status: aborted ? "cancelled" : "skipped", finishedAt: new Date().toISOString() });
      }
    }
    const failed = [...status.entries()].filter(([, s]) => s === "failed");
    let final: RunStatus;
    let error: string | null = null;
    let problem: StepError["problem"] | null = null;
    if (aborted?.reason === "cancelled") {
      final = "cancelled";
      error = aborted.message;
    } else if (aborted) {
      final = "failed";
      error = aborted.message;
    } else if (hardFailure) {
      final = "failed";
      const hf = hardFailure as { stepId: string; error: string; problem: StepError["problem"] };
      error = `${stepLabel(steps.get(hf.stepId)!)} failed: ${hf.error}`;
      problem = hf.problem ?? null;
    } else if (failed.length) {
      final = "partial";
      error = `${failed.length} step${failed.length === 1 ? "" : "s"} failed but the pipeline was set to continue.`;
    } else {
      final = "succeeded";
    }
    this.runs.finish(runId, final, error, problem ?? null);
    writeLog(null, final === "succeeded" ? "info" : "error", final === "succeeded" ? "Run finished successfully." : error!);
    emit({ type: "run", runId, pipelineId: p.id, status: final });
    this.log.info("pipeline run finished", { pipelineId: p.id, runId, status: final });
    return this.runs.require(runId);
  }

  private async runStep(a: {
    p: RunnablePipeline;
    runId: string;
    dir: string;
    step: NormalizedPipeline["steps"][number];
    params: Record<string, ParamValue>;
    testRows: number | null;
    scope: TemplateScope;
    inputs: { id: string; dataset: Dataset | null }[];
    inputHashes: string[];
    allInputsReused: boolean;
    previous: StepRun | null;
    signal: AbortSignal;
    writeLog: (stepId: string | null, level: LogLevel, message: string) => void;
    emit: (e: RunEvent) => void;
  }): Promise<{ status: StepStatus; output: Dataset | null; hash: string; error?: string; problem?: StepError["problem"] }> {
    const { step, runId } = a;
    const def = a.p.definition;
    const spec = block(step.uses);
    const stepDir = join(a.dir, "steps", step.id);
    mkdirSync(stepDir, { recursive: true });
    const log = (level: LogLevel, message: string) => a.writeLog(step.id, level, message);
    const started = new Date().toISOString();
    const set = (patch: Parameters<RunStore["updateStep"]>[2]) => this.runs.updateStep(runId, step.id, patch);

    let config: Record<string, unknown>;
    try {
      config = renderConfig(step.with, a.scope, spec?.sqlFields ?? []);
    } catch (e) {
      const error = (e as Error).message;
      set({ status: "failed", startedAt: started, finishedAt: new Date().toISOString(), error });
      log("error", error);
      a.emit({ type: "step", runId, stepId: step.id, status: "failed" });
      return { status: "failed", output: null, hash: "", error };
    }
    const hash = createHash("sha256").update(canonical({ uses: step.uses, config, inputs: a.inputHashes, test: a.testRows })).digest("hex");

    // Checkpoint: the previous attempt of this run already did this exact work.
    const prev = a.previous;
    if (prev && (prev.status === "succeeded" || prev.status === "reused") && prev.stepHash === hash && step.checkpoint && a.allInputsReused && (!prev.output || existsSync(prev.output.path))) {
      let output: Dataset | null = null;
      if (prev.output) {
        const dest = outputPath(stepDir);
        try {
          linkSync(prev.output.path, dest);
        } catch {
          copyFileSync(prev.output.path, dest);
        }
        output = { ...prev.output, path: dest };
      }
      set({ status: "reused", stepHash: hash, startedAt: started, finishedAt: new Date().toISOString(), output, metrics: prev.metrics, state: prev.state, warnings: prev.warnings, environment: prev.environment });
      log("info", "Already completed in the earlier attempt; reusing its result.");
      a.emit({ type: "step", runId, stepId: step.id, status: "reused" });
      return { status: "reused", output, hash };
    }

    const executor = this.opts.executors.get(step.uses);
    const noData = a.inputs.filter((i) => !i.dataset).map((i) => i.id);
    if (noData.length && spec && spec.inputs.min > 0) {
      const error = `${noData.join(", ")} didn't produce any data for this step to use.`;
      set({ status: "failed", stepHash: hash, startedAt: started, finishedAt: new Date().toISOString(), error });
      log("error", error);
      a.emit({ type: "step", runId, stepId: step.id, status: "failed" });
      return { status: "failed", output: null, hash, error };
    }
    const policy = step.retry ?? def.retry;
    const inputs = a.inputs.filter((i): i is { id: string; dataset: Dataset } => !!i.dataset);
    const memoryLimitMb = def.resources.memoryMb === "auto" ? Math.max(512, Math.floor(totalmem() / 1024 / 1024 / 4)) : def.resources.memoryMb;
    const threads = def.resources.cpuPercent === "auto" ? Math.max(2, Math.floor(cpus().length / 2)) : Math.max(1, Math.round((cpus().length * def.resources.cpuPercent) / 100));
    const previousState = this.runs.lastStepState(a.p.id, step.id);
    // Script steps replace this after their exact managed environment is ready. If setup itself
    // fails, leave it null instead of falsely claiming the DuckDB environment ran the script.
    let environment = ["python", "r"].includes(step.uses) ? null : captureStepEnvironment();

    let attempt = 0;
    let lastError: unknown = null;
    set({ status: "running", stepHash: hash, startedAt: started, environment });
    a.emit({ type: "step", runId, stepId: step.id, status: "running", attempt: 1 });
    log("info", `Started ${stepLabel(step)}.`);
    while (attempt <= policy.attempts) {
      attempt++;
      set({ attempts: attempt, status: "running" });
      try {
        if (!executor) throw new StepError(`The ${spec?.label ?? step.uses} block isn't available on this server yet.`);
        const ctx: StepContext = {
          pipeline: def,
          pipelineId: a.p.id,
          runId,
          step,
          config,
          inputs,
          params: a.params,
          workDir: stepDir,
          outputPath: outputPath(stepDir),
          testRows: a.testRows,
          previousState,
          recordEnvironment(specific) {
            environment = captureStepEnvironment(specific);
            set({ environment });
          },
          attempt,
          signal: a.signal,
          services: this.opts.services ?? {},
          sandbox: (extra = {}) =>
            openSandbox({
              directories: [stepDir, ...inputs.map((i) => dirname(i.dataset.path)), ...(extra.directories ?? [])],
              files: extra.files,
              extensions: extra.extensions,
              setup: extra.setup,
              tempDir: join(stepDir, "tmp"),
              memoryLimitMb,
              threads,
            }),
          log,
          logger: this.log,
        };
        const result = await raceAbort(executor.run(ctx), a.signal);
        if (result.environment) environment = captureStepEnvironment(result.environment);
        const metrics: StepMetrics = {
          rowsIn: inputs.reduce((n, i) => n + i.dataset.rows, 0),
          rowsOut: result.output?.rows ?? null,
          rowsWritten: null,
          bytesOut: result.output?.bytes ?? null,
          peakMemoryBytes: null,
          ...result.metrics,
        };
        for (const w of result.warnings ?? []) log("warn", w);
        set({ status: "succeeded", finishedAt: new Date().toISOString(), output: result.output, metrics, state: result.state ?? null, warnings: result.warnings ?? [], error: null, environment });
        log("info", `Finished ${stepLabel(step)}${describeRows(result)}.`);
        a.emit({ type: "step", runId, stepId: step.id, status: "succeeded" });
        return { status: "succeeded", output: result.output, hash };
      } catch (e) {
        lastError = e;
        if (a.signal.aborted) {
          set({ status: "cancelled", finishedAt: new Date().toISOString(), error: (a.signal.reason as Error).message });
          a.emit({ type: "step", runId, stepId: step.id, status: "cancelled" });
          return { status: "cancelled", output: null, hash };
        }
        const transient = isTransient(e);
        if (transient && attempt <= policy.attempts) {
          const wait = retryDelayMs(policy, attempt);
          log("warn", `Temporary problem: ${(e as Error).message}. Trying again in ${formatWait(wait)} (attempt ${attempt + 1} of ${policy.attempts + 1}).`);
          set({ status: "retrying" });
          a.emit({ type: "step", runId, stepId: step.id, status: "retrying", attempt: attempt + 1 });
          try {
            await this.sleep(wait, a.signal);
          } catch {
            set({ status: "cancelled", finishedAt: new Date().toISOString() });
            a.emit({ type: "step", runId, stepId: step.id, status: "cancelled" });
            return { status: "cancelled", output: null, hash };
          }
          continue;
        }
        break;
      }
    }
    const err = lastError as Error;
    const message = err?.message ?? String(lastError);
    const technical = lastError instanceof StepError ? lastError.technical : err?.stack;
    if (technical && technical !== message) log("debug", technical);
    log("error", attempt > 1 ? `${message} (after ${attempt} attempts)` : message);
    set({ status: "failed", finishedAt: new Date().toISOString(), error: message });
    a.emit({ type: "step", runId, stepId: step.id, status: "failed" });
    return { status: "failed", output: null, hash, error: message, problem: lastError instanceof StepError ? lastError.problem : undefined };
  }
}

function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => (signal.removeEventListener("abort", onAbort), resolve(v)),
      (e) => (signal.removeEventListener("abort", onAbort), reject(e)),
    );
  });
}

function stepLabel(step: { id: string; name?: string; uses: string }): string {
  const label = block(step.uses)?.label ?? step.uses;
  return step.name ? `${step.name} (${label})` : `${step.id} (${label})`;
}

function describeRows(r: StepResult): string {
  const parts: string[] = [];
  if (r.output) parts.push(`${r.output.rows.toLocaleString("en-US")} rows out`);
  if (r.metrics?.rowsWritten != null) parts.push(`${r.metrics.rowsWritten.toLocaleString("en-US")} rows written`);
  return parts.length ? ` — ${parts.join(", ")}` : "";
}

function formatWait(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} seconds`;
  const m = Math.round(ms / 60_000);
  return `${m} minute${m === 1 ? "" : "s"}`;
}
