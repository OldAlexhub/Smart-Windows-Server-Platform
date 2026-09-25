import { mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";

/** A step's data on disk: always a Parquet file, so Python, R and DuckDB all read it natively. */
export interface Dataset {
  path: string;
  rows: number;
  columns: { name: string; type: string }[];
  bytes: number;
}

/** Forward slashes and doubled quotes: safe inside a DuckDB string literal. */
export const sqlPath = (p: string) => `'${resolve(p).replace(/\\/g, "/").replace(/'/g, "''")}'`;
export const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;
export const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

export interface SandboxOptions {
  /** Folders the SQL may read and write (the step's own folder, its inputs' folders). */
  directories: string[];
  /** Individual files it may read (a configured source file). */
  files?: string[];
  tempDir: string;
  memoryLimitMb?: number;
  threads?: number;
  /** Extension files to load before the sandbox is locked (Excel, PostgreSQL…). */
  extensions?: string[];
  /**
   * Statements the connector (never the user) runs before the sandbox is locked, e.g. attaching the
   * PostgreSQL database it reads from. What they open stays usable; nothing new can be opened later.
   */
  setup?: string[];
}

export interface Sandbox {
  conn: DuckDBConnection;
  /** Runs a query and returns plain JS rows (BigInts become numbers where safe). */
  rows<T = Record<string, unknown>>(sql: string): Promise<T[]>;
  close(): void;
}

function plain(v: unknown): unknown {
  if (typeof v === "bigint") return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  return v;
}

/**
 * An isolated DuckDB for one step. Its SQL can only touch the listed folders and files; reading
 * anything else on the computer, attaching databases, installing extensions or using the network
 * is refused, and the SQL can't lift these limits (the configuration is locked).
 */
export async function openSandbox(o: SandboxOptions): Promise<Sandbox> {
  mkdirSync(o.tempDir, { recursive: true });
  const instance = await DuckDBInstance.create(":memory:", {
    threads: String(Math.max(1, o.threads ?? 2)),
    ...(o.memoryLimitMb ? { memory_limit: `${Math.max(128, Math.floor(o.memoryLimitMb))}MB` } : {}),
    autoinstall_known_extensions: "false",
    autoload_known_extensions: "false",
  });
  const conn = await instance.connect();
  try {
    for (const ext of o.extensions ?? []) await conn.run(`LOAD ${sqlPath(ext)}`);
    for (const statement of o.setup ?? []) await conn.run(statement);
    await conn.run(`SET temp_directory = ${sqlPath(o.tempDir)}`);
    const dirs = [...new Set([...o.directories, o.tempDir].map((d) => `${resolve(d).replace(/\\/g, "/").replace(/\/?$/, "/")}`))];
    await conn.run(`SET allowed_directories = [${dirs.map(sqlString).join(", ")}]`);
    if (o.files?.length) await conn.run(`SET allowed_paths = [${o.files.map((f) => sqlString(resolve(f).replace(/\\/g, "/"))).join(", ")}]`);
    await conn.run("SET enable_external_access = false");
    await conn.run("SET lock_configuration = true");
  } catch (e) {
    conn.closeSync();
    instance.closeSync();
    throw e;
  }
  return {
    conn,
    async rows<T>(sql: string) {
      const r = await conn.runAndReadAll(sql);
      return r.getRowObjects().map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, plain(v)]))) as T[];
    },
    close() {
      conn.closeSync();
      instance.closeSync();
    },
  };
}

/** Writes a query's result as the step's Parquet output and describes it. */
export async function writeDataset(sb: Sandbox, query: string, path: string): Promise<Dataset> {
  mkdirSync(dirname(path), { recursive: true });
  await sb.conn.run(`COPY (${query}) TO ${sqlPath(path)} (FORMAT parquet, COMPRESSION zstd)`);
  return describeDataset(sb, path);
}

export async function describeDataset(sb: Sandbox, path: string): Promise<Dataset> {
  const [count] = await sb.rows<{ n: number }>(`SELECT count(*)::BIGINT AS n FROM read_parquet(${sqlPath(path)})`);
  const cols = await sb.rows<{ column_name: string; column_type: string }>(`DESCRIBE SELECT * FROM read_parquet(${sqlPath(path)})`);
  return { path, rows: Number(count?.n ?? 0), columns: cols.map((c) => ({ name: c.column_name, type: c.column_type })), bytes: statSync(path).size };
}

/** Creates `name` as a view over an input dataset. */
export async function attachInput(sb: Sandbox, name: string, ds: Dataset): Promise<void> {
  await sb.conn.run(`CREATE OR REPLACE VIEW ${ident(name)} AS SELECT * FROM read_parquet(${sqlPath(ds.path)})`);
}

export const outputPath = (stepDir: string) => join(stepDir, "output.parquet");
