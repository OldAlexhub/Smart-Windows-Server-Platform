import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it.skipIf(process.platform !== "win32")(
  "packages a clean portable ZIP without deleting or including existing user data",
  async () => {
    const helper = "../scripts/package-portable.mjs";
    const { packagePortable } = await import(helper);
    const root = mkdtempSync(join(tmpdir(), "nexus-package-test-"));
    try {
      for (const path of ["dist/app", "scripts/portable", "dist/NexusPortable/data"])
        mkdirSync(join(root, path), { recursive: true });
      writeFileSync(join(root, "dist/app/VERSION"), "new build");
      writeFileSync(join(root, "scripts/portable/Start Nexus.cmd"), "launcher");
      writeFileSync(join(root, "HOW-TO-USE-NEXUS.md"), "guide");
      writeFileSync(join(root, "dist/NexusPortable/data/keep.txt"), "user data");
      const archive = packagePortable(root);
      const entries = execFileSync("tar.exe", ["-tf", archive], { encoding: "utf8" });
      expect(entries).toContain("NexusPortable/app/VERSION");
      expect(entries).toContain("NexusPortable/Start Nexus.cmd");
      expect(entries).not.toContain("NexusPortable/data");
      expect(readFileSync(join(root, "dist/NexusPortable/data/keep.txt"), "utf8")).toBe("user data");
      expect(packagePortable(root)).toBe(archive); // Replacing an older ZIP also works on Windows.
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
