import { Check, Copy, FolderOpen, KeyRound, Laptop, PackageOpen, RefreshCw, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { ApiError, del, post, put } from "../lib/api";
import { useApi } from "../lib/hooks";
import { Card, ErrorNote, Modal, Spinner } from "./ui";

interface Delivery {
  source: { dir: string; uploaded: boolean; exists: boolean };
  autoDeploy: boolean;
  deployKey: { enabled: boolean; createdAt: string | null; url: string };
  pendingChanges: number;
  updating: string | null;
}

/** Commands for pushing a new version from another computer with a deploy key. */
function commands(base: string, url: string, key: string) {
  const endpoint = `${base}${url}`;
  return {
    powershell: [
      "# Run in your project folder. Dependencies (node_modules, .venv) are left out: Nexus installs them.",
      "tar -a -c -f ..\\app.zip --exclude=node_modules --exclude=.venv --exclude=.git .",
      `Invoke-RestMethod -Method Post -Uri "${endpoint}" -Headers @{ Authorization = "Bearer ${key}" } -ContentType "application/zip" -InFile ..\\app.zip`,
    ].join("\n"),
    curl: [
      "tar -a -c -f ../app.zip --exclude=node_modules --exclude=.venv --exclude=.git .",
      `curl -X POST "${endpoint}" -H "Authorization: Bearer ${key}" -H "Content-Type: application/zip" --data-binary @../app.zip`,
    ].join("\n"),
    folder: `Invoke-RestMethod -Method Post -Uri "${endpoint}" -Headers @{ Authorization = "Bearer ${key}" }`,
  };
}

function CopyBlock({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="command-block">
      <div className="command-head"><strong>{label}</strong><button className="btn ghost small" onClick={() => void navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>{copied ? <Check size={14} /> : <Copy size={14} />} {copied ? "Copied" : "Copy"}</button></div>
      <pre className="mono">{text}</pre>
    </div>
  );
}

/**
 * How new versions reach an app: every update switches over without downtime, and can come from
 * a zip upload, automatically from the app's folder, or from another computer with a deploy key.
 */
export function DeliveryCard({ appId, onJob }: { appId: string; onJob: (jobId: string) => void }) {
  const { data, error, reload } = useApi<Delivery>(`/apps/${appId}/delivery`, 10_000);
  const { data: network } = useApi<{ controlCenterUrl?: string | null }>("/network/private", 60_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [newKey, setNewKey] = useState<{ key: string; url: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function act(name: string, fn: () => Promise<void>) {
    setBusy(name);
    try {
      await fn();
      setActionError(null);
      await reload();
    } catch (e) {
      setActionError(e as ApiError);
    } finally {
      setBusy(null);
    }
  }
  const upload = (file: File) => act("upload", async () => {
    const form = new FormData();
    form.append("file", file, file.name);
    const r = await post<{ jobId: string }>(`/apps/${appId}/upload`, form);
    onJob(r.jobId);
  });

  if (!data) return error ? <ErrorNote error={error} /> : null;
  const base = network?.controlCenterUrl ?? location.origin;
  const cmd = newKey ? commands(base, newKey.url, newKey.key) : null;

  return (
    <Card title="Updates" sub="New versions go live without taking your app offline">
      <ol className="delivery-steps">
        <li><strong>The new version starts</strong><span>next to the one that's running</span></li>
        <li><strong>Visitors switch over</strong><span>once it answers, so nobody is cut off</span></li>
        <li><strong>If it fails, nothing changes</strong><span>the current version keeps running</span></li>
      </ol>

      <div className="delivery-source">
        {data.source.uploaded ? <PackageOpen size={18} /> : <FolderOpen size={18} />}
        <span>
          <small>{data.source.uploaded ? "Code comes from the last uploaded zip" : "Code comes from this folder"}</small>
          <code>{data.source.dir}</code>
          {!data.source.exists && <small className="warn-text">This folder can't be found. Upload a new version, or put the folder back.</small>}
          {data.pendingChanges > 0 && !data.updating && <small className="accent-text">{data.pendingChanges} file{data.pendingChanges === 1 ? "" : "s"} changed since the last deploy. Press <strong>Deploy Latest</strong> to put them live.</small>}
          {data.updating && <small className="accent-text">Updating now…</small>}
        </span>
      </div>

      <div className="delivery-actions">
        <input ref={fileRef} type="file" accept=".zip,application/zip" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(f); }} />
        <button className="btn" disabled={!!busy || !!data.updating} onClick={() => fileRef.current?.click()}>{busy === "upload" ? <Spinner label="Uploading…" /> : <><Upload size={15} /> Upload New Version (.zip)</>}</button>
        <span className="small muted">Zip your project folder without <code>node_modules</code> or <code>.venv</code>. Nexus installs what's in package.json / requirements.txt.</span>
      </div>

      {!data.source.uploaded ? (
        <label className="toggle-row">
          <input type="checkbox" checked={data.autoDeploy} disabled={!!busy} onChange={(e) => void act("auto", async () => { await put(`/apps/${appId}/auto-deploy`, { enabled: e.target.checked }); })} />
          <span><strong><RefreshCw size={14} /> Update automatically when files in this folder change</strong><small>Save your code or run <code>git pull</code> in the folder and it goes live on its own. Nexus waits until the files have stopped changing for 20 seconds, and never retries a version that failed until you change the files again.</small></span>
        </label>
      ) : (
        <p className="small muted">Automatic updates follow a folder on this computer. This app's code now comes from uploads, so use <strong>Upload New Version</strong> or a deploy key.</p>
      )}

      <div className="delivery-key">
        <span><KeyRound size={17} /><span><strong>Deploy key</strong><small>{data.deployKey.enabled ? `Active since ${new Date(data.deployKey.createdAt!).toLocaleString()}. Another computer can push new versions of this app.` : "Push new versions from your laptop or a build script (from this computer, or over your private network)."}</small></span></span>
        <span className="row">
          <button className="btn small" disabled={!!busy} onClick={() => void act("key", async () => setNewKey(await post<{ key: string; url: string }>(`/apps/${appId}/deploy-key`)))}>{data.deployKey.enabled ? "New Key" : "Create Deploy Key"}</button>
          {data.deployKey.enabled && <button className="btn ghost small danger" disabled={!!busy} onClick={() => void act("revoke", async () => { await del(`/apps/${appId}/deploy-key`); })}>Turn Off</button>}
        </span>
      </div>
      <ErrorNote error={actionError} />

      {newKey && cmd && (
        <Modal wide title="Your deploy key" onClose={() => setNewKey(null)} footer={<button className="btn primary" onClick={() => setNewKey(null)}>Done</button>}>
          <p className="secondary">This key is shown <strong>only once</strong>. Anyone who has it can update this app, so keep it like a password. Any older key has stopped working.</p>
          <CopyBlock label="Key" text={newKey.key} />
          <p className="small secondary" style={{ marginTop: 14 }}><Laptop size={14} /> {network?.controlCenterUrl ? "From your laptop with the private network (WireGuard) on:" : "From this computer (turn on the private network in Settings to use it from your laptop):"}</p>
          <CopyBlock label="Send a new version (PowerShell)" text={cmd.powershell} />
          <CopyBlock label="Same with curl (Mac, Linux, Git Bash)" text={cmd.curl} />
          <CopyBlock label="Redeploy the app's folder on the server (no zip)" text={cmd.folder} />
          <p className="small muted" style={{ marginTop: 10 }}>The answer includes a <code>follow</code> address: open it with the same key to see the update's progress. Deploy keys aren't accepted straight from the internet.</p>
        </Modal>
      )}
    </Card>
  );
}
