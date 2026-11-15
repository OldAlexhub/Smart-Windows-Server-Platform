import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";

/** Extract the verified npm release, including its bundled dependency tree, into an empty directory. */
export function stageNpm(root, nodeDir, component) {
  const archive = join(root, "vendor", ".downloads", `npm-${component.version}.${component.archive}`);
  const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
  if (digest !== component.sha256) throw new Error("The bundled npm archive failed checksum verification.");
  const destination = join(nodeDir, "node_modules", "npm");
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  execFileSync(tar, ["-xf", archive, "-C", destination, "--strip-components", "1"], { stdio: "pipe", windowsHide: true });
  if (JSON.parse(readFileSync(join(destination, "package.json"), "utf8")).version !== component.version) {
    throw new Error("The bundled npm version does not match components.json.");
  }
}

/** Exercise package extraction and npm ci offline; --version alone never loads the failing install code. */
export function verifyNpm(nodeDir) {
  const node = join(nodeDir, process.platform === "win32" ? "node.exe" : "node");
  const cli = join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js");
  const fixture = mkdtempSync(join(tmpdir(), "nexus-npm-smoke-"));
  try {
    const pkg = join(fixture, "package"), project = join(fixture, "project");
    mkdirSync(pkg); mkdirSync(project);
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "nexus-install-check", version: "1.0.0", main: "index.js" }));
    writeFileSync(join(pkg, "index.js"), "module.exports = 'installed';\n");
    execFileSync(tar, ["-czf", join(fixture, "dependency.tgz"), "-C", fixture, "package"], { windowsHide: true });
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "nexus-npm-smoke", version: "1.0.0", private: true, dependencies: { "nexus-install-check": "file:../dependency.tgz" } }));
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^npm_config_|^NODE_OPTIONS$|^NODE_PATH$/i.test(key)) delete env[key];
    const config = join(fixture, "user.npmrc"), globalConfig = join(fixture, "global.npmrc");
    writeFileSync(config, ""); writeFileSync(globalConfig, "");
    const options = { cwd: project, env, encoding: "utf8", windowsHide: true, timeout: 60_000 };
    execFileSync(node, ["-e", "require(process.argv[1])", join(nodeDir, "node_modules", "npm", "lib", "commands", "ci.js")], options);
    const flags = ["--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", join(fixture, "cache"), "--userconfig", config, "--globalconfig", globalConfig];
    execFileSync(node, [cli, "install", "--package-lock-only", ...flags], options);
    execFileSync(node, [cli, "ci", "--include=dev", ...flags], options);
    const installed = join(project, "node_modules", "nexus-install-check", "index.js");
    if (!existsSync(installed) || readFileSync(installed, "utf8") !== "module.exports = 'installed';\n") throw new Error("Bundled npm ci did not install its test dependency.");
    console.log("  Bundled npm: offline lockfile generation, tarball extraction and npm ci passed.");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}
