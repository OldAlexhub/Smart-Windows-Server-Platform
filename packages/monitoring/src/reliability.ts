import type { AppReliabilitySummary, AppStatus, DatabaseHealth, ReliabilityWindowSummary } from "@nexus/shared";
import type { Migration, StateStore } from "@nexus/state";

const MINUTE_MS = 60_000;
const RETENTION_MS = 32 * 86_400_000;

export const reliabilityMigrations: Migration[] = [
  {
    id: "monitoring/001_reliability",
    up: `CREATE TABLE reliability_app_minutes (
      app_id TEXT NOT NULL,
      minute_start INTEGER NOT NULL,
      sampled INTEGER NOT NULL DEFAULT 0,
      expected_up INTEGER NOT NULL DEFAULT 1,
      status TEXT,
      available INTEGER NOT NULL DEFAULT 0,
      cpu_percent REAL,
      memory_bytes INTEGER,
      database_health TEXT NOT NULL DEFAULT 'unknown',
      probe_count INTEGER NOT NULL DEFAULT 0,
      successful_probe_count INTEGER NOT NULL DEFAULT 0,
      response_ms_sum REAL NOT NULL DEFAULT 0,
      response_ms_max REAL,
      PRIMARY KEY (app_id, minute_start)
    );
    CREATE INDEX reliability_app_minutes_time ON reliability_app_minutes(minute_start);
    CREATE TABLE reliability_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      at INTEGER NOT NULL
    );
    CREATE INDEX reliability_events_app_time ON reliability_events(app_id, at);
    CREATE TABLE reliability_disk_minutes (
      mount TEXT NOT NULL,
      minute_start INTEGER NOT NULL,
      total_bytes INTEGER NOT NULL,
      used_bytes INTEGER NOT NULL,
      PRIMARY KEY (mount, minute_start)
    );
    CREATE INDEX reliability_disk_minutes_time ON reliability_disk_minutes(minute_start);`,
  },
];

export type ReliabilityEventKind = "crash" | "restart";

export interface AppReliabilitySample {
  appId: string;
  status: AppStatus;
  expectedUp: boolean;
  cpuPercent: number | null;
  memoryBytes: number | null;
  databaseHealth: DatabaseHealth;
  at?: number;
}

export interface DiskReliabilitySummary {
  mount: string;
  lastSampleAt: string;
  totalBytes: number;
  usedBytes: number;
  averageUsedBytes: number;
  peakUsedBytes: number;
}

interface AggregateRow {
  monitored_minutes: number;
  availability_checks: number;
  available_checks: number;
  average_cpu: number | null;
  peak_cpu: number | null;
  average_memory: number | null;
  peak_memory: number | null;
  response_sum: number;
  response_count: number;
  peak_response: number | null;
}

const minute = (at: number) => Math.floor(at / MINUTE_MS) * MINUTE_MS;
const rounded = (value: number | null, places = 1): number | null => {
  if (value === null || !Number.isFinite(value)) return null;
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
};

/**
 * Durable, bounded reliability history. Raw probes are rolled into one row per application/minute;
 * resource, database and disk observations use the same cadence and are retained for 32 days.
 */
export class ReliabilityRepository {
  constructor(private readonly store: StateStore) {
    store.migrate(reliabilityMigrations);
  }

  recordAppSample(sample: AppReliabilitySample): void {
    const at = minute(sample.at ?? Date.now());
    this.store.run(
      `INSERT INTO reliability_app_minutes
       (app_id, minute_start, sampled, expected_up, status, available, cpu_percent, memory_bytes, database_health)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(app_id, minute_start) DO UPDATE SET
         sampled = 1,
         expected_up = excluded.expected_up,
         status = excluded.status,
         available = excluded.available,
         cpu_percent = excluded.cpu_percent,
         memory_bytes = excluded.memory_bytes,
         database_health = excluded.database_health`,
      [
        sample.appId,
        at,
        sample.expectedUp ? 1 : 0,
        sample.status,
        sample.status === "running" ? 1 : 0,
        sample.cpuPercent,
        sample.memoryBytes,
        sample.databaseHealth,
      ],
    );
  }

  /** Every health check contributes to uptime and latency without creating a raw high-volume row. */
  recordProbe(appId: string, ok: boolean, responseMs: number, at = Date.now()): void {
    const bucket = minute(at);
    const ms = Math.max(0, responseMs);
    this.store.run(
      `INSERT INTO reliability_app_minutes
       (app_id, minute_start, probe_count, successful_probe_count, response_ms_sum, response_ms_max)
       VALUES (?, ?, 1, ?, ?, ?)
       ON CONFLICT(app_id, minute_start) DO UPDATE SET
         probe_count = probe_count + 1,
         successful_probe_count = successful_probe_count + excluded.successful_probe_count,
         response_ms_sum = response_ms_sum + excluded.response_ms_sum,
         response_ms_max = CASE
           WHEN response_ms_max IS NULL THEN excluded.response_ms_max
           ELSE MAX(response_ms_max, excluded.response_ms_max)
         END`,
      [appId, bucket, ok ? 1 : 0, ms, ms],
    );
  }

  recordEvent(appId: string, kind: ReliabilityEventKind, at = Date.now()): void {
    this.store.run("INSERT INTO reliability_events (app_id, kind, at) VALUES (?, ?, ?)", [appId, kind, at]);
  }

  recordDisk(mount: string, totalBytes: number, freeBytes: number, at = Date.now()): void {
    this.store.run(
      `INSERT INTO reliability_disk_minutes (mount, minute_start, total_bytes, used_bytes)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(mount, minute_start) DO UPDATE SET
         total_bytes = excluded.total_bytes,
         used_bytes = excluded.used_bytes`,
      [mount, minute(at), totalBytes, Math.max(0, totalBytes - freeBytes)],
    );
  }

