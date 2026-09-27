import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, type Dirent } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import type { ComponentAnalysis, ProjectAnalysis, CommandSpec } from "@nexus/detection";
import { newId, NexusError, silentLogger, type Logger } from "@nexus/shared";
import type { Migration, StateStore } from "@nexus/state";
import { buildIsolatedEnv, resolveCommand, runToCompletion, type RuntimeContext } from "@nexus/runtime";
import { PythonLocator } from "./python-runtime";
import { RRuntimeLocator } from "./r-runtime";

export const deploymentMigrations: Migration[] = [
  {
    id: "deployment/001_deployments",
    up: `CREATE TABLE deployments (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      version_label TEXT NOT NULL,
      source_dir TEXT NOT NULL,
      source_commit TEXT,
      status TEXT NOT NULL,
      release_dir TEXT NOT NULL,
      venv_dir TEXT,
      python_version TEXT,
      ran_migrations INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL,
      finished_at TEXT,
      activated_at TEXT,
      duration_ms INTEGER,
      UNIQUE (app_id, seq)
    );
    CREATE INDEX deployments_app ON deployments(app_id, seq);`,
  },
  {
    id: "deployment/002_r_runtime",
    up: `ALTER TABLE deployments ADD COLUMN r_script TEXT;
    ALTER TABLE deployments ADD COLUMN r_lib_dir TEXT;
    ALTER TABLE deployments ADD COLUMN r_version TEXT;`,
  },
];

export type DeploymentStatus = "building" | "ready" | "failed" | "active" | "superseded" | "pruned";

export interface DeploymentRecord {
  id: string;
  appId: string;
  seq: number;
  versionLabel: string;
  sourceDir: string;
  sourceCommit: string | null;
  status: DeploymentStatus;
  releaseDir: string;
  venvDir: string | null;
  pythonVersion: string | null;
  /** Rscript.exe and private package library of an R release. */
  rScript: string | null;
  rLibDir: string | null;
  rVersion: string | null;
  ranMigrations: boolean;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  activatedAt: string | null;
  durationMs: number | null;
}

export type StepStatus = "running" | "done" | "failed" | "skipped";
export type StepCallback = (key: string, status: StepStatus, detail?: string) => void;
export type LineCallback = (stream: "stdout" | "stderr" | "system", line: string) => void;

/** Never copied into a release: dependencies, VCS data, caches and real secrets. */
const EXCLUDE_DIRS = new Set(["node_modules", ".git", ".hg", ".svn", ".venv", "venv", "env", "__pycache__", ".next", ".nuxt", ".turbo", ".cache", ".pytest_cache", ".mypy_cache", "coverage", ".idea", ".vscode", ".Rproj.user", "rsconnect"]);
const EXCLUDE_FILE = /^\.env(\.(local|development|production|test))?(\.local)?$/i;
/** renv's installed packages: machine-specific, and Nexus installs its own library per release. */
const EXCLUDE_REL = /(^|\/)renv\/(library|staging|local|sandbox)(\/|$)/;

/**
 * Files in an app's folder changed after `since` — only those a new release would copy (the same
 * exclusions as a deploy), so "Update" only appears when redeploying would actually change something.
 */
export function sourceChangesSince(root: string, since: Date, maxFiles = 50_000): { changed: string[]; scanned: number; newestMs: number } {
  const changed: string[] = [];
  let scanned = 0;
  let newestMs = 0;
  const walk = (dir: string, rel: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (scanned >= maxFiles) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!EXCLUDE_DIRS.has(e.name) && !EXCLUDE_REL.test(r)) walk(join(dir, e.name), r);
      } else if (e.isFile() && !EXCLUDE_FILE.test(e.name)) {
        scanned++;
        try {
          const mtime = statSync(join(dir, e.name)).mtimeMs;
          if (mtime > since.getTime()) {
            changed.push(r);
            newestMs = Math.max(newestMs, mtime);
          }
        } catch {
          // removed while scanning
        }
      }
    }
  };
  walk(root, "");
  return { changed, scanned, newestMs };
}

export interface DeploymentManagerOptions {
  appsRoot: string;
  runtime: RuntimeContext;
  python?: PythonLocator;
  r?: RRuntimeLocator;
  logger?: Logger;
  /** Shared package caches so each app doesn't re-download the world. */
  cacheRoot?: string;
  keepReleases?: number;
  installTimeoutMs?: number;
}

