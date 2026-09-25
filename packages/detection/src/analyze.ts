import { basename } from "node:path";
import { analyzeNodeComponent, isOrchestratorPackage, readPackageJson } from "./node";
import { analyzePythonComponent, parsePyproject } from "./python";
import { BUILTIN_SIGNAL_DETECTORS } from "./signals";
import { ProjectSnapshot, joinRel } from "./snapshot";
import type { ComponentAnalysis, ProjectAnalysis } from "./types";

export type ComponentAnalyzer = (snap: ProjectSnapshot, path: string) => ComponentAnalysis | null;

/** Signal detectors enrich an analysis (env vars, database, ports...). Registered in order. */
export type SignalDetector = (snap: ProjectSnapshot, analysis: ProjectAnalysis) => void;

const SUBFOLDER_CANDIDATES = ["server", "backend", "api", "client", "frontend", "web", "ui", "app", "site"];

const componentAnalyzers: ComponentAnalyzer[] = [analyzeNodeComponent, analyzePythonComponent, analyzeStaticComponent];
const signalDetectors: SignalDetector[] = [...BUILTIN_SIGNAL_DETECTORS];

/** Extension point: plugins can teach Nexus new frameworks and languages. */
export function registerComponentAnalyzer(a: ComponentAnalyzer, priority: "first" | "last" = "last"): void {
  // Static sites are the fallback and must stay last.
  const idx = componentAnalyzers.indexOf(analyzeStaticComponent);
  if (priority === "first") componentAnalyzers.unshift(a);
  else componentAnalyzers.splice(idx, 0, a);
}

export function registerSignalDetector(d: SignalDetector): void {
  signalDetectors.push(d);
}

function analyzeFolder(snap: ProjectSnapshot, path: string): ComponentAnalysis | null {
  for (const a of componentAnalyzers) {
    const c = a(snap, path);
    if (c) return c;
  }
  return null;
}

export function analyzeStaticComponent(snap: ProjectSnapshot, path: string): ComponentAnalysis | null {
  for (const dir of ["", "public", "www", "site"]) {
    const index = joinRel(joinRel(path, dir), "index.html");
    if (snap.has(index)) {
      return {
        role: "static",
        path,
        runtime: "static",
        language: "html",
        framework: "Static website",
        packageManager: null,
        install: null,
        build: null,
        start: null,
        staticDir: joinRel(path, dir),
        entryFile: "index.html",
        runtimeVersion: null,
        dependencies: [],
      };
    }
  }
  return null;
}

/** Inspects a project folder and describes it in terms Nexus can deploy. Read-only. */
export function analyzeProject(root: string): ProjectAnalysis {
  const snap = new ProjectSnapshot(root);
  const components: ComponentAnalysis[] = [];

  const rootComponent = analyzeFolder(snap, "");
  const subs: ComponentAnalysis[] = [];
  for (const dir of SUBFOLDER_CANDIDATES) {
    if (!snap.files.some((f) => f.startsWith(`${dir}/`))) continue;
    const c = analyzeFolder(snap, dir);
    if (c && c.role !== "static") subs.push(c);
  }

  if (rootComponent && !(subs.length > 0 && (rootComponent.role === "static" || isOrchestratorPackage(snap, "")))) {
    components.push(rootComponent);
  }
  // Only add sub-projects that complement the root (e.g. root backend + client/ frontend).
  for (const s of subs) {
    if (components.some((c) => c.role === s.role || c.role === "fullstack")) continue;
    components.push(s);
  }

  const pyproject = snap.read("pyproject.toml");
  const pkgName = readPackageJson(snap, "")?.name ?? (pyproject ? parsePyproject(pyproject).name : null);
  const analysis: ProjectAnalysis = {
    name: prettifyName(pkgName && !pkgName.startsWith("@") ? pkgName : basename(root)),
    root,
    runtime: primary(components)?.runtime ?? "static",
    summary: "",
    components,
    env: [],
    database: { required: false, kind: null, evidence: [], libraries: [], patterns: [] },
    storage: { required: false, evidence: [] },
    port: { value: null, envVar: null, evidence: null },
    healthPath: null,
    migrations: null,
    hasDockerfile: snap.files.some((f) => /(^|\/)Dockerfile$/.test(f)),
    externalAccessRecommended: components.length > 0,
    warnings: [],
  };

  if (components.length === 0) {
    analysis.warnings.push("Nexus couldn't recognise this project. Check that you chose the folder containing the application.");
  }
  const p = primary(components);
  if (p && (p.role === "backend" || p.role === "fullstack") && !p.start) {
    analysis.warnings.push("Nexus couldn't find how to start this application. You can set the start command in Advanced settings.");
  }

  for (const d of signalDetectors) d(snap, analysis);
  analysis.summary = summarize(analysis);
  return analysis;
}

/** The component that defines the app's runtime (backend first). */
export function primary(components: ComponentAnalysis[]): ComponentAnalysis | undefined {
  return (
    components.find((c) => c.role === "fullstack") ??
    components.find((c) => c.role === "backend") ??
    components.find((c) => c.role === "frontend") ??
    components[0]
  );
}

const RUNTIME_LABEL = { node: "Node.js", python: "Python", static: "" } as const;

export function describeComponent(c: ComponentAnalysis): string {
  const rt = RUNTIME_LABEL[c.runtime];
  switch (c.role) {
    case "backend":
      return c.framework === rt ? `${rt} backend` : `${rt} + ${c.framework} backend`;
    case "fullstack":
      return `${c.framework} application`;
    case "frontend":
      return `${c.framework} frontend`;
    case "static":
      return "Static website";
  }
}

function summarize(a: ProjectAnalysis): string {
  return a.components.map(describeComponent).join(", ") || "Unrecognised project";
}

function prettifyName(raw: string): string {
  const cleaned = raw.replace(/[-_]+/g, " ").trim();
  if (/[A-Z]/.test(cleaned)) return cleaned; // keep "TaxiOps" style names as the author wrote them
  return cleaned.replace(/\b\w/g, (c) => c.toUpperCase());
}
