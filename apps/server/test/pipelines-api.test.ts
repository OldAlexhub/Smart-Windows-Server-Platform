import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NexusContext } from "../src/context";
import { authRoutes } from "../src/http/routes/auth";
import { dataRoutes } from "../src/http/routes/data";
import { pipelineRoutes } from "../src/http/routes/pipelines";
import { importRoutes } from "../src/http/routes/imports";
import { buildServer } from "../src/http/server";
import { PipelineService } from "../src/services/pipelines";
import { DataImportService } from "../src/services/imports";
import { createContext, tempHome } from "./helpers";
import { ownerClient } from "./helpers-http";

let ctx: NexusContext;
let app: FastifyInstance;
let service: PipelineService;
let home: string;
let dispose: () => void;
let call: Awaited<ReturnType<typeof ownerClient>>;
let ownerCookie = "";

const pipelineFile = (dataDir: string) => `
nexus: pipeline/v1
name: Completed trips
params:
  - { name: status, default: Completed }
steps:
  - id: trips
    uses: csv.read
    with: { path: '${join(dataDir, "trips.csv")}' }
  - id: done
    uses: filter
    with: { where: "status = {{params.status}}" }
  - id: load
    uses: warehouse.write
    with: { table: completed_trips }
`;

beforeAll(async () => {
  const t = tempHome();
  home = t.home;
  dispose = t.dispose;
  ctx = await createContext(home, { setup: true });
  service = new PipelineService(ctx);
  const imports = new DataImportService(ctx, service);
  app = await buildServer(ctx, [authRoutes, dataRoutes, importRoutes(imports), pipelineRoutes(service)]);
  call = await ownerClient(app, ctx);
  const signedIn = await app.inject({ method: "POST", url: "/api/v1/auth/local", headers: { "x-nexus-request": "1" }, payload: { token: ctx.localToken } });
  ownerCookie = String(signedIn.headers["set-cookie"]).split(";")[0]!;
  mkdirSync(join(home, "input"), { recursive: true });
  writeFileSync(join(home, "input", "trips.csv"), "trip_id,status,fare\n1,Completed,12.5\n2,Cancelled,0\n3,Completed,8\n");
}, 240_000);

afterAll(async () => {
  await app?.close();
  await ctx?.shutdown();
  dispose?.();
}, 120_000);

