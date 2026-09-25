import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { describeDataset } from "../duck";
import { StepError } from "../errors";
import type { StepContext, StepExecutor, StepResult } from "../executor";
import type { ConnectorServices } from "../connectors";
import { runProcess, scriptEnv } from "../process";
import type { ScriptStepOptions } from "../python/step";
import { detectRRequirements, explainRError, type RLocator } from "./detect";
import type { RLibraries } from "./environments";

/** R steps: the script runs with Rscript, an isolated package library, and nexusR attached. */
export function rStep(locator: RLocator, libraries: RLibraries, opts: ScriptStepOptions): StepExecutor {
  return {
    kind: "r",
    async run(ctx: StepContext): Promise<StepResult> {
      const cfg = ctx.config as { script: string; args: string[]; packages: string[]; version?: string };
      const services = ctx.services as ConnectorServices;
      if (!isAbsolute(cfg.script)) throw new StepError(`Use a full path for the script, like C:\\Analytics\\${cfg.script}.`);
      services.checkPath?.(cfg.script, "read");
      if (!existsSync(cfg.script)) throw new StepError(`The script ${cfg.script} doesn't exist.`, { problem: { title: "Script missing", summary: `The pipeline expected ${cfg.script}, but it isn't there.`, checks: [{ label: "Script file", status: "failed", detail: cfg.script }] } });

      // 1. R and packages
      const r = await locator.require(cfg.version ?? null);
      const req = detectRRequirements(cfg.script, await libraries.builtin(r), cfg.packages);
      if (req.packages.length) ctx.log("info", `Packages detected (${req.source}): ${req.packages.join(", ")}.`);
      const lib = await libraries.ensure(r, req.packages, req.pinned, (m) => ctx.log("info", m), ctx.signal);

      // 2. Only the secrets and databases the script names
      const secrets: Record<string, string> = {};
      for (const name of req.secrets) {
        const value = services.secret?.(name);
        if (value === undefined) throw new StepError(`The script uses the secret "${name}", which isn't set up. Add it under Pipelines › Secrets.`);
        secrets[name] = value;
      }
      const databases: Record<string, string> = {};
      for (const name of req.databases) {
        if (!services.database) throw new StepError("Database access isn't available on this server.");
        databases[name] = (await services.database({ database: name }, "write")).url;
      }

      // 3. Run it
      const gpu = ctx.pipeline.resources.gpu === "allowed" && !!opts.cudaAvailable?.();
      const vars: Record<string, string> = {
        R_LIBS: lib.dir,
        R_LIBS_USER: lib.dir,
        R_LIBS_SITE: "",
        // nexusR is attached automatically, so nexus_input() works with or without library(nexusR).
        R_DEFAULT_PACKAGES: "datasets,utils,grDevices,graphics,stats,methods,nexusR",
        LANG: "en_US.UTF-8",
        NEXUS_INPUTS: JSON.stringify(Object.fromEntries(ctx.inputs.map((i) => [i.id, i.dataset.path]))),
        NEXUS_OUTPUT: ctx.outputPath,
        NEXUS_PARAMS: JSON.stringify(ctx.params),
        NEXUS_SECRETS: JSON.stringify(secrets),
        NEXUS_DATABASES: JSON.stringify(databases),
        NEXUS_EXECUTION_MODE: gpu ? "cuda" : "cpu",
        NEXUS_TEST_RUN: ctx.testRows !== null ? "1" : "0",
        NEXUS_RUN_ID: ctx.runId,
      };
      ctx.log("info", `Running ${basename(cfg.script)} with R ${r.version} (${gpu ? "CUDA accelerated" : "CPU"}).`);
      const secretValues = Object.values(secrets).filter((v) => v.length >= 4);
      const redact = (line: string) => secretValues.reduce((l, s) => l.split(s).join("••••"), line);
      const environment = { runtime: `R ${r.version}`, packages: lib.packages };
      ctx.recordEnvironment(environment);
      const result = await runProcess({
        exe: r.rscript,
        // --no-environ etc.: the user's personal R settings can't change how the pipeline runs.
        args: ["--no-save", "--no-restore", "--no-site-file", "--no-init-file", "--no-environ", cfg.script, ...cfg.args],
        cwd: dirname(cfg.script),
        env: scriptEnv({ homeDir: join(ctx.workDir, "home"), pathDirs: [join(r.home, "bin")], vars, gpu }),
        cleanEnv: true,
        signal: ctx.signal,
        sampleMemory: true,
        onLine: (line, stream) => {
          if (!line.trim()) return;
          const level = stream === "stderr" ? (/^Warning|warning\b/i.test(line) ? "warn" : /^Error/.test(line) ? "error" : "info") : "info";
          ctx.log(level, redact(line));
        },
      });
      if (ctx.signal.aborted) throw ctx.signal.reason;
      if (result.code !== 0) {
        const tail = result.tail.map(redact);
        throw new StepError(explainRError(tail), { technical: tail.slice(-40).join("\n") });
      }

      // 4. Its result
      const peakMemoryBytes = result.peakMemoryBytes;
      if (!existsSync(ctx.outputPath)) {
        return { output: null, environment, metrics: { peakMemoryBytes }, warnings: ctx.inputs.length ? ["The script didn't call nexus_output(), so it passes no data on."] : [] };
      }
      const sb = await ctx.sandbox();
      try {
        const output = await describeDataset(sb, ctx.outputPath);
        return { output, environment, metrics: { rowsOut: output.rows, bytesOut: output.bytes, peakMemoryBytes } };
      } finally {
        sb.close();
      }
    },
  };
}

/** Reads an R script's text (exported for the designer's "packages detected" preview). */
export const readRScript = (path: string) => readFileSync(path, "utf8");
