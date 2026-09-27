import { z } from "zod";

/**
 * The building blocks of a pipeline. Every step is one block: `uses: csv.read`, `uses: python`, …
 * The catalogue drives validation, the visual designer (palette, forms) and the engine.
 * Connectors (2.3) supply the implementation for each kind; this file only describes them.
 */

export type BlockCategory = "source" | "transform" | "destination" | "control";

export interface BlockSpec {
  kind: string;
  category: BlockCategory;
  label: string;
  description: string;
  /** How many upstream steps feed this block. */
  inputs: { min: number; max: number };
  config: z.ZodType;
  /** Config fields holding SQL (dotted paths, * = any list item): placeholders there become quoted literals. */
  sqlFields?: string[];
}

// ---------------------------------------------------------------- shared config pieces

/** A Nexus-managed database by name ("TaxiOps"), or an external one whose URL is kept in a secret. */
const connection = z.union([
  z.object({ database: z.string().min(1) }).strict(),
  z.object({ secret: z.string().min(1) }).strict(),
]);

const mongoCollection = z
  .string()
  .min(1)
  .max(120)
  .refine((v) => !v.includes("\0") && !v.includes("$") && !v.startsWith("system."), "Use a regular MongoDB collection name (not system.* and without $).");

const path = z.string().min(1).max(1000);
const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/, "Use letters, numbers and underscores (starting with a letter).");
const tableName = z.string().regex(/^([A-Za-z_][A-Za-z0-9_]{0,62}\.)?[A-Za-z_][A-Za-z0-9_]{0,62}$/, "Use a table name like trips or analytics.trips.");

/** Loads only new or changed rows since the last successful run (2.6). */
const incremental = z
  .object({
    column: identifier,
    /** First run: start from this value (otherwise everything is loaded once). */
    initial: z.union([z.string(), z.number()]).optional(),
  })
  .strict();

const readSource = z.object({ table: tableName.optional(), query: z.string().min(1).optional(), incremental: incremental.optional() }).strict();
const exactlyOneOf = (v: { table?: string; query?: string }) => !!v.table !== !!v.query;

const writeMode = z.enum(["replace", "append", "upsert"]);
const writeTarget = z
  .object({ table: tableName, mode: writeMode.default("replace"), key: z.array(identifier).min(1).optional() })
  .strict()
  .refine((v) => v.mode !== "upsert" || !!v.key?.length, { message: "Upsert needs the key column(s) that identify a row.", path: ["key"] });

const script = z
  .object({
    script: path,
    /** Extra arguments passed to the script. */
    args: z.array(z.string()).default([]),
    /** Packages to install in addition to the ones Nexus detects. */
    packages: z.array(z.string().min(1)).default([]),
    version: z.string().regex(/^\d+(\.\d+){0,2}$/).optional(),
  })
  .strict();

// ---------------------------------------------------------------- catalogue

const SOURCE = { min: 0, max: 0 };
const ONE = { min: 1, max: 1 };
const MANY = { min: 1, max: 16 };

