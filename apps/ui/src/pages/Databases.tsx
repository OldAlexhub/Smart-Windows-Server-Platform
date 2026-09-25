import { ArrowRight, Braces, Database, FileJson, Plus, ShieldCheck, Table2 } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { formatBytes } from "@nexus/shared/format";
import type { DatabaseSummary } from "@nexus/shared/contracts";
import { PageHead } from "../components/Layout";
import { Empty, ErrorNote, Modal, Spinner, StatusOf } from "../components/ui";
import { ApiError, post } from "../lib/api";
import { useApi } from "../lib/hooks";

type Kind = "postgresql" | "mongodb";

/** Where a database opens: tables for PostgreSQL, collections for document databases. */
export const databasePath = (db: Pick<DatabaseSummary, "id" | "engine">) => (db.engine === "mongodb" ? `/documents/${db.id}` : `/databases/${db.id}`);

function DatabaseCard({ db }: { db: DatabaseSummary }) {
  const documents = db.engine === "mongodb";
  return (
    <Link className="card database-card" to={databasePath(db)}>
      <div className="database-card-head">
        <span className={`database-icon ${documents ? "documents" : ""}`}>{documents ? <Braces size={20} /> : <Database size={21} />}</span>
        <StatusOf status={db.status} />
      </div>
      <h2>{db.name}</h2>
      <p className="small muted">
        <span className="engine-label">{documents ? "Documents · MongoDB-compatible" : "Tables · PostgreSQL"}</span> <span className="mono">{db.dbName}</span>
      </p>
      <div className="database-stats">
        <span>{documents ? <FileJson size={15} /> : <Table2 size={15} />}<strong>{db.tableCount}</strong><small>{documents ? "Collections" : "Tables"}</small></span>
        <span><Database size={15} /><strong>{formatBytes(db.sizeBytes)}</strong><small>Size</small></span>
        <span><ShieldCheck size={15} /><strong>{db.protected ? "Yes" : "No"}</strong><small>Protected</small></span>
      </div>
      <div className="row small">
        <span className="muted">
          {documents ? `${(db.documentCount ?? 0).toLocaleString()} ${db.documentCount === 1 ? "document" : "documents"}` : `${db.connectionCount} active ${db.connectionCount === 1 ? "connection" : "connections"}`}
        </span>
        <span className="spacer" /> Browse <ArrowRight size={14} />
      </div>
    </Link>
  );
}

export function Databases({ canCreate }: { canCreate: boolean }) {
  const navigate = useNavigate();
  const { data, error, loading } = useApi<DatabaseSummary[]>("/databases", 15_000);
  const { data: engine } = useApi<{ available: boolean }>(canCreate ? "/documents/engine" : null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Kind>("postgresql");
  const [busy, setBusy] = useState(false);
  const [createError, setCreateError] = useState<ApiError | null>(null);
  async function create() {
    setBusy(true);
    try {
      const db = await post<DatabaseSummary>(kind === "mongodb" ? "/documents" : "/databases", { name: name.trim() });
      navigate(databasePath(db));
    } catch (e) {
      setCreateError(e as ApiError);
    } finally {
      setBusy(false);
    }
  }
  const open = () => { setKind("postgresql"); setCreateError(null); setCreating(true); };
  return (
    <>
      <PageHead title="Databases" sub="Databases managed and protected by Nexus." actions={canCreate && <button className="btn primary" onClick={open}><Plus size={17} /> Create Database</button>} />
      {loading && !data ? <div className="center-panel"><Spinner label="Loading databases…" /></div> : error && !data ? <ErrorNote error={error} /> : !data?.length ? (
        <Empty icon={<Database size={34} />} title="No databases yet" action={canCreate && <button className="btn primary" onClick={open}>Create Database</button>}>Applications get an isolated database automatically during deployment.</Empty>
      ) : <div className="database-grid">{data.map((db) => <DatabaseCard db={db} key={db.id} />)}</div>}
      {creating && (
        <Modal
          title="Create Database"
          onClose={() => setCreating(false)}
          footer={<><button className="btn" onClick={() => setCreating(false)}>Cancel</button><button className="btn primary" disabled={!name.trim() || busy} onClick={() => void create()}>{busy ? <Spinner label="Creating…" /> : "Create Database"}</button></>}
        >
          <p className="secondary">Enter a friendly name. Nexus creates secure credentials and handles the technical setup.</p>
          <label className="field" style={{ marginTop: 14 }}>Database name<input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={80} placeholder="Customer Records" /></label>
          {engine?.available && (
            <div className="choice-stack" style={{ marginTop: 14 }} role="radiogroup" aria-label="Kind of database">
              <button type="button" role="radio" aria-checked={kind === "postgresql"} className={`choice wizard-choice ${kind === "postgresql" ? "selected" : ""}`} onClick={() => setKind("postgresql")}>
                <span className="radio-dot">{kind === "postgresql" && <span />}</span>
                <span className="choice-copy"><span className="title">Tables (recommended)</span><span className="desc">Rows and columns, like a spreadsheet. PostgreSQL — works with most applications.</span></span>
              </button>
              <button type="button" role="radio" aria-checked={kind === "mongodb"} className={`choice wizard-choice ${kind === "mongodb" ? "selected" : ""}`} onClick={() => setKind("mongodb")}>
                <span className="radio-dot">{kind === "mongodb" && <span />}</span>
                <span className="choice-copy"><span className="title">Documents</span><span className="desc">Flexible JSON-like records, MongoDB-compatible — for apps built with Mongoose, PyMongo or the MongoDB driver.</span></span>
              </button>
            </div>
          )}
          <ErrorNote error={createError} />
        </Modal>
      )}
    </>
  );
}
