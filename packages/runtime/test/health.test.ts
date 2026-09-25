import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AppSupervisor,
  buildIsolatedEnv,
  defaultRuntimeContext,
  HealthMonitor,
  ProcessIsolationProvider,
  resolveCommand,
  type HealthEvent,
  type Prober,
} from "@nexus/runtime";
import { freePort } from "./ports";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});


/** Real app process whose behaviour is set by a script. */
async function app(script: string) {
  const dir = mkdtempSync(join(tmpdir(), "nexus-health-"));
  writeFileSync(join(dir, "app.js"), script);
  const p = await freePort();
  const cmd = resolveCommand("node", ["app.js"], defaultRuntimeContext());
  const sup = new AppSupervisor(
    {
      appId: "t",
      cwd: dir,
      executable: cmd.executable,
      args: cmd.args,
      env: buildIsolatedEnv({ homeDir: join(dir, "home"), pathDirs: cmd.pathDirs, appEnv: {}, port: p }),
      port: p,
      resources: { cpuLimitPercent: "auto", memoryLimitMb: "auto", priority: "normal" },
      startupTimeoutMs: 10_000,
    },
    new ProcessIsolationProvider(),
  );
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanup.push(() => sup.stop());
  return sup;
}

const SERVER = `require("http").createServer((q,s)=>{s.statusCode=q.url==="/health"?200:404;s.end("x")}).listen(+process.env.PORT,"127.0.0.1");`;
const CRASH_ONCE = `const fs=require("fs");const f="crashed.flag";require("http").createServer((q,s)=>s.end("ok")).listen(+process.env.PORT,"127.0.0.1",()=>{if(!fs.existsSync(f)){fs.writeFileSync(f,"1");setTimeout(()=>process.exit(1),1000)}});`;
const ALWAYS_CRASH = `require("http").createServer().listen(+process.env.PORT,"127.0.0.1",()=>setTimeout(()=>{console.error("Error: relation \\"drivers\\" does not exist");process.exit(1)},150));`;

function waitFor(events: HealthEvent[], kind: HealthEvent["kind"], ms = 15_000): Promise<HealthEvent> {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const e = events.find((x) => x.kind === kind);
      if (e) return resolve(e);
      if (Date.now() > deadline) return reject(new Error(`no ${kind} event; got ${events.map((x) => x.kind).join(",")}`));
      setTimeout(tick, 50);
    };
    tick();
  });
}

function monitor(sup: AppSupervisor, cfg: Partial<ConstructorParameters<typeof HealthMonitor>[1]> = {}, deps: ConstructorParameters<typeof HealthMonitor>[2] = {}) {
  const m = new HealthMonitor(sup, { appName: "TaxiOps", healthPath: null, intervalMs: 100_000, restart: { maxRestarts: 3, windowMs: 60_000, backoffMs: [50, 50, 50] }, ...cfg }, deps);
  const events: HealthEvent[] = [];
  m.on("event", (e) => events.push(e));
  m.start();
  cleanup.push(() => m.dispose());
  return { m, events };
}

describe("HealthMonitor", () => {
  it("restarts a crashed app and reports recovery with downtime", async () => {
    const sup = await app(CRASH_ONCE);
    const { events } = monitor(sup);
    expect(await sup.start()).toBe("running");
    const rec = await waitFor(events, "recovered");
    expect(rec.message).toMatch(/TaxiOps is running again\. Service restored after/);
    expect(events.map((e) => e.kind)).toEqual(["restarting", "recovered"]);
    expect(sup.status).toBe("running");
  });

  it("stops a crash loop and explains the underlying problem", async () => {
    const sup = await app(ALWAYS_CRASH);
    const { events } = monitor(sup, {}, { explain: () => 'relation "drivers" does not exist' });
    await sup.start();
    const gave = await waitFor(events, "gave_up", 20_000);
    expect(gave.message).toMatch(/stopped restarting it/);
    expect(events.filter((e) => e.kind === "restarting")).toHaveLength(3);
    await new Promise((r) => setTimeout(r, 300));
    expect(sup.status).toBe("needs_attention");
    expect(sup.detail).toContain('relation "drivers" does not exist');
  }, 30_000);

  it("restarts an app that stops answering health checks", async () => {
    const sup = await app(SERVER);
    let fail = true;
    const probe: Prober = async () => (fail ? { ok: false, status: null, ms: 5000, error: "timeout" } : { ok: true, status: 200, ms: 3 });
    const { m, events } = monitor(sup, { failureThreshold: 2 }, { probe });
    await sup.start();
    const pid = sup.pid;
    await m.check();
    await m.check();
    await waitFor(events, "restarting");
    fail = false;
    await waitFor(events, "recovered");
    expect(sup.pid).not.toBe(pid);
    expect(events.map((e) => e.kind)).toEqual(["unhealthy", "restarting", "recovered"]);
  });

  it("explicit health endpoints must succeed; '/' only needs to answer", async () => {
    const sup = await app(SERVER);
    await sup.start();
    const withPath = monitor(sup, { healthPath: "/missing", failureThreshold: 99 });
    await withPath.m.check();
    expect(withPath.m.lastProbe).toMatchObject({ ok: false, status: 404 });
    withPath.m.dispose();

    const root = monitor(sup, { healthPath: null });
    await root.m.check();
    expect(root.m.lastProbe).toMatchObject({ ok: true, status: 404 }); // alive, just no page at "/"
    const good = monitor(sup, { healthPath: "/health" });
    await good.m.check();
    expect(good.m.lastProbe).toMatchObject({ ok: true, status: 200 });
  });

  it("restarts after sustained memory overuse", async () => {
    const sup = await app(SERVER);
    await sup.start();
    const { m, events } = monitor(sup, { memoryLimitBytes: 100 * 1024 * 1024 }, { memoryOf: async () => 500 * 1024 * 1024 });
    await m.check();
    await m.check();
    expect(events).toEqual([]);
    await m.check();
    expect((await waitFor(events, "memory_exceeded")).message).toMatch(/500 MB.*100 MB limit/);
    await waitFor(events, "restarting");
  });
});
