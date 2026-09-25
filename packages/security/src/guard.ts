import type { Migration, StateStore } from "@nexus/state";

// ---------------------------------------------------------------------------
// Rate limiting (token bucket, in memory — per API key / IP / route)
// ---------------------------------------------------------------------------

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updated: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = Date.now,
  ) {}

  take(key: string, cost = 1): RateLimitDecision {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, updated: t };
    b.tokens = Math.min(this.capacity, b.tokens + ((t - b.updated) / 1000) * this.refillPerSecond);
    b.updated = t;
    this.buckets.set(key, b);
    if (b.tokens >= cost) {
      b.tokens -= cost;
      return { allowed: true, remaining: Math.floor(b.tokens), retryAfterMs: 0 };
    }
    return { allowed: false, remaining: 0, retryAfterMs: Math.ceil(((cost - b.tokens) / this.refillPerSecond) * 1000) };
  }

  /** Drops idle buckets to bound memory. */
  sweep(maxIdleMs = 10 * 60_000): void {
    const t = this.now();
    for (const [k, b] of this.buckets) if (t - b.updated > maxIdleMs) this.buckets.delete(k);
  }
}

// ---------------------------------------------------------------------------
// Brute-force protection + suspicious login detection (persisted)
// ---------------------------------------------------------------------------

export const guardMigrations: Migration[] = [
  {
    id: "security/003_login_guard",
    up: `CREATE TABLE login_failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL COLLATE NOCASE,
      ip TEXT NOT NULL,
      at INTEGER NOT NULL
    );
    CREATE INDEX login_failures_user ON login_failures(username, at);
    CREATE INDEX login_failures_ip ON login_failures(ip, at);
    CREATE TABLE login_lockouts (
      key TEXT PRIMARY KEY,
      until INTEGER NOT NULL,
      level INTEGER NOT NULL
    );
    CREATE TABLE login_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      ip TEXT NOT NULL,
      user_agent TEXT,
      remote INTEGER NOT NULL,
      at INTEGER NOT NULL
    );
    CREATE INDEX login_history_user ON login_history(user_id, at);`,
  },
];

export interface LoginGuardPolicy {
  windowMs: number;
  maxAccountFailures: number;
  maxIpFailures: number;
  baseLockoutMs: number;
  maxLockoutMs: number;
}

export const DEFAULT_GUARD_POLICY: LoginGuardPolicy = {
  windowMs: 15 * 60_000,
  maxAccountFailures: 5,
  maxIpFailures: 20,
  baseLockoutMs: 15 * 60_000,
  maxLockoutMs: 24 * 60 * 60_000,
};

export interface GuardDecision {
  allowed: boolean;
  retryAfterMs: number;
  reason?: "account_locked" | "ip_blocked";
}

export type RiskLevel = "none" | "low" | "high";

export interface LoginRisk {
  level: RiskLevel;
  signals: string[];
}

export class LoginGuard {
  constructor(
    private readonly store: StateStore,
    private readonly policy: LoginGuardPolicy = DEFAULT_GUARD_POLICY,
    private readonly now: () => number = Date.now,
  ) {
    store.migrate(guardMigrations);
  }

  /** Call before verifying credentials. Loopback requests are never IP-blocked. */
  check(username: string, ip: string): GuardDecision {
    const t = this.now();
    for (const [key, reason] of [
      [`user:${username.toLowerCase()}`, "account_locked"],
      [`ip:${ip}`, "ip_blocked"],
    ] as const) {
      if (reason === "ip_blocked" && isLoopback(ip)) continue;
      const lock = this.store.get<{ until: number }>("SELECT until FROM login_lockouts WHERE key = ?", [key]);
      if (lock && lock.until > t) return { allowed: false, retryAfterMs: lock.until - t, reason };
    }
    return { allowed: true, retryAfterMs: 0 };
  }

  recordFailure(username: string, ip: string): GuardDecision {
    const t = this.now();
    const since = t - this.policy.windowMs;
    this.store.run("INSERT INTO login_failures (username, ip, at) VALUES (?, ?, ?)", [username, ip, t]);
    const accountFails = this.count("username", username, since);
    const ipFails = this.count("ip", ip, since);
    if (accountFails >= this.policy.maxAccountFailures) this.lock(`user:${username.toLowerCase()}`);
    if (ipFails >= this.policy.maxIpFailures && !isLoopback(ip)) this.lock(`ip:${ip}`);
    this.store.run("DELETE FROM login_failures WHERE at < ?", [t - this.policy.maxLockoutMs]);
    return this.check(username, ip);
  }

  /**
   * Clears the account's failure counter and assesses how unusual this login is.
   * Signals are surfaced in the dashboard's security card and the audit log.
   */
  recordSuccess(input: { userId: string; username: string; ip: string; userAgent?: string; remote: boolean }): LoginRisk {
    const t = this.now();
    const since = t - this.policy.windowMs;
    const recentFailures = this.count("username", input.username, since);
    this.store.run("DELETE FROM login_failures WHERE username = ?", [input.username]);
    this.store.run("DELETE FROM login_lockouts WHERE key = ?", [`user:${input.username.toLowerCase()}`]);

    const history = this.store.all<{ ip: string; user_agent: string | null; remote: number }>(
      "SELECT ip, user_agent, remote FROM login_history WHERE user_id = ? ORDER BY at DESC LIMIT 50",
      [input.userId],
    );
    const signals: string[] = [];
    if (history.length > 0) {
      if (!history.some((h) => h.ip === input.ip)) signals.push("Sign-in from a new network address");
      if (input.userAgent && !history.some((h) => h.user_agent === input.userAgent)) {
        signals.push("Sign-in from a new device or browser");
      }
      if (input.remote && history.every((h) => !h.remote)) signals.push("First sign-in from outside this computer");
    }
    if (recentFailures >= 3) signals.push(`${recentFailures} failed attempts before this sign-in`);

    this.store.run("INSERT INTO login_history (user_id, ip, user_agent, remote, at) VALUES (?, ?, ?, ?, ?)", [
      input.userId,
      input.ip,
      input.userAgent ?? null,
      input.remote ? 1 : 0,
      t,
    ]);

    const level: RiskLevel =
      signals.length === 0 ? "none" : recentFailures >= 3 || signals.length >= 2 ? "high" : "low";
    return { level, signals };
  }

  unlock(key: `user:${string}` | `ip:${string}`): void {
    this.store.run("DELETE FROM login_lockouts WHERE key = ?", [key]);
  }

  private count(column: "username" | "ip", value: string, since: number): number {
    return this.store.get<{ n: number }>(`SELECT COUNT(*) AS n FROM login_failures WHERE ${column} = ? AND at >= ?`, [
      value,
      since,
    ])!.n;
  }

  private lock(key: string): void {
    const t = this.now();
    const prev = this.store.get<{ until: number; level: number }>("SELECT until, level FROM login_lockouts WHERE key = ?", [key]);
    if (prev && prev.until > t) return; // already locked
    const level = prev ? prev.level + 1 : 0;
    const duration = Math.min(this.policy.baseLockoutMs * 2 ** level, this.policy.maxLockoutMs);
    this.store.run(
      `INSERT INTO login_lockouts (key, until, level) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET until = excluded.until, level = excluded.level`,
      [key, t + duration, level],
    );
  }
}

export function isLoopback(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1" || ip.startsWith("127.");
}