export class DeploymentManager {
  private readonly python: PythonLocator;
  private readonly r: RRuntimeLocator;
  private readonly log: Logger;
  private readonly keep: number;

  constructor(
    private readonly store: StateStore,
    private readonly opts: DeploymentManagerOptions,
  ) {
    store.migrate(deploymentMigrations);
    this.python = opts.python ?? new PythonLocator();
    this.r = opts.r ?? new RRuntimeLocator();
    this.log = opts.logger ?? silentLogger;
    this.keep = opts.keepReleases ?? 5;
  }

  appDir(slug: string): string {
    return join(this.opts.appsRoot, slug);
  }

  homeDir(slug: string): string {
    return join(this.appDir(slug), "home");
  }

  /** Runtime context (node, venv, R library) for running a given release. */
  runtimeFor(d: DeploymentRecord): RuntimeContext {
    return {
      ...this.opts.runtime,
      ...(d.venvDir ? { venvDir: d.venvDir } : {}),
      ...(d.rScript && d.rLibDir ? { rscript: d.rScript, rLibDir: d.rLibDir } : {}),
    };
  }

  /**
   * Copies the project into a new immutable release folder, prepares its runtime,
   * installs dependencies and builds it. The source folder is never modified.
   */
  async prepareRelease(input: {
    appId: string;
    slug: string;
    analysis: ProjectAnalysis;
    onStep?: StepCallback;
    onLine?: LineCallback;
  }): Promise<DeploymentRecord> {
    const { appId, slug, analysis } = input;
    const onStep = input.onStep ?? (() => {});
    const onLine = input.onLine ?? (() => {});
    const started = Date.now();
    const seq = (this.store.get<{ n: number | null }>("SELECT MAX(seq) AS n FROM deployments WHERE app_id = ?", [appId])?.n ?? 0) + 1;
    const releaseDir = join(this.appDir(slug), "releases", String(seq));
    const id = newId();
    this.store.run(
      `INSERT INTO deployments (id, app_id, seq, version_label, source_dir, source_commit, status, release_dir, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'building', ?, ?)`,
      [id, appId, seq, versionLabel(analysis, seq), analysis.root, readGitCommit(analysis.root), releaseDir, new Date().toISOString()],
    );

    const fail = (step: string, message: string, tail: string[] = []): never => {
      onStep(step, "failed", message);
      this.store.run("UPDATE deployments SET status = 'failed', error = ?, finished_at = ?, duration_ms = ? WHERE id = ?", [
        message,
        new Date().toISOString(),
        Date.now() - started,
        id,
      ]);
      throw new NexusError("infrastructure", message, {
        problem: {
          title: `${analysis.name} could not be prepared`,
          summary: message,
          checks: [],
          technical: tail.slice(-25).join("\n"),
        },
      });
    };

    // 1. Copy
    onStep("copy", "running", "Copying application files");
    try {
      copyProject(analysis.root, releaseDir);
    } catch (e) {
      fail("copy", `Nexus could not copy the application files: ${(e as Error).message}`);
    }
    onStep("copy", "done");

    // 2. Runtime (Python venv or R package library)
    let venvDir: string | null = null;
    let pythonVersion: string | null = null;
    const pyComponent = analysis.components.find((c) => c.runtime === "python");
    const rComponent = analysis.components.find((c) => c.runtime === "r");
    const ctx: RuntimeContext = { ...this.opts.runtime };
    if (rComponent) {
      onStep("runtime", "running", "Preparing R");
      const r = await this.r.require(rComponent.runtimeVersion).catch((e) => {
        onStep("runtime", "failed", (e as Error).message);
        this.store.run("UPDATE deployments SET status = 'failed', error = ? WHERE id = ?", [(e as Error).message, id]);
        throw e;
      });
      const rLibDir = join(releaseDir, ".rlib");
      mkdirSync(rLibDir, { recursive: true });
      ctx.rscript = r.rscript;
      ctx.rLibDir = rLibDir;
      this.store.run("UPDATE deployments SET r_script = ?, r_lib_dir = ?, r_version = ? WHERE id = ?", [r.rscript, rLibDir, r.version, id]);
      const differs = rComponent.runtimeVersion && !r.version.startsWith(rComponent.runtimeVersion.split(".").slice(0, 2).join("."));
      if (differs) onLine("system", `This app was written for R ${rComponent.runtimeVersion}; R ${r.version} is the closest installed version.`);
      onStep("runtime", "done", `R ${r.version}`);
    } else if (pyComponent) {
      onStep("runtime", "running", "Preparing Python");
      const py = await this.python.require(pyComponent.runtimeVersion).catch((e) => {
        onStep("runtime", "failed", (e as Error).message);
        this.store.run("UPDATE deployments SET status = 'failed', error = ? WHERE id = ?", [(e as Error).message, id]);
        throw e;
      });
      venvDir = join(releaseDir, ".venv");
      const r = await runToCompletion({
        executable: py.executable,
        args: ["-m", "venv", venvDir],
        cwd: releaseDir,
        env: this.toolEnv(slug, []),
        onLine: onLine,
        timeoutMs: 180_000,
      });
      if (r.code !== 0) fail("runtime", "Nexus could not create a private Python environment for this application.", r.tail);
      pythonVersion = py.version;
      ctx.venvDir = venvDir;
      this.store.run("UPDATE deployments SET venv_dir = ?, python_version = ? WHERE id = ?", [venvDir, pythonVersion, id]);
      onStep("runtime", "done", `Python ${py.version}`);
    } else {
      onStep("runtime", "skipped");
    }

    // 3. Install dependencies, 4. Build
    for (const phase of ["install", "build"] as const) {
      const work = analysis.components.filter((c) => (phase === "install" ? c.install : c.build));
      if (work.length === 0) {
        onStep(phase, "skipped");
        continue;
      }
      onStep(phase, "running", phase === "install" ? "Installing components" : "Building");
      for (const c of work) {
        const spec = phaseCommand(c, phase);
        const cwd = c.path ? join(releaseDir, ...c.path.split("/")) : releaseDir;
        const resolved = resolveCommand(spec.command, spec.args, ctx);
        onLine("system", `> ${spec.command} ${spec.args.join(" ")}${c.path ? `  (in ${c.path})` : ""}`);
        const env = this.toolEnv(slug, resolved.pathDirs, { ...(spec.env ?? {}), ...resolved.env, ...phaseEnv(c, phase) });
        const r = await runToCompletion({
          executable: resolved.executable,
          args: resolved.args,
          cwd,
          env,
          onLine,
          timeoutMs: this.opts.installTimeoutMs ?? 20 * 60_000,
        });
        if (r.code !== 0) {
          fail(phase, phase === "install" ? explainInstallFailure(r.tail) : "The application's build step failed.", r.tail);
        }
        if (phase === "install" && c.extraPackages?.length) {
          const extra = resolveCommand("pip", ["install", ...c.extraPackages], ctx);
          const x = await runToCompletion({ executable: extra.executable, args: extra.args, cwd, env, onLine, timeoutMs: 600_000 });
          if (x.code !== 0) fail(phase, explainInstallFailure(x.tail), x.tail);
        }
      }
      onStep(phase, "done");
    }

    this.store.run("UPDATE deployments SET status = 'ready', finished_at = ?, duration_ms = ? WHERE id = ?", [
      new Date().toISOString(),
      Date.now() - started,
      id,
    ]);
    this.log.info("release prepared", { appId, seq, ms: Date.now() - started });
    return this.require(id);
  }

