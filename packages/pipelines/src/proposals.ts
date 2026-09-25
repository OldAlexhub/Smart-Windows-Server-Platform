import { z } from "zod";
import { BLOCKS, block } from "./blocks";
import { validatePipeline, toDocument, type NormalizedPipeline, type PipelineIssue } from "./definition";

/**
 * "Describe the pipeline you want." The local model turns a sentence into a proposed pipeline made
 * of the normal blocks (plus any short Python/R scripts it needs). Nothing is saved or switched on:
 * the person reviews the proposal, and creating it gives a pipeline that starts switched off.
 */

export interface ProposalMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** What the model may know about this server: names only, never data. */
export interface ProposalContext {
  databases: { name: string; tables: { name: string; columns: string[] }[] }[];
  secrets: string[];
}

export interface GeneratedScript {
  stepId: string;
  language: "python" | "r";
  /** File name the script gets when the pipeline is created (e.g. remove_duplicates.py). */
  fileName: string;
  code: string;
}

export interface PipelineProposal {
  /** The pipeline as a document (what the designer and POST /pipelines take). Script paths are placeholders until created. */
  definition: Record<string, unknown>;
  scripts: GeneratedScript[];
  /** What the model assumed (e.g. "Every night" → 02:00). */
  assumptions: string[];
  /** Things to check before creating it (unknown database, missing secret…). */
  warnings: string[];
}

const MAX_SCRIPT = 50_000;

const answerSchema = z.object({
  pipeline: z.record(z.string(), z.unknown()),
  scripts: z
    .array(z.object({ step: z.string(), language: z.string(), code: z.string() }).passthrough())
    .default([]),
  assumptions: z.array(z.string()).default([]),
});

// ---------------------------------------------------------------- the prompt

/** Settings of one block, from its schema: `table?, query?, incremental?` */
function settingsOf(kind: string): string {
  const spec = block(kind)!;
  const json = z.toJSONSchema(spec.config, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  const props = new Map<string, boolean>();
  const collect = (s: unknown) => {
    if (!s || typeof s !== "object") return;
    const o = s as { properties?: Record<string, unknown>; required?: string[]; allOf?: unknown[]; anyOf?: unknown[] };
    for (const name of Object.keys(o.properties ?? {})) props.set(name, (props.get(name) ?? false) || !!o.required?.includes(name));
    for (const sub of [...(o.allOf ?? []), ...(o.anyOf ?? [])]) collect(sub);
  };
  collect(json);
  return [...props].map(([name, required]) => (required ? name : `${name}?`)).join(", ");
}

/** A compact description of every block for the model. */
export function blockGuide(): string {
  return BLOCKS.map((b) => {
    const inputs = b.inputs.max === 0 ? "no input" : b.inputs.min === b.inputs.max ? `${b.inputs.min} input${b.inputs.min === 1 ? "" : "s"}` : `${b.inputs.min}–${b.inputs.max} inputs`;
    return `- ${b.kind} (${b.category}, ${inputs}): ${b.description} Settings: ${settingsOf(b.kind) || "none"}`;
  }).join("\n");
}

function describeContext(c: ProposalContext): string {
  const dbs = c.databases.length
    ? c.databases
        .map((d) => `- ${d.name}${d.tables.length ? `: ${d.tables.map((t) => `${t.name}(${t.columns.slice(0, 25).join(", ")})`).join("; ")}` : " (no tables yet)"}`)
        .join("\n")
    : "(none)";
  return `Nexus databases on this server (use their names in connection.database):\n${dbs}\nSaved secrets: ${c.secrets.length ? c.secrets.join(", ") : "(none)"}`;
}

export function proposalPrompt(request: string, context: ProposalContext): ProposalMessage[] {
  const system = `You design data pipelines for Nexus, a private server. Turn the person's request into a pipeline made ONLY of these blocks:
${blockGuide()}

Rules:
- A pipeline is {"name", "description", "schedule", "steps"}. Each step is {"id", "name", "uses", "with", "needs"?}. Step ids use lowercase letters, numbers, - and _. A step without "needs" reads from the step before it.
- connection is {"database": "<Nexus database name>"} or {"secret": "<secret holding a connection URL>"}.
- Read a table with "table" OR a query with "query", never both. "Only new rows" / "incremental" → "incremental": {"column": "<timestamp or id column>"}.
- "Operations Warehouse", "the warehouse", reports and dashboards → warehouse.write / warehouse.read.
- Prefer the built-in blocks (filter, deduplicate, aggregate, transform, sql, validate). Use a python or r step only when the person asks for Python or R, or for work the other blocks can't do.
- For each python or r step you write the script: set "with": {"script": "<step id>.py" or "<step id>.R"} and add it to "scripts". Python scripts: from nexus import input_data, output_data; df = input_data() (a pandas DataFrame); …; output_data(df). R scripts: df <- nexus_input() (a data.frame); …; nexus_output(df). Keep scripts short, commented and safe: no network, no deleting files.
- If the person names an existing script path (like C:\\Scripts\\clean.py), use it as "script" and don't write one.
- schedule: {"type":"manual"} | {"type":"interval","minutes":N} | {"type":"daily","at":"HH:MM","days"?:["mon",…]} | {"type":"weekly","day":"mon","at":"HH:MM"} | {"type":"monthly","day":1,"at":"HH:MM"} | {"type":"file","path":"C:\\\\Folder\\\\*.csv"}. "Every night" means daily at 02:00 unless a time is given.
- Only use databases, tables, columns and secrets that exist below, or that the person names. Never invent passwords or URLs.
- List every guess you made in "assumptions", in plain words.

${describeContext(context)}

Answer with JSON only:
{"pipeline": {…}, "scripts": [{"step": "<step id>", "language": "python" | "r", "code": "…"}], "assumptions": ["…"]}`;
  return [
    { role: "system", content: system },
    { role: "user", content: request },
  ];
}

export function proposalRepairPrompt(previous: ProposalMessage[], answer: string, problems: string[]): ProposalMessage[] {
  return [
    ...previous,
    { role: "assistant", content: answer },
    { role: "user", content: `That pipeline has problems:\n${problems.map((p) => `- ${p}`).join("\n")}\nFix them and answer with the complete JSON again.` },
  ];
}

// ---------------------------------------------------------------- reading the answer

export type ProposalCheck = { ok: true; proposal: PipelineProposal; pipeline: NormalizedPipeline } | { ok: false; problems: string[] };

const jsonOf = (text: string): unknown => {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : text);
};

