import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { DEFAULT_POLICY } from "@nexus/backups";
import { authorize, type Permission } from "@nexus/security";
import { NexusError, type DatabaseSummary } from "@nexus/shared";
import type { NexusContext } from "../../context";
import type { RouteModule } from "../server";
import { appsUsingDb } from "./data";
import { requirePermission, requireUser } from "../auth";

/** Document database access follows the apps using it, exactly like relational databases. */
function requireDocPermission(ctx: NexusContext, req: FastifyRequest, databaseId: string, permission: Permission) {
  const { user } = requireUser(req);
  const db = ctx.documents?.get(databaseId);
  if (!db) throw NexusError.notFound("Document database");
  const ok = authorize(user, permission) || db.appIds.some((a) => authorize(user, permission, a));
  if (!ok) throw NexusError.forbidden();
  return { user, db };
}

/** Summary of a document database, in the same shape the Databases page uses for PostgreSQL. */
export async function documentSummary(ctx: NexusContext, id: string): Promise<DatabaseSummary> {
  const d = ctx.documents!.require(id);
  let stats: { sizeBytes: number; collections: number; documents: number } | null = null;
  try {
    stats = await ctx.documentBrowser!.stats(id);
  } catch {
    stats = null;
  }
  const latest = d.appIds.map((a) => ctx.backups?.latestSuccessful(a)).filter(Boolean).sort((a, b) => b!.createdAt.localeCompare(a!.createdAt))[0] ?? null;
  const prot = d.appIds.length
    ? d.appIds.every((a) => ctx.backups?.protection(a, { database: true, files: false, config: true }, ctx.backups.policy(a, DEFAULT_POLICY)).protected)
    : false;
  return {
    id: d.id,
    name: d.name,
    engine: "mongodb",
    dbName: d.dbName,
    status: stats ? "healthy" : "offline",
    sizeBytes: stats?.sizeBytes ?? 0,
    tableCount: stats?.collections ?? 0,
    documentCount: stats?.documents ?? 0,
    connectionCount: 0,
    ownerAppIds: d.appIds,
    usedBy: appsUsingDb(ctx, d.appIds),
    lastBackupAt: latest?.createdAt ?? null,
    protected: prot,
  };
}