  /** Marks a release as the one running; the previous active release becomes a rollback target. */
  activate(id: string): DeploymentRecord {
    const d = this.require(id);
    if (!["ready", "superseded", "active"].includes(d.status)) throw NexusError.conflict("This version can't be started.");
    this.store.transaction(() => {
      this.store.run("UPDATE deployments SET status = 'superseded' WHERE app_id = ? AND status = 'active' AND id != ?", [d.appId, id]);
      this.store.run("UPDATE deployments SET status = 'active', activated_at = ? WHERE id = ?", [new Date().toISOString(), id]);
    });
    this.prune(d.appId);
    return this.require(id);
  }

  markMigrationsRan(id: string): void {
    this.store.run("UPDATE deployments SET ran_migrations = 1 WHERE id = ?", [id]);
  }

  get(id: string): DeploymentRecord | undefined {
    const r = this.store.get<Row>("SELECT * FROM deployments WHERE id = ?", [id]);
    return r ? toRecord(r) : undefined;
  }

  require(id: string): DeploymentRecord {
    const d = this.get(id);
    if (!d) throw NexusError.notFound("Deployment");
    return d;
  }

  history(appId: string): DeploymentRecord[] {
    return this.store.all<Row>("SELECT * FROM deployments WHERE app_id = ? ORDER BY seq DESC", [appId]).map(toRecord);
  }

