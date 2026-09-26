import { BSON, MongoClient, type Document } from "mongodb";
import { NexusError } from "@nexus/shared";

const { ObjectId } = BSON;

/**
 * Moving data into Nexus without losing types.
 *
 * Data exported to JSON files often loses MongoDB's types: ObjectIds and dates become plain text,
 * and apps then can't find documents by id or group them by date. Nexus restores them on import,
 * can repair collections that were already imported, and can copy straight from another MongoDB so
 * nothing is lost in the first place.
 */

/** A full ISO-8601 timestamp (date and time), as JavaScript and MongoDB exports write them. */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;
const OBJECT_ID_TEXT = /^[0-9a-f]{24}$/i;
/** Field names that hold another document's id: _id, userId, user_id, ownerID, tagIds, post_ids… */
const ID_FIELD = /^(_id|.*(Id|ID|_id))$/;
const ID_LIST_FIELD = /^.*(Ids|IDs|_ids)$/;

export interface TypeChanges {
  ids: number;
  references: number;
  dates: number;
}

const none = (): TypeChanges => ({ ids: 0, references: 0, dates: 0 });

/**
 * Returns a copy with text ObjectIds and text timestamps turned back into real types. A text
 * reference (userId: "6a79…") only becomes an ObjectId when `knownIds` holds that id — it really
 * points at a document — so ordinary text that happens to look like an id is left alone.
 */
export function restoreTypes(doc: Document, changes: TypeChanges = none(), knownIds?: Set<string>): { doc: Document; changes: TypeChanges } {
  const isRef = (v: string) => !knownIds || knownIds.has(v.toLowerCase());
  const walk = (value: unknown, key: string, depth: number, top: boolean): unknown => {
    if (typeof value === "string") {
      if (OBJECT_ID_TEXT.test(value) && top && key === "_id") {
        changes.ids++;
        return new ObjectId(value);
      }
      // Nested _id (Mongoose sub-documents) is always an ObjectId; other id fields only when they point somewhere.
      if (OBJECT_ID_TEXT.test(value) && (key === "_id" || (ID_FIELD.test(key) && isRef(value)))) {
        changes.references++;
        return new ObjectId(value);
      }
      if (ISO_TIMESTAMP.test(value)) {
        const d = new Date(value);
        if (!Number.isNaN(d.getTime())) {
          changes.dates++;
          return d;
        }
      }
      return value;
    }
    if (depth > 20 || value === null || typeof value !== "object") return value;
    if (value instanceof Date || (value as { _bsontype?: string })._bsontype) return value;
    if (Array.isArray(value)) {
      const listOfIds = ID_LIST_FIELD.test(key);
      return value.map((v) => (listOfIds && typeof v === "string" && OBJECT_ID_TEXT.test(v) && isRef(v) ? (changes.references++, new ObjectId(v)) : walk(v, key, depth + 1, false)));
    }
    const out: Document = {};
    for (const [k, v] of Object.entries(value as Document)) out[k] = walk(v, k, depth + 1, false);
    return out;
  };
  const out: Document = {};
  for (const [k, v] of Object.entries(doc)) out[k] = walk(v, k, 0, true);
  return { doc: out, changes };
}

export interface TypeReport extends TypeChanges {
  /** Documents that would change. */
  documents: number;
  scanned: number;
}

const SCAN_LIMIT = 200_000;

/** Every document id in the database (ObjectIds, and text that is exactly an ObjectId), as lowercase hex. */
export async function knownIds(c: MongoClient, dbName: string): Promise<Set<string>> {
  const ids = new Set<string>();
  const db = c.db(dbName);
  for (const info of await db.listCollections({}, { nameOnly: true }).toArray()) {
    if (info.name.startsWith("system.")) continue;
    for await (const d of db.collection(info.name).find({}, { projection: { _id: 1 } }).limit(SCAN_LIMIT)) {
      const raw: unknown = d._id;
      const id = raw instanceof ObjectId ? raw.toHexString() : typeof raw === "string" && OBJECT_ID_TEXT.test(raw) ? raw.toLowerCase() : null;
      if (id) ids.add(id);
    }
  }
  return ids;
}

