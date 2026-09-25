import { Archive, CalendarClock, Check, ChevronDown, ChevronUp, Clock3, Copy, Database, FileArchive, FileText, HardDrive, KeyRound, RefreshCw, RotateCcw, Save, ShieldCheck, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Me } from "../App";
import { PageHead } from "../components/Layout";
import { Card, ErrorNote, Modal, ProblemCard, Spinner, Status } from "../components/ui";
import { ApiError, get, post, put } from "../lib/api";
import { useApi, useJob } from "../lib/hooks";

interface Retention { daily: number; weekly: number; monthly: number; manual: number; preRestoreDays: number }
interface BackupPolicy { enabled: boolean; frequency: "daily" | "weekly" | "custom"; time: string; weekday?: number; intervalHours?: number; retention: Retention }
interface BackupRecord { id: string; appId: string; createdAt: string; finishedAt: string | null; trigger: "scheduled" | "manual" | "pre-restore"; status: "running" | "succeeded" | "failed"; size: number | null; sizeLabel: string | null; contents: { database: boolean; files: boolean; config: boolean }; error: string | null; durationMs: number | null }
interface Protection { appId: string; appName: string; protected: boolean; latest: BackupRecord | null; contents: { database: boolean; files: boolean; config: boolean }; message: string; policy: BackupPolicy }

function when(value: string | null | undefined): string {
  if (!value) return "Never";
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : value;
}

function schedule(policy: BackupPolicy): string {
  if (!policy.enabled) return "Automatic backups off";
  if (policy.frequency === "daily") return `Daily at ${policy.time}`;
  if (policy.frequency === "weekly") return `Weekly at ${policy.time}`;
  return `Every ${policy.intervalHours ?? 24} hours`;
}

function appPermission(me: Me, appId: string, permission: "backup" | "restore" | "configure"): boolean {
  const global: Record<string, string[]> = {
    owner: ["backup", "restore", "configure"], administrator: ["backup", "restore", "configure"], developer: ["backup", "configure"], operator: ["backup"], viewer: [], app_user: [],
  };
  const scoped: Record<string, string[]> = {
    administrator: ["backup", "restore", "configure"], developer: ["backup", "configure"], operator: ["backup"], viewer: [], app_user: [],
  };
  return global[me.user.role]?.includes(permission) || scoped[me.user.appRoles[appId] ?? ""]?.includes(permission) || false;
}

function JobNotice({ jobId, onFinished }: { jobId: string; onFinished: () => void }) {
  const job = useJob(jobId);
  const done = job?.status === "succeeded" || job?.status === "failed";
  useEffect(() => { if (done) onFinished(); }, [done, onFinished]);
  if (!job) return <div className="backup-job"><Spinner label="Starting…" /></div>;
  return <div className="backup-job fade-in"><div className="row"><Status tone={job.status === "succeeded" ? "good" : job.status === "failed" ? "critical" : "neutral"} spinning={job.status === "running"}>{job.status === "succeeded" ? "Complete" : job.status === "failed" ? "Failed" : "Working"}</Status><strong>{job.title}</strong></div>{job.steps.map((step) => <div className="backup-job-step" key={step.key}><span>{step.status === "done" ? <Check size={15} /> : step.status === "running" ? <Spinner /> : "○"}</span><span>{step.label}{step.detail && <small>{step.detail}</small>}</span></div>)}{job.problem && <ProblemCard problem={job.problem} />}</div>;
}

