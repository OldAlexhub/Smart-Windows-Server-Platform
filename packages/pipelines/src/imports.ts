import { closeSync, openSync, readSync, rmSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { NexusError } from "@nexus/shared";
import { ident, openSandbox, sqlPath, sqlString, type Sandbox } from "./duck";

/**
 * The data import wizard: a CSV, Excel or JSON file → "I found these columns" → a suggested table,
 * column types and primary key the person can change → the rows loaded into a PostgreSQL database.
 * Files are read by the same locked-down DuckDB as pipelines; nothing is written until every value
 * has been checked against the chosen types and the key.
 */

export type ImportFormat = "csv" | "excel" | "json";
export type ImportType = "text" | "integer" | "decimal" | "date" | "timestamp" | "boolean";

export const IMPORT_TYPES: { id: ImportType; label: string; postgres: string }[] = [
  { id: "text", label: "Text", postgres: "text" },
  { id: "integer", label: "Whole number", postgres: "bigint" },
  { id: "decimal", label: "Decimal number", postgres: "numeric" },
  { id: "date", label: "Date", postgres: "date" },
  { id: "timestamp", label: "Date and time", postgres: "timestamp" },
  { id: "boolean", label: "Yes / no", postgres: "boolean" },
];

export interface ImportColumn {
  /** The column as it appears in the file ("Driver ID"). */
  source: string;
  /** Suggested column name in the database ("driver_id"). */
  name: string;
  type: ImportType;
  /** How text values are read: a date pattern like %m/%d/%Y, "money" ($1,234.50) or "json" (nested values). */
  format: string | null;
  /** DuckDB's type for the column as read from the file. */
  sourceType: string;
  empty: number;
  distinct: number;
  examples: string[];
  /** Something the person should know about the guess ("03/04/2024 read as month/day"). */
  note: string | null;
}

export interface ImportAnalysis {
  format: ImportFormat;
  /** Excel only: every sheet, and the one analysed. */
  sheets: string[];
  sheet: string | null;
  rows: number;
  columns: ImportColumn[];
  /** The first rows, as text, for the preview. */
  sample: Record<string, string | null>[];
  suggestedTable: string;
  /** Column names (in the database) that identify a row, or null → Nexus adds an id column. */
  primaryKey: string[] | null;
}

export interface ImportPlan {
  table: string;
  /** create: a new table (it must not exist). append: add rows to an existing table. */
  mode: "create" | "append";
  columns: { source: string; name: string; type: ImportType; format?: string | null; include: boolean }[];
  /** Columns that identify a row; null = add an automatic id column (create only). */
  primaryKey: string[] | null;
}

export interface ImportFileOptions {
  file: string;
  format: ImportFormat;
  sheet?: string | null;
  /** A folder the import may use for temporary files. */
  workDir: string;
  /** DuckDB extension files: excel for .xlsx, postgres_scanner for loading. */
  extensions: { excel?: string; postgres?: string };
}

const SAMPLE_ROWS = 20;
const DATE_FORMATS = ["%m/%d/%Y", "%d/%m/%Y", "%d.%m.%Y", "%Y/%m/%d", "%d-%m-%Y", "%m-%d-%Y"];
const TIMESTAMP_FORMATS = [
  "%m/%d/%Y %H:%M",
  "%m/%d/%Y %H:%M:%S",
  "%d/%m/%Y %H:%M",
  "%d/%m/%Y %H:%M:%S",
  "%d.%m.%Y %H:%M",
  "%m/%d/%Y %I:%M %p",
  "%m/%d/%Y %I:%M:%S %p",
];
const TABLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export function importFormat(fileName: string): ImportFormat {
  switch (extname(fileName).toLowerCase()) {
    case ".csv":
    case ".txt":
    case ".tsv":
      return "csv";
    case ".xlsx":
      return "excel";
    case ".json":
    case ".jsonl":
    case ".ndjson":
      return "json";
    case ".xls":
      throw NexusError.invalid(
        "Old Excel files (.xls) can't be read. Open it in Excel and save it as .xlsx, then try again.",
      );
    default:
      throw NexusError.invalid("Nexus can import CSV, Excel (.xlsx) and JSON files.");
  }
}

// ---------------------------------------------------------------- names

/** "Driver ID" → driver_id, "LastPayment" → last_payment, "2024 total" → c_2024_total. */
export function columnName(header: string, taken: Set<string> = new Set()): string {
  let n = header
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/%/g, "_pct")
    .replace(/#/g, "_no")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!n) n = "column";
  if (/^\d/.test(n)) n = `c_${n}`;
  n = n.slice(0, 60);
  let name = n;
  for (let i = 2; taken.has(name); i++) name = `${n}_${i}`;
  taken.add(name);
  return name;
}

/** "Drivers export 2024-09.csv" → drivers, sheet "Payments" → payments. Never an existing table. */
export function suggestTableName(fileName: string, sheet: string | null, existing: string[]): string {
  const fromSheet = sheet && !/^sheet\s*\d*$/i.test(sheet.trim()) ? sheet : null;
  let n = columnName(fromSheet ?? basename(fileName, extname(fileName)));
  n = n
    .replace(/(_(export|exported|final|copy|data|latest|new|v\d+|\d{1,8}))+$/g, "")
    .replace(/^(export|data|copy)_/, "")
    .replace(/^c_/, "t_");
  if (!n || n === "column") n = "imported_data";
  const taken = new Set(existing.map((t) => t.toLowerCase()));
  let name = n.slice(0, 55);
  for (let i = 2; taken.has(name); i++) name = `${n.slice(0, 55)}_${i}`;
  return name;
}

// ---------------------------------------------------------------- Excel sheet names

/** Sheet names of an .xlsx workbook (read from the zip's workbook.xml without loading the file). */
export function excelSheetNames(path: string): string[] {
  const fd = openSync(path, "r");
  try {
    const size = statSync(path).size;
    const read = (pos: number, len: number) => {
      const b = Buffer.alloc(len);
      readSync(fd, b, 0, len, pos);
      return b;
    };
    const tailLen = Math.min(size, 65_557);
    const tail = read(size - tailLen, tailLen);
    const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) throw new Error("not a zip");
    const count = tail.readUInt16LE(eocd + 10);
    const dirSize = tail.readUInt32LE(eocd + 12);
    const dirOffset = tail.readUInt32LE(eocd + 16);
    const dir = read(dirOffset, dirSize);
    let p = 0;
    for (let i = 0; i < count && p + 46 <= dir.length; i++) {
      const method = dir.readUInt16LE(p + 10);
      const compressed = dir.readUInt32LE(p + 20);
      const nameLen = dir.readUInt16LE(p + 28);
      const extraLen = dir.readUInt16LE(p + 30);
      const commentLen = dir.readUInt16LE(p + 32);
      const local = dir.readUInt32LE(p + 42);
      const name = dir.toString("utf8", p + 46, p + 46 + nameLen);
      p += 46 + nameLen + extraLen + commentLen;
      if (name !== "xl/workbook.xml") continue;
      const header = read(local, 30);
      const start = local + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
      const data = read(start, compressed);
      const xml = (method === 8 ? inflateRawSync(data) : data).toString("utf8");
      const decode = (s: string) =>
        s
          .replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&amp;/g, "&");
      return [...xml.matchAll(/<(?:\w+:)?sheet\b[^>]*\bname="([^"]*)"/g)].map((m) => decode(m[1]!));
    }
    return [];
  } catch {
    throw NexusError.invalid("This doesn't look like an Excel workbook (.xlsx). Open it in Excel and save it again.");
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------- reading

function reader(o: ImportFileOptions): string {
  const p = sqlPath(o.file);
  if (o.format === "csv") return `read_csv(${p}, header = true, all_varchar = true, sample_size = -1)`;
  if (o.format === "json") return `read_json_auto(${p}, sample_size = -1)`;
  return `read_xlsx(${p}, header = true, empty_as_varchar = true${o.sheet ? `, sheet = ${sqlString(o.sheet)}` : ""})`;
}

async function sandbox(
  o: ImportFileOptions,
  extras: { extensions?: string[]; setup?: string[] } = {},
): Promise<Sandbox> {
  const extensions = [
    ...(o.format === "excel" ? [need(o.extensions.excel, "Excel reader")] : []),
    ...(extras.extensions ?? []),
  ];
  return openSandbox({
    directories: [o.workDir],
    files: [o.file],
    tempDir: join(o.workDir, "tmp"),
    extensions,
    ...(extras.setup ? { setup: extras.setup } : {}),
    memoryLimitMb: 1024,
  });
}

function need(file: string | undefined, label: string): string {
  if (!file) throw NexusError.conflict(`The ${label} isn't installed. Reinstall Nexus to add it.`);
  return file;
}

function readFailure(o: ImportFileOptions, e: unknown): NexusError {
  const msg = (e as Error).message ?? String(e);
  if (/No sheet|sheet .* not found/i.test(msg))
    return NexusError.invalid(`The workbook has no sheet called ${o.sheet}.`);
  if (/malformed JSON|JSON/i.test(msg) && o.format === "json")
    return NexusError.invalid(
      "This file isn't valid JSON. Nexus reads a JSON array of records ([{…}, {…}]) or one record per line.",
    );
  if (/CSV|sniff|delimiter/i.test(msg))
    return NexusError.invalid(`Nexus couldn't read this CSV file: ${msg.split("\n")[0]}`);
  return NexusError.invalid(`Nexus couldn't read this file: ${msg.split("\n")[0]}`);
}

/** A column as it is in the file, read so that empty cells are NULL. */
const textOf = (col: string, sourceType: string) =>
  /STRUCT|MAP|\[\]|JSON|UNION/.test(sourceType)
    ? `nullif(to_json(${ident(col)})::VARCHAR, 'null')`
    : `nullif(trim(CAST(${ident(col)} AS VARCHAR)), '')`;

// ---------------------------------------------------------------- type guesses

const IS_TEXT = (t: string) => t === "VARCHAR";
const MONEY = `regexp_replace(v, '[$€£¥\\s,]', '', 'g')`;
const MONEY_SHAPE = `'^\\(?-?[$€£¥]?\\s?-?[0-9]{1,3}(,?[0-9]{3})*(\\.[0-9]+)?\\)?$'`;

/** SQL that turns a column into the chosen type (NULL when a value doesn't convert). */
export function convertExpression(col: string, sourceType: string, type: ImportType, format: string | null): string {
  const v = textOf(col, sourceType);
  const raw = ident(col);
  const typed = !IS_TEXT(sourceType) && !/STRUCT|MAP|\[\]|JSON|UNION/.test(sourceType);
  switch (type) {
    case "text":
      return v;
    case "integer":
      return typed && /DOUBLE|FLOAT|DECIMAL/.test(sourceType)
        ? `CASE WHEN ${raw} = trunc(${raw}) THEN CAST(${raw} AS BIGINT) END`
        : `TRY_CAST(${format === "money" ? MONEY.replace("v", v) : v} AS BIGINT)`;
    case "decimal":
      return typed && /INT|DOUBLE|FLOAT|DECIMAL/.test(sourceType)
        ? `CAST(${raw} AS DOUBLE)`
        : `TRY_CAST(${format === "money" ? MONEY.replace("v", v) : v} AS DOUBLE)`;
    case "date":
      if (typed && /DATE|TIMESTAMP/.test(sourceType)) return `CAST(${raw} AS DATE)`;
      return format ? `CAST(try_strptime(${v}, ${sqlString(format)}) AS DATE)` : `TRY_CAST(${v} AS DATE)`;
    case "timestamp":
      if (typed && /DATE|TIMESTAMP/.test(sourceType)) return `CAST(${raw} AS TIMESTAMP)`;
      return format ? `try_strptime(${v}, ${sqlString(format)})` : `TRY_CAST(${v} AS TIMESTAMP)`;
    case "boolean":
      if (typed && sourceType === "BOOLEAN") return raw;
      return `CASE WHEN lower(${v}) IN ('true', 'yes', 'y', '1', 't') THEN true WHEN lower(${v}) IN ('false', 'no', 'n', '0', 'f') THEN false END`;
  }
}

async function guessType(
  sb: Sandbox,
  from: string,
  col: string,
  sourceType: string,
): Promise<{ type: ImportType; format: string | null; note: string | null }> {
  if (/STRUCT|MAP|\[\]|JSON|UNION/.test(sourceType))
    return { type: "text", format: "json", note: "Nested values are kept as JSON text." };
  if (sourceType === "BOOLEAN") return { type: "boolean", format: null, note: null };
  if (/^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT)$/.test(sourceType))
    return { type: "integer", format: null, note: null };
  if (/DOUBLE|FLOAT|DECIMAL/.test(sourceType)) {
    const [r] = await sb.rows<{ fraction: number }>(
      `SELECT count(*) FILTER (WHERE ${ident(col)} <> trunc(${ident(col)}))::BIGINT AS fraction FROM ${from}`,
    );
    return { type: Number(r?.fraction) === 0 ? "integer" : "decimal", format: null, note: null };
  }
  if (sourceType === "DATE") return { type: "date", format: null, note: null };
  if (sourceType.startsWith("TIMESTAMP")) return { type: "timestamp", format: null, note: null };
  if (!IS_TEXT(sourceType)) return { type: "text", format: null, note: null };

  // Text: find the narrowest type every filled value fits.
  const v = "v";
  const miss = (cond: string) => `count(*) FILTER (WHERE v IS NOT NULL AND NOT coalesce(${cond}, false))::BIGINT`;
  const leadingZero = `regexp_matches(v, '^[+-]?0[0-9]')`;
  const checks: Record<string, string> = {
    filled: "count(v)::BIGINT",
    bool: miss(`lower(v) IN ('true', 'false', 'yes', 'no')`),
    int: miss(`TRY_CAST(v AS BIGINT) IS NOT NULL AND NOT ${leadingZero}`),
    dec: miss(
      `TRY_CAST(v AS DOUBLE) IS NOT NULL AND NOT ${leadingZero} AND regexp_matches(v, '^[+-]?[0-9]*\\.?[0-9]+$')`,
    ),
    money: miss(`regexp_matches(v, ${MONEY_SHAPE}) AND TRY_CAST(${MONEY.replace("v", v)} AS DOUBLE) IS NOT NULL`),
    iso_date: miss(`TRY_CAST(v AS DATE) IS NOT NULL AND regexp_matches(v, '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')`),
    iso_ts: miss(`TRY_CAST(v AS TIMESTAMP) IS NOT NULL AND regexp_matches(v, '^[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]')`),
    day_first_only: `count(*) FILTER (WHERE TRY_CAST(split_part(v, '/', 1) AS INTEGER) > 12)::BIGINT`,
    month_first_only: `count(*) FILTER (WHERE TRY_CAST(split_part(v, '/', 2) AS INTEGER) > 12)::BIGINT`,
  };
  DATE_FORMATS.forEach((f, i) => (checks[`d${i}`] = miss(`try_strptime(v, ${sqlString(f)}) IS NOT NULL`)));
  TIMESTAMP_FORMATS.forEach((f, i) => (checks[`t${i}`] = miss(`try_strptime(v, ${sqlString(f)}) IS NOT NULL`)));
  const [r] = await sb.rows<Record<string, number>>(
    `SELECT ${Object.entries(checks)
      .map(([k, sql]) => `${sql} AS ${k}`)
      .join(", ")} FROM (SELECT ${textOf(col, sourceType)} AS v FROM ${from})`,
  );
  const ok = (k: string) => Number(r![k]) === 0;
  if (!r || Number(r.filled) === 0) return { type: "text", format: null, note: "This column is empty in the file." };
  if (ok("bool")) return { type: "boolean", format: null, note: null };
  if (ok("int")) return { type: "integer", format: null, note: null };
  if (ok("dec")) return { type: "decimal", format: null, note: null };
  if (ok("money"))
    return { type: "decimal", format: "money", note: "Currency signs and thousands separators are removed." };
  if (ok("iso_date")) return { type: "date", format: null, note: null };
  if (ok("iso_ts")) return { type: "timestamp", format: null, note: null };
  for (const [i, f] of DATE_FORMATS.entries()) {
    if (!ok(`d${i}`)) continue;
    // 03/04/2024 could be March 4 or 3 April: go with what the other rows prove, say so if nothing does.
    if (f === "%m/%d/%Y" && Number(r.day_first_only) > 0) continue;
    const ambiguous =
      (f === "%m/%d/%Y" || f === "%d/%m/%Y") && Number(r.day_first_only) === 0 && Number(r.month_first_only) === 0;
    return {
      type: "date",
      format: f,
      note: ambiguous ? "Dates like 03/04/2024 are read as month/day. Change the format if they are day/month." : null,
    };
  }
  for (const [i, f] of TIMESTAMP_FORMATS.entries()) {
    if (!ok(`t${i}`)) continue;
    if (f.startsWith("%m/%d") && Number(r.day_first_only) > 0) continue;
    return { type: "timestamp", format: f, note: null };
  }
  return { type: "text", format: null, note: null };
}

