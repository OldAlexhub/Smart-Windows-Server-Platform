import { ArrowLeft, Code2, FlaskConical, History, Play, Save, Settings2, Workflow } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import type { DatabaseSummary } from "@nexus/shared/contracts";
import type { Me } from "../App";
import { PipelineDesigner, type DesignerIssue } from "../components/PipelineDesigner";
import { PageHead } from "../components/Layout";
import { ConfirmByName, ErrorNote, Modal, Spinner, Status } from "../components/ui";
import { ApiError, del, get, post, put } from "../lib/api";
import { useApi } from "../lib/hooks";
import { describeSchedule, formatDuration, formatRows, runTone, TRIGGER_LABEL, type BlockInfo, type Definition, type Param, type PipelineDetailData, type PipelineSummary, type RunHistoryEntry, type Schedule } from "../lib/pipelines";
import { OnOff, timeAgo } from "./Pipelines";

type Tab = "designer" | "runs" | "settings" | "file";

const EMPTY: Definition = {
  name: "New pipeline",
  params: [],
  steps: [],
  schedule: { type: "manual" },
  retry: { attempts: 2, delaySeconds: 60, backoff: "exponential" },
  resources: { memoryMb: "auto", cpuPercent: "auto", gpu: "allowed", priority: "normal", timeoutMinutes: 720 },
  notifications: { onFailure: true, onSuccess: false, onAnomaly: true, onDataQuality: true },
};

/** What goes back to the service: everything except the computed run order. */
const forSave = (d: Definition) => {
  const { order: _order, ...rest } = d;
  return rest;
};

// ---------------------------------------------------------------- run dialog