function PolicyModal({ item, onClose, onSaved }: { item: Protection; onClose: () => void; onSaved: () => void }) {
  const [policy, setPolicy] = useState(item.policy);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const retention = (key: keyof Retention, value: number) => setPolicy((p) => ({ ...p, retention: { ...p.retention, [key]: value } }));
  async function save() { setBusy(true); try { await put(`/apps/${item.appId}/backup-policy`, policy); onSaved(); onClose(); } catch (e) { setError(e as ApiError); } finally { setBusy(false); } }
  return <Modal title={`Backup schedule for ${item.appName}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={() => void save()}><Save size={15} /> Save Schedule</button></>}><label className="toggle-row"><input type="checkbox" checked={policy.enabled} onChange={(e) => setPolicy((p) => ({ ...p, enabled: e.target.checked }))} /><span><strong>Automatic backups</strong><small>Run even when the control center is closed.</small></span></label><div className="policy-grid"><label className="field">Frequency<select className="select" value={policy.frequency} disabled={!policy.enabled} onChange={(e) => setPolicy((p) => ({ ...p, frequency: e.target.value as BackupPolicy["frequency"] }))}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="custom">Custom interval</option></select></label>{policy.frequency === "custom" ? <label className="field">Every hours<input className="input" type="number" min={1} max={168} value={policy.intervalHours ?? 24} onChange={(e) => setPolicy((p) => ({ ...p, intervalHours: Number(e.target.value) }))} /></label> : <><label className="field">Time<input className="input" type="time" value={policy.time} onChange={(e) => setPolicy((p) => ({ ...p, time: e.target.value }))} /></label>{policy.frequency === "weekly" && <label className="field">Day<select className="select" value={policy.weekday ?? 0} onChange={(e) => setPolicy((p) => ({ ...p, weekday: Number(e.target.value) }))}>{["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((d, i) => <option value={i} key={d}>{d}</option>)}</select></label>}</>}</div><h3 style={{ marginTop: 20 }}>Keep restore points</h3><div className="retention-grid">{(["daily", "weekly", "monthly", "manual"] as const).map((key) => <label className="field" key={key}>{key[0]!.toUpperCase() + key.slice(1)}<input className="input" type="number" min={key === "weekly" || key === "monthly" ? 0 : 1} value={policy.retention[key]} onChange={(e) => retention(key, Number(e.target.value))} /></label>)}</div><ErrorNote error={error} /></Modal>;
}

function RestoreModal({ item, backup, onClose, onStarted }: { item: Protection; backup: BackupRecord; onClose: () => void; onStarted: (jobId: string) => void }) {
  const [mode, setMode] = useState<"entire" | "parts">("entire");
  const [parts, setParts] = useState({ database: backup.contents.database, files: backup.contents.files, config: backup.contents.config });
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const selected = (Object.entries(parts).filter(([, v]) => v).map(([k]) => k)) as ("database" | "files" | "config")[];
  async function restore() { setBusy(true); try { const r = await post<{ jobId: string }>(`/apps/${item.appId}/restore`, { backupId: backup.id, parts: mode === "entire" ? "entire" : selected, confirmation }); onStarted(r.jobId); onClose(); } catch (e) { setError(e as ApiError); } finally { setBusy(false); } }
  return <Modal title={`Restore ${item.appName}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || confirmation !== item.appName || (mode === "parts" && !selected.length)} onClick={() => void restore()}><RotateCcw size={15} /> Start Restore</button></>}><div className="restore-warning"><TriangleAlert size={20} /><span><strong>Current data will be replaced.</strong> Nexus creates a safety backup first and restarts the application when finished.</span></div><div className="choice-stack" role="radiogroup" aria-label="Restore scope"><label className={`choice ${mode === "entire" ? "selected" : ""}`}><input type="radio" checked={mode === "entire"} onChange={() => setMode("entire")} /><span><span className="title">Entire application</span><span className="desc">Database, files, and configuration from this restore point.</span></span></label><label className={`choice ${mode === "parts" ? "selected" : ""}`}><input type="radio" checked={mode === "parts"} onChange={() => setMode("parts")} /><span><span className="title">Choose what to restore</span><span className="desc">Restore only selected parts.</span></span></label></div>{mode === "parts" && <div className="restore-parts">{(["database", "files", "config"] as const).map((part) => <label key={part}><input type="checkbox" checked={parts[part]} disabled={!backup.contents[part]} onChange={(e) => setParts((p) => ({ ...p, [part]: e.target.checked }))} />{part === "config" ? "Application settings" : part[0]!.toUpperCase() + part.slice(1)}{!backup.contents[part] && <small>Not in this backup</small>}</label>)}</div>}<label className="field" style={{ marginTop: 16 }}>Type <strong>{item.appName}</strong> to confirm<input className="input" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} autoComplete="off" /></label><ErrorNote error={error} /></Modal>;
}

