import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NexusContext } from "../src/context";
import { authRoutes } from "../src/http/routes/auth";
import { notificationRoutes } from "../src/http/routes/notifications";
import { pipelineRoutes } from "../src/http/routes/pipelines";
import { buildServer } from "../src/http/server";
import { NotificationService } from "../src/services/notifications";
import { PipelineService } from "../src/services/pipelines";
import { createContext, tempHome } from "./helpers";
import { ownerClient } from "./helpers-http";

let ctx: NexusContext;
let app: FastifyInstance;
let home: string;
let dispose: () => void;
let call: Awaited<ReturnType<typeof ownerClient>>;
const sent: { url: string; body: { text: string } }[] = [];
let chatStatus = 200;

beforeAll(async () => {
  const t = tempHome();
  home = t.home;
  dispose = t.dispose;
  ctx = await createContext(home, { setup: true });
  const notifications = new NotificationService(ctx, async (url, body) => {
    sent.push({ url, body: JSON.parse(body) });
    return new Response("{}", { status: chatStatus });
  });
  app = await buildServer(ctx, [authRoutes, pipelineRoutes(new PipelineService(ctx, notifications)), notificationRoutes(notifications)]);
  call = await ownerClient(app, ctx);
}, 240_000);

afterAll(async () => {
  await app?.close();
  await ctx?.shutdown();
  dispose?.();
}, 120_000);

describe("notifications", () => {
  it("accepts only https chat webhooks and never shows the address back", async () => {
    expect((await call("PUT", "/api/v1/notifications/settings", { webhookUrl: "http://chat.example.com/hook" })).status).toBe(400);
    expect((await call("PUT", "/api/v1/notifications/settings", { webhookUrl: "not a url" })).status).toBe(400);
    const ok = await call("PUT", "/api/v1/notifications/settings", { webhookUrl: "https://chat.example.com/hooks/SECRET123", minSeverity: "warning" });
    expect(ok.body).toEqual({ webhookConfigured: true, minSeverity: "warning", lastDelivery: null });
    expect(JSON.stringify(ok.body)).not.toContain("SECRET123");
    const test = await call("POST", "/api/v1/notifications/test");
    expect(test.body).toEqual({ ok: true, error: null });
    expect(sent.at(-1)!.body.text).toContain("Nexus test notification");
  });

  it("tells people when a pipeline's source is missing — in the app and in the chat channel", async () => {
    sent.length = 0;
    const p = await call("POST", "/api/v1/pipelines", {
      definition: { name: "Daily import", steps: [{ id: "file", uses: "csv.read", with: { path: join(home, "nowhere", "trips.csv") } }, { id: "save", uses: "file.write", with: { path: join(home, "out", "x.csv") } }] },
    });
    const r = await call("POST", `/api/v1/pipelines/${p.body.id}/run`, { waitSeconds: 60 });
    expect(r.body.status).toBe("failed");
    await new Promise((res) => setTimeout(res, 200)); // notifications are sent right after the run finishes

    const list = await call("GET", "/api/v1/notifications");
    expect(list.body.unread).toBe(1);
    expect(list.body.items[0]).toMatchObject({ severity: "critical", source: "pipeline", title: "Daily import: a data source is unavailable", link: `/pipelines/${p.body.id}/runs/${r.body.runId}`, read: false });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.text).toContain("🔴 **Daily import: a data source is unavailable**");
    expect(ctx.activity.list(5)[0]!.message).toContain("Daily import: a data source is unavailable");

    // The same failure again: no second message.
    await call("POST", `/api/v1/pipelines/${p.body.id}/run`, { waitSeconds: 60 });
    await new Promise((res) => setTimeout(res, 200));
    expect((await call("GET", "/api/v1/notifications")).body.unread).toBe(1);
    expect(sent).toHaveLength(1);

    expect((await call("POST", "/api/v1/notifications/read", {})).body.unread).toBe(0);
  }, 120_000);

  it("keeps less important notifications inside Nexus and records failed deliveries", async () => {
    sent.length = 0;
    const n = new NotificationService(ctx, async () => new Response("", { status: chatStatus }));
    await n.publish({ severity: "info", source: "pipeline", title: "Quiet", message: "Just so you know." });
    expect(sent).toHaveLength(0);
    chatStatus = 500;
    await n.publish({ severity: "critical", source: "system", title: "Loud", message: "Something broke." });
    expect(n.settings().lastDelivery).toMatchObject({ ok: false, error: "The chat service answered with HTTP 500." });
    chatStatus = 200;
    expect(n.list({ limit: 2 }).map((x) => x.title)).toEqual(["Loud", "Quiet"]);
    await call("PUT", "/api/v1/notifications/settings", { webhookUrl: null });
    expect(n.settings().webhookConfigured).toBe(false);
  });
});
