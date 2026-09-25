import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Migration, StateStore } from "@nexus/state";
import { classifyLine, isContinuation, Redactor, type EntryLevel } from "./classify";

export const logMigrations: Migration[] = [
  {
    id: "logs/001_counts",
    up: `CREATE TABLE log_counts (
      source TEXT NOT NULL,
      day TEXT NOT NULL,
      errors INTEGER NOT NULL DEFAULT 0,
      warnings INTEGER NOT NULL DEFAULT 0,
      info INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (source, day)
    )`,
  },
];

export type LogStreamName = "stdout" | "stderr" | "system";

export interface LogEntry {
  /** ISO timestamp. */
  t: string;
  source: string;
  stream: LogStreamName;
  level: EntryLevel;
  /** May span several lines (stack traces are kept together). */
  message: string;
}

export interface LogQuery {
  text?: string;
  level?: EntryLevel | "problems"; // "problems" = errors + warnings
  since?: string;
  until?: string;
  limit?: number;
}

export interface LogCounts {
  errors: number;
  warnings: number;
  info: number;
}

interface Pending {
  entry: LogEntry;
  lastLine: string;
  timer: NodeJS.Timeout | null;
}

export type LogListener = (entry: LogEntry) => void;

/**
 * Central log collection for apps, pipelines and Nexus itself.
 *  - groups multi-line stack traces into one entry
 *  - classifies error / warning / normal activity
 *  - redacts credentials before anything is stored
 *  - stores JSONL per source per day, keeps a live in-memory tail, counts per day
 */
