import { ArrowRight, CheckCircle2, FileJson, FileSpreadsheet, Upload } from "lucide-react";
import { useState } from "react";
import { ApiError, del, post } from "../lib/api";
import { ErrorNote, Modal, Spinner } from "./ui";

type ImportType = "text" | "integer" | "decimal" | "date" | "timestamp" | "boolean";

interface ImportColumn {
  source: string;
  name: string;
  type: ImportType;
  format: string | null;
  sourceType: string;
  empty: number;
  distinct: number;
  examples: string[];
  note: string | null;
}

interface ImportPreview {
  importId: string;
  fileName: string;
  format: "csv" | "excel" | "json";
  sheets: string[];
  sheet: string | null;
  rows: number;
  columns: ImportColumn[];
  sample: Record<string, string | null>[];
  suggestedTable: string;
  primaryKey: string[] | null;
  existingTables: string[];
}

type DraftColumn = ImportColumn & { include: boolean };
type Result = { rows: number; table: string; generatedKey: string | null };

const TYPES: { id: ImportType; label: string }[] = [
  { id: "text", label: "Text" },
  { id: "integer", label: "Whole number" },
  { id: "decimal", label: "Decimal number" },
  { id: "date", label: "Date" },
  { id: "timestamp", label: "Date and time" },
  { id: "boolean", label: "Yes / no" },
];

const DATE_FORMATS = [
  ["", "Automatic"],
  ["%m/%d/%Y", "Month/day/year (03/21/2026)"],
  ["%d/%m/%Y", "Day/month/year (21/03/2026)"],
  ["%Y-%m-%d", "Year-month-day (2026-03-21)"],
  ["%d.%m.%Y", "Day.month.year (21.03.2026)"],
] as const;

function plainError(e: unknown): ApiError {
  return e instanceof ApiError
    ? e
    : new ApiError(e instanceof Error ? e.message : "The import didn't work.", 0, "network", null);
}

