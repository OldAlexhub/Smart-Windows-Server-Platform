import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StateStore } from "@nexus/state";
import { PythonLocator } from "@nexus/deployment";
import {
  BUILTIN_CONNECTORS,
  BUILTIN_TRANSFORMS,
  detectPythonRequirements,
  ExecutorRegistry,
  explainPythonError,
  importsOf,
  normalizePipeline,
  PipelineEngine,
  pythonStep,
  PythonEnvironments,
  scriptMetadata,
  type PipelineInput,
} from "@nexus/pipelines";

const HELPERS = join(__dirname, "..", "helpers");
const root = mkdtempSync(join(tmpdir(), "nexus-py-"));
afterAll(() => {
  // Windows may hold a file of a just-killed process for a moment.
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    /* a temp folder left behind is harmless */
  }
});
const write = (rel: string, text: string) => {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
  return p;
};

let hasPython = false;
try {
  execFileSync("py", ["-3", "-c", "print(1)"], { stdio: "ignore" });
  hasPython = true;
} catch {
  hasPython = false;
}

describe("Python dependency detection", () => {
  const stdlib = new Set(["os", "sys", "json", "datetime", "pathlib", "collections", "re"]);

  it("finds imported packages, skipping the standard library, local modules, comments and strings", () => {
    write("proj/helpers.py", "import numpy as np\nfrom bs4 import BeautifulSoup\n");
    const script = write(
      "proj/clean_trips.py",
      [
        "import os, sys",
        "import pandas as pd, polars",
        "from sklearn.cluster import KMeans",
        "from helpers import tidy",
        "from . import sibling",
        "import sqlalchemy.orm",
        "# import tensorflow",
        "text = 'import torch'",
        'doc = """',
        "from keras import layers",
        '"""',
        "from nexus import input_data, output_data, secret",
        "key = secret('shop_api')",
        'url = nexus.database("TaxiOps")',
      ].join("\n"),
    );
    const r = detectPythonRequirements(script, stdlib);
    expect(r.source).toBe("imports");
    expect(r.imports).toEqual(["bs4", "numpy", "pandas", "polars", "sklearn", "sqlalchemy"]);
    expect(r.packages).toEqual(["beautifulsoup4", "numpy", "pandas", "polars", "scikit-learn", "SQLAlchemy"]);
    expect(r.secrets).toEqual(["shop_api"]);
    expect(r.databases).toEqual(["TaxiOps"]);
  });

  it("prefers inline script metadata (PEP 723), then requirements.txt, and adds the step's extra packages", () => {
    const meta = "# /// script\n# requires-python = \">=3.11\"\n# dependencies = [\n#   \"requests<3\",\n#   \"rich\",\n# ]\n# ///\nimport requests\n";
    expect(scriptMetadata(meta)).toEqual({ requiresPython: ">=3.11", dependencies: ["requests<3", "rich"] });
    expect(detectPythonRequirements(write("meta/job.py", meta), stdlib)).toMatchObject({ source: "script metadata", requiresPython: ">=3.11", packages: ["requests<3", "rich"] });

    write("req/requirements.txt", "# pinned\npandas==2.2.3\n-r other.txt\nhttpx>=0.27  # client\n");
    const r = detectPythonRequirements(write("req/job.py", "import pandas\nimport httpx\n"), stdlib, ["openpyxl"]);
    expect(r).toMatchObject({ source: "requirements.txt", packages: ["httpx>=0.27", "openpyxl", "pandas==2.2.3"] });
  });

  it("parses the many forms of import lines", () => {
    expect(importsOf("import a.b.c as d, e\nfrom f.g import (h,\n i)\n   import   j\nif x:\n    import k\n").sort()).toEqual(["a", "e", "f", "j", "k"]);
  });

  it("explains tracebacks in plain words", () => {
    const tb = ["Traceback (most recent call last):", '  File "C:\\P\\clean.py", line 7, in <module>', "    df['provider_id']", "KeyError: 'provider_id'"];
    expect(explainPythonError(tb, "C:\\P\\clean.py")).toBe('The script looked for "provider_id", which isn\'t there (line 7 of clean.py) — the incoming data may not have a column called provider_id.');
    expect(explainPythonError(["ModuleNotFoundError: No module named 'openpyxl.styles'"], "C:\\P\\x.py")).toContain('Python package "openpyxl"');
    expect(explainPythonError(['  File "C:\\P\\x.py", line 3, in f', "ValueError: bad date"], "C:\\P\\x.py")).toBe("The script stopped with an error (line 3 of x.py): ValueError: bad date");
  });
});

