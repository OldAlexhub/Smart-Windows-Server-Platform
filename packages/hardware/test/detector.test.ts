import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  decodeConsole,
  HardwareDetector,
  inferMedia,
  parseCudaVersion,
  parseGpus,
  parseNvidiaSmiCsv,
  parseVolumes,
  parseWslStatus,
  type CommandRunner,
} from "@nexus/hardware";

const fx = (name: string) => readFileSync(join(__dirname, "fixtures", name), "utf8");
const GiB = 1024 ** 3;

/** Fake runner that answers like a real machine from fixtures. */
function fakeRunner(opts: { probe: string; smiCsv?: string; smiBanner?: string; wslCode?: number }): CommandRunner {
  return async (cmd, args) => {
    const ok = (s: string, code = 0) => ({ code, stdout: Buffer.from(s), stderr: Buffer.alloc(0) });
    if (cmd === "powershell.exe") return ok(opts.probe);
    if (cmd.includes("nvidia-smi")) {
      if (!opts.smiCsv) return ok("", 1);
      return args.length ? ok(opts.smiCsv) : ok(opts.smiBanner ?? "");
    }
    if (cmd === "wsl.exe") {
      const code = opts.wslCode ?? 0;
      const text = code === 0 ? "Default Version: 2\r\n" : "The Windows Subsystem for Linux is not installed.";
      return { code, stdout: Buffer.from(text, "utf16le"), stderr: Buffer.alloc(0) };
    }
    return ok("", 1);
  };
}

const nics = () => ({
  Ethernet: [
    { address: "192.168.1.20", family: "IPv4", internal: false } as never,
    { address: "fe80::1", family: "IPv6", internal: false } as never,
  ],
  Loopback: [{ address: "127.0.0.1", family: "IPv4", internal: true } as never],
});

describe("parsers", () => {
  it("parses nvidia-smi CSV and both banner formats", () => {
    const gpus = parseNvidiaSmiCsv("NVIDIA GeForce RTX 5080, 16303, 1215, 610.60, 7\n");
    expect(gpus[0]).toMatchObject({ name: "NVIDIA GeForce RTX 5080", driverVersion: "610.60", utilizationPercent: 7 });
    expect(gpus[0]!.memoryTotalBytes).toBe(16303 * 1024 * 1024);
    expect(parseCudaVersion(fx("nvidia-smi-header-new.txt"))).toBe("13.3");
    expect(parseCudaVersion(fx("nvidia-smi-header-classic.txt"))).toBe("12.3");
    expect(parseCudaVersion("garbage")).toBeNull();
  });

  it("classifies disk media from bus, media type and model", () => {
    expect(inferMedia({ bus: "NVMe", media: "SSD", model: "" })).toBe("nvme");
    expect(inferMedia({ bus: "USB", media: "Unspecified", model: "Seagate Expansion HDD" })).toBe("hdd");
    expect(inferMedia({ bus: "SATA", media: "HDD", model: "ST4000DM004" })).toBe("hdd");
    expect(inferMedia({ bus: "USB", media: "Unspecified", model: "USB Flash" })).toBe("unknown");
  });

  it("flags external and removable volumes", () => {
    const vols = parseVolumes(JSON.parse(fx("amd-workstation.probe.json")).volumes);
    expect(vols.map((v) => [v.mount, v.media, v.external, v.removable])).toEqual([
      ["C:\\", "nvme", false, false],
      ["E:\\", "hdd", false, false],
      ["F:\\", "unknown", true, true],
    ]);
  });

  it("identifies discrete vs integrated GPUs and uses 64-bit VRAM", () => {
    const gpus = parseGpus(JSON.parse(fx("amd-workstation.probe.json")).gpus);
    expect(gpus.map((g) => [g.name, g.vendor, g.integrated])).toEqual([
      ["AMD Radeon RX 7900 XTX", "amd", false],
      ["AMD Radeon(TM) Graphics", "amd", true],
    ]);
    expect(Math.round(gpus[0]!.vramBytes / GiB)).toBe(24);
    const intel = parseGpus(JSON.parse(fx("laptop-cpu-only.probe.json")).gpus);
    expect(intel[0]).toMatchObject({ vendor: "intel", integrated: true });
  });

  it("decodes UTF-16 console output from wsl.exe", () => {
    const text = "The Windows Subsystem for Linux is not installed.";
    expect(decodeConsole(Buffer.from(text, "utf16le"))).toBe(text);
    expect(decodeConsole(Buffer.from(text, "utf8"))).toBe(text);
    expect(parseWslStatus(50, text)).toEqual({ installed: false, defaultVersion: null });
    expect(parseWslStatus(0, "Default Version: 2")).toEqual({ installed: true, defaultVersion: 2 });
  });
});

