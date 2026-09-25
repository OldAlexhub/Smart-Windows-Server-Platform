import { newId, NexusError } from "@nexus/shared";
import type { Migration } from "@nexus/state";
import type { NexusContext } from "../context";

export const notificationMigrations: Migration[] = [
  {
    id: "server/005_notifications",
    up: `CREATE TABLE notifications (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      severity TEXT NOT NULL,
      source TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      link TEXT,
      read_at TEXT
    );
    CREATE INDEX notifications_at ON notifications(at);`,
  },
];

export type Severity = "info" | "warning" | "critical";

export interface Notification {
  id: string;
  at: string;
  severity: Severity;
  /** What raised it: "pipeline", "backup", "system"… */
  source: string;
  title: string;
  message: string;
  /** Where the control center should take the person, e.g. /pipelines/<id>/runs/<runId>. */
  link: string | null;
  read: boolean;
}

export interface NotificationSettings {
  /** Send to an outside chat channel (Teams, Slack, Discord incoming webhook). The URL itself is kept in the vault. */
  webhookConfigured: boolean;
  /** Only notifications at least this important are sent outside Nexus. */
  minSeverity: Severity;
  lastDelivery: { at: string; ok: boolean; error: string | null } | null;
}

const RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };
const WEBHOOK_SECRET = "notifications/webhook-url";
const SETTINGS_KEY = "notifications.settings";
const ICON: Record<Severity, string> = { info: "ℹ️", warning: "⚠️", critical: "🔴" };

/**
 * The notification center: important events people should see (failed pipelines, data-quality
 * problems, unusual runs…). Every notification lands in the control center and the activity feed;
 * the important ones can also go to a team chat through an incoming webhook.
 */
export class NotificationService {
  constructor(
    private readonly ctx: NexusContext,
    /** Replaceable in tests. */
    private readonly send: (url: string, body: string) => Promise<Response> = (url, body) =>
      fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(10_000) }),
  ) {
    ctx.store.migrate(notificationMigrations);
  }

  async publish(n: { severity: Severity; source: string; title: string; message: string; link?: string | null }): Promise<Notification> {
    const item: Notification = { id: newId(), at: new Date().toISOString(), severity: n.severity, source: n.source, title: n.title, message: n.message, link: n.link ?? null, read: false };
    this.ctx.store.run("INSERT INTO notifications (id, at, severity, source, title, message, link) VALUES (?, ?, ?, ?, ?, ?, ?)", [item.id, item.at, item.severity, item.source, item.title, item.message, item.link]);
    this.ctx.store.run("DELETE FROM notifications WHERE id IN (SELECT id FROM notifications ORDER BY at DESC LIMIT -1 OFFSET 2000)");
    this.ctx.activity.add(n.severity === "critical" ? "problem" : n.severity === "warning" ? "warning" : "info", `${n.title}. ${n.message}`.replace(/\.\s*\./, "."));
    const settings = this.settings();
    const url = this.ctx.vault.get(WEBHOOK_SECRET);
    if (url && RANK[n.severity] >= RANK[settings.minSeverity]) await this.deliver(url, item);
    return item;
  }

  list(opts: { limit?: number; unreadOnly?: boolean } = {}): Notification[] {
    return this.ctx.store
      .all<Row>(`SELECT * FROM notifications ${opts.unreadOnly ? "WHERE read_at IS NULL" : ""} ORDER BY at DESC LIMIT ?`, [opts.limit ?? 50])
      .map((r) => ({ id: r.id, at: r.at, severity: r.severity as Severity, source: r.source, title: r.title, message: r.message, link: r.link, read: !!r.read_at }));
  }

  unreadCount(): number {
    return this.ctx.store.get<{ n: number }>("SELECT count(*) AS n FROM notifications WHERE read_at IS NULL")!.n;
  }

  markRead(id?: string): void {
    const now = new Date().toISOString();
    if (id) this.ctx.store.run("UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL", [now, id]);
    else this.ctx.store.run("UPDATE notifications SET read_at = ? WHERE read_at IS NULL", [now]);
  }

  settings(): NotificationSettings {
    const s = this.ctx.settings.get<{ minSeverity: Severity; lastDelivery: NotificationSettings["lastDelivery"] }>(SETTINGS_KEY, { minSeverity: "warning", lastDelivery: null });
    return { webhookConfigured: this.ctx.vault.has(WEBHOOK_SECRET), minSeverity: s.minSeverity, lastDelivery: s.lastDelivery };
  }

  configure(input: { webhookUrl?: string | null; minSeverity?: Severity }): NotificationSettings {
    if (input.webhookUrl !== undefined) {
      if (input.webhookUrl === null || input.webhookUrl === "") this.ctx.vault.delete(WEBHOOK_SECRET);
      else {
        let u: URL;
        try {
          u = new URL(input.webhookUrl);
        } catch {
          throw NexusError.invalid("That isn't a web address. Paste the incoming webhook URL from Teams, Slack or Discord.");
        }
        if (u.protocol !== "https:") throw NexusError.invalid("The webhook address must start with https://.");
        this.ctx.vault.set(WEBHOOK_SECRET, u.toString(), "system");
      }
    }
    const current = this.ctx.settings.get<{ minSeverity: Severity; lastDelivery: NotificationSettings["lastDelivery"] }>(SETTINGS_KEY, { minSeverity: "warning", lastDelivery: null });
    this.ctx.settings.set(SETTINGS_KEY, { ...current, ...(input.minSeverity ? { minSeverity: input.minSeverity } : {}) });
    return this.settings();
  }

  /** Sends a test message to the configured channel and reports what happened. */
  async test(): Promise<{ ok: boolean; error: string | null }> {
    const url = this.ctx.vault.get(WEBHOOK_SECRET);
    if (!url) throw NexusError.conflict("No chat channel is set up yet.");
    return this.deliver(url, { id: "test", at: new Date().toISOString(), severity: "info", source: "system", title: "Nexus test notification", message: "Notifications from Nexus will appear here.", link: null, read: false });
  }

  private async deliver(url: string, n: Notification): Promise<{ ok: boolean; error: string | null }> {
    // {"text": …} is understood by Slack, Microsoft Teams and Discord (as "content") incoming webhooks.
    const text = `${ICON[n.severity]} **${n.title}**\n${n.message}`;
    let result: { ok: boolean; error: string | null };
    try {
      const res = await this.send(url, JSON.stringify({ text, content: text }));
      result = res.ok ? { ok: true, error: null } : { ok: false, error: `The chat service answered with HTTP ${res.status}.` };
    } catch (e) {
      result = { ok: false, error: `The chat service couldn't be reached (${(e as Error).message}).` };
    }
    if (!result.ok) this.ctx.log.warn("notification delivery failed", { error: result.error });
    const current = this.ctx.settings.get<Record<string, unknown>>(SETTINGS_KEY, { minSeverity: "warning" });
    this.ctx.settings.set(SETTINGS_KEY, { ...current, lastDelivery: { at: new Date().toISOString(), ...result } });
    return result;
  }
}

interface Row {
  id: string;
  at: string;
  severity: string;
  source: string;
  title: string;
  message: string;
  link: string | null;
  read_at: string | null;
}
