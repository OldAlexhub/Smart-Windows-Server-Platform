import { useState } from "react";
import { Link } from "react-router";
import { ExternalLink, GitBranch } from "lucide-react";
import { del, post } from "../lib/api";
import { useApi } from "../lib/hooks";
import type { GitHubAccount } from "../lib/github";
import { Card, ErrorNote, Spinner, Status } from "./ui";

/** Account authorization lives in Settings; application screens only select a repository. */
export function GitHubAccountSettings({ canCreateApps }: { canCreateApps: boolean }) {
  const { data: account, error: accountError, loading, reload } = useApi<GitHubAccount>("/github/account", 2000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  async function act(action: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await action(); await reload(); } catch (e) { setError(e as Error); } finally { setBusy(false); }
  }
  const pending = account?.pending;
  const waiting = pending && pending.status !== "failed";
  return <Card title="GitHub account" sub="Connect once here, then choose a repository whenever you add an application.">
    {loading ? <Spinner label="Checking your GitHub connection…" /> : <>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <GitBranch size={20} />
        <strong>{account?.connected ? `Connected as ${account.login}` : "GitHub is not connected"}</strong>
        <span className="spacer" />
        {account?.connected ? <Status tone="good">Connected</Status> : !waiting && <button className="btn primary" disabled={busy || !!accountError} onClick={() => void act(() => post("/github/account/login"))}>Connect GitHub</button>}
      </div>
      <p className="secondary" style={{ marginTop: 16 }}>Your connection is saved securely for your Nexus account and stays connected after you close Nexus or restart the server. Creating another application or updating your code uses this saved connection.</p>
      {waiting && <div className="notice" role="status" style={{ marginTop: 16 }}>
        {pending.userCode ? <>
          <p>Enter this one-time code on GitHub: <strong><code style={{ fontSize: 22, userSelect: "all" }}>{pending.userCode}</code></strong></p>
          <a className="btn primary" href="https://github.com/login/device" target="_blank" rel="noopener noreferrer" onClick={() => { void navigator.clipboard?.writeText(pending.userCode!).catch(() => {}); }}>Copy code &amp; open GitHub <ExternalLink size={15} /></a>
          <p className="small muted">Approve the GitHub CLI sign-in in your browser, then return here. Nexus will save the connection for future applications.</p>
        </> : <Spinner label="Preparing GitHub sign-in…" />}
        <button className="btn ghost" disabled={busy} onClick={() => void act(() => del("/github/account/login"))}>Cancel sign-in</button>
      </div>}
      {account?.connected && <>
        {canCreateApps && <div style={{ marginTop: 16 }}><Link className="btn primary" to="/apps/new?source=github">Choose a repository for a new application</Link></div>}
        <details style={{ marginTop: 20 }}>
          <summary>Manage GitHub connection</summary>
          <p className="small muted" style={{ margin: "12px 0" }}>Use these options to change accounts or renew access if GitHub authorization stops working. Disconnecting here leaves existing application connections in place; manage each repository in the application's Updates panel.</p>
          <div className="row" style={{ flexWrap: "wrap" }}>
            {!waiting && <button className="btn" disabled={busy} onClick={() => void act(() => post("/github/account/login"))}>Sign in again or change account</button>}
            <button className="btn ghost" disabled={busy} onClick={() => void act(() => del("/github/account"))}>Disconnect GitHub account</button>
          </div>
        </details>
      </>}
    </>}
    <ErrorNote error={error ?? accountError ?? (pending?.error ? { message: pending.error } : null)} />
  </Card>;
}
