import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StateStore } from "@nexus/state";
import { SecretVault } from "@nexus/security";
import { DatabaseManager, type PostgresEngine } from "@nexus/database";
import { BackupManager, DecryptStream, DEFAULT_POLICY, EncryptStream, isOverdue, nextRun, selectForDeletion, type BackupRef } from "@nexus/backups";
import { PG_BIN, startTestCluster } from "../../database/test/pg-harness";

async function roundTrip(data: Buffer, encKey: Buffer, decKey = encKey, mutate?: (b: Buffer) => Buffer): Promise<Buffer> {
  const enc: Buffer[] = [];
  await pipeline(Readable.from([data]), new EncryptStream(encKey), new Writable({ write: (c, _e, cb) => (enc.push(c), cb()) }));
  let cipher: Buffer = Buffer.concat(enc);
  if (mutate) cipher = mutate(cipher);
  const out: Buffer[] = [];
  await pipeline(Readable.from([cipher]), new DecryptStream(decKey), new Writable({ write: (c, _e, cb) => (out.push(c), cb()) }));
  return Buffer.concat(out);
}

describe("backup encryption stream", () => {
  const key = randomBytes(32);
  it("round-trips small and multi-chunk data", async () => {
    expect((await roundTrip(Buffer.from("hello"), key)).toString()).toBe("hello");
    expect((await roundTrip(Buffer.alloc(0), key)).length).toBe(0);
    const big = randomBytes(3 * 1024 * 1024 + 123);
    expect((await roundTrip(big, key)).equals(big)).toBe(true);
  });
  it("rejects the wrong key, tampering, truncation and reordering", async () => {
    const data = randomBytes(2.5 * 1024 * 1024);
    await expect(roundTrip(data, key, randomBytes(32))).rejects.toThrow(/could not be decrypted/);
    await expect(roundTrip(data, key, key, (b) => ((b[100]! ^= 1), b))).rejects.toThrow(/could not be decrypted/);
    const chunkSize = 4 + 1024 * 1024 + 16;
    await expect(roundTrip(data, key, key, (b) => b.subarray(0, 24 + chunkSize * 2))).rejects.toThrow(/incomplete/);
    await expect(
      roundTrip(data, key, key, (b) => Buffer.concat([b.subarray(0, 24), b.subarray(24 + chunkSize, 24 + 2 * chunkSize), b.subarray(24, 24 + chunkSize), b.subarray(24 + 2 * chunkSize)])),
    ).rejects.toThrow(/could not be decrypted/);
    await expect(roundTrip(data, key, key, (b) => Buffer.concat([Buffer.from("XXXX"), b.subarray(4)]))).rejects.toThrow(/not a Nexus backup/);
  });
});

describe("schedules", () => {
  it("computes the next daily/weekly/custom run", () => {
    const now = new Date(2026, 8, 23, 21, 0); // Wed 23 Sep 2026, 9 PM
    expect(nextRun(DEFAULT_POLICY, null, now)).toEqual(new Date(2026, 8, 24, 3, 0));
    expect(nextRun({ ...DEFAULT_POLICY }, null, new Date(2026, 8, 23, 2, 0))).toEqual(new Date(2026, 8, 23, 3, 0));
    expect(nextRun({ ...DEFAULT_POLICY, frequency: "weekly", weekday: 0 }, null, now)).toEqual(new Date(2026, 8, 27, 3, 0));
    const last = new Date(2026, 8, 23, 18, 0);
    expect(nextRun({ ...DEFAULT_POLICY, frequency: "custom", intervalHours: 6 }, last, now)).toEqual(new Date(2026, 8, 24, 0, 0));
    expect(nextRun({ ...DEFAULT_POLICY, enabled: false }, null, now)).toBeNull();
  });
  it("catches up on missed backups", () => {
    const now = new Date(2026, 8, 23, 9, 0);
    expect(isOverdue(DEFAULT_POLICY, null, now)).toBe(true);
    expect(isOverdue(DEFAULT_POLICY, new Date(2026, 8, 21, 3, 0), now)).toBe(true);
    expect(isOverdue(DEFAULT_POLICY, new Date(2026, 8, 23, 3, 0), now)).toBe(false);
  });
});

