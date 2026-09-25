#!/usr/bin/env node
/**
 * Visual check of the control center: screenshots pages of a running Nexus with headless Edge.
 *   node scripts/ui-shot.mjs --home <NEXUS_HOME> --port 7790 --out <dir> [--dark] [--width 1366] [--height 900] /path1 /path2
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const flag = (n) => args.includes(`--${n}`);
const home = opt("home");
const port = opt("port", "7780");
const out = opt("out", ".");
const width = opt("width", "1366");
const height = opt("height", "900");
const budget = opt("wait", "6000");
const VALUED = new Set(["--home", "--port", "--out", "--width", "--height", "--wait"]);
// Headless Edge will not make its window narrower than about 500px; narrower shots crop a 500px-wide page.
if (Number(opt("width", "0")) && Number(opt("width", "0")) < 500) console.warn("Note: headless Edge renders at least 500px wide; use --width 500 or more for phone checks.");
const pages = args.filter((a, i) => a.startsWith("/") && !VALUED.has(args[i - 1] ?? ""));
const edge = ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"].find((p) => existsSync(p));
if (!edge) throw new Error("Microsoft Edge not found");
const token = readFileSync(join(home, "local-access.token"), "utf8").trim();
mkdirSync(out, { recursive: true });

for (const page of pages.length ? pages : ["/"]) {
  const name = `${page.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "") || "home"}${flag("dark") ? "-dark" : ""}${width < 700 ? "-mobile" : ""}.png`;
  const url = `http://127.0.0.1:${port}${page}${page.includes("?") ? "&" : "?"}local=${token}`;
  // A fresh profile each time: no cached pages from an earlier build.
  const profile = mkdtempSync(join(tmpdir(), "nexus-edge-"));
  execFileSync(
    edge,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      `--virtual-time-budget=${budget}`,
      ...(flag("dark") ? ["--force-dark-mode", "--blink-settings=preferredColorScheme=0"] : ["--blink-settings=preferredColorScheme=1"]),
      `--screenshot=${join(out, name)}`,
      url,
    ],
    { stdio: "ignore", timeout: 90_000 },
  );
  rmSync(profile, { recursive: true, force: true });
  console.log(join(out, name));
}
