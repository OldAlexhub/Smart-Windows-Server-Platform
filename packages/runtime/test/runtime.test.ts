import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AppSupervisor,
  buildIsolatedEnv,
  defaultRuntimeContext,
  ProcessIsolationProvider,
  resolveCommand,
  substituteArgs,
  type AppProcessConfig,
} from "@nexus/runtime";
import { isPortFree } from "@nexus/network";
import { freePort } from "./ports";

const dirs: string[] = [];
const sups: AppSupervisor[] = [];
afterEach(async () => {
  for (const s of sups.splice(0)) await s.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function workspace(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "nexus-rt-"));
  dirs.push(root);
  const release = join(root, "release");
  mkdirSync(release);
  for (const [n, c] of Object.entries(files)) writeFileSync(join(release, n), c);
  return { root, release, home: join(root, "home") };
}

const SERVER = `
const http = require("http");
console.log("secret visible:", process.env.NEXUS_TEST_SENTINEL ?? "no");
console.log("home:", process.env.USERPROFILE);
console.error("a warning line");
http.createServer((q, s) => s.end(JSON.stringify({ port: process.env.PORT, host: process.env.HOST, db: process.env.DATABASE_URL })))
  .listen(Number(process.env.PORT), process.env.HOST, () => console.log("listening on " + process.env.PORT));
`;


function config(release: string, home: string, file: string, port: number, extra: Partial<AppProcessConfig> = {}): AppProcessConfig {
  const ctx = defaultRuntimeContext();
  const cmd = resolveCommand("node", [file], ctx);
  return {
    appId: "taxiops",
    cwd: release,
    executable: cmd.executable,
    args: cmd.args,
    env: buildIsolatedEnv({ homeDir: home, pathDirs: cmd.pathDirs, appEnv: { DATABASE_URL: "postgres://app@127.0.0.1/db" }, port }),
    port,
    resources: { cpuLimitPercent: "auto", memoryLimitMb: "auto", priority: "normal" },
    startupTimeoutMs: 15_000,
    ...extra,
  };
}

describe("buildIsolatedEnv", () => {
  it("drops host variables, sets private folders, and Nexus owns PORT/HOST", () => {
    const { home } = workspace({});
    const env = buildIsolatedEnv({
      homeDir: home,
      pathDirs: ["C:\\Nexus\\runtime\\node"],
      appEnv: { PORT: "80", HOST: "0.0.0.0", JWT_SECRET: "x", NODE_ENV: "staging" },
      port: 43127,
      hostEnv: { SystemRoot: "C:\\Windows", AWS_SECRET_ACCESS_KEY: "leak", PATH: "C:\\evil", USERPROFILE: "C:\\Users\\admin" },
    });
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.PATH!.startsWith("C:\\Nexus\\runtime\\node;C:\\Windows\\System32")).toBe(true);
    expect(env.PATH).not.toContain("evil");
    expect(env.USERPROFILE).toBe(home);
    expect(env.TEMP).toBe(join(home, "tmp"));
    expect(env.PORT).toBe("43127");
    expect(env.HOST).toBe("127.0.0.1");
    expect(env.JWT_SECRET).toBe("x");
    expect(env.NODE_ENV).toBe("staging");
  });

  it("substitutes {PORT}", () => {
    expect(substituteArgs(["--port", "{PORT}", "--listen=127.0.0.1:{PORT}"], { PORT: 43001 })).toEqual([
      "--port",
      "43001",
      "--listen=127.0.0.1:43001",
    ]);
  });
});

describe("resolveCommand", () => {
  it("runs npm through the bundled node without cmd.exe", () => {
    const r = resolveCommand("npm", ["run", "start"], defaultRuntimeContext());
    expect(r.executable).toBe(process.execPath);
    expect(r.args[0]).toMatch(/npm-cli\.js$/);
    expect(r.args.slice(1)).toEqual(["run", "start"]);
  });
  it("uses the app's venv for python and pip", () => {
    const r = resolveCommand("pip", ["install", "-r", "requirements.txt"], { nodeExe: process.execPath, venvDir: "C:\\Nexus\\Apps\\x\\venv" });
    expect(r.executable).toMatch(/venv[\\/]Scripts[\\/]python\.exe$|venv[\\/]bin[\\/]python$/);
    expect(r.args).toEqual(["-m", "pip", "install", "-r", "requirements.txt"]);
    expect(() => resolveCommand("python", [], { nodeExe: process.execPath })).toThrow(/no environment/);
  });
});

