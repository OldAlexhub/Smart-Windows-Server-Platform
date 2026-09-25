import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StateStore } from "@nexus/state";
import { AI_ACTIONS, AiProposals, evaluateAiAction, locateOllama, OllamaRuntime, OpenAICompatibleRuntime, stripThinking, type AiAction } from "@nexus/ai";

describe("AI permission engine", () => {
  it("reads are always allowed", () => {
    for (const level of ["observe", "recommend", "execute_after_approval"] as const) {
      expect(evaluateAiAction("read_logs", level).decision).toBe("allow");
      expect(evaluateAiAction("run_readonly_sql", level).decision).toBe("allow");
    }
  });

  it("recommend (default) turns risky actions into proposals, never execution", () => {
    expect(evaluateAiAction("recommend", "recommend").decision).toBe("allow");
    for (const a of ["modify_schema", "edit_code", "restore_backup", "change_firewall", "change_external_access", "deploy_code", "delete_data", "restart_critical"] as AiAction[]) {
      expect(evaluateAiAction(a, "recommend").decision).toBe("propose");
    }
  });

  it("observe mode refuses anything beyond reading", () => {
    expect(evaluateAiAction("recommend", "observe").decision).toBe("deny");
    expect(evaluateAiAction("modify_schema", "observe").decision).toBe("deny");
  });

  it("execute-after-approval requires a person to approve", () => {
    expect(evaluateAiAction("modify_schema", "execute_after_approval").decision).toBe("require_approval");
  });

  it("never: delete backups, drop production databases, disable security", () => {
    for (const a of ["delete_backups", "drop_database", "disable_security"] as AiAction[]) {
      for (const level of ["observe", "recommend", "execute_after_approval"] as const) expect(evaluateAiAction(a, level).decision).toBe("deny");
    }
    expect(Object.values(AI_ACTIONS).filter((c) => c === "forbidden")).toHaveLength(3);
  });
});

describe("AiProposals", () => {
  const clock = { t: Date.UTC(2027, 0, 1) };
  const make = () => new AiProposals(StateStore.memory(), () => clock.t);

  it("records recommendations and approvals; only people can approve", () => {
    const p = make();
    const r = p.request("recommend", {
      action: "modify_schema",
      title: "Add an index on transactions.transaction_date",
      explanation: "The transactions query scans 7.8M rows.",
      target: { type: "database", id: "db1" },
      payload: { sql: "CREATE INDEX CONCURRENTLY ON transactions (transaction_date)" },
    });
    expect(r.decision.decision).toBe("propose");
    expect(r.proposal).toMatchObject({ status: "pending", executable: false });
    expect(() => p.approve(r.proposal!.id, "ai")).toThrow(/Only a person/);
    const approved = p.approve(r.proposal!.id, "user-1");
    expect(approved).toMatchObject({ status: "approved", decidedBy: "user-1" });
    // Recommend-level proposals are never executed by Nexus AI itself.
    expect(() => p.markExecuted(approved.id, true, "done")).toThrow(/Only approved actions/);
  });

  it("execute-after-approval proposals run only once approved", () => {
    const p = make();
    const { proposal } = p.request("execute_after_approval", { action: "restart_app", title: "Restart TaxiOps", explanation: "Memory leak" });
    expect(proposal!.executable).toBe(true);
    expect(() => p.markExecuted(proposal!.id, true, "x")).toThrow();
    p.approve(proposal!.id, "owner");
    p.markExecuted(proposal!.id, true, "Restarted in 4s");
    expect(p.require(proposal!.id)).toMatchObject({ status: "executed", result: "Restarted in 4s" });
    expect(() => p.approve(proposal!.id, "owner")).toThrow(/already executed/);
  });

  it("forbidden and allowed actions create no proposal; pending ones expire", () => {
    const p = make();
    expect(p.request("execute_after_approval", { action: "drop_database", title: "x", explanation: "y" })).toMatchObject({ decision: { decision: "deny" }, proposal: null });
    expect(p.request("recommend", { action: "read_logs", title: "x", explanation: "y" }).proposal).toBeNull();
    const { proposal } = p.request("recommend", { action: "deploy_code", title: "Deploy", explanation: "z", ttlHours: 1 });
    clock.t += 2 * 3_600_000;
    expect(p.list("expired").map((x) => x.id)).toContain(proposal!.id);
    expect(() => p.approve(proposal!.id, "owner")).toThrow(/already expired/);
  });
});

