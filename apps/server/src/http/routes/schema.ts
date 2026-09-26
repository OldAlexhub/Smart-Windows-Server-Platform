import { z } from "zod";
import { buildCreateTable, COLUMN_KINDS, readSqlBlueprint, type TableDesign } from "@nexus/database";
import { NexusError } from "@nexus/shared";
import type { NexusContext } from "../../context";
import type { RouteModule } from "../server";
import { requirePermission } from "../auth";
import { appsUsingDb, requireDbPermission } from "./data";

const columnSchema = z.object({
  name: z.string().min(1).max(63),
  kind: z.enum(COLUMN_KINDS.map((k) => k.id) as [string, ...string[]]),
  required: z.boolean().optional(),
  unique: z.boolean().optional(),
  primaryKey: z.boolean().optional(),
  default: z.string().max(500).nullable().optional(),
  references: z.object({ table: z.string().min(1).max(63), column: z.string().min(1).max(63), onDelete: z.enum(["restrict", "cascade", "set_null"]).optional() }).nullable().optional(),
  description: z.string().max(500).nullable().optional(),
});
const designSchema = z.object({
  name: z.string().min(1).max(63),
  description: z.string().max(1000).nullable().optional(),
  columns: z.array(columnSchema).min(1).max(200),
  indexes: z.array(z.object({ columns: z.array(z.string()).min(1).max(8), unique: z.boolean().optional() })).max(30).optional(),
});

/** Which apps use a database, and through which of their settings (never the values). */
function connections(ctx: NexusContext, kind: "tables" | "documents", appIds: string[]) {
  return appsUsingDb(ctx, appIds).map((a) => {
    const row = ctx.store.get<{ analysis: string }>("SELECT analysis FROM apps WHERE id = ?", [a.id]);
    let settings: string[] = [];
    try {
      const analysis = JSON.parse(row?.analysis ?? "{}") as { env?: { name: string; category: string }[] };
      settings = (analysis.env ?? []).filter((e) => e.category === "database").map((e) => e.name);
    } catch {
      /* no analysis */
    }
    return { appId: a.id, appName: a.name, settings: settings.length ? settings : kind === "tables" ? ["DATABASE_URL"] : ["MONGO_URL"] };
  });
}

/** A database shared with other servers over the private network (see database-links). */
function sharedLink(ctx: NexusContext, kind: "tables" | "documents", id: string) {
  const rec = ctx.settings.get<Record<string, { port: number }>>("databaseLinks", {})[`${kind}:${id}`];
  const pn = ctx.settings.get<{ enabled?: boolean; subnet?: { base: string } | null }>("privateNetwork", {});
  return rec && pn.subnet ? { host: `${pn.subnet.base}.1`, port: rec.port, privateNetworkOn: !!pn.enabled } : null;
}

/** Table designer and database blueprints. */
export const schemaRoutes: RouteModule = (app, ctx) => {
  const dbs = () => {
    if (!ctx.databases || !ctx.dataBrowser) throw NexusError.conflict("The database server isn't available yet.");
    return { dbs: ctx.databases, browser: ctx.dataBrowser };
  };

  app.get("/api/v1/schema/column-kinds", async (req) => {
    requirePermission(req, "server.view");
    return COLUMN_KINDS.map(({ id, label, hint }) => ({ id, label, hint }));
  });

  /** The SQL a design would run — shown before creating, and used to report mistakes early. */
  app.post("/api/v1/databases/:id/tables/preview", async (req) => {
    const { id } = req.params as { id: string };
    requireDbPermission(ctx, req, id, "app.data.write");
    const design = designSchema.parse(req.body) as TableDesign;
    const existing = (await dbs().browser.listTables(id)).map((t) => t.name);
    return { sql: buildCreateTable(design, existing) };
  });

  app.post("/api/v1/databases/:id/tables/create", async (req) => {
    const { id } = req.params as { id: string };
    const { user } = requireDbPermission(ctx, req, id, "app.data.write");
    const design = designSchema.parse(req.body) as TableDesign;
    const { dbs: manager, browser } = dbs();
    const sql = buildCreateTable(design, (await browser.listTables(id)).map((t) => t.name));
    // As the database's owner role, so every app with access can use the new table; all or nothing.
    await manager.withOwner(id, async (c) => {
      await c.query("BEGIN");
      try {
        await c.query(sql);
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK").catch(() => undefined);
        const msg = (e as Error).message;
        if (/does not exist/.test(msg) && /relation/.test(msg)) throw NexusError.invalid(`A linked table doesn't exist yet: ${msg.split("\n")[0]}. Create that table first.`);
        if (/there is no unique constraint matching/.test(msg)) throw NexusError.invalid("A link must point to a key or unique column of the other table.");
        throw NexusError.invalid(`PostgreSQL refused the table: ${msg.split("\n")[0]}`);
      }
    });
    ctx.audit.record({ actor: { type: "user", id: user.id, name: user.displayName }, action: "database.table.create", target: { type: "database", id }, details: { table: design.name } });
    ctx.activity.add("success", `Table ${design.name} was created in ${manager.require(id).name}.`);
    return { ok: true, table: design.name.trim().toLowerCase(), sql };
  });

  app.get("/api/v1/databases/:id/blueprint", async (req) => {
    const { id } = req.params as { id: string };
    requireDbPermission(ctx, req, id, "app.view");
    const { dbs: manager } = dbs();
    const db = manager.require(id);
    const schema = await manager.withReadOnly(id, (c) => readSqlBlueprint(c), 30_000);
    return {
      database: { id: db.id, name: db.name, engine: "PostgreSQL", dbName: db.dbName, generatedAt: new Date().toISOString() },
      connection: { host: "127.0.0.1", port: ctx.postgres?.port ?? null, note: "Reachable only from this computer (and through a private-network link if shared)." },
      connections: connections(ctx, "tables", db.appIds),
      sharedLink: sharedLink(ctx, "tables", id),
      schema,
    };
  });

  app.get("/api/v1/documents/:id/blueprint", async (req) => {
    const { id } = req.params as { id: string };
    requirePermission(req, "server.view");
    const docs = await ctx.startDocuments();
    const db = docs.require(id);
    if (!ctx.documentBrowser) throw NexusError.conflict("Document databases aren't available yet.");
    const schema = await ctx.documentBrowser.blueprint(id);
    return {
      database: { id: db.id, name: db.name, engine: "Document database (MongoDB-compatible, FerretDB)", dbName: db.dbName, generatedAt: new Date().toISOString() },
      connection: { host: "127.0.0.1", port: null, note: "Reachable only from this computer, through Nexus's MongoDB compatibility layer (and through a private-network link if shared)." },
      connections: connections(ctx, "documents", db.appIds),
      sharedLink: sharedLink(ctx, "documents", id),
      schema,
    };
  });
};
