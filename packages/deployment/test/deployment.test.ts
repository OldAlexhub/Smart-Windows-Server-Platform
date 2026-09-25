import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeProject } from "@nexus/detection";
import { StateStore } from "@nexus/state";
import { defaultRuntimeContext } from "@nexus/runtime";
import {
  choosePython,
  DeploymentManager,
  explainInstallFailure,
  parsePyLauncherList,
  PythonLocator,
  readGitCommit,
  satisfies,
  suggestVersion,
} from "@nexus/deployment";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "nexus-dep-"));
  dirs.push(d);
  return d;
}
function write(root: string, files: Record<string, string>) {
  for (const [rel, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), c);
  }
}
function manager(store = StateStore.memory(), keep = 5) {
  const base = tmp();
  return { mgr: new DeploymentManager(store, { appsRoot: join(base, "Apps"), runtime: defaultRuntimeContext(), keepReleases: keep }), base, store };
}

describe("Python runtime selection", () => {
  it("parses py launcher output (modern and legacy)", () => {
    expect(
      parsePyLauncherList(
        " -V:3.13 *        C:\\Python313\\python.exe\n -V:3.12          C:\\Users\\me\\AppData\\Local\\Programs\\Python\\Python312\\python.exe\n -3.9-64          C:\\Python39\\python.exe\n",
      ),
    ).toEqual([
      { version: "3.13", executable: "C:\\Python313\\python.exe" },
      { version: "3.12", executable: "C:\\Users\\me\\AppData\\Local\\Programs\\Python\\Python312\\python.exe" },
      { version: "3.9", executable: "C:\\Python39\\python.exe" },
    ]);
  });

  it("matches version requirements", () => {
    expect(satisfies("3.12", ">=3.11")).toBe(true);
    expect(satisfies("3.10", ">=3.11")).toBe(false);
    expect(satisfies("3.12", "^3.11")).toBe(true);
    expect(satisfies("3.12", ">=3.9,<3.12")).toBe(false);
    expect(satisfies("3.11", "~=3.11")).toBe(true);
    expect(satisfies("3.12", "3.12")).toBe(true);
    expect(satisfies("3.13", "3.12")).toBe(false);
    expect(satisfies("3.12", "==3.12.*")).toBe(true);
    expect(satisfies("3.12", null)).toBe(true);
  });

  it("chooses the newest matching interpreter and suggests one to install", () => {
    const installs = [
      { version: "3.9", executable: "a" },
      { version: "3.13", executable: "b" },
      { version: "3.12", executable: "c" },
    ];
    expect(choosePython(installs, ">=3.10,<3.13")?.executable).toBe("c");
    expect(choosePython(installs, null)?.executable).toBe("b");
    expect(choosePython(installs, ">=3.14")).toBeNull();
    expect(suggestVersion("<3.12")).toBe("3.11");
  });

  it("explains what to do when no Python matches (no promise of an install it can't do)", async () => {
    const locator = new PythonLocator(async () => ({ code: 1, stdout: "" }), [], true);
    const err = await locator.require(">=3.11").catch((e) => e);
    expect(err.code).toBe("dependency_missing");
    expect(err.problem.summary).toMatch(/Reinstall Nexus/);
    expect(err.problem.repair).toBeUndefined();
  });
});

