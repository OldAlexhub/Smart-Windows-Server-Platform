import { createHash, randomBytes } from "node:crypto";
import { newId, NexusError } from "@nexus/shared";
import type { Migration, StateStore } from "@nexus/state";

export const appTokenMigrations: Migration[] = [
  {
    id: "security/005_app_tokens",
    up: `CREATE TABLE app_tokens (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      scopes TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      revoked_at TEXT
    );
    CREATE INDEX app_tokens_app ON app_tokens(app_id);`,
  },
];

/**
 * What an application credential may do. Every scope is limited to the app's OWN resources:
 * an app can never read another app's files, secrets or logs.
 */
export const APP_SCOPES = ["storage:read", "storage:write", "secrets:read", "logs:write", "health:read", "ai:infer", "pipelines:run", "gateway:api"] as const;
export type AppScope = (typeof APP_SCOPES)[number];

export const DEFAULT_APP_SCOPES: AppScope[] = ["storage:read", "storage:write", "secrets:read", "logs:write", "health:read"];

export interface AppPrincipal {
  tokenId: string;
  appId: string;
  scopes: AppScope[];
  label: string;
}

const hash = (t: string) => createHash("sha256").update(t).digest("hex");

/** Credentials for applications (injected automatically) and for external API clients. */
export class AppTokens {
  constructor(
    private readonly store: StateStore,
    private readonly now: () => number = Date.now,
  ) {
    store.migrate(appTokenMigrations);
  }

  issue(appId: string, label: string, scopes: AppScope[] = DEFAULT_APP_SCOPES): { id: string; token: string } {
    for (const s of scopes) if (!(APP_SCOPES as readonly string[]).includes(s)) throw NexusError.invalid(`Unknown scope ${s}`);
    const id = newId();
    // Recognisable prefix helps secret scanners and makes leaked tokens easy to spot.
    const token = `nxs_${randomBytes(32).toString("base64url")}`;
    this.store.run(
      "INSERT INTO app_tokens (id, app_id, token_hash, label, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [id, appId, hash(token), label, JSON.stringify(scopes), new Date(this.now()).toISOString()],
    );
    return { id, token };
  }

  verify(token: string | undefined | null): AppPrincipal | null {
    if (!token || !token.startsWith("nxs_")) return null;
    const row = this.store.get<{ id: string; app_id: string; scopes: string; label: string; revoked_at: string | null }>(
      "SELECT id, app_id, scopes, label, revoked_at FROM app_tokens WHERE token_hash = ?",
      [hash(token)],
    );
    if (!row || row.revoked_at) return null;
    this.store.run("UPDATE app_tokens SET last_used_at = ? WHERE id = ?", [new Date(this.now()).toISOString(), row.id]);
    return { tokenId: row.id, appId: row.app_id, scopes: JSON.parse(row.scopes) as AppScope[], label: row.label };
  }

  /** Throws unless the principal has `scope` for `appId`. */
  static assert(p: AppPrincipal | null, scope: AppScope, appId?: string): AppPrincipal {
    if (!p) throw NexusError.unauthorized("A valid application credential is required.");
    if (!p.scopes.includes(scope)) throw NexusError.forbidden(`This credential is not allowed to use ${scope}.`);
    if (appId && appId !== p.appId) throw NexusError.forbidden("Applications can only access their own resources.");
    return p;
  }

  list(appId: string): { id: string; label: string; scopes: AppScope[]; createdAt: string; lastUsedAt: string | null; revoked: boolean }[] {
    return this.store
      .all<{ id: string; label: string; scopes: string; created_at: string; last_used_at: string | null; revoked_at: string | null }>(
        "SELECT * FROM app_tokens WHERE app_id = ? ORDER BY created_at",
        [appId],
      )
      .map((r) => ({ id: r.id, label: r.label, scopes: JSON.parse(r.scopes), createdAt: r.created_at, lastUsedAt: r.last_used_at, revoked: !!r.revoked_at }));
  }

  revoke(tokenId: string): void {
    this.store.run("UPDATE app_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [new Date(this.now()).toISOString(), tokenId]);
  }

  revokeAll(appId: string): void {
    this.store.run("UPDATE app_tokens SET revoked_at = ? WHERE app_id = ? AND revoked_at IS NULL", [new Date(this.now()).toISOString(), appId]);
  }
}
