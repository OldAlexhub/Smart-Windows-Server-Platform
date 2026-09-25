import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync, readdirSync, renameSync, rmSync, statSync, type Dirent, type ReadStream } from "node:fs";
import { join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { newId, NexusError } from "@nexus/shared";
import type { Migration, StateStore } from "@nexus/state";

export const storageMigrations: Migration[] = [
  {
    id: "storage/001_objects",
    up: `CREATE TABLE storage_objects (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      folder TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      content_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT,
      metadata TEXT
    );
    CREATE INDEX storage_app_folder ON storage_objects(app_id, folder, created_at);
    CREATE TABLE storage_quotas (
      app_id TEXT PRIMARY KEY,
      max_bytes INTEGER NOT NULL
    );`,
  },
];

export interface StoredObject {
  id: string;
  appId: string;
  folder: string;
  name: string;
  contentType: string;
  size: number;
  sha256: string;
  createdAt: string;
  createdBy: string | null;
  metadata: Record<string, string>;
}

export interface PutInput {
  name: string;
  contentType?: string;
  folder?: string;
  createdBy?: string | null;
  metadata?: Record<string, string>;
}

/** Content types that could run script in a browser are always downloaded, never displayed inline. */
const ACTIVE_CONTENT = /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml|application\/javascript|text\/javascript)/i;

const EXT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  csv: "text/csv",
  txt: "text/plain",
  json: "application/json",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  zip: "application/zip",
  html: "text/html",
  svg: "image/svg+xml",
};

export function guessContentType(name: string, declared?: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (declared && declared !== "application/octet-stream" && /^[\w.+-]+\/[\w.+-]+/.test(declared)) return declared.split(";")[0]!.trim();
  return EXT_TYPES[ext] ?? "application/octet-stream";
}

