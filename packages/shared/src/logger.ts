/** Minimal structured logger: JSON records, levels, child bindings, pluggable sinks. */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogRecord {
  time: string;
  level: LogLevel;
  msg: string;
  [key: string]: unknown;
}

export type LogSink = (record: LogRecord) => void;

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  sinks?: LogSink[];
  bindings?: Record<string, unknown>;
}

export const consoleSink: LogSink = (r) => {
  const line = JSON.stringify(r);
  if (r.level === "error" || r.level === "warn") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
};

export function createLogger(options: LoggerOptions = {}): Logger {
  const min = LEVEL_ORDER[options.level ?? "info"];
  const sinks = options.sinks ?? [consoleSink];
  const bindings = options.bindings ?? {};

  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (LEVEL_ORDER[level] < min) return;
    const record: LogRecord = { time: new Date().toISOString(), level, msg, ...bindings, ...serialize(fields) };
    for (const sink of sinks) sink(record);
  };

  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (extra) => createLogger({ ...options, bindings: { ...bindings, ...extra } }),
  };
}

function serialize(fields?: Record<string, unknown>): Record<string, unknown> {
  if (!fields) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v;
  }
  return out;
}

/** Logger that discards everything; useful for tests. */
export const silentLogger: Logger = createLogger({ sinks: [] });

/** Sink that keeps records in memory; useful for tests. */
export function memorySink(): LogSink & { records: LogRecord[] } {
  const records: LogRecord[] = [];
  const sink = ((r: LogRecord) => void records.push(r)) as LogSink & { records: LogRecord[] };
  sink.records = records;
  return sink;
}
