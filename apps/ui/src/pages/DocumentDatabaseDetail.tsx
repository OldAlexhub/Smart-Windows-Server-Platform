import { ArrowLeft, Braces, ChevronLeft, ChevronRight, Download, FileJson, Filter, Pencil, Plus, Search, Trash2, Upload, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { formatBytes } from "@nexus/shared/format";
import type { DatabaseSummary } from "@nexus/shared/contracts";
import type { Me } from "../App";
import { PageHead } from "../components/Layout";
import { DeleteDatabase } from "../components/DeleteDatabase";
import { DatabaseLink } from "../components/DatabaseLink";
import { ConfirmByName, ErrorNote, Modal, Spinner, StatusOf } from "../components/ui";
import { ApiError, del, post, put } from "../lib/api";
import { useApi } from "../lib/hooks";
import { canWrite } from "./DatabaseDetail";

interface CollectionSummary { name: string; documents: number; sizeBytes: number; indexes: number }
type Doc = Record<string, unknown> & { _id?: unknown };
interface DocumentPage { documents: Doc[]; total: number; skip: number; limit: number }

const PAGE = 20;
const FILTER_EXAMPLES = ['{"status": "open"}', '{"total": {"$gt": 100}}', '{"name": {"$regex": "^Ada", "$options": "i"}}'];

/** Short label for a document's id: ObjectIds show their hex value, other ids as written. */
function idLabel(id: unknown): string {
  if (id && typeof id === "object" && "$oid" in id) return String((id as { $oid: string }).$oid);
  return typeof id === "string" ? id : JSON.stringify(id);
}

/** Top-level fields as "name: value" pairs for the collapsed card view. */
function preview(doc: Doc): [string, string][] {
  return Object.entries(doc)
    .filter(([k]) => k !== "_id")
    .slice(0, 6)
    .map(([k, v]) => {
      let s: string;
      if (v && typeof v === "object" && "$date" in v) s = new Date(String((v as { $date: string }).$date)).toLocaleString();
      else if (v && typeof v === "object" && "$oid" in v) s = String((v as { $oid: string }).$oid);
      else s = typeof v === "string" ? v : JSON.stringify(v);
      return [k, s.length > 80 ? `${s.slice(0, 80)}…` : s];
    });
}

function JsonEditor({ title, initial, saveLabel, onSave, onClose }: { title: string; initial: string; saveLabel: string; onSave: (text: string) => Promise<void>; onClose: () => void }) {
  const [text, setText] = useState(initial);
  const [error, setError] = useState<ApiError | null>(null);
  const [saving, setSaving] = useState(false);
  let parseError: string | null = null;
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) parseError = "A document must be a JSON object: { … }";
  } catch (e) {
    parseError = (e as Error).message.replace(/^JSON\.parse: /, "");
  }
  async function save() {
    setSaving(true);
    try { await onSave(text); onClose(); } catch (e) { setError(e as ApiError); } finally { setSaving(false); }
  }
  return (
    <Modal wide title={title} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!!parseError || saving} onClick={() => void save()}>{saving ? <Spinner label="Saving…" /> : saveLabel}</button></>}>
      <p className="small secondary">Edit the document as JSON. Special types use Extended JSON, for example <span className="mono">{'{"$date": "2025-01-31T09:00:00Z"}'}</span>.</p>
      <textarea className="input mono json-editor" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} autoFocus aria-label="Document JSON" aria-invalid={!!parseError} />
      <p className={`small ${parseError ? "json-invalid" : "muted"}`} role="status">{parseError ? `Not valid JSON yet: ${parseError}` : "Valid JSON"}</p>
      <ErrorNote error={error} />
    </Modal>
  );
}

