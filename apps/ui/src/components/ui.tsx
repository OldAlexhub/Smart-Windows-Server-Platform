import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, CircleDashed, Loader2, OctagonAlert, PauseCircle, Wrench, XCircle } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { FriendlyProblem, RepairAction } from "@nexus/shared/errors";
import { ApiError, post } from "../lib/api";

/** Repairs that just take the person to the right place instead of calling the server. */
const NAVIGATE_REPAIRS: Record<string, (appId?: string) => string> = {
  "app.open-settings": (appId) => (appId ? `/apps/${appId}?tab=settings` : "/apps"),
  "backup.restore": () => "/backups",
  "storage.cleanup": () => "/",
};

/** Runs a one-click repair: confirmation when needed, server call, then a short result. */
function useRepair(appId?: string) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [confirming, setConfirming] = useState<RepairAction | null>(null);
  async function run(r: RepairAction, confirmed = false) {
    const nav = NAVIGATE_REPAIRS[r.id];
    if (nav) {
      location.assign(nav(appId));
      return;
    }
    if (r.requiresConfirmation && !confirmed) {
      setConfirming(r);
      return;
    }
    setConfirming(null);
    setBusy(true);
    setResult(null);
    try {
      const res = await post<{ ok: boolean; message: string; jobId?: string }>("/repairs", { id: r.id, appId, confirmed, params: r.params });
      setResult({ ok: res.ok, message: res.message });
      if (res.jobId && appId) setTimeout(() => location.assign(`/apps/${appId}`), 800);
    } catch (e) {
      setResult({ ok: false, message: e instanceof ApiError ? e.message : "The repair didn't work." });
    } finally {
      setBusy(false);
    }
  }
  return { busy, result, confirming, run, cancel: () => setConfirming(null) };
}

