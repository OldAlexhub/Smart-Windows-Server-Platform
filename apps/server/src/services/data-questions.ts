import { checkReadOnlySql, chooseChart, columnKind, describeSchema, parseAnswerPlan, questionPrompt, repairPrompt, type ChartSpec, type ChatMessage, type ResultColumn, type SchemaTable, type SqlAnswerPlan } from "@nexus/ai";
import { NexusError } from "@nexus/shared";
import type { NexusContext } from "../context";

/** The local model, as far as data questions need it. */
export interface QuestionModel {
  chat(messages: ChatMessage[], opts: { json: boolean }): Promise<string>;
}

export interface DataAnswer {
  question: string | null;
  sql: string;
  explanation: string;
  /** One or two sentences answering the question from the results (when the model is available). */
  summary: string | null;
  columns: ResultColumn[];
  rows: Record<string, unknown>[];
  /** More rows exist than are shown. */
  truncated: boolean;
  chart: ChartSpec | null;
  /** The first query failed and the model corrected it. */
  repaired: boolean;
  durationMs: number;
}

const MAX_ROWS = 1000;
const MAX_TABLES = 60;

function friendlyDbError(message: string): string {
  if (/canceling statement due to statement timeout/i.test(message)) return "The question took too long to answer (over 15 seconds). Try asking about a shorter period or fewer things at once.";
  if (/read-only transaction/i.test(message)) return "That would change data, and questions can only read it.";
  if (/permission denied/i.test(message)) return "That needs data the question isn't allowed to read.";
  return message.split("\n")[0]!;
}

/**
 * "Ask a question about your data." The model writes one SELECT; Nexus checks it, runs it as the
 * database's read-only role in a read-only transaction with a time limit, and returns the rows with
 * a suggested chart. Data never goes to the model except the first rows, locally, for the summary.
 */
export class DataQuestionService {
  constructor(
    private readonly ctx: NexusContext,
    /** Returns the model when AI is ready; null otherwise. */
    private readonly model: () => QuestionModel | null,
  ) {}

  private need() {
    if (!this.ctx.databases || !this.ctx.dataBrowser) throw NexusError.conflict("The database server isn't available yet.");
    return { dbs: this.ctx.databases, browser: this.ctx.dataBrowser };
  }

  /** Table and column names only (never data), for the model. */
  async schema(databaseId: string): Promise<SchemaTable[]> {
    const { browser } = this.need();
    const tables = (await browser.listTables(databaseId)).slice(0, MAX_TABLES);
    return Promise.all(
      tables.map(async (t) => {
        const info = await browser.describe(databaseId, t.name);
        return { name: t.name, rowEstimate: t.rowEstimate, columns: info.columns.map((c) => ({ name: c.name, type: c.type, primaryKey: c.primaryKey })) };
      }),
    );
  }

  async ask(databaseId: string, question: string): Promise<DataAnswer> {
    const q = question.trim();
    if (!q) throw NexusError.invalid("Please type a question.");
    const model = this.model();
    if (!model) {
      throw new NexusError("conflict", "Questions in plain English need the AI to be ready.", {
        problem: {
          title: "AI isn't ready",
          summary: "The local AI model is off, still downloading, or not installed. You can still write a SQL query yourself.",
          checks: [{ label: "AI model", status: "failed" }],
          repair: { id: "ai.open-settings", label: "Open AI settings", requiresConfirmation: false },
        },
      });
    }
    const started = Date.now();
    const schema = await this.schema(databaseId);
    if (!schema.length) throw NexusError.conflict("This database has no tables yet, so there is nothing to ask about.");
    const messages = questionPrompt(q, describeSchema(schema), new Date().toISOString().slice(0, 10));
    let plan = await this.plan(model, messages);
    let repaired = false;
    let result: Awaited<ReturnType<DataQuestionService["run"]>>;
    try {
      result = await this.run(databaseId, plan.sql);
    } catch (e) {
      if (!(e instanceof DbError)) throw e;
      // One chance for the model to fix its own query, with the database's message.
      plan = await this.plan(model, repairPrompt(messages, plan.sql, e.message));
      repaired = true;
      try {
        result = await this.run(databaseId, plan.sql);
      } catch (e2) {
        throw NexusError.invalid(`Nexus couldn't answer that: ${friendlyDbError((e2 as Error).message)} Try rephrasing the question.`);
      }
    }
    const chart = chooseChart(plan.chart, result.columns, result.rows.length);
    const summary = await this.summarize(model, q, result).catch(() => null);
    return { question: q, sql: plan.sql, explanation: plan.explanation, summary, ...result, chart, repaired, durationMs: Date.now() - started };
  }