function ImportDialog({ collection, endpoint, onDone, onClose }: { collection: string; endpoint: string; onDone: () => void; onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ inserted: number; skipped: number; errors: string[] } | null>(null);
  async function run() {
    if (!file) return;
    setBusy(true);
    try {
      const r = await post<{ inserted: number; skipped: number; errors: string[] }>(endpoint, { content: await file.text() });
      setResult(r);
      onDone();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={`Import into ${collection}`} onClose={onClose} footer={result ? <button className="btn primary" onClick={onClose}>Done</button> : <><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!file || busy} onClick={() => void run()}>{busy ? <Spinner label="Importing…" /> : "Import"}</button></>}>
      {result ? (
        <div>
          <p><strong>{result.inserted.toLocaleString()}</strong> {result.inserted === 1 ? "document" : "documents"} added.</p>
          {result.skipped > 0 && <p className="secondary">{result.skipped.toLocaleString()} already existed (same _id) and were left unchanged.</p>}
          {result.errors.length > 0 && <ul className="small secondary">{result.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
        </div>
      ) : (
        <>
          <p className="secondary">Choose a <strong>.json</strong> file: an array of documents (as exported by Nexus or mongoexport), or one document per line. Documents that already exist are skipped, so importing twice is safe.</p>
          <label className="field" style={{ marginTop: 14 }}>File<input className="input" type="file" accept=".json,.jsonl,.ndjson,application/json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
          <ErrorNote error={error} />
        </>
      )}
    </Modal>
  );
}

export function DocumentDatabaseDetail({ me }: { me: Me }) {
  const { id = "" } = useParams();
  const { data: database, error: dbError, loading: dbLoading, reload: reloadDb } = useApi<DatabaseSummary>(id ? `/documents/${id}` : null, 15_000);
  const { data: collections, error: colError, loading: colLoading, reload: reloadCollections } = useApi<CollectionSummary[]>(id ? `/documents/${id}/collections` : null, 15_000);
  const [selected, setSelected] = useState<string | null>(null);
  const [skip, setSkip] = useState(0);
  const [filterDraft, setFilterDraft] = useState("");
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Doc | "new" | null>(null);
  const [deleting, setDeleting] = useState<Doc | null>(null);
  const [importing, setImporting] = useState(false);
  const [newCollection, setNewCollection] = useState<string | null>(null);
  const [droppingCollection, setDroppingCollection] = useState(false);
  const [writeError, setWriteError] = useState<ApiError | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if ((!selected || !collections?.some((c) => c.name === selected)) && collections?.[0]) setSelected(collections[0].name); }, [collections, selected]);
  useEffect(() => { setSkip(0); setExpanded(new Set()); }, [selected, filter]);

  const base = selected ? `/documents/${id}/collections/${encodeURIComponent(selected)}` : null;
  const query = useMemo(() => {
    const q = new URLSearchParams({ skip: String(skip), limit: String(PAGE) });
    if (filter) q.set("filter", filter);
    return q.toString();
  }, [skip, filter]);
  const { data, error, loading, reload } = useApi<DocumentPage>(base ? `${base}?${query}` : null);
  const writable = database ? canWrite(me, database.ownerAppIds) : false;
  const exportUrl = base ? `/api/v1${base}/export.json${filter ? `?filter=${encodeURIComponent(filter)}` : ""}` : "#";
  const refresh = async () => { await Promise.all([reload(), reloadCollections(), reloadDb()]); };

  async function saveDocument(text: string) {
    if (!base) return;
    if (editing === "new") await post(`${base}/documents`, { document: text });
    else if (editing) await put(`${base}/documents`, { id: editing._id, document: text });
    setWriteError(null);
    await refresh();
  }
  async function removeDocument() {
    if (!base || !deleting) return;
    try { await del(`${base}/documents`, { id: deleting._id, confirmed: true }); setDeleting(null); setWriteError(null); await refresh(); }
    catch (e) { setWriteError(e as ApiError); setDeleting(null); }
  }
  async function createCollection() {
    if (!newCollection?.trim()) return;
    try { await post(`/documents/${id}/collections`, { name: newCollection.trim() }); setSelected(newCollection.trim()); setNewCollection(null); setWriteError(null); await reloadCollections(); }
    catch (e) { setWriteError(e as ApiError); setNewCollection(null); }
  }
  async function dropCollection() {
    if (!selected) return;
    try { await del(`/documents/${id}/collections/${encodeURIComponent(selected)}`, { confirmation: selected }); setSelected(null); setDroppingCollection(false); await refresh(); }
    catch (e) { setWriteError(e as ApiError); setDroppingCollection(false); }
  }

  if (dbLoading && !database) return <div className="center-panel"><Spinner label="Loading database…" /></div>;
  if (dbError && !database) return <ErrorNote error={dbError} />;
  if (!database) return null;
  const from = data && data.total ? data.skip + 1 : 0;
  const to = data ? Math.min(data.skip + data.limit, data.total) : 0;

  return (
    <>
      <div className="app-breadcrumb"><Link to="/databases"><ArrowLeft size={15} /> Databases</Link></div>
      <PageHead title={<span className="row"><span className="database-icon large documents"><Braces size={21} /></span>{database.name}<StatusOf status={database.status} /></span>} sub={<span><span className="engine-label">Documents · MongoDB-compatible</span> <span className="mono">{database.dbName}</span></span>} />
      <div className="grid database-summary">
        <div className="card"><span className="stat-label">Database Size</span><strong className="stat-value">{formatBytes(database.sizeBytes)}</strong></div>
        <div className="card"><span className="stat-label">Collections</span><strong className="stat-value">{database.tableCount}</strong></div>
        <div className="card"><span className="stat-label">Documents</span><strong className="stat-value">{(database.documentCount ?? 0).toLocaleString()}</strong></div>
        <div className="card"><span className="stat-label">Backup</span><strong className="stat-value small-value">{database.ownerAppIds.length ? (database.protected ? "Protected" : "Needs Attention") : "Not scheduled"}</strong><span className="small muted">{database.lastBackupAt ? `Last ${new Date(database.lastBackupAt).toLocaleString()}` : database.ownerAppIds.length ? "Backed up with its application" : "Backed up once an application uses it"}</span></div>
      </div>
      <div className="database-browser card">
        <aside className="table-sidebar">
          <div className="table-sidebar-head"><strong>Collections</strong>{writable ? <button className="btn ghost small" title="New collection" aria-label="New collection" onClick={() => setNewCollection("")}><Plus size={15} /></button> : <span className="small muted">{collections?.length ?? 0}</span>}</div>
          {colLoading && !collections ? <Spinner /> : colError ? <ErrorNote error={colError} /> : !collections?.length ? (
            <div className="database-empty"><FileJson size={28} /><span>No collections yet</span>{writable && <button className="btn small" onClick={() => setNewCollection("")}><Plus size={14} /> New Collection</button>}</div>
          ) : collections.map((c) => (
            <button className={`table-choice ${selected === c.name ? "active" : ""}`} key={c.name} onClick={() => setSelected(c.name)}>
              <FileJson size={16} /><span><strong>{c.name}</strong><small>{c.documents.toLocaleString()} {c.documents === 1 ? "document" : "documents"} · {formatBytes(c.sizeBytes)}</small></span>
            </button>
          ))}
        </aside>
        <section className="data-sheet">
          {!selected ? <div className="database-empty"><FileJson size={32} /><span>Create a collection to start adding documents.</span></div> : <>
            <div className="data-sheet-head">
              <div><h2>{selected}</h2>{data && <span className="small muted">{data.total.toLocaleString()} {data.total === 1 ? "document" : "documents"}{filter ? " match" : ""}</span>}</div>
              <div className="row">
                {writable && <button className="btn primary small" onClick={() => setEditing("new")}><Plus size={14} /> Add Document</button>}
                {writable && <button className="btn small" onClick={() => setImporting(true)}><Upload size={14} /> Import</button>}
                <a className="btn small" href={exportUrl}><Download size={14} /> Export JSON</a>
                {writable && <button className="btn ghost small danger" title="Delete collection" aria-label="Delete collection" onClick={() => setDroppingCollection(true)}><Trash2 size={14} /></button>}
              </div>
            </div>
            <form className="doc-filter" onSubmit={(e) => { e.preventDefault(); setFilter(filterDraft.trim()); }}>
              <span className="search-input"><Filter size={16} /><input ref={filterRef} className="input mono" value={filterDraft} onChange={(e) => setFilterDraft(e.target.value)} placeholder='Filter, e.g. {"status": "open"}' aria-label="Filter documents (JSON)" /></span>
              <button className="btn" type="submit"><Search size={14} /> Find</button>
              {filter && <button className="btn ghost" type="button" onClick={() => { setFilter(""); setFilterDraft(""); }}><X size={14} /> Clear</button>}
            </form>
            {!filter && <div className="filter-chips"><span className="small muted">Examples:</span>{FILTER_EXAMPLES.map((ex) => <button key={ex} className="mono" onClick={() => { setFilterDraft(ex); filterRef.current?.focus(); }}>{ex}</button>)}</div>}
            <ErrorNote error={writeError} />
            {loading && !data ? <div className="folder-loading"><Spinner label="Loading documents…" /></div> : error ? <ErrorNote error={error} /> : data && (
              <div className="doc-list">
                {data.documents.map((doc) => {
                  const key = idLabel(doc._id);
                  const open = expanded.has(key);
                  return (
                    <article className="doc-card" key={key}>
                      <header>
                        <button className="doc-toggle" aria-expanded={open} onClick={() => setExpanded((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; })}>
                          <span className="mono doc-id">_id {key}</span><span className="small muted">{open ? "Hide JSON" : "Show JSON"}</span>
                        </button>
                        {writable && <span className="row"><button className="btn ghost small" title="Edit document" aria-label="Edit document" onClick={() => setEditing(doc)}><Pencil size={14} /></button><button className="btn ghost small danger" title="Delete document" aria-label="Delete document" onClick={() => setDeleting(doc)}><Trash2 size={14} /></button></span>}
                      </header>
                      {open ? <pre className="mono doc-json">{JSON.stringify(doc, null, 2)}</pre> : (
                        <dl className="doc-fields">{preview(doc).map(([k, v]) => <div key={k}><dt>{k}</dt><dd className="mono">{v}</dd></div>)}{Object.keys(doc).length > 7 && <div><dt className="muted">…</dt><dd className="muted">{Object.keys(doc).length - 7} more fields</dd></div>}</dl>
                      )}
                    </article>
                  );
                })}
                {data.documents.length === 0 && <div className="database-empty"><Search size={28} /><span>{filter ? "No documents match this filter." : "This collection is empty."}</span></div>}
              </div>
            )}
            {data && data.total > 0 && <div className="pagination"><span className="small muted">Documents {from}–{to} of {data.total.toLocaleString()}</span><span className="spacer" /><button className="btn small" disabled={skip <= 0} onClick={() => setSkip((s) => Math.max(0, s - PAGE))}><ChevronLeft size={15} /> Previous</button><button className="btn small" disabled={to >= data.total} onClick={() => setSkip((s) => s + PAGE)}>Next <ChevronRight size={15} /></button></div>}
          </>}
        </section>
      </div>
      {database && <div className="db-link-zone"><DatabaseLink kind="documents" databaseId={database.id} canManage={me.permissions.includes("server.settings")} /></div>}
      {database && me.permissions.includes("server.settings") && <div className="danger-zone"><DeleteDatabase database={database} kind="documents" /></div>}
      {editing && <JsonEditor title={editing === "new" ? `Add document to ${selected}` : "Edit document"} saveLabel={editing === "new" ? "Add Document" : "Save Changes"} initial={editing === "new" ? "{\n  \n}" : JSON.stringify(editing, null, 2)} onSave={saveDocument} onClose={() => setEditing(null)} />}
      {importing && base && <ImportDialog collection={selected!} endpoint={`${base}/import`} onDone={() => void refresh()} onClose={() => setImporting(false)} />}
      {deleting && <Modal title="Delete this document?" onClose={() => setDeleting(null)} footer={<><button className="btn" onClick={() => setDeleting(null)}>Cancel</button><button className="btn danger" style={{ background: "var(--critical)", color: "white" }} onClick={() => void removeDocument()}><Trash2 size={15} /> Delete Document</button></>}><p>This deletes one document from <strong>{selected}</strong>. This cannot be undone, but your backups still contain it.</p><pre className="mono delete-key">{JSON.stringify(deleting, null, 2).slice(0, 1200)}</pre></Modal>}
      {newCollection !== null && <Modal title="New Collection" onClose={() => setNewCollection(null)} footer={<><button className="btn" onClick={() => setNewCollection(null)}>Cancel</button><button className="btn primary" disabled={!newCollection.trim()} onClick={() => void createCollection()}>Create Collection</button></>}><p className="secondary">A collection holds documents of one kind, like <em>customers</em> or <em>orders</em>.</p><label className="field" style={{ marginTop: 14 }}>Collection name<input className="input" value={newCollection} onChange={(e) => setNewCollection(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void createCollection()} autoFocus maxLength={120} placeholder="customers" /></label></Modal>}
      {droppingCollection && selected && <ConfirmByName name={selected} action="Delete Collection" onConfirm={() => void dropCollection()} onClose={() => setDroppingCollection(false)}><p>This permanently deletes the <strong>{selected}</strong> collection and all {data?.total.toLocaleString() ?? ""} of its documents. Backups taken before now still contain them.</p></ConfirmByName>}
    </>
  );
}
