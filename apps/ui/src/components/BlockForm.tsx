import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import type { JsonSchema } from "../lib/pipelines";

export interface FormContext {
  /** Nexus PostgreSQL databases by name. */
  databases: string[];
  /** Saved pipeline secret names. */
  secrets: string[];
}

const LABELS: Record<string, string> = {
  groupBy: "Group by",
  secretHeaders: "Secret headers",
  keepOthers: "Keep the other columns",
  onFailure: "When a check fails",
  continueOnError: "Keep going if this step fails",
  batchSize: "Rows per request",
  maxPages: "Most pages to read",
  settleSeconds: "Wait until the file is complete (seconds)",
  materialize: "Save as",
  fn: "Calculation",
  args: "Arguments",
  records: "Where the records are",
  url: "Address",
};
const SQL_KEYS = new Set(["query", "where", "expression"]);
const PATH_KEYS = new Set(["path", "script"]);
const human = (k: string) => LABELS[k] ?? k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
const typeOf = (s: JsonSchema): string => (Array.isArray(s.type) ? s.type.find((t) => t !== "null") ?? "string" : s.type ?? (s.enum ? "string" : s.properties ? "object" : "any"));

/** Nexus database or saved-secret connection (the `connection` setting of database blocks). */
function ConnectionField({ value, onChange, ctx }: { value: unknown; onChange: (v: unknown) => void; ctx: FormContext }) {
  const v = (value ?? {}) as { database?: string; secret?: string };
  const external = v.secret !== undefined;
  return (
    <div className="block-field">
      <span className="block-label">Connection<span className="req">*</span></span>
      <div className="segmented" role="radiogroup" aria-label="Connection kind">
        <button type="button" className={!external ? "active" : ""} onClick={() => onChange({ database: ctx.databases[0] ?? "" })}>Nexus database</button>
        <button type="button" className={external ? "active" : ""} onClick={() => onChange({ secret: ctx.secrets[0] ?? "" })}>Other server</button>
      </div>
      {!external ? (
        <select className="select" value={v.database ?? ""} onChange={(e) => onChange({ database: e.target.value })}>
          <option value="">Choose a database…</option>
          {ctx.databases.map((d) => <option key={d}>{d}</option>)}
        </select>
      ) : (
        <>
          <select className="select" value={v.secret ?? ""} onChange={(e) => onChange({ secret: e.target.value })}>
            <option value="">Choose a saved secret…</option>
            {ctx.secrets.map((s) => <option key={s}>{s}</option>)}
          </select>
          <small className="muted">The secret holds the server's address, e.g. postgresql://user:password@server:5432/database.</small>
        </>
      )}
    </div>
  );
}

function KeyValueField({ label, value, onChange, secretValues, ctx }: { label: string; value: Record<string, string>; onChange: (v: Record<string, string>) => void; secretValues: boolean; ctx: FormContext }) {
  const entries = Object.entries(value ?? {});
  const set = (i: number, k: string, v: string) => onChange(Object.fromEntries(entries.map(([ek, ev], n) => (n === i ? [k, v] : [ek, ev]))));
  return (
    <div className="block-field">
      <span className="block-label">{label}</span>
      {entries.map(([k, v], i) => (
        <div className="kv-row" key={i}>
          <input className="input" value={k} placeholder="Header" aria-label="Name" onChange={(e) => set(i, e.target.value, v)} />
          {secretValues ? (
            <select className="select" value={v} aria-label="Secret" onChange={(e) => set(i, k, e.target.value)}>
              <option value="">Saved secret…</option>
              {ctx.secrets.map((s) => <option key={s}>{s}</option>)}
            </select>
          ) : (
            <input className="input" value={v} placeholder="Value" aria-label="Value" onChange={(e) => set(i, k, e.target.value)} />
          )}
          <button type="button" className="btn ghost small" aria-label="Remove" onClick={() => onChange(Object.fromEntries(entries.filter((_, n) => n !== i)))}><Trash2 size={14} /></button>
        </div>
      ))}
      <button type="button" className="btn small" onClick={() => onChange({ ...value, [`Header${entries.length ? entries.length + 1 : ""}`]: "" })}><Plus size={14} /> Add</button>
    </div>
  );
}

