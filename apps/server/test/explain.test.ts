import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NexusContext } from "../src/context";
import { authRoutes } from "../src/http/routes/auth";
import { explainRoutes } from "../src/http/routes/explain";
import { pipelineRoutes } from "../src/http/routes/pipelines";
import { buildServer } from "../src/http/server";
import { AppManager } from "../src/services/apps";
import { ExplainService } from "../src/services/explain";
import { GatewayService } from "../src/services/gateway";
import { PipelineService } from "../src/services/pipelines";
import type { QuestionModel } from "../src/services/data-questions";
import { createContext, tempHome } from "./helpers";
import { ownerClient } from "./helpers-http";

let ctx: NexusContext;
let app: FastifyInstance;
let home: string;
let dispose: () => void;
let call: Awaited<ReturnType<typeof ownerClient>>;
let modelReady = false;
const prompts: string[] = [];
const model: QuestionModel = {
  async chat(messages) {
    prompts.push(messages.map((m) => m.content).join("\n"));
    return JSON.stringify({ explanation: "The trips export changed: provider_id is now called provider_code, so the analysis can't find it.", steps: ["Use provider_code in the analysis step", "Resume the run"] });
  },
};

beforeAll(async () => {
  const t = tempHome();
  home = t.home;
  dispose = t.dispose;
  ctx = await createContext(home, { setup: true });
  const pipelines = new PipelineService(ctx);
  const apps = new AppManager(ctx, new GatewayService(ctx));
  app = await buildServer(ctx, [authRoutes, pipelineRoutes(pipelines), explainRoutes(new ExplainService(ctx, apps, pipelines, () => (modelReady ? model : null)))]);
  call = await ownerClient(app, ctx);
  mkdirSync(join(home, "input"), { recursive: true });
}, 240_000);

afterAll(async () => {
  await app?.close();
  await ctx?.shutdown();
  dispose?.();
}, 120_000);

describe("explaining a failed pipeline run", () => {
  it("names the renamed column, with or without the AI", async () => {
    const file = join(home, "input", "trips.csv");
    writeFileSync(file, "trip_id,provider_id,fare\n1,A,12\n2,B,8\n");
    const p = await call("POST", "/api/v1/pipelines", {
      definition: {
        name: "Provider totals",
        steps: [
          { id: "trips", uses: "csv.read", with: { path: file } },
          { id: "totals", name: "Totals per provider", uses: "sql", with: { query: "select provider_id, sum(fare) as fare from input group by provider_id" } },
        ],
      },
    });
    expect((await call("POST", `/api/v1/pipelines/${p.body.id}/run`, { waitSeconds: 60 })).body.status).toBe("succeeded");

    // The export changes its column name.
    writeFileSync(file, "trip_id,provider_code,fare\n1,A,12\n2,B,8\n");
    const failed = await call("POST", `/api/v1/pipelines/${p.body.id}/run`, { waitSeconds: 60 });
    expect(failed.body.status).toBe("failed");

    const plain = await call("POST", `/api/v1/pipeline-runs/${failed.body.runId}/explain`);
    expect(plain.body.diagnosis).toMatchObject({
      stepId: "totals",
      title: "The incoming data changed",
      summary: "The data coming into Totals per provider no longer contains provider_id. It now has provider_code instead — the source probably renamed provider_id to provider_code.",
    });
    expect(plain.body.ai).toBeNull();

    modelReady = true;
    const withAi = await call("POST", `/api/v1/pipeline-runs/${failed.body.runId}/explain`);
    expect(withAi.body.ai).toEqual({ explanation: "The trips export changed: provider_id is now called provider_code, so the analysis can't find it.", steps: ["Use provider_code in the analysis step", "Resume the run"] });
    expect(prompts.at(-1)).toContain("provider_code");
    modelReady = false;

    const ok = await call("GET", `/api/v1/pipelines/${p.body.id}/runs`);
    const good = ok.body.find((e: { run: { status: string } }) => e.run.status === "succeeded").run.id;
    expect((await call("POST", `/api/v1/pipeline-runs/${good}/explain`)).status).toBe(409);
  }, 180_000);
});