  current(appId: string): DeploymentRecord | undefined {
    const r = this.store.get<Row>("SELECT * FROM deployments WHERE app_id = ? AND status = 'active'", [appId]);
    return r ? toRecord(r) : undefined;
  }

  /**
   * Whether rolling back to `targetId` is safe. Rolling back code is always possible while the
   * release is on disk, but if a newer release changed the database structure the old code may
   * not understand it — that needs the user's explicit confirmation (and possibly a DB restore).
   */
  rollbackCheck(targetId: string): { allowed: boolean; requiresConfirmation: boolean; reason: string | null } {
    const target = this.require(targetId);
    if (target.status === "active") return { allowed: false, requiresConfirmation: false, reason: "This version is already running." };
    if (!["superseded", "ready"].includes(target.status) || !existsSync(target.releaseDir)) {
      return { allowed: false, requiresConfirmation: false, reason: "This version is no longer available on this computer." };
    }
    const newerWithMigrations = this.store.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM deployments WHERE app_id = ? AND seq > ? AND ran_migrations = 1",
      [target.appId, target.seq],
    )!.n;
    if (newerWithMigrations > 0) {
      return {
        allowed: true,
        requiresConfirmation: true,
        reason: "A newer version changed the database structure. The older version may not work with it. Consider restoring the database backup from that time as well.",
      };
    }
    return { allowed: true, requiresConfirmation: false, reason: null };
  }

  /** Keeps the newest N releases on disk (never the active one). */
  prune(appId: string): number {
    const rows = this.history(appId).filter((d) => d.status !== "pruned");
    let removed = 0;
    for (const d of rows.slice(this.keep)) {
      if (d.status === "active") continue;
      rmSync(d.releaseDir, { recursive: true, force: true });
      this.store.run("UPDATE deployments SET status = 'pruned' WHERE id = ?", [d.id]);
      removed++;
    }
    return removed;
  }

  /** Environment for install/build tools: isolated, with shared caches and proxy settings. */
  private toolEnv(slug: string, pathDirs: string[], extra: Record<string, string> = {}): Record<string, string> {
    const cache = this.opts.cacheRoot ?? join(this.opts.appsRoot, ".cache");
    const passthrough: Record<string, string> = {};
    for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"]) {
      if (process.env[k]) passthrough[k] = process.env[k]!;
    }
    const env = buildIsolatedEnv({
      homeDir: this.homeDir(slug),
      pathDirs,
      port: 0,
      appEnv: {
        ...passthrough,
        npm_config_cache: join(cache, "npm"),
        npm_config_update_notifier: "false",
        PIP_CACHE_DIR: join(cache, "pip"),
        R_USER_CACHE_DIR: join(cache, "r"),
        PIP_DISABLE_PIP_VERSION_CHECK: "1",
        ...extra,
      },
    });
    delete env.PORT;
    delete env.HOST;
    return env;
  }
}

function phaseCommand(c: ComponentAnalysis, phase: "install" | "build"): CommandSpec {
  const spec = (phase === "install" ? c.install : c.build)!;
  // Builds need devDependencies even though apps run with NODE_ENV=production.
  if (phase === "install" && spec.command === "npm" && !spec.args.includes("--include=dev")) {
    return { ...spec, args: [...spec.args, "--include=dev"] };
  }
  return spec;
}

function phaseEnv(c: ComponentAnalysis, phase: "install" | "build"): Record<string, string> {
  if (phase === "install" && (c.packageManager === "yarn" || c.packageManager === "pnpm")) return { NODE_ENV: "development" };
  return {};
}

