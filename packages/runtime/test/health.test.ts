import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HealthMonitoring } from "@nexus/shared";
import {
  AppSupervisor,
  buildIsolatedEnv,
  defaultRuntimeContext,
  HealthMonitor,
  ProcessIsolationProvider,
  resolveCommand,
  type HealthEvent,
  type ExitInfo,
  type IsolationProvider,
  type LaunchSpec,
  type ManagedProcess,
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
const automatic = (candidate: string | null = null): HealthMonitoring => ({
  mode: "automatic",
  candidate: candidate ? { path: candidate, evidence: "Express route in server.js" } : null,
  endpoint: null,
  rejection: null,
});
const validated = (path = "/health"): HealthMonitoring => ({
  mode: "automatic",
  candidate: { path, evidence: "Express route in server.js" },
  endpoint: { path, source: "detected", validated: true },
  rejection: null,
});
const custom = (path = "/health"): HealthMonitoring => ({
  mode: "custom",
  candidate: null,
  endpoint: { path, source: "user", validated: true },
  rejection: null,
});

let fakePid = 80_000;
class FakeProcess implements ManagedProcess {
  readonly pid = fakePid++;
  readonly startedAt = Date.now();
  running = true;
  readonly exited: Promise<ExitInfo>;
  private finish!: (exit: ExitInfo) => void;
  constructor() {
    this.exited = new Promise((resolve) => (this.finish = resolve));
  }
  crash(code = 1): void {
    if (!this.running) return;
    this.running = false;
    this.finish({ code, signal: null, requested: false, at: Date.now() });
  }
  async stop(): Promise<ExitInfo> {
    if (this.running) {
      this.running = false;
      this.finish({ code: 0, signal: null, requested: true, at: Date.now() });
    }
    return this.exited;
  }
}

class FakeProvider implements IsolationProvider {
  readonly id = "fake";
  readonly label = "Fake process";
  current: FakeProcess | null = null;
  available = async () => ({ available: true });
  async launch(_spec: LaunchSpec): Promise<ManagedProcess> {
    return (this.current = new FakeProcess());
  }
}

async function fakeApp(): Promise<{ sup: AppSupervisor; provider: FakeProvider }> {
  const provider = new FakeProvider();
  const sup = new AppSupervisor(
    {
      appId: "fake",
      cwd: ".",
      executable: "fake",
      args: [],
      env: {},
      port: 43123,
      resources: { cpuLimitPercent: "auto", memoryLimitMb: "auto", priority: "normal" },
      listens: false,
    },
    provider,
  );
  cleanup.push(() => sup.stop());
  await sup.start();
  return { sup, provider };
}

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
  const m = new HealthMonitor(sup, { appName: "TaxiOps", health: automatic(), intervalMs: 100_000, restart: { maxRestarts: 3, windowMs: 60_000, backoffMs: [50, 50, 50] }, ...cfg }, deps);
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
    expect(events.map((e) => e.kind)).toEqual(["process_crashed", "restarting", "recovered"]);
    expect(events[0]?.failure?.kind).toBe("process_crashed");
    expect(sup.status).toBe("running");
  });

  it("stops a crash loop and explains the underlying problem", async () => {
    const sup = await app(ALWAYS_CRASH);
    const { events } = monitor(sup, {}, { logs: () => ({ stdout: ["Listening on the assigned port"], stderr: ['Error: relation "drivers" does not exist'] }) });
    await sup.start();
    const gave = await waitFor(events, "gave_up", 20_000);
    expect(gave.message).toMatch(/stopped restarting it/);
    expect(events.filter((e) => e.kind === "restarting")).toHaveLength(3);
    expect(gave.failure?.kind).toBe("process_crashed");
    await new Promise((r) => setTimeout(r, 300));
    expect(sup.status).toBe("needs_attention");
    expect(sup.detail).toContain('relation "drivers" does not exist');
    expect(sup.detail).toContain("Listening on the assigned port");
    expect(gave.detail).toContain("Restart history:");
    expect(gave.diagnostics?.restartHistory).toHaveLength(3);
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
    expect(events.find((e) => e.kind === "unhealthy")?.failure?.kind).toBe("http_timeout");
    fail = false;
    await waitFor(events, "recovered");
    expect(sup.pid).not.toBe(pid);
    expect(events.map((e) => e.kind)).toEqual(["unhealthy", "restarting", "recovered"]);
  });

  it("validates a detected endpoint, while general liveness accepts route-level responses", async () => {
    const sup = await app(SERVER);
    await sup.start();
    const root = monitor(sup);
    await root.m.check();
    expect(root.m.lastProbe).toMatchObject({ ok: true, status: 404 }); // alive, just no page at "/"
    root.m.dispose();

    const good = monitor(sup, { health: automatic("/health") });
    await good.m.check();
    expect(good.m.lastProbe).toMatchObject({ ok: true, status: 200 });
    expect(good.m.diagnostics().monitoring.endpoint).toEqual({ path: "/health", source: "detected", validated: true });
  });

  it("rejects a detected 404, falls back to '/', and never restarts the responding app", async () => {
    const { sup } = await fakeApp();
    const seen: string[] = [];
    const { m, events } = monitor(sup, { health: automatic("/health"), failureThreshold: 1 }, {
      probe: async (url) => {
        seen.push(new URL(url).pathname);
        return { ok: true, status: 404, ms: 7 };
      },
    });
    const pid = sup.pid;
    await m.check();
    await m.check();
    await m.check();
    expect(seen).toEqual(["/health", "/", "/", "/"]);
    expect(m.diagnostics().monitoring.rejection).toMatchObject({ path: "/health", status: 404 });
    expect(m.diagnostics().lastSuccessfulProbe).toMatchObject({ status: 404, url: expect.stringMatching(/\/$/) });
    expect(events.filter((e) => e.kind === "health_candidate_rejected")).toHaveLength(1);
    expect(events.some((e) => e.kind === "restarting")).toBe(false);
    expect(sup.pid).toBe(pid);
  });

  it.each([401, 403, 404])("treats HTTP %s from '/' as proof of liveness", async (status) => {
    const { sup } = await fakeApp();
    const { m, events } = monitor(sup, { failureThreshold: 1 }, { probe: async () => ({ ok: true, status, ms: 2 }) });
    await m.check();
    expect(m.lastProbe).toMatchObject({ ok: true, status });
    expect(events).toEqual([]);
  });

  it("keeps strict semantics for a user-configured endpoint", async () => {
    const { sup } = await fakeApp();
    const { m, events } = monitor(sup, { health: custom(), failureThreshold: 1 }, { probe: async () => ({ ok: true, status: 404, ms: 2 }) });
    await m.check();
    expect(events.find((e) => e.kind === "unhealthy")?.failure).toMatchObject({ kind: "http_error" });
    expect(events.some((e) => e.kind === "restarting")).toBe(true);
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
    expect(events.find((e) => e.kind === "memory_exceeded")?.failure?.kind).toBe("resource_exceeded");
    await waitFor(events, "restarting");
  });

  it("leaves a healthy application running", async () => {
    const { sup } = await fakeApp();
    const { m, events } = monitor(sup, {}, { probe: async () => ({ ok: true, status: 200, ms: 2 }) });
    const pid = sup.pid;
    await m.check();
    await m.check();
    expect(sup.status).toBe("running");
    expect(sup.pid).toBe(pid);
    expect(events).toEqual([]);
    expect(m.diagnostics().lastSuccessfulProbe?.status).toBe(200);
  });

  it("diagnoses HTTP 5xx separately from transport failures", async () => {
    const { sup } = await fakeApp();
    const { m, events } = monitor(sup, { health: validated(), failureThreshold: 1 }, { probe: async () => ({ ok: true, status: 503, ms: 8 }) });
    await m.check();
    const failed = events.find((e) => e.kind === "unhealthy");
    expect(failed?.failure).toMatchObject({ kind: "http_error", detail: "HTTP 503 after 8 ms" });
    expect(failed?.message).toMatch(/health endpoint returned an error/);
  });

  it("diagnoses a refused assigned port separately", async () => {
    const { sup } = await fakeApp();
    const { m, events } = monitor(sup, { failureThreshold: 1 }, { probe: async () => ({ ok: false, status: null, ms: 4, error: "connect ECONNREFUSED 127.0.0.1", failure: "connection_refused" }) });
    await m.check();
    const failed = events.find((e) => e.kind === "unhealthy");
    expect(failed?.failure?.kind).toBe("connection_refused");
    expect(failed?.message).toMatch(/nothing is accepting connections/);
  });

  it("manual restart reset clears give-up state without erasing incident evidence", async () => {
    const { sup } = await fakeApp();
    let healthy = false;
    const { m, events } = monitor(
      sup,
      { failureThreshold: 1, restart: { maxRestarts: 0, windowMs: 60_000, backoffMs: [1] } },
      { probe: async () => healthy ? { ok: true, status: 200, ms: 1 } : { ok: false, status: null, ms: 5_000, error: "timeout", failure: "timeout" } },
    );
    await m.check();
    await waitFor(events, "gave_up");
    expect(m.isGivingUp).toBe(true);
    expect(sup.status).toBe("needs_attention");
    expect(sup.pid).not.toBeNull(); // HTTP evidence is kept alive until the user restarts.
    m.reset();
    healthy = true;
    await sup.restart();
    await m.check();
    expect(m.isGivingUp).toBe(false);
    expect(sup.status).toBe("running");
    expect(m.diagnostics().failedProbes).toHaveLength(1);
  });

  it("retains intermittent failure evidence without restarting a recovered app", async () => {
    const { sup } = await fakeApp();
    const replies: Awaited<ReturnType<Prober>>[] = [
      { ok: false, status: null, ms: 5_000, error: "timeout", failure: "timeout" },
      { ok: true, status: 200, ms: 3 },
      { ok: false, status: null, ms: 9, error: "ECONNRESET", failure: "connection_reset" },
      { ok: true, status: 200, ms: 2 },
    ];
    const { m, events } = monitor(sup, { failureThreshold: 2 }, { probe: async () => replies.shift()! });
    await m.check();
    await m.check();
    await m.check();
    await m.check();
    expect(events.some((e) => e.kind === "restarting")).toBe(false);
    expect(m.diagnostics().failedProbes.map((p) => p.failure)).toEqual(["timeout", "connection_reset"]);
    expect(m.diagnostics().lastSuccessfulProbe?.ms).toBe(2);
    expect(sup.status).toBe("running");
  });
});
