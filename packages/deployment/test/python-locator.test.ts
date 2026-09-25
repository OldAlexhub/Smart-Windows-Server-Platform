import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bundledPython, machineWidePythons, PythonLocator } from "@nexus/deployment";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "nexus-py-"));
  dirs.push(d);
  return d;
};
const fakeExe = (dir: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "python.exe"), "");
  return join(dir, "python.exe");
};

describe("finding Python for the Nexus service", () => {
  it("uses Nexus's own Python, named after the component version", () => {
    expect(bundledPython("C:\\Nexus\\components\\python\\3.12.14+20260924", "3.12.14+20260924")).toEqual([{ version: "3.12", executable: "C:\\Nexus\\components\\python\\3.12.14+20260924\\python.exe" }]);
    expect(bundledPython(null, null)).toEqual([]);
  });

  it("finds Pythons installed for all users under Program Files", () => {
    const pf = tmp();
    fakeExe(join(pf, "Python313"));
    fakeExe(join(pf, "Python310"));
    mkdirSync(join(pf, "Python39-docs"));
    expect(machineWidePythons(pf).map((p) => p.version).sort()).toEqual(["3.10", "3.13"]);
  });

  it("as the service, ignores per-user installs (their owner could change them)", async () => {
    const own = fakeExe(join(tmp(), "python"));
    const launcher = async () => ({ code: 0, stdout: " -V:3.14 *        C:\\Users\\moham\\AppData\\Local\\Programs\\Python\\Python314\\python.exe\n" });
    const service = new PythonLocator(launcher, [{ version: "3.12", executable: own }], true);
    expect((await service.require(null)).executable).toBe(own);
    // Run by hand (development), the person's own Pythons are fine.
    const byHand = new PythonLocator(launcher, [{ version: "3.12", executable: own }], false);
    expect((await byHand.require(null)).version).toBe("3.14");
  });

  it("explains honestly when the right version isn't available", async () => {
    const own = fakeExe(join(tmp(), "python"));
    const service = new PythonLocator(async () => ({ code: 1, stdout: "" }), [{ version: "3.12", executable: own }], true);
    await expect(service.require(">=3.13")).rejects.toThrow("This application needs Python (>=3.13), but only Python 3.12 is available to Nexus.");
  });
});
