import { EventEmitter } from "node:events";
import { formatBytes, formatDuration, type HealthMonitoring } from "@nexus/shared";
import type { AppSupervisor } from "./supervisor";
import type { ExitInfo } from "./types";

export type ProbeFailureKind = "timeout" | "connection_refused" | "connection_reset" | "http_error" | "network_error";

export interface ProbeResult {
  /** Whether the HTTP exchange itself completed. HealthMonitor applies the endpoint's status policy. */
  ok: boolean;
  status: number | null;
  ms: number;
  error?: string;
  failure?: ProbeFailureKind;
}

export type Prober = (url: string, timeoutMs: number) => Promise<ProbeResult>;

/** Explicit endpoints report health; general probes only prove that an HTTP server is alive. */
export function healthyHttpStatus(kind: "health" | "liveness", status: number): boolean {
  return kind === "health" ? status < 400 : status < 500;
}

function networkFailure(error: unknown): { failure: Exclude<ProbeFailureKind, "http_error">; error: string } {
  const e = error as Error & { code?: string; cause?: { code?: string; message?: string } };
  const code = e.code ?? e.cause?.code;
  const message = e.message || e.cause?.message || String(error);
  if (e.name === "TimeoutError" || e.name === "AbortError" || /timed? ?out|timeout/i.test(message)) return { failure: "timeout", error: `timeout: ${message}` };
  if (code === "ECONNREFUSED" || /ECONNREFUSED|connection refused/i.test(message)) return { failure: "connection_refused", error: `ECONNREFUSED: ${message}` };
  if (code === "ECONNRESET" || /ECONNRESET|connection reset|socket hang up/i.test(message)) return { failure: "connection_reset", error: `ECONNRESET: ${message}` };
  return { failure: "network_error", error: code ? `${code}: ${message}` : message };
}

export const httpProber: Prober = async (url, timeoutMs) => {
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
    await res.body?.cancel();
    return { ok: true, status: res.status, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, status: null, ms: Date.now() - started, ...networkFailure(e) };
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
  health: HealthMonitoring;
  intervalMs?: number;
  timeoutMs?: number;
  /** Consecutive failed probes before restarting. */
  failureThreshold?: number;
  memoryLimitBytes?: number | null;
  restart?: Partial<RestartPolicy>;
}

export type HealthFailureKind = "process_crashed" | "http_timeout" | "http_error" | "connection_refused" | "connection_reset" | "network_error" | "resource_exceeded";

export interface HealthFailure {
  kind: HealthFailureKind;
  at: number;
  detail: string;
}

export interface ProbeRecord extends ProbeResult {
  at: number;
  url: string;
}

export interface RestartRecord {
  at: number;
  failure: HealthFailureKind;
  detail: string;
  pidBefore: number | null;
  completedAt?: number;
  outcome?: string;
  pidAfter?: number | null;
}

export interface HealthDiagnostics {
  monitoring: HealthMonitoring;
  candidateValidation: ProbeRecord | null;
  lastSuccessfulProbe: ProbeRecord | null;
  failedProbes: ProbeRecord[];
  lastFailure: HealthFailure | null;
  process: {
    pid: number | null;
    running: boolean;
    status: string;
    startedAt: number | null;
    uptimeMs: number | null;
    memoryBytes: number | null;
    lastExit: ExitInfo | null;
  };
  restartHistory: RestartRecord[];
}

export type HealthEventKind = "health_validated" | "health_candidate_rejected" | "unhealthy" | "restarting" | "recovered" | "gave_up" | "memory_exceeded" | "process_crashed";

export interface HealthEvent {
  kind: HealthEventKind;
  appName: string;
  message: string;
  downtimeMs?: number;
  failure?: HealthFailure;
  /** Full incident evidence for callers that persist or display it. */
  detail?: string;
  diagnostics?: HealthDiagnostics;
}

export interface ApplicationLogTail {
  stdout: string[];
  stderr: string[];
  system?: string[];
}

const DEFAULT_POLICY: RestartPolicy = { maxRestarts: 5, windowMs: 10 * 60_000, backoffMs: [1000, 5000, 15_000, 30_000, 60_000] };
const EVIDENCE_LIMIT = 10;
const RESTART_HISTORY_LIMIT = 20;

/**
 * Watches one application and repairs safe conditions automatically. It intentionally keeps
 * process crashes, HTTP failures and resource enforcement as separate incident causes: those are
 * different problems even though each may ultimately require a restart.
 */
