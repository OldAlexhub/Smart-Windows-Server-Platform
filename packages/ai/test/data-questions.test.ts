import { describe, expect, it } from "vitest";
import { checkReadOnlySql, chooseChart, columnKind, describeSchema, parseAnswerPlan, questionPrompt } from "@nexus/ai";

const ok = (sql: string) => expect(checkReadOnlySql(sql), sql).toMatchObject({ ok: true });
const refused = (sql: string, reason: RegExp) => {
  const r = checkReadOnlySql(sql);
  expect(r.ok, sql).toBe(false);
  if (!r.ok) expect(r.reason).toMatch(reason);
};

describe("read-only SQL checks", () => {
  it("accepts ordinary questions, including words that only look dangerous", () => {
    ok("select provider, count(*) as trips from trips group by provider order by trips desc");
    ok("WITH monthly AS (SELECT date_trunc('month', trip_date) AS month, sum(fare) AS revenue FROM trips GROUP BY 1) SELECT * FROM monthly");
    ok("select * from notes where body like '%delete me; drop table x%'");
    ok("select comment, load, status from reviews -- update later\n");
    ok('select "update" from audit /* insert into x */');
    ok("select $$drop table trips$$ as text");
    ok("select * from trips;");
  });

  it("refuses anything that could change data or reach outside the database", () => {
    refused("delete from trips", /Only questions that read data/);
    refused("with gone as (delete from trips returning *) select * from gone", /DELETE/);
    refused("select * into backup_trips from trips", /INTO/);
    refused("select 1; drop table trips", /one query/);
    refused("select pg_sleep(60)", /pg_sleep/);
    refused("select set_config('role', 'postgres', false)", /set_config/);
    refused("select lo_import('C:/Windows/win.ini')", /lo_import/);
    refused("select pg_read_file('postgresql.conf')", /pg_read_file/);
    refused("select * from trips for update", /UPDATE/);
    refused("", /empty/);
  });

  it("reads the model's answer even when wrapped in code fences", () => {
    expect(parseAnswerPlan('```json\n{"sql": "select 1 as n", "explanation": "One.", "chart": {"type": "bar", "x": "a", "y": "n"}}\n```')).toEqual({ sql: "select 1 as n", explanation: "One.", chart: { type: "bar", x: "a", y: "n" } });
    expect(parseAnswerPlan("SELECT count(*) FROM trips")).toMatchObject({ sql: "SELECT count(*) FROM trips", chart: { type: "none" } });
    expect(parseAnswerPlan("I'm not sure.")).toBeNull();
    expect(parseAnswerPlan('{"sql": ""}')).toBeNull();
  });

  it("describes only table and column names to the model", () => {
    const text = describeSchema([{ name: "trips", rowEstimate: 1200, columns: [{ name: "id", type: "integer", primaryKey: true }, { name: "fare", type: "numeric" }] }]);
    expect(text).toBe("trips (~1,200 rows): id integer PK, fare numeric");
    const prompt = questionPrompt("How many trips?", text, "2026-09-24");
    expect(prompt[0]!.content).toContain("Today is 2026-09-24.");
    expect(prompt[1]).toEqual({ role: "user", content: "How many trips?" });
  });
});

describe("chart choice", () => {
  const cols = (spec: Record<string, string>) => Object.entries(spec).map(([name, t]) => ({ name, kind: columnKind(t) }));

  it("uses a line for values over time and bars to compare a few categories", () => {
    expect(chooseChart({ type: "none" }, cols({ month: "date", revenue: "numeric" }), 12)).toEqual({ type: "line", x: "month", y: ["revenue"] });
    expect(chooseChart({ type: "none" }, cols({ provider: "text", trips: "int8", revenue: "numeric" }), 4)).toEqual({ type: "bar", x: "provider", y: ["trips", "revenue"] });
    expect(chooseChart({ type: "bar", x: "provider", y: "revenue" }, cols({ provider: "text", trips: "int8", revenue: "numeric" }), 4)).toEqual({ type: "bar", x: "provider", y: ["revenue"] });
  });

  it("shows no chart when one wouldn't help", () => {
    expect(chooseChart({ type: "bar", x: "provider", y: "trips" }, cols({ provider: "text", trips: "int8" }), 1)).toBeNull();
    expect(chooseChart({ type: "bar", x: "name", y: "x" }, cols({ name: "text", email: "text" }), 10)).toBeNull();
    expect(chooseChart({ type: "none" }, cols({ customer: "text", total: "numeric" }), 300)).toBeNull();
    expect(chooseChart({ type: "bar", x: "missing", y: "trips" }, cols({ provider: "text", trips: "int8" }), 3)).toEqual({ type: "bar", x: "provider", y: ["trips"] });
  });
});
