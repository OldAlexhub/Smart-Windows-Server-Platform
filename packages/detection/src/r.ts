import type { CommandSpec, ComponentAnalysis } from "./types";
import { joinRel, type ProjectSnapshot } from "./snapshot";

/** Removes # comments (outside strings) so commented-out library() calls don't count. */
function withoutComments(src: string): string {
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

/** Masks quoted text while preserving offsets, so `::` inside data such as XPath isn't R syntax. */
function withoutStrings(src: string): string {
  const chars = [...src];
  let quote: string | null = null;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (!quote) {
      if (c === '"' || c === "'") {
        quote = c;
        chars[i] = " ";
      }
    } else if (c === "\\") {
      chars[i] = " ";
      if (i + 1 < chars.length && chars[i + 1] !== "\n") chars[++i] = " ";
    } else if (c === quote) {
      quote = null;
      chars[i] = " ";
    } else if (c !== "\n") {
      chars[i] = " ";
    }
  }
  return chars.join("");
}

/** Packages used by library(), require(), requireNamespace(), pacman::p_load() and pkg::fn. */
export function rPackagesInSource(source: string): string[] {
  const code = withoutComments(source);
  const executableCode = withoutStrings(code);
  const names = new Set<string>();
  const name = "([A-Za-z][A-Za-z0-9.]*[A-Za-z0-9]|[A-Za-z])";
  for (const m of code.matchAll(new RegExp(`\\b(?:library|require|requireNamespace|loadNamespace)\\(\\s*["']?${name}["']?`, "g"))) names.add(m[1]!);
  for (const m of executableCode.matchAll(new RegExp(`\\b${name}:::?[A-Za-z._]`, "g"))) names.add(m[1]!);
  for (const m of code.matchAll(/\bp_load\(([^)]*)\)/g)) {
    for (const p of m[1]!.split(",")) {
      const n = p.trim().replace(/^["']|["']$/g, "");
      if (/^[A-Za-z][A-Za-z0-9.]*$/.test(n)) names.add(n);
    }
  }
  return [...names].sort();
}

/** renv.lock: the R version and the exact package versions the author used. */
export function parseRenvLock(text: string): { rVersion: string | null; packages: Record<string, string> } | null {
  try {
    const lock = JSON.parse(text) as { R?: { Version?: string }; Packages?: Record<string, { Package?: string; Version?: string }> };
    const packages: Record<string, string> = {};
    for (const [key, p] of Object.entries(lock.Packages ?? {})) if (p.Version) packages[p.Package ?? key] = p.Version;
    return { rVersion: lock.R?.Version ?? null, packages };
  } catch {
    return null;
  }
}

/** Files that make a folder a Shiny app, in the order `shiny::runApp()` looks for them. */
const findCaseless = (snap: ProjectSnapshot, path: string, name: string): string | null => {
  const want = joinRel(path, name).toLowerCase();
  return snap.files.find((f) => f.toLowerCase() === want) ?? null;
};

/**
 * R Shiny applications: an app.R (or ui.R + server.R) folder. Nexus installs the packages the
 * code uses into a private library and runs `shiny::runApp()` on the port it assigns.
 */
export function analyzeRComponent(snap: ProjectSnapshot, path: string): ComponentAnalysis | null {
  const appR = findCaseless(snap, path, "app.R");
  const uiR = findCaseless(snap, path, "ui.R");
  const serverR = findCaseless(snap, path, "server.R");
  if (!appR && !(uiR && serverR)) return null;

  const lockText = snap.read(joinRel(path, "renv.lock"));
  const lock = lockText ? parseRenvLock(lockText) : null;
  const used = new Set<string>(["shiny"]);
  for (const f of snap.list(path, /\.(r|rmd)$/i)) for (const p of rPackagesInSource(snap.read(f) ?? "")) used.add(p);
  const dependencies = [...new Set([...used, ...Object.keys(lock?.packages ?? {})])].sort();

  // `r-packages` is resolved by the runtime into an Rscript call against the release's own library.
  const wanted = [...used].sort();
  const install: CommandSpec = lock ? { command: "r-packages", args: ["restore", "renv.lock", ...wanted] } : { command: "r-packages", args: ["install", ...wanted] };

  return {
    role: "fullstack",
    path,
    runtime: "r",
    language: "r",
    framework: "Shiny",
    packageManager: lock ? "renv" : "cran",
    install,
    build: null,
    start: { command: "Rscript", args: ["-e", "shiny::runApp('.', host = '127.0.0.1', port = {PORT}L, launch.browser = FALSE)"] },
    staticDir: null,
    entryFile: appR ?? serverR,
    runtimeVersion: lock?.rVersion ?? null,
    dependencies,
  };
}
