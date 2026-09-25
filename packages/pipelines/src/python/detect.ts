import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/** Import names whose PyPI package is called something else. */
export const IMPORT_TO_PACKAGE: Record<string, string> = {
  sklearn: "scikit-learn",
  cv2: "opencv-python",
  PIL: "Pillow",
  yaml: "PyYAML",
  bs4: "beautifulsoup4",
  dateutil: "python-dateutil",
  dotenv: "python-dotenv",
  psycopg2: "psycopg2-binary",
  psycopg: "psycopg[binary]",
  jwt: "PyJWT",
  docx: "python-docx",
  pptx: "python-pptx",
  Crypto: "pycryptodome",
  google: "google-api-python-client",
  jose: "python-jose",
  magic: "python-magic",
  sqlalchemy: "SQLAlchemy",
  skimage: "scikit-image",
  attr: "attrs",
  serial: "pyserial",
  usb: "pyusb",
  win32api: "pywin32",
  win32com: "pywin32",
  pyodbc: "pyodbc",
  duckdb: "duckdb",
  pymssql: "pymssql",
  MySQLdb: "mysqlclient",
  telegram: "python-telegram-bot",
  fitz: "PyMuPDF",
  Levenshtein: "python-Levenshtein",
  cudf: "cudf-cu12",
  cupy: "cupy-cuda12x",
};

/** What a Python script needs, found by reading it (never by running it). */
export interface PythonRequirements {
  /** e.g. ">=3.11" from inline metadata, or null. */
  requiresPython: string | null;
  /** Package specifiers to install, e.g. ["pandas", "requests>=2.31"]. */
  packages: string[];
  /** Where the list came from, for the user: "imports", "requirements.txt", "script metadata". */
  source: "imports" | "requirements.txt" | "script metadata";
  /** Top-level modules imported (before mapping), for display. */
  imports: string[];
  /** Secret names used literally: secret("shop_api"). */
  secrets: string[];
  /** Nexus database names used literally: database("TaxiOps"). */
  databases: string[];
}

const IMPORT_LINE = /^[ \t]*import[ \t]+([^#\n]+)/gm;
const FROM_LINE = /^[ \t]*from[ \t]+([A-Za-z_][\w.]*)[ \t]+import\b/gm;

/** Drops comments and the contents of strings so text inside them isn't mistaken for code. */
function stripStringsAndComments(src: string): string {
  return src
    .replace(/("""|''')[\s\S]*?\1/g, '""')
    .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""')
    .replace(/#[^\n]*/g, "");
}

export function importsOf(source: string): string[] {
  const code = stripStringsAndComments(source);
  const names = new Set<string>();
  for (const m of code.matchAll(IMPORT_LINE)) {
    for (const part of m[1]!.split(",")) {
      const name = part.trim().split(/\s+as\s+/)[0]!.split(".")[0]!.trim();
      if (/^[A-Za-z_]\w*$/.test(name)) names.add(name);
    }
  }
  for (const m of code.matchAll(FROM_LINE)) names.add(m[1]!.split(".")[0]!);
  return [...names];
}

/** PEP 723 inline script metadata: `# /// script` … `# ///`. */
export function scriptMetadata(source: string): { requiresPython: string | null; dependencies: string[] } | null {
  const m = source.match(/^# \/\/\/ script\s*$([\s\S]*?)^# \/\/\/\s*$/m);
  if (!m) return null;
  const toml = m[1]!
    .split(/\r?\n/)
    .map((l) => l.replace(/^#\s?/, ""))
    .join("\n");
  const requiresPython = toml.match(/requires-python\s*=\s*["']([^"']+)["']/)?.[1] ?? null;
  const deps = toml.match(/dependencies\s*=\s*\[([\s\S]*?)\]/)?.[1];
  const dependencies = deps ? [...deps.matchAll(/["']([^"']+)["']/g)].map((d) => d[1]!.trim()).filter(Boolean) : [];
  return { requiresPython, dependencies };
}

function requirementsFile(dir: string): string[] | null {
  const f = join(dir, "requirements.txt");
  if (!existsSync(f)) return null;
  return readFileSync(f, "utf8")
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, "").trim())
    .filter((l) => l && !l.startsWith("-"));
}

function literalCalls(source: string, fn: string): string[] {
  const re = new RegExp(`\\b${fn}\\(\\s*(?:name\\s*=\\s*)?["']([^"'\\n]+)["']\\s*\\)`, "g");
  return [...new Set([...source.matchAll(re)].map((m) => m[1]!))];
}

/**
 * Reads a script (and the local modules next to it that it imports) and works out which packages
 * it needs. `stdlib` is the interpreter's own list of standard modules.
 */
export function detectPythonRequirements(scriptPath: string, stdlib: Set<string>, extraPackages: string[] = []): PythonRequirements {
  const dir = dirname(scriptPath);
  const source = readFileSync(scriptPath, "utf8");
  const isLocal = (name: string) => existsSync(join(dir, `${name}.py`)) || (existsSync(join(dir, name)) && statSync(join(dir, name)).isDirectory() && existsSync(join(dir, name, "__init__.py")));

  // Follow local modules so their imports count too (one folder deep, no cycles).
  const imports = new Set<string>();
  const seen = new Set<string>();
  const queue = [source];
  let allSource = "";
  while (queue.length) {
    const src = queue.shift()!;
    allSource += `\n${src}`;
    for (const name of importsOf(src)) {
      if (isLocal(name)) {
        if (!seen.has(name) && existsSync(join(dir, `${name}.py`))) {
          seen.add(name);
          queue.push(readFileSync(join(dir, `${name}.py`), "utf8"));
        }
        continue;
      }
      imports.add(name);
    }
  }
  const external = [...imports].filter((n) => !stdlib.has(n) && n !== "nexus" && n !== "__future__").sort();

  const meta = scriptMetadata(source);
  const requirements = requirementsFile(dir);
  let packages: string[];
  let from: PythonRequirements["source"];
  if (meta?.dependencies.length) {
    packages = meta.dependencies;
    from = "script metadata";
  } else if (requirements) {
    packages = requirements;
    from = "requirements.txt";
  } else {
    packages = external.map((n) => IMPORT_TO_PACKAGE[n] ?? n);
    from = "imports";
  }
  const byName = new Map<string, string>();
  for (const p of [...packages, ...extraPackages]) byName.set(packageName(p), p);
  return {
    requiresPython: meta?.requiresPython ?? null,
    packages: [...byName.values()].sort((a, b) => packageName(a).localeCompare(packageName(b))),
    source: from,
    imports: external,
    secrets: literalCalls(allSource, "secret"),
    databases: literalCalls(allSource, "database"),
  };
}

/** "pandas>=2" → "pandas"; "psycopg[binary]" → "psycopg"; normalised as pip does. */
export function packageName(spec: string): string {
  return spec
    .split(/[<>=!~;\[ @]/)[0]!
    .trim()
    .toLowerCase()
    .replace(/[-_.]+/g, "-");
}
