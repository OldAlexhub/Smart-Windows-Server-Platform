import { useState } from "react";
import { Copy, KeyRound, Plus, Unlink } from "lucide-react";
import { ApiError, del, post } from "../lib/api";
import { useApi } from "../lib/hooks";
import { ErrorNote, Modal } from "./ui";

interface Account { username: string; mode: "read-only" | "read-write"; revoked: boolean }
interface Credentials { username: string; password: string }

export function DatabaseAccounts({ databaseId, host, port, database }: { databaseId: string; host: string; port: number; database: string }) {
  const path = `/database-links/tables/${databaseId}/accounts`;
  const { data, error, reload } = useApi<Account[]>(path);
  const [adding, setAdding] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<Account["mode"]>("read-only");
  const [credentials, setCredentials] = useState<Credentials | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  async function act(action: () => Promise<void>) {
    setBusy(true); setFailure(null);
    try { await action(); await reload(); } catch (e) { setFailure(e as ApiError); } finally { setBusy(false); }
  }
  const details = credentials ? `Host: ${host}\nPort: ${port}\nDatabase: ${database}\nUsername: ${credentials.username}\nPassword: ${credentials.password}` : "";
  return <div className="db-code-guide">
    <div className="row"><strong>Connection accounts</strong><button className="btn small" onClick={() => setAdding(true)}><Plus size={14} /> Add account</button></div>
    <p className="small muted">Individual logins for Excel, Power BI, ODBC, and other tools. Each account can access only this database's public tables. Read/write permits editing data, not changing the schema.</p>
    {data?.filter((account) => !account.revoked).map((account) => <div className="row" key={account.username}>
      <code>{account.username}</code><span className="small muted">{account.mode === "read-only" ? "Read only" : "Read/write"}</span>
      <button className="btn small" disabled={busy} onClick={() => void act(async () => setCredentials(await post<Credentials>(`${path}/${encodeURIComponent(account.username)}/password`, {})))}><KeyRound size={14} /> New password</button>
      <button className="btn small" disabled={busy} onClick={() => setRevoking(account.username)}><Unlink size={14} /> Revoke</button>
    </div>)}
    <ErrorNote error={failure ?? error} />
    {adding && <Modal title="Add database connection account" onClose={() => setAdding(false)} footer={<><button className="btn" onClick={() => setAdding(false)}>Cancel</button><button className="btn primary" disabled={busy || !username.trim()} onClick={() => void act(async () => {
      setCredentials(await post<Credentials>(path, { username: username.trim(), password: password || undefined, mode }));
      setAdding(false); setUsername(""); setPassword("");
    })}>Create account</button></>}>
      <label className="field">Username<input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" /></label>
      <label className="field">Password<input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" placeholder="Leave blank to generate a strong password" /><small>Use at least 16 characters if you set your own.</small></label>
      <label className="field">Access<select className="select" value={mode} onChange={(e) => setMode(e.target.value as Account["mode"])}><option value="read-only">Read only</option><option value="read-write">Read/write</option></select></label>
      <ErrorNote error={failure} />
    </Modal>}
    {credentials && <Modal title="Database connection details" onClose={() => setCredentials(null)} footer={<><button className="btn" onClick={() => setCredentials(null)}>Close</button><button className="btn primary" onClick={() => void navigator.clipboard.writeText(details)}><Copy size={14} /> Copy details</button></>}>
      <p>Save this password now. Connect through the private network and use the PostgreSQL ODBC driver on the user's computer.</p><pre className="recovery-key">{details}</pre>
    </Modal>}
    {revoking && <Modal title="Revoke database access" onClose={() => setRevoking(null)} footer={<><button className="btn" onClick={() => setRevoking(null)}>Cancel</button><button className="btn primary" disabled={busy} onClick={() => void act(async () => { await del(`${path}/${encodeURIComponent(revoking)}`); setRevoking(null); })}>Revoke access</button></>}>
      <p>Revoke <strong>{revoking}</strong>? Its active database connections will close. Database contents and other accounts are preserved.</p><ErrorNote error={failure} />
    </Modal>}
  </div>;
}
