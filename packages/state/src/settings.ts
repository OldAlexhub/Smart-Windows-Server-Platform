import type { Migration, StateStore } from "./store";
import { fromJson, toJson } from "./store";

export const settingsMigrations: Migration[] = [
  {
    id: "state/001_settings",
    up: `CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  },
];

/** Typed key/value settings stored in the state database. */
export class SettingsRepo {
  constructor(private readonly store: StateStore) {}

  get<T>(key: string, fallback: T): T {
    const row = this.store.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", [key]);
    return row ? fromJson<T>(row.value, fallback) : fallback;
  }

  set(key: string, value: unknown): void {
    this.store.run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, toJson(value), new Date().toISOString()],
    );
  }

  delete(key: string): void {
    this.store.run("DELETE FROM settings WHERE key = ?", [key]);
  }
}