function JsonField({ label, value, onChange }: { label: string; value: unknown; onChange: (v: unknown) => void }) {
  const [text, setText] = useState(value === undefined ? "" : JSON.stringify(value, null, 2));
  const [bad, setBad] = useState(false);
  return (
    <label className="block-field">
      <span className="block-label">{label}</span>
      <textarea
        className={`input mono sql-input ${bad ? "invalid" : ""}`}
        value={text}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          if (!e.target.value.trim()) return (setBad(false), onChange(undefined));
          try {
            onChange(JSON.parse(e.target.value));
            setBad(false);
          } catch {
            setBad(true);
          }
        }}
      />
      {bad && <small className="json-invalid">Not valid JSON yet.</small>}
    </label>
  );
}

function Field({ name, schema, required, value, onChange, ctx }: { name: string; schema: JsonSchema; required: boolean; value: unknown; onChange: (v: unknown) => void; ctx: FormContext }) {
  const label = human(name);
  const req = required ? <span className="req">*</span> : null;
  if (name === "connection") return <ConnectionField value={value} onChange={onChange} ctx={ctx} />;
  if (name === "secretHeaders") return <KeyValueField label={label} value={value as Record<string, string>} onChange={onChange} secretValues ctx={ctx} />;
  if (schema.anyOf || schema.oneOf) {
    const opts = (schema.anyOf ?? schema.oneOf)!.filter((o) => o.type !== "null");
    if (opts.length === 1) return <Field name={name} schema={opts[0]!} required={required} value={value} onChange={onChange} ctx={ctx} />;
    // number-or-text style unions: a plain text box that keeps numbers as numbers.
    if (opts.every((o) => ["string", "number", "integer"].includes(typeOf(o)))) {
      return (
        <label className="block-field">
          <span className="block-label">{label}{req}</span>
          <input className="input" value={value === undefined ? "" : String(value)} onChange={(e) => onChange(e.target.value === "" ? undefined : /^-?\d+(\.\d+)?$/.test(e.target.value) ? Number(e.target.value) : e.target.value)} />
        </label>
      );
    }
    return <JsonField label={label} value={value} onChange={onChange} />;
  }
  const t = typeOf(schema);
  if (schema.enum) {
    return (
      <label className="block-field">
        <span className="block-label">{label}{req}</span>
        <select className="select" value={value === undefined ? String(schema.default ?? "") : String(value)} onChange={(e) => onChange(e.target.value)}>
          {!required && schema.default === undefined && <option value="">—</option>}
          {schema.enum.map((o) => <option key={String(o)} value={String(o)}>{String(o).replace(/_/g, " ")}</option>)}
        </select>
      </label>
    );
  }
  if (t === "boolean") {
    return (
      <label className="block-field check-field">
        <input type="checkbox" checked={value === undefined ? !!schema.default : !!value} onChange={(e) => onChange(e.target.checked)} />
        <span>{label}</span>
      </label>
    );
  }
  if (t === "number" || t === "integer") {
    return (
      <label className="block-field">
        <span className="block-label">{label}{req}</span>
        <input className="input" type="number" value={value === undefined ? "" : String(value)} placeholder={schema.default !== undefined ? String(schema.default) : ""} min={schema.minimum} max={schema.maximum} onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))} />
      </label>
    );
  }
  if (t === "string") {
    const sql = SQL_KEYS.has(name);
    return (
      <label className="block-field">
        <span className="block-label">{label}{req}</span>
        {sql ? (
          <textarea className="input mono sql-input" spellCheck={false} value={String(value ?? "")} placeholder={name === "where" ? "status = 'Completed'" : name === "expression" ? "fare * 1.1" : "select * from input"} onChange={(e) => onChange(e.target.value || undefined)} />
        ) : (
          <input className={`input ${PATH_KEYS.has(name) ? "mono" : ""}`} value={String(value ?? "")} placeholder={PATH_KEYS.has(name) ? "C:\\Data\\file.csv" : schema.default !== undefined ? String(schema.default) : ""} onChange={(e) => onChange(e.target.value || undefined)} />
        )}
      </label>
    );
  }
  if (t === "array" && schema.items) {
    const items = (value as unknown[] | undefined) ?? [];
    const it = schema.items;
    if (typeOf(it) === "string" || typeOf(it) === "number") {
      return (
        <label className="block-field">
          <span className="block-label">{label}{req}</span>
          <input className="input" value={items.join(", ")} placeholder="one, two, three" onChange={(e) => onChange(e.target.value.split(",").map((x) => x.trim()).filter(Boolean))} />
          <small className="muted">Separate with commas.</small>
        </label>
      );
    }
    if (typeOf(it) === "object" && it.properties) {
      return (
        <div className="block-field">
          <span className="block-label">{label}{req}</span>
          {items.map((row, i) => (
            <div className="array-row" key={i}>
              <ObjectFields schema={it} value={(row ?? {}) as Record<string, unknown>} onChange={(v) => onChange(items.map((x, n) => (n === i ? v : x)))} ctx={ctx} compact />
              <button type="button" className="btn ghost small" aria-label="Remove" onClick={() => onChange(items.filter((_, n) => n !== i))}><Trash2 size={14} /></button>
            </div>
          ))}
          <button type="button" className="btn small" onClick={() => onChange([...items, {}])}><Plus size={14} /> Add</button>
        </div>
      );
    }
  }
  if (t === "object" && schema.properties) {
    const present = value !== undefined;
    return (
      <fieldset className="block-fieldset">
        <legend>
          {!required && <input type="checkbox" checked={present} onChange={(e) => onChange(e.target.checked ? {} : undefined)} aria-label={`Use ${label}`} />} {label}
        </legend>
        {present && <ObjectFields schema={schema} value={value as Record<string, unknown>} onChange={onChange} ctx={ctx} />}
      </fieldset>
    );
  }
  if (t === "object" && typeof schema.additionalProperties === "object") {
    return <KeyValueField label={label} value={value as Record<string, string>} onChange={onChange} secretValues={false} ctx={ctx} />;
  }
  return <JsonField label={label} value={value} onChange={onChange} />;
}

