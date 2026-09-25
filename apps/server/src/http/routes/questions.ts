import { z } from "zod";
import type { RouteModule } from "../server";
import type { DataQuestionService } from "../../services/data-questions";
import { requireDbPermission } from "./data";

/** Questions about a database's data: in plain English (AI) or as SQL — always read-only. */
export function questionRoutes(q: DataQuestionService): RouteModule {
  return (app, ctx) => {
    app.post("/api/v1/databases/:id/ask", async (req) => {
      const { id } = req.params as { id: string };
      const { user } = requireDbPermission(ctx, req, id, "app.data.read");
      const { question } = z.object({ question: z.string().min(1).max(2000) }).parse(req.body);
      const answer = await q.ask(id, question);
      ctx.audit.record({ actor: { type: "user", id: user.id, name: user.displayName }, action: "data.question", target: { type: "database", id }, details: { question, sql: answer.sql } });
      return answer;
    });

    app.post("/api/v1/databases/:id/query", async (req) => {
      const { id } = req.params as { id: string };
      const { user } = requireDbPermission(ctx, req, id, "app.data.read");
      const { sql } = z.object({ sql: z.string().min(1).max(20_000) }).parse(req.body);
      const answer = await q.query(id, sql);
      ctx.audit.record({ actor: { type: "user", id: user.id, name: user.displayName }, action: "data.query", target: { type: "database", id }, details: { sql } });
      return answer;
    });
  };
}
