import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HardwareDetector } from "@nexus/hardware";
import { InsecurePlainKeyProtector } from "@nexus/security";
import type { HardwareProfile } from "@nexus/shared";
import { NexusContext, SETTINGS } from "../src/context";
import { resolveServicePaths, type DataPaths } from "../src/paths";

export const GiB = 1024 ** 3;

export const FAKE_HARDWARE: HardwareProfile = {
  detectedAt: "2026-09-23T00:00:00.000Z",
  os: { name: "Windows 11 Pro", version: "24H2", build: "26100", edition: "Professional", arch: "x64" },
  cpu: { model: "AMD Ryzen 9 9950X", vendor: "AMD", cores: 16, threads: 32, baseMhz: 4300 },
  // Realistic for CI/dev machines: several test clusters run at once.
  memory: { totalBytes: 16 * GiB, freeBytes: 8 * GiB },
  disks: [
    {
      mount: "C:\\",
      label: "System",
      fileSystem: "NTFS",
      totalBytes: 1000 * GiB,
      freeBytes: 400 * GiB,
      media: "nvme",
      bus: "NVMe",
      model: null,
      removable: false,
      external: false,
    },
    {
      mount: "E:\\",
      label: "Backup",
      fileSystem: "NTFS",
      totalBytes: 8000 * GiB,
      freeBytes: 7000 * GiB,
      media: "hdd",
      bus: "USB",
      model: null,
      removable: false,
      external: true,
    },
  ],
  gpus: [
    {
      name: "NVIDIA GeForce RTX 5090",
      vendor: "nvidia",
      vramBytes: 32 * GiB,
      driverVersion: "610.60",
      cudaVersion: "13.3",
      integrated: false,
    },
  ],
  cuda: { available: true, version: "13.3" },
  network: [{ name: "Ethernet", address: "192.168.1.20", family: "IPv4", internal: false }],
  virtualization: { firmwareEnabled: true, hypervisorPresent: true, wsl2Available: false, wsl2Installable: true },
  system: { manufacturer: "Custom", model: "Workstation" },
};

export class FakeDetector extends HardwareDetector {
  override async detect(): Promise<HardwareProfile> {
    return { ...FAKE_HARDWARE, detectedAt: new Date().toISOString() };
  }
}

// Below Windows' ephemeral range (49152+), which outgoing connections and listen(0) use, so a test app's
// port is never taken by another test's connection between the free-check and the app starting.
let rangeBase = 30000 + Math.floor(Math.random() * 40) * 200 + (process.pid % 10) * 20;
function nextRange(): [number, number] {
  const start = rangeBase;
  rangeBase += 20;
  if (rangeBase > 42800) rangeBase = 30000;
  return [start, start + 19];
}

/** A throwaway Nexus installation in a temp folder. */
export function tempHome(): { home: string; dispose: () => void } {
  const home = mkdtempSync(join(tmpdir(), "nexus-home-"));
  return { home, dispose: () => rmSync(home, { recursive: true, force: true }) };
}

export async function createContext(
  home: string,
  opts: { setup?: boolean; managementPort?: number } = {},
): Promise<NexusContext> {
  const paths = resolveServicePaths({ ...process.env, NEXUS_HOME: join(home, "service") });
  const ctx = await NexusContext.create({
    paths,
    managementPort: opts.managementPort ?? 0,
    keyProtector: new InsecurePlainKeyProtector(),
    hardwareDetector: new FakeDetector(),
    // Each test context gets its own private port range so parallel tests never collide.
    portRange: nextRange(),
  });
  if (opts.setup) {
    const data: DataPaths = {
      apps: join(home, "data", "Apps"),
      database: join(home, "data", "Database"),
      files: join(home, "data", "Storage"),
      backups: join(home, "data", "Backups"),
      ai: join(home, "data", "AI"),
    };
    for (const d of Object.values(data)) mkdirSync(d, { recursive: true });
    ctx.settings.set(SETTINGS.hardware, FAKE_HARDWARE);
    ctx.settings.set(SETTINGS.dataPaths, data);
    ctx.settings.set(SETTINGS.setupCompleted, true);
    await ctx.startDataServices();
  }
  return ctx;
}
