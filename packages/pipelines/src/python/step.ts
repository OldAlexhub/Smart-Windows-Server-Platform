import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { describeDataset } from "../duck";
import { StepError } from "../errors";
import type { StepContext, StepExecutor, StepResult } from "../executor";
import type { ConnectorServices } from "../connectors";
import { runProcess, scriptEnv } from "../process";
import { detectPythonRequirements, scriptMetadata } from "./detect";
import type { PythonEnvironments } from "./environments";

export interface ScriptStepOptions {
  /** Folder holding the helper libraries (python/nexus, r/nexusR). */
  helpersDir: string;
  /** True when CUDA-capable hardware is present (hardware detection). */
  cudaAvailable?: () => boolean;
}

/** Turns a Python traceback into one plain sentence (the full traceback stays in the log). */
export function explainPythonError(lines: string[], scriptPath: string): string {
  const text = lines.join("\n");
  const last = [...lines].reverse().find((l) => /^[A-Za-z_][\w.]*(Error|Exception|Exit|Interrupt|Warning)\b/.test(l.trim()))?.trim();
  const script = basename(scriptPath);
  const frames = [...text.matchAll(/File "([^"]+)", line (\d+)/g)].filter((m) => basename(m[1]!) === script);
  const where = frames.length ? ` (line ${frames.at(-1)![2]} of ${script})` : "";
  const missing = text.match(/ModuleNotFoundError: No module named '([^']+)'/)?.[1];
  if (missing) return `The script needs the Python package "${missing.split(".")[0]}", which isn't installed. Add it to this step's packages.`;
  const key = last?.match(/^KeyError: '([^']+)'/)?.[1];
  if (key) return `The script looked for "${key}", which isn't there${where} — the incoming data may not have a column called ${key}.`;
  if (last) return `The script stopped with an error${where}: ${last}`;
  return `The script stopped with an error${where}.`;
}

export function pythonStep(envs: PythonEnvironments, opts: ScriptStepOptions): StepExecutor {
  return {
    kind: "python",
    async run(ctx: StepContext): Promise<StepResult> {
      const cfg = ctx.config as { script: string; args: string[]; packages: string[]; version?: string };
      const services = ctx.services as ConnectorServices;
      if (!isAbsolute(cfg.script)) throw new StepError(`Use a full path for the script, like C:\\Pipelines\\${cfg.script}.`);
      services.checkPath?.(cfg.script, "read");
      if (!existsSync(cfg.script)) throw new StepError(`The script ${cfg.script} doesn't exist.`, { problem: { title: "Script missing", summary: `The pipeline expected ${cfg.script}, but it isn't there.`, checks: [{ label: "Script file", status: "failed", detail: cfg.script }] } });

      // 1. Interpreter and packages
      const requirement = cfg.version ?? scriptMetadata(readFileSync(cfg.script, "utf8"))?.requiresPython ?? null;
      const install = await envs.finder.require(requirement ? (/^\d/.test(requirement) && !/[<>=~^]/.test(requirement) ? `==${requirement}` : requirement) : null).catch((e: Error) => {
        throw new StepError(e.message, { problem: (e as { problem?: StepError["problem"] }).problem });
      });
      const req = detectPythonRequirements(cfg.script, await envs.stdlib(install.executable), cfg.packages);
      if (req.imports.length) ctx.log("info", `Packages detected (${req.source}): ${req.packages.join(", ") || "none"}.`);
      const env = await envs.ensure(install, req.packages, (m) => ctx.log("info", m), ctx.signal);

      // 2. What the script may use: only the secrets and databases it names
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
        PYTHONPATH: join(opts.helpersDir, "python"),
        PYTHONUNBUFFERED: "1",
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
        NEXUS_INPUTS: JSON.stringify(Object.fromEntries(ctx.inputs.map((i) => [i.id, i.dataset.path]))),
        NEXUS_OUTPUT: ctx.outputPath,
        NEXUS_PARAMS: JSON.stringify(ctx.params),
        NEXUS_SECRETS: JSON.stringify(secrets),
        NEXUS_DATABASES: JSON.stringify(databases),
        NEXUS_EXECUTION_MODE: gpu ? "cuda" : "cpu",
        NEXUS_TEST_RUN: ctx.testRows !== null ? "1" : "0",
        NEXUS_RUN_ID: ctx.runId,
      };
      ctx.log("info", `Running ${basename(cfg.script)} with Python ${env.version} (${gpu ? "CUDA accelerated" : "CPU"}).`);
      const secretValues = Object.values(secrets).filter((v) => v.length >= 4);
      const redact = (line: string) => secretValues.reduce((l, s) => l.split(s).join("••••"), line);
      const environment = { runtime: `Python ${env.version}`, packages: env.packages };
      ctx.recordEnvironment(environment);
      const result = await runProcess({
        exe: env.python,
        args: ["-u", cfg.script, ...cfg.args],
        cwd: dirname(cfg.script),
        env: scriptEnv({ homeDir: join(ctx.workDir, "home"), pathDirs: [join(env.dir, "Scripts")], vars, gpu }),
        cleanEnv: true,
        signal: ctx.signal,
        sampleMemory: true,
        onLine: (line, stream) => {
          if (!line.trim()) return;
          const level = stream === "stderr" ? (/Warning\b/.test(line) ? "warn" : "debug") : "info";
          ctx.log(level, redact(line));
        },
      });
      if (ctx.signal.aborted) throw ctx.signal.reason;
      if (result.code !== 0) {
        const tail = result.tail.map(redact);
        throw new StepError(explainPythonError(tail, cfg.script), { technical: tail.slice(-40).join("\n") });
      }

      // 4. Its result
      const peakMemoryBytes = result.peakMemoryBytes;
      if (!existsSync(ctx.outputPath)) {
        return { output: null, environment, metrics: { peakMemoryBytes }, warnings: ctx.inputs.length ? ["The script didn't call output_data(), so it passes no data on."] : [] };
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
