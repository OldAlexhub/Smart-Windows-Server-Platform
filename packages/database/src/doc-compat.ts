import { createServer, Socket, type Server } from "node:net";
import { Decimal128, deserialize, EJSON, serialize, Long, type Document } from "bson";
import { aggregate as runPipeline } from "mingo";
import { silentLogger, type Logger } from "@nexus/shared";
import type { DocumentEngine } from "./ferretdb";

/**
 * MongoDB compatibility layer in front of FerretDB.
 *
 * Applications connect here instead of to FerretDB directly. Every message passes straight through,
 * except an aggregation FerretDB answers with "not implemented" (for example `$cond` inside
 * `$group`): Nexus then reads the documents through the same authenticated connection — so the
 * app's own permissions apply — runs the pipeline with mingo (MIT), and replies as MongoDB would.
 * The app needs no changes.
 */

const OP_MSG = 2013;
const HEADER = 16;
/** MongoDB's default maximum message size. */
const MAX_MESSAGE = 48_000_000;
/** Requests Nexus sends itself use ids far away from the driver's. */
let internalId = 0x70000000;

interface Frame {
  buf: Buffer;
  requestId: number;
  responseTo: number;
  opCode: number;
}

function readHeader(buf: Buffer): Frame {
  return { buf, requestId: buf.readInt32LE(4), responseTo: buf.readInt32LE(8), opCode: buf.readInt32LE(12) };
}

/** Splits a TCP stream into MongoDB wire-protocol messages. */
function framer(onFrame: (f: Frame) => void): (chunk: Buffer) => void {
  let pending: Buffer = Buffer.alloc(0);
  return (chunk) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= 4) {
      const len = pending.readInt32LE(0);
      if (len < HEADER || len > MAX_MESSAGE * 2) throw new Error("Invalid MongoDB message.");
      if (pending.length < len) break;
      onFrame(readHeader(pending.subarray(0, len)));
      pending = pending.subarray(len);
    }
  };
}

/** The command document of an OP_MSG (section kind 0). */
function msgBody(f: Frame): Document | null {
  if (f.opCode !== OP_MSG) return null;
  let off = HEADER + 4;
  while (off < f.buf.length) {
    const kind = f.buf.readUInt8(off);
    off += 1;
    const size = f.buf.readInt32LE(off);
    if (kind === 0) return deserialize(f.buf.subarray(off, off + size), { promoteLongs: false, promoteValues: true });
    off += size;
  }
  return null;
}

function opMsg(body: Document, responseTo: number, requestId: number): Buffer {
  const doc = serialize(body);
  const buf = Buffer.alloc(HEADER + 4 + 1 + doc.length);
  buf.writeInt32LE(buf.length, 0);
  buf.writeInt32LE(requestId, 4);
  buf.writeInt32LE(responseTo, 8);
  buf.writeInt32LE(OP_MSG, 12);
  buf.writeUInt32LE(0, 16); // flags
  buf.writeUInt8(0, 20); // section kind 0
  buf.set(doc, 21);
  return buf;
}

/**
 * FerretDB 1.x terminates its connection when it receives BSON Decimal128. Nexus stores those
 * values as an unambiguous ordinary subdocument and restores Decimal128 at the wire boundary.
 * This keeps exact base-10 text/scale and also makes equality filters work, because query values
 * undergo the same encoding. The marker is deliberately versioned and requires an exact shape.
 */
const DECIMAL_MARKER = "__nexus_internal_bson_decimal128_9f36c1e7_v1__";

