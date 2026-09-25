import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

/**
 * A schema migration owned by one module. Ids are namespaced ("security/001_users")
 * so every package can ship its own migrations independently.
 */
export interface Migration {
  id: string;
  description?: string;
  up: string | ((store: StateStore) => void);
}

export type Params = SQLInputValue[] | Record<string, SQLInputValue>;

/**
 * Nexus's own control-plane state (users, apps, jobs, audit...). Business data never lives here.
 * Backed by SQLite in WAL mode; all access is synchronous and fast.
 */
export class StateStore {
  readonly db: DatabaseSync;
  private txDepth = 0;

  constructor(readonly path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { enableForeignKeyConstraints: true, timeout: 5000 });
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`);
  }

  static memory(): StateStore {
    return new StateStore(":memory:");
  }

  /** Applies migrations that have not run yet, in the order given. Returns the ids applied. */
  migrate(migrations: readonly Migration[]): string[] {
    const seen = new Set<string>();
    for (const m of migrations) {
      if (seen.has(m.id)) throw new Error(`Duplicate migration id: ${m.id}`);
      seen.add(m.id);
    }
    const applied = new Set(this.all<{ id: string }>("SELECT id FROM schema_migrations").map((r) => r.id));
    const ran: string[] = [];
    for (const m of migrations) {
      if (applied.has(m.id)) continue;
      this.transaction(() => {
        if (typeof m.up === "string") this.db.exec(m.up);
        else m.up(this);
        this.run("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)", [m.id, new Date().toISOString()]);
      });
      ran.push(m.id);
    }
    return ran;
  }

  appliedMigrations(): string[] {
    return this.all<{ id: string }>("SELECT id FROM schema_migrations ORDER BY rowid").map((r) => r.id);
  }

  run(sql: string, params: Params = []): { changes: number; lastInsertRowid: number } {
    const stmt = this.db.prepare(sql);
    const r = Array.isArray(params) ? stmt.run(...params) : stmt.run(params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  get<T>(sql: string, params: Params = []): T | undefined {
    const stmt = this.db.prepare(sql);
    return (Array.isArray(params) ? stmt.get(...params) : stmt.get(params)) as T | undefined;
  }

  all<T>(sql: string, params: Params = []): T[] {
    const stmt = this.db.prepare(sql);
    return (Array.isArray(params) ? stmt.all(...params) : stmt.all(params)) as T[];
  }

  /** Runs fn inside a transaction (nested calls use savepoints). Rolls back on throw. */
  transaction<T>(fn: () => T): T {
    const sp = `sp_${this.txDepth}`;
    this.db.exec(this.txDepth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${sp}`);
    this.txDepth++;
    try {
      const result = fn();
      this.txDepth--;
      this.db.exec(this.txDepth === 0 ? "COMMIT" : `RELEASE ${sp}`);
      return result;
    } catch (e) {
      this.txDepth--;
      this.db.exec(this.txDepth === 0 ? "ROLLBACK" : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw e;
    }
  }

  close(): void {
    this.db.close();
  }
}

/** Serialize a value into a JSON TEXT column. */
export const toJson = (v: unknown): string => JSON.stringify(v ?? null);

/** Parse a JSON TEXT column, tolerating nulls. */
export function fromJson<T>(v: unknown, fallback: T): T {
  if (typeof v !== "string" || v === "") return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}
