import { createHash } from "node:crypto";
import type { Migration, StateStore } from "@nexus/state";

export const auditMigrations: Migration[] = [
  {
    id: "security/004_audit",
    up: `CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      actor_name TEXT,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      outcome TEXT NOT NULL,
      details TEXT,
      ip TEXT,
      prev_hash TEXT NOT NULL,
      hash TEXT NOT NULL
    );
    CREATE INDEX audit_at ON audit_log(at);
    CREATE INDEX audit_target ON audit_log(target_type, target_id);
    CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log
      BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
    CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log
      BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;`,
  },
];

export type ActorType = "user" | "app" | "ai" | "system";
export type AuditOutcome = "success" | "denied" | "failure";

export interface AuditEntryInput {
  actor: { type: ActorType; id?: string | null; name?: string | null };
  action: string;
  target?: { type: string; id?: string | null };
  outcome?: AuditOutcome;
  details?: Record<string, unknown>;
  ip?: string | null;
}

export interface AuditEntry {
  id: number;
  at: string;
  actorType: ActorType;
  actorId: string | null;
  actorName: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  outcome: AuditOutcome;
  details: Record<string, unknown>;
  ip: string | null;
}

interface Row {
  id: number;
  at: string;
  actor_type: ActorType;
  actor_id: string | null;
  actor_name: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  outcome: AuditOutcome;
  details: string | null;
  ip: string | null;
  prev_hash: string;
  hash: string;
}

const GENESIS = "0".repeat(64);
const SENSITIVE_KEYS = /pass(word)?|secret|token|key|credential/i;

/**
 * Append-only audit trail. Each entry's hash covers its content and the previous
 * entry's hash, so any tampering with history is detectable by `verify()`.
 */
export class AuditLog {
  constructor(
    private readonly store: StateStore,
    private readonly now: () => number = Date.now,
  ) {
    store.migrate(auditMigrations);
  }

  record(input: AuditEntryInput): AuditEntry {
    return this.store.transaction(() => {
      const prev = this.store.get<{ hash: string }>("SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1");
      const prevHash = prev?.hash ?? GENESIS;
      const fields = {
        at: new Date(this.now()).toISOString(),
        actor_type: input.actor.type,
        actor_id: input.actor.id ?? null,
        actor_name: input.actor.name ?? null,
        action: input.action,
        target_type: input.target?.type ?? null,
        target_id: input.target?.id ?? null,
        outcome: input.outcome ?? "success",
        details: input.details ? JSON.stringify(redact(input.details)) : null,
        ip: input.ip ?? null,
      };
      const hash = entryHash(prevHash, fields);
      const { lastInsertRowid } = this.store.run(
        `INSERT INTO audit_log (at, actor_type, actor_id, actor_name, action, target_type, target_id, outcome, details, ip, prev_hash, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          fields.at,
          fields.actor_type,
          fields.actor_id,
          fields.actor_name,
          fields.action,
          fields.target_type,
          fields.target_id,
          fields.outcome,
          fields.details,
          fields.ip,
          prevHash,
          hash,
        ],
      );
      return this.toEntry(this.store.get<Row>("SELECT * FROM audit_log WHERE id = ?", [lastInsertRowid])!);
    });
  }

  query(filter: {
    targetType?: string;
    targetId?: string;
    actorId?: string;
    action?: string;
    outcome?: AuditOutcome;
    limit?: number;
    beforeId?: number;
  } = {}): AuditEntry[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.targetType) (where.push("target_type = ?"), params.push(filter.targetType));
    if (filter.targetId) (where.push("target_id = ?"), params.push(filter.targetId));
    if (filter.actorId) (where.push("actor_id = ?"), params.push(filter.actorId));
    if (filter.action) (where.push("action LIKE ?"), params.push(`${filter.action}%`));
    if (filter.outcome) (where.push("outcome = ?"), params.push(filter.outcome));
    if (filter.beforeId) (where.push("id < ?"), params.push(filter.beforeId));
    const sql = `SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`;
    params.push(Math.min(filter.limit ?? 100, 1000));
    return this.store.all<Row>(sql, params).map((r) => this.toEntry(r));
  }

  /** Recomputes the hash chain. Returns the id of the first broken entry, or null if intact. */
  verify(): { intact: boolean; brokenAt: number | null; entries: number } {
    let prevHash = GENESIS;
    let n = 0;
    for (const row of this.store.all<Row>("SELECT * FROM audit_log ORDER BY id")) {
      n++;
      const { id, prev_hash, hash, ...fields } = row;
      if (prev_hash !== prevHash || entryHash(prevHash, fields) !== hash) {
        return { intact: false, brokenAt: id, entries: n };
      }
      prevHash = hash;
    }
    return { intact: true, brokenAt: null, entries: n };
  }

  private toEntry(r: Row): AuditEntry {
    return {
      id: r.id,
      at: r.at,
      actorType: r.actor_type,
      actorId: r.actor_id,
      actorName: r.actor_name,
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      outcome: r.outcome,
      details: r.details ? JSON.parse(r.details) : {},
      ip: r.ip,
    };
  }
}

function entryHash(prevHash: string, f: Omit<Row, "id" | "prev_hash" | "hash">): string {
  const canonical = JSON.stringify([
    prevHash,
    f.at,
    f.actor_type,
    f.actor_id,
    f.actor_name,
    f.action,
    f.target_type,
    f.target_id,
    f.outcome,
    f.details,
    f.ip,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

/** Never write secret values into the audit trail, even by accident. */
function redact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.test(k)) out[k] = "[redacted]";
    else if (v && typeof v === "object" && !Array.isArray(v)) out[k] = redact(v as Record<string, unknown>);
    else out[k] = v;
  }
  return out;
}
