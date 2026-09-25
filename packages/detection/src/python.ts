import type { CommandSpec, ComponentAnalysis } from "./types";
import { joinRel, type ProjectSnapshot } from "./snapshot";

// ------------------------------------------------------------------ dependency files

/** Normalises "Flask[async]>=3.0 ; python_version>'3.8'" → "flask". */
export function requirementName(line: string): string | null {
  const t = line.split("#")[0]!.trim();
  if (!t || t.startsWith("-") || t.startsWith("git+") || t.includes("://")) return null;
  const m = t.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
  return m ? m[1]!.toLowerCase().replace(/_/g, "-") : null;
}

export function parseRequirements(text: string): string[] {
  return [...new Set(text.split(/\r?\n/).map(requirementName).filter((x): x is string => !!x))];
}

/** Minimal pyproject reader: PEP 621 dependencies, Poetry dependencies, requires-python. */
export function parsePyproject(text: string): { dependencies: string[]; requiresPython: string | null; name: string | null } {
  const deps = new Set<string>();
  const arr = text.match(/^\s*dependencies\s*=\s*\[([\s\S]*?)\]/m);
  if (arr) {
    for (const m of arr[1]!.matchAll(/["']([^"']+)["']/g)) {
      const n = requirementName(m[1]!);
      if (n) deps.add(n);
    }
  }
  const poetry = text.match(/^\[tool\.poetry\.dependencies\]\s*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m);
  if (poetry) {
    for (const line of poetry[1]!.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/);
      if (m && m[1]!.toLowerCase() !== "python") deps.add(m[1]!.toLowerCase().replace(/_/g, "-"));
    }
  }
  const rp = text.match(/^\s*requires-python\s*=\s*["']([^"']+)["']/m);
  const poetryPy = poetry?.[1]!.match(/^\s*python\s*=\s*["']([^"']+)["']/m);
  const name = text.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
  return { dependencies: [...deps], requiresPython: rp?.[1] ?? poetryPy?.[1] ?? null, name: name?.[1] ?? null };
}

