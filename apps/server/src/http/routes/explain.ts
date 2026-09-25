import type { RouteModule } from "../server";
import { requirePermission } from "../auth";
import type { ExplainService } from "../../services/explain";

/** "Explain this" for application problems and failed pipeline runs. */
export function explainRoutes(x: ExplainService): RouteModule {
  return (app) => {
    app.post("/api/v1/apps/:id/explain", async (req) => {
      const { id } = req.params as { id: string };
      requirePermission(req, "app.logs", id);
      return x.explainApp(id);
    });

    app.post("/api/v1/pipeline-runs/:runId/explain", async (req) => {
      requirePermission(req, "pipelines.view");
      return x.explainRun((req.params as { runId: string }).runId);
    });
  };
}