describe.runIf(hasPython)("Python steps (real interpreter and managed environment)", () => {
  // Kept between test runs so the environment is built only once on a machine.
  const envs = new PythonEnvironments(join(tmpdir(), "nexus-test-python-envs"), new PythonLocator());
  const secrets: Record<string, string> = { shop_api: "tok-SUPERSECRET-123" };
  let engine: PipelineEngine;
  let seq = 0;
  const run = (def: PipelineInput, opts: Parameters<PipelineEngine["start"]>[1] = {}) => {
    const started = engine.start({ id: `py${++seq}`, version: 1, definition: normalizePipeline(def) }, opts);
    return { ...started, done: started.done };
  };

  beforeAll(() => {
    engine = new PipelineEngine({
      store: StateStore.memory(),
      workRoot: join(root, "runs"),
      executors: new ExecutorRegistry([...BUILTIN_TRANSFORMS, ...BUILTIN_CONNECTORS, pythonStep(envs, { helpersDir: HELPERS })]),
      services: { secret: (n) => secrets[n] },
    });
    write("data/trips.csv", "trip_id,status,provider,fare\n1,Completed,A,12.5\n2,Completed,B,20\n2,Completed,B,20\n3,Cancelled,A,0\n");
  });

  it("gives the script its input, parameters and secrets, and passes its result on", async () => {
    const script = write(
      "pipelines/clean_trips.py",
      [
        "from nexus import input_data, output_data, param, secret, execution_mode, is_test_run",
        "df = input_data()",
        "print(f'received {len(df)} rows; mode={execution_mode()}; test={is_test_run()}')",
        "token = secret('shop_api')",
        "print('using token', token)",
        "df = df.drop_duplicates()",
        "df = df[df['status'] == param('status')]",
        "df['fare_with_tax'] = df['fare'] * (1 + param('tax'))",
        "output_data(df)",
      ].join("\n"),
    );
    const def: PipelineInput = {
      name: "Clean trips",
      params: [{ name: "status", default: "Completed" }, { name: "tax", type: "number", default: 0.1 }],
      steps: [
        { id: "trips", uses: "csv.read", with: { path: join(root, "data", "trips.csv") } },
        { id: "clean", uses: "python", with: { script } },
        { id: "totals", uses: "sql", with: { query: "select provider, round(sum(fare_with_tax), 2)::double as total from input group by provider order by provider" } },
      ],
    };
    const r = await run(def).done;
    expect(r.error).toBeNull();
    expect(r.status).toBe("succeeded");
    expect(r.steps.map((s) => s.output?.rows)).toEqual([4, 2, 2]);
    expect(r.steps[1]!.output!.columns.map((c) => c.name)).toContain("fare_with_tax");
    expect(r.steps[1]!.environment?.runtime).toMatch(/^Python 3\.\d+\.\d+$/);
    expect(Object.keys(r.steps[1]!.environment!.packages)).toEqual(expect.arrayContaining(["pandas", "pyarrow"]));
    const logs = engine.logs(r.id, "clean").map((l) => l.message);
    expect(logs).toContain("received 4 rows; mode=cpu; test=False");
    expect(logs).toContain("using token ••••");
    expect(logs.join("\n")).not.toContain("SUPERSECRET");

    // Same packages → the environment is reused, not rebuilt.
    const again = await run(def).done;
    expect(engine.logs(again.id, "clean").some((l) => l.message.startsWith("Creating a Python"))).toBe(false);
  }, 900_000);

  it("reports script errors plainly and doesn't retry them", async () => {
    const script = write("pipelines/broken.py", "from nexus import input_data\ndf = input_data()\nprint(df['provider_id'].sum())\n");
    const r = await run({ name: "Broken", steps: [{ id: "trips", uses: "csv.read", with: { path: join(root, "data", "trips.csv") } }, { id: "calc", uses: "python", with: { script } }] }).done;
    expect(r.status).toBe("failed");
    expect(r.error).toBe('calc (Python script) failed: The script looked for "provider_id", which isn\'t there (line 3 of broken.py) — the incoming data may not have a column called provider_id.');
    expect(r.steps[1]!.attempts).toBe(1);
    expect(r.steps[1]!.environment).toMatchObject({ runtime: expect.stringMatching(/^Python 3\./), host: { node: process.versions.node } });
  }, 300_000);

  it("refuses to run when a secret the script names isn't set up", async () => {
    const script = write("pipelines/needs_secret.py", "from nexus import secret\nprint(secret('warehouse_key'))\n");
    const r = await run({ name: "Secret", steps: [{ id: "s", uses: "python", with: { script } }] }).done;
    expect(r.error).toContain('The script uses the secret "warehouse_key", which isn\'t set up.');
  }, 300_000);

  it("stops the script (and anything it started) when the run is cancelled", async () => {
    const script = write("pipelines/slow.py", "import time\nprint('working', flush=True)\ntime.sleep(120)\n");
    const { runId, done } = run({ name: "Slow", steps: [{ id: "s", uses: "python", with: { script } }] });
    for (let i = 0; i < 600 && !engine.logs(runId, "s").some((l) => l.message === "working"); i++) await new Promise((r) => setTimeout(r, 100));
    const t = Date.now();
    engine.cancel(runId);
    const r = await done;
    expect(r.status).toBe("cancelled");
    expect(Date.now() - t).toBeLessThan(10_000);
  }, 300_000);
});