function RunDialog({ pipeline, onClose }: { pipeline: PipelineDetailData; onClose: () => void }) {
  const navigate = useNavigate();
  const params = pipeline.definition.params;
  const [values, setValues] = useState<Record<string, string | number | boolean>>(() => Object.fromEntries(params.filter((p) => p.default !== undefined).map((p) => [p.name, p.default!])));
  const [mode, setMode] = useState<"real" | "100" | "10000">(pipeline.enabled ? "real" : "100");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  async function start() {
    setBusy(true);
    try {
      const r = await post<{ runId: string }>(`/pipelines/${pipeline.id}/run`, { params: values, ...(mode !== "real" ? { testRows: Number(mode) } : {}) });
      navigate(`/pipelines/${pipeline.id}/runs/${r.runId}`);
    } catch (e) {
      setErr(e as ApiError);
      setBusy(false);
    }
  }
  const input = (p: Param) => {
    const v = values[p.name];
    const set = (x: string | number | boolean) => setValues({ ...values, [p.name]: x });
    if (p.choices) return <select className="select" value={String(v ?? "")} onChange={(e) => set(e.target.value)}><option value="">Choose…</option>{p.choices.map((c) => <option key={String(c)}>{String(c)}</option>)}</select>;
    if (p.type === "boolean") return <input type="checkbox" checked={!!v} onChange={(e) => set(e.target.checked)} />;
    if (p.type === "date") return <input className="input" type="date" value={String(v ?? "")} onChange={(e) => set(e.target.value)} />;
    if (p.type === "number") return <input className="input" type="number" value={v === undefined ? "" : String(v)} onChange={(e) => set(Number(e.target.value))} />;
    return <input className="input" value={String(v ?? "")} onChange={(e) => set(e.target.value)} />;
  };
  return (
    <Modal title={`Run ${pipeline.name}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={() => void start()}>{busy ? <Spinner label="Starting…" /> : mode === "real" ? <><Play size={15} /> Run</> : <><FlaskConical size={15} /> Test</>}</button></>}>
      {params.map((p) => (
        <label className="field" key={p.name}>
          <span>{p.label ?? p.name}</span>
          {input(p)}
          {p.description && <small className="muted">{p.description}</small>}
        </label>
      ))}
      <div className="choice-stack" role="radiogroup" aria-label="Kind of run" style={{ marginTop: 12 }}>
        {([
          ["100", "Test with the first 100 rows", "Sources read a sample; nothing is written to databases, files or APIs."],
          ["10000", "Test with the first 10,000 rows", "A bigger sample; still nothing is written."],
          ["real", "Run for real", "Reads all the data and writes the results."],
        ] as const).map(([k, title, desc]) => (
          <button key={k} type="button" role="radio" aria-checked={mode === k} className={`choice wizard-choice ${mode === k ? "selected" : ""}`} onClick={() => setMode(k)}>
            <span className="radio-dot">{mode === k && <span />}</span>
            <span className="choice-copy"><span className="title">{title}</span><span className="desc">{desc}</span></span>
          </button>
        ))}
      </div>
      <ErrorNote error={err} />
    </Modal>
  );
}

// ---------------------------------------------------------------- runs tab

function RunsTab({ id }: { id: string }) {
  const { data, error } = useApi<RunHistoryEntry[]>(`/pipelines/${id}/runs`, 5000);
  if (error && !data) return <ErrorNote error={error} />;
  if (!data) return <Spinner label="Loading runs…" />;
  if (!data.length) return <div className="card database-empty"><History size={28} /><span>No runs yet. Use Run or Test to start one.</span></div>;
  return (
    <div className="card run-table-wrap">
      <table className="run-table">
        <thead><tr><th>Run</th><th>Started</th><th>How</th><th>Duration</th><th>Rows</th><th>Notes</th></tr></thead>
        <tbody>
          {data.map(({ run, metrics, anomalies }) => {
            const t = runTone(run.status);
            return (
              <tr key={run.id}>
                <td><Link to={`/pipelines/${id}/runs/${run.id}`}><Status tone={t.tone} spinning={t.spinning}>{t.label}</Status></Link></td>
                <td title={new Date(run.startedAt).toLocaleString()}>{timeAgo(run.startedAt)}</td>
                <td>{run.testRows ? `Test (${run.testRows.toLocaleString()} rows)` : TRIGGER_LABEL[run.trigger] ?? run.trigger}</td>
                <td className="num">{formatDuration(run.durationMs)}</td>
                <td className="num">{formatRows(metrics.rowsWritten ?? metrics.rows)}</td>
                <td className="small">{run.error ? <span className="critical-text">{run.error}</span> : anomalies.map((a) => <div key={a.kind} className="warning-text">{a.message}</div>)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- settings tab

function ScheduleEditor({ value, onChange, others }: { value: Schedule; onChange: (s: Schedule) => void; others: PipelineSummary[] }) {
  const DEFAULTS: Record<Schedule["type"], Schedule> = {
    manual: { type: "manual" },
    interval: { type: "interval", minutes: 60 },
    daily: { type: "daily", at: "02:00" },
    weekly: { type: "weekly", day: "mon", at: "06:00" },
    monthly: { type: "monthly", day: 1, at: "03:00" },
    cron: { type: "cron", expression: "0 4 * * 1-5" },
    file: { type: "file", path: "C:\\Incoming\\*.csv" },
    after: { type: "after", pipelines: [], when: "success" },
  };
  const labels: Record<Schedule["type"], string> = { manual: "Only when started", interval: "Every few minutes or hours", daily: "Every day", weekly: "Every week", monthly: "Every month", cron: "Custom (cron)", file: "When a file arrives", after: "After other pipelines" };
  const v = value as Record<string, unknown>;
  return (
    <div className="schedule-editor">
      <select className="select" value={value.type} onChange={(e) => onChange(DEFAULTS[e.target.value as Schedule["type"]])} aria-label="When should it run">
        {(Object.keys(labels) as Schedule["type"][]).map((k) => <option key={k} value={k}>{labels[k]}</option>)}
      </select>
      {value.type === "interval" && <label className="inline-field">every <input className="input narrow" type="number" min={1} value={value.minutes} onChange={(e) => onChange({ ...value, minutes: Number(e.target.value) })} /> minutes</label>}
      {"at" in value && <label className="inline-field">at <input className="input narrow" type="time" value={String(v.at)} onChange={(e) => onChange({ ...value, at: e.target.value } as Schedule)} /></label>}
      {value.type === "weekly" && <select className="select narrow" value={value.day} onChange={(e) => onChange({ ...value, day: e.target.value })}>{["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => <option key={d} value={d}>{d.toUpperCase()}</option>)}</select>}
      {value.type === "monthly" && <label className="inline-field">on day <input className="input narrow" type="number" min={1} max={31} value={value.day === "last" ? 31 : value.day} onChange={(e) => onChange({ ...value, day: Number(e.target.value) })} /></label>}
      {value.type === "cron" && <input className="input mono" value={value.expression} onChange={(e) => onChange({ ...value, expression: e.target.value })} aria-label="Cron expression" />}
      {value.type === "file" && <input className="input mono" value={value.path} onChange={(e) => onChange({ ...value, path: e.target.value })} aria-label="Folder and file pattern" />}
      {value.type === "after" && (
        <div className="after-list">
          {others.map((o) => (
            <label key={o.id} className="check-field">
              <input type="checkbox" checked={value.pipelines.includes(o.id)} onChange={(e) => onChange({ ...value, pipelines: e.target.checked ? [...value.pipelines, o.id] : value.pipelines.filter((x) => x !== o.id) })} />
              <span>{o.name}</span>
            </label>
          ))}
          <select className="select narrow" value={value.when ?? "success"} onChange={(e) => onChange({ ...value, when: e.target.value as "success" | "completion" })}>
            <option value="success">only if they succeed</option>
            <option value="completion">even if they fail</option>
          </select>
        </div>
      )}
    </div>
  );
}

function SettingsTab({ pipeline, draft, setDraft, canEdit, reload }: { pipeline: PipelineDetailData | null; draft: Definition; setDraft: (d: Definition) => void; canEdit: boolean; reload: () => Promise<void> }) {
  const navigate = useNavigate();
  const { data: all } = useApi<PipelineSummary[]>("/pipelines");
  const { data: versions, reload: reloadVersions } = useApi<{ version: number; author: string | null; note: string | null; createdAt: string }[]>(pipeline ? `/pipelines/${pipeline.id}/versions` : null);
  const [diff, setDiff] = useState<{ version: number; changes: { kind: string; path: string; before?: unknown; after?: unknown }[] } | null>(null);
  const [hook, setHook] = useState<{ url: string; token: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const setParam = (i: number, p: Partial<Param>) => setDraft({ ...draft, params: draft.params.map((x, n) => (n === i ? { ...x, ...p } : x)) });
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setErr(null);
    } catch (e) {
      setErr(e as ApiError);
    }
  };
  return (
    <fieldset className="settings-grid" disabled={!canEdit}>
      <div className="card">
        <h2>About</h2>
        <label className="field">Name<input className="input" value={draft.name} maxLength={80} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
        <label className="field">Description<textarea className="input" rows={2} value={draft.description ?? ""} onChange={(e) => setDraft({ ...draft, description: e.target.value || undefined })} /></label>
      </div>
      <div className="card">
        <h2>When it runs</h2>
        <ScheduleEditor value={draft.schedule} onChange={(schedule) => setDraft({ ...draft, schedule })} others={(all ?? []).filter((p) => p.id !== pipeline?.id)} />
        <p className="small muted">Schedules only run while the pipeline is switched on.</p>
        <label className="inline-field">If a step hits a temporary problem, try again <input className="input narrow" type="number" min={0} max={10} value={draft.retry.attempts} onChange={(e) => setDraft({ ...draft, retry: { ...draft.retry, attempts: Number(e.target.value) } })} /> more times</label>
      </div>
      <div className="card">
        <h2>Parameters</h2>
        <p className="small muted">Values asked for when the pipeline runs, used in blocks as {"{{params.name}}"}.</p>
        {draft.params.map((p, i) => (
          <div className="param-row" key={i}>
            <input className="input mono" value={p.name} placeholder="start_date" aria-label="Parameter name" onChange={(e) => setParam(i, { name: e.target.value })} />
            <select className="select" value={p.type} aria-label="Type" onChange={(e) => setParam(i, { type: e.target.value as Param["type"] })}>
              <option value="string">Text</option><option value="number">Number</option><option value="date">Date</option><option value="boolean">Yes / no</option>
            </select>
            <input className="input" value={p.default === undefined ? "" : String(p.default)} placeholder="Default (optional)" aria-label="Default" onChange={(e) => setParam(i, { default: e.target.value === "" ? undefined : p.type === "number" ? Number(e.target.value) : e.target.value })} />
            <button className="btn ghost small" onClick={() => setDraft({ ...draft, params: draft.params.filter((_, n) => n !== i) })}>Remove</button>
          </div>
        ))}
        <button className="btn small" onClick={() => setDraft({ ...draft, params: [...draft.params, { name: `param_${draft.params.length + 1}`, type: "string" }] })}>Add parameter</button>
      </div>
      <div className="card">
        <h2>Notifications</h2>
        {([
          ["onFailure", "When it fails (once, and again when it works again)"],
          ["onAnomaly", "When a run is unusual (much slower, far fewer rows…)"],
          ["onDataQuality", "When a data quality check finds problems"],
          ["onSuccess", "Every time it finishes successfully"],
        ] as const).map(([k, label]) => (
          <label key={k} className="check-field">
            <input type="checkbox" checked={draft.notifications[k]} onChange={(e) => setDraft({ ...draft, notifications: { ...draft.notifications, [k]: e.target.checked } })} />
            <span>{label}</span>
          </label>
        ))}
      </div>
      {pipeline && (
        <div className="card">
          <h2>Start from other systems</h2>
          <p className="small muted">Other applications with a Nexus credential can start it at <span className="mono">POST /api/v1/pipelines/{pipeline.slug}/run</span>. For services that can only call a web address, create a webhook.</p>
          {hook ? (
            <div className="webhook-once">
              <p className="small"><strong>Copy this now</strong> — the secret isn't shown again.</p>
              <code className="mono">{location.origin}{hook.url}</code>
              <code className="mono">X-Nexus-Webhook-Token: {hook.token}</code>
            </div>
          ) : (
            <p className="small">{pipeline.webhook.enabled ? `Webhook active since ${new Date(pipeline.webhook.createdAt!).toLocaleDateString()}.` : "No webhook yet."}</p>
          )}
          <div className="row">
            <button className="btn small" onClick={() => void run(async () => setHook(await post(`/pipelines/${pipeline.id}/webhook`)))}>{pipeline.webhook.enabled ? "Replace webhook secret" : "Create webhook"}</button>
            {pipeline.webhook.enabled && <button className="btn small ghost" onClick={() => void run(async () => (await del(`/pipelines/${pipeline.id}/webhook`), setHook(null), await reload()))}>Turn off webhook</button>}
          </div>
          {!pipeline.enabled && <p className="small warning-text">Switch the pipeline on before other systems can start it.</p>}
        </div>
      )}
      {pipeline && versions && (
        <div className="card">
          <h2>Versions</h2>
          <ul className="version-list">
            {versions.map((v) => (
              <li key={v.version}>
                <strong>Version {v.version}</strong>
                {v.version === pipeline.version && <span className="tab-badge">Current</span>}
                <span className="small muted">{new Date(v.createdAt).toLocaleString()}{v.note ? ` · ${v.note}` : ""}</span>
                <span className="spacer" />
                {v.version !== pipeline.version && (
                  <>
                    <button className="btn ghost small" onClick={() => void run(async () => setDiff({ version: v.version, ...(await get<{ changes: { kind: string; path: string; before?: unknown; after?: unknown }[] }>(`/pipelines/${pipeline.id}/diff?from=${v.version}&to=${pipeline.version}`)) }))}>Compare</button>
                    <button className="btn small" onClick={() => void run(async () => (await post(`/pipelines/${pipeline.id}/rollback`, { version: v.version }), await reload(), await reloadVersions()))}>Go back to this</button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <ErrorNote error={err} />
      {pipeline && canEdit && (
        <div className="card danger-zone">
          <h2>Delete pipeline</h2>
          <p className="small muted">Removes the pipeline and its schedule. Data it already loaded stays where it is.</p>
          <button className="btn danger" onClick={() => setDeleting(true)}>Delete pipeline</button>
        </div>
      )}
      {diff && pipeline && (
        <Modal wide title={`Changes from version ${diff.version} to ${pipeline.version}`} onClose={() => setDiff(null)}>
          {diff.changes.length === 0 ? <p className="muted">No differences.</p> : (
            <ul className="diff-list">
              {diff.changes.map((c, n) => (
                <li key={n} className={`diff-${c.kind}`}>
                  <span className="mono">{c.path}</span> <span className="tab-badge">{c.kind}</span>
                  {c.before !== undefined && <pre className="mono diff-before">{JSON.stringify(c.before, null, 1)}</pre>}
                  {c.after !== undefined && <pre className="mono diff-after">{JSON.stringify(c.after, null, 1)}</pre>}
                </li>
              ))}
            </ul>
          )}
        </Modal>
      )}
      {deleting && pipeline && (
        <ConfirmByName name={pipeline.name} action="Delete Pipeline" onClose={() => setDeleting(false)} onConfirm={() => void run(async () => (await del(`/pipelines/${pipeline.id}`, { confirmation: pipeline.name }), navigate("/pipelines")))}>
          <p>This deletes <strong>{pipeline.name}</strong> and its schedule. Its run history is kept.</p>
        </ConfirmByName>
      )}
    </fieldset>
  );
}

// ---------------------------------------------------------------- file tab

function FileTab({ pipeline, canEdit, reload }: { pipeline: PipelineDetailData; canEdit: boolean; reload: () => Promise<void> }) {
  const [text, setText] = useState<string | null>(null);
  const [edited, setEdited] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  useEffect(() => {
    void get<string>(`/pipelines/${pipeline.id}/export.yaml`).then((t) => (setText(t), setEdited(false)));
  }, [pipeline.id, pipeline.version]);
  if (text === null) return <Spinner />;
  return (
    <div className="card">
      <div className="row">
        <p className="small muted">The same pipeline as a file — handy for review, version control, or copying between computers.</p>
        <span className="spacer" />
        <a className="btn small" href={`/api/v1/pipelines/${pipeline.id}/export.yaml`}>Download</a>
        {canEdit && <button className="btn small primary" disabled={!edited} onClick={() => void put(`/pipelines/${pipeline.id}`, { file: text, note: "Edited as a file" }).then(reload).then(() => setErr(null), (e) => setErr(e as ApiError))}>Save file</button>}
      </div>
      <textarea className="input mono pipeline-file" spellCheck={false} readOnly={!canEdit} value={text} onChange={(e) => (setText(e.target.value), setEdited(true))} aria-label="Pipeline file" />
      <ErrorNote error={err} />
    </div>
  );
}

// ---------------------------------------------------------------- page

export function PipelineDetail({ me }: { me: Me }) {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();
  const loc = useLocation();
  const { data: pipeline, error, reload } = useApi<PipelineDetailData>(id ? `/pipelines/${id}` : null, 10_000);
  const { data: blocks } = useApi<BlockInfo[]>("/pipelines/blocks");
  const { data: dbs } = useApi<DatabaseSummary[]>("/databases");
  const { data: secretList } = useApi<{ name: string }[]>(me.permissions.includes("pipelines.edit") ? "/pipelines/secrets" : null);
  const { data: latest } = useApi<RunHistoryEntry[]>(id ? `/pipelines/${id}/runs?limit=1` : null, 5000);
  const [tab, setTab] = useState<Tab>("designer");
  const [draft, setDraft] = useState<Definition | null>(isNew ? EMPTY : null);
  const [dirty, setDirty] = useState(isNew);
  const [issues, setIssues] = useState<DesignerIssue[]>([]);
  const [running, setRunning] = useState(new URLSearchParams(loc.search).has("run"));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const canEdit = me.permissions.includes("pipelines.edit");
  const canRun = me.permissions.includes("pipelines.run");

  // Take the saved definition unless the person is in the middle of editing.
  const version = pipeline?.version;
  useEffect(() => {
    if (pipeline && !dirty) setDraft(pipeline.definition);
  }, [version, pipeline?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const change = (d: Definition) => {
    setDraft(d);
    setDirty(true);
  };

  // Check the draft as it changes, and pin problems to the blocks.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!draft || !dirty) return void setIssues([]);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void post<{ ok: boolean; issues: { path: string; message: string }[] }>("/pipelines/validate", { definition: forSave(draft) }).then((r) =>
        setIssues(r.issues.map((i) => ({ step: i.path.match(/^steps\.([^.]+)/)?.[1] ?? null, message: i.message }))),
      );
    }, 400);
  }, [draft, dirty]);

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      if (isNew) {
        const p = await post<{ id: string }>("/pipelines", { definition: forSave(draft) });
        navigate(`/pipelines/${p.id}`, { replace: true });
      } else {
        await put(`/pipelines/${id}`, { definition: forSave(draft) });
        setDirty(false);
        await reload();
      }
      setErr(null);
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setSaving(false);
    }
  }

  const stepStatus = useMemo(() => Object.fromEntries((latest?.[0]?.run.steps ?? []).map((s) => [s.stepId, s.status])), [latest]);
  const ctx = { databases: (dbs ?? []).filter((d) => d.engine === "postgresql").map((d) => d.name), secrets: (secretList ?? []).map((s) => s.name) };

  if (error && !pipeline) return <ErrorNote error={error} />;
  if (!draft || !blocks || (!isNew && !pipeline)) return <div className="center-panel"><Spinner label="Loading pipeline…" /></div>;
  const last = pipeline?.running ? runTone("running") : pipeline?.lastRun ? runTone(pipeline.lastRun.status) : null;
  const tabs: { key: Tab; label: string; icon: typeof Workflow }[] = [
    { key: "designer", label: "Designer", icon: Workflow },
    ...(isNew ? [] : [{ key: "runs" as Tab, label: "Runs", icon: History }]),
    { key: "settings", label: "Settings", icon: Settings2 },
    ...(isNew ? [] : [{ key: "file" as Tab, label: "Pipeline file", icon: Code2 }]),
  ];
  return (
    <>
      <div className="app-breadcrumb"><Link to="/pipelines"><ArrowLeft size={15} /> Pipelines</Link></div>
      <PageHead
        title={<span className="row"><span className="pipeline-icon large"><Workflow size={20} /></span>{draft.name}{last && <Status tone={last.tone} spinning={last.spinning}>{last.label}</Status>}</span>}
        sub={pipeline ? `${describeSchedule(pipeline.definition.schedule)} · version ${pipeline.version}${pipeline.dependencies?.message ? ` · ${pipeline.dependencies.message}` : ""}` : "Not saved yet"}
        actions={
          <>
            {pipeline && canEdit && <OnOff checked={pipeline.enabled} label="Switched on" onChange={(v) => void post(`/pipelines/${pipeline.id}/enabled`, { enabled: v }).then(reload, (e) => setErr(e as ApiError))} />}
            {pipeline && canRun && <button className="btn" disabled={dirty || pipeline.running} title={dirty ? "Save your changes first" : undefined} onClick={() => setRunning(true)}><Play size={16} /> Run</button>}
            {canEdit && (dirty || isNew) && <button className="btn primary" disabled={saving || issues.length > 0 || !draft.steps.length} title={issues.length ? "Fix the problems first" : undefined} onClick={() => void save()}>{saving ? <Spinner label="Saving…" /> : <><Save size={16} /> {isNew ? "Create" : "Save"}</>}</button>}
          </>
        }
      />
      <ErrorNote error={err} />
      <div className="tabs app-tabs">
        {tabs.map(({ key, label, icon: Icon }) => <button key={key} className={`tab ${tab === key ? "active" : ""}`} onClick={() => setTab(key)}><Icon size={16} />{label}</button>)}
      </div>
      {tab === "designer" && <PipelineDesigner definition={draft} blocks={blocks} issues={issues} stepStatus={dirty ? {} : stepStatus} ctx={ctx} readOnly={!canEdit} onChange={change} />}
      {tab === "runs" && id && <RunsTab id={id} />}
      {tab === "settings" && <SettingsTab pipeline={pipeline ?? null} draft={draft} setDraft={change} canEdit={canEdit} reload={reload} />}
      {tab === "file" && pipeline && <FileTab pipeline={pipeline} canEdit={canEdit} reload={async () => (setDirty(false), await reload())} />}
      {running && pipeline && <RunDialog pipeline={pipeline} onClose={() => setRunning(false)} />}
    </>
  );
}
