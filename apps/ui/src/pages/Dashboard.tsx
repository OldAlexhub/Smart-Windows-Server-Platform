import {
  Activity,
  ArrowRight,
  Bot,
  Box,
  CheckCircle2,
  CircleAlert,
  Cloud,
  Cpu,
  Database,
  Globe2,
  HardDrive,
  MemoryStick,
  MessageSquareText,
  Plus,
  RefreshCw,
  Check,
  Send,
  Server,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  WifiOff,
} from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { BRAND } from "@nexus/shared/brand";
import { formatBytes } from "@nexus/shared/format";
import type { ActivityItem, AppSummary } from "@nexus/shared/contracts";
import { PageHead } from "../components/Layout";
import { Card, ErrorNote, Meter, Spinner, Status, StatusOf } from "../components/ui";
import { ApiError, get, post } from "../lib/api";
import { useApi } from "../lib/hooks";

interface DashboardData {
  product: string;
  health: { score: number; label: "Healthy" | "Needs Attention" | "Problem"; issues: string[] };
  apps: { total: number; running: number; items: AppSummary[] };
  databases: { total: number; online: number };
  storage: { usedBytes: number; totalBytes: number };
  cpuPercent: number | null;
  memory: { usedBytes: number; totalBytes: number } | null;
  gpu: { name: string; utilizationPercent: number; memoryUsedBytes: number; memoryTotalBytes: number } | null;
  externalAccess: { state: "private" | "online" | "problem"; message: string | null };
  ai: { state: "off" | "not_installed" | "starting" | "downloading_model" | "ready" | "error"; label: string | null; message: string };
  backups: { unprotected: string[] };
  activity: ActivityItem[];
}

function fraction(used: number, total: number): number {
  return total > 0 ? used / total : 0;
}

