import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "@nexus/shared";

/** Well-known SIDs (locale-independent): LocalSystem and the local Administrators group. */
const SYSTEM = "*S-1-5-18";
const ADMINISTRATORS = "*S-1-5-32-544";

/** Windows accounts allowed to use the desktop app's automatic sign-in (written by the installer). */
export function desktopUsers(root: string): string[] {
  const f = join(root, "desktop-users.txt");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    // DOMAIN\user or user — nothing that could smuggle extra icacls arguments.
    .filter((l) => /^[A-Za-z0-9._ -]{1,64}(\\[A-Za-z0-9._ -]{1,64})?$/.test(l));
}

/**
 * Locks down Nexus's own data folder. By default everything under %ProgramData% is readable by
 * every local user; the vault key and the local sign-in token must not be. After this:
 *   - the folder: SYSTEM + Administrators only (no inherited "Users: Read"),
 *   - the sign-in token: additionally readable by the Windows account(s) that installed Nexus.
 */
export function hardenDataFolder(root: string, tokenFile: string, log: Logger, run: (args: string[]) => void = defaultRun): void {
  if (process.platform !== "win32") return;
  try {
    // Only the folder itself gets explicit entries; everything inside inherits them. (Applying
    // "/inheritance:r" with /T to files strips their only — inherited — entries, and the folder-only
    // (OI)(CI) grant doesn't apply to files, leaving files nobody can open, not even SYSTEM.)
    run([root, "/inheritance:r", "/grant:r", `${SYSTEM}:(OI)(CI)F`, `${ADMINISTRATORS}:(OI)(CI)F`, "/C", "/Q"]);
    run([join(root, "*"), "/reset", "/T", "/C", "/Q"]);
  } catch (e) {
    log.warn("could not restrict permissions on the Nexus data folder", { err: e as Error });
  }
  allowDesktopUsers(tokenFile, root, log, run);
}

/**
 * Lets the Windows account(s) that installed Nexus read the local sign-in key. Must run whenever
 * the key file is (re)created — on a fresh install it doesn't exist yet when the folder is locked.
 */
export function allowDesktopUsers(tokenFile: string, root: string, log: Logger, run: (args: string[]) => void = defaultRun): void {
  if (process.platform !== "win32" || !existsSync(tokenFile)) return;
  for (const user of desktopUsers(root)) {
    try {
      run([tokenFile, "/grant", `${user}:R`, "/Q"]);
    } catch (e) {
      log.warn("could not let a desktop user read the sign-in key", { user, err: e as Error });
    }
  }
}

function defaultRun(args: string[]): void {
  execFileSync("icacls", args, { windowsHide: true, stdio: "ignore", timeout: 120_000 });
}
