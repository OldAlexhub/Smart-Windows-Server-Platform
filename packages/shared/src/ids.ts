import { randomBytes, randomUUID } from "node:crypto";

export const newId = (): string => randomUUID();

/** URL/hostname/identifier-safe slug: "Taxi Ops Backend!" -> "taxi-ops-backend". */
export function slugify(input: string, maxLength = 48): string {
  const slug = input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  return slug || "app";
}

/** Identifier safe for PostgreSQL database/role names: lowercase, starts with a letter, [a-z0-9_]. */
export function sqlIdentifier(input: string, maxLength = 48): string {
  let id = slugify(input, maxLength).replace(/-/g, "_");
  if (!/^[a-z]/.test(id)) id = `n_${id}`;
  return id.slice(0, maxLength);
}

/** URL-safe random token with the given entropy in bytes. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
