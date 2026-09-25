import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NexusContext } from "../src/context";
import { authRoutes } from "../src/http/routes/auth";
import { setupRoutes } from "../src/http/routes/setup";
import { buildServer } from "../src/http/server";
import { createContext, tempHome } from "./helpers";
import { ownerClient } from "./helpers-http";

let ctx: NexusContext;
let app: FastifyInstance;
let home: string;
let dispose: () => void;

beforeAll(async () => {
  const t = tempHome();
  home = t.home;
  dispose = t.dispose;
  ctx = await createContext(home);
  app = await buildServer(ctx, [authRoutes, setupRoutes]);
});
afterAll(async () => {
  await app.close();
  await ctx.shutdown();
  dispose();
}, 60_000);

describe("first-run setup", () => {
  it("checks the computer, recommends a configuration, and applies it", async () => {
    const call = await ownerClient(app, ctx);
    expect((await call("GET", "/api/v1/setup/status")).body).toEqual({ completed: false, hardwareChecked: false });

    const check = await call("POST", "/api/v1/setup/check");
    expect(check.body.checks.map((c: { label: string }) => c.label)).toEqual([
      "CPU",
      "Memory",
      "Storage",
      "Virtualization",
      "Network",
      "GPU",
      "AI Acceleration",
      "Windows",
    ]);
    expect(check.body.checks.find((c: { key: string }) => c.key === "cuda").summary).toBe("CUDA 13.3 available");

    const rec = await call("GET", "/api/v1/setup/recommendation");
    expect(rec.body.paths).toMatchObject({ apps: "C:\\Nexus\\Apps", database: "C:\\Nexus\\Database", backups: "E:\\NexusBackups", ai: "C:\\Nexus\\AI" });
    expect(rec.body.ai).toMatchObject({ enabled: true, label: "GPU Accelerated", acceleration: "cuda", model: "qwen3:32b" });
    expect(rec.body.drives.database[0]).toMatchObject({ mount: "C:\\", suitability: "recommended" });

    // The test machine has no E: drive, so point every location inside the temp folder.
    const d = (n: string) => join(home, "data", n);
    const bad = await call("POST", "/api/v1/setup/apply", { paths: { apps: "relative\\path" } });
    expect(bad.status).toBe(400);
    const applied = await call("POST", "/api/v1/setup/apply", {
      paths: { apps: d("Apps"), database: d("Database"), files: d("Storage"), backups: d("Backups"), ai: d("AI") },
    });
    expect(applied.status).toBe(200);
    expect(ctx.setupCompleted).toBe(true);
    expect(await ctx.postgres!.state()).toBe("running");
    expect(ctx.activity.list()[0]!.message).toBe("Your server is ready.");
    expect((await call("POST", "/api/v1/setup/apply", {})).status).toBe(409);
  }, 180_000);

  it("only people with Server Settings access can run setup", async () => {
    await ctx.users.createUser({ username: "viewer1", displayName: "Viewer", role: "viewer", password: "correct horse battery staple" });
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { "x-nexus-request": "1" }, payload: { username: "viewer1", password: "correct horse battery staple" } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    const res = await app.inject({ method: "POST", url: "/api/v1/setup/check", headers: { cookie, "x-nexus-request": "1" } });
    expect(res.statusCode).toBe(403);
  });
});