export class HealthMonitor extends EventEmitter<{ event: [HealthEvent]; probe: [ProbeResult] }> {
  private timer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private consecutiveFailures = 0;
  private memoryStrikes = 0;
  /** Restart timestamps used only for rate limiting the current automatic-repair incident. */
  private restartAttempts: number[] = [];
  private readonly restartHistory: RestartRecord[] = [];
  private readonly failedProbes: ProbeRecord[] = [];
  private readonly health: HealthMonitoring;
  private candidateValidation: ProbeRecord | null = null;
  private lastSuccessfulProbe: ProbeRecord | null = null;
  private lastFailure: HealthFailure | null = null;
  private lastMemoryBytes: number | null = null;
  /** Output snapshots taken before each restart, so later noisy restarts cannot evict the cause. */
  private readonly capturedLogs: ApplicationLogTail = { stdout: [], stderr: [], system: [] };
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
      /** Most recent error text. Kept for callers using the original API. */
      explain?: () => string | null;
      /** Already-redacted application output to retain with the incident. */
      logs?: () => ApplicationLogTail;
      /** Checks the app's configured database only when automatic recovery gives up. */
      database?: () => Promise<string | null>;
      now?: () => number;
    } = {},
  ) {
    super();
    this.policy = { ...DEFAULT_POLICY, ...cfg.restart };
    this.health = structuredClone(cfg.health);
    this.onCrash = this.onCrash.bind(this);
  }

  private get now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  get isGivingUp(): boolean {
    return this.gaveUp;
  }

  /** A copy of all evidence retained for the current/recent incident. */
  diagnostics(): HealthDiagnostics {
    const startedAt = this.sup.startedAt;
    return {
      monitoring: structuredClone(this.health),
      candidateValidation: this.candidateValidation ? { ...this.candidateValidation } : null,
      lastSuccessfulProbe: this.lastSuccessfulProbe ? { ...this.lastSuccessfulProbe } : null,
      failedProbes: this.failedProbes.map((p) => ({ ...p })),
      lastFailure: this.lastFailure ? { ...this.lastFailure } : null,
      process: {
        pid: this.sup.pid,
        running: this.sup.pid !== null,
        status: this.sup.status,
        startedAt,
        uptimeMs: startedAt === null ? null : Math.max(0, this.now - startedAt),
        memoryBytes: this.lastMemoryBytes,
        lastExit: this.sup.lastExitInfo ? { ...this.sup.lastExitInfo } : null,
      },
      restartHistory: this.restartHistory.map((r) => ({ ...r })),
    };
  }

  start(): void {
    this.stopped = false;
    // start() is idempotent: never attach the crash listener twice.
    this.sup.off("crash", this.onCrash);
    this.sup.on("crash", this.onCrash);
    if (!this.timer) this.schedule();
  }

  dispose(): void {
    this.stopped = true;
    this.sup.off("crash", this.onCrash);
    if (this.timer) clearTimeout(this.timer);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.timer = null;
    this.restartTimer = null;
  }

  /** Called after the user fixes something and presses Start/Restart. */
  reset(): void {
    this.gaveUp = false;
    this.restartAttempts = [];
    this.consecutiveFailures = 0;
    this.memoryStrikes = 0;
    this.downSince = null;
    // Historical evidence is deliberately retained; reset only re-enables automatic recovery.
  }

  /** One health check round; exposed for tests and "Check now". */
  async check(): Promise<void> {
    if (this.stopped || this.gaveUp || this.sup.status !== "running") return;
    const pid = this.sup.pid;
    const target = this.probeTarget();
    const probePromise = this.probe(target.path);
    const memoryPromise = this.deps.memoryOf && pid ? this.deps.memoryOf(pid).catch(() => null) : Promise.resolve(null);
    let [raw, memory] = await Promise.all([probePromise, memoryPromise]);
    if (memory !== null) this.lastMemoryBytes = memory;

    let path = target.path;
    let kind: "health" | "liveness" = target.kind;
    if (target.validation) {
      const candidateRecord: ProbeRecord = {
        ...raw,
        ok: raw.ok && raw.status !== null && healthyHttpStatus("health", raw.status),
        at: this.now,
        url: this.url(path),
      };
      this.candidateValidation = candidateRecord;
      if (candidateRecord.ok) {
        this.health.endpoint = { path, source: "detected", validated: true };
        this.health.rejection = null;
        this.emit("event", {
          kind: "health_validated",
          appName: this.cfg.appName,
          message: `Nexus validated ${path} as ${this.cfg.appName}'s health endpoint.`,
          diagnostics: this.diagnostics(),
        });
      } else {
        // A candidate is only a hypothesis. If the general endpoint answers, runtime reality wins
        // and this candidate is persisted as rejected instead of triggering a restart loop.
        const fallback = path === "/" ? raw : await this.probe("/");
        if (fallback.ok && fallback.status !== null) {
          const reason = raw.status !== null
            ? `Detected candidate returned HTTP ${raw.status}; general HTTP monitoring is responding.`
            : `Detected candidate could not be reached (${raw.failure ?? raw.error ?? "request failed"}); general HTTP monitoring is responding.`;
          this.health.endpoint = null;
          this.health.rejection = { path, status: raw.status, reason, at: new Date(this.now).toISOString() };
          this.emit("event", {
            kind: "health_candidate_rejected",
            appName: this.cfg.appName,
            message: `${this.cfg.appName} is responding. Nexus rejected the detected ${path} candidate and switched to general HTTP monitoring.`,
            diagnostics: this.diagnostics(),
          });
        }
        raw = fallback;
        path = "/";
        kind = "liveness";
      }
    }

    // The process can exit (or be replaced by an already-scheduled restart) while fetch is in
    // flight. Its socket then looks like ECONNRESET/ECONNREFUSED, but the exit event is the real
    // cause. Socket teardown can reach fetch a tick before ChildProcess emits exit, so give that
    // event a brief chance to settle before classifying the probe.
    if (!raw.ok) await new Promise((resolve) => setTimeout(resolve, 10));
    if (this.sup.status !== "running" || this.sup.pid !== pid) return;

    const healthy = raw.ok && raw.status !== null && healthyHttpStatus(kind, raw.status);
    const failure = healthy ? undefined : raw.failure ?? (raw.status !== null ? "http_error" : this.inferProbeFailure(raw.error));
    const record: ProbeRecord = { ...raw, ok: healthy, ...(failure ? { failure } : {}), at: this.now, url: this.url(path) };
    this.lastProbe = { ...record };
    this.emit("probe", this.lastProbe);
    if (healthy) {
      this.lastSuccessfulProbe = record;
      this.consecutiveFailures = 0;
    } else {
      this.failedProbes.push(record);
      if (this.failedProbes.length > EVIDENCE_LIMIT) this.failedProbes.shift();
      this.consecutiveFailures++;
      if (this.downSince === null) this.downSince = this.now;
    }

    // Resource enforcement wins when the same round also has an HTTP failure. Otherwise a process
    // killed for sustained memory use is misleadingly reported as a generic HTTP timeout.
    if (this.cfg.memoryLimitBytes && memory !== null && memory > this.cfg.memoryLimitBytes) {
      if (++this.memoryStrikes >= 3) {
        this.memoryStrikes = 0;
        if (this.downSince === null) this.downSince = this.now;
        const f: HealthFailure = {
          kind: "resource_exceeded",
          at: this.now,
          detail: `Process-tree memory was ${formatBytes(memory)}, above the ${formatBytes(this.cfg.memoryLimitBytes)} limit for 3 checks.`,
        };
        this.lastFailure = f;
        this.emit("event", {
          kind: "memory_exceeded",
          appName: this.cfg.appName,
          message: `${this.cfg.appName} was using ${formatBytes(memory)}, above its ${formatBytes(this.cfg.memoryLimitBytes)} limit.`,
          failure: f,
          diagnostics: this.diagnostics(),
        });
        this.requestRestart(f);
        return;
      }
    } else {
      this.memoryStrikes = 0;
    }

    if (healthy) {
      if (this.downSince !== null) this.recovered();
      return;
    }
    if (this.consecutiveFailures >= (this.cfg.failureThreshold ?? 3)) {
      this.consecutiveFailures = 0;
      const f = this.probeFailure(record);
      this.lastFailure = f;
      this.emit("event", { kind: "unhealthy", appName: this.cfg.appName, message: this.failureMessage(f), failure: f, diagnostics: this.diagnostics() });
      this.requestRestart(f);
    }
  }

  private probeTarget(): { path: string; kind: "health" | "liveness"; validation: boolean } {
    if (this.health.endpoint) return { path: this.health.endpoint.path, kind: "health", validation: false };
    const candidate = this.health.candidate;
    const rejected = candidate && this.health.rejection?.path === candidate.path;
    if (this.health.mode === "automatic" && candidate && !rejected) return { path: candidate.path, kind: "health", validation: true };
    return { path: "/", kind: "liveness", validation: false };
  }

  private url(path: string): string {
    return `http://127.0.0.1:${this.sup.port}${path}`;
  }

  private probe(path: string): Promise<ProbeResult> {
    return (this.deps.probe ?? httpProber)(this.url(path), this.cfg.timeoutMs ?? 5000).catch((e) => ({
      ok: false,
      status: null,
      ms: 0,
      ...networkFailure(e),
    }));
  }

  private onCrash(exit: ExitInfo): void {
    if (this.stopped) return;
    if (this.downSince === null) this.downSince = this.now;
    const value = exit.code ?? exit.signal ?? "unknown";
    const f: HealthFailure = { kind: "process_crashed", at: exit.at, detail: `The process exited unexpectedly (exit ${value}).` };
    this.lastFailure = f;
    this.emit("event", { kind: "process_crashed", appName: this.cfg.appName, message: `${this.cfg.appName} crashed (exit ${value}).`, failure: f, diagnostics: this.diagnostics() });
    this.requestRestart(f);
  }

  private requestRestart(failure: HealthFailure): void {
    if (this.gaveUp || this.restartTimer) return;
    this.captureLogs();
    const t = this.now;
    this.restartAttempts = this.restartAttempts.filter((x) => t - x < this.policy.windowMs);
    if (this.restartAttempts.length >= this.policy.maxRestarts) {
      void this.giveUp(failure);
      return;
    }
    const delay = this.policy.backoffMs[Math.min(this.restartAttempts.length, this.policy.backoffMs.length - 1)] ?? 1000;
    this.restartAttempts.push(t);
    const history: RestartRecord = { at: t, failure: failure.kind, detail: failure.detail, pidBefore: this.sup.pid };
    this.restartHistory.push(history);
    if (this.restartHistory.length > RESTART_HISTORY_LIMIT) this.restartHistory.shift();
    this.emit("event", {
      kind: "restarting",
      appName: this.cfg.appName,
      message: `${this.failureMessage(failure)} Nexus is restarting it.`,
      failure,
      diagnostics: this.diagnostics(),
    });
    this.restartTimer = setTimeout(async () => {
      this.restartTimer = null;
      if (this.stopped) return;
      const status = await this.sup.restart();
      history.completedAt = this.now;
      history.outcome = status;
      history.pidAfter = this.sup.pid;
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
      diagnostics: this.diagnostics(),
    });
  }

  private async giveUp(failure: HealthFailure): Promise<void> {
    if (this.gaveUp) return;
    this.gaveUp = true;
    const [database, logs] = await Promise.all([
      this.deps.database?.().catch((e) => `check failed: ${(e as Error).message}`) ?? Promise.resolve(null),
      Promise.resolve(this.deps.logs?.() ?? { stdout: [], stderr: [] }),
    ]);
    this.mergeLogs(logs);
    const diagnostics = this.diagnostics();
    const summary = `${this.cfg.appName} failed again after Nexus restarted it ${this.policy.maxRestarts} times in ${formatDuration(this.policy.windowMs)}. Nexus stopped restarting it so the underlying problem can be fixed.`;
    const detail = this.formatDiagnostics(summary, failure, diagnostics, this.capturedLogs, database);

    // An unresponsive HTTP process is valuable live evidence. Keep it available for inspection and
    // let a manual Restart replace it. A process over its resource limit must be stopped for safety.
    if (failure.kind === "resource_exceeded" && this.sup.pid !== null) await this.sup.stop();
    this.sup.flag("needs_attention", detail);
    this.emit("event", { kind: "gave_up", appName: this.cfg.appName, message: summary, failure, detail, diagnostics });
  }

  private formatDiagnostics(summary: string, failure: HealthFailure, d: HealthDiagnostics, logs: ApplicationLogTail, database: string | null): string {
    const lines = [summary, "", `Failure: ${this.failureLabel(failure.kind)}`, `Reason: ${failure.detail}`];
    lines.push(`Health monitoring: ${d.monitoring.mode === "custom" ? "custom endpoint" : d.monitoring.endpoint ? "validated endpoint" : "automatic HTTP liveness"}`);
    lines.push(`Health endpoint: ${d.monitoring.endpoint ? `http://127.0.0.1:${this.sup.port}${d.monitoring.endpoint.path} (${d.monitoring.endpoint.source})` : "none; probing / for an HTTP response"}`);
    if (d.candidateValidation) lines.push(`Detected candidate: ${d.candidateValidation.url} -> ${this.probeDescription(d.candidateValidation)}`);
    if (d.monitoring.rejection) lines.push(`Candidate rejected: ${d.monitoring.rejection.reason}`);
    lines.push(`Last successful health check: ${d.lastSuccessfulProbe ? `${new Date(d.lastSuccessfulProbe.at).toISOString()} (${d.lastSuccessfulProbe.ms} ms, HTTP ${d.lastSuccessfulProbe.status})` : "none recorded"}`);
    lines.push("Last failed checks:");
    if (!d.failedProbes.length) lines.push("  none (the process exited before an HTTP failure was recorded)");
    for (const p of d.failedProbes.slice(-5)) lines.push(`  ${new Date(p.at).toISOString()} ${this.probeDescription(p)}`);
    lines.push("", "Process:");
    lines.push(`  PID: ${d.process.pid ?? "none"}`);
    lines.push(`  still running: ${d.process.running ? "yes" : "no"}`);
    lines.push(`  supervisor status: ${d.process.status}`);
    lines.push(`  memory: ${d.process.memoryBytes === null ? "not available" : formatBytes(d.process.memoryBytes)}`);
    lines.push(`  uptime: ${d.process.uptimeMs === null ? "not running" : formatDuration(d.process.uptimeMs)}`);
    if (d.process.lastExit) lines.push(`  last exit: ${d.process.lastExit.code ?? d.process.lastExit.signal ?? "unknown"} at ${new Date(d.process.lastExit.at).toISOString()}`);
    lines.push("", `Database connectivity: ${database ?? "not configured or not checked"}`);
    lines.push("", "Restart history:");
    if (!d.restartHistory.length) lines.push("  no automatic restarts");
    for (const r of d.restartHistory.slice(-10)) lines.push(`  ${new Date(r.at).toISOString()} ${this.failureLabel(r.failure)}; PID ${r.pidBefore ?? "none"} -> ${r.pidAfter ?? "pending"}; ${r.outcome ?? "scheduled"}`);
    const legacy = this.deps.explain?.();
    if (legacy && !logs.stderr.length) logs.stderr.push(legacy);
    for (const [label, entries] of [["Last application stderr", logs.stderr], ["Last application stdout", logs.stdout], ["Last Nexus process messages", logs.system ?? []]] as const) {
      lines.push("", `${label}:`);
      if (!entries.length) lines.push("  none captured");
      else for (const line of entries.slice(-10)) lines.push(`  ${line}`);
    }
    return lines.join("\n");
  }

  private inferProbeFailure(error?: string): ProbeFailureKind {
    return networkFailure(new Error(error ?? "health request failed")).failure;
  }

  private captureLogs(): void {
    const latest = this.deps.logs?.();
    if (latest) this.mergeLogs(latest);
  }

  private mergeLogs(latest: ApplicationLogTail): void {
    for (const stream of ["stdout", "stderr", "system"] as const) {
      const target = this.capturedLogs[stream] ?? (this.capturedLogs[stream] = []);
      for (const line of latest[stream] ?? []) if (!target.includes(line)) target.push(line);
      if (target.length > 30) target.splice(0, target.length - 30);
    }
  }

  private probeFailure(p: ProbeRecord): HealthFailure {
    const kind: HealthFailureKind =
      p.failure === "timeout" ? "http_timeout" :
      p.failure === "connection_refused" ? "connection_refused" :
      p.failure === "connection_reset" ? "connection_reset" :
      p.failure === "http_error" || p.status !== null ? "http_error" : "network_error";
    return { kind, at: p.at, detail: this.probeDescription(p) };
  }

  private probeDescription(p: ProbeResult): string {
    if (p.status !== null) return `HTTP ${p.status} after ${p.ms} ms`;
    if (p.failure === "timeout") return `timeout after ${p.ms} ms`;
    return `${p.error ?? p.failure ?? "request failed"} after ${p.ms} ms`;
  }

  private failureLabel(kind: HealthFailureKind): string {
    return {
      process_crashed: "process crashed",
      http_timeout: "HTTP health check timed out",
      http_error: "health endpoint returned an error",
      connection_refused: "assigned port refused the connection",
      connection_reset: "HTTP connection was reset",
      network_error: "HTTP health check failed",
      resource_exceeded: "resource limit exceeded",
    }[kind];
  }

  private failureMessage(failure: HealthFailure): string {
    const name = this.cfg.appName;
    return {
      process_crashed: `${name} crashed.`,
      http_timeout: `${name} is still running, but its health check timed out.`,
      http_error: `${name} is running, but its health endpoint returned an error.`,
      connection_refused: `${name} is running, but nothing is accepting connections on its assigned port.`,
      connection_reset: `${name} is running, but it reset the health-check connection.`,
      network_error: `${name} is running, but its health check could not complete.`,
      resource_exceeded: `${name} exceeded its configured resource limit.`,
    }[failure.kind];
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(async () => {
      this.timer = null;
      try {
        await this.check();
      } finally {
        this.schedule();
      }
    }, this.cfg.intervalMs ?? 15_000);
    this.timer.unref?.();
  }
}
