import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { BSON, type Document, type MongoClient } from "mongodb";
import { NexusError } from "@nexus/shared";
import type { DocumentDatabaseManager } from "./documents";
import { copyFromMongo, knownIds, repairTypes, restoreTypes, typeReport, type CopyProgress, type CopyResult, type TypeChanges, type TypeReport } from "./doc-migrate";

const { EJSON, ObjectId } = BSON;

export interface BsonTypeCounts {
  /** ObjectIds used as a document or nested-document _id. */
  objectIds: number;
  /** ObjectIds in all other fields, including arrays of references. */
  objectIdReferences: number;
  dates: number;
  decimal128: number;
}

export interface DocumentImportResult {
  inserted: number;
  skipped: number;
  errors: string[];
  errorCount: number;
  convertedIds: number;
  restored: TypeChanges;
  detected: {
    format: "mongodb_extended_json" | "json";
    documents: number;
    types: BsonTypeCounts;
  };
  /** BSON values recognised before insertion. The database round-trip is covered by engine tests. */
  preserved: BsonTypeCounts;
}

export interface DocumentBlueprint {
  collections: {
    name: string;
    documents: number;
    /** How many documents the field list was worked out from. */
    sampled: number;
    fields: { path: string; types: string[]; presence: number; references: string | null }[];
    indexes: { name: string; keys: string[]; unique: boolean }[];
  }[];
  relations: { from: { collection: string; field: string }; to: { collection: string; field: string } }[];
}

function typeOf(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (v instanceof ObjectId) return "ObjectId";
  if (v instanceof Date) return "date";
  if (Array.isArray(v)) return "array";
  const bsonType = (v as { _bsontype?: string })._bsontype;
  if (bsonType) return bsonType === "Decimal128" ? "decimal" : bsonType === "Long" || bsonType === "Int32" ? "number" : bsonType;
  return typeof v === "object" ? "object" : typeof v;
}
const OBJECT_ID_TEXT = /^[0-9a-f]{24}$/i;

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
  // BSON values are data, not operator documents. In particular, do not walk Decimal128's byte
  // representation and accidentally reject or rewrite it.
  if (value instanceof Date || (value && typeof value === "object" && "_bsontype" in value)) return;
  if (value && typeof value === "object" && value.constructor === Object) {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_OPERATORS.has(k)) throw NexusError.invalid(`${k} isn't allowed: it would run code on the server.`);
      assertSafe(v, depth + 1);
    }
  }
}

const noBsonTypes = (): BsonTypeCounts => ({ objectIds: 0, objectIdReferences: 0, dates: 0, decimal128: 0 });

/** Counts semantic BSON values recursively without converting them to JavaScript primitives. */
export function bsonTypeCounts(documents: Document[]): BsonTypeCounts {
  const counts = noBsonTypes();
  const walk = (value: unknown, key: string): void => {
    if (value instanceof ObjectId) {
      if (key === "_id") counts.objectIds++;
      else counts.objectIdReferences++;
      return;
    }
    if (value instanceof Date) {
      counts.dates++;
      return;
    }
    if (value && typeof value === "object" && (value as { _bsontype?: string })._bsontype === "Decimal128") {
      counts.decimal128++;
      return;
    }
    if (Array.isArray(value)) return value.forEach((v) => walk(v, key));
    if (value && typeof value === "object" && !(value as { _bsontype?: string })._bsontype) {
      for (const [k, v] of Object.entries(value as Document)) walk(v, k);
    }
  };
  documents.forEach((d) => walk(d, ""));
  return counts;
}

function parseFailure(error: unknown): string {
  return String((error as Error)?.message ?? error).replace(/\s+/g, " ").trim().slice(0, 500);
}

