import { mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "@nexus/state";
import { classifyLine, isContinuation, LogManager, Redactor } from "@nexus/logs";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function setup(now?: () => Date) {
  const root = mkdtempSync(join(tmpdir(), "nexus-logs-"));
  dirs.push(root);
  return { logs: new LogManager(StateStore.memory(), root, { now }), root };
}

describe("classifyLine", () => {
  it.each([
    ['{"level":50,"msg":"db down"}', "error"],
    ['{"level":40,"msg":"slow"}', "warning"],
    ['{"level":"info","message":"ok"}', "info"],
    ["2026-09-23 10:00:01,123 - app - ERROR - boom", "error"],
    ["ERROR:root:failed to connect", "error"],
    ["WARNING: this is deprecated", "warning"],
    ["[WARN] disk is 85% full", "warning"],
    ["INFO:     127.0.0.1:5000 - \"GET / HTTP/1.1\" 200 OK", "info"],
    ["Error: connect ECONNREFUSED 127.0.0.1:5432", "error"],
    ["Traceback (most recent call last):", "error"],
    ["(node:123) DeprecationWarning: Buffer() is deprecated", "warning"],
    ["GET /api/drivers 200 12ms", "info"],
    ["Server listening on 43127", "info"],
    ["level=error msg=\"x\"", "error"],
    ["Invalid environment configuration:", "error"],
    ["- CLIENT_URL is required when NODE_ENV=production.", "error"],
    ["Server startup failed.", "error"],
  ])("%s → %s", (line, level) => {
    expect(classifyLine(line)).toBe(level);
  });

  it("recognises stack continuation lines", () => {
    expect(isContinuation("    at Pool.connect (C:\\app\\db.js:10:5)", "Error: x")).toBe(true);
    expect(isContinuation('  File "app.py", line 3, in <module>', "Traceback (most recent call last):")).toBe(true);
    expect(isContinuation("ValueError: bad", '    raise ValueError("bad")')).toBe(true);
    expect(isContinuation("GET / 200", "Error: x")).toBe(false);
  });
});

describe("Redactor", () => {
  it("masks connection strings, key=value secrets and registered values", () => {
    const r = new Redactor();
    r.addSecret("Zq9-generated-db-pass");
    expect(r.redact("connecting to postgres://taxiops:Zq9@127.0.0.1:43500/taxiops")).toBe(
      "connecting to postgres://taxiops:***@127.0.0.1:43500/taxiops",
    );
    expect(r.redact('password="hunter2" token=abc123 other=1')).toBe('password="***" token=*** other=1');
    expect(r.redact("pass is Zq9-generated-db-pass!")).toBe("pass is ***!");
  });
});

describe("LogManager", () => {
  it("groups a Node stack trace into one error entry and counts activity", () => {
    const { logs } = setup();
    logs.write("app:taxiops", "stdout", "Server listening on 43127");
    logs.write("app:taxiops", "stderr", "Error: connect ECONNREFUSED 127.0.0.1:5432");
    logs.write("app:taxiops", "stderr", "    at TCPConnectWrap.afterConnect (node:net:1555:16)");
    logs.write("app:taxiops", "stderr", "    at Pool.connect (C:\\app\\db.js:10:5)");
    logs.write("app:taxiops", "stdout", "GET /health 200");
    logs.write("app:taxiops", "stderr", "(node:1) DeprecationWarning: x is deprecated");
    logs.flush();
    const tail = logs.tail("app:taxiops");
    expect(tail.map((e) => e.level)).toEqual(["info", "error", "info", "warning"]);
    expect(tail[1]!.message.split("\n")).toHaveLength(3);
    expect(logs.countsFor("app:taxiops")).toEqual({ errors: 1, warnings: 1, info: 2 });
  });

  it("groups a Python traceback", () => {
    const { logs } = setup();
    for (const l of [
      "Traceback (most recent call last):",
      '  File "C:\\app\\main.py", line 3, in <module>',
      "    raise ValueError('provider_id not found')",
      "ValueError: provider_id not found",
    ]) logs.write("pipe", "stderr", l);
    logs.flush();
    const [e] = logs.tail("pipe");
    expect(e!.level).toBe("error");
    expect(e!.message).toContain("ValueError: provider_id not found");
    expect(logs.tail("pipe")).toHaveLength(1);
  });

  it("persists, searches newest-first, filters problems, and redacts before storing", () => {
    const { logs, root } = setup();
    logs.redactor("app:x").addSecret("S3cretPassw0rd");
    logs.write("app:x", "stdout", "first request");
    logs.write("app:x", "stderr", "ERROR login failed for password S3cretPassw0rd");
    logs.write("app:x", "stdout", "second request");
    logs.flush();
    expect(logs.search("app:x", { text: "request" }).map((e) => e.message)).toEqual(["second request", "first request"]);
    const problems = logs.search("app:x", { level: "problems" });
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).not.toContain("S3cretPassw0rd");
    expect(readdirSync(join(root, "app_x"))[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.jsonl$/);
  });

  it("strips ANSI colour codes and notifies subscribers", () => {
    const { logs } = setup();
    const seen: string[] = [];
    logs.subscribe((e) => seen.push(e.message));
    logs.write("s", "stdout", "\x1b[32mready\x1b[0m");
    logs.flush();
    expect(seen).toEqual(["ready"]);
  });

  it("applies retention to old daily files", () => {
    const now = new Date("2026-09-23T12:00:00Z");
    const { logs, root } = setup(() => now);
    mkdirSync(join(root, "app_old"), { recursive: true });
    writeFileSync(join(root, "app_old", "2026-08-01.jsonl"), "");
    writeFileSync(join(root, "app_old", "2026-09-20.jsonl"), "");
    expect(logs.applyRetention(14)).toBe(1);
    expect(readdirSync(join(root, "app_old"))).toEqual(["2026-09-20.jsonl"]);
  });
});
