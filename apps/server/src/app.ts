import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { PluginManager } from "@nexus/plugins";
import type { NexusContext } from "./context";
import { appApiRoutes } from "./http/routes/app-api";
import { appRoutes } from "./http/routes/apps";
import { repairRoutes } from "./http/routes/repairs";
import { authRoutes } from "./http/routes/auth";
import { dataRoutes } from "./http/routes/data";
import { documentRoutes } from "./http/routes/documents";
import { operationsRoutes } from "./http/routes/operations";
import { notificationRoutes } from "./http/routes/notifications";
import { questionRoutes } from "./http/routes/questions";
import { explainRoutes } from "./http/routes/explain";
import { pipelineRoutes } from "./http/routes/pipelines";
import { importRoutes } from "./http/routes/imports";
import { pluginRoutes } from "./http/routes/plugins";
import { setupRoutes } from "./http/routes/setup";
import { systemRoutes } from "./http/routes/system";
import { buildServer, type RouteModule } from "./http/server";
import { AiService } from "./services/ai";
import { AppManager } from "./services/apps";
import { BackupService } from "./services/backups";
import { GatewayService } from "./services/gateway";
import { DataQuestionService } from "./services/data-questions";
import { ExplainService } from "./services/explain";
import { PrivateNetworkService } from "./services/private-network";
import { privateNetworkRoutes } from "./http/routes/private-network";
import { DatabaseLinkService } from "./services/database-links";
import { databaseLinkRoutes } from "./http/routes/database-links";
import { schemaRoutes } from "./http/routes/schema";
import { PipelineProposalService } from "./services/pipeline-proposals";
import { NotificationService } from "./services/notifications";
import { PipelineService } from "./services/pipelines";
import { DataImportService } from "./services/imports";

export interface NexusServices {
  gateway: GatewayService;
  apps: AppManager;
  backups: BackupService;
  ai: AiService;
  pipelines: PipelineService;
  notifications: NotificationService;
  imports: DataImportService;
  plugins: PluginManager;
  privateNetwork: PrivateNetworkService;
  databaseLinks: DatabaseLinkService;
}

/** Wires every service and route into the Core Service HTTP API. */
export async function createNexusServer(ctx: NexusContext, extraRoutes: RouteModule[] = []): Promise<{ app: FastifyInstance; services: NexusServices }> {
  const gateway = new GatewayService(ctx);
  const apps = new AppManager(ctx, gateway);
  const backups = new BackupService(ctx, apps);
  const ai = new AiService(ctx, apps);
  const notifications = new NotificationService(ctx);
  const pipelines = new PipelineService(ctx, notifications);
  const imports = new DataImportService(ctx, pipelines);
  const plugins = new PluginManager(ctx.store, { root: join(ctx.opts.paths.root, "plugins"), logger: ctx.log.child({ module: "plugins" }) });
  ctx.onStop(() => plugins.stopAll());
  const privateNetwork = new PrivateNetworkService(ctx, gateway, apps);
  const databaseLinks = new DatabaseLinkService(ctx, privateNetwork);
  ctx.onStop(() => databaseLinks.stop());
  const services = { gateway, apps, backups, ai, pipelines, notifications, imports, plugins, privateNetwork, databaseLinks };
  // What the assistant knows about pipelines, backups and notifications.
  ai.extraFacts.push(() =>
    pipelines.available
      ? pipelines.store.list().map((p) => {
          const last = pipelines.engine.runs.list(p.id, 1)[0];
          return `Pipeline ${p.name}: ${p.enabled ? "on" : "off"}${last ? `, last run ${last.status} at ${last.startedAt.slice(0, 16).replace("T", " ")}${last.error ? ` (${last.error.slice(0, 200)})` : ""}` : ", never run"}`;
        })
      : [],
  );
  ai.extraFacts.push(() => {
    const unread = notifications.list({ unreadOnly: true, limit: 5 });
    return unread.length ? [`${notifications.unreadCount()} unread notifications, latest: ${unread.map((n) => `${n.title} — ${n.message}`.slice(0, 200)).join(" | ")}`] : [];
  });
  ai.extraFacts.push(() => apps.list().filter((a) => ctx.backups && !ctx.backups.latestSuccessful(a.id)).map((a) => `Application ${a.name} has no successful backup yet`));
  const app = await buildServer(ctx, [
    authRoutes,
    setupRoutes,
    appRoutes(apps),
    dataRoutes,
    importRoutes(imports),
    pluginRoutes(plugins),
    documentRoutes,
    operationsRoutes(apps, backups),
    systemRoutes(services),
    appApiRoutes(apps),
    repairRoutes(services),
    pipelineRoutes(pipelines, new PipelineProposalService(ctx, pipelines, () => ai.questionModel())),
    notificationRoutes(notifications),
    privateNetworkRoutes(privateNetwork),
    databaseLinkRoutes(databaseLinks),
    schemaRoutes,
    questionRoutes(new DataQuestionService(ctx, () => ai.questionModel())),
    explainRoutes(new ExplainService(ctx, apps, pipelines, () => ai.questionModel())),
    ...extraRoutes,
  ]);
  // First-run setup finishing while the service runs: start background work right away.
  ctx.afterSetup.push(() => startBackground(ctx, services));
  return { app, services };
}

/** Background work once the server is set up: apps, gateway, backups, AI. */
export async function startBackground(ctx: NexusContext, s: NexusServices): Promise<void> {
  if (!ctx.setupCompleted) return;
  await s.plugins.startEnabled();
  await s.apps.autostart();
  void s.privateNetwork.resume().catch((e) => ctx.log.warn("private network could not resume", { err: e as Error }));
  void s.databaseLinks.resume().catch((e) => ctx.log.warn("database links could not resume", { err: e as Error }));
  s.backups.startScheduler();
  s.pipelines.startScheduler();
  void s.ai.start();
}
