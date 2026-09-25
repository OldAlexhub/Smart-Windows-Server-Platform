import { describe, expect, it } from "vitest";
import type { GpuInfo, HardwareProfile } from "@nexus/shared";
import { EMBEDDING_MODEL, MODEL_CATALOG, modelFootprintGb, ollamaEnv, OPEN_SOURCE_LICENSES, planAi } from "@nexus/ai";

const GiB = 1024 ** 3;
const nvidia = (name: string, vramGb: number): GpuInfo => ({ name, vendor: "nvidia", vramBytes: vramGb * GiB, driverVersion: "610.60", cudaVersion: "13.3", integrated: false });

function hw(ramGb: number, gpus: GpuInfo[] = [], cuda = gpus.some((g) => g.vendor === "nvidia"), cores = 16): HardwareProfile {
  return {
    detectedAt: "",
    os: { name: "Windows 11 Pro", version: "24H2", build: "26100", edition: "Professional", arch: "x64" },
    cpu: { model: "CPU", vendor: "AMD", cores, threads: cores * 2, baseMhz: 4000 },
    memory: { totalBytes: ramGb * GiB, freeBytes: ramGb * GiB * 0.5 },
    disks: [],
    gpus,
    cuda: { available: cuda, version: cuda ? "13.3" : null },
    network: [],
    virtualization: { firmwareEnabled: true, hypervisorPresent: false, wsl2Available: false, wsl2Installable: true },
    system: { manufacturer: "", model: "" },
  };
}

describe("planAi — CUDA", () => {
  it("RTX 5090 (32 GB): large model, long context, concurrent inference", () => {
    const p = planAi(hw(64, [nvidia("NVIDIA RTX 5090", 32)]));
    expect(p).toMatchObject({ acceleration: "cuda", label: "GPU Accelerated (CUDA)" });
    expect(p.model.id).toBe("qwen3:32b");
    expect(p.contextTokens).toBe(32768);
    expect(p.concurrency).toBeGreaterThanOrEqual(1);
    expect(modelFootprintGb(p.model, p.contextTokens)).toBeLessThanOrEqual(p.budgetBytes / GiB);
  });

  it("RTX 5080 (16 GB, this machine): 14B model with room for 2+ requests", () => {
    const p = planAi(hw(32, [nvidia("NVIDIA GeForce RTX 5080", 15.9)]));
    expect(p.acceleration).toBe("cuda");
    expect(p.model.id).toBe("qwen3:14b");
    expect(p.contextTokens).toBe(16384);
    expect(p.gpu).toMatchObject({ name: "NVIDIA GeForce RTX 5080", index: 0 });
  });

  it("8 GB GPU: mid-size model", () => {
    const p = planAi(hw(32, [nvidia("NVIDIA RTX 4060", 8)]));
    expect(p.model.id).toBe("qwen3:4b");
    expect(p.contextTokens).toBe(8192);
  });

  it("picks the GPU with the most memory and ignores integrated graphics", () => {
    const igpu: GpuInfo = { name: "Intel UHD", vendor: "intel", vramBytes: 1 * GiB, driverVersion: null, cudaVersion: null, integrated: true };
    const p = planAi(hw(64, [igpu, nvidia("RTX 3060", 12), nvidia("RTX 4090", 24)]));
    expect(p.gpu).toMatchObject({ name: "RTX 4090", index: 2 });
  });

  it("NVIDIA GPU without a working CUDA driver falls back to CPU", () => {
    expect(planAi(hw(32, [nvidia("RTX 3080", 10)], false)).acceleration).toBe("cpu");
  });
});

describe("planAi — CPU only", () => {
  it("16 GB laptop: lightweight model, single request", () => {
    const p = planAi(hw(16, [], false, 8));
    expect(p).toMatchObject({ acceleration: "cpu", label: "CPU Mode", concurrency: 1, contextTokens: 8192 });
    expect(p.model.parametersB).toBeLessThanOrEqual(4);
    expect(p.cpuThreads).toBe(6);
  });
  it("64 GB workstation: allows a larger model", () => {
    const p = planAi(hw(64, [], false));
    expect(p.model.parametersB).toBeGreaterThanOrEqual(8);
    expect(p.model.parametersB).toBeLessThanOrEqual(14);
  });
  it("tiny machines still get a model, with a warning", () => {
    const p = planAi(hw(4, [], false, 2));
    expect(p.model.id).toBe("qwen3:1.7b");
    expect(p.warnings[0]).toMatch(/very little memory/);
  });
  it("AMD GPUs use ROCm", () => {
    const amd: GpuInfo = { name: "AMD Radeon RX 7900 XTX", vendor: "amd", vramBytes: 24 * GiB, driverVersion: "x", cudaVersion: null, integrated: false };
    const p = planAi(hw(64, [amd], false));
    expect(p).toMatchObject({ acceleration: "rocm", label: "GPU Accelerated (AMD)" });
  });
});

describe("advanced overrides and runtime environment", () => {
  it("honours a preferred model and warns if it will not fit", () => {
    const p = planAi(hw(32, [nvidia("RTX 4060", 8)]), { preferredModel: "qwen3:32b" });
    expect(p.model.id).toBe("qwen3:32b");
    expect(p.warnings[0]).toMatch(/partly on the CPU/);
    expect(planAi(hw(32), { preferredModel: "made-up:1b" }).warnings[0]).toMatch(/isn't in the catalogue/);
  });

  it("builds a loopback-only Ollama environment", () => {
    const gpu = ollamaEnv(planAi(hw(32, [nvidia("RTX 5080", 16)])), { port: 43900, modelsDir: "D:\\Nexus\\AI\\models" });
    expect(gpu).toMatchObject({ OLLAMA_HOST: "127.0.0.1:43900", CUDA_VISIBLE_DEVICES: "0", OLLAMA_FLASH_ATTENTION: "1", OLLAMA_MODELS: "D:\\Nexus\\AI\\models" });
    const cpu = ollamaEnv(planAi(hw(16, [], false)), { port: 43900, modelsDir: "x" });
    expect(cpu).toMatchObject({ CUDA_VISIBLE_DEVICES: "-1", OLLAMA_NUM_PARALLEL: "1" });
    expect(cpu.OLLAMA_HOST).toMatch(/^127\.0\.0\.1:/);
  });
});

describe("model catalogue", () => {
  it("lists only models under open-source licences", () => {
    for (const m of [...MODEL_CATALOG, EMBEDDING_MODEL]) expect(OPEN_SOURCE_LICENSES, `${m.id} (${m.license})`).toContain(m.license);
  });

  it("picks a large open-source model for machines with plenty of graphics memory", () => {
    const plan = planAi(hw(256, [nvidia("NVIDIA RTX PRO 6000", 96)]));
    expect(plan.model.license).toBe("Apache-2.0");
    expect(plan.model.id).toBe("gpt-oss:120b");
  });
});
