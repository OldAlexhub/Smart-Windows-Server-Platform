import { NexusError } from "@nexus/shared";
import type { SecretVault } from "@nexus/security";
import type { StateStore } from "@nexus/state";
import { generateDbPassword, type DatabaseManager } from "./manager";
import type { PostgresEngine } from "./postgres";

export type DatabaseAccountMode = "read-only" | "read-write";
export interface DatabaseAccount { username: string; mode: DatabaseAccountMode; createdAt: string; revoked: boolean }
const secret = (databaseId: string, username: string) => `db:${databaseId}/connection:${username}/password`;

/** Human/ODBC accounts: data privileges on one database, never an app's owner role. */
export class DatabaseAccountManager {
  constructor(private readonly store: StateStore, private readonly vault: SecretVault, private readonly engine: PostgresEngine, private readonly databases: DatabaseManager) {
    store.migrate([{ id: "database/connection_accounts_v1", up: `CREATE TABLE database_connection_accounts (
      username TEXT PRIMARY KEY, database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
      mode TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT
    );` }]);
  }

  list(databaseId: string): DatabaseAccount[] {
    this.databases.require(databaseId);
    return this.store.all<{ username: string; mode: DatabaseAccountMode; created_at: string; revoked_at: string | null }>(
      "SELECT * FROM database_connection_accounts WHERE database_id = ? ORDER BY created_at", [databaseId],
    ).map((row) => ({ username: row.username, mode: row.mode, createdAt: row.created_at, revoked: !!row.revoked_at }));
  }

  async create(databaseId: string, input: { username: string; password?: string; mode: DatabaseAccountMode }): Promise<DatabaseAccount & { password: string }> {
    const db = this.databases.require(databaseId);
    const username = input.username.trim();
    if (!/^[a-z][a-z0-9_]{2,49}$/.test(username) || /^(pg_|nexus_|postgres$)/.test(username)) throw NexusError.invalid("Use 3–50 lowercase letters, numbers or underscores, starting with a letter. Choose a name that isn't reserved by Nexus or PostgreSQL.");
    if (!["read-only", "read-write"].includes(input.mode)) throw NexusError.invalid("Choose read-only or read/write access.");
    const password = input.password || generateDbPassword();
    this.validatePassword(password);
    const client = await this.engine.adminClient(db.dbName);
    let committed = false;
    try {
      if ((await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [username])).rowCount) throw NexusError.conflict("That database username is already in use. Choose a unique username for this connection.");
      const role = client.escapeIdentifier(username);
      const owner = client.escapeIdentifier(db.ownerRole);
      await client.query("BEGIN");
      await client.query(`CREATE ROLE ${role} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${client.escapeLiteral(password)}`);
      await client.query(`GRANT CONNECT ON DATABASE ${client.escapeIdentifier(db.dbName)} TO ${role}`);
      await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      const tablePrivileges = input.mode === "read-only" ? "SELECT" : "SELECT, INSERT, UPDATE, DELETE";
      await client.query(`GRANT ${tablePrivileges} ON ALL TABLES IN SCHEMA public TO ${role}`);
      await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public GRANT ${tablePrivileges} ON TABLES TO ${role}`);
      if (input.mode === "read-write") {
        await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
        await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${role}`);
      }
      await client.query("COMMIT");
      committed = true;
      const createdAt = new Date().toISOString();
      this.store.transaction(() => {
        this.vault.set(secret(databaseId, username), password, `db:${databaseId}`);
        this.store.run("INSERT INTO database_connection_accounts (username, database_id, mode, created_at) VALUES (?, ?, ?, ?)", [username, databaseId, input.mode, createdAt]);
      });
      return { username, mode: input.mode, createdAt, revoked: false, password };
    } catch (error) {
      if (!committed) await client.query("ROLLBACK").catch(() => {});
      else await client.query(`ALTER ROLE ${client.escapeIdentifier(username)} NOLOGIN`).catch(() => {});
      throw error;
    } finally { await client.end(); }
  }

  async rotate(databaseId: string, username: string, suppliedPassword?: string): Promise<{ username: string; password: string }> {
    this.require(databaseId, username);
    const password = suppliedPassword || generateDbPassword();
    this.validatePassword(password);
    const client = await this.engine.adminClient();
    try {
      await client.query(`ALTER ROLE ${client.escapeIdentifier(username)} PASSWORD ${client.escapeLiteral(password)}`);
      this.vault.set(secret(databaseId, username), password, `db:${databaseId}`);
      await client.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1 AND pid <> pg_backend_pid()", [username]);
    } finally { await client.end(); }
    return { username, password };
  }

  /** Schema replacement removes grants; restore only still-authorized accounts. */
  async reapply(databaseId: string): Promise<void> {
    const db = this.databases.require(databaseId);
    const client = await this.engine.adminClient(db.dbName);
    try {
      for (const account of this.list(databaseId).filter((account) => !account.revoked)) {
        const role = client.escapeIdentifier(account.username);
        const owner = client.escapeIdentifier(db.ownerRole);
        const privileges = account.mode === "read-only" ? "SELECT" : "SELECT, INSERT, UPDATE, DELETE";
        await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
        await client.query(`GRANT ${privileges} ON ALL TABLES IN SCHEMA public TO ${role}`);
        await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public GRANT ${privileges} ON TABLES TO ${role}`);
        if (account.mode === "read-write") {
          await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
          await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${role}`);
        }
      }
    } finally { await client.end(); }
  }

  async revoke(databaseId: string, username: string): Promise<void> {
    this.require(databaseId, username);
    const client = await this.engine.adminClient();
    try {
      // Disable rather than DROP OWNED: revoking access must never delete user data.
      await client.query(`ALTER ROLE ${client.escapeIdentifier(username)} NOLOGIN PASSWORD NULL`);
      await client.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1 AND pid <> pg_backend_pid()", [username]);
    } finally { await client.end(); }
    this.store.run("UPDATE database_connection_accounts SET revoked_at = ? WHERE database_id = ? AND username = ?", [new Date().toISOString(), databaseId, username]);
    this.vault.delete(secret(databaseId, username));
  }

  private require(databaseId: string, username: string): void {
    this.databases.require(databaseId);
    if (!this.store.get("SELECT 1 FROM database_connection_accounts WHERE database_id = ? AND username = ? AND revoked_at IS NULL", [databaseId, username])) throw NexusError.notFound("Connection account");
  }
  private validatePassword(password: string): void {
    if (password.length < 16 || password.length > 128 || password.includes("\0")) throw NexusError.invalid("Use a password between 16 and 128 characters, or leave it blank to generate one.");
  }
}
