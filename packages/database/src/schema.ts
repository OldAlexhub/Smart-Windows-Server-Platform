import type pg from "pg";
import { NexusError } from "@nexus/shared";

/**
 * The table designer: a table described as a list of columns in plain words, turned into safe SQL.
 * Also reads a database's structure back (tables, keys, links, indexes) for the blueprint.
 */

export type ColumnKind = "auto_id" | "text" | "short_text" | "integer" | "big_integer" | "decimal" | "money" | "boolean" | "date" | "timestamp" | "time" | "uuid" | "json" | "email" | "url";

export const COLUMN_KINDS: { id: ColumnKind; label: string; sql: string; hint: string }[] = [
  { id: "auto_id", label: "Auto number (ID)", sql: "bigint GENERATED ALWAYS AS IDENTITY", hint: "1, 2, 3… filled in automatically. The usual primary key." },
  { id: "text", label: "Text", sql: "text", hint: "Any length: names, descriptions, notes." },
  { id: "short_text", label: "Short text (up to 255)", sql: "varchar(255)", hint: "Codes, titles, short labels." },
  { id: "email", label: "Email address", sql: "text", hint: "Text that must look like an email address." },
  { id: "url", label: "Web address", sql: "text", hint: "Text that must start with http:// or https://." },
  { id: "integer", label: "Whole number", sql: "integer", hint: "Counts, quantities (up to about 2 billion)." },
  { id: "big_integer", label: "Big whole number", sql: "bigint", hint: "Very large whole numbers, or links to an Auto number ID." },
  { id: "decimal", label: "Decimal number", sql: "numeric", hint: "Exact decimals: measurements, rates." },
  { id: "money", label: "Money", sql: "numeric(14,2)", hint: "Amounts with 2 decimals, stored exactly." },
  { id: "boolean", label: "Yes / no", sql: "boolean", hint: "True or false." },
  { id: "date", label: "Date", sql: "date", hint: "A calendar day." },
  { id: "timestamp", label: "Date and time", sql: "timestamptz", hint: "A moment in time (time zone aware)." },
  { id: "time", label: "Time of day", sql: "time", hint: "Like 14:30." },
  { id: "uuid", label: "Unique code (UUID)", sql: "uuid", hint: "A random unique identifier." },
  { id: "json", label: "JSON (flexible data)", sql: "jsonb", hint: "Nested or changing data." },
];

export interface ColumnDesign {
  name: string;
  kind: ColumnKind;
  required?: boolean;
  unique?: boolean;
  primaryKey?: boolean;
  /** "now", "today", "new_uuid", "true"/"false", a number, or any text (stored as a literal). */
  default?: string | null;
  references?: { table: string; column: string; onDelete?: "restrict" | "cascade" | "set_null" } | null;
  description?: string | null;
}

export interface TableDesign {
  name: string;
  description?: string | null;
  columns: ColumnDesign[];
  indexes?: { columns: string[]; unique?: boolean }[];
}

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
const RESERVED = new Set(["user", "order", "group", "table", "select", "where", "from", "to", "column", "check", "default", "primary", "references", "limit", "offset", "desc", "asc", "all", "and", "or", "not", "null", "true", "false", "end", "case", "when", "grant", "role"]);

const qi = (s: string) => `"${s.replace(/"/g, '""')}"`;
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

function checkName(label: string, name: string): void {
  if (!IDENT.test(name)) throw NexusError.invalid(`${label} "${name}": use lowercase letters, numbers and underscores, starting with a letter (e.g. customer_name).`);
}

function defaultSql(c: ColumnDesign): string | null {
  const d = c.default?.trim();
  if (!d) return null;
  const lower = d.toLowerCase();
  if (c.kind === "auto_id") throw NexusError.invalid(`${c.name}: an Auto number fills itself in; remove its default.`);
  if (lower === "now") {
    if (c.kind === "timestamp") return "now()";
    if (c.kind === "date") return "CURRENT_DATE";
    if (c.kind === "time") return "CURRENT_TIME";
  }
  if (lower === "today" && c.kind === "date") return "CURRENT_DATE";
  if (lower === "new_uuid" && c.kind === "uuid") return "gen_random_uuid()";
  if (c.kind === "boolean") {
    if (["true", "yes"].includes(lower)) return "true";
    if (["false", "no"].includes(lower)) return "false";
    throw NexusError.invalid(`${c.name}: the default for Yes / no must be yes or no.`);
  }
  if (["integer", "big_integer", "decimal", "money"].includes(c.kind)) {
    if (!/^-?\d+(\.\d+)?$/.test(d)) throw NexusError.invalid(`${c.name}: the default must be a number.`);
    if ((c.kind === "integer" || c.kind === "big_integer") && d.includes(".")) throw NexusError.invalid(`${c.name}: the default must be a whole number.`);
    return d;
  }
  if (c.kind === "json") {
    try {
      JSON.parse(d);
    } catch {
      throw NexusError.invalid(`${c.name}: the default must be valid JSON, like {} or [].`);
    }
    return `${lit(d)}::jsonb`;
  }
  if (["date", "timestamp", "time", "uuid"].includes(c.kind)) return lit(d); // PostgreSQL validates it
  return lit(d);
}

