import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Sealed-box format (all binary, concatenated):
 *   version(1) | iv(12) | tag(16) | ciphertext(n)
 * AES-256-GCM with optional additional authenticated data (AAD) binding the
 * ciphertext to its context (e.g. the secret's name) so rows cannot be swapped.
 */
const VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER = 1 + IV_LEN + TAG_LEN;

export function seal(key: Buffer, plaintext: Buffer, aad?: string): Buffer {
  assertKey(key);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ct]);
}

export function open(key: Buffer, sealed: Buffer, aad?: string): Buffer {
  assertKey(key);
  if (sealed.length < HEADER || sealed[0] !== VERSION) throw new Error("Unsupported or corrupted encrypted data.");
  const iv = sealed.subarray(1, 1 + IV_LEN);
  const tag = sealed.subarray(1 + IV_LEN, HEADER);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  if (aad) decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(sealed.subarray(HEADER)), decipher.final()]);
  } catch {
    throw new Error("Encrypted data could not be verified (wrong key or tampered data).");
  }
}

/** Derive an independent sub-key (e.g. "backups", "sessions") from the master key. */
export function deriveKey(master: Buffer, purpose: string): Buffer {
  assertKey(master);
  return Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), `nexus:${purpose}`, 32));
}

export function constantTimeEqual(a: string | Buffer, b: string | Buffer): boolean {
  const ab = Buffer.isBuffer(a) ? a : Buffer.from(a);
  const bb = Buffer.isBuffer(b) ? b : Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function assertKey(key: Buffer): void {
  if (key.length !== 32) throw new Error("Encryption key must be 32 bytes.");
}
