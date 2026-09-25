import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { BSON, type Document, type MongoClient } from "mongodb";
import { NexusError } from "@nexus/shared";
import type { DocumentDatabaseManager } from "./documents";

const { EJSON } = BSON;

export interface CollectionSummary {
  name: string;
  documents: number;
  sizeBytes: number;
  indexes: number;
}

export interface DocumentPage {
  /** Documents as relaxed Extended JSON (ObjectId → {"$oid"}, dates → {"$date"}), ready to show and edit. */
  documents: Record<string, unknown>[];
  total: number;
  skip: number;
  limit: number;
}

/** Marker collection Nexus uses so an empty database still exists. Hidden from people. */
const INTERNAL = "_nexus";
const MAX_LIMIT = 200;
/** Operators that run JavaScript on the server. Refused here, and the server itself runs with --noscripting. */
const FORBIDDEN_OPERATORS = new Set(["$where", "$function", "$accumulator"]);

/** Collection names people may create: MongoDB's own rules, minus the ones that confuse tools. */
export function validCollectionName(name: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9_. -]{0,119}$/.test(name) && !name.startsWith("system.") && name !== INTERNAL && !name.includes("..");
}

function assertCollectionName(name: string): void {
  if (!validCollectionName(name)) throw NexusError.invalid("Use letters, numbers, spaces, dots, dashes or underscores for the collection name.");
}

function assertSafe(value: unknown, depth = 0): void {
  if (depth > 40) throw NexusError.invalid("That filter is nested too deeply.");
  if (Array.isArray(value)) return value.forEach((v) => assertSafe(v, depth + 1));
  if (value && typeof value === "object" && value.constructor === Object) {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_OPERATORS.has(k)) throw NexusError.invalid(`${k} isn't allowed: it would run code on the server.`);
      assertSafe(v, depth + 1);
    }
  }
}

