import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sourceChangesSince } from "@nexus/deployment";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("changes waiting to be deployed", () => {
  it("finds files edited after the release, ignoring what a deploy never copies", () => {
    const root = mkdtempSync(join(tmpdir(), "nexus-src-"));
    dirs.push(root);
    const old = new Date("2026-01-01T00:00:00Z");
    const write = (rel: string, mtime: Date) => {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), "x");
      utimesSync(join(root, rel), mtime, mtime);
    };
    write("server.js", old);
    write("public/index.html", old);
    const release = new Date("2026-06-01T00:00:00Z");
    expect(sourceChangesSince(root, release)).toEqual({ changed: [], scanned: 2, newestMs: 0 });

    const now = new Date();
    write("public/index.html", now);
    write("node_modules/express/index.js", now); // dependencies are reinstalled, not copied
    write(".env", now); // secrets are never copied
    write("__pycache__/app.cpython-312.pyc", now);
    expect(sourceChangesSince(root, release).changed).toEqual(["public/index.html"]);
  });
});
