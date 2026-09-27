import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { rPackagesScript } from "./r-packages";

/** Locations of the runtimes Nexus manages (bundled Node, per-app Python venv...). */
export interface RuntimeContext {
  /** Absolute path to node.exe (Nexus ships its own). */
  nodeExe: string;
  /** Python venv folder for this app, if it is a Python app. */
  venvDir?: string;
  /** Rscript.exe of the R this app runs on, if it is an R app. */
  rscript?: string;
  /** The release's private R package library. */
  rLibDir?: string;
}

export interface ResolvedCommand {
  executable: string;
  args: string[];
  /** Directories to put on PATH for child tools. */
  pathDirs: string[];
  /** Variables the command needs on top of the app's environment (e.g. the R library). */
  env: Record<string, string>;
}

export function defaultRuntimeContext(): RuntimeContext {
  return { nodeExe: process.execPath };
}

function npmCli(nodeExe: string, tool: "npm" | "npx"): string {
  const base = dirname(nodeExe);
  const candidates = [
    join(base, "node_modules", "npm", "bin", `${tool}-cli.js`),
    join(base, "..", "lib", "node_modules", "npm", "bin", `${tool}-cli.js`),
  ];
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error(`The bundled ${tool} could not be found next to ${nodeExe}.`);
  return found;
}

/**
 * Turns a logical command ("npm run start", "python -m uvicorn ...") into a concrete
 * executable + args without going through cmd.exe (no shell injection, exact PIDs).
 */
export function resolveCommand(command: string, args: string[], ctx: RuntimeContext): ResolvedCommand {
  const nodeDir = dirname(ctx.nodeExe);
  const venvScripts = ctx.venvDir ? join(ctx.venvDir, process.platform === "win32" ? "Scripts" : "bin") : null;
  const rBin = ctx.rscript ? dirname(ctx.rscript) : null;
  const pathDirs = [...(venvScripts ? [venvScripts] : []), ...(rBin ? [rBin] : []), nodeDir];
  const env: Record<string, string> = {};

  switch (command) {
    case "node":
      return { executable: ctx.nodeExe, args, pathDirs, env };
    case "npm":
    case "npx":
      return { executable: ctx.nodeExe, args: [npmCli(ctx.nodeExe, command), ...args], pathDirs, env };
    case "yarn":
    case "pnpm":
      // Via corepack, bundled with Node.
      return { executable: ctx.nodeExe, args: [join(nodeDir, "node_modules", "corepack", "dist", `${command}.js`), ...args], pathDirs, env };
    case "python":
    case "pip": {
      if (!venvScripts) throw new Error("This Python application has no environment yet.");
      const python = join(venvScripts, process.platform === "win32" ? "python.exe" : "python");
      return { executable: python, args: command === "pip" ? ["-m", "pip", ...args] : args, pathDirs, env };
    }
    case "Rscript":
    case "r-packages": {
      if (!ctx.rscript || !ctx.rLibDir) throw new Error("This R application has no environment yet.");
      // Only the app's own library plus R's bundled packages; --no-init-file skips a project .Rprofile
      // (renv's would switch to a library that isn't there).
      Object.assign(env, { R_LIBS_USER: ctx.rLibDir, R_LIBS: ctx.rLibDir, R_LIBS_SITE: ctx.rLibDir });
      const flags = ["--no-save", "--no-restore", "--no-init-file"];
      return { executable: ctx.rscript, args: command === "Rscript" ? [...flags, ...args] : [...flags, "-e", rPackagesScript(args)], pathDirs, env };
    }
    default:
      throw new Error(`Unsupported command "${command}".`);
  }
}