  appSummary(appId: string, now = Date.now()): AppReliabilitySummary {
    const latest = this.store.get<{ minute_start: number; database_health: DatabaseHealth }>(
      `SELECT minute_start, database_health FROM reliability_app_minutes
       WHERE app_id = ? AND sampled = 1 ORDER BY minute_start DESC LIMIT 1`,
      [appId],
    );
    return {
      lastSampleAt: latest ? new Date(Number(latest.minute_start)).toISOString() : null,
      databaseHealth: latest?.database_health ?? "unknown",
      last7Days: this.window(appId, 7, now),
      last30Days: this.window(appId, 30, now),
    };
  }

  diskSummary(days: 7 | 30 = 30, now = Date.now()): DiskReliabilitySummary[] {
    const rows = this.store.all<{
      mount: string;
      last_at: number;
      average_used: number;
      peak_used: number;
    }>(
      `SELECT mount, MAX(minute_start) AS last_at, AVG(used_bytes) AS average_used,
              MAX(used_bytes) AS peak_used
       FROM reliability_disk_minutes WHERE minute_start >= ? GROUP BY mount ORDER BY mount`,
      [now - days * 86_400_000],
    );
    return rows.map((row) => {
      const latest = this.store.get<{ total_bytes: number; used_bytes: number }>(
        "SELECT total_bytes, used_bytes FROM reliability_disk_minutes WHERE mount = ? ORDER BY minute_start DESC LIMIT 1",
        [row.mount],
      )!;
      return {
        mount: row.mount,
        lastSampleAt: new Date(Number(row.last_at)).toISOString(),
        totalBytes: Number(latest.total_bytes),
        usedBytes: Number(latest.used_bytes),
        averageUsedBytes: Math.round(Number(row.average_used)),
        peakUsedBytes: Number(row.peak_used),
      };
    });
  }

  prune(now = Date.now()): void {
    const cutoff = now - RETENTION_MS;
    this.store.transaction(() => {
      this.store.run("DELETE FROM reliability_app_minutes WHERE minute_start < ?", [cutoff]);
      this.store.run("DELETE FROM reliability_events WHERE at < ?", [cutoff]);
      this.store.run("DELETE FROM reliability_disk_minutes WHERE minute_start < ?", [cutoff]);
    });
  }

  deleteApp(appId: string): void {
    this.store.transaction(() => {
      this.store.run("DELETE FROM reliability_app_minutes WHERE app_id = ?", [appId]);
      this.store.run("DELETE FROM reliability_events WHERE app_id = ?", [appId]);
    });
  }

  private window(appId: string, days: 7 | 30, now: number): ReliabilityWindowSummary {
    const since = now - days * 86_400_000;
    const row = this.store.get<AggregateRow>(
      `SELECT
         SUM(CASE WHEN expected_up = 1 AND (sampled = 1 OR probe_count > 0) THEN 1 ELSE 0 END) AS monitored_minutes,
         SUM(CASE WHEN expected_up = 1 THEN CASE WHEN probe_count > 0 THEN probe_count WHEN sampled = 1 THEN 1 ELSE 0 END ELSE 0 END) AS availability_checks,
         SUM(CASE WHEN expected_up = 1 THEN CASE WHEN probe_count > 0 THEN successful_probe_count WHEN sampled = 1 THEN available ELSE 0 END ELSE 0 END) AS available_checks,
         AVG(CASE WHEN sampled = 1 THEN cpu_percent END) AS average_cpu,
         MAX(cpu_percent) AS peak_cpu,
         AVG(CASE WHEN sampled = 1 THEN memory_bytes END) AS average_memory,
         MAX(memory_bytes) AS peak_memory,
         SUM(response_ms_sum) AS response_sum,
         SUM(probe_count) AS response_count,
         MAX(response_ms_max) AS peak_response
       FROM reliability_app_minutes WHERE app_id = ? AND minute_start >= ? AND minute_start <= ?`,
      [appId, since, now],
    );
    const events = this.store.all<{ kind: ReliabilityEventKind; count: number }>(
      "SELECT kind, COUNT(*) AS count FROM reliability_events WHERE app_id = ? AND at >= ? AND at <= ? GROUP BY kind",
      [appId, since, now],
    );
    const counts = new Map(events.map((event) => [event.kind, Number(event.count)]));
    const checks = Number(row?.availability_checks ?? 0);
    const responses = Number(row?.response_count ?? 0);
    return {
      days,
      monitoredMinutes: Number(row?.monitored_minutes ?? 0),
      availabilityChecks: checks,
      uptimePercent: checks ? rounded((Number(row?.available_checks ?? 0) / checks) * 100, 2) : null,
      averageCpuPercent: rounded(row?.average_cpu ?? null, 2),
      peakCpuPercent: rounded(row?.peak_cpu ?? null, 2),
      averageMemoryBytes:
        row?.average_memory === null || row?.average_memory === undefined
          ? null
          : Math.round(Number(row.average_memory)),
      peakMemoryBytes: row?.peak_memory === null || row?.peak_memory === undefined ? null : Number(row.peak_memory),
      averageResponseMs: responses ? rounded(Number(row?.response_sum ?? 0) / responses, 1) : null,
      peakResponseMs: rounded(row?.peak_response ?? null, 1),
      crashes: counts.get("crash") ?? 0,
      restarts: counts.get("restart") ?? 0,
    };
  }
}