/** MongoDB Extended JSON array, one document, or JSON Lines -> BSON documents with exact types. */
export function parseImportJson(text: string): Document[] {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (!trimmed) throw NexusError.invalid("That file is empty.");
  if (trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      // Canonical mode is intentional: $oid, $date and $numberDecimal must remain BSON values.
      parsed = EJSON.parse(trimmed, { relaxed: false });
    } catch (e) {
      throw NexusError.invalid(`That Extended JSON array could not be read: ${parseFailure(e)}`);
    }
    if (!Array.isArray(parsed)) throw NexusError.invalid("The top-level value must be an array of documents.");
    return parsed as Document[];
  }

  // A single pretty-printed document is valid too. If the whole text is not one document, fall
  // back to mongoexport's default JSON Lines format and report the exact bad line.
  try {
    const one = EJSON.parse(trimmed, { relaxed: false }) as unknown;
    if (one && typeof one === "object" && !Array.isArray(one)) return [one as Document];
  } catch {
    // JSON Lines is tried below.
  }
  const documents: Document[] = [];
  for (const [lineNumber, line] of trimmed.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      documents.push(EJSON.parse(line, { relaxed: false }) as Document);
    } catch (e) {
      throw NexusError.invalid(`Line ${lineNumber + 1} is not valid MongoDB Extended JSON: ${parseFailure(e)}`);
    }
  }
  return documents;
}

interface WriteIssue {
  index: number | null;
  code: number | null;
  message: string;
}

