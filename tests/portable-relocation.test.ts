import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

const helper = "../scripts/portable/relocate-portable.mjs";
const { relocatePortable, rebasePortablePath, releaseForeignGateway } = await import(helper);
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nexus-move-"));
  roots.push(root);
  const oldRoot = join(root, "old-copy");
  const next = join(root, "new-copy");
  const data = join(next, "data");
  for (const name of ["Apps", "Database", "Storage", "Backups", "AI", "nexus/state"])
    mkdirSync(join(data, name), { recursive: true });
  const dbPath = join(data, "nexus/state/nexus.db");
  const db = new DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT); CREATE TABLE deployments (release_dir TEXT, venv_dir TEXT); CREATE TABLE backups(path TEXT)",
  );
  const paths = Object.fromEntries(
    Object.entries({ apps: "Apps", database: "Database", files: "Storage", backups: "Backups", ai: "AI" }).map(
      ([key, name]) => [key, join(oldRoot, "data", name)],
    ),
  );
  db.prepare("INSERT INTO settings VALUES ('setup.dataPaths', ?, '')").run(JSON.stringify(paths));
  db.prepare("INSERT INTO deployments VALUES (?, ?)").run(
    join(oldRoot, "data/Apps/demo/releases/1"),
    join(oldRoot, "data/Apps/demo/venv"),
  );
  db.prepare("INSERT INTO backups VALUES (?)").run(join(root, "external/backups/example.nxb"));
  db.close();
  return { root, oldRoot, next, data, dbPath, paths };
}

describe("portable folder relocation", () => {
  it("releases another copy's gateway reservations while retaining its own orphaned gateway", async () => {
    const f = fixture();
    const db = new DatabaseSync(f.dbPath);
    db.exec(
      "CREATE TABLE port_allocations(port INTEGER, owner TEXT, purpose TEXT); INSERT INTO port_allocations VALUES (43600, 'gateway', 'admin'), (43510, 'database', 'postgres');",
    );
    try {
      expect(await releaseForeignGateway(f.next, async () => undefined)).toBe(false);
      expect(await releaseForeignGateway(f.next, async () => join(f.next, "data/nexus/gateway/data"))).toBe(false);
      expect(await releaseForeignGateway(f.next, async () => join(f.root, "installed/gateway"))).toBe(true);
      expect(db.prepare("SELECT owner FROM port_allocations").all()).toEqual([{ owner: "database" }]);
    } finally {
      db.close();
    }
  });
  it("rebases only paths inside the old folder, including case-safe path boundaries", () => {
    const { oldRoot, next } = fixture();
    expect(rebasePortablePath(join(oldRoot, "data/Apps"), oldRoot, next)).toBe(join(next, "data/Apps"));
    expect(rebasePortablePath(oldRoot + "-other", oldRoot, next)).toBe(oldRoot + "-other");
    expect(rebasePortablePath(null, oldRoot, next)).toBe(null);
  });
  it("moves settings and deployment references, preserves external paths, and backs up state", () => {
    const f = fixture();
    const venv = join(f.data, "Apps/demo/venv");
    mkdirSync(venv, { recursive: true });
    writeFileSync(
      join(venv, "pyvenv.cfg"),
      `home = ${join(f.oldRoot, "app/components/python")}\ninclude-system-site-packages = false\n`,
    );
    expect(relocatePortable(f.next)).toBe(true);
    const db = new DatabaseSync(f.dbPath);
    try {
      const paths = JSON.parse(db.prepare("SELECT value FROM settings").get()!.value as string);
      expect(paths.database).toBe(join(f.data, "Database"));
      expect(db.prepare("SELECT release_dir FROM deployments").get()!.release_dir).toBe(
        join(f.data, "Apps/demo/releases/1"),
      );
      expect(db.prepare("SELECT path FROM backups").get()!.path).toBe(join(f.root, "external/backups/example.nxb"));
    } finally {
      db.close();
    }
    expect(readFileSync(join(venv, "pyvenv.cfg"), "utf8")).toContain(join(f.next, "app/components/python"));
    expect(readdirSync(join(f.data, "nexus/state")).filter((file) => file.includes("before-move"))).toHaveLength(1);
    expect(relocatePortable(f.next)).toBe(false);
  });
  it("refuses an incomplete moved data folder without resetting settings", () => {
    const f = fixture();
    rmSync(join(f.data, "Database"), { recursive: true });
    expect(() => relocatePortable(f.next)).toThrow("missing data\\Database");
    const db = new DatabaseSync(f.dbPath);
    try {
      expect(JSON.parse(db.prepare("SELECT value FROM settings").get()!.value as string)).toEqual(f.paths);
    } finally {
      db.close();
    }
  });
  it("does nothing for a fresh extraction", () => {
    const f = fixture();
    expect(relocatePortable(join(f.root, "fresh"))).toBe(false);
  });
});
