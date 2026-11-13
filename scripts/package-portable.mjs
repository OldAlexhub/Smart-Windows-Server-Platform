import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function packagePortable(root, archiveName = "NexusPortable.zip") {
  const staging = mkdtempSync(join(tmpdir(), "nexus-portable-build-"));
  try {
    const portable = join(staging, "NexusPortable");
    cpSync(join(root, "dist", "app"), join(portable, "app"), { recursive: true });
    for (const file of readdirSync(join(root, "scripts", "portable"))) {
      cpSync(join(root, "scripts", "portable", file), join(portable, file));
    }
    cpSync(join(root, "HOW-TO-USE-NEXUS.md"), join(portable, "HOW-TO-USE-NEXUS.md"));
    const destination = join(root, "dist", "NexusPortable");
    // Never delete or package a user's existing portable data, even during a rebuild.
    if (!existsSync(destination)) cpSync(portable, destination, { recursive: true });
    else console.log(`Existing portable folder preserved: ${destination}`);
    mkdirSync(join(root, "dist"), { recursive: true });
    const archive = join(staging, archiveName);
    const tar =
      process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
    execFileSync(tar, ["-a", "-c", "-f", archive, "-C", staging, "NexusPortable"], { stdio: "inherit" });
    const target = join(root, "dist", archiveName);
    // Copy onto the destination volume before the atomic rename (staging may be on C:).
    const pending = `${target}.pending`;
    cpSync(archive, pending);
    renameSync(pending, target);
    return target;
  } finally {
    if (dirname(resolve(staging)) !== resolve(tmpdir()) || !basename(staging).startsWith("nexus-portable-build-")) {
      throw new Error("Refusing to clean an unexpected staging path.");
    }
    rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(packagePortable(resolve(dirname(fileURLToPath(import.meta.url)), ".."), process.argv[2]));
}