const scriptFileName = (stepId: string, language: "python" | "r") => `${stepId.replace(/[^a-z0-9_]/g, "_")}.${language === "python" ? "py" : "R"}`;

/** Script files and paths that clearly aren't something the person pointed at. */
const isPlaceholder = (script: unknown, stepId: string) => typeof script !== "string" || !/[\\/:]/.test(script) || script.replace(/\.(py|r)$/i, "") === stepId;

/**
 * Checks the model's answer: valid JSON, a valid pipeline, a script for every python/r step that
 * doesn't point at an existing file. Problems go back to the model once; warnings go to the person.
 */
export function checkProposal(text: string, context: ProposalContext): ProposalCheck {
  let answer: z.output<typeof answerSchema>;
  try {
    answer = answerSchema.parse(jsonOf(text));
  } catch {
    return { ok: false, problems: ['The answer must be JSON like {"pipeline": {…}, "scripts": […], "assumptions": […]}.'] };
  }
  const raw = { ...answer.pipeline };
  delete raw.nexus;
  const steps = Array.isArray(raw.steps) ? (raw.steps as Record<string, unknown>[]) : [];
  const scripts: GeneratedScript[] = [];
  const problems: string[] = [];
  for (const s of steps) {
    const kind = s.uses;
    if (kind !== "python" && kind !== "r") continue;
    const id = String(s.id ?? "");
    const code = answer.scripts.find((x) => x.step === id)?.code?.trim();
    const w = (s.with && typeof s.with === "object" ? s.with : {}) as Record<string, unknown>;
    if (code) {
      if (code.length > MAX_SCRIPT) problems.push(`The script for ${id} is too long; keep it short.`);
      const fileName = scriptFileName(id, kind);
      scripts.push({ stepId: id, language: kind, fileName, code: code.endsWith("\n") ? code : `${code}\n` });
      s.with = { ...w, script: fileName };
    } else if (isPlaceholder(w.script, id)) {
      problems.push(`Step ${id} is a ${kind === "r" ? "R" : "Python"} step: write its script in "scripts", or use a script path the person gave.`);
    }
  }
  const v = validatePipeline(raw);
  if (!v.ok) problems.push(...v.issues.slice(0, 10).map((i: PipelineIssue) => `${i.path ? `${i.path}: ` : ""}${i.message}`));
  if (problems.length || !v.ok) return { ok: false, problems };

  const pipeline = v.pipeline;
  const warnings: string[] = [];
  const known = new Set(context.databases.map((d) => d.name.toLowerCase()));
  const secrets = new Set(context.secrets);
  for (const s of pipeline.steps) {
    const w = s.with as Record<string, unknown>;
    const conn = w.connection as { database?: string; secret?: string } | undefined;
    const label = s.name ?? s.id;
    if (conn?.database && !known.has(conn.database.toLowerCase())) warnings.push(`${label} uses a database called ${conn.database}, which isn't on this server. Choose the right one before running it.`);
    if (conn?.secret && !secrets.has(conn.secret)) warnings.push(`${label} needs a secret called ${conn.secret}. Add it under Pipelines › Secrets before running.`);
    for (const name of [...Object.values((w.secretHeaders as Record<string, string>) ?? {})]) if (!secrets.has(name)) warnings.push(`${label} needs a secret called ${name}. Add it under Pipelines › Secrets before running.`);
  }
  return {
    ok: true,
    pipeline,
    proposal: {
      definition: toDocument(pipeline),
      scripts: scripts.filter((x) => pipeline.steps.some((s) => s.id === x.stepId)),
      assumptions: answer.assumptions.map((a) => a.trim()).filter(Boolean).slice(0, 10),
      warnings: [...new Set(warnings)],
    },
  };
}

/**
 * Where generated scripts go when a proposal is created: a file per script in `dir`, never over an
 * existing file (clean.py → clean-2.py). Returns the definition with the real script paths.
 */
export function placeScripts(
  definition: Record<string, unknown>,
  scripts: GeneratedScript[],
  dir: string,
  exists: (path: string) => boolean,
  join: (...parts: string[]) => string,
): { definition: Record<string, unknown>; files: { path: string; code: string }[] } {
  const steps = (Array.isArray(definition.steps) ? definition.steps : []) as Record<string, unknown>[];
  const files: { path: string; code: string }[] = [];
  const out = steps.map((s) => {
    const script = scripts.find((x) => x.stepId === s.id);
    if (!script) return s;
    const [base, ext] = [script.fileName.replace(/\.[^.]+$/, ""), script.language === "python" ? ".py" : ".R"];
    let path = join(dir, `${base}${ext}`);
    for (let n = 2; exists(path) || files.some((f) => f.path === path); n++) path = join(dir, `${base}-${n}${ext}`);
    files.push({ path, code: script.code });
    return { ...s, with: { ...((s.with as Record<string, unknown>) ?? {}), script: path } };
  });
  return { definition: { ...definition, steps: out }, files };
}
