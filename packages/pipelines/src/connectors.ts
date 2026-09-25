import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { once } from "node:events";
import { dirname, extname, isAbsolute, join } from "node:path";
import { attachInput, ident, sqlPath, sqlString, writeDataset, type Dataset, type Sandbox } from "./duck";
import { StepError } from "./errors";
import type { EngineServices, StepContext, StepExecutor, StepResult } from "./executor";

/**
 * Connectors: where data comes from and where it goes. Each is a plugin (a StepExecutor) that the
 * host registers; the host supplies credentials and paths through these services.
 */
export interface ConnectorServices extends EngineServices {
  /** Path of a bundled DuckDB extension ("excel", "postgres_scanner", "sqlite_scanner"). */
  extension?(name: string): string | undefined;
  /** A connection URL for a Nexus database (by name) or an external one (URL kept in a secret). */
  database?(ref: { database: string } | { secret: string }, access: "read" | "write"): Promise<{ url: string; label: string }>;
  /** The Nexus Warehouse (created on first use). */
  warehouse?(access: "read" | "write"): Promise<{ url: string; label: string }>;
  /** Absolute path of a file in an application's Nexus Storage. */
  storageFile?(app: string, path: string, access: "read" | "write"): string;
}

const svc = (ctx: StepContext) => ctx.services as ConnectorServices;

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new StepError(`${what} isn't available on this server.`);
  return value;
}

function extensionPath(ctx: StepContext, name: string, label: string): string {
  const p = svc(ctx).extension?.(name);
  if (!p || !existsSync(p)) throw new StepError(`The ${label} component is missing. Reinstall Nexus to repair it.`);
  return p;
}

