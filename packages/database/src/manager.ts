import { randomInt } from "node:crypto";
import pg from "pg";
import { newId, NexusError, sqlIdentifier } from "@nexus/shared";
import type { SecretVault } from "@nexus/security";
import type { Migration, StateStore } from "@nexus/state";
import type { PostgresEngine } from "./postgres";

export const databaseMigrations: Migration[] = [
  {
    id: "database/001_databases",
    up: `CREATE TABLE databases (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      engine TEXT NOT NULL DEFAULT 'postgresql',
      db_name TEXT NOT NULL UNIQUE,
      owner_role TEXT NOT NULL,
      readonly_role TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE database_access (
      database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
      app_id TEXT NOT NULL,
      login_role TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (database_id, app_id)
    );`,
  },
];

const PW_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

/**
 * 32 characters from an alphabet that never needs URL-encoding or shell quoting
 * (~186 bits of entropy). Safe to drop into DATABASE_URL as-is.
 */
export function generateDbPassword(length = 32): string {
  let out = "";
  for (let i = 0; i < length; i++) out += PW_ALPHABET[randomInt(PW_ALPHABET.length)];
  return out;
}

export interface ManagedDatabase {
  id: string;
  name: string;
  engine: "postgresql";
  dbName: string;
  ownerRole: string;
  readonlyRole: string;
  createdAt: string;
  appIds: string[];
}

export interface ConnectionInfo {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  url: string;
}

const secretName = (dbId: string, appId: string) => `db:${dbId}/app:${appId}/password`;

/**
 * Provisions and manages per-application PostgreSQL databases.
 *
 * Isolation model for database "taxiops":
 *   taxiops_owner  NOLOGIN  owns the database and schema (all app tables belong to it)
 *   taxiops_ro     NOLOGIN  SELECT-only; used for Browse Data (read mode) and AI questions
 *   taxiops_<app>  LOGIN    one per connected app, member of taxiops_owner, own password
 * PUBLIC loses CONNECT on every Nexus database, so apps cannot see each other's data.
 * No app role is superuser or may create roles or databases.
 */
export class DatabaseManager {
  constructor(
    private readonly store: StateStore,
    private readonly vault: SecretVault,
    private readonly engine: PostgresEngine,
  ) {
    store.migrate(databaseMigrations);
  }

  /** One-time hardening of the cluster itself. Safe to call repeatedly. */
  async hardenCluster(): Promise<void> {
    await this.engine.adminQuery("REVOKE CONNECT ON DATABASE postgres FROM PUBLIC");
    await this.engine.adminQuery("REVOKE ALL ON SCHEMA public FROM PUBLIC", [], "postgres");
  }

  list(): ManagedDatabase[] {
    return this.store
      .all<Row>("SELECT * FROM databases ORDER BY created_at")
      .map((r) => this.toModel(r));
  }

  get(id: string): ManagedDatabase | undefined {
    const r = this.store.get<Row>("SELECT * FROM databases WHERE id = ?", [id]);
    return r ? this.toModel(r) : undefined;
  }

  require(id: string): ManagedDatabase {
    const d = this.get(id);
    if (!d) throw NexusError.notFound("Database");
    return d;
  }

  findByApp(appId: string): ManagedDatabase | undefined {
    const r = this.store.get<{ database_id: string }>("SELECT database_id FROM database_access WHERE app_id = ?", [appId]);
    return r ? this.get(r.database_id) : undefined;
  }

  /** Suggests a free database identifier for a display name ("TaxiOps" → "taxiops", then "taxiops_2"). */
  uniqueDbName(displayName: string): string {
    const base = sqlIdentifier(displayName, 40);
    const reserved = new Set(["postgres", "template0", "template1", "nexus"]);
    let candidate = reserved.has(base) ? `${base}_db` : base;
    for (let i = 2; this.store.get("SELECT 1 FROM databases WHERE db_name = ?", [candidate]); i++) candidate = `${base}_${i}`;
    return candidate;
  }

