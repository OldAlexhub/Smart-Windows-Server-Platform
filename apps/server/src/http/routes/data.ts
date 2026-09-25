import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { databaseStats, type Filter } from "@nexus/database";
import { DEFAULT_POLICY } from "@nexus/backups";
import { authorize, type Permission } from "@nexus/security";
import { NexusError, type DatabaseSummary } from "@nexus/shared";
import type { NexusContext } from "../../context";
import type { RouteModule } from "../server";
import { requirePermission, requireUser } from "../auth";
import { documentSummary } from "./documents";

/** Database access follows the apps using it: e.g. "app.data.read" on any attached app. */
/** The applications (that still exist) using a database — only these block deleting it. */
export function appsUsingDb(ctx: NexusContext, appIds: string[]): { id: string; name: string }[] {
  const find = (id: string) => {
    try {
      return ctx.store.get<{ id: string; name: string }>("SELECT id, name FROM apps WHERE id = ?", [id]);
    } catch {
      return undefined; // no applications table yet: no applications
    }
  };
  return appIds.map(find).filter((a): a is { id: string; name: string } => !!a);
}

export function requireDbPermission(ctx: NexusContext, req: FastifyRequest, databaseId: string, permission: Permission) {
  const { user } = requireUser(req);
  const db = ctx.databases?.get(databaseId);
  if (!db) throw NexusError.notFound("Database");
  const ok = authorize(user, permission) || db.appIds.some((a) => authorize(user, permission, a));
  if (!ok) throw NexusError.forbidden();
  return { user, db };
}

const browseQuery = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(500).optional(),
  sort: z.string().optional(),
  dir: z.enum(["asc", "desc"]).optional(),
  search: z.string().max(200).optional(),
  filters: z.string().optional(),
});

function parseBrowse(q: unknown) {
  const b = browseQuery.parse(q);
  let filters: Filter[] = [];
  if (b.filters) {
    try {
      filters = z
        .array(z.object({ column: z.string(), op: z.enum(["eq", "neq", "lt", "lte", "gt", "gte", "contains", "starts", "is_null", "not_null"]), value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional() }))
        .parse(JSON.parse(b.filters));
    } catch {
      throw NexusError.invalid("Those filters aren't valid.");
    }
  }
  return {
    ...(b.page ? { page: b.page } : {}),
    ...(b.pageSize ? { pageSize: b.pageSize } : {}),
    ...(b.sort ? { sort: { column: b.sort, direction: b.dir ?? "asc" } } : {}),
    ...(b.search ? { search: b.search } : {}),
    filters,
  };
}

