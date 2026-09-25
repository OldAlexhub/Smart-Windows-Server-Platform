import type { StepEnvironment } from "./executor";
import type { PipelineRun } from "./runs";

/** Kept in sync with packages/pipelines/package.json by a test. */
export const PIPELINE_RUNTIME_VERSIONS = Object.freeze({
  pipelines: "0.1.0",
  duckdb: "1.5.5-r.5",
});

export function captureStepEnvironment(specific?: Pick<StepEnvironment, "runtime" | "packages">): StepEnvironment {
  return {
    runtime: specific?.runtime ?? `DuckDB ${PIPELINE_RUNTIME_VERSIONS.duckdb}`,
    packages: specific?.packages ?? {
      "@duckdb/node-api": PIPELINE_RUNTIME_VERSIONS.duckdb,
      "@nexus/pipelines": PIPELINE_RUNTIME_VERSIONS.pipelines,
    },
    host: {
      platform: process.platform,
      architecture: process.arch,
      node: process.versions.node,
      pipelines: PIPELINE_RUNTIME_VERSIONS.pipelines,
      duckdb: PIPELINE_RUNTIME_VERSIONS.duckdb,
    },
  };
}

export interface RunReproducibilityManifest {
  format: "nexus-pipeline-environment/v1";
  runId: string;
  pipelineId: string;
  pipelineVersion: number;
  capturedAt: string;
  complete: boolean;
  host: NonNullable<StepEnvironment["host"]> | null;
  steps: {
    stepId: string;
    status: string;
    attempts: number;
    environment: StepEnvironment | null;
  }[];
}

/** A secret-free manifest that can be downloaded with a run or used to rebuild script environments. */
export function reproducibilityManifest(run: PipelineRun): RunReproducibilityManifest {
  const attempted = run.steps.filter((step) => step.attempts > 0 || step.status === "reused");
  const host =
    (
      attempted.find((step) => step.status !== "reused" && step.environment?.host) ??
      attempted.find((step) => step.environment?.host)
    )?.environment?.host ?? null;
  return {
    format: "nexus-pipeline-environment/v1",
    runId: run.id,
    pipelineId: run.pipelineId,
    pipelineVersion: run.version,
    capturedAt: run.finishedAt ?? run.startedAt,
    complete: attempted.every((step) => step.environment !== null),
    host,
    steps: run.steps.map((step) => ({
      stepId: step.stepId,
      status: step.status,
      attempts: step.attempts,
      environment: step.environment,
    })),
  };
}
