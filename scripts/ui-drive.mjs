#!/usr/bin/env node
/**
 * Drives the control center in headless Edge (DevTools protocol, no extra dependencies) to check
 * interactions: typing, clicking, dragging, and screenshots along the way.
 *
 *   node scripts/ui-drive.mjs --home <NEXUS_HOME> --port 7790 --out <dir> [--dark] [--width 1440] [--height 900] steps.json
 *
 * steps.json is a list of actions:
 *   { "goto": "/pipelines" }                     open a page (signed in as the local Owner)
 *   { "waitFor": "css selector", "timeout": 10000 }
 *   { "click": "css selector" }                  also { "click": "text=Run" } to click by visible text
 *   { "type": { "into": "css selector", "text": "…" } }
 *   { "drag": { "from": "selector", "to": "selector", "fromOffset": [x, y] } }   offsets from the element's centre
 *   { "wait": 500 }
 *   { "expect": "js expression that must be true", "label": "what it checks" }
 *   { "shot": "name" }                           writes <out>/<name>.png
 * Exits non-zero if any step fails.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const flag = (n) => args.includes(`--${n}`);
const home = opt("home");
const appPort = opt("port", "7780");
const out = opt("out", ".");
const width = Number(opt("width", "1440"));
const height = Number(opt("height", "900"));
const stepsFile = args.filter((a, i) => !a.startsWith("--") && !["--home", "--port", "--out", "--width", "--height"].includes(args[i - 1] ?? "")).at(-1);
const steps = JSON.parse(readFileSync(stepsFile, "utf8"));
const edge = ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"].find((p) => existsSync(p));
if (!edge) throw new Error("Microsoft Edge not found");
const token = readFileSync(join(home, "local-access.token"), "utf8").trim();
mkdirSync(out, { recursive: true });

const freePort = () => new Promise((r) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const debugPort = await freePort();
const profile = mkdtempSync(join(tmpdir(), "nexus-drive-"));
const browser = spawn(edge, ["--headless=new", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, `--window-size=${width},${height}`, "--no-first-run", "--disable-extensions", "about:blank"], { stdio: "ignore" });

let target;
for (let i = 0; i < 100 && !target; i++) {
  await sleep(100);
  try {
    target = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find((t) => t.type === "page");
  } catch { /* starting */ }
}
if (!target) throw new Error("Edge did not start");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0;
const pending = new Map();
const consoleErrors = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  } else if (msg.method === "Runtime.exceptionThrown") consoleErrors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
};
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
if (flag("dark")) await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });

/** Finds an element (css, or text=… for a button/link/tab by its visible text) and returns its centre. */
const locate = async (selector, scroll = true) =>
  evaluate(`(() => {
    const sel = ${JSON.stringify(selector)};
    let el;
    if (sel.startsWith("text=")) {
      const want = sel.slice(5).trim();
      el = [...document.querySelectorAll("button, a, [role=tab], [role=radio], summary, label")].find((e) => e.textContent.trim() === want) ?? [...document.querySelectorAll("button, a, summary")].find((e) => e.textContent.includes(want));
    } else el = document.querySelector(sel);
    if (!el) return null;
    if (${scroll}) el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    // Really visible: the element (not something covering or clipping it) is under its centre point.
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const visible = !!hit && (hit === el || el.contains(hit) || hit.contains(el));
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, visible };
  })()`);

const mouse = (type, x, y, extra = {}) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: type === "mouseMoved" ? 0 : 1, ...extra });

let failures = 0;
for (const [n, step] of steps.entries()) {
  const label = step.label ?? JSON.stringify(step).slice(0, 90);
  try {
    if (step.goto) {
      const url = `http://127.0.0.1:${appPort}${step.goto}${step.goto.includes("?") ? "&" : "?"}local=${token}`;
      await send("Page.navigate", { url });
      await sleep(step.settle ?? 1500);
    } else if (step.waitFor) {
      const until = Date.now() + (step.timeout ?? 10000);
      while (!(await locate(step.waitFor))) {
        if (Date.now() > until) throw new Error(`not found: ${step.waitFor}`);
        await sleep(150);
      }
    } else if (step.click) {
      const p = await locate(step.click);
      if (!p) throw new Error(`not found: ${step.click}`);
      await mouse("mouseMoved", p.x, p.y);
      await mouse("mousePressed", p.x, p.y);
      await mouse("mouseReleased", p.x, p.y);
      await sleep(step.settle ?? 300);
    } else if (step.type) {
      const p = await locate(step.type.into);
      if (!p) throw new Error(`not found: ${step.type.into}`);
      await evaluate(`document.querySelector(${JSON.stringify(step.type.into)}).focus()`);
      await send("Input.insertText", { text: step.type.text });
      await sleep(100);
    } else if (step.drag) {
      // Only the starting point is scrolled into view (scrolling for the target would move the start).
      const a = await locate(step.drag.from);
      const b = await locate(step.drag.to, false);
      if (!a || !b) throw new Error(`not found: ${!a ? step.drag.from : step.drag.to}`);
      if (!b.visible) throw new Error(`target not on screen: ${step.drag.to}`);
      const [fx, fy] = step.drag.fromOffset ?? [0, 0];
      const [tx, ty] = step.drag.toOffset ?? [0, 0];
      const from = { x: a.x + fx, y: a.y + fy };
      const to = { x: b.x + tx, y: b.y + ty };
      await mouse("mouseMoved", from.x, from.y);
      await mouse("mousePressed", from.x, from.y, { buttons: 1 });
      for (let i = 1; i <= 12; i++) await mouse("mouseMoved", from.x + ((to.x - from.x) * i) / 12, from.y + ((to.y - from.y) * i) / 12, { buttons: 1 });
      await mouse("mouseReleased", to.x, to.y);
      await sleep(step.settle ?? 300);
    } else if (step.wait) {
      await sleep(step.wait);
    } else if (step.expect) {
      const until = Date.now() + (step.timeout ?? 5000);
      while (!(await evaluate(`Boolean(${step.expect})`))) {
        if (Date.now() > until) throw new Error(`expectation not met: ${step.expect}`);
        await sleep(150);
      }
    } else if (step.pdf) {
      // What "Print / Save as PDF" produces (print styles applied).
      const { data } = await send("Page.printToPDF", { printBackground: true, preferCSSPageSize: true });
      const file = join(out, `${step.pdf}.pdf`);
      writeFileSync(file, Buffer.from(data, "base64"));
      console.log(`pdf  ${file}`);
      continue;
    } else if (step.shot) {
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      const file = join(out, `${step.shot}${flag("dark") ? "-dark" : ""}.png`);
      writeFileSync(file, Buffer.from(data, "base64"));
      console.log(`shot ${file}`);
      continue;
    }
    console.log(`ok   ${n + 1}. ${label}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${n + 1}. ${label} — ${e.message}`);
    const { data } = await send("Page.captureScreenshot", { format: "png" }).catch(() => ({ data: null }));
    if (data) writeFileSync(join(out, `failure-${n + 1}.png`), Buffer.from(data, "base64"));
    break;
  }
}
if (consoleErrors.length) {
  console.log(`page errors:\n  ${consoleErrors.join("\n  ")}`);
  failures++;
}
ws.close();
browser.kill();
await sleep(300);
rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
process.exit(failures ? 1 : 0);