/** Checks a design and turns it into one CREATE TABLE (+ indexes, comments). Throws plain-language errors. */
export function buildCreateTable(design: TableDesign, existingTables: string[] = []): string {
  const table = design.name.trim().toLowerCase();
  checkName("Table name", table);
  if (existingTables.includes(table)) throw NexusError.conflict(`A table called ${table} already exists.`);
  if (!design.columns.length) throw NexusError.invalid("Add at least one column.");
  const names = new Set<string>();
  for (const c of design.columns) {
    c.name = c.name.trim().toLowerCase();
    checkName("Column name", c.name);
    if (names.has(c.name)) throw NexusError.invalid(`There are two columns called ${c.name}.`);
    names.add(c.name);
    if (!COLUMN_KINDS.some((k) => k.id === c.kind)) throw NexusError.invalid(`${c.name}: unknown type.`);
  }
  const pk = design.columns.filter((c) => c.primaryKey || c.kind === "auto_id");
  if (!pk.length) throw NexusError.invalid("Choose a key column (tick Key), or add an Auto number ID — it lets Nexus and your apps find each row.");
  if (design.columns.filter((c) => c.kind === "auto_id").length > 1) throw NexusError.invalid("A table can have only one Auto number column.");

  const lines: string[] = [];
  const checks: string[] = [];
  for (const c of design.columns) {
    const kind = COLUMN_KINDS.find((k) => k.id === c.kind)!;
    const parts = [qi(c.name), kind.sql];
    const isPk = pk.includes(c);
    if (c.required || isPk) parts.push("NOT NULL");
    const def = defaultSql(c);
    if (def) parts.push(`DEFAULT ${def}`);
    if (c.unique && !isPk) parts.push("UNIQUE");
    if (c.references) {
      const ref = c.references;
      checkName("Linked table", ref.table);
      checkName("Linked column", ref.column);
      const onDelete = ref.onDelete === "cascade" ? "CASCADE" : ref.onDelete === "set_null" ? "SET NULL" : "RESTRICT";
      if (onDelete === "SET NULL" && (c.required || isPk)) throw NexusError.invalid(`${c.name}: "clear the link" on delete needs the column to be optional.`);
      if (ref.table === table && !names.has(ref.column)) throw NexusError.invalid(`${c.name}: this table has no column ${ref.column}.`);
      parts.push(`REFERENCES ${qi(ref.table)} (${qi(ref.column)}) ON DELETE ${onDelete}`);
    }
    lines.push(parts.join(" "));
    if (c.kind === "email") checks.push(`CONSTRAINT ${qi(`${table}_${c.name}_email`.slice(0, 63))} CHECK (${qi(c.name)} ~* '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$')`);
    if (c.kind === "url") checks.push(`CONSTRAINT ${qi(`${table}_${c.name}_url`.slice(0, 63))} CHECK (${qi(c.name)} ~* '^https?://')`);
  }
  lines.push(`PRIMARY KEY (${pk.map((c) => qi(c.name)).join(", ")})`);
  lines.push(...checks);

  const statements = [`CREATE TABLE ${qi(table)} (\n  ${lines.join(",\n  ")}\n);`];
  for (const [i, ix] of (design.indexes ?? []).entries()) {
    if (!ix.columns.length) continue;
    for (const col of ix.columns) if (!names.has(col)) throw NexusError.invalid(`Index ${i + 1}: this table has no column ${col}.`);
    const name = `${table}_${ix.columns.join("_")}_${ix.unique ? "uidx" : "idx"}`.slice(0, 63);
    statements.push(`CREATE ${ix.unique ? "UNIQUE " : ""}INDEX ${qi(name)} ON ${qi(table)} (${ix.columns.map(qi).join(", ")});`);
  }
  // Links are looked up often: index them automatically (PostgreSQL doesn't).
  for (const c of design.columns.filter((x) => x.references && !x.unique && !pk.includes(x))) {
    if ((design.indexes ?? []).some((ix) => ix.columns[0] === c.name)) continue;
    statements.push(`CREATE INDEX ${qi(`${table}_${c.name}_idx`.slice(0, 63))} ON ${qi(table)} (${qi(c.name)});`);
  }
  if (design.description?.trim()) statements.push(`COMMENT ON TABLE ${qi(table)} IS ${lit(design.description.trim())};`);
  for (const c of design.columns) if (c.description?.trim()) statements.push(`COMMENT ON COLUMN ${qi(table)}.${qi(c.name)} IS ${lit(c.description.trim())};`);
  return statements.join("\n");
}

// ---------------------------------------------------------------- blueprint

export interface BlueprintColumn {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  primaryKey: boolean;
  unique: boolean;
  references: { table: string; column: string; onDelete: string } | null;
  description: string | null;
}