const limit = (ctx: StepContext) => (ctx.testRows ? ` LIMIT ${Math.floor(ctx.testRows)}` : "");
const hasWildcard = (p: string) => /[*?[]/.test(p);

interface IncrementalConfig {
  column: string;
  initial?: string | number;
}

interface Watermark {
  column: string;
  value: string | number;
  type: string;
}

/** Only reuse a saved watermark when it belongs to the column that is still configured. */
function previousWatermark(ctx: StepContext, incremental: IncrementalConfig | undefined): Watermark | null {
  if (!incremental) return null;
  const saved = ctx.previousState?.watermark;
  if (!saved || typeof saved !== "object") return null;
  const w = saved as Partial<Watermark>;
  return w.column === incremental.column && (typeof w.value === "string" || typeof w.value === "number")
    ? { column: w.column, value: w.value, type: typeof w.type === "string" ? w.type : "VARCHAR" }
    : null;
}

function watermarkStart(ctx: StepContext, incremental: IncrementalConfig | undefined): string | number | undefined {
  return previousWatermark(ctx, incremental)?.value ?? incremental?.initial;
}

/** PostgreSQL and DuckDB both coerce quoted, unknown literals to the compared column's type. */
const watermarkLiteral = (value: string | number) => (typeof value === "number" ? String(value) : sqlString(value));

async function stateForWatermark(ctx: StepContext, sb: Sandbox, output: Dataset, incremental: IncrementalConfig | undefined): Promise<Record<string, unknown> | undefined> {
  if (!incremental) return undefined;
  const col = output.columns.find((x) => x.name === incremental.column);
  if (!col) throw new StepError(`The incremental column ${incremental.column} isn't in the data returned by this step.`);
  const [row] = await sb.rows<{ value: string | null }>(`SELECT max(${ident(incremental.column)})::VARCHAR AS value FROM read_parquet(${sqlPath(output.path)})`);
  const value = row?.value ?? previousWatermark(ctx, incremental)?.value ?? incremental.initial;
  if (value === undefined || value === null) return undefined;
  ctx.log("info", `Saved ${incremental.column} = ${value} as the incremental watermark.`);
  return { watermark: { column: incremental.column, value, type: col.type } satisfies Watermark };
}

/** Checks a configured file path and returns the folder the sandbox must be able to reach. */
function checkFile(ctx: StepContext, path: string, access: "read" | "write"): string {
  if (!isAbsolute(path)) throw new StepError(`Use a full path for the file, like C:\\Data\\${path}.`);
  const dir = hasWildcard(path) ? dirname(path.slice(0, path.search(/[*?[]/)) + "x") : dirname(path);
  svc(ctx).checkPath?.(path, access);
  if (access === "read" && !hasWildcard(path) && !existsSync(path)) throw new StepError(`The file ${path} doesn't exist.`, { problem: { title: "Source file missing", summary: `The pipeline expected ${path}, but it isn't there.`, checks: [{ label: "Source file", status: "failed", detail: path }], cause: "The file may not have arrived yet, or it was moved or renamed." } });
  if (access === "write") mkdirSync(dir, { recursive: true });
  return dir;
}

function readerFailure(what: string, path: string, e: unknown): StepError {
  const msg = (e as Error).message ?? String(e);
  if (/No files found that match the pattern/i.test(msg)) return new StepError(`No files match ${path}.`, { technical: msg });
  if (/Permission Error|Cannot access file/i.test(msg)) return new StepError(`${what}: Nexus isn't allowed to read ${path}.`, { technical: msg });
  return new StepError(`${what}: ${msg.split("\n")[0]}`, { technical: msg, cause: e });
}

async function fromFile(ctx: StepContext, label: string, path: string, reader: (p: string) => string, extensions: string[] = []): Promise<StepResult> {
  const dir = checkFile(ctx, path, "read");
  const sb = await ctx.sandbox({ directories: [dir], extensions });
  try {
    const out = await writeDataset(sb, `SELECT * FROM ${reader(sqlPath(path))}${limit(ctx)}`, ctx.outputPath);
    return { output: out, metrics: { rowsOut: out.rows, bytesOut: out.bytes } };
  } catch (e) {
    throw e instanceof StepError ? e : readerFailure(label, path, e);
  } finally {
    sb.close();
  }
}

// ---------------------------------------------------------------- files

const csvRead: StepExecutor = {
  kind: "csv.read",
  run(ctx) {
    const c = ctx.config as { path: string; delimiter?: string; header: boolean };
    const opts = [`header = ${c.header}`, ...(c.delimiter ? [`delim = ${sqlString(c.delimiter)}`] : []), "union_by_name = true", "filename = false"];
    return fromFile(ctx, "CSV file", c.path, (p) => `read_csv(${p}, ${opts.join(", ")})`);
  },
};

const jsonRead: StepExecutor = {
  kind: "json.read",
  run: (ctx) => fromFile(ctx, "JSON file", String(ctx.config.path), (p) => `read_json_auto(${p})`),
};

const parquetRead: StepExecutor = {
  kind: "parquet.read",
  run: (ctx) => fromFile(ctx, "Parquet file", String(ctx.config.path), (p) => `read_parquet(${p}, union_by_name = true)`),
};

function xlsxReader(c: { sheet?: string; range?: string; header?: boolean }) {
  // Blank cells in the first data row would otherwise make DuckDB guess a number for a text column.
  const opts = [`header = ${c.header ?? true}`, "empty_as_varchar = true", ...(c.sheet ? [`sheet = ${sqlString(c.sheet)}`] : []), ...(c.range ? [`range = ${sqlString(c.range)}`] : [])];
  return (p: string) => `read_xlsx(${p}, ${opts.join(", ")})`;
}

const excelRead: StepExecutor = {
  kind: "excel.read",
  run(ctx) {
    const c = ctx.config as { path: string; sheet?: string; range?: string; header: boolean };
    return fromFile(ctx, "Excel workbook", c.path, xlsxReader(c), [extensionPath(ctx, "excel", "Excel reader")]);
  },
};

/** Reader for a file whose type is known only from its extension (Nexus Storage). */
function readerFor(ctx: StepContext, path: string): { label: string; reader: (p: string) => string; extensions: string[] } {
  switch (extname(path).toLowerCase()) {
    case ".csv":
    case ".txt":
      return { label: "CSV file", reader: (p) => `read_csv(${p}, header = true)`, extensions: [] };
    case ".json":
    case ".jsonl":
    case ".ndjson":
      return { label: "JSON file", reader: (p) => `read_json_auto(${p})`, extensions: [] };
    case ".parquet":
      return { label: "Parquet file", reader: (p) => `read_parquet(${p})`, extensions: [] };
    case ".xlsx":
      return { label: "Excel workbook", reader: xlsxReader({}), extensions: [extensionPath(ctx, "excel", "Excel reader")] };
    default:
      throw new StepError(`Nexus can read CSV, JSON, Parquet and Excel (.xlsx) files, not ${extname(path) || "this file"}.`);
  }
}

const storageRead: StepExecutor = {
  kind: "storage.read",
  run(ctx) {
    const c = ctx.config as { app: string; path: string };
    const file = need(svc(ctx).storageFile, "Nexus Storage")(c.app, c.path, "read");
    const r = readerFor(ctx, file);
    return fromFile(ctx, r.label, file, r.reader, r.extensions);
  },
};

const sqliteRead: StepExecutor = {
  kind: "sqlite.read",
  async run(ctx): Promise<StepResult> {
    const c = ctx.config as { path: string; table?: string; query?: string; incremental?: IncrementalConfig };
    checkFile(ctx, c.path, "read");
    const sb = await ctx.sandbox({ extensions: [extensionPath(ctx, "sqlite_scanner", "SQLite reader")], setup: [`ATTACH ${sqlPath(c.path)} AS src (TYPE sqlite, READ_ONLY)`] });
    try {
      const base = c.table ? `SELECT * FROM src.${ident(c.table)}` : `SELECT * FROM sqlite_query('src', ${sqlString(String(c.query).trim().replace(/;\s*$/, ""))})`;
      const start = watermarkStart(ctx, c.incremental);
      const filtered = start === undefined ? base : `SELECT * FROM (${base}) AS nexus_incremental WHERE ${ident(c.incremental!.column)} > ${watermarkLiteral(start)}`;
      const out = await writeDataset(sb, `${filtered}${limit(ctx)}`, ctx.outputPath);
      const state = await stateForWatermark(ctx, sb, out, c.incremental);
      return { output: out, metrics: { rowsOut: out.rows, bytesOut: out.bytes }, state };
    } catch (e) {
      const msg = (e as Error).message;
      if (/Table with name .* does not exist|no such table/i.test(msg)) throw new StepError(`The table ${c.table ?? ""} doesn't exist in ${c.path}.`.replace("  ", " "), { technical: msg });
      throw readerFailure("SQLite", c.path, e);
    } finally {
      sb.close();
    }
  },
};

// ---------------------------------------------------------------- PostgreSQL & Warehouse

type DbTarget = { url: string; label: string };

function splitTable(name: string): { schema: string; table: string } {
  const [a, b] = name.split(".");
  return b ? { schema: a!, table: b } : { schema: "public", table: a! };
}

const pgIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;
const pgTable = (name: string) => {
  const { schema, table } = splitTable(name);
  return `${pgIdent(schema)}.${pgIdent(table)}`;
};

function pgFailure(label: string, e: unknown, table?: string): StepError {
  const msg = (e as Error).message ?? String(e);
  if (/password authentication failed|no pg_hba|role .* does not exist/i.test(msg)) return new StepError(`${label} refused the connection details. Check the saved credentials.`, { technical: msg });
  if (/Connection refused|could not connect|timeout expired|server closed the connection|the database system is (starting up|shutting down)|Connection reset/i.test(msg)) return new StepError(`${label} isn't reachable right now.`, { transient: true, technical: msg });
  if (/(relation|Table with name) .* does not exist/i.test(msg)) return new StepError(`The table ${table ?? ""} doesn't exist in ${label}.`.replace("  ", " "), { technical: msg });
  if (/permission denied/i.test(msg)) return new StepError(`Nexus isn't allowed to do this in ${label}: ${msg.split("\n")[0]}`, { technical: msg });
  return new StepError(`${label}: ${msg.split("\n")[0]}`, { technical: msg, cause: e });
}

async function openDb(ctx: StepContext, target: DbTarget, readOnly: boolean): Promise<Sandbox> {
  try {
    return await ctx.sandbox({
      extensions: [extensionPath(ctx, "postgres_scanner", "PostgreSQL connector")],
      setup: [`ATTACH ${sqlString(target.url)} AS db (TYPE postgres${readOnly ? ", READ_ONLY" : ""})`],
    });
  } catch (e) {
    throw pgFailure(target.label, e);
  }
}

async function readDb(ctx: StepContext, target: DbTarget): Promise<StepResult> {
  const c = ctx.config as { table?: string; query?: string; incremental?: IncrementalConfig };
  const sb = await openDb(ctx, target, true);
  try {
    let from: string;
    if (c.incremental) {
      const base = c.table ? `SELECT * FROM ${pgTable(c.table)}` : String(c.query).trim().replace(/;\s*$/, "");
      const start = watermarkStart(ctx, c.incremental);
      const query = start === undefined ? base : `SELECT * FROM (${base}) AS nexus_incremental WHERE ${pgIdent(c.incremental.column)} > ${watermarkLiteral(start)}`;
      const sampled = ctx.testRows ? `SELECT * FROM (${query}) AS nexus_sample LIMIT ${Math.floor(ctx.testRows)}` : query;
      from = `SELECT * FROM postgres_query('db', ${sqlString(sampled)})`;
    } else if (c.table) {
      const { schema, table } = splitTable(c.table);
      from = `SELECT * FROM db.${ident(schema)}.${ident(table)}${limit(ctx)}`;
    } else {
      // The query runs inside PostgreSQL (with the pipeline's own credentials); the limit too.
      const q = String(c.query).trim().replace(/;\s*$/, "");
      from = `SELECT * FROM postgres_query('db', ${sqlString(ctx.testRows ? `SELECT * FROM (${q}) AS q LIMIT ${Math.floor(ctx.testRows)}` : q)})`;
    }
    const out = await writeDataset(sb, from, ctx.outputPath);
    const state = await stateForWatermark(ctx, sb, out, c.incremental);
    return { output: out, metrics: { rowsOut: out.rows, bytesOut: out.bytes }, state };
  } catch (e) {
    throw pgFailure(target.label, e, c.table);
  } finally {
    sb.close();
  }
}

/**
 * ELT queries are embedded inside controlled CREATE/INSERT statements. Refuse anything except one
 * SELECT (or WITH … SELECT), including data-changing CTEs and SELECT INTO.
 */
function selectOnly(query: string): string {
  const q = query.trim().replace(/;\s*$/, "");
  let masked = "";
  for (let i = 0; i < q.length;) {
    const ch = q[i]!;
    if (ch === "'" || ch === '"') {
      const quote = ch;
      masked += " ";
      i++;
      while (i < q.length) {
        if (q[i] === quote) {
          if (q[i + 1] === quote) { i += 2; continue; }
          i++; break;
        }
        i++;
      }
      continue;
    }
    if (ch === "-" && q[i + 1] === "-") {
      while (i < q.length && q[i] !== "\n") i++;
      masked += "\n";
      continue;
    }
    if (ch === "/" && q[i + 1] === "*") {
      const end = q.indexOf("*/", i + 2);
      i = end < 0 ? q.length : end + 2;
      masked += " ";
      continue;
    }
    if (ch === "$") {
      const tag = q.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0];
      if (tag) {
        const end = q.indexOf(tag, i + tag.length);
        i = end < 0 ? q.length : end + tag.length;
        masked += " ";
        continue;
      }
    }
    masked += ch;
    i++;
  }
  const clean = masked.trim().toLowerCase();
  if (!/^(select|with)\b/.test(clean)) throw new StepError("An in-database SQL transform must be a SELECT query.");
  if (clean.includes(";")) throw new StepError("An in-database SQL transform must contain one query, not several statements.");
  if (/\b(insert|update|delete|merge|call|copy|create|alter|drop|truncate|grant|revoke|execute|prepare|do|vacuum|lock)\b/.test(clean) || /\bselect\s+.*\binto\b/s.test(clean)) {
    throw new StepError("An in-database SQL transform may only read data. Nexus controls the table or view it writes.");
  }
  return q;
}

async function transformDb(ctx: StepContext, target: DbTarget): Promise<StepResult> {
  const c = ctx.config as { query: string; table: string; materialize: "table" | "append" | "view" };
  const query = selectOnly(c.query);
  const { schema, table } = splitTable(c.table);
  const full = `${pgIdent(schema)}.${pgIdent(table)}`;
  if (ctx.testRows !== null) {
    const sb = await openDb(ctx, target, true);
    try {
      const preview = `SELECT * FROM (${query}) AS nexus_preview LIMIT ${ctx.testRows}`;
      const output = await writeDataset(sb, `SELECT * FROM postgres_query('db', ${sqlString(preview)})`, ctx.outputPath);
      ctx.log("info", `Test run: previewed ${output.rows.toLocaleString("en-US")} rows; would build ${c.table} in ${target.label}.`);
      return { output, metrics: { rowsOut: output.rows, bytesOut: output.bytes, rowsWritten: 0, extra: { wouldMaterialize: c.table } } };
    } catch (e) {
      throw pgFailure(target.label, e, c.table);
    } finally {
      sb.close();
    }
  }
  const sb = await openDb(ctx, target, false);
  try {
    const existing = await sb.rows<{ column_name: string }>(
      `SELECT column_name FROM duckdb_columns() WHERE database_name = 'db' AND schema_name = ${sqlString(schema)} AND table_name = ${sqlString(table)}`,
    );
    const before = c.materialize === "append" && existing.length
      ? Number((await sb.rows<{ n: number }>(`SELECT n FROM postgres_query('db', ${sqlString(`SELECT count(*)::bigint AS n FROM ${full}`)})`))[0]?.n ?? 0)
      : 0;
    let sql: string;
    if (c.materialize === "view") {
      sql = `BEGIN; CREATE SCHEMA IF NOT EXISTS ${pgIdent(schema)}; CREATE OR REPLACE VIEW ${full} AS ${query}; COMMIT;`;
    } else {
      const create = `CREATE TABLE IF NOT EXISTS ${full} AS SELECT * FROM (${query}) AS nexus_query WITH NO DATA`;
      const clear = c.materialize === "table" ? `TRUNCATE TABLE ${full}; ` : "";
      sql = `BEGIN; CREATE SCHEMA IF NOT EXISTS ${pgIdent(schema)}; ${create}; ${clear}INSERT INTO ${full} SELECT * FROM (${query}) AS nexus_query; COMMIT;`;
    }
    await sb.conn.run(`CALL postgres_execute('db', ${sqlString(sql)})`);
    const [count] = await sb.rows<{ n: number }>(`SELECT n FROM postgres_query('db', ${sqlString(`SELECT count(*)::bigint AS n FROM ${full}`)})`);
    const total = Number(count?.n ?? 0);
    const written = c.materialize === "view" ? null : c.materialize === "append" ? Math.max(0, total - before) : total;
    ctx.log("info", `${c.materialize === "view" ? "Updated the view" : c.materialize === "append" ? "Added rows to" : "Built"} ${c.table} in ${target.label}.`);
    return { output: null, metrics: { rowsWritten: written, extra: { resultRows: total } } };
  } catch (e) {
    throw e instanceof StepError ? e : pgFailure(target.label, e, c.table);
  } finally {
    sb.close();
  }
}

/**
 * Loads the step's input into a PostgreSQL table.
 *  replace — the table ends up holding exactly the new rows (grants and views on it are kept)
 *  append  — the new rows are added
 *  upsert  — rows with a matching key are replaced, new keys added
 * A missing table is created; new columns in the data are added to an existing table.
 */
async function writeDb(ctx: StepContext, target: DbTarget): Promise<StepResult> {
  const c = ctx.config as { table: string; mode: "replace" | "append" | "upsert"; key?: string[] };
  const input = ctx.inputs[0]!.dataset;
  const { schema, table } = splitTable(c.table);
  if (ctx.testRows !== null) {
    ctx.log("info", `Test run: would ${c.mode === "replace" ? "replace the contents of" : c.mode === "append" ? "add rows to" : "update"} ${c.table} in ${target.label} with ${input.rows.toLocaleString("en-US")} rows.`);
    return { output: null, metrics: { rowsWritten: 0, extra: { wouldWrite: input.rows } } };
  }
  const sb = await openDb(ctx, target, false);
  const full = `db.${ident(schema)}.${ident(table)}`;
  try {
    await attachInput(sb, "input", input);
    await sb.conn.run(`CREATE SCHEMA IF NOT EXISTS db.${ident(schema)}`);
    const existing = await sb.rows<{ column_name: string }>(
      `SELECT column_name FROM duckdb_columns() WHERE database_name = 'db' AND schema_name = ${sqlString(schema)} AND table_name = ${sqlString(table)}`,
    );
    if (!existing.length) {
      await sb.conn.run(`CREATE TABLE ${full} AS SELECT * FROM input`);
      ctx.log("info", `Created the table ${c.table} in ${target.label}.`);
      return { output: null, metrics: { rowsWritten: input.rows } };
    }
    const have = new Set(existing.map((r) => r.column_name));
    for (const col of input.columns.filter((x) => !have.has(x.name))) {
      await sb.conn.run(`ALTER TABLE ${full} ADD COLUMN ${ident(col.name)} ${col.type}`);
      ctx.log("info", `Added the new column ${col.name} to ${c.table}.`);
    }
    const cols = input.columns.map((x) => ident(x.name)).join(", ");
    if (c.mode === "upsert") {
      const key = c.key!;
      const stage = `_nexus_stage_${randomBytes(4).toString("hex")}`;
      const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
      await sb.conn.run(
        `CREATE TABLE db.${ident(schema)}.${ident(stage)} AS SELECT * EXCLUDE (__rn) FROM (SELECT *, row_number() OVER (PARTITION BY ${key.map(ident).join(", ")}) AS __rn FROM input) WHERE __rn = 1`,
      );
      try {
        const match = key.map((k) => `t.${q(k)} = s.${q(k)}`).join(" AND ");
        const sql = `BEGIN; DELETE FROM ${q(schema)}.${q(table)} AS t USING ${q(schema)}.${q(stage)} AS s WHERE ${match}; INSERT INTO ${q(schema)}.${q(table)} (${input.columns.map((x) => q(x.name)).join(", ")}) SELECT ${input.columns.map((x) => q(x.name)).join(", ")} FROM ${q(schema)}.${q(stage)}; COMMIT;`;
        await sb.conn.run(`CALL postgres_execute('db', ${sqlString(sql)})`);
      } finally {
        await sb.conn.run(`CALL postgres_execute('db', ${sqlString(`DROP TABLE IF EXISTS ${q(schema)}.${q(stage)}`)})`).catch(() => undefined);
      }
      const [n] = await sb.rows<{ n: number }>(`SELECT count(DISTINCT (${key.map(ident).join(", ")}))::BIGINT AS n FROM input`);
      return { output: null, metrics: { rowsWritten: Number(n?.n ?? 0) } };
    }
    await sb.conn.run("BEGIN TRANSACTION");
    try {
      if (c.mode === "replace") await sb.conn.run(`DELETE FROM ${full}`);
      await sb.conn.run(`INSERT INTO ${full} (${cols}) SELECT ${cols} FROM input`);
      await sb.conn.run("COMMIT");
    } catch (e) {
      await sb.conn.run("ROLLBACK").catch(() => undefined);
      throw e;
    }
    return { output: null, metrics: { rowsWritten: input.rows } };
  } catch (e) {
    throw e instanceof StepError ? e : pgFailure(target.label, e, c.table);
  } finally {
    sb.close();
  }
}

const dbTarget = (ctx: StepContext, access: "read" | "write") => need(svc(ctx).database, "Database access")(ctx.config.connection as { database: string } | { secret: string }, access);
const whTarget = (ctx: StepContext, access: "read" | "write") => need(svc(ctx).warehouse, "The Nexus Warehouse")(access);

const postgresRead: StepExecutor = { kind: "postgres.read", run: async (ctx) => readDb(ctx, await dbTarget(ctx, "read")) };
const postgresWrite: StepExecutor = { kind: "postgres.write", run: async (ctx) => writeDb(ctx, await dbTarget(ctx, "write")) };
const warehouseRead: StepExecutor = { kind: "warehouse.read", run: async (ctx) => readDb(ctx, await whTarget(ctx, "read")) };
const warehouseWrite: StepExecutor = { kind: "warehouse.write", run: async (ctx) => writeDb(ctx, await whTarget(ctx, "write")) };
const postgresTransform: StepExecutor = { kind: "postgres.transform", run: async (ctx) => transformDb(ctx, await dbTarget(ctx, ctx.testRows === null ? "write" : "read")) };
const warehouseTransform: StepExecutor = { kind: "warehouse.transform", run: async (ctx) => transformDb(ctx, await whTarget(ctx, ctx.testRows === null ? "write" : "read")) };

// ---------------------------------------------------------------- writing files

const FORMATS: Record<string, "csv" | "parquet" | "json" | "excel"> = { ".csv": "csv", ".parquet": "parquet", ".json": "json", ".xlsx": "excel" };

async function writeFile(ctx: StepContext, path: string, format: string | undefined): Promise<StepResult> {
  const input = ctx.inputs[0]!.dataset;
  const fmt = (format as keyof typeof FORMATS | undefined) ?? FORMATS[extname(path).toLowerCase()];
  if (!fmt) throw new StepError(`Choose a format for ${path} (CSV, Parquet, JSON or Excel), or end the file name with .csv, .parquet, .json or .xlsx.`);
  if (ctx.testRows !== null) {
    ctx.log("info", `Test run: would save ${input.rows.toLocaleString("en-US")} rows to ${path}.`);
    return { output: null, metrics: { rowsWritten: 0, extra: { wouldWrite: input.rows } } };
  }
  const dir = checkFile(ctx, path, "write");
  const sb = await ctx.sandbox({ directories: [dir], extensions: fmt === "excel" ? [extensionPath(ctx, "excel", "Excel writer")] : [] });
  // Written next to the target, then swapped in: readers never see a half-written file.
  const partial = join(dir, `.${randomBytes(4).toString("hex")}.nexus-part`);
  try {
    await attachInput(sb, "input", input);
    const options = { csv: "FORMAT csv, HEADER true", parquet: "FORMAT parquet, COMPRESSION zstd", json: "FORMAT json, ARRAY true", excel: "FORMAT xlsx, HEADER true" }[fmt];
    await sb.conn.run(`COPY (SELECT * FROM input) TO ${sqlPath(partial)} (${options})`);
    sb.close();
    rmSync(path, { force: true });
    renameSync(partial, path);
    ctx.log("info", `Saved ${input.rows.toLocaleString("en-US")} rows to ${path}.`);
    return { output: null, metrics: { rowsWritten: input.rows } };
  } catch (e) {
    rmSync(partial, { force: true });
    throw readerFailure("Export file", path, e);
  } finally {
    try {
      sb.close();
    } catch {
      /* already closed */
    }
  }
}

const fileWrite: StepExecutor = { kind: "file.write", run: (ctx) => writeFile(ctx, String(ctx.config.path), ctx.config.format as string | undefined) };
const storageWrite: StepExecutor = {
  kind: "storage.write",
  run(ctx) {
    const c = ctx.config as { app: string; path: string; format?: string };
    // A dry run only needs the name to validate the output format; don't ask storage to prepare a path.
    const path = ctx.testRows === null ? need(svc(ctx).storageFile, "Nexus Storage")(c.app, c.path, "write") : c.path;
    return writeFile(ctx, path, c.format);
  },
};

// ---------------------------------------------------------------- REST APIs

function headersFor(ctx: StepContext, c: { headers: Record<string, string>; secretHeaders: Record<string, string> }): Record<string, string> {
  const out: Record<string, string> = { accept: "application/json", "user-agent": "Nexus-Pipelines/1", ...c.headers };
  for (const [header, secret] of Object.entries(c.secretHeaders)) {
    const value = svc(ctx).secret?.(secret);
    if (value === undefined) throw new StepError(`The secret "${secret}" isn't set up. Add it under Pipelines › Secrets.`);
    out[header] = value;
  }
  return out;
}

async function call(ctx: StepContext, url: string, init: RequestInit, what: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(60_000)]) });
  } catch (e) {
    if (ctx.signal.aborted) throw e;
    throw new StepError(`${what} didn't answer (${(e as Error).message}).`, { transient: true, cause: e });
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 500);
    if ([408, 425, 429, 500, 502, 503, 504].includes(res.status)) throw new StepError(`${what} is busy or having trouble (HTTP ${res.status}).`, { transient: true, technical: body });
    if (res.status === 401 || res.status === 403) throw new StepError(`${what} refused the credentials (HTTP ${res.status}).`, { technical: body });
    throw new StepError(`${what} answered with an error (HTTP ${res.status}).`, { technical: body });
  }
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw new StepError(`${what} didn't return JSON.`, { technical: text.slice(0, 500) });
  }
}

