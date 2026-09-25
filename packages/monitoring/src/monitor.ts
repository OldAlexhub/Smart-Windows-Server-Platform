import os from "node:os";
import { silentLogger, type Logger } from "@nexus/shared";
import { MetricsRegistry } from "./series";
import {
  cpuPercent,
  cpuTimes,
  defaultExec,
  diskUsage,
  gpuUsage,
  listProcesses,
  parseNetstatE,
  treeCpuPercent,
  treeUsage,
  type CpuTimes,
  type DiskUsage,
  type GpuUsage,
} from "./samplers";

export interface SystemSnapshot {
  at: string;
  cpuPercent: number;
  memory: { totalBytes: number; usedBytes: number };
  disks: DiskUsage[];
  gpus: GpuUsage[];
  network: { rxBytesPerSec: number; txBytesPerSec: number } | null;
}

export interface AppUsage {
  appId: string;
  cpuPercent: number;
  memoryBytes: number;
  processCount: number;
}

/**
 * Collects system and per-application resource usage on an interval and keeps short
 * time series for charts: CPU, memory, GPU, VRAM, disks, network, and each app's process tree.
 */
export class MonitoringManager {
  readonly metrics = new MetricsRegistry();
  private prevCpu: CpuTimes | null = null;
  private prevNet: { rx: number; tx: number; t: number } | null = null;
  private prevApp = new Map<string, { cpuTime: number; t: number }>();
  private snapshot: SystemSnapshot | null = null;
  private appUsage = new Map<string, AppUsage>();
  private timer: NodeJS.Timeout | null = null;
  private readonly log: Logger;

  constructor(
    private readonly opts: {
      /** Drives to watch (Nexus data locations). */
      mounts: () => string[];
      /** Running apps and their root process ids. */
      appPids: () => { appId: string; pid: number }[];
      intervalMs?: number;
      logger?: Logger;
    },
  ) {
    this.log = opts.logger ?? silentLogger;
  }

  start(): void {
    const tick = async () => {
      try {
        await this.sample();
      } catch (e) {
        this.log.warn("monitoring sample failed", { err: e as Error });
      }
      this.timer = setTimeout(tick, this.opts.intervalMs ?? 10_000);
      this.timer.unref();
    };
    void tick();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  latest(): SystemSnapshot | null {
    return this.snapshot;
  }

  app(appId: string): AppUsage | null {
    return this.appUsage.get(appId) ?? null;
  }

  async sample(): Promise<SystemSnapshot> {
    const now = Date.now();
    const cpuNow = cpuTimes();
    const cpu = this.prevCpu ? cpuPercent(this.prevCpu, cpuNow) : 0;
    this.prevCpu = cpuNow;

    const [disks, gpus, net, procs] = await Promise.all([
      diskUsage(this.opts.mounts()),
      gpuUsage(),
      process.platform === "win32" ? defaultExec("netstat", ["-e"]).then((r) => parseNetstatE(r.out)) : Promise.resolve(null),
      this.opts.appPids().length ? listProcesses() : Promise.resolve([]),
    ]);

    let network: SystemSnapshot["network"] = null;
    if (net) {
      if (this.prevNet && now > this.prevNet.t) {
        const dt = (now - this.prevNet.t) / 1000;
        network = { rxBytesPerSec: Math.max(0, (net.rxBytes - this.prevNet.rx) / dt), txBytesPerSec: Math.max(0, (net.txBytes - this.prevNet.tx) / dt) };
      }
      this.prevNet = { rx: net.rxBytes, tx: net.txBytes, t: now };
    }

    const total = os.totalmem();
    const snap: SystemSnapshot = {
      at: new Date(now).toISOString(),
      cpuPercent: cpu,
      memory: { totalBytes: total, usedBytes: total - os.freemem() },
      disks,
      gpus,
      network,
    };
    this.snapshot = snap;
    this.metrics.record("system.cpu", cpu, now);
    this.metrics.record("system.memory.used", snap.memory.usedBytes, now);
    gpus.forEach((g, i) => {
      this.metrics.record(`system.gpu.${i}.util`, g.utilizationPercent, now);
      this.metrics.record(`system.gpu.${i}.vram`, g.memoryUsedBytes, now);
    });
    if (network) {
      this.metrics.record("system.net.rx", network.rxBytesPerSec, now);
      this.metrics.record("system.net.tx", network.txBytesPerSec, now);
    }

    const cores = os.cpus().length;
    const live = new Set<string>();
    for (const { appId, pid } of this.opts.appPids()) {
      const u = treeUsage(procs, pid);
      if (!u) continue;
      live.add(appId);
      const prev = this.prevApp.get(appId);
      const cpuPct = prev ? treeCpuPercent(prev.cpuTime, u.cpuTime, now - prev.t, cores) : 0;
      this.prevApp.set(appId, { cpuTime: u.cpuTime, t: now });
      const usage = { appId, cpuPercent: cpuPct, memoryBytes: u.memoryBytes, processCount: u.pids.length };
      this.appUsage.set(appId, usage);
      this.metrics.record(`app.${appId}.cpu`, cpuPct, now);
      this.metrics.record(`app.${appId}.memory`, u.memoryBytes, now);
    }
    for (const id of [...this.appUsage.keys()]) {
      if (!live.has(id)) {
        this.appUsage.delete(id);
        this.prevApp.delete(id);
      }
    }
    return snap;
  }

  /** Memory of one process tree right now (used by the health watchdog). */
  async memoryOf(pid: number): Promise<number | null> {
    return treeUsage(await listProcesses(), pid)?.memoryBytes ?? null;
  }
}
