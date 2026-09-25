import { MongoClient } from "mongodb";
import { newId, NexusError, sqlIdentifier } from "@nexus/shared";
import type { SecretVault } from "@nexus/security";
import type { Migration, StateStore } from "@nexus/state";
import type { DocumentEngine } from "./ferretdb";
import { generateDbPassword, type ConnectionInfo } from "./manager";
import type { PostgresEngine } from "./postgres";

export const documentDatabaseMigrations: Migration[] = [
  {
    id: "documents/001_document_databases",
    // Kept for installations that tried the earlier MongoDB-based engine; no longer used.
    up: `CREATE TABLE document_databases (id TEXT PRIMARY KEY, name TEXT NOT NULL, engine TEXT NOT NULL DEFAULT 'mongodb', db_name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
    CREATE TABLE document_database_access (database_id TEXT NOT NULL REFERENCES document_databases(id) ON DELETE CASCADE, app_id TEXT NOT NULL, username TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, PRIMARY KEY (database_id, app_id));`,
  },
  {
    id: "documents/002_ferretdb",
    up: `CREATE TABLE docdb_databases (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      db_name TEXT NOT NULL UNIQUE,
      pg_database TEXT NOT NULL UNIQUE,
      owner_role TEXT NOT NULL,
      port INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE docdb_access (
      database_id TEXT NOT NULL REFERENCES docdb_databases(id) ON DELETE CASCADE,
      app_id TEXT NOT NULL,
      login_role TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (database_id, app_id)
    );`,
  },
];

export interface ManagedDocumentDatabase {
  id: string;
  name: string;
  /** Apps speak the MongoDB protocol to it. */
  engine: "mongodb";
  /** The database name apps use in their mongodb:// address. */
  dbName: string;
  appIds: string[];
  createdAt: string;
}

/** Nexus's own login on each document database (browsing, import/export, backups). */
const NEXUS_ACCESS = "__nexus";
const MARKER = "_nexus";
const secretName = (dbId: string, appId: string) => `docdb:${dbId}/app:${appId}/password`;
const RESERVED = new Set(["admin", "local", "config", "nexus", "public"]);

export interface PortReservations {
  allocate(owner: string, purpose: string): Promise<number>;
  ensureAvailable(owner: string, purpose: string): Promise<{ port: number; changedFrom: number | null }>;
  release(owner: string, purpose?: string): void;
}

interface Row {
  id: string;
  name: string;
  db_name: string;
  pg_database: string;
  owner_role: string;
  port: number;
  created_at: string;
}

/**
 * Document (MongoDB-compatible) databases, stored in the managed PostgreSQL through FerretDB.
 *
 * Isolation model for document database "shop":
 *   PostgreSQL database docs_shop, owned by the NOLOGIN role docs_shop_owner;
 *   each connected app has its own login (member of the owner role, whose session runs as the owner);
 *   PUBLIC has no access, so one app can never read, change or even list another app's data;
 *   a separate FerretDB process serves only this database, on its own private port.
 */
export class DocumentDatabaseManager {
  constructor(
    private readonly store: StateStore,
    private readonly vault: SecretVault,
    private readonly pg: PostgresEngine,
    private readonly engine: DocumentEngine,
    private readonly ports: PortReservations,
  ) {
    store.migrate(documentDatabaseMigrations);
  }

  get version(): string {
    return this.engine.version;
  }

  list(): ManagedDocumentDatabase[] {
    return this.store.all<Row>("SELECT * FROM docdb_databases ORDER BY created_at").map((r) => this.toModel(r));
  }

  get(id: string): ManagedDocumentDatabase | undefined {
    const r = this.row(id);
    return r ? this.toModel(r) : undefined;
  }

  require(id: string): ManagedDocumentDatabase {
    const d = this.get(id);
    if (!d) throw NexusError.notFound("Document database");
    return d;
  }

  findByApp(appId: string): ManagedDocumentDatabase | undefined {
    const r = this.store.get<{ database_id: string }>("SELECT database_id FROM docdb_access WHERE app_id = ?", [appId]);
    return r ? this.get(r.database_id) : undefined;
  }

