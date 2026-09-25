import { NexusError } from "@nexus/shared";
import { normalizePipeline, type NormalizedPipeline, type PipelineInput } from "./definition";

/**
 * Ready-made pipelines. The person answers a few plain questions (which database, which file,
 * which table…) and gets a complete, valid pipeline they can test and then switch on.
 */

/** What the person wants to do — the "Create Pipeline" choices. */
export type TemplateIntent = "import" | "move" | "warehouse" | "python" | "r" | "transform" | "api" | "export";

export const INTENTS: { id: TemplateIntent; label: string; description: string }[] = [
  { id: "import", label: "Import data", description: "Bring a file (CSV, Excel) into a database." },
  { id: "move", label: "Move data between databases", description: "Copy tables from one database to another." },
  { id: "warehouse", label: "Load warehouse", description: "Keep the Warehouse up to date for reports and dashboards." },
  { id: "python", label: "Run Python script", description: "Clean or reshape data with your own Python code." },
  { id: "r", label: "Run R script", description: "Analyse data with your own R code." },
  { id: "transform", label: "Transform data", description: "Summarise, snapshot or reshape data with SQL." },
  { id: "api", label: "Call API", description: "Fetch data from a web service." },
  { id: "export", label: "Export data", description: "Save data as files (Parquet, CSV, Excel)." },
];

export type FieldKind = "database" | "table" | "file" | "folder" | "url" | "text" | "secret" | "script" | "time" | "column" | "choice";

export interface TemplateField {
  name: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  default?: string;
  help?: string;
  choices?: { value: string; label: string }[];
  /** For "file"/"script": the extensions offered by the file picker. */
  extensions?: string[];
}

export interface PipelineTemplate {
  id: string;
  name: string;
  description: string;
  intents: TemplateIntent[];
  /** Short picture of the flow, e.g. ["Excel file", "Warehouse"]. */
  flow: string[];
  fields: TemplateField[];
  build(v: Record<string, string>): PipelineInput;
}

// ---------------------------------------------------------------- shared fields

const f = {
  database: (label = "Source database"): TemplateField => ({ name: "database", label, kind: "database", required: true }),
  table: (name = "table", label = "Table", help?: string): TemplateField => ({ name, label, kind: "table", required: true, ...(help ? { help } : {}) }),
  target: (label = "Save into table", def?: string): TemplateField => ({ name: "target", label, kind: "text", required: true, ...(def ? { default: def } : {}), help: "A table name like trips or analytics.trips. Nexus creates it if it doesn't exist." }),
  mode: (): TemplateField => ({
    name: "mode",
    label: "Each run",
    kind: "choice",
    required: true,
    default: "replace",
    choices: [
      { value: "replace", label: "Replace the table's contents" },
      { value: "append", label: "Add the new rows" },
    ],
  }),
  time: (def = "02:00"): TemplateField => ({ name: "time", label: "Run every day at", kind: "time", required: false, default: def, help: "Leave empty to run only when started by hand." }),
};

const daily = (v: Record<string, string>) => (v.time ? { schedule: { type: "daily" as const, at: v.time } } : {});
const title = (v: Record<string, string>, fallback: string) => v.name?.trim() || fallback;
const mode = (v: Record<string, string>) => (v.mode === "append" ? "append" : "replace");

function secretHeaders(v: Record<string, string>) {
  return v.secret ? { secretHeaders: { [v.header?.trim() || "Authorization"]: v.secret } } : {};
}

// ---------------------------------------------------------------- the templates

