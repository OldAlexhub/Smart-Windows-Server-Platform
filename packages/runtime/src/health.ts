import { EventEmitter } from "node:events";
import { formatBytes, formatDuration } from "@nexus/shared";
import type { AppSupervisor } from "./supervisor";

export interface ProbeResult {
  ok: boolean;
  status: number | null;
  ms: number;
  error?: string;
}

export type Prober = (url: string, timeoutMs: number) => Promise<ProbeResult>;

export const httpProber: Prober = async (url, timeoutMs) => {
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
    await res.body?.cancel();
    return { ok: true, status: res.status, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, status: null, ms: Date.now() - started, error: (e as Error).message };
  }
};

export interface RestartPolicy {
  /** Automatic restarts allowed inside `windowMs` before Nexus stops trying. */
  maxRestarts: number;
  windowMs: number;
  /** Delay before each successive restart. */
  backoffMs: number[];
}

export interface HealthConfig {
  appName: string;
  /** Explicit health endpoint, or null to probe "/" (any non-5xx answer counts). */
  healthPath: string | null;
  intervalMs?: number;
  timeoutMs?: number;
  /** Consecutive failed probes before restarting. */
  failureThreshold?: number;
  memoryLimitBytes?: number | null;
  restart?: Partial<RestartPolicy>;
}

export type HealthEventKind = "unhealthy" | "restarting" | "recovered" | "gave_up" | "memory_exceeded";

export interface HealthEvent {
  kind: HealthEventKind;
  appName: string;
  message: string;
  downtimeMs?: number;
}

const DEFAULT_POLICY: RestartPolicy = { maxRestarts: 5, windowMs: 10 * 60_000, backoffMs: [1000, 5000, 15_000, 30_000, 60_000] };

/**
 * Watches one application and repairs safe conditions automatically:
 * crashed process → restart with backoff; unresponsive HTTP → restart; memory runaway → restart.
 * If failures repeat, it stops the restart loop and reports the underlying problem instead.
 */
export class HealthMonitor extends EventEmitter<{ event: [HealthEvent]; probe: [ProbeResult] }> {
  private timer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private consecutiveFailures = 0;
  private memoryStrikes = 0;
  private restarts: number[] = [];
  private downSince: number | null = null;
  private stopped = false;
  private gaveUp = false;
  private readonly policy: RestartPolicy;
  lastProbe: ProbeResult | null = null;

  constructor(
    private readonly sup: AppSupervisor,
    private readonly cfg: HealthConfig,
    private readonly deps: {
      probe?: Prober;
      /** Current memory of the app's process tree in bytes. */
      memoryOf?: (pid: number) => Promise<number | null>;
      /** Most recent error text, used to explain a crash loop. */
      explain?: () => string | null;
      now?: () => number;
    } = {},
  ) {
    super();
    this.policy = { ...DEFAULT_POLICY, ...cfg.restart };
    this.onCrash = this.onCrash.bind(this);
  }

  private get now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  get isGivingUp(): boolean {
    return this.gaveUp;
  }

  start(): void {
    this.stopped = false;
    this.sup.on("crash", this.onCrash);
    this.schedule();
  }

  dispose(): void {
    this.stopped = true;
    this.sup.off("crash", this.onCrash);
    if (this.timer) clearTimeout(this.timer);
    if (this.restartTimer) clearTimeout(this.restartTimer);
  }

  /** Called after the user fixes something and presses Start/Restart. */
  reset(): void {
    this.gaveUp = false;
    this.restarts = [];
    this.consecutiveFailures = 0;
    this.memoryStrikes = 0;
    this.downSince = null;
  }

