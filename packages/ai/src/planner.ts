import { GiB, type AiAcceleration, type GpuInfo, type HardwareProfile } from "@nexus/shared";
import { EMBEDDING_MODEL, findModel, MODEL_CATALOG, type ModelEntry } from "./catalog";

export interface AiPlan {
  acceleration: AiAcceleration;
  /** "GPU Accelerated (CUDA)" / "CPU Mode" — what the dashboard shows. */
  label: string;
  gpu: { name: string; vramBytes: number; index: number } | null;
  model: ModelEntry;
  embeddingModel: ModelEntry;
  contextTokens: number;
  /** Parallel requests the model can serve. */
  concurrency: number;
  /** Memory the AI may use (VRAM for GPU, RAM for CPU). */
  budgetBytes: number;
  cpuThreads: number;
  /** How the plan was chosen, for Advanced mode. */
  reasons: string[];
  warnings: string[];
}

export interface PlanOptions {
  /** Advanced-mode override. */
  preferredModel?: string | null;
  /** Force CPU even with a GPU (e.g. GPU reserved for other work). */
  forceCpu?: boolean;
  catalog?: ModelEntry[];
}

const DISPLAY_RESERVE = 1.0 * GiB; // desktop/compositor share of VRAM
const OVERHEAD = 1.15; // runtime buffers on top of weights

function bestGpu(gpus: GpuInfo[], cuda: boolean): { gpu: GpuInfo; index: number } | null {
  const candidates = gpus
    .map((gpu, index) => ({ gpu, index }))
    .filter(({ gpu }) => !gpu.integrated && ((gpu.vendor === "nvidia" && cuda) || gpu.vendor === "amd") && gpu.vramBytes >= 4 * GiB);
  candidates.sort((a, b) => b.gpu.vramBytes - a.gpu.vramBytes);
  return candidates[0] ?? null;
}

function contextFor(budgetGb: number, onGpu: boolean): number {
  if (!onGpu) return 8192;
  if (budgetGb >= 24) return 32768;
  if (budgetGb >= 12) return 16384;
  return 8192;
}

/** Memory a model needs for `ctx` tokens × `parallel` requests. */
export function modelFootprintGb(m: ModelEntry, ctx: number, parallel = 1): number {
  return m.sizeGb * OVERHEAD + m.kvGbPer1k * (ctx / 1024) * parallel;
}

/**
 * Chooses how local AI runs on this computer. No questions: CUDA when an NVIDIA GPU with
 * enough memory is present, ROCm on capable AMD GPUs, otherwise CPU with a smaller model.
 * The largest catalogued model that fits the memory budget is selected.
 */
