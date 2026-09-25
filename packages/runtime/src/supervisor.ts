import { EventEmitter } from "node:events";
import net from "node:net";
import type { AppStatus, ResourcePolicy } from "@nexus/shared";
import type { ExitInfo, IsolationProvider, LogStream, ManagedProcess } from "./types";

/** Resolves true once something accepts TCP connections on 127.0.0.1:port. */
export function waitForPort(port: number, timeoutMs: number, isAlive: () => boolean = () => true): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let delay = 50; // fast at first so quick starts are noticed promptly, then back off
  return new Promise((resolve) => {
    const attempt = () => {
      if (!isAlive()) return resolve(false);
      const sock = net.connect({ port, host: "127.0.0.1" });
      sock.once("connect", () => {
        sock.destroy();
        resolve(true);
      });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() >= deadline) resolve(false);
        else {
          setTimeout(attempt, delay);
          delay = Math.min(delay * 2, 500);
        }
      });
    };
    attempt();
  });
}

export interface AppProcessConfig {
  appId: string;
  cwd: string;
  executable: string;
  args: string[];
  env: Record<string, string>;
  port: number;
  resources: ResourcePolicy;
  /** How long an app may take to open its port. */
  startupTimeoutMs?: number;
  /** Background workers without an HTTP port. */
  listens?: boolean;
}

export interface SupervisorEvents {
  status: [status: AppStatus, detail?: string];
  output: [stream: LogStream, line: string];
  /** The process exited without Nexus asking it to. */
  crash: [exit: ExitInfo];
}

/**
 * Owns the lifecycle of one running application: start (and confirm it is listening),
 * stop (whole process tree), restart. Restart policy lives in the HealthMonitor.
 */
export class AppSupervisor extends EventEmitter<SupervisorEvents> {
  private proc: ManagedProcess | null = null;
  private _status: AppStatus = "stopped";
  private _detail: string | undefined;
  private lastExit: ExitInfo | null = null;
  private opQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private config: AppProcessConfig,
    private readonly provider: IsolationProvider,
  ) {
    super();
  }

  get status(): AppStatus {
    return this._status;
  }
  get detail(): string | undefined {
    return this._detail;
  }
  get pid(): number | null {
    return this.proc?.running ? this.proc.pid : null;
  }
  get startedAt(): number | null {
    return this.proc?.running ? this.proc.startedAt : null;
  }
  get lastExitInfo(): ExitInfo | null {
    return this.lastExit;
  }
  get port(): number {
    return this.config.port;
  }
  /** What is being run (for Advanced › Developer). Environment values are deliberately excluded. */
  get command(): { executable: string; args: string[]; cwd: string } {
    return { executable: this.config.executable, args: [...this.config.args], cwd: this.config.cwd };
  }
  get isolation(): { id: string; label: string } {
    return { id: this.provider.id, label: this.provider.label };
  }

  /** Apply new configuration (takes effect on next start). */
  reconfigure(config: AppProcessConfig): void {
    this.config = config;
  }

  start(): Promise<AppStatus> {
    return this.serial(() => this.doStart());
  }

  stop(): Promise<void> {
    return this.serial(() => this.doStop());
  }

  restart(): Promise<AppStatus> {
    return this.serial(async () => {
      await this.doStop();
      return this.doStart();
    });
  }

  /** Mark as needing attention (e.g. crash loop) without touching the process. */
  flag(status: AppStatus, detail: string): void {
    this.setStatus(status, detail);
  }

  private async doStart(): Promise<AppStatus> {
    if (this.proc?.running) return this._status;
    this.setStatus("starting");
    const cfg = this.config;
    let proc: ManagedProcess;
    try {
      proc = await this.provider.launch({
        appId: cfg.appId,
        cwd: cfg.cwd,
        executable: cfg.executable,
        args: cfg.args,
        env: cfg.env,
        port: cfg.port,
        resources: cfg.resources,
        onOutput: (s, l) => this.emit("output", s, l),
      });
    } catch (e) {
      this.setStatus("crashed", (e as Error).message);
      return this._status;
    }
    this.proc = proc;
    this.emit("output", "system", `Started (process ${proc.pid}).`);

    void proc.exited.then((exit) => {
      this.lastExit = exit;
      if (this.proc !== proc) return;
      this.proc = null;
      if (exit.requested) return;
      const detail = `Stopped unexpectedly (exit code ${exit.code ?? exit.signal ?? "unknown"}).`;
      this.emit("output", "system", detail);
      this.setStatus("crashed", detail);
      this.emit("crash", exit);
    });

    if (cfg.listens === false) {
      this.setStatus("running");
      return this._status;
    }
    const up = await waitForPort(cfg.port, cfg.startupTimeoutMs ?? 60_000, () => proc.running);
    if (!proc.running) return this._status; // exit handler already marked it crashed
    if (up) this.setStatus("running");
    else this.setStatus("needs_attention", "The application started but is not answering on its assigned port.");
    return this._status;
  }

  private async doStop(): Promise<void> {
    const proc = this.proc;
    if (!proc) {
      if (this._status !== "needs_attention") this.setStatus("stopped");
      return;
    }
    await proc.stop();
    this.proc = null;
    this.emit("output", "system", "Stopped.");
    this.setStatus("stopped");
  }

  private setStatus(status: AppStatus, detail?: string): void {
    this._status = status;
    this._detail = detail;
    this.emit("status", status, detail);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.opQueue.then(fn, fn);
    this.opQueue = next.catch(() => undefined);
    return next;
  }
}
