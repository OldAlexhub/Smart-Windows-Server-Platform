// Repair paths after moving a stopped portable folder on the same Windows account.
// The vault's Windows protection is preserved; no secrets are decrypted here.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import http from "node:http";
import { fileURLToPath } from "node:url";

export function rebasePortablePath(value, oldRoot, newRoot) {
  if (typeof value !== "string" || !isAbsolute(value)) return value;
  const rel = relative(oldRoot, value);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return value;
  return join(newRoot, rel);
}

export function relocatePortable(root) {
  root = resolve(root);
  const data = join(root, "data");
  const dbPath = join(data, "nexus", "state", "nexus.db");
  if (!existsSync(dbPath)) return false;
  const db = new DatabaseSync(dbPath, { timeout: 5000 });
  try {
    const stored = db.prepare("SELECT value FROM settings WHERE key = 'setup.dataPaths'").get();
    if (!stored) return false;
    const paths = JSON.parse(stored.value);
    const names = { apps: "Apps", database: "Database", files: "Storage", backups: "Backups", ai: "AI" };
    const oldData = dirname(paths.database);
    if (relative(oldData, data) === "") return false;
    // Only infer a legacy portable location from its complete standard layout.
    // A custom external storage path is never silently redirected.
    if (
      basename(oldData).toLowerCase() !== "data" ||
      !Object.entries(names).every(
        ([key, name]) => typeof paths[key] === "string" && relative(join(oldData, name), paths[key]) === "",
      )
    ) {
      const missing = Object.values(paths).filter((path) => typeof path === "string" && !existsSync(path));
      if (missing.length)
        throw new Error(
          `Saved storage folders are unavailable: ${missing.join(", ")}. Reconnect that storage before starting Nexus.`,
        );
      return false;
    }
    for (const name of Object.values(names)) {
      if (!existsSync(join(data, name))) {
        throw new Error(
          `The moved portable folder is missing data\\${name}. Copy the complete original data folder before starting Nexus.`,
        );
      }
    }
    const oldRoot = dirname(oldData);
    const rebase = (path) => rebasePortablePath(path, oldRoot, root);
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((row) => row.name),
    );
    const backup = `${dbPath}.before-move-${Date.now()}.bak`;
    db.prepare("VACUUM INTO ?").run(backup);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE settings SET value=?, updated_at=? WHERE key='setup.dataPaths'").run(
        JSON.stringify(Object.fromEntries(Object.entries(paths).map(([key, value]) => [key, rebase(value)]))),
        new Date().toISOString(),
      );
      const fields = {
        apps: ["source_dir"],
        deployments: ["source_dir", "release_dir", "venv_dir", "r_script", "r_lib_dir"],
        backups: ["path"],
      };
      for (const [table, candidates] of Object.entries(fields)) {
        if (!tables.has(table)) continue;
        const columns = new Set(
          db
            .prepare(`PRAGMA table_info(${table})`)
            .all()
            .map((row) => row.name),
        );
        for (const field of candidates.filter((column) => columns.has(column))) {
          const update = db.prepare(`UPDATE ${table} SET ${field}=? WHERE rowid=?`);
          for (const row of db.prepare(`SELECT rowid AS record_id, ${field} AS path FROM ${table}`).all()) {
            const next = rebase(row.path);
            if (next !== row.path) update.run(next, row.record_id);
          }
        }
      }
      // Python venv launchers find their bundled Python through pyvenv.cfg.
      // Update only its known runtime paths, preserving unrelated configuration.
      const apps = join(data, "Apps");
      const visit = (directory) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) continue;
          const path = join(directory, entry.name);
          if (entry.isDirectory() && !["node_modules", "site-packages", ".git"].includes(entry.name)) visit(path);
          else if (entry.isFile() && entry.name === "pyvenv.cfg") {
            const text = readFileSync(path, "utf8");
            const next = text.replace(
              /^(home|executable)\s*=\s*(.+)$/gm,
              (_line, key, value) => `${key} = ${rebase(value.trim())}`,
            );
            if (text !== next) writeFileSync(path, next);
          }
        }
      };
      visit(apps);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    console.log(`Updated portable folder paths. Previous settings saved at ${backup}`);
    return true;
  } finally {
    db.close();
  }
}

function gatewayStorageRoot(port) {
  return new Promise((done) => {
    // Caddy rejects fetch's browser-style headers on its private admin API.
    const request = http.get({ host: "127.0.0.1", port, path: "/config/storage/", timeout: 1500 }, (response) => {
      let body = "";
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > 65536) {
          response.destroy();
          done(null);
        }
      });
      response.on("error", () => done(null));
      response.on("end", () => {
        try {
          done(response.statusCode === 200 ? (JSON.parse(body).root ?? null) : null);
        } catch {
          done(null);
        }
      });
    });
    request.on("timeout", () => {
      request.destroy();
      done(null);
    });
    request.on("error", (error) => done(error.code === "ECONNREFUSED" ? undefined : null));
  });
}

export async function releaseForeignGateway(root, probe = gatewayStorageRoot) {
  const dbPath = join(root, "data/nexus/state/nexus.db");
  if (!existsSync(dbPath)) return false;
  const db = new DatabaseSync(dbPath, { timeout: 5000 });
  try {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE name='port_allocations'").get()) return false;
    const row = db.prepare("SELECT port FROM port_allocations WHERE owner='gateway' AND purpose='admin'").get();
    if (!row) return false;
    const storage = await probe(row.port);
    if (
      storage === undefined ||
      (typeof storage === "string" && relative(join(root, "data/nexus/gateway/data"), storage) === "")
    )
      return false;
    // Cached ports are not proof of ownership: a moved/cloned copy can have the
    // installed server's reservations. Let the allocator pick available ports.
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(
        "DELETE FROM port_allocations WHERE owner='gateway'; DELETE FROM settings WHERE key='gateway.activePorts'; COMMIT;",
      );
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    console.log("Another Nexus copy owns the saved gateway port; this copy will choose its own ports.");
    return true;
  } finally {
    db.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = dirname(fileURLToPath(import.meta.url));
    relocatePortable(root);
    await releaseForeignGateway(root);
  } catch (error) {
    console.error(`Nexus Portable: ${error.message}`);
    process.exitCode = 1;
  }
}
