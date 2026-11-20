import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function currentWindowsSid() {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value"],
  { encoding: "utf8", windowsHide: true, timeout: 30_000 }).trim();
}

/** Record the installing identity in the actual service home before starting the service.
 * Numeric SIDs survive account renames and avoid ANSI/Unicode account-name corruption in NSIS.
 */
export function recordDesktopUser(home, identify = currentWindowsSid) {
  const sid = identify().trim();
  if (!/^S-1-(?:\d+-){1,14}\d+$/.test(sid)) throw new Error("Could not identify the Windows account for Nexus automatic sign-in.");
  mkdirSync(home, { recursive: true });
  const file = join(home, "desktop-users.txt");
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (existing.split(/\r?\n/).some((line) => line.trim().replace(/^\*/, "") === sid)) return;
  writeFileSync(file, `${existing}${existing && !existing.endsWith("\n") ? "\r\n" : ""}${sid}\r\n`, "utf8");
}