export interface BlueprintTable {
  name: string;
  description: string | null;
  rowEstimate: number;
  sizeBytes: number;
  columns: BlueprintColumn[];
  indexes: { name: string; columns: string[]; unique: boolean; primary: boolean }[];
}

export interface SqlBlueprint {
  tables: BlueprintTable[];
  relations: { from: { table: string; column: string }; to: { table: string; column: string }; onDelete: string }[];
}

/** The whole structure of a PostgreSQL database (public schema), for the blueprint. */
export async function readSqlBlueprint(c: pg.Client): Promise<SqlBlueprint> {
  const tables = await c.query<{ name: string; description: string | null; rows: string; size: string }>(
    `SELECT cl.relname AS name, obj_description(cl.oid, 'pg_class') AS description,
            GREATEST(cl.reltuples, 0)::bigint AS rows, pg_total_relation_size(cl.oid) AS size
     FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace AND n.nspname = 'public'
     WHERE cl.relkind IN ('r', 'p') ORDER BY cl.relname`,
  );
  const cols = await c.query<{ table: string; name: string; type: string; nullable: boolean; def: string | null; description: string | null; num: number }>(
    `SELECT cl.relname AS table, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
            CASE WHEN a.attidentity <> '' THEN 'auto number' ELSE pg_get_expr(d.adbin, d.adrelid) END AS def,
            col_description(cl.oid, a.attnum) AS description, a.attnum AS num
     FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace AND n.nspname = 'public'
     JOIN pg_attribute a ON a.attrelid = cl.oid AND a.attnum > 0 AND NOT a.attisdropped
     LEFT JOIN pg_attrdef d ON d.adrelid = cl.oid AND d.adnum = a.attnum
     WHERE cl.relkind IN ('r', 'p') ORDER BY cl.relname, a.attnum`,
  );
  const idx = await c.query<{ table: string; name: string; columns: string[]; unique: boolean; primary: boolean }>(
    `SELECT t.relname AS table, i.relname AS name, ix.indisunique AS unique, ix.indisprimary AS primary,
            ARRAY(SELECT a.attname::text FROM unnest(ix.indkey) WITH ORDINALITY k(n, o) JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.n ORDER BY k.o) AS columns
     FROM pg_index ix JOIN pg_class t ON t.oid = ix.indrelid JOIN pg_class i ON i.oid = ix.indexrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public' ORDER BY t.relname, i.relname`,
  );
  const fks = await c.query<{ from_table: string; from_col: string; to_table: string; to_col: string; ondelete: string }>(
    `SELECT src.relname AS from_table, sa.attname AS from_col, dst.relname AS to_table, da.attname AS to_col,
            CASE con.confdeltype WHEN 'c' THEN 'cascade' WHEN 'n' THEN 'set null' WHEN 'r' THEN 'restrict' ELSE 'no action' END AS ondelete
     FROM pg_constraint con
     JOIN pg_class src ON src.oid = con.conrelid JOIN pg_namespace n ON n.oid = src.relnamespace AND n.nspname = 'public'
     JOIN pg_class dst ON dst.oid = con.confrelid
     JOIN LATERAL unnest(con.conkey, con.confkey) AS k(s, d) ON true
     JOIN pg_attribute sa ON sa.attrelid = src.oid AND sa.attnum = k.s
     JOIN pg_attribute da ON da.attrelid = dst.oid AND da.attnum = k.d
     WHERE con.contype = 'f'`,
  );
  const relations = fks.rows.map((f) => ({ from: { table: f.from_table, column: f.from_col }, to: { table: f.to_table, column: f.to_col }, onDelete: f.ondelete }));
  return {
    relations,
    tables: tables.rows.map((t) => {
      const ti = idx.rows.filter((i) => i.table === t.name);
      const pk = new Set(ti.find((i) => i.primary)?.columns ?? []);
      const uniqueCols = new Set(ti.filter((i) => i.unique && !i.primary && i.columns.length === 1).map((i) => i.columns[0]!));
      return {
        name: t.name,
        description: t.description,
        rowEstimate: Number(t.rows),
        sizeBytes: Number(t.size),
        columns: cols.rows
          .filter((cc) => cc.table === t.name)
          .map((cc) => {
            const rel = relations.find((r) => r.from.table === t.name && r.from.column === cc.name);
            return {
              name: cc.name,
              type: cc.type,
              nullable: cc.nullable,
              // 'new'::character varying → 'new' (the cast is PostgreSQL's bookkeeping, not the value).
              default: cc.def ? cc.def.replace(/::[a-z][a-z ]*(\(\d+(,\d+)?\))?(\[\])?$/i, "") : null,
              primaryKey: pk.has(cc.name),
              unique: uniqueCols.has(cc.name),
              references: rel ? { table: rel.to.table, column: rel.to.column, onDelete: rel.onDelete } : null,
              description: cc.description,
            };
          }),
        indexes: ti.map((i) => ({ name: i.name, columns: i.columns, unique: i.unique, primary: i.primary })),
      };
    }),
  };
}
