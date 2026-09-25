import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "@nexus/state";
import { DpapiKeyProtector, InsecurePlainKeyProtector, open, seal, SecretVault } from "@nexus/security";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "nexus-sec-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("sealed boxes", () => {
  const key = randomBytes(32);
  it("round-trips and detects tampering", () => {
    const box = seal(key, Buffer.from("hunter2"), "db/password");
    expect(open(key, box, "db/password").toString()).toBe("hunter2");
    const tampered = Buffer.from(box);
    tampered[tampered.length - 1]! ^= 0xff;
    expect(() => open(key, tampered, "db/password")).toThrow(/verified/);
  });
  it("binds ciphertext to its AAD", () => {
    const box = seal(key, Buffer.from("x"), "a");
    expect(() => open(key, box, "b")).toThrow();
  });
  it("fails with the wrong key", () => {
    const box = seal(key, Buffer.from("x"));
    expect(() => open(randomBytes(32), box)).toThrow();
  });
});

describe("SecretVault", () => {
  it("stores values encrypted, never in plaintext", () => {
    const store = StateStore.memory();
    const vault = SecretVault.withKey(store, randomBytes(32));
    vault.set("app:taxiops/db_password", "S3cret-Value!", "app:taxiops");
    const raw = store.get<{ ciphertext: Uint8Array }>("SELECT ciphertext FROM secrets")!;
    expect(Buffer.from(raw.ciphertext).toString("latin1")).not.toContain("S3cret-Value!");
    expect(vault.get("app:taxiops/db_password")).toBe("S3cret-Value!");
  });

  it("versions updates, lists metadata only, deletes by scope", () => {
    const vault = SecretVault.withKey(StateStore.memory(), randomBytes(32));
    vault.set("a", "1", "app:x");
    vault.set("a", "2", "app:x");
    vault.set("b", "3", "app:y");
    expect(vault.get("a")).toBe("2");
    expect(vault.list("app:x")).toEqual([expect.objectContaining({ name: "a", version: 2 })]);
    expect(JSON.stringify(vault.list())).not.toContain('"2"');
    expect(vault.deleteScope("app:x")).toBe(1);
    expect(vault.has("a")).toBe(false);
    expect(vault.require("b")).toBe("3");
    expect(() => vault.require("missing")).toThrow(/not found/);
  });

  it("rejects row swapping between secret names", () => {
    const store = StateStore.memory();
    const vault = SecretVault.withKey(store, randomBytes(32));
    vault.set("public", "harmless");
    vault.set("private", "sensitive");
    store.run("UPDATE secrets SET ciphertext = (SELECT ciphertext FROM secrets WHERE name='private') WHERE name='public'");
    expect(() => vault.get("public")).toThrow();
  });

  it("creates the key file once and reopens with the same key", () => {
    const dir = tmp();
    const store = new StateStore(join(dir, "state.db"));
    const keyPath = join(dir, "keys", "master.key");
    const p = new InsecurePlainKeyProtector();
    SecretVault.open(store, keyPath, p).set("k", "v");
    const again = SecretVault.open(store, keyPath, p);
    expect(again.get("k")).toBe("v");
    expect(readFileSync(keyPath, "utf8")).toMatch(/^NEXUSKEY1:plain:/);
    store.close();
  });

  it("recovery key round-trips to the master key", () => {
    const key = randomBytes(32);
    const vault = SecretVault.withKey(StateStore.memory(), key);
    const rk = vault.exportRecoveryKey();
    expect(rk).toMatch(/^([0-9A-F]{8}-){7}[0-9A-F]{8}$/);
    expect(SecretVault.parseRecoveryKey(rk).equals(key)).toBe(true);
  });

  it("derives distinct purpose keys", () => {
    const vault = SecretVault.withKey(StateStore.memory(), randomBytes(32));
    expect(vault.deriveKey("backups").equals(vault.deriveKey("sessions"))).toBe(false);
    expect(vault.deriveKey("backups").equals(vault.deriveKey("backups"))).toBe(true);
  });
});

describe.runIf(process.platform === "win32")("DPAPI key protector (Windows)", () => {
  it("protects and unprotects with Windows data protection", () => {
    const p = new DpapiKeyProtector();
    const key = randomBytes(32);
    const wrapped = p.protect(key);
    expect(wrapped.equals(key)).toBe(false);
    expect(p.unprotect(wrapped).equals(key)).toBe(true);
  });

  it("vault opens through DPAPI end to end", () => {
    const dir = tmp();
    const store = new StateStore(join(dir, "state.db"));
    const keyPath = join(dir, "master.key");
    SecretVault.open(store, keyPath, new DpapiKeyProtector()).set("x", "y");
    expect(SecretVault.open(store, keyPath, new DpapiKeyProtector()).get("x")).toBe("y");
    expect(readFileSync(keyPath, "utf8")).toMatch(/^NEXUSKEY1:dpapi:/);
    store.close();
  });
});
