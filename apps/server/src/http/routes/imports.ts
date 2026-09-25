import { z } from "zod";
import { NexusError } from "@nexus/shared";
import type { DataImportService } from "../../services/imports";
import type { RouteModule } from "../server";
import { requireDbPermission } from "./data";

const column = z
  .object({
    source: z.string().min(1).max(255),
    name: z.string().min(1).max(63),
    type: z.enum(["text", "integer", "decimal", "date", "timestamp", "boolean"]),
    format: z.string().max(40).nullable().optional(),
    include: z.boolean(),
  })
  .strict();

const plan = z
  .object({
    table: z.string().min(1).max(63),
    mode: z.enum(["create", "append"]),
    columns: z.array(column).min(1).max(500),
    primaryKey: z.array(z.string().min(1).max(63)).max(16).nullable(),
    sheet: z.string().min(1).max(255).nullable().optional(),
  })
  .strict();

/** Upload, inspect, review and commit a CSV/Excel/JSON import. */
export const importRoutes =
  (imports: DataImportService): RouteModule =>
  (app, ctx) => {
    app.post("/api/v1/databases/:id/imports", async (req) => {
      const { id } = req.params as { id: string };
      requireDbPermission(ctx, req, id, "app.data.write");
      const part = await req.file({ limits: { files: 1, fileSize: 5 * 1024 ** 3 } });
      if (!part) throw NexusError.invalid("Choose a CSV, Excel (.xlsx) or JSON file.");
      const result = await imports.receive(id, part.filename, part.file);
      if (part.file.truncated) {
        imports.cancel(id, result.importId);
        throw NexusError.invalid("That file is too large to import.");
      }
      return result;
    });

    app.post("/api/v1/databases/:id/imports/:importId/analyze", async (req) => {
      const { id, importId } = req.params as { id: string; importId: string };
      requireDbPermission(ctx, req, id, "app.data.write");
      const { sheet } = z
        .object({ sheet: z.string().min(1).max(255).nullable().optional() })
        .strict()
        .parse(req.body);
      return imports.analyze(id, importId, sheet);
    });

    app.post("/api/v1/databases/:id/imports/:importId/run", async (req) => {
      const { id, importId } = req.params as { id: string; importId: string };
      const { user } = requireDbPermission(ctx, req, id, "app.data.write");
      const body = plan.parse(req.body);
      const result = await imports.run(id, importId, body, body.sheet);
      ctx.audit.record({
        actor: { type: "user", id: user.id, name: user.displayName },
        action: "database.import",
        target: { type: "database", id },
        details: { table: result.table, rows: result.rows, mode: body.mode },
      });
      return result;
    });

    app.delete("/api/v1/databases/:id/imports/:importId", async (req) => {
      const { id, importId } = req.params as { id: string; importId: string };
      requireDbPermission(ctx, req, id, "app.data.write");
      imports.cancel(id, importId);
      return { ok: true };
    });
  };
