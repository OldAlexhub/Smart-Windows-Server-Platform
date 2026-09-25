import { canonical, type NormalizedPipeline } from "./definition";

export type PipelineChangeKind = "added" | "removed" | "changed" | "reordered";

export interface PipelineChange {
  kind: PipelineChangeKind;
  /** Stable designer-friendly path, e.g. steps.clean.with.columns or schedule.at. */
  path: string;
  before?: unknown;
  after?: unknown;
}

const same = (before: unknown, after: unknown) => canonical(before) === canonical(after);
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function compare(path: string, before: unknown, after: unknown, changes: PipelineChange[]): void {
  if (same(before, after)) return;
  if (before === undefined) return void changes.push({ kind: "added", path, after });
  if (after === undefined) return void changes.push({ kind: "removed", path, before });
  if (object(before) && object(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const key of keys) compare(`${path}.${key}`, before[key], after[key], changes);
    return;
  }
  changes.push({ kind: "changed", path, before, after });
}

function keyed(
  path: "params" | "steps",
  before: Record<string, unknown>[],
  after: Record<string, unknown>[],
  key: "name" | "id",
  changes: PipelineChange[],
): void {
  const old = new Map(before.map((item) => [String(item[key]), item]));
  const next = new Map(after.map((item) => [String(item[key]), item]));
  for (const id of old.keys())
    if (!next.has(id)) changes.push({ kind: "removed", path: `${path}.${id}`, before: old.get(id) });
  for (const id of next.keys())
    if (!old.has(id)) changes.push({ kind: "added", path: `${path}.${id}`, after: next.get(id) });
  for (const id of old.keys()) {
    if (!next.has(id)) continue;
    const from = { ...old.get(id) };
    const to = { ...next.get(id) };
    delete from[key];
    delete to[key];
    if (path === "steps") {
      delete from.position;
      delete to.position;
    }
    compare(`${path}.${id}`, from, to, changes);
  }
  const shared = new Set([...old.keys()].filter((id) => next.has(id)));
  const oldOrder = before.map((item) => String(item[key])).filter((id) => shared.has(id));
  const nextOrder = after.map((item) => String(item[key])).filter((id) => shared.has(id));
  if (!same(oldOrder, nextOrder)) changes.push({ kind: "reordered", path, before: oldOrder, after: nextOrder });
}

/** Semantic pipeline diff: keyed params/steps avoid noisy index shifts and designer positions are ignored. */
export function diffPipelineDefinitions(before: NormalizedPipeline, after: NormalizedPipeline): PipelineChange[] {
  const changes: PipelineChange[] = [];
  for (const field of ["name", "description", "schedule", "retry", "resources", "notifications"] as const) {
    compare(field, before[field], after[field], changes);
  }
  keyed(
    "params",
    before.params as unknown as Record<string, unknown>[],
    after.params as unknown as Record<string, unknown>[],
    "name",
    changes,
  );
  keyed(
    "steps",
    before.steps as unknown as Record<string, unknown>[],
    after.steps as unknown as Record<string, unknown>[],
    "id",
    changes,
  );
  return changes;
}