/** How likely a column is to be the row identifier (0 = not a candidate). */
function keyScore(c: ImportColumn, index: number, table: string, rows: number): number {
  if (c.empty > 0 || c.distinct !== rows || rows === 0) return 0;
  if (c.type !== "integer" && c.type !== "text") return 0;
  const n = c.name;
  const singular = table.replace(/ies$/, "y").replace(/s$/, "");
  let score = 0;
  if (n === "id") score = 100;
  else if (n === `${singular}_id` || n === `${table}_id`) score = 95;
  else if (/(^|_)(id|uuid|guid)$/.test(n)) score = 80;
  else if (/(^|_)(code|number|no|num|key|ref|reference|sku)$/.test(n)) score = 65;
  else if (index === 0 && c.type === "integer") score = 60;
  if (score === 0) return 0;
  if (index === 0) score += 10;
  if (c.type === "integer") score += 5;
  return score;
}

/** Reads the file and proposes a table: column names and types, and the primary key. */
export async function analyzeImport(
  o: ImportFileOptions,
  fileName: string,
  existingTables: string[],
): Promise<ImportAnalysis> {
  const sheets = o.format === "excel" ? excelSheetNames(o.file) : [];
  if (o.format === "excel" && !sheets.length) throw NexusError.invalid("This workbook has no sheets.");
  const sheet = o.format === "excel" ? (o.sheet && sheets.includes(o.sheet) ? o.sheet : sheets[0]!) : null;
  const opts = { ...o, sheet };
  const sb = await sandbox(opts);
  const staged = join(o.workDir, "staged.parquet");
  try {
    // Re-analysing another Excel sheet reuses the upload folder.
    rmIfPresent(staged);
    try {
      await sb.conn.run(`COPY (SELECT * FROM ${reader(opts)}) TO ${sqlPath(staged)} (FORMAT parquet)`);
    } catch (e) {
      throw readFailure(opts, e);
    }
    const from = `read_parquet(${sqlPath(staged)})`;
    const described = await sb.rows<{ column_name: string; column_type: string }>(`DESCRIBE SELECT * FROM ${from}`);
    const [count] = await sb.rows<{ n: number }>(`SELECT count(*)::BIGINT AS n FROM ${from}`);
    const rows = Number(count?.n ?? 0);
    if (!described.length) throw NexusError.invalid("Nexus didn't find any columns in this file.");
    const table = suggestTableName(fileName, sheet, existingTables);
    const taken = new Set<string>();
    const columns: ImportColumn[] = [];
    for (const d of described) {
      const col = d.column_name;
      const text = textOf(col, d.column_type);
      const [stats] = await sb.rows<{ empty: number; distinct: number }>(
        `SELECT (count(*) - count(${text}))::BIGINT AS empty, count(DISTINCT ${text})::BIGINT AS distinct FROM ${from}`,
      );
      const examples = await sb.rows<{ v: string }>(
        `SELECT DISTINCT ${text} AS v FROM ${from} WHERE ${text} IS NOT NULL LIMIT 3`,
      );
      const guess = await guessType(sb, from, col, d.column_type);
      columns.push({
        source: col,
        name: columnName(col, taken),
        sourceType: d.column_type,
        ...guess,
        empty: Number(stats?.empty ?? 0),
        distinct: Number(stats?.distinct ?? 0),
        examples: examples.map((e) => String(e.v).slice(0, 80)),
      });
    }
    const sample = await sb.rows<Record<string, string | null>>(
      `SELECT ${described.map((d) => `${textOf(d.column_name, d.column_type)} AS ${ident(d.column_name)}`).join(", ")} FROM ${from} LIMIT ${SAMPLE_ROWS}`,
    );
    const best = columns
      .map((c, i) => ({ c, score: keyScore(c, i, table, rows) }))
      .sort((a, b) => b.score - a.score)[0];
    return {
      format: o.format,
      sheets,
      sheet,
      rows,
      columns,
      sample,
      suggestedTable: table,
      primaryKey: best && best.score > 0 ? [best.c.name] : null,
    };
  } finally {
    sb.close();
  }
}

