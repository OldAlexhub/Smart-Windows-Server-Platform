import { Code2, MessageCircleQuestion, Search, Sparkles } from "lucide-react";
import { useState } from "react";
import { ApiError, post } from "../lib/api";
import { AnswerChart, type ChartSpec } from "./AnswerChart";
import { ErrorNote, Spinner } from "./ui";

interface Answer {
  question: string | null;
  sql: string;
  explanation: string;
  summary: string | null;
  columns: { name: string; kind: string }[];
  rows: Record<string, unknown>[];
  truncated: boolean;
  chart: ChartSpec | null;
  repaired: boolean;
  durationMs: number;
  statements?: StatementResult[];
}

interface StatementResult {
  command: string;
  rowCount: number | null;
  columns: Answer["columns"];
  rows: Answer["rows"];
  truncated: boolean;
}

const SHOWN = 200;

function cell(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return v.toLocaleString(undefined, { maximumFractionDigits: 4 });
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function ResultTable({ columns, rows }: Pick<StatementResult, "columns" | "rows">) {
  if (!columns.length) return null;
  return (
    <div className="sheet-wrap answer-table">
      <table className="sheet">
        <thead><tr>{columns.map((column) => <th key={column.name}><div className="preview-th"><span>{column.name}</span></div></th>)}</tr></thead>
        <tbody>
          {rows.slice(0, SHOWN).map((row, index) => (
            <tr key={index}>{columns.map((column) => <td key={column.name} className={column.kind === "number" ? "num" : ""}><span className="cell-value">{cell(row[column.name])}</span></td>)}</tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <div className="database-empty"><span>No rows.</span></div>}
    </div>
  );
}

function StatementOutput({ result, index, total }: { result: StatementResult; index: number; total: number }) {
  const count = result.rowCount === null ? null : result.rowCount.toLocaleString();
  const status = count === null
    ? "Completed successfully."
    : result.command === "SELECT" || result.command === "SHOW" || result.command === "VALUES" || result.command === "TABLE"
      ? `${count}${result.truncated ? "+" : ""} ${result.rowCount === 1 ? "row" : "rows"} returned.`
      : `${count} ${result.rowCount === 1 ? "row" : "rows"} affected.`;
  return (
    <div className="sql-statement-result">
      <p className="small secondary"><strong>{total > 1 ? `Statement ${index + 1} · ` : ""}{result.command}</strong> — {status}</p>
      <ResultTable columns={result.columns} rows={result.rows} />
    </div>
  );
}

/** Plain-English questions stay read-only; authorized users may run full PostgreSQL statements. */
export function AskData({ databaseId, aiReady, canRunSql, onSqlExecuted }: { databaseId: string; aiReady: boolean; canRunSql: boolean; onSqlExecuted?: () => void }) {
  const [mode, setMode] = useState<"ask" | "sql">(!aiReady && canRunSql ? "sql" : "ask");
  const [question, setQuestion] = useState("");
  const [sql, setSql] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);

  async function run() {
    setBusy(true);
    setErr(null);
    try {
      const a = mode === "ask" ? await post<Answer>(`/databases/${databaseId}/ask`, { question }) : await post<Answer>(`/databases/${databaseId}/query`, { sql });
      setAnswer(a);
      setSql(a.sql);
      if (mode === "sql") onSqlExecuted?.();
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card ask-data" aria-label="Ask about this data">
      <div className="ask-head">
        <h2><MessageCircleQuestion size={18} /> Ask about this data</h2>
        <div className="segmented" role="radiogroup" aria-label="How to ask">
          <button type="button" role="radio" aria-checked={mode === "ask"} className={mode === "ask" ? "active" : ""} onClick={() => setMode("ask")}><Sparkles size={13} /> In plain English</button>
          {canRunSql && <button type="button" role="radio" aria-checked={mode === "sql"} className={mode === "sql" ? "active" : ""} onClick={() => setMode("sql")}><Code2 size={13} /> SQL</button>}
        </div>
      </div>
      <form
        className="data-ask-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        {mode === "ask" ? (
          <input className="input" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="e.g. Which provider completed the most trips last month?" aria-label="Your question" maxLength={2000} />
        ) : (
          <textarea className="input mono sql-input" value={sql} onChange={(e) => setSql(e.target.value)} placeholder="select status, count(*) from trips group by status" aria-label="SQL query" spellCheck={false} />
        )}
        <button className="btn primary" disabled={busy || (mode === "ask" ? !question.trim() : !sql.trim())}>{busy ? <Spinner label={mode === "ask" ? "Thinking…" : "Running…"} /> : <><Search size={15} /> {mode === "ask" ? "Ask" : "Run"}</>}</button>
      </form>
      <p className={`small ${mode === "sql" ? "sql-write-warning" : "muted"}`}>
        {mode === "ask"
          ? `Plain-English questions only read data — nothing can be changed.${!aiReady ? canRunSql ? " The AI isn't ready yet; you can use SQL instead." : " The AI isn't ready yet." : ""}`
          : "SQL runs with write access. You can use SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, TRUNCATE, and multiple statements."}
      </p>
      <ErrorNote error={err} />
      {answer && (
        <div className="answer">
          {answer.summary && <p className="answer-summary">{answer.summary}</p>}
          {answer.explanation && <p className="small secondary">{answer.explanation}{answer.repaired ? " (The first attempt had a mistake; the AI corrected it.)" : ""}</p>}
          {answer.chart && <AnswerChart spec={answer.chart} rows={answer.rows} />}
          {answer.statements?.length
            ? answer.statements.map((statement, index) => <StatementOutput key={index} result={statement} index={index} total={answer.statements!.length} />)
            : <ResultTable columns={answer.columns} rows={answer.rows} />}
          <p className="small muted">
            {answer.statements?.length
              ? `${answer.statements.length} ${answer.statements.length === 1 ? "statement" : "statements"} completed`
              : answer.rows.length > SHOWN
                ? `Showing ${SHOWN} of ${answer.rows.length}${answer.truncated ? "+" : ""} rows`
                : `${answer.rows.length.toLocaleString()}${answer.truncated ? "+" : ""} ${answer.rows.length === 1 ? "row" : "rows"}`} · {(answer.durationMs / 1000).toFixed(1)}s
          </p>
          {answer.question && (
            <details>
              <summary className="small">Show the SQL</summary>
              <pre className="mono answer-sql">{answer.sql}</pre>
              {canRunSql && <button className="btn small" onClick={() => setMode("sql")}>Edit as SQL</button>}
            </details>
          )}
        </div>
      )}
    </section>
  );
}