export const dataRoutes: RouteModule = (app, ctx) => {
  const need = () => {
    if (!ctx.databases || !ctx.dataBrowser || !ctx.postgres) throw NexusError.conflict("The database server isn't available yet.");
    return { dbs: ctx.databases, browser: ctx.dataBrowser, pg: ctx.postgres };
  };

  async function summarize(id: string): Promise<DatabaseSummary> {
    const { dbs, pg } = need();
    const d = dbs.require(id);
    const stats = await databaseStats(pg, d.dbName);
    const appsUsing = d.appIds;
    const latest = appsUsing.map((a) => ctx.backups?.latestSuccessful(a)).filter(Boolean).sort((a, b) => b!.createdAt.localeCompare(a!.createdAt))[0] ?? null;
    const prot = appsUsing.length
      ? appsUsing.every((a) => ctx.backups?.protection(a, { database: true, files: false, config: true }, ctx.backups.policy(a, DEFAULT_POLICY)).protected)
      : false;
    return {
      id: d.id,
      name: d.name,
      engine: "postgresql",
      dbName: d.dbName,
      status: stats.status === "healthy" ? "healthy" : "offline",
      sizeBytes: stats.sizeBytes,
      tableCount: stats.tableCount,
      connectionCount: stats.connectionCount,
      ownerAppIds: appsUsing,
      usedBy: appsUsingDb(ctx, appsUsing),
      lastBackupAt: latest?.createdAt ?? null,
      protected: prot,
    };
  }

  /** All databases: relational (PostgreSQL) and document (MongoDB) together. */
  app.get("/api/v1/databases", async (req) => {
    const { user } = requireUser(req);
    const canSee = (d: { appIds: string[] }) => authorize(user, "app.view") || d.appIds.some((a) => authorize(user, "app.view", a));
    const relational = ctx.databases ? await Promise.all(ctx.databases.list().filter(canSee).map((d) => summarize(d.id))) : [];
    const documents = ctx.documents ? await Promise.all(ctx.documents.list().filter(canSee).map((d) => documentSummary(ctx, d.id))) : [];
    return [...relational, ...documents];
  });

  app.post("/api/v1/databases", async (req) => {
    const user = requirePermission(req, "databases.create");
    const { name } = z.object({ name: z.string().min(1).max(80) }).parse(req.body);
    const { database } = await need().dbs.createDatabase({ displayName: name });
    ctx.audit.record({ actor: { type: "user", id: user.id, name: user.displayName }, action: "database.create", target: { type: "database", id: database.id } });
    ctx.activity.add("success", `${database.name} database created.`);
    return summarize(database.id);
  });

  app.get("/api/v1/databases/:id", async (req) => {
    const { id } = req.params as { id: string };
    requireDbPermission(ctx, req, id, "app.view");
    return summarize(id);
  });

  app.get("/api/v1/databases/:id/connection", async (req) => {
    const { id } = req.params as { id: string };
    const { user, db } = requireDbPermission(ctx, req, id, "app.secrets.read");
    const appId = db.appIds[0];
    if (!appId) throw NexusError.conflict("No application is connected to this database yet.");
    ctx.audit.record({ actor: { type: "user", id: user.id, name: user.displayName }, action: "database.reveal_connection", target: { type: "database", id } });
    return need().dbs.connectionInfo(id, appId);
  });

  app.get("/api/v1/databases/:id/tables", async (req) => {
    const { id } = req.params as { id: string };
    requireDbPermission(ctx, req, id, "app.data.read");
    return need().browser.listTables(id);
  });

  app.get("/api/v1/databases/:id/tables/:table", async (req) => {
    const { id, table } = req.params as { id: string; table: string };
    requireDbPermission(ctx, req, id, "app.data.read");
    return need().browser.browse(id, table, parseBrowse(req.query));
  });

  app.get("/api/v1/databases/:id/tables/:table/export.csv", async (req, reply) => {
    const { id, table } = req.params as { id: string; table: string };
    const { user } = requireDbPermission(ctx, req, id, "app.data.read");
    ctx.audit.record({ actor: { type: "user", id: user.id, name: user.displayName }, action: "database.export", target: { type: "database", id }, details: { table } });
    const { Readable } = await import("node:stream");
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="${table.replace(/[^A-Za-z0-9_-]/g, "_")}.csv"`);
    return reply.send(Readable.from(need().browser.exportCsv(id, table, parseBrowse(req.query))));
  });

  app.post("/api/v1/databases/:id/tables/:table/rows", async (req) => {
    const { id, table } = req.params as { id: string; table: string };
    const { user } = requireDbPermission(ctx, req, id, "app.data.write");
    const { values } = z.object({ values: z.record(z.string(), z.unknown()) }).parse(req.body);
    const row = await need().browser.insertRow(id, table, values);
    ctx.audit.record({ actor: { type: "user", id: user.id, name: user.displayName }, action: "data.insert", target: { type: "database", id }, details: { table } });
    return row;
  });

  app.patch("/api/v1/databases/:id/tables/:table/rows", async (req) => {
    const { id, table } = req.params as { id: string; table: string };
    const { user } = requireDbPermission(ctx, req, id, "app.data.write");
    const { key, changes } = z.object({ key: z.record(z.string(), z.unknown()), changes: z.record(z.string(), z.unknown()) }).parse(req.body);
    const row = await need().browser.updateRow(id, table, key, changes);
    ctx.audit.record({ actor: { type: "user", id: user.id, name: user.displayName }, action: "data.update", target: { type: "database", id }, details: { table, key, columns: Object.keys(changes) } });
    return row;
  });

  app.delete("/api/v1/databases/:id/tables/:table/rows", async (req) => {
    const { id, table } = req.params as { id: string; table: string };
    const { user } = requireDbPermission(ctx, req, id, "app.data.write");
    // Deleting a record always needs an explicit confirmation from the UI.
    const { key } = z.object({ key: z.record(z.string(), z.unknown()), confirmed: z.literal(true) }).parse(req.body);
    await need().browser.deleteRow(id, table, key);
    ctx.audit.record({ actor: { type: "user", id: user.id, name: user.displayName }, action: "data.delete", target: { type: "database", id }, details: { table, key } });
    return { ok: true };
  });

  app.delete("/api/v1/databases/:id", async (req) => {
    const { id } = req.params as { id: string };
    const user = requirePermission(req, "server.settings");
    const { confirmation } = z.object({ confirmation: z.string() }).parse(req.body);
    const { dbs } = need();
    const db = dbs.require(id);
    const users = appsUsingDb(ctx, db.appIds);
    if (users.length) throw NexusError.conflict(`This database is still used by ${users.map((a) => a.name).join(", ")}. Remove ${users.length === 1 ? "that application" : "those applications"} first, or connect ${users.length === 1 ? "it" : "them"} to another database.`);
    await dbs.dropDatabase(id, confirmation);
    ctx.audit.record({ actor: { type: "user", id: user.id, name: user.displayName }, action: "database.drop", target: { type: "database", id } });
    ctx.activity.add("info", `${db.name} database was deleted.`);
    return { ok: true };
  });
};