// ---------------------------------------------------------------- loading

const pgIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** Checks the plan against the data and loads it. Returns the number of rows imported. */
export async function runImport(
  o: ImportFileOptions,
  url: string,
  plan: ImportPlan,
  existingColumns: string[] | null,
): Promise<{ rows: number; table: string; generatedKey: string | null }> {
  const table = plan.table.trim().toLowerCase();
  if (!TABLE_NAME.test(table))
    throw NexusError.invalid(
      "Use a table name with lowercase letters, numbers and underscores, starting with a letter.",
    );
  const cols = plan.columns.filter((c) => c.include);
  if (!cols.length) throw NexusError.invalid("Choose at least one column to import.");
  const names = new Set<string>();
  for (const c of cols) {
    if (!TABLE_NAME.test(c.name))
      throw NexusError.invalid(
        `"${c.name}" can't be a column name. Use lowercase letters, numbers and underscores, starting with a letter.`,
      );
    if (names.has(c.name)) throw NexusError.invalid(`Two columns are called ${c.name}. Give each column its own name.`);
    names.add(c.name);
  }
  if (plan.mode === "create" && existingColumns)
    throw NexusError.conflict(`A table called ${table} already exists. Choose another name, or add the rows to it.`);
  if (plan.mode === "append" && !existingColumns) throw NexusError.notFound(`Table ${table}`);
  if (plan.mode === "append") {
    const missing = cols.filter((c) => !existingColumns!.includes(c.name)).map((c) => c.name);
    if (missing.length)
      throw NexusError.invalid(
        `${table} has no column${missing.length > 1 ? "s" : ""} called ${missing.join(", ")}. Rename ${missing.length > 1 ? "them" : "it"} to match, or leave ${missing.length > 1 ? "them" : "it"} out.`,
      );
  }
  const key = plan.primaryKey?.length ? plan.primaryKey : null;
  for (const k of key ?? [])
    if (!names.has(k)) throw NexusError.invalid(`The primary key ${k} isn't one of the imported columns.`);

  const sb = await sandbox(o, {
    extensions: [need(o.extensions.postgres, "PostgreSQL connector")],
    setup: [`ATTACH ${sqlString(url)} AS db (TYPE postgres)`],
  });
  const staged = join(o.workDir, "load.parquet");
  try {
    rmIfPresent(staged);
    try {
      await sb.conn.run(`COPY (SELECT * FROM ${reader(o)}) TO ${sqlPath(staged)} (FORMAT parquet)`);
    } catch (e) {
      throw readFailure(o, e);
    }
    const from = `read_parquet(${sqlPath(staged)})`;
    const types = new Map(
      (await sb.rows<{ column_name: string; column_type: string }>(`DESCRIBE SELECT * FROM ${from}`)).map((d) => [
        d.column_name,
        d.column_type,
      ]),
    );
    const exprs = cols.map((c) => {
      const t = types.get(c.source);
      if (!t) throw NexusError.invalid(`The file has no column called ${c.source}.`);
      return { c, expr: convertExpression(c.source, t, c.type, c.format ?? null), text: textOf(c.source, t) };
    });
    // Every filled value must convert; show a few that don't.
    for (const { c, expr, text } of exprs) {
      if (c.type === "text") continue;
      const bad = await sb.rows<{ v: string; n: number }>(
        `SELECT v, count(*) OVER ()::BIGINT AS n FROM (SELECT ${text} AS v, ${expr} AS x FROM ${from}) WHERE v IS NOT NULL AND x IS NULL LIMIT 3`,
      );
      if (bad.length) {
        const label = IMPORT_TYPES.find((t) => t.id === c.type)!.label.toLowerCase();
        throw NexusError.invalid(
          `${Number(bad[0]!.n).toLocaleString("en-US")} value${Number(bad[0]!.n) === 1 ? "" : "s"} in ${c.source} ${Number(bad[0]!.n) === 1 ? "isn't a" : "aren't"} ${label} (for example ${bad.map((b) => `“${b.v}”`).join(", ")}). Choose Text for this column, or fix the file.`,
        );
      }
    }
    if (key) {
      const keyExprs = key.map((k) => exprs.find((e) => e.c.name === k)!.expr);
      const [r] = await sb.rows<{ empty: number; dupes: number }>(
        `SELECT count(*) FILTER (WHERE ${keyExprs.map((e) => `${e} IS NULL`).join(" OR ")})::BIGINT AS empty, (count(*) - count(DISTINCT (${keyExprs.join(", ")})))::BIGINT AS dupes FROM ${from}`,
      );
      if (Number(r?.empty) > 0)
        throw NexusError.invalid(
          `${Number(r!.empty)} row${Number(r!.empty) === 1 ? " has" : "s have"} no ${key.join(" / ")}, so it can't be the primary key. Choose another key or let Nexus add an id column.`,
        );
      if (Number(r?.dupes) > 0)
        throw NexusError.invalid(
          `${key.join(" / ")} repeats in ${Number(r!.dupes)} row${Number(r!.dupes) === 1 ? "" : "s"}, so it can't identify each row. Choose another key or let Nexus add an id column.`,
        );
    }

    let generatedKey: string | null = null;
    if (plan.mode === "create") {
      const defs = cols.map(
        (c) =>
          `${pgIdent(c.name)} ${IMPORT_TYPES.find((t) => t.id === c.type)!.postgres}${key?.includes(c.name) ? " NOT NULL" : ""}`,
      );
      if (!key) {
        generatedKey = names.has("id") ? (names.has("row_id") ? "nexus_row_id" : "row_id") : "id";
        defs.unshift(`${pgIdent(generatedKey)} bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY`);
      } else {
        defs.push(`PRIMARY KEY (${key.map(pgIdent).join(", ")})`);
      }
      await sb.conn.run(
        `CALL postgres_execute('db', ${sqlString(`CREATE TABLE public.${pgIdent(table)} (${defs.join(", ")})`)})`,
      );
    }
    try {
      await sb.conn.run(
        `INSERT INTO db.public.${ident(table)} (${cols.map((c) => ident(c.name)).join(", ")}) SELECT ${exprs.map((e) => e.expr).join(", ")} FROM ${from}`,
      );
    } catch (e) {
      if (plan.mode === "create")
        await sb.conn
          .run(`CALL postgres_execute('db', ${sqlString(`DROP TABLE IF EXISTS public.${pgIdent(table)}`)})`)
          .catch(() => undefined);
      const msg = (e as Error).message;
      if (/duplicate key/i.test(msg))
        throw NexusError.conflict(`Some rows have the same key as rows already in ${table}. Nothing was imported.`);
      throw NexusError.invalid(`The rows couldn't be saved: ${msg.split("\n")[0]}. Nothing was imported.`);
    }
    const [n] = await sb.rows<{ n: number }>(`SELECT count(*)::BIGINT AS n FROM ${from}`);
    return { rows: Number(n?.n ?? 0), table, generatedKey };
  } finally {
    sb.close();
  }
}

function rmIfPresent(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // A later DuckDB error will explain an in-use work file more clearly.
  }
}