/** Pipfile [packages] section. */
export function parsePipfile(text: string): string[] {
  const sec = text.match(/^\[packages\]\s*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m);
  if (!sec) return [];
  return sec[1]!
    .split(/\r?\n/)
    .map((l) => l.match(/^\s*["']?([A-Za-z0-9][A-Za-z0-9._-]*)["']?\s*=/)?.[1]?.toLowerCase() ?? null)
    .filter((x): x is string => !!x);
}

// ------------------------------------------------------------------ app object discovery

interface AppObject {
  file: string;
  module: string;
  attr: string;
  factory: boolean;
  pythonPath: string | null;
}

/** "src/app/main.py" (component "") → module "app.main", PYTHONPATH "src" when src-layout has no package. */
function moduleFor(snap: ProjectSnapshot, componentPath: string, file: string): { module: string; pythonPath: string | null } {
  let rel = componentPath ? file.slice(componentPath.length + 1) : file;
  let pythonPath: string | null = null;
  if (rel.startsWith("src/") && !snap.has(joinRel(componentPath, "src/__init__.py"))) {
    rel = rel.slice(4);
    pythonPath = "src";
  }
  return { module: rel.replace(/\.py$/, "").replace(/\/__init__$/, "").split("/").join("."), pythonPath };
}

function findAppObject(snap: ProjectSnapshot, path: string, ctor: RegExp, factoryName: RegExp): AppObject | null {
  const files = snap.sources(path, /\.py$/i).sort((a, b) => rankPyFile(a) - rankPyFile(b));
  for (const file of files) {
    const text = snap.read(file);
    if (!text) continue;
    const m = text.match(new RegExp(`^(\\w+)\\s*(?::\\s*\\w+\\s*)?=\\s*${ctor.source}`, "m"));
    if (m) return { file, attr: m[1]!, factory: false, ...moduleFor(snap, path, file) };
  }
  for (const file of files) {
    const text = snap.read(file);
    const m = text?.match(new RegExp(`^def\\s+(${factoryName.source})\\s*\\(`, "m"));
    if (m) return { file, attr: m[1]!, factory: true, ...moduleFor(snap, path, file) };
  }
  return null;
}

const PREFERRED = ["main.py", "app.py", "server.py", "wsgi.py", "asgi.py", "api.py", "run.py", "__init__.py"];
function rankPyFile(f: string): number {
  const base = f.split("/").pop()!;
  const i = PREFERRED.indexOf(base);
  return (i < 0 ? 50 : i) + f.split("/").length * 10;
}

// ------------------------------------------------------------------ analyzer

export function analyzePythonComponent(snap: ProjectSnapshot, path: string): ComponentAnalysis | null {
  const req = snap.read(joinRel(path, "requirements.txt"));
  const pyproject = snap.read(joinRel(path, "pyproject.toml"));
  const pipfile = snap.read(joinRel(path, "Pipfile"));
  const managePy = snap.has(joinRel(path, "manage.py"));
  const pySources = snap.sources(path, /\.py$/i);
  if (req === null && pyproject === null && pipfile === null && !managePy && pySources.length === 0) return null;
  // A folder with a stray .py next to a package.json is a Node project.
  if (req === null && pyproject === null && pipfile === null && !managePy && snap.has(joinRel(path, "package.json"))) return null;

  const pp = pyproject ? parsePyproject(pyproject) : null;
  const dependencies = [
    ...new Set([...(req ? parseRequirements(req) : []), ...(pp?.dependencies ?? []), ...(pipfile ? parsePipfile(pipfile) : [])]),
  ];
  const has = (d: string) => dependencies.includes(d);

  const packageManager: ComponentAnalysis["packageManager"] = snap.has(joinRel(path, "poetry.lock"))
    ? "poetry"
    : snap.has(joinRel(path, "uv.lock"))
      ? "uv"
      : pipfile !== null && req === null
        ? "pipenv"
        : "pip";

  let install: CommandSpec | null = null;
  if (req !== null) install = { command: "pip", args: ["install", "-r", "requirements.txt"] };
  else if (pyproject !== null && /\[build-system\]|\[tool\.poetry\]|\[project\]/.test(pyproject)) install = { command: "pip", args: ["install", "."] };
  else if (dependencies.length) install = { command: "pip", args: ["install", ...dependencies] };

  const runtimeVersion =
    pp?.requiresPython ??
    snap.read(joinRel(path, ".python-version"))?.trim() ??
    snap.read(joinRel(path, "runtime.txt"))?.trim().replace(/^python-/, "") ??
    null;

  const base = {
    path,
    runtime: "python" as const,
    language: "python" as const,
    packageManager,
    install,
    build: null,
    staticDir: null,
    runtimeVersion,
    dependencies,
  };
  const listen = ["--host", "127.0.0.1", "--port", "{PORT}"];
  const withPath = (spec: CommandSpec, pythonPath: string | null): CommandSpec =>
    pythonPath ? { ...spec, env: { PYTHONPATH: pythonPath } } : spec;

  // Django
  if (managePy || has("django")) {
    const manage = snap.read(joinRel(path, "manage.py")) ?? "";
    const settings = manage.match(/DJANGO_SETTINGS_MODULE["']\s*,\s*["']([\w.]+)["']/)?.[1] ?? null;
    const project = settings?.split(".")[0] ?? null;
    const asgi = has("channels") || has("daphne");
    const target = project ? `${project}.${asgi ? "asgi" : "wsgi"}:application` : null;
    return {
      ...base,
      role: "backend",
      framework: "Django",
      start: target
        ? asgi
          ? { command: "python", args: ["-m", "uvicorn", target, ...listen] }
          : { command: "python", args: ["-m", "waitress", "--listen=127.0.0.1:{PORT}", target] }
        : null,
      entryFile: "manage.py",
      extraPackages: asgi ? (has("uvicorn") ? [] : ["uvicorn"]) : has("waitress") ? [] : ["waitress"],
    };
  }

  // FastAPI / Starlette / Quart (ASGI) → uvicorn
  const asgiFw = has("fastapi") ? "FastAPI" : has("starlette") ? "Starlette" : has("quart") ? "Quart" : null;
  if (asgiFw) {
    const ctor = asgiFw === "FastAPI" ? /FastAPI\(/ : asgiFw === "Starlette" ? /Starlette\(/ : /Quart\(/;
    const obj = findAppObject(snap, path, ctor, /create_app|get_app|build_app/);
    return {
      ...base,
      role: "backend",
      framework: asgiFw,
      start: obj
        ? withPath({ command: "python", args: ["-m", "uvicorn", `${obj.module}:${obj.attr}`, ...(obj.factory ? ["--factory"] : []), ...listen] }, obj.pythonPath)
        : null,
      entryFile: obj?.file ?? null,
      extraPackages: has("uvicorn") ? [] : ["uvicorn"],
    };
  }

  // Flask (WSGI) → waitress (gunicorn does not run on Windows)
  if (has("flask")) {
    const obj = findAppObject(snap, path, /Flask\(/, /create_app|make_app/);
    return {
      ...base,
      role: "backend",
      framework: "Flask",
      start: obj
        ? withPath(
            {
              command: "python",
              args: ["-m", "waitress", "--listen=127.0.0.1:{PORT}", ...(obj.factory ? ["--call"] : []), `${obj.module}:${obj.attr}`],
            },
            obj.pythonPath,
          )
        : null,
      entryFile: obj?.file ?? null,
      extraPackages: has("waitress") ? [] : ["waitress"],
    };
  }

  // Plain Python script / service
  const main = ["main.py", "app.py", "server.py", "run.py"].map((f) => joinRel(path, f)).find((f) => snap.has(f));
  if (main) {
    return {
      ...base,
      role: "backend",
      framework: "Python",
      start: { command: "python", args: [path ? main.slice(path.length + 1) : main] },
      entryFile: main,
    };
  }
  return null;
}
