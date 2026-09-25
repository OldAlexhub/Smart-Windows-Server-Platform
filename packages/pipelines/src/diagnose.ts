import { block } from "./blocks";
import type { NormalizedPipeline } from "./definition";
import type { PipelineRun } from "./runs";

/** A plain explanation of why a run failed, worked out from the run itself (no AI needed). */
export interface RunDiagnosis {
  stepId: string | null;
  title: string;
  summary: string;
  details: string[];
  suggestions: string[];
  /** Columns the failing step expected but its input no longer has, and columns that appeared. */
  schemaChange: { missing: string[]; added: string[]; likelyRenames: { from: string; to: string }[] } | null;
}

/** Column names a failure message says are missing (SQL, Python, R, DuckDB wordings). */
export function missingColumns(error: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /column "([^"]+)" (?:does not exist|doesn't exist)/gi,
    /Referenced column "([^"]+)" not found/gi,
    /object ['‘"]([^'’"]+)['’"] not found/gi,
    /looked for "([^"]+)", which isn't there/gi,
    /refers to "([^"]+)", which doesn't exist/gi,
    /KeyError: '([^']+)'/g,
    /column (?:named )?['"]?([A-Za-z_][\w]*)['"]? (?:not found|is missing)/gi,
  ];
  for (const re of patterns) for (const m of error.matchAll(re)) found.add(m[1]!);
  return [...found];
}

/** How alike two column names are (0–1), for spotting renames like provider_id → provider_code. */
export function similarity(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) return 1;
  const tokens = (s: string) => new Set(s.split(/[_\-\s]+|(?<=[a-z])(?=[A-Z])/).filter(Boolean));
  const ta = tokens(x);
  const tb = tokens(y);
  const shared = [...ta].filter((t) => tb.has(t)).length;
  const tokenScore = shared / Math.max(ta.size, tb.size);
  // Levenshtein distance, normalised.
  const d: number[][] = Array.from({ length: x.length + 1 }, (_, i) => [i, ...Array(y.length).fill(0)]);
  for (let j = 1; j <= y.length; j++) d[0]![j] = j;
  for (let i = 1; i <= x.length; i++) for (let j = 1; j <= y.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
  const editScore = 1 - d[x.length]![y.length]! / Math.max(x.length, y.length);
  return Math.max(tokenScore, editScore);
}

const columnsOf = (run: PipelineRun, stepIds: string[]) => new Set(run.steps.filter((s) => stepIds.includes(s.stepId)).flatMap((s) => s.output?.columns.map((c) => c.name) ?? []));

/**
 * Explains a failed run. Compares what the failing step received now with what it received the
 * last time the pipeline worked, which catches the most common cause of a pipeline breaking:
 * the source changed (a column renamed or removed).
 */
