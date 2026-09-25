import { isNexusError, newId, type FriendlyProblem, type JobState, type JobStep } from "@nexus/shared";

export interface JobQuestion {
  id: string;
  prompt: string;
  choices: { value: string; label: string; description?: string }[];
}

export interface JobView extends JobState {
  question: JobQuestion | null;
  log: string[];
}

/**
 * Handle given to long-running work (deployments, restores, model downloads).
 * Progress is visible to the UI; the work can pause to ask the user one question.
 */
export class JobHandle {
  constructor(
    private readonly job: JobView,
    private readonly mgr: JobManager,
  ) {}

  get id(): string {
    return this.job.id;
  }

  step(key: string, status: JobStep["status"], detail?: string): void {
    const s = this.job.steps.find((x) => x.key === key);
    if (s) {
      s.status = status;
      if (detail !== undefined) s.detail = detail;
    } else this.job.steps.push({ key, label: key, status, ...(detail ? { detail } : {}) });
  }

  log(line: string): void {
    this.job.log.push(line);
    if (this.job.log.length > 500) this.job.log.splice(0, this.job.log.length - 500);
  }

  /** Pauses the job until the user answers in the UI. */
  ask(prompt: string, choices: JobQuestion["choices"]): Promise<string> {
    const q: JobQuestion = { id: newId(), prompt, choices };
    this.job.question = q;
    this.job.status = "waiting_for_input";
    return new Promise((resolve) => this.mgr.registerAnswer(this.job.id, q.id, (answer) => {
      this.job.question = null;
      this.job.status = "running";
      resolve(answer);
    }));
  }
}

/** Tracks long-running operations with steps, logs and optional questions. Bounded history. */
export class JobManager {
  private readonly jobs = new Map<string, JobView>();
  private readonly waiters = new Map<string, { questionId: string; resolve: (a: string) => void }>();

  start<T>(kind: string, title: string, steps: { key: string; label: string }[], work: (job: JobHandle) => Promise<T>): JobView {
    const job: JobView = {
      id: newId(),
      kind,
      title,
      status: "running",
      steps: steps.map((s) => ({ ...s, status: "pending" as const })),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      question: null,
      log: [],
    };
    this.jobs.set(job.id, job);
    this.trim();
    const handle = new JobHandle(job, this);
    void (async () => {
      try {
        job.result = await work(handle);
        job.status = "succeeded";
      } catch (e) {
        job.status = "failed";
        job.problem = toProblem(e);
        for (const s of job.steps) if (s.status === "running") s.status = "failed";
      } finally {
        job.finishedAt = new Date().toISOString();
        job.question = null;
        this.waiters.delete(job.id);
      }
    })();
    return job;
  }

  get(id: string): JobView | undefined {
    return this.jobs.get(id);
  }

  list(kind?: string): JobView[] {
    return [...this.jobs.values()].filter((j) => !kind || j.kind === kind).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  registerAnswer(jobId: string, questionId: string, resolve: (a: string) => void): void {
    this.waiters.set(jobId, { questionId, resolve });
  }

  answer(jobId: string, questionId: string, value: string): boolean {
    const w = this.waiters.get(jobId);
    const job = this.jobs.get(jobId);
    if (!w || !job || w.questionId !== questionId) return false;
    if (!job.question?.choices.some((c) => c.value === value)) return false;
    this.waiters.delete(jobId);
    w.resolve(value);
    return true;
  }

  /** Waits for a job to finish (tests, CLI). */
  async wait(id: string, timeoutMs = 600_000): Promise<JobView> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const j = this.jobs.get(id);
      if (!j) throw new Error("Unknown job");
      if (j.status === "succeeded" || j.status === "failed") return j;
      if (Date.now() > deadline) throw new Error("Timed out waiting for job");
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  private trim(): void {
    const finished = [...this.jobs.values()].filter((j) => j.finishedAt).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    while (this.jobs.size > 200 && finished.length) this.jobs.delete(finished.shift()!.id);
  }
}

export function toProblem(e: unknown): FriendlyProblem {
  if (isNexusError(e) && e.problem) return e.problem;
  const message = e instanceof Error ? e.message : String(e);
  return { title: "Something went wrong", summary: message, checks: [], technical: e instanceof Error ? (e.stack ?? message) : message };
}