describe("DeploymentManager", () => {
  it("creates an isolated Node release: copies code, never copies secrets/deps/.git, installs", async () => {
    const src = join(tmp(), "TaxiOpsBackend");
    write(src, {
      "package.json": JSON.stringify({ name: "taxiops-backend", version: "1.4.8", scripts: { start: "node server.js" }, dependencies: {} }), // no deps → offline install
      "server.js": "require('http').createServer().listen(process.env.PORT)",
      ".env": "DATABASE_URL=postgres://prod:SECRET@x/db",
      ".env.example": "DATABASE_URL=",
      "node_modules/express/index.js": "junk",
      ".git/HEAD": "ref: refs/heads/main\n",
      ".git/refs/heads/main": "0123456789abcdef0123456789abcdef01234567\n",
    });
    const analysis = analyzeProject(src);
    const { mgr } = manager();
    const steps: string[] = [];
    const d = await mgr.prepareRelease({ appId: "a1", slug: "taxiops", analysis, onStep: (k, s) => steps.push(`${k}:${s}`) });

    expect(d).toMatchObject({ status: "ready", seq: 1, versionLabel: "v1.4.8", sourceCommit: "0123456" });
    expect(existsSync(join(d.releaseDir, "server.js"))).toBe(true);
    expect(existsSync(join(d.releaseDir, ".env"))).toBe(false);
    expect(existsSync(join(d.releaseDir, ".env.example"))).toBe(true);
    expect(existsSync(join(d.releaseDir, ".git"))).toBe(false);
    expect(existsSync(join(d.releaseDir, "node_modules", "express"))).toBe(false);
    expect(existsSync(join(d.releaseDir, "package-lock.json"))).toBe(true); // npm install ran
    expect(existsSync(join(src, "package-lock.json"))).toBe(false); // source untouched
    expect(steps).toEqual(["copy:running", "copy:done", "runtime:skipped", "install:running", "install:done", "build:skipped"]);
  }, 120_000);

  it("creates a private Python environment per release", async () => {
    const src = join(tmp(), "reports");
    write(src, { "main.py": "print('hi')", "requirements.txt": "# none yet\n" });
    const { mgr } = manager();
    const d = await mgr.prepareRelease({ appId: "p1", slug: "reports", analysis: analyzeProject(src) });
    expect(d.status).toBe("ready");
    expect(d.pythonVersion).toMatch(/^3\.\d+$/);
    expect(existsSync(join(d.venvDir!, "Scripts", "python.exe")) || existsSync(join(d.venvDir!, "bin", "python"))).toBe(true);
    expect(mgr.runtimeFor(d).venvDir).toBe(d.venvDir);
  }, 180_000);

  it("records a failed build with a friendly message", async () => {
    const src = join(tmp(), "broken");
    write(src, {
      "package.json": JSON.stringify({ scripts: { start: "node dist/index.js", build: "node -e \"process.exit(2)\"" } }),
      "tsconfig.json": "{}",
    });
    const analysis = analyzeProject(src);
    expect(analysis.components[0]!.build).toEqual({ command: "npm", args: ["run", "build"] });
    const { mgr } = manager();
    const err = await mgr.prepareRelease({ appId: "b1", slug: "broken", analysis }).catch((e) => e);
    expect(err.message).toMatch(/build step failed/);
    expect(mgr.history("b1")[0]).toMatchObject({ status: "failed" });
  }, 120_000);

  it("tracks history, activation, rollback safety and pruning", async () => {
    const src = join(tmp(), "site");
    write(src, { "index.html": "<h1>v</h1>" });
    const { mgr } = manager(StateStore.memory(), 3);
    const analysis = analyzeProject(src);
    const r1 = await mgr.prepareRelease({ appId: "s", slug: "site", analysis });
    mgr.activate(r1.id);
    const r2 = await mgr.prepareRelease({ appId: "s", slug: "site", analysis });
    mgr.activate(r2.id);
    expect(mgr.current("s")!.id).toBe(r2.id);
    expect(mgr.get(r1.id)!.status).toBe("superseded");
    expect(mgr.rollbackCheck(r1.id)).toEqual({ allowed: true, requiresConfirmation: false, reason: null });
    expect(mgr.rollbackCheck(r2.id).allowed).toBe(false);

    mgr.markMigrationsRan(r2.id);
    const check = mgr.rollbackCheck(r1.id);
    expect(check).toMatchObject({ allowed: true, requiresConfirmation: true });
    expect(check.reason).toMatch(/database structure/);

    for (let i = 0; i < 3; i++) mgr.activate((await mgr.prepareRelease({ appId: "s", slug: "site", analysis })).id);
    const hist = mgr.history("s");
    expect(hist.map((h) => h.seq)).toEqual([5, 4, 3, 2, 1]);
    expect(hist.filter((h) => h.status === "pruned").map((h) => h.seq)).toEqual([2, 1]);
    expect(existsSync(r1.releaseDir)).toBe(false);
    expect(mgr.rollbackCheck(r1.id).reason).toMatch(/no longer available/);
    expect(readFileSync(join(mgr.current("s")!.releaseDir, "index.html"), "utf8")).toContain("<h1>");
  });

  it("explains install failures in plain language", () => {
    expect(explainInstallFailure(["npm ERR! code ENOTFOUND", "npm ERR! request to https://registry.npmjs.org failed"])).toMatch(/internet connection/);
    expect(explainInstallFailure(["ERROR: No matching distribution found for torch==9"])).toMatch(/Python packages/);
    expect(explainInstallFailure(["gyp ERR! find VS"])).toMatch(/build tools/);
  });

  it("reads git commits from packed refs", () => {
    const root = tmp();
    write(root, { ".git/HEAD": "ref: refs/heads/main\n", ".git/packed-refs": "# pack-refs\nabcdef1234567890abcdef1234567890abcdef12 refs/heads/main\n" });
    expect(readGitCommit(root)).toBe("abcdef1");
    expect(readGitCommit(tmp())).toBeNull();
  });
});
