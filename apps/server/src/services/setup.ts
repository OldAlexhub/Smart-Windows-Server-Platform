import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { planAi } from "@nexus/ai";
import { driveOptions, recommendConfig, systemChecks, type DriveOption, type SystemCheck } from "@nexus/hardware";
import { NexusError, type HardwareProfile } from "@nexus/shared";
import { SETTINGS, type NexusContext } from "../context";
import type { DataPaths } from "../paths";

export interface SetupRecommendation {
  paths: DataPaths;
  ai: { enabled: boolean; label: string; model: string; acceleration: string };
  notes: string[];
  drives: Record<"apps" | "database" | "files" | "backups", DriveOption[]>;
}

/** Step 2 of first run: "Checking your computer..." */
export async function runHardwareCheck(ctx: NexusContext): Promise<{ hardware: HardwareProfile; checks: SystemCheck[] }> {
  const hardware = await ctx.hardwareDetector.detect();
  ctx.settings.set(SETTINGS.hardware, hardware);
  return { hardware, checks: systemChecks(hardware) };
}

/** Step 3: "Recommended Configuration". Nothing to decide unless the user wants to. */
export function recommendation(ctx: NexusContext): SetupRecommendation {
  const hw = ctx.hardware;
  if (!hw) throw NexusError.conflict("Nexus needs to check this computer first.");
  const rec = recommendConfig(hw);
  const ai = planAi(hw);
  // Portable copy: everything stays inside its own folder (it can move to another computer).
  const portable = process.env.NEXUS_DATA_ROOT;
  const paths = portable
    ? { apps: join(portable, "Apps"), database: join(portable, "Database"), files: join(portable, "Storage"), backups: join(portable, "Backups"), ai: join(portable, "AI") }
    : { ...rec.paths, ai: join(dirname(rec.paths.apps), "AI") };
  return {
    paths,
    ai: { enabled: true, label: rec.ai.label, model: ai.model.id, acceleration: ai.acceleration },
    notes: portable ? ["Portable copy: your applications, databases, files and backups are kept inside the portable folder.", ...rec.notes] : rec.notes,
    drives: {
      apps: driveOptions(hw, "apps"),
      database: driveOptions(hw, "database"),
      files: driveOptions(hw, "files"),
      backups: driveOptions(hw, "backups"),
    },
  };
}

/** Confirms a folder can be created and written, with a plain explanation if not. */
function ensureWritable(label: string, path: string): void {
  try {
    mkdirSync(path, { recursive: true });
    const probe = join(path, `.nexus-write-test-${process.pid}`);
    writeFileSync(probe, "ok");
    rmSync(probe);
  } catch (e) {
    throw NexusError.invalid(`Nexus can't use ${path} for ${label} (${(e as NodeJS.ErrnoException).code ?? "not writable"}). Choose another location.`);
  }
}

/** Step 4: "Use Recommended Configuration" (optionally with changed locations). */
export async function applySetup(ctx: NexusContext, input: { paths?: Partial<DataPaths>; aiEnabled?: boolean }): Promise<void> {
  if (ctx.setupCompleted) throw NexusError.conflict("This server is already set up.");
  const rec = recommendation(ctx);
  const paths: DataPaths = { ...rec.paths, ...input.paths };
  const labels: Record<keyof DataPaths, string> = {
    apps: "applications",
    database: "databases",
    files: "file storage",
    backups: "backups",
    ai: "AI models",
  };
  for (const [k, v] of Object.entries(paths) as [keyof DataPaths, string][]) ensureWritable(labels[k], v);

  ctx.settings.set(SETTINGS.dataPaths, paths);
  ctx.settings.set(SETTINGS.aiEnabled, input.aiEnabled ?? true);
  ctx.settings.set(SETTINGS.aiLevel, "recommend");
  await ctx.startDataServices();
  ctx.settings.set(SETTINGS.setupCompleted, true);
  for (const fn of ctx.afterSetup) void fn().catch((e) => ctx.log.error("post-setup start failed", { err: e as Error }));
  ctx.activity.add("success", "Your server is ready.");
  ctx.audit.record({ actor: { type: "system" }, action: "setup.complete", details: { paths } });
}