describe("HardwareDetector with fixtures", () => {
  it("NVIDIA workstation: CUDA available, VRAM from nvidia-smi, virtualization via hypervisor", async () => {
    const det = new HardwareDetector({
      platform: "win32",
      networkInterfaces: nics,
      run: fakeRunner({
        probe: fx("workstation-rtx5080.probe.json"),
        smiCsv: "NVIDIA GeForce RTX 5080, 16303, 1215, 610.60, 0",
        smiBanner: fx("nvidia-smi-header-new.txt"),
        wslCode: 50,
      }),
    });
    const hw = await det.detect();
    expect(hw.os).toMatchObject({ name: "Windows 11 Home", version: "25H2", edition: "Core" });
    expect(hw.cpu).toMatchObject({ model: "Intel(R) Core(TM) Ultra 9 285", cores: 24, threads: 24, vendor: "Intel" });
    expect(Math.round(hw.memory.totalBytes / GiB)).toBe(32);
    expect(hw.gpus).toHaveLength(1);
    expect(hw.gpus[0]).toMatchObject({ vendor: "nvidia", cudaVersion: "13.3", driverVersion: "610.60", integrated: false });
    expect(hw.gpus[0]!.vramBytes).toBe(16303 * 1024 * 1024);
    expect(hw.cuda).toEqual({ available: true, version: "13.3" });
    expect(hw.virtualization).toEqual({
      firmwareEnabled: true,
      hypervisorPresent: true,
      wsl2Available: false,
      wsl2Installable: true,
    });
    expect(hw.disks.map((d) => `${d.mount}${d.media}${d.external ? "+ext" : ""}`)).toEqual([
      "C:\\nvme",
      "D:\\hdd+ext",
      "G:\\ssd+ext",
    ]);
    expect(hw.network).toEqual([
      { name: "Ethernet", address: "192.168.1.20", family: "IPv4", internal: false },
      { name: "Loopback", address: "127.0.0.1", family: "IPv4", internal: true },
    ]);
  });

  it("CPU-only laptop: no CUDA, single-object PowerShell JSON handled", async () => {
    const det = new HardwareDetector({
      platform: "win32",
      networkInterfaces: nics,
      run: fakeRunner({ probe: fx("laptop-cpu-only.probe.json"), wslCode: 0 }),
    });
    const hw = await det.detect();
    expect(hw.cuda).toEqual({ available: false, version: null });
    expect(hw.cpu.threads).toBe(12);
    expect(hw.disks).toHaveLength(1);
    expect(hw.virtualization.wsl2Available).toBe(true);
    expect(hw.gpus[0]!.integrated).toBe(true);
  });

  it("survives a broken probe by falling back to Node's view", async () => {
    const det = new HardwareDetector({ platform: "win32", networkInterfaces: nics, run: fakeRunner({ probe: "not json" }) });
    const hw = await det.detect();
    expect(hw.cpu.threads).toBeGreaterThan(0);
    expect(hw.memory.totalBytes).toBeGreaterThan(0);
    expect(hw.disks).toEqual([]);
  });
});

describe.runIf(process.platform === "win32")("HardwareDetector live (this machine)", () => {
  it("detects real hardware", async () => {
    const hw = await new HardwareDetector().detect();
    expect(hw.cpu.threads).toBeGreaterThan(0);
    expect(hw.memory.totalBytes).toBeGreaterThan(2 * GiB);
    expect(hw.disks.some((d) => d.mount === "C:\\")).toBe(true);
    expect(hw.os.name).toMatch(/Windows/);
  }, 120_000);
});