function percent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)}%`;
}

function relativeTime(value: string): string {
  const elapsed = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(elapsed)) return "";
  const minutes = Math.round(elapsed / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days < 7 ? `${days}d ago` : new Date(value).toLocaleDateString();
}

function SummaryCard({ icon, label, value, detail, to, children }: { icon: ReactNode; label: string; value: ReactNode; detail: ReactNode; to: string; children?: ReactNode }) {
  return (
    <Link to={to} className="summary-card card">
      <div className="summary-card-icon" aria-hidden>{icon}</div>
      <div className="stat-label">{label}</div>
      <div className="stat-value num">{value}</div>
      <div className="stat-sub">{detail}</div>
      {children}
    </Link>
  );
}

function Resource({ icon, label, value, detail, used }: { icon: ReactNode; label: string; value: string; detail: string; used: number }) {
  return (
    <div className="resource">
      <div className="resource-head">
        <span className="row resource-label">{icon}{label}</span>
        <strong className="num">{value}</strong>
      </div>
      <Meter value={used} label={`${label} used`} />
      <div className="small muted" style={{ marginTop: 6 }}>{detail}</div>
    </div>
  );
}

const activityTone = (kind: ActivityItem["kind"]) => kind === "success" ? "good" : kind === "warning" ? "warning" : kind === "problem" ? "critical" : "neutral";

interface PendingUpdate {
  appId: string;
  name: string;
  action: "deploy" | "restart";
  reason: string;
  files: string[];
}

/**
 * "Updates ready": changes you made that the running apps don't have yet — edited files (Deploy)
 * or changed settings (Restart). Nothing happens until you press Update or Apply all.
 */
function PendingUpdates({ updates, onDone }: { updates: PendingUpdate[]; onDone: () => Promise<void> }) {
  const [working, setWorking] = useState<Record<string, "running" | "done" | "failed">>({});
  const [err, setErr] = useState<ApiError | null>(null);

  async function apply(u: PendingUpdate) {
    setWorking((w) => ({ ...w, [u.appId]: "running" }));
    try {
      if (u.action === "restart") {
        await post(`/apps/${u.appId}/restart`);
      } else {
        const { jobId } = await post<{ jobId: string }>(`/apps/${u.appId}/deploy`);
        for (;;) {
          await new Promise((r) => setTimeout(r, 1500));
          const job = await get<{ status: string; problem?: { summary?: string } | null }>(`/jobs/${jobId}`);
          if (job.status === "succeeded") break;
          if (job.status === "failed") throw new ApiError(job.problem?.summary ?? `Updating ${u.name} failed. Open the app to see why.`, 0, "failed", null);
        }
      }
      setWorking((w) => ({ ...w, [u.appId]: "done" }));
    } catch (e) {
      setWorking((w) => ({ ...w, [u.appId]: "failed" }));
      setErr(e as ApiError);
    }
  }
  async function applyAll() {
    setErr(null);
    for (const u of updates) if (working[u.appId] !== "done") await apply(u);
    await onDone();
  }

  if (!updates.length) return null;
  return (
    <Card className="updates-card" title="Updates ready" sub="Changes you made that your running apps don't have yet." action={<button className="btn primary small" disabled={Object.values(working).includes("running")} onClick={() => void applyAll()}>Apply all</button>}>
      <div className="updates-list">
        {updates.map((u) => (
          <div className="update-row" key={u.appId}>
            <span>
              <strong>{u.name}</strong>
              <small className="muted">{u.reason}</small>
              {u.files.length > 0 && <details className="small"><summary>Changed files</summary><code>{u.files.join("\n")}</code></details>}
            </span>
            {working[u.appId] === "running" ? <Spinner label={u.action === "deploy" ? "Deploying…" : "Restarting…"} /> : working[u.appId] === "done" ? <Status tone="good">Updated</Status> : (
              <button className="btn small" onClick={() => void apply(u).then(onDone)}>{u.action === "deploy" ? "Deploy update" : "Restart"}</button>
            )}
          </div>
        ))}
      </div>
      <ErrorNote error={err} />
    </Card>
  );
}

/**
 * The same event repeated back to back (a backup retrying, an app restarting) becomes one line with
 * a count. Messages differing only in ids, numbers or temporary folder names count as the same.
 */
function groupActivity<T extends { id: string; message: string }>(items: T[]): { item: T; count: number }[] {
  const key = (m: string) => m.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "#").replace(/\d+/g, "#");
  const out: { item: T; count: number }[] = [];
  for (const item of items) {
    const last = out[out.length - 1];
    if (last && key(last.item.message) === key(item.message)) last.count++;
    else out.push({ item, count: 1 });
  }
  return out;
}

export function Dashboard({ canCreateApps, canUseAi }: { canCreateApps: boolean; canUseAi: boolean }) {
  const { data, error, loading, reload } = useApi<DashboardData>("/dashboard", 10_000);
  const { data: updates, reload: reloadUpdates } = useApi<PendingUpdate[]>("/apps/pending-updates", 30_000);
  const [refreshing, setRefreshing] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  async function refreshAll() {
    setRefreshing(true);
    try {
      await Promise.all([reload(), reloadUpdates()]);
      setCheckedAt(new Date());
    } finally {
      setRefreshing(false);
    }
  }
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<{ answer: string; source: "ai" | "diagnostics" } | null>(null);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<ApiError | null>(null);

  async function ask(e: FormEvent) {
    e.preventDefault();
    if (!question.trim() || asking) return;
    setAsking(true);
    setAskError(null);
    try {
      setAnswer(await post("/ai/ask", { question: question.trim() }));
      setQuestion("");
    } catch (err) {
      setAskError(err instanceof ApiError ? err : new ApiError(String(err), 0, "network", null));
    } finally {
      setAsking(false);
    }
  }

  if (loading && !data) return <div className="center-panel"><Spinner label="Loading your dashboard…" /></div>;
  if (error && !data) {
    return (
      <div className="center-panel">
        <ErrorNote error={error} />
        <button className="btn" onClick={() => void reload()}>Try again</button>
      </div>
    );
  }
  if (!data) return null;

  const healthTone = data.health.score >= 90 ? "good" : data.health.score >= 60 ? "warning" : "critical";
  const storageUsed = fraction(data.storage.usedBytes, data.storage.totalBytes);
  const memoryUsed = data.memory ? fraction(data.memory.usedBytes, data.memory.totalBytes) : 0;
  const gpuUsed = data.gpu ? fraction(data.gpu.memoryUsedBytes, data.gpu.memoryTotalBytes) : 0;

  return (
    <>
      <PageHead
        title="Dashboard"
        sub="A live view of your applications and this computer."
        actions={
          <>
            <button className="btn" disabled={refreshing} onClick={() => void refreshAll()} title="Reload everything and look for changes you made to your apps">
              {refreshing ? <Spinner label="Checking…" /> : <><RefreshCw size={16} /> Refresh</>}
            </button>
            {canCreateApps && <Link to="/apps/new" className="btn primary"><Plus size={17} /> Add Application</Link>}
          </>
        }
      />
      {checkedAt && !refreshing && !updates?.length && <div className="notice saved-note" role="status"><Check size={16} /> Everything is up to date (checked {checkedAt.toLocaleTimeString()}).</div>}
      <PendingUpdates updates={updates ?? []} onDone={refreshAll} />

      <div className="dashboard-overview">
        <Card className="health-card">
          <div className="health-content">
            <div className={`health-ring ${healthTone}`} style={{ "--health": `${data.health.score * 3.6}deg` } as React.CSSProperties} role="meter" aria-label="System health" aria-valuenow={data.health.score} aria-valuemin={0} aria-valuemax={100}>
              <span className="num">{data.health.score}</span>
              <small>out of 100</small>
            </div>
            <div>
              <div className="small muted">System Health</div>
              <h2 style={{ marginTop: 3 }}>{data.health.label}</h2>
              {data.health.issues.length === 0 ? (
                <p className="secondary" style={{ marginTop: 6 }}>Everything is running normally.</p>
              ) : (
                <div className="health-issues">
                  {data.health.issues.slice(0, 3).map((issue) => <div className="row small" key={issue}><CircleAlert size={14} /> {issue}</div>)}
                </div>
              )}
            </div>
          </div>
        </Card>
        <div className="dashboard-summary-grid">
          <SummaryCard icon={<Box size={19} />} label="Applications" value={data.apps.total} detail={`${data.apps.running} running`} to="/apps" />
          <SummaryCard icon={<Database size={19} />} label="Databases" value={data.databases.total} detail={`${data.databases.online} online`} to="/databases" />
          <SummaryCard icon={<HardDrive size={19} />} label="Storage" value={data.storage.totalBytes ? formatBytes(data.storage.usedBytes) : "—"} detail={data.storage.totalBytes ? `${formatBytes(data.storage.totalBytes)} total` : "No storage data"} to="/settings/storage">
            {data.storage.totalBytes > 0 && <Meter value={storageUsed} label="Storage used" />}
          </SummaryCard>
        </div>
      </div>

      {data.backups.unprotected.length > 0 && (
        <Link to="/backups" className="dashboard-warning">
          <TriangleAlert size={19} aria-hidden />
          <span><strong>Backups need attention.</strong> {data.backups.unprotected.join(", ")} {data.backups.unprotected.length === 1 ? "is" : "are"} not fully protected.</span>
          <ArrowRight size={17} aria-hidden />
        </Link>
      )}

      <div className="dashboard-main-grid">
        <div className="stack">
          <Card title="Applications" sub={data.apps.total ? `${data.apps.running} of ${data.apps.total} running` : "Your deployed projects"} action={<Link to="/apps" className="btn ghost small">View all <ArrowRight size={14} /></Link>}>
            {data.apps.items.length === 0 ? (
              <div className="dashboard-empty">
                <Server size={28} aria-hidden />
                <div><strong>No applications yet</strong><div className="small secondary">Add a project folder and Nexus will set it up.</div></div>
                {canCreateApps && <Link className="btn primary small" to="/apps/new">Add Application</Link>}
              </div>
            ) : (
              <div className="list app-list">
                {data.apps.items.slice(0, 6).map((app) => (
                  <Link className="list-item app-row" to={`/apps/${app.id}`} key={app.id}>
                    <span className="app-avatar" aria-hidden>{app.name.slice(0, 1).toUpperCase()}</span>
                    <span className="app-main"><strong>{app.name}</strong><span className="small muted">{app.framework || app.runtime}</span></span>
                    <StatusOf status={app.status} />
                    <span className="app-metric num small">{app.cpuPercent.toFixed(0)}% CPU</span>
                    <span className="app-metric num small">{formatBytes(app.memoryBytes)}</span>
                    <ArrowRight size={15} className="muted" aria-hidden />
                  </Link>
                ))}
              </div>
            )}
          </Card>

          <Card title="This Computer" sub="Updated automatically every 10 seconds">
            <div className="resource-grid">
              <Resource icon={<Cpu size={16} />} label="Processor" value={percent(data.cpuPercent)} detail={data.cpuPercent === null ? "Waiting for a reading" : "Current usage"} used={(data.cpuPercent ?? 0) / 100} />
              <Resource icon={<MemoryStick size={16} />} label="Memory" value={data.memory ? percent(memoryUsed * 100) : "—"} detail={data.memory ? `${formatBytes(data.memory.usedBytes)} of ${formatBytes(data.memory.totalBytes)}` : "Waiting for a reading"} used={memoryUsed} />
              {data.gpu ? (
                <Resource icon={<Activity size={16} />} label="Graphics" value={percent(data.gpu.utilizationPercent)} detail={`${data.gpu.name} · ${formatBytes(data.gpu.memoryUsedBytes)} of ${formatBytes(data.gpu.memoryTotalBytes)} VRAM`} used={gpuUsed} />
              ) : (
                <div className="resource"><div className="resource-head"><span className="row resource-label"><Activity size={16} />Graphics</span><strong>Not detected</strong></div><div className="small muted" style={{ marginTop: 12 }}>No supported GPU metrics are available.</div></div>
              )}
            </div>
          </Card>
        </div>

        <div className="stack">
          <Card title="Services">
            <div className="service-list">
              <Link to="/settings/network" className="service-row">
                <span className="service-icon">{data.externalAccess.state === "problem" ? <WifiOff size={19} /> : <Globe2 size={19} />}</span>
                <span className="service-main"><strong>External Access</strong><span>{data.externalAccess.message || (data.externalAccess.state === "private" ? "Private to this computer" : "Available from the internet")}</span></span>
                <Status tone={data.externalAccess.state === "problem" ? "critical" : data.externalAccess.state === "online" ? "good" : "neutral"}>{data.externalAccess.state === "problem" ? "Problem" : data.externalAccess.state === "online" ? "Online" : "Private"}</Status>
              </Link>
              <Link to="/ai" className="service-row">
                <span className="service-icon"><Sparkles size={19} /></span>
                <span className="service-main"><strong>{BRAND.assistantName}</strong><span>{data.ai.label || data.ai.message}</span></span>
                <Status tone={data.ai.state === "ready" ? "good" : data.ai.state === "error" ? "critical" : data.ai.state === "off" || data.ai.state === "not_installed" ? "neutral" : "warning"} spinning={data.ai.state === "starting" || data.ai.state === "downloading_model"}>{data.ai.state === "ready" ? "Ready" : data.ai.state === "off" ? "Off" : data.ai.state === "not_installed" ? "Not installed" : data.ai.state === "error" ? "Problem" : "Starting"}</Status>
              </Link>
              <Link to="/backups" className="service-row">
                <span className="service-icon"><ShieldCheck size={19} /></span>
                <span className="service-main"><strong>Backups</strong><span>{data.backups.unprotected.length ? `${data.backups.unprotected.length} ${data.backups.unprotected.length === 1 ? "app needs" : "apps need"} protection` : "All applications protected"}</span></span>
                <Status tone={data.backups.unprotected.length ? "warning" : "good"}>{data.backups.unprotected.length ? "Needs Attention" : "Protected"}</Status>
              </Link>
            </div>
          </Card>

          <Card title="Recent Activity">
            {data.activity.length === 0 ? <div className="dashboard-empty small secondary">Nothing to report yet.</div> : (
              <div className="activity-list">
                {groupActivity(data.activity).map(({ item, count }) => (
                  <div className="activity-row" key={item.id}>
                    <span className={`activity-dot ${activityTone(item.kind)}`} aria-hidden />
                    <span className={`activity-message${expanded === item.id ? " open" : ""}`} title={expanded === item.id ? undefined : item.message} onClick={() => setExpanded(expanded === item.id ? null : item.id)}>
                      {count > 1 && <span className="activity-count" title={`Happened ${count} times in a row`}>×{count}</span>}
                      {item.message}
                    </span>
                    <time className="small muted" dateTime={item.at} title={new Date(item.at).toLocaleString()}>{relativeTime(item.at)}</time>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>

      <Card className="ask-card">
        <div className="ask-layout">
          <div className="ask-heading">
            <span className="ask-icon"><Bot size={22} /></span>
            <div><h2>Ask {BRAND.assistantName}</h2><p className="secondary">Ask about server health, applications, or what needs your attention.</p></div>
          </div>
          <form className="ask-form" onSubmit={(e) => void ask(e)}>
            <label className="sr-only" htmlFor="ask-nexus">Question for {BRAND.assistantName}</label>
            <MessageSquareText size={18} className="ask-input-icon" aria-hidden />
            <input id="ask-nexus" className="input" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder={canUseAi ? "How is everything running?" : "You don't have permission to use AI"} disabled={!canUseAi || asking} maxLength={4000} />
            <button className="btn primary" disabled={!canUseAi || asking || !question.trim()} aria-label="Send question">{asking ? <Spinner /> : <Send size={17} />}</button>
          </form>
        </div>
        {answer && <div className="ask-answer fade-in"><div className="row small muted"><CheckCircle2 size={14} /> {answer.source === "ai" ? "Local AI response" : "Server diagnostics"}</div><p>{answer.answer}</p></div>}
        <ErrorNote error={askError} />
      </Card>
    </>
  );
}
