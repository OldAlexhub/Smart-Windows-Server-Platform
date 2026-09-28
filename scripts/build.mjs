#!/usr/bin/env node
/**
 * Builds the complete Nexus installation and the NexusSetup.exe installer.
 *
 *   node scripts/build.mjs              # stage dist/app + build installer
 *   node scripts/build.mjs --no-installer
 *   node scripts/build.mjs --skip-portable # leave an in-use portable copy and its data untouched
 *
 * dist/app/ (installed to <Program Files>\Nexus Server\app):
 *   node/            node.exe + npm + corepack (runtime for Nexus and for Node applications)
 *   server/          main.mjs (bundled Core Service) + service-config.mjs
 *   ui/              control center (static files served by the service)
 *   components/      postgresql, ferretdb, duckdb-extensions, caddy, winsw (pinned in components.json)
 *   helpers/         python/nexus, r/nexusR — imported by pipeline scripts
 *   scripts/         service.mjs (register / upgrade / remove the Windows service)
 */
import { execFileSync, execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist", "app");
const args = process.argv.slice(2);
const step = (m) => console.log(`\n▸ ${m}`);
const npm = (a, cwd = root) => execSync(`npm ${a.join(" ")}`, { cwd, stdio: "inherit" });

// ---------------------------------------------------------------- brand
const brandSrc = readFileSync(join(root, "packages/shared/src/brand.ts"), "utf8");
const brand = (key) => brandSrc.match(new RegExp(`${key}:\\s*"([^"]+)"`))?.[1];
const productName = brand("productName");
const installerName = brand("installerName");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

step(`Building ${productName} ${version}`);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// ---------------------------------------------------------------- components
step("Components (PostgreSQL, FerretDB, DuckDB extensions, Caddy, WinSW)");
execFileSync(process.execPath, [join(root, "scripts/fetch-components.mjs")], { stdio: "inherit" });
const manifest = JSON.parse(readFileSync(join(root, "components.json"), "utf8"));
for (const [name, c] of Object.entries(manifest.components)) {
  const src = join(root, "vendor", name, c.version);
  if (!existsSync(join(src, ".complete"))) throw new Error(`Component ${name} ${c.version} is missing.`);
  cpSync(src, join(out, "components", name, c.version), { recursive: true });
}

// ---------------------------------------------------------------- UI
step("Control center UI");
npm(["run", "build", "-w", "@nexus/ui"]);
cpSync(join(root, "apps/ui/dist"), join(out, "ui"), { recursive: true, filter: (p) => !p.endsWith(".map") });

// ---------------------------------------------------------------- server
step("Core Service bundle");
const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: "linked",
  legalComments: "none",
  // ESM output still needs `require` for bundled CommonJS dependencies.
  banner: {
    js: `import { createRequire as __nexusCreateRequire } from "node:module"; const require = __nexusCreateRequire(import.meta.url);`,
  },
  // DuckDB ships a native binary (.node) that can't be bundled; it is copied next to the bundle below.
  external: ["pg-native", "@duckdb/*"],
  logLevel: "warning",
};
await build({ ...common, entryPoints: [join(root, "apps/server/src/main.ts")], outfile: join(out, "server/main.mjs") });
await build({
  ...common,
  entryPoints: [join(root, "apps/server/src/service/winsw.ts")],
  outfile: join(out, "server/service-config.mjs"),
  sourcemap: false,
});
// Helper libraries pipeline scripts import (Python "nexus", R "nexusR").
cpSync(join(root, "packages/pipelines/helpers"), join(out, "helpers"), { recursive: true, filter: (p) => !/__pycache__/.test(p) });
for (const pkg of readdirSync(join(root, "node_modules", "@duckdb"))) {
  if (pkg.startsWith("node-bindings-") && pkg !== `node-bindings-${process.platform}-${process.arch}`) continue;
  cpSync(join(root, "node_modules", "@duckdb", pkg), join(out, "server", "node_modules", "@duckdb", pkg), { recursive: true, dereference: true });
}
mkdirSync(join(out, "scripts"), { recursive: true });
cpSync(join(root, "scripts/service.mjs"), join(out, "scripts/service.mjs"));

