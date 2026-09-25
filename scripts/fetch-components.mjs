#!/usr/bin/env node
/**
 * Downloads the third-party components listed in components.json into vendor/<name>/<version>/.
 * Used for development and by the installer build. Verifies sha256 when pinned; prints the
 * hash when not yet pinned so it can be recorded.
 *
 *   node scripts/fetch-components.mjs            # all components
 *   node scripts/fetch-components.mjs postgresql # one component
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "components.json"), "utf8"));
const only = process.argv[2];

async function sha256(file) {
  const h = createHash("sha256");
  await pipeline(createReadStream(file), h);
  return h.digest("hex");
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download failed: ${res.status} ${url}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  let got = 0;
  let lastPct = -1;
  const body = Readable.fromWeb(res.body);
  body.on("data", (c) => {
    got += c.length;
    const pct = total ? Math.floor((got / total) * 100) : -1;
    if (pct !== lastPct && pct % 10 === 0) {
      lastPct = pct;
      process.stdout.write(`  ${pct}% (${Math.round(got / 1e6)} MB)\n`);
    }
  });
  await pipeline(body, createWriteStream(dest));
}

for (const [name, c] of Object.entries(manifest.components)) {
  if (only && only !== name) continue;
  const target = join(root, "vendor", name, c.version);
  if (existsSync(join(target, ".complete"))) {
    console.log(`${name} ${c.version}: already present`);
    continue;
  }
  mkdirSync(join(root, "vendor", ".downloads"), { recursive: true });
  if (c.build) {
    await buildFromSource(name, c, target);
    continue;
  }
  if (c.files) {
    // Several single files (e.g. DuckDB extensions), each gzip-compressed and pinned by sha256.
    const staging = `${target}.staging`;
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    for (const file of c.files) {
      const dl = join(root, "vendor", ".downloads", `${name}-${c.version}-${file.fileName}.gz`);
      if (!existsSync(dl)) {
        console.log(`${name} ${c.version}: downloading ${file.url}`);
        await download(file.url, `${dl}.part`);
        renameSync(`${dl}.part`, dl);
      }
      const h = await sha256(dl);
      if (file.sha256 !== h) throw new Error(`${name}/${file.fileName}: checksum mismatch (expected ${file.sha256}, got ${h})`);
      writeFileSync(join(staging, file.fileName), gunzipSync(readFileSync(dl)));
    }
    rmSync(target, { recursive: true, force: true });
    mkdirSync(dirname(target), { recursive: true });
    renameSync(staging, target);
    writeFileSync(join(target, ".complete"), new Date().toISOString());
    console.log(`${name} ${c.version}: ready at ${target}`);
    continue;
  }
  const archive = join(root, "vendor", ".downloads", `${name}-${c.version}.${c.archive}`);
  if (!existsSync(archive)) {
    console.log(`${name} ${c.version}: downloading ${c.url}`);
    await download(c.url, `${archive}.part`);
    renameSync(`${archive}.part`, archive);
  }
  const hash = await sha256(archive);
  if (c.sha256 && c.sha256 !== hash) throw new Error(`${name}: checksum mismatch (expected ${c.sha256}, got ${hash})`);
  if (!c.sha256) console.log(`${name}: sha256 ${hash} (not pinned yet — add it to components.json)`);

  const staging = `${target}.staging`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  if (c.archive === "zip" || c.archive === "tar.gz") {
    // Windows 10+ ships bsdtar, which extracts zip archives too.
    const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
    execFileSync(tar, ["-xf", archive, "-C", staging, ...(c.extract ?? [])], { stdio: "inherit" });
  } else if (c.archive === "exe") {
    writeFileSync(join(staging, c.fileName), readFileSync(archive));
  }
  const src = c.stripPrefix ? join(staging, c.stripPrefix) : staging;
  rmSync(target, { recursive: true, force: true });
  mkdirSync(dirname(target), { recursive: true });
  renameSync(src, target);
  rmSync(staging, { recursive: true, force: true });
  writeFileSync(join(target, ".complete"), new Date().toISOString());
  console.log(`${name} ${c.version}: ready at ${target}`);
}

/** Downloads a pinned file (once) into vendor/.downloads and checks its sha256. */
async function pinned(url, sha, fileName) {
  mkdirSync(join(root, "vendor", ".downloads"), { recursive: true });
  const file = join(root, "vendor", ".downloads", fileName);
  if (!existsSync(file)) {
    console.log(`  downloading ${url}`);
    await download(url, `${file}.part`);
    renameSync(`${file}.part`, file);
  }
  const h = await sha256(file);
  if (h !== sha) throw new Error(`${fileName}: checksum mismatch (expected ${sha}, got ${h})`);
  return file;
}

/**
 * Components without an official Windows download (FerretDB) are compiled from pinned source with
 * a pinned Go toolchain. Both archives are checked by sha256; the build is offline after the Go
 * module download, reproducible (-trimpath) and has no C dependencies (CGO off).
 */
async function buildFromSource(name, c, target) {
  const b = c.build;
  const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\Windows", "System32", "tar.exe") : "tar";
  const tools = join(root, "vendor", ".tools");
  const goDir = join(tools, `go-${b.go.version}`);
  if (!existsSync(join(goDir, "go", "bin", "go.exe"))) {
    const zip = await pinned(b.go.url, b.go.sha256, `go-${b.go.version}.zip`);
    rmSync(goDir, { recursive: true, force: true });
    mkdirSync(goDir, { recursive: true });
    execFileSync(tar, ["-xf", zip, "-C", goDir], { stdio: "inherit" });
  }
  const src = join(tools, `${name}-${c.version}-src`);
  rmSync(src, { recursive: true, force: true });
  mkdirSync(src, { recursive: true });
  const archive = await pinned(b.source.url, b.source.sha256, `${name}-${c.version}-src.tar.gz`);
  execFileSync(tar, ["-xzf", archive, "-C", src, "--strip-components", "1"], { stdio: "inherit" });
  for (const [rel, content] of Object.entries(b.writeFiles ?? {})) writeFileSync(join(src, rel), content);
  const staging = `${target}.staging`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  console.log(`${name} ${c.version}: building from source with Go ${b.go.version}`);
  execFileSync(join(goDir, "go", "bin", "go.exe"), ["build", "-trimpath", "-buildvcs=false", "-ldflags", "-s -w", "-o", join(staging, b.output), b.package], {
    cwd: src,
    stdio: "inherit",
    env: { ...process.env, GOTOOLCHAIN: "local", CGO_ENABLED: "0", GOPATH: join(tools, "gopath"), GOCACHE: join(tools, "gocache"), GOFLAGS: "-mod=mod" },
  });
  for (const f of b.include ?? []) writeFileSync(join(staging, f), readFileSync(join(src, f)));
  rmSync(target, { recursive: true, force: true });
  mkdirSync(dirname(target), { recursive: true });
  renameSync(staging, target);
  writeFileSync(join(target, ".complete"), new Date().toISOString());
  console.log(`${name} ${c.version}: ready at ${target}`);
}
