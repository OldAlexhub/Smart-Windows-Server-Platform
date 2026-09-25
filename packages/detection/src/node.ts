import type { CommandSpec, ComponentAnalysis } from "./types";
import { joinRel, type ProjectSnapshot } from "./snapshot";

interface PackageJson {
  name?: string;
  main?: string;
  type?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: { node?: string };
  workspaces?: unknown;
}

const BACKEND_FRAMEWORKS: [dep: string, name: string][] = [
  ["@nestjs/core", "NestJS"],
  ["fastify", "Fastify"],
  ["express", "Express"],
  ["koa", "Koa"],
  ["@hapi/hapi", "hapi"],
  ["hono", "Hono"],
];

const FULLSTACK_FRAMEWORKS: [dep: string, name: string][] = [
  ["next", "Next.js"],
  ["nuxt", "Nuxt"],
  ["@remix-run/node", "Remix"],
  ["@sveltejs/kit", "SvelteKit"],
];

const FRONTEND_FRAMEWORKS: [dep: string, name: string][] = [
  ["@angular/core", "Angular"],
  ["react", "React"],
  ["vue", "Vue"],
  ["svelte", "Svelte"],
  ["solid-js", "Solid"],
  ["preact", "Preact"],
];

/** Start scripts that launch a development server rather than a production app. */
const DEV_SERVER = /\b(react-scripts start|vite(\s|$)|vite dev|ng serve|vue-cli-service serve|webpack(-dev-server| serve)|parcel(\s|$)(?!build))/;
const ENTRY_CANDIDATES = [
  "server.js",
  "index.js",
  "app.js",
  "main.js",
  "server.mjs",
  "index.mjs",
  "src/server.js",
  "src/index.js",
  "src/app.js",
  "src/main.js",
  "dist/index.js",
  "dist/server.js",
  "dist/main.js",
  "bin/www",
];

export function readPackageJson(snap: ProjectSnapshot, path: string): PackageJson | null {
  return snap.json<PackageJson>(joinRel(path, "package.json"));
}

export function analyzeNodeComponent(snap: ProjectSnapshot, path: string): ComponentAnalysis | null {
  const pkg = readPackageJson(snap, path);
  if (!pkg) return null;
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const has = (d: string) => d in deps;
  const scripts = pkg.scripts ?? {};

  const packageManager = snap.has(joinRel(path, "pnpm-lock.yaml"))
    ? "pnpm"
    : snap.has(joinRel(path, "yarn.lock"))
      ? "yarn"
      : "npm";
  const hasLock = packageManager !== "npm" || snap.has(joinRel(path, "package-lock.json"));
  const install: CommandSpec =
    packageManager === "npm"
      ? { command: "npm", args: [hasLock ? "ci" : "install", "--no-audit", "--no-fund"] }
      : { command: packageManager, args: ["install", "--frozen-lockfile"] };
  const run = (script: string): CommandSpec =>
    packageManager === "npm" ? { command: "npm", args: ["run", script] } : { command: packageManager, args: ["run", script] };

  const typescript = has("typescript") || snap.has(joinRel(path, "tsconfig.json"));
  const language = typescript ? "typescript" : "javascript";
  const runtimeVersion = pkg.engines?.node ?? (snap.read(joinRel(path, ".nvmrc")) ?? snap.read(joinRel(path, ".node-version")))?.trim() ?? null;

  const fullstack = FULLSTACK_FRAMEWORKS.find(([d]) => has(d));
  const backend = BACKEND_FRAMEWORKS.find(([d]) => has(d));
  const frontend = FRONTEND_FRAMEWORKS.find(([d]) => has(d));

  const base = {
    path,
    runtime: "node" as const,
    language: language as ComponentAnalysis["language"],
    packageManager: packageManager as ComponentAnalysis["packageManager"],
    install,
    runtimeVersion,
    dependencies: Object.keys(pkg.dependencies ?? {}),
  };

  if (fullstack) {
    const [, name] = fullstack;
    const start: CommandSpec =
      scripts.start && !DEV_SERVER.test(scripts.start) ? run("start") : { command: "npx", args: [name === "Next.js" ? "next" : "nuxt", "start"] };
    return {
      ...base,
      role: "fullstack",
      framework: name,
      build: scripts.build ? run("build") : null,
      start,
      staticDir: null,
      entryFile: null,
    };
  }

  if (backend || (!frontend && (scripts.start || pkg.main))) {
    const { start, entryFile } = resolveBackendStart(snap, path, pkg, run);
    return {
      ...base,
      role: "backend",
      framework: backend ? backend[1] : "Node.js",
      build: scripts.build && typescript ? run("build") : null,
      start,
      staticDir: null,
      entryFile,
    };
  }

  if (frontend) {
    const isVite = has("vite");
    const isCra = has("react-scripts");
    const staticDir = isCra ? "build" : frontend[1] === "Angular" ? guessAngularOut(snap, path, pkg) : "dist";
    return {
      ...base,
      role: "frontend",
      framework: isVite && frontend[1] !== "React" ? `${frontend[1]} (Vite)` : frontend[1],
      build: scripts.build ? run("build") : null,
      start: null,
      staticDir: joinRel(path, staticDir),
      entryFile: null,
    };
  }

  return null;
}

function resolveBackendStart(
  snap: ProjectSnapshot,
  path: string,
  pkg: PackageJson,
  run: (s: string) => CommandSpec,
): { start: CommandSpec | null; entryFile: string | null } {
  const scripts = pkg.scripts ?? {};
  const start = scripts.start;
  if (start && !DEV_SERVER.test(start)) {
    // "nodemon server.js" is a dev convenience; production should run node directly.
    const nodemon = start.match(/^nodemon\s+([^\s&|;]+)$/);
    if (nodemon) return { start: { command: "node", args: [nodemon[1]!] }, entryFile: nodemon[1]! };
    const direct = start.match(/^node\s+([^\s&|;]+)$/);
    return { start: run("start"), entryFile: direct ? direct[1]! : null };
  }
  if (scripts.serve && !DEV_SERVER.test(scripts.serve)) return { start: run("serve"), entryFile: null };
  if (pkg.main && snap.has(joinRel(path, pkg.main))) return { start: { command: "node", args: [pkg.main] }, entryFile: pkg.main };
  const entry = ENTRY_CANDIDATES.find((c) => snap.has(joinRel(path, c)));
  if (entry) return { start: { command: "node", args: [entry] }, entryFile: entry };
  return { start: null, entryFile: null };
}

function guessAngularOut(snap: ProjectSnapshot, path: string, pkg: PackageJson): string {
  const cfg = snap.json<{ projects?: Record<string, { architect?: { build?: { options?: { outputPath?: string } } } }> }>(
    joinRel(path, "angular.json"),
  );
  const first = cfg?.projects ? Object.values(cfg.projects)[0] : undefined;
  return first?.architect?.build?.options?.outputPath ?? `dist/${pkg.name ?? ""}`;
}

/** A root package.json that only orchestrates sub-projects (workspaces / "cd client && ..."). */
export function isOrchestratorPackage(snap: ProjectSnapshot, path: string): boolean {
  const pkg = readPackageJson(snap, path);
  if (!pkg) return false;
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const hasFramework = [...BACKEND_FRAMEWORKS, ...FULLSTACK_FRAMEWORKS, ...FRONTEND_FRAMEWORKS].some(([d]) => d in deps);
  if (hasFramework) return false;
  const scriptText = Object.values(pkg.scripts ?? {}).join(" ");
  return !!pkg.workspaces || /\b(cd\s+|--prefix\s+|-w\s+|--workspace)/.test(scriptText) || !pkg.main;
}
