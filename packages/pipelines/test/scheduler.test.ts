import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { StateStore } from "@nexus/state";
import {
  cronMatches,
  parseCron,
  PipelineDependencyGraph,
  PipelineScheduler,
  PipelineStore,
  previousCalendarSlot,
  validatePipeline,
  type PipelineInput,
  type ScheduledRun,
} from "@nexus/pipelines";

const root = mkdtempSync(join(tmpdir(), "nexus-scheduler-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const definition = (name: string, schedule: PipelineInput["schedule"]): PipelineInput => ({
  name,
  schedule,
  steps: [{ id: "done", uses: "notify", with: { message: "done" } }],
});

describe("cron and calendar schedules", () => {
  it("supports lists, ranges, steps and weekday/month names", () => {
    const cron = parseCron("*/15 8-10 * JAN,MAR MON-FRI");
    expect(cron.minute.values).toEqual(new Set([0, 15, 30, 45]));
    expect(cronMatches(new Date(2026, 0, 5, 8, 30), cron)).toBe(true); // Monday in January
    expect(cronMatches(new Date(2026, 0, 4, 8, 30), cron)).toBe(false); // Sunday
    expect(cronMatches(new Date(2026, 1, 5, 8, 30), cron)).toBe(false); // February
    expect(cronMatches(new Date(2026, 0, 5, 11, 30), cron)).toBe(false);
    expect(cronMatches(new Date(2026, 0, 6, 8, 0), "0 8 */1 * MON")).toBe(false); // */1 is unrestricted
  });

  it("rejects malformed cron when the pipeline is validated", () => {
    const bad = validatePipeline(definition("Bad cron", { type: "cron", expression: "70 4 * * *" }));
    expect(bad.ok).toBe(false);
    if (!bad.ok)
      expect(bad.issues[0]).toMatchObject({
        path: "schedule.expression",
        message: expect.stringContaining("Invalid cron schedule"),
      });
  });

  it("finds daily, weekly, monthly-last and cron slots in local time", () => {
    const monday = new Date(2026, 8, 21, 5, 0);
    expect(previousCalendarSlot({ type: "daily", at: "04:00" }, monday)?.getHours()).toBe(4);
    expect(previousCalendarSlot({ type: "weekly", day: "mon", at: "04:00" }, monday)?.getDate()).toBe(21);
    const october = new Date(2026, 9, 31, 23, 0);
    expect(previousCalendarSlot({ type: "monthly", day: "last", at: "22:30" }, october)?.getDate()).toBe(31);
    expect(previousCalendarSlot({ type: "cron", expression: "0 4 * * MON" }, monday)?.getDate()).toBe(21);
  });
});

