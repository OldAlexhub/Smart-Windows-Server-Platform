import { newId, NexusError, type AiPermissionLevel } from "@nexus/shared";
import type { Migration, StateStore } from "@nexus/state";

/**
 * Every action the AI can take is classified. The AI never holds administrative credentials;
 * it can only ask this engine, and dangerous actions become proposals a human must approve.
 */
export const AI_ACTIONS = {
  // Always allowed (read-only)
  read_logs: "observe",
  read_metrics: "observe",
  inspect_code: "observe",
  run_readonly_sql: "observe",
  read_schema: "observe",
  // Allowed from "recommend" upward (no side effects)
  recommend: "recommend",
  prepare_config: "recommend",
  draft_script: "recommend",
  // Require explicit human approval
  modify_schema: "approval",
  edit_code: "approval",
  write_data: "approval",
  delete_data: "approval",
  restart_app: "approval",
  restart_critical: "approval",
  restore_backup: "approval",
  change_firewall: "approval",
  change_external_access: "approval",
  deploy_code: "approval",
  activate_pipeline: "approval",
  // Never, not even with approval
  delete_backups: "forbidden",
  drop_database: "forbidden",
  disable_security: "forbidden",
} as const;

export type AiAction = keyof typeof AI_ACTIONS;

export type AiDecision =
  | { decision: "allow" }
  | { decision: "propose"; reason: string }
  | { decision: "require_approval"; reason: string }
  | { decision: "deny"; reason: string };

/**
 * Observe:                 read-only insight.
 * Recommend (default):     + suggestions and prepared changes, shown as "Review Recommendation".
 * Execute after approval:  + queued actions that run only after a person approves them.
 */
export function evaluateAiAction(action: AiAction, level: AiPermissionLevel): AiDecision {
  const cls = AI_ACTIONS[action];
  if (!cls) return { decision: "deny", reason: "Unknown action." };
  if (cls === "forbidden") return { decision: "deny", reason: "Nexus AI is never allowed to do this automatically." };
  if (cls === "observe") return { decision: "allow" };
  if (level === "observe") return { decision: "deny", reason: "Nexus AI is set to observe only." };
  if (cls === "recommend") return { decision: "allow" };
  // cls === "approval"
  if (level === "recommend") return { decision: "propose", reason: "This change needs your review before anything happens." };
  return { decision: "require_approval", reason: "Nexus AI will do this only after you approve it." };
}

// ------------------------------------------------------------------ proposals / approvals

export const aiMigrations: Migration[] = [
  {
    id: "ai/001_proposals",
    up: `CREATE TABLE ai_proposals (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      title TEXT NOT NULL,
      explanation TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      payload TEXT NOT NULL,
      status TEXT NOT NULL,
      executable INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      decided_by TEXT,
      decided_at TEXT,
      result TEXT
    );
    CREATE INDEX ai_proposals_status ON ai_proposals(status, created_at);`,
  },
];

export type ProposalStatus = "pending" | "approved" | "rejected" | "executed" | "failed" | "expired";

export interface AiProposal {
  id: string;
  action: AiAction;
  title: string;
  explanation: string;
  target: { type: string; id: string } | null;
  payload: unknown;
  status: ProposalStatus;
  /** False for "recommend" level: approving records agreement, but a person applies the change. */
  executable: boolean;
  createdAt: string;
  expiresAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  result: string | null;
}

export class AiProposals {
  constructor(
    private readonly store: StateStore,
    private readonly now: () => number = Date.now,
  ) {
    store.migrate(aiMigrations);
  }

  /**
   * The AI calls this for any non-read action. Returns immediately for allowed actions;
   * otherwise records a proposal (or refuses). The AI can never approve its own proposals.
   */
  request(
    level: AiPermissionLevel,
    input: { action: AiAction; title: string; explanation: string; target?: { type: string; id: string }; payload?: unknown; ttlHours?: number },
  ): { decision: AiDecision; proposal: AiProposal | null } {
    const decision = evaluateAiAction(input.action, level);
    if (decision.decision === "allow" || decision.decision === "deny") return { decision, proposal: null };
    const id = newId();
    const created = new Date(this.now());
    const expires = new Date(created.getTime() + (input.ttlHours ?? 72) * 3_600_000);
    this.store.run(
      `INSERT INTO ai_proposals (id, action, title, explanation, target_type, target_id, payload, status, executable, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      [
        id,
        input.action,
        input.title,
        input.explanation,
        input.target?.type ?? null,
        input.target?.id ?? null,
        JSON.stringify(input.payload ?? null),
        decision.decision === "require_approval" ? 1 : 0,
        created.toISOString(),
        expires.toISOString(),
      ],
    );
    return { decision, proposal: this.require(id) };
  }

  /** A person approves. `approverId` must be a human user id (never the AI). */
  approve(id: string, approverId: string): AiProposal {
    if (!approverId || approverId === "ai") throw NexusError.forbidden("Only a person can approve AI proposals.");
    const p = this.pending(id);
    this.store.run("UPDATE ai_proposals SET status = 'approved', decided_by = ?, decided_at = ? WHERE id = ?", [
      approverId,
      new Date(this.now()).toISOString(),
      id,
    ]);
    return { ...p, ...this.require(id) };
  }

  reject(id: string, userId: string): AiProposal {
    this.pending(id);
    this.store.run("UPDATE ai_proposals SET status = 'rejected', decided_by = ?, decided_at = ? WHERE id = ?", [userId, new Date(this.now()).toISOString(), id]);
    return this.require(id);
  }

  /** Called by the executor after running an approved, executable proposal. */
  markExecuted(id: string, ok: boolean, result: string): void {
    const p = this.require(id);
    if (p.status !== "approved" || !p.executable) throw NexusError.conflict("Only approved actions can be executed.");
    this.store.run("UPDATE ai_proposals SET status = ?, result = ? WHERE id = ?", [ok ? "executed" : "failed", result, id]);
  }

  list(status?: ProposalStatus): AiProposal[] {
    this.expire();
    const rows = status
      ? this.store.all<Row>("SELECT * FROM ai_proposals WHERE status = ? ORDER BY created_at DESC", [status])
      : this.store.all<Row>("SELECT * FROM ai_proposals ORDER BY created_at DESC LIMIT 200");
    return rows.map(toProposal);
  }

  require(id: string): AiProposal {
    const r = this.store.get<Row>("SELECT * FROM ai_proposals WHERE id = ?", [id]);
    if (!r) throw NexusError.notFound("Recommendation");
    return toProposal(r);
  }

  private pending(id: string): AiProposal {
    this.expire();
    const p = this.require(id);
    if (p.status !== "pending") throw NexusError.conflict(`This recommendation is already ${p.status}.`);
    return p;
  }

  private expire(): void {
    this.store.run("UPDATE ai_proposals SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?", [new Date(this.now()).toISOString()]);
  }
}

interface Row {
  id: string;
  action: AiAction;
  title: string;
  explanation: string;
  target_type: string | null;
  target_id: string | null;
  payload: string;
  status: ProposalStatus;
  executable: number;
  created_at: string;
  expires_at: string;
  decided_by: string | null;
  decided_at: string | null;
  result: string | null;
}

function toProposal(r: Row): AiProposal {
  return {
    id: r.id,
    action: r.action,
    title: r.title,
    explanation: r.explanation,
    target: r.target_type && r.target_id ? { type: r.target_type, id: r.target_id } : null,
    payload: JSON.parse(r.payload),
    status: r.status,
    executable: !!r.executable,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
    result: r.result,
  };
}
