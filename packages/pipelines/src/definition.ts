import { createHash } from "node:crypto";
import { parse as parseYaml, stringify as toYamlText } from "yaml";
import { z } from "zod";
import { NexusError } from "@nexus/shared";
import { block, type BlockSpec } from "./blocks";
import { cronProblem } from "./cron";

/**
 * A pipeline, as stored and as written by people in a file:
 *
 *   nexus: pipeline/v1
 *   name: Operations Warehouse Refresh
 *   params:
 *     - { name: start_date, type: date, default: "2025-01-01" }
 *   schedule: { type: daily, at: "04:00" }
 *   steps:
 *     - id: trips
 *       uses: postgres.read
 *       with: { connection: { database: TaxiOps }, table: trips, incremental: { column: updated_at } }
 *     - id: clean
 *       uses: python
 *       with: { script: C:\Pipelines\clean_trips.py }
 *     - id: load
 *       uses: warehouse.write
 *       with: { table: trips_clean, mode: append }
 *
 * A step without `needs` reads from the step before it (if it takes input), so simple pipelines read
 * top to bottom. `needs: []` makes a script run on its own.
 * Values may use {{params.name}} and {{run.date}} placeholders.
 */

export const PIPELINE_FORMAT = "pipeline/v1";

const stepId = z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/, "Step names use lowercase letters, numbers, - and _ (starting with a letter).");
const paramName = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/, "Parameter names use lowercase letters, numbers and _ (starting with a letter).");
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a 24-hour time like 04:00.");
const weekday = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

export const retrySchema = z
  .object({
    /** Extra attempts after the first one. Permanent errors (bad script, missing column) are never retried. */
    attempts: z.number().int().min(0).max(10).default(2),
    delaySeconds: z.number().int().min(1).max(86_400).default(60),
    backoff: z.enum(["fixed", "exponential"]).default("exponential"),
  })
  .strict();

export const paramSchema = z
  .object({
    name: paramName,
    label: z.string().max(80).optional(),
    description: z.string().max(500).optional(),
    type: z.enum(["string", "number", "boolean", "date"]).default("string"),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    /** Allowed values, shown as a choice list. */
    choices: z.array(z.union([z.string(), z.number()])).optional(),
  })
  .strict();

export const scheduleSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("manual") }).strict(),
  z.object({ type: z.literal("interval"), minutes: z.number().int().min(1).max(525_600) }).strict(),
  z.object({ type: z.literal("daily"), at: clock, days: z.array(weekday).min(1).optional() }).strict(),
  z.object({ type: z.literal("weekly"), day: weekday, at: clock }).strict(),
  z.object({ type: z.literal("monthly"), day: z.union([z.number().int().min(1).max(31), z.literal("last")]), at: clock }).strict(),
  z.object({ type: z.literal("cron"), expression: z.string().min(1).max(120).superRefine((value, ctx) => { const message = cronProblem(value); if (message) ctx.addIssue({ code: "custom", message }); }) }).strict(),
  /** When a new file appears (or changes) in a folder matching a pattern. */
  z.object({ type: z.literal("file"), path: z.string().min(1), settleSeconds: z.number().int().min(0).max(3600).default(10) }).strict(),
  /** After other pipelines finish. `success`: only if they all succeeded (upstream failure blocks this one). */
  z.object({ type: z.literal("after"), pipelines: z.array(z.string().min(1)).min(1), when: z.enum(["success", "completion"]).default("success") }).strict(),
]);

export const stepSchema = z
  .object({
    id: stepId,
    name: z.string().max(80).optional(),
    uses: z.string().min(1),
    with: z.record(z.string(), z.unknown()).default({}),
    /** Upstream steps. Omitted = the previous step (for blocks that need input). */
    needs: z.array(stepId).optional(),
    retry: retrySchema.optional(),
    /** Keep going when this step fails (its downstream steps are skipped). */
    continueOnError: z.boolean().default(false),
    /** Save this step's output so a failed run can resume after it (on by default for long pipelines). */
    checkpoint: z.boolean().default(true),
    /** Designer position; ignored by the engine. */
    position: z.object({ x: z.number(), y: z.number() }).strict().optional(),
  })
  .strict();

