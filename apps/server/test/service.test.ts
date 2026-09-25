import { spawn, execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderWinswXml } from "../src/service/winsw";

const ROOT = join(__dirname, "..", "..", "..");
const WINSW = join(ROOT, "vendor", "winsw", "2.12.0", "WinSW-x64.exe");

const def = {
  installDir: "C:\\Program Files\\Nexus",
  nodeExe: "C:\\Program Files\\Nexus\\node\\node.exe",
  entry: "C:\\Program Files\\Nexus\\server\\main.mjs",
  home: "C:\\ProgramData\\Nexus",
  logDir: "C:\\ProgramData\\Nexus\\logs\\service",
  port: 7780,
};

describe("Windows service definition", () => {
  it("starts automatically, restarts on failure and stops gracefully", () => {
    const x = renderWinswXml(def);
    expect(x).toContain("<id>NexusServer</id>");
    expect(x).toContain("<startmode>Automatic</startmode>");
    expect(x).toContain("<delayedAutoStart>true</delayedAutoStart>");
    expect(x.match(/<onfailure action="restart"/g)).toHaveLength(3);
    expect(x).toContain('<env name="NODE_ENV" value="production"/>');
    expect(x).toContain('<env name="NEXUS_PORT" value="7780"/>');
    expect(x).toContain("<stopparentprocessfirst>true</stopparentprocessfirst>");
  });

  it("escapes paths safely", () => {
    const x = renderWinswXml({ ...def, installDir: 'C:\\A & B <"x">' });
    expect(x).toContain("C:\\A &amp; B &lt;&quot;x&quot;&gt;");
  });

  it.runIf(existsSync(WINSW))("WinSW accepts the generated configuration", () => {
    const dir = mkdtempSync(join(tmpdir(), "nexus-winsw-"));
    try {
      const exe = join(dir, "NexusServerTest.exe");
      copyFileSync(WINSW, exe);
      writeFileSync(join(dir, "NexusServerTest.xml"), renderWinswXml(def).replace("<id>NexusServer</id>", "<id>NexusServerTest</id>"));
      const out = execFileSync(exe, ["status"], { encoding: "utf8" });
      expect(out.trim()).toBe("NonExistent"); // parsed fine; not installed (installing needs Administrator)
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

describe("Core Service process", () => {
  it("boots, serves the API on loopback, and prints the local sign-in link", async () => {
    const home = mkdtempSync(join(tmpdir(), "nexus-main-"));
    const port = await freePort();
    const child = spawn(process.execPath, ["--import", "tsx", join(ROOT, "apps", "server", "src", "main.ts")], {
      cwd: ROOT,
      env: { ...process.env, NEXUS_HOME: home, NEXUS_PORT: String(port), NODE_ENV: "development" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    try {
      let health: { status: string; setupCompleted: boolean } | null = null;
      for (let i = 0; i < 150 && !health; i++) {
        await new Promise((r) => setTimeout(r, 200));
        health = (await fetch(`http://127.0.0.1:${port}/api/v1/health`).then((r) => r.json()).catch(() => null)) as typeof health;
      }
      expect(health).toMatchObject({ status: "ok", setupCompleted: false });
      expect(out).toMatch(new RegExp(`Open: http://127\\.0\\.0\\.1:${port}/\\?local=[A-Za-z0-9_-]{43}`));
      // Management API is loopback-only.
      const lanIp = Object.values((await import("node:os")).networkInterfaces()).flat().find((a) => a && a.family === "IPv4" && !a.internal)?.address;
      if (lanIp) await expect(fetch(`http://${lanIp}:${port}/api/v1/health`, { signal: AbortSignal.timeout(2000) })).rejects.toThrow();
    } finally {
      child.kill();
      await new Promise((r) => child.once("exit", r));
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});