  /**
   * "Create New Database" — the only thing the user types is the name.
   * If `appId` is given, that app is connected immediately and its credentials returned.
   */
  async createDatabase(input: { displayName: string; appId?: string }): Promise<{ database: ManagedDatabase; connection: ConnectionInfo | null }> {
    const name = input.displayName.trim();
    if (!name) throw NexusError.invalid("Please give the database a name.");
    const dbName = this.uniqueDbName(name);
    const owner = `${dbName}_owner`;
    const ro = `${dbName}_ro`;
    const id = newId();

    const admin = await this.engine.adminClient();
    try {
      const qi = (s: string) => admin.escapeIdentifier(s);
      await admin.query(`CREATE ROLE ${qi(owner)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`);
      await admin.query(`CREATE ROLE ${qi(ro)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`);
      await admin.query(`CREATE DATABASE ${qi(dbName)} OWNER ${qi(owner)} ENCODING 'UTF8' TEMPLATE template0`);
      await admin.query(`REVOKE ALL ON DATABASE ${qi(dbName)} FROM PUBLIC`);
      await admin.query(`GRANT CONNECT, TEMPORARY ON DATABASE ${qi(dbName)} TO ${qi(owner)}`);
      await admin.query(`GRANT CONNECT ON DATABASE ${qi(dbName)} TO ${qi(ro)}`);
    } catch (e) {
      await admin.end();
      await this.cleanupFailedCreate(dbName, [owner, ro]);
      throw new NexusError("infrastructure", "Nexus could not create the database.", { cause: e });
    }
    await admin.end();

    const inDb = await this.engine.adminClient(dbName);
    try {
      const qi = (s: string) => inDb.escapeIdentifier(s);
      await inDb.query(`ALTER SCHEMA public OWNER TO ${qi(owner)}`);
      await inDb.query(`REVOKE ALL ON SCHEMA public FROM PUBLIC`);
      await inDb.query(`GRANT USAGE ON SCHEMA public TO ${qi(ro)}`);
      await inDb.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${qi(owner)} IN SCHEMA public GRANT SELECT ON TABLES TO ${qi(ro)}`);
      await inDb.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${qi(owner)} IN SCHEMA public GRANT SELECT ON SEQUENCES TO ${qi(ro)}`);
    } finally {
      await inDb.end();
    }

