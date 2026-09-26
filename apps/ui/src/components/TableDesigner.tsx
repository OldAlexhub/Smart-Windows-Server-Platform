import { ArrowDown, ArrowUp, Code2, KeyRound, Link2, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, post } from "../lib/api";
import { useApi } from "../lib/hooks";
import { ErrorNote, Modal, Spinner } from "./ui";

type Kind = string;
interface KindInfo { id: Kind; label: string; hint: string }
interface Column {
  key: number;
  name: string;
  kind: Kind;
  required: boolean;
  unique: boolean;
  primaryKey: boolean;
  default: string;
  link: string; // "table.column" or ""
  onDelete: "restrict" | "cascade" | "set_null";
  description: string;
}
interface Blueprint {
  schema: { tables: { name: string; columns: { name: string; type: string; primaryKey: boolean; unique: boolean }[] }[] };
}

let nextKey = 1;
const col = (over: Partial<Column> = {}): Column => ({ key: nextKey++, name: "", kind: "text", required: false, unique: false, primaryKey: false, default: "", link: "", onDelete: "restrict", description: "", ...over });

/** Ready-made starting points: every column can still be changed. */
const TEMPLATES: { id: string; label: string; table: string; columns: () => Column[] }[] = [
  { id: "blank", label: "Blank", table: "", columns: () => [col({ name: "id", kind: "auto_id" }), col({ name: "created_at", kind: "timestamp", required: true, default: "now" })] },
  {
    id: "customers",
    label: "Customers",
    table: "customers",
    columns: () => [
      col({ name: "id", kind: "auto_id" }),
      col({ name: "name", kind: "text", required: true }),
      col({ name: "email", kind: "email", unique: true }),
      col({ name: "phone", kind: "short_text" }),
      col({ name: "created_at", kind: "timestamp", required: true, default: "now" }),
    ],
  },
  {
    id: "products",
    label: "Products",
    table: "products",
    columns: () => [
      col({ name: "id", kind: "auto_id" }),
      col({ name: "sku", kind: "short_text", required: true, unique: true }),
      col({ name: "name", kind: "text", required: true }),
      col({ name: "price", kind: "money", required: true, default: "0" }),
      col({ name: "in_stock", kind: "integer", required: true, default: "0" }),
      col({ name: "active", kind: "boolean", required: true, default: "yes" }),
    ],
  },
  {
    id: "orders",
    label: "Orders",
    table: "orders",
    columns: () => [
      col({ name: "id", kind: "auto_id" }),
      col({ name: "customer_id", kind: "big_integer", required: true }),
      col({ name: "total", kind: "money", required: true, default: "0" }),
      col({ name: "status", kind: "short_text", required: true, default: "new" }),
      col({ name: "ordered_at", kind: "timestamp", required: true, default: "now" }),
    ],
  },
  {
    id: "employees",
    label: "Employees",
    table: "employees",
    columns: () => [
      col({ name: "id", kind: "auto_id" }),
      col({ name: "full_name", kind: "text", required: true }),
      col({ name: "email", kind: "email", unique: true }),
      col({ name: "hired_on", kind: "date" }),
      col({ name: "salary", kind: "money" }),
      col({ name: "active", kind: "boolean", required: true, default: "yes" }),
    ],
  },
];

const DEFAULT_HINTS: Record<string, string> = { timestamp: "now", date: "today", time: "now", boolean: "yes / no", uuid: "new_uuid", json: "{}", integer: "0", big_integer: "0", decimal: "0", money: "0" };

/** "Customer Name" → customer_name, as people type. */
const toName = (s: string) => s.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+/, "").slice(0, 63);

/**
 * New Table: fill in one row per column (name, type, rules, default, link to another table) and
 * Nexus writes the SQL. The SQL is shown live, checked by the server, and run in one step.
 */