export class LogManager {
  private readonly tails = new Map<string, LogEntry[]>();
  private readonly pending = new Map<string, Pending>();
  private readonly counts = new Map<string, LogCounts>(); // key: source|day (unflushed deltas)
  private readonly redactors = new Map<string, Redactor>();
  private readonly listeners = new Set<LogListener>();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: StateStore,
    private readonly root: string,
    private readonly opts: { tailSize?: number; groupWindowMs?: number; now?: () => Date } = {},
  ) {
    store.migrate(logMigrations);
    mkdirSync(root, { recursive: true });
  }

  private get now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  /** Values (passwords, tokens) that must never appear in this source's logs. */
  redactor(source: string): Redactor {
    let r = this.redactors.get(source);
    if (!r) this.redactors.set(source, (r = new Redactor()));
    return r;
  }

  subscribe(listener: LogListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Feed one raw output line. */
  write(source: string, stream: LogStreamName, rawLine: string): void {
    const line = this.redactor(source).redact(rawLine.replace(/\x1b\[[0-9;]*m/g, "")); // strip ANSI colours
    if (!line.trim()) return;
    const p = this.pending.get(source);
    if (p && stream === p.entry.stream && isContinuation(line, p.lastLine)) {
      p.entry.message += `\n${line}`;
      p.lastLine = line;
      if (p.entry.level !== "error" && classifyLine(line) === "error") p.entry.level = "error";
      this.armTimer(source, p);
      return;
    }
    if (p) this.commit(source);
    const entry: LogEntry = { t: this.now.toISOString(), source, stream, level: classifyLine(line), message: line };
    if (/^Traceback \(most recent call last\)/.test(line)) entry.level = "error";
    const np: Pending = { entry, lastLine: line, timer: null };
    this.pending.set(source, np);
    this.armTimer(source, np);
  }

  /** Force pending multi-line entries out (used by tests and on shutdown). */
  flush(): void {
    for (const s of [...this.pending.keys()]) this.commit(s);
    this.persistCounts();
  }

  tail(source: string, limit = 200): LogEntry[] {
    this.commitIfPending(source);
    const t = this.tails.get(source) ?? [];
    return t.slice(-limit);
  }

  /** Newest first. Scans the live tail then daily files, bounded by `limit`. */
  search(source: string, q: LogQuery = {}): LogEntry[] {
    this.commitIfPending(source);
    const limit = Math.min(q.limit ?? 200, 2000);
    const text = q.text?.toLowerCase();
    const match = (e: LogEntry) =>
      (!text || e.message.toLowerCase().includes(text)) &&
      (!q.level || (q.level === "problems" ? e.level !== "info" : e.level === q.level)) &&
      (!q.since || e.t >= q.since) &&
      (!q.until || e.t <= q.until);
    const out: LogEntry[] = [];
    const dir = join(this.root, safe(source));
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort().reverse() : [];
    for (const f of files) {
      if (q.since && f.slice(0, 10) < q.since.slice(0, 10)) break;
      const lines = readFileSync(join(dir, f), "utf8").split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i]) continue;
        const e = JSON.parse(lines[i]!) as LogEntry;
        if (match(e)) out.push(e);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  /** Errors / warnings / normal activity for a day (default: today). */
  countsFor(source: string, day = this.now.toISOString().slice(0, 10)): LogCounts {
    this.commitIfPending(source);
    this.persistCounts();
    const row = this.store.get<LogCounts>("SELECT errors, warnings, info FROM log_counts WHERE source = ? AND day = ?", [source, day]);
    return row ?? { errors: 0, warnings: 0, info: 0 };
  }

  /** Removes daily files older than `days`. */
  applyRetention(days = 14): number {
    const cutoff = new Date(this.now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
    let removed = 0;
    for (const src of readdirSync(this.root)) {
      const dir = join(this.root, src);
      for (const f of readdirSync(dir)) {
        if (f.endsWith(".jsonl") && f.slice(0, 10) < cutoff) {
          rmSync(join(dir, f));
          removed++;
        }
      }
    }
    this.store.run("DELETE FROM log_counts WHERE day < ?", [cutoff]);
    return removed;
  }

  dispose(): void {
    this.flush();
    if (this.flushTimer) clearTimeout(this.flushTimer);
  }

  private armTimer(source: string, p: Pending): void {
    if (p.timer) clearTimeout(p.timer);
    p.timer = setTimeout(() => this.commit(source), this.opts.groupWindowMs ?? 150);
    p.timer.unref();
  }

  private commitIfPending(source: string): void {
    if (this.pending.has(source)) this.commit(source);
  }

  private commit(source: string): void {
    const p = this.pending.get(source);
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    this.pending.delete(source);
    const e = p.entry;

    const tail = this.tails.get(source) ?? [];
    tail.push(e);
    if (tail.length > (this.opts.tailSize ?? 2000)) tail.splice(0, tail.length - (this.opts.tailSize ?? 2000));
    this.tails.set(source, tail);

    const dir = join(this.root, safe(source));
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `${e.t.slice(0, 10)}.jsonl`), JSON.stringify(e) + "\n");

    const key = `${source}|${e.t.slice(0, 10)}`;
    const c = this.counts.get(key) ?? { errors: 0, warnings: 0, info: 0 };
    if (e.level === "error") c.errors++;
    else if (e.level === "warning") c.warnings++;
    else c.info++;
    this.counts.set(key, c);
    this.scheduleCountFlush();

    for (const l of this.listeners) l(e);
  }

  private scheduleCountFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.persistCounts();
    }, 2000);
    this.flushTimer.unref();
  }

  private persistCounts(): void {
    if (this.counts.size === 0) return;
    this.store.transaction(() => {
      for (const [key, c] of this.counts) {
        const [source, day] = key.split("|") as [string, string];
        this.store.run(
          `INSERT INTO log_counts (source, day, errors, warnings, info) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(source, day) DO UPDATE SET errors = errors + excluded.errors,
             warnings = warnings + excluded.warnings, info = info + excluded.info`,
          [source, day, c.errors, c.warnings, c.info],
        );
      }
    });
    this.counts.clear();
  }
}

const safe = (source: string) => source.replace(/[^a-zA-Z0-9_.-]/g, "_");
