import { ArrowDown, ArrowLeft, ArrowUp, ChevronLeft, ChevronRight, Database, Download, Filter, KeyRound, Pencil, Plus, Search, Table2, Trash2, Upload, X, FileText } from "lucide-react";
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { Link, useParams } from "react-router";
import { formatBytes } from "@nexus/shared/format";
import type { DatabaseSummary } from "@nexus/shared/contracts";
import type { Me } from "../App";
import { PageHead } from "../components/Layout";
import { ErrorNote, Modal, Spinner, StatusOf } from "../components/ui";
import { ApiError, del, patch, post } from "../lib/api";
import { useApi } from "../lib/hooks";
import { AskData } from "../components/AskData";
import { ImportData } from "../components/ImportData";
import { TableDesigner } from "../components/TableDesigner";
import { DeleteDatabase } from "../components/DeleteDatabase";
import { DatabaseLink } from "../components/DatabaseLink";

interface TableSummary { name: string; rowEstimate: number; sizeBytes: number; columnCount: number; editable: boolean }
interface ColumnInfo { name: string; type: string; nullable: boolean; hasDefault: boolean; primaryKey: boolean }
interface BrowseResult { table: { name: string; columns: ColumnInfo[]; primaryKey: string[]; editable: boolean }; rows: Record<string, unknown>[]; total: number; page: number; pageSize: number }
type FilterOp = "eq" | "neq" | "lt" | "lte" | "gt" | "gte" | "contains" | "starts" | "is_null" | "not_null";
interface DataFilter { column: string; op: FilterOp; value?: string }

export function canWrite(me: Me, appIds: string[]): boolean {
  if (["owner", "administrator", "developer"].includes(me.user.role)) return true;
  return appIds.some((id) => ["administrator", "developer"].includes(me.user.appRoles[id] ?? ""));
}

function showValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function parseValue(raw: string, column: ColumnInfo): unknown {
  if (raw === "NULL" && column.nullable) return null;
  if (/^(smallint|integer|bigint|decimal|numeric|real|double precision)/.test(column.type)) {
    const n = Number(raw);
    if (!Number.isNaN(n)) return n;
  }
  if (column.type === "boolean") return /^(true|t|1|yes)$/i.test(raw);
  if (/json/.test(column.type)) {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  return raw;
}

function Cell({ value, column, editable, onSave }: { value: unknown; column: ColumnInfo; editable: boolean; onSave: (value: unknown) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(showValue(value));
  const [saving, setSaving] = useState(false);
  async function save() { setSaving(true); try { await onSave(parseValue(draft, column)); setEditing(false); } finally { setSaving(false); } }
  function key(e: KeyboardEvent<HTMLInputElement>) { if (e.key === "Enter") void save(); if (e.key === "Escape") { setDraft(showValue(value)); setEditing(false); } }
  if (editing) return <div className="cell-editor"><input className="input mono" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={key} autoFocus disabled={saving} /><button className="btn small primary" disabled={saving} onClick={() => void save()}>Save</button><button className="btn small ghost" onClick={() => setEditing(false)}><X size={13} /></button></div>;
  return <button className={`cell-value ${value === null ? "null" : ""}`} disabled={!editable} title={editable ? "Click to edit" : showValue(value)} onClick={() => { setDraft(showValue(value)); setEditing(true); }}>{showValue(value)}{editable && <Pencil size={12} />}</button>;
}

function AddRow({ table, onClose, onAdded, endpoint }: { table: BrowseResult["table"]; onClose: () => void; onAdded: () => void; endpoint: string }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [included, setIncluded] = useState<Record<string, boolean>>(() => Object.fromEntries(table.columns.map((c) => [c.name, !c.hasDefault && !c.nullable])));
  const [error, setError] = useState<ApiError | null>(null);
  const [saving, setSaving] = useState(false);
  async function save() {
    const payload: Record<string, unknown> = {};
    for (const col of table.columns) if (included[col.name]) payload[col.name] = parseValue(values[col.name] ?? "", col);
    setSaving(true); try { await post(endpoint, { values: payload }); onAdded(); onClose(); } catch (e) { setError(e as ApiError); } finally { setSaving(false); }
  }
  return <Modal title={`Add row to ${table.name}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={saving} onClick={() => void save()}>{saving ? <Spinner label="Adding…" /> : "Add Row"}</button></>}><div className="row-form">{table.columns.map((col) => <div className="row-field" key={col.name}><label className="row include-field"><input type="checkbox" checked={!!included[col.name]} onChange={(e) => setIncluded((v) => ({ ...v, [col.name]: e.target.checked }))} /><span><strong className="mono">{col.name}</strong><small>{col.type}{col.primaryKey ? " · Primary key" : ""}{col.hasDefault ? " · Has default" : ""}{col.nullable ? " · Optional" : ""}</small></span></label><input className="input mono" disabled={!included[col.name]} value={values[col.name] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [col.name]: e.target.value }))} placeholder={col.nullable ? "NULL" : col.hasDefault ? "Use default" : "Value"} /></div>)}</div><ErrorNote error={error} /></Modal>;
}

const opLabel: Record<FilterOp, string> = { eq: "equals", neq: "does not equal", lt: "less than", lte: "at most", gt: "greater than", gte: "at least", contains: "contains", starts: "starts with", is_null: "is empty", not_null: "is not empty" };

export function DatabaseDetail({ me }: { me: Me }) {
  const { id = "" } = useParams();
  const { data: database, error: dbError, loading: dbLoading, reload: reloadDatabase } = useApi<DatabaseSummary>(id ? `/databases/${id}` : null, 15_000);
  const { data: ai } = useApi<{ state: string }>("/ai", 30_000);
  const [designing, setDesigning] = useState(false);
  const { data: tables, error: tableError, loading: tablesLoading, reload: reloadTables } = useApi<TableSummary[]>(id ? `/databases/${id}/tables` : null, 15_000);
  const [selected, setSelected] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ column: string; direction: "asc" | "desc" } | null>(null);
  const [filters, setFilters] = useState<DataFilter[]>([]);
  const [filterColumn, setFilterColumn] = useState("");
  const [filterOp, setFilterOp] = useState<FilterOp>("eq");
  const [filterValue, setFilterValue] = useState("");
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<Record<string, unknown> | null>(null);
  const [writeError, setWriteError] = useState<ApiError | null>(null);
  const [importing, setImporting] = useState(false);
  useEffect(() => { if (!selected && tables?.[0]) setSelected(tables[0].name); }, [tables, selected]);
  useEffect(() => { setPage(1); }, [selected, search, sort, filters]);
  const query = useMemo(() => {
    const q = new URLSearchParams({ page: String(page), pageSize: "50" });
    if (search) q.set("search", search);
    if (sort) { q.set("sort", sort.column); q.set("dir", sort.direction); }
    if (filters.length) q.set("filters", JSON.stringify(filters));
    return q.toString();
  }, [page, search, sort, filters]);
  const base = selected ? `/databases/${id}/tables/${encodeURIComponent(selected)}` : null;
  const { data, error, loading, reload } = useApi<BrowseResult>(base ? `${base}?${query}` : null);
  const writable = database ? canWrite(me, database.ownerAppIds) : false;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const exportUrl = base ? `/api/v1${base}/export.csv?${query}` : "#";

  async function update(row: Record<string, unknown>, column: ColumnInfo, value: unknown) {
    if (!data || !base) return;
    const key = Object.fromEntries(data.table.primaryKey.map((k) => [k, row[k]]));
    try { await patch(`${base}/rows`, { key, changes: { [column.name]: value } }); setWriteError(null); await reload(); }
    catch (e) { setWriteError(e as ApiError); }
  }
  async function remove() {
    if (!base || !deleting) return;
    try { await del(`${base}/rows`, { key: deleting, confirmed: true }); setDeleting(null); setWriteError(null); await reload(); }
    catch (e) { setWriteError(e as ApiError); }
  }
  function addFilter() {
    if (!filterColumn) return;
    setFilters((f) => [...f, { column: filterColumn, op: filterOp, ...(!["is_null", "not_null"].includes(filterOp) ? { value: filterValue } : {}) }]);
    setFilterValue("");
  }
  if (dbLoading && !database) return <div className="center-panel"><Spinner label="Loading database…" /></div>;
  if (dbError && !database) return <ErrorNote error={dbError} />;
  if (!database) return null;
  return (
    <>
      <div className="app-breadcrumb"><Link to="/databases"><ArrowLeft size={15} /> Databases</Link></div>
      <PageHead title={<span className="row"><span className="database-icon large"><Database size={22} /></span>{database.name}<StatusOf status={database.status} /></span>} sub={<span className="mono">{database.dbName}</span>} actions={<><Link className="btn" to={`/databases/${id}/blueprint`}><FileText size={16} /> Blueprint</Link>{writable && <button className="btn" onClick={() => setDesigning(true)}><Plus size={16} /> New Table</button>}{writable && <button className="btn primary" onClick={() => setImporting(true)}><Upload size={16} /> Import Data</button>}</>} />
      <div className="grid database-summary"><div className="card"><span className="stat-label">Database Size</span><strong className="stat-value">{formatBytes(database.sizeBytes)}</strong></div><div className="card"><span className="stat-label">Tables</span><strong className="stat-value">{database.tableCount}</strong></div><div className="card"><span className="stat-label">Connections</span><strong className="stat-value">{database.connectionCount}</strong></div><div className="card"><span className="stat-label">Backup</span><strong className="stat-value small-value">{database.protected ? "Protected" : "Needs Attention"}</strong></div></div>
      <AskData databaseId={id} aiReady={ai?.state === "ready"} />
      <div className="database-browser card">
        <aside className="table-sidebar">
          <div className="table-sidebar-head"><strong>Tables</strong><span className="small muted">{tables?.length ?? 0}</span>{writable && <button className="btn ghost small" title="New table" aria-label="New table" onClick={() => setDesigning(true)}><Plus size={14} /></button>}</div>
          {tablesLoading && !tables ? <Spinner /> : tableError ? <ErrorNote error={tableError} /> : !tables?.length ? <div className="database-empty"><Table2 size={28} /><span>No tables yet</span>{writable && <button className="btn small primary" onClick={() => setDesigning(true)}><Plus size={14} /> New Table</button>}</div> : tables.map((table) => <button className={`table-choice ${selected === table.name ? "active" : ""}`} key={table.name} onClick={() => setSelected(table.name)}><Table2 size={16} /><span><strong>{table.name}</strong><small>{table.rowEstimate.toLocaleString()} rows · {formatBytes(table.sizeBytes)}</small></span>{!table.editable && <span title="Read only">🔒</span>}</button>)}
        </aside>
        <section className="data-sheet">
          {!selected ? <div className="database-empty"><Table2 size={32} /><span>Choose a table to browse its data.</span></div> : <>
            <div className="data-sheet-head"><div><h2>{selected}</h2>{data && <span className="small muted">{data.total.toLocaleString()} {data.total === 1 ? "row" : "rows"}{data.table.editable ? " · Editable" : " · Read only (no primary key)"}</span>}</div><div className="row">{writable && data?.table.editable && <button className="btn primary small" onClick={() => setAdding(true)}><Plus size={14} /> Add Row</button>}<a className="btn small" href={exportUrl}><Download size={14} /> Export CSV</a></div></div>
            <div className="data-toolbar"><form className="search-input" onSubmit={(e) => { e.preventDefault(); setSearch(searchDraft); }}><Search size={16} /><input className="input" value={searchDraft} onChange={(e) => setSearchDraft(e.target.value)} placeholder="Search every column" /></form><select className="select" value={filterColumn} onChange={(e) => setFilterColumn(e.target.value)}><option value="">Filter column…</option>{data?.table.columns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}</select><select className="select" value={filterOp} onChange={(e) => setFilterOp(e.target.value as FilterOp)}>{Object.entries(opLabel).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select>{!["is_null", "not_null"].includes(filterOp) && <input className="input" value={filterValue} onChange={(e) => setFilterValue(e.target.value)} placeholder="Value" />}<button className="btn" disabled={!filterColumn} onClick={addFilter}><Filter size={14} /> Add</button></div>
            {(search || filters.length > 0) && <div className="filter-chips">{search && <button onClick={() => { setSearch(""); setSearchDraft(""); }}>Search: {search} <X size={12} /></button>}{filters.map((f, i) => <button key={`${f.column}-${i}`} onClick={() => setFilters((all) => all.filter((_, n) => n !== i))}>{f.column} {opLabel[f.op]} {f.value ?? ""} <X size={12} /></button>)}</div>}
            <ErrorNote error={writeError} />
            {loading && !data ? <div className="folder-loading"><Spinner label="Loading rows…" /></div> : error ? <ErrorNote error={error} /> : data && <div className="sheet-wrap"><table className="sheet"><thead><tr>{data.table.columns.map((column) => <th key={column.name}><button onClick={() => setSort((s) => s?.column === column.name ? { column: column.name, direction: s.direction === "asc" ? "desc" : "asc" } : { column: column.name, direction: "asc" })}><span>{column.primaryKey && <KeyRound size={12} />}{column.name}</span><small>{column.type}</small>{sort?.column === column.name && (sort.direction === "asc" ? <ArrowUp size={13} /> : <ArrowDown size={13} />)}</button></th>)}{writable && data.table.editable && <th className="actions-col">Actions</th>}</tr></thead><tbody>{data.rows.map((row, rowIndex) => { const key = Object.fromEntries(data.table.primaryKey.map((k) => [k, row[k]])); return <tr key={JSON.stringify(key) || rowIndex}>{data.table.columns.map((column) => <td key={column.name}><Cell value={row[column.name]} column={column} editable={writable && data.table.editable} onSave={(value) => update(row, column, value)} /></td>)}{writable && data.table.editable && <td className="row-actions"><button className="btn ghost small danger" title="Delete row" onClick={() => setDeleting(key)}><Trash2 size={14} /></button></td>}</tr>; })}</tbody></table>{data.rows.length === 0 && <div className="database-empty"><Search size={28} /><span>No rows match this view.</span></div>}</div>}
            {data && <div className="pagination"><span className="small muted">Rows {data.total ? (data.page - 1) * data.pageSize + 1 : 0}–{Math.min(data.page * data.pageSize, data.total)} of {data.total}</span><span className="spacer" /><button className="btn small" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><ChevronLeft size={15} /> Previous</button><span className="small num">Page {page} of {totalPages}</span><button className="btn small" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next <ChevronRight size={15} /></button></div>}
          </>}
        </section>
      </div>
      {database && <div className="db-link-zone"><DatabaseLink kind="tables" databaseId={database.id} canManage={me.permissions.includes("server.settings")} /></div>}
      {database && me.permissions.includes("server.settings") && <div className="danger-zone"><DeleteDatabase database={database} kind="tables" /></div>}
      {adding && data && base && <AddRow table={data.table} endpoint={`${base}/rows`} onAdded={() => void reload()} onClose={() => setAdding(false)} />}
      {deleting && <Modal title="Delete this row?" onClose={() => setDeleting(null)} footer={<><button className="btn" onClick={() => setDeleting(null)}>Cancel</button><button className="btn danger" style={{ background: "var(--critical)", color: "white" }} onClick={() => void remove()}><Trash2 size={15} /> Delete Row</button></>}><p>This deletes one record from <strong>{selected}</strong>. This cannot be undone.</p><pre className="mono delete-key">{JSON.stringify(deleting, null, 2)}</pre></Modal>}
      {designing && id && <TableDesigner databaseId={id} onClose={() => setDesigning(false)} onCreated={(table) => { setDesigning(false); setSelected(table); void reloadTables(); void reloadDatabase(); }} />}
      {importing && <ImportData databaseId={id} onClose={() => setImporting(false)} onImported={(table) => { setImporting(false); setSelected(table); void reloadTables(); void reloadDatabase(); }} />}
    </>
  );
}