describe("Pipelines API", () => {
  let id = "";

  it("offers the block catalogue with a settings form for each block", async () => {
    const r = await call("GET", "/api/v1/pipelines/blocks");
    const csv = r.body.find((b: { kind: string }) => b.kind === "csv.read");
    expect(csv).toMatchObject({ category: "source", label: "CSV file", inputs: { min: 0, max: 0 } });
    expect(csv.schema.properties.path).toBeTruthy();
  });

  it("creates a pipeline from a pipeline file and pins problems to steps", async () => {
    const bad = await call("POST", "/api/v1/pipelines", { definition: { name: "Bad", steps: [{ id: "x", uses: "nope" }] } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.issues).toEqual([{ path: "steps.x.uses", message: '"nope" isn\'t a known block.' }]);

    const created = await call("POST", "/api/v1/pipelines", { file: pipelineFile(join(home, "input")) });
    expect(created.body.error ?? null).toBeNull();
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ slug: "completed-trips", enabled: false, version: 1, steps: 3, lastRun: null });
    id = created.body.id;
  });

  it("runs it on request with parameters, and loads the Warehouse (created on first use)", async () => {
    const r = await call("POST", `/api/v1/pipelines/${id}/run`, { waitSeconds: 120 });
    expect(r.body).toMatchObject({ status: "succeeded", error: null });
    const run = await call("GET", `/api/v1/pipeline-runs/${r.body.runId}`);
    expect(run.body.steps.map((s: { stepId: string; status: string }) => `${s.stepId}:${s.status}`)).toEqual(["trips:succeeded", "done:succeeded", "load:succeeded"]);
    expect(run.body.steps[2].metrics.rowsWritten).toBe(2);
    const dbs = await call("GET", "/api/v1/databases");
    expect(dbs.body.map((d: { name: string }) => d.name)).toContain("Warehouse");

    const cancelled = await call("POST", `/api/v1/pipelines/${id}/run`, { params: { status: "Cancelled" }, waitSeconds: 120 });
    expect(cancelled.body.status).toBe("succeeded");
    const again = await call("GET", `/api/v1/pipeline-runs/${cancelled.body.runId}`);
    expect(again.body.steps[1].output.rows).toBe(1);

    const wrong = await call("POST", `/api/v1/pipelines/${id}/run`, { params: { region: "x" } });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.message).toBe("This pipeline has no parameter called region.");

    const history = await call("GET", `/api/v1/pipelines/${id}/runs`);
    expect(history.body.length).toBe(2);
    const logs = await call("GET", `/api/v1/pipeline-runs/${r.body.runId}/logs`);
    expect(logs.body.at(-1).message).toBe("Run finished successfully.");
    const preview = await call("GET", `/api/v1/pipeline-runs/${r.body.runId}/steps/done/preview?limit=10`);
    expect(preview.status).toBe(200);
  }, 240_000);

  it("lets applications start only switched-on pipelines, with a pipelines:run credential", async () => {
    const withScope = ctx.appTokens.issue("reporting", "Reports", ["pipelines:run"]).token;
    const without = ctx.appTokens.issue("reporting", "Storage only", ["storage:read"]).token;
    const post = (token: string, body: object) => app.inject({ method: "POST", url: `/api/v1/pipelines/completed-trips/run`, headers: { authorization: `Bearer ${token}` }, payload: body });

    const off = await post(withScope, {});
    expect(off.statusCode).toBe(409);
    expect(off.json().error.message).toContain("switched off");

    await call("POST", `/api/v1/pipelines/${id}/enabled`, { enabled: true });
    const ok = await post(withScope, { params: { status: "Completed" }, waitSeconds: 120 });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe("succeeded");
    expect((await post(without, {})).statusCode).toBe(403);
    expect((await post(withScope, { testRows: 5 })).statusCode).toBe(400);
  }, 240_000);

  it("accepts webhooks carrying the pipeline's own secret (no session, no browser header)", async () => {
    const hook = await call("POST", `/api/v1/pipelines/${id}/webhook`);
    expect(hook.body.url).toBe("/api/v1/hooks/pipelines/completed-trips");
    const send = (headers: Record<string, string>, payload: object = { status: "Completed", unrelated: 1 }, url = hook.body.url) => app.inject({ method: "POST", url, headers, payload });

    const ok = await send({ "x-nexus-webhook-token": hook.body.token });
    expect(ok.statusCode).toBe(202);
    const run = await service.wait(ok.json().runId);
    expect(run).toMatchObject({ status: "succeeded", trigger: "api", params: { status: "Completed" } });

    expect((await send({ "x-nexus-webhook-token": "nxw_wrong" })).statusCode).toBe(401);
    const viaQuery = await send({}, {}, `${hook.body.url}?token=${hook.body.token}`);
    expect(viaQuery.statusCode).toBe(202);
    await service.wait(viaQuery.json().runId);
    expect((await send({ "x-nexus-webhook-token": hook.body.token }, {}, "/api/v1/hooks/pipelines/nope")).statusCode).toBe(401);

    await call("DELETE", `/api/v1/pipelines/${id}/webhook`);
    expect((await send({ "x-nexus-webhook-token": hook.body.token })).statusCode).toBe(401);
    // Management routes still need a session and the security header.
    expect((await app.inject({ method: "POST", url: `/api/v1/pipelines/${id}/run`, payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/api/v1/pipelines/${id}/run`, headers: { "x-nexus-request": "1" }, payload: {} })).statusCode).toBe(401);
  }, 240_000);

  it("keeps Nexus's own folders out of reach of pipelines", async () => {
    const secretFile = join(ctx.opts.paths.root, "stolen.csv");
    writeFileSync(secretFile, "a\n1\n");
    const p = await call("POST", "/api/v1/pipelines", { definition: { name: "Sneaky", steps: [{ id: "s", uses: "csv.read", with: { path: secretFile } }] } });
    const r = await call("POST", `/api/v1/pipelines/${p.body.id}/run`, { waitSeconds: 60 });
    expect(r.body.status).toBe("failed");
    expect(r.body.error).toContain("Nexus's own folders");
  }, 120_000);

  it("stores secrets encrypted and only ever shows their names", async () => {
    expect((await call("PUT", "/api/v1/pipelines/secrets/shop_api", { value: "tok-123" })).status).toBe(200);
    const list = await call("GET", "/api/v1/pipelines/secrets");
    expect(list.body).toEqual([{ name: "shop_api", updatedAt: expect.any(String) }]);
    expect(JSON.stringify(list.body)).not.toContain("tok-123");
    expect((await call("PUT", "/api/v1/pipelines/secrets/bad name", { value: "x" })).status).toBe(400);
    expect((await call("DELETE", "/api/v1/pipelines/secrets/shop_api")).status).toBe(200);
  });

  it("creates a working pipeline from a template: CSV files into a Nexus database", async () => {
    const list = await call("GET", "/api/v1/pipelines/templates");
    expect(list.body.intents.map((i: { id: string }) => i.id)).toContain("import");
    await ctx.databases!.createDatabase({ displayName: "Operations" });
    const created = await call("POST", "/api/v1/pipelines/from-template", {
      template: "csv-to-postgresql",
      answers: { file: join(home, "input", "trips.csv"), database: "Operations", target: "trips", mode: "replace" },
    });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ name: "Import trips from CSV", enabled: false });
    const r = await call("POST", `/api/v1/pipelines/${created.body.id}/run`, { waitSeconds: 120 });
    expect(r.body).toMatchObject({ status: "succeeded" });
    const db = ctx.databases!.list().find((d) => d.name === "Operations")!;
    expect((await ctx.postgres!.adminQuery("select count(*)::int as n from trips", [], db.dbName))[0]!.n).toBe(3);
    const missing = await call("POST", "/api/v1/pipelines/from-template", { template: "csv-to-postgresql", answers: {} });
    expect(missing.status).toBe(400);
    expect(missing.body.error.message).toBe('Please fill in "CSV file or pattern".');
  }, 240_000);

  it("imports a CSV through the review API into a real PostgreSQL table", async () => {
    const { database } = await ctx.databases!.createDatabase({ displayName: "Imported Records" });
    const boundary = "----nexus-import-test";
    const csv =
      'Driver ID,Total Paid,Paid On,Active\r\n101,"$1,250.50",03/04/2024,yes\r\n102,"$22.00",04/05/2024,no\r\n';
    const body = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="Drivers export.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n`,
    );
    const uploaded = await app.inject({
      method: "POST",
      url: `/api/v1/databases/${database.id}/imports`,
      headers: {
        cookie: ownerCookie,
        "x-nexus-request": "1",
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });
    expect(uploaded.statusCode).toBe(200);
    const analysis = uploaded.json();
    expect(analysis).toMatchObject({ rows: 2, suggestedTable: "drivers", primaryKey: ["driver_id"] });

    const imported = await call("POST", `/api/v1/databases/${database.id}/imports/${analysis.importId}/run`, {
      table: analysis.suggestedTable,
      mode: "create",
      columns: analysis.columns.map((c: { source: string; name: string; type: string; format: string | null }) => ({
        source: c.source,
        name: c.name,
        type: c.type,
        format: c.format,
        include: true,
      })),
      primaryKey: analysis.primaryKey,
    });
    expect(imported).toMatchObject({ status: 200, body: { rows: 2, table: "drivers", generatedKey: null } });
    expect(
      await ctx.postgres!.adminQuery(
        "select driver_id, total_paid::text, paid_on::text, active from drivers order by driver_id",
        [],
        database.dbName,
      ),
    ).toEqual([
      { driver_id: "101", total_paid: "1250.5", paid_on: "2024-03-04", active: true },
      { driver_id: "102", total_paid: "22.0", paid_on: "2024-04-05", active: false },
    ]);
    expect(
      (await call("GET", `/api/v1/databases/${database.id}/tables`)).body.map((t: { name: string }) => t.name),
    ).toContain("drivers");
  }, 240_000);

  it("deletes a pipeline only with its name typed", async () => {
    expect((await call("DELETE", `/api/v1/pipelines/${id}`, { confirmation: "nope" })).status).toBe(400);
    expect((await call("DELETE", `/api/v1/pipelines/${id}`, { confirmation: "Completed trips" })).status).toBe(200);
    expect((await call("GET", `/api/v1/pipelines/${id}`)).status).toBe(404);
  });
});
