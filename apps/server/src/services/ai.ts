import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { locateOllama, ollamaEnv, OllamaRuntime, planAi, type AiPlan, type ChatMessage } from "@nexus/ai";
import { computeHealthScore } from "@nexus/monitoring";
import { BRAND, formatBytes, type AiPermissionLevel } from "@nexus/shared";
import { SETTINGS, type NexusContext } from "../context";
import type { AppManager } from "./apps";

export interface AiStatus {
  enabled: boolean;
  level: AiPermissionLevel;
  plan: AiPlan | null;
  /** external: Nexus uses an Ollama someone already runs on this computer (it doesn't start or stop it). */
  runtime: { installed: boolean; running: boolean; version: string | null; modelReady: boolean; external: boolean };
  state: "off" | "not_installed" | "starting" | "downloading_model" | "ready" | "error";
  message: string;
}

/**
 * Local AI: chooses the model for this hardware, runs a Nexus-owned Ollama on a private
 * port, downloads the model in the background, and answers questions about the server.
 * Everything works offline; without a model, Nexus answers from its own diagnostics.
 */
/** Per-user Ollama installs Nexus can see (it can't use them directly, but can say what to do). */
function userOllamaInstalls(): string[] {
  const root = process.env.SystemDrive ? join(process.env.SystemDrive + "\\", "Users") : "C:\\Users";
  try {
    return readdirSync(root).filter((u) => existsSync(join(root, u, "AppData", "Local", "Programs", "Ollama", "ollama.exe")));
  } catch {
    return [];
  }
}

function notInstalledMessage(): string {
  const users = userOllamaInstalls();
  return users.length
    ? `Ollama is installed for ${users.join(", ")} but isn't running. Open Ollama and Nexus will connect to it automatically.`
    : "The AI engine isn't installed yet. Install Ollama (free and open source, from ollama.com), open it, and Nexus will connect to it automatically.";
}

export class AiService {
  private runtime: OllamaRuntime | null = null;
  private state: AiStatus["state"] = "off";
  private message = "";
  private external = false;
  private lastExternalCheck = 0;

  constructor(
    private readonly ctx: NexusContext,
    private readonly apps: AppManager,
  ) {}

  get enabled(): boolean {
    return this.ctx.settings.get(SETTINGS.aiEnabled, true);
  }

  get level(): AiPermissionLevel {
    return this.ctx.settings.get<AiPermissionLevel>(SETTINGS.aiLevel, "recommend");
  }

  plan(): AiPlan | null {
    const hw = this.ctx.hardware;
    return hw ? planAi(hw, { preferredModel: this.ctx.settings.get<string | null>(SETTINGS.aiModel, null) }) : null;
  }

  async status(): Promise<AiStatus> {
    const plan = this.plan();
    if (!this.runtime && this.enabled && this.state === "not_installed" && Date.now() - this.lastExternalCheck > 10_000) await this.attachExternal();
    const rt = (await this.runtime?.status()) ?? { installed: !!locateOllama(), running: false, version: null, models: [] };
    const modelReady = !!plan && rt.models.some((m) => m.id === plan.model.id || m.id === `${plan.model.id}:latest`);
    let state = this.state;
    if (!this.enabled) state = "off";
    else if (!rt.installed) state = "not_installed";
    else if (rt.running && modelReady) state = "ready";
    else if (state === "off") state = "starting";
    return {
      enabled: this.enabled,
      level: this.level,
      plan,
      runtime: { installed: rt.installed, running: rt.running, version: rt.version, modelReady, external: this.external },
      state,
      message:
        state === "ready"
          ? "Ready"
          : state === "not_installed"
            ? notInstalledMessage()
            : state === "downloading_model"
              ? this.message || "Downloading the AI model"
              : state === "off"
                ? "AI is turned off"
                : this.message || "Starting",
    };
  }

