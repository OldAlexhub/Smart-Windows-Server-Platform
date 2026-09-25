import { describe, expect, it } from "vitest";
import type { DiskInfo, HardwareProfile } from "@nexus/shared";
import { driveOptions, recommendConfig, systemChecks } from "@nexus/hardware";

const GiB = 1024 ** 3;
const disk = (mount: string, media: DiskInfo["media"], freeGb: number, extra: Partial<DiskInfo> = {}): DiskInfo => ({
  mount,
  label: "",
  fileSystem: "NTFS",
  totalBytes: freeGb * 2 * GiB,
  freeBytes: freeGb * GiB,
  media,
  bus: null,
  model: null,
  removable: false,
  external: false,
  ...extra,
});

function hw(overrides: Partial<HardwareProfile> = {}): HardwareProfile {
  return {
    detectedAt: "",
    os: { name: "Windows 11 Pro", version: "24H2", build: "26100", edition: "Professional", arch: "x64" },
    cpu: { model: "AMD Ryzen 9", vendor: "AMD", cores: 16, threads: 32, baseMhz: 4300 },
    memory: { totalBytes: 64 * GiB, freeBytes: 40 * GiB },
    disks: [disk("C:\\", "nvme", 400)],
    gpus: [],
    cuda: { available: false, version: null },
    network: [{ name: "Ethernet", address: "192.168.1.5", family: "IPv4", internal: false }],
    virtualization: { firmwareEnabled: true, hypervisorPresent: false, wsl2Available: true, wsl2Installable: false },
    system: { manufacturer: "", model: "" },
    ...overrides,
  };
}

describe("recommendConfig", () => {
  it("spec example: data on fast internal D:, backups on separate E:", () => {
    const r = recommendConfig(
      hw({
        disks: [disk("C:\\", "nvme", 300), disk("D:\\", "nvme", 3700), disk("E:\\", "hdd", 6000, { external: true })],
        gpus: [{ name: "NVIDIA RTX 5090", vendor: "nvidia", vramBytes: 32 * GiB, driverVersion: "x", cudaVersion: "13.0", integrated: false }],
        cuda: { available: true, version: "13.0" },
      }),
    );
    expect(r.paths).toEqual({
      apps: "D:\\Nexus\\Apps",
      database: "D:\\Nexus\\Database",
      files: "D:\\Nexus\\Storage",
      backups: "E:\\NexusBackups",
    });
    expect(r.ai).toEqual({ mode: "gpu", label: "GPU Accelerated" });
    expect(r.notes).toEqual([]);
  });

  it("this machine's shape: NVMe C: + external HDD/SSD → data on C:, backups on the big external", () => {
    const r = recommendConfig(
      hw({
        disks: [
          disk("C:\\", "nvme", 218),
          disk("D:\\", "hdd", 6706, { external: true, bus: "USB" }),
          disk("G:\\", "ssd", 1310, { external: true, bus: "USB" }),
        ],
      }),
    );
    expect(r.paths.database).toBe("C:\\Nexus\\Database");
    expect(r.paths.backups).toBe("D:\\NexusBackups");
    expect(r.ai.mode).toBe("cpu");
  });

  it("never puts live data on an HDD when an SSD exists, and warns when backups share the drive", () => {
    const r = recommendConfig(hw({ disks: [disk("C:\\", "ssd", 200), disk("D:\\", "hdd", 4000)] }));
    expect(r.paths.database).toBe("C:\\Nexus\\Database");
    expect(r.paths.backups).toBe("D:\\NexusBackups");

    const single = recommendConfig(hw({ disks: [disk("C:\\", "ssd", 200)] }));
    expect(single.paths.backups).toBe("C:\\NexusBackups");
    expect(single.notes[0]).toMatch(/same drive/);
  });

  it("prefers a large non-removable backup drive over a USB stick", () => {
    const r = recommendConfig(
      hw({ disks: [disk("C:\\", "nvme", 200), disk("F:\\", "unknown", 60, { removable: true, external: true }), disk("E:\\", "hdd", 900)] }),
    );
    expect(r.paths.backups).toBe("E:\\NexusBackups");
  });

  it("works with no disk information at all", () => {
    expect(recommendConfig(hw({ disks: [] })).paths.apps).toBe("C:\\Nexus\\Apps");
  });
});

describe("driveOptions", () => {
  it("labels drives for the friendly picker", () => {
    const h = hw({ disks: [disk("C:\\", "nvme", 300), disk("E:\\", "hdd", 6000, { external: true })] });
    const db = driveOptions(h, "database");
    expect(db.map((o) => [o.mount, o.suitability])).toEqual([
      ["C:\\", "recommended"],
      ["E:\\", "not_recommended"],
    ]);
    const backups = driveOptions(h, "backups");
    expect(backups.find((o) => o.mount === "E:\\")?.suitability).toBe("recommended");
  });
});

describe("systemChecks", () => {
  it("produces the first-run check list in plain language", () => {
    const checks = systemChecks(
      hw({
        gpus: [{ name: "NVIDIA RTX 5090", vendor: "nvidia", vramBytes: 32 * GiB, driverVersion: "x", cudaVersion: "13.0", integrated: false }],
        cuda: { available: true, version: "13.0" },
      }),
    );
    expect(checks.map((c) => c.key)).toEqual(["cpu", "memory", "storage", "virtualization", "network", "gpu", "cuda", "windows"]);
    expect(checks.every((c) => c.level === "ok")).toBe(true);
    expect(checks.find((c) => c.key === "gpu")!.summary).toBe("NVIDIA RTX 5090 · 32 GB");
    expect(checks.find((c) => c.key === "cuda")!.summary).toBe("CUDA 13.0 available");
  });

  it("warns (without blocking) on low memory and CPU-only", () => {
    const checks = systemChecks(hw({ memory: { totalBytes: 6 * GiB, freeBytes: GiB }, network: [] }));
    expect(checks.find((c) => c.key === "memory")!.level).toBe("warning");
    expect(checks.find((c) => c.key === "network")!.level).toBe("warning");
    expect(checks.find((c) => c.key === "cuda")!.summary).toBe("CPU mode");
  });
});
