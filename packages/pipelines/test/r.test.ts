import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StateStore } from "@nexus/state";
import { BUILTIN_CONNECTORS, BUILTIN_TRANSFORMS, detectRRequirements, ExecutorRegistry, explainRError, normalizePipeline, PipelineEngine, RLibraries, RLocator, rPackagesUsed, rStep, type PipelineInput } from "@nexus/pipelines";

const HELPERS = join(__dirname, "..", "helpers");
const root = mkdtempSync(join(tmpdir(), "nexus-r-"));
afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    /* harmless */
  }
});
const write = (rel: string, text: string) => {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
  return p;
};

describe("R dependency detection", () => {
  it("finds packages from library(), require(), pkg:: and p_load(), ignoring comments", () => {
    const src = [
      "library(dplyr)",
      'suppressPackageStartupMessages(library("data.table"))',
      "require(readxl)",
      "if (!requireNamespace('arrow', quietly = TRUE)) stop('x')",
      "x <- httr2::request(url)",
      "pacman::p_load(jsonlite, 'DBI')",
      "# library(ggplot2)",
      "msg <- 'library(fake)' # comment library(other)",
      "library(nexusR)",
      "stats::median(1)",
    ].join("\n");
    expect(rPackagesUsed(src)).toEqual(["DBI", "arrow", "data.table", "dplyr", "fake", "httr2", "jsonlite", "pacman", "readxl", "stats"]);
    const script = write("detect/analysis.R", `${src}\nkey <- nexus_secret("warehouse_key")\ncon <- nexus_database('TaxiOps')\n`);
    const r = detectRRequirements(script, new Set(["stats", "utils", "base"]), ["tidyr"]);
    expect(r.source).toBe("library calls");
    expect(r.packages).toEqual(["DBI", "arrow", "data.table", "dplyr", "fake", "httr2", "jsonlite", "pacman", "readxl", "tidyr"]);
    expect(r.secrets).toEqual(["warehouse_key"]);
    expect(r.databases).toEqual(["TaxiOps"]);
  });

  it("uses renv.lock versions when the project has one", () => {
    write("renv/renv.lock", JSON.stringify({ R: { Version: "4.4.1" }, Packages: { dplyr: { Package: "dplyr", Version: "1.1.4" }, rlang: { Package: "rlang", Version: "1.1.4" } } }));
    const r = detectRRequirements(write("renv/job.R", "library(dplyr)\n"), new Set());
    expect(r).toMatchObject({ source: "renv.lock", packages: ["dplyr", "rlang"], pinned: { dplyr: "1.1.4", rlang: "1.1.4" } });
  });

  it("explains R errors in plain words", () => {
    expect(explainRError(["Error in `dplyr::filter()`:", "! object 'provider_id' not found", "Execution halted"])).toBe(
      'The script refers to "provider_id", which doesn\'t exist — the incoming data may not have a column called provider_id.',
    );
    expect(explainRError(["Error in library(zoo) : there is no package called ‘zoo’"])).toContain('R package "zoo"');
    expect(explainRError(["Error: division went wrong", "Execution halted"])).toBe("The script stopped with an error: division went wrong");
  });
});

const locator = new RLocator();
let hasR = false;
beforeAll(async () => {
  hasR = (await locator.list()).length > 0;
});

describe("R steps (real R and isolated package library)", () => {
  const libraries = new RLibraries(join(tmpdir(), "nexus-test-r-libraries"), HELPERS);
  const secrets: Record<string, string> = { warehouse_key: "wk-SUPERSECRET-9" };
  let engine: PipelineEngine;
  let seq = 0;
  const run = (def: PipelineInput) => engine.start({ id: `r${++seq}`, version: 1, definition: normalizePipeline(def) }).done;

  beforeAll(() => {
    engine = new PipelineEngine({
      store: StateStore.memory(),
      workRoot: join(root, "runs"),
      executors: new ExecutorRegistry([...BUILTIN_TRANSFORMS, ...BUILTIN_CONNECTORS, rStep(locator, libraries, { helpersDir: HELPERS })]),
      services: { secret: (n) => secrets[n] },
    });
    write("data/trips.csv", "trip_id,status,provider,minutes\n1,Completed,A,30\n2,Completed,B,45\n3,Cancelled,A,0\n4,Completed,A,15\n");
  });

  it("runs the spec's R scenario: input → dplyr summary → output, with parameters and secrets", async (t) => {
    if (!hasR) return t.skip();
    const script = write(
      "analytics/operations.R",
      [
        "library(dplyr)",
        "input <- nexus_input()",
        "message('rows in: ', nrow(input), '; mode: ', nexus_execution_mode())",
        "key <- nexus_secret('warehouse_key')",
        "cat('key is', key, '\\n')",
        "result <- input |>",
        "  dplyr::filter(status == nexus_param('status')) |>",
        "  dplyr::group_by(provider) |>",
        "  dplyr::summarise(trips = dplyr::n(), minutes = sum(minutes))",
        "nexus_output(result)",
      ].join("\n"),
    );
    const r = await run({
      name: "Provider performance",
      params: [{ name: "status", default: "Completed" }],
      steps: [
        { id: "trips", uses: "csv.read", with: { path: join(root, "data", "trips.csv") } },
        { id: "analysis", uses: "r", with: { script } },
        { id: "check", uses: "sql", with: { query: "select provider, trips::int as trips, minutes::int as minutes from input order by provider" } },
      ],
    });
    expect(r.error).toBeNull();
    expect(r.status).toBe("succeeded");
    expect(r.steps.map((s) => s.output?.rows)).toEqual([4, 2, 2]);
    expect(r.steps[1]!.environment?.runtime).toMatch(/^R 4\.\d+\.\d+$/);
    expect(Object.keys(r.steps[1]!.environment!.packages)).toEqual(expect.arrayContaining(["dplyr", "nexusR", "nanoparquet"]));
    const logs = engine.logs(r.id, "analysis").map((l) => l.message);
    expect(logs).toContain("rows in: 4; mode: cpu");
    expect(logs.join("\n")).not.toContain("SUPERSECRET");
    expect(logs).toContain("key is •••• ");
    expect(existsSync(r.steps[1]!.output!.path)).toBe(true);
  }, 1_800_000);

  it("works without library(nexusR) and explains a missing column like the spec's example", async (t) => {
    if (!hasR) return t.skip();
    const script = write("analytics/broken.R", "data <- nexus_input()\ntotal <- with(data, sum(provider_id))\nnexus_output(data.frame(total = total))\n");
    const r = await run({ name: "Broken", steps: [{ id: "trips", uses: "csv.read", with: { path: join(root, "data", "trips.csv") } }, { id: "analysis", uses: "r", with: { script } }] });
    expect(r.status).toBe("failed");
    expect(r.error).toBe('analysis (R script) failed: The script refers to "provider_id", which doesn\'t exist — the incoming data may not have a column called provider_id.');
    expect(r.steps[1]!.attempts).toBe(1);
    expect(r.steps[1]!.environment).toMatchObject({ runtime: expect.stringMatching(/^R 4\./), host: { node: process.versions.node } });
  }, 600_000);
});