export const BLOCKS: BlockSpec[] = [
  // Sources
  {
    kind: "postgres.read",
    category: "source",
    sqlFields: ["query"],
    label: "PostgreSQL",
    description: "Read a table or query from a Nexus database or an external PostgreSQL server.",
    inputs: SOURCE,
    config: readSource.extend({ connection }).strict().refine(exactlyOneOf, { message: "Choose a table or write a query (not both)." }),
  },
  {
    kind: "mongodb.read",
    category: "source",
    label: "MongoDB",
    description: "Read a collection from a Nexus document database or an external MongoDB server.",
    inputs: SOURCE,
    config: z
      .object({
        connection,
        /** Optional for external addresses; managed Nexus connections already identify their database. */
        databaseName: z.string().min(1).max(120).optional(),
        collection: mongoCollection,
        /** MongoDB Extended JSON is accepted, so filters can include ObjectIds and dates. */
        filter: z.record(z.string(), z.unknown()).default({}),
        projection: z.record(z.string(), z.union([z.literal(0), z.literal(1)])).optional(),
        batchSize: z.number().int().min(1).max(10_000).default(1000),
      })
      .strict(),
  },
  {
    kind: "sqlite.read",
    category: "source",
    sqlFields: ["query"],
    label: "SQLite",
    description: "Read a table or query from a SQLite file.",
    inputs: SOURCE,
    config: readSource.extend({ path }).strict().refine(exactlyOneOf, { message: "Choose a table or write a query (not both)." }),
  },
  { kind: "csv.read", category: "source", label: "CSV file", description: "Read one CSV file, or every file matching a pattern like C:\\Data\\trips_*.csv.", inputs: SOURCE, config: z.object({ path, delimiter: z.string().length(1).optional(), header: z.boolean().default(true) }).strict() },
  { kind: "excel.read", category: "source", label: "Excel workbook", description: "Read a sheet from an .xlsx workbook.", inputs: SOURCE, config: z.object({ path, sheet: z.string().optional(), range: z.string().regex(/^[A-Z]+\d+:[A-Z]+\d+$/).optional(), header: z.boolean().default(true) }).strict() },
  { kind: "json.read", category: "source", label: "JSON file", description: "Read a JSON array or JSON Lines file.", inputs: SOURCE, config: z.object({ path }).strict() },
  { kind: "parquet.read", category: "source", label: "Parquet file", description: "Read Parquet files (a single file or a pattern).", inputs: SOURCE, config: z.object({ path }).strict() },
  {
    kind: "rest.read",
    category: "source",
    label: "REST API",
    description: "Call a web API and turn its JSON response into rows.",
    inputs: SOURCE,
    config: z
      .object({
        url: z.string().url().or(z.string().regex(/\{\{/)),
        method: z.enum(["GET", "POST"]).default("GET"),
        headers: z.record(z.string(), z.string()).default({}),
        /** Header name → Nexus secret name; the value is injected at run time and never stored in the pipeline. */
        secretHeaders: z.record(z.string(), z.string()).default({}),
        body: z.unknown().optional(),
        /** Where the records are in the response, e.g. "data.items". Empty = the whole response. */
        records: z.string().default(""),
        pagination: z
          .discriminatedUnion("type", [
            z.object({ type: z.literal("page"), param: z.string().default("page"), start: z.number().int().default(1), maxPages: z.number().int().min(1).max(10_000).default(100) }),
            z.object({ type: z.literal("cursor"), param: z.string(), next: z.string(), maxPages: z.number().int().min(1).max(10_000).default(100) }),
          ])
          .optional(),
      })
      .strict(),
  },
  { kind: "storage.read", category: "source", label: "Nexus Storage file", description: "Read a CSV, JSON, Parquet or Excel file uploaded to an application's storage.", inputs: SOURCE, config: z.object({ app: z.string().min(1), path }).strict() },
  { kind: "warehouse.read", category: "source", sqlFields: ["query"], label: "Warehouse", description: "Read a table or query from the Nexus Warehouse.", inputs: SOURCE, config: readSource.refine(exactlyOneOf, { message: "Choose a table or write a query (not both)." }) },

  // Transforms
  { kind: "python", category: "transform", label: "Python script", description: "Run a Python script. It receives the incoming data with input_data() and returns results with output_data().", inputs: { min: 0, max: 16 }, config: script },
  { kind: "r", category: "transform", label: "R script", description: "Run an R script. It receives the incoming data with nexus_input() and returns results with nexus_output().", inputs: { min: 0, max: 16 }, config: script },
  { kind: "sql", category: "transform", sqlFields: ["query"], label: "SQL", description: "Transform the incoming data with SQL. Refer to the input as `input` (or by step name when there are several).", inputs: MANY, config: z.object({ query: z.string().min(1).max(200_000) }).strict() },
  { kind: "filter", category: "transform", sqlFields: ["where"], label: "Filter", description: "Keep only the rows that match a condition, e.g. status = 'Completed'.", inputs: ONE, config: z.object({ where: z.string().min(1).max(10_000) }).strict() },
  {
    kind: "transform",
    category: "transform",
    sqlFields: ["columns.*.expression"],
    label: "Transform columns",
    description: "Keep, rename or calculate columns.",
    inputs: ONE,
    config: z
      .object({
        columns: z.array(z.object({ name: identifier, expression: z.string().min(1).max(5000).optional() }).strict()).min(1),
        /** Keep the other columns too (default: only the listed ones). */
        keepOthers: z.boolean().default(false),
      })
      .strict(),
  },
  {
    kind: "join",
    category: "transform",
    label: "Join",
    description: "Combine two inputs on matching columns.",
    inputs: { min: 2, max: 2 },
    config: z.object({ type: z.enum(["inner", "left", "right", "full"]).default("inner"), on: z.array(z.object({ left: identifier, right: identifier }).strict()).min(1) }).strict(),
  },
  {
    kind: "aggregate",
    category: "transform",
    label: "Aggregate",
    description: "Group rows and calculate totals, counts and averages.",
    inputs: ONE,
    config: z
      .object({
        groupBy: z.array(identifier).default([]),
        measures: z
          .array(z.object({ name: identifier, fn: z.enum(["count", "count_distinct", "sum", "avg", "min", "max"]), column: identifier.optional() }).strict().refine((m) => m.fn === "count" || !!m.column, { message: "Choose the column to calculate." }))
          .min(1),
      })
      .strict(),
  },
  { kind: "deduplicate", category: "transform", label: "Remove duplicates", description: "Remove duplicate rows (optionally by chosen columns).", inputs: ONE, config: z.object({ columns: z.array(identifier).default([]) }).strict() },
  {
    kind: "validate",
    category: "transform",
    label: "Validate",
    description: "Check data quality rules before loading.",
    inputs: ONE,
    config: z
      .object({
        rules: z
          .array(
            z
              .object({
                column: identifier,
                check: z.enum(["not_null", "unique", "min", "max", "matches", "one_of"]),
                value: z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))]).optional(),
              })
              .strict()
              .refine((r) => ["not_null", "unique"].includes(r.check) || r.value !== undefined, { message: "This check needs a value." }),
          )
          .min(1),
        /** fail = stop the pipeline; warn = continue and report; drop = remove failing rows. */
        onFailure: z.enum(["fail", "warn", "drop"]).default("fail"),
      })
      .strict(),
  },

  // In-database transformations (ELT): the work happens inside PostgreSQL, no data moves.
  {
    kind: "warehouse.transform",
    category: "transform",
    sqlFields: ["query"],
    label: "SQL in the Warehouse",
    description: "Build a table or view in the Warehouse from a SELECT that runs inside the Warehouse (ELT). Best for large data.",
    inputs: { min: 0, max: 16 },
    config: z.object({ query: z.string().min(1).max(200_000), table: tableName, materialize: z.enum(["table", "append", "view"]).default("table") }).strict(),
  },
  {
    kind: "postgres.transform",
    category: "transform",
    sqlFields: ["query"],
    label: "SQL in a database",
    description: "Build a table or view in a PostgreSQL database from a SELECT that runs inside it (ELT).",
    inputs: { min: 0, max: 16 },
    config: z.object({ connection, query: z.string().min(1).max(200_000), table: tableName, materialize: z.enum(["table", "append", "view"]).default("table") }).strict(),
  },

  // Destinations
  { kind: "postgres.write", category: "destination", label: "PostgreSQL", description: "Load the data into a table in a Nexus database or an external PostgreSQL server.", inputs: ONE, config: z.intersection(writeTarget, z.object({ connection })) },
  { kind: "warehouse.write", category: "destination", label: "Warehouse", description: "Load the data into the Nexus Warehouse for reporting and dashboards.", inputs: ONE, config: writeTarget },
  { kind: "file.write", category: "destination", label: "Export file", description: "Save the data as CSV, Parquet, JSON or Excel.", inputs: ONE, config: z.object({ path, format: z.enum(["csv", "parquet", "json", "excel"]).optional() }).strict() },
  { kind: "storage.write", category: "destination", label: "Nexus Storage", description: "Save the data as a file in an application's storage.", inputs: ONE, config: z.object({ app: z.string().min(1), path, format: z.enum(["csv", "parquet", "json"]).optional() }).strict() },
  {
    kind: "api.write",
    category: "destination",
    label: "API output",
    description: "Send the rows to a web API as JSON, in batches.",
    inputs: ONE,
    config: z.object({ url: z.string().min(1), method: z.enum(["POST", "PUT"]).default("POST"), headers: z.record(z.string(), z.string()).default({}), secretHeaders: z.record(z.string(), z.string()).default({}), batchSize: z.number().int().min(1).max(10_000).default(500) }).strict(),
  },

  // Control
  { kind: "notify", category: "control", label: "Notification", description: "Send a message when the pipeline reaches this point.", inputs: { min: 0, max: 16 }, config: z.object({ message: z.string().min(1).max(2000) }).strict() },
];

const byKind = new Map(BLOCKS.map((b) => [b.kind, b]));

export function block(kind: string): BlockSpec | undefined {
  return byKind.get(kind);
}
