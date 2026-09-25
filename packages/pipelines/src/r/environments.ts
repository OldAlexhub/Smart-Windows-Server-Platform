import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { StepError } from "../errors";
import { runProcess } from "../process";
import type { RInstall } from "./detect";

export interface RLibrary {
  key: string;
  dir: string;
  rVersion: string;
  /** Installed packages and exact versions (for reproducibility). */
  packages: Record<string, string>;
}

/** Packages the nexusR helper needs. */
export const R_HELPER_PACKAGES = ["jsonlite", "nanoparquet"];
const LIB_FILE = "nexus-library.json";
const rString = (s: string) => `"${s.replace(/\\/g, "/").replace(/"/g, '\\"')}"`;

/**
 * Isolated R package libraries for pipeline scripts: one per R version and package set, built once
 * and shared. Scripts see only this library plus the packages that ship with R.
 */
export class RLibraries {
  private readonly building = new Map<string, Promise<RLibrary>>();
  private readonly builtinCache = new Map<string, Set<string>>();

  constructor(
    private readonly root: string,
    private readonly helpersDir: string,
    /** CRAN mirror; the cloud mirror serves Windows binaries for current R versions. */
    private readonly repo = "https://cloud.r-project.org",
  ) {}

  /** Packages that come with R itself (base and recommended). */
  async builtin(r: RInstall): Promise<Set<string>> {
    const cached = this.builtinCache.get(r.home);
    if (cached) return cached;
    const res = await runProcess({ exe: r.rscript, args: ["--vanilla", "-e", 'cat(rownames(installed.packages(lib.loc = .Library, priority = c("base", "recommended"))), sep = "\\n")'], timeoutMs: 120_000 });
    if (res.code !== 0) throw new StepError("R couldn't be started.", { technical: res.tail.join("\n") });
    const set = new Set(res.tail.map((l) => l.trim()).filter(Boolean));
    this.builtinCache.set(r.home, set);
    return set;
  }

  keyFor(r: RInstall, packages: string[], pinned: Record<string, string>): string {
    const minor = r.version.split(".").slice(0, 2).join(".");
    return createHash("sha256")
      .update(JSON.stringify({ r: minor, packages: [...new Set([...R_HELPER_PACKAGES, ...packages])].sort(), pinned, helper: this.helperVersion() }))
      .digest("hex")
      .slice(0, 16);
  }

  private helperVersion(): string {
    const desc = readFileSync(join(this.helpersDir, "r", "nexusR", "DESCRIPTION"), "utf8");
    return desc.match(/^Version:\s*(.+)$/m)?.[1]?.trim() ?? "0";
  }

  ensure(r: RInstall, packages: string[], pinned: Record<string, string>, log: (m: string) => void, signal?: AbortSignal): Promise<RLibrary> {
    const key = this.keyFor(r, packages, pinned);
    const dir = join(this.root, key);
    if (existsSync(join(dir, LIB_FILE))) return Promise.resolve(JSON.parse(readFileSync(join(dir, LIB_FILE), "utf8")) as RLibrary);
    let job = this.building.get(key);
    if (!job) {
      job = this.build(key, dir, r, packages, pinned, log, signal).finally(() => this.building.delete(key));
      this.building.set(key, job);
    }
    return job;
  }

  private async build(key: string, dir: string, r: RInstall, packages: string[], pinned: Record<string, string>, log: (m: string) => void, signal?: AbortSignal): Promise<RLibrary> {
    rmSync(dir, { recursive: true, force: true });
    const lib = join(dir, "library");
    mkdirSync(lib, { recursive: true });
    const wanted = [...new Set([...R_HELPER_PACKAGES, ...packages])].sort();
    log(`Preparing an R ${r.version} package library with ${wanted.join(", ")}. This happens once; later runs reuse it.`);
    const pinnedPkgs = Object.keys(pinned);
    const script = [
      `lib <- ${rString(lib)}`,
      `.libPaths(c(lib, .Library))`,
      `options(repos = c(CRAN = ${rString(this.repo)}), warn = 1, timeout = 600)`,
      `bin <- if (.Platform$OS.type == "windows") "binary" else getOption("pkgType")`,
      `want <- c(${wanted.map(rString).join(", ")})`,
      pinnedPkgs.length
        ? // renv.lock: restore the exact versions with renv.
          `install.packages("renv", lib = lib, type = bin, quiet = TRUE); renv::restore(lockfile = ${rString(join(dirname(lib), "renv.lock"))}, library = lib, prompt = FALSE, clean = FALSE); want <- setdiff(want, rownames(installed.packages(lib.loc = lib)))`
        : "",
      `if (length(want)) install.packages(want, lib = lib, type = bin, dependencies = c("Depends", "Imports", "LinkingTo"), quiet = TRUE)`,
      `missing <- setdiff(c(${wanted.map(rString).join(", ")}), rownames(installed.packages(lib.loc = c(lib, .Library))))`,
      `if (length(missing)) { cat("NEXUS_MISSING:", paste(missing, collapse = ","), "\\n"); quit(status = 3) }`,
      `install.packages(${rString(join(this.helpersDir, "r", "nexusR"))}, lib = lib, repos = NULL, type = "source", quiet = TRUE)`,
      `ip <- installed.packages(lib.loc = lib)`,
      `cat("NEXUS_PACKAGES:", jsonlite::toJSON(as.list(setNames(ip[, "Version"], ip[, "Package"])), auto_unbox = TRUE), "\\n")`,
    ]
      .filter(Boolean)
      .join("\n");
    if (pinnedPkgs.length) writeFileSync(join(dir, "renv.lock"), JSON.stringify({ R: { Version: r.version, Repositories: [{ Name: "CRAN", URL: this.repo }] }, Packages: Object.fromEntries(Object.entries(pinned).map(([p, v]) => [p, { Package: p, Version: v, Source: "Repository", Repository: "CRAN" }])) }));
    const file = join(dir, "install.R");
    writeFileSync(file, script);
    const res = await runProcess({ exe: r.rscript, args: ["--vanilla", file], timeoutMs: 3_600_000, signal, env: { R_LIBS_USER: lib, R_LIBS_SITE: "" } });
    const text = res.tail.join("\n");
    if (res.code !== 0) {
      rmSync(dir, { recursive: true, force: true });
      const missing = text.match(/NEXUS_MISSING:\s*([^\n]+)/)?.[1]?.trim();
      if (/cannot open URL|Could not resolve host|unable to access index|InternetOpenUrl failed|Timeout was reached/i.test(text)) {
        throw new StepError("Nexus couldn't download R packages (no internet connection?).", { transient: true, technical: text });
      }
      if (missing) throw new StepError(`The R package${missing.includes(",") ? "s" : ""} ${missing.split(",").map((m) => `"${m}"`).join(", ")} couldn't be installed. Check the name${missing.includes(",") ? "s" : ""}; some packages aren't available for R ${r.version}.`, { technical: text });
      throw new StepError("Installing the R packages failed.", { technical: text });
    }
    const packagesJson = text.match(/NEXUS_PACKAGES:\s*(\{[^\n]*\})/)?.[1];
    const library: RLibrary = { key, dir: lib, rVersion: r.version, packages: packagesJson ? (JSON.parse(packagesJson) as Record<string, string>) : {} };
    writeFileSync(join(dir, LIB_FILE), JSON.stringify(library, null, 2));
    log(`R package library ready (${Object.keys(library.packages).length} packages).`);
    return library;
  }
}
