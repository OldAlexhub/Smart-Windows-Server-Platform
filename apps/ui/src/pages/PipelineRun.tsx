import { ArrowLeft, ChevronDown, ChevronRight, Download, RotateCcw, Square, Table2 } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { Me } from "../App";
import { PageHead } from "../components/Layout";
import { AiExplanationCard, type AiExplanation } from "../components/AiExplanation";
import { ErrorNote, Modal, Spinner, Status } from "../components/ui";
import { ApiError, post } from "../lib/api";
import { useApi } from "../lib/hooks";
import { formatDuration, formatRows, runTone, TRIGGER_LABEL, type LogLine, type PipelineDetailData, type Preview, type Run, type StepRun } from "../lib/pipelines";

function cell(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function PreviewDialog({ runId, step, onClose }: { runId: string; step: string; onClose: () => void }) {
  const [offset, setOffset] = useState(0);
  const { data, error, loading } = useApi<Preview>(`/pipeline-runs/${runId}/steps/${encodeURIComponent(step)}/preview?limit=100&offset=${offset}`);
  return (
    <Modal wide title={`Data after ${step}`} onClose={onClose} footer={<button className="btn" onClick={onClose}>Close</button>}>
      <ErrorNote error={error} />
      {loading && !data ? <Spinner /> : data && (
        <>
          <p className="small muted">{data.totalRows.toLocaleString()} rows · showing {data.totalRows ? offset + 1 : 0}–{offset + data.rows.length}</p>
          <div className="sheet-wrap preview-wrap">
            <table className="sheet">
              <thead><tr>{data.columns.map((c) => <th key={c.name}><div className="preview-th"><span>{c.name}</span><small>{c.type}</small></div></th>)}</tr></thead>
              <tbody>{data.rows.map((r, i) => <tr key={i}>{data.columns.map((c) => <td key={c.name}><span className="cell-value">{cell(r[c.name])}</span></td>)}</tr>)}</tbody>
            </table>
          </div>
          <div className="pagination">
            <span className="spacer" />
            <button className="btn small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 100))}>Previous</button>
            <button className="btn small" disabled={!data.hasMore} onClick={() => setOffset(offset + 100)}>Next</button>
          </div>
        </>
      )}
    </Modal>
  );
}

function StepRow({ s, label, runId, onPreview }: { s: StepRun; label: string; runId: string; onPreview: () => void }) {
  const [open, setOpen] = useState(s.status === "failed");
  const t = runTone(s.status);
  const m = s.metrics;
  const out = m?.rowsWritten ?? m?.rowsOut;
  const diff = m && m.rowsOut != null && m.rowsIn > 0 ? m.rowsOut - m.rowsIn : null;
  const hasMore = !!(s.error || s.warnings.length || m?.quality?.length || s.environment);
  return (
    <li className={`step-run ${s.status}`}>
      <button className="step-run-head" onClick={() => setOpen(!open)} aria-expanded={open} disabled={!hasMore}>
        {hasMore ? open ? <ChevronDown size={15} /> : <ChevronRight size={15} /> : <span style={{ width: 15 }} />}
        <span className="step-run-name"><strong>{label}</strong><small className="muted">{[label !== s.stepId ? s.stepId : null, s.attempts > 1 ? `${s.attempts} attempts` : null].filter(Boolean).join(" · ")}</small></span>
        <Status tone={t.tone} spinning={t.spinning}>{t.label}</Status>
        <span className="step-run-rows num">
          {m && m.rowsIn > 0 && <>{formatRows(m.rowsIn)} → </>}
          {out != null ? `${formatRows(out)} ${m?.rowsWritten != null ? "written" : "rows"}` : ""}
          {diff != null && diff !== 0 && <small className={diff < 0 ? "muted" : "muted"}> ({diff > 0 ? "+" : "−"}{Math.abs(diff).toLocaleString()})</small>}
        </span>
        <span className="step-run-time num">{formatDuration(s.durationMs)}</span>
      </button>
      {open && (
        <div className="step-run-body">
          {s.error && <p className="critical-text">{s.error}</p>}
          {s.warnings.map((w, i) => <p key={i} className="warning-text small">{w}</p>)}
          {m?.quality?.length ? (
            <ul className="quality-list">
              {m.quality.map((q) => <li key={q.rule}><Status tone={q.passed ? "good" : "warning"}>{q.passed ? "Passed" : `${q.failedRows.toLocaleString()} rows`}</Status> {q.rule}</li>)}
            </ul>
          ) : null}
          {s.environment && (
            <details className="small">
              <summary>Ran with {s.environment.runtime} and {Object.keys(s.environment.packages).length} packages</summary>
              <p className="mono env-packages">{Object.entries(s.environment.packages).map(([k, v]) => `${k} ${v}`).join(" · ")}</p>
            </details>
          )}
        </div>
      )}
      {s.output && <button className="btn ghost small step-preview" onClick={onPreview} title={`Preview the data after ${label}`}><Table2 size={14} /> Preview</button>}
      <span hidden>{runId}</span>
    </li>
  );
}

export function PipelineRun({ me }: { me: Me }) {
  const { id = "", runId = "" } = useParams();
  const navigate = useNavigate();
  const { data: pipeline } = useApi<PipelineDetailData>(`/pipelines/${id}`);
  const { data: run, error, reload } = useApi<Run>(`/pipeline-runs/${runId}`, 2000);
  const [stepFilter, setStepFilter] = useState("");
  const [showDebug, setShowDebug] = useState(false);
  const { data: logs } = useApi<LogLine[]>(`/pipeline-runs/${runId}/logs${stepFilter ? `?step=${encodeURIComponent(stepFilter)}` : ""}`, run?.status === "running" ? 2000 : undefined);
  const [preview, setPreview] = useState<string | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [explanation, setExplanation] = useState<{ diagnosis: { title: string; summary: string; details: string[]; suggestions: string[] } | null; ai: AiExplanation | null } | null>(null);
  const [explaining, setExplaining] = useState(false);
  const canRun = me.permissions.includes("pipelines.run");
  const explain = async () => {
    setExplaining(true);
    try {
      setExplanation(await post(`/pipeline-runs/${runId}/explain`));
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setExplaining(false);
    }
  };

  if (error && !run) return <ErrorNote error={error} />;
  if (!run) return <div className="center-panel"><Spinner label="Loading run…" /></div>;
  const t = runTone(run.status);
  const stepLabel = (sid: string) => pipeline?.definition.steps.find((s) => s.id === sid)?.name ?? sid;
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setErr(null);
      await reload();
    } catch (e) {
      setErr(e as ApiError);
    }
  };
  const visibleLogs = (logs ?? []).filter((l) => showDebug || l.level !== "debug");

  return (
    <>
      <div className="app-breadcrumb"><Link to={`/pipelines/${id}`}><ArrowLeft size={15} /> {pipeline?.name ?? "Pipeline"}</Link></div>
      <PageHead
        title={<span className="row">{run.testRows ? "Test run" : "Run"} <Status tone={t.tone} spinning={t.spinning}>{t.label}</Status></span>}
        sub={`${new Date(run.startedAt).toLocaleString()} · ${run.testRows ? `first ${run.testRows.toLocaleString()} rows, nothing written` : TRIGGER_LABEL[run.trigger] ?? run.trigger} · ${formatDuration(run.durationMs)} · version ${run.version}`}
        actions={
          canRun && (
            <>
              {run.status === "running" && <button className="btn" onClick={() => void act(() => post(`/pipeline-runs/${run.id}/cancel`))}><Square size={15} /> Stop</button>}
              {["failed", "partial", "cancelled"].includes(run.status) && (
                <button className="btn primary" onClick={() => void act(async () => navigate(`/pipelines/${id}/runs/${(await post<{ runId: string }>(`/pipeline-runs/${run.id}/resume`)).runId}`))}>
                  <RotateCcw size={15} /> Resume from where it stopped
                </button>
              )}
              <a className="btn ghost" href={`/api/v1/pipeline-runs/${run.id}/reproducibility`} download={`run-${run.id}.json`}><Download size={15} /> Environment</a>
            </>
          )
        }
      />
      <ErrorNote error={err} />
      {run.error && (
        <div className="card run-problem">
          <div className="row">
            <strong>{run.problem?.title ?? "What went wrong"}</strong>
            <span className="spacer" />
            {["failed", "partial"].includes(run.status) && !explanation && (
              <button className="btn small" disabled={explaining} onClick={() => void explain()}>{explaining ? <Spinner label="Looking…" /> : "Explain what went wrong"}</button>
            )}
          </div>
          <p>{run.error}</p>
          {run.problem?.summary && <p className="small muted">{run.problem.summary}</p>}
          {explanation?.diagnosis && (
            <div className="diagnosis">
              <strong>{explanation.diagnosis.title}</strong>
              <p>{explanation.diagnosis.summary}</p>
              {explanation.diagnosis.details.map((d, i) => <p key={i} className="small secondary">{d}</p>)}
              {explanation.diagnosis.suggestions.length > 0 && <ul className="small">{explanation.diagnosis.suggestions.map((d, i) => <li key={i}>{d}</li>)}</ul>}
            </div>
          )}
          {explanation?.ai && <AiExplanationCard ai={explanation.ai} />}
        </div>
      )}
      {Object.keys(run.params).length > 0 && <div className="chips">{Object.entries(run.params).map(([k, v]) => <span key={k} className="chip">{k}: {String(v)}</span>)}</div>}
      <div className="card">
        <h2>Steps</h2>
        <ol className="step-run-list">
          {run.steps.map((s) => <StepRow key={s.stepId} s={s} label={stepLabel(s.stepId)} runId={run.id} onPreview={() => setPreview(s.stepId)} />)}
        </ol>
      </div>
      <div className="card">
        <div className="row">
          <h2>Log</h2>
          <span className="spacer" />
          <select className="select narrow" value={stepFilter} onChange={(e) => setStepFilter(e.target.value)} aria-label="Show log for">
            <option value="">All steps</option>
            {run.steps.map((s) => <option key={s.stepId} value={s.stepId}>{stepLabel(s.stepId)}</option>)}
          </select>
          <label className="check-field small"><input type="checkbox" checked={showDebug} onChange={(e) => setShowDebug(e.target.checked)} /> Technical details</label>
        </div>
        <div className="run-log" role="log" aria-live="polite">
          {visibleLogs.map((l, i) => (
            <div key={i} className={`log-line ${l.level}`}>
              <span className="log-time">{new Date(l.time).toLocaleTimeString()}</span>
              {l.step && <span className="log-step">{stepLabel(l.step)}</span>}
              <span className="log-msg">{l.message}</span>
            </div>
          ))}
          {!visibleLogs.length && <span className="muted small">Nothing logged yet.</span>}
        </div>
      </div>
      {preview && <PreviewDialog runId={run.id} step={preview} onClose={() => setPreview(null)} />}
    </>
  );
}