export function ImportData({
  databaseId,
  onClose,
  onImported,
}: {
  databaseId: string;
  onClose: () => void;
  onImported: (table: string) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [columns, setColumns] = useState<DraftColumn[]>([]);
  const [mode, setMode] = useState<"create" | "append">("create");
  const [table, setTable] = useState("");
  const [primaryKey, setPrimaryKey] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  function apply(next: ImportPreview) {
    setPreview(next);
    setColumns(next.columns.map((c) => ({ ...c, include: true })));
    setTable(next.suggestedTable);
    setPrimaryKey(next.primaryKey?.[0] ?? "");
  }

  async function upload() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      apply(await post<ImportPreview>(`/databases/${databaseId}/imports`, form));
    } catch (e) {
      setError(plainError(e));
    } finally {
      setBusy(false);
    }
  }

  async function chooseSheet(sheet: string) {
    if (!preview || sheet === preview.sheet) return;
    setBusy(true);
    setError(null);
    try {
      apply(await post<ImportPreview>(`/databases/${databaseId}/imports/${preview.importId}/analyze`, { sheet }));
    } catch (e) {
      setError(plainError(e));
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      setResult(
        await post<Result>(`/databases/${databaseId}/imports/${preview.importId}/run`, {
          table,
          mode,
          sheet: preview.sheet,
          columns: columns.map((c) => ({
            source: c.source,
            name: c.name,
            type: c.type,
            format: c.format,
            include: c.include,
          })),
          primaryKey: mode === "create" && primaryKey ? [primaryKey] : null,
        }),
      );
    } catch (e) {
      setError(plainError(e));
    } finally {
      setBusy(false);
    }
  }

  function close() {
    if (busy) return;
    if (preview && !result) void del(`/databases/${databaseId}/imports/${preview.importId}`).catch(() => undefined);
    onClose();
  }

  const included = columns.filter((c) => c.include);
  const keyIsValid = !primaryKey || included.some((c) => c.name === primaryKey);
  const valid = !!table.trim() && included.length > 0 && keyIsValid;

  return (
    <Modal
      title="Import data"
      wide
      onClose={close}
      footer={
        result ? (
          <button className="btn primary" onClick={() => onImported(result.table)}>
            View {result.table} <ArrowRight size={15} />
          </button>
        ) : preview ? (
          <>
            <button className="btn" disabled={busy} onClick={close}>
              Cancel
            </button>
            <button className="btn primary" disabled={busy || !valid} onClick={() => void run()}>
              {busy ? <Spinner label="Importing…" /> : `Import ${preview.rows.toLocaleString()} rows`}
            </button>
          </>
        ) : (
          <>
            <button className="btn" disabled={busy} onClick={close}>
              Cancel
            </button>
            <button className="btn primary" disabled={!file || busy} onClick={() => void upload()}>
              {busy ? (
                <Spinner label="Reading file…" />
              ) : (
                <>
                  Review file <ArrowRight size={15} />
                </>
              )}
            </button>
          </>
        )
      }
    >
      <ol className="import-steps" aria-label="Import progress">
        <li className={!preview ? "active" : "done"}>
          <span>1</span> Choose file
        </li>
        <li className={preview && !result ? "active" : result ? "done" : ""}>
          <span>2</span> Review
        </li>
        <li className={result ? "done" : ""}>
          <span>3</span> Import
        </li>
      </ol>

      {!preview && !result && (
        <div className="import-picker">
          <span className="import-picker-icon">
            <Upload size={30} />
          </span>
          <h3>Choose a data file</h3>
          <p>
            CSV, Excel (.xlsx), or JSON. Nexus will inspect the columns and suggest safe database types before it saves
            anything.
          </p>
          <label className="btn primary import-file-button">
            <FileSpreadsheet size={16} /> Choose File
            <input
              type="file"
              accept=".csv,.txt,.tsv,.xlsx,.json,.jsonl,.ndjson"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
          {file && (
            <div className="notice import-file">
              <FileJson size={17} />
              <span>
                <strong>{file.name}</strong>
                <small>{(file.size / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KB</small>
              </span>
            </div>
          )}
        </div>
      )}

      {preview && !result && (
        <div className="import-review">
          <div className="import-summary">
            <span>
              <strong>{preview.fileName}</strong>
              <small>
                {preview.rows.toLocaleString()} rows · {preview.columns.length} columns
              </small>
            </span>
            {preview.sheets.length > 1 && (
              <label className="field">
                Excel sheet
                <select
                  className="select"
                  value={preview.sheet ?? ""}
                  disabled={busy}
                  onChange={(e) => void chooseSheet(e.target.value)}
                >
                  {preview.sheets.map((s) => (
                    <option value={s} key={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          <div className="import-target">
            <div className="choice-stack compact">
              <button
                className={`choice ${mode === "create" ? "selected" : ""}`}
                onClick={() => {
                  setMode("create");
                  setTable(preview.suggestedTable);
                }}
              >
                <span>
                  <strong className="title">Create a new table</strong>
                  <span className="desc">Recommended · keeps existing data unchanged</span>
                </span>
              </button>
              <button
                className={`choice ${mode === "append" ? "selected" : ""}`}
                disabled={!preview.existingTables.length}
                onClick={() => {
                  setMode("append");
                  setTable(preview.existingTables[0] ?? "");
                  setPrimaryKey("");
                }}
              >
                <span>
                  <strong className="title">Add rows to an existing table</strong>
                  <span className="desc">Column names must match the table</span>
                </span>
              </button>
            </div>
            <label className="field">
              {mode === "create" ? "New table name" : "Existing table"}
              {mode === "create" ? (
                <input
                  className="input mono"
                  value={table}
                  maxLength={63}
                  onChange={(e) => setTable(e.target.value.toLowerCase())}
                />
              ) : (
                <select className="select mono" value={table} onChange={(e) => setTable(e.target.value)}>
                  {preview.existingTables.map((t) => (
                    <option value={t} key={t}>
                      {t}
                    </option>
                  ))}
                </select>
              )}
            </label>
            {mode === "create" && (
              <label className="field">
                Primary key
                <select className="select" value={primaryKey} onChange={(e) => setPrimaryKey(e.target.value)}>
                  <option value="">Add an automatic ID</option>
                  {included.map((c) => (
                    <option value={c.name} key={c.source}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <span className="hint">The value that uniquely identifies each row.</span>
              </label>
            )}
          </div>

          <div className="import-columns">
            <div className="import-columns-head">
              <strong>Columns</strong>
              <span className="small muted">Review the suggested names and types</span>
            </div>
            {columns.map((column, index) => (
              <div className={`import-column ${column.include ? "" : "excluded"}`} key={column.source}>
                <label className="import-include" title="Include this column">
                  <input
                    type="checkbox"
                    checked={column.include}
                    onChange={(e) =>
                      setColumns((all) => all.map((c, i) => (i === index ? { ...c, include: e.target.checked } : c)))
                    }
                  />
                </label>
                <span className="import-source">
                  <strong>{column.source}</strong>
                  <small>
                    {column.empty ? `${column.empty.toLocaleString()} empty · ` : ""}
                    {column.distinct.toLocaleString()} unique
                    {column.examples.length ? ` · ${column.examples.join(", ")}` : ""}
                  </small>
                </span>
                <input
                  className="input mono"
                  aria-label={`Database name for ${column.source}`}
                  disabled={!column.include}
                  value={column.name}
                  maxLength={63}
                  onChange={(e) =>
                    setColumns((all) =>
                      all.map((c, i) => (i === index ? { ...c, name: e.target.value.toLowerCase() } : c)),
                    )
                  }
                />
                <select
                  className="select"
                  aria-label={`Type for ${column.source}`}
                  disabled={!column.include}
                  value={column.type}
                  onChange={(e) =>
                    setColumns((all) =>
                      all.map((c, i) => (i === index ? { ...c, type: e.target.value as ImportType, format: null } : c)),
                    )
                  }
                >
                  {TYPES.map((t) => (
                    <option value={t.id} key={t.id}>
                      {t.label}
                    </option>
                  ))}
                </select>
                {(column.type === "date" || column.type === "timestamp") && (
                  <select
                    className="select import-format"
                    aria-label={`Date format for ${column.source}`}
                    disabled={!column.include}
                    value={column.format ?? ""}
                    onChange={(e) =>
                      setColumns((all) =>
                        all.map((c, i) => (i === index ? { ...c, format: e.target.value || null } : c)),
                      )
                    }
                  >
                    {DATE_FORMATS.map(([value, label]) => (
                      <option value={value} key={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                )}
                {column.note && <small className="import-note">{column.note}</small>}
              </div>
            ))}
          </div>

          {preview.sample.length > 0 && (
            <div className="import-preview">
              <strong>First {preview.sample.length} rows</strong>
              <div className="sheet-wrap">
                <table className="sheet">
                  <thead>
                    <tr>
                      {preview.columns.map((c) => (
                        <th key={c.source}>
                          <span>{c.source}</span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.sample.map((row, i) => (
                      <tr key={i}>
                        {preview.columns.map((c) => (
                          <td key={c.source}>
                            <span className="import-cell">{row[c.source] ?? "NULL"}</span>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {result && (
        <div className="import-complete">
          <CheckCircle2 size={42} />
          <h3>Import complete</h3>
          <p>
            <strong>{result.rows.toLocaleString()} rows</strong> are now in <span className="mono">{result.table}</span>
            .
          </p>
          {result.generatedKey && (
            <p className="secondary">
              Nexus added <span className="mono">{result.generatedKey}</span> as the primary key.
            </p>
          )}
        </div>
      )}
      <ErrorNote error={error} />
    </Modal>
  );
}
