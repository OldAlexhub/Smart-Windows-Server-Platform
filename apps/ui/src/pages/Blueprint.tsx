import { ArrowLeft, Printer } from "lucide-react";
import { Link, useParams } from "react-router";
import { formatBytes } from "@nexus/shared/format";
import { ErrorNote, Spinner } from "../components/ui";
import { useApi } from "../lib/hooks";

interface SqlColumn { name: string; type: string; nullable: boolean; default: string | null; primaryKey: boolean; unique: boolean; references: { table: string; column: string; onDelete: string } | null; description: string | null }
interface SqlTable { name: string; description: string | null; rowEstimate: number; sizeBytes: number; columns: SqlColumn[]; indexes: { name: string; columns: string[]; unique: boolean; primary: boolean }[] }
interface DocField { path: string; types: string[]; presence: number; references: string | null }
interface DocCollection { name: string; documents: number; sampled: number; fields: DocField[]; indexes: { name: string; keys: string[]; unique: boolean }[] }

interface BlueprintData {
  database: { id: string; name: string; engine: string; dbName: string; generatedAt: string };
  connection: { host: string; port: number | null; note: string };
  connections: { appId: string; appName: string; settings: string[] }[];
  sharedLink: { host: string; port: number; privateNetworkOn: boolean } | null;
  schema:
    | { tables: SqlTable[]; relations: { from: { table: string; column: string }; to: { table: string; column: string }; onDelete: string }[] }
    | { collections: DocCollection[]; relations: { from: { collection: string; field: string }; to: { collection: string; field: string } }[] };
}

/** One box in the diagram: a table or collection with its rows (columns or fields). */
interface Box {
  name: string;
  rows: { name: string; type: string; mark: "key" | "link" | "unique" | "" }[];
  more: number;
}
interface Edge { from: { box: string; row: string }; to: { box: string; row: string }; label: string }

const BOX_W = 250;
const HEAD_H = 32;
const ROW_H = 22;
const GAP_X = 110;
const GAP_Y = 36;
const MAX_ROWS = 14;

/**
 * Layout: tables that others point at stand on the left, the ones pointing at them to their right
 * (one column per level), so link lines mostly run right-to-left and rarely cross.
 */