  /** One health check round; exposed for tests and "Check now". */
  async check(): Promise<void> {
    if (this.stopped || this.gaveUp || this.sup.status !== "running") return;
    const url = `http://127.0.0.1:${this.sup.port}${this.cfg.healthPath ?? "/"}`;
    const r = await (this.deps.probe ?? httpProber)(url, this.cfg.timeoutMs ?? 5000);
    // With an explicit health endpoint we require success; for "/" any non-5xx answer means "alive".
    const healthy = r.ok && r.status !== null && (this.cfg.healthPath ? r.status < 400 : r.status < 500);
    this.lastProbe = { ...r, ok: healthy };
    this.emit("probe", this.lastProbe);

    if (healthy) {
      this.consecutiveFailures = 0;
      if (this.downSince !== null) this.recovered();
    } else {
      this.consecutiveFailures++;
      if (this.downSince === null) this.downSince = this.now;
      if (this.consecutiveFailures >= (this.cfg.failureThreshold ?? 3)) {
        this.consecutiveFailures = 0;
        this.emit("event", { kind: "unhealthy", appName: this.cfg.appName, message: `${this.cfg.appName} stopped responding.` });
        this.requestRestart("stopped responding");
        return;
      }
    }

    if (this.cfg.memoryLimitBytes && this.deps.memoryOf && this.sup.pid) {
      const mem = await this.deps.memoryOf(this.sup.pid);
      if (mem !== null && mem > this.cfg.memoryLimitBytes) {
        if (++this.memoryStrikes >= 3) {
          this.memoryStrikes = 0;
          this.emit("event", {
            kind: "memory_exceeded",
            appName: this.cfg.appName,
            message: `${this.cfg.appName} was using ${formatBytes(mem)}, above its ${formatBytes(this.cfg.memoryLimitBytes)} limit.`,
          });
          this.requestRestart("used too much memory");
        }
      } else {
        this.memoryStrikes = 0;
      }
    }
  }

  private onCrash(): void {
    if (this.stopped) return;
    if (this.downSince === null) this.downSince = this.now;
    this.requestRestart("stopped unexpectedly");
  }

  private requestRestart(reason: string): void {
    if (this.gaveUp || this.restartTimer) return;
    const t = this.now;
    this.restarts = this.restarts.filter((x) => t - x < this.policy.windowMs);
    if (this.restarts.length >= this.policy.maxRestarts) {
      this.giveUp(reason);
      return;
    }
    const delay = this.policy.backoffMs[Math.min(this.restarts.length, this.policy.backoffMs.length - 1)] ?? 1000;
    this.restarts.push(t);
    this.emit("event", {
      kind: "restarting",
      appName: this.cfg.appName,
      message: `${this.cfg.appName} ${reason}. Nexus is restarting it.`,
    });
    this.restartTimer = setTimeout(async () => {
      this.restartTimer = null;
      if (this.stopped) return;
      const status = await this.sup.restart();
      if (status === "running") {
        // Confirm with a real probe before announcing recovery.
        await this.check();
        if (this.downSince !== null && this.sup.status === "running" && this.lastProbe?.ok !== false) this.recovered();
      }
    }, delay);
    this.restartTimer.unref?.();
  }

  private recovered(): void {
    const downtime = this.downSince !== null ? this.now - this.downSince : 0;
    this.downSince = null;
    this.emit("event", {
      kind: "recovered",
      appName: this.cfg.appName,
      message: `${this.cfg.appName} is running again. Service restored after ${formatDuration(downtime)}.`,
      downtimeMs: downtime,
    });
  }

  private giveUp(reason: string): void {
    this.gaveUp = true;
    const why = this.deps.explain?.() ?? null;
    const detail = `${this.cfg.appName} ${reason} ${this.policy.maxRestarts} times in ${formatDuration(this.policy.windowMs)}. Nexus stopped restarting it so the underlying problem can be fixed.`;
    this.sup.flag("needs_attention", why ? `${detail}\n\nLast error: ${why}` : detail);
    void this.sup.stop().then(() => this.sup.flag("needs_attention", why ? `${detail}\n\nLast error: ${why}` : detail));
    this.emit("event", { kind: "gave_up", appName: this.cfg.appName, message: detail });
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(async () => {
      try {
        await this.check();
      } finally {
        this.schedule();
      }
    }, this.cfg.intervalMs ?? 15_000);
    this.timer.unref?.();
  }
}
