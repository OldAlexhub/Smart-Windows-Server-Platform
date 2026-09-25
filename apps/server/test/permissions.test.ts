import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { silentLogger } from "@nexus/shared";
import { desktopUsers, hardenDataFolder } from "../src/service/permissions";

describe("data folder hardening", () => {
  it("reads installer-recorded desktop users and rejects anything odd", () => {
    const root = mkdtempSync(join(tmpdir(), "nexus-acl-"));
    try {
      writeFileSync(join(root, "desktop-users.txt"), "OFFICE-PC\\moham\r\nsomeone\r\nbad /grant Everyone:F\r\n\r\n");
      expect(desktopUsers(root)).toEqual(["OFFICE-PC\\moham", "someone"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "win32")("removes inherited access and grants only SYSTEM, Administrators and the desktop user", () => {
    const root = mkdtempSync(join(tmpdir(), "nexus-acl-"));
    const token = join(root, "local-access.token");
    writeFileSync(token, "secret");
    writeFileSync(join(root, "desktop-users.txt"), "someone\n");
    const calls: string[][] = [];
    hardenDataFolder(root, token, silentLogger, (a) => void calls.push(a));
    expect(calls[0]).toEqual([root, "/inheritance:r", "/grant:r", "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F", "/C", "/Q"]);
    expect(calls[1]).toEqual([join(root, "*"), "/reset", "/T", "/C", "/Q"]);
    expect(calls[2]).toEqual([token, "/grant", "someone:R", "/Q"]);
    rmSync(root, { recursive: true, force: true });
  });

  it.runIf(process.platform === "win32")("leaves every existing file usable by SYSTEM and Administrators (real icacls)", () => {
    const root = mkdtempSync(join(tmpdir(), "nexus-acl-"));
    const me = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
    try {
      mkdirSync(join(root, "logs", "service"), { recursive: true });
      const files = [join(root, "local-access.token"), join(root, "logs", "nexus.log"), join(root, "logs", "service", "NexusServer.err.log")];
      for (const f of files) writeFileSync(f, "x");
      // Real icacls, plus read access for the (non-admin) test account so it can inspect the result.
      hardenDataFolder(root, files[0]!, silentLogger, (args) => {
        const a = args[1] === "/inheritance:r" ? [...args.slice(0, -2), `${me}:(OI)(CI)R`, ...args.slice(-2)] : args;
        execFileSync("icacls", a, { stdio: "ignore" });
      });
      for (const f of files) {
        const acl = execFileSync("icacls", [f], { encoding: "utf8" });
        // Inherited (I) full control for SYSTEM and Administrators — never an empty list.
        expect(acl).toMatch(/NT AUTHORITY\\SYSTEM:\(I\)\(F\)/);
        expect(acl).toMatch(/BUILTIN\\Administrators:\(I\)\(F\)/);
      }
    } finally {
      // We still own the folder, so we can give ourselves access back to clean up.
      execFileSync("icacls", [root, "/grant", `${me}:(OI)(CI)F`, "/T", "/C", "/Q"], { stdio: "ignore" });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