function mapDecimals(value: unknown, direction: "store" | "restore", changed: { count: number }): unknown {
  if (direction === "store" && value instanceof Decimal128) {
    changed.count++;
    return { [DECIMAL_MARKER]: value.toString() };
  }
  if (!value || typeof value !== "object") return value;
  if (direction === "restore" && value.constructor === Object) {
    const entries = Object.entries(value as Document);
    if (entries.length === 1 && entries[0]![0] === DECIMAL_MARKER && typeof entries[0]![1] === "string") {
      changed.count++;
      return Decimal128.fromString(entries[0]![1]);
    }
  }
  if ((value as { _bsontype?: string })._bsontype || value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((v) => mapDecimals(v, direction, changed));
  const result: Document = {};
  for (const [key, item] of Object.entries(value as Document)) result[key] = mapDecimals(item, direction, changed);
  return result;
}

function decimalDocument(body: Document, direction: "store" | "restore", changed: { count: number }): Document {
  return mapDecimals(body, direction, changed) as Document;
}

/** Rewrites every BSON document in an OP_MSG, including kind-1 insert/update sequences. */
function rewriteDecimals(frame: Frame, direction: "store" | "restore"): { buf: Buffer; count: number } {
  if (frame.opCode !== OP_MSG) return { buf: frame.buf, count: 0 };
  const flags = frame.buf.readUInt32LE(HEADER);
  // Checksummed OP_MSG frames are not negotiated by the bundled driver/server. Never invalidate a
  // checksum if a future client enables them; pass it through unchanged instead.
  if (flags & 1) return { buf: frame.buf, count: 0 };
  const changed = { count: 0 };
  const sections: Buffer[] = [];
  let offset = HEADER + 4;
  while (offset < frame.buf.length) {
    const kind = frame.buf.readUInt8(offset++);
    if (kind === 0) {
      const size = frame.buf.readInt32LE(offset);
      const body = deserialize(frame.buf.subarray(offset, offset + size), { promoteLongs: false, promoteValues: true });
      sections.push(Buffer.from([0]), Buffer.from(serialize(decimalDocument(body, direction, changed))));
      offset += size;
      continue;
    }
    if (kind === 1) {
      const sectionStart = offset;
      const size = frame.buf.readInt32LE(sectionStart);
      const sectionEnd = sectionStart + size;
      let nameEnd = sectionStart + 4;
      while (nameEnd < sectionEnd && frame.buf[nameEnd] !== 0) nameEnd++;
      if (nameEnd >= sectionEnd) throw new Error("Invalid MongoDB document sequence.");
      const name = frame.buf.subarray(sectionStart + 4, nameEnd + 1);
      const documents: Buffer[] = [];
      let docOffset = nameEnd + 1;
      while (docOffset < sectionEnd) {
        const docSize = frame.buf.readInt32LE(docOffset);
        const body = deserialize(frame.buf.subarray(docOffset, docOffset + docSize), { promoteLongs: false, promoteValues: true });
        documents.push(Buffer.from(serialize(decimalDocument(body, direction, changed))));
        docOffset += docSize;
      }
      const payload = Buffer.concat([name, ...documents]);
      const header = Buffer.alloc(5);
      header.writeUInt8(1, 0);
      header.writeInt32LE(4 + payload.length, 1);
      sections.push(header, payload);
      offset = sectionEnd;
      continue;
    }
    throw new Error(`Unsupported MongoDB OP_MSG section ${kind}.`);
  }
  if (!changed.count) return { buf: frame.buf, count: 0 };
  const payload = Buffer.concat(sections);
  const buf = Buffer.alloc(HEADER + 4 + payload.length);
  buf.writeInt32LE(buf.length, 0);
  buf.writeInt32LE(frame.requestId, 4);
  buf.writeInt32LE(frame.responseTo, 8);
  buf.writeInt32LE(frame.opCode, 12);
  buf.writeUInt32LE(flags, 16);
  payload.copy(buf, 20);
  return { buf, count: changed.count };
}

const notImplemented = (reply: Document) => reply.ok !== 1 && (reply.code === 238 || /not implemented/i.test(String(reply.errmsg ?? "")));
/** Stages that write or need the real server: never emulated. */
const UNSUPPORTED_STAGES = ["$out", "$merge", "$changeStream", "$currentOp", "$collStats", "$indexStats", "$listSessions", "$planCacheStats", "$search", "$searchMeta"];

/**
 * The commands the layer can stand in for, rewritten as an aggregation over one collection:
 * aggregate itself, find (e.g. an $expr filter), distinct and count.
 */
interface Emulatable {
  coll: string;
  db: string;
  pipeline: Document[];
  shape: "cursor" | "distinct" | "count";
  /** distinct: the field whose values are collected (dotted paths allowed). */
  key?: string;
}

export function asEmulatable(body: Document): Emulatable | null {
  const db = String(body.$db ?? "");
  if (body.explain) return null;
  if (typeof body.aggregate === "string" && Array.isArray(body.pipeline)) {
    if ((body.pipeline as Document[]).some((s) => UNSUPPORTED_STAGES.some((k) => k in s))) return null;
    return { coll: body.aggregate, db, pipeline: body.pipeline, shape: "cursor" };
  }
  if (typeof body.find === "string") {
    const p: Document[] = [];
    if (body.filter && Object.keys(body.filter).length) p.push({ $match: body.filter });
    if (body.sort && Object.keys(body.sort).length) p.push({ $sort: body.sort });
    if (body.skip) p.push({ $skip: Number(body.skip) });
    const limit = Math.abs(Number(body.limit ?? 0));
    if (limit) p.push({ $limit: limit });
    if (body.projection && Object.keys(body.projection).length) p.push({ $project: body.projection });
    return { coll: body.find, db, pipeline: p, shape: "cursor" };
  }
  if (typeof body.distinct === "string" && typeof body.key === "string") {
    const p: Document[] = [];
    if (body.query && Object.keys(body.query).length) p.push({ $match: body.query });
    return { coll: body.distinct, db, pipeline: p, shape: "distinct", key: body.key };
  }
  if (typeof body.count === "string") {
    const p: Document[] = [];
    if (body.query && Object.keys(body.query).length) p.push({ $match: body.query });
    if (body.skip) p.push({ $skip: Number(body.skip) });
    if (body.limit) p.push({ $limit: Math.abs(Number(body.limit)) });
    p.push({ $count: "n" });
    return { coll: body.count, db, pipeline: p, shape: "count" };
  }
  return null;
}

function foreignCollections(pipeline: Document[]): string[] {
  const names = new Set<string>();
  const walk = (stages: Document[]) => {
    for (const s of stages) {
      const lookup = s.$lookup ?? s.$graphLookup;
      if (lookup?.from) names.add(String(lookup.from));
      if (Array.isArray(lookup?.pipeline)) walk(lookup.pipeline);
      const union = s.$unionWith;
      if (typeof union === "string") names.add(union);
      else if (union?.coll) {
        names.add(String(union.coll));
        if (Array.isArray(union.pipeline)) walk(union.pipeline);
      }
      if (s.$facet) for (const sub of Object.values(s.$facet as Record<string, Document[]>)) walk(sub);
    }
  };
  walk(pipeline);
  return [...names];
}

export interface CompatStats {
  emulated: number;
  lastEmulated: { at: string; collection: string; operators: string } | null;
  decimal128Stored: number;
  decimal128Restored: number;
}

/** One listening proxy per document database. */
export class DocumentCompatProxy {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  readonly stats: CompatStats = { emulated: 0, lastEmulated: null, decimal128Stored: 0, decimal128Restored: 0 };

  constructor(
    private readonly opts: { listenPort: number; upstreamPort: number; logger?: Logger; host?: string },
  ) {}

  private get log(): Logger {
    return this.opts.logger ?? silentLogger;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((client) => this.handle(client));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.opts.listenPort, this.opts.host ?? "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }

  private handle(client: Socket): void {
    const upstream = new Socket();
    this.sockets.add(client).add(upstream);
    const close = () => {
      client.destroy();
      upstream.destroy();
      this.sockets.delete(client);
      this.sockets.delete(upstream);
    };
    client.on("error", close).on("close", close);
    upstream.on("error", close).on("close", close);
    client.setNoDelay(true);
    upstream.setNoDelay(true);

    /** Aggregations in flight (driver request id → the command), and Nexus's own requests. */
    const aggregations = new Map<number, Emulatable>();
    const internal = new Map<number, (reply: Document) => void>();
    const ask = (body: Document): Promise<Document> =>
      new Promise((resolve) => {
        const id = internalId++;
        internal.set(id, resolve);
        const changed = { count: 0 };
        const stored = decimalDocument(body, "store", changed);
        this.stats.decimal128Stored += changed.count;
        upstream.write(opMsg(stored, 0, id));
      });

    const fromClient = framer((f) => {
      const body = f.opCode === OP_MSG ? safeBody(f) : null;
      const emulatable = body ? asEmulatable(body) : null;
      if (emulatable) aggregations.set(f.requestId, emulatable);
      const rewritten = rewriteDecimals(f, "store");
      this.stats.decimal128Stored += rewritten.count;
      upstream.write(rewritten.buf);
    });
    const fromUpstream = framer((f) => {
      const mine = internal.get(f.responseTo);
      if (mine) {
        internal.delete(f.responseTo);
        const body = safeBody(f);
        if (!body) mine({ ok: 0, errmsg: "No reply." });
        else {
          const changed = { count: 0 };
          mine(decimalDocument(body, "restore", changed));
          this.stats.decimal128Restored += changed.count;
        }
        return;
      }
      const command = aggregations.get(f.responseTo);
      if (!command) {
        const rewritten = rewriteDecimals(f, "restore");
        this.stats.decimal128Restored += rewritten.count;
        return void client.write(rewritten.buf);
      }
      aggregations.delete(f.responseTo);
      const rawReply = safeBody(f);
      if (!rawReply || !notImplemented(rawReply)) {
        const rewritten = rewriteDecimals(f, "restore");
        this.stats.decimal128Restored += rewritten.count;
        return void client.write(rewritten.buf);
      }
      // FerretDB can't run this command: run it here, then answer the driver's request.
      void this.emulate(command, ask)
        .then((result) => client.write(opMsg(result, f.responseTo, internalId++)))
        .catch((e) => {
          this.log.warn("compatibility layer could not run an aggregation", { err: e as Error });
          client.write(f.buf); // the original "not implemented" error
        });
    });

    const safeBody = (f: Frame) => {
      try {
        return msgBody(f);
      } catch {
        return null;
      }
    };
    client.on("data", (c: Buffer) => {
      try {
        fromClient(c);
      } catch {
        close();
      }
    });
    upstream.on("data", (c: Buffer) => {
      try {
        fromUpstream(c);
      } catch {
        close();
      }
    });
    upstream.connect(this.opts.upstreamPort, "127.0.0.1");
  }

  /** Reads what the command needs through the app's own connection and runs it with mingo. */
  private async emulate(command: Emulatable, ask: (body: Document) => Promise<Document>): Promise<Document> {
    const { db, coll, pipeline } = command;

    const readAll = async (collection: string, filter: Document = {}): Promise<Document[]> => {
      const docs: Document[] = [];
      let reply = await ask({ find: collection, filter, batchSize: 10_000, $db: db });
      if (reply.ok !== 1 && Object.keys(filter).length) reply = await ask({ find: collection, filter: {}, batchSize: 10_000, $db: db });
      if (reply.ok !== 1) throw new Error(String(reply.errmsg ?? "find failed"));
      docs.push(...(reply.cursor.firstBatch as Document[]));
      let cursorId = reply.cursor.id as Long | number;
      while (cursorId && !(cursorId instanceof Long ? cursorId.isZero() : cursorId === 0)) {
        const more = await ask({ getMore: cursorId, collection, batchSize: 10_000, $db: db });
        if (more.ok !== 1) throw new Error(String(more.errmsg ?? "getMore failed"));
        docs.push(...(more.cursor.nextBatch as Document[]));
        cursorId = more.cursor.id;
      }
      return docs;
    };

    // A leading $match is filtered by the database; mingo runs it again, so either way is correct.
    const leadingMatch = pipeline[0]?.$match as Document | undefined;
    const input = await readAll(coll, leadingMatch ?? {});
    const foreign = new Map<string, Document[]>();
    for (const name of foreignCollections(pipeline)) foreign.set(name, await readAll(name));

    const results = runPipeline(input, pipeline, { collectionResolver: (name: string) => foreign.get(name) ?? [] }) as Document[];
    const size = results.reduce((n, d) => n + serialize(d).length, 0);
    if (size > MAX_MESSAGE - 1_000_000) throw new Error("The aggregation result is too large to return in one reply.");

    this.stats.emulated++;
    this.stats.lastEmulated = { at: new Date().toISOString(), collection: coll, operators: JSON.stringify(pipeline).match(/\$[a-zA-Z]+/g)?.slice(0, 6).join(" ") ?? "" };
    if (command.shape === "distinct") {
      // Collected here rather than with $group, so ObjectIds, dates and arrays compare exactly.
      const seen = new Map<string, unknown>();
      const collect = (v: unknown): void => {
        if (v === undefined) return;
        if (Array.isArray(v)) return v.forEach(collect);
        const k = EJSON.stringify({ v } as Document, { relaxed: false });
        if (!seen.has(k)) seen.set(k, v);
      };
      const valueAt = (d: unknown, path: string[]): unknown =>
        path.reduce<unknown>((o, part) => (Array.isArray(o) ? o.map((x) => (x as Document | undefined)?.[part]) : (o as Document | undefined)?.[part]), d);
      for (const d of results) collect(valueAt(d, command.key!.split(".")));
      return { values: [...seen.values()], ok: 1 };
    }
    if (command.shape === "count") return { n: Number(results[0]?.n ?? 0), ok: 1 };
    return { cursor: { id: Long.fromNumber(0), ns: `${db}.${coll}`, firstBatch: results }, ok: 1 };
  }
}

/**
 * The document engine apps actually talk to: FerretDB on an internal port, with the compatibility
 * layer on the database's own port. Addresses apps already have keep working unchanged.
 */
export class CompatibleDocumentEngine implements DocumentEngine {
  readonly kind = "ferretdb" as const;
  private readonly proxies = new Map<string, { proxy: DocumentCompatProxy; port: number; upstream: number }>();

  constructor(
    private readonly inner: DocumentEngine,
    /** The internal port FerretDB uses for this database (kept stable; moved if another program took it). */
    private readonly enginePort: (pgDatabase: string, ownedByUs: boolean) => Promise<number>,
    private readonly logger: Logger = silentLogger,
  ) {}

  get version(): string {
    return this.inner.version;
  }

  async ensure(pgDatabase: string, port: number): Promise<void> {
    const upstream = await this.enginePort(pgDatabase, this.inner.running().includes(pgDatabase));
    await this.inner.ensure(pgDatabase, upstream);
    const current = this.proxies.get(pgDatabase);
    if (current && current.port === port && current.upstream === upstream) return;
    await current?.proxy.stop();
    this.proxies.delete(pgDatabase);
    const proxy = new DocumentCompatProxy({ listenPort: port, upstreamPort: upstream, logger: this.logger });
    await proxy.start();
    this.proxies.set(pgDatabase, { proxy, port, upstream });
  }

  async stopOne(pgDatabase: string): Promise<void> {
    await this.proxies.get(pgDatabase)?.proxy.stop();
    this.proxies.delete(pgDatabase);
    await this.inner.stopOne(pgDatabase);
  }

  running(): string[] {
    return this.inner.running();
  }

  async stop(): Promise<void> {
    for (const { proxy } of this.proxies.values()) await proxy.stop();
    this.proxies.clear();
    await this.inner.stop();
  }

  /** How often Nexus stepped in for this database (shown to the owner). */
  stats(pgDatabase: string): CompatStats | null {
    return this.proxies.get(pgDatabase)?.proxy.stats ?? null;
  }
}
