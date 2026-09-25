import { ArrowLeft, ArrowRight, Blocks, KeyRound, Play, Plus, Trash2, Workflow } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import type { DatabaseSummary } from "@nexus/shared/contracts";
import type { Me } from "../App";
import { DescribePipeline } from "../components/DescribePipeline";
import { PageHead } from "../components/Layout";
import { Empty, ErrorNote, Modal, Spinner, Status } from "../components/ui";
import { ApiError, del, post, put } from "../lib/api";
import { useApi } from "../lib/hooks";
import { describeSchedule, formatDuration, runTone, type Intent, type PipelineSummary, type Template, type TemplateField } from "../lib/pipelines";

export const timeAgo = (iso: string) => {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: new Date(iso).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
};

export function OnOff({ checked, label, disabled, onChange }: { checked: boolean; label: string; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={`switch ${checked ? "on" : ""}`} onClick={() => onChange(!checked)}>
      <span className="switch-knob" />
      <span className="switch-text">{checked ? "On" : "Off"}</span>
    </button>
  );
}

function SecretsDialog({ onClose }: { onClose: () => void }) {
  const { data, reload, error } = useApi<{ name: string; updatedAt: string }[]>("/pipelines/secrets");
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [err, setErr] = useState<ApiError | null>(null);
  async function save() {
    try {
      await put(`/pipelines/secrets/${encodeURIComponent(name.trim())}`, { value });
      setName("");
      setValue("");
      setErr(null);
      await reload();
    } catch (e) {
      setErr(e as ApiError);
    }
  }
  return (
    <Modal title="Pipeline secrets" onClose={onClose} footer={<button className="btn" onClick={onClose}>Done</button>}>
      <p className="secondary small">Passwords, API keys and connection addresses scripts and blocks use — stored encrypted, never shown again, and never written in a pipeline.</p>
      <ErrorNote error={error} />
      <ul className="secret-list">
        {data?.map((s) => (
          <li key={s.name}>
            <KeyRound size={14} /> <span className="mono">{s.name}</span> <span className="small muted">updated {timeAgo(s.updatedAt)}</span>
            <span className="spacer" />
            <button className="btn ghost small" aria-label={`Delete ${s.name}`} onClick={() => void del(`/pipelines/secrets/${encodeURIComponent(s.name)}`).then(reload)}><Trash2 size={14} /></button>
          </li>
        ))}
        {data && !data.length && <li className="muted small">No secrets yet.</li>}
      </ul>
      <div className="secret-form">
        <input className="input mono" placeholder="name, e.g. shop_api" value={name} onChange={(e) => setName(e.target.value)} aria-label="Secret name" />
        <input className="input" type="password" placeholder="value" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Secret value" autoComplete="off" />
        <button className="btn primary" disabled={!name.trim() || !value} onClick={() => void save()}>Save</button>
      </div>
      <ErrorNote error={err} />
    </Modal>
  );
}

