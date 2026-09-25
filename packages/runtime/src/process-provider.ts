import { spawn, execFile, type ChildProcess } from "node:child_process";
import os from "node:os";
import { createInterface } from "node:readline";
import type { ExitInfo, IsolationProvider, LaunchSpec, ManagedProcess } from "./types";

const PRIORITY = { low: os.constants.priority.PRIORITY_BELOW_NORMAL, normal: os.constants.priority.PRIORITY_NORMAL, high: os.constants.priority.PRIORITY_ABOVE_NORMAL };

/** Kill a whole process tree on Windows (npm → node, python → workers...). */
export function killTree(pid: number, force: boolean): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      execFile("taskkill", ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])], { windowsHide: true }, () => resolve());
    } else {
      try {
        process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
      } catch {
        try {
          process.kill(pid, force ? "SIGKILL" : "SIGTERM");
        } catch {
          /* already gone */
        }
      }
      resolve();
    }
  });
}

class ChildManagedProcess implements ManagedProcess {
  readonly pid: number;
  readonly startedAt = Date.now();
  readonly exited: Promise<ExitInfo>;
  private stopRequested = false;
  private done = false;

  constructor(private readonly child: ChildProcess) {
    this.pid = child.pid!;
    this.exited = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        this.done = true;
        resolve({ code, signal, requested: this.stopRequested, at: Date.now() });
      });
    });
  }

  get running(): boolean {
    return !this.done;
  }

  async stop(graceMs = 8000): Promise<ExitInfo> {
    if (this.done) return this.exited;
    this.stopRequested = true;
    // Polite first (lets console apps with window handlers clean up), then force the whole tree.
    await killTree(this.pid, false);
    const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), graceMs).unref());
    if ((await Promise.race([this.exited, timeout])) === "timeout") await killTree(this.pid, true);
    const hard = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 5000).unref());
    if ((await Promise.race([this.exited, hard])) === "timeout") this.child.kill("SIGKILL");
    return this.exited;
  }
}

/**
 * Default isolation: each app runs as its own process tree with
 *  - its own release folder as working directory,
 *  - a scrubbed environment with private HOME/TEMP/APPDATA (see buildIsolatedEnv),
 *  - a loopback-only port assigned by Nexus,
 *  - its own least-privilege database role,
 *  - resource limits enforced by the Nexus watchdog.
 * Works on every Windows edition, including Home, with no extra components.
 */
export class ProcessIsolationProvider implements IsolationProvider {
  readonly id = "process";
  readonly label = "Isolated process";

  async available(): Promise<{ available: boolean }> {
    return { available: true };
  }

  async launch(spec: LaunchSpec): Promise<ManagedProcess> {
    const env = { ...spec.env };
    if (spec.resources.memoryLimitMb !== "auto" && /node(\.exe)?$/i.test(spec.executable)) {
      // Let V8 respect the memory limit instead of being killed by the watchdog.
      const heap = Math.max(128, Math.floor(spec.resources.memoryLimitMb * 0.85));
      env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ""} --max-old-space-size=${heap}`.trim();
    }

    const child = spawn(spec.executable, spec.args, {
      cwd: spec.cwd,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", (e) => reject(new Error(`Could not start the application: ${e.message}`)));
    });

    for (const [stream, name] of [
      [child.stdout, "stdout"],
      [child.stderr, "stderr"],
    ] as const) {
      if (!stream) continue;
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      rl.on("line", (line) => spec.onOutput(name, line));
    }

    if (spec.resources.priority !== "normal") {
      try {
        os.setPriority(child.pid!, PRIORITY[spec.resources.priority]);
      } catch {
        /* not fatal */
      }
    }
    return new ChildManagedProcess(child);
  }
}
