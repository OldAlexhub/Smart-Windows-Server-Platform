import { AlertTriangle, ArrowRight, Sparkles } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { ApiError, post } from "../lib/api";
import { useApi } from "../lib/hooks";
import { describeSchedule, type BlockInfo, type Schedule } from "../lib/pipelines";
import { ErrorNote, Spinner } from "./ui";

interface ProposedStep {
  id: string;
  name?: string;
  uses: string;
  with: Record<string, unknown>;
  needs?: string[];
}

interface Proposal {
  definition: { name: string; description?: string; schedule?: Schedule; steps: ProposedStep[] };
  scripts: { stepId: string; language: "python" | "r"; fileName: string; code: string }[];
  assumptions: string[];
  warnings: string[];
}

const EXAMPLE = "Every night, take the completed trips from TaxiOps, remove duplicate trips, total the fares per provider, and load it into the Warehouse.";

/** One line of a step's settings, e.g. "table: trips · incremental: updated_at". */
function settings(step: ProposedStep, generated: boolean): string {
  return Object.entries(step.with)
    .filter(([k]) => !(generated && k === "script"))
    .map(([k, v]) => {
      const plain = v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string" || typeof x === "number");
      const text = typeof v === "string" ? v : plain ? Object.values(v as Record<string, string>).join(", ") : JSON.stringify(v);
      return `${k}: ${text.length > 90 ? `${text.slice(0, 87)}…` : text}`;
    })
    .join(" · ");
}

/**
 * "Describe it": a sentence becomes a proposed pipeline. The person reviews the flow, schedule and
 * any scripts the AI wrote (and can edit them) before anything is created — and it starts switched off.
 */
export function DescribePipeline({ aiReady }: { aiReady: boolean }) {
  const navigate = useNavigate();
  const { data: blocks } = useApi<BlockInfo[]>("/pipelines/blocks");
  const [request, setRequest] = useState("");
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [scripts, setScripts] = useState<Proposal["scripts"]>([]);
  const [busy, setBusy] = useState<"propose" | "create" | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const label = (kind: string) => blocks?.find((b) => b.kind === kind)?.label ?? kind;

  async function propose() {
    setBusy("propose");
    setErr(null);
    try {
      const p = await post<Proposal>("/pipelines/propose", { request });
      setProposal(p);
      setScripts(p.scripts);
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(null);
    }
  }
  async function create() {
    if (!proposal) return;
    setBusy("create");
    setErr(null);
    try {
      const p = await post<{ id: string }>("/pipelines/from-proposal", { definition: proposal.definition, scripts });
      navigate(`/pipelines/${p.id}`);
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(null);
    }
  }

  if (!proposal) {
    return (
      <div className="card describe-pipeline">
        <strong className="describe-head"><Sparkles size={15} /> Describe it</strong>
        <textarea className="input" rows={3} placeholder={EXAMPLE} value={request} disabled={!aiReady} onChange={(e) => setRequest(e.target.value)} aria-label="Describe the pipeline" />
        <ErrorNote error={err} />
        <div className="row">
          {aiReady ? <span className="small muted">Nexus proposes a pipeline for you to review. Nothing is created until you say so.</span> : <span className="small muted">Needs the local AI. <Link to="/ai">Set it up in Nexus AI</Link>, or choose a starting point below.</span>}
          <span className="spacer" />
          <button className="btn primary" disabled={!aiReady || !request.trim() || busy !== null} onClick={() => void propose()}>{busy ? <Spinner label="Designing…" /> : "Propose pipeline"}</button>
        </div>
      </div>
    );
  }

  const d = proposal.definition;
  return (
    <div className="card describe-pipeline proposal">
      <div className="row">
        <strong className="describe-head"><Sparkles size={15} /> Proposed pipeline: {d.name}</strong>
      </div>
      <span className="flow">{d.steps.map((s, n) => <span key={s.id}>{n > 0 && <ArrowRight size={12} />}<span className="flow-step">{s.name ?? label(s.uses)}</span></span>)}</span>
      <ol className="proposal-steps">
        {d.steps.map((s) => {
          const script = scripts.find((x) => x.stepId === s.id);
          return (
            <li key={s.id}>
              <span><strong>{s.name ?? s.id}</strong> <span className="muted small">{label(s.uses)}</span></span>
              <span className="small secondary mono">{settings(s, !!script)}</span>
              {script && (
                <details className="proposal-script" open>
                  <summary className="small">{script.language === "python" ? "Python" : "R"} script the AI wrote — saved as {script.fileName}</summary>
                  <textarea className="input mono" spellCheck={false} rows={Math.min(16, script.code.split("\n").length + 1)} value={script.code} aria-label={`Script for ${s.name ?? s.id}`} onChange={(e) => setScripts(scripts.map((x) => (x.stepId === s.id ? { ...x, code: e.target.value } : x)))} />
                </details>
              )}
            </li>
          );
        })}
      </ol>
      <p className="small"><strong>Schedule:</strong> {describeSchedule(d.schedule ?? { type: "manual" })}</p>
      {proposal.assumptions.length > 0 && (
        <div className="small">
          <strong>What Nexus assumed</strong>
          <ul>{proposal.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul>
        </div>
      )}
      {proposal.warnings.map((w, i) => <div key={i} className="notice warn small"><AlertTriangle size={14} /> {w}</div>)}
      <ErrorNote error={err} />
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn" disabled={busy !== null} onClick={() => setProposal(null)}>Change description</button>
        <button className="btn primary" disabled={busy !== null} onClick={() => void create()}>{busy === "create" ? <Spinner label="Creating…" /> : "Create Pipeline"}</button>
      </div>
      <p className="small muted">It starts switched off. Test it on the next page, then switch it on to follow its schedule.</p>
    </div>
  );
}
