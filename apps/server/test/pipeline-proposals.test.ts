import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NexusContext } from "../src/context";
import { authRoutes } from "../src/http/routes/auth";
import { pipelineRoutes } from "../src/http/routes/pipelines";
import { buildServer } from "../src/http/server";
import type { QuestionModel } from "../src/services/data-questions";
import { PipelineProposalService } from "../src/services/pipeline-proposals";
import { PipelineService } from "../src/services/pipelines";
import { createContext, tempHome } from "./helpers";
import { ownerClient } from "./helpers-http";

let ctx: NexusContext;
let app: FastifyInstance;
let home: string;
let dispose: () => void;
let call: Awaited<ReturnType<typeof ownerClient>>;
let modelReady = true;
const answers: string[] = [];
const prompts: string[][] = [];
const model: QuestionModel = {
  async chat(messages) {
    prompts.push(messages.map((m) => m.content));
    return answers.shift() ?? "{}";
  },
};

beforeAll(async () => {
  const t = tempHome();
  home = t.home;
  dispose = t.dispose;
  ctx = await createContext(home, { setup: true });
  const pipelines = new PipelineService(ctx);
  app = await buildServer(ctx, [authRoutes, pipelineRoutes(pipelines, new PipelineProposalService(ctx, pipelines, () => (modelReady ? model : null)))]);
  call = await ownerClient(app, ctx);
  mkdirSync(join(home, "input"), { recursive: true });
}, 240_000);

afterAll(async () => {
  await app?.close();
  await ctx?.shutdown();
  dispose?.();
}, 120_000);

describe("pipelines described in plain English", () => {
  it("proposes (fixing its own mistake once), saves nothing, and creates a switched-off pipeline with its scripts", async () => {
    const source = join(home, "input", "trips.csv");
    const out = join(home, "output", "trips_clean.csv");
    writeFileSync(source, "trip_id,provider,fare\n1,A,12\n1,A,12\n2,B,8\n");
    const pipeline = (clean: Record<string, unknown>) => ({
      name: "Nightly trips clean-up",
      schedule: { type: "daily", at: "02:00" },
      steps: [
        { id: "trips", uses: "csv.read", with: { path: source } },
        { id: "clean", name: "Remove duplicates", uses: "deduplicate", with: clean },
        { id: "report", name: "Provider report", uses: "python", with: { script: "report.py" } },
        { id: "save", uses: "file.write", with: { path: out }, needs: ["clean"] },
      ],
    });
    const script = { step: "report", language: "python", code: "from nexus import input_data, output_data\ndf = input_data()\noutput_data(df.groupby('provider', as_index=False)['fare'].sum())" };
    answers.push(
      JSON.stringify({ pipeline: pipeline({ columns: "trip_id" }), scripts: [script], assumptions: [] }), // columns must be a list
      JSON.stringify({ pipeline: pipeline({ columns: ["trip_id"] }), scripts: [script], assumptions: ["“Every night” means 2:00 AM."] }),
    );

    const before = (await call("GET", "/api/v1/pipelines")).body.length;
    const r = await call("POST", "/api/v1/pipelines/propose", { request: "Every night, take trips.csv, remove duplicate trips, total fares per provider in Python, and save the clean file." });
    expect(r.status).toBe(200);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]!.at(-1)).toContain("steps.clean.with.columns");
    expect(r.body.definition.schedule).toEqual({ type: "daily", at: "02:00" });
    expect(r.body.definition.steps.map((s: { id: string }) => s.id)).toEqual(["trips", "clean", "report", "save"]);
    expect(r.body.scripts).toEqual([{ stepId: "report", language: "python", fileName: "report.py", code: `${script.code}\n` }]);
    expect(r.body.assumptions).toEqual(["“Every night” means 2:00 AM."]);
    expect(r.body.warnings).toEqual([]);
    expect((await call("GET", "/api/v1/pipelines")).body.length).toBe(before);

    // The person reviews and edits the script, then creates it.
    const edited = [{ ...r.body.scripts[0], code: "# reviewed\n" + r.body.scripts[0].code }];
    const created = await call("POST", "/api/v1/pipelines/from-proposal", { definition: r.body.definition, scripts: edited });
    expect(created.status).toBe(200);
    expect(created.body.enabled).toBe(false);
    const scriptPath = created.body.scripts[0] as string;
    expect(scriptPath.endsWith(join("scripts", "nightly-trips-clean-up", "report.py"))).toBe(true);
    expect(readFileSync(scriptPath, "utf8").startsWith("# reviewed\nfrom nexus import")).toBe(true);
    expect(created.body.definition.steps.find((s: { id: string }) => s.id === "report").with.script).toBe(scriptPath);

    // Creating it again never replaces the first script.
    const again = await call("POST", "/api/v1/pipelines/from-proposal", { definition: r.body.definition, scripts: [{ ...edited[0], code: "print('other')\n" }] });
    expect(again.body.scripts[0]).toBe(scriptPath.replace("report.py", "report-2.py"));
    expect(readFileSync(scriptPath, "utf8").startsWith("# reviewed")).toBe(true);

    // A test run of the parts that don't need Python works straight away.
    await call("DELETE", `/api/v1/pipelines/${again.body.id}`);
    const plain = { ...r.body.definition, name: "Trips clean-up", steps: r.body.definition.steps.filter((s: { id: string }) => s.id !== "report") };
    const p = await call("POST", "/api/v1/pipelines/from-proposal", { definition: plain, scripts: [] });
    const run = await call("POST", `/api/v1/pipelines/${p.body.id}/run`, { waitSeconds: 60 });
    expect(run.body.status).toBe("succeeded");
    expect(readFileSync(out, "utf8").trim().split(/\r?\n/)).toHaveLength(3);
  }, 180_000);

  it("refuses a python step without a script, and gives up after one failed repair", async () => {
    const def = { name: "No script", steps: [{ id: "x", uses: "python", with: { script: "x.py" }, needs: [] }] };
    const r = await call("POST", "/api/v1/pipelines/from-proposal", { definition: def, scripts: [] });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toBe("Step x has no script. Add its code or choose a script file.");

    answers.push("Sorry, I can't.", "Still no.");
    const bad = await call("POST", "/api/v1/pipelines/propose", { request: "do magic" });
    expect(bad.status).toBe(409);
    expect(bad.body.error.message).toMatch(/^The AI couldn't turn that into a working pipeline/);
  });

  it("explains that the AI isn't ready", async () => {
    modelReady = false;
    const r = await call("POST", "/api/v1/pipelines/propose", { request: "Every night copy trips" });
    expect(r.status).toBe(409);
    expect(r.body.error.problem.title).toBe("AI isn't ready");
    modelReady = true;
  });
});