export function planAi(hw: HardwareProfile, opts: PlanOptions = {}): AiPlan {
  const catalog = (opts.catalog ?? MODEL_CATALOG).filter((m) => m.purposes.includes("chat")).sort((a, b) => a.sizeGb - b.sizeGb);
  const reasons: string[] = [];
  const warnings: string[] = [];
  const ramGb = hw.memory.totalBytes / GiB;
  const physicalCores = Math.max(1, hw.cpu.cores || hw.cpu.threads);
  const cpuThreads = Math.max(1, Math.min(physicalCores - (physicalCores > 4 ? 2 : 1), 32));

  const pick = opts.forceCpu ? null : bestGpu(hw.gpus, hw.cuda.available);
  let acceleration: AiAcceleration = "cpu";
  let budgetBytes: number;
  if (pick) {
    acceleration = pick.gpu.vendor === "nvidia" ? "cuda" : "rocm";
    budgetBytes = Math.max(0, pick.gpu.vramBytes * 0.9 - DISPLAY_RESERVE);
    reasons.push(`${pick.gpu.name} with ${Math.round(pick.gpu.vramBytes / GiB)} GB of graphics memory`);
  } else {
    // Keep most RAM for applications and PostgreSQL; CPU inference also slows sharply with size.
    const share = ramGb >= 64 ? 0.35 : ramGb >= 32 ? 0.3 : 0.25;
    budgetBytes = Math.max(1.5 * GiB, Math.min(hw.memory.totalBytes * share, 24 * GiB));
    reasons.push(hw.gpus.some((g) => !g.integrated) ? "No supported GPU acceleration found" : "No dedicated graphics card");
    reasons.push(`${Math.round(ramGb)} GB of memory`);
  }
  const budgetGb = budgetBytes / GiB;
  const ctx = contextFor(budgetGb, !!pick);

  // CPU speed limit: beyond ~14B parameters answers become too slow to be useful on CPU.
  const cpuCap = ramGb >= 64 ? 14 : ramGb >= 32 ? 8 : 4;
  const fitting = catalog.filter((m) => modelFootprintGb(m, ctx) <= budgetGb && (pick || m.parametersB <= cpuCap));
  let model = fitting[fitting.length - 1] ?? catalog[0]!;
  if (!fitting.length) warnings.push("This computer has very little memory for AI. Nexus chose the smallest model; answers may be slow.");

  if (opts.preferredModel) {
    const chosen = findModel(opts.preferredModel, opts.catalog ?? MODEL_CATALOG);
    if (!chosen) warnings.push(`The model "${opts.preferredModel}" isn't in the catalogue; using the recommended one.`);
    else {
      if (modelFootprintGb(chosen, ctx) > budgetGb) {
        warnings.push(`${chosen.id} needs about ${modelFootprintGb(chosen, ctx).toFixed(1)} GB but ${budgetGb.toFixed(1)} GB is available. It will run partly on the CPU and be slower.`);
      }
      model = chosen;
      reasons.push("Model chosen in Advanced settings");
    }
  } else {
    reasons.push(`${model.family} ${model.parametersB}B is the largest model that fits comfortably`);
  }

  const spare = budgetGb - modelFootprintGb(model, ctx);
  const perRequest = model.kvGbPer1k * (ctx / 1024);
  const concurrency = pick ? Math.max(1, Math.min(4, 1 + Math.floor(spare / Math.max(perRequest, 0.1)))) : 1;

  const label =
    acceleration === "cuda" ? "GPU Accelerated (CUDA)" : acceleration === "rocm" ? "GPU Accelerated (AMD)" : "CPU Mode";

  return {
    acceleration,
    label,
    gpu: pick ? { name: pick.gpu.name, vramBytes: pick.gpu.vramBytes, index: pick.index } : null,
    model,
    embeddingModel: EMBEDDING_MODEL,
    contextTokens: ctx,
    concurrency,
    budgetBytes,
    cpuThreads,
    reasons,
    warnings,
  };
}

/** Environment for the Ollama runtime implementing this plan. Loopback-only, always. */
export function ollamaEnv(plan: AiPlan, opts: { port: number; modelsDir: string }): Record<string, string> {
  const env: Record<string, string> = {
    OLLAMA_HOST: `127.0.0.1:${opts.port}`,
    OLLAMA_MODELS: opts.modelsDir,
    OLLAMA_NUM_PARALLEL: String(plan.concurrency),
    OLLAMA_MAX_LOADED_MODELS: plan.acceleration === "cpu" ? "1" : "2",
    OLLAMA_KEEP_ALIVE: "30m",
    OLLAMA_CONTEXT_LENGTH: String(plan.contextTokens),
    OLLAMA_ORIGINS: "http://127.0.0.1",
  };
  if (plan.acceleration === "cuda") {
    env.CUDA_VISIBLE_DEVICES = String(plan.gpu?.index ?? 0);
    env.OLLAMA_FLASH_ATTENTION = "1";
  } else if (plan.acceleration === "rocm") {
    env.HIP_VISIBLE_DEVICES = String(plan.gpu?.index ?? 0);
  } else {
    env.CUDA_VISIBLE_DEVICES = "-1";
    env.HIP_VISIBLE_DEVICES = "-1";
    env.OLLAMA_NUM_THREADS = String(plan.cpuThreads);
  }
  return env;
}
