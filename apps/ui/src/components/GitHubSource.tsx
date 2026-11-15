import { useState } from "react";
import { GitBranch } from "lucide-react";
import { ApiError, del, post, put } from "../lib/api";
import { useApi } from "../lib/hooks";
import { ErrorNote, Modal } from "./ui";
import { GitHubRepositoryPicker } from "./GitHubRepositoryPicker";

interface Source { repository: string; branch: string; enabled: boolean; intervalMinutes: number; checkedAt: string | null; attempted: string | null; error: string | null; localSource: string }
export function GitHubSource({ appId, onJob, onChange }: { appId: string; onJob: (id: string) => void; onChange: () => void }) {
  const path = `/apps/${appId}/github`;
  const { data, error, reload } = useApi<Source | null>(path, 10_000);
  const [open, setOpen] = useState(false);
  const [repository, setRepository] = useState("");
  const [branch, setBranch] = useState("main");
  const [connected, setConnected] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [interval, setIntervalMinutes] = useState(2);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);
  async function act(action: () => Promise<void>) {
    setBusy(true); setFailure(null);
    try { await action(); await reload(); onChange(); } catch (e) { setFailure(e as ApiError); } finally { setBusy(false); }
  }
  return <div className="delivery-key">
    <span><GitBranch size={17} /><span><strong>GitHub</strong><small>{data ? `${data.repository} · ${data.branch} · ${data.enabled ? `Checks every ${data.intervalMinutes} minute(s)` : "Automatic updates paused"}` : "Optional: pull a project from GitHub and deploy new pushes automatically. Local folders and ZIP uploads stay available."}</small>
      {data?.checkedAt && <small>Last checked: {new Date(data.checkedAt).toLocaleString()}{data.attempted ? ` · Last attempted commit ${data.attempted.slice(0, 7)}` : ""}</small>}
      {data?.error && <small className="warn-text">{data.error}</small>}
    </span></span>
    <span className="row"><button className="btn small" disabled={busy} onClick={() => { setRepository(data?.repository ?? ""); setBranch(data?.branch ?? "main"); setEnabled(data?.enabled ?? true); setIntervalMinutes(data?.intervalMinutes ?? 2); setConnected(false); setOpen(true); }}>{data ? "Repository settings" : "Choose GitHub repository"}</button>
      {data && <><button className="btn small" disabled={busy} onClick={() => void act(async () => { const r = await post<{ jobId: string | null }>(`${path}/check`); if (r.jobId) onJob(r.jobId); })}>Deploy Branch Now</button><button className="btn ghost small" disabled={busy} onClick={() => void act(async () => { await del(path); })}>Disconnect</button></>}
    </span><ErrorNote error={failure ?? error} />
    {open && <Modal title="Choose GitHub repository" onClose={() => setOpen(false)} footer={<><button className="btn" onClick={() => setOpen(false)}>Cancel</button><button className="btn primary" disabled={busy || !repository || !branch || (!connected && (!data || repository !== data.repository))} onClick={() => void act(async () => { await put(path, { repository, branch, useAccount: connected, enabled, intervalMinutes: interval }); setOpen(false); })}>Save connection</button></>}>
      <GitHubRepositoryPicker selected={repository} disabled={busy} onConnected={setConnected} onSelect={(item) => { setRepository(item.repository); setBranch(item.branch); }} />
      {!connected && data && <p className="small muted">Current repository: {data.repository}. Its saved connection still supports branch and update settings. Connect your account in Settings → GitHub to choose another repository.</p>}
      <label className="field">Branch<input className="input" value={branch} onChange={(e) => setBranch(e.target.value)} /></label>
      <label className="toggle-row"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /><span><strong>Automatically deploy updates</strong><small>Deploys the latest branch commit on the next check while this app is running, then follows new pushes. Several pushes between checks deploy as one latest version. Failed versions wait for a new commit or a manual retry.</small></span></label>
      <label className="field">Check every (minutes)<input className="input" type="number" min={1} max={1440} value={interval} onChange={(e) => setIntervalMinutes(Number(e.target.value))} /></label>
      <p className="small muted">Your original local folder stays on disk. Disconnecting selects it again when available; the current running version stays up until you deploy. Local folder watching and GitHub automatic updates run one at a time. Git submodules and Git LFS files are not fetched separately.</p>
      <ErrorNote error={failure} />
    </Modal>}
  </div>;
}
