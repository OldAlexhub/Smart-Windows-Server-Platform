import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "@nexus/state";
import { AppTokens } from "@nexus/security";
import { downloadHeaders, guessContentType, normalizeFolder, safeFileName, StorageManager } from "@nexus/storage";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
function setup(opts = {}) {
  const root = mkdtempSync(join(tmpdir(), "nexus-store-"));
  dirs.push(root);
  const store = StateStore.memory();
  return { storage: new StorageManager(store, root, opts), store, root };
}
const body = (s: string | Buffer) => Readable.from([Buffer.from(s)]);

describe("helpers", () => {
  it("normalises folders and file names safely", () => {
    expect(normalizeFolder("/invoices\\2026/ ")).toBe("invoices/2026");
    expect(() => normalizeFolder("../other-app")).toThrow(/isn't allowed/);
    expect(safeFileName("C:\\Users\\x\\Invoice #12.pdf")).toBe("Invoice #12.pdf");
    expect(safeFileName("a<b>.txt")).toBe("a_b_.txt");
    expect(() => safeFileName("..")).toThrow();
  });
  it("guesses content types", () => {
    expect(guessContentType("scan.PDF")).toBe("application/pdf");
    expect(guessContentType("x.bin", "image/png; charset=binary")).toBe("image/png");
    expect(guessContentType("unknown.xyz")).toBe("application/octet-stream");
  });
  it("never serves active content inline", () => {
    const o = { id: "1", appId: "a", folder: "", name: "evil.html", contentType: "text/html", size: 5, sha256: "h", createdAt: "", createdBy: null, metadata: {} };
    const h = downloadHeaders(o);
    expect(h["Content-Type"]).toBe("application/octet-stream");
    expect(h["Content-Disposition"]).toMatch(/^attachment;/);
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(downloadHeaders({ ...o, name: "photo.jpg", contentType: "image/jpeg" })["Content-Disposition"]).toMatch(/^inline;/);
    expect(downloadHeaders({ ...o, name: "façture.pdf", contentType: "application/pdf" })["Content-Disposition"]).toContain("filename*=UTF-8''fa%C3%A7ture.pdf");
  });
});

describe("StorageManager", () => {
  it("stores, lists, reads and deletes documents", async () => {
    const { storage } = setup();
    const o = await storage.put("taxiops", { name: "Invoice-001.pdf", folder: "invoices/2026", createdBy: "user:owner" }, body("%PDF-1.7 fake"));
    expect(o).toMatchObject({ appId: "taxiops", folder: "invoices/2026", name: "Invoice-001.pdf", contentType: "application/pdf", size: 13 });
    expect(o.sha256).toMatch(/^[0-9a-f]{64}$/);

    await storage.put("taxiops", { name: "driver-photo.jpg", folder: "photos" }, body("jpegdata"));
    const root = storage.list("taxiops", { folder: "" });
    expect(root.folders).toEqual(["invoices", "photos"]);
    expect(storage.list("taxiops", { folder: "invoices" }).folders).toEqual(["2026"]);
    expect(storage.list("taxiops", { search: "invoice" }).objects.map((x) => x.name)).toEqual(["Invoice-001.pdf"]);

    const { stream } = storage.open("taxiops", o.id);
    expect(await text(stream)).toBe("%PDF-1.7 fake");
    expect(storage.usage("taxiops")).toEqual({ bytes: 21, objects: 2, quotaBytes: null });

    storage.delete("taxiops", o.id);
    expect(() => storage.head("taxiops", o.id)).toThrow(/not found/);
  });

  it("isolates applications: another app's files look like missing files", async () => {
    const { storage } = setup();
    const o = await storage.put("taxiops", { name: "secret.pdf" }, body("x"));
    expect(() => storage.open("finance", o.id)).toThrow(/not found/);
    expect(() => storage.delete("finance", o.id)).toThrow(/not found/);
    expect(storage.list("finance").objects).toEqual([]);
  });

  it("enforces size limits and quotas without leaving partial files", async () => {
    const { storage, root } = setup({ maxObjectBytes: 10 });
    await expect(storage.put("a", { name: "big.bin" }, body("01234567890"))).rejects.toThrow(/too large/);
    storage.setQuota("a", 8);
    await storage.put("a", { name: "one.txt" }, body("12345"));
    await expect(storage.put("a", { name: "two.txt" }, body("12345"))).rejects.toThrow(/storage is full/);
    const leftovers = readdirSync(join(root, "a", "objects"), { recursive: true }).filter((f) => String(f).endsWith(".part"));
    expect(leftovers).toEqual([]);
    expect(storage.usage("a").objects).toBe(1);
  });

  it("gives apps a persistent upload folder outside their release", () => {
    const { storage, root } = setup();
    const d = storage.persistentDir("taxiops");
    expect(d).toBe(join(root, "taxiops", "local"));
    expect(existsSync(d)).toBe(true);
    expect(() => storage.persistentDir("../evil")).toThrow();
  });
});

describe("AppTokens (per-app credentials)", () => {
  it("issues scoped tokens, verifies, and enforces app boundaries", () => {
    const tokens = new AppTokens(StateStore.memory());
    const { token } = tokens.issue("taxiops", "Automatic");
    expect(token).toMatch(/^nxs_[A-Za-z0-9_-]{43}$/);
    const p = tokens.verify(token)!;
    expect(p).toMatchObject({ appId: "taxiops", scopes: expect.arrayContaining(["storage:read", "storage:write"]) });
    expect(AppTokens.assert(p, "storage:write", "taxiops").appId).toBe("taxiops");
    expect(() => AppTokens.assert(p, "storage:read", "finance")).toThrow(/own resources/);
    expect(() => AppTokens.assert(p, "ai:infer")).toThrow(/not allowed/);
    expect(() => AppTokens.assert(null, "storage:read")).toThrow(/credential is required/);
    expect(tokens.verify("nxs_forged")).toBeNull();
    tokens.revokeAll("taxiops");
    expect(tokens.verify(token)).toBeNull();
    expect(tokens.list("taxiops")[0]).toMatchObject({ label: "Automatic", revoked: true });
  });
});