describe("runtimes (fake servers)", () => {
  let server: http.Server;
  let base: string;
  const seen: { path: string; body: unknown }[] = [];
  beforeAll(async () => {
    server = http.createServer((q, s) => {
      let data = "";
      q.on("data", (c) => (data += c));
      q.on("end", () => {
        const body = data ? JSON.parse(data) : null;
        seen.push({ path: q.url!, body });
        s.setHeader("Content-Type", "application/json");
        if (q.url === "/api/version") return s.end(JSON.stringify({ version: "0.34.0" }));
        if (q.url === "/api/tags") return s.end(JSON.stringify({ models: [{ name: "qwen3:8b", size: 5_200_000_000 }] }));
        if (q.url === "/api/chat") return s.end(JSON.stringify({ message: { role: "assistant", content: "<think>hmm</think>TaxiOps is healthy." } }));
        if (q.url === "/api/pull") {
          s.write(JSON.stringify({ status: "pulling manifest" }) + "\n");
          s.write(JSON.stringify({ status: "downloading", completed: 50, total: 100 }) + "\n");
          return s.end(JSON.stringify({ status: "success" }) + "\n");
        }
        if (q.url === "/v1/chat/completions") return s.end(JSON.stringify({ choices: [{ message: { content: '{"sql":"SELECT 1"}' } }] }));
        s.statusCode = 404;
        s.end("{}");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it("Ollama: status, chat (thinking stripped, JSON mode), model download progress", async () => {
    const o = new OllamaRuntime({ baseUrl: base });
    expect(await o.status()).toEqual({ installed: true, running: true, version: "0.34.0", models: [{ id: "qwen3:8b", sizeBytes: 5_200_000_000 }] });
    expect(await o.chat({ model: "qwen3:8b", messages: [{ role: "user", content: "How is everything?" }], json: true })).toBe("TaxiOps is healthy.");
    expect(seen.find((x) => x.path === "/api/chat")!.body).toMatchObject({ model: "qwen3:8b", stream: false, format: "json" });
    await o.ensureModel("qwen3:8b"); // already present → no pull
    expect(seen.some((x) => x.path === "/api/pull")).toBe(false);
    const progress: string[] = [];
    await o.ensureModel("qwen3:14b", (p) => progress.push(p.status));
    expect(progress).toEqual(["pulling manifest", "downloading", "success"]);
  });

  it("OpenAI-compatible (llama.cpp llama-server)", async () => {
    const r = new OpenAICompatibleRuntime({ baseUrl: base });
    expect(await r.chat({ model: "local", messages: [{ role: "user", content: "sql" }], json: true })).toBe('{"sql":"SELECT 1"}');
  });

  it("reports not running when nothing listens", async () => {
    expect((await new OllamaRuntime({ baseUrl: "http://127.0.0.1:1" }).status()).running).toBe(false);
    expect(stripThinking("<think>\nx\n</think>\n\nAnswer")).toBe("Answer");
  });
});

const OLLAMA = locateOllama();
describe.runIf(!!OLLAMA)("OllamaRuntime live (Nexus-owned instance on a private port)", () => {
  it("starts and stops its own loopback-only Ollama", async () => {
    const port = await new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, "127.0.0.1", () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    const models = mkdtempSync(join(tmpdir(), "nexus-ollama-"));
    const o = new OllamaRuntime({ baseUrl: `http://127.0.0.1:${port}`, exe: OLLAMA, env: { OLLAMA_HOST: `127.0.0.1:${port}`, OLLAMA_MODELS: models } });
    try {
      await o.start();
      const s = await o.status();
      expect(s.running).toBe(true);
      expect(s.version).toMatch(/^\d+\.\d+/);
      expect(s.models).toEqual([]);
    } finally {
      await o.stop();
      rmSync(models, { recursive: true, force: true });
    }
    expect((await o.status()).running).toBe(false);
  }, 60_000);
});
