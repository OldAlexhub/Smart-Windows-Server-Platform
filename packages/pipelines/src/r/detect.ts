import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { StepError } from "../errors";

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

/** Finds installed R versions (Windows registry, then Program Files\R). */
export class RLocator {
  constructor(private readonly extraRoots: string[] = []) {}

  async list(): Promise<RInstall[]> {
    const found = await registryInstalls();
    for (const root of [join(process.env.ProgramFiles ?? "C:\\Program Files", "R"), ...this.extraRoots]) {
      if (!existsSync(root)) continue;
      for (const d of readdirSync(root)) {
        const m = d.match(/^R-(\d+\.\d+\.\d+)$/);
        if (m) found.push({ version: m[1]!, home: join(root, d), rscript: join(root, d, "bin", "Rscript.exe") });
      }
    }
    const seen = new Set<string>();
    return found
      .filter((f) => existsSync(f.rscript) && !seen.has(f.home.toLowerCase()) && seen.add(f.home.toLowerCase()))
      .sort((a, b) => cmp(b.version, a.version));
  }

  /** The newest R, or the newest matching a requested version ("4.4" or "4.4.1"). */
  async require(version: string | null): Promise<RInstall> {
    const all = await this.list();
    const pick = version ? all.find((r) => r.version === version || r.version.startsWith(`${version}.`)) : all[0];
    if (pick) return pick;
    throw new StepError(version ? `R ${version} isn't installed on this computer.` : "R isn't installed on this computer.", {
      problem: {
        title: "R is needed",
        summary: version ? `This step asks for R ${version}. Installed: ${all.map((r) => r.version).join(", ") || "none"}.` : "This pipeline runs an R script, but R isn't installed.",
        checks: [{ label: "R installations found", status: all.length ? "ok" : "failed", detail: all.map((r) => r.version).join(", ") || "none" }],
        cause: "Install R from cran.r-project.org (Nexus finds it automatically), or choose an installed version for this step.",
      },
    });
  }
}

/** What an R script needs, found by reading it. */
export interface RRequirements {
  packages: string[];
  source: "library calls" | "renv.lock";
  /** renv.lock versions, when the project has one. */
  pinned: Record<string, string>;
  secrets: string[];
  databases: string[];
}

function stripRComments(src: string): string {
  // Remove strings' contents only for the # scan, keep them for package names in library("x").
  return src
    .split(/\r?\n/)
    .map((line) => {
      let inStr: string | null = null;
      for (let i = 0; i < line.length; i++) {
        const c = line[i]!;
        if (inStr) {
          if (c === "\\") i++;
          else if (c === inStr) inStr = null;
        } else if (c === '"' || c === "'") inStr = c;
        else if (c === "#") return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}

/** Packages used by library(), require(), requireNamespace(), pacman::p_load() and pkg::fn. */
export function rPackagesUsed(source: string): string[] {
  const code = stripRComments(source);
  const names = new Set<string>();
  const name = "([A-Za-z][A-Za-z0-9.]*[A-Za-z0-9]|[A-Za-z])";
  for (const m of code.matchAll(new RegExp(`\\b(?:library|require|requireNamespace|loadNamespace)\\(\\s*["']?${name}["']?`, "g"))) names.add(m[1]!);
  for (const m of code.matchAll(new RegExp(`\\b${name}:::?[A-Za-z._]`, "g"))) names.add(m[1]!);
  for (const m of code.matchAll(/\bp_load\(([^)]*)\)/g)) for (const p of m[1]!.split(",")) {
    const n = p.trim().replace(/^["']|["']$/g, "");
    if (/^[A-Za-z][A-Za-z0-9.]*$/.test(n) && !n.includes("=")) names.add(n);
  }
  names.delete("nexusR");
  return [...names].sort();
}

function literalCalls(source: string, fn: string): string[] {
  const re = new RegExp(`\\b${fn}\\(\\s*["']([^"'\\n]+)["']\\s*\\)`, "g");
  return [...new Set([...stripRComments(source).matchAll(re)].map((m) => m[1]!))];
}

/**
 * Reads an R script and works out which packages it needs. `builtin` are the packages that ship
 * with R itself (base and recommended), which are never installed.
 */
export function detectRRequirements(scriptPath: string, builtin: Set<string>, extraPackages: string[] = []): RRequirements {
  const source = readFileSync(scriptPath, "utf8");
  const lock = join(dirname(scriptPath), "renv.lock");
  const secrets = literalCalls(source, "nexus_secret");
  const databases = literalCalls(source, "nexus_database");
  if (existsSync(lock)) {
    const parsed = JSON.parse(readFileSync(lock, "utf8")) as { Packages?: Record<string, { Package: string; Version: string }> };
    const pinned = Object.fromEntries(Object.values(parsed.Packages ?? {}).map((p) => [p.Package, p.Version]));
    const packages = [...new Set([...Object.keys(pinned), ...extraPackages])].filter((p) => !builtin.has(p)).sort();
    return { packages, source: "renv.lock", pinned, secrets, databases };
  }
  const packages = [...new Set([...rPackagesUsed(source), ...extraPackages])].filter((p) => !builtin.has(p)).sort();
  return { packages, source: "library calls", pinned: {}, secrets, databases };
}

/** Turns R's error output into one plain sentence. */
export function explainRError(lines: string[]): string {
  const text = lines.join("\n");
  const missingPkg = text.match(/there is no package called ['‘"]([^'’"]+)['’"]/)?.[1];
  if (missingPkg) return `The script needs the R package "${missingPkg}", which isn't installed. Add it to this step's packages.`;
  const object = text.match(/object ['‘"]([^'’"]+)['’"] not found/)?.[1];
  if (object) return `The script refers to "${object}", which doesn't exist — the incoming data may not have a column called ${object}.`;
  const idx = lines.findIndex((l) => /^Error\b/.test(l));
  if (idx >= 0) {
    const msg = lines.slice(idx, idx + 3).join(" ").replace(/^Error(?: in [^:]+)?\s*:\s*/, "").replace(/\s+Calls:.*$/, "").replace(/\s+Execution halted.*$/, "").trim();
    return `The script stopped with an error: ${msg}`;
  }
  return "The script stopped with an error.";
}
