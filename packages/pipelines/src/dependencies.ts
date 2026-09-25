import type { PipelineRecord } from "./store";

export type DependencyProblemCode = "missing" | "self" | "duplicate" | "cycle";

export interface DependencyProblem {
  pipelineId: string;
  code: DependencyProblemCode;
  message: string;
  reference?: string;
}

export interface ResolvedDependency {
  reference: string;
  pipeline: PipelineRecord;
}

/** Resolves cross-pipeline references and validates the dependency graph as a whole. */
export class PipelineDependencyGraph {
  private readonly byId = new Map<string, PipelineRecord>();
  private readonly byReference = new Map<string, PipelineRecord>();
  private readonly problemMap = new Map<string, DependencyProblem[]>();

  constructor(readonly pipelines: PipelineRecord[]) {
    for (const pipeline of pipelines) {
      this.byId.set(pipeline.id, pipeline);
      this.byReference.set(pipeline.id, pipeline);
      this.byReference.set(pipeline.slug, pipeline);
    }
    for (const pipeline of pipelines) this.validateReferences(pipeline);
    for (const pipeline of pipelines) this.validateCycle(pipeline);
  }

  get(id: string): PipelineRecord | undefined {
    return this.byId.get(id);
  }

  resolve(reference: string): PipelineRecord | undefined {
    return this.byReference.get(reference);
  }

  dependencies(pipelineId: string): ResolvedDependency[] {
    const pipeline = this.byId.get(pipelineId);
    if (!pipeline || pipeline.definition.schedule.type !== "after") return [];
    return pipeline.definition.schedule.pipelines.flatMap((reference) => {
      const dependency = this.resolve(reference);
      return dependency ? [{ reference, pipeline: dependency }] : [];
    });
  }

  /** Pipelines that directly wait for this upstream pipeline. */
  directDownstream(pipelineId: string): PipelineRecord[] {
    return this.pipelines.filter((candidate) =>
      this.dependencies(candidate.id).some((dependency) => dependency.pipeline.id === pipelineId),
    );
  }

  /** Every downstream pipeline, nearest first and without duplicates. */
  downstream(pipelineId: string): PipelineRecord[] {
    const found: PipelineRecord[] = [];
    const seen = new Set([pipelineId]);
    const queue = [pipelineId];
    while (queue.length) {
      for (const pipeline of this.directDownstream(queue.shift()!)) {
        if (seen.has(pipeline.id)) continue;
        seen.add(pipeline.id);
        found.push(pipeline);
        queue.push(pipeline.id);
      }
    }
    return found;
  }

  problems(pipelineId?: string): DependencyProblem[] {
    if (pipelineId) return [...(this.problemMap.get(pipelineId) ?? [])];
    return this.pipelines.flatMap((pipeline) => this.problems(pipeline.id));
  }

  private validateReferences(pipeline: PipelineRecord): void {
    if (pipeline.definition.schedule.type !== "after") return;
    const resolved = new Set<string>();
    for (const reference of pipeline.definition.schedule.pipelines) {
      const dependency = this.resolve(reference);
      if (!dependency) {
        this.add({
          pipelineId: pipeline.id,
          code: "missing",
          reference,
          message: `Upstream pipeline "${reference}" no longer exists.`,
        });
      } else if (dependency.id === pipeline.id) {
        this.add({
          pipelineId: pipeline.id,
          code: "self",
          reference,
          message: `"${pipeline.name}" can't depend on itself.`,
        });
      } else if (resolved.has(dependency.id)) {
        this.add({
          pipelineId: pipeline.id,
          code: "duplicate",
          reference,
          message: `"${dependency.name}" is listed more than once as an upstream pipeline.`,
        });
      } else {
        resolved.add(dependency.id);
      }
    }
  }

  private validateCycle(pipeline: PipelineRecord): void {
    if (this.problemMap.get(pipeline.id)?.some((problem) => problem.code !== "cycle")) return;
    const path: PipelineRecord[] = [];
    const visiting = new Set<string>();
    const visit = (current: PipelineRecord): PipelineRecord[] | null => {
      const repeated = path.findIndex((item) => item.id === current.id);
      if (repeated >= 0) return [...path.slice(repeated), current];
      if (visiting.has(current.id)) return null;
      visiting.add(current.id);
      path.push(current);
      for (const dependency of this.dependencies(current.id)) {
        const cycle = visit(dependency.pipeline);
        if (cycle) return cycle;
      }
      path.pop();
      return null;
    };
    const cycle = visit(pipeline);
    if (cycle) {
      this.add({
        pipelineId: pipeline.id,
        code: "cycle",
        message: `Pipeline dependency cycle: ${cycle.map((item) => item.name).join(" → ")}. Remove one of these links.`,
      });
    }
  }

  private add(problem: DependencyProblem): void {
    this.problemMap.set(problem.pipelineId, [...(this.problemMap.get(problem.pipelineId) ?? []), problem]);
  }
}