describe("pipeline scheduler", () => {
  it("runs intervals once when due, catches up once, persists slots, and retries a rejected start", async () => {
    const state = StateStore.memory();
    const pipelines = new PipelineStore(state);
    const p = pipelines.create(definition("Every five", { type: "interval", minutes: 5 }));
    pipelines.setEnabled(p.id, true);
    let now = new Date(2026, 8, 21, 10, 0);
    const runs: ScheduledRun[] = [];
    let reject = false;
    let alreadyRunning = false;
    const make = () =>
      new PipelineScheduler({
        store: state,
        pipelines,
        now: () => new Date(now),
        isRunning: () => alreadyRunning,
        run: (_pipeline, request) => {
          if (reject) throw new Error("service is stopping");
          runs.push(request);
        },
      });
    let scheduler = make();
    await scheduler.tick(); // baseline: enabling never causes an immediate surprise run
    now = new Date(now.getTime() + 4 * 60_000);
    await scheduler.tick();
    expect(runs).toHaveLength(0);
    now = new Date(now.getTime() + 60_000);
    await scheduler.tick();
    expect(runs).toHaveLength(1);

    now = new Date(now.getTime() + 16 * 60_000); // three slots were missed; catch up once at the newest one
    await scheduler.tick();
    expect(runs).toHaveLength(2);
    await scheduler.tick();
    expect(runs).toHaveLength(2);
    scheduler = make(); // service restart, same persistent state
    await scheduler.tick();
    expect(runs).toHaveLength(2);

    now = new Date(now.getTime() + 5 * 60_000);
    alreadyRunning = true;
    await scheduler.tick();
    expect(runs).toHaveLength(2);
    alreadyRunning = false;
    reject = true;
    await scheduler.tick();
    expect(runs).toHaveLength(2);
    reject = false;
    await scheduler.tick();
    expect(runs).toHaveLength(3);
    expect(new Date(runs[2]!.logicalTime).getTime()).toBeLessThanOrEqual(now.getTime());

    pipelines.setEnabled(p.id, false);
    await scheduler.tick();
    now = new Date(now.getTime() + 60 * 60_000);
    pipelines.setEnabled(p.id, true);
    await scheduler.tick();
    expect(runs).toHaveLength(3); // re-enabling starts a fresh interval instead of replaying disabled time
  });

  it("runs daily, weekly, monthly and cron pipelines at their local-time slots", async () => {
    const state = StateStore.memory();
    const pipelines = new PipelineStore(state);
    const configs: [string, PipelineInput["schedule"]][] = [
      ["Daily", { type: "daily", at: "04:00" }],
      ["Weekly", { type: "weekly", day: "mon", at: "04:00" }],
      ["Monthly", { type: "monthly", day: 21, at: "04:00" }],
      ["Cron", { type: "cron", expression: "0 4 * * MON" }],
    ];
    for (const [name, schedule] of configs) {
      const p = pipelines.create(definition(name, schedule));
      pipelines.setEnabled(p.id, true);
    }
    let now = new Date(2026, 8, 21, 3, 50); // Monday, September 21
    const runs: string[] = [];
    const scheduler = new PipelineScheduler({
      store: state,
      pipelines,
      now: () => new Date(now),
      run: (p) => void runs.push(p.name),
    });
    await scheduler.tick();
    now = new Date(2026, 8, 21, 4, 0);
    await scheduler.tick();
    expect(runs.sort()).toEqual(["Cron", "Daily", "Monthly", "Weekly"]);
    await scheduler.tick();
    expect(runs).toHaveLength(4);
    now = new Date(2026, 8, 22, 5, 0);
    await scheduler.tick();
    expect(runs.filter((x) => x === "Daily")).toHaveLength(2);
    expect(runs).toHaveLength(5);
  });

  it("waits for arriving files to settle, emits each version once, and survives a restart", async () => {
    const inbox = join(root, "inbox");
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(inbox, "old.csv"), "old\n");
    const state = StateStore.memory();
    const pipelines = new PipelineStore(state);
    const p = pipelines.create(
      definition("File arrival", { type: "file", path: join(inbox, "*.csv"), settleSeconds: 10 }),
    );
    pipelines.setEnabled(p.id, true);
    let now = new Date(2026, 8, 21, 12, 0);
    const runs: ScheduledRun[] = [];
    const make = () =>
      new PipelineScheduler({
        store: state,
        pipelines,
        now: () => new Date(now),
        run: (_p, request) => void runs.push(request),
      });
    let scheduler = make();
    await scheduler.tick(); // old.csv is the baseline, not a new arrival
    const incoming = join(inbox, "new.csv");
    writeFileSync(incoming, "a\n");
    await scheduler.tick();
    now = new Date(now.getTime() + 5_000);
    writeFileSync(incoming, "a\nb\n"); // still being copied: settle timer restarts
    await scheduler.tick();
    now = new Date(now.getTime() + 9_000);
    await scheduler.tick();
    expect(runs).toHaveLength(0);
    now = new Date(now.getTime() + 1_000);
    await scheduler.tick();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger: "file", files: [incoming] });
    await scheduler.tick();
    scheduler = make();
    await scheduler.tick();
    expect(runs).toHaveLength(1);
    writeFileSync(incoming, "a\nb\nc\n");
    await scheduler.tick();
    now = new Date(now.getTime() + 10_000);
    await scheduler.tick();
    expect(runs).toHaveLength(2);
  });

  it("waits for all upstream pipelines, gates on success, accepts completion, and deduplicates events", async () => {
    const state = StateStore.memory();
    const pipelines = new PipelineStore(state);
    const a = pipelines.create(definition("Source A", { type: "manual" }));
    const b = pipelines.create(definition("Source B", { type: "manual" }));
    const success = pipelines.create(
      definition("After both succeed", { type: "after", pipelines: [a.slug, b.id], when: "success" }),
    );
    const completion = pipelines.create(
      definition("After A completes", { type: "after", pipelines: [a.id], when: "completion" }),
    );
    pipelines.setEnabled(success.id, true);
    pipelines.setEnabled(completion.id, true);
    let now = new Date(2026, 8, 21, 14, 0);
    const runs: { name: string; request: ScheduledRun }[] = [];
    const scheduler = new PipelineScheduler({
      store: state,
      pipelines,
      now: () => new Date(now),
      run: (p, request) => void runs.push({ name: p.name, request }),
    });
    await scheduler.tick();

    await scheduler.pipelineFinished({ pipelineId: a.id, runId: "a1", status: "succeeded" });
    expect(runs.map((x) => x.name)).toEqual(["After A completes"]);
    await scheduler.pipelineFinished({ pipelineId: a.id, runId: "a1", status: "succeeded" }); // duplicate event
    expect(runs).toHaveLength(1);
    await scheduler.pipelineFinished({ pipelineId: b.id, runId: "b1", status: "failed" });
    expect(runs).toHaveLength(1);
    now = new Date(now.getTime() + 60_000);
    await scheduler.pipelineFinished({ pipelineId: b.id, runId: "b2", status: "succeeded" });
    expect(runs.map((x) => x.name)).toEqual(["After A completes", "After both succeed"]);
    expect(runs[1]!.request).toMatchObject({ trigger: "upstream", upstream: [{ runId: "a1" }, { runId: "b2" }] });
    await scheduler.pipelineFinished({ pipelineId: b.id, runId: "b2", status: "succeeded" });
    expect(runs).toHaveLength(2);

    await scheduler.pipelineFinished({ pipelineId: a.id, runId: "a2", status: "failed" });
    expect(runs.at(-1)!.name).toBe("After A completes");
    expect(runs.at(-1)!.request.upstream?.[0]!.status).toBe("failed");
  });
});

