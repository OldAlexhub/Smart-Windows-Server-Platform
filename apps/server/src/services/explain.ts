import type { ChatMessage } from "@nexus/ai";
import { explainError } from "@nexus/logs";
import { diagnoseRun, type RunDiagnosis } from "@nexus/pipelines";
import { BRAND, NexusError, type FriendlyProblem } from "@nexus/shared";
import type { NexusContext } from "../context";
import type { AppManager } from "./apps";
import type { QuestionModel } from "./data-questions";
import type { PipelineService } from "./pipelines";

export interface AiExplanation {
  /** Two to four plain sentences: what happened and the most likely reason. */
  explanation: string;
  /** Concrete next steps. The AI only recommends; nothing is changed. */
  steps: string[];
}

export interface AppExplanation {
  appId: string;
  /** Nexus's own rule-based diagnosis (always available, works offline). */
  problem: FriendlyProblem | null;
  /** Recent error lines the explanation is based on (already redacted). */
  evidence: { at: string; message: string }[];
  ai: AiExplanation | null;
}

export interface RunExplanation {
  runId: string;
  diagnosis: RunDiagnosis | null;
  evidence: { at: string; message: string }[];
  ai: AiExplanation | null;
}

const SYSTEM = `You are ${BRAND.assistantName}, the assistant inside ${BRAND.productName}, a private server run by a business owner.
Explain technical problems in plain, friendly English without jargon. Never claim you changed anything — you can only recommend.
Use observed structured checks before log speculation. Clearly distinguish OBSERVED facts, INFERRED conclusions, and POSSIBLE causes. Do not invent a database or restart theory without evidence. HTTP 404 means an HTTP server responded; when it came from an automatically detected health candidate, explain that the candidate may be wrong and recommend automatic/general monitoring. A user-configured or runtime-validated endpoint is authoritative and may use strict status semantics.
Answer with JSON only: {"explanation": "2–4 sentences: what happened and the most likely reason", "steps": ["up to 4 short, concrete next steps"]}.`;

function parseExplanation(text: string): AiExplanation | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  try {
    const j = JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : text) as { explanation?: unknown; steps?: unknown };
    if (typeof j.explanation !== "string" || !j.explanation.trim()) return null;
    const steps = Array.isArray(j.steps) ? j.steps.filter((s): s is string => typeof s === "string" && !!s.trim()).slice(0, 4) : [];
    return { explanation: j.explanation.trim().slice(0, 1200), steps: steps.map((s) => s.trim().slice(0, 300)) };
  } catch {
    const plain = text.trim();
    return plain && !plain.startsWith("{") ? { explanation: plain.slice(0, 1200), steps: [] } : null;
  }
}

/**
 * "Explain this": crashes and errors of applications, and failed pipeline runs. Nexus's own rules
 * always answer (offline, instantly); when the local AI is ready it adds a short explanation in
 * plain words, based on the same evidence. Logs reach the model only after secret redaction.
 */
export class ExplainService {
  constructor(
    private readonly ctx: NexusContext,
    private readonly apps: AppManager,
    private readonly pipelines: PipelineService,
    private readonly model: () => QuestionModel | null,
  ) {}

  async explainApp(appId: string): Promise<AppExplanation> {
    const app = this.apps.require(appId);
    const summary = this.apps.summary(app);
    const errors = this.ctx.logs.search(`app:${appId}`, { level: "problems", limit: 30 });
    const evidence = errors.slice(-12).map((e) => ({ at: e.t, message: e.message.slice(0, 2000) }));
    const latestError = [...errors].reverse().find((e) => e.level === "error");
    const problem =
      app.problem ??
      (latestError
        ? explainError(latestError.message, { appName: app.name, databasePort: this.ctx.postgres?.port ?? null, databaseRunning: this.ctx.postgres ? (await this.ctx.postgres.state()) === "running" : null })
        : null);
    if (!problem && !evidence.length) return { appId, problem: null, evidence, ai: null };
    const facts = [
      `Application: ${app.name} (${app.analysis.summary || app.analysis.runtime}), status: ${summary.status}.`,
      `Memory ${Math.round(summary.memoryBytes / 1024 / 1024)} MB, CPU ${summary.cpuPercent.toFixed(0)}%.`,
      app.databaseId ? "It uses a Nexus PostgreSQL database." : app.documentDatabaseId ? "It uses a Nexus document (MongoDB-compatible) database." : "It has no Nexus database.",
      problem ? `Nexus's own diagnosis: ${problem.title} — ${problem.summary}${problem.cause ? ` (${problem.cause})` : ""}` : "",
      ...(problem?.checks ?? []).map((check) => `Observed check: ${check.label} = ${check.status}${check.detail ? ` (${check.detail})` : ""}.`),
      app.analysis.health.rejection ? `Observed health monitoring: detected candidate ${app.analysis.health.rejection.path} was rejected because ${app.analysis.health.rejection.reason} Nexus fell back to general HTTP liveness.` : "",
    ].filter(Boolean);
    const ai = await this.ask([
      { role: "system", content: SYSTEM },
      { role: "user", content: `${facts.join("\n")}\n\nRecent error and warning lines (newest last):\n${evidence.map((e) => `[${e.at}] ${e.message}`).join("\n").slice(-6000)}\n\nWhy is this happening and what should I do?` },
    ]);
    return { appId, problem, evidence, ai };
  }

  async explainRun(runId: string): Promise<RunExplanation> {
    const run = this.pipelines.engine.runs.require(runId);
    const pipeline = this.pipelines.store.require(run.pipelineId);
    const version = pipeline.version === run.version ? pipeline.definition : this.pipelines.store.version(pipeline.id, run.version).definition;
    const lastGood = this.pipelines.engine.runs.list(pipeline.id, 100).find((r) => r.status === "succeeded" && r.testRows === null && r.startedAt < run.startedAt) ?? null;
    const diagnosis = diagnoseRun(version, run, lastGood);
    if (!diagnosis) throw NexusError.conflict("This run didn't fail, so there is nothing to explain.");
    const logs = this.pipelines.engine.logs(runId, diagnosis.stepId ?? undefined).filter((l) => l.level !== "info" || !l.message.startsWith("Started"));
    const evidence = logs.slice(-15).map((l) => ({ at: l.time, message: l.message.slice(0, 2000) }));
    const ai = await this.ask([
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: `Pipeline "${pipeline.name}" failed${diagnosis.stepId ? ` at step "${diagnosis.stepId}"` : ""}.
Nexus's own diagnosis: ${diagnosis.title} — ${diagnosis.summary}
${diagnosis.details.join("\n")}
Log (newest last):
${evidence.map((e) => e.message).join("\n").slice(-6000)}

Explain what went wrong and what to do.`,
      },
    ]);
    return { runId, diagnosis, evidence, ai };
  }

  private async ask(messages: ChatMessage[]): Promise<AiExplanation | null> {
    const model = this.model();
    if (!model) return null;
    try {
      return parseExplanation(await model.chat(messages, { json: true }));
    } catch (e) {
      this.ctx.log.warn("AI explanation failed", { err: e as Error });
      return null;
    }
  }
}
