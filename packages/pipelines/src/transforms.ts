import { attachInput, ident, writeDataset, type Dataset } from "./duck";
import { StepError } from "./errors";
import type { QualityResult, StepContext, StepExecutor, StepResult } from "./executor";
import { sqlLiteral } from "./params";

/**
 * Built-in transforms. Each runs in the step's sandboxed DuckDB, reads its inputs as views and
 * writes one Parquet file — fast on large data (DuckDB spills to disk instead of running out of memory).
 */

/** DuckDB error → a permanent step failure with the technical message kept for Advanced mode. */
function sqlFailure(what: string, e: unknown): StepError {
  const msg = (e as Error).message ?? String(e);
  const column = msg.match(/Referenced column "([^"]+)" not found/i)?.[1];
  const friendly = column ? `${what}: the column "${column}" doesn't exist in the incoming data.` : `${what}: ${msg.split("\n")[0]}`;
  return new StepError(friendly, { technical: msg, cause: e });
}

async function withInputs<T>(ctx: StepContext, fn: (sb: Awaited<ReturnType<StepContext["sandbox"]>>) => Promise<T>): Promise<T> {
  const sb = await ctx.sandbox();
  try {
    for (const input of ctx.inputs) await attachInput(sb, input.id, input.dataset);
    if (ctx.inputs.length === 1) await attachInput(sb, "input", ctx.inputs[0]!.dataset);
    return await fn(sb);
  } finally {
    sb.close();
  }
}

const rowsIn = (ctx: StepContext) => ctx.inputs.reduce((n, i) => n + i.dataset.rows, 0);

function result(ctx: StepContext, output: Dataset, extra: Partial<StepResult> = {}): StepResult {
  return { output, ...extra, metrics: { rowsIn: rowsIn(ctx), rowsOut: output.rows, bytesOut: output.bytes, ...extra.metrics } };
}

