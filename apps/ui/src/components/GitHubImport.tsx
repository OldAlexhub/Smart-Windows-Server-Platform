import { useEffect, useRef, useState } from "react";
import { ArrowRight, RefreshCw } from "lucide-react";
import { ApiError, del, post } from "../lib/api";
import { Card, ErrorNote, Spinner } from "./ui";
import type { AnalysisResult } from "../pages/AddApplication";
import { GitHubRepositoryPicker } from "./GitHubRepositoryPicker";

export interface ImportedProject { importId: string; sourceDir: string; repository: string; branch: string; analysis: AnalysisResult }

export function GitHubImport({ onAnalyzed }: { onAnalyzed: (project: ImportedProject) => void }) {
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [connected, setConnected] = useState(false);
  const [repository, setRepository] = useState("");
  const [branch, setBranch] = useState("main");
  const [enabled, setEnabled] = useState(true);
  const [intervalMinutes, setIntervalMinutes] = useState(2);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  async function act(name: string, action: () => Promise<void>) {
    setBusy(name); setError(null);
    try { await action(); } catch (e) { setError(e as ApiError); } finally { setBusy(null); }
  }

  return <>
    <div className="wizard-head"><h1>Choose your GitHub repository</h1><p>Nexus reads your project directly from GitHub. Push new code to your chosen branch and Nexus can deploy it automatically.</p></div>
    <Card>
      <GitHubRepositoryPicker selected={repository} disabled={!!busy} onConnected={setConnected} onSelect={(item) => { setRepository(item.repository); setBranch(item.branch); }} />
      <label className="field">Branch<input className="input" value={branch} disabled={!!busy} onChange={(e) => setBranch(e.target.value)} placeholder="main" /></label>
      <label className="toggle-row"><input type="checkbox" checked={enabled} disabled={!!busy} onChange={(e) => setEnabled(e.target.checked)} /><span><strong><RefreshCw size={14} /> Automatically deploy new pushes</strong><small>Nexus checks this branch while the app is running and deploys its latest commit. You can pause updates in the application's Updates panel.</small></span></label>
      <label className="field">Check every (minutes)<input className="input" type="number" min={1} max={1440} value={intervalMinutes} disabled={!!busy} onChange={(e) => setIntervalMinutes(Number(e.target.value))} /></label>
      <p className="small muted">You will review the application, database and access settings before it goes live. Git submodules and Git LFS objects are not fetched separately.</p>
      <ErrorNote error={error} />
      <div className="wizard-actions"><span className="spacer" /><button className="btn primary large" disabled={!!busy || !connected || !repository.trim() || !branch.trim()} onClick={() => void act("import", async () => { const project = await post<ImportedProject>("/github/imports", { repository, branch, enabled, intervalMinutes }); if (mounted.current) onAnalyzed(project); else await del(`/github/imports/${project.importId}`); })}>{busy === "import" ? <Spinner label="Reading repository…" /> : <>Read Repository <ArrowRight size={17} /></>}</button></div>
    </Card>
  </>;
}