  uniqueDbName(displayName: string): string {
    const base = sqlIdentifier(displayName, 40);
    let candidate = RESERVED.has(base) ? `${base}_db` : base;
    for (let i = 2; this.store.get("SELECT 1 FROM docdb_databases WHERE db_name = ?", [candidate]); i++) candidate = `${base}_${i}`;
    return candidate;
  }

  /** "Create Document Database" — the only thing the user types is the name. */
  async createDatabase(input: { displayName: string; appId?: string }): Promise<{ database: ManagedDocumentDatabase; connection: ConnectionInfo | null }> {
    const name = input.displayName.trim();
    if (!name) throw NexusError.invalid("Please give the database a name.");
    const dbName = this.uniqueDbName(name);
    const pgDatabase = `docs_${dbName}`;
    const owner = `${pgDatabase}_owner`;
    const admin = await this.pg.adminClient();
    try {
      const qi = (s: string) => admin.escapeIdentifier(s);
      await admin.query(`CREATE ROLE ${qi(owner)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`);
      await admin.query(`CREATE DATABASE ${qi(pgDatabase)} OWNER ${qi(owner)} ENCODING 'UTF8' TEMPLATE template0`);
      await admin.query(`REVOKE ALL ON DATABASE ${qi(pgDatabase)} FROM PUBLIC`);
    } catch (e) {
      await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(pgDatabase)}`).catch(() => undefined);
      await admin.query(`DROP ROLE IF EXISTS ${admin.escapeIdentifier(owner)}`).catch(() => undefined);
      throw new NexusError("infrastructure", "Nexus could not create the document database.", { cause: e });
    } finally {
      await admin.end();
    }
    const inDb = await this.pg.adminClient(pgDatabase);
    try {
      await inDb.query(`REVOKE ALL ON SCHEMA public FROM PUBLIC`);
      await inDb.query(`ALTER SCHEMA public OWNER TO ${inDb.escapeIdentifier(owner)}`);
    } finally {
      await inDb.end();
    }
    const port = await this.ports.allocate("ferretdb", pgDatabase);
    const id = newId();
    this.store.run("INSERT INTO docdb_databases (id, name, db_name, pg_database, owner_role, port, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [
      id,
      name,
      dbName,
      pgDatabase,
      owner,
      port,
      new Date().toISOString(),
    ]);
    // A marker collection makes the (otherwise empty) database visible to MongoDB tools.
    await this.withDatabase(id, async (c, db) => {
      await c.db(db).collection(MARKER).insertOne({ _id: "database" as never, createdBy: "nexus", name, createdAt: new Date() });
    });
    const connection = input.appId ? await this.grantAppAccess(id, input.appId) : null;
    return { database: this.require(id), connection };
  }

  /** Gives an application its own login to a document database. Idempotent. */
  async grantAppAccess(databaseId: string, appId: string): Promise<ConnectionInfo> {
    const db = this.requireRow(databaseId);
    const existing = this.store.get<{ login_role: string }>("SELECT login_role FROM docdb_access WHERE database_id = ? AND app_id = ?", [databaseId, appId]);
    if (existing && this.vault.has(secretName(databaseId, appId))) return this.connectionInfo(databaseId, appId);
    const login = existing?.login_role ?? this.uniqueLogin(`d_${db.db_name.slice(0, 30)}_${appId === NEXUS_ACCESS ? "nexus" : sqlIdentifier(appId, 20)}`);
    const password = generateDbPassword();
    const admin = await this.pg.adminClient();
    try {
      const qi = (s: string) => admin.escapeIdentifier(s);
      const exists = (await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [login])).rowCount;
      await admin.query(`${exists ? "ALTER" : "CREATE"} ROLE ${qi(login)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 100 PASSWORD ${admin.escapeLiteral(password)}`);
      await admin.query(`GRANT ${qi(db.owner_role)} TO ${qi(login)}`);
      // Everything the app creates belongs to the shared owner role, so apps sharing a database see the same data.
      await admin.query(`ALTER ROLE ${qi(login)} IN DATABASE ${qi(db.pg_database)} SET role = ${admin.escapeLiteral(db.owner_role)}`);
    } finally {
      await admin.end();
    }
    this.vault.set(secretName(databaseId, appId), password, appId === NEXUS_ACCESS ? "system" : `app:${appId}`);
    this.store.run(`INSERT INTO docdb_access (database_id, app_id, login_role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(database_id, app_id) DO NOTHING`, [
      databaseId,
      appId,
      login,
      new Date().toISOString(),
    ]);
    return this.connectionInfo(databaseId, appId);
  }

  async revokeAppAccess(databaseId: string, appId: string): Promise<void> {
    const row = this.store.get<{ login_role: string }>("SELECT login_role FROM docdb_access WHERE database_id = ? AND app_id = ?", [databaseId, appId]);
    if (!row) return;
    const db = this.requireRow(databaseId);
    await this.engine.stopOne(db.pg_database);
    await this.pg.adminQuery("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1", [row.login_role]);
    await this.pg.adminQuery(`DROP ROLE IF EXISTS "${row.login_role.replace(/"/g, '""')}"`);
    this.vault.delete(secretName(databaseId, appId));
    this.store.run("DELETE FROM docdb_access WHERE database_id = ? AND app_id = ?", [databaseId, appId]);
    await this.dropPooledLogins(databaseId);
  }

