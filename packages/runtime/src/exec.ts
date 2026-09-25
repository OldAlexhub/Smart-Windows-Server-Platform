import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { killTree } from "./process-provider";

export interface RunResult {
  code: number;
  /** Last lines of combined output, for friendly error reports. */
  tail: string[];
  durationMs: number;
  timedOut: boolean;
}

/**
 * Runs a one-off command (install, build, migrate) to completion, streaming output
 * line by line. Never uses a shell.
 */
export function runToCompletion(opts: {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  onLine?: (stream: "stdout" | "stderr", line: string) => void;
  timeoutMs?: number;
}): Promise<RunResult> {
  const started = Date.now();
  const tail: string[] = [];
  const push = (l: string) => {
    tail.push(l);
    if (tail.length > 60) tail.shift();
  };
  return new Promise((resolve) => {
    const child = spawn(opts.executable, opts.args, { cwd: opts.cwd, env: opts.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          if (child.pid) void killTree(child.pid, true);
        }, opts.timeoutMs)
      : null;
    for (const [s, name] of [
      [child.stdout, "stdout"],
      [child.stderr, "stderr"],
    ] as const) {
      createInterface({ input: s! }).on("line", (l) => {
        push(l);
        opts.onLine?.(name, l);
      });
    }
    child.once("error", (e) => {
      if (timer) clearTimeout(timer);
      push(e.message);
      resolve({ code: -1, tail, durationMs: Date.now() - started, timedOut });
    });
    child.once("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, tail, durationMs: Date.now() - started, timedOut });
    });
  });
}
