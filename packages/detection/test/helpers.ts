import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach } from "vitest";

const created: string[] = [];
afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Writes a fake project to a temp folder: { "package.json": {...} | "text" }. */
export function project(files: Record<string, unknown>, folderName = "Project"): string {
  const base = mkdtempSync(join(tmpdir(), "nexus-detect-"));
  created.push(base);
  const root = join(base, folderName);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
  mkdirSync(root, { recursive: true });
  return root;
}
