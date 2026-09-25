import { BRAND, formatBytes, GiB, type DiskInfo, type HardwareProfile } from "@nexus/shared";

// ------------------------------------------------------------------ first-run checks

export type CheckLevel = "ok" | "warning" | "problem";

export interface SystemCheck {
  key: "cpu" | "memory" | "storage" | "virtualization" | "network" | "gpu" | "cuda" | "windows";
  label: string;
  level: CheckLevel;
  summary: string;
}

/** The "Checking your computer..." list. Plain language; nothing here requires a decision. */
export function systemChecks(hw: HardwareProfile): SystemCheck[] {
  const checks: SystemCheck[] = [];
  const ramGb = hw.memory.totalBytes / GiB;
  const bestFree = Math.max(0, ...hw.disks.filter((d) => !d.external).map((d) => d.freeBytes));
  const hasLan = hw.network.some((n) => !n.internal && n.family === "IPv4");
  const discrete = hw.gpus.find((g) => !g.integrated);

  checks.push({
    key: "cpu",
    label: "CPU",
    level: hw.cpu.threads >= 4 ? "ok" : "warning",
    summary: `${hw.cpu.model} · ${hw.cpu.cores} cores / ${hw.cpu.threads} threads`,
  });
  checks.push({
    key: "memory",
    label: "Memory",
    level: ramGb >= 8 ? "ok" : ramGb >= 4 ? "warning" : "problem",
    summary: `${Math.round(ramGb)} GB${ramGb < 8 ? " — more memory is recommended for running several apps" : ""}`,
  });
  checks.push({
    key: "storage",
    label: "Storage",
    level: bestFree >= 50 * GiB ? "ok" : bestFree >= 10 * GiB ? "warning" : "problem",
    summary: `${formatBytes(bestFree)} free on the best internal drive`,
  });
  checks.push({
    key: "virtualization",
    label: "Virtualization",
    level: hw.virtualization.firmwareEnabled === false ? "warning" : "ok",
    summary: hw.virtualization.wsl2Available
      ? "Enabled · Linux apps supported"
      : hw.virtualization.firmwareEnabled === false
        ? "Turned off in firmware — Windows apps still work"
        : "Enabled",
  });
  checks.push({
    key: "network",
    label: "Network",
    level: hasLan ? "ok" : "warning",
    summary: hasLan ? "Connected" : "No network connection found — local use only for now",
  });
  checks.push({
    key: "gpu",
    label: "GPU",
    level: "ok",
    summary: discrete
      ? `${discrete.name}${discrete.vramBytes ? ` · ${Math.round(discrete.vramBytes / GiB)} GB` : ""}`
      : hw.gpus[0]
        ? `${hw.gpus[0].name} (integrated)`
        : "No dedicated graphics — AI will use the CPU",
  });
  checks.push({
    key: "cuda",
    label: "AI Acceleration",
    level: "ok",
    summary: hw.cuda.available
      ? `CUDA ${hw.cuda.version} available`
      : discrete?.vendor === "amd"
        ? "AMD GPU acceleration"
        : "CPU mode",
  });
  const build = Number(hw.os.build);
  checks.push({
    key: "windows",
    label: "Windows",
    level: !build || build >= 19041 ? "ok" : "warning",
    summary: `${hw.os.name} ${hw.os.version}`.trim(),
  });
  return checks;
}

// ------------------------------------------------------------------ storage recommendation

export type DriveRole = "apps" | "database" | "files" | "backups";

export interface DriveOption {
  mount: string;
  label: string;
  media: DiskInfo["media"];
  external: boolean;
  freeBytes: number;
  totalBytes: number;
  suitability: "recommended" | "good" | "not_recommended";
  note: string;
}

export interface RecommendedConfig {
  paths: { apps: string; database: string; files: string; backups: string };
  ai: { mode: "gpu" | "cpu"; label: string };
  notes: string[];
}

const MEDIA_SCORE: Record<DiskInfo["media"], number> = { nvme: 4, ssd: 3, unknown: 1, hdd: 0 };
const MIN_WORK_FREE = 20 * GiB;

/** Score a drive for live workloads (apps, databases): fast, internal, room to grow. */
function liveScore(d: DiskInfo, systemDrive: string): number {
  if (d.external || d.removable || d.freeBytes < MIN_WORK_FREE) return -1;
  let s = MEDIA_SCORE[d.media] * 1000;
  // Prefer a fast non-system data drive, so a full data disk can never stop Windows.
  if (d.mount.toUpperCase() !== systemDrive && d.media !== "hdd") s += 500;
  s += Math.min(d.freeBytes / GiB, 499);
  return s;
}