export function diagnoseRun(pipeline: NormalizedPipeline, run: PipelineRun, lastGood: PipelineRun | null): RunDiagnosis | null {
  if (run.status !== "failed" && run.status !== "partial") return null;
  const failed = run.steps.find((s) => s.status === "failed");
  if (!failed) {
    return { stepId: null, title: "The run was stopped", summary: run.error ?? "The run didn't finish.", details: [], suggestions: /time limit/.test(run.error ?? "") ? ["Raise the pipeline's time limit, or test with fewer rows to see which step is slow."] : ["Start the run again, or resume it from where it stopped."], schemaChange: null };
  }
  const step = pipeline.steps.find((s) => s.id === failed.stepId);
  const spec = step ? block(step.uses) : undefined;
  const label = step?.name ?? failed.stepId;
  const error = failed.error ?? run.error ?? "";
  const details: string[] = [];
  const suggestions: string[] = [];

  // Did the input change since it last worked?
  const missing = missingColumns(error);
  let schemaChange: RunDiagnosis["schemaChange"] = null;
  if (step?.needs.length && missing.length) {
    const now = columnsOf(run, step.needs);
    const before = lastGood ? columnsOf(lastGood, step.needs) : new Set<string>();
    const gone = missing.filter((c) => !now.has(c));
    const added = [...now].filter((c) => before.size && !before.has(c));
    const renames = gone
      .map((from) => {
        const best = added.map((to) => ({ to, score: similarity(from, to) })).sort((a, b) => b.score - a.score)[0];
        return best && best.score >= 0.4 ? { from, to: best.to } : null;
      })
      .filter((r): r is { from: string; to: string } => !!r);
    schemaChange = { missing: gone, added, likelyRenames: renames };
    if (gone.length && before.size && gone.some((c) => before.has(c))) {
      const r = renames[0];
      const title = "The incoming data changed";
      const summary = r
        ? `The data coming into ${label} no longer contains ${r.from}. It now has ${r.to} instead — the source probably renamed ${r.from} to ${r.to}.`
        : `The data coming into ${label} no longer contains ${gone.join(", ")}, which it had the last time this pipeline worked.`;
      if (added.length) details.push(`New columns since the last successful run: ${added.join(", ")}.`);
      details.push(`Columns ${label} receives now: ${[...now].join(", ") || "none"}.`);
      suggestions.push(r ? `Update ${label} to use ${r.to} instead of ${r.from}, or rename the column back where the data comes from.` : `Check where ${gone.join(", ")} went in the source, or update ${label} to stop using it.`);
      return { stepId: failed.stepId, title, summary, details, suggestions, schemaChange };
    }
    if (gone.length && now.size) {
      // A typo or wrong name in the step: suggest the closest column it does receive.
      const closest = [...now].map((c) => ({ c, score: similarity(gone[0]!, c) })).sort((a, b) => b.score - a.score)[0];
      const guess = closest && closest.score >= 0.4 ? closest.c : null;
      return {
        stepId: failed.stepId,
        title: `${label} uses a column the data doesn't have`,
        summary: `${label} refers to ${gone.join(", ")}, but the incoming data has no such column.`,
        details: [`Columns available: ${[...now].join(", ")}.`],
        suggestions: [guess ? `Did you mean ${guess}?` : `Use one of the available columns in ${label}.`],
        schemaChange,
      };
    }
  }

  // Other common situations.
  if (/doesn't exist|No files match|Source file missing/i.test(error) && spec?.category === "source") {
    return { stepId: failed.stepId, title: "The source wasn't there", summary: error, details: [], suggestions: ["Check the file or table name and that it has arrived. If files arrive later, schedule the pipeline to run when a file arrives."], schemaChange };
  }
  if (/isn't reachable|didn't answer|busy or having trouble/i.test(error)) {
    return { stepId: failed.stepId, title: "A system it depends on wasn't available", summary: error, details: [`It was tried ${failed.attempts} time${failed.attempts === 1 ? "" : "s"}.`], suggestions: ["Check the other system is running; Nexus retries temporary problems automatically. Resume the run once it's back."], schemaChange };
  }
  if (/refused the (connection details|credentials)|secret "[^"]+" isn't set up/i.test(error)) {
    return { stepId: failed.stepId, title: "The login details didn't work", summary: error, details: [], suggestions: ["Update the saved secret under Pipelines › Secrets, then resume the run."], schemaChange };
  }
  if (/Data quality check failed/i.test(error)) {
    return { stepId: failed.stepId, title: "The data didn't pass its quality checks", summary: error, details: [], suggestions: ["Look at the rows that fail (preview the step before it), fix them at the source, or change the check to warn or drop failing rows."], schemaChange };
  }
  if (spec?.kind === "python" || spec?.kind === "r") {
    return { stepId: failed.stepId, title: `The ${spec.label.toLowerCase()} stopped with an error`, summary: error, details: [], suggestions: ["Open the step's log for the full error, fix the script, and resume the run — earlier steps won't run again."], schemaChange };
  }
  return { stepId: failed.stepId, title: `${label} failed`, summary: error, details: [], suggestions: ["Resume the run once the problem is fixed; steps that already worked are reused."], schemaChange };
}