const at = (value: unknown, path: string): unknown => (path ? path.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), value) : value);

const restRead: StepExecutor = {
  kind: "rest.read",
  async run(ctx): Promise<StepResult> {
    const c = ctx.config as {
      url: string;
      method: "GET" | "POST";
      headers: Record<string, string>;
      secretHeaders: Record<string, string>;
      body?: unknown;
      records: string;
      pagination?: { type: "page"; param: string; start: number; maxPages: number } | { type: "cursor"; param: string; next: string; maxPages: number };
    };
    const headers = headersFor(ctx, c);
    if (c.body !== undefined) headers["content-type"] = "application/json";
    const file = join(ctx.workDir, "records.jsonl");
    const out = createWriteStream(file);
    let count = 0;
    let pages = 0;
    let cursor: string | null = null;
    try {
      for (;;) {
        const url = new URL(c.url);
        if (c.pagination?.type === "page") url.searchParams.set(c.pagination.param, String(c.pagination.start + pages));
        if (c.pagination?.type === "cursor" && cursor !== null) url.searchParams.set(c.pagination.param, cursor);
        const body = await call(ctx, url.toString(), { method: c.method, headers, ...(c.body !== undefined ? { body: JSON.stringify(c.body) } : {}) }, `The API at ${url.host}`);
        pages++;
        const found = at(body, c.records);
        const records = Array.isArray(found) ? found : found && typeof found === "object" ? [found] : [];
        if (found === undefined && c.records) throw new StepError(`The API response has no "${c.records}". Check where the records are in the response.`);
        for (const r of records) {
          if (ctx.testRows !== null && count >= ctx.testRows) break;
          if (!out.write(JSON.stringify(r && typeof r === "object" ? r : { value: r }) + "\n")) await once(out, "drain");
          count++;
        }
        if (ctx.testRows !== null && count >= ctx.testRows) break;
        if (!c.pagination || !records.length || pages >= c.pagination.maxPages) break;
        if (c.pagination.type === "cursor") {
          const next = at(body, c.pagination.next);
          if (next === undefined || next === null || next === "") break;
          cursor = String(next);
        }
      }
    } finally {
      out.end();
      await once(out, "finish");
    }
    const sb = await ctx.sandbox();
    try {
      const output = count
        ? await writeDataset(sb, `SELECT * FROM read_json_auto(${sqlPath(file)}, format = 'newline_delimited')${limit(ctx)}`, ctx.outputPath)
        : await writeDataset(sb, "SELECT NULL::VARCHAR AS no_records WHERE false", ctx.outputPath);
      return { output, warnings: count ? [] : ["The API returned no records."], metrics: { rowsOut: output.rows, bytesOut: output.bytes, extra: { pages } } };
    } finally {
      sb.close();
      rmSync(file, { force: true });
    }
  },
};

