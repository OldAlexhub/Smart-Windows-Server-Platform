import type { AppStatus } from "@nexus/shared";

export interface HealthInputs {
  apps: { name: string; status: AppStatus }[];
  databasesOffline: number;
  cpuPercent: number | null;
  memoryUsedFraction: number | null;
  /** Lowest free-space fraction among drives Nexus uses. */
  lowestDiskFreeFraction: number | null;
  unprotectedApps: string[];
  externalAccessProblems: number;
  securityAlerts: number;
}

export interface HealthScore {
  score: number;
  label: "Healthy" | "Needs Attention" | "Problem";
  issues: string[];
}

/**
 * The single "System Health" number on the dashboard, with the reasons behind it in plain words.
 * Weighted so that a stopped app or unprotected data matters more than a busy CPU.
 */
export function computeHealthScore(i: HealthInputs): HealthScore {
  let score = 100;
  const issues: string[] = [];
  const hit = (points: number, issue: string) => {
    score -= points;
    issues.push(issue);
  };

  for (const a of i.apps) {
    if (a.status === "crashed" || a.status === "needs_attention") hit(15, `${a.name} needs attention`);
  }
  if (i.databasesOffline > 0) hit(20 * i.databasesOffline, `${i.databasesOffline} database${i.databasesOffline > 1 ? "s are" : " is"} offline`);
  if (i.unprotectedApps.length) hit(Math.min(20, 5 * i.unprotectedApps.length), `Backups out of date: ${i.unprotectedApps.join(", ")}`);
  if (i.lowestDiskFreeFraction !== null) {
    if (i.lowestDiskFreeFraction < 0.05) hit(20, "A drive is almost full");
    else if (i.lowestDiskFreeFraction < 0.15) hit(5, "A drive is getting full");
  }
  if (i.memoryUsedFraction !== null && i.memoryUsedFraction > 0.92) hit(10, "Memory is nearly full");
  if (i.cpuPercent !== null && i.cpuPercent > 90) hit(5, "The processor is very busy");
  if (i.externalAccessProblems > 0) hit(10, "External access has a problem");
  if (i.securityAlerts > 0) hit(10, `${i.securityAlerts} security alert${i.securityAlerts > 1 ? "s" : ""}`);

  score = Math.max(0, Math.round(score));
  return { score, label: score >= 90 ? "Healthy" : score >= 60 ? "Needs Attention" : "Problem", issues };
}
