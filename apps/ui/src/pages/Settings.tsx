import { Activity, Check, ChevronRight, CircleUserRound, Clipboard, Cloud, Code2, Cpu, Database, Globe2, HardDrive, KeyRound, Laptop, LockKeyhole, Network, PlugZap, Plus, Save, Server, ShieldCheck, Trash2, TriangleAlert, UserCog, Users, Wifi, X } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import type { HardwareProfile } from "@nexus/shared/contracts";
import type { FriendlyProblem } from "@nexus/shared/errors";
import type { Me } from "../App";
import { PageHead } from "../components/Layout";
import { Card, ConfirmByName, ErrorNote, Modal, ProblemCard, Spinner, Status } from "../components/ui";
import { ApiError, del, get, patch, post, put } from "../lib/api";
import { useApi } from "../lib/hooks";
import { PluginSettings } from "../components/PluginSettings";
import { PrivateNetwork } from "../components/PrivateNetwork";

type Tab = "users" | "access" | "security" | "plugins" | "developer";
type Role = "owner" | "administrator" | "developer" | "operator" | "viewer" | "app_user";
type AppRole = "administrator" | "developer" | "operator" | "viewer" | "app_user";
interface User {
  id: string; username: string; displayName: string; email: string | null; role: Role; hasPassword: boolean; mfaEnabled: boolean; disabled: boolean; serverSettingsAccess: boolean; appRoles: Record<string, AppRole>; createdAt: string; lastLoginAt: string | null;
}
interface AppSummary { id: string; name: string; status: string }
interface Provider { id: string; label: string; description: string; kind: "public" | "private"; installed: boolean; configured: boolean; connected: boolean; detail?: string }
interface DnsCheck { status: "connected" | "pending" | "wrong_target" | "error"; message: string; action: string | null }
interface CertificateCheck { active: boolean; issuer: string | null; daysLeft: number | null; message: string }
interface Domain { appId: string; appName: string; hostname: string; dns: DnsCheck | null; certificate: CertificateCheck | null; instruction: string | null }
interface NetworkState {
  publicIp: string | null; providers: Provider[]; gateway: { available: boolean; running: boolean; error: string | null; problem: FriendlyProblem | null }; baseDomain: string | null; remoteAdmin: { enabled: boolean; publicHost: string | null }; domains: Domain[];
}
interface AuditEntry { id: number; at: string; actorName: string | null; actorType: string; action: string; targetType: string | null; targetId: string | null; outcome: string }
interface AuditState { entries: AuditEntry[]; integrity: { intact: boolean; brokenAt: number | null; entries: number } }
interface LogEntry { t: string; level: string; source: string; message: string }

const ROLE_LABELS: Record<Role, string> = { owner: "Owner", administrator: "Administrator", developer: "Developer", operator: "Operator", viewer: "Viewer", app_user: "Application user" };
const EDITABLE_ROLES: Exclude<Role, "owner">[] = ["administrator", "developer", "operator", "viewer", "app_user"];
const APP_ROLES: (AppRole | "")[] = ["", "administrator", "developer", "operator", "viewer", "app_user"];
const TAB_INFO: { id: Tab; label: string; icon: typeof Users }[] = [
  { id: "users", label: "People", icon: Users },
  { id: "access", label: "External Access", icon: Globe2 },
  { id: "security", label: "Sign-in & Security", icon: LockKeyhole },
  { id: "plugins", label: "Plugins", icon: PlugZap },
  { id: "developer", label: "Advanced › Developer", icon: Code2 },
];

function when(value: string | null): string { return value ? new Date(value).toLocaleString() : "Never"; }
function providerTone(item: Provider): "good" | "warning" | "neutral" { return item.connected ? "good" : item.installed ? "warning" : "neutral"; }
function providerLabel(item: Provider): string { return item.connected ? "Connected" : item.configured ? "Not connected" : item.installed ? "Available" : "Not installed"; }

function CreateUserModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ username: "", displayName: "", email: "", role: "viewer" as Exclude<Role, "owner">, password: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try { await post("/users", { ...form, email: form.email || undefined, password: form.password || undefined }); onSaved(); onClose(); }
    catch (e2) { setError(e2 as ApiError); }
    finally { setBusy(false); }
  }
  return <Modal title="Add a person" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !form.username.trim() || !form.displayName.trim()} onClick={(e) => void submit(e)}><Plus size={15} /> Add Person</button></>}>
    <form className="settings-form" onSubmit={(e) => void submit(e)}><label className="field">Display name<input className="input" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} autoFocus /></label><label className="field">Username<input className="input" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} autoComplete="off" /></label><label className="field">Email <span className="hint">Optional</span><input className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label><label className="field">Server role<select className="select" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Exclude<Role, "owner"> })}>{EDITABLE_ROLES.map((role) => <option value={role} key={role}>{ROLE_LABELS[role]}</option>)}</select></label><label className="field">Temporary password <span className="hint">Optional; the person can only sign in remotely after one is set.</span><input className="input" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" /></label><ErrorNote error={error} /></form>
  </Modal>;
}