export const pipelineSchema = z
  .object({
    nexus: z.literal(PIPELINE_FORMAT).default(PIPELINE_FORMAT),
    name: z.string().trim().min(1).max(80),
    description: z.string().max(2000).optional(),
    params: z.array(paramSchema).default([]),
    steps: z.array(stepSchema).min(1, "A pipeline needs at least one step."),
    schedule: scheduleSchema.default({ type: "manual" }),
    /** Default retry policy for steps that don't set their own. */
    retry: retrySchema.default({ attempts: 2, delaySeconds: 60, backoff: "exponential" }),
    resources: z
      .object({
        memoryMb: z.union([z.literal("auto"), z.number().int().min(128)]).default("auto"),
        cpuPercent: z.union([z.literal("auto"), z.number().int().min(5).max(100)]).default("auto"),
        gpu: z.enum(["allowed", "never"]).default("allowed"),
        priority: z.enum(["low", "normal", "high"]).default("normal"),
        /** A run is stopped if it takes longer than this. */
        timeoutMinutes: z.number().int().min(1).max(10_080).default(720),
      })
      .strict()
      .default({ memoryMb: "auto", cpuPercent: "auto", gpu: "allowed", priority: "normal", timeoutMinutes: 720 }),
    notifications: z
      .object({
        onFailure: z.boolean().default(true),
        onSuccess: z.boolean().default(false),
        onAnomaly: z.boolean().default(true),
        onDataQuality: z.boolean().default(true),
      })
      .strict()
      .default({ onFailure: true, onSuccess: false, onAnomaly: true, onDataQuality: true }),
  })
  .strict();

export type PipelineDefinition = z.output<typeof pipelineSchema>;
export type PipelineInput = z.input<typeof pipelineSchema>;
export type StepDefinition = z.output<typeof stepSchema>;
export type Schedule = z.output<typeof scheduleSchema>;
export type ParamDefinition = z.output<typeof paramSchema>;
export type RetryPolicy = z.output<typeof retrySchema>;

/** A validated pipeline: defaults filled in, every step's inputs resolved, steps in run order. */
export interface NormalizedPipeline extends PipelineDefinition {
  steps: (StepDefinition & { needs: string[] })[];
  /** Step ids in an order where every step comes after its inputs. */
  order: string[];
}

export interface PipelineIssue {
  /** Where: "steps.clean.with.script", "params.start_date", "steps". */
  path: string;
  message: string;
}

/** Placeholders every pipeline may use besides its own parameters. */
export const BUILTIN_PLACEHOLDERS = ["run.id", "run.date", "run.time", "run.timestamp", "pipeline.name", "last_success.date", "last_success.timestamp"];
const PLACEHOLDER = /\{\{\s*([a-z_]+(?:\.[a-z_][a-z0-9_]*)?)\s*\}\}/g;

function placeholders(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof value === "string") for (const m of value.matchAll(PLACEHOLDER)) out.add(m[1]!);
  else if (Array.isArray(value)) value.forEach((v) => placeholders(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => placeholders(v, out));
  return out;
}

/** "groupBy" → "group by": setting names as people read them. */
const words = (key: string) => key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase();

/** Zod's wording ("Invalid input: expected string, received undefined") → plain words. */
function plainMessage(i: z.core.$ZodIssue): string {
  const field = [...i.path].reverse().find((p) => typeof p === "string");
  if (i.code === "invalid_type" && /received undefined$/.test(i.message)) return field ? `Please fill in ${words(String(field))}.` : "Something required is missing.";
  if (i.code === "invalid_type") return `${field ? `${words(String(field)).replace(/^./, (c) => c.toUpperCase())} ` : ""}has the wrong kind of value (${i.message.replace(/^Invalid input: /, "")}).`;
  if (i.code === "unrecognized_keys") return `${i.message.replace(/^Unrecognized keys?:?/, "Unknown setting:")}`;
  return i.message;
}

const zodIssues = (e: z.ZodError, prefix: string): PipelineIssue[] =>
  e.issues.map((i) => ({ path: [prefix, ...i.path.map(String)].filter(Boolean).join("."), message: plainMessage(i) }));

/** Friendlier paths: "steps.2.with.script" → "steps.clean.with.script". */
function namePaths(issues: PipelineIssue[], raw: unknown): PipelineIssue[] {
  const steps = (raw as { steps?: { id?: unknown }[] })?.steps;
  return issues.map((i) => {
    const m = i.path.match(/^steps\.(\d+)(\..*)?$/);
    const id = m ? steps?.[Number(m[1])]?.id : undefined;
    return typeof id === "string" ? { ...i, path: `steps.${id}${m![2] ?? ""}` } : i;
  });
}