export const TEMPLATES: PipelineTemplate[] = [
  {
    id: "database-to-warehouse",
    name: "Database → Warehouse",
    description: "Copy a table from one of your databases into the Warehouse every day.",
    intents: ["warehouse", "move"],
    flow: ["Database", "Warehouse"],
    fields: [f.database(), f.table(), f.target("Warehouse table"), f.mode(), f.time()],
    build: (v) => ({
      name: title(v, `${v.database} ${v.table} → Warehouse`),
      ...daily(v),
      steps: [
        { id: "extract", uses: "postgres.read", with: { connection: { database: v.database }, table: v.table } },
        { id: "load", uses: "warehouse.write", with: { table: v.target, mode: mode(v) } },
      ],
    }),
  },
  {
    id: "excel-to-database",
    name: "Excel → Database",
    description: "Load a sheet from an Excel workbook into a database table.",
    intents: ["import"],
    flow: ["Excel file", "Database"],
    fields: [
      { name: "file", label: "Excel workbook", kind: "file", required: true, extensions: [".xlsx"] },
      { name: "sheet", label: "Sheet", kind: "text", required: false, help: "Leave empty for the first sheet." },
      f.database("Database"),
      f.target(),
      f.mode(),
    ],
    build: (v) => ({
      name: title(v, `Import ${v.target} from Excel`),
      steps: [
        { id: "workbook", uses: "excel.read", with: { path: v.file, ...(v.sheet ? { sheet: v.sheet } : {}) } },
        { id: "load", uses: "postgres.write", with: { connection: { database: v.database }, table: v.target, mode: mode(v) } },
      ],
    }),
  },
  {
    id: "excel-to-warehouse",
    name: "Excel → Warehouse",
    description: "Load a sheet from an Excel workbook into the Warehouse.",
    intents: ["import", "warehouse"],
    flow: ["Excel file", "Warehouse"],
    fields: [
      { name: "file", label: "Excel workbook", kind: "file", required: true, extensions: [".xlsx"] },
      { name: "sheet", label: "Sheet", kind: "text", required: false, help: "Leave empty for the first sheet." },
      f.target("Warehouse table"),
      f.mode(),
    ],
    build: (v) => ({
      name: title(v, `Excel → Warehouse ${v.target}`),
      steps: [
        { id: "workbook", uses: "excel.read", with: { path: v.file, ...(v.sheet ? { sheet: v.sheet } : {}) } },
        { id: "load", uses: "warehouse.write", with: { table: v.target, mode: mode(v) } },
      ],
    }),
  },
  ...(["database", "warehouse"] as const).map(
    (to): PipelineTemplate => ({
      id: `api-to-${to}`,
      name: `API → ${to === "database" ? "Database" : "Warehouse"}`,
      description: `Fetch records from a web API and save them into ${to === "database" ? "a database table" : "the Warehouse"}.`,
      intents: to === "database" ? ["api", "import"] : ["api", "warehouse"],
      flow: ["Web API", to === "database" ? "Database" : "Warehouse"],
      fields: [
        { name: "url", label: "API address", kind: "url", required: true, help: "The web address that returns the records as JSON." },
        { name: "records", label: "Where the records are", kind: "text", required: false, help: 'For a response like {"data": {"items": [...]}}, enter data.items. Leave empty if the response is the list itself.' },
        { name: "secret", label: "API key (saved secret)", kind: "secret", required: false },
        { name: "header", label: "Send the key in header", kind: "text", required: false, default: "Authorization" },
        ...(to === "database" ? [f.database("Database")] : []),
        f.target(to === "database" ? "Save into table" : "Warehouse table"),
        { ...f.mode(), default: "append" },
        f.time(),
      ],
      build: (v) => ({
        name: title(v, `API → ${v.target}`),
        ...daily(v),
        steps: [
          { id: "fetch", uses: "rest.read", with: { url: v.url, records: v.records ?? "", ...secretHeaders(v) } },
          to === "database"
            ? { id: "load", uses: "postgres.write", with: { connection: { database: v.database }, table: v.target, mode: mode(v) } }
            : { id: "load", uses: "warehouse.write", with: { table: v.target, mode: mode(v) } },
        ],
      }),
    }),
  ),
  {
    id: "csv-to-postgresql",
    name: "CSV → PostgreSQL",
    description: "Load CSV files (one file, or every file matching a pattern) into a database table.",
    intents: ["import"],
    flow: ["CSV files", "Database"],
    fields: [
      { name: "file", label: "CSV file or pattern", kind: "file", required: true, extensions: [".csv"], help: "For example C:\\Data\\trips_*.csv to load every matching file." },
      f.database("Database"),
      f.target(),
      f.mode(),
    ],
    build: (v) => ({
      name: title(v, `Import ${v.target} from CSV`),
      steps: [
        { id: "files", uses: "csv.read", with: { path: v.file } },
        { id: "load", uses: "postgres.write", with: { connection: { database: v.database }, table: v.target, mode: mode(v) } },
      ],
    }),
  },
  {
    id: "postgresql-to-parquet",
    name: "PostgreSQL → Parquet",
    description: "Save a table as a Parquet file (compact, fast to read with Python, R and analytics tools).",
    intents: ["export"],
    flow: ["Database", "Parquet file"],
    fields: [f.database(), f.table(), { name: "folder", label: "Save in folder", kind: "folder", required: true }, f.time("")],
    build: (v) => ({
      name: title(v, `Export ${v.table} to Parquet`),
      ...daily(v),
      steps: [
        { id: "extract", uses: "postgres.read", with: { connection: { database: v.database }, table: v.table } },
        { id: "save", uses: "file.write", with: { path: `${(v.folder ?? "").replace(/[\\/]+$/, "")}\\${(v.table ?? "").replace(/\./g, "_")}_{{run.date}}.parquet` } },
      ],
    }),
  },
  ...(["python", "r"] as const).map(
    (lang): PipelineTemplate => ({
      id: `${lang}-transformation`,
      name: `${lang === "python" ? "Python" : "R"} Transformation`,
      description:
        lang === "python"
          ? "Read a table, clean or reshape it with your Python script (input_data() / output_data()), and save the result in the Warehouse."
          : "Read a table, analyse it with your R script (nexus_input() / nexus_output()), and save the result in the Warehouse.",
      intents: [lang, "transform", "warehouse"],
      flow: ["Database", lang === "python" ? "Python" : "R", "Warehouse"],
      fields: [
        f.database(),
        f.table(),
        { name: "script", label: `${lang === "python" ? "Python" : "R"} script`, kind: "script", required: true, extensions: [lang === "python" ? ".py" : ".R"] },
        f.target("Save the result as"),
        f.time(),
      ],
      build: (v) => ({
        name: title(v, `${lang === "python" ? "Python" : "R"}: ${v.target}`),
        ...daily(v),
        steps: [
          { id: "extract", uses: "postgres.read", with: { connection: { database: v.database }, table: v.table } },
          { id: "script", uses: lang, with: { script: v.script } },
          { id: "load", uses: "warehouse.write", with: { table: v.target, mode: "replace" } },
        ],
      }),
    }),
  ),
  {
    id: "database-backup-export",
    name: "Database Backup Export",
    description: "Every night, save a copy of a table as a dated Parquet file (in addition to Nexus's own backups).",
    intents: ["export"],
    flow: ["Database", "Dated files"],
    fields: [f.database(), f.table(), { name: "folder", label: "Save copies in folder", kind: "folder", required: true }, f.time("01:00")],
    build: (v) => ({
      name: title(v, `Export copy of ${v.table}`),
      ...daily(v),
      steps: [
        { id: "extract", uses: "postgres.read", with: { connection: { database: v.database }, table: v.table } },
        { id: "save", uses: "file.write", with: { path: `${(v.folder ?? "").replace(/[\\/]+$/, "")}\\${(v.database ?? "").replace(/[^\w-]+/g, "_")}_${(v.table ?? "").replace(/\./g, "_")}_{{run.date}}.parquet` } },
      ],
    }),
  },
  {
    id: "daily-incremental-load",
    name: "Daily Incremental Load",
    description: "Load only rows that are new or changed since the last successful run, and update them in the Warehouse.",
    intents: ["warehouse", "move"],
    flow: ["Database (new rows)", "Warehouse"],
    fields: [
      f.database(),
      f.table(),
      { name: "column", label: "Changed-at column", kind: "column", required: true, help: "A column that grows with every change, like updated_at. Nexus suggests one." },
      { name: "key", label: "Row identifier", kind: "column", required: true, default: "id", help: "The column that identifies a row, so changed rows are updated instead of duplicated." },
      f.target("Warehouse table"),
      f.time("02:00"),
    ],
    build: (v) => ({
      name: title(v, `${v.table} incremental → Warehouse`),
      ...daily(v),
      steps: [
        { id: "extract", uses: "postgres.read", with: { connection: { database: v.database }, table: v.table, incremental: { column: v.column } } },
        { id: "load", uses: "warehouse.write", with: { table: v.target, mode: "upsert", key: (v.key ?? "").split(",").map((k) => k.trim()).filter(Boolean) } },
      ],
    }),
  },
  {
    id: "monthly-historical-snapshot",
    name: "Monthly Historical Snapshot",
    description: "On the first of every month, add a dated copy of a table to the Warehouse so you can compare months later.",
    intents: ["warehouse", "transform"],
    flow: ["Database", "Add snapshot date", "Warehouse history"],
    fields: [f.database(), f.table(), f.target("History table", undefined), { ...f.time("03:00"), label: "Run on the 1st at" }],
    build: (v) => ({
      name: title(v, `Monthly snapshot of ${v.table}`),
      ...(v.time ? { schedule: { type: "monthly" as const, day: 1, at: v.time } } : {}),
      steps: [
        { id: "extract", uses: "postgres.read", with: { connection: { database: v.database }, table: v.table } },
        { id: "stamp", uses: "transform", with: { keepOthers: true, columns: [{ name: "snapshot_date", expression: "CAST({{run.date}} AS DATE)" }] } },
        { id: "load", uses: "warehouse.write", with: { table: v.target, mode: "append" } },
      ],
    }),
  },
];

export function template(id: string): PipelineTemplate {
  const t = TEMPLATES.find((x) => x.id === id);
  if (!t) throw NexusError.notFound("Template");
  return t;
}

/** What the UI shows: everything except the build function. */
export function describeTemplates(): Omit<PipelineTemplate, "build">[] {
  return TEMPLATES.map(({ build: _build, ...t }) => t);
}

/**
 * Fills a template with the person's answers. Required answers are checked in plain words; the
 * result is a complete, validated pipeline.
 */
export function instantiateTemplate(id: string, answers: Record<string, string>): NormalizedPipeline {
  const t = template(id);
  const values: Record<string, string> = {};
  for (const field of t.fields) {
    const v = (answers[field.name] ?? field.default ?? "").trim();
    if (field.required && !v) throw NexusError.invalid(`Please fill in "${field.label}".`);
    if (field.choices && v && !field.choices.some((c) => c.value === v)) throw NexusError.invalid(`"${field.label}" must be one of: ${field.choices.map((c) => c.label).join(", ")}.`);
    values[field.name] = v;
  }
  if (answers.name) values.name = answers.name;
  return normalizePipeline(t.build(values));
}
