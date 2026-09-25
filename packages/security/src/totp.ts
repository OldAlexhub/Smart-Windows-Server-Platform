import { createHmac, randomBytes } from "node:crypto";
import { constantTimeEqual } from "./crypto";

/** RFC 4648 base32 (no padding) — the format authenticator apps expect. */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error("Invalid base32 character.");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export interface TotpOptions {
  digits?: number;
  period?: number;
  algorithm?: "sha1" | "sha256" | "sha512";
}

/** RFC 6238 TOTP code for the given secret (raw bytes) at time `atMs`. */
export function totpCode(secret: Buffer, atMs: number, opts: TotpOptions = {}): string {
  const { digits = 6, period = 30, algorithm = "sha1" } = opts;
  const counter = Math.floor(atMs / 1000 / period);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac(algorithm, secret).update(msg).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const bin =
    ((hmac[offset]! & 0x7f) << 24) | (hmac[offset + 1]! << 16) | (hmac[offset + 2]! << 8) | hmac[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/**
 * Verifies a code allowing ±`window` periods of clock drift.
 * Returns the matched time-step so callers can reject replays of the same step.
 */
export function verifyTotp(
  secret: Buffer,
  code: string,
  atMs: number,
  window = 1,
  opts: TotpOptions = {},
): number | null {
  const period = opts.period ?? 30;
  const normalized = code.replace(/\s/g, "");
  if (!/^\d{6,8}$/.test(normalized)) return null;
  for (let w = -window; w <= window; w++) {
    const t = atMs + w * period * 1000;
    if (constantTimeEqual(totpCode(secret, t, opts), normalized)) return Math.floor(t / 1000 / period);
  }
  return null;
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function otpauthUri(secretB32: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret: secretB32, issuer, algorithm: "SHA1", digits: "6", period: "30" });
  return `otpauth://totp/${label}?${params.toString()}`;
}