  /** Starts the runtime and fetches the model in the background (idempotent). */
  async start(): Promise<void> {
    if (!this.enabled || this.runtime) return;
    const exe = locateOllama(this.ctx.settings.get<string | null>("ai.ollamaPath", null));
    const plan = this.plan();
    if (!exe) {
      this.state = "not_installed";
      await this.attachExternal();
      return;
    }
    if (!plan || !this.ctx.dataPaths) {
      this.state = "error";
      return;
    }
    const port = await this.ctx.ports.allocate("ai", "ollama");
    this.runtime = new OllamaRuntime({
      baseUrl: `http://127.0.0.1:${port}`,
      exe,
      env: ollamaEnv(plan, { port, modelsDir: join(this.ctx.dataPaths.ai, "models") }),
      onOutput: (l) => this.ctx.logs.write("system:ai", "stdout", l),
    });
    this.ctx.onStop(() => this.runtime?.stop());
    await this.prepare(this.runtime, plan);
  }

  /**
   * No Ollama in a protected folder, but maybe one is already running for the person using this
   * computer (a per-user install). Nexus talks to it over its local address instead of running its
   * program: the service runs as SYSTEM and must never start a program from a folder a normal
   * account can change.
   */
  private async attachExternal(): Promise<void> {
    this.lastExternalCheck = Date.now();
    const plan = this.plan();
    if (this.runtime || !plan) return;
    const host = (process.env.OLLAMA_HOST || "127.0.0.1:11434").replace(/^https?:\/\//, "");
    if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host)) return;
    const probe = new OllamaRuntime({ baseUrl: `http://${host}` });
    if (!(await probe.status()).running) return;
    this.runtime = probe;
    this.external = true;
    this.ctx.log.info("using the Ollama already running on this computer", { host });
    void this.prepare(probe, plan);
  }

  private async prepare(runtime: OllamaRuntime, plan: AiPlan): Promise<void> {
    try {
      this.state = "starting";
      await runtime.start();
      this.state = "downloading_model";
      await runtime.ensureModel(plan.model.id, (p) => {
        this.message = p.total ? `Downloading ${plan.model.family} ${plan.model.parametersB}B — ${Math.floor(((p.completed ?? 0) / p.total) * 100)}%` : p.status;
      });
      this.state = "ready";
      this.ctx.activity.add("success", `${BRAND.assistantName} is ready (${plan.label}${this.external ? ", using your Ollama" : ""}).`);
    } catch (e) {
      this.state = "error";
      this.message = (e as Error).message;
    }
  }

  /** The model for features that need it (data questions…), or null while AI isn't ready. */
  questionModel(): { chat(messages: ChatMessage[], opts: { json: boolean }): Promise<string> } | null {
    const runtime = this.runtime;
    const plan = this.plan();
    if (!this.enabled || this.state !== "ready" || !runtime || !plan) return null;
    return { chat: (messages, opts) => runtime.chat({ model: plan.model.id, messages, json: opts.json, temperature: 0.1, signal: AbortSignal.timeout(120_000) }) };
  }

  /** A snapshot of the server in plain words, used as context for questions. */
  facts(): string[] {
    const apps = this.apps.list().map((a) => ({ a, s: this.apps.summary(a) }));
    const snap = this.ctx.monitoring?.latest();
    const lines: string[] = [];
    for (const { a, s } of apps) {
      lines.push(`App ${a.name}: ${s.status}, CPU ${s.cpuPercent.toFixed(0)}%, memory ${formatBytes(s.memoryBytes)}${s.problem ? `, problem: ${s.problem.title} — ${s.problem.summary}` : ""}`);
      if (a.analysis.health.rejection) {
        lines.push(`  Observed: detected health candidate ${a.analysis.health.rejection.path} was rejected (${a.analysis.health.rejection.reason}). The app uses general HTTP liveness monitoring.`);
      } else if (a.analysis.health.endpoint) {
        lines.push(`  Observed: health endpoint ${a.analysis.health.endpoint.path} is trusted because its source is ${a.analysis.health.endpoint.source}.`);
      }
      const counts = this.ctx.logs.countsFor(`app:${a.id}`);
      if (counts.errors) lines.push(`  ${a.name} logged ${counts.errors} errors today`);
    }
    if (snap) lines.push(`System CPU ${snap.cpuPercent.toFixed(0)}%, memory ${formatBytes(snap.memory.usedBytes)} of ${formatBytes(snap.memory.totalBytes)}`);
    for (const d of snap?.disks ?? []) lines.push(`Drive ${d.mount}: ${formatBytes(d.freeBytes)} free of ${formatBytes(d.totalBytes)}`);
    for (const db of this.ctx.databases?.list() ?? []) lines.push(`Database ${db.name} (tables), used by ${db.appIds.join(", ") || "no application"}`);
    for (const db of this.ctx.documents?.list() ?? []) lines.push(`Document database ${db.name}, used by ${db.appIds.join(", ") || "no application"}`);
    for (const provide of this.extraFacts) {
      try {
        lines.push(...provide());
      } catch {
        /* a failing source never breaks the assistant */
      }
    }
    for (const a of this.ctx.activity.list(8)) lines.push(`Recent (${a.at.slice(0, 16).replace("T", " ")}): ${a.message}`);
    return lines;
  }

  /** Other services add what they know (pipelines, backups, notifications…) without the assistant depending on them. */
  readonly extraFacts: (() => string[])[] = [];

  /**
   * "Ask Nexus". Uses the local model when ready; otherwise answers common questions from
   * Nexus's own diagnostics so the box is never useless offline or on small machines.
   */
  async ask(question: string, history: ChatMessage[] = []): Promise<{ answer: string; source: "ai" | "diagnostics" }> {
    const status = await this.status();
    const facts = this.facts();
    if (status.state === "ready" && this.runtime && status.plan) {
      const messages: ChatMessage[] = [
        {
          role: "system",
          content: `You are ${BRAND.assistantName}, the assistant inside ${BRAND.productName}, a private application server. Answer in plain, friendly English for a business owner. Be brief. Never claim you changed anything; you can only recommend.
Treat the supplied facts as authoritative observations. Clearly distinguish OBSERVED facts, INFERRED conclusions, and POSSIBLE causes. Never invent a database, restart, or dependency theory when the observations identify a more direct cause. An HTTP 404 proves an HTTP server responded; it does not prove the process crashed. A 404 from a detected-but-unvalidated health candidate means the candidate may be wrong and general monitoring should be used. Only describe a database problem when the facts contain database-failure evidence.
Current server facts:\n${facts.join("\n")}`,
        },
        // The last few turns, so follow-up questions ("and the other one?") make sense.
        ...history.filter((m) => m.role !== "system").slice(-8).map((m) => ({ role: m.role, content: m.content.slice(0, 2000) })),
        { role: "user", content: question.slice(0, 4000) },
      ];
      try {
        return { answer: await this.runtime.chat({ model: status.plan.model.id, messages, signal: AbortSignal.timeout(120_000) }), source: "ai" };
      } catch {
        /* fall back */
      }
    }
    return { answer: this.diagnosticAnswer(), source: "diagnostics" };
  }

  diagnosticAnswer(): string {
    const apps = this.apps.list().map((a) => this.apps.summary(a));
    const snap = this.ctx.monitoring?.latest();
    const score = computeHealthScore({
      apps: apps.map((a) => ({ name: a.name, status: a.status })),
      databasesOffline: 0,
      cpuPercent: snap?.cpuPercent ?? null,
      memoryUsedFraction: snap ? snap.memory.usedBytes / snap.memory.totalBytes : null,
      lowestDiskFreeFraction: snap?.disks.length ? Math.min(...snap.disks.map((d) => d.freeBytes / d.totalBytes)) : null,
      unprotectedApps: [],
      externalAccessProblems: 0,
      securityAlerts: 0,
    });
    const running = apps.filter((a) => a.status === "running").length;
    const head = score.issues.length === 0 ? "Everything is running normally." : `${score.issues.length === 1 ? "One thing needs" : "A few things need"} attention.`;
    const parts = [`${head} ${running} of ${apps.length} application${apps.length === 1 ? " is" : "s are"} running.`];
    if (score.issues.length) parts.push(score.issues.map((i) => `• ${i}`).join("\n"));
    for (const a of apps.filter((x) => x.problem)) parts.push(`${a.problem!.title}: ${a.problem!.summary}`);
    return parts.join("\n");
  }
}
