import type { Tone } from "../components/ui";

/** Shapes returned by /api/v1/pipelines… (mirrors @nexus/pipelines, which runs only in the service). */

export type BlockCategory = "source" | "transform" | "destination" | "control";

export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: (string | number)[];
  const?: unknown;
  default?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  additionalProperties?: JsonSchema | boolean;
  minimum?: number;
  maximum?: number;
  description?: string;
}

export interface BlockInfo {
  kind: string;
  category: BlockCategory;
  label: string;
  description: string;
  inputs: { min: number; max: number };
  schema: JsonSchema;
}

export interface Step {
  id: string;
  name?: string;
  uses: string;
  with: Record<string, unknown>;
  needs: string[];
  retry?: unknown;
  continueOnError?: boolean;
  checkpoint?: boolean;
  position?: { x: number; y: number };
}

export type Schedule =
  | { type: "manual" }
  | { type: "interval"; minutes: number }
  | { type: "daily"; at: string; days?: string[] }
  | { type: "weekly"; day: string; at: string }
  | { type: "monthly"; day: number | "last"; at: string }
  | { type: "cron"; expression: string }
  | { type: "file"; path: string; settleSeconds?: number }
  | { type: "after"; pipelines: string[]; when?: "success" | "completion" };

export interface Param {
  name: string;
  label?: string;
  description?: string;
  type: "string" | "number" | "boolean" | "date";
  default?: string | number | boolean;
  choices?: (string | number)[];
}

export interface Definition {
  nexus?: string;
  name: string;
  description?: string;
  params: Param[];
  steps: Step[];
  schedule: Schedule;
  retry: { attempts: number; delaySeconds: number; backoff: "fixed" | "exponential" };
  resources: Record<string, unknown>;
  notifications: { onFailure: boolean; onSuccess: boolean; onAnomaly: boolean; onDataQuality: boolean };
  order?: string[];
}

export type RunStatus = "running" | "succeeded" | "failed" | "partial" | "cancelled";
export type StepStatus = "pending" | "running" | "retrying" | "succeeded" | "failed" | "skipped" | "reused" | "cancelled";

export interface PipelineSummary {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  enabled: boolean;
  version: number;
  schedule: Schedule;
  steps: number;
  running: boolean;
  lastRun: { id: string; status: RunStatus; startedAt: string; finishedAt: string | null; durationMs: number | null; error: string | null } | null;
  updatedAt: string;
}

export interface PipelineDetailData extends PipelineSummary {
  definition: Definition;
  dependencies: { state: string; message: string | null } | null;
  webhook: { enabled: boolean; createdAt: string | null; url: string };
}

export interface StepRun {
  stepId: string;
  status: StepStatus;
  attempts: number;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  metrics: { rowsIn: number; rowsOut: number | null; rowsWritten: number | null; bytesOut: number | null; peakMemoryBytes?: number | null; quality?: { rule: string; failedRows: number; passed: boolean }[]; extra?: Record<string, number | string> } | null;
  output: { rows: number; columns: { name: string; type: string }[] } | null;
  warnings: string[];
  error: string | null;
  environment: { runtime: string; packages: Record<string, string> } | null;
}

export interface Run {
  id: string;
  pipelineId: string;
  version: number;
  status: RunStatus;
  trigger: string;
  requestedBy: string | null;
  params: Record<string, string | number | boolean>;
  logicalTime: string;
  testRows: number | null;
  resumedFrom: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  error: string | null;
  problem: { title: string; summary: string } | null;
  steps: StepRun[];
}

export interface RunHistoryEntry {
  run: Run;
  metrics: { durationMs: number | null; rows: number | null; rowsWritten: number | null; peakMemoryBytes: number | null };
  anomalies: { kind: string; severity: "warning" | "critical"; message: string }[];
}

export interface LogLine {
  time: string;
  step: string | null;
  level: "debug" | "info" | "warn" | "error";
  message: string;
}