const sqlStep: StepExecutor = {
  kind: "sql",
  run: (ctx) =>
    withInputs(ctx, async (sb) => {
      const query = String(ctx.config.query).trim().replace(/;\s*$/, "");
      if (/;/.test(query.replace(/'(?:[^']|'')*'/g, ""))) throw new StepError("SQL step: write one query (no semicolons between statements).");
      try {
        return result(ctx, await writeDataset(sb, query, ctx.outputPath));
      } catch (e) {
        throw sqlFailure("SQL step", e);
      }
    }),
};

const filter: StepExecutor = {
  kind: "filter",
  run: (ctx) =>
    withInputs(ctx, async (sb) => {
      try {
        const out = await writeDataset(sb, `SELECT * FROM input WHERE (${String(ctx.config.where)})`, ctx.outputPath);
        return result(ctx, out);
      } catch (e) {
        throw sqlFailure("Filter", e);
      }
    }),
};

const transform: StepExecutor = {
  kind: "transform",
  run: (ctx) =>
    withInputs(ctx, async (sb) => {
      const cfg = ctx.config as { columns: { name: string; expression?: string }[]; keepOthers: boolean };
      const listed = cfg.columns.map((c) => (c.expression ? `(${c.expression}) AS ${ident(c.name)}` : ident(c.name)));
      const inputCols = ctx.inputs[0]!.dataset.columns.map((c) => c.name);
      const names = new Set(cfg.columns.map((c) => c.name));
      const others = cfg.keepOthers ? inputCols.filter((c) => !names.has(c)).map(ident) : [];
      try {
        return result(ctx, await writeDataset(sb, `SELECT ${[...others, ...listed].join(", ")} FROM input`, ctx.outputPath));
      } catch (e) {
        throw sqlFailure("Transform columns", e);
      }
    }),
};

const join: StepExecutor = {
  kind: "join",
  run: (ctx) =>
    withInputs(ctx, async (sb) => {
      const cfg = ctx.config as { type: "inner" | "left" | "right" | "full"; on: { left: string; right: string }[] };
      const [left, right] = ctx.inputs as [{ id: string; dataset: Dataset }, { id: string; dataset: Dataset }];
      await attachInput(sb, "__l", left.dataset);
      await attachInput(sb, "__r", right.dataset);
      const leftCols = left.dataset.columns.map((c) => c.name);
      const taken = new Set(leftCols);
      const rightKeys = new Map(cfg.on.map((k) => [k.right, k.left]));
      // Same-named keys appear once; other clashing right-hand columns get the step name as a suffix.
      const rightCols = right.dataset.columns
        .map((c) => c.name)
        .filter((c) => !(rightKeys.get(c) === c))
        .map((c) => (taken.has(c) ? `__r.${ident(c)} AS ${ident(`${c}_${right.id.replace(/-/g, "_")}`)}` : `__r.${ident(c)}`));
      const on = cfg.on.map((k) => `__l.${ident(k.left)} = __r.${ident(k.right)}`).join(" AND ");
      const select = [...leftCols.map((c) => `__l.${ident(c)}`), ...rightCols].join(", ");
      try {
        return result(ctx, await writeDataset(sb, `SELECT ${select} FROM __l ${cfg.type.toUpperCase()} JOIN __r ON ${on}`, ctx.outputPath));
      } catch (e) {
        throw sqlFailure("Join", e);
      }
    }),
};

const aggregate: StepExecutor = {
  kind: "aggregate",
  run: (ctx) =>
    withInputs(ctx, async (sb) => {
      const cfg = ctx.config as { groupBy: string[]; measures: { name: string; fn: string; column?: string }[] };
      const measure = (m: { name: string; fn: string; column?: string }) => {
        const col = m.column ? ident(m.column) : "*";
        const expr = m.fn === "count" ? `count(${col})` : m.fn === "count_distinct" ? `count(DISTINCT ${col})` : `${m.fn}(${col})`;
        return `${expr} AS ${ident(m.name)}`;
      };
      const select = [...cfg.groupBy.map(ident), ...cfg.measures.map(measure)].join(", ");
      const group = cfg.groupBy.length ? ` GROUP BY ${cfg.groupBy.map(ident).join(", ")} ORDER BY ${cfg.groupBy.map(ident).join(", ")}` : "";
      try {
        return result(ctx, await writeDataset(sb, `SELECT ${select} FROM input${group}`, ctx.outputPath));
      } catch (e) {
        throw sqlFailure("Aggregate", e);
      }
    }),
};

const deduplicate: StepExecutor = {
  kind: "deduplicate",
  run: (ctx) =>
    withInputs(ctx, async (sb) => {
      const cols = (ctx.config.columns as string[]) ?? [];
      const query = cols.length
        ? `SELECT * EXCLUDE (__rn) FROM (SELECT *, row_number() OVER (PARTITION BY ${cols.map(ident).join(", ")}) AS __rn FROM input) WHERE __rn = 1`
        : "SELECT DISTINCT * FROM input";
      try {
        const out = await writeDataset(sb, query, ctx.outputPath);
        const removed = rowsIn(ctx) - out.rows;
        if (removed) ctx.log("info", `Removed ${removed.toLocaleString("en-US")} duplicate ${removed === 1 ? "row" : "rows"}.`);
        return result(ctx, out, { metrics: { extra: { removed } } });
      } catch (e) {
        throw sqlFailure("Remove duplicates", e);
      }
    }),
};

type Rule = { column: string; check: "not_null" | "unique" | "min" | "max" | "matches" | "one_of"; value?: string | number | (string | number)[] };

/** SQL condition that is TRUE for rows breaking the rule. */
function failing(r: Rule): string {
  const c = ident(r.column);
  switch (r.check) {
    case "not_null":
      return `${c} IS NULL`;
    case "unique":
      return `${c} IN (SELECT ${c} FROM input WHERE ${c} IS NOT NULL GROUP BY ${c} HAVING count(*) > 1)`;
    case "min":
      return `${c} < ${sqlLiteral(r.value as string | number)}`;
    case "max":
      return `${c} > ${sqlLiteral(r.value as string | number)}`;
    case "matches":
      return `${c} IS NOT NULL AND NOT regexp_full_match(CAST(${c} AS VARCHAR), ${sqlLiteral(String(r.value))})`;
    case "one_of":
      return `${c} IS NOT NULL AND ${c} NOT IN (${(r.value as (string | number)[]).map((v) => sqlLiteral(v)).join(", ")})`;
  }
}

const describeRule = (r: Rule) =>
  ({
    not_null: `${r.column} is filled in`,
    unique: `${r.column} is unique`,
    min: `${r.column} ≥ ${r.value}`,
    max: `${r.column} ≤ ${r.value}`,
    matches: `${r.column} matches ${r.value}`,
    one_of: `${r.column} is one of ${Array.isArray(r.value) ? r.value.join(", ") : r.value}`,
  })[r.check];

const validate: StepExecutor = {
  kind: "validate",
  run: (ctx) =>
    withInputs(ctx, async (sb) => {
      const cfg = ctx.config as { rules: Rule[]; onFailure: "fail" | "warn" | "drop" };
      const quality: QualityResult[] = [];
      try {
        for (const r of cfg.rules) {
          const [row] = await sb.rows<{ n: number }>(`SELECT count(*)::BIGINT AS n FROM input WHERE ${failing(r)}`);
          quality.push({ rule: describeRule(r), failedRows: Number(row?.n ?? 0), passed: !row?.n });
        }
      } catch (e) {
        throw sqlFailure("Validate", e);
      }
      const failed = quality.filter((q) => !q.passed);
      const summary = failed.map((q) => `${q.rule}: ${q.failedRows.toLocaleString("en-US")} ${q.failedRows === 1 ? "row fails" : "rows fail"}`);
      if (failed.length && cfg.onFailure === "fail") {
        throw new StepError(`Data quality check failed — ${summary.join("; ")}.`, { problem: { title: "Data quality check failed", summary: summary.join(". "), checks: quality.map((q) => ({ label: q.rule, status: q.passed ? "ok" : "failed", detail: q.passed ? undefined : `${q.failedRows} rows` })) } });
      }
      const query = failed.length && cfg.onFailure === "drop" ? `SELECT * FROM input WHERE NOT (${cfg.rules.map((r) => `coalesce(${failing(r)}, false)`).join(" OR ")})` : "SELECT * FROM input";
      const out = await writeDataset(sb, query, ctx.outputPath);
      const warnings = failed.length ? [cfg.onFailure === "drop" ? `Removed ${(rowsIn(ctx) - out.rows).toLocaleString("en-US")} rows that failed checks (${summary.join("; ")}).` : `Data quality: ${summary.join("; ")}.`] : [];
      return result(ctx, out, { warnings, metrics: { quality } });
    }),
};

const notify: StepExecutor = {
  kind: "notify",
  async run(ctx) {
    const message = String(ctx.config.message);
    if (ctx.testRows === null && ctx.services.notify) await ctx.services.notify(message, { pipelineId: ctx.pipelineId, runId: ctx.runId, stepId: ctx.step.id });
    ctx.log("info", ctx.testRows === null ? `Notification: ${message}` : `Notification (not sent in test mode): ${message}`);
    return { output: null, metrics: { rowsIn: rowsIn(ctx) } };
  },
};

export const BUILTIN_TRANSFORMS: StepExecutor[] = [sqlStep, filter, transform, join, aggregate, deduplicate, validate, notify];
