import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StepError } from "../errors";
import { runProcess } from "../process";
import { packageName } from "./detect";

export interface PythonInstall {
  version: string;
  executable: string;
}

/** How Nexus finds Python interpreters (the deployment package's PythonLocator fits). */
export interface PythonFinder {
  require(requirement: string | null): Promise<PythonInstall>;
}

export interface PythonEnvironment {
  key: string;
  dir: string;
  python: string;
  /** Full interpreter version, e.g. "3.12.2". */
  version: string;
  /** Installed packages and their exact versions (for reproducibility). */
  packages: Record<string, string>;
}

/** Always installed: the nexus helper reads and writes Parquet through pyarrow and returns pandas DataFrames. */
export const HELPER_PACKAGES = ["pandas", "pyarrow"];

const ENV_FILE = "nexus-env.json";

/**
 * Managed virtual environments for pipeline scripts. Each unique combination of Python version and
 * packages gets one environment, built once and shared by every script that needs the same thing.
 */
export class PythonEnvironments {
  private readonly building = new Map<string, Promise<PythonEnvironment>>();
  private readonly stdlibCache = new Map<string, Set<string>>();

  constructor(
    private readonly root: string,
    readonly finder: PythonFinder,
  ) {}

  /** The interpreter's own list of standard-library modules (so they are never "installed"). */
  async stdlib(executable: string): Promise<Set<string>> {
    const cached = this.stdlibCache.get(executable);
    if (cached) return cached;
    const r = await runProcess({ exe: executable, args: ["-c", "import sys, json; print(json.dumps(sorted(set(sys.stdlib_module_names) | set(sys.builtin_module_names))))"], timeoutMs: 60_000 });
    if (r.code !== 0) throw new StepError("Python couldn't be started.", { technical: r.tail.join("\n") });
    const set = new Set<string>(JSON.parse(r.tail.at(-1)!));
    this.stdlibCache.set(executable, set);
    return set;
  }

  /** Packages to install: the script's own, plus the helper's (the script's version choice wins). */
  static plan(packages: string[]): string[] {
    const byName = new Map(HELPER_PACKAGES.map((p) => [packageName(p), p]));
    for (const p of packages) byName.set(packageName(p), p);
    return [...byName.values()].sort((a, b) => packageName(a).localeCompare(packageName(b)));
  }

  keyFor(install: PythonInstall, packages: string[]): string {
    return createHash("sha256")
      .update(JSON.stringify({ python: install.version, packages: PythonEnvironments.plan(packages) }))
      .digest("hex")
      .slice(0, 16);
  }

  /** Returns a ready environment, creating it (once) if needed. */
  ensure(install: PythonInstall, packages: string[], log: (message: string) => void, signal?: AbortSignal): Promise<PythonEnvironment> {
    const key = this.keyFor(install, packages);
    const dir = join(this.root, key);
    if (existsSync(join(dir, ENV_FILE))) return Promise.resolve(JSON.parse(readFileSync(join(dir, ENV_FILE), "utf8")) as PythonEnvironment);
    let job = this.building.get(key);
    if (!job) {
      job = this.build(key, dir, install, PythonEnvironments.plan(packages), log, signal).finally(() => this.building.delete(key));
      this.building.set(key, job);
    }
    return job;
  }

  private async build(key: string, dir: string, install: PythonInstall, packages: string[], log: (message: string) => void, signal?: AbortSignal): Promise<PythonEnvironment> {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(this.root, { recursive: true });
    log(`Creating a Python ${install.version} environment with ${packages.join(", ")}. This happens once; later runs reuse it.`);
    const venv = await runProcess({ exe: install.executable, args: ["-m", "venv", dir], timeoutMs: 300_000, signal });
    if (venv.code !== 0) throw new StepError("Nexus couldn't create the Python environment.", { technical: venv.tail.join("\n") });
    const python = join(dir, "Scripts", "python.exe");
    const pip = await runProcess({
      exe: python,
      args: ["-m", "pip", "install", "--disable-pip-version-check", "--no-input", "--progress-bar", "off", ...packages],
      timeoutMs: 3_600_000,
      signal,
      env: { PIP_NO_INPUT: "1" },
    });
    if (pip.code !== 0) {
      rmSync(dir, { recursive: true, force: true });
      const text = pip.tail.join("\n");
      const missing = text.match(/No matching distribution found for ([^\s]+)/)?.[1];
      if (missing) throw new StepError(`The Python package "${missing}" couldn't be found. Check its name in this step's packages (some packages are published under a different name than the one you import).`, { technical: text });
      if (/Failed to establish a new connection|Temporary failure in name resolution|getaddrinfo failed|Read timed out|ConnectionResetError|ProxyError/i.test(text)) {
        throw new StepError("Nexus couldn't download Python packages (no internet connection?).", { transient: true, technical: text });
      }
      throw new StepError("Installing the Python packages failed.", { technical: text });
    }
    const [versionRun, listRun] = await Promise.all([
      runProcess({ exe: python, args: ["-c", "import platform; print(platform.python_version())"], timeoutMs: 60_000 }),
      runProcess({ exe: python, args: ["-m", "pip", "list", "--format=json", "--disable-pip-version-check"], timeoutMs: 120_000 }),
    ]);
    const list = JSON.parse(listRun.tail.join("\n") || "[]") as { name: string; version: string }[];
    const env: PythonEnvironment = {
      key,
      dir,
      python,
      version: versionRun.tail.at(-1)?.trim() || install.version,
      packages: Object.fromEntries(list.filter((p) => !["pip", "setuptools", "wheel"].includes(p.name.toLowerCase())).map((p) => [p.name, p.version])),
    };
    writeFileSync(join(dir, ENV_FILE), JSON.stringify(env, null, 2));
    log(`Python environment ready (${Object.keys(env.packages).length} packages).`);
    return env;
  }
}
