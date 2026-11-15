import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileSync = vi.fn();
const originalArgv = process.argv;

beforeEach(() => {
  vi.resetModules();
  execFileSync.mockReset();
  vi.doMock("node:child_process", () => ({ execFileSync }));
  vi.doMock("node:fs", () => ({
    existsSync: () => true,
    copyFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: () => '<service><env name="NEXUS_HOME" value="D:\\NexusData"/><env name="NEXUS_PORT" value="7780"/></service>',
  }));
});

afterEach(() => {
  process.argv = originalArgv;
  vi.doUnmock("node:child_process");
  vi.doUnmock("node:fs");
});

async function run(command: string) {
  process.argv = [process.execPath, "service.mjs", command, "--install-dir", "C:/Nexus"];
  const script = "../scripts/service.mjs";
  await import(script);
}

describe("installer service commands", () => {
  it.each(["install", "uninstall"])("blocks %s when shutdown fails", async (command) => {
    execFileSync.mockImplementation((_exe, args) => {
      if (args[0] === "status") return "Started";
      throw new Error("stop failed");
    });
    await expect(run(command)).rejects.toThrow("stop failed");
    expect(execFileSync.mock.calls.map((call) => call[1][0])).toEqual(["status", "stop"]);
  });

  it("does not treat a status query error as an absent service", async () => {
    execFileSync.mockImplementation(() => {
      throw new Error("access denied");
    });
    await expect(run("uninstall")).rejects.toThrow("access denied");
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["Started", ["status", "stop", "uninstall"]],
    ["Stopped", ["status", "uninstall"]],
    ["NonExistent", ["status"]],
  ])("uninstalls safely when status is %s", async (status, commands) => {
    execFileSync.mockReturnValue(status);
    await run("uninstall");
    expect(execFileSync.mock.calls.map((call) => call[1][0])).toEqual(commands);
  });
});
