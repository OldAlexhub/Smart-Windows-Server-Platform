import { Bot, BrainCircuit, Check, Cpu, Gauge, LockKeyhole, MessageSquareText, Send, Settings2, ShieldCheck, Sparkles, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { BRAND } from "@nexus/shared/brand";
import type { Me } from "../App";
import { PageHead } from "../components/Layout";
import { Card, ErrorNote, Modal, Spinner, Status } from "../components/ui";
import { ApiError, post, put } from "../lib/api";
import { useApi } from "../lib/hooks";

type AiLevel = "observe" | "recommend" | "execute_after_approval";
interface Model { id: string; family: string; parametersB: number; sizeGb: number }
interface AiStatus {
  enabled: boolean;
  level: AiLevel;
  plan: { label: string; acceleration: string; model: Model; contextTokens: number; concurrency: number; reasons: string[]; warnings: string[] } | null;
  runtime: { installed: boolean; running: boolean; version: string | null; modelReady: boolean; external?: boolean };
  state: "off" | "not_installed" | "starting" | "downloading_model" | "ready" | "error";
  message: string;
}
interface Proposal {
  id: string;
  action: string;
  title: string;
  explanation: string;
  target: { type: string; id: string } | null;
  status: "pending" | "approved" | "rejected" | "executed" | "failed" | "expired";
  executable: boolean;
  createdAt: string;
  expiresAt: string;
  result: string | null;
}
interface Message { id: number; who: "you" | "nexus"; text: string; source?: "ai" | "diagnostics" }

const LEVELS: { value: AiLevel; title: string; text: string }[] = [
  { value: "observe", title: "Observe only", text: "Read health, metrics, and logs. No prepared changes." },
  { value: "recommend", title: "Recommend", text: "Suggest fixes and prepare changes for you to review." },
  { value: "execute_after_approval", title: "Execute after approval", text: "Carry out supported changes only after a person approves each one." },
];

function stateTone(state: AiStatus["state"]): "good" | "warning" | "critical" | "neutral" {
  if (state === "ready") return "good";
  if (state === "error") return "critical";
  if (state === "not_installed") return "warning";
  return "neutral";
}

function statusLabel(status: AiStatus): string {
  if (!status.enabled || status.state === "off") return "Off";
  if (status.state === "not_installed") return "Engine not installed";
  if (status.state === "downloading_model") return "Preparing model";
  if (status.state === "starting") return "Starting";
  if (status.state === "ready") return "Ready";
  return "Needs attention";
}

function SettingsModal({ status, onClose, onSaved }: { status: AiStatus; onClose: () => void; onSaved: () => void }) {
  const [enabled, setEnabled] = useState(status.enabled);
  const [level, setLevel] = useState<AiLevel>(status.level);
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await put("/ai/settings", { enabled, level, preferredModel: model.trim() || null });
      onSaved();
      onClose();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  }
  return <Modal title={`${BRAND.assistantName} settings`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={() => void save()}>{busy ? <Spinner /> : <Settings2 size={15} />} Save Settings</button></>}>
    <label className="toggle-row ai-master-toggle"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /><span><strong>Use local AI</strong><small>Runs on this server. Questions, logs, and data stay here.</small></span></label>
    <div className="choice-stack ai-levels" role="radiogroup" aria-label="AI permission level">{LEVELS.map((item) => <label className={`choice ${level === item.value ? "selected" : ""}`} key={item.value}><input type="radio" checked={level === item.value} onChange={() => setLevel(item.value)} /><span><span className="title">{item.title}</span><span className="desc">{item.text}</span></span></label>)}</div>
    <label className="field ai-model-field">Model override <span className="hint">Advanced: leave blank to use the best model for this computer.</span><input className="input mono" value={model} onChange={(e) => setModel(e.target.value)} placeholder={status.plan ? `Automatic (${status.plan.model.id})` : "Automatic"} /></label>
    <ErrorNote error={error} />
  </Modal>;
}

