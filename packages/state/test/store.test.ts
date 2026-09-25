import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsRepo, settingsMigrations, StateStore, type Migration } from "@nexus/state";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const m1: Migration = { id: "test/001", up: "CREATE TABLE things (id INTEGER PRIMARY KEY, name TEXT NOT NULL)" };
const m2: Migration = {
  id: "test/002",
  up: (s) => s.run("INSERT INTO things (name) VALUES (?)", ["seeded"]),
};

describe("StateStore", () => {
  it("applies migrations once and in order", () => {
    const s = StateStore.memory();
    expect(s.migrate([m1, m2])).toEqual(["test/001", "test/002"]);
    expect(s.migrate([m1, m2])).toEqual([]);
    expect(s.all<{ name: string }>("SELECT name FROM things")).toEqual([{ name: "seeded" }]);
    expect(s.appliedMigrations()).toEqual(["test/001", "test/002"]);
  });

  it("persists migrations across reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "nexus-state-"));
    dirs.push(dir);
    const path = join(dir, "sub", "state.db");
    const a = new StateStore(path);
    a.migrate([m1]);
    a.close();
    const b = new StateStore(path);
    expect(b.migrate([m1, m2])).toEqual(["test/002"]);
    b.close();
  });

  it("rolls back a failing migration entirely", () => {
    const s = StateStore.memory();
    const bad: Migration = { id: "test/bad", up: "CREATE TABLE x (id INTEGER); INSERT INTO nope VALUES (1);" };
    expect(() => s.migrate([bad])).toThrow();
    expect(s.appliedMigrations()).toEqual([]);
    expect(s.get("SELECT name FROM sqlite_master WHERE name = 'x'")).toBeUndefined();
  });

  it("rejects duplicate migration ids", () => {
    expect(() => StateStore.memory().migrate([m1, m1])).toThrow(/Duplicate/);
  });

  it("supports nested transactions with savepoints", () => {
    const s = StateStore.memory();
    s.migrate([m1]);
    s.transaction(() => {
      s.run("INSERT INTO things (name) VALUES ('outer')");
      expect(() =>
        s.transaction(() => {
          s.run("INSERT INTO things (name) VALUES ('inner')");
          throw new Error("inner fails");
        }),
      ).toThrow();
    });
    expect(s.all<{ name: string }>("SELECT name FROM things").map((r) => r.name)).toEqual(["outer"]);
  });

  it("stores typed settings", () => {
    const s = StateStore.memory();
    s.migrate(settingsMigrations);
    const settings = new SettingsRepo(s);
    expect(settings.get("setup.completed", false)).toBe(false);
    settings.set("setup.completed", true);
    settings.set("paths", { apps: "D:\\Nexus\\Apps" });
    expect(settings.get("setup.completed", false)).toBe(true);
    expect(settings.get("paths", {})).toEqual({ apps: "D:\\Nexus\\Apps" });
  });
});