function BackupHistory({ item, me, onJob, onPolicy }: { item: Protection; me: Me; onJob: (id: string) => void; onPolicy: () => void }) {
  const { data, error, loading, reload } = useApi<BackupRecord[]>(`/apps/${item.appId}/backups`, 10_000);
  const [restore, setRestore] = useState<BackupRecord | null>(null);
  const [starting, setStarting] = useState(false);
  const canBackup = appPermission(me, item.appId, "backup");
  const canRestore = appPermission(me, item.appId, "restore");
  async function backup() { setStarting(true); try { const r = await post<{ jobId: string }>(`/apps/${item.appId}/backups`); onJob(r.jobId); } finally { setStarting(false); } }
  return <div className="backup-detail"><div className="backup-detail-head"><div><strong>Restore points</strong><div className="small muted">Encrypted with the server recovery key</div></div><div className="row"><button className="btn small" onClick={onPolicy}><CalendarClock size={14} /> Schedule</button>{canBackup && <button className="btn primary small" disabled={starting} onClick={() => void backup()}><Archive size={14} /> Back Up Now</button>}</div></div>{loading && !data ? <div className="folder-loading"><Spinner /></div> : error ? <ErrorNote error={error} /> : !data?.length ? <div className="backup-empty">No restore points yet.</div> : <div className="restore-point-list">{data.map((point) => <div className="restore-point" key={point.id}><span className="restore-point-icon"><FileArchive size={18} /></span><span className="restore-point-main"><strong>{when(point.createdAt)}</strong><small>{point.trigger === "manual" ? "Manual" : point.trigger === "pre-restore" ? "Safety backup" : "Scheduled"} · {point.sizeLabel ?? "Size pending"}</small><span className="backup-contents">{point.contents.database && <em><Database size={12} /> Database</em>}{point.contents.files && <em><HardDrive size={12} /> Files</em>}{point.contents.config && <em><FileText size={12} /> Settings</em>}</span></span><Status tone={point.status === "succeeded" ? "good" : point.status === "failed" ? "critical" : "neutral"} spinning={point.status === "running"}>{point.status === "succeeded" ? "Ready" : point.status === "failed" ? "Failed" : "Running"}</Status>{canRestore && point.status === "succeeded" && <button className="btn small" onClick={() => setRestore(point)}><RotateCcw size={14} /> Restore</button>}</div>)}</div>}{restore && <RestoreModal item={item} backup={restore} onClose={() => setRestore(null)} onStarted={(id) => { onJob(id); setTimeout(() => void reload(), 1000); }} />}</div>;
}

export function Backups({ me }: { me: Me }) {
  const { data, error, loading, reload } = useApi<Protection[]>("/backups", 15_000);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [policy, setPolicy] = useState<Protection | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<ApiError | null>(null);
  const protectedCount = data?.filter((x) => x.protected).length ?? 0;
  const latest = useMemo(() => data?.map((x) => x.latest?.createdAt).filter((x): x is string => !!x).sort().reverse()[0] ?? null, [data]);
  async function revealKey() { try { const r = await get<{ recoveryKey: string }>("/backups/recovery-key"); setRecovery(r.recoveryKey); } catch (e) { setKeyError(e as ApiError); } }
  return <>
    <PageHead title="Backups & Restore" sub="Encrypted restore points for every application." actions={me.permissions.includes("server.recovery_key") && <button className="btn" onClick={() => void revealKey()}><KeyRound size={16} /> Recovery Key</button>} />
    <div className="grid backup-summary"><Card><div className="stat-label">Protected Applications</div><div className="stat-value">{protectedCount} of {data?.length ?? 0}</div></Card><Card><div className="stat-label">Latest Backup</div><div className="stat-value small-value">{latest ? when(latest) : "None yet"}</div></Card><Card><div className="stat-label">Encryption</div><div className="stat-value small-value">AES-256-GCM</div><div className="stat-sub">Verified after every backup</div></Card></div>
    {jobId && <JobNotice jobId={jobId} onFinished={() => void reload()} />}
    {loading && !data ? <div className="center-panel"><Spinner label="Checking protection…" /></div> : error && !data ? <ErrorNote error={error} /> : !data?.length ? <Card><div className="backup-empty"><Archive size={32} /><strong>No applications to back up</strong><span>Deploy an application first.</span></div></Card> : <div className="backup-app-list">{data.map((item) => <Card className={`backup-app ${item.protected ? "" : "needs-attention"}`} key={item.appId}><button className="backup-app-row" onClick={() => setExpanded((v) => v === item.appId ? null : item.appId)}><span className={`protection-icon ${item.protected ? "good" : "warning"}`}>{item.protected ? <ShieldCheck size={22} /> : <TriangleAlert size={22} />}</span><span className="backup-app-main"><strong>{item.appName}</strong><small>{schedule(item.policy)} · Latest: {when(item.latest?.createdAt)}</small></span><Status tone={item.protected ? "good" : "warning"}>{item.message}</Status>{expanded === item.appId ? <ChevronUp size={18} /> : <ChevronDown size={18} />}</button>{expanded === item.appId && <BackupHistory item={item} me={me} onJob={setJobId} onPolicy={() => setPolicy(item)} />}</Card>)}</div>}
    {policy && <PolicyModal item={policy} onClose={() => setPolicy(null)} onSaved={() => void reload()} />}
    {recovery && <Modal title="Server Recovery Key" onClose={() => setRecovery(null)} footer={<><button className="btn" onClick={() => setRecovery(null)}>Close</button><button className="btn primary" onClick={() => void navigator.clipboard.writeText(recovery)}><Copy size={15} /> Copy Key</button></>}><div className="restore-warning"><KeyRound size={20} /><span>Keep this key somewhere separate from this computer. It is required to restore backups if Windows is reinstalled.</span></div><pre className="recovery-key">{recovery}</pre></Modal>}
    <ErrorNote error={keyError} />
  </>;
}
