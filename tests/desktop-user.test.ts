import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { desktopUsers } from "../apps/server/src/service/permissions";

const modulePath = "../scripts/desktop-user.mjs";
const { recordDesktopUser } = await import(modulePath);

describe("installer desktop identity", () => {
  it("records a SID in a custom data location, keeps existing users and is repeatable", () => {
    const root = mkdtempSync(join(tmpdir(), "nexus-desktop-user-"));
    const file = join(root, "desktop-users.txt");
    try {
      writeFileSync(file, "PC\\existing");
      const identify = () => "S-1-5-21-111-222-333-1001\r\n";
      recordDesktopUser(root, identify);
      recordDesktopUser(root, identify);
      expect(readFileSync(file, "utf8")).toBe("PC\\existing\r\nS-1-5-21-111-222-333-1001\r\n");
      expect(desktopUsers(root)).toEqual(["PC\\existing", "*S-1-5-21-111-222-333-1001"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects failed identity lookup without changing existing access", () => {
    const root = mkdtempSync(join(tmpdir(), "nexus-desktop-user-"));
    const file = join(root, "desktop-users.txt");
    try {
      writeFileSync(file, "PC\\existing\n");
      for (const invalid of ["", "PC\\name", "S-1-5-21-1 /grant Everyone:F"]) {
        expect(() => recordDesktopUser(root, () => invalid)).toThrow(/identify/);
        expect(readFileSync(file, "utf8")).toBe("PC\\existing\n");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "win32")("resolves the real installing Windows identity to an icacls SID", () => {
    const root = mkdtempSync(join(tmpdir(), "nexus-desktop-user-"));
    try {
      recordDesktopUser(root);
      expect(desktopUsers(root)).toEqual([expect.stringMatching(/^\*S-1-(?:\d+-){1,14}\d+$/)]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
