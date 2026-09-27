import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { ExitInfo, IsolationProvider, LaunchSpec, ManagedProcess } from "./types";

export type Exec = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

const defaultExec: Exec = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 30_000 }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) }),
    );
  });

/** Variables that describe the Windows host and make no sense inside a Linux container. */
const HOST_ONLY = /^(SystemRoot|SYSTEMROOT|windir|ComSpec|PATHEXT|PATH|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|HOME|ProgramData|ProgramFiles.*|CommonProgramFiles|SystemDrive|NUMBER_OF_PROCESSORS|PROCESSOR_.*|OS)$/;

export function containerName(appId: string): string {
  return `nexus-${appId.toLowerCase().replace(/[^a-z0-9_.-]/g, "-")}`;
}

export function defaultImage(runtime: string, version?: string | null): string {
  const major = version?.match(/(\d+)(?:\.(\d+))?/);
  if (runtime === "python") return `docker.io/library/python:${major ? `${major[1]}.${major[2] ?? "12"}` : "3.12"}-slim`;
  if (runtime === "r") return `docker.io/rocker/r-ver:${version?.match(/^\d+\.\d+\.\d+$/) ? version : "latest"}`;
  if (runtime === "node") return `docker.io/library/node:${major && Number(major[1]) >= 18 ? major[1] : "22"}-slim`;
  return "docker.io/library/caddy:2-alpine";
}

/**
 * Builds a hardened `podman run` command line. Secret values are NOT placed on the
 * command line: `-e NAME` makes Podman copy the value from its own environment.
 */
export function buildPodmanRunArgs(spec: LaunchSpec, image: string): { args: string[]; env: Record<string, string> } {
  if (!spec.logical) throw new Error("Container launch needs the logical command.");
  const passEnv: Record<string, string> = {};
  const args = [
    "run",
    "--rm",
    "--name",
    containerName(spec.appId),
    "--replace",
    // Publish only on loopback; the HTTPS gateway is the sole public entry point.
    "-p",
    `127.0.0.1:${spec.port}:${spec.port}`,
    "-v",
    `${spec.cwd}:/app:Z`,
    "-w",
    "/app",
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "--pids-limit",
    "512",
    "--add-host",
    "host.nexus.internal:host-gateway",
  ];
  if (spec.resources.memoryLimitMb !== "auto") args.push("--memory", `${spec.resources.memoryLimitMb}m`);
  if (spec.resources.cpuLimitPercent !== "auto") args.push("--cpus", (spec.resources.cpuLimitPercent / 100).toFixed(2));

  for (const [k, v] of Object.entries(spec.env)) {
    if (HOST_ONLY.test(k)) continue;
    // Inside the container the app must bind all interfaces; the port is published to loopback only.
    const value = k === "HOST" ? "0.0.0.0" : rewriteLoopback(v);
    passEnv[k] = value;
    args.push("-e", k);
  }
  args.push(image, spec.logical.command, ...spec.logical.args.map((a) => a.replaceAll("{PORT}", String(spec.port))));
  return { args, env: passEnv };
}

/** Services on the Windows host (PostgreSQL, storage API) are reached via host.nexus.internal. */
function rewriteLoopback(v: string): string {
  return v.replace(/\b(127\.0\.0\.1|localhost)\b/g, "host.nexus.internal");
}

class PodmanProcess implements ManagedProcess {
  readonly pid: number;
  readonly startedAt = Date.now();
  readonly exited: Promise<ExitInfo>;
  private done = false;
  private requested = false;

  constructor(
    private readonly child: ChildProcess,
    private readonly name: string,
    private readonly podman: string,
    private readonly exec: Exec,
  ) {
    this.pid = child.pid!;
    this.exited = new Promise((resolve) =>
      child.once("exit", (code, signal) => {
        this.done = true;
        resolve({ code, signal, requested: this.requested, at: Date.now() });
      }),
    );
  }
  get running(): boolean {
    return !this.done;
  }
  async stop(graceMs = 10_000): Promise<ExitInfo> {
    if (this.done) return this.exited;
    this.requested = true;
    await this.exec(this.podman, ["stop", "-t", String(Math.ceil(graceMs / 1000)), this.name]);
    return this.exited;
  }
}

/**
 * Linux containers via Podman (rootless, daemonless) running on WSL2.
 * Optional: used for Linux-only apps or when chosen in Advanced settings.
 */
export class PodmanIsolationProvider implements IsolationProvider {
  readonly id = "podman";
  readonly label = "Linux container (Podman on WSL2)";

  constructor(
    private readonly podman = "podman",
    private readonly exec: Exec = defaultExec,
  ) {}

  async available(): Promise<{ available: boolean; reason?: string }> {
    const v = await this.exec(this.podman, ["--version"]);
    if (v.code !== 0) return { available: false, reason: "Podman is not installed." };
    const info = await this.exec(this.podman, ["info", "--format", "{{.Host.OS}}"]);
    if (info.code !== 0) {
      return { available: false, reason: "The Linux environment (WSL2 machine) is not running." };
    }
    return { available: true };
  }

  async launch(spec: LaunchSpec): Promise<ManagedProcess> {
    const image = defaultImage(spec.logical?.runtime ?? "node", spec.logical?.runtimeVersion);
    const { args, env } = buildPodmanRunArgs(spec, image);
    const child = spawn(this.podman, args, { env: { ...process.env, ...env }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", (e) => reject(new Error(`Could not start the container: ${e.message}`)));
    });
    for (const [s, name] of [
      [child.stdout, "stdout"],
      [child.stderr, "stderr"],
    ] as const) {
      if (s) createInterface({ input: s }).on("line", (l) => spec.onOutput(name, l));
    }
    return new PodmanProcess(child, containerName(spec.appId), this.podman, this.exec);
  }
}
