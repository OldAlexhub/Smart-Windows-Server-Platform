import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  computeHealthScore,
  cpuPercent,
  MonitoringManager,
  parseNetstatE,
  TimeSeries,
  treeCpuPercent,
  treeUsage,
  type ProcRow,
} from "@nexus/monitoring";

describe("parsers & math", () => {
  it("parses netstat -e", () => {
    expect(parseNetstatE("Interface Statistics\n\n    Received   Sent\n\nBytes                    1168651455      2405421780\n")).toEqual({
      rxBytes: 1168651455,
      txBytes: 2405421780,
    });
    expect(parseNetstatE("nope")).toBeNull();
  });

  it("computes CPU usage from counters", () => {
    expect(cpuPercent({ idle: 100, total: 200 }, { idle: 150, total: 400 })).toBe(75);
    expect(cpuPercent({ idle: 1, total: 1 }, { idle: 1, total: 1 })).toBe(0);
    // 2 s of CPU time over 1 s on 4 cores = 50%
    expect(treeCpuPercent(0, 20_000_000, 1000, 4)).toBe(50);
  });

  it("sums a process tree (npm → node → worker)", () => {
    const rows: ProcRow[] = [
      { ProcessId: 1, ParentProcessId: 0, WorkingSetSize: 10, KernelModeTime: 0, UserModeTime: 0 },
      { ProcessId: 100, ParentProcessId: 1, WorkingSetSize: 50e6, KernelModeTime: 10, UserModeTime: 20 },
      { ProcessId: 101, ParentProcessId: 100, WorkingSetSize: 300e6, KernelModeTime: 100, UserModeTime: 200 },
      { ProcessId: 102, ParentProcessId: 101, WorkingSetSize: 20e6, KernelModeTime: 1, UserModeTime: 1 },
      { ProcessId: 200, ParentProcessId: 1, WorkingSetSize: 999e6, KernelModeTime: 0, UserModeTime: 0 },
    ];
    expect(treeUsage(rows, 100)).toEqual({ memoryBytes: 370e6, cpuTime: 332, pids: [100, 101, 102] });
    expect(treeUsage(rows, 999)).toBeNull();
  });
});

describe("TimeSeries", () => {
  it("keeps raw points for an hour and minute averages for a day", () => {
    const s = new TimeSeries();
    const t0 = Date.UTC(2027, 0, 1);
    for (let i = 0; i < 6 * 60 * 3; i++) s.add(i % 2 === 0 ? 10 : 30, t0 + i * 10_000); // 3 hours, every 10 s
    const now = t0 + 3 * 3_600_000;
    expect(s.range(3_600_000, now).length).toBeLessThanOrEqual(361);
    const day = s.range(86_400_000, now);
    expect(day.length).toBeGreaterThanOrEqual(179);
    expect(day.every((p) => p.v === 20)).toBe(true);
    expect(s.average(600_000, now)).toBe(20);
  });
});

describe("computeHealthScore", () => {
  const base = {
    apps: [{ name: "TaxiOps", status: "running" as const }],
    databasesOffline: 0,
    cpuPercent: 18,
    memoryUsedFraction: 0.4,
    lowestDiskFreeFraction: 0.7,
    unprotectedApps: [],
    externalAccessProblems: 0,
    securityAlerts: 0,
  };
  it("healthy system scores 100", () => {
    expect(computeHealthScore(base)).toEqual({ score: 100, label: "Healthy", issues: [] });
  });
  it("explains what lowers the score", () => {
    const s = computeHealthScore({
      ...base,
      apps: [...base.apps, { name: "Finance", status: "crashed" }],
      unprotectedApps: ["Analytics"],
      lowestDiskFreeFraction: 0.1,
    });
    expect(s.score).toBe(75);
    expect(s.label).toBe("Needs Attention");
    expect(s.issues).toEqual(["Finance needs attention", "Backups out of date: Analytics", "A drive is getting full"]);
  });
});

describe.runIf(process.platform === "win32")("MonitoringManager live", () => {
  it("samples this machine and a real app process tree", async () => {
    const child = spawn(process.execPath, ["-e", "const a=[];setInterval(()=>a.push(new Array(1e5).fill(1)),50)"], { stdio: "ignore" });
    try {
      const m = new MonitoringManager({ mounts: () => ["C:\\"], appPids: () => [{ appId: "demo", pid: child.pid! }] });
      await m.sample();
      await new Promise((r) => setTimeout(r, 1500));
      const snap = await m.sample();
      expect(snap.cpuPercent).toBeGreaterThanOrEqual(0);
      expect(snap.memory.usedBytes).toBeGreaterThan(0);
      expect(snap.disks[0]!.totalBytes).toBeGreaterThan(snap.disks[0]!.freeBytes);
      expect(snap.network).not.toBeNull();
      const app = m.app("demo")!;
      expect(app.memoryBytes).toBeGreaterThan(10 * 1024 * 1024);
      expect(app.processCount).toBeGreaterThanOrEqual(1);
      expect(m.metrics.latest("system.cpu")).not.toBeNull();
      expect(await m.memoryOf(child.pid!)).toBeGreaterThan(0);
    } finally {
      child.kill();
    }
  }, 60_000);
});