describe("retention (grandfather-father-son)", () => {
  it("keeps 7 daily, 4 weekly, 6 monthly and recent manual backups", () => {
    const now = new Date(2026, 8, 23, 12);
    const refs: BackupRef[] = [];
    for (let d = 0; d < 200; d++) {
      const t = new Date(2026, 8, 23, 3);
      t.setDate(t.getDate() - d);
      refs.push({ id: `s${d}`, createdAt: t.toISOString(), trigger: "scheduled", status: "succeeded" });
    }
    for (let m = 0; m < 12; m++) refs.push({ id: `m${m}`, createdAt: new Date(2026, 8, 20 - m, 10).toISOString(), trigger: "manual", status: "succeeded" });
    refs.push({ id: "f1", createdAt: new Date(2026, 8, 22).toISOString(), trigger: "scheduled", status: "failed" });
    refs.push({ id: "r1", createdAt: new Date(2026, 8, 22).toISOString(), trigger: "scheduled", status: "running" });
    const doomed = new Set(selectForDeletion(refs, DEFAULT_POLICY.retention, now));
    const kept = refs.filter((r) => !doomed.has(r.id));
    expect(kept.filter((r) => r.trigger === "manual")).toHaveLength(10);
    for (let d = 0; d < 7; d++) expect(doomed.has(`s${d}`)).toBe(false);
    expect(doomed.has("f1")).toBe(true);
    expect(doomed.has("r1")).toBe(false);
    const scheduledKept = kept.filter((r) => r.trigger === "scheduled" && r.status === "succeeded").length;
    expect(scheduledKept).toBeGreaterThanOrEqual(7 + 3 + 4);
    expect(scheduledKept).toBeLessThanOrEqual(7 + 4 + 6);
  });
  it("never deletes the only backup", () => {
    const only: BackupRef[] = [{ id: "x", createdAt: new Date(2020, 0, 1).toISOString(), trigger: "pre-restore", status: "succeeded" }];
    expect(selectForDeletion(only, DEFAULT_POLICY.retention, new Date())).toEqual([]);
  });
});

describe.runIf(!!PG_BIN)("BackupManager (real PostgreSQL)", () => {
  let engine: PostgresEngine;
  let dispose: () => Promise<void>;
  let dbs: DatabaseManager;
  let dir: string;
  let backups: BackupManager;
  const key = randomBytes(32);

  beforeAll(async () => {
    ({ engine, dispose } = await startTestCluster());
    const store = StateStore.memory();
    dbs = new DatabaseManager(store, SecretVault.withKey(store, randomBytes(32)), engine);
    const { database } = await dbs.createDatabase({ displayName: "TaxiOps", appId: "taxiops" });
    await dbs.withOwner(database.id, async (c) => {
      await c.query("CREATE TABLE drivers (id serial primary key, name text)");
      await c.query("INSERT INTO drivers (name) VALUES ('SensitiveDriverName'), ('Bob')");
    });
    dir = mkdtempSync(join(tmpdir(), "nexus-bk-"));
    mkdirSync(join(dir, "storage", "invoices"), { recursive: true });
    writeFileSync(join(dir, "storage", "invoices", "inv-1.pdf"), "%PDF invoice one");
    backups = new BackupManager(store, {
      root: join(dir, "Backups"),
      backupKey: key,
      pg: { binDir: engine.binDir, host: "127.0.0.1", port: engine.port, user: engine.superuser, password: "test-superuser-password-123" },
    });
  }, 180_000);
  afterAll(async () => {
    await dispose?.();
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it("creates an encrypted, verified backup of database + files + configuration", async () => {
    const b = await backups.backup(
      { appId: "taxiops", appName: "TaxiOps", database: { dbName: "taxiops" }, fileDirs: [{ name: "storage", path: join(dir, "storage") }], config: { env: { JWT_SECRET: "jwt-secret-value" } } },
      "scheduled",
    );
    expect(b).toMatchObject({ status: "succeeded", trigger: "scheduled", contents: { database: true, files: true, config: true } });
    expect(b.size).toBeGreaterThan(100);
    const raw = readFileSync(b.path!);
    expect(raw.subarray(0, 4).toString()).toBe("NXB1");
    for (const secret of ["SensitiveDriverName", "invoice one", "jwt-secret-value"]) expect(raw.includes(Buffer.from(secret))).toBe(false);

    const manifest = await backups.verifyFile(b.path!);
    expect(manifest).toMatchObject({ appName: "TaxiOps", database: { dbName: "taxiops", format: "pg_dump-custom" }, files: ["storage"] });

    const out = join(dir, "extracted");
    await backups.extract(b.path!, out);
    expect(readFileSync(join(out, "files", "storage", "invoices", "inv-1.pdf"), "utf8")).toBe("%PDF invoice one");
    expect(JSON.parse(readFileSync(join(out, "config", "app.json"), "utf8"))).toEqual({ env: { JWT_SECRET: "jwt-secret-value" } });
    await expect(backups.verifyFile(b.path!, randomBytes(32))).rejects.toThrow(/could not be decrypted/);
  });

  it("reports protection status", () => {
    const expected = { database: true, files: true, config: true };
    const status = backups.protection("taxiops", expected, DEFAULT_POLICY);
    expect(status).toMatchObject({ protected: true, message: "Protected" });
    const later = new Date(Date.now() + 3 * 86_400_000);
    expect(backups.protection("taxiops", expected, DEFAULT_POLICY, later)).toMatchObject({ protected: false, message: "Latest backup is out of date" });
    expect(backups.protection("finance", expected, DEFAULT_POLICY).message).toBe("Not backed up yet");
  });

  it("records failures in plain language and leaves no partial files", async () => {
    await expect(
      backups.backup({ appId: "ghost", appName: "Ghost", database: { dbName: "does_not_exist" }, fileDirs: [], config: {} }),
    ).rejects.toThrow(/could not be exported/);
    expect(backups.list("ghost")[0]).toMatchObject({ status: "failed", path: null });
  });
});