  /** Connection details for an app. The mongodb:// URL works with mongoose, the Node driver, PyMongo and Motor. */
  connectionInfo(databaseId: string, appId: string): ConnectionInfo {
    const db = this.requireRow(databaseId);
    const row = this.store.get<{ login_role: string }>("SELECT login_role FROM docdb_access WHERE database_id = ? AND app_id = ?", [databaseId, appId]);
    if (!row) throw NexusError.notFound("Document database access for this application");
    const password = this.vault.require(secretName(databaseId, appId));
    const host = "127.0.0.1";
    return {
      host,
      port: db.port,
      database: db.db_name,
      user: row.login_role,
      password,
      // PLAIN: FerretDB hands the credentials to PostgreSQL, which checks them. Loopback only.
      url: `mongodb://${encodeURIComponent(row.login_role)}:${encodeURIComponent(password)}@${host}:${db.port}/${encodeURIComponent(db.db_name)}?authMechanism=PLAIN&authSource=%24external&directConnection=true`,
    };
  }

  /** Starts this database's endpoint if needed (moving it if another program took its port). */
  async ensureRunning(databaseId: string): Promise<void> {
    const db = this.requireRow(databaseId);
    try {
      await this.engine.ensure(db.pg_database, db.port);
    } catch (e) {
      const moved = await this.ports.ensureAvailable("ferretdb", db.pg_database);
      if (moved.changedFrom === null) throw e;
      this.store.run("UPDATE docdb_databases SET port = ? WHERE id = ?", [moved.port, databaseId]);
      await this.engine.ensure(db.pg_database, moved.port);
    }
  }

  /** Starts the endpoints of every database an application uses. */
  async ensureAllInUse(): Promise<void> {
    for (const d of this.list().filter((x) => x.appIds.length)) await this.ensureRunning(d.id);
  }

  /** Issues a new password (used by "Repair Connection"). */
  async rotatePassword(databaseId: string, appId: string): Promise<ConnectionInfo> {
    const info = this.connectionInfo(databaseId, appId);
    const password = generateDbPassword();
    await this.pg.adminQuery(`ALTER ROLE "${info.user.replace(/"/g, '""')}" PASSWORD '${password}'`);
    this.vault.set(secretName(databaseId, appId), password, `app:${appId}`);
    await this.dropPooledLogins(databaseId);
    return this.connectionInfo(databaseId, appId);
  }

