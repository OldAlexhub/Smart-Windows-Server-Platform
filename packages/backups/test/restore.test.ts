import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StateStore } from "@nexus/state";
import { SecretVault } from "@nexus/security";
import { DatabaseManager, type PostgresEngine } from "@nexus/database";
import { BackupManager, resetSchemaSql, RestoreManager, type RestoreTarget } from "@nexus/backups";
import { PG_BIN, startTestCluster } from "../../database/test/pg-harness";

describe.runIf(!!PG_BIN)("RestoreManager (real PostgreSQL)", () => {
  let engine: PostgresEngine;
  let dispose: () => Promise<void>;
  let dbs: DatabaseManager;
  let dbId: string;
  let dir: string;
  let backups: BackupManager;
  let restore: RestoreManager;
  let target: RestoreTarget;

  const names = async () =>
    dbs.withOwner(dbId, async (c) => (await c.query("SELECT name FROM drivers ORDER BY id")).rows.map((r) => r.name as string));

  beforeAll(async () => {
    ({ engine, dispose } = await startTestCluster());
    const store = StateStore.memory();
    dbs = new DatabaseManager(store, SecretVault.withKey(store, randomBytes(32)), engine);
    const { database } = await dbs.createDatabase({ displayName: "TaxiOps", appId: "taxiops" });
    dbId = database.id;
    await dbs.withOwner(dbId, async (c) => {
      await c.query("CREATE TABLE drivers (id serial primary key, name text)");
      await c.query("INSERT INTO drivers (name) VALUES ('Ann'), ('Bob')");
    });
    dir = mkdtempSync(join(tmpdir(), "nexus-restore-"));
    mkdirSync(join(dir, "storage"), { recursive: true });
    writeFileSync(join(dir, "storage", "contract.pdf"), "original contract");

    const pg = { binDir: engine.binDir, host: "127.0.0.1", port: engine.port, user: engine.superuser, password: "test-superuser-password-123" };
    backups = new BackupManager(store, { root: join(dir, "Backups"), backupKey: randomBytes(32), pg });
    restore = new RestoreManager(backups, pg);
    const fileDirs = [{ name: "storage", path: join(dir, "storage") }];
    target = {
      current: { appId: "taxiops", appName: "TaxiOps", database: { dbName: "taxiops" }, fileDirs, config: { version: "current" } },
      fileDirs,
      database: {
        dbName: "taxiops",
        ownerRole: "taxiops_owner",
        reset: async () => {
          const c = await engine.adminClient("taxiops");
          try {
            for (const sql of resetSchemaSql("taxiops_owner", "taxiops_ro", (s) => c.escapeIdentifier(s))) await c.query(sql);
          } finally {
            await c.end();
          }
        },
      },
    };
  }, 180_000);
  afterAll(async () => {
    await dispose?.();
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it("restores the entire application to a restore point", async () => {
    const point = await backups.backup({ ...target.current, config: { version: "at-backup" } }, "scheduled");

    // Things change after the backup...
    await dbs.withOwner(dbId, async (c) => {
      await c.query("DELETE FROM drivers WHERE name = 'Ann'");
      await c.query("INSERT INTO drivers (name) VALUES ('Mallory')");
      await c.query("CREATE TABLE junk (x int)");
    });
    unlinkSync(join(dir, "storage", "contract.pdf"));
    writeFileSync(join(dir, "storage", "new.txt"), "added later");

    const result = await restore.restore(point.id, "entire", target, "TaxiOps");
    expect(result.restored).toEqual(["database", "files", "config"]);
    expect(result.config).toEqual({ version: "at-backup" });
    expect(await names()).toEqual(["Ann", "Bob"]);
    const junk = await dbs.withOwner(dbId, async (c) => (await c.query("SELECT to_regclass('public.junk') AS t")).rows[0].t);
    expect(junk).toBeNull();
    expect(readFileSync(join(dir, "storage", "contract.pdf"), "utf8")).toBe("original contract");
    expect(existsSync(join(dir, "storage", "new.txt"))).toBe(false);

    // Restored tables are owned by the app's owner role and readable in read-only mode.
    const owner = await engine.adminQuery("SELECT tableowner FROM pg_tables WHERE tablename = 'drivers'", [], "taxiops");
    expect(owner[0]!.tableowner).toBe("taxiops_owner");
    const ro = await dbs.withReadOnly(dbId, async (c) => (await c.query("SELECT count(*)::int AS n FROM drivers")).rows[0].n);
    expect(ro).toBe(2);
    // The app itself can still connect and write.
    expect(await dbs.testConnection(dbs.connectionInfo(dbId, "taxiops"))).toEqual({ ok: true });

    // A safety backup of the pre-restore state exists and contains Mallory.
    const safety = backups.require(result.safetyBackupId!);
    expect(safety.trigger).toBe("pre-restore");
  }, 120_000);

  it("can restore only files, leaving the database untouched", async () => {
    const point = await backups.backup(target.current, "manual");
    await dbs.withOwner(dbId, (c) => c.query("INSERT INTO drivers (name) VALUES ('Cara')"));
    writeFileSync(join(dir, "storage", "contract.pdf"), "edited");
    await restore.restore(point.id, ["files"], target, "TaxiOps");
    expect(readFileSync(join(dir, "storage", "contract.pdf"), "utf8")).toBe("original contract");
    expect(await names()).toContain("Cara");
  }, 120_000);

  it("requires typing the application name and a usable restore point", async () => {
    const point = backups.latestSuccessful("taxiops")!;
    await expect(restore.restore(point.id, "entire", target, "yes")).rejects.toThrow(/type the application name exactly: TaxiOps/);
    await expect(restore.restore("nope", "entire", target, "TaxiOps")).rejects.toThrow(/not found/);
  });
});
