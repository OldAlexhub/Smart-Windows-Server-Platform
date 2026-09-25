import { createHash } from "node:crypto";
import { globSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { silentLogger, type Logger } from "@nexus/shared";
import type { Migration, StateStore } from "@nexus/state";
import { canonical, type Schedule } from "./definition";
import { PipelineDependencyGraph } from "./dependencies";
import { previousCronSlot } from "./cron";
import type { PipelineRecord, PipelineStore } from "./store";
import type { RunStatus, RunTrigger } from "./runs";

export const schedulerMigrations: Migration[] = [
  {
    id: "pipelines/004_scheduler",
    up: `CREATE TABLE pipeline_schedule_state (
      pipeline_id TEXT PRIMARY KEY,
      schedule_key TEXT NOT NULL,
      pipeline_updated_at TEXT NOT NULL,
      last_slot TEXT NOT NULL,
      file_state TEXT NOT NULL,
      upstream_state TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`,
  },
];

interface FileStamp {
  size: number;
  mtimeMs: number;
  changedAt: string;
  emitted: string | null;
}
interface FileInfo {
  path: string;
  size: number;
  mtimeMs: number;
}
export type UpstreamStatus = Exclude<RunStatus, "running"> | "blocked";
export interface UpstreamEvent {
  pipelineId: string;
  runId: string;
  status: UpstreamStatus;
  at: string;
  message?: string;
}
interface DependencyBlock {
  key: string;
  at: string;
  message: string;
  upstream: UpstreamEvent[];
}
interface UpstreamState {
  pending: Record<string, UpstreamEvent>;
  seen: string[];
  blocked: DependencyBlock | null;
}
interface ScheduleState {
  pipelineId: string;
  scheduleKey: string;
  pipelineUpdatedAt: string;
  lastSlot: string;
  files: Record<string, FileStamp>;
  upstream: UpstreamState;
  updatedAt: string;
}

export interface ScheduledRun {
  trigger: Extract<RunTrigger, "schedule" | "file" | "upstream">;
  /** The scheduled slot, file-ready time, or last upstream completion. */
  logicalTime: string;
  files?: string[];
  upstream?: UpstreamEvent[];
}

export interface DependencyStatus {
  state: "not-dependent" | "waiting" | "ready" | "blocked";
  waitingFor: { id: string; name: string }[];
  blockedBy: UpstreamEvent[];
  message: string | null;
}

export interface PipelineSchedulerOptions {
  store: StateStore;
  pipelines: Pick<PipelineStore, "list">;
  /** Resolve after the engine has accepted and persisted the run (not after the whole pipeline finishes). */
  run(pipeline: PipelineRecord, request: ScheduledRun): void | Promise<void>;
  isRunning?(pipelineId: string): boolean;
  now?: () => Date;
  scanFiles?: (pattern: string) => FileInfo[];
  checkFilePath?: (pattern: string) => void;
  logger?: Logger;
  tickMs?: number;
}

interface StateRow {
  pipeline_id: string;
  schedule_key: string;
  pipeline_updated_at: string;
  last_slot: string;
  file_state: string;
  upstream_state: string;
  updated_at: string;
}

const DAY: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const fingerprint = (f: Pick<FileInfo, "size" | "mtimeMs">) => `${f.size}:${Math.trunc(f.mtimeMs)}`;

function defaultScan(pattern: string): FileInfo[] {
  const normalized = resolve(pattern).replace(/\\/g, "/");
  const out: FileInfo[] = [];
  for (const path of globSync(normalized)) {
    try {
      const s = statSync(path);
      if (s.isFile()) out.push({ path: resolve(path), size: s.size, mtimeMs: s.mtimeMs });
    } catch {
      /* a file can disappear between the directory scan and stat */
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

/** Latest calendar slot at or before now, using the server's local time. */
export function previousCalendarSlot(schedule: Schedule, now: Date, after?: Date): Date | null {
  const floor = after?.getTime() ?? -Infinity;
  if (schedule.type === "daily") {
    const [hour, minute] = schedule.at.split(":").map(Number) as [number, number];
    for (let back = 0; back < 8; back++) {
      const d = new Date(now);
      d.setDate(d.getDate() - back);
      d.setHours(hour, minute, 0, 0);
      if (d > now || d.getTime() <= floor) continue;
      if (!schedule.days?.length || schedule.days.some((x) => DAY[x] === d.getDay())) return d;
    }
    return null;
  }
  if (schedule.type === "weekly") {
    const [hour, minute] = schedule.at.split(":").map(Number) as [number, number];
    const d = new Date(now);
    d.setDate(d.getDate() - ((d.getDay() - DAY[schedule.day]! + 7) % 7));
    d.setHours(hour, minute, 0, 0);
    if (d > now) d.setDate(d.getDate() - 7);
    return d.getTime() > floor ? d : null;
  }
  if (schedule.type === "monthly") {
    const [hour, minute] = schedule.at.split(":").map(Number) as [number, number];
    for (let back = 0; back < 14; back++) {
      const base = new Date(now.getFullYear(), now.getMonth() - back, 1, hour, minute, 0, 0);
      const max = daysInMonth(base.getFullYear(), base.getMonth());
      if (schedule.day !== "last" && schedule.day > max) continue;
      base.setDate(schedule.day === "last" ? max : schedule.day);
      if (base <= now && base.getTime() > floor) return base;
    }
    return null;
  }
  if (schedule.type === "cron") return previousCronSlot(schedule.expression, now, after);
  return null;
}

export class PipelineScheduler {
  private readonly now: () => Date;
  private readonly scan: (pattern: string) => FileInfo[];
  private readonly log: Logger;
  private readonly active = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<void> | null = null;

  constructor(private readonly opts: PipelineSchedulerOptions) {
    opts.store.migrate(schedulerMigrations);
    this.now = opts.now ?? (() => new Date());
    this.scan = opts.scanFiles ?? defaultScan;
    this.log = opts.logger ?? silentLogger;
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), Math.max(1_000, this.opts.tickMs ?? 30_000));
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Checks every enabled pipeline once. Concurrent calls share the same tick. */
  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.doTick().finally(() => (this.ticking = null));
    return this.ticking;
  }

  private async doTick(): Promise<void> {
    const now = this.now();
    const pipelines = this.opts.pipelines.list();
    const graph = new PipelineDependencyGraph(pipelines);
    const known = new Set(pipelines.map((p) => p.id));
    for (const row of this.opts.store.all<{ pipeline_id: string }>("SELECT pipeline_id FROM pipeline_schedule_state")) {
      const pipeline = pipelines.find((p) => p.id === row.pipeline_id);
      // Disabling resets the baseline: turning it on later must not replay work intentionally missed.
      if (!known.has(row.pipeline_id) || !pipeline?.enabled)
        this.opts.store.run("DELETE FROM pipeline_schedule_state WHERE pipeline_id = ?", [row.pipeline_id]);
    }
    for (const pipeline of pipelines.filter((p) => p.enabled)) {
      try {
        const state = this.ensureState(pipeline, now);
        const schedule = pipeline.definition.schedule;
        if (schedule.type === "manual") continue;
        if (schedule.type === "file") await this.fileTick(pipeline, state, schedule, now);
        else if (schedule.type === "after") {
          const blocked = await this.upstreamTick(pipeline, state, schedule, graph);
          if (blocked) await this.deliverOutcome(blocked, graph);
        } else await this.timeTick(pipeline, state, schedule, now);
      } catch (e) {
        this.log.error("pipeline scheduler tick failed", { pipelineId: pipeline.id, err: e as Error });
      }
    }
  }

  private async timeTick(
    p: PipelineRecord,
    state: ScheduleState,
    schedule: Exclude<Schedule, { type: "manual" | "file" | "after" }>,
    now: Date,
  ): Promise<void> {
    const last = new Date(state.lastSlot);
    let slot: Date | null = null;
    if (schedule.type === "interval") {
      const every = schedule.minutes * 60_000;
      const periods = Math.floor((now.getTime() - last.getTime()) / every);
      if (periods > 0) slot = new Date(last.getTime() + periods * every);
    } else {
      slot = previousCalendarSlot(schedule, now, last);
    }
    if (!slot || !(await this.trigger(p, { trigger: "schedule", logicalTime: slot.toISOString() }))) return;
    state.lastSlot = slot.toISOString();
    this.save(state, now);
  }

  private async fileTick(
    p: PipelineRecord,
    state: ScheduleState,
    schedule: Extract<Schedule, { type: "file" }>,
    now: Date,
  ): Promise<void> {
    this.opts.checkFilePath?.(schedule.path);
    const current = this.scan(schedule.path);
    const next: Record<string, FileStamp> = {};
    const ready: string[] = [];
    for (const file of current) {
      const stamp = fingerprint(file);
      const before = state.files[file.path];
      const changedAt = !before || fingerprint(before) !== stamp ? now.toISOString() : before.changedAt;
      const emitted = !before || fingerprint(before) !== stamp ? null : before.emitted;
      const settled = now.getTime() - Date.parse(changedAt) >= schedule.settleSeconds * 1000;
      if (settled && emitted !== stamp) ready.push(file.path);
      next[file.path] = { size: file.size, mtimeMs: file.mtimeMs, changedAt, emitted };
    }
    state.files = next;
    if (ready.length && (await this.trigger(p, { trigger: "file", logicalTime: now.toISOString(), files: ready }))) {
      for (const path of ready) state.files[path]!.emitted = fingerprint(state.files[path]!);
      state.lastSlot = now.toISOString();
    }
    this.save(state, now);
  }

  /** Records an engine completion for pipelines using an "after" schedule. Safe to call twice. */
  async pipelineFinished(event: {
    pipelineId: string;
    runId: string;
    status: Exclude<RunStatus, "running">;
    at?: string;
  }): Promise<void> {
    const now = this.now();
    const graph = new PipelineDependencyGraph(this.opts.pipelines.list());
    if (!graph.get(event.pipelineId)) return;
    await this.deliverOutcome(
      { pipelineId: event.pipelineId, runId: event.runId, status: event.status, at: event.at ?? now.toISOString() },
      graph,
    );
  }

  /** Current dependency state for the UI/API, including failures that prevented a run. */
  dependencyStatus(pipelineId: string): DependencyStatus {
    const graph = new PipelineDependencyGraph(this.opts.pipelines.list());
    const pipeline = graph.get(pipelineId);
    if (!pipeline || pipeline.definition.schedule.type !== "after")
      return { state: "not-dependent", waitingFor: [], blockedBy: [], message: null };
    const problems = graph.problems(pipelineId);
    if (problems.length)
      return {
        state: "blocked",
        waitingFor: [],
        blockedBy: [],
        message: problems.map((problem) => problem.message).join(" "),
      };
    const state = this.load(pipelineId);
    const schedule = pipeline.definition.schedule;
    const dependencies = graph.dependencies(pipelineId);
    const waitingFor = dependencies
      .filter((dependency) => !state?.upstream.pending[dependency.pipeline.id])
      .map((dependency) => ({ id: dependency.pipeline.id, name: dependency.pipeline.name }));
    const events = dependencies.flatMap((dependency) => state?.upstream.pending[dependency.pipeline.id] ?? []);
    const blockedBy = events.filter(
      (event) => event.status === "blocked" || (schedule.when === "success" && event.status !== "succeeded"),
    );
    if (state?.upstream.blocked || blockedBy.length) {
      return {
        state: "blocked",
        waitingFor,
        blockedBy: state?.upstream.blocked?.upstream ?? blockedBy,
        message: state?.upstream.blocked?.message ?? "An upstream pipeline did not succeed.",
      };
    }
    return { state: waitingFor.length ? "waiting" : "ready", waitingFor, blockedBy: [], message: null };
  }

  private async deliverOutcome(
    event: UpstreamEvent,
    graph: PipelineDependencyGraph,
    path = new Set<string>(),
  ): Promise<void> {
    if (path.has(event.pipelineId)) return;
    const nextPath = new Set(path).add(event.pipelineId);
    for (const target of graph.directDownstream(event.pipelineId).filter((pipeline) => pipeline.enabled)) {
      const schedule = target.definition.schedule as Extract<Schedule, { type: "after" }>;
      const state = this.ensureState(target, this.now());
      if (state.upstream.seen.includes(event.runId)) continue;
      state.upstream.pending[event.pipelineId] = event;
      state.upstream.seen = [...state.upstream.seen, event.runId].slice(-200);
      this.save(state, this.now());
      const blocked = await this.upstreamTick(target, state, schedule, graph);
      if (blocked) await this.deliverOutcome(blocked, graph, nextPath);
    }
  }

  private async upstreamTick(
    p: PipelineRecord,
    state: ScheduleState,
    schedule: Extract<Schedule, { type: "after" }>,
    graph: PipelineDependencyGraph,
  ): Promise<UpstreamEvent | null> {
    const problems = graph.problems(p.id);
    if (problems.length) return this.block(p, state, problems.map((problem) => problem.message).join(" "), []);
    const dependencies = graph.dependencies(p.id);
    const events = dependencies
      .map((dependency) => state.upstream.pending[dependency.pipeline.id])
      .filter((event): event is UpstreamEvent => !!event);
    const failures = events.filter(
      (event) => event.status === "blocked" || (schedule.when === "success" && event.status !== "succeeded"),
    );
    if (failures.length)
      return this.block(
        p,
        state,
        failures
          .map(
            (event) => event.message ?? `"${graph.get(event.pipelineId)?.name ?? event.pipelineId}" did not succeed.`,
          )
          .join(" "),
        failures,
      );
    if (state.upstream.blocked) {
      state.upstream.blocked = null;
      this.save(state, this.now());
    }
    if (events.length !== dependencies.length) return null;
    const logicalTime = events
      .map((e) => e.at)
      .sort()
      .at(-1)!;
    if (!(await this.trigger(p, { trigger: "upstream", logicalTime, upstream: events }))) return null;
    state.upstream.pending = {};
    state.lastSlot = logicalTime;
    this.save(state, this.now());
    return null;
  }

  private block(
    p: PipelineRecord,
    state: ScheduleState,
    message: string,
    upstream: UpstreamEvent[],
  ): UpstreamEvent | null {
    const key = createHash("sha256")
      .update(canonical({ message, runs: upstream.map((event) => event.runId).sort() }))
      .digest("hex")
      .slice(0, 24);
    const at =
      state.upstream.blocked?.key === key
        ? state.upstream.blocked.at
        : (upstream
            .map((event) => event.at)
            .sort()
            .at(-1) ?? this.now().toISOString());
    if (state.upstream.blocked?.key !== key) {
      state.upstream.blocked = { key, at, message, upstream };
      this.save(state, this.now());
    }
    // Re-offer the stable outcome on every tick. Downstreams deduplicate it, while a newly
    // enabled or edited downstream still learns that its upstream remains blocked.
    return {
      pipelineId: p.id,
      runId: `blocked:${p.id}:${key}`,
      status: "blocked",
      at,
      message: `"${p.name}" was blocked: ${message}`,
    };
  }

  private async trigger(p: PipelineRecord, request: ScheduledRun): Promise<boolean> {
    if (this.active.has(p.id) || this.opts.isRunning?.(p.id)) return false;
    this.active.add(p.id);
    try {
      await this.opts.run(p, request);
      return true;
    } catch (e) {
      this.log.error("scheduled pipeline could not start", {
        pipelineId: p.id,
        trigger: request.trigger,
        err: e as Error,
      });
      return false;
    } finally {
      this.active.delete(p.id);
    }
  }

  private ensureState(p: PipelineRecord, now: Date): ScheduleState {
    const key = canonical(p.definition.schedule);
    const old = this.load(p.id);
    if (old && old.scheduleKey === key && old.pipelineUpdatedAt === p.updatedAt) return old;
    const files: Record<string, FileStamp> = {};
    if (p.definition.schedule.type === "file") {
      this.opts.checkFilePath?.(p.definition.schedule.path);
      for (const f of this.scan(p.definition.schedule.path)) {
        const stamp = fingerprint(f);
        files[f.path] = { size: f.size, mtimeMs: f.mtimeMs, changedAt: now.toISOString(), emitted: stamp };
      }
    }
    const fresh: ScheduleState = {
      pipelineId: p.id,
      scheduleKey: key,
      pipelineUpdatedAt: p.updatedAt,
      lastSlot: now.toISOString(),
      files,
      upstream: { pending: {}, seen: [], blocked: null },
      updatedAt: now.toISOString(),
    };
    this.save(fresh, now);
    return fresh;
  }

  private load(pipelineId: string): ScheduleState | null {
    const r = this.opts.store.get<StateRow>("SELECT * FROM pipeline_schedule_state WHERE pipeline_id = ?", [
      pipelineId,
    ]);
    if (!r) return null;
    const upstream = JSON.parse(r.upstream_state) as Partial<UpstreamState>;
    return {
      pipelineId: r.pipeline_id,
      scheduleKey: r.schedule_key,
      pipelineUpdatedAt: r.pipeline_updated_at,
      lastSlot: r.last_slot,
      files: JSON.parse(r.file_state) as Record<string, FileStamp>,
      upstream: { pending: upstream.pending ?? {}, seen: upstream.seen ?? [], blocked: upstream.blocked ?? null },
      updatedAt: r.updated_at,
    };
  }

  private save(state: ScheduleState, now: Date): void {
    state.updatedAt = now.toISOString();
    this.opts.store.run(
      `INSERT INTO pipeline_schedule_state (pipeline_id, schedule_key, pipeline_updated_at, last_slot, file_state, upstream_state, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(pipeline_id) DO UPDATE SET schedule_key = excluded.schedule_key, pipeline_updated_at = excluded.pipeline_updated_at,
         last_slot = excluded.last_slot, file_state = excluded.file_state, upstream_state = excluded.upstream_state, updated_at = excluded.updated_at`,
      [
        state.pipelineId,
        state.scheduleKey,
        state.pipelineUpdatedAt,
        state.lastSlot,
        JSON.stringify(state.files),
        JSON.stringify(state.upstream),
        state.updatedAt,
      ],
    );
  }
}
