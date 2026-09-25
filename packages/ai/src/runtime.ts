import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  /** Ask for a JSON object answer (used for SQL generation, pipeline proposals...). */
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface RuntimeStatus {
  installed: boolean;
  running: boolean;
  version: string | null;
  models: { id: string; sizeBytes: number }[];
}

export interface PullProgress {
  status: string;
  completed?: number;
  total?: number;
}

/**
 * A local inference engine. Implementations: Ollama (default), any OpenAI-compatible server
 * (llama.cpp's llama-server, vLLM...). Everything listens on 127.0.0.1 only.
 */
export interface AiRuntime {
  readonly id: string;
  status(): Promise<RuntimeStatus>;
  chat(req: ChatRequest): Promise<string>;
  embed?(model: string, input: string[]): Promise<number[][]>;
  ensureModel?(model: string, onProgress?: (p: PullProgress) => void): Promise<void>;
}

// ------------------------------------------------------------------ Ollama

export function locateOllama(configured?: string | null): string | null {
  const candidates = [
    configured,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs", "Ollama", "ollama.exe") : null,
    process.env.ProgramFiles ? join(process.env.ProgramFiles, "Ollama", "ollama.exe") : null,
  ].filter((x): x is string => !!x);
  return candidates.find((c) => existsSync(c)) ?? null;
}

export class OllamaRuntime implements AiRuntime {
  readonly id = "ollama";
  private child: ChildProcess | null = null;

  constructor(
    private readonly opts: {
      baseUrl: string; // http://127.0.0.1:<port>
      exe?: string | null;
      env?: Record<string, string>;
      onOutput?: (line: string) => void;
      fetcher?: typeof fetch;
    },
  ) {}

  private get f(): typeof fetch {
    return this.opts.fetcher ?? fetch;
  }

  /** Starts a Nexus-owned `ollama serve` (separate from any Ollama the user runs themselves). */
  async start(): Promise<void> {
    if ((await this.status()).running) return;
    if (!this.opts.exe) throw new Error("The AI engine is not installed yet.");
    const child = spawn(this.opts.exe, ["serve"], {
      env: { ...process.env, ...this.opts.env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    for (const s of [child.stdout, child.stderr]) if (s) createInterface({ input: s }).on("line", (l) => this.opts.onOutput?.(l));
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error("The AI engine stopped while starting.");
      if ((await this.status()).running) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("The AI engine did not start in time.");
  }

  async stop(): Promise<void> {
    const c = this.child;
    if (!c || c.exitCode !== null) return;
    const exited = new Promise((r) => c.once("exit", r));
    c.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    this.child = null;
  }

  async status(): Promise<RuntimeStatus> {
    try {
      const v = await this.f(`${this.opts.baseUrl}/api/version`, { signal: AbortSignal.timeout(2000) });
      if (!v.ok) throw new Error();
      const version = ((await v.json()) as { version?: string }).version ?? null;
      const t = await this.f(`${this.opts.baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
      const tags = t.ok ? ((await t.json()) as { models?: { name: string; size: number }[] }).models ?? [] : [];
      return { installed: true, running: true, version, models: tags.map((m) => ({ id: m.name, sizeBytes: m.size })) };
    } catch {
      return { installed: !!this.opts.exe, running: false, version: null, models: [] };
    }
  }

  async ensureModel(model: string, onProgress?: (p: PullProgress) => void): Promise<void> {
    const s = await this.status();
    if (s.models.some((m) => m.id === model || m.id === `${model}:latest`)) return;
    const res = await this.f(`${this.opts.baseUrl}/api/pull`, { method: "POST", body: JSON.stringify({ model, stream: true }) });
    if (!res.ok || !res.body) throw new Error(`The AI model ${model} could not be downloaded.`);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const p = JSON.parse(line) as PullProgress & { error?: string };
        if (p.error) throw new Error(`The AI model ${model} could not be downloaded: ${p.error}`);
        onProgress?.(p);
      }
    }
  }

  async chat(req: ChatRequest): Promise<string> {
    const res = await this.f(`${this.opts.baseUrl}/api/chat`, {
      method: "POST",
      signal: req.signal ?? null,
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        stream: false,
        ...(req.json ? { format: "json" } : {}),
        options: { temperature: req.temperature ?? 0.2, ...(req.maxTokens ? { num_predict: req.maxTokens } : {}) },
      }),
    });
    if (!res.ok) throw new Error(`The AI engine returned an error (${res.status}).`);
    const body = (await res.json()) as { message?: { content?: string } };
    return stripThinking(body.message?.content ?? "");
  }

  async embed(model: string, input: string[]): Promise<number[][]> {
    const res = await this.f(`${this.opts.baseUrl}/api/embed`, { method: "POST", body: JSON.stringify({ model, input }) });
    if (!res.ok) throw new Error(`The AI engine returned an error (${res.status}).`);
    return ((await res.json()) as { embeddings: number[][] }).embeddings;
  }
}

// ------------------------------------------------------------------ OpenAI-compatible (llama.cpp, vLLM...)

/** For llama.cpp's `llama-server` and other local servers exposing /v1/chat/completions. */
export class OpenAICompatibleRuntime implements AiRuntime {
  readonly id = "openai-compatible";
  constructor(private readonly opts: { baseUrl: string; fetcher?: typeof fetch }) {}

  async status(): Promise<RuntimeStatus> {
    try {
      const r = await (this.opts.fetcher ?? fetch)(`${this.opts.baseUrl}/v1/models`, { signal: AbortSignal.timeout(2000) });
      const models = r.ok ? ((await r.json()) as { data?: { id: string }[] }).data ?? [] : [];
      return { installed: true, running: r.ok, version: null, models: models.map((m) => ({ id: m.id, sizeBytes: 0 })) };
    } catch {
      return { installed: false, running: false, version: null, models: [] };
    }
  }

  async chat(req: ChatRequest): Promise<string> {
    const r = await (this.opts.fetcher ?? fetch)(`${this.opts.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: req.signal ?? null,
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        temperature: req.temperature ?? 0.2,
        ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
        ...(req.json ? { response_format: { type: "json_object" } } : {}),
      }),
    });
    if (!r.ok) throw new Error(`The AI engine returned an error (${r.status}).`);
    const body = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    return stripThinking(body.choices?.[0]?.message?.content ?? "");
  }
}

/** Reasoning models may prefix answers with <think>…</think>; users only see the answer. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}