/** What "Fix types" would change in a collection (nothing is changed). */
export async function typeReport(c: MongoClient, dbName: string, collection: string): Promise<TypeReport> {
  const report: TypeReport = { ...none(), documents: 0, scanned: 0 };
  const known = await knownIds(c, dbName);
  for await (const d of c.db(dbName).collection(collection).find({}).limit(SCAN_LIMIT)) {
    report.scanned++;
    const changes = none();
    restoreTypes(d, changes, known);
    if (changes.ids + changes.references + changes.dates) {
      report.documents++;
      report.ids += changes.ids;
      report.references += changes.references;
      report.dates += changes.dates;
    }
  }
  return report;
}

const REPAIR_BATCH = 500;

/**
 * Restores types in place, 500 documents at a time: the old copies are removed and the corrected
 * ones written back (FerretDB replaces documents one by one at ~60 ms each, but deletes and inserts
 * a whole batch in ~50 ms, so tens of thousands of visits or events take seconds, not minutes).
 * A document that can't be written back is put back exactly as it was. When a text _id becomes an
 * ObjectId that a separate document already has, that text copy is left alone.
 */
export async function repairTypes(c: MongoClient, dbName: string, collection: string): Promise<{ fixed: number; skipped: number; failed: number }> {
  const coll = c.db(dbName).collection(collection);
  const known = await knownIds(c, dbName);
  const pending: { before: Document; after: Document; newId: boolean }[] = [];
  for await (const d of coll.find({}).limit(SCAN_LIMIT)) {
    const changes = none();
    const { doc } = restoreTypes(d, changes, known);
    if (changes.ids + changes.references + changes.dates) pending.push({ before: d, after: doc, newId: changes.ids > 0 });
  }
  let fixed = 0;
  let skipped = 0;
  let failed = 0;
  for (let i = 0; i < pending.length; i += REPAIR_BATCH) {
    let batch = pending.slice(i, i + REPAIR_BATCH);
    const newIds = batch.filter((p) => p.newId).map((p) => p.after._id);
    if (newIds.length) {
      // FerretDB matches "6a79…" and ObjectId("6a79…") alike, so only real ObjectIds count as a clash.
      const taken = new Set(
        (await coll.find({ _id: { $in: newIds } }, { projection: { _id: 1 } }).toArray()).filter((d) => d._id instanceof ObjectId).map((d) => String(d._id)),
      );
      const before = batch.length;
      batch = batch.filter((p) => !p.newId || !taken.has(String(p.after._id)));
      skipped += before - batch.length;
    }
    if (!batch.length) continue;
    await coll.deleteMany({ _id: { $in: batch.map((p) => p.before._id) } });
    try {
      const r = await coll.insertMany(batch.map((p) => p.after), { ordered: false });
      fixed += r.insertedCount;
    } catch (e) {
      const err = e as { insertedIds?: Record<number, unknown>; writeErrors?: { index: number }[] | { index: number } };
      const writeErrors = Array.isArray(err.writeErrors) ? err.writeErrors : err.writeErrors ? [err.writeErrors] : [];
      const bad = new Set(writeErrors.map((w) => w.index));
      if (!bad.size) {
        // Nothing reported per document: put the whole batch back as it was.
        await coll.insertMany(batch.map((p) => p.before), { ordered: false }).catch(() => undefined);
        failed += batch.length;
        continue;
      }
      await coll.insertMany(batch.filter((_, n) => bad.has(n)).map((p) => p.before), { ordered: false }).catch(() => undefined);
      fixed += batch.length - bad.size;
      failed += bad.size;
    }
  }
  return { fixed, skipped, failed };
}

// ---------------------------------------------------------------- copy from another MongoDB

export interface CopyProgress {
  collection: string;
  copied: number;
  total: number;
}

export interface CopyResult {
  source: string;
  collections: { name: string; documents: number; skipped: number; indexes: number; indexErrors: string[] }[];
}

/** Hides the password in a connection address, for messages and the audit trail. */
export function redactUrl(url: string): string {
  return url.replace(/(\/\/[^:/@]+:)[^@]*@/, "$1••••@");
}