/**
 * Checks a pipeline completely and returns it normalised, or the list of problems in plain words.
 * Never throws for bad input.
 */
export function validatePipeline(raw: unknown): { ok: true; pipeline: NormalizedPipeline } | { ok: false; issues: PipelineIssue[] } {
  // A normalised pipeline sent back as-is (designer, re-import) carries its computed run order; it is
  // always recomputed, so it's ignored rather than rejected.
  if (raw && typeof raw === "object" && !Array.isArray(raw) && "order" in raw) {
    const { order: _order, ...rest } = raw as Record<string, unknown>;
    raw = rest;
  }
  const parsed = pipelineSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, issues: namePaths(zodIssues(parsed.error, ""), raw) };
  const def = parsed.data;
  const issues: PipelineIssue[] = [];

  // Parameters
  const paramNames = new Set<string>();
  for (const p of def.params) {
    if (paramNames.has(p.name)) issues.push({ path: `params.${p.name}`, message: `There are two parameters called ${p.name}.` });
    paramNames.add(p.name);
    if (p.default !== undefined && p.type === "number" && typeof p.default !== "number") issues.push({ path: `params.${p.name}`, message: "The default must be a number." });
    if (p.default !== undefined && p.type === "date" && !/^\d{4}-\d{2}-\d{2}$|\{\{/.test(String(p.default))) issues.push({ path: `params.${p.name}`, message: "Use a date like 2025-01-31 as the default." });
  }

  // Steps: known blocks, valid configuration, unique names
  const ids = new Set<string>();
  const specs = new Map<string, BlockSpec>();
  const steps: NormalizedPipeline["steps"] = [];
  def.steps.forEach((s, index) => {
    if (ids.has(s.id)) issues.push({ path: `steps.${s.id}`, message: `Two steps are called ${s.id}. Give each step its own name.` });
    ids.add(s.id);
    const spec = block(s.uses);
    if (!spec) {
      issues.push({ path: `steps.${s.id}.uses`, message: `"${s.uses}" isn't a known block.` });
      steps.push({ ...s, needs: s.needs ?? [] });
      return;
    }
    specs.set(s.id, spec);
    const cfg = spec.config.safeParse(s.with);
    if (!cfg.success) issues.push(...zodIssues(cfg.error, `steps.${s.id}.with`));
    // Implicit wiring: a block that accepts input reads from the step before it (needs: [] opts out).
    const needs = s.needs ?? (spec.inputs.max > 0 && index > 0 ? [def.steps[index - 1]!.id] : []);
    steps.push({ ...s, with: cfg.success ? (cfg.data as Record<string, unknown>) : s.with, needs });
  });

  for (const s of steps) {
    const spec = specs.get(s.id);
    for (const n of s.needs) {
      if (!ids.has(n)) issues.push({ path: `steps.${s.id}.needs`, message: `Step ${s.id} reads from "${n}", but there is no step with that name.` });
      if (n === s.id) issues.push({ path: `steps.${s.id}.needs`, message: `Step ${s.id} can't read from itself.` });
    }
    if (spec && (s.needs.length < spec.inputs.min || s.needs.length > spec.inputs.max)) {
      const want = spec.inputs.max === 0 ? "no inputs (it's where data comes from)" : spec.inputs.min === spec.inputs.max ? `${spec.inputs.min} input${spec.inputs.min === 1 ? "" : "s"}` : `${spec.inputs.min}–${spec.inputs.max} inputs`;
      issues.push({ path: `steps.${s.id}.needs`, message: `${spec.label} (${s.id}) takes ${want}, but has ${s.needs.length}.` });
    }
    for (const ph of placeholders(s.with)) {
      if (ph.startsWith("params.")) {
        if (!paramNames.has(ph.slice(7))) issues.push({ path: `steps.${s.id}.with`, message: `{{${ph}}} refers to a parameter that isn't defined.` });
      } else if (!BUILTIN_PLACEHOLDERS.includes(ph)) {
        issues.push({ path: `steps.${s.id}.with`, message: `{{${ph}}} isn't a known placeholder.` });
      }
    }
  }

  // Order (Kahn's algorithm); anything left over sits on a cycle.
  const order: string[] = [];
  const remaining = new Map(steps.map((s) => [s.id, new Set(s.needs.filter((n) => ids.has(n) && n !== s.id))]));
  while (remaining.size) {
    const ready = [...remaining.entries()].filter(([, deps]) => deps.size === 0).map(([id]) => id);
    if (!ready.length) {
      issues.push({ path: "steps", message: `These steps depend on each other in a loop: ${[...remaining.keys()].join(", ")}.` });
      break;
    }
    for (const id of ready) {
      order.push(id);
      remaining.delete(id);
      for (const deps of remaining.values()) deps.delete(id);
    }
  }

  if (issues.length) return { ok: false, issues };
  return { ok: true, pipeline: { ...def, steps, order } };
}

/** A pipeline that can't be saved or run; `issues` lets the designer point at each problem. */
export class PipelineInvalidError extends NexusError {
  constructor(
    message: string,
    readonly issues: PipelineIssue[],
  ) {
    super("invalid_input", message);
  }
}

/** Like validatePipeline, but throws a friendly error listing the problems. */
export function normalizePipeline(raw: unknown): NormalizedPipeline {
  const r = validatePipeline(raw);
  if (r.ok) return r.pipeline;
  const list = r.issues.slice(0, 8).map((i) => `• ${i.path ? `${i.path}: ` : ""}${i.message}`).join("\n");
  throw new PipelineInvalidError(`This pipeline has ${r.issues.length === 1 ? "a problem" : `${r.issues.length} problems`}:\n${list}`, r.issues);
}

/** Reads a pipeline file (YAML or JSON). */
export function parsePipelineText(text: string): NormalizedPipeline {
  let raw: unknown;
  try {
    raw = parseYaml(text, { prettyErrors: true, maxAliasCount: 50 });
  } catch (e) {
    throw NexusError.invalid(`The pipeline file couldn't be read: ${(e as Error).message.split("\n")[0]}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw NexusError.invalid("A pipeline file must describe one pipeline (name, steps, …).");
  return normalizePipeline(raw);
}

/**
 * The pipeline as people write it: defaults and implicit wiring left out, so an exported file
 * stays short and a re-import produces the same pipeline.
 */
export function toDocument(p: NormalizedPipeline | PipelineDefinition): Record<string, unknown> {
  const out: Record<string, unknown> = { nexus: PIPELINE_FORMAT, name: p.name };
  if (p.description) out.description = p.description;
  if (p.params.length) out.params = p.params;
  if (p.schedule.type !== "manual") out.schedule = p.schedule;
  out.steps = p.steps.map((s, i) => {
    const spec = block(s.uses);
    const implicit = spec && spec.inputs.max > 0 && i > 0 ? [p.steps[i - 1]!.id] : [];
    const step: Record<string, unknown> = { id: s.id };
    if (s.name) step.name = s.name;
    step.uses = s.uses;
    if (Object.keys(s.with).length) step.with = s.with;
    if (s.needs && JSON.stringify(s.needs) !== JSON.stringify(implicit)) step.needs = s.needs;
    if (s.retry) step.retry = s.retry;
    if (s.continueOnError) step.continueOnError = true;
    if (s.checkpoint === false) step.checkpoint = false;
    if (s.position) step.position = s.position;
    return step;
  });
  const defaults = pipelineSchema.parse({ name: "x", steps: [{ id: "x", uses: "notify" }] });
  for (const key of ["retry", "resources", "notifications"] as const) {
    if (canonical(p[key]) !== canonical(defaults[key])) out[key] = p[key];
  }
  return out;
}

export function toYaml(p: NormalizedPipeline | PipelineDefinition): string {
  return toYamlText(toDocument(p), { lineWidth: 0 });
}

/** Stable JSON (sorted keys) — the basis of version hashes and diffs. */
export function canonical(value: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sort) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])])) : v;
  return JSON.stringify(sort(value));
}

/** Content hash of a pipeline; designer positions don't count as a change. */
export function pipelineHash(p: PipelineDefinition): string {
  const withoutLayout = { ...p, steps: p.steps.map(({ position: _position, ...s }) => s) };
  return createHash("sha256").update(canonical(withoutLayout)).digest("hex");
}
