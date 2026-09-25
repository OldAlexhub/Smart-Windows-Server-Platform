import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkProposal, normalizePipeline, placeScripts, proposalPrompt, proposalRepairPrompt, type GeneratedScript, type PipelineProposal, type PipelineRecord, type ProposalContext } from "@nexus/pipelines";
import { NexusError } from "@nexus/shared";
import type { NexusContext } from "../context";
import type { QuestionModel } from "./data-questions";
import type { PipelineService } from "./pipelines";

const MAX_DATABASES = 12;
const MAX_TABLES = 40;

/**
 * Natural-language pipeline creation. The local model proposes; the person reviews (flow, schedule,
 * any scripts it wrote) and creates. Created pipelines start switched off, like every new pipeline,
 * and generated scripts never replace an existing file.
 */
export class PipelineProposalService {
  constructor(
    private readonly ctx: NexusContext,
    private readonly pipelines: PipelineService,
    private readonly model: () => QuestionModel | null,
  ) {}

  /** Names of databases, tables, columns and secrets — never any data. */
  async context(): Promise<ProposalContext> {
    const dbs = this.ctx.databases?.list() ?? [];
    const browser = this.ctx.dataBrowser;
    const databases = await Promise.all(
      dbs.slice(0, MAX_DATABASES).map(async (d) => {
        if (!browser) return { name: d.name, tables: [] };
        try {
          const tables = (await browser.listTables(d.id)).slice(0, MAX_TABLES);
          return { name: d.name, tables: await Promise.all(tables.map(async (t) => ({ name: t.name, columns: (await browser.describe(d.id, t.name)).columns.map((c) => c.name) }))) };
        } catch {
          return { name: d.name, tables: [] };
        }
      }),
    );
    return { databases, secrets: this.pipelines.secretNames().map((s) => s.name) };
  }

  async propose(request: string): Promise<PipelineProposal> {
    const text = request.trim();
    if (!text) throw NexusError.invalid("Describe the pipeline you'd like, e.g. “Every night, copy completed trips from TaxiOps into the Warehouse.”");
    const model = this.model();
    if (!model) {
      throw new NexusError("conflict", "Describing a pipeline in plain English needs the AI to be ready.", {
        problem: {
          title: "AI isn't ready",
          summary: "The local AI model is off, still downloading, or not installed. You can still start from a template or build the pipeline yourself.",
          checks: [{ label: "AI model", status: "failed" }],
          repair: { id: "ai.open-settings", label: "Open AI settings", requiresConfirmation: false },
        },
      });
    }
    const context = await this.context();
    let messages = proposalPrompt(text, context);
    let problems: string[] = [];
    // One chance to fix a pipeline that doesn't validate.
    for (let attempt = 0; attempt < 2; attempt++) {
      const answer = await model.chat(messages, { json: true });
      const r = checkProposal(answer, context);
      if (r.ok) {
        for (const s of r.pipeline.steps) {
          const path = (s.with as { path?: unknown }).path;
          if (typeof path !== "string" || /[*?]/.test(path) || !/(csv|excel|json|parquet|sqlite)\.read$/.test(s.uses)) continue;
          if (!existsSync(path)) r.proposal.warnings.push(`${s.name ?? s.id} reads ${path}, which doesn't exist yet.`);
        }
        this.ctx.log.info("pipeline proposed", { steps: r.pipeline.steps.length, repaired: attempt > 0 });
        return r.proposal;
      }
      problems = r.problems;
      messages = proposalRepairPrompt(messages, answer, problems);
    }
    throw NexusError.conflict(`The AI couldn't turn that into a working pipeline (${problems[0] ?? "unknown problem"}). Try describing it step by step, or start from a template.`);
  }

  /** Creates a reviewed proposal: writes its scripts, then creates the pipeline switched off. */
  create(input: { definition: Record<string, unknown>; scripts: GeneratedScript[] }, userId: string): { pipeline: PipelineRecord; scripts: string[] } {
    const steps = (Array.isArray(input.definition.steps) ? input.definition.steps : []) as { id?: unknown; uses?: unknown; with?: { script?: unknown } }[];
    for (const s of steps) {
      if (s.uses !== "python" && s.uses !== "r") continue;
      const hasCode = input.scripts.some((x) => x.stepId === s.id && x.code.trim());
      if (!hasCode && !/[\\/]/.test(String(s.with?.script ?? ""))) throw NexusError.invalid(`Step ${String(s.id)} has no script. Add its code or choose a script file.`);
    }
    const name = typeof input.definition.name === "string" ? input.definition.name : "pipeline";
    const folder = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "pipeline";
    const dir = join(this.pipelines.workRoot, "scripts", folder);
    const placed = placeScripts(input.definition, input.scripts, dir, existsSync, join);
    // Validate before touching the disk.
    normalizePipeline(placed.definition);
    if (placed.files.length) mkdirSync(dir, { recursive: true });
    for (const f of placed.files) writeFileSync(f.path, f.code, { encoding: "utf8", flag: "wx" });
    const pipeline = this.pipelines.store.create(placed.definition, userId);
    return { pipeline, scripts: placed.files.map((f) => f.path) };
  }
}
