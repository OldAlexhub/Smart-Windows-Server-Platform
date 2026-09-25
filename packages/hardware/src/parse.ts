import type { DiskInfo, DiskMedia, GpuInfo } from "@nexus/shared";

/** PowerShell's ConvertTo-Json collapses single-element arrays; normalise. */
export function toArray<T>(v: T | T[] | null | undefined): T[] {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

// ---------------------------------------------------------------- probe JSON

export interface RawProbe {
  os?: { caption?: string; version?: string; build?: string; arch?: string; edition?: string; displayVersion?: string; freeMemKb?: number };
  cpu?: RawCpu | RawCpu[];
  system?: { totalMem?: number; hypervisor?: boolean; model?: string; manufacturer?: string };
  volumes?: RawVolume | RawVolume[];
  gpus?: RawGpu | RawGpu[];
}
interface RawCpu {
  name?: string;
  manufacturer?: string;
  cores?: number;
  threads?: number;
  mhz?: number;
  virt?: boolean | null;
}
interface RawVolume {
  id: string;
  label?: string | null;
  fs?: string | null;
  size?: number | null;
  free?: number | null;
  driveType?: number;
  media?: string | null;
  bus?: string | null;
  model?: string | null;
}
interface RawGpu {
  name?: string;
  vendor?: string;
  ram?: number | null;
  qwMem?: number | null;
  driver?: string | null;
  pnp?: string | null;
}

export function parseCpu(raw: RawProbe["cpu"]) {
  const cpus = toArray(raw);
  const first = cpus[0] ?? {};
  const model = (first.name ?? "Unknown processor").replace(/\s+/g, " ").trim();
  return {
    model,
    vendor: /amd/i.test(first.manufacturer ?? model) ? "AMD" : /intel/i.test(first.manufacturer ?? model) ? "Intel" : (first.manufacturer ?? "Unknown"),
    cores: cpus.reduce((s, c) => s + (c.cores ?? 0), 0),
    threads: cpus.reduce((s, c) => s + (c.threads ?? 0), 0),
    baseMhz: first.mhz ?? 0,
    virtualizationFirmware: cpus.some((c) => c.virt === true) ? true : cpus.every((c) => c.virt === false) ? false : null,
  };
}

const EXTERNAL_BUSES = new Set(["usb", "1394", "sd", "mmc", "thunderbolt"]);

export function inferMedia(v: Pick<RawVolume, "media" | "bus" | "model">): DiskMedia {
  const bus = (v.bus ?? "").toLowerCase();
  const media = (v.media ?? "").toLowerCase();
  const model = v.model ?? "";
  if (bus === "nvme" || /\bnvme\b/i.test(model)) return "nvme";
  if (media === "ssd") return "ssd";
  if (media === "hdd") return "hdd";
  if (/\b(ssd|solid state|extreme\s*pro|990 pro|970 evo)\b/i.test(model)) return "ssd";
  if (/\b(hdd|barracuda|ironwolf|expansion|elements|my passport|wd (blue|red|purple)|st\d{3,}dm)\b/i.test(model)) return "hdd";
  return "unknown";
}

export function parseVolumes(raw: RawProbe["volumes"]): DiskInfo[] {
  return toArray(raw)
    .filter((v) => (v.size ?? 0) > 0)
    .map((v) => {
      const bus = v.bus && v.bus !== "Unknown" ? v.bus : null;
      return {
        mount: `${v.id.replace(/\\$/, "")}\\`,
        label: v.label ?? "",
        fileSystem: v.fs ?? "",
        totalBytes: Number(v.size ?? 0),
        freeBytes: Number(v.free ?? 0),
        media: inferMedia(v),
        bus,
        model: v.model ?? null,
        removable: v.driveType === 2,
        external: v.driveType === 2 || EXTERNAL_BUSES.has((bus ?? "").toLowerCase()),
      };
    });
}

export function gpuVendor(name: string, vendor = "", pnp = ""): GpuInfo["vendor"] {
  const s = `${name} ${vendor} ${pnp}`;
  if (/VEN_10DE|nvidia/i.test(s)) return "nvidia";
  if (/VEN_1002|\bamd\b|advanced micro devices|radeon/i.test(s)) return "amd";
  if (/VEN_8086|intel/i.test(s)) return "intel";
  return "other";
}

function isIntegrated(name: string, vendor: GpuInfo["vendor"]): boolean {
  if (vendor === "intel") return !/\barc\s*a\d{3}|\barc\s*b\d{3}/i.test(name);
  if (vendor === "amd") return /radeon\(tm\) graphics|radeon graphics|vega \d+ graphics|\d{3}m\b/i.test(name) && !/\brx\b/i.test(name);
  return false;
}

export function parseGpus(raw: RawProbe["gpus"]): GpuInfo[] {
  return toArray(raw)
    .filter((g) => g.name && !/microsoft basic|remote display|virtual/i.test(g.name))
    .map((g) => {
      const vendor = gpuVendor(g.name!, g.vendor ?? "", g.pnp ?? "");
      return {
        name: g.name!.trim(),
        vendor,
        vramBytes: Number(g.qwMem ?? g.ram ?? 0),
        driverVersion: g.driver ?? null,
        cudaVersion: null,
        integrated: isIntegrated(g.name!, vendor),
      };
    });
}

// ---------------------------------------------------------------- nvidia-smi

export interface NvidiaGpu {
  name: string;
  memoryTotalBytes: number;
  memoryUsedBytes: number;
  driverVersion: string;
  utilizationPercent: number;
}

/** Parses `nvidia-smi --query-gpu=name,memory.total,memory.used,driver_version,utilization.gpu --format=csv,noheader,nounits`. */
export function parseNvidiaSmiCsv(csv: string): NvidiaGpu[] {
  return csv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, total, used, driver, util] = line.split(",").map((s) => s.trim());
      return {
        name: name ?? "NVIDIA GPU",
        memoryTotalBytes: Number(total) * 1024 * 1024 || 0,
        memoryUsedBytes: Number(used) * 1024 * 1024 || 0,
        driverVersion: driver ?? "",
        utilizationPercent: Number(util) || 0,
      };
    });
}

/** Extracts the CUDA version from the nvidia-smi banner (classic and newer "CUDA UMD Version" formats). */
export function parseCudaVersion(banner: string): string | null {
  const m = banner.match(/CUDA(?:\s+UMD)?\s+Version:\s*([\d.]+)/i);
  return m ? m[1]! : null;
}

// ---------------------------------------------------------------- WSL

/** `wsl.exe --status` exits 0 only when WSL is installed. */
export function parseWslStatus(code: number, output: string): { installed: boolean; defaultVersion: number | null } {
  if (code !== 0 || /not installed/i.test(output)) return { installed: false, defaultVersion: null };
  const m = output.match(/Default Version:\s*(\d)/i);
  return { installed: true, defaultVersion: m ? Number(m[1]) : 2 };
}
