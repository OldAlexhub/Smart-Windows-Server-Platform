import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NexusContext } from "../src/context";
import { ActivityFeed } from "../src/services/activity";
import { JobManager } from "../src/services/jobs";
import { StateStore } from "@nexus/state";
import { NexusError } from "@nexus/shared";
import { createContext, tempHome } from "./helpers";

describe("NexusContext", () => {
  it("boots core services on first start: owner account, vault, local sign-in token", async () => {
    const { home, dispose } = tempHome();
    const ctx = await createContext(home);
    try {
      expect(ctx.setupCompleted).toBe(false);
      expect(ctx.users.list().map((u) => u.role)).toEqual(["owner"]);
      expect(NexusContext.readLocalToken(ctx.opts.paths)).toBe(ctx.localToken);
      expect(readFileSync(ctx.opts.paths.keyFile, "utf8")).toMatch(/^NEXUSKEY1:plain:/);
      expect(ctx.postgres).toBeNull();
    } finally {
      await ctx.shutdown();
      dispose();
    }
  });

  it("starts data services after setup (real PostgreSQL) and stops them on shutdown", async () => {
    const { home, dispose } = tempHome();
    const ctx = await createContext(home, { setup: true });
    try {
      expect(await ctx.postgres!.state()).toBe("running");
      const { connection } = await ctx.databases!.createDatabase({ displayName: "Smoke", appId: "smoke" });
      expect(await ctx.databases!.testConnection(connection!)).toEqual({ ok: true });
      expect(ctx.backups).not.toBeNull();
      expect(ctx.deployments).not.toBeNull();
      expect(ctx.vault.has("system/postgres-superuser")).toBe(true);
    } finally {
      const pg = ctx.postgres!;
      await ctx.shutdown();
      expect(await pg.state()).toBe("stopped");
      dispose();
    }
  }, 180_000);

  it("reuses the same vault key and state across restarts", async () => {
    const { home, dispose } = tempHome();
    const a = await createContext(home);
    a.vault.set("x", "persisted");
    const ownerId = a.users.list()[0]!.id;
    await a.shutdown();
    const b = await createContext(home);
    try {
      expect(b.vault.get("x")).toBe("persisted");
      expect(b.users.list()[0]!.id).toBe(ownerId);
      expect(b.localToken).not.toBe(a.localToken); // rotated each start
    } finally {
      await b.shutdown();
      dispose();
    }
  });
});

describe("JobManager", () => {
  it("tracks steps, asks one question, and completes", async () => {
    const jobs = new JobManager();
    const job = jobs.start("deploy", "Deploying TaxiOps", [{ key: "db", label: "Database" }], async (j) => {
      j.step("db", "running");
      const answer = await j.ask("Which one does TaxiOps use?", [
        { value: "FLEET", label: "Fleet database" },
        { value: "BILLING", label: "Billing database" },
      ]);
      j.step("db", "done", answer);
      return { chosen: answer };
    });
    for (let i = 0; i < 50 && jobs.get(job.id)!.status !== "waiting_for_input"; i++) await new Promise((r) => setTimeout(r, 10));
    const waiting = jobs.get(job.id)!;
    expect(waiting.status).toBe("waiting_for_input");
    expect(jobs.answer(job.id, waiting.question!.id, "NOT_A_CHOICE")).toBe(false);
    expect(jobs.answer(job.id, waiting.question!.id, "BILLING")).toBe(true);
    const done = await jobs.wait(job.id);
    expect(done).toMatchObject({ status: "succeeded", result: { chosen: "BILLING" } });
    expect(done.steps[0]).toMatchObject({ status: "done", detail: "BILLING" });
  });

  it("turns failures into friendly problems", async () => {
    const jobs = new JobManager();
    const job = jobs.start("x", "X", [{ key: "a", label: "A" }], async (j) => {
      j.step("a", "running");
      throw new NexusError("infrastructure", "boom", { problem: { title: "Database Connection Problem", summary: "…", checks: [] } });
    });
    const done = await jobs.wait(job.id);
    expect(done.status).toBe("failed");
    expect(done.problem!.title).toBe("Database Connection Problem");
    expect(done.steps[0]!.status).toBe("failed");
  });
});

describe("ActivityFeed", () => {
  it("lists newest first and per app", () => {
    let t = 0;
    const feed = new ActivityFeed(StateStore.memory(), () => ++t * 1000);
    feed.add("success", "TaxiOps deployed successfully", "taxiops");
    feed.add("info", "Finance backup completed", "finance");
    expect(feed.list().map((a) => a.message)).toEqual(["Finance backup completed", "TaxiOps deployed successfully"]);
    expect(feed.list(10, "taxiops")).toHaveLength(1);
  });
});
