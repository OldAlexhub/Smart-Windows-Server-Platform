import { useCallback, useEffect, useRef, useState } from "react";
import { GitBranch, RefreshCw } from "lucide-react";
import { Link } from "react-router";
import { post } from "../lib/api";
import { useApi } from "../lib/hooks";
import type { GitHubAccount } from "../lib/github";
import { ErrorNote, Spinner } from "./ui";

interface Repository { repository: string; branch: string; private: boolean }
interface Props { selected: string; disabled?: boolean; onSelect: (repository: Repository) => void; onConnected: (connected: boolean) => void }

/** Shared by new application import and existing application source settings. No credentials enter the browser. */
export function GitHubRepositoryPicker({ selected, disabled, onSelect, onConnected }: Props) {
  const { data: account, error: accountError, loading: checkingAccount } = useApi<GitHubAccount>("/github/account", 10_000);
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const generation = useRef(0);
  const connectedCallback = useRef(onConnected); connectedCallback.current = onConnected;
  const connected = !!account?.connected;
  useEffect(() => { connectedCallback.current(connected); }, [connected]);
  const list = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true); setError(null); setRepositories([]);
    try {
      let page: number | null = 1;
      const all = new Map<string, Repository>();
      while (page !== null) {
        const result: { repositories: Repository[]; nextPage: number | null } = await post("/github/repositories", { page });
        if (current !== generation.current) return;
        for (const row of result.repositories) all.set(row.repository, row);
        setRepositories([...all.values()]);
        page = result.nextPage;
      }
    } catch (e) { if (current === generation.current) setError(e as Error); }
    finally { if (current === generation.current) setLoading(false); }
  }, []);
  useEffect(() => {
    // An unrelated pending sign-in must not block the already saved connection.
    if (connected) void list(); else { setRepositories([]); setLoading(false); }
    return () => { generation.current++; };
  }, [connected, account?.login, list]);
  const filtered = repositories.filter((repo) => repo.repository.toLowerCase().includes(search.toLowerCase()));
  return <div>
    <div className="row" style={{ flexWrap: "wrap" }}>
      <GitBranch size={18} />
      <strong>{connected ? `Repositories from ${account.login}` : "Your GitHub repositories"}</strong>
      <span className="spacer" />
      {connected && <Link className="btn ghost small" to="/settings/github">GitHub settings</Link>}
    </div>
    {checkingAccount && <Spinner label="Loading your GitHub connection…" />}
    {!checkingAccount && !connected && !accountError && <div className="notice" style={{ marginTop: 16 }}>
      <p>Connect your GitHub account once in Settings. After that, your repositories will appear here for every new application.</p>
      <Link className="btn primary" to="/settings/github">Set up GitHub in Settings</Link>
    </div>}
    {connected && <>
      <div className="row" style={{ marginTop: 16 }}><label className="field" style={{ flex: 1 }}>Find a repository<input className="input" placeholder="Search your repositories" value={search} disabled={disabled} onChange={(e) => setSearch(e.target.value)} /></label><button className="btn ghost" title="Refresh repositories" aria-label="Refresh repositories" disabled={disabled || loading} onClick={() => void list()}><RefreshCw size={16} /></button></div>
      <label className="field">Your repositories<select className="select" value={selected} disabled={disabled} onChange={(e) => { const repo = repositories.find((row) => row.repository === e.target.value); if (repo) onSelect(repo); }}>
        <option value="">Choose a repository</option>
        {selected && !filtered.some((repo) => repo.repository === selected) && <option value={selected}>{selected}</option>}
        {filtered.map((repo) => <option key={repo.repository} value={repo.repository}>{repo.repository}{repo.private ? " (private)" : ""}</option>)}
      </select><span className="hint">{loading ? `Loading repositories… ${repositories.length} found` : `${repositories.length} repositories available`}</span></label>
      {!loading && !repositories.length && <p className="small muted">No repositories are available. Check that you approved the correct GitHub account and any organization access, then refresh.</p>}
      <p className="small muted">Using the GitHub account saved in Settings. Organization repositories appear when your organization permits access.</p>
    </>}
    <ErrorNote error={error ?? accountError} />
  </div>;
}