describe("pipeline dependencies", () => {
  it("resolves IDs and stable slugs, lists transitive downstream pipelines, and reports bad graphs", () => {
    const state = StateStore.memory();
    const pipelines = new PipelineStore(state);
    const source = pipelines.create(definition("Source", { type: "manual" }));
    const middle = pipelines.create(definition("Middle", { type: "after", pipelines: [source.slug], when: "success" }));
    const final = pipelines.create(definition("Final", { type: "after", pipelines: [middle.id], when: "success" }));
    const duplicate = pipelines.create(
      definition("Duplicate", { type: "after", pipelines: [source.id, source.slug], when: "success" }),
    );
    const missing = pipelines.create(definition("Missing", { type: "after", pipelines: ["gone"], when: "success" }));
    const self = pipelines.create(definition("Self", { type: "manual" }));
    pipelines.update(self.id, definition("Self", { type: "after", pipelines: [self.id], when: "success" }));

    let graph = new PipelineDependencyGraph(pipelines.list());
    expect(graph.dependencies(middle.id)[0]).toMatchObject({ reference: source.slug, pipeline: { id: source.id } });
    expect(new Set(graph.downstream(source.id).map((pipeline) => pipeline.id))).toEqual(
      new Set([middle.id, final.id, duplicate.id]),
    );
    expect(graph.problems(duplicate.id)[0]?.code).toBe("duplicate");
    expect(graph.problems(missing.id)[0]?.code).toBe("missing");
    expect(graph.problems(self.id)[0]?.code).toBe("self");

    pipelines.update(source.id, definition("Source", { type: "after", pipelines: [middle.id], when: "success" }));
    graph = new PipelineDependencyGraph(pipelines.list());
    expect(graph.problems(source.id).some((problem) => problem.code === "cycle")).toBe(true);
    expect(graph.problems(middle.id).some((problem) => problem.code === "cycle")).toBe(true);
    expect(graph.problems(final.id).some((problem) => problem.code === "cycle")).toBe(true); // depends on the cycle
  });

  it("persists a failed upstream as blocked and unblocks only after a newer success", async () => {
    const state = StateStore.memory();
    const pipelines = new PipelineStore(state);
    const source = pipelines.create(definition("Source", { type: "manual" }));
    const downstream = pipelines.create(
      definition("Downstream", { type: "after", pipelines: [source.id], when: "success" }),
    );
    pipelines.setEnabled(downstream.id, true);
    const runs: string[] = [];
    const make = () =>
      new PipelineScheduler({ store: state, pipelines, run: (pipeline) => void runs.push(pipeline.name) });
    let scheduler = make();
    await scheduler.tick();
    await scheduler.pipelineFinished({ pipelineId: source.id, runId: "source-failed", status: "failed" });
    expect(runs).toEqual([]);
    expect(scheduler.dependencyStatus(downstream.id)).toMatchObject({
      state: "blocked",
      blockedBy: [{ runId: "source-failed", status: "failed" }],
    });

    scheduler = make();
    expect(scheduler.dependencyStatus(downstream.id).state).toBe("blocked");
    await scheduler.pipelineFinished({ pipelineId: source.id, runId: "source-succeeded", status: "succeeded" });
    expect(runs).toEqual(["Downstream"]);
    expect(scheduler.dependencyStatus(downstream.id).state).toBe("waiting");
  });

  it("propagates blocking through dependency chains and never treats blocked as completion", async () => {
    const state = StateStore.memory();
    const pipelines = new PipelineStore(state);
    const source = pipelines.create(definition("Source", { type: "manual" }));
    const middle = pipelines.create(definition("Middle", { type: "after", pipelines: [source.id], when: "success" }));
    const final = pipelines.create(definition("Final", { type: "after", pipelines: [middle.id], when: "completion" }));
    pipelines.setEnabled(middle.id, true);
    pipelines.setEnabled(final.id, true);
    const runs: string[] = [];
    const scheduler = new PipelineScheduler({
      store: state,
      pipelines,
      run: (pipeline) => void runs.push(pipeline.name),
    });
    await scheduler.tick();

    await scheduler.pipelineFinished({ pipelineId: source.id, runId: "source-1", status: "failed" });
    expect(runs).toEqual([]);
    expect(scheduler.dependencyStatus(middle.id).state).toBe("blocked");
    expect(scheduler.dependencyStatus(final.id)).toMatchObject({
      state: "blocked",
      blockedBy: [{ pipelineId: middle.id, status: "blocked" }],
    });

    pipelines.setEnabled(final.id, false);
    await scheduler.tick();
    pipelines.setEnabled(final.id, true);
    await scheduler.tick();
    expect(scheduler.dependencyStatus(final.id).state).toBe("blocked"); // persistent blocks reach newly enabled dependants

    await scheduler.pipelineFinished({ pipelineId: source.id, runId: "source-2", status: "succeeded" });
    expect(runs).toEqual(["Middle"]);
    expect(scheduler.dependencyStatus(final.id).state).toBe("blocked");
    await scheduler.pipelineFinished({ pipelineId: middle.id, runId: "middle-2", status: "succeeded" });
    expect(runs).toEqual(["Middle", "Final"]);
  });

  it("blocks invalid cycles instead of starting either pipeline", async () => {
    const state = StateStore.memory();
    const pipelines = new PipelineStore(state);
    const a = pipelines.create(definition("A", { type: "manual" }));
    const b = pipelines.create(definition("B", { type: "after", pipelines: [a.id], when: "success" }));
    pipelines.update(a.id, definition("A", { type: "after", pipelines: [b.id], when: "success" }));
    pipelines.setEnabled(a.id, true);
    pipelines.setEnabled(b.id, true);
    const runs: string[] = [];
    const scheduler = new PipelineScheduler({
      store: state,
      pipelines,
      run: (pipeline) => void runs.push(pipeline.name),
    });
    await scheduler.tick();
    expect(runs).toEqual([]);
    expect(scheduler.dependencyStatus(a.id)).toMatchObject({
      state: "blocked",
      message: expect.stringContaining("cycle"),
    });
    expect(scheduler.dependencyStatus(b.id)).toMatchObject({
      state: "blocked",
      message: expect.stringContaining("cycle"),
    });
  });
});
