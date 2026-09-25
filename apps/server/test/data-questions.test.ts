import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChatMessage } from "@nexus/ai";
import type { NexusContext } from "../src/context";
import { authRoutes } from "../src/http/routes/auth";
import { questionRoutes } from "../src/http/routes/questions";
import { buildServer } from "../src/http/server";
import { DataQuestionService, type QuestionModel } from "../src/services/data-questions";
import { createContext, tempHome } from "./helpers";
import { ownerClient } from "./helpers-http";

let ctx: NexusContext;
let app: FastifyInstance;
let dispose: () => void;
let call: Awaited<ReturnType<typeof ownerClient>>;
let dbId = "";

/** A stand-in for the local model: answers are scripted per test, prompts are recorded. */
let script: string[] = [];
const seen: ChatMessage[][] = [];
let modelReady = true;
const model: QuestionModel = {
  async chat(messages, opts) {
    seen.push(messages);
    if (!opts.json) return "Alpha Cabs completed the most trips (3), ahead of Beta Rides (1).";
    const next = script.shift();
    if (next === undefined) throw new Error("no scripted answer");
    return next;
  },
};

beforeAll(async () => {
  const t = tempHome();
  dispose = t.dispose;
  ctx = await createContext(t.home, { setup: true });
  const { database } = await ctx.databases!.createDatabase({ displayName: "Operations" });
  dbId = database.id;
  await ctx.databases!.withOwner(dbId, async (c) => {
    await c.query("create table trips (id serial primary key, provider text not null, status text not null, fare numeric(10,2), trip_date date not null)");
    await c.query(`insert into trips (provider, status, fare, trip_date) values
      ('Alpha Cabs', 'Completed', 12.50, '2026-07-03'), ('Alpha Cabs', 'Completed', 20.00, '2026-08-11'),
      ('Beta Rides', 'Completed', 8.00, '2026-08-12'), ('Alpha Cabs', 'Completed', 15.00, '2026-09-01'),
      ('Beta Rides', 'Cancelled', 0, '2026-09-02')`);
    await c.query("analyze trips");
  });
  app = await buildServer(ctx, [authRoutes, questionRoutes(new DataQuestionService(ctx, () => (modelReady ? model : null)))]);
  call = await ownerClient(app, ctx);
}, 240_000);

afterAll(async () => {
  await app?.close();
  await ctx?.shutdown();
  dispose?.();
}, 120_000);

const tripCount = async () => (await ctx.databases!.withOwner(dbId, (c) => c.query<{ n: number }>("select count(*)::int as n from trips"))).rows[0]!.n;

describe("questions about your data", () => {
  it("answers a plain-English question with rows, a chart and a sentence", async () => {
    script = [JSON.stringify({ sql: "select provider, count(*) as trips, sum(fare) as revenue from trips where status = 'Completed' group by provider order by trips desc", explanation: "Counts completed trips per provider.", chart: { type: "bar", x: "provider", y: "trips" } })];
    const r = await call("POST", `/api/v1/databases/${dbId}/ask`, { question: "Which provider completed the most trips?" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      explanation: "Counts completed trips per provider.",
      summary: "Alpha Cabs completed the most trips (3), ahead of Beta Rides (1).",
      columns: [{ name: "provider", kind: "text" }, { name: "trips", kind: "number" }, { name: "revenue", kind: "number" }],
      rows: [{ provider: "Alpha Cabs", trips: 3, revenue: 47.5 }, { provider: "Beta Rides", trips: 1, revenue: 8 }],
      chart: { type: "bar", x: "provider", y: ["trips"] },
      repaired: false,
      truncated: false,
    });
    // The model saw table and column names, never the rows themselves (except the result, for the sentence).
    expect(seen[0]![0]!.content).toContain("trips (~5 rows): id integer PK, provider text, status text, fare numeric(10,2), trip_date date");
    expect(seen[0]![0]!.content).not.toContain("Alpha Cabs");
  });

  it("charts values over time as a line, with dates as dates", async () => {
    script = [JSON.stringify({ sql: "select date_trunc('month', trip_date)::date as month, sum(fare) as revenue from trips group by 1 order by 1", explanation: "Revenue per month.", chart: { type: "bar", x: "month", y: "revenue" } })];
    const r = await call("POST", `/api/v1/databases/${dbId}/ask`, { question: "Revenue by month?" });
    expect(r.body.rows[0]).toEqual({ month: "2026-07-01", revenue: 12.5 });
    expect(r.body.chart).toEqual({ type: "line", x: "month", y: ["revenue"] });
  });

  it("lets the model fix a query that failed, once", async () => {
    script = [JSON.stringify({ sql: "select driver, count(*) from trips group by driver" }), JSON.stringify({ sql: "select provider, count(*) as trips from trips group by provider order by provider", explanation: "Fixed." })];
    const r = await call("POST", `/api/v1/databases/${dbId}/ask`, { question: "Trips per driver?" });
    expect(r.body).toMatchObject({ repaired: true, rows: [{ provider: "Alpha Cabs", trips: 3 }, { provider: "Beta Rides", trips: 2 }] });
    expect(seen.at(-2)!.at(-1)!.content).toContain('column "driver" does not exist');
  });

  it("never changes data, whatever the model writes", async () => {
    script = [JSON.stringify({ sql: "delete from trips" })];
    const del = await call("POST", `/api/v1/databases/${dbId}/ask`, { question: "Clean up the table" });
    expect(del.status).toBe(400);
    expect(del.body.error.message).toBe("Only questions that read data (SELECT) can be answered.");

    script = [JSON.stringify({ sql: "with gone as (delete from trips returning *) select count(*) from gone" })];
    expect((await call("POST", `/api/v1/databases/${dbId}/ask`, { question: "Sneaky" })).status).toBe(400);

    // Even SQL that gets past the checks runs read-only: the database itself refuses to change anything.
    const lock = await call("POST", `/api/v1/databases/${dbId}/query`, { sql: "select * from trips for share" });
    expect(lock.status).toBe(400);
    expect(lock.body.error.message).toMatch(/read-only|can only read/i);
    expect(await tripCount()).toBe(5);
  });

  it("runs SQL typed by a person with the same protection", async () => {
    const r = await call("POST", `/api/v1/databases/${dbId}/query`, { sql: "select status, count(*) as trips from trips group by status order by status" });
    expect(r.body).toMatchObject({ question: null, rows: [{ status: "Cancelled", trips: 1 }, { status: "Completed", trips: 4 }], chart: { type: "bar", x: "status", y: ["trips"] } });
    const bad = await call("POST", `/api/v1/databases/${dbId}/query`, { sql: "select nope from trips" });
    expect(bad.body.error.message).toBe('column "nope" does not exist');
  });

  it("stops questions that take too long", async () => {
    const r = await call("POST", `/api/v1/databases/${dbId}/query`, { sql: "select count(*) from generate_series(1, 5000000000)" });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/took too long/);
  }, 60_000);

  it("explains what to do when the AI isn't ready", async () => {
    modelReady = false;
    const r = await call("POST", `/api/v1/databases/${dbId}/ask`, { question: "How many trips?" });
    expect(r.status).toBe(409);
    expect(r.body.error.problem.title).toBe("AI isn't ready");
    modelReady = true;
  });
});
