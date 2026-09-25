import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NexusContext } from "../src/context";
import { createNexusServer } from "../src/app";
import { createContext, tempHome } from "./helpers";
import { ownerClient } from "./helpers-http";

let ctx: NexusContext;
let app: FastifyInstance;
let home: string;
let dispose: () => void;
let call: Awaited<ReturnType<typeof ownerClient>>;

function plugin(version: string): string {
  const folder = join(home, `plugin-${version}`);
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, "nexus-plugin.json"),
    JSON.stringify({
      nexus: "plugin/v1",
      id: "test.status",
      name: "Status Extension",
      version,
      apiVersion: 1,
      publisher: "Test publisher",
      description: "Receives server status events.",
      license: "MIT",
      entry: "main.mjs",
      capabilities: ["server.events"],
    }),
  );
  writeFileSync(
    join(folder, "main.mjs"),
    `process.stdout.write(JSON.stringify({ type: "ready", protocol: 1, capabilities: ["server.events"] }) + "\\n"); process.stdin.resume();`,
  );
  return folder;
}

beforeAll(async () => {
  const t = tempHome();
  home = t.home;
  dispose = t.dispose;
  ctx = await createContext(home);
  ({ app } = await createNexusServer(ctx));
  call = await ownerClient(app, ctx);
});

afterAll(async () => {
  await app?.close();
  await ctx?.shutdown();
  dispose?.();
});

describe("plugin API", () => {
  it("previews capabilities, installs disabled, and requires explicit approval and confirmation", async () => {
    const sourceDir = plugin("1.0.0");
    const preview = await call("POST", "/api/v1/plugins/inspect", { sourceDir });
    expect(preview).toMatchObject({
      status: 200,
      body: {
        manifest: { id: "test.status", name: "Status Extension", version: "1.0.0", license: "MIT" },
        capabilities: [{ id: "server.events", risk: "low" }],
        files: 2,
      },
    });
    expect(
      (await call("POST", "/api/v1/plugins", { sourceDir, approvedCapabilities: [], confirmation: "Status Extension" }))
        .status,
    ).toBe(403);
    expect(
      (
        await call("POST", "/api/v1/plugins", {
          sourceDir,
          approvedCapabilities: ["server.events"],
          confirmation: "wrong",
        })
      ).status,
    ).toBe(400);

    const installed = await call("POST", "/api/v1/plugins", {
      sourceDir,
      approvedCapabilities: ["server.events"],
      confirmation: "Status Extension",
    });
    expect(installed.body).toMatchObject({ id: "test.status", enabled: false, status: "installed" });
    expect(JSON.stringify(installed.body)).not.toContain(sourceDir);
  });

  it("enables, restarts, atomically updates, and removes a plugin", async () => {
    const enabled = await call("PUT", "/api/v1/plugins/test.status/enabled", { enabled: true });
    expect(enabled.body).toMatchObject({ enabled: true, status: "running" });
    expect((await call("POST", "/api/v1/plugins/test.status/restart")).body.status).toBe("running");

    const sourceDir = plugin("2.0.0");
    const updated = await call("POST", "/api/v1/plugins/test.status/update", {
      sourceDir,
      approvedCapabilities: ["server.events"],
      confirmation: "Status Extension",
    });
    expect(updated.body).toMatchObject({ version: "2.0.0", enabled: true, status: "running" });
    const list = await call("GET", "/api/v1/plugins");
    expect(list.body.plugins[0]).toMatchObject({ id: "test.status", version: "2.0.0", status: "running" });
    expect(list.body.plugins[0].logs.at(-1).message).toContain("Updated from 1.0.0 to 2.0.0");

    expect((await call("DELETE", "/api/v1/plugins/test.status", { confirmation: "wrong" })).status).toBe(400);
    expect((await call("DELETE", "/api/v1/plugins/test.status", { confirmation: "Status Extension" })).status).toBe(
      200,
    );
    expect((await call("GET", "/api/v1/plugins")).body.plugins).toEqual([]);
    expect(ctx.audit.query({ action: "plugin." }).map((entry) => entry.action)).toEqual([
      "plugin.uninstall",
      "plugin.update",
      "plugin.restart",
      "plugin.enable",
      "plugin.install",
    ]);
  }, 20_000);
});
