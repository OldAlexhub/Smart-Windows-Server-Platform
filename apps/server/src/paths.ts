import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BRAND } from "@nexus/shared";

/** Where Nexus keeps its own state (not user data). */
export interface ServicePaths {
  root: string;
  stateDb: string;
  keyFile: string;
  /** Machine-local secret the desktop app uses to sign in without a password. */
  localTokenFile: string;
  logs: string;
  gateway: string;
  /** Folders containing bundled components: <root>/<name>/<version>/... */
  componentRoots: string[];
  /** Built control-center UI, if present. */
  uiDir: string | null;
  /** Helper libraries pipeline scripts import (python/nexus, r/nexusR). */
  helpersDir: string | null;
}

/** Where user data lives (chosen during first-run setup). */
export interface DataPaths {
  apps: string;
  database: string;
  files: string;
  backups: string;
  ai: string;
}

function repoRoot(): string | null {
  // In development the service runs from source: apps/server/src → repo root.
  let d = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(d, "components.json"))) return d;
    d = dirname(d);
  }
  return null;
}

export function resolveServicePaths(env: NodeJS.ProcessEnv = process.env): ServicePaths {
  const repo = repoRoot();
  const root =
    env.NEXUS_HOME ??
    (env.NODE_ENV === "production" || !repo
      ? join(env.ProgramData ?? "C:\\ProgramData", BRAND.dataFolderName)
      : join(repo, ".nexus-dev"));
  // Installed layout is <install>/node/node.exe, so the install dir is one level above node.exe.
  const exeDir = dirname(process.execPath);
  const installDir = env.NEXUS_INSTALL_DIR || (basename(exeDir).toLowerCase() === "node" ? dirname(exeDir) : exeDir);
  const componentRoots = [join(installDir, "components"), ...(repo ? [join(repo, "vendor")] : [])].filter((p) => existsSync(p));
  const uiCandidates = [env.NEXUS_UI_DIR, join(installDir, "ui"), repo ? join(repo, "apps", "ui", "dist") : undefined].filter(
    (p): p is string => !!p && existsSync(join(p, "index.html")),
  );
  const paths: ServicePaths = {
    root: resolve(root),
    stateDb: join(root, "state", "nexus.db"),
    keyFile: join(root, "keys", "master.key"),
    localTokenFile: join(root, "local-access.token"),
    logs: join(root, "logs"),
    gateway: join(root, "gateway"),
    componentRoots,
    uiDir: uiCandidates[0] ?? null,
    helpersDir: [join(installDir, "helpers"), ...(repo ? [join(repo, "packages", "pipelines", "helpers")] : [])].find((p) => existsSync(join(p, "python", "nexus"))) ?? null,
  };
  for (const d of [paths.root, dirname(paths.stateDb), dirname(paths.keyFile), paths.logs, paths.gateway]) mkdirSync(d, { recursive: true });
  return paths;
}

/** Newest installed version folder of a bundled component, e.g. componentDir(paths, "caddy") → …\caddy\2.11.4 */
export function componentDir(paths: ServicePaths, name: string): string | null {
  for (const root of paths.componentRoots) {
    const base = join(root, name);
    if (!existsSync(base)) continue;
    const versions = readdirSync(base).filter((v) => existsSync(join(base, v, ".complete")));
    versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    if (versions[0]) return join(base, versions[0]);
  }
  return null;
}