  /** Runs SQL someone typed, with exactly the same checks and read-only protection. */
  async query(databaseId: string, sql: string): Promise<DataAnswer> {
    const started = Date.now();
    try {
      const result = await this.run(databaseId, sql);
      return { question: null, sql: sql.trim(), explanation: "", summary: null, ...result, chart: chooseChart({ type: "none" }, result.columns, result.rows.length), repaired: false, durationMs: Date.now() - started };
    } catch (e) {
      if (e instanceof DbError) throw NexusError.invalid(friendlyDbError(e.message));
      throw e;
    }
  }

  private async plan(model: QuestionModel, messages: ChatMessage[]): Promise<SqlAnswerPlan> {
    let text: string;
    try {
      text = await model.chat(messages, { json: true });
    } catch (e) {
      throw new NexusError("infrastructure", `The AI didn't answer: ${(e as Error).message}`);
    }
    const plan = parseAnswerPlan(text);
    if (!plan) throw NexusError.invalid("The AI couldn't turn that into a query. Try rephrasing the question.");
    return plan;
  }

  private async run(databaseId: string, input: string): Promise<{ columns: ResultColumn[]; rows: Record<string, unknown>[]; truncated: boolean }> {
    const check = checkReadOnlySql(input);
    if (!check.ok) throw NexusError.invalid(check.reason);
    const { dbs } = this.need();
    try {
      return await dbs.withReadOnly(databaseId, async (c) => {
        const r = await c.query({ text: `SELECT * FROM (${check.sql}) AS nexus_answer LIMIT ${MAX_ROWS + 1}` });
        const oids = [...new Set(r.fields.map((f) => f.dataTypeID))];
        const types = new Map((await c.query<{ oid: number; typname: string }>("SELECT oid::int AS oid, typname FROM pg_type WHERE oid = ANY($1)", [oids])).rows.map((t) => [t.oid, t.typname]));
        const columns: ResultColumn[] = r.fields.map((f) => ({ name: f.name, kind: columnKind(types.get(f.dataTypeID) ?? "") }));
        const dateOnly = new Set(r.fields.filter((f) => types.get(f.dataTypeID) === "date").map((f) => f.name));
        const rows = r.rows.slice(0, MAX_ROWS).map((row) =>
          Object.fromEntries(
            columns.map((col) => {
              const v = (row as Record<string, unknown>)[col.name];
              if (v instanceof Date) return [col.name, dateOnly.has(col.name) ? v.toISOString().slice(0, 10) : v.toISOString()];
              if (col.kind === "number" && typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return [col.name, Number(v)];
              return [col.name, v];
            }),
          ),
        );
        return { columns, rows, truncated: r.rows.length > MAX_ROWS };
      });
    } catch (e) {
      if (e instanceof NexusError) throw e;
      throw new DbError((e as Error).message);
    }
  }

  private async summarize(model: QuestionModel, question: string, result: { columns: ResultColumn[]; rows: Record<string, unknown>[]; truncated: boolean }): Promise<string | null> {
    if (!result.rows.length) return "No data matches that question.";
    const sample = JSON.stringify(result.rows.slice(0, 30));
    const text = await model.chat(
      [
        { role: "system", content: "Answer the question in one or two plain sentences using only these query results. Mention the key numbers. No SQL, no markdown." },
        { role: "user", content: `Question: ${question}\nResults (${result.rows.length}${result.truncated ? "+" : ""} rows, first ones shown): ${sample.slice(0, 6000)}` },
      ],
      { json: false },
    );
    return text.trim().slice(0, 600) || null;
  }
}

class DbError extends Error {}
