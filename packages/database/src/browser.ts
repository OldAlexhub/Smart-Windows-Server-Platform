import type pg from "pg";
import { NexusError } from "@nexus/shared";
import type { DatabaseManager } from "./manager";
import type { PostgresEngine } from "./postgres";

// ------------------------------------------------------------------ stats

export interface DatabaseStats {
  sizeBytes: number;
  tableCount: number;
  connectionCount: number;
  status: "healthy" | "offline";
}

export async function databaseStats(engine: PostgresEngine, dbName: string): Promise<DatabaseStats> {
  try {
    const [row] = await engine.adminQuery<{ size: string; conns: number }>(
      `SELECT pg_database_size($1)::text AS size,
              (SELECT count(*)::int FROM pg_stat_activity WHERE datname = $1) AS conns`,
      [dbName],
    );
    const [t] = await engine.adminQuery<{ n: number }>(
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
      [],
      dbName,
    );
    return { sizeBytes: Number(row!.size), tableCount: t!.n, connectionCount: row!.conns, status: "healthy" };
  } catch {
    return { sizeBytes: 0, tableCount: 0, connectionCount: 0, status: "offline" };
  }
}

// ------------------------------------------------------------------ browser

export interface TableSummary {
  name: string;
  rowEstimate: number;
  sizeBytes: number;
  columnCount: number;
  editable: boolean;
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  hasDefault: boolean;
  primaryKey: boolean;
}

export interface TableInfo {
  name: string;
  columns: ColumnInfo[];
  primaryKey: string[];
  /** Rows can only be edited safely when they can be identified by a primary key. */
  editable: boolean;
}

export type FilterOp = "eq" | "neq" | "lt" | "lte" | "gt" | "gte" | "contains" | "starts" | "is_null" | "not_null";

export interface Filter {
  column: string;
  op: FilterOp;
  value?: string | number | boolean | null;
}

export interface BrowseQuery {
  page?: number;
  pageSize?: number;
  sort?: { column: string; direction: "asc" | "desc" };
  search?: string;
  filters?: Filter[];
}

export interface BrowseResult {
  table: TableInfo;
  rows: Record<string, unknown>[];
  total: number;
  page: number;
  pageSize: number;
}

const OPS: Record<Exclude<FilterOp, "is_null" | "not_null" | "contains" | "starts">, string> = {
  eq: "=",
  neq: "<>",
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
};

/**
 * Spreadsheet-style access to an app's tables without SQL.
 * Every table/column name is validated against the live schema before use (no injection),
 * values are always parameters, reads use the read-only role, writes the owner role.
 */
export class DataBrowser {
  constructor(private readonly dbs: DatabaseManager) {}

  async listTables(databaseId: string): Promise<TableSummary[]> {
    return this.dbs.withReadOnly(databaseId, async (c) => {
      const r = await c.query<{ name: string; est: string; size: string; cols: number; pk: boolean }>(`
        SELECT c.relname AS name,
               GREATEST(c.reltuples, 0)::bigint::text AS est,
               pg_total_relation_size(c.oid)::text AS size,
               (SELECT count(*)::int FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS cols,
               EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary) AS pk
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        ORDER BY c.relname`);
      return r.rows.map((x) => ({ name: x.name, rowEstimate: Number(x.est), sizeBytes: Number(x.size), columnCount: x.cols, editable: x.pk }));
    });
  }

  async describe(databaseId: string, table: string): Promise<TableInfo> {
    return this.dbs.withReadOnly(databaseId, (c) => describeTable(c, table));
  }