export function Pipelines({ me }: { me: Me }) {
  const navigate = useNavigate();
  const { data, error, loading, reload } = useApi<PipelineSummary[]>("/pipelines", 10_000);
  const [secrets, setSecrets] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const canEdit = me.permissions.includes("pipelines.edit");
  const canRun = me.permissions.includes("pipelines.run");
  const names = Object.fromEntries((data ?? []).map((p) => [p.id, p.name]));

  async function act(id: string, fn: () => Promise<unknown>) {
    setBusy(id);
    try {
      await fn();
      setActionError(null);
      await reload();
    } catch (e) {
      setActionError(e as ApiError);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <PageHead
        title="Pipelines"
        sub="Tell Nexus where data comes from, what should happen to it, and where it should go."
        actions={
          <>
            {canEdit && <button className="btn" onClick={() => setSecrets(true)}><KeyRound size={16} /> Secrets</button>}
            {canEdit && <button className="btn primary" onClick={() => navigate("/pipelines/new")}><Plus size={17} /> Create Pipeline</button>}
          </>
        }
      />
      <ErrorNote error={actionError} />
      {loading && !data ? (
        <div className="center-panel"><Spinner label="Loading pipelines…" /></div>
      ) : error && !data ? (
        <ErrorNote error={error} />
      ) : !data?.length ? (
        <Empty icon={<Workflow size={34} />} title="No pipelines yet" action={canEdit && <button className="btn primary" onClick={() => navigate("/pipelines/new")}>Create Pipeline</button>}>
          Import files, move data between databases, run Python or R, and keep the Warehouse up to date — on a schedule or on demand.
        </Empty>
      ) : (
        <div className="card pipeline-list">
          {data.map((p) => {
            const last = p.running ? runTone("running") : p.lastRun ? runTone(p.lastRun.status) : null;
            return (
              <div className="pipeline-row" key={p.id}>
                <Link to={`/pipelines/${p.id}`} className="pipeline-main">
                  <span className="pipeline-icon"><Workflow size={18} /></span>
                  <span>
                    <strong>{p.name}</strong>
                    <small className="muted">{describeSchedule(p.schedule, names)} · {p.steps} {p.steps === 1 ? "step" : "steps"}</small>
                  </span>
                </Link>
                <span className="pipeline-last">
                  {last ? <Status tone={last.tone} spinning={last.spinning}>{last.label}</Status> : <span className="muted small">Never run</span>}
                  {p.lastRun && !p.running && <small className="muted">{timeAgo(p.lastRun.startedAt)} · {formatDuration(p.lastRun.durationMs)}</small>}
                </span>
                {canEdit ? <OnOff checked={p.enabled} label={`${p.name} switched on`} disabled={busy === p.id} onChange={(v) => void act(p.id, () => post(`/pipelines/${p.id}/enabled`, { enabled: v }))} /> : <span className="small muted">{p.enabled ? "On" : "Off"}</span>}
                {canRun && (
                  <button className="btn small" disabled={p.running || busy === p.id} onClick={() => navigate(`/pipelines/${p.id}?run=1`)}>
                    <Play size={14} /> Run
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {secrets && <SecretsDialog onClose={() => setSecrets(false)} />}
    </>
  );
}

// ---------------------------------------------------------------- Create Pipeline

function TemplateFieldInput({ f, value, onChange, databases, secrets }: { f: TemplateField; value: string; onChange: (v: string) => void; databases: string[]; secrets: string[] }) {
  const common = { id: `tf-${f.name}`, value, onChange: (e: { target: { value: string } }) => onChange(e.target.value) };
  switch (f.kind) {
    case "database":
      return (
        <select className="select" {...common}>
          <option value="">Choose a database…</option>
          {databases.map((d) => <option key={d}>{d}</option>)}
        </select>
      );
    case "secret":
      return (
        <select className="select" {...common}>
          <option value="">{secrets.length ? "No key" : "No saved secrets yet"}</option>
          {secrets.map((s) => <option key={s}>{s}</option>)}
        </select>
      );
    case "choice":
      return <select className="select" {...common}>{f.choices!.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</select>;
    case "time":
      return <input className="input" type="time" {...common} />;
    case "file":
    case "script":
    case "folder":
      return <input className="input mono" placeholder={f.kind === "folder" ? "C:\\Exports" : `C:\\Data\\file${f.extensions?.[0] ?? ""}`} {...common} />;
    default:
      return <input className="input" {...common} placeholder={f.kind === "url" ? "https://…" : ""} />;
  }
}

export function NewPipeline() {
  const navigate = useNavigate();
  const { data } = useApi<{ intents: Intent[]; templates: Template[] }>("/pipelines/templates");
  const { data: dbs } = useApi<DatabaseSummary[]>("/databases");
  const { data: secretList } = useApi<{ name: string }[]>("/pipelines/secrets");
  const { data: ai } = useApi<{ state: string }>("/ai", 30_000);
  const [intent, setIntent] = useState<string | null>(null);
  const [template, setTemplate] = useState<Template | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const databases = (dbs ?? []).filter((d) => d.engine === "postgresql").map((d) => d.name);
  const secrets = (secretList ?? []).map((s) => s.name);

  function choose(t: Template) {
    setTemplate(t);
    setAnswers(Object.fromEntries(t.fields.map((f) => [f.name, f.default ?? ""])));
    setErr(null);
  }
  async function create() {
    if (!template) return;
    setBusy(true);
    try {
      const p = await post<{ id: string }>("/pipelines/from-template", { template: template.id, answers });
      navigate(`/pipelines/${p.id}`);
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <div className="center-panel"><Spinner label="Loading…" /></div>;
  const templates = intent ? data.templates.filter((t) => t.intents.includes(intent)) : [];
  return (
    <>
      <div className="app-breadcrumb"><Link to="/pipelines"><ArrowLeft size={15} /> Pipelines</Link></div>
      <PageHead title="Create Pipeline" sub={template ? template.description : intent ? "Choose a starting point. You can change everything afterwards." : "What would you like to do?"} />
      {!intent && <DescribePipeline aiReady={ai?.state === "ready"} />}
      {!intent && (
        <div className="intent-grid">
          {data.intents.map((i) => (
            <button key={i.id} className="card intent-card" onClick={() => setIntent(i.id)}>
              <strong>{i.label}</strong>
              <span className="small muted">{i.description}</span>
            </button>
          ))}
          <button className="card intent-card custom" onClick={() => navigate("/pipelines/new/custom")}>
            <strong><Blocks size={16} /> Build custom pipeline</strong>
            <span className="small muted">Start from an empty canvas and connect blocks yourself.</span>
          </button>
        </div>
      )}
      {intent && !template && (
        <>
          <button className="btn ghost small" onClick={() => setIntent(null)}><ArrowLeft size={14} /> Other choices</button>
          <div className="template-grid">
            {templates.map((t) => (
              <button key={t.id} className="card template-card" onClick={() => choose(t)}>
                <strong>{t.name}</strong>
                <span className="flow">{t.flow.map((s, n) => <span key={n}>{n > 0 && <ArrowRight size={12} />}<span className="flow-step">{s}</span></span>)}</span>
                <span className="small muted">{t.description}</span>
              </button>
            ))}
          </div>
        </>
      )}
      {template && (
        <div className="card template-form">
          <span className="flow">{template.flow.map((s, n) => <span key={n}>{n > 0 && <ArrowRight size={12} />}<span className="flow-step">{s}</span></span>)}</span>
          <label className="field">
            Pipeline name
            <input className="input" placeholder="Nexus suggests a name" value={answers.name ?? ""} onChange={(e) => setAnswers({ ...answers, name: e.target.value })} />
          </label>
          {template.fields.map((f) => (
            <label className="field" key={f.name} htmlFor={`tf-${f.name}`}>
              <span>{f.label}{f.required && <span className="req">*</span>}</span>
              <TemplateFieldInput f={f} value={answers[f.name] ?? ""} onChange={(v) => setAnswers({ ...answers, [f.name]: v })} databases={databases} secrets={secrets} />
              {f.help && <small className="muted">{f.help}</small>}
            </label>
          ))}
          <ErrorNote error={err} />
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn" onClick={() => setTemplate(null)}>Back</button>
            <button className="btn primary" disabled={busy} onClick={() => void create()}>{busy ? <Spinner label="Creating…" /> : "Create Pipeline"}</button>
          </div>
          <p className="small muted">New pipelines start switched off, so you can test them before they run on a schedule.</p>
        </div>
      )}
    </>
  );
}
