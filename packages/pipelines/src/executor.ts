import type { Logger } from "@nexus/shared";
import type { NormalizedPipeline, StepDefinition } from "./definition";
import type { Dataset, Sandbox, SandboxOptions } from "./duck";
import type { ParamValue } from "./params";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Data-quality outcome of a Validate step (feeds notifications and the run page). */
export interface QualityResult {
  rule: string;
  failedRows: number;
  passed: boolean;
}

export interface StepMetrics {
  rowsIn: number;
  rowsOut: number | null;
  /** Rows written to a destination (database, file, API). */
  rowsWritten: number | null;
  bytesOut: number | null;
  /** Largest process-tree memory use observed while this step ran (scripts and external tools). */
  peakMemoryBytes: number | null;
  quality?: QualityResult[];
  /** Anything else worth showing, e.g. { pages: 12 } for an API source. */
  extra?: Record<string, number | string>;
}

export interface StepResult {
  output: Dataset | null;
  metrics?: Partial<StepMetrics>;
  warnings?: string[];
  /** Saved with the step run, e.g. the new incremental watermark (2.6). */
  state?: Record<string, unknown>;
  /** The runtime a script ran with, recorded so the run can be reproduced later. */
  environment?: StepEnvironment;
}

export interface StepEnvironment {
  /** "Python 3.12.2", "R 4.4.1". */
  runtime: string;
  /** Package name → exact version. */
  packages: Record<string, string>;
  /** The engine/host versions around the step; optional only for runs created by older Nexus versions. */
  host?: {
    platform: NodeJS.Platform;
    architecture: string;
    node: string;
    pipelines: string;
    duckdb: string;
  };
}

/**
 * Everything the host (the Nexus service) provides to steps: secrets, Nexus databases, the
 * warehouse, storage, script runtimes. Connectors ask for what they need; the engine itself needs none of it.
 */
export interface EngineServices {
  secret?(name: string): string | undefined;
  notify?(message: string, info: { pipelineId: string; runId: string; stepId: string }): Promise<void>;
  /** Extra checks on file paths a pipeline wants to read or write (keeps Nexus's own files out of reach). */
  checkPath?(path: string, access: "read" | "write"): void;
  [service: string]: unknown;
}

export interface StepContext {
  pipeline: NormalizedPipeline;
  pipelineId: string;
  runId: string;
  step: StepDefinition & { needs: string[] };
  /** The step's configuration with placeholders filled in. */
  config: Record<string, unknown>;
  /** Inputs in the order of `needs`, by step id. */
  inputs: { id: string; dataset: Dataset }[];
  params: Record<string, ParamValue>;
  /** This step's private folder; its output goes to `outputPath`. */
  workDir: string;
  outputPath: string;
  /** Test mode: sources read at most this many rows and destinations don't write for real. */
  testRows: number | null;
  /** State this step saved on the last successful run (e.g. the incremental watermark). */
  previousState: Record<string, unknown> | null;
  /** Scripts call this as soon as their exact environment is ready, so failures remain reproducible. */
  recordEnvironment(environment: Pick<StepEnvironment, "runtime" | "packages">): void;
  attempt: number;
  signal: AbortSignal;
  services: EngineServices;
  /** A locked-down DuckDB that can see this step's folder and its inputs (plus `extra`). */
  sandbox(extra?: Partial<Pick<SandboxOptions, "directories" | "files" | "extensions" | "setup">>): Promise<Sandbox>;
  log(level: LogLevel, message: string): void;
  logger: Logger;
}

export interface StepExecutor {
  kind: string;
  run(ctx: StepContext): Promise<StepResult>;
}

/** Maps block kinds to implementations. Connectors register here (2.3); tests register fakes. */
export class ExecutorRegistry {
  private readonly map = new Map<string, StepExecutor>();

  constructor(executors: StepExecutor[] = []) {
    executors.forEach((e) => this.register(e));
  }

  register(e: StepExecutor): this {
    this.map.set(e.kind, e);
    return this;
  }

  get(kind: string): StepExecutor | undefined {
    return this.map.get(kind);
  }

  kinds(): string[] {
    return [...this.map.keys()];
  }
}
