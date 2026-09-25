import { randomBytes, scrypt as scryptCb, type ScryptOptions } from "node:crypto";
import { constantTimeEqual } from "./crypto";

const scrypt = (password: string, salt: Buffer, keylen: number, opts: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) =>
    scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );

/** scrypt parameters (N=2^15, r=8, p=1 → ~32 MiB, ~50-100 ms on modern CPUs). */
const DEFAULTS = { N: 1 << 15, r: 8, p: 1 };
const KEYLEN = 32;

/** Encoded as: scrypt$N$r$p$saltB64$hashB64 */
export async function hashPassword(password: string, params = DEFAULTS): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password.normalize("NFKC"), salt, KEYLEN, { ...params, maxmem: 128 * params.N * params.r * 2 });
  return ["scrypt", params.N, params.r, params.p, salt.toString("base64"), hash.toString("base64")].join("$");
}

export async function verifyPassword(password: string, encoded: string | null | undefined): Promise<boolean> {
  if (!encoded) return false;
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const N = Number(n);
  const params = { N, r: Number(r), p: Number(p), maxmem: 128 * N * Number(r) * 2 };
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scrypt(password.normalize("NFKC"), Buffer.from(saltB64, "base64"), expected.length, params);
  return constantTimeEqual(actual, expected);
}

export interface PasswordCheck {
  acceptable: boolean;
  problems: string[];
}

const COMMON = new Set(["password", "password123", "123456789012", "qwertyuiop12", "letmein12345", "administrator"]);

/** Plain-language password policy: length first, no forced symbol soup. */
export function checkPasswordStrength(password: string, context: string[] = []): PasswordCheck {
  const problems: string[] = [];
  if (password.length < 12) problems.push("Use at least 12 characters.");
  if (password.length > 256) problems.push("Use at most 256 characters.");
  if (COMMON.has(password.toLowerCase())) problems.push("This password is too common.");
  if (/^(.)\1+$/.test(password)) problems.push("Avoid repeating a single character.");
  const lower = password.toLowerCase();
  for (const c of context) {
    if (c && c.length >= 3 && lower.includes(c.toLowerCase())) problems.push("Don't include your name or username.");
  }
  if (new Set(password).size < 5) problems.push("Use a wider variety of characters.");
  return { acceptable: problems.length === 0, problems: [...new Set(problems)] };
}
