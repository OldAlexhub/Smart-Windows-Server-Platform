import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { NexusError } from "@nexus/shared";

/** Windows bsdtar rejects archive paths that escape the destination. */
export function extractZip(zipFile: string, dir: string): Promise<void> {
  const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  return new Promise((resolve, reject) => {
    execFile(existsSync(tar) ? tar : "tar", ["-x", "-f", zipFile, "-C", dir], { windowsHide: true, timeout: 10 * 60_000 }, (err, _out, stderr) => {
      if (err) reject(NexusError.invalid(`That file couldn't be unpacked. Make sure it's a .zip file. ${String(stderr).split("\n")[0] ?? ""}`.trim()));
      else resolve();
    });
  });
}

export function projectRoot(directory: string): string {
  let root = directory;
  for (;;) {
    const entries = readdirSync(root, { withFileTypes: true }).filter((entry) => !entry.name.startsWith("__MACOSX"));
    if (entries.length !== 1 || !entries[0]!.isDirectory()) return root;
    root = join(root, entries[0]!.name);
  }
}
