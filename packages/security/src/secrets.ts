import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { NexusError } from "@nexus/shared";
import type { Migration, StateStore } from "@nexus/state";
import { deriveKey, open, seal } from "./crypto";
import type { KeyProtector } from "./key-protector";

export const secretsMigrations: Migration[] = [
  {
    id: "security/001_secrets",
    up: `CREATE TABLE secrets (
      name TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      ciphertext BLOB NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX secrets_scope ON secrets(scope);`,
  },
];

const KEY_FILE_MAGIC = "NEXUSKEY1:";

export interface SecretInfo {
  name: string;
  scope: string;
  version: number;
  updatedAt: string;
}

/**
 * Encrypted secret storage. Values never touch disk in plaintext: each is sealed with
 * AES-256-GCM under a master key, with the secret's name as AAD. The master key itself
 * is stored wrapped by a KeyProtector (DPAPI on Windows).
 *
 * Scopes group secrets by owner: "system", "app:<id>", "pipeline:<id>", "db:<id>".
 */
export class SecretVault {
  private readonly masterKey: Buffer;

  private constructor(
    private readonly store: StateStore,
    masterKey: Buffer,
  ) {
    this.masterKey = masterKey;
  }

  /** Opens the vault, creating and protecting a new master key on first run. */
  static open(store: StateStore, keyPath: string, protector: KeyProtector): SecretVault {
    store.migrate(secretsMigrations);
    let key: Buffer;
    if (existsSync(keyPath)) {
      const raw = readFileSync(keyPath, "utf8").trim();
      if (!raw.startsWith(KEY_FILE_MAGIC)) throw new Error("Nexus key file is not recognised.");
      const [kind, payload] = raw.slice(KEY_FILE_MAGIC.length).split(":");
      if (kind !== protector.kind) {
        throw new Error(`Nexus key file was protected with "${kind}" but "${protector.kind}" is configured.`);
      }
      key = protector.unprotect(Buffer.from(payload ?? "", "base64"));
    } else {
      key = randomBytes(32);
      mkdirSync(dirname(keyPath), { recursive: true });
      const wrapped = protector.protect(key).toString("base64");
      writeFileSync(keyPath, `${KEY_FILE_MAGIC}${protector.kind}:${wrapped}\n`, { mode: 0o600, flag: "wx" });
    }
    if (key.length !== 32) throw new Error("Nexus master key is invalid.");
    return new SecretVault(store, key);
  }

  /** For tests / recovery: open with an explicit key. */
  static withKey(store: StateStore, masterKey: Buffer): SecretVault {
    store.migrate(secretsMigrations);
    return new SecretVault(store, Buffer.from(masterKey));
  }

  set(name: string, value: string, scope = "system"): void {
    validateName(name);
    const now = new Date().toISOString();
    const ct = seal(this.masterKey, Buffer.from(value, "utf8"), name);
    this.store.run(
      `INSERT INTO secrets (name, scope, ciphertext, version, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)
       ON CONFLICT(name) DO UPDATE SET ciphertext = excluded.ciphertext, scope = excluded.scope,
         version = secrets.version + 1, updated_at = excluded.updated_at`,
      [name, scope, ct, now, now],
    );
  }

  get(name: string): string | undefined {
    const row = this.store.get<{ ciphertext: Uint8Array }>("SELECT ciphertext FROM secrets WHERE name = ?", [name]);
    if (!row) return undefined;
    return open(this.masterKey, Buffer.from(row.ciphertext), name).toString("utf8");
  }

  require(name: string): string {
    const v = this.get(name);
    if (v === undefined) throw NexusError.notFound(`Secret "${name}"`);
    return v;
  }

  has(name: string): boolean {
    return !!this.store.get("SELECT 1 FROM secrets WHERE name = ?", [name]);
  }

  delete(name: string): boolean {
    return this.store.run("DELETE FROM secrets WHERE name = ?", [name]).changes > 0;
  }

  deleteScope(scope: string): number {
    return this.store.run("DELETE FROM secrets WHERE scope = ?", [scope]).changes;
  }

  /** Lists secret metadata only — never values. */
  list(scope?: string): SecretInfo[] {
    const rows = this.store.all<{ name: string; scope: string; version: number; updated_at: string }>(
      scope
        ? "SELECT name, scope, version, updated_at FROM secrets WHERE scope = ? ORDER BY name"
        : "SELECT name, scope, version, updated_at FROM secrets ORDER BY name",
      scope ? [scope] : [],
    );
    return rows.map((r) => ({ name: r.name, scope: r.scope, version: r.version, updatedAt: r.updated_at }));
  }

  /** Independent key for another purpose (backup encryption, token signing...). */
  deriveKey(purpose: string): Buffer {
    return deriveKey(this.masterKey, purpose);
  }

  /**
   * Recovery key the Owner can write down. Required to decrypt backups on a different
   * machine if this computer is lost.
   */
  exportRecoveryKey(): string {
    const hex = this.masterKey.toString("hex").toUpperCase();
    return hex.match(/.{1,8}/g)!.join("-");
  }

  static parseRecoveryKey(recoveryKey: string): Buffer {
    const hex = recoveryKey.replace(/[^0-9a-fA-F]/g, "");
    if (hex.length !== 64) throw NexusError.invalid("That recovery key is not complete.");
    return Buffer.from(hex, "hex");
  }
}

function validateName(name: string): void {
  if (!/^[A-Za-z0-9_.:/-]{1,200}$/.test(name)) throw NexusError.invalid(`Invalid secret name "${name}".`);
}
