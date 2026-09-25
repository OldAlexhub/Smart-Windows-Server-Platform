import { newId, type ActivityItem, type ActivityKind } from "@nexus/shared";
import type { Migration, StateStore } from "@nexus/state";

export const activityMigrations: Migration[] = [
  {
    id: "server/001_activity",
    up: `CREATE TABLE activity (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      app_id TEXT
    );
    CREATE INDEX activity_at ON activity(at);`,
  },
];

/** "Recent Activity" on the dashboard — plain sentences, newest first. */
export class ActivityFeed {
  private listeners = new Set<(a: ActivityItem) => void>();

  constructor(
    private readonly store: StateStore,
    private readonly now: () => number = Date.now,
  ) {
    store.migrate(activityMigrations);
  }

  add(kind: ActivityKind, message: string, appId?: string): ActivityItem {
    const item: ActivityItem = { id: newId(), at: new Date(this.now()).toISOString(), kind, message, ...(appId ? { appId } : {}) };
    this.store.run("INSERT INTO activity (id, at, kind, message, app_id) VALUES (?, ?, ?, ?, ?)", [item.id, item.at, kind, message, appId ?? null]);
    // Keep the feed bounded.
    this.store.run("DELETE FROM activity WHERE id IN (SELECT id FROM activity ORDER BY at DESC LIMIT -1 OFFSET 5000)");
    for (const l of this.listeners) l(item);
    return item;
  }

  list(limit = 20, appId?: string): ActivityItem[] {
    const rows = this.store.all<{ id: string; at: string; kind: ActivityKind; message: string; app_id: string | null }>(
      appId ? "SELECT * FROM activity WHERE app_id = ? ORDER BY at DESC LIMIT ?" : "SELECT * FROM activity ORDER BY at DESC LIMIT ?",
      appId ? [appId, limit] : [limit],
    );
    return rows.map((r) => ({ id: r.id, at: r.at, kind: r.kind, message: r.message, ...(r.app_id ? { appId: r.app_id } : {}) }));
  }

  subscribe(fn: (a: ActivityItem) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