/**
 * Copies every collection (documents with their exact types, and indexes) from another MongoDB —
 * Atlas, a local server, anything with a mongodb:// or mongodb+srv:// address — into a Nexus
 * database. Existing documents with the same _id are left alone, so it can safely run again.
 */
export async function copyFromMongo(
  sourceUrl: string,
  target: { client: MongoClient; dbName: string },
  opts: { sourceDb?: string | null; onProgress?: (p: CopyProgress) => void; onCollection?: (name: string) => void } = {},
): Promise<CopyResult> {
  if (!/^mongodb(\+srv)?:\/\//.test(sourceUrl.trim())) throw NexusError.invalid("Paste a MongoDB address that starts with mongodb:// or mongodb+srv://.");
  const source = new MongoClient(sourceUrl.trim(), { serverSelectionTimeoutMS: 15_000, connectTimeoutMS: 15_000 });
  try {
    try {
      await source.connect();
    } catch (e) {
      const msg = (e as Error).message;
      if (/auth|Authentication/i.test(msg)) throw NexusError.invalid("The other MongoDB refused the username or password in that address.");
      if (/ENOTFOUND|querySrv|getaddrinfo/i.test(msg)) throw NexusError.invalid("That MongoDB address couldn't be found. Check it, and that this computer is online.");
      if (/timed out|Server selection/i.test(msg)) throw NexusError.invalid("The other MongoDB didn't answer. If it's MongoDB Atlas, allow this computer's IP address under Network Access, then try again.");
      throw NexusError.invalid(`Couldn't connect to the other MongoDB: ${msg.split("\n")[0]}`);
    }
    const db = source.db(opts.sourceDb?.trim() || undefined);
    const infos = (await db.listCollections({}, { nameOnly: false }).toArray()).filter((x) => x.type !== "view" && !x.name.startsWith("system.") && x.name !== "_nexus");
    if (!infos.length) throw NexusError.invalid(`The database "${db.databaseName}" on the other MongoDB has no collections. Check the database name.`);
    const result: CopyResult = { source: redactUrl(sourceUrl), collections: [] };
    for (const info of infos) {
      const name = info.name;
      opts.onCollection?.(name);
      const from = db.collection(name);
      const to = target.client.db(target.dbName).collection(name);
      const total = await from.estimatedDocumentCount().catch(() => 0);
      let copied = 0;
      let skipped = 0;
      let batch: Document[] = [];
      const flush = async () => {
        if (!batch.length) return;
        try {
          const r = await to.insertMany(batch, { ordered: false });
          copied += r.insertedCount;
        } catch (e) {
          const err = e as { insertedCount?: number; result?: { insertedCount?: number }; writeErrors?: { code?: number }[] | { code?: number } };
          const writeErrors = Array.isArray(err.writeErrors) ? err.writeErrors : err.writeErrors ? [err.writeErrors] : [];
          if (!writeErrors.length) throw e;
          copied += err.insertedCount ?? err.result?.insertedCount ?? 0;
          skipped += writeErrors.filter((w) => w.code === 11000).length;
        }
        batch = [];
        opts.onProgress?.({ collection: name, copied: copied + skipped, total });
      };
      for await (const d of from.find({}).batchSize(1000)) {
        batch.push(d);
        if (batch.length >= 1000) await flush();
      }
      await flush();
      let indexes = 0;
      const indexErrors: string[] = [];
      for (const ix of await from.indexes().catch(() => [])) {
        if (ix.name === "_id_") continue;
        const { key, name: ixName, unique, sparse, expireAfterSeconds, partialFilterExpression } = ix as Document;
        try {
          await to.createIndex(key, { name: ixName, ...(unique ? { unique } : {}), ...(sparse ? { sparse } : {}), ...(expireAfterSeconds !== undefined ? { expireAfterSeconds } : {}), ...(partialFilterExpression ? { partialFilterExpression } : {}) });
          indexes++;
        } catch (e) {
          indexErrors.push(`${ixName}: ${(e as Error).message.split("\n")[0]}`);
        }
      }
      result.collections.push({ name, documents: copied, skipped, indexes, indexErrors });
    }
    return result;
  } finally {
    await source.close().catch(() => undefined);
  }
}
