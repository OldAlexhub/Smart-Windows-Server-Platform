import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { NexusError } from "@nexus/shared";

export interface RInstall {
  /** "4.5.2" */
  version: string;
  home: string;
  rscript: string;
}

const cmp = (a: string, b: string) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};

function registryInstalls(): Promise<RInstall[]> {
  if (process.platform !== "win32") return Promise.resolve([]);
  return new Promise((resolve) => {
    const script = "foreach ($h in 'HKLM:\\SOFTWARE\\R-core\\R','HKCU:\\SOFTWARE\\R-core\\R') { Get-ChildItem $h -ErrorAction SilentlyContinue | ForEach-Object { '{0}|{1}' -f $_.PSChildName, (Get-ItemProperty $_.PSPath).InstallPath } }";
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 20_000 }, (_err, stdout) => {
      const found: RInstall[] = [];
      for (const line of String(stdout ?? "").split(/\r?\n/)) {
        const [version, home] = line.trim().split("|");
        if (version && home && /^\d+\.\d+\.\d+$/.test(version)) found.push({ version, home, rscript: join(home, "bin", "Rscript.exe") });
      }
      resolve(found);
    });
  });
}

/**
 * Installed R versions, newest first (Windows registry, then Program Files\R).
 * `protectedOnly` drops installs inside user profiles: the Nexus service runs as SYSTEM and must
 * never run a program a normal account can change.
 */
export async function findRInstalls(opts: { extraRoots?: string[]; protectedOnly?: boolean } = {}): Promise<RInstall[]> {
  const found = await registryInstalls();
  for (const root of [join(process.env.ProgramFiles ?? "C:\\Program Files", "R"), ...(opts.extraRoots ?? [])]) {
    if (!existsSync(root)) continue;
    for (const d of readdirSync(root)) {
      const m = d.match(/^R-(\d+\.\d+\.\d+)$/);
      if (m) found.push({ version: m[1]!, home: join(root, d), rscript: join(root, d, "bin", "Rscript.exe") });
    }
  }
  const seen = new Set<string>();
  return found
    .filter((f) => !(opts.protectedOnly && /\\Users\\/i.test(f.home)))
    .filter((f) => existsSync(f.rscript) && !seen.has(f.home.toLowerCase()) && seen.add(f.home.toLowerCase()))
    .sort((a, b) => cmp(b.version, a.version));
}

/**
 * Picks the R for an application: the exact version asked for (renv.lock), else the newest with the
 * same major.minor, else the newest installed. Package binaries follow major.minor, so a
 * different minor is still usable — the caller reports it.
 */
export function chooseR(installs: RInstall[], wanted: string | null): RInstall | null {
  if (!wanted) return installs[0] ?? null;
  const minor = wanted.split(".").slice(0, 2).join(".");
  return installs.find((r) => r.version === wanted) ?? installs.find((r) => r.version.startsWith(`${minor}.`)) ?? installs[0] ?? null;
}

export class RRuntimeLocator {
  constructor(
    private readonly opts: { extraRoots?: string[]; protectedOnly?: boolean } = {},
    private readonly list: () => Promise<RInstall[]> = () => findRInstalls(opts),
  ) {}

  async require(wanted: string | null): Promise<RInstall> {
    const installs = await this.list();
    const chosen = chooseR(installs, wanted);
    if (chosen) return chosen;
    throw new NexusError("dependency_missing", "R isn't installed on this computer.", {
      problem: {
        title: "R is needed",
        summary: `This is an R Shiny application${wanted ? ` written for R ${wanted}` : ""}. Install R for all users from cran.r-project.org (the default installer does this), then deploy again. Nexus finds it automatically.`,
        checks: [{ label: "R installations found", status: "failed", detail: "none" }],
      },
    });
  }
}
