import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const manifest = JSON.parse(readFileSync(resolve("components.json"), "utf8"));
const available = existsSync(resolve(`vendor/.downloads/npm-${manifest.components.npm.version}.tar.gz`));
it.skipIf(!available)("rejects a mixed npm dependency tree and replaces it with the verified release", async () => {
  const module = "../scripts/stage-npm.mjs";
  const { stageNpm, verifyNpm } = await import(module);
  const fixture = mkdtempSync(join(tmpdir(), "nexus-npm-regression-"));
  try {
    cpSync(process.execPath, join(fixture, process.platform === "win32" ? "node.exe" : "node"));
    stageNpm(resolve("."), fixture, manifest.components.npm);
    const flush = join(fixture, "node_modules/npm/node_modules/minipass-flush");
    // Reproduce the shipped mismatch: newer code asks for a named Minipass export from v3.
    writeFileSync(join(flush, "index.js"), "const { Minipass } = require('minipass'); module.exports = class extends Minipass {};\n");
    expect(() => verifyNpm(fixture)).toThrow(/Class extends value undefined/);
    const stale = join(flush, "node_modules/obsolete"); mkdirSync(stale, { recursive: true });
    stageNpm(resolve("."), fixture, manifest.components.npm);
    expect(existsSync(stale)).toBe(false);
    verifyNpm(fixture);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
}, 180_000);