    this.store.run(
      "INSERT INTO databases (id, name, engine, db_name, owner_role, readonly_role, created_at) VALUES (?, ?, 'postgresql', ?, ?, ?, ?)",
      [id, name, dbName, owner, ro, new Date().toISOString()],
    );
    const connection = input.appId ? await this.grantAppAccess(id, input.appId) : null;
    return { database: this.require(id), connection };
  }

  /**
   * Gives an application its own login to a database ("Connect to an existing Nexus database").
   * Idempotent: an app that already has access keeps its credentials.
   */
  async grantAppAccess(databaseId: string, appId: string): Promise<ConnectionInfo> {
    const db = this.require(databaseId);
    const existing = this.store.get<{ login_role: string }>(
      "SELECT login_role FROM database_access WHERE database_id = ? AND app_id = ?",
      [databaseId, appId],
    );
    if (existing && this.vault.has(secretName(databaseId, appId))) return this.connectionInfo(databaseId, appId);

    const loginRole = existing?.login_role ?? this.uniqueRoleName(`${db.dbName}_${sqlIdentifier(appId, 20)}`);
    const password = generateDbPassword();
    const admin = await this.engine.adminClient();
    try {
      const qi = (s: string) => admin.escapeIdentifier(s);
      const exists = (await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [loginRole])).rowCount;
      const verb = exists ? "ALTER" : "CREATE";
      await admin.query(
        `${verb} ROLE ${qi(loginRole)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 100 PASSWORD ${admin.escapeLiteral(password)}`,
      );
      await admin.query(`GRANT ${qi(db.ownerRole)} TO ${qi(loginRole)}`);
      // Objects the app creates (migrations) belong to the shared owner role, not the login.
      await admin.query(`ALTER ROLE ${qi(loginRole)} IN DATABASE ${qi(db.dbName)} SET role = ${admin.escapeLiteral(db.ownerRole)}`);
    } finally {
      await admin.end();
    }
    this.vault.set(secretName(databaseId, appId), password, `app:${appId}`);
    this.store.run(
      `INSERT INTO database_access (database_id, app_id, login_role, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(database_id, app_id) DO NOTHING`,
      [databaseId, appId, loginRole, new Date().toISOString()],
    );
    return this.connectionInfo(databaseId, appId);
  }

  async revokeAppAccess(databaseId: string, appId: string): Promise<void> {
    const row = this.store.get<{ login_role: string }>(
      "SELECT login_role FROM database_access WHERE database_id = ? AND app_id = ?",
      [databaseId, appId],
    );
    if (!row) return;
    const admin = await this.engine.adminClient();
    try {
      await admin.query(`DROP ROLE IF EXISTS ${admin.escapeIdentifier(row.login_role)}`);
    } finally {
      await admin.end();
    }
    this.vault.delete(secretName(databaseId, appId));
    this.store.run("DELETE FROM database_access WHERE database_id = ? AND app_id = ?", [databaseId, appId]);
  }

  /** Connection details for an app. The password comes from the encrypted vault. */
  connectionInfo(databaseId: string, appId: string): ConnectionInfo {
    const db = this.require(databaseId);
    const row = this.store.get<{ login_role: string }>(
      "SELECT login_role FROM database_access WHERE database_id = ? AND app_id = ?",
      [databaseId, appId],
    );
    if (!row) throw NexusError.notFound("Database access for this application");
    const password = this.vault.require(secretName(databaseId, appId));
    const host = "127.0.0.1";
    const port = this.engine.port;
    return {
      host,
      port,
      database: db.dbName,
      user: row.login_role,
      password,
      url: `postgresql://${encodeURIComponent(row.login_role)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(db.dbName)}`,
    };
  }

  /** Issues a new password (used by "Repair Connection" and routine rotation). */
  async rotatePassword(databaseId: string, appId: string): Promise<ConnectionInfo> {
    const info = this.connectionInfo(databaseId, appId);
    const password = generateDbPassword();
    const admin = await this.engine.adminClient();
    try {
      await admin.query(`ALTER ROLE ${admin.escapeIdentifier(info.user)} PASSWORD ${admin.escapeLiteral(password)}`);
    } finally {
      await admin.end();
    }
    this.vault.set(secretName(databaseId, appId), password, `app:${appId}`);
    return this.connectionInfo(databaseId, appId);
  }

  /** Connects exactly as the application would. */
  async testConnection(info: ConnectionInfo): Promise<{ ok: true } | { ok: false; error: string }> {
    const c = new pg.Client({ connectionString: info.url, connectionTimeoutMillis: 5000 });
    try {
      await c.connect();
      await c.query("SELECT 1");
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    } finally {
      await c.end().catch(() => {});
    }
  }

  /**
   * Permanently deletes a database. Callers must obtain explicit user confirmation
   * (typing the name); the AI permission engine never allows this.
   */
  async dropDatabase(databaseId: string, confirmation: string): Promise<void> {
    const db = this.require(databaseId);
    if (confirmation !== db.name && confirmation !== db.dbName) {
      throw NexusError.invalid(`Type "${db.name}" to confirm deleting this database.`);
    }
    const access = this.store.all<{ app_id: string; login_role: string }>(
      "SELECT app_id, login_role FROM database_access WHERE database_id = ?",
      [databaseId],
    );
    const admin = await this.engine.adminClient();
    try {
      const qi = (s: string) => admin.escapeIdentifier(s);
      await admin.query(`DROP DATABASE IF EXISTS ${qi(db.dbName)} WITH (FORCE)`);
      for (const a of access) await admin.query(`DROP ROLE IF EXISTS ${qi(a.login_role)}`);
      await admin.query(`DROP ROLE IF EXISTS ${qi(db.readonlyRole)}`);
      await admin.query(`DROP ROLE IF EXISTS ${qi(db.ownerRole)}`);
    } finally {
      await admin.end();
    }
    for (const a of access) this.vault.delete(secretName(databaseId, a.app_id));
    this.store.run("DELETE FROM databases WHERE id = ?", [databaseId]);
  }

  /**
   * Runs `fn` with a connection restricted to the read-only role (Browse Data, AI questions).
   * The session is also marked read-only so even functions with side effects are refused.
   */
  async withReadOnly<T>(databaseId: string, fn: (c: pg.Client) => Promise<T>, statementTimeoutMs = 15_000): Promise<T> {
    const db = this.require(databaseId);
    const c = await this.engine.adminClient(db.dbName);
    try {
      await c.query("BEGIN READ ONLY");
      await c.query(`SET LOCAL ROLE ${c.escapeIdentifier(db.readonlyRole)}`);
      await c.query(`SET LOCAL statement_timeout = ${Math.floor(statementTimeoutMs)}`);
      const result = await fn(c);
      await c.query("ROLLBACK");
      return result;
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      await c.end();
    }
  }

  /** Connection acting as the owner role (Browse Data edit mode, imports, migrations). */
  async withOwner<T>(databaseId: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const db = this.require(databaseId);
    const c = await this.engine.adminClient(db.dbName);
    try {
      await c.query(`SET ROLE ${c.escapeIdentifier(db.ownerRole)}`);
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  private uniqueRoleName(base: string): string {
    let name = base.slice(0, 60);
    for (let i = 2; this.store.get("SELECT 1 FROM database_access WHERE login_role = ?", [name]); i++) name = `${base.slice(0, 56)}_${i}`;
    return name;
  }

  private async cleanupFailedCreate(dbName: string, roles: string[]): Promise<void> {
    const admin = await this.engine.adminClient().catch(() => null);
    if (!admin) return;
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(dbName)}`).catch(() => {});
      for (const r of roles) await admin.query(`DROP ROLE IF EXISTS ${admin.escapeIdentifier(r)}`).catch(() => {});
    } finally {
      await admin.end();
    }
  }

  private toModel(r: Row): ManagedDatabase {
    return {
      id: r.id,
      name: r.name,
      engine: "postgresql",
      dbName: r.db_name,
      ownerRole: r.owner_role,
      readonlyRole: r.readonly_role,
      createdAt: r.created_at,
      appIds: this.store.all<{ app_id: string }>("SELECT app_id FROM database_access WHERE database_id = ?", [r.id]).map((x) => x.app_id),
    };
  }
}

interface Row {
  id: string;
  name: string;
  db_name: string;
  owner_role: string;
  readonly_role: string;
  created_at: string;
}