  async browse(databaseId: string, table: string, q: BrowseQuery = {}): Promise<BrowseResult> {
    return this.dbs.withReadOnly(databaseId, async (c) => {
      const info = await describeTable(c, table);
      const { where, params } = buildWhere(info, q, c);
      const pageSize = Math.min(Math.max(q.pageSize ?? 50, 1), 500);
      const page = Math.max(q.page ?? 1, 1);
      const order = q.sort
        ? `ORDER BY ${c.escapeIdentifier(col(info, q.sort.column).name)} ${q.sort.direction === "desc" ? "DESC" : "ASC"} NULLS LAST`
        : info.primaryKey.length
          ? `ORDER BY ${info.primaryKey.map((k) => c.escapeIdentifier(k)).join(", ")}`
          : "";
      const from = `FROM public.${c.escapeIdentifier(info.name)} ${where}`;
      const total = Number((await c.query<{ n: string }>(`SELECT count(*)::text AS n ${from}`, params)).rows[0]!.n);
      const rows = (await c.query(`SELECT * ${from} ${order} LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, params)).rows;
      return { table: info, rows, total, page, pageSize };
    });
  }

  async insertRow(databaseId: string, table: string, values: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.dbs.withOwner(databaseId, async (c) => {
      const info = await describeTable(c, table);
      const cols = Object.keys(values).map((k) => col(info, k).name);
      if (cols.length === 0) {
        return (await c.query(`INSERT INTO public.${c.escapeIdentifier(info.name)} DEFAULT VALUES RETURNING *`)).rows[0];
      }
      const sql = `INSERT INTO public.${c.escapeIdentifier(info.name)} (${cols.map((x) => c.escapeIdentifier(x)).join(", ")})
                   VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`;
      return (await c.query(sql, cols.map((k) => values[k]))).rows[0];
    });
  }

  async updateRow(databaseId: string, table: string, key: Record<string, unknown>, changes: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.dbs.withOwner(databaseId, async (c) => {
      const info = await describeTable(c, table);
      const where = keyWhere(info, key, c, Object.keys(changes).length);
      const sets = Object.keys(changes).map((k, i) => `${c.escapeIdentifier(col(info, k).name)} = $${i + 1}`);
      if (sets.length === 0) throw NexusError.invalid("Nothing to change.");
      const sql = `UPDATE public.${c.escapeIdentifier(info.name)} SET ${sets.join(", ")} WHERE ${where.sql} RETURNING *`;
      const r = await c.query(sql, [...Object.values(changes), ...where.params]);
      if (r.rowCount !== 1) throw NexusError.notFound("That record");
      return r.rows[0];
    });
  }

  /** Deleting requires explicit confirmation in the UI/API layer; this only ever deletes one row by key. */
  async deleteRow(databaseId: string, table: string, key: Record<string, unknown>): Promise<void> {
    await this.dbs.withOwner(databaseId, async (c) => {
      const info = await describeTable(c, table);
      const where = keyWhere(info, key, c, 0);
      const r = await c.query(`DELETE FROM public.${c.escapeIdentifier(info.name)} WHERE ${where.sql}`, where.params);
      if (r.rowCount !== 1) throw NexusError.notFound("That record");
    });
  }

  /** CSV export of the current view (search/filters/sort applied), streamed in pages. */
  async *exportCsv(databaseId: string, table: string, q: BrowseQuery = {}, maxRows = 1_000_000): AsyncGenerator<string> {
    let page = 1;
    let sent = 0;
    let header = false;
    for (;;) {
      const r = await this.browse(databaseId, table, { ...q, page, pageSize: 500 });
      if (!header) {
        yield r.table.columns.map((x) => csvCell(x.name)).join(",") + "\r\n";
        header = true;
      }
      for (const row of r.rows) {
        yield r.table.columns.map((x) => csvCell(row[x.name])).join(",") + "\r\n";
        if (++sent >= maxRows) return;
      }
      if (r.rows.length < 500) return;
      page++;
    }
  }
}

export async function describeTable(c: pg.Client, table: string): Promise<TableInfo> {
  const r = await c.query<{ name: string; type: string; nullable: boolean; hasdefault: boolean; pk: boolean }>(
    `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
            a.atthasdef AS hasdefault,
            COALESCE(a.attnum = ANY (i.indkey), false) AS pk
     FROM pg_class cl
     JOIN pg_namespace n ON n.oid = cl.relnamespace AND n.nspname = 'public'
     JOIN pg_attribute a ON a.attrelid = cl.oid AND a.attnum > 0 AND NOT a.attisdropped
     LEFT JOIN pg_index i ON i.indrelid = cl.oid AND i.indisprimary
     WHERE cl.relname = $1 AND cl.relkind IN ('r', 'p')
     ORDER BY a.attnum`,
    [table],
  );
  if (r.rows.length === 0) throw NexusError.notFound(`Table "${table}"`);
  const columns = r.rows.map((x) => ({ name: x.name, type: x.type, nullable: x.nullable, hasDefault: x.hasdefault, primaryKey: x.pk }));
  const primaryKey = columns.filter((x) => x.primaryKey).map((x) => x.name);
  return { name: table, columns, primaryKey, editable: primaryKey.length > 0 };
}

function col(info: TableInfo, name: string): ColumnInfo {
  const c = info.columns.find((x) => x.name === name);
  if (!c) throw NexusError.invalid(`"${info.name}" has no column called "${name}".`);
  return c;
}

const TEXTUAL = /^(text|character|character varying|varchar|citext|uuid|json|jsonb|name)/;

function buildWhere(info: TableInfo, q: BrowseQuery, c: pg.Client): { where: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (q.search?.trim()) {
    const term = p(`%${q.search.trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    // Search every column as text: names, numbers, dates, IDs all match what the user sees.
    const ors = info.columns.map((x) => `${c.escapeIdentifier(x.name)}::text ILIKE ${term}`);
    parts.push(`(${ors.join(" OR ")})`);
  }
  for (const f of q.filters ?? []) {
    const column = col(info, f.column);
    const id = c.escapeIdentifier(column.name);
    switch (f.op) {
      case "is_null":
        parts.push(`${id} IS NULL`);
        break;
      case "not_null":
        parts.push(`${id} IS NOT NULL`);
        break;
      case "contains":
        parts.push(`${id}::text ILIKE ${p(`%${String(f.value ?? "")}%`)}`);
        break;
      case "starts":
        parts.push(`${id}::text ILIKE ${p(`${String(f.value ?? "")}%`)}`);
        break;
      default: {
        const op = OPS[f.op];
        if (!op) throw NexusError.invalid(`Unknown filter "${f.op}".`);
        // Compare text columns as text, everything else via the column's own type.
        parts.push(TEXTUAL.test(column.type) ? `${id} ${op} ${p(f.value)}` : `${id} ${op} ${p(f.value)}::${column.type.replace(/[^a-z0-9 ()_,[\]]/gi, "")}`);
      }
    }
  }
  return { where: parts.length ? `WHERE ${parts.join(" AND ")}` : "", params };
}

function keyWhere(info: TableInfo, key: Record<string, unknown>, c: pg.Client, offset: number): { sql: string; params: unknown[] } {
  if (!info.editable) throw NexusError.invalid(`Records in "${info.name}" can't be edited here because the table has no primary key.`);
  const missing = info.primaryKey.filter((k) => !(k in key));
  if (missing.length) throw NexusError.invalid(`Missing ${missing.join(", ")} to identify the record.`);
  return {
    sql: info.primaryKey.map((k, i) => `${c.escapeIdentifier(k)} = $${offset + i + 1}`).join(" AND "),
    params: info.primaryKey.map((k) => key[k]),
  };
}

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
  // Neutralise spreadsheet formula injection.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