/** Driver versions expose bulk write errors as an array, map, object, or result method. */
function bulkWriteIssues(error: unknown): WriteIssue[] {
  const e = error as {
    writeErrors?: unknown;
    result?: { getWriteErrors?: () => unknown[] };
  };
  let values: { value: unknown; index: number | null }[] = [];
  if (Array.isArray(e.writeErrors)) values = e.writeErrors.map((value, index) => ({ value, index }));
  else if (e.writeErrors instanceof Map) values = [...e.writeErrors.entries()].map(([index, value]) => ({ value, index: Number(index) }));
  else if (e.writeErrors && typeof e.writeErrors === "object") values = Object.entries(e.writeErrors).map(([index, value]) => ({ value, index: Number(index) }));
  else if (typeof e.result?.getWriteErrors === "function") values = e.result.getWriteErrors().map((value, index) => ({ value, index }));
  return values.map(({ value, index }) => {
    const w = value as { index?: number; code?: number; errmsg?: string; message?: string; err?: { index?: number; code?: number; errmsg?: string; message?: string } };
    const inner = w.err ?? w;
    return {
      index: Number.isInteger(inner.index ?? w.index ?? index) ? Number(inner.index ?? w.index ?? index) : null,
      code: typeof (inner.code ?? w.code) === "number" ? Number(inner.code ?? w.code) : null,
      message: String(inner.errmsg ?? inner.message ?? w.errmsg ?? w.message ?? "Could not insert this document."),
    };
  });
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

  /**
   * The blueprint of a document database: each collection's fields worked out from its documents
   * (types, how often present), its indexes, and links between collections (fields holding ObjectIds
   * that match another collection's _id).
   */
  async blueprint(databaseId: string, sampleSize = 300): Promise<DocumentBlueprint> {
    return this.inDb(databaseId, async (c, dbName) => {
      const db = c.db(dbName);
      const names = (await db.listCollections({ type: "collection" }, { nameOnly: true }).toArray())
        .map((x) => x.name)
        .filter((n) => n !== INTERNAL && !n.startsWith("system."))
        .sort((a, b) => a.localeCompare(b));
      const collections: DocumentBlueprint["collections"] = [];
      const idOwner = new Map<string, string>(); // ObjectId hex → collection it identifies
      const samples = new Map<string, Document[]>();
      for (const name of names) {
        const coll = db.collection(name);
        const docs = await coll.find({}).limit(sampleSize).toArray();
        samples.set(name, docs);
        for (const d of docs) if (d._id instanceof ObjectId) idOwner.set(d._id.toHexString(), name);
        const count = await coll.estimatedDocumentCount().catch(() => docs.length);
        const indexes = await coll.indexes().catch(() => []);
        collections.push({ name, documents: count, sampled: docs.length, fields: [], indexes: indexes.map((ix) => ({ name: String(ix.name), keys: Object.keys(ix.key ?? {}), unique: !!ix.unique })) });
      }
      const relations: DocumentBlueprint["relations"] = [];
      for (const col of collections) {
        const fields = new Map<string, { types: Map<string, number>; present: number; refs: Map<string, number> }>();
        const docs = samples.get(col.name) ?? [];
        const visit = (value: unknown, path: string, seen: Set<string>) => {
          const entry = fields.get(path) ?? { types: new Map(), present: 0, refs: new Map() };
          fields.set(path, entry);
          if (!seen.has(path)) {
            entry.present++;
            seen.add(path);
          }
          const type = typeOf(value);
          entry.types.set(type, (entry.types.get(type) ?? 0) + 1);
          if (value instanceof ObjectId && path !== "_id") {
            const target = idOwner.get(value.toHexString());
            if (target) entry.refs.set(target, (entry.refs.get(target) ?? 0) + 1);
          }
          if (Array.isArray(value)) for (const v of value.slice(0, 20)) if (v instanceof ObjectId) {
            const target = idOwner.get(v.toHexString());
            if (target) entry.refs.set(target, (entry.refs.get(target) ?? 0) + 1);
          }
          if (type === "object" && path.split(".").length < 4) for (const [k, v] of Object.entries(value as Document)) visit(v, `${path}.${k}`, seen);
        };
        for (const d of docs) {
          const seen = new Set<string>();
          for (const [k, v] of Object.entries(d)) visit(v, k, seen);
        }
        col.fields = [...fields.entries()]
          .map(([path, e]) => {
            const ref = [...e.refs.entries()].sort((a, b) => b[1] - a[1])[0];
            if (ref) relations.push({ from: { collection: col.name, field: path }, to: { collection: ref[0], field: "_id" } });
            return { path, types: [...e.types.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t), presence: docs.length ? e.present / docs.length : 0, references: ref ? ref[0] : null };
          })
          .sort((a, b) => (a.path === "_id" ? -1 : b.path === "_id" ? 1 : a.path.localeCompare(b.path)));
      }
      return { collections, relations };
    });
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

  /** Streams canonical Extended JSON so every BSON type can be imported again without loss. */
  async *exportJson(databaseId: string, collection: string, filterText?: string): AsyncGenerator<string> {
    assertCollectionName(collection);
    const filter = parseFilter(filterText);
    const db = this.docs.require(databaseId);
    const c = await this.docs.openClient(databaseId);
    try {
      yield "[\n";
      let first = true;
      for await (const d of c.db(db.dbName).collection(collection).find(filter, { sort: { _id: 1 } })) {
        yield `${first ? "" : ",\n"}${EJSON.stringify(d, { relaxed: false })}`;
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
  async importJson(databaseId: string, collection: string, text: string): Promise<DocumentImportResult> {
    assertCollectionName(collection);
    let docs = parseImportJson(text);
    if (!Array.isArray(docs) || docs.some((d) => !d || typeof d !== "object" || Array.isArray(d))) {
      throw NexusError.invalid("Every entry in the file must be a JSON object (a document).");
    }
    docs.forEach((d) => assertSafe(d));
    const parsedTypes = bsonTypeCounts(docs);
    const detected = {
      format: Object.values(parsedTypes).some(Boolean) ? "mongodb_extended_json" as const : "json" as const,
      documents: docs.length,
      types: parsedTypes,
    };
    if (!docs.length) return { inserted: 0, skipped: 0, errors: [], errorCount: 0, convertedIds: 0, restored: { ids: 0, references: 0, dates: 0 }, detected, preserved: parsedTypes };
    return this.inDb(databaseId, async (c, dbName) => {
      // Files saved from an app or API lose MongoDB's types: ids and dates arrive as plain text.
      // Apps look documents up by ObjectId and group by real dates, so those types are put back:
      // text _ids, references to documents that exist (here or in this file), and ISO timestamps.
      const known = await knownIds(c, dbName);
      for (const d of docs) {
        const id = typeof d._id === "string" ? d._id : d._id instanceof ObjectId ? d._id.toHexString() : null;
        if (id && OBJECT_ID_TEXT.test(id)) known.add(id.toLowerCase());
      }
      const restored: TypeChanges = { ids: 0, references: 0, dates: 0 };
      docs = docs.map((d) => restoreTypes(d, restored, known).doc);
      const convertedIds = restored.ids;
      const coll = c.db(dbName).collection(collection);
      let inserted = 0;
      let skipped = 0;
      const errors: string[] = [];
      let errorCount = 0;
      for (let i = 0; i < docs.length; i += 1000) {
        const batch = docs.slice(i, i + 1000);
        try {
          const r = await coll.insertMany(batch, { ordered: false });
          inserted += r.insertedCount;
        } catch (e) {
          const err = e as { insertedCount?: number; result?: { insertedCount?: number } };
          inserted += err.insertedCount ?? err.result?.insertedCount ?? 0;
          const issues = bulkWriteIssues(e);
          if (!issues.length) {
            const reason = parseFailure(e);
            throw new NexusError("infrastructure", `The database rejected documents ${i + 1}-${i + batch.length}: ${reason}`, {
              cause: e,
              problem: {
                title: "Document import stopped",
                summary: `The database could not insert the batch beginning at document ${i + 1}.`,
                checks: [{ label: "MongoDB Extended JSON", status: "ok", detail: `${docs.length} documents parsed; BSON types preserved before insertion` }, { label: "Database insert", status: "failed", detail: reason }],
                technical: reason,
              },
            });
          }
          for (const issue of issues) {
            if (issue.code === 11000) {
              skipped++;
              continue;
            }
            errorCount++;
            if (errors.length < 10) {
              const absolute = issue.index === null ? null : i + issue.index;
              const doc = absolute === null ? null : docs[absolute];
              const id = doc?._id === undefined ? "" : ` (_id ${EJSON.stringify(doc._id, { relaxed: false })})`;
              errors.push(`${absolute === null ? "A document" : `Document ${absolute + 1}`}${id}: ${issue.message}`);
            }
          }
        }
      }
      // restoreTypes never touches values already represented as BSON. Recount after that pass so
      // the response describes both native Extended JSON and safe text-to-type restoration.
      const preserved = bsonTypeCounts(docs);
      return { inserted, skipped, errors, errorCount, convertedIds, restored, detected, preserved };
    });
  }

  /** How many documents have a text _id that looks exactly like an ObjectId (usually an import mistake). */
  async textIdCount(databaseId: string, collection: string): Promise<number> {
    assertCollectionName(collection);
    return this.inDb(databaseId, async (c, dbName) => {
      const ids = await c.db(dbName).collection(collection).find({ _id: { $type: "string" } as never }, { projection: { _id: 1 } }).toArray();
      return ids.filter((d) => OBJECT_ID_TEXT.test(String(d._id))).length;
    });
  }

  /**
   * Turns text ids that are exactly ObjectIds into real ObjectIds (the document is copied under the
   * new id, then the old copy removed). A document whose ObjectId already exists is left alone.
   */
  async convertTextIds(databaseId: string, collection: string): Promise<{ converted: number; skipped: number }> {
    assertCollectionName(collection);
    return this.inDb(databaseId, async (c, dbName) => {
      const coll = c.db(dbName).collection(collection);
      const docs = await coll.find({ _id: { $type: "string" } as never }).toArray();
      let converted = 0;
      let skipped = 0;
      for (const d of docs) {
        const text = String(d._id);
        if (!OBJECT_ID_TEXT.test(text)) continue;
        const oid = new ObjectId(text);
        if (await coll.findOne({ _id: oid }, { projection: { _id: 1 } })) {
          skipped++;
          continue;
        }
        // FerretDB treats "6a79…" and ObjectId("6a79…") as the same key, so the old copy goes first;
        // if the new one can't be written, the original is put back unchanged.
        await coll.deleteOne({ _id: text as never });
        try {
          await coll.insertOne({ ...d, _id: oid });
        } catch (e) {
          await coll.insertOne(d);
          throw e;
        }
        converted++;
      }
      return { converted, skipped };
    });
  }

  /** Text that should be ids or dates (usually from an import): what "Fix types" would change. */
  async typeIssues(databaseId: string, collection: string): Promise<TypeReport> {
    assertCollectionName(collection);
    return this.inDb(databaseId, (c, dbName) => typeReport(c, dbName, collection));
  }

  /** Turns text ids, text references and text timestamps back into ObjectIds and dates. */
  async fixTypes(databaseId: string, collection: string): Promise<{ fixed: number; skipped: number; failed: number }> {
    assertCollectionName(collection);
    return this.inDb(databaseId, (c, dbName) => repairTypes(c, dbName, collection));
  }

  /** Copies another MongoDB (Atlas, a local server…) into this database with every type intact. */
  async copyFrom(databaseId: string, sourceUrl: string, opts: { sourceDb?: string | null; onProgress?: (p: CopyProgress) => void; onCollection?: (name: string) => void } = {}): Promise<CopyResult> {
    return this.inDb(databaseId, (client, dbName) => copyFromMongo(sourceUrl, { client, dbName }, opts));
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
