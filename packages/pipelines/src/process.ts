import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { killTree } from "@nexus/runtime";

export interface ProcessRun {
  code: number;
  /** The last lines of output (stdout and stderr together), for errors and small results. */
  tail: string[];
  /** Largest memory use seen (bytes), sampled while it ran. */
  peakMemoryBytes: number | null;
  timedOut: boolean;
}

/** Windows variables a script genuinely needs; nothing else from Nexus's own environment is passed on. */
const SYSTEM_VARS = ["SystemRoot", "SYSTEMROOT", "windir", "ComSpec", "PATHEXT", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "OS", "SystemDrive", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "CommonProgramFiles"];
const GPU_VARS = /^(CUDA_PATH(_V\d+_\d+)?|NVIDIA_[A-Z_]+|CUDNN_PATH)$/;

/** A clean environment for a script: system variables, a private home and temp folder, then `vars`. */
export function scriptEnv(o: { homeDir: string; pathDirs: string[]; vars: Record<string, string>; gpu: boolean; hostEnv?: NodeJS.ProcessEnv }): Record<string, string> {
  const host = o.hostEnv ?? process.env;
  const env: Record<string, string> = {};
  for (const k of SYSTEM_VARS) if (host[k] !== undefined) env[k] = host[k]!;
  if (o.gpu) for (const [k, v] of Object.entries(host)) if (GPU_VARS.test(k) && v !== undefined) env[k] = v;
  const temp = join(o.homeDir, "tmp");
  mkdirSync(temp, { recursive: true });
  const sysRoot = env.SystemRoot ?? "C:\\Windows";
  const gpuPath = o.gpu && env.CUDA_PATH ? [join(env.CUDA_PATH, "bin")] : [];
  Object.assign(env, {
    USERPROFILE: o.homeDir,
    HOME: o.homeDir,
    APPDATA: join(o.homeDir, "AppData", "Roaming"),
    LOCALAPPDATA: join(o.homeDir, "AppData", "Local"),
    TEMP: temp,
    TMP: temp,
    PATH: [...o.pathDirs, ...gpuPath, join(sysRoot, "System32"), sysRoot, join(sysRoot, "System32", "Wbem")].join(";"),
    ...(o.gpu ? {} : { CUDA_VISIBLE_DEVICES: "" }),
    ...o.vars,
  });
  return env;
}

async function memoryOf(pid: number): Promise<number | null> {
  if (process.platform !== "win32") return null;
  return new Promise((resolve) => {
    const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid} OR ParentProcessId=${pid}" | Measure-Object -Property WorkingSetSize -Sum).Sum`], { windowsHide: true });
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.on("close", () => resolve(Number(out.trim()) || null));
    p.on("error", () => resolve(null));
  });
}

/**
 * Runs a program, streaming its output line by line. Stopping (cancel or timeout) ends the whole
 * process tree, so nothing a script started is left behind.
 */
export function runProcess(o: {
  exe: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Replace the environment instead of adding to Nexus's own (scripts get a clean one). */
  cleanEnv?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  onLine?: (line: string, stream: "stdout" | "stderr") => void;
  sampleMemory?: boolean;
  tailLines?: number;
}): Promise<ProcessRun> {
  return new Promise((resolve) => {
    const tail: string[] = [];
    const keep = o.tailLines ?? 200;
    let peak: number | null = null;
    let timedOut = false;
    const child = spawn(o.exe, o.args, {
      cwd: o.cwd,
      env: o.cleanEnv ? o.env : { ...process.env, ...o.env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stop = () => {
      if (child.pid && child.exitCode === null) void killTree(child.pid, true);
    };
    const timer = o.timeoutMs ? setTimeout(() => ((timedOut = true), stop()), o.timeoutMs) : null;
    o.signal?.addEventListener("abort", stop, { once: true });
    const sampler = o.sampleMemory && child.pid
      ? setInterval(() => {
          void memoryOf(child.pid!).then((m) => {
            if (m && (!peak || m > peak)) peak = m;
          });
        }, 2000)
      : null;
    for (const [stream, name] of [[child.stdout, "stdout"], [child.stderr, "stderr"]] as const) {
      let buffer = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop()!;
        for (const line of lines) {
          tail.push(line);
          if (tail.length > keep) tail.shift();
          o.onLine?.(line, name);
        }
      });
      stream.on("end", () => {
        if (buffer) {
          tail.push(buffer);
          if (tail.length > keep) tail.shift();
          o.onLine?.(buffer, name);
        }
      });
    }
    child.on("error", (e) => {
      tail.push(String(e.message));
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (sampler) clearInterval(sampler);
      o.signal?.removeEventListener("abort", stop);
      resolve({ code: code ?? -1, tail, peakMemoryBytes: peak, timedOut });
    });
  });
}