export function Card({ title, sub, action, children, className = "" }: { title?: ReactNode; sub?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || action) && (
        <div className="card-head">
          <div>
            {title && <h2>{title}</h2>}
            {sub && <div className="sub">{sub}</div>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export type Tone = "good" | "warning" | "serious" | "critical" | "neutral";

const TONE_ICON: Record<Tone, typeof CheckCircle2> = {
  good: CheckCircle2,
  warning: AlertTriangle,
  serious: OctagonAlert,
  critical: XCircle,
  neutral: PauseCircle,
};

/** Status is never colour alone: icon + word + colour. */
export function Status({ tone, children, spinning = false }: { tone: Tone; children: ReactNode; spinning?: boolean }) {
  const Icon = spinning ? Loader2 : TONE_ICON[tone];
  return (
    <span className={`status ${tone}`}>
      <Icon size={16} className={spinning ? "spin" : ""} aria-hidden />
      {children}
    </span>
  );
}

/** App / database status words → tone. */
export function statusTone(s: string): { tone: Tone; label: string; spinning?: boolean } {
  switch (s) {
    case "running":
    case "healthy":
    case "online":
    case "ready":
      return { tone: "good", label: s === "healthy" ? "Healthy" : s === "online" ? "Online" : s === "ready" ? "Ready" : "Running" };
    case "deploying":
    case "starting":
      return { tone: "neutral", label: s === "deploying" ? "Deploying" : "Starting", spinning: true };
    case "stopped":
    case "off":
      return { tone: "neutral", label: s === "off" ? "Off" : "Stopped" };
    case "crashed":
    case "offline":
      return { tone: "critical", label: s === "offline" ? "Offline" : "Stopped unexpectedly" };
    default:
      return { tone: "warning", label: "Needs Attention" };
  }
}

export function StatusOf({ status }: { status: string }) {
  const t = statusTone(status);
  return (
    <Status tone={t.tone} spinning={!!t.spinning}>
      {t.label}
    </Status>
  );
}

export function Stat({ label, value, sub, children }: { label: ReactNode; value: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="card">
      <div className="stat-label">{label}</div>
      <div className="stat-value num">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
      {children}
    </div>
  );
}

/** Part-of-whole bar. Value is 0..1. */
export function Meter({ value, label }: { value: number; label: string }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label={label}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="row secondary">
      <Loader2 size={18} className="spin" aria-hidden /> {label ?? "Loading…"}
    </span>
  );
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="card" style={{ textAlign: "center", padding: "40px 24px" }}>
      <div style={{ color: "var(--text-muted)", marginBottom: 12 }}>{icon ?? <CircleDashed size={32} />}</div>
      <h2>{title}</h2>
      {children && <p className="secondary" style={{ marginTop: 6 }}>{children}</p>}
      {action && <div style={{ marginTop: 18 }}>{action}</div>}
    </div>
  );
}

/** Friendly problem: what's wrong, what Nexus checked, a one-click repair, and details on request. */
export function ProblemCard({ problem, appId, onRepair, repairing }: { problem: FriendlyProblem; appId?: string; onRepair?: (id: string) => void; repairing?: boolean }) {
  const [open, setOpen] = useState(false);
  // On application pages the app comes from the address (/apps/<id>).
  const pageApp = location.pathname.match(/^\/apps\/([^/]+)/)?.[1];
  const repair = useRepair(appId ?? (pageApp && pageApp !== "new" ? pageApp : undefined));
  const doRepair = onRepair ?? ((id: string) => problem.repair && id === problem.repair.id && void repair.run(problem.repair));
  const isRepairing = repairing ?? repair.busy;
  return (
    <div className="problem fade-in" role="alert">
      <Status tone="critical">{problem.title}</Status>
      <p style={{ marginTop: 8 }}>{problem.summary}</p>
      {problem.checks.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="small secondary" style={{ fontWeight: 600, marginBottom: 4 }}>
            Nexus checked:
          </div>
          {problem.checks.map((c) => (
            <div key={c.label} className="row small">
              <span style={{ minWidth: 150 }}>{c.label}</span>
              <Status tone={c.status === "ok" ? "good" : c.status === "failed" ? "critical" : "neutral"}>{c.detail ?? (c.status === "ok" ? "Working" : c.status === "failed" ? "Not working" : "Unknown")}</Status>
            </div>
          ))}
        </div>
      )}
      {problem.cause && (
        <p style={{ marginTop: 12 }}>
          <strong>Problem: </strong>
          {problem.cause}
        </p>
      )}
      <div className="row" style={{ marginTop: 14 }}>
        {problem.repair && (
          <button className="btn primary" disabled={isRepairing} onClick={() => doRepair(problem.repair!.id)}>
            {isRepairing ? <Loader2 size={16} className="spin" /> : <Wrench size={16} />} {problem.repair.label}
          </button>
        )}
        {problem.technical && (
          <button className="btn ghost small" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Advanced details
          </button>
        )}
      </div>
      {repair.result && (
        <div style={{ marginTop: 10 }}>
          <Status tone={repair.result.ok ? "good" : "critical"}>{repair.result.message}</Status>
        </div>
      )}
      {repair.confirming && (
        <Modal
          title={repair.confirming.label}
          onClose={repair.cancel}
          footer={
            <>
              <button className="btn" onClick={repair.cancel}>
                Cancel
              </button>
              <button className="btn primary" onClick={() => void repair.run(repair.confirming!, true)}>
                {repair.confirming.label}
              </button>
            </>
          }
        >
          <p>{problem.cause ?? problem.summary}</p>
          <p className="secondary" style={{ marginTop: 8 }}>
            Nexus will do this for you. Your application's code is never changed.
          </p>
        </Modal>
      )}
      {open && problem.technical && (
        <pre className="mono" style={{ whiteSpace: "pre-wrap", marginTop: 10, padding: 12, background: "var(--surface-sunken)", borderRadius: 8, maxHeight: 260, overflow: "auto" }}>
          {problem.technical}
        </pre>
      )}
    </div>
  );
}

export function Modal({ title, children, onClose, footer, wide = false }: { title: string; children: ReactNode; onClose: () => void; footer?: ReactNode; wide?: boolean }) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal fade-in${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <h2 style={{ marginBottom: 14 }}>{title}</h2>
        {children}
        {footer && <div className="row" style={{ justifyContent: "flex-end", marginTop: 20 }}>{footer}</div>}
      </div>
    </div>
  );
}

/** Destructive actions: the user types the name to confirm. */
export function ConfirmByName({ name, action, danger = true, onConfirm, onClose, children }: { name: string; action: string; danger?: boolean; onConfirm: () => void; onClose: () => void; children?: ReactNode }) {
  const [typed, setTyped] = useState("");
  return (
    <Modal
      title={action}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className={`btn ${danger ? "primary" : "primary"}`} style={danger ? { background: "var(--critical)" } : {}} disabled={typed !== name} onClick={onConfirm}>
            {action}
          </button>
        </>
      }
    >
      {children}
      <label className="field" style={{ marginTop: 12 }}>
        Type <strong>{name}</strong> to confirm
        <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
      </label>
    </Modal>
  );
}

export function ErrorNote({ error }: { error: { message: string; problem?: FriendlyProblem | null } | null }) {
  if (!error) return null;
  if (error.problem) return <ProblemCard problem={error.problem} />;
  return (
    <div className="notice" role="alert" style={{ color: "var(--critical-text)" }}>
      {error.message}
    </div>
  );
}
