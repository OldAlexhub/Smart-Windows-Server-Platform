import { Code2, Copy, Eye, KeyRound, Link2, Network, Unlink } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { ApiError, del, get, post } from "../lib/api";
import { useApi } from "../lib/hooks";
import { Card, ErrorNote, Spinner } from "./ui";
import { DatabaseAccounts } from "./DatabaseAccounts";

interface LinkState {
  available: boolean;
  blocker: string | null;
  enabled: boolean;
  host: string | null;
  port: number | null;
  database: string | null;
  user: string | null;
  url: string | null;
}

/**
 * "Connect from another server": the database is reachable from Nexus's private network only
 * (WireGuard) — never from the internet — with its own login for this one database.
 */
export function DatabaseLink({ kind, databaseId, canManage }: { kind: "tables" | "documents"; databaseId: string; canManage: boolean }) {
  const path = `/database-links/${kind}/${databaseId}`;
  const { data, error, reload } = useApi<LinkState>(path);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [copied, setCopied] = useState<"url" | "code" | null>(null);
  const [language, setLanguage] = useState<"python" | "r">("python");

  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setErr(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(null);
    }
  }
  const copy = async (text: string, target: "url" | "code") => {
    await navigator.clipboard.writeText(text);
    setCopied(target);
    setTimeout(() => setCopied(null), 2500);
  };

  if (!data) return error ? <ErrorNote error={error} /> : null;
  const url = revealed ?? data.url;
  const variable = kind === "tables" ? "DATABASE_URL" : "MONGO_URL";
  const examples = kind === "tables" ? {
    python: `# pip install "psycopg[binary]"\nimport os\nimport psycopg\n\nwith psycopg.connect(os.environ["DATABASE_URL"]) as connection:\n    with connection.cursor() as cursor:\n        cursor.execute("SELECT * FROM your_table LIMIT 10")\n        print(cursor.fetchall())`,
    r: `# install.packages(c("DBI", "RPostgres"))\nlibrary(DBI)\nlibrary(RPostgres)\n\nconnection <- dbConnect(\n  RPostgres::Postgres(),\n  dbname = Sys.getenv("DATABASE_URL")\n)\ndbGetQuery(connection, "SELECT * FROM your_table LIMIT 10")`,
  } : {
    python: `# pip install pymongo\nimport os\nfrom pymongo import MongoClient\n\nclient = MongoClient(os.environ["MONGO_URL"])\ndatabase = client.get_default_database()\nprint(list(database.your_collection.find().limit(10)))`,
    r: `# install.packages("mongolite")\nlibrary(mongolite)\n\ncollection <- mongo(\n  collection = "your_collection",\n  url = Sys.getenv("MONGO_URL")\n)\ncollection$find(limit = 10)`,
  };

  return (
    <Card title="Connect with Python, R, or another server" sub="Create a secure database link for code running on a computer in your private network. It is never exposed to the internet.">
      {!data.enabled && (
        <div className="db-link-off">
          <Network size={18} />
          <span>
            {data.blocker ? (
              <>
                <strong>Needs the private network</strong>
                <small className="muted">
                  {data.blocker} <Link to="/settings/network">Open External Access</Link>
                </small>
              </>
            ) : (
              <>
                <strong>Not shared</strong>
                <small className="muted">Nexus will create a separate login for this database and a link that works only inside your private network.</small>
              </>
            )}
          </span>
          {canManage && !data.blocker && (
            <button className="btn primary small" disabled={busy !== null} onClick={() => void act("on", async () => setRevealed((await post<LinkState>(path)).url))}>
              {busy === "on" ? <Spinner label="Sharing…" /> : <><Link2 size={14} /> Share</>}
            </button>
          )}
        </div>
      )}

      {data.enabled && url && (
        <div className="db-link-on">
          <div className="db-link-url">
            <code>{url}</code>
            {revealed ? (
              <button className="btn small" onClick={() => void copy(revealed, "url")}><Copy size={14} /> {copied === "url" ? "Copied" : "Copy link"}</button>
            ) : canManage ? (
              <button className="btn small" disabled={busy !== null} onClick={() => void act("reveal", async () => setRevealed((await get<LinkState>(`${path}?reveal=1`)).url))}><Eye size={14} /> Show & copy</button>
            ) : null}
          </div>
          <div className="db-link-parts small">
            <span><span className="muted">Host</span> <code>{data.host}</code></span>
            <span><span className="muted">Port</span> <code>{data.port}</code></span>
            <span><span className="muted">Database</span> <code>{data.database}</code></span>
            <span><span className="muted">User</span> <code>{data.user}</code></span>
          </div>
          <ol className="small db-link-steps">
            <li>On the other server, install <strong>WireGuard</strong> and add it as a device: <Link to="/settings/network">Settings → External Access → Private network → Add device</Link> (use <strong>Download file for a laptop</strong>).</li>
            <li>Switch the tunnel on there, then use the link above as that server's database address (for example its <code>{kind === "tables" ? "DATABASE_URL" : "MONGO_URL"}</code>).</li>
          </ol>
          {data.blocker && <div className="notice warn small">{data.blocker}</div>}
          {canManage && (
            <div className="row">
              <button className="btn small" disabled={busy !== null} onClick={() => void act("rotate", async () => setRevealed((await post<LinkState>(`${path}/rotate`)).url))}><KeyRound size={14} /> New password</button>
              <span className="spacer" />
              <button className="btn small danger" disabled={busy !== null} onClick={() => confirm("Stop sharing this database? Other servers using the link will be disconnected.") && void act("off", async () => { await del(path); setRevealed(null); })}><Unlink size={14} /> Stop sharing</button>
            </div>
          )}
        </div>
      )}
      <div className="db-code-guide">
        <div className="db-code-head">
          <span className="db-code-icon" aria-hidden><Code2 size={17} /></span>
          <span><strong>Use this database in code</strong><small>{data.enabled ? <>Copy the connection link above into a <code>{variable}</code> environment variable, then use one of these examples.</> : <>After creating the secure link, save it as <code>{variable}</code> and use one of these examples.</>}</small></span>
        </div>
        <div className="db-code-tabs" role="tablist" aria-label="Connection example language">
          <button role="tab" aria-selected={language === "python"} className={language === "python" ? "active" : ""} onClick={() => setLanguage("python")}>Python</button>
          <button role="tab" aria-selected={language === "r"} className={language === "r" ? "active" : ""} onClick={() => setLanguage("r")}>R</button>
        </div>
        <div className="db-code-block">
          <pre><code>{examples[language]}</code></pre>
          <button className="btn small" onClick={() => void copy(examples[language], "code")}><Copy size={14} /> {copied === "code" ? "Copied" : "Copy code"}</button>
        </div>
      </div>
      {kind === "tables" && canManage && data.enabled && data.host && data.port && data.database && <DatabaseAccounts databaseId={databaseId} host={data.host} port={data.port} database={data.database} />}
      <ErrorNote error={err} />
    </Card>
  );
}