export function TableDesigner({ databaseId, onClose, onCreated }: { databaseId: string; onClose: () => void; onCreated: (table: string) => void }) {
  const { data: kinds } = useApi<KindInfo[]>("/schema/column-kinds");
  const { data: blueprint } = useApi<Blueprint>(`/databases/${databaseId}/blueprint`);
  const [table, setTable] = useState("");
  const [description, setDescription] = useState("");
  const [columns, setColumns] = useState<Column[]>(TEMPLATES[0]!.columns());
  const [sql, setSql] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [showSql, setShowSql] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);

  // Columns other tables can be linked to: their keys and unique columns.
  const linkTargets = useMemo(
    () => (blueprint?.schema.tables ?? []).flatMap((t) => t.columns.filter((c) => c.primaryKey || c.unique).map((c) => ({ value: `${t.name}.${c.name}`, label: `${t.name} → ${c.name}`, type: c.type }))),
    [blueprint],
  );

  const design = () => ({
    name: table,
    description: description || null,
    columns: columns.map((c) => ({
      name: c.name,
      kind: c.kind,
      required: c.required,
      unique: c.unique,
      primaryKey: c.primaryKey,
      default: c.default || null,
      description: c.description || null,
      references: c.link ? { table: c.link.split(".")[0]!, column: c.link.split(".")[1]!, onDelete: c.onDelete } : null,
    })),
  });

  // Live check: the server builds the SQL and reports the first problem in plain words.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!table) {
      setSql(null);
      setProblem("Give the table a name.");
      return;
    }
    timer.current = setTimeout(() => {
      post<{ sql: string }>(`/databases/${databaseId}/tables/preview`, design())
        .then((r) => {
          setSql(r.sql);
          setProblem(null);
        })
        .catch((e: ApiError) => {
          setSql(null);
          setProblem(e.message);
        });
    }, 350);
  }, [table, description, columns]); // eslint-disable-line react-hooks/exhaustive-deps

  const change = (key: number, patch: Partial<Column>) => setColumns((cs) => cs.map((c) => (c.key === key ? { ...c, ...patch } : c)));
  const move = (i: number, d: -1 | 1) => setColumns((cs) => {
    const next = [...cs];
    const j = i + d;
    if (j < 0 || j >= next.length) return cs;
    [next[i], next[j]] = [next[j]!, next[i]!];
    return next;
  });

  async function create() {
    setBusy(true);
    setErr(null);
    try {
      const r = await post<{ table: string }>(`/databases/${databaseId}/tables/create`, design());
      onCreated(r.table);
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      wide
      title="New Table"
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={() => setShowSql(!showSql)}><Code2 size={15} /> {showSql ? "Hide SQL" : "Show SQL"}</button>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !sql} onClick={() => void create()}>{busy ? <Spinner label="Creating…" /> : "Create Table"}</button>
        </>
      }
    >
      <div className="designer-top">
        <div className="designer-templates">
          <span className="small muted">Start from</span>
          {TEMPLATES.map((t) => (
            <button key={t.id} className="btn small" onClick={() => { setColumns(t.columns()); if (t.table) setTable(t.table); }}>{t.label}</button>
          ))}
        </div>
        <div className="designer-names">
          <label className="field">Table name<input className="input mono" value={table} placeholder="e.g. customers" onChange={(e) => setTable(toName(e.target.value))} autoFocus /></label>
          <label className="field">Description <span className="hint">optional — appears in the blueprint</span><input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this table holds" /></label>
        </div>
      </div>

      <div className="column-grid" role="table" aria-label="Columns">
        <div className="column-row head" role="row">
          <span>Column name</span><span>Type</span><span title="Must always have a value">Required</span><span title="No two rows may share a value">Unique</span><span title="Identifies each row">Key</span><span>Default</span><span>Links to</span><span />
        </div>
        {columns.map((c, i) => {
          const hint = kinds?.find((k) => k.id === c.kind)?.hint;
          const auto = c.kind === "auto_id";
          return (
            <div className="column-row" role="row" key={c.key}>
              <input className="input mono" aria-label="Column name" value={c.name} placeholder="column_name" onChange={(e) => change(c.key, { name: toName(e.target.value) })} />
              <select className="select" aria-label="Type" title={hint} value={c.kind} onChange={(e) => change(c.key, { kind: e.target.value, ...(e.target.value === "auto_id" ? { default: "", primaryKey: true } : {}) })}>
                {(kinds ?? []).map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
              </select>
              <input type="checkbox" aria-label="Required" checked={c.required || auto || c.primaryKey} disabled={auto || c.primaryKey} onChange={(e) => change(c.key, { required: e.target.checked })} />
              <input type="checkbox" aria-label="Unique" checked={c.unique} disabled={auto || c.primaryKey} onChange={(e) => change(c.key, { unique: e.target.checked })} />
              <label className="key-toggle" title="Key: identifies each row"><input type="checkbox" aria-label="Key" checked={c.primaryKey || auto} disabled={auto} onChange={(e) => change(c.key, { primaryKey: e.target.checked })} /><KeyRound size={13} /></label>
              <input className="input" aria-label="Default" value={c.default} disabled={auto} placeholder={auto ? "automatic" : DEFAULT_HINTS[c.kind] ?? "none"} onChange={(e) => change(c.key, { default: e.target.value })} />
              <span className="link-cell">
                <select className="select" aria-label="Links to" value={c.link} disabled={auto} onChange={(e) => change(c.key, { link: e.target.value, ...(e.target.value && c.kind === "text" ? { kind: "big_integer" } : {}) })}>
                  <option value="">—</option>
                  {linkTargets.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
                {c.link && (
                  <select className="select" aria-label="When the linked row is deleted" title="When the linked row is deleted" value={c.onDelete} onChange={(e) => change(c.key, { onDelete: e.target.value as Column["onDelete"] })}>
                    <option value="restrict">Block deleting it</option>
                    <option value="cascade">Delete these rows too</option>
                    <option value="set_null">Clear the link</option>
                  </select>
                )}
              </span>
              <span className="row-tools">
                <button className="btn ghost small" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={13} /></button>
                <button className="btn ghost small" aria-label="Move down" disabled={i === columns.length - 1} onClick={() => move(i, 1)}><ArrowDown size={13} /></button>
                <button className="btn ghost small danger" aria-label={`Remove ${c.name || "column"}`} disabled={columns.length === 1} onClick={() => setColumns((cs) => cs.filter((x) => x.key !== c.key))}><Trash2 size={13} /></button>
              </span>
            </div>
          );
        })}
      </div>
      <div className="row designer-bottom">
        <button className="btn small" onClick={() => setColumns((cs) => [...cs, col()])}><Plus size={14} /> Add column</button>
        {!linkTargets.length && <span className="small muted"><Link2 size={12} /> Links to other tables appear once this database has tables.</span>}
        <span className="spacer" />
        {problem ? <span className="small designer-problem">{problem}</span> : sql ? <span className="small designer-ok">Ready to create</span> : null}
      </div>
      {showSql && sql && <pre className="designer-sql mono">{sql}</pre>}
      <ErrorNote error={err} />
    </Modal>
  );
}
