import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { BRAND } from "@nexus/shared";

const ROOT = join(__dirname, "..", "..", "..");
const SCAN_DIRS = ["packages", "apps"];
const SKIP = new Set(["node_modules", "dist", "target", "test", ".vite"]);

function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* sourceFiles(full);
    else if (/\.(ts|tsx)$/.test(name)) yield full;
  }
}

describe("branding", () => {
  it("exposes a complete brand definition", () => {
    expect(BRAND.productName).toBeTruthy();
    expect(BRAND.serviceId).not.toMatch(/\s/);
    expect(BRAND.envPrefix).toMatch(/^[A-Z_]+_$/);
  });

  it("product name is not hard-coded outside brand.ts", () => {
    const offenders: string[] = [];
    for (const d of SCAN_DIRS) {
      for (const file of sourceFiles(join(ROOT, d))) {
        if (file.endsWith("brand.ts")) continue;
        if (readFileSync(file, "utf8").includes(BRAND.productName)) offenders.push(relative(ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