export interface Preview {
  columns: { name: string; type: string }[];
  totalRows: number;
  offset: number;
  rows: Record<string, unknown>[];
  hasMore: boolean;
}

export interface TemplateField {
  name: string;
  label: string;
  kind: "database" | "table" | "file" | "folder" | "url" | "text" | "secret" | "script" | "time" | "column" | "choice";
  required: boolean;
  default?: string;
  help?: string;
  choices?: { value: string; label: string }[];
  extensions?: string[];
}

export interface Template {
  id: string;
  name: string;
  description: string;
  intents: string[];
  flow: string[];
  fields: TemplateField[];
}

export interface Intent {
  id: string;
  label: string;
  description: string;
}

// ---------------------------------------------------------------- words

export function runTone(status: RunStatus | StepStatus): { tone: Tone; label: string; spinning?: boolean } {
  switch (status) {
    case "succeeded":
      return { tone: "good", label: "Succeeded" };
    case "reused":
      return { tone: "good", label: "Reused" };
    case "running":
      return { tone: "neutral", label: "Running", spinning: true };
    case "retrying":
      return { tone: "warning", label: "Retrying", spinning: true };
    case "pending":
      return { tone: "neutral", label: "Waiting" };
    case "failed":
      return { tone: "critical", label: "Failed" };
    case "partial":
      return { tone: "warning", label: "Finished with problems" };
    case "skipped":
      return { tone: "neutral", label: "Skipped" };
    case "cancelled":
      return { tone: "neutral", label: "Stopped" };
  }
}

const DAYS: Record<string, string> = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };

export function describeSchedule(s: Schedule, names: Record<string, string> = {}): string {
  switch (s.type) {
    case "manual":
      return "Only when started";
    case "interval":
      return s.minutes % 60 === 0 ? `Every ${s.minutes / 60 === 1 ? "hour" : `${s.minutes / 60} hours`}` : `Every ${s.minutes} minute${s.minutes === 1 ? "" : "s"}`;
    case "daily":
      return s.days?.length ? `${s.days.map((d) => DAYS[d]?.slice(0, 3)).join(", ")} at ${s.at}` : `Every day at ${s.at}`;
    case "weekly":
      return `Every ${DAYS[s.day]} at ${s.at}`;
    case "monthly":
      return `Monthly on ${s.day === "last" ? "the last day" : `day ${s.day}`} at ${s.at}`;
    case "cron":
      return `Custom schedule (${s.expression})`;
    case "file":
      return `When a file arrives: ${s.path}`;
    case "after":
      return `After ${s.pipelines.map((p) => names[p] ?? p).join(", ")} ${s.when === "completion" ? "finishes" : "succeeds"}`;
  }
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export const formatRows = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString());

export const TRIGGER_LABEL: Record<string, string> = { manual: "Started by hand", schedule: "Schedule", api: "API / webhook", upstream: "After another pipeline", file: "File arrived", test: "Test run", resume: "Resumed" };

/** Positions for steps that have none: columns by depth, rows within a column. */
export function autoLayout(steps: Step[]): Record<string, { x: number; y: number }> {
  const depth = new Map<string, number>();
  const byId = new Map(steps.map((s) => [s.id, s]));
  const visit = (id: string, seen: Set<string>): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const s = byId.get(id);
    const d = s && s.needs.length ? 1 + Math.max(...s.needs.map((n) => visit(n, seen))) : 0;
    depth.set(id, d);
    return d;
  };
  steps.forEach((s) => visit(s.id, new Set()));
  const rows = new Map<number, number>();
  const out: Record<string, { x: number; y: number }> = {};
  for (const s of steps) {
    const d = depth.get(s.id) ?? 0;
    const r = rows.get(d) ?? 0;
    rows.set(d, r + 1);
    out[s.id] = { x: 40 + d * 250, y: 40 + r * 120 };
  }
  return out;
}
