import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PluginManager, parsePluginManifest, type PluginCapability } from "@nexus/plugins";
import { StateStore } from "@nexus/state";

let roots: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "nexus-plugin-"));
  roots.push(dir);
  return dir;
};

function packageAt(
  parent: string,
  version = "1.0.0",
  capabilities: PluginCapability[] = ["server.events"],
  readyCapabilities = capabilities,
) {
  const folder = join(parent, `sample-${version}`);
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, "nexus-plugin.json"),
    JSON.stringify({
      nexus: "plugin/v1",
      id: "example.greeter",
      name: "Example Greeter",
      version,
      apiVersion: 1,
      publisher: "Nexus test",
      description: "A self-contained test plugin.",
      license: "MIT",
      homepage: "https://example.test/greeter",
      entry: "plugin.mjs",
      capabilities,
    }),
  );
  writeFileSync(
    join(folder, "plugin.mjs"),
    `import readline from "node:readline";
const capabilities = ${JSON.stringify(readyCapabilities)};
process.stdout.write(JSON.stringify({ type: "ready", protocol: 1, capabilities }) + "\\n");
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.action === "crash.now") return process.exit(7);
  process.stdout.write(JSON.stringify({ type: "response", id: message.id, ok: true, result: { version: ${JSON.stringify(version)}, payload: message.payload } }) + "\\n");
});
`,
  );
  return folder;
}

function setup() {
  const root = temp();
  const store = StateStore.memory();
  const manager = new PluginManager(store, {
    root: join(root, "managed"),
    startupTimeoutMs: 3000,
    requestTimeoutMs: 3000,
  });
  return { root, store, manager };
}

afterEach(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  roots = [];
});

describe("plugin manifests", () => {
  it("requires a stable id, semantic version, supported API, safe entry and known capabilities", () => {
    const valid = {
      nexus: "plugin/v1",
      id: "acme.weather",
      name: "Weather",
      version: "1.2.0",
      apiVersion: 1,
      publisher: "Acme",
      description: "Weather data blocks.",
      license: "Apache-2.0",
      entry: "dist/main.mjs",
      capabilities: ["pipelines.steps"],
    };
    expect(parsePluginManifest(valid)).toMatchObject({ id: "acme.weather", capabilities: ["pipelines.steps"] });
    expect(() => parsePluginManifest({ ...valid, entry: "../outside.mjs" })).toThrow("stay inside");
    expect(() => parsePluginManifest({ ...valid, version: "latest" })).toThrow("semantic version");
    expect(() => parsePluginManifest({ ...valid, capabilities: ["unknown"] })).toThrow("valid Nexus plugin manifest");
  });
});

describe("plugin lifecycle", () => {
  it("inspects and installs a private copy, disabled, only after every capability is approved", async () => {
    const { root, store, manager } = setup();
    const source = packageAt(root, "1.0.0", ["server.events", "pipelines.steps"]);
    const inspection = await manager.inspect(source);
    expect(inspection).toMatchObject({
      manifest: { id: "example.greeter", version: "1.0.0" },
      files: 2,
      capabilities: [{ id: "server.events" }, { id: "pipelines.steps" }],
    });
    await expect(manager.install(source, ["server.events"], "Example Greeter")).rejects.toThrow(
      "Approve every capability",
    );
    const installed = await manager.install(source, ["server.events", "pipelines.steps"], "Example Greeter");
    expect(installed).toMatchObject({ enabled: false, status: "installed", license: "MIT" });
    expect(existsSync(join(root, "managed", "packages", "example.greeter", "plugin.mjs"))).toBe(true);
    store.close();
  });

  it("starts only when enabled, verifies the handshake, and serves capability-scoped requests", async () => {
    const { root, store, manager } = setup();
    await manager.install(packageAt(root), ["server.events"], "Example Greeter");
    expect((await manager.setEnabled("example.greeter", true)).status).toBe("running");
    await expect(
      manager.request("example.greeter", "server.events", "event.echo", { hello: "world" }),
    ).resolves.toEqual({ version: "1.0.0", payload: { hello: "world" } });
    await expect(manager.request("example.greeter", "network.providers", "network.open", {})).rejects.toThrow(
      "doesn't declare",
    );
    expect((await manager.setEnabled("example.greeter", false)).status).toBe("stopped");
    await expect(manager.request("example.greeter", "server.events", "event.echo", {})).rejects.toThrow("switched off");
    await manager.stopAll();
    store.close();
  });

  it("refuses changed installed files before execution", async () => {
    const { root, store, manager } = setup();
    await manager.install(packageAt(root), ["server.events"], "Example Greeter");
    writeFileSync(join(root, "managed", "packages", "example.greeter", "plugin.mjs"), "process.exit(0)");
    const view = await manager.setEnabled("example.greeter", true);
    expect(view).toMatchObject({ enabled: true, status: "tampered" });
    expect(view.lastError).toContain("changed after installation");
    store.close();
  });

  it("starts enabled plugins again after the service restarts", async () => {
    const { root, store, manager } = setup();
    await manager.install(packageAt(root), ["server.events"], "Example Greeter");
    await manager.setEnabled("example.greeter", true);
    await manager.stopAll();
    expect(manager.require("example.greeter")).toMatchObject({ enabled: true, status: "stopped" });

    const restarted = new PluginManager(store, { root: join(root, "managed"), startupTimeoutMs: 3000 });
    await restarted.startEnabled();
    expect(restarted.require("example.greeter")).toMatchObject({ enabled: true, status: "running" });
    await restarted.stopAll();
    store.close();
  });

  it("updates a running plugin atomically and rolls back an update that cannot become ready", async () => {
    const { root, store, manager } = setup();
    await manager.install(packageAt(root, "1.0.0"), ["server.events"], "Example Greeter");
    await manager.setEnabled("example.greeter", true);
    const updated = await manager.update(
      "example.greeter",
      packageAt(root, "2.0.0"),
      ["server.events"],
      "Example Greeter",
    );
    expect(updated).toMatchObject({ version: "2.0.0", enabled: true, status: "running" });
    await expect(manager.request("example.greeter", "server.events", "event.echo", null)).resolves.toMatchObject({
      version: "2.0.0",
    });

    const broken = packageAt(root, "3.0.0", ["server.events"], ["pipelines.steps"]);
    await expect(manager.update("example.greeter", broken, ["server.events"], "Example Greeter")).rejects.toThrow(
      "kept 2.0.0",
    );
    expect(manager.require("example.greeter")).toMatchObject({ version: "2.0.0", status: "running" });
    await expect(manager.request("example.greeter", "server.events", "event.echo", null)).resolves.toMatchObject({
      version: "2.0.0",
    });
    await manager.stopAll();
    store.close();
  }, 20_000);

  it("requires the plugin name before uninstalling and removes its managed files", async () => {
    const { root, store, manager } = setup();
    await manager.install(packageAt(root), ["server.events"], "Example Greeter");
    await expect(manager.uninstall("example.greeter", "wrong")).rejects.toThrow('Type "Example Greeter"');
    await manager.uninstall("example.greeter", "Example Greeter");
    expect(manager.list()).toEqual([]);
    expect(existsSync(join(root, "managed", "packages", "example.greeter"))).toBe(false);
    store.close();
  });
});