export function ObjectFields({ schema, value, onChange, ctx, compact = false }: { schema: JsonSchema; value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void; ctx: FormContext; compact?: boolean }) {
  const props = Object.entries(schema.properties ?? {});
  const required = new Set(schema.required ?? []);
  // Required settings first, then the optional ones.
  props.sort(([a], [b]) => Number(required.has(b)) - Number(required.has(a)));
  return (
    <div className={compact ? "object-fields compact" : "object-fields"}>
      {props.map(([k, s]) => (
        <Field
          key={k}
          name={k}
          schema={s}
          required={required.has(k) && s.default === undefined}
          value={value[k]}
          ctx={ctx}
          onChange={(v) => {
            const next = { ...value };
            if (v === undefined) delete next[k];
            else next[k] = v;
            onChange(next);
          }}
        />
      ))}
    </div>
  );
}

/** Merges `allOf` parts (blocks built from two schemas) into one list of fields. */
export function flattenSchema(s: JsonSchema & { allOf?: JsonSchema[] }): JsonSchema {
  if (!s.allOf) return s;
  const parts = s.allOf.map(flattenSchema);
  return {
    type: "object",
    properties: Object.assign({}, ...parts.map((p) => p.properties ?? {})),
    required: parts.flatMap((p) => p.required ?? []),
  };
}