function ProposalRow({ item, canApprove, onDone }: { item: Proposal; canApprove: boolean; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  async function decide(decision: "approve" | "reject") {
    setBusy(true);
    setError(null);
    try { await post(`/ai/proposals/${item.id}/${decision}`); onDone(); }
    catch (e) { setError(e as ApiError); }
    finally { setBusy(false); }
  }
  const tone = item.status === "executed" || item.status === "approved" ? "good" : item.status === "failed" ? "critical" : item.status === "pending" ? "warning" : "neutral";
  return <div className="proposal-row"><span className="proposal-icon"><Sparkles size={17} /></span><span className="proposal-main"><strong>{item.title}</strong><small>{item.explanation}</small>{item.target && <em>{item.target.type}: {item.target.id}</em>}{item.result && <em>{item.result}</em>}<ErrorNote error={error} /></span><Status tone={tone}>{item.status[0]!.toUpperCase() + item.status.slice(1)}</Status>{canApprove && item.status === "pending" && <span className="proposal-actions"><button className="btn small" disabled={busy} onClick={() => void decide("reject")}><X size={14} /> Reject</button><button className="btn primary small" disabled={busy} onClick={() => void decide("approve")}><Check size={14} /> Approve</button></span>}</div>;
}

export function Ai({ me }: { me: Me }) {
  const { data: status, error, loading, reload } = useApi<AiStatus>("/ai", 8_000);
  const { data: proposals, reload: reloadProposals } = useApi<Proposal[]>("/ai/proposals", 10_000);
  const [settings, setSettings] = useState(false);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<ApiError | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const pending = proposals?.filter((p) => p.status === "pending").length ?? 0;
  async function ask(e: FormEvent) {
    e.preventDefault();
    const text = question.trim();
    if (!text || asking) return;
    setMessages((m) => [...m, { id: Date.now(), who: "you", text }]);
    setQuestion("");
    setAsking(true);
    setAskError(null);
    try {
      // The conversation so far, so follow-up questions keep their meaning.
      const history = messages.slice(-8).map((m) => ({ role: m.who === "you" ? "user" : "assistant", content: m.text }));
      const answer = await post<{ answer: string; source: "ai" | "diagnostics" }>("/ai/ask", { question: text, history });
      setMessages((m) => [...m, { id: Date.now() + 1, who: "nexus", text: answer.answer, source: answer.source }]);
    } catch (e2) { setAskError(e2 as ApiError); }
    finally { setAsking(false); }
  }
  if (loading && !status) return <div className="center-panel"><Spinner label={`Checking ${BRAND.assistantName}…`} /></div>;
  if (!status) return <ErrorNote error={error} />;
  return <>
    <PageHead title={BRAND.assistantName} sub="Private help for your server, powered locally." actions={me.permissions.includes("server.settings") && <button className="btn" onClick={() => setSettings(true)}><Settings2 size={16} /> AI Settings</button>} />
    <div className="ai-layout">
      <Card className="ai-chat-card">
        <div className="ai-chat-head"><span className="ai-orb"><Bot size={22} /></span><span><strong>Ask about this server</strong><small>{status.state === "ready" ? "Answers use local AI and live diagnostics." : "Offline diagnostics are available even while AI is off."}</small></span><Status tone={stateTone(status.state)} spinning={status.state === "starting" || status.state === "downloading_model"}>{statusLabel(status)}</Status></div>
        <div className="ai-conversation" aria-live="polite">{!messages.length ? <div className="ai-welcome"><MessageSquareText size={34} /><strong>What would you like to know?</strong><span>Try “Is everything healthy?” or “Why is an application stopped?”</span><div className="ai-prompts">{["Is everything healthy?", "Which apps need attention?", "Are my backups current?"].map((prompt) => <button key={prompt} onClick={() => setQuestion(prompt)}>{prompt}</button>)}</div></div> : messages.map((message) => <div className={`ai-message ${message.who}`} key={message.id}><span>{message.who === "you" ? "You" : BRAND.assistantName}</span><p>{message.text}</p>{message.source === "diagnostics" && <small><Cpu size={12} /> Answered from built-in diagnostics</small>}</div>)}{asking && <div className="ai-message nexus"><span>{BRAND.assistantName}</span><Spinner label="Checking your server…" /></div>}</div>
        <form className="ai-compose" onSubmit={(e) => void ask(e)}><input className="input" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Ask about applications, backups, or server health" maxLength={4000} aria-label={`Ask ${BRAND.assistantName}`} /><button className="btn primary" disabled={!question.trim() || asking} aria-label="Send question"><Send size={16} /> Send</button></form>
        <ErrorNote error={askError} />
      </Card>
      <div className="stack">
        <Card title="How it runs" action={<BrainCircuit size={19} className="muted" />}>
          <div className="ai-runtime"><div><span>Mode</span><strong>{status.plan?.label ?? "Local diagnostics"}</strong></div><div><span>Model</span><strong>{status.plan?.model.id ?? "Not loaded"}</strong></div><div><span>Permission</span><strong>{LEVELS.find((x) => x.value === status.level)?.title}</strong></div><div><span>Engine</span><strong>{status.runtime.version ? `Ollama ${status.runtime.version}${status.runtime.external ? " (yours)" : ""}` : status.runtime.installed ? "Installed" : "Not installed"}</strong></div></div>
          {status.message && <div className="notice ai-status-message">{status.message}</div>}
          <div className="ai-private"><LockKeyhole size={17} /><span><strong>Private by design</strong><small>AI listens only on this computer. It cannot approve its own changes.</small></span></div>
        </Card>
        <Card title="Safety boundaries" action={<ShieldCheck size={19} className="muted" />}><div className="safety-list"><span><Check size={15} /> Can inspect logs and health</span><span><Check size={15} /> Changes require human approval</span><span><X size={15} /> Cannot delete backups or disable security</span></div></Card>
      </div>
    </div>
    <Card className="ai-proposals" title="Recommendations" sub={pending ? `${pending} waiting for review` : "Nothing is changed without your review."} action={<Gauge size={18} className="muted" />}>
      {!proposals?.length ? <div className="ai-empty">No recommendations right now.</div> : <div className="proposal-list">{proposals.map((item) => <ProposalRow key={item.id} item={item} canApprove={me.permissions.includes("ai.approve")} onDone={() => void reloadProposals()} />)}</div>}
    </Card>
    {settings && <SettingsModal status={status} onClose={() => setSettings(false)} onSaved={() => void reload()} />}
  </>;
}