/** Score a drive for backups: ideally a different physical device, lots of space, speed irrelevant. */
function backupScore(d: DiskInfo, liveMount: string): number {
  if (d.mount === liveMount) return -1;
  let s = d.external ? 2000 : 1000;
  if (d.removable) s -= 500; // flash sticks get unplugged
  s += Math.min(d.freeBytes / GiB, 999);
  return s;
}

export function recommendConfig(hw: HardwareProfile, systemDrive = "C:\\"): RecommendedConfig {
  const sys = systemDrive.toUpperCase();
  const disks = hw.disks.length ? hw.disks : [fallbackDisk(sys)];
  const notes: string[] = [];

  const live = [...disks].sort((a, b) => liveScore(b, sys) - liveScore(a, sys))[0]!;
  const liveRoot = `${live.mount}${BRAND.dataFolderName}`;

  const backupCandidates = disks.filter((d) => backupScore(d, live.mount) >= 0 && d.freeBytes >= 10 * GiB);
  const backupDisk = backupCandidates.sort((a, b) => backupScore(b, live.mount) - backupScore(a, live.mount))[0];
  let backups: string;
  if (backupDisk) {
    backups = `${backupDisk.mount}${BRAND.backupFolderName}`;
  } else {
    backups = `${live.mount}${BRAND.backupFolderName}`;
    notes.push(
      "Backups are on the same drive as your data. Connect an external drive later to protect against drive failure.",
    );
  }
  if (live.media === "hdd") notes.push("Your fastest available drive is a hard disk. An SSD will make databases much faster.");

  const gpu = hw.gpus.find((g) => !g.integrated && (g.vendor === "nvidia" || g.vendor === "amd"));
  const ai = hw.cuda.available || gpu?.vendor === "amd" ? { mode: "gpu" as const, label: "GPU Accelerated" } : { mode: "cpu" as const, label: "CPU Mode" };

  return {
    paths: {
      apps: `${liveRoot}\\Apps`,
      database: `${liveRoot}\\Database`,
      files: `${liveRoot}\\Storage`,
      backups,
    },
    ai,
    notes,
  };
}

/** Drive picker contents for "Choose a different location". */
export function driveOptions(hw: HardwareProfile, role: DriveRole, systemDrive = "C:\\"): DriveOption[] {
  const sys = systemDrive.toUpperCase();
  const rec = recommendConfig(hw, systemDrive);
  const recommendedMount = (role === "backups" ? rec.paths.backups : rec.paths[role]).slice(0, 3);
  return hw.disks.map((d) => {
    let suitability: DriveOption["suitability"] = "good";
    let note = "";
    if (d.mount === recommendedMount) {
      suitability = "recommended";
      note = role === "backups" ? "Separate drive — protects against drive failure" : "Fastest drive with room to grow";
    } else if (role === "backups") {
      if (d.removable) (suitability = "not_recommended"), (note = "Removable drives are easily unplugged");
      else if (d.freeBytes < 10 * GiB) (suitability = "not_recommended"), (note = "Not enough free space");
      else note = d.external ? "External drive" : "Internal drive";
    } else {
      if (d.external || d.removable) (suitability = "not_recommended"), (note = "External drives can disconnect while in use");
      else if (d.media === "hdd") (suitability = "not_recommended"), (note = "Hard disks are slow for live data");
      else if (d.freeBytes < MIN_WORK_FREE) (suitability = "not_recommended"), (note = "Not enough free space");
      else note = d.mount.toUpperCase() === sys ? "Windows system drive" : "Fast internal drive";
    }
    return {
      mount: d.mount,
      label: d.label || d.model || d.mount,
      media: d.media,
      external: d.external,
      freeBytes: d.freeBytes,
      totalBytes: d.totalBytes,
      suitability,
      note,
    };
  });
}

function fallbackDisk(mount: string): DiskInfo {
  return {
    mount,
    label: "",
    fileSystem: "NTFS",
    totalBytes: 0,
    freeBytes: MIN_WORK_FREE,
    media: "unknown",
    bus: null,
    model: null,
    removable: false,
    external: false,
  };
}
