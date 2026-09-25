import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { NexusError } from "@nexus/shared";

export interface PythonInstall {
  version: string; // "3.12"
  executable: string;
}

/** Parses `py -0p` (both the modern "-V:3.12" and legacy "-3.12-64" formats). */
export function parsePyLauncherList(output: string): PythonInstall[] {
  const out: PythonInstall[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = line.match(/^\s*-(?:V:)?(\d+\.\d+)(?:-\d+)?\s*\*?\s+(.+?python[w]?\.exe)\s*$/i);
    if (m) out.push({ version: m[1]!, executable: m[2]!.trim() });
  }
  return out;
}

const cmp = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
};
const parts = (v: string) => v.split(".").map((x) => Number(x) || 0);

/** Minimal PEP 440 / Poetry specifier check for major.minor versions ("^3.12", ">=3.9,<3.13", "~=3.11", "3.12"). */
export function satisfies(version: string, spec: string | null): boolean {
  if (!spec) return true;
  const v = parts(version);
  return spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .every((clause) => {
      const m = clause.match(/^(\^|~=|~|>=|<=|==|!=|>|<)?\s*([\d.*]+)$/);
      if (!m) return true;
      const op = m[1] ?? "==";
      const target = m[2]!.replace(/\.\*$/, "");
      const t = parts(target);
      const vv = v.slice(0, Math.max(t.length, 2));
      switch (op) {
        case ">=":
          return cmp(vv, t) >= 0;
        case ">":
          return cmp(vv, t) > 0;
        case "<=":
          return cmp(vv, t) <= 0;
        case "<":
          return cmp(vv, t) < 0;
        case "!=":
          return cmp(vv.slice(0, t.length), t) !== 0;
        case "^":
          return cmp(vv, t) >= 0 && v[0] === t[0];
        case "~=":
        case "~":
          return cmp(vv, t) >= 0 && cmp(v.slice(0, Math.max(1, t.length - 1)), t.slice(0, Math.max(1, t.length - 1))) === 0;
        default:
          return cmp(v.slice(0, t.length), t) === 0;
      }
    });
}

/** Picks the newest installed Python that satisfies the requirement. */
export function choosePython(installs: PythonInstall[], requirement: string | null): PythonInstall | null {
  const ok = installs.filter((i) => satisfies(i.version, requirement));
  ok.sort((a, b) => cmp(parts(b.version), parts(a.version)));
  return ok[0] ?? null;
}

type Exec = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string }>;
const defaultExec: Exec = (cmd, args) =>
  new Promise((resolve) =>
    execFile(cmd, args, { windowsHide: true, timeout: 20_000 }, (err, stdout) =>
      resolve({ code: err ? 1 : 0, stdout: String(stdout ?? "") }),
    ),
  );

/**
 * Python installed for all users under Program Files (e.g. "Python313"). Only admin-protected
 * folders: the Nexus service runs as SYSTEM and must never run a program a normal account can change.
 */
export function machineWidePythons(programFiles = process.env.ProgramFiles ?? "C:\\Program Files"): PythonInstall[] {
  try {
    return readdirSync(programFiles)
      .map((d) => d.match(/^Python(\d)(\d{1,2})$/i))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m) => ({ version: `${m[1]}.${m[2]}`, executable: join(programFiles, m[0], "python.exe") }))
      .filter((p) => existsSync(p.executable));
  } catch {
    return [];
  }
}

/** Nexus's own Python, from the component folder name ("3.12.14+20260924" → 3.12). */
export function bundledPython(dir: string | null, componentVersion: string | null): PythonInstall[] {
  const m = componentVersion?.match(/^(\d+\.\d+)/);
  return dir && m ? [{ version: m[1]!, executable: join(dir, "python.exe") }] : [];
}

/** Finds Python interpreters on this computer (Nexus's own, Program Files, py launcher, PATH). */
export class PythonLocator {
  constructor(
    private readonly exec: Exec = defaultExec,
    private readonly bundled: PythonInstall[] = [],
    /** Ignore interpreters inside user profiles (set when running as the Windows service). */
    private readonly protectedOnly = false,
  ) {}

  async list(): Promise<PythonInstall[]> {
    const found = [...this.bundled.filter((b) => existsSync(b.executable)), ...machineWidePythons()];
    const py = await this.exec("py", ["-0p"]);
    // Under the service, only admin-protected interpreters (a per-user install is changeable by that user).
    if (py.code === 0) found.push(...parsePyLauncherList(py.stdout).filter((p) => !this.protectedOnly || !/\\Users\\/i.test(p.executable)));
    if (found.length === 0 && !this.protectedOnly) {
      const p = await this.exec("python", ["-c", "import sys;print('%d.%d' % sys.version_info[:2]);print(sys.executable)"]);
      const [version, executable] = p.stdout.trim().split(/\r?\n/);
      if (p.code === 0 && version && executable && !/WindowsApps/i.test(executable)) found.push({ version, executable });
    }
    const seen = new Set<string>();
    return found.filter((f) => !seen.has(f.executable.toLowerCase()) && seen.add(f.executable.toLowerCase()));
  }

  async require(requirement: string | null): Promise<PythonInstall> {
    const installs = await this.list();
    const chosen = choosePython(installs, requirement);
    if (chosen) return chosen;
    const wanted = requirement ? ` (${requirement})` : "";
    const have = installs.map((i) => i.version).join(", ");
    throw new NexusError("dependency_missing", installs.length ? `This application needs Python${wanted}, but only Python ${have} is available to Nexus.` : "Python isn't available to Nexus.", {
      problem: {
        title: "Python is needed",
        summary: installs.length
          ? `This application is written for Python${wanted}. Install that version for all users (python.org installer → Customize installation → "Install Python for all users"), then deploy again. Pythons installed only for your own account can't be used by the Nexus service.`
          : "Nexus normally includes its own Python. Reinstall Nexus to restore it, or install Python for all users from python.org, then deploy again.",
        checks: [
          {
            label: "Python installations found",
            status: installs.length ? "ok" : "failed",
            detail: installs.map((i) => i.version).join(", ") || "none",
          },
        ],
      },
    });
  }
}

export function suggestVersion(requirement: string | null): string {
  for (const v of ["3.13", "3.12", "3.11", "3.10"]) if (satisfies(v, requirement)) return v;
  return "3.12";
}
