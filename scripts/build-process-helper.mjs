import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function buildProcessHelper(destination) {
  const source = join(dirname(fileURLToPath(import.meta.url)), "../packages/runtime/native/NexusProcess.cs");
  const compiler = join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET/Framework64/v4.0.30319/csc.exe");
  mkdirSync(dirname(destination), { recursive: true });
  execFileSync(compiler, ["/nologo", "/optimize+", "/target:exe", `/out:${destination}`, source], { windowsHide: true, stdio: "pipe" });
}
