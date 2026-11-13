// The short-lived launcher opens the server's logs as OS file handles. This
// avoids keeping PowerShell alive to forward a long-running server's output.
import { spawn } from "node:child_process";
import { closeSync, openSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const logs = join(root, "data", "nexus", "logs");
const errorLog = join(logs, "startup-error.log");
const handles = [];
const fail = (error) => {
  writeFileSync(errorLog, String(error.stack ?? error));
  process.exitCode = 1;
};
try {
  handles.push(openSync(join(logs, "startup-output.log"), "w"));
  handles.push(openSync(errorLog, "w"));
  const child = spawn(
    join(root, "app", "node", "node.exe"),
    ["--enable-source-maps", "--disable-warning=ExperimentalWarning", join(root, "app", "server", "main.mjs")],
    { cwd: join(root, "app"), env: process.env, detached: true, windowsHide: true, stdio: ["ignore", ...handles] },
  );
  child.once("error", fail);
  child.once("spawn", () => {
    writeFileSync(join(root, "data", "portable-server.pid"), String(child.pid));
    child.unref();
  });
} catch (error) {
  fail(error);
} finally {
  for (const handle of handles) closeSync(handle);
}