/** Parses a filter typed by a person, e.g. {"status": "open", "total": {"$gt": 100}}. Extended JSON ({"$oid": …}) works. */
export function parseFilter(text: string | undefined | null): Document {
  if (!text || !text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = EJSON.parse(text, { relaxed: true });
  } catch {
    throw NexusError.invalid("That filter isn't valid JSON. Example: {\"status\": \"open\"}");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw NexusError.invalid("A filter must be a JSON object, like {\"status\": \"open\"}.");
  assertSafe(parsed);
  return parsed as Document;
}

/** Turns a document typed or edited by a person into a BSON document (Extended JSON supported). */
export function parseDocument(input: unknown): Document {
  let doc: unknown;
  try {
    doc = typeof input === "string" ? EJSON.parse(input, { relaxed: true }) : EJSON.deserialize(input as Document, { relaxed: true });
  } catch {
    throw NexusError.invalid("That document isn't valid JSON.");
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw NexusError.invalid("A document must be a JSON object.");
  assertSafe(doc);
  return doc as Document;
}

/** The `_id` of a document as shown in the UI (Extended JSON) → the real value. */
export function parseId(id: unknown): unknown {
  try {
    return EJSON.deserialize({ v: id } as Document, { relaxed: true }).v;
  } catch {
    throw NexusError.invalid("That document id isn't valid.");
  }
}

const toView = (d: Document) => EJSON.serialize(d, { relaxed: true }) as Record<string, unknown>;

/**
 * Browse, edit, import and export for document databases — the MongoDB counterpart of DataBrowser.
 * Always goes through Nexus's administrator connection, limited to the one database in question.
 */
export class DocumentBrowser {
  constructor(private readonly docs: DocumentDatabaseManager) {}

  private async inDb<T>(databaseId: string, fn: (c: MongoClient, dbName: string) => Promise<T>): Promise<T> {
    return this.docs.withDatabase(databaseId, fn);
  }

  async collections(databaseId: string): Promise<CollectionSummary[]> {
    return this.inDb(databaseId, async (c, dbName) => {
      const db = c.db(dbName);
      const names = (await db.listCollections({ type: "collection" }, { nameOnly: true }).toArray())
        .map((x) => x.name)
        .filter((n) => n !== INTERNAL && !n.startsWith("system."))
        .sort((a, b) => a.localeCompare(b));
      return Promise.all(
        names.map(async (name) => {
          const [stats] = await db
            .collection(name)
            .aggregate<{ storageStats?: { size?: number; nindexes?: number; count?: number } }>([{ $collStats: { storageStats: {} } }])
            .toArray();
          return {
            name,
            documents: stats?.storageStats?.count ?? (await db.collection(name).estimatedDocumentCount()),
            sizeBytes: stats?.storageStats?.size ?? 0,
            indexes: stats?.storageStats?.nindexes ?? 0,
          };
        }),
      );
    });
  }

  async stats(databaseId: string): Promise<{ sizeBytes: number; collections: number; documents: number }> {
    return this.inDb(databaseId, async (c, dbName) => {
      const s = await c.db(dbName).stats();
      const hasMarker = (await c.db(dbName).listCollections({ name: INTERNAL }, { nameOnly: true }).toArray()).length;
      return { sizeBytes: Number(s.storageSize ?? 0) + Number(s.indexSize ?? 0), collections: Math.max(0, Number(s.collections ?? 0) - hasMarker), documents: Math.max(0, Number(s.objects ?? 0) - hasMarker) };
    });
  }

  async find(databaseId: string, collection: string, opts: { filter?: string; skip?: number; limit?: number } = {}): Promise<DocumentPage> {
    assertCollectionName(collection);
    const filter = parseFilter(opts.filter);
    const skip = Math.max(0, Math.floor(opts.skip ?? 0));
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(opts.limit ?? 50)));
    return this.inDb(databaseId, async (c, dbName) => {
      const coll = c.db(dbName).collection(collection);
      const [docs, total] = await Promise.all([
        coll.find(filter, { skip, limit, sort: { _id: 1 }, maxTimeMS: 15_000 }).toArray(),
        coll.countDocuments(filter, { maxTimeMS: 15_000 }),
      ]);
      return { documents: docs.map(toView), total, skip, limit };
    });
  }

  async insert(databaseId: string, collection: string, input: unknown): Promise<Record<string, unknown>> {
    assertCollectionName(collection);
    const doc = parseDocument(input);
    return this.inDb(databaseId, async (c, dbName) => {
      const coll = c.db(dbName).collection(collection);
      const r = await coll.insertOne(doc);
      return toView((await coll.findOne({ _id: r.insertedId }))!);
    });
  }

  /** Replaces a whole document (the editor shows the full document). The _id never changes. */
  async replace(databaseId: string, collection: string, id: unknown, input: unknown): Promise<Record<string, unknown>> {
    assertCollectionName(collection);
    const _id = parseId(id);
    const { _id: ignored, ...doc } = parseDocument(input);
    void ignored;
    return this.inDb(databaseId, async (c, dbName) => {
      const coll = c.db(dbName).collection(collection);
      const r = await coll.replaceOne({ _id: _id as never }, doc);
      if (!r.matchedCount) throw NexusError.notFound("Document");
      return toView((await coll.findOne({ _id: _id as never }))!);
    });
  }

  async remove(databaseId: string, collection: string, id: unknown): Promise<void> {
    assertCollectionName(collection);
    const _id = parseId(id);
    await this.inDb(databaseId, async (c, dbName) => {
      const r = await c.db(dbName).collection(collection).deleteOne({ _id: _id as never });
      if (!r.deletedCount) throw NexusError.notFound("Document");
    });
  }

  async createCollection(databaseId: string, name: string): Promise<void> {
    assertCollectionName(name);
    await this.inDb(databaseId, async (c, dbName) => {
      const exists = await c.db(dbName).listCollections({ name }, { nameOnly: true }).hasNext();
      if (exists) throw NexusError.conflict(`There is already a collection called ${name}.`);
      await c.db(dbName).createCollection(name);
    });
  }

  /** Deletes a collection and its documents. The caller obtains typed confirmation. */
  async dropCollection(databaseId: string, name: string, confirmation: string): Promise<void> {
    assertCollectionName(name);
    if (confirmation !== name) throw NexusError.invalid(`Type "${name}" to confirm deleting this collection.`);
    await this.inDb(databaseId, (c, dbName) => c.db(dbName).collection(name).drop());
  }

  /** Streams a collection as a JSON array (relaxed Extended JSON, the same format mongoexport --jsonArray uses). */
  async *exportJson(databaseId: string, collection: string, filterText?: string): AsyncGenerator<string> {
    assertCollectionName(collection);
    const filter = parseFilter(filterText);
    const db = this.docs.require(databaseId);
    const c = await this.docs.openClient(databaseId);
    try {
      yield "[\n";
      let first = true;
      for await (const d of c.db(db.dbName).collection(collection).find(filter, { sort: { _id: 1 } })) {
        yield `${first ? "" : ",\n"}${EJSON.stringify(d, { relaxed: true })}`;
        first = false;
      }
      yield "\n]\n";
    } finally {
      await c.close();
    }
  }

  /**
   * Imports documents from a JSON array or JSON Lines (one document per line). Existing documents
   * with the same _id are left alone and reported, so importing twice never duplicates.
   */
  async importJson(databaseId: string, collection: string, text: string): Promise<{ inserted: number; skipped: number; errors: string[] }> {
    assertCollectionName(collection);
    let docs: Document[];
    const trimmed = text.trim();
    try {
      if (trimmed.startsWith("[")) {
        docs = EJSON.parse(trimmed, { relaxed: true }) as Document[];
      } else {
        docs = trimmed
          .split(/\r?\n/)
          .filter((l) => l.trim())
          .map((l) => EJSON.parse(l, { relaxed: true }) as Document);
      }
    } catch {
      throw NexusError.invalid("That file isn't valid JSON. Use a JSON array of documents, or one document per line.");
    }
    if (!Array.isArray(docs) || docs.some((d) => !d || typeof d !== "object" || Array.isArray(d))) {
      throw NexusError.invalid("Every entry in the file must be a JSON object (a document).");
    }
    docs.forEach((d) => assertSafe(d));
    if (!docs.length) return { inserted: 0, skipped: 0, errors: [] };
    return this.inDb(databaseId, async (c, dbName) => {
      const coll = c.db(dbName).collection(collection);
      let inserted = 0;
      let skipped = 0;
      const errors: string[] = [];
      for (let i = 0; i < docs.length; i += 1000) {
        try {
          const r = await coll.insertMany(docs.slice(i, i + 1000), { ordered: false });
          inserted += r.insertedCount;
        } catch (e) {
          const err = e as { insertedCount?: number; result?: { insertedCount?: number }; writeErrors?: { code?: number; errmsg?: string }[] | { code?: number; errmsg?: string } };
          inserted += err.insertedCount ?? err.result?.insertedCount ?? 0;
          const writeErrors = Array.isArray(err.writeErrors) ? err.writeErrors : err.writeErrors ? [err.writeErrors] : [];
          if (!writeErrors.length) throw e;
          for (const w of writeErrors) {
            if (w.code === 11000) skipped++;
            else if (errors.length < 10) errors.push(w.errmsg ?? "Could not insert a document.");
          }
        }
      }
      return { inserted, skipped, errors };
    });
  }

  // ---------------------------------------------------------------- backup & restore

  /**
   * Writes the whole database into `dir` for a backup:
   *   collections.json — names, options (validators, capped…) and index definitions
   *   c0001.ejsonl…    — one document per line in canonical Extended JSON (exact types preserved)
   */
  async exportDatabase(databaseId: string, dir: string): Promise<{ collections: number; documents: number }> {
    mkdirSync(dir, { recursive: true });
    return this.inDb(databaseId, async (c, dbName) => {
      const db = c.db(dbName);
      const infos = (await db.listCollections({ type: "collection" }).toArray()).filter((x) => !x.name.startsWith("system."));
      const index: { name: string; file: string; options: Document; indexes: Document[] }[] = [];
      let documents = 0;
      for (const [i, info] of infos.entries()) {
        const file = `c${String(i + 1).padStart(4, "0")}.ejsonl`;
        const out = createWriteStream(join(dir, file));
        for await (const d of db.collection(info.name).find({}, { sort: { _id: 1 } })) {
          if (!out.write(EJSON.stringify(d, { relaxed: false }) + "\n")) await once(out, "drain");
          documents++;
        }
        out.end();
        await once(out, "finish");
        const indexes = (await db.collection(info.name).indexes()).filter((ix) => ix.name !== "_id_");
        index.push({ name: info.name, file, options: EJSON.serialize((info as { options?: Document }).options ?? {}, { relaxed: false }), indexes: indexes.map((ix) => EJSON.serialize(ix, { relaxed: false })) });
      }
      writeFileSync(join(dir, "collections.json"), JSON.stringify({ format: "nexus-documents", version: 1, collections: index }, null, 2));
      return { collections: index.length, documents };
    });
  }

  /** Replaces the database's contents with a backup written by exportDatabase. Users and access stay as they are. */
  async importDatabase(databaseId: string, dir: string): Promise<{ collections: number; documents: number }> {
    const indexFile = join(dir, "collections.json");
    if (!existsSync(indexFile)) throw NexusError.invalid("This backup doesn't contain a document database.");
    const meta = JSON.parse(readFileSync(indexFile, "utf8")) as { format: string; collections: { name: string; file: string; options: Document; indexes: Document[] }[] };
    if (meta.format !== "nexus-documents") throw NexusError.invalid("This backup's document export isn't in a format Nexus understands.");
    return this.inDb(databaseId, async (c, dbName) => {
      const db = c.db(dbName);
      for (const x of await db.listCollections({}, { nameOnly: true }).toArray()) {
        if (!x.name.startsWith("system.")) await db.collection(x.name).drop();
      }
      let documents = 0;
      for (const col of meta.collections) {
        await db.createCollection(col.name, EJSON.deserialize(col.options, { relaxed: false }));
        const coll = db.collection(col.name);
        let batch: Document[] = [];
        const lines = createInterface({ input: createReadStream(join(dir, col.file)), crlfDelay: Infinity });
        for await (const line of lines) {
          if (!line.trim()) continue;
          batch.push(EJSON.parse(line, { relaxed: false }) as Document);
          if (batch.length === 1000) {
            await coll.insertMany(batch, { ordered: true });
            documents += batch.length;
            batch = [];
          }
        }
        if (batch.length) {
          await coll.insertMany(batch, { ordered: true });
          documents += batch.length;
        }
        for (const raw of col.indexes) {
          const { key, v: _v, ns: _ns, ...options } = EJSON.deserialize(raw, { relaxed: false }) as Document;
          void _v;
          void _ns;
          await coll.createIndex(key, options);
        }
      }
      return { collections: meta.collections.length, documents };
    });
  }

}