describe("AppSupervisor with ProcessIsolationProvider (real processes)", () => {
  it("starts an app, waits for its port, captures logs, and stops it", async () => {
    process.env.NEXUS_TEST_SENTINEL = "super-secret";
    const { release, home } = workspace({ "server.js": SERVER });
    const port = await freePort();
    const sup = new AppSupervisor(config(release, home, "server.js", port), new ProcessIsolationProvider());
    sups.push(sup);
    const lines: string[] = [];
    const statuses: string[] = [];
    sup.on("output", (s, l) => lines.push(`${s}:${l}`));
    sup.on("status", (s) => statuses.push(s));

    expect(await sup.start()).toBe("running");
    expect(sup.pid).toBeGreaterThan(0);
    const res = await (await fetch(`http://127.0.0.1:${port}/`)).json();
    expect(res).toEqual({ port: String(port), host: "127.0.0.1", db: "postgres://app@127.0.0.1/db" });
    expect(lines).toContain("stdout:secret visible: no");
    expect(lines).toContain(`stdout:home: ${home}`);
    expect(lines).toContain("stderr:a warning line");

    await sup.stop();
    expect(sup.status).toBe("stopped");
    expect(await isPortFree(port)).toBe(true);
    expect(statuses).toEqual(["starting", "running", "stopped"]);
    delete process.env.NEXUS_TEST_SENTINEL;
  });

  it("detects a crash and reports it", async () => {
    const { release, home } = workspace({
      "crash.js": `const http=require("http");http.createServer().listen(Number(process.env.PORT),"127.0.0.1",()=>{console.log("up");setTimeout(()=>process.exit(3),300)});`,
    });
    const sup = new AppSupervisor(config(release, home, "crash.js", await freePort()), new ProcessIsolationProvider());
    sups.push(sup);
    const crashed = new Promise((r) => sup.once("crash", r));
    expect(await sup.start()).toBe("running");
    expect(await crashed).toMatchObject({ code: 3, requested: false });
    expect(sup.status).toBe("crashed");
    expect(sup.detail).toMatch(/exit code 3/);
  });

  it("reports an app that exits immediately (bad start)", async () => {
    const { release, home } = workspace({ "bad.js": `throw new Error("Cannot find module 'express'")` });
    const sup = new AppSupervisor(config(release, home, "bad.js", await freePort()), new ProcessIsolationProvider());
    sups.push(sup);
    const errs: string[] = [];
    sup.on("output", (s, l) => s === "stderr" && errs.push(l));
    expect(await sup.start()).toBe("crashed");
    expect(errs.join("\n")).toContain("Cannot find module 'express'");
  });

  it("flags an app that never opens its port", async () => {
    const { release, home } = workspace({ "silent.js": `setInterval(()=>{}, 1000)` });
    const sup = new AppSupervisor(config(release, home, "silent.js", await freePort(), { startupTimeoutMs: 1500 }), new ProcessIsolationProvider());
    sups.push(sup);
    expect(await sup.start()).toBe("needs_attention");
    expect(sup.detail).toMatch(/not answering/);
  });

  it("stop kills the whole process tree (npm → node style)", async () => {
    const { release, home } = workspace({
      "parent.js": `const {spawn}=require("child_process");const c=spawn(process.execPath,["server.js"],{stdio:"inherit",env:process.env});setInterval(()=>{},1000);`,
      "server.js": SERVER,
    });
    const port = await freePort();
    const sup = new AppSupervisor(config(release, home, "parent.js", port), new ProcessIsolationProvider());
    sups.push(sup);
    expect(await sup.start()).toBe("running");
    await sup.stop();
    await new Promise((r) => setTimeout(r, 500));
    expect(await isPortFree(port)).toBe(true); // grandchild is gone too
  });

  it("restarts", async () => {
    const { release, home } = workspace({ "server.js": SERVER });
    const sup = new AppSupervisor(config(release, home, "server.js", await freePort()), new ProcessIsolationProvider());
    sups.push(sup);
    await sup.start();
    const firstPid = sup.pid;
    expect(await sup.restart()).toBe("running");
    expect(sup.pid).not.toBe(firstPid);
  });
});