const apiWrite: StepExecutor = {
  kind: "api.write",
  async run(ctx): Promise<StepResult> {
    const c = ctx.config as { url: string; method: "POST" | "PUT"; headers: Record<string, string>; secretHeaders: Record<string, string>; batchSize: number };
    const input = ctx.inputs[0]!.dataset;
    if (ctx.testRows !== null) {
      ctx.log("info", `Test run: would send ${input.rows.toLocaleString("en-US")} rows to ${new URL(c.url).host}.`);
      return { output: null, metrics: { rowsWritten: 0, extra: { wouldWrite: input.rows } } };
    }
    const headers = { ...headersFor(ctx, c), "content-type": "application/json" };
    const sb = await ctx.sandbox();
    let sent = 0;
    let batches = 0;
    try {
      await attachInput(sb, "input", input);
      for (let offset = 0; offset < input.rows; offset += c.batchSize) {
        const rows = await sb.rows<{ j: string }>(`SELECT to_json(t)::VARCHAR AS j FROM (SELECT * FROM input LIMIT ${c.batchSize} OFFSET ${offset}) t`);
        const payload = `[${rows.map((r) => r.j).join(",")}]`;
        await call(ctx, c.url, { method: c.method, headers, body: payload }, `The API at ${new URL(c.url).host}`);
        sent += rows.length;
        batches++;
      }
      return { output: null, metrics: { rowsWritten: sent, extra: { batches } } };
    } finally {
      sb.close();
    }
  },
};

export const BUILTIN_CONNECTORS: StepExecutor[] = [csvRead, jsonRead, parquetRead, excelRead, storageRead, sqliteRead, postgresRead, warehouseRead, restRead, postgresTransform, warehouseTransform, postgresWrite, warehouseWrite, fileWrite, storageWrite, apiWrite];
