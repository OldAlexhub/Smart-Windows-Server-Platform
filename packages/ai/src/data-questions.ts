import type { ChatMessage } from "./runtime";

/**
 * Natural-language data questions: "How many trips did each provider complete last month?"
 * → a single read-only SELECT → a table and, when it fits, a chart.
 *
 * Safety is layered. The checks here reject anything that isn't one plain query before it reaches
 * the database; the database then runs it as a read-only role inside a READ ONLY transaction with a
 * time limit, so even a query that slipped past these checks could not change anything.
 */

// ---------------------------------------------------------------- SQL safety

export type SqlCheck = { ok: true; sql: string } | { ok: false; reason: string };

/**
 * The query must start with SELECT/WITH and be a single statement, so the only ways to write
 * inside it are data-changing WITH clauses (WITH x AS (DELETE …)) and SELECT … INTO. Ordinary
 * column names like "comment" or "load" stay allowed.
 */
const FORBIDDEN_WORDS = ["insert", "update", "delete", "merge", "into", "truncate", "drop", "alter", "create", "grant", "revoke", "copy", "call"];
/** Functions with side effects or access outside the database, and slow-downs. */
const FORBIDDEN_FUNCTIONS = /\b(pg_sleep\w*|pg_read_\w+|pg_ls_\w+|pg_stat_file|pg_file_\w+|lo_\w+|dblink\w*|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|set_config|pg_advisory\w*|pg_try_advisory\w*|nextval|setval|txid_\w+|pg_notify|query_to_xml\w*|table_to_xml\w*|cursor_to_xml\w*|database_to_xml\w*|current_setting)\s*\(/i;

/** Removes string literals, quoted identifiers and comments so keywords inside them don't count. */
export function sqlSkeleton(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      out += " ";
    } else if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 2;
      out += " ";
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c && sql[j + 1] === c) j += 2;
        else if (sql[j] === c) break;
        else j++;
      }
      out += c === "'" ? " '' " : ' "x" ';
      i = j + 1;
    } else if (c === "$") {
      // Dollar-quoted strings: $$…$$ or $tag$…$tag$
      const tag = sql.slice(i).match(/^\$[A-Za-z_]*\$/)?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        i = end < 0 ? sql.length : end + tag.length;
        out += " '' ";
      } else {
        out += c;
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Accepts exactly one SELECT (or WITH … SELECT) query and nothing else. */
export function checkReadOnlySql(input: string): SqlCheck {
  const sql = input.trim().replace(/;\s*$/, "").trim();
  if (!sql) return { ok: false, reason: "The query is empty." };
  if (sql.length > 20_000) return { ok: false, reason: "The query is too long." };
  const skeleton = sqlSkeleton(sql);
  if (skeleton.includes(";")) return { ok: false, reason: "Only one query can be run at a time." };
  const words = skeleton.toLowerCase();
  if (!/^\s*\(*\s*(select|with|values|table)\b/.test(words)) return { ok: false, reason: "Only questions that read data (SELECT) can be answered." };
  for (const w of FORBIDDEN_WORDS) {
    if (new RegExp(`\\b${w}\\b`).test(words)) return { ok: false, reason: `The query contains "${w.toUpperCase()}", which isn't allowed for questions — they can only read data.` };
  }
  const fn = skeleton.match(FORBIDDEN_FUNCTIONS);
  if (fn) return { ok: false, reason: `The query uses ${fn[1]}(), which isn't allowed for questions.` };
  if (/\b(pg_catalog|information_schema)\s*\.\s*(pg_authid|pg_shadow|pg_user_mapping)/i.test(skeleton)) return { ok: false, reason: "The query reads Nexus's own security settings, which isn't allowed." };
  return { ok: true, sql };
}

// ---------------------------------------------------------------- prompt

export interface SchemaTable {
  name: string;
  rowEstimate: number;
  columns: { name: string; type: string; primaryKey?: boolean }[];
}

/** A compact description of the tables for the model (names and types only — never data). */
export function describeSchema(tables: SchemaTable[], maxChars = 12_000): string {
  const lines: string[] = [];
  for (const t of tables) {
    lines.push(`${t.name} (~${t.rowEstimate.toLocaleString("en-US")} rows): ${t.columns.map((c) => `${c.name} ${c.type}${c.primaryKey ? " PK" : ""}`).join(", ")}`);
  }
  let text = lines.join("\n");
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n… (more tables not shown)`;
  return text;
}

export type ChartKind = "bar" | "line" | "none";

export interface SqlAnswerPlan {
  sql: string;
  explanation: string;
  chart: { type: ChartKind; x?: string; y?: string };
}

export function questionPrompt(question: string, schema: string, today: string): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You turn a business question into ONE PostgreSQL SELECT query over the tables below.",
        "Rules: read data only (SELECT or WITH … SELECT); one statement; no semicolons; use only the tables and columns listed;",
        "quote identifiers that need it; give result columns short readable names with AS; add ORDER BY when order matters;",
        "aggregate instead of returning huge row lists; limit plain lists to 200 rows.",
        `Today is ${today}.`,
        'Answer with JSON only: {"sql": "...", "explanation": "one plain sentence saying what the query does", "chart": {"type": "bar" | "line" | "none", "x": "column for labels or dates", "y": "numeric column"}}.',
        "Use a line chart for values over time, a bar chart to compare categories, none otherwise.",
        "",
        "Tables:",
        schema,
      ].join("\n"),
    },
    { role: "user", content: question.slice(0, 2000) },
  ];
}

/** Asks the model to fix its own query once, with the database's error message. */
export function repairPrompt(previous: ChatMessage[], sql: string, error: string): ChatMessage[] {
  return [
    ...previous,
    { role: "assistant", content: JSON.stringify({ sql }) },
    { role: "user", content: `That query failed with: ${error.slice(0, 500)}\nReturn a corrected query in the same JSON format.` },
  ];
}

/** Reads the model's JSON (tolerating code fences and extra words around it). */
export function parseAnswerPlan(text: string): SqlAnswerPlan | null {
  const cleaned = text.replace(/```(?:json|sql)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) {
    // A bare query is still usable.
    return /^\s*(select|with)\b/i.test(cleaned) ? { sql: cleaned, explanation: "", chart: { type: "none" } } : null;
  }
  try {
    const j = JSON.parse(cleaned.slice(start, end + 1)) as { sql?: unknown; explanation?: unknown; chart?: { type?: unknown; x?: unknown; y?: unknown } };
    if (typeof j.sql !== "string" || !j.sql.trim()) return null;
    const type = j.chart?.type === "bar" || j.chart?.type === "line" ? j.chart.type : "none";
    return {
      sql: j.sql.trim(),
      explanation: typeof j.explanation === "string" ? j.explanation.slice(0, 500) : "",
      chart: { type, ...(typeof j.chart?.x === "string" ? { x: j.chart.x } : {}), ...(typeof j.chart?.y === "string" ? { y: j.chart.y } : {}) },
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- chart

export interface ResultColumn {
  name: string;
  /** "number" | "date" | "text" | "boolean" | "other" */
  kind: "number" | "date" | "text" | "boolean" | "other";
}

export interface ChartSpec {
  type: "bar" | "line";
  x: string;
  /** One or more numeric series. */
  y: string[];
}

/**
 * Keeps the model's chart suggestion only if it fits the actual result; otherwise picks one:
 * dates + numbers → line, a few categories + numbers → bar, anything else → no chart.
 */
export function chooseChart(suggested: SqlAnswerPlan["chart"], columns: ResultColumn[], rowCount: number): ChartSpec | null {
  if (rowCount < 2 || rowCount > 500 || columns.length < 2) return null;
  const numeric = columns.filter((c) => c.kind === "number").map((c) => c.name);
  const labels = columns.filter((c) => c.kind === "date" || c.kind === "text");
  if (!numeric.length || !labels.length) return null;
  if (suggested.type !== "none" && suggested.x && labels.some((c) => c.name === suggested.x)) {
    const y = suggested.y && numeric.includes(suggested.y) ? [suggested.y] : numeric.slice(0, 4);
    const x = labels.find((c) => c.name === suggested.x)!;
    const type = x.kind === "date" ? "line" : suggested.type;
    if (type === "bar" && rowCount > 40) return null;
    return { type, x: x.name, y };
  }
  const date = labels.find((c) => c.kind === "date");
  if (date) return { type: "line", x: date.name, y: numeric.slice(0, 4) };
  if (rowCount <= 40) return { type: "bar", x: labels[0]!.name, y: numeric.slice(0, 4) };
  return null;
}

/** PostgreSQL type name → result column kind (from the driver's field type OIDs, via their names). */
export function columnKind(pgType: string): ResultColumn["kind"] {
  const t = pgType.toLowerCase();
  if (/^(int|smallint|bigint|numeric|decimal|real|double|float|money|oid)/.test(t)) return "number";
  if (/^(date|timestamp|time)/.test(t)) return "date";
  if (/^(bool)/.test(t)) return "boolean";
  if (/^(text|varchar|character|char|name|citext|uuid|bpchar)/.test(t)) return "text";
  return "other";
}
