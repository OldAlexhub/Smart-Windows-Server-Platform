#!/usr/bin/env node
/**
 * Installs / removes / controls the Nexus Core Windows service (used by the installer).
 * Must run as Administrator for install/uninstall/start/stop.
 *
 *   node scripts/service.mjs install --install-dir "C:\Program Files\Nexus" [--port 7780]
 *   node scripts/service.mjs uninstall|start|stop|status --install-dir "..."
 *
 * Layout inside the install directory:
 *   node\node.exe  server\main.mjs  components\winsw\<ver>\WinSW-x64.exe
 *   service\NexusServer.exe (copy of WinSW) + service\NexusServer.xml
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readServiceSettings } from "./service-settings.mjs";
import { recordDesktopUser } from "./desktop-user.mjs";

const args = process.argv.slice(2);
const command = args[0];
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const installDir = opt("install-dir", process.cwd());
let port = Number(opt("port", "7780"));
const serviceId = opt("service-id", "NexusServer");
let home = opt("home", join(process.env.ProgramData ?? "C:\\ProgramData", "Nexus"));
const serviceDir = join(installDir, "service");
const wrapper = join(serviceDir, `${serviceId}.exe`);
const configFile = join(serviceDir, `${serviceId}.xml`);

function findWinsw() {
  for (const root of [join(installDir, "components", "winsw"), join(process.cwd(), "vendor", "winsw")]) {
    if (!existsSync(root)) continue;
    for (const v of readdirSync(root).sort().reverse()) {
      const exe = join(root, v, "WinSW-x64.exe");
      if (existsSync(exe)) return exe;
    }
  }
  throw new Error("WinSW component not found.");
}

async function renderXml() {
  // The renderer lives in the server bundle so the installer and the code agree.
  const mod = await import(
    new URL("file:///" + join(installDir, "server", "service-config.mjs").replace(/\\/g, "/")).href
  ).catch(() => null);
  const def = {
    installDir,
    nodeExe: join(installDir, "node", "node.exe"),
    entry: join(installDir, "server", "main.mjs"),
    home,
    logDir: join(home, "logs", "service"),
    port,
  };
  if (!mod) throw new Error("service-config.mjs not found in the server bundle.");
  return mod.renderWinswXml(def);
}

const run = (a) => execFileSync(wrapper, [a], { stdio: "inherit" });
const status = () => {
  if (!existsSync(wrapper)) return "NonExistent";
  // Access/configuration errors are not evidence that the service is absent.
  return execFileSync(wrapper, ["status"], { encoding: "utf8" }).trim();
};

switch (command) {
  case "install": {
    // Upgrade in place: stop and remove the previous registration first.
    const current = status();
    if (current !== "NonExistent") {
      const existing = readServiceSettings(readFileSync(configFile, "utf8"));
      if (!args.includes("--home")) home = existing.home;
      if (!args.includes("--port")) port = existing.port;
      if (current !== "Stopped") run("stop");
    }
    // Resolve and validate every new input before removing a working registration.
    const winsw = findWinsw();
    const config = await renderXml();
    recordDesktopUser(home);
    if (current !== "NonExistent") {
      run("uninstall");
    }
    mkdirSync(serviceDir, { recursive: true });
    copyFileSync(winsw, wrapper);
    writeFileSync(configFile, config);
    run("install");
    run("start");
    break;
  }
  case "uninstall": {
    const current = status();
    if (current === "NonExistent") break;
    if (current !== "Stopped") run("stop");
    run("uninstall");
    break;
  }
  case "start":
  case "stop":
  case "status":
  case "restart":
    run(command);
    break;
  default:
    console.error("Usage: service.mjs install|uninstall|start|stop|restart|status --install-dir <dir>");
    process.exit(2);
}
