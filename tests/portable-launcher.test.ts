import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const fixtures: { root: string; port: number }[] = [];
async function fixture(main?: string) {
  const port = await new Promise<number>((done) => {
    const listener = net.createServer().listen(0, "127.0.0.1", () => {
      const value = (listener.address() as net.AddressInfo).port;
      listener.close(() => done(value));
    });
  });
  const root = mkdtempSync(join(tmpdir(), "nexus portable [qa]-"));
  fixtures.push({ root, port });
  for (const name of ["app/node", "app/server", "app/ui", "data/nexus"])
    mkdirSync(join(root, name), { recursive: true });
  for (const name of ["nexus-portable.ps1", "relocate-portable.mjs", "start-portable.mjs"])
    copyFileSync(resolve("scripts/portable", name), join(root, name));
  copyFileSync(process.execPath, join(root, "app/node/node.exe"));
  writeFileSync(join(root, "app/ui/index.html"), "test UI");
  writeFileSync(
    join(root, "app/server/main.mjs"),
    main ??
      `
    import http from 'node:http';
    import {existsSync,writeFileSync,rmSync} from 'node:fs';
    import {join} from 'node:path';
    writeFileSync(join(process.env.NEXUS_HOME,'local-access.token'),'test-local-token');
    const server = http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'ok',product:'Nexus Server'}))});
    server.listen(Number(process.env.NEXUS_PORT),'127.0.0.1');
    setInterval(()=>{if(existsSync(process.env.NEXUS_STOP_FILE)){rmSync(process.env.NEXUS_STOP_FILE);server.close(()=>process.exit(0));}},100);
  `,
  );
  return { root, port };
}
function run(f: { root: string; port: number }, action = "start") {
  try {
    return execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(f.root, "nexus-portable.ps1"),
        action,
        "-NoBrowser",
        "-Port",
        String(f.port),
      ],
      { encoding: "utf8", timeout: 25_000 },
    );
  } catch (error) {
    const output = String((error as { stdout?: string }).stdout);
    throw Object.assign(new Error(output), { stdout: output });
  }
}
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    try {
      run(f, "stop");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

describe.skipIf(process.platform !== "win32")("portable launcher", () => {
  it("starts in a path with spaces and brackets, clears stale stop requests, reuses its process, and stops cleanly", async () => {
    const f = await fixture();
    writeFileSync(join(f.root, "data/nexus/stop-request"), "stale");
    writeFileSync(join(f.root, "data/portable-server.pid"), "invalid-pid");
    expect(run(f)).toContain("Nexus Portable is running");
    const pid = readFileSync(join(f.root, "data/portable-server.pid"), "utf8");
    expect(run(f)).toContain("Nexus Portable is running");
    expect(readFileSync(join(f.root, "data/portable-server.pid"), "utf8")).toBe(pid);
    expect(run(f, "stop")).toContain("Nexus Portable stopped");
    expect(existsSync(join(f.root, "data/portable-server.pid"))).toBe(false);
  });
  it("rejects a different portable copy on the same port", async () => {
    const first = await fixture();
    const second = await fixture();
    run(first);
    expect(
      await fetch(`http://127.0.0.1:${first.port}/api/v1/health`).then((response) => response.json()),
    ).toMatchObject({ status: "ok" });
    second.port = first.port;
    try {
      run(second);
      throw new Error("Expected a port conflict");
    } catch (error) {
      expect(String((error as { stdout?: string }).stdout)).toContain("another portable copy");
    }
    expect(run(first)).toContain("Nexus Portable is running");
  });
  it("captures an early runtime failure and exits without an interactive prompt", async () => {
    const f = await fixture("throw new Error('portable startup regression fixture');");
    expect(() => run(f)).toThrow();
    expect(readFileSync(join(f.root, "data/nexus/logs/startup-error.log"), "utf8")).toContain(
      "portable startup regression fixture",
    );
    expect(existsSync(join(f.root, "data/portable-server.pid"))).toBe(false);
  });
  it("explains an incomplete extraction before trying to start", async () => {
    const f = await fixture();
    rmSync(join(f.root, "app/ui/index.html"));
    try {
      run(f);
      throw new Error("Expected missing file failure");
    } catch (error) {
      expect(String((error as { stdout?: string }).stdout)).toContain("Extract the entire NexusPortable.zip");
    }
  });
});
