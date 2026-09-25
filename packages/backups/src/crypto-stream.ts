import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";

/**
 * Nexus backup encryption (".nxb"): a STREAM-style chunked AEAD so multi-gigabyte backups
 * can be encrypted and decrypted without holding them in memory, while still detecting
 * tampering, reordering and truncation.
 *
 *   header:  "NXB1" (4) | fileSalt (16) | noncePrefix (4)
 *   chunk:   length (4, big-endian, of ciphertext) | ciphertext | tag (16)
 * Each chunk uses AES-256-GCM with nonce = noncePrefix || counter(8) and AAD = [final flag],
 * under a per-file key HKDF(backupKey, fileSalt). The last chunk has final flag 1.
 */
const MAGIC = Buffer.from("NXB1");
const HEADER_LEN = 4 + 16 + 4;
const CHUNK = 1024 * 1024;
const TAG = 16;

function fileKey(backupKey: Buffer, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", backupKey, salt, "nexus-backup-v1", 32));
}

function nonce(prefix: Buffer, counter: bigint): Buffer {
  const n = Buffer.alloc(12);
  prefix.copy(n, 0);
  n.writeBigUInt64BE(counter, 4);
  return n;
}

export class EncryptStream extends Transform {
  private buf = Buffer.alloc(0);
  private counter = 0n;
  private readonly key: Buffer;
  private readonly prefix: Buffer;

  constructor(backupKey: Buffer) {
    super();
    if (backupKey.length !== 32) throw new Error("Backup key must be 32 bytes.");
    const salt = randomBytes(16);
    this.prefix = randomBytes(4);
    this.key = fileKey(backupKey, salt);
    this.push(Buffer.concat([MAGIC, salt, this.prefix]));
  }

  private seal(plain: Buffer, final: boolean): Buffer {
    const c = createCipheriv("aes-256-gcm", this.key, nonce(this.prefix, this.counter++));
    c.setAAD(Buffer.from([final ? 1 : 0]));
    const ct = Buffer.concat([c.update(plain), c.final()]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(ct.length);
    return Buffer.concat([len, ct, c.getAuthTag()]);
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    // Keep at least one byte back so the true final chunk is always emitted in _flush.
    while (this.buf.length > CHUNK) {
      this.push(this.seal(this.buf.subarray(0, CHUNK), false));
      this.buf = this.buf.subarray(CHUNK);
    }
    cb();
  }

  override _flush(cb: TransformCallback): void {
    this.push(this.seal(this.buf, true));
    cb();
  }
}

export class DecryptStream extends Transform {
  private buf = Buffer.alloc(0);
  private key: Buffer | null = null;
  private prefix: Buffer | null = null;
  private counter = 0n;
  private sawFinal = false;

  constructor(private readonly backupKey: Buffer) {
    super();
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    try {
      this.drain();
      cb();
    } catch (e) {
      cb(e as Error);
    }
  }

  private drain(): void {
    if (!this.key) {
      if (this.buf.length < HEADER_LEN) return;
      if (!this.buf.subarray(0, 4).equals(MAGIC)) throw new Error("This file is not a Nexus backup.");
      this.key = fileKey(this.backupKey, this.buf.subarray(4, 20));
      this.prefix = Buffer.from(this.buf.subarray(20, 24));
      this.buf = this.buf.subarray(HEADER_LEN);
    }
    for (;;) {
      if (this.buf.length < 4) return;
      const len = this.buf.readUInt32BE(0);
      if (len > CHUNK + 64) throw new Error("The backup file is damaged.");
      if (this.buf.length < 4 + len + TAG) return;
      if (this.sawFinal) throw new Error("The backup file has unexpected extra data.");
      const ct = this.buf.subarray(4, 4 + len);
      const tag = this.buf.subarray(4 + len, 4 + len + TAG);
      this.buf = this.buf.subarray(4 + len + TAG);
      // A chunk is final iff it authenticates with final flag 1 — try that only when no data follows.
      const plain = this.open(ct, tag, this.buf.length === 0);
      this.push(plain);
    }
  }

  private open(ct: Buffer, tag: Buffer, maybeFinal: boolean): Buffer {
    const attempt = (final: boolean) => {
      const d = createDecipheriv("aes-256-gcm", this.key!, nonce(this.prefix!, this.counter));
      d.setAAD(Buffer.from([final ? 1 : 0]));
      d.setAuthTag(tag);
      return Buffer.concat([d.update(ct), d.final()]);
    };
    try {
      const p = attempt(false);
      this.counter++;
      return p;
    } catch {
      if (!maybeFinal) throw new Error("The backup could not be decrypted (wrong key or damaged file).");
      try {
        const p = attempt(true);
        this.counter++;
        this.sawFinal = true;
        return p;
      } catch {
        throw new Error("The backup could not be decrypted (wrong key or damaged file).");
      }
    }
  }

  override _flush(cb: TransformCallback): void {
    if (!this.key) return cb(new Error("This file is not a Nexus backup."));
    if (this.buf.length > 0 || !this.sawFinal) return cb(new Error("The backup file is incomplete (it may have been cut off while copying)."));
    cb();
  }
}