const collectionParams = z.object({ id: z.string(), collection: z.string().min(1).max(120) });
const findQuery = z.object({
  filter: z.string().max(10_000).optional(),
  skip: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const documentRoutes: RouteModule = (app, ctx) => {
  const browser = () => {
    if (!ctx.documents || !ctx.documentBrowser) throw NexusError.conflict("Document databases aren't available on this server.");
    return ctx.documentBrowser;
  };
  const audit = (user: { id: string; displayName: string }, action: string, id: string, details?: Record<string, unknown>) =>
    ctx.audit.record({ actor: { type: "user", id: user.id, name: user.displayName }, action, target: { type: "document_database", id }, ...(details ? { details } : {}) });

  /** Whether document databases can be used here, and which MongoDB server runs them. */
  app.get("/api/v1/documents/engine", async (req) => {
    requirePermission(req, "server.view");
    if (!ctx.documents || !ctx.documentSource) return { available: false, state: "unavailable", engine: null, source: null, version: null, running: 0 };
    return { available: true, state: "ready", engine: "FerretDB", source: ctx.documentSource.source, version: ctx.documentSource.version, running: ctx.documentEngine?.running().length ?? 0 };
  });

  app.post("/api/v1/documents", async (req) => {
    const user = requirePermission(req, "databases.create");
    const { name } = z.object({ name: z.string().min(1).max(80) }).parse(req.body);
    const docs = await ctx.startDocuments();
    const { database } = await docs.createDatabase({ displayName: name });
    audit(user, "document_database.create", database.id);
    ctx.activity.add("success", `${database.name} document database created.`);
    return documentSummary(ctx, database.id);
  });

  app.get("/api/v1/documents/:id", async (req) => {
    const { id } = req.params as { id: string };
    requireDocPermission(ctx, req, id, "app.view");
    return documentSummary(ctx, id);
  });

  app.get("/api/v1/documents/:id/connection", async (req) => {
    const { id } = req.params as { id: string };
    const { user, db } = requireDocPermission(ctx, req, id, "app.secrets.read");
    const appId = db.appIds[0];
    if (!appId) throw NexusError.conflict("No application is connected to this database yet.");
    audit(user, "document_database.reveal_connection", id);
    return ctx.documents!.connectionInfo(id, appId);
  });

  app.delete("/api/v1/documents/:id", async (req) => {
    const { id } = req.params as { id: string };
    const user = requirePermission(req, "server.settings");
    const { confirmation } = z.object({ confirmation: z.string() }).parse(req.body);
    const docs = await ctx.startDocuments();
    const db = docs.require(id);
    const users = appsUsingDb(ctx, db.appIds);
    if (users.length) throw NexusError.conflict(`This database is still used by ${users.map((a) => a.name).join(", ")}. Remove ${users.length === 1 ? "that application" : "those applications"} first.`);
    await docs.dropDatabase(id, confirmation);
    audit(user, "document_database.drop", id);
    ctx.activity.add("info", `${db.name} document database was deleted.`);
    return { ok: true };
  });

  // ---------------------------------------------------------------- collections

  app.get("/api/v1/documents/:id/collections", async (req) => {
    const { id } = req.params as { id: string };
    requireDocPermission(ctx, req, id, "app.data.read");
    await ctx.startDocuments();
    return browser().collections(id);
  });

  app.post("/api/v1/documents/:id/collections", async (req) => {
    const { id } = req.params as { id: string };
    const { user } = requireDocPermission(ctx, req, id, "app.data.write");
    const { name } = z.object({ name: z.string().min(1).max(120) }).parse(req.body);
    await browser().createCollection(id, name);
    audit(user, "document_collection.create", id, { collection: name });
    return { ok: true };
  });

  app.delete("/api/v1/documents/:id/collections/:collection", async (req) => {
    const { id, collection } = collectionParams.parse(req.params);
    const { user } = requireDocPermission(ctx, req, id, "app.data.write");
    const { confirmation } = z.object({ confirmation: z.string() }).parse(req.body);
    await browser().dropCollection(id, collection, confirmation);
    audit(user, "document_collection.drop", id, { collection });
    return { ok: true };
  });

  // ---------------------------------------------------------------- documents

  app.get("/api/v1/documents/:id/collections/:collection", async (req) => {
    const { id, collection } = collectionParams.parse(req.params);
    requireDocPermission(ctx, req, id, "app.data.read");
    return browser().find(id, collection, findQuery.parse(req.query));
  });

  app.post("/api/v1/documents/:id/collections/:collection/documents", async (req) => {
    const { id, collection } = collectionParams.parse(req.params);
    const { user } = requireDocPermission(ctx, req, id, "app.data.write");
    const { document } = z.object({ document: z.union([z.string(), z.record(z.string(), z.unknown())]) }).parse(req.body);
    const created = await browser().insert(id, collection, document);
    audit(user, "document.insert", id, { collection });
    return created;
  });

  app.put("/api/v1/documents/:id/collections/:collection/documents", async (req) => {
    const { id, collection } = collectionParams.parse(req.params);
    const { user } = requireDocPermission(ctx, req, id, "app.data.write");
    const body = z.object({ id: z.unknown(), document: z.union([z.string(), z.record(z.string(), z.unknown())]) }).parse(req.body);
    const updated = await browser().replace(id, collection, body.id, body.document);
    audit(user, "document.update", id, { collection, documentId: body.id });
    return updated;
  });

  app.delete("/api/v1/documents/:id/collections/:collection/documents", async (req) => {
    const { id, collection } = collectionParams.parse(req.params);
    const { user } = requireDocPermission(ctx, req, id, "app.data.write");
    // Deleting a document always needs an explicit confirmation from the UI.
    const body = z.object({ id: z.unknown(), confirmed: z.literal(true) }).parse(req.body);
    await browser().remove(id, collection, body.id);
    audit(user, "document.delete", id, { collection, documentId: body.id });
    return { ok: true };
  });

  // ---------------------------------------------------------------- import / export

  app.get("/api/v1/documents/:id/collections/:collection/export.json", async (req, reply) => {
    const { id, collection } = collectionParams.parse(req.params);
    const { user } = requireDocPermission(ctx, req, id, "app.data.read");
    const { filter } = findQuery.parse(req.query);
    audit(user, "document_collection.export", id, { collection });
    const { Readable } = await import("node:stream");
    reply.header("Content-Type", "application/json; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="${collection.replace(/[^A-Za-z0-9_.-]/g, "_")}.json"`);
    return reply.send(Readable.from(browser().exportJson(id, collection, filter)));
  });

  app.post(
    "/api/v1/documents/:id/collections/:collection/import",
    { bodyLimit: 64 * 1024 * 1024 },
    async (req) => {
      const { id, collection } = collectionParams.parse(req.params);
      const { user } = requireDocPermission(ctx, req, id, "app.data.write");
      const { content, create } = z.object({ content: z.string().min(1), create: z.boolean().optional() }).parse(req.body);
      if (create) {
        const existing = await browser().collections(id);
        if (!existing.some((c) => c.name === collection)) await browser().createCollection(id, collection);
      }
      const result = await browser().importJson(id, collection, content);
      audit(user, "document_collection.import", id, { collection, inserted: result.inserted, skipped: result.skipped });
      return result;
    },
  );
};