export function explainInstallFailure(tail: string[]): string {
  const text = tail.join("\n");
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|Temporary failure in name resolution|Failed to establish a new connection|NewConnectionError/i.test(text)) {
    return "Installing the application's components needs an internet connection, and none was available.";
  }
  if (/ENOSPC|No space left on device|not enough space/i.test(text)) return "The drive is full, so the application's components could not be installed.";
  if (/EINTEGRITY|lockfile.*(out of date|not in sync)|npm ci.*can only install/i.test(text)) {
    return "The application's package-lock.json doesn't match package.json. Update the lock file in the project, then deploy again.";
  }
  const rMissing = text.match(/NEXUS_MISSING:\s*([^\n]+)/)?.[1]?.trim();
  if (rMissing) {
    const many = rMissing.includes(",");
    return `The R package${many ? "s" : ""} ${rMissing.split(",").map((m) => `"${m}"`).join(", ")} couldn't be installed. ${many ? "They may" : "It may"} not be on CRAN for this version of R.`;
  }
  if (/cannot open URL|unable to access index|InternetOpenUrl failed/i.test(text)) {
    return "Installing the application's R packages needs an internet connection, and CRAN couldn't be reached.";
  }
  if (/Rtools is required|make: not found|compilation failed for package/i.test(text)) {
    return "An R package has to be compiled from source and Rtools isn't installed. Install Rtools from cran.r-project.org, or use package versions with Windows binaries.";
  }
  if (/No matching distribution found|Could not find a version that satisfies/i.test(text)) {
    return "One of the application's Python packages could not be found for this version of Python.";
  }
  if (/Microsoft Visual C\+\+ 14\.0 or greater is required|gyp ERR!/i.test(text)) {
    return "A component needs to be compiled and the required build tools are not installed.";
  }
  return "Installing the application's components failed.";
}

function copyProject(from: string, to: string): void {
  if (existsSync(to)) rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  cpSync(from, to, {
    recursive: true,
    filter: (src) => {
      const rel = relative(from, src);
      if (!rel) return true;
      const segs = rel.split(sep);
      if (segs.some((s) => EXCLUDE_DIRS.has(s)) || EXCLUDE_REL.test(segs.join("/"))) return false;
      return !EXCLUDE_FILE.test(basename(src));
    },
  });
}

function versionLabel(a: ProjectAnalysis, seq: number): string {
  for (const c of [{ path: "" }, ...a.components]) {
    try {
      const pkg = JSON.parse(readFileSync(join(a.root, c.path, "package.json"), "utf8")) as { version?: string };
      if (pkg.version && pkg.version !== "0.0.0" && pkg.version !== "1.0.0") return `v${pkg.version}`;
    } catch {
      /* none */
    }
  }
  try {
    const v = readFileSync(join(a.root, "pyproject.toml"), "utf8").match(/^\s*version\s*=\s*["']([^"']+)["']/m)?.[1];
    if (v) return `v${v}`;
  } catch {
    /* none */
  }
  return `Release ${seq}`;
}

export function readGitCommit(root: string): string | null {
  try {
    const head = readFileSync(join(root, ".git", "HEAD"), "utf8").trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head.slice(0, 7);
    const ref = head.match(/^ref:\s*(.+)$/)?.[1];
    if (!ref) return null;
    const refFile = join(root, ".git", ...ref.split("/"));
    if (existsSync(refFile)) return readFileSync(refFile, "utf8").trim().slice(0, 7);
    const packed = readFileSync(join(root, ".git", "packed-refs"), "utf8");
    const line = packed.split(/\r?\n/).find((l) => l.endsWith(` ${ref}`));
    return line ? line.slice(0, 7) : null;
  } catch {
    return null;
  }
}

interface Row {
  id: string;
  app_id: string;
  seq: number;
  version_label: string;
  source_dir: string;
  source_commit: string | null;
  status: DeploymentStatus;
  release_dir: string;
  venv_dir: string | null;
  python_version: string | null;
  r_script: string | null;
  r_lib_dir: string | null;
  r_version: string | null;
  ran_migrations: number;
  error: string | null;
  created_at: string;
  finished_at: string | null;
  activated_at: string | null;
  duration_ms: number | null;
}

function toRecord(r: Row): DeploymentRecord {
  return {
    id: r.id,
    appId: r.app_id,
    seq: r.seq,
    versionLabel: r.version_label,
    sourceDir: r.source_dir,
    sourceCommit: r.source_commit,
    status: r.status,
    releaseDir: r.release_dir,
    venvDir: r.venv_dir,
    pythonVersion: r.python_version,
    rScript: r.r_script ?? null,
    rLibDir: r.r_lib_dir ?? null,
    rVersion: r.r_version ?? null,
    ranMigrations: !!r.ran_migrations,
    error: r.error,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
    activatedAt: r.activated_at,
    durationMs: r.duration_ms,
  };
}
