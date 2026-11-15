import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { StateStore } from "@nexus/state";
import { BackupManager, DEFAULT_POLICY, isBackupDue, RestoreManager, validateBackupManifest } from "@nexus/backups";

it("recovers app code and a live SQLite WAL database, and replaces only verified backups", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nexus-complete-"));
  const store = StateStore.memory();
  const source = join(dir, "app"); mkdirSync(source);
  const db = new DatabaseSync(join(source, "data.sqlite"));
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE items(name TEXT); INSERT INTO items VALUES ('saved');");
    writeFileSync(join(source, "server.js"), "original source");
    const backups = new BackupManager(store, { root: join(dir, "backups"), backupKey: randomBytes(32), pg: null });
    const target = { appId: "app", appName: "App", database: null, fileDirs: [{ name: "application", path: source, snapshot: true }], config: { version: "saved" } };
    const first = await backups.backup(target);
    expect(first.contents.application).toBe(true);
    const out = join(dir, "out"); await backups.extract(first.path!, out);
    const saved = new DatabaseSync(join(out, "files", "application", "data.sqlite"));
    expect(saved.prepare("SELECT name FROM items").get()?.name).toBe("saved"); saved.close();
    expect(existsSync(join(out, "files", "application", "data.sqlite-wal"))).toBe(false);
    await expect(backups.backup({ ...target, validateFiles: () => { throw new Error("snapshot incomplete"); } })).rejects.toThrow("snapshot incomplete");
    expect(existsSync(first.path!)).toBe(true);
    db.close();
    writeFileSync(join(source, "server.js"), "changed source");
    const result = await new RestoreManager(backups, null).restore(first.id, "entire", { current: target, database: null, fileDirs: target.fileDirs }, "App");
    expect(result.restored).toEqual(["files", "config"]);
    expect(readFileSync(join(source, "server.js"), "utf8")).toBe("original source");
    const newest = await backups.backup(target);
    backups.applyRetention("app", DEFAULT_POLICY.retention, new Date(), true);
    expect(backups.list("app").map((b) => b.id)).toEqual([newest.id]);
    expect(existsSync(first.path!)).toBe(false);
  } finally { if (db.isOpen) db.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("honors daily slots and exact custom intervals without 1.5x schedule drift", () => {
  const now = new Date(2026, 10, 13, 3, 0);
  expect(isBackupDue(DEFAULT_POLICY, new Date(2026, 10, 12, 3, 0), now)).toBe(true);
  expect(isBackupDue(DEFAULT_POLICY, now, now)).toBe(false);
  expect(isBackupDue({ ...DEFAULT_POLICY, frequency: "custom", intervalHours: 2 }, new Date(now.getTime() - 2 * 3600_000), now)).toBe(true);
  expect(isBackupDue({ ...DEFAULT_POLICY, enabled: false }, null, now)).toBe(false);
});

it("rejects manifest paths that leave the archive", () => {
  expect(() => validateBackupManifest({ format: "nexus-backup", version: 1, appId: "a", files: ["../../outside"], config: null })).toThrow("unsafe paths");
});
