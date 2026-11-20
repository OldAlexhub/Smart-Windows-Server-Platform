import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger, memorySink } from "@nexus/shared";
import { locatePostgresBinaries, PostgresEngine } from "../src/postgres";

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFile,
}));
let root: string;
type Result = (err: Error | null, stdout: string, stderr: string) => void;
let init: (args: string[], done: Result) => void;

function initialized(args: string[], done: Result) {
  const data = args[args.indexOf("-D") + 1]!;
  mkdirSync(join(data, "global"), { recursive: true });
  writeFileSync(join(data, "PG_VERSION"), "18");
  writeFileSync(join(data, "global/pg_control"), "control");
  writeFileSync(join(data, "postgresql.conf"), "# defaults\n");
  done(null, "initialized", "");
}

function engine() {
  const sink = memorySink();
  const pg = new PostgresEngine({
    bin: { binDir: join(root, "bin"), version: "18.4-1" },
    dataDir: join(root, "pg18"),
    port: 43500,
    superuser: "nexus_admin",
    superuserPassword: "private-test-password",
    tuning: {},
    logger: createLogger({ sinks: [sink] }),
  });
  return { pg, sink };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nexus-pg-setup-"));
  init = initialized;
  execFile.mockReset().mockImplementation((file: string, args: string[], _opts: unknown, done: Result) => {
    if (basename(file) === "whoami.exe") done(null, '"PC\\user","S-1-5-21-123-456-789-1001"', "");
    else if (basename(file) === "icacls.exe") done(null, "Success", "");
    else init(args, done);
  });
});
afterEach(() => {
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("nexus-pg-setup-"))
    throw new Error("Unsafe cleanup");
  rmSync(root, { recursive: true, force: true });
});

describe("database setup resilience", () => {
  it("reports and logs silent Windows loader failures with their exit status", async () => {
    init = (_args, done) => done(Object.assign(new Error("Process failed"), { code: -1073741515 }), "", "");
    const { pg, sink } = engine();
    const error = await pg.initialize().catch((e) => e);
    expect(error.problem.summary).toContain("required database component could not load");
    expect(error.problem.technical).toContain("0xc0000135");
    expect(sink.records.some((r) => String(r.technical).includes("0xc0000135"))).toBe(true);
    expect(existsSync(pg.dataDir)).toBe(false);
    expect(readdirSync(root).filter((name) => name.startsWith(".pg18-setup-"))).toEqual([]);
  });

  it("keeps interrupted attempts separate, removes passwords, and succeeds on retry", async () => {
    const { pg } = engine();
    let firstAttempt = "";
    init = (args, done) => {
      firstAttempt = args[args.indexOf("-D") + 1]!;
      mkdirSync(firstAttempt, { recursive: true });
      writeFileSync(join(firstAttempt, "PG_VERSION"), "18");
      done(Object.assign(new Error("terminated"), { code: 1, killed: true }), "", "");
    };
    await expect(pg.initialize()).rejects.toThrow("could not set up");
    expect(existsSync(join(dirname(firstAttempt), "password"))).toBe(false);
    expect(pg.isInitialized()).toBe(false);
    init = initialized;
    await pg.initialize();
    expect(pg.isInitialized()).toBe(true);
    expect(readFileSync(join(firstAttempt, "PG_VERSION"), "utf8")).toBe("18");
    expect(readFileSync(join(pg.dataDir, "nexus.conf"), "utf8")).toContain(pg.dataDir.replaceAll("\\", "/") + "/log");
  });

  it("preserves existing incomplete data, even when PG_VERSION exists", async () => {
    const { pg } = engine();
    mkdirSync(pg.dataDir);
    writeFileSync(join(pg.dataDir, "PG_VERSION"), "18");
    writeFileSync(join(pg.dataDir, "important-data"), "keep");
    expect(pg.isInitialized()).toBe(false);
    await expect(pg.initialize()).rejects.toMatchObject({ problem: { title: "Existing database needs recovery" } });
    expect(execFile).not.toHaveBeenCalled();
    expect(readFileSync(join(pg.dataDir, "important-data"), "utf8")).toBe("keep");
  });

  it("coalesces concurrent initialization and does not initialize a completed database again", async () => {
    const { pg } = engine();
    await Promise.all([pg.initialize(), pg.initialize()]);
    await pg.initialize();
    expect(execFile.mock.calls.filter(([file]) => basename(file).startsWith("initdb"))).toHaveLength(1);
    expect(pg.isInitialized()).toBe(true);
  });

  it("never writes a bootstrap password to diagnostics", async () => {
    init = (_args, done) => done(Object.assign(new Error("failed"), { code: 1 }), "private-test-password", "");
    const { pg, sink } = engine();
    const error = await pg.initialize().catch((e) => e);
    expect(error.problem.technical).toContain("[redacted]");
    expect(JSON.stringify(sink.records)).not.toContain("private-test-password");
  });

  it("uses the tested bundled database instead of a newer unrelated installation", () => {
    function binaries(parent: string, version: string) {
      const bin = join(parent, version, "bin");
      mkdirSync(bin, { recursive: true });
      for (const tool of ["postgres", "initdb", "pg_ctl", "pg_dump", "pg_restore"])
        writeFileSync(join(bin, tool + (process.platform === "win32" ? ".exe" : "")), "");
      return bin;
    }
    const bundled = binaries(join(root, "bundled"), "18.4-1");
    const system = binaries(join(root, "programs/PostgreSQL"), "19.0");
    expect(
      locatePostgresBinaries({ bundledRoots: [join(root, "bundled")], programFiles: join(root, "programs") }),
    ).toEqual({ binDir: bundled, version: "18.4-1" });
    expect(locatePostgresBinaries({ configured: bundled })?.version).toBe("18.4-1");
    mkdirSync(join(root, "existing/pg19"), { recursive: true });
    writeFileSync(join(root, "existing/pg19/PG_VERSION"), "19");
    expect(
      locatePostgresBinaries({
        bundledRoots: [join(root, "bundled")],
        programFiles: join(root, "programs"),
        dataRoot: join(root, "existing"),
      }),
    ).toEqual({ binDir: system, version: "19.0" });
    expect(
      locatePostgresBinaries({
        bundledRoots: [join(root, "bundled")],
        programFiles: join(root, "missing"),
        dataRoot: join(root, "existing"),
      }),
    ).toBeNull();
  });
});