function layout(boxes: Box[], edges: Edge[]) {
  const level = new Map<string, number>(boxes.map((b) => [b.name, 0]));
  for (let pass = 0; pass < boxes.length; pass++) {
    let changed = false;
    for (const e of edges) {
      if (e.from.box === e.to.box) continue;
      const want = (level.get(e.to.box) ?? 0) + 1;
      if ((level.get(e.from.box) ?? 0) < want && want < boxes.length) {
        level.set(e.from.box, want);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const columns = new Map<number, Box[]>();
  for (const b of boxes) columns.set(level.get(b.name)!, [...(columns.get(level.get(b.name)!) ?? []), b]);
  const pos = new Map<string, { x: number; y: number; h: number }>();
  let width = 0;
  let height = 0;
  for (const [lv, list] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
    let y = 0;
    for (const b of list) {
      const h = HEAD_H + (b.rows.length + (b.more ? 1 : 0)) * ROW_H + 8;
      pos.set(b.name, { x: lv * (BOX_W + GAP_X), y, h });
      y += h + GAP_Y;
    }
    width = Math.max(width, lv * (BOX_W + GAP_X) + BOX_W);
    height = Math.max(height, y - GAP_Y);
  }
  return { pos, width: Math.max(width, BOX_W), height: Math.max(height, HEAD_H) };
}

function Diagram({ boxes, edges }: { boxes: Box[]; edges: Edge[] }) {
  if (!boxes.length) return <p className="muted">This database is empty.</p>;
  const { pos, width, height } = layout(boxes, edges);
  const rowY = (box: string, row: string) => {
    const b = boxes.find((x) => x.name === box)!;
    const i = b.rows.findIndex((r) => r.name === row);
    return pos.get(box)!.y + HEAD_H + (i < 0 ? 0 : i) * ROW_H + ROW_H / 2 + 4;
  };
  const pad = 24;
  return (
    <svg className="bp-diagram" viewBox={`${-pad} ${-pad} ${width + pad * 2} ${height + pad * 2}`} style={{ width: `min(100%, ${width + pad * 2}px)` }} role="img" aria-label="Database diagram">
      <defs>
        <marker id="bp-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" className="bp-arrow" /></marker>
      </defs>
      {edges.map((e, i) => {
        const a = pos.get(e.from.box);
        const b = pos.get(e.to.box);
        if (!a || !b) return null;
        const y1 = rowY(e.from.box, e.from.row);
        const y2 = rowY(e.to.box, e.to.row);
        const self = e.from.box === e.to.box;
        const leftward = b.x < a.x;
        const x1 = self || !leftward ? a.x + BOX_W : a.x;
        const x2 = self ? b.x + BOX_W : leftward ? b.x + BOX_W : b.x;
        const bend = self ? 50 : Math.max(40, Math.abs(x1 - x2) / 2);
        const c1 = self || !leftward ? x1 + bend : x1 - bend;
        const c2 = self ? x2 + bend : leftward ? x2 + bend : x2 - bend;
        return (
          <g key={i} className="bp-edge">
            <path d={`M ${x1} ${y1} C ${c1} ${y1}, ${c2} ${y2}, ${x2} ${y2}`} markerEnd="url(#bp-arrow)" />
            <circle cx={x1} cy={y1} r={3.5} />
            <title>{e.label}</title>
          </g>
        );
      })}
      {boxes.map((b) => {
        const p = pos.get(b.name)!;
        return (
          <g key={b.name} transform={`translate(${p.x} ${p.y})`} className="bp-box">
            <rect width={BOX_W} height={p.h} rx={8} className="bp-box-bg" />
            <rect width={BOX_W} height={HEAD_H} rx={8} className="bp-box-head" />
            <rect y={HEAD_H - 8} width={BOX_W} height={8} className="bp-box-head" />
            <text x={12} y={21} className="bp-box-title">{b.name}</text>
            {b.rows.map((r, i) => (
              <g key={r.name} transform={`translate(0 ${HEAD_H + 4 + i * ROW_H})`}>
                <text x={12} y={15} className={`bp-row ${r.mark}`}>{r.mark === "key" ? "🔑 " : r.mark === "link" ? "↗ " : ""}{r.name}</text>
                <text x={BOX_W - 12} y={15} textAnchor="end" className="bp-type">{r.type.length > 18 ? `${r.type.slice(0, 17)}…` : r.type}</text>
              </g>
            ))}
            {b.more > 0 && <text x={12} y={HEAD_H + 4 + b.rows.length * ROW_H + 15} className="bp-type">+ {b.more} more</text>}
          </g>
        );
      })}
    </svg>
  );
}

const shortType = (t: string) =>
  t
    .replace("timestamp with time zone", "timestamptz")
    .replace("timestamp without time zone", "timestamp")
    .replace("character varying", "varchar");

/** Printable blueprint of a database: how it connects, a diagram, and every table or collection in detail. */
export function Blueprint({ kind }: { kind: "tables" | "documents" }) {
  const { id } = useParams();
  const { data, error } = useApi<BlueprintData>(id ? `/${kind === "tables" ? "databases" : "documents"}/${id}/blueprint` : null);
  if (error) return <ErrorNote error={error} />;
  if (!data) return <div className="center-panel"><Spinner label="Drawing the blueprint…" /></div>;

  const sql = "tables" in data.schema ? data.schema : null;
  const docs = "collections" in data.schema ? data.schema : null;
  const boxes: Box[] = sql
    ? sql.tables.map((t) => ({ name: t.name, rows: t.columns.slice(0, MAX_ROWS).map((c) => ({ name: c.name, type: shortType(c.type), mark: c.primaryKey ? "key" : c.references ? "link" : c.unique ? "unique" : "" })), more: Math.max(0, t.columns.length - MAX_ROWS) }))
    : docs!.collections.map((c) => {
        const top = c.fields.filter((f) => !f.path.includes(".") || f.references);
        return { name: c.name, rows: top.slice(0, MAX_ROWS).map((f) => ({ name: f.path, type: f.types.join(" | "), mark: f.path === "_id" ? "key" : f.references ? "link" : "" })), more: Math.max(0, top.length - MAX_ROWS) };
      });
  const edges: Edge[] = sql
    ? sql.relations.map((r) => ({ from: { box: r.from.table, row: r.from.column }, to: { box: r.to.table, row: r.to.column }, label: `${r.from.table}.${r.from.column} → ${r.to.table}.${r.to.column} (on delete: ${r.onDelete})` }))
    : docs!.relations.map((r) => ({ from: { box: r.from.collection, row: r.from.field }, to: { box: r.to.collection, row: "_id" }, label: `${r.from.collection}.${r.from.field} → ${r.to.collection}._id` }));
  const back = kind === "tables" ? `/databases/${id}` : `/documents/${id}`;
  const count = sql ? sql.tables.length : docs!.collections.length;

  return (
    <div className="blueprint">
      <div className="bp-toolbar no-print">
        <Link to={back} className="btn ghost small"><ArrowLeft size={15} /> Back to {data.database.name}</Link>
        <span className="spacer" />
        <button className="btn primary" onClick={() => window.print()}><Printer size={16} /> Print / Save as PDF</button>
      </div>

      <header className="bp-title">
        <div>
          <h1>{data.database.name}</h1>
          <p className="muted">{data.database.engine} · database <code>{data.database.dbName}</code> · {count} {sql ? (count === 1 ? "table" : "tables") : count === 1 ? "collection" : "collections"} · {edges.length} {edges.length === 1 ? "link" : "links"}</p>
        </div>
        <p className="small muted">Blueprint generated {new Date(data.database.generatedAt).toLocaleString()} by Nexus</p>
      </header>

      <section className="bp-section">
        <h2>How it connects</h2>
        <div className="bp-connect">
          <div className="bp-connect-col">
            <strong>Applications</strong>
            {data.connections.length ? data.connections.map((c) => (
              <div className="bp-node" key={c.appId}><span>{c.appName}</span><small className="muted">reads {c.settings.map((s) => <code key={s}>{s}</code>)}</small></div>
            )) : <div className="bp-node muted">No application uses it yet</div>}
          </div>
          <div className="bp-connect-arrow" aria-hidden>→</div>
          <div className="bp-connect-col">
            <strong>This database</strong>
            <div className="bp-node main"><span>{data.database.name}</span><small className="muted">{data.connection.host}{data.connection.port ? `:${data.connection.port}` : ""} · <code>{data.database.dbName}</code></small></div>
            <small className="muted">{data.connection.note}</small>
          </div>
          <div className="bp-connect-arrow" aria-hidden>←</div>
          <div className="bp-connect-col">
            <strong>Other servers</strong>
            {data.sharedLink ? (
              <div className="bp-node"><span>Private network link</span><small className="muted">{data.sharedLink.host}:{data.sharedLink.port}{data.sharedLink.privateNetworkOn ? "" : " (private network is off)"}</small></div>
            ) : <div className="bp-node muted">Not shared</div>}
          </div>
        </div>
        <p className="small muted">Each application has its own login, given to it by Nexus through the settings shown. Passwords are never printed.</p>
      </section>

      <section className="bp-section">
        <h2>Diagram</h2>
        <Diagram boxes={boxes} edges={edges} />
        <p className="small muted bp-legend">🔑 key · ↗ link to another {sql ? "table" : "collection"} (the arrow points at the {sql ? "table" : "collection"} it links to)</p>
      </section>

      {sql && sql.tables.map((t) => (
        <section className="bp-section bp-detail" key={t.name}>
          <h2>{t.name} <small className="muted">· about {t.rowEstimate.toLocaleString()} rows · {formatBytes(t.sizeBytes)}</small></h2>
          {t.description && <p>{t.description}</p>}
          <table className="bp-table">
            <thead><tr><th>Column</th><th>Type</th><th>Required</th><th>Key / unique</th><th>Default</th><th>Links to</th><th>Description</th></tr></thead>
            <tbody>
              {t.columns.map((c) => (
                <tr key={c.name}>
                  <td className="mono">{c.name}</td>
                  <td className="mono">{shortType(c.type)}</td>
                  <td>{c.nullable ? "" : "Yes"}</td>
                  <td>{c.primaryKey ? "Key" : c.unique ? "Unique" : ""}</td>
                  <td className="mono">{c.default ?? ""}</td>
                  <td className="mono">{c.references ? `${c.references.table}.${c.references.column} (on delete: ${c.references.onDelete})` : ""}</td>
                  <td>{c.description ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {t.indexes.length > 0 && <p className="small"><strong>Indexes:</strong> {t.indexes.map((i) => `${i.name} (${i.columns.join(", ")}${i.primary ? ", key" : i.unique ? ", unique" : ""})`).join(" · ")}</p>}
        </section>
      ))}

      {docs && docs.collections.map((c) => (
        <section className="bp-section bp-detail" key={c.name}>
          <h2>{c.name} <small className="muted">· {c.documents.toLocaleString()} documents{c.sampled < c.documents ? ` (fields from ${c.sampled} of them)` : ""}</small></h2>
          <table className="bp-table">
            <thead><tr><th>Field</th><th>Types</th><th>Present in</th><th>Links to</th></tr></thead>
            <tbody>
              {c.fields.map((f) => (
                <tr key={f.path}>
                  <td className="mono">{f.path}</td>
                  <td className="mono">{f.types.join(", ")}</td>
                  <td>{Math.round(f.presence * 100)}%</td>
                  <td className="mono">{f.references ? `${f.references}._id` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {c.indexes.length > 0 && <p className="small"><strong>Indexes:</strong> {c.indexes.map((i) => `${i.name} (${i.keys.join(", ")}${i.unique ? ", unique" : ""})`).join(" · ")}</p>}
        </section>
      ))}
    </div>
  );
}