/** Normalised virtual folder: "invoices/2026" (no leading/trailing slashes, no "..", no backslashes). */
export function normalizeFolder(folder = ""): string {
  const parts = folder
    .replace(/\\/g, "/")
    .split("/")
    .map((p) => p.trim())
    .filter((p) => p && p !== ".");
  if (parts.some((p) => p === ".." || /[<>:"|?*\x00-\x1f]/.test(p))) throw NexusError.invalid("That folder name isn't allowed.");
  return parts.join("/");
}

export function safeFileName(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop()!.replace(/[\x00-\x1f<>:"|?*]/g, "_").trim();
  if (!base || base === "." || base === "..") throw NexusError.invalid("Please give the file a name.");
  return base.slice(0, 255);
}

/** Headers for serving a stored file safely (no stored-XSS through uploads). */
export function downloadHeaders(o: StoredObject, inline = true): Record<string, string> {
  const active = ACTIVE_CONTENT.test(o.contentType);
  const disposition = inline && !active ? "inline" : "attachment";
  const ascii = o.name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return {
    "Content-Type": active ? "application/octet-stream" : o.contentType,
    "Content-Length": String(o.size),
    "Content-Disposition": `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(o.name)}`,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    ETag: `"${o.sha256}"`,
  };
}

/**
 * Application file storage (documents, invoices, photos, reports, exports), separate from
 * PostgreSQL. Each app has its own bucket; an app can only ever reach its own objects.
 * Files are written to a temp file, hashed, then atomically moved into place.
 */
export class StorageManager {
  constructor(
    private readonly store: StateStore,
    private readonly root: string,
    private readonly opts: { maxObjectBytes?: number } = {},
  ) {
    store.migrate(storageMigrations);
    mkdirSync(root, { recursive: true });
  }

  /** Folder for apps that write uploads to disk themselves (e.g. UPLOAD_DIR). Survives redeploys; backed up. */
  persistentDir(appId: string): string {
    const d = join(this.root, safeId(appId), "local");
    mkdirSync(d, { recursive: true });
    return d;
  }

  bucketDir(appId: string): string {
    return join(this.root, safeId(appId), "objects");
  }

  private objectPath(appId: string, id: string): string {
    return join(this.bucketDir(appId), id.slice(0, 2), id);
  }

  setQuota(appId: string, maxBytes: number | null): void {
    if (maxBytes === null) this.store.run("DELETE FROM storage_quotas WHERE app_id = ?", [appId]);
    else
      this.store.run("INSERT INTO storage_quotas (app_id, max_bytes) VALUES (?, ?) ON CONFLICT(app_id) DO UPDATE SET max_bytes = excluded.max_bytes", [
        appId,
        maxBytes,
      ]);
  }

  usage(appId: string): { bytes: number; objects: number; quotaBytes: number | null } {
    const u = this.store.get<{ b: number | null; n: number }>("SELECT SUM(size) AS b, COUNT(*) AS n FROM storage_objects WHERE app_id = ?", [appId])!;
    const q = this.store.get<{ max_bytes: number }>("SELECT max_bytes FROM storage_quotas WHERE app_id = ?", [appId]);
    return { bytes: u.b ?? 0, objects: u.n, quotaBytes: q?.max_bytes ?? null };
  }

  async put(appId: string, input: PutInput, body: Readable): Promise<StoredObject> {
    const id = newId().replace(/-/g, "");
    const name = safeFileName(input.name);
    const folder = normalizeFolder(input.folder);
    const final = this.objectPath(appId, id);
    mkdirSync(join(final, ".."), { recursive: true });
    const tmp = `${final}.part`;
    const hash = createHash("sha256");
    const { quotaBytes, bytes: used } = this.usage(appId);
    const limit = Math.min(this.opts.maxObjectBytes ?? 5 * 1024 ** 3, quotaBytes !== null ? quotaBytes - used : Infinity);
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > limit) return cb(NexusError.invalid(quotaBytes !== null && limit === quotaBytes - used ? "This application's storage is full." : "That file is too large."));
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    try {
      await pipeline(body, meter, createWriteStream(tmp, { flags: "wx" }));
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
    renameSync(tmp, final);
    const o: StoredObject = {
      id,
      appId,
      folder,
      name,
      contentType: guessContentType(name, input.contentType),
      size,
      sha256: hash.digest("hex"),
      createdAt: new Date().toISOString(),
      createdBy: input.createdBy ?? null,
      metadata: input.metadata ?? {},
    };
    this.store.run(
      `INSERT INTO storage_objects (id, app_id, folder, name, content_type, size, sha256, created_at, created_by, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [o.id, appId, o.folder, o.name, o.contentType, o.size, o.sha256, o.createdAt, o.createdBy, JSON.stringify(o.metadata)],
    );
    return o;
  }

  /** Metadata for one of the app's objects. Objects of other apps are indistinguishable from missing ones. */
  head(appId: string, id: string): StoredObject {
    const r = this.store.get<Row>("SELECT * FROM storage_objects WHERE id = ? AND app_id = ?", [id, appId]);
    if (!r) throw NexusError.notFound("File");
    return toObject(r);
  }

  open(appId: string, id: string): { object: StoredObject; stream: ReadStream } {
    const object = this.head(appId, id);
    return { object, stream: createReadStream(this.objectPath(appId, id)) };
  }

  list(appId: string, q: { folder?: string; search?: string; limit?: number; before?: string } = {}): { objects: StoredObject[]; folders: string[] } {
    const folder = q.folder !== undefined ? normalizeFolder(q.folder) : undefined;
    const where = ["app_id = ?"];
    const params: (string | number)[] = [appId];
    if (folder !== undefined) (where.push("folder = ?"), params.push(folder));
    if (q.search) (where.push("name LIKE ? ESCAPE '\\'"), params.push(`%${q.search.replace(/[\\%_]/g, (m) => `\\${m}`)}%`));
    if (q.before) (where.push("created_at < ?"), params.push(q.before));
    params.push(Math.min(q.limit ?? 100, 1000));
    const objects = this.store.all<Row>(`SELECT * FROM storage_objects WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`, params).map(toObject);
    const prefix = folder ? `${folder}/` : "";
    const folders = [
      ...new Set(
        this.store
          .all<{ folder: string }>("SELECT DISTINCT folder FROM storage_objects WHERE app_id = ? AND folder LIKE ?", [appId, `${prefix}%`])
          .map((r) => r.folder.slice(prefix.length).split("/")[0]!)
          .filter(Boolean),
      ),
    ].sort();
    return { objects, folders };
  }

  delete(appId: string, id: string): void {
    this.head(appId, id);
    rmSync(this.objectPath(appId, id), { force: true });
    this.store.run("DELETE FROM storage_objects WHERE id = ? AND app_id = ?", [id, appId]);
  }

  /** Total bytes on disk for an app (objects + persistent upload folder), for the dashboard. */
  diskUsage(appId: string): number {
    return dirSize(join(this.root, safeId(appId)));
  }
}

function dirSize(dir: string): number {
  let total = 0;
  const walk = (d: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else
        try {
          total += statSync(p).size;
        } catch {
          /* raced */
        }
    }
  };
  walk(dir);
  return total;
}

const safeId = (appId: string) => {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(appId)) throw NexusError.invalid("Invalid application id.");
  return appId;
};

interface Row {
  id: string;
  app_id: string;
  folder: string;
  name: string;
  content_type: string;
  size: number;
  sha256: string;
  created_at: string;
  created_by: string | null;
  metadata: string | null;
}

function toObject(r: Row): StoredObject {
  return {
    id: r.id,
    appId: r.app_id,
    folder: r.folder,
    name: r.name,
    contentType: r.content_type,
    size: r.size,
    sha256: r.sha256,
    createdAt: r.created_at,
    createdBy: r.created_by,
    metadata: r.metadata ? JSON.parse(r.metadata) : {},
  };
}
