export interface Point {
  t: number;
  v: number;
}

/**
 * Two-tier in-memory time series: raw points for the last hour, one-minute averages for
 * the last day. Enough for dashboard charts and anomaly checks without a metrics database.
 */
export class TimeSeries {
  private raw: Point[] = [];
  private minutes: Point[] = [];
  private bucket: { minute: number; sum: number; n: number } | null = null;

  constructor(
    private readonly rawWindowMs = 3_600_000,
    private readonly minuteWindowMs = 86_400_000,
  ) {}

  add(v: number, t = Date.now()): void {
    this.raw.push({ t, v });
    const cut = t - this.rawWindowMs;
    while (this.raw.length && this.raw[0]!.t < cut) this.raw.shift();

    const minute = Math.floor(t / 60_000) * 60_000;
    if (this.bucket && this.bucket.minute !== minute) this.flushBucket();
    if (!this.bucket) this.bucket = { minute, sum: 0, n: 0 };
    this.bucket.sum += v;
    this.bucket.n++;
    const mcut = t - this.minuteWindowMs;
    while (this.minutes.length && this.minutes[0]!.t < mcut) this.minutes.shift();
  }

  private flushBucket(): void {
    if (!this.bucket) return;
    this.minutes.push({ t: this.bucket.minute, v: this.bucket.sum / this.bucket.n });
    this.bucket = null;
  }

  latest(): number | null {
    return this.raw.at(-1)?.v ?? null;
  }

  /** Points in [since, now]; raw resolution for ≤1h ranges, minute averages beyond. */
  range(sinceMs: number, now = Date.now()): Point[] {
    const since = now - sinceMs;
    if (sinceMs <= this.rawWindowMs) return this.raw.filter((p) => p.t >= since);
    const current = this.bucket ? [{ t: this.bucket.minute, v: this.bucket.sum / this.bucket.n }] : [];
    return [...this.minutes, ...current].filter((p) => p.t >= since);
  }

  average(sinceMs: number, now = Date.now()): number | null {
    const pts = this.range(sinceMs, now);
    return pts.length ? pts.reduce((s, p) => s + p.v, 0) / pts.length : null;
  }
}

export class MetricsRegistry {
  private readonly series = new Map<string, TimeSeries>();

  record(key: string, value: number, t = Date.now()): void {
    let s = this.series.get(key);
    if (!s) this.series.set(key, (s = new TimeSeries()));
    s.add(value, t);
  }

  get(key: string): TimeSeries | undefined {
    return this.series.get(key);
  }

  latest(key: string): number | null {
    return this.series.get(key)?.latest() ?? null;
  }

  keys(prefix = ""): string[] {
    return [...this.series.keys()].filter((k) => k.startsWith(prefix));
  }

  drop(prefix: string): void {
    for (const k of this.keys(prefix)) this.series.delete(k);
  }
}