function EditUserModal({ user, apps, onClose, onSaved }: { user: User; apps: AppSummary[]; onClose: () => void; onSaved: () => void }) {
  const [role, setRole] = useState(user.role);
  const [disabled, setDisabled] = useState(user.disabled);
  const [serverSettingsAccess, setServerSettingsAccess] = useState(user.serverSettingsAccess);
  const [appRoles, setAppRoles] = useState<Record<string, AppRole | null>>({ ...user.appRoles });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  async function save() {
    setBusy(true); setError(null);
    try { await patch(`/users/${user.id}`, { role, disabled, serverSettingsAccess, appRoles }); onSaved(); onClose(); }
    catch (e) { setError(e as ApiError); }
    finally { setBusy(false); }
  }
  return <Modal title={`Access for ${user.displayName}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={() => void save()}><Save size={15} /> Save Access</button></>}>
    <div className="settings-form"><label className="field">Server role<select className="select" value={role} disabled={user.role === "owner"} onChange={(e) => setRole(e.target.value as Role)}>{user.role === "owner" && <option value="owner">Owner</option>}{EDITABLE_ROLES.map((r) => <option value={r} key={r}>{ROLE_LABELS[r]}</option>)}</select></label><label className="toggle-row"><input type="checkbox" checked={serverSettingsAccess} disabled={user.role === "owner"} onChange={(e) => setServerSettingsAccess(e.target.checked)} /><span><strong>Server settings access</strong><small>Allow configuration beyond the assigned role.</small></span></label><label className="toggle-row"><input type="checkbox" checked={disabled} disabled={user.role === "owner"} onChange={(e) => setDisabled(e.target.checked)} /><span><strong>Suspend this account</strong><small>Existing sessions stop working immediately.</small></span></label>{apps.length > 0 && <div><h3>Application-specific access</h3><div className="app-role-list">{apps.map((app) => <label className="app-role-row" key={app.id}><span><strong>{app.name}</strong><small>Overrides access for this application</small></span><select className="select" value={appRoles[app.id] ?? ""} onChange={(e) => setAppRoles((v) => ({ ...v, [app.id]: (e.target.value || null) as AppRole | null }))}>{APP_ROLES.map((r) => <option key={r || "none"} value={r}>{r ? ROLE_LABELS[r] : "Use server role"}</option>)}</select></label>)}</div></div>}<ErrorNote error={error} /></div>
  </Modal>;
}

function UsersPanel({ me }: { me: Me }) {
  const { data: users, error, loading, reload } = useApi<User[]>(me.permissions.includes("users.manage") ? "/users" : null);
  const { data: apps } = useApi<AppSummary[]>("/apps");
  const [create, setCreate] = useState(false);
  const [edit, setEdit] = useState<User | null>(null);
  const [remove, setRemove] = useState<User | null>(null);
  const [deleteError, setDeleteError] = useState<ApiError | null>(null);
  if (!me.permissions.includes("users.manage")) return <Card><div className="settings-empty"><Users size={30} /><strong>User management is restricted</strong><span>An Owner or Administrator can manage access.</span></div></Card>;
  async function removeUser() { if (!remove) return; try { await del(`/users/${remove.id}`); setRemove(null); void reload(); } catch (e) { setDeleteError(e as ApiError); setRemove(null); } }
  return <>
    <Card title="People with access" sub="Server roles set the default. Application roles can narrow or expand access." action={<button className="btn primary small" onClick={() => setCreate(true)}><Plus size={14} /> Add Person</button>}>
      {loading && !users ? <Spinner label="Loading people…" /> : error ? <ErrorNote error={error} /> : <div className="people-list">{users?.map((user) => <div className="person-row" key={user.id}><span className="person-avatar">{user.displayName.slice(0, 1).toUpperCase()}</span><span className="person-main"><strong>{user.displayName}{user.id === me.user.id && <em>You</em>}</strong><small>@{user.username}{user.email ? ` · ${user.email}` : ""}</small></span><span className="person-security"><Status tone={user.disabled ? "critical" : user.hasPassword && user.mfaEnabled ? "good" : "warning"}>{user.disabled ? "Suspended" : user.hasPassword && user.mfaEnabled ? "Remote ready" : "Local only"}</Status><small>Last sign-in: {when(user.lastLoginAt)}</small></span><span className="role-pill">{ROLE_LABELS[user.role]}</span><button className="btn small" onClick={() => setEdit(user)}><UserCog size={14} /> Manage</button>{user.role !== "owner" && user.id !== me.user.id && <button className="btn ghost small danger" aria-label={`Remove ${user.displayName}`} onClick={() => setRemove(user)}><Trash2 size={15} /></button>}</div>)}</div>}
    </Card>
    <Card title="Role guide"><div className="role-guide"><div><strong>Administrator</strong><span>Manage server, applications, databases, and people.</span></div><div><strong>Developer</strong><span>Deploy and configure applications without user or network control.</span></div><div><strong>Operator</strong><span>Monitor apps, restart them, and run backups.</span></div><div><strong>Viewer / Application user</strong><span>Read-only server access or access only to assigned applications.</span></div></div></Card>
    <ErrorNote error={deleteError} />
    {create && <CreateUserModal onClose={() => setCreate(false)} onSaved={() => void reload()} />}
    {edit && <EditUserModal user={edit} apps={apps ?? []} onClose={() => setEdit(null)} onSaved={() => void reload()} />}
    {remove && <ConfirmByName name={remove.username} action="Remove Person" onClose={() => setRemove(null)} onConfirm={() => void removeUser()}><p>This permanently removes <strong>{remove.displayName}</strong> and revokes all of their sessions. Applications and data are not removed.</p></ConfirmByName>}
  </>;
}

function AccessPanel({ me }: { me: Me }) {
  const { data, error, loading, reload } = useApi<NetworkState>("/network", 20_000);
  const { data: users } = useApi<User[]>(me.permissions.includes("users.manage") ? "/users" : null);
  const current = users?.find((u) => u.id === me.user.id);
  const [baseDomain, setBaseDomain] = useState<string | null>(null);
  const [savingDomain, setSavingDomain] = useState(false);
  const [domainSaved, setDomainSaved] = useState(false);
  const [remote, setRemote] = useState<{ enabled: boolean; publicHost: string } | null>(null);
  const [understood, setUnderstood] = useState(false);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  if (loading && !data) return <div className="center-panel"><Spinner label="Checking external access…" /></div>;
  if (!data) return <ErrorNote error={error} />;
  const network = data;
  const canManage = me.permissions.includes("network.manage");
  const canManageRemote = me.permissions.includes("server.remote_admin");
  const remoteReady = !!current?.hasPassword && !!current?.mfaEnabled;
  async function saveDomain() { setSavingDomain(true); setActionError(null); try { await put("/network/settings", { baseDomain: (baseDomain ?? network.baseDomain)?.trim() || null }); await reload(); setBaseDomain(null); setDomainSaved(true); setTimeout(() => setDomainSaved(false), 6000); } catch (e) { setActionError(e as ApiError); } finally { setSavingDomain(false); } }
  async function saveRemote() { if (!remote) return; setActionError(null); try { await put("/remote-admin", { enabled: remote.enabled, publicHost: remote.publicHost.trim() || null }); await reload(); setRemote(null); setUnderstood(false); } catch (e) { setActionError(e as ApiError); } }
  return <>
    {data.gateway.problem && <ProblemCard problem={data.gateway.problem} />}
    {!data.gateway.running && data.gateway.error && <ProblemCard problem={{ title: "Secure gateway stopped", summary: data.gateway.error, checks: [], repair: { id: "gateway.retry", label: "Try Again", requiresConfirmation: false } }} />}
    <div className="grid access-summary"><Card><div className="stat-label">Secure Gateway</div><div className="settings-stat"><Status tone={data.gateway.running ? "good" : data.gateway.available ? "warning" : "critical"}>{data.gateway.running ? "Running" : data.gateway.available ? "Stopped" : "Unavailable"}</Status></div><div className="stat-sub">Routes private and public application traffic</div></Card><Card><div className="stat-label">Public Address</div><div className="stat-value small-value mono">{data.publicIp ?? "Not detected"}</div><div className="stat-sub">Only needed for direct internet access</div></Card><Card><div className="stat-label">Remote Administration</div><div className="settings-stat"><Status tone={data.remoteAdmin.enabled ? "warning" : "good"}>{data.remoteAdmin.enabled ? "Enabled" : "Local only"}</Status></div><div className="stat-sub">{data.remoteAdmin.publicHost ?? "Control center stays on this computer"}</div></Card></div>
    <Card title="Connection options" sub="Nexus chooses the simplest available route when you publish an application."><div className="provider-list">{data.providers.map((provider) => <div className="provider-row" key={provider.id}><span className="provider-icon">{provider.kind === "private" ? <Wifi size={18} /> : provider.id.includes("cloudflare") ? <Cloud size={18} /> : <Network size={18} />}</span><span><strong>{provider.label}</strong><small>{provider.description}</small>{provider.detail && <em>{provider.detail}</em>}</span><Status tone={providerTone(provider)}>{providerLabel(provider)}</Status></div>)}</div></Card>
    <PrivateNetwork canManage={canManage} />
    <Card title="Domains" sub="Use one base domain to create predictable addresses for applications." action={canManage && <button className="btn primary small" disabled={savingDomain} onClick={() => void saveDomain()}><Save size={14} /> Save</button>}>
      <label className="field domain-setting">Base domain <span className="hint">Example: example.com. New applications can use app-name.example.com.</span><input className="input" disabled={!canManage} value={baseDomain ?? data.baseDomain ?? ""} onChange={(e) => { setBaseDomain(e.target.value); setDomainSaved(false); }} placeholder="example.com" /></label>
      {domainSaved && <div className="notice saved-note" role="status"><Check size={16} /> Saved. New applications you publish can use addresses like <strong>app-name.{data.baseDomain}</strong>.</div>}
      {!data.domains.length ? <div className="settings-empty compact"><Globe2 size={25} /><strong>No public application domains</strong><span>Private applications continue to work at their local addresses.</span></div> : <div className="domain-list">{data.domains.map((domain) => <div className="domain-row" key={`${domain.appId}:${domain.hostname}`}><span><strong>{domain.hostname}</strong><small>{domain.appName}</small></span><span><Status tone={domain.dns?.status === "connected" ? "good" : domain.dns?.status === "error" || domain.dns?.status === "wrong_target" ? "critical" : "warning"}>{domain.dns?.status === "connected" ? "DNS connected" : domain.dns?.status === "wrong_target" ? "DNS needs a change" : domain.dns?.status === "error" ? "DNS check failed" : "DNS pending"}</Status><small>{domain.dns?.message ?? domain.instruction ?? "Waiting for a public address"}</small></span><span><Status tone={domain.certificate?.active ? "good" : "warning"}>{domain.certificate?.active ? "HTTPS active" : "HTTPS pending"}</Status><small>{domain.certificate?.message ?? "Certificate will be automatic"}</small></span></div>)}</div>}
    </Card>
    <Card title="Remote administration" sub="Open this control center from outside the server. Application access is configured separately." action={canManageRemote && <button className="btn small" onClick={() => setRemote({ enabled: data.remoteAdmin.enabled, publicHost: data.remoteAdmin.publicHost ?? "" })}>Configure</button>}><div className="remote-admin-summary"><ShieldCheck size={22} /><span><strong>{data.remoteAdmin.enabled ? `Available at ${data.remoteAdmin.publicHost}` : "Control center is local only"}</strong><small>{data.remoteAdmin.enabled ? "A password and two-step verification are required at every remote sign-in." : "This is the safest default. Published applications can still be reached normally."}</small></span></div></Card>
    <ErrorNote error={actionError} />
    {remote && <Modal title="Remote administration" onClose={() => setRemote(null)} footer={<><button className="btn" onClick={() => setRemote(null)}>Cancel</button><button className="btn primary" disabled={remote.enabled && (!remote.publicHost.trim() || !remoteReady || !understood)} onClick={() => void saveRemote()}><Save size={15} /> Save Access</button></>}><div className="settings-form"><label className="toggle-row"><input type="checkbox" checked={remote.enabled} onChange={(e) => setRemote({ ...remote, enabled: e.target.checked })} /><span><strong>Allow remote administration</strong><small>Exposes the Nexus sign-in page at the address below.</small></span></label>{remote.enabled && <><label className="field">Control center address<input className="input" value={remote.publicHost} onChange={(e) => setRemote({ ...remote, publicHost: e.target.value })} placeholder="server.example.com" /></label><div className="prerequisite-list"><span className={current?.hasPassword ? "done" : "missing"}>{current?.hasPassword ? <Check size={15} /> : <X size={15} />} Owner password</span><span className={current?.mfaEnabled ? "done" : "missing"}>{current?.mfaEnabled ? <Check size={15} /> : <X size={15} />} Two-step verification</span></div><label className="toggle-row warning-toggle"><input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} /><span><strong>I understand this makes the sign-in page reachable from the internet</strong><small>Nexus still requires encrypted HTTPS, a password, and two-step verification.</small></span></label></>}</div></Modal>}
  </>;
}

function PasswordModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => Promise<void> | void }) {
  const [password, setPassword] = useState(""); const [again, setAgain] = useState(""); const [error, setError] = useState<ApiError | null>(null); const [busy, setBusy] = useState(false);
  async function save(e: FormEvent) { e.preventDefault(); if (password !== again) { setError(new ApiError("The passwords do not match.", 0, "invalid", null)); return; } setBusy(true); try { await post("/me/password", { password }); await onSaved(); onClose(); } catch (e2) { setError(e2 as ApiError); } finally { setBusy(false); } }
  return <Modal title="Set your password" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !password || password !== again} onClick={(e) => void save(e)}><KeyRound size={15} /> Save Password</button></>}><form className="settings-form" onSubmit={(e) => void save(e)}><p className="secondary">Use a long, unique password. It is required before remote administration can be enabled.</p><label className="field">New password<input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" autoFocus /></label><label className="field">Confirm password<input className="input" type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" /></label><ErrorNote error={error} /></form></Modal>;
}

function MfaModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [data, setData] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [code, setCode] = useState(""); const [confirmError, setConfirmError] = useState<ApiError | null>(null); const [codes, setCodes] = useState<string[] | null>(null);
  useEffect(() => { void post<{ secret: string; otpauthUri: string }>("/me/mfa/begin").then(setData).catch((e) => setError(e as ApiError)).finally(() => setLoading(false)); }, []);
  async function confirm() { try { const r = await post<{ recoveryCodes: string[] }>("/me/mfa/confirm", { code }); setCodes(r.recoveryCodes); onSaved(); } catch (e) { setConfirmError(e as ApiError); } }
  if (codes) return <Modal title="Save your recovery codes" onClose={onClose} footer={<button className="btn primary" onClick={() => location.reload()}><Check size={15} /> I Saved Them</button>}><div className="restore-warning"><TriangleAlert size={20} /><span>These codes are shown once. Keep them somewhere separate from this server.</span></div><pre className="recovery-codes">{codes.join("\n")}</pre><button className="btn" onClick={() => void navigator.clipboard.writeText(codes.join("\n"))}><Clipboard size={15} /> Copy Codes</button></Modal>;
  return <Modal title="Turn on two-step verification" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!data || code.trim().length < 6} onClick={() => void confirm()}><ShieldCheck size={15} /> Verify and Enable</button></>}>
    {loading ? <Spinner label="Creating a private setup key…" /> : error ? <ErrorNote error={error} /> : data && <div className="settings-form"><p className="secondary">In your authenticator app, add an account manually and enter this setup key.</p><div className="mfa-secret"><code>{data.secret}</code><button className="btn small" onClick={() => void navigator.clipboard.writeText(data.secret)}><Clipboard size={14} /> Copy</button></div><details><summary>Authenticator link</summary><code className="mfa-uri">{data.otpauthUri}</code></details><label className="field">6-digit code<input className="input code-input" inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} /></label><ErrorNote error={confirmError} /></div>}
  </Modal>;
}

function SecurityPanel({ me }: { me: Me }) {
  const { data: users, reload } = useApi<User[]>(me.permissions.includes("users.manage") ? "/users" : null);
  const current = users?.find((u) => u.id === me.user.id);
  const [password, setPassword] = useState(false); const [mfa, setMfa] = useState(false); const [savedNote, setSavedNote] = useState<string | null>(null);
  return <>
    {savedNote && <div className="notice saved-note" role="status"><Check size={16} /> {savedNote}</div>}
    <Card title="Your sign-in security" sub="These protections belong to your account."><div className="security-options"><div className="security-option"><span className="settings-icon"><KeyRound size={19} /></span><span><strong>Password</strong><small>{current?.hasPassword ? "A password is set for your account." : "Set a password before using remote administration."}</small></span><Status tone={current?.hasPassword ? "good" : "warning"}>{current?.hasPassword ? "Set" : "Not set"}</Status><button className="btn small" onClick={() => setPassword(true)}>{current?.hasPassword ? "Change" : "Set Password"}</button></div><div className="security-option"><span className="settings-icon"><ShieldCheck size={19} /></span><span><strong>Two-step verification</strong><small>Add a time-based code from an authenticator app.</small></span><Status tone={me.user.mfaEnabled ? "good" : "warning"}>{me.user.mfaEnabled ? "Enabled" : "Not enabled"}</Status>{!me.user.mfaEnabled && <button className="btn small" onClick={() => setMfa(true)}>Set Up</button>}</div></div></Card>
    <Card title="Security defaults"><div className="safety-list"><span><Check size={15} /> Server control stays local unless the Owner enables remote access</span><span><Check size={15} /> Remote sign-ins require password and two-step verification</span><span><Check size={15} /> Suspicious attempts are rate-limited and written to the audit trail</span><span><Check size={15} /> Application access follows least-privilege roles</span></div></Card>
    {password && <PasswordModal onClose={() => setPassword(false)} onSaved={async () => { await reload(); setSavedNote("Password saved. Use it with the username “" + me.user.username + "” when signing in from a browser or another device."); }} />}
    {mfa && <MfaModal onClose={() => setMfa(false)} onSaved={() => void reload()} />}
  </>;
}

interface DevInfo {
  appId: string; name: string; status: string; runtime: string; framework: string; sourceDir: string; pid: number | null;
  internalAddress: string | null; localUrl: string | null; publicHosts: string[]; accessMode: string;
  isolation: { id: string; label: string };
  release: { version: string; dir: string; commit: string | null; python: string | null } | null;
  start: { executable: string; args: string[]; cwd: string } | null;
  healthPath: string | null;
  migrations: { tool: string; description: string } | null;
  settings: { name: string; value: string; secret: boolean }[];
  managedVariables: string[];
  database: { name: string; host: string; port: number; database: string; user: string; password: string; url: string } | null;
  apiCredentials: { id: string; label: string; scopes: string[]; createdAt: string; lastUsedAt: string | null; revoked: boolean }[];
}

function KV({ k, v, mono = true }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return <div className="dev-kv"><span className="muted small">{k}</span><span className={mono ? "mono" : ""} style={{ overflowWrap: "anywhere" }}>{v ?? "—"}</span></div>;
}

/** Per-application technical details: ports, runtime, isolation, release, settings, database, credentials. */
function AppDeveloperCard() {
  const { data: apps } = useApi<AppSummary[]>("/apps");
  const [appId, setAppId] = useState<string>("");
  const [reveal, setReveal] = useState(false);
  const selected = appId || apps?.[0]?.id || "";
  const { data, error, loading } = useApi<DevInfo>(selected ? `/apps/${selected}/developer${reveal ? "?reveal=1" : ""}` : null);
  if (apps && !apps.length) return <Card title="Applications"><div className="settings-empty compact"><Code2 size={24} /><strong>No applications yet</strong><span>Technical details appear here once an application is deployed.</span></div></Card>;
  return <Card title="Application internals" sub="Ports, runtime, settings and credentials Nexus manages for each application." action={<div className="row"><select className="select log-source-select" value={selected} onChange={(e) => { setAppId(e.target.value); setReveal(false); }}>{apps?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select><button className="btn small" onClick={() => setReveal(!reveal)}><KeyRound size={14} /> {reveal ? "Hide secrets" : "Reveal secrets"}</button></div>}>
    <ErrorNote error={error} />
    {loading && !data ? <Spinner label="Reading application details…" /> : data && <div className="stack">
      <div className="dev-grid">
        <KV k="Status" v={data.status} mono={false} />
        <KV k="Internal address" v={data.internalAddress} />
        <KV k="Local address" v={data.localUrl} />
        <KV k="Public domains" v={data.publicHosts.join(", ") || "None (private)"} />
        <KV k="Isolation" v={data.isolation.label} mono={false} />
        <KV k="Process ID" v={data.pid ?? "Not running"} />
        <KV k="Health endpoint" v={data.healthPath ?? "/ (any answer)"} />
        <KV k="Runtime" v={`${data.framework}${data.release?.python ? ` · Python ${data.release.python}` : ""}`} mono={false} />
        <KV k="Current release" v={data.release ? `${data.release.version}${data.release.commit ? ` (${data.release.commit})` : ""}` : "Not deployed"} />
        <KV k="Release folder" v={data.release?.dir} />
        <KV k="Source folder" v={data.sourceDir} />
        <KV k="Start command" v={data.start ? [data.start.executable, ...data.start.args].join(" ") : "Served by the gateway"} />
        <KV k="Migrations" v={data.migrations?.description ?? "None detected"} mono={false} />
      </div>
      {data.database && <div><h3 style={{ marginBottom: 8 }}><Database size={15} /> Database connection</h3><div className="dev-grid"><KV k="Database" v={data.database.database} /><KV k="Host" v={`${data.database.host}:${data.database.port}`} /><KV k="User" v={data.database.user} /><KV k="Password" v={data.database.password} /><KV k="Connection URL" v={data.database.url} /></div></div>}
      <div><h3 style={{ marginBottom: 8 }}>Environment variables</h3><div className="table-wrap"><table className="data"><thead><tr><th>Name</th><th>Value</th><th>Source</th></tr></thead><tbody>
        {data.managedVariables.map((n) => <tr key={`m-${n}`}><td className="mono">{n}</td><td className="muted">Set automatically at start</td><td>Nexus</td></tr>)}
        {data.settings.map((s) => <tr key={s.name}><td className="mono">{s.name}</td><td className="mono">{s.value}</td><td>{s.secret ? "Secret" : "Setting"}</td></tr>)}
      </tbody></table></div></div>
      <div><h3 style={{ marginBottom: 8 }}>API credentials</h3>{!data.apiCredentials.length ? <p className="muted">None.</p> : <div className="list">{data.apiCredentials.map((c) => <div className="list-item" key={c.id}><KeyRound size={16} className="muted" /><span style={{ flex: 1 }}><strong>{c.label}</strong><div className="small muted mono">{c.scopes.join(", ")}</div></span><span className="small muted">{c.lastUsedAt ? `Used ${when(c.lastUsedAt)}` : "Never used"}</span><Status tone={c.revoked ? "neutral" : "good"}>{c.revoked ? "Revoked" : "Active"}</Status></div>)}</div>}</div>
      <p className="small muted">An interactive application terminal is planned; for now use the release folder above with a local terminal.</p>
    </div>}
  </Card>;
}

const AUDIT_PAGE = 50;

/** The newest events (refreshed live) in a fixed-height scrolling box; older ones load on request. */
function AuditList({ latest, total }: { latest: AuditEntry[]; total: number }) {
  const [older, setOlder] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [end, setEnd] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const entries = useMemo(() => {
    const seen = new Set(latest.map((e) => e.id));
    return [...latest, ...older.filter((e) => !seen.has(e.id))];
  }, [latest, older]);
  async function loadOlder() {
    const oldest = entries.at(-1)?.id;
    if (!oldest) return;
    setLoading(true);
    try {
      const r = await get<AuditState>(`/audit?limit=${AUDIT_PAGE}&beforeId=${oldest}`);
      setOlder((o) => [...o, ...r.entries]);
      if (r.entries.length < AUDIT_PAGE) setEnd(true);
      setError(null);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setLoading(false);
    }
  }
  const more = !end && entries.length < total && (entries.at(-1)?.id ?? 0) > 1;
  return <>
    <div className="audit-list">{entries.map((entry) => <div className="audit-row" key={entry.id}><span className="audit-number">#{entry.id}</span><span><strong>{entry.action.replaceAll(".", " › ")}</strong><small>{entry.actorName ?? entry.actorType}{entry.targetType ? ` · ${entry.targetType}${entry.targetId ? ` ${entry.targetId}` : ""}` : ""}</small></span><Status tone={entry.outcome === "success" ? "good" : "critical"}>{entry.outcome}</Status><time>{new Date(entry.at).toLocaleString()}</time></div>)}</div>
    <ErrorNote error={error} />
    <div className="audit-foot"><span className="small muted">Showing {entries.length.toLocaleString()} of {total.toLocaleString()} events</span>{more && <button className="btn small" disabled={loading} onClick={() => void loadOlder()}>{loading ? <Spinner label="Loading…" /> : "Show older"}</button>}</div>
  </>;
}

function DeveloperPanel({ me }: { me: Me }) {
  const { data: hardware } = useApi<{ hardware: HardwareProfile }>("/hardware");
  const { data: audit, error: auditError } = useApi<AuditState>(me.permissions.includes("audit.view") ? "/audit?limit=30" : null, 15_000);
  const [source, setSource] = useState("gateway");
  const { data: logs, error: logError } = useApi<{ entries: LogEntry[] }>(me.permissions.includes("server.settings") ? `/logs/system/${source}` : null, 10_000);
  const apiAddress = `${location.origin}/api/v1`;
  const recentLogs = logs?.entries.slice(0, 100) ?? [];
  return <>
    <div className="grid developer-summary"><Card><div className="stat-label">Local API</div><div className="developer-value mono">{apiAddress}</div><div className="stat-sub">Authenticated, versioned service endpoint</div></Card><Card><div className="stat-label">Signed-in Role</div><div className="developer-value">{ROLE_LABELS[me.user.role as Role]}</div><div className="stat-sub">{me.permissions.length} effective permissions</div></Card><Card><div className="stat-label">Audit Integrity</div><div className="settings-stat"><Status tone={audit?.integrity.intact ? "good" : "critical"}>{audit?.integrity.intact ? "Verified" : audit ? "Broken" : "Checking"}</Status></div><div className="stat-sub">{audit?.integrity.entries ?? 0} chained events</div></Card></div>
    <Card title="Detected hardware" sub="Read-only information used for automatic configuration.">{hardware ? <div className="hardware-grid"><span><Cpu size={17} /><strong>{hardware.hardware.cpu.model}</strong><small>{hardware.hardware.cpu.cores} cores · {hardware.hardware.cpu.threads} threads</small></span><span><Database size={17} /><strong>{Math.round(hardware.hardware.memory.totalBytes / 1073741824)} GB memory</strong><small>{Math.round(hardware.hardware.memory.freeBytes / 1073741824)} GB currently free</small></span><span><HardDrive size={17} /><strong>{hardware.hardware.disks.length} storage devices</strong><small>{hardware.hardware.disks.map((d) => d.mount).join(", ")}</small></span><span><Laptop size={17} /><strong>{hardware.hardware.os.edition || hardware.hardware.os.name}</strong><small>{hardware.hardware.system.manufacturer} {hardware.hardware.system.model}</small></span></div> : <Spinner label="Reading hardware…" />}</Card>
    <AppDeveloperCard />
    {me.permissions.includes("server.settings") && <Card title="System logs" sub="Technical service output. Secrets are automatically redacted." action={<select className="select log-source-select" value={source} onChange={(e) => setSource(e.target.value)}><option value="gateway">Secure gateway</option><option value="postgres">PostgreSQL</option><option value="ai">Local AI</option></select>}><ErrorNote error={logError} />{!recentLogs.length ? <div className="settings-empty compact"><Activity size={24} /><strong>No recent {source} logs</strong></div> : <div className="system-log">{recentLogs.map((entry, i) => <div className={`system-log-line ${entry.level}`} key={`${entry.t}:${i}`}><time>{new Date(entry.t).toLocaleTimeString()}</time><strong>{entry.level}</strong><pre>{entry.message}</pre></div>)}</div>}</Card>}
    {me.permissions.includes("audit.view") && <Card title="Audit trail" sub="Append-only record of security and configuration changes." action={audit && <Status tone={audit.integrity.intact ? "good" : "critical"}>{audit.integrity.intact ? "Chain intact" : `Broken at #${audit.integrity.brokenAt}`}</Status>}><ErrorNote error={auditError} />{audit && <AuditList latest={audit.entries} total={audit.integrity.entries} />}</Card>}
  </>;
}

export function Settings({ me }: { me: Me }) {
  const location = useLocation();
  const navigate = useNavigate();
  const allowed = useMemo(() => TAB_INFO
    .filter((item) => item.id !== "users" || me.permissions.includes("users.manage"))
    .filter((item) => item.id !== "access" || me.permissions.includes("server.view"))
    .filter((item) => item.id !== "plugins" || me.permissions.includes("plugins.manage"))
    .filter((item) => item.id !== "developer" || me.permissions.includes("server.settings") || me.permissions.includes("audit.view")), [me.permissions]);
  const section = location.pathname.split("/").filter(Boolean)[1] ?? "";
  const routeTab: Tab = section === "network" || section === "domains" ? "access" : section === "security" ? "security" : section === "plugins" ? "plugins" : section === "developer" || section === "storage" ? "developer" : "users";
  const active = allowed.some((x) => x.id === routeTab) ? routeTab : (allowed[0]?.id ?? "security");
  const routeFor: Record<Tab, string> = { users: "/settings", access: "/settings/network", security: "/settings/security", plugins: "/settings/plugins", developer: "/settings/developer" };
  return <>
    <PageHead title="Settings" sub="People, secure access, and advanced server details." />
    <div className="settings-layout"><nav className="settings-nav" aria-label="Settings sections">{allowed.map(({ id, label, icon: Icon }) => <button key={id} className={active === id ? "active" : ""} onClick={() => navigate(routeFor[id])}><Icon size={17} /><span>{label}</span><ChevronRight size={15} /></button>)}</nav><div className="settings-content stack">{active === "users" ? <UsersPanel me={me} /> : active === "access" ? <AccessPanel me={me} /> : active === "security" ? <SecurityPanel me={me} /> : active === "plugins" ? <PluginSettings /> : <DeveloperPanel me={me} />}</div></div>
  </>;
}
