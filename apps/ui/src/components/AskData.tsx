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
}

const SHOWN = 200;

function cell(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return v.toLocaleString(undefined, { maximumFractionDigits: 4 });
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** "Ask a question about this database" — plain English (local AI) or SQL, always read-only. */
export function AskData({ databaseId, aiReady }: { databaseId: string; aiReady: boolean }) {
  const [mode, setMode] = useState<"ask" | "sql">(aiReady ? "ask" : "sql");
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
          <button type="button" role="radio" aria-checked={mode === "sql"} className={mode === "sql" ? "active" : ""} onClick={() => setMode("sql")}><Code2 size={13} /> SQL</button>
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
      <p className="small muted">Questions only read data — nothing can be changed from here.{mode === "ask" && !aiReady ? " The AI isn't ready yet, so plain-English questions may not work; SQL always does." : ""}</p>
      <ErrorNote error={err} />
      {answer && (
        <div className="answer">
          {answer.summary && <p className="answer-summary">{answer.summary}</p>}
          {answer.explanation && <p className="small secondary">{answer.explanation}{answer.repaired ? " (The first attempt had a mistake; the AI corrected it.)" : ""}</p>}
          {answer.chart && <AnswerChart spec={answer.chart} rows={answer.rows} />}
          <div className="sheet-wrap answer-table">
            <table className="sheet">
              <thead><tr>{answer.columns.map((c) => <th key={c.name}><div className="preview-th"><span>{c.name}</span></div></th>)}</tr></thead>
              <tbody>
                {answer.rows.slice(0, SHOWN).map((r, i) => (
                  <tr key={i}>{answer.columns.map((c) => <td key={c.name} className={c.kind === "number" ? "num" : ""}><span className="cell-value">{cell(r[c.name])}</span></td>)}</tr>
                ))}
              </tbody>
            </table>
            {answer.rows.length === 0 && <div className="database-empty"><span>No rows.</span></div>}
          </div>
          <p className="small muted">
            {answer.rows.length > SHOWN ? `Showing ${SHOWN} of ${answer.rows.length}${answer.truncated ? "+" : ""} rows` : `${answer.rows.length.toLocaleString()}${answer.truncated ? "+" : ""} ${answer.rows.length === 1 ? "row" : "rows"}`} · {(answer.durationMs / 1000).toFixed(1)}s
          </p>
          {answer.question && (
            <details>
              <summary className="small">Show the SQL</summary>
              <pre className="mono answer-sql">{answer.sql}</pre>
              <button className="btn small" onClick={() => setMode("sql")}>Edit as SQL</button>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
