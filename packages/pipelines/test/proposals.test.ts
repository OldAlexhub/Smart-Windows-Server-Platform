import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { blockGuide, checkProposal, placeScripts, proposalPrompt, type ProposalContext } from "@nexus/pipelines";

const context: ProposalContext = {
  databases: [{ name: "TaxiOps", tables: [{ name: "trips", columns: ["trip_id", "provider_id", "status", "fare", "updated_at"] }] }],
  secrets: ["shop_api"],
};

/** The spec's example: nightly completed trips → Python dedupe → R provider performance → Warehouse. */
const nightly = {
  pipeline: {
    name: "Provider performance",
    schedule: { type: "daily", at: "02:00" },
    steps: [
      { id: "trips", name: "Completed trips", uses: "postgres.read", with: { connection: { database: "TaxiOps" }, query: "select * from trips where status = 'completed'", incremental: { column: "updated_at" } } },
      { id: "dedupe", name: "Remove duplicates", uses: "python", with: { script: "dedupe.py" } },
      { id: "performance", name: "Provider performance", uses: "r", with: { script: "performance.R" } },
      { id: "load", uses: "warehouse.write", with: { table: "provider_performance" } },
    ],
  },
  scripts: [
    { step: "dedupe", language: "python", code: "from nexus import input_data, output_data\ndf = input_data()\noutput_data(df.drop_duplicates(subset=['trip_id']))" },
    { step: "performance", language: "r", code: "df <- nexus_input()\nnexus_output(aggregate(fare ~ provider_id, df, sum))\n" },
  ],
  assumptions: ["“Every night” means 2:00 AM.", "Only new or changed trips are read each night (by updated_at)."],
};

describe("pipeline proposals", () => {
  it("describes every block and its settings for the model", () => {
    const guide = blockGuide();
    expect(guide).toContain("- postgres.read (source, no input)");
    expect(guide).toMatch(/postgres\.read .*Settings: table\?, query\?, incremental\?, connection$/m);
    expect(guide).toContain("- join (transform, 2 inputs)");
    expect(guide).toMatch(/warehouse\.write .*Settings: table, mode\?, key\?/);
    const prompt = proposalPrompt("Every night …", context)[0]!.content;
    expect(prompt).toContain("TaxiOps: trips(trip_id, provider_id, status, fare, updated_at)");
    expect(prompt).toContain("Saved secrets: shop_api");
  });

  it("turns the spec's example into a valid pipeline with its scripts", () => {
    const r = checkProposal(`Here you go:\n${JSON.stringify(nightly)}`, context);
    if (!r.ok) throw new Error(r.problems.join("; "));
    expect(r.pipeline.order).toEqual(["trips", "dedupe", "performance", "load"]);
    expect(r.pipeline.schedule).toEqual({ type: "daily", at: "02:00" });
    expect(r.proposal.scripts.map((s) => [s.stepId, s.language, s.fileName])).toEqual([["dedupe", "python", "dedupe.py"], ["performance", "r", "performance.R"]]);
    expect(r.proposal.scripts[0]!.code.endsWith("\n")).toBe(true);
    expect(r.proposal.assumptions).toHaveLength(2);
    expect(r.proposal.warnings).toEqual([]);
  });

  it("sends problems back to the model: no script, invalid settings, not JSON", () => {
    const noScript = { ...nightly, scripts: [] };
    const r = checkProposal(JSON.stringify(noScript), context);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems[0]).toBe('Step dedupe is a Python step: write its script in "scripts", or use a script path the person gave.');

    const both = structuredClone(nightly);
    (both.pipeline.steps[0]!.with as Record<string, unknown>).table = "trips";
    const b = checkProposal(JSON.stringify(both), context);
    expect(!b.ok && b.problems.some((p) => p.includes("Choose a table or write a query (not both)."))).toBe(true);

    expect(checkProposal("I can't do that", context)).toEqual({ ok: false, problems: ['The answer must be JSON like {"pipeline": {…}, "scripts": […], "assumptions": […]}.'] });
  });

  it("keeps an existing script the person named, and warns about unknown databases and secrets", () => {
    const own = structuredClone(nightly);
    own.pipeline.steps[1]!.with = { script: "C:\\Scripts\\dedupe.py" };
    own.scripts = own.scripts.filter((s) => s.step !== "dedupe");
    (own.pipeline.steps[0]!.with as Record<string, unknown>).connection = { database: "Billing" };
    own.pipeline.steps.push({ id: "api", uses: "api.write", with: { url: "https://example.com/in", secretHeaders: { Authorization: "crm_token" } } as never, needs: ["performance"] } as never);
    const r = checkProposal(JSON.stringify(own), context);
    if (!r.ok) throw new Error(r.problems.join("; "));
    expect(r.proposal.scripts.map((s) => s.stepId)).toEqual(["performance"]);
    expect((r.pipeline.steps[1]!.with as { script: string }).script).toBe("C:\\Scripts\\dedupe.py");
    expect(r.proposal.warnings).toEqual([
      "Completed trips uses a database called Billing, which isn't on this server. Choose the right one before running it.",
      "api needs a secret called crm_token. Add it under Pipelines › Secrets before running.",
    ]);
  });

  it("places scripts without replacing existing files", () => {
    const r = checkProposal(JSON.stringify(nightly), context);
    if (!r.ok) throw new Error("invalid");
    const dir = "C:\\Nexus\\Pipelines\\scripts\\provider-performance";
    const taken = new Set([join(dir, "dedupe.py")]);
    const placed = placeScripts(r.proposal.definition, r.proposal.scripts, dir, (p) => taken.has(p), join);
    expect(placed.files.map((f) => f.path)).toEqual([join(dir, "dedupe-2.py"), join(dir, "performance.R")]);
    const steps = placed.definition.steps as { id: string; with: { script?: string } }[];
    expect(steps.find((s) => s.id === "dedupe")!.with.script).toBe(join(dir, "dedupe-2.py"));
    expect(steps.find((s) => s.id === "trips")!.with.script).toBeUndefined();
  });
});
