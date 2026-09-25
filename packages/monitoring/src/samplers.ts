import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import os from "node:os";
import { parseNvidiaSmiCsv } from "@nexus/hardware";

type Exec = (file: string, args: string[], timeoutMs?: number) => Promise<{ code: number; out: string }>;
export const defaultExec: Exec = (file, args, timeoutMs = 15_000) =>
  new Promise((resolve) =>
    execFile(file, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) =>
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: String(stdout ?? "") }),
    ),
  );

// ------------------------------------------------------------------ CPU

export interface CpuTimes {
  idle: number;
  total: number;
}

export function cpuTimes(cpus = os.cpus()): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    idle += c.times.idle;
    total += c.times.idle + c.times.user + c.times.sys + c.times.irq + c.times.nice;
  }
  return { idle, total };
}

export function cpuPercent(prev: CpuTimes, next: CpuTimes): number {
  const dt = next.total - prev.total;
  if (dt <= 0) return 0;
  return Math.max(0, Math.min(100, (1 - (next.idle - prev.idle) / dt) * 100));
}

// ------------------------------------------------------------------ network

/** Parses `netstat -e` totals (all interfaces). */
export function parseNetstatE(out: string): { rxBytes: number; txBytes: number } | null {
  const m = out.match(/^\s*Bytes\s+(\d+)\s+(\d+)/m);
  return m ? { rxBytes: Number(m[1]), txBytes: Number(m[2]) } : null;
}

// ------------------------------------------------------------------ processes

export interface ProcRow {
  ProcessId: number;
  ParentProcessId: number;
  WorkingSetSize: number;
  KernelModeTime: number; // 100 ns units
  UserModeTime: number;
}

export interface TreeUsage {
  memoryBytes: number;
  /** Total CPU time of the tree in 100 ns units. */
  cpuTime: number;
  pids: number[];
}

/** Sums memory and CPU time over a process and all its descendants. */
export function treeUsage(rows: ProcRow[], rootPid: number): TreeUsage | null {
  const byParent = new Map<number, ProcRow[]>();
  const byPid = new Map<number, ProcRow>();
  for (const r of rows) {
    byPid.set(r.ProcessId, r);
    if (r.ProcessId === r.ParentProcessId) continue;
    const list = byParent.get(r.ParentProcessId) ?? [];
    list.push(r);
    byParent.set(r.ParentProcessId, list);
  }
  const root = byPid.get(rootPid);
  if (!root) return null;
  const usage: TreeUsage = { memoryBytes: 0, cpuTime: 0, pids: [] };
  const stack = [root];
  const seen = new Set<number>();
  while (stack.length) {
    const r = stack.pop()!;
    if (seen.has(r.ProcessId)) continue;
    seen.add(r.ProcessId);
    usage.memoryBytes += Number(r.WorkingSetSize) || 0;
    usage.cpuTime += (Number(r.KernelModeTime) || 0) + (Number(r.UserModeTime) || 0);
    usage.pids.push(r.ProcessId);
    stack.push(...(byParent.get(r.ProcessId) ?? []));
  }
  return usage;
}

/** CPU % of all cores for a tree between two samples. */
export function treeCpuPercent(prevCpuTime: number, nextCpuTime: number, elapsedMs: number, cores: number): number {
  if (elapsedMs <= 0) return 0;
  const usedMs = (nextCpuTime - prevCpuTime) / 10_000;
  return Math.max(0, Math.min(100, (usedMs / (elapsedMs * cores)) * 100));
}

const PROC_QUERY =
  "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,KernelModeTime,UserModeTime | ConvertTo-Json -Compress";

export async function listProcesses(exec: Exec = defaultExec): Promise<ProcRow[]> {
  if (process.platform !== "win32") return [];
  const r = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", PROC_QUERY], 30_000);
  if (r.code !== 0) return [];
  try {
    const parsed = JSON.parse(r.out) as ProcRow | ProcRow[];
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------ disks & GPU

export interface DiskUsage {
  mount: string;
  totalBytes: number;
  freeBytes: number;
}

export async function diskUsage(mounts: string[]): Promise<DiskUsage[]> {
  const out: DiskUsage[] = [];
  for (const m of mounts) {
    try {
      const s = await statfs(m);
      out.push({ mount: m, totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize });
    } catch {
      /* drive unplugged */
    }
  }
  return out;
}

export interface GpuUsage {
  name: string;
  utilizationPercent: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
}

export async function gpuUsage(exec: Exec = defaultExec): Promise<GpuUsage[]> {
  const r = await exec("nvidia-smi", ["--query-gpu=name,memory.total,memory.used,driver_version,utilization.gpu", "--format=csv,noheader,nounits"]);
  if (r.code !== 0) return [];
  return parseNvidiaSmiCsv(r.out).map((g) => ({
    name: g.name,
    utilizationPercent: g.utilizationPercent,
    memoryUsedBytes: g.memoryUsedBytes,
    memoryTotalBytes: g.memoryTotalBytes,
  }));
}