  /**
   * FerretDB keeps PostgreSQL connections per login; after a password change or a removed login,
   * its endpoint restarts so the old credentials stop working at once. Drivers reconnect by themselves.
   */
  private async dropPooledLogins(databaseId: string): Promise<void> {
    const db = this.requireRow(databaseId);
    if (!this.engine.running().includes(db.pg_database)) return;
    await this.engine.stopOne(db.pg_database);
    await this.ensureRunning(databaseId);
  }

  /** Connects exactly as the application would. */
  async testConnection(info: ConnectionInfo): Promise<{ ok: true } | { ok: false; error: string }> {
    const row = this.store.get<Row>("SELECT * FROM docdb_databases WHERE port = ? AND db_name = ?", [info.port, info.database]);
    const c = new MongoClient(info.url, { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000 });
    try {
      if (row) await this.ensureRunning(row.id);
      await c.connect();
      await c.db(info.database).listCollections({}, { nameOnly: true }).toArray();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    } finally {
      await c.close().catch(() => {});
    }
  }

  /** Permanently deletes a document database. Callers must obtain typed confirmation. */
  async dropDatabase(databaseId: string, confirmation: string): Promise<void> {
    const db = this.requireRow(databaseId);
    if (confirmation !== db.name && confirmation !== db.db_name) throw NexusError.invalid(`Type "${db.name}" to confirm deleting this database.`);
    await this.engine.stopOne(db.pg_database);
    const access = this.store.all<{ app_id: string; login_role: string }>("SELECT app_id, login_role FROM docdb_access WHERE database_id = ?", [databaseId]);
    const admin = await this.pg.adminClient();
    try {
      const qi = (s: string) => admin.escapeIdentifier(s);
      await admin.query(`DROP DATABASE IF EXISTS ${qi(db.pg_database)} WITH (FORCE)`);
      for (const a of access) await admin.query(`DROP ROLE IF EXISTS ${qi(a.login_role)}`);
      await admin.query(`DROP ROLE IF EXISTS ${qi(db.owner_role)}`);
    } finally {
      await admin.end();
    }
    for (const a of access) this.vault.delete(secretName(databaseId, a.app_id));
    this.ports.release("ferretdb", db.pg_database);
    this.store.run("DELETE FROM docdb_databases WHERE id = ?", [databaseId]);
  }

  /** A connection as Nexus (browsing, import/export, backups); the caller must close it. */
  async openClient(databaseId: string): Promise<MongoClient> {
    await this.ensureRunning(databaseId);
    const info = await this.grantAppAccess(databaseId, NEXUS_ACCESS);
    const c = new MongoClient(info.url, { serverSelectionTimeoutMS: 10_000, connectTimeoutMS: 5000, appName: "nexus" });
    await c.connect();
    return c;
  }

  /** Runs `fn` with Nexus's connection to one document database. */
  async withDatabase<T>(databaseId: string, fn: (c: MongoClient, dbName: string) => Promise<T>): Promise<T> {
    const db = this.require(databaseId);
    const c = await this.openClient(databaseId);
    try {
      return await fn(c, db.dbName);
    } finally {
      await c.close();
    }
  }

  private row(id: string): Row | undefined {
    return this.store.get<Row>("SELECT * FROM docdb_databases WHERE id = ?", [id]);
  }

  private requireRow(id: string): Row {
    const r = this.row(id);
    if (!r) throw NexusError.notFound("Document database");
    return r;
  }

  private uniqueLogin(base: string): string {
    let name = base.slice(0, 60);
    for (let i = 2; this.store.get("SELECT 1 FROM docdb_access WHERE login_role = ?", [name]); i++) name = `${base.slice(0, 56)}_${i}`;
    return name;
  }

  private toModel(r: Row): ManagedDocumentDatabase {
    return {
      id: r.id,
      name: r.name,
      engine: "mongodb",
      dbName: r.db_name,
      createdAt: r.created_at,
      appIds: this.store.all<{ app_id: string }>("SELECT app_id FROM docdb_access WHERE database_id = ? AND app_id != ?", [r.id, NEXUS_ACCESS]).map((x) => x.app_id),
    };
  }
}
