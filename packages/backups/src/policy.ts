export interface RetentionPolicy {
  /** Newest backup of each of the last N days. */
  daily: number;
  /** Newest backup of each of the last N weeks. */
  weekly: number;
  /** Newest backup of each of the last N months. */
  monthly: number;
  /** Most recent N backups made by pressing "Backup". */
  manual: number;
  /** Safety backups taken automatically before a restore, kept this many days. */
  preRestoreDays: number;
}

export interface BackupPolicy {
  enabled: boolean;
  frequency: "daily" | "weekly" | "custom";
  /** Local time "HH:MM". */
  time: string;
  /** 0 = Sunday, for weekly. */
  weekday?: number;
  /** For custom: every N hours. */
  intervalHours?: number;
  retention: RetentionPolicy;
}

export const DEFAULT_POLICY: BackupPolicy = {
  enabled: true,
  frequency: "daily",
  time: "03:00",
  retention: { daily: 7, weekly: 4, monthly: 6, manual: 10, preRestoreDays: 30 },
};

function parseTime(t: string): [number, number] {
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`Invalid time "${t}".`);
  return [Number(m[1]), Number(m[2])];
}

/** When the next scheduled backup should run (local time), strictly after `now`. */
export function nextRun(policy: BackupPolicy, lastRunAt: Date | null, now: Date): Date | null {
  if (!policy.enabled) return null;
  if (policy.frequency === "custom") {
    const hours = Math.max(1, policy.intervalHours ?? 24);
    if (!lastRunAt) return new Date(now.getTime() + 60_000);
    const next = new Date(lastRunAt.getTime() + hours * 3_600_000);
    return next > now ? next : new Date(now.getTime() + 60_000);
  }
  const [h, m] = parseTime(policy.time);
  const candidate = new Date(now);
  candidate.setHours(h, m, 0, 0);
  if (policy.frequency === "daily") {
    if (candidate <= now) candidate.setDate(candidate.getDate() + 1);
    return candidate;
  }
  const weekday = policy.weekday ?? 0;
  let add = (weekday - candidate.getDay() + 7) % 7;
  if (add === 0 && candidate <= now) add = 7;
  candidate.setDate(candidate.getDate() + add);
  return candidate;
}

/** A missed run (computer was off at 3 AM) should happen soon after start-up. */
export function isOverdue(policy: BackupPolicy, lastRunAt: Date | null, now: Date): boolean {
  if (!policy.enabled) return false;
  if (!lastRunAt) return true;
  const periodMs =
    policy.frequency === "custom" ? Math.max(1, policy.intervalHours ?? 24) * 3_600_000 : policy.frequency === "weekly" ? 7 * 86_400_000 : 86_400_000;
  return now.getTime() - lastRunAt.getTime() > periodMs * 1.5;
}

export interface BackupRef {
  id: string;
  createdAt: string;
  trigger: "scheduled" | "manual" | "pre-restore";
  status: "succeeded" | "failed" | "running";
}

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const monthKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}`;
function weekKey(d: Date): string {
  // ISO week: Thursday of the current week decides the year.
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)}`;
}

/**
 * Grandfather-father-son retention. Returns backups that may be deleted.
 * Guarantees: never deletes the newest successful backup; never touches running backups.
 */
export function selectForDeletion(backups: BackupRef[], r: RetentionPolicy, now: Date): string[] {
  const ok = backups.filter((b) => b.status === "succeeded").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const keep = new Set<string>();
  if (ok[0]) keep.add(ok[0].id);

  const scheduled = ok.filter((b) => b.trigger === "scheduled");
  for (const [n, key] of [
    [r.daily, dayKey],
    [r.weekly, weekKey],
    [r.monthly, monthKey],
  ] as const) {
    const seen = new Set<string>();
    for (const b of scheduled) {
      const k = key(new Date(b.createdAt));
      if (seen.has(k)) continue;
      seen.add(k);
      if (seen.size > n) break;
      keep.add(b.id);
    }
  }
  ok.filter((b) => b.trigger === "manual")
    .slice(0, r.manual)
    .forEach((b) => keep.add(b.id));
  ok.filter((b) => b.trigger === "pre-restore" && now.getTime() - new Date(b.createdAt).getTime() < r.preRestoreDays * 86_400_000).forEach((b) =>
    keep.add(b.id),
  );

  return backups.filter((b) => b.status !== "running" && !keep.has(b.id)).map((b) => b.id);
}
