import { existsSync } from "node:fs";
import os from "node:os";
import type { GpuInfo, HardwareProfile, Logger, NetworkInterfaceInfo } from "@nexus/shared";
import { silentLogger } from "@nexus/shared";
import {
  parseCpu,
  parseCudaVersion,
  parseGpus,
  parseNvidiaSmiCsv,
  parseVolumes,
  parseWslStatus,
  type NvidiaGpu,
  type RawProbe,
} from "./parse";
import { PROBE_SCRIPT } from "./probe.ps1";
import { decodeConsole, execRunner, type CommandRunner } from "./runner";

const NVIDIA_SMI_CANDIDATES = [
  "nvidia-smi",
  "C:\\Windows\\System32\\nvidia-smi.exe",
  "C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe",
];

export interface DetectorDeps {
  run?: CommandRunner;
  logger?: Logger;
  /** Overrides for tests. */
  networkInterfaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  platform?: NodeJS.Platform;
}

export class HardwareDetector {
  private readonly run: CommandRunner;
  private readonly log: Logger;
  private readonly nics: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  private readonly platform: NodeJS.Platform;

  constructor(deps: DetectorDeps = {}) {
    this.run = deps.run ?? execRunner;
    this.log = deps.logger ?? silentLogger;
    this.nics = deps.networkInterfaces ?? os.networkInterfaces;
    this.platform = deps.platform ?? process.platform;
  }

  async detect(): Promise<HardwareProfile> {
    const [probe, nvidia, wsl] = await Promise.all([this.probe(), this.nvidia(), this.wsl()]);
    const cpu = parseCpu(probe.cpu);
    let gpus = parseGpus(probe.gpus);
    gpus = mergeNvidia(gpus, nvidia.gpus, nvidia.cudaVersion);

    const hypervisor = probe.system?.hypervisor === true;
    // With Hyper-V/VBS active, Windows reports firmware virtualization as "false"; the hypervisor proves it is on.
    const firmwareEnabled = hypervisor ? true : cpu.virtualizationFirmware;
    const cudaAvailable = gpus.some((g) => g.vendor === "nvidia" && g.cudaVersion !== null);

    return {
      detectedAt: new Date().toISOString(),
      os: {
        name: probe.os?.caption?.replace(/^Microsoft\s+/, "") ?? `${os.type()} ${os.release()}`,
        version: probe.os?.displayVersion ?? probe.os?.version ?? os.release(),
        build: probe.os?.build ?? "",
        edition: probe.os?.edition ?? "",
        arch: os.arch(),
      },
      cpu: {
        model: cpu.model !== "Unknown processor" ? cpu.model : (os.cpus()[0]?.model ?? cpu.model),
        vendor: cpu.vendor,
        cores: cpu.cores || os.cpus().length,
        threads: cpu.threads || os.cpus().length,
        baseMhz: cpu.baseMhz || os.cpus()[0]?.speed || 0,
      },
      memory: {
        totalBytes: Number(probe.system?.totalMem ?? os.totalmem()),
        freeBytes: probe.os?.freeMemKb ? probe.os.freeMemKb * 1024 : os.freemem(),
      },
      disks: parseVolumes(probe.volumes),
      gpus,
      cuda: { available: cudaAvailable, version: cudaAvailable ? nvidia.cudaVersion : null },
      network: this.network(),
      virtualization: {
        firmwareEnabled,
        hypervisorPresent: hypervisor,
        wsl2Available: wsl.installed,
        wsl2Installable: !wsl.installed && firmwareEnabled !== false,
      },
      system: { manufacturer: probe.system?.manufacturer ?? "", model: probe.system?.model ?? "" },
    };
  }

  /** Live GPU utilisation / memory for monitoring (cheap; no PowerShell). */
  async nvidiaSnapshot(): Promise<NvidiaGpu[]> {
    return (await this.nvidia()).gpus;
  }

  private async probe(): Promise<RawProbe> {
    if (this.platform !== "win32") return {};
    const r = await this.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", PROBE_SCRIPT], 90_000);
    const text = decodeConsole(r.stdout).trim();
    try {
      return JSON.parse(text) as RawProbe;
    } catch (e) {
      this.log.warn("hardware probe returned unreadable output", { code: r.code, err: e as Error });
      return {};
    }
  }

  private async nvidia(): Promise<{ gpus: NvidiaGpu[]; cudaVersion: string | null }> {
    for (const exe of NVIDIA_SMI_CANDIDATES) {
      if (exe.includes("\\") && !existsSync(exe)) continue;
      const q = await this.run(exe, [
        "--query-gpu=name,memory.total,memory.used,driver_version,utilization.gpu",
        "--format=csv,noheader,nounits",
      ]);
      if (q.code !== 0) continue;
      const banner = await this.run(exe, []);
      return { gpus: parseNvidiaSmiCsv(decodeConsole(q.stdout)), cudaVersion: parseCudaVersion(decodeConsole(banner.stdout)) };
    }
    return { gpus: [], cudaVersion: null };
  }

  private async wsl(): Promise<{ installed: boolean }> {
    if (this.platform !== "win32") return { installed: false };
    const r = await this.run("wsl.exe", ["--status"], 20_000);
    return parseWslStatus(r.code, decodeConsole(r.stdout) + decodeConsole(r.stderr));
  }

  private network(): NetworkInterfaceInfo[] {
    const out: NetworkInterfaceInfo[] = [];
    for (const [name, addrs] of Object.entries(this.nics())) {
      for (const a of addrs ?? []) {
        if (a.family !== "IPv4" && a.family !== "IPv6") continue;
        if (a.family === "IPv6" && a.address.startsWith("fe80")) continue;
        out.push({ name, address: a.address, family: a.family, internal: a.internal });
      }
    }
    return out;
  }
}

/** nvidia-smi is authoritative for NVIDIA VRAM, driver and CUDA. */
export function mergeNvidia(gpus: GpuInfo[], smi: NvidiaGpu[], cudaVersion: string | null): GpuInfo[] {
  const result = gpus.map((g) => ({ ...g }));
  for (const s of smi) {
    const match = result.find((g) => g.vendor === "nvidia" && (g.name === s.name || s.name.includes(g.name) || g.name.includes(s.name)))
      ?? result.find((g) => g.vendor === "nvidia" && g.cudaVersion === null);
    if (match) {
      match.vramBytes = s.memoryTotalBytes || match.vramBytes;
      match.driverVersion = s.driverVersion || match.driverVersion;
      match.cudaVersion = cudaVersion;
    } else {
      result.push({
        name: s.name,
        vendor: "nvidia",
        vramBytes: s.memoryTotalBytes,
        driverVersion: s.driverVersion,
        cudaVersion,
        integrated: false,
      });
    }
  }
  return result;
}
