import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NexusContext } from "../src/context";
import { AiService } from "../src/services/ai";
import { AppManager } from "../src/services/apps";
import { GatewayService } from "../src/services/gateway";
import { createContext, tempHome } from "./helpers";

let ctx: NexusContext;
let dispose: () => void;
let ollama: Server;
const pulled: string[] = [];
const models: string[] = ["qwen2.5-coder:3b"];
const saved = { host: process.env.OLLAMA_HOST, local: process.env.LOCALAPPDATA, pf: process.env.ProgramFiles };

beforeAll(async () => {
  // A stand-in for the Ollama someone runs for their own Windows account.
  ollama = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/version") return res.end(JSON.stringify({ version: "0.34.2" }));
      if (req.url === "/api/tags") return res.end(JSON.stringify({ models: models.map((name) => ({ name, size: 1 })) }));
      if (req.url === "/api/pull") {
        const { model } = JSON.parse(body) as { model: string };
        pulled.push(model);
        models.push(model);
        return res.end(`${JSON.stringify({ status: "pulling", completed: 5, total: 10 })}\n${JSON.stringify({ status: "success" })}\n`);
      }
      if (req.url === "/api/chat") return res.end(JSON.stringify({ message: { content: "All good." } }));
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise<void>((r) => ollama.listen(0, "127.0.0.1", r));
  process.env.OLLAMA_HOST = `127.0.0.1:${(ollama.address() as AddressInfo).port}`;
  // No Ollama program where Nexus would run its own (as the service, per-user installs aren't used).
  process.env.LOCALAPPDATA = "C:\\nonexistent-local";
  process.env.ProgramFiles = "C:\\nonexistent-pf";
  const t = tempHome();
  dispose = t.dispose;
  ctx = await createContext(t.home, { setup: true });
}, 240_000);

afterAll(async () => {
  for (const [k, v] of [["OLLAMA_HOST", saved.host], ["LOCALAPPDATA", saved.local], ["ProgramFiles", saved.pf]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await new Promise((r) => ollama.close(r));
  await ctx?.shutdown();
  dispose?.();
}, 120_000);

describe("using an Ollama that's already running", () => {
  it("connects to it, fetches the planned model, and answers", async () => {
    const ai = new AiService(ctx, new AppManager(ctx, new GatewayService(ctx)));
    await ai.start();
    const deadline = Date.now() + 10_000;
    let s = await ai.status();
    while (s.state !== "ready" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      s = await ai.status();
    }
    expect(s.state).toBe("ready");
    expect(s.runtime).toMatchObject({ installed: true, running: true, version: "0.34.2", external: true, modelReady: true });
    expect(pulled).toEqual([s.plan!.model.id]);
    expect(await ai.questionModel()!.chat([{ role: "user", content: "hi" }], { json: false })).toBe("All good.");
  });
});
