import {
  Activity,
  Archive,
  ArrowLeft,
  ArrowRight,
  Box,
  Copy,
  Clock3,
  Code2,
  Database,
  ExternalLink,
  FileClock,
  HardDrive,
  History,
  KeyRound,
  MemoryStick,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings,
  ShieldCheck,
  Check,
  Square,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { formatBytes } from "@nexus/shared/format";
import type { AccessMode, ActivityItem, AppSummary } from "@nexus/shared/contracts";
import type { FriendlyProblem } from "@nexus/shared/errors";
import type { Me } from "../App";
import { PageHead } from "../components/Layout";
import { Card, ConfirmByName, Empty, ErrorNote, Meter, Modal, ProblemCard, Spinner, Status, StatusOf } from "../components/ui";
import { AiExplanationCard, type AiExplanation } from "../components/AiExplanation";
import { ApiError, del, get, post, put } from "../lib/api";
import { useApi, useJob } from "../lib/hooks";

interface AppDetailData extends AppSummary {
  sourceDir: string;
  analysis: { summary: string; components: { role: string; framework: string; path: string }[]; healthPath: string | null };
  database: { id: string; name: string } | null;
  publicHosts: string[];
  suggestedDomain?: string | null;
  addresses?: { kind: "public" | "local" | "private-network" | "direct"; label: string; url: string; note: string }[];
  deployments: Deployment[];
  logCounts: { errors: number; warnings: number; info: number };
  settings: EnvSetting[];
  activity: ActivityItem[];
}

interface Deployment { id: string; version: string; status: string; createdAt: string; activatedAt: string | null; commit: string | null; error: string | null }
interface EnvSetting { name: string; value: string; source: "nexus" | "you"; secret: boolean }
interface LogEntry { t: string; source: string; stream: string; level: "error" | "warning" | "info" | "debug"; message: string }
interface LogsResult { entries: LogEntry[]; counts: { errors: number; warnings: number; info: number } }
interface BackupRecord { id: string; createdAt: string; finishedAt: string | null; trigger: "scheduled" | "manual" | "pre-restore"; status: "running" | "succeeded" | "failed"; size: number | null; sizeLabel: string | null; contents: { database: boolean; files: boolean; config: boolean }; error: string | null; durationMs: number | null }

type Tab = "overview" | "logs" | "backups" | "settings" | "deployments";
type AppPermission = "operate" | "deploy" | "configure" | "logs" | "backup" | "delete" | "access";

const roleGrants: Record<string, AppPermission[]> = {
  owner: ["operate", "deploy", "configure", "logs", "backup", "delete", "access"],
  administrator: ["operate", "deploy", "configure", "logs", "backup", "delete", "access"],
  developer: ["operate", "deploy", "configure", "logs", "backup"],
  operator: ["operate", "logs", "backup"],
  viewer: ["logs"],
  app_user: [],
};
const appRoleGrants: Record<string, AppPermission[]> = {
  administrator: ["operate", "deploy", "configure", "logs", "backup", "delete", "access"],
  developer: ["operate", "deploy", "configure", "logs", "backup"],
  operator: ["operate", "logs", "backup"],
  viewer: ["logs"],
  app_user: [],
};

function allowed(me: Me, appId: string, permission: AppPermission): boolean {
  return !!roleGrants[me.user.role]?.includes(permission) || !!appRoleGrants[me.user.appRoles[appId] ?? ""]?.includes(permission);
}

function when(value: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value;
}

function ActionJob({ jobId, onDone }: { jobId: string; onDone: () => void }) {
  const job = useJob(jobId);
  const [answered, setAnswered] = useState(false);
  const done = job?.status === "succeeded" || job?.status === "failed";
  useEffect(() => { if (done) onDone(); }, [done, onDone]);
  if (!job) return <div className="action-job"><Spinner label="Starting…" /></div>;
  return (
    <div className="action-job fade-in">
      <div className="row"><Status tone={job.status === "failed" ? "critical" : job.status === "succeeded" ? "good" : "neutral"} spinning={job.status === "running"}>{job.status === "failed" ? "Failed" : job.status === "succeeded" ? "Complete" : job.status === "waiting_for_input" ? "Waiting for you" : "Working"}</Status><strong>{job.title}</strong></div>
      <div className="job-mini-steps">{job.steps.map((step) => <span className={step.status} key={step.key}>{step.status === "done" || step.status === "skipped" ? "✓" : step.status === "failed" ? "×" : step.status === "running" ? "•" : "○"} {step.label}</span>)}</div>
      {job.question && <div className="job-question"><strong>{job.question.prompt}</strong><div className="row" style={{ marginTop: 10 }}>{job.question.choices.map((choice) => <button className="btn" disabled={answered} key={choice.value} onClick={() => { setAnswered(true); void post(`/jobs/${jobId}/answer`, { questionId: job.question!.id, value: choice.value }); }}>{choice.label}</button>)}</div></div>}
      {job.problem && <ProblemCard problem={job.problem} />}
    </div>
  );
}

/** Remove the app: type its name to confirm. The database and backups are kept. */
function RemoveAppButton({ app, small = false }: { app: AppDetailData; small?: boolean }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  return (
    <>
      <button className={`btn danger${small ? " ghost" : ""}`} onClick={() => setOpen(true)}><Trash2 size={small ? 15 : 16} /> Remove{small ? "" : ` ${app.name}`}</button>
      {open && (
        <ConfirmByName name={app.name} action="Remove Application" onClose={() => setOpen(false)} onConfirm={() => void del(`/apps/${app.id}`, { confirmation: app.name }).then(() => navigate("/apps")).catch((e) => setError(e as ApiError))}>
          <p>This stops and removes the application. Its database and backups are kept so data is not lost.</p>
          <ErrorNote error={error} />
        </ConfirmByName>
      )}
    </>
  );
}

function Overview({ app, canOperate, canDeploy, canDelete, busy, act }: { app: AppDetailData; canOperate: boolean; canDeploy: boolean; canDelete: boolean; busy: string | null; act: (action: "start" | "stop" | "restart" | "deploy") => void }) {
  const memoryFraction = Math.min(1, app.memoryBytes / (1024 ** 3));
  return (
    <div className="stack">
      {app.problem && <ProblemCard problem={app.problem} />}
      <div className="grid app-overview-stats">
        <Card><div className="stat-label">Processor</div><div className="stat-value num">{app.cpuPercent.toFixed(1)}%</div><Meter value={app.cpuPercent / 100} label="Application processor use" /></Card>
        <Card><div className="stat-label">Memory</div><div className="stat-value num">{formatBytes(app.memoryBytes)}</div><Meter value={memoryFraction} label="Application memory (relative to 1 GB)" /></Card>
        <Card><div className="stat-label">File Storage</div><div className="stat-value num">{formatBytes(app.storageBytes)}</div><div className="stat-sub">Persistent application files</div></Card>
      </div>
      <div className="grid grid-2">
        <Card title="Application" sub="Detected configuration">
          <div className="detail-list"><div><span>Framework</span><strong>{app.framework || app.runtime}</strong></div><div><span>Release</span><strong>{app.currentRelease ?? "Not deployed"}</strong></div><div><span>Last deployed</span><strong>{when(app.lastDeployedAt)}</strong></div><div><span>Source folder</span><strong className="mono ellipsis" title={app.sourceDir}>{app.sourceDir}</strong></div>{app.database && <div><span>Database</span><Link to={`/databases/${app.database.id}`}>{app.database.name}</Link></div>}</div>
        </Card>
        <Card title="Controls" sub="Nexus restarts safely and watches for crash loops">
          <div className="control-buttons">
            {app.status === "stopped" ? <button className="btn primary" disabled={!canOperate || !!busy} onClick={() => act("start")}><Play size={16} /> Start</button> : <><button className="btn" disabled={!canOperate || !!busy} onClick={() => act("restart")}><RefreshCw size={16} /> Restart</button><button className="btn" disabled={!canOperate || !!busy} onClick={() => act("stop")}><Square size={15} /> Stop</button></>}
            <button className="btn" disabled={!canDeploy || !!busy} onClick={() => act("deploy")}><Code2 size={16} /> Deploy Latest</button>
            {canDelete && <RemoveAppButton app={app} small />}
          </div>
          {!canOperate && <p className="small muted" style={{ marginTop: 12 }}>Your role can view this application but cannot start or stop it.</p>}
        </Card>
      </div>
      <Card title="Recent Activity">
        {app.activity.length ? <div className="activity-list">{app.activity.map((item) => <div className="activity-row" key={item.id}><span className={`activity-dot ${item.kind === "success" ? "good" : item.kind === "warning" ? "warning" : item.kind === "problem" ? "critical" : "neutral"}`} /><span>{item.message}</span><time className="small muted">{when(item.at)}</time></div>)}</div> : <p className="secondary">No activity yet.</p>}
      </Card>
    </div>
  );
}

function LogsTab({ appId }: { appId: string }) {
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState("all");
  const path = `/apps/${appId}/logs?limit=500${query ? `&text=${encodeURIComponent(query)}` : ""}${level !== "all" ? `&level=${level}` : ""}`;
  const { data, error, loading, reload } = useApi<LogsResult>(path, 5000);
  const [explanation, setExplanation] = useState<{ problem: FriendlyProblem | null; ai: AiExplanation | null; evidence: unknown[] } | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [explainError, setExplainError] = useState<ApiError | null>(null);
  async function explain() { setExplaining(true); try { setExplanation(await post(`/apps/${appId}/explain`)); setExplainError(null); } catch (e) { setExplainError(e as ApiError); } finally { setExplaining(false); } }
  return (
    <Card title="Application Logs" sub="Secrets are automatically removed before logs are stored" action={<button className="btn small" disabled={explaining} onClick={() => void explain()}>{explaining ? <Spinner label="Looking…" /> : "Explain these errors"}</button>}>
      <form className="log-toolbar" onSubmit={(e: FormEvent) => { e.preventDefault(); setQuery(text); }}><span className="search-input"><Search size={16} /><input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Search logs" /></span><select className="select" value={level} onChange={(e) => setLevel(e.target.value)}><option value="all">All levels</option><option value="problems">Problems</option><option value="error">Errors</option><option value="warning">Warnings</option><option value="info">Info</option></select><button className="btn">Search</button><button type="button" className="btn ghost" onClick={() => void reload()}><RefreshCw size={15} /> Refresh</button></form>
      {data && <div className="row log-counts"><Status tone={data.counts.errors ? "critical" : "good"}>{data.counts.errors} errors</Status><Status tone={data.counts.warnings ? "warning" : "neutral"}>{data.counts.warnings} warnings</Status><span className="small muted">{data.counts.info} info</span></div>}
      {explanation?.ai && <AiExplanationCard ai={explanation.ai} />}{explanation?.problem && <ProblemCard problem={explanation.problem} />}{explanation && !explanation.problem && !explanation.ai && <div className="notice">No recent errors to explain.</div>}<ErrorNote error={explainError} />
      {loading && !data ? <div className="folder-loading"><Spinner /></div> : error ? <ErrorNote error={error} /> : !data?.entries.length ? <Empty icon={<TerminalSquare size={30} />} title="No matching logs">Try a different filter or wait for the application to produce output.</Empty> : <div className="log-view">{data.entries.map((entry, i) => <div className={`log-line ${entry.level}`} key={`${entry.t}-${i}`}><time>{new Date(entry.t).toLocaleTimeString()}</time><span className="log-level">{entry.level}</span><pre>{entry.message}</pre></div>)}</div>}
    </Card>
  );
}

function BackupsTab({ appId, canBackup, onJob }: { appId: string; canBackup: boolean; onJob: (id: string) => void }) {
  const { data, error, loading, reload } = useApi<BackupRecord[]>(`/apps/${appId}/backups`, 10_000);
  const [starting, setStarting] = useState(false);
  async function backup() { setStarting(true); try { const r = await post<{ jobId: string }>(`/apps/${appId}/backups`); onJob(r.jobId); setTimeout(() => void reload(), 1000); } finally { setStarting(false); } }
  return (
    <Card title="Backups" sub="Encrypted copies of the database, files, and configuration" action={canBackup && <button className="btn primary small" disabled={starting} onClick={() => void backup()}><Archive size={15} /> Back Up Now</button>}>
      {loading && !data ? <div className="folder-loading"><Spinner /></div> : error ? <ErrorNote error={error} /> : !data?.length ? <Empty icon={<Archive size={30} />} title="No backups yet" action={canBackup && <button className="btn primary" onClick={() => void backup()}>Create First Backup</button>}>Automatic backups run after the first deployment.</Empty> : <div className="backup-list">{data.map((backup) => <div className="backup-row" key={backup.id}><span className="backup-icon"><Archive size={18} /></span><span className="backup-main"><strong>{when(backup.createdAt)}</strong><span className="small muted">{backup.trigger === "manual" ? "Manual backup" : backup.trigger === "pre-restore" ? "Safety backup" : "Scheduled backup"} · {backup.sizeLabel ?? "Size pending"}</span></span><Status tone={backup.status === "succeeded" ? "good" : backup.status === "failed" ? "critical" : "neutral"} spinning={backup.status === "running"}>{backup.status === "succeeded" ? "Protected" : backup.status === "failed" ? "Failed" : "Running"}</Status></div>)}</div>}
    </Card>
  );
}

function SettingsTab({ app, canConfigure, canAccess, canDelete, reload }: { app: AppDetailData; canConfigure: boolean; canAccess: boolean; canDelete: boolean; reload: () => Promise<void> }) {
  const [access, setAccess] = useState<AccessMode>(app.accessMode);
  const [domain, setDomain] = useState(app.publicHosts[0] ?? app.suggestedDomain ?? "");
  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("");
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [note, setNote] = useState<{ text: string; restart: boolean } | null>(null);
  const { data: envFile, reload: reloadEnvFile } = useApi<{ files: string[]; settings: { name: string; alreadySet: boolean }[] }>(canConfigure ? `/apps/${app.id}/env-file` : null);
  const toImport = envFile?.settings.filter((x) => !x.alreadySet) ?? [];
  async function importEnvFile() { setSaving("import"); try { const r = await post<{ imported: string[] }>(`/apps/${app.id}/env-file/import`, { names: toImport.map((x) => x.name) }); await reload(); await reloadEnvFile(); setError(null); setNote({ text: `Imported ${r.imported.join(", ")}. ${app.name} reads its settings when it starts — restart it to use them.`, restart: app.status !== "stopped" }); } catch (e) { setError(e as ApiError); } finally { setSaving(null); } }
  async function restartNow() { setSaving("restart"); try { await post(`/apps/${app.id}/restart`); await reload(); setNote({ text: `${app.name} restarted with the new settings.`, restart: false }); } catch (e) { setError(e as ApiError); } finally { setSaving(null); } }
  async function saveSetting(name: string, value: string | null) { setSaving(name); try { await put(`/apps/${app.id}/settings/${encodeURIComponent(name)}`, { value }); await reload(); setNewName(""); setNewValue(""); setError(null); setNote(app.status === "stopped" ? { text: `Saved. ${app.name} will use it the next time it starts.`, restart: false } : { text: `Saved. ${app.name} reads its settings when it starts — restart it to use the new value.`, restart: true }); } catch (e) { setError(e as ApiError); } finally { setSaving(null); } }
  async function saveAccess() { setSaving("access"); try { await put(`/apps/${app.id}/access`, { access, domain: access === "private" ? null : domain }); await reload(); setError(null); setNote({ text: access === "private" ? "Saved. The app is now private to this computer." : `Saved. The address ${domain} is being set up (the app doesn't need a restart).`, restart: false }); } catch (e) { setError(e as ApiError); } finally { setSaving(null); } }
  return (
    <div className="stack">
      {note && <div className="notice saved-note row" role="status"><Check size={16} /> <span>{note.text}</span>{note.restart && <><span className="spacer" /><button className="btn small primary" disabled={!!saving} onClick={() => void restartNow()}>{saving === "restart" ? <Spinner label="Restarting…" /> : "Restart now"}</button></>}</div>}
      <Card title="External Access" sub="The application itself remains on a private local port">
        <div className="settings-access"><label className="field">Who can access<select className="select" value={access} disabled={!canAccess} onChange={(e) => setAccess(e.target.value as AccessMode)}><option value="private">Private to this computer</option><option value="internet">Public website</option><option value="authorized">Authorized users only</option><option value="api">API access only</option></select></label>{access !== "private" && <label className="field">Domain name<input className="input" value={domain} disabled={!canAccess} onChange={(e) => setDomain(e.target.value)} placeholder="app.example.com" /></label>}<button className="btn primary" disabled={!canAccess || saving === "access" || (access !== "private" && !domain)} onClick={() => void saveAccess()}><Save size={15} /> Save Access</button></div>
      </Card>
      {toImport.length > 0 && (
        <Card title="Settings from your app's .env file" sub={`Found in ${envFile!.files.join(" and ")}. Nexus doesn't copy .env files into the app (they hold passwords) — import them here and they're stored encrypted.`}>
          <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
            {toImport.map((x) => <code key={x.name}>{x.name}</code>)}
            <span className="spacer" />
            <button className="btn primary" disabled={!!saving} onClick={() => void importEnvFile()}>{saving === "import" ? <Spinner label="Importing…" /> : `Import ${toImport.length} setting${toImport.length === 1 ? "" : "s"}`}</button>
          </div>
        </Card>
      )}
      <Card title="Application Settings" sub="Secret values are encrypted and remain hidden">
        {app.settings.length > 0 && <div className="setting-list">{app.settings.map((setting) => <div className="setting-row" key={setting.name}><span><strong className="mono">{setting.name}</strong><small>{setting.secret ? "Encrypted secret" : "Configuration"}</small></span><code>{setting.value}</code>{canConfigure && <button className="btn ghost small danger" disabled={!!saving} onClick={() => void saveSetting(setting.name, null)}>Remove</button>}</div>)}</div>}
        {canConfigure ? <div className="new-setting"><label className="field">Name<input className="input mono" value={newName} onChange={(e) => setNewName(e.target.value.toUpperCase())} placeholder="SETTING_NAME" /></label><label className="field">Value<input className="input" type={/SECRET|PASSWORD|TOKEN|KEY|_URL$/.test(newName) ? "password" : "text"} value={newValue} onChange={(e) => setNewValue(e.target.value)} /></label><button className="btn" disabled={!newName || !newValue || !!saving} onClick={() => void saveSetting(newName, newValue)}><Plus size={15} /> Add Setting</button></div> : <p className="secondary">Your role cannot change settings.</p>}
        <ErrorNote error={error} />
      </Card>
      {canDelete && <Card title="Remove Application" sub="The database and backups will be kept"><RemoveAppButton app={app} /></Card>}
    </div>
  );
}

function DeploymentsTab({ app, canDeploy, onJob, reload }: { app: AppDetailData; canDeploy: boolean; onJob: (id: string) => void; reload: () => Promise<void> }) {
  const [confirm, setConfirm] = useState<{ id: string; reason: string } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  async function rollback(id: string, confirmed = false) { try { const r = await post<{ requiresConfirmation?: string }>(`/apps/${app.id}/rollback`, { deploymentId: id, confirmed }); if (r.requiresConfirmation) setConfirm({ id, reason: r.requiresConfirmation }); else { setConfirm(null); await reload(); } } catch (e) { setError(e as ApiError); } }
  async function deploy() { try { const r = await post<{ jobId: string }>(`/apps/${app.id}/deploy`); onJob(r.jobId); } catch (e) { setError(e as ApiError); } }
  return (
    <Card title="Deployments" sub="Immutable releases make safe rollback possible" action={canDeploy && <button className="btn primary small" onClick={() => void deploy()}><Code2 size={15} /> Deploy Latest</button>}>
      <ErrorNote error={error} />
      <div className="deployment-list">{app.deployments.map((deployment) => <div className="deployment-row" key={deployment.id}><span className={`deployment-marker ${deployment.status}`}><History size={16} /></span><span className="deployment-main"><strong>{deployment.version}</strong><span className="small muted">{when(deployment.activatedAt ?? deployment.createdAt)}{deployment.commit ? ` · ${deployment.commit.slice(0, 8)}` : ""}</span>{deployment.error && <span className="small" style={{ color: "var(--critical-text)" }}>{deployment.error}</span>}</span><Status tone={deployment.status === "active" ? "good" : deployment.status === "failed" ? "critical" : "neutral"}>{deployment.status === "active" ? "Active" : deployment.status === "failed" ? "Failed" : "Previous"}</Status>{canDeploy && deployment.status !== "active" && deployment.status !== "failed" && <button className="btn small" onClick={() => void rollback(deployment.id)}><RotateCcw size={14} /> Roll Back</button>}</div>)}</div>
      {confirm && <Modal title="Confirm rollback" onClose={() => setConfirm(null)} footer={<><button className="btn" onClick={() => setConfirm(null)}>Cancel</button><button className="btn primary" onClick={() => void rollback(confirm.id, true)}>Roll Back</button></>}><p>{confirm.reason}</p><p className="secondary" style={{ marginTop: 8 }}>Nexus will keep the current release so you can return to it.</p></Modal>}
    </Card>
  );
}

const tabs: { key: Tab; label: string; icon: ReactNode; permission?: AppPermission }[] = [
  { key: "overview", label: "Overview", icon: <Activity size={15} /> },
  { key: "logs", label: "Logs", icon: <TerminalSquare size={15} />, permission: "logs" },
  { key: "backups", label: "Backups", icon: <ShieldCheck size={15} /> },
  { key: "settings", label: "Settings", icon: <Settings size={15} /> },
  { key: "deployments", label: "Deployments", icon: <FileClock size={15} /> },
];

export function ApplicationDetail({ me }: { me: Me }) {
  const { id = "" } = useParams();
  const { data: app, error, loading, reload } = useApi<AppDetailData>(id ? `/apps/${id}` : null, 5000);
  const [tab, setTab] = useState<Tab>("overview");
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const onJobDone = useCallback(() => { void reload(); }, [reload]);
  const can = useMemo(() => (p: AppPermission) => allowed(me, id, p), [me, id]);

  async function act(action: "start" | "stop" | "restart" | "deploy") {
    setBusy(action); setActionError(null);
    try { const r = await post<{ jobId?: string }>(`/apps/${id}/${action}`); if (r.jobId) setJobId(r.jobId); await reload(); }
    catch (e) { setActionError(e as ApiError); }
    finally { setBusy(null); }
  }

  if (loading && !app) return <div className="center-panel"><Spinner label="Loading application…" /></div>;
  if (error && !app) return <ErrorNote error={error} />;
  if (!app) return null;
  const address = app.externalUrl ?? app.localUrl;
  return (
    <>
      <div className="app-breadcrumb"><Link to="/apps"><ArrowLeft size={15} /> Applications</Link></div>
      <PageHead title={<span className="row"><span className="app-avatar large">{app.name.slice(0, 1).toUpperCase()}</span><span>{app.name}</span><StatusOf status={app.status} /></span>} sub={app.analysis.summary || app.framework} actions={address && <a className="btn" href={address} target="_blank" rel="noreferrer"><ExternalLink size={16} /> Open Application</a>} />
      <div className="app-address card">
        <div className="app-address-list">
          {(app.addresses?.length ? app.addresses : address ? [{ kind: "local" as const, label: "Address", url: address, note: "" }] : []).map((a) => (
            <div className="app-address-row" key={a.url}>
              <Box size={16} />
              <span>
                <span className="small muted">{a.label}</span>
                <a href={a.url} target="_blank" rel="noreferrer" className="mono">{a.url}</a>
                {a.note && <small className="muted">{a.note}</small>}
              </span>
              <button className="btn ghost small" title="Copy address" aria-label={`Copy ${a.url}`} onClick={() => void navigator.clipboard.writeText(a.url)}><Copy size={14} /></button>
            </div>
          ))}
        </div>
        <span className="row small secondary"><HardDrive size={15} /> {app.accessMode === "private" ? "Private to this computer" : app.accessMode === "authorized" ? "Authorized users" : app.accessMode === "api" ? "API key required" : "Public website"}</span>
      </div>
      <div className="tabs app-tabs">{tabs.filter((item) => !item.permission || can(item.permission)).map((item) => <button className={`tab ${tab === item.key ? "active" : ""}`} key={item.key} onClick={() => setTab(item.key)}>{item.icon}{item.label}{item.key === "logs" && app.logCounts.errors > 0 && <span className="tab-badge">{app.logCounts.errors}</span>}</button>)}</div>
      {actionError && <ErrorNote error={actionError} />}
      {jobId && <ActionJob jobId={jobId} onDone={onJobDone} />}
      {tab === "overview" && <Overview app={app} canOperate={can("operate")} canDeploy={can("deploy")} canDelete={can("delete")} busy={busy} act={act} />}
      {tab === "logs" && can("logs") && <LogsTab appId={id} />}
      {tab === "backups" && <BackupsTab appId={id} canBackup={can("backup")} onJob={setJobId} />}
      {tab === "settings" && <SettingsTab app={app} canConfigure={can("configure")} canAccess={can("access")} canDelete={can("delete")} reload={reload} />}
      {tab === "deployments" && <DeploymentsTab app={app} canDeploy={can("deploy")} onJob={setJobId} reload={reload} />}
    </>
  );
}
