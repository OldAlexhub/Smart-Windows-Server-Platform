import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  "coverage",
  "venv",
  ".venv",
  "env",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".idea",
  ".vscode",
  "target",
  "vendor",
  ".turbo",
  ".cache",
]);

const TEXT_EXT = /\.(js|mjs|cjs|jsx|ts|tsx|mts|cts|py|json|toml|cfg|ini|txt|yml|yaml|env|example|sample|template|html|sql|prisma|md)$/i;
const MAX_FILES = 4000;
const MAX_FILE_BYTES = 512 * 1024;

/**
 * Read-only, bounded view of a project folder. Never follows into dependency or
 * build folders and caps how much it reads, so analysing a huge repo stays fast.
 */
export class ProjectSnapshot {
  readonly files: string[] = [];
  private readonly cache = new Map<string, string | null>();

  constructor(readonly root: string) {
    if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`Folder not found: ${root}`);
    this.walk(root, 0);
    this.files.sort();
  }

  get folderName(): string {
    return basename(this.root);
  }

  private walk(dir: string, depth: number): void {
    if (depth > 8 || this.files.length >= MAX_FILES) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (this.files.length >= MAX_FILES) return;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!IGNORED_DIRS.has(name) && !name.startsWith(".")) this.walk(full, depth + 1);
      } else if (st.isFile()) {
        this.files.push(relative(this.root, full).split(sep).join("/"));
      }
    }
  }

  has(rel: string): boolean {
    return this.files.includes(rel);
  }

  /** Text content of a file (relative, forward slashes), or null if missing/binary/too large. */
  read(rel: string): string | null {
    if (this.cache.has(rel)) return this.cache.get(rel)!;
    let content: string | null = null;
    const full = join(this.root, rel);
    try {
      const st = statSync(full);
      const base = rel.split("/").pop()!;
      const isText = TEXT_EXT.test(rel) || base.startsWith(".") || !base.includes(".");
      if (st.isFile() && st.size <= MAX_FILE_BYTES && isText) {
        content = readFileSync(full, "utf8");
      }
    } catch {
      content = null;
    }
    this.cache.set(rel, content);
    return content;
  }

  json<T = Record<string, unknown>>(rel: string): T | null {
    const text = this.read(rel);
    if (text === null) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  /** Files under `prefix` (a component folder), matching an optional regex. */
  list(prefix = "", pattern?: RegExp): string[] {
    const p = prefix ? `${prefix.replace(/\/$/, "")}/` : "";
    return this.files.filter((f) => f.startsWith(p) && (!pattern || pattern.test(f)));
  }

  /** Source files of a component, for code scanning. */
  sources(prefix = "", exts = /\.(js|mjs|cjs|jsx|ts|tsx|mts|cts|py)$/i): string[] {
    return this.list(prefix, exts).filter((f) => !/\.(test|spec)\.|(^|\/)(tests?|__tests__)\//.test(f));
  }
}

export const joinRel = (a: string, b: string): string => (a ? `${a.replace(/\/$/, "")}/${b}` : b);