// ---------------------------------------------------------------- node runtime
step("Node.js runtime");
const nodeDir = dirname(process.execPath);
mkdirSync(join(out, "node"), { recursive: true });
cpSync(process.execPath, join(out, "node", "node.exe"));
for (const tool of ["npm", "corepack"]) {
  const src = join(nodeDir, "node_modules", tool);
  if (existsSync(src)) cpSync(src, join(out, "node", "node_modules", tool), { recursive: true });
}
for (const f of ["LICENSE"]) if (existsSync(join(nodeDir, f))) cpSync(join(nodeDir, f), join(out, "node", f));

// ---------------------------------------------------------------- smoke test of the staged app
step("Smoke test of the staged installation");
const smoke = await import(pathToFileURL(join(out, "server/service-config.mjs")).href);
if (
  !smoke.renderWinswXml({ installDir: out, nodeExe: "x", entry: "y", home: "z", logDir: "w", port: 1 }).includes("<id>")
) {
  throw new Error("service-config.mjs is broken");
}
writeFileSync(join(out, "VERSION"), `${productName} ${version}\n`);

// ---------------------------------------------------------------- portable copy
// The same app folder plus start/stop scripts: runs from any folder or USB drive, nothing installed.
// A portable copy may itself be the running development server, so installer-only rebuilds can
// explicitly leave it (and the user data stored inside it) untouched.
if (!args.includes("--skip-portable")) {
  step("Portable copy");
  const portable = join(root, "dist", "NexusPortable");
  rmSync(portable, { recursive: true, force: true });
  cpSync(out, join(portable, "app"), { recursive: true });
  for (const f of readdirSync(join(root, "scripts", "portable"))) cpSync(join(root, "scripts", "portable", f), join(portable, f));
  cpSync(join(root, "HOW-TO-USE-NEXUS.md"), join(portable, "HOW-TO-USE-NEXUS.md"));
  const portableZip = join(root, "dist", "NexusPortable.zip");
  rmSync(portableZip, { force: true });
  // Windows' bsdtar writes zip archives with -a (format from the file extension).
  const tarExe = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  execFileSync(tarExe, ["-a", "-c", "-f", portableZip, "-C", join(root, "dist"), "NexusPortable"], { stdio: "inherit" });
  console.log(`  ${portableZip}`);
}

if (args.includes("--no-installer")) {
  console.log(`\n✔ Staged ${out}`);
  process.exit(0);
}

// ---------------------------------------------------------------- installer
step("Installer (NSIS)");
const confPath = join(root, "apps/desktop/src-tauri/tauri.conf.json");
const conf = JSON.parse(readFileSync(confPath, "utf8"));
conf.productName = productName;
conf.version = version;
conf.app.windows[0].title = productName;
writeFileSync(confPath, JSON.stringify(conf, null, 2) + "\n");

const tauriConf = JSON.stringify({
  bundle: {
    active: true,
    targets: ["nsis"],
    publisher: brand("publisher"),
    copyright: brand("copyright"),
    shortDescription: brand("tagline"),
    resources: { "../../../dist/app/": "app/" },
    windows: {
      nsis: {
        installMode: "perMachine",
        installerHooks: "installer-hooks.nsh",
        displayLanguageSelector: false,
        installerIcon: "icons/icon.ico",
      },
      webviewInstallMode: { type: "downloadBootstrapper", silent: true },
    },
  },
});
execFileSync(process.execPath, [join(root, "node_modules/@tauri-apps/cli/tauri.js"), "build", "--config", tauriConf], {
  cwd: join(root, "apps/desktop"),
  stdio: "inherit",
});

const bundleDir = join(root, "apps/desktop/src-tauri/target/release/bundle/nsis");
const built = readdirSync(bundleDir).find((f) => f.endsWith("-setup.exe"));
if (!built) throw new Error("The NSIS installer was not produced.");
mkdirSync(join(root, "dist"), { recursive: true });
const target = join(root, "dist", installerName);
rmSync(target, { force: true });
renameSync(join(bundleDir, built), target);
console.log(`\n✔ ${target}`);
