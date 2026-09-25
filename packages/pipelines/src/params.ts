import { NexusError } from "@nexus/shared";
import type { ParamDefinition } from "./definition";

export type ParamValue = string | number | boolean;

/**
 * Turns the parameters a run was started with (from the UI, the API or a schedule) into checked,
 * typed values. Unknown names and wrong types are refused — API callers get a clear message.
 */
export function resolveParams(defs: ParamDefinition[], given: Record<string, unknown> = {}): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  const known = new Set(defs.map((d) => d.name));
  const unknown = Object.keys(given).filter((k) => !known.has(k));
  if (unknown.length) throw NexusError.invalid(`This pipeline has no parameter called ${unknown.join(", ")}.`);
  for (const d of defs) {
    const raw = given[d.name] ?? d.default;
    const label = d.label ?? d.name;
    if (raw === undefined || raw === null || raw === "") throw NexusError.invalid(`Please provide ${label}.`);
    let v: ParamValue;
    switch (d.type) {
      case "number": {
        const n = typeof raw === "number" ? raw : Number(String(raw).trim());
        if (!Number.isFinite(n)) throw NexusError.invalid(`${label} must be a number.`);
        v = n;
        break;
      }
      case "boolean":
        if (typeof raw === "boolean") v = raw;
        else if (/^(true|yes|1)$/i.test(String(raw))) v = true;
        else if (/^(false|no|0)$/i.test(String(raw))) v = false;
        else throw NexusError.invalid(`${label} must be true or false.`);
        break;
      case "date": {
        const s = String(raw).trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`)) || new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) !== s) {
          throw NexusError.invalid(`${label} must be a date like 2025-01-31.`);
        }
        v = s;
        break;
      }
      default:
        if (typeof raw === "object") throw NexusError.invalid(`${label} must be text.`);
        v = String(raw);
        if (v.length > 4000) throw NexusError.invalid(`${label} is too long.`);
    }
    if (d.choices && !d.choices.map(String).includes(String(v))) throw NexusError.invalid(`${label} must be one of: ${d.choices.join(", ")}.`);
    out[d.name] = v;
  }
  return out;
}

/** A value as a SQL literal: 'text' with quotes doubled, numbers and booleans as they are. */
export function sqlLiteral(v: ParamValue | null): string {
  if (v === null) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return `'${v.replace(/'/g, "''")}'`;
}

export interface TemplateScope {
  params: Record<string, ParamValue>;
  /** run.id, run.date, pipeline.name, last_success.date … */
  values: Record<string, ParamValue | null>;
}

const PLACEHOLDER = /\{\{\s*([a-z_]+(?:\.[a-z_][a-z0-9_]*)?)\s*\}\}/g;
/** In SQL a placeholder may be written with or without quotes around it; both become one literal. */
const SQL_PLACEHOLDER = /'\{\{\s*([a-z_]+(?:\.[a-z_][a-z0-9_]*)?)\s*\}\}'|\{\{\s*([a-z_]+(?:\.[a-z_][a-z0-9_]*)?)\s*\}\}/g;

function lookup(name: string, scope: TemplateScope): ParamValue | null {
  if (name.startsWith("params.")) {
    const key = name.slice(7);
    if (!(key in scope.params)) throw NexusError.invalid(`{{${name}}} refers to a parameter that isn't defined.`);
    return scope.params[key]!;
  }
  if (!(name in scope.values)) throw NexusError.invalid(`{{${name}}} isn't a known placeholder.`);
  return scope.values[name] ?? null;
}

/** Fills placeholders in plain text (file paths, URLs, messages). */
export function renderText(text: string, scope: TemplateScope): string {
  return text.replace(PLACEHOLDER, (_, name: string) => {
    const v = lookup(name, scope);
    return v === null ? "" : String(v);
  });
}

/**
 * Fills placeholders in SQL safely: each value becomes a quoted literal, so a parameter (which may
 * come from an API caller) can never change the shape of the query.
 */
export function renderSql(sql: string, scope: TemplateScope): string {
  return sql.replace(SQL_PLACEHOLDER, (_, quoted: string | undefined, bare: string | undefined) => sqlLiteral(lookup((quoted ?? bare)!, scope)));
}

/**
 * Fills every placeholder in a step's configuration. `sqlFields` are dotted paths ("where",
 * "columns.*.expression") whose strings are SQL; everything else is plain text.
 */
export function renderConfig<T>(config: T, scope: TemplateScope, sqlFields: string[] = []): T {
  const isSql = (path: string[]) => sqlFields.some((f) => {
    const parts = f.split(".");
    return parts.length === path.length && parts.every((p, i) => p === "*" || p === path[i]);
  });
  const walk = (v: unknown, path: string[]): unknown => {
    if (typeof v === "string") return isSql(path) ? renderSql(v, scope) : renderText(v, scope);
    if (Array.isArray(v)) return v.map((x, i) => walk(x, [...path, String(i)]));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, [...path, k])]));
    return v;
  };
  return walk(config, []) as T;
}
