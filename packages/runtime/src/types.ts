import type { ResourcePolicy, RuntimeKind } from "@nexus/shared";

export type LogStream = "stdout" | "stderr" | "system";

export interface LaunchSpec {
  appId: string;
  /** Working directory (inside the app's release folder). */
  cwd: string;
  /** Absolute path to the executable. */
  executable: string;
  args: string[];
  /** Complete environment for the process — nothing is inherited from Nexus. */
  env: Record<string, string>;
  port: number;
  resources: ResourcePolicy;
  onOutput: (stream: LogStream, line: string) => void;
  /**
   * The un-resolved command ("npm", ["run","start"]) and runtime, for providers that run
   * the app somewhere other than the host (containers).
   */
  logical?: { runtime: RuntimeKind; command: string; args: string[]; runtimeVersion?: string | null };
}

export interface ExitInfo {
  code: number | null;
  signal: string | null;
  /** True when Nexus asked the process to stop. */
  requested: boolean;
  at: number;
}

export interface ManagedProcess {
  readonly pid: number;
  readonly startedAt: number;
  /** Resolves when the process exits. */
  readonly exited: Promise<ExitInfo>;
  readonly running: boolean;
  stop(graceMs?: number): Promise<ExitInfo>;
}

/**
 * How an application is isolated. Implementations: plain isolated processes (works everywhere),
 * Podman containers on WSL2 (when available), and future plugins.
 */
export interface IsolationProvider {
  readonly id: string;
  /** Friendly name for Advanced mode, e.g. "Isolated process" or "Linux container (Podman)". */
  readonly label: string;
  available(): Promise<{ available: boolean; reason?: string }>;
  launch(spec: LaunchSpec): Promise<ManagedProcess>;
}
