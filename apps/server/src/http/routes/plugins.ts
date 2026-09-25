import { z } from "zod";
import { PLUGIN_CAPABILITIES, type PluginCapability, type PluginManager } from "@nexus/plugins";
import type { RouteModule } from "../server";
import { requirePermission } from "../auth";

const capability = z.enum(Object.keys(PLUGIN_CAPABILITIES) as [PluginCapability, ...PluginCapability[]]);
const source = z.object({ sourceDir: z.string().min(1).max(1000) }).strict();
const packageAction = source
  .extend({ approvedCapabilities: z.array(capability).max(20), confirmation: z.string().max(100) })
  .strict();

export function pluginRoutes(plugins: PluginManager): RouteModule {
  return (app, ctx) => {
    app.get("/api/v1/plugins", async (req) => {
      requirePermission(req, "plugins.manage");
      return { capabilities: plugins.capabilities(), plugins: plugins.list() };
    });

    app.post("/api/v1/plugins/inspect", async (req) => {
      requirePermission(req, "plugins.manage");
      const { sourceDir } = source.parse(req.body);
      return plugins.inspect(sourceDir);
    });

    app.post("/api/v1/plugins", async (req) => {
      const user = requirePermission(req, "plugins.manage");
      const body = packageAction.parse(req.body);
      const plugin = await plugins.install(body.sourceDir, body.approvedCapabilities, body.confirmation);
      ctx.audit.record({
        actor: { type: "user", id: user.id, name: user.displayName },
        action: "plugin.install",
        target: { type: "plugin", id: plugin.id },
        details: { version: plugin.version, capabilities: plugin.capabilities.map((c) => c.id) },
      });
      ctx.activity.add("info", `${plugin.name} ${plugin.version} was installed and left switched off.`);
      return plugin;
    });

    app.post("/api/v1/plugins/:id/update", async (req) => {
      const user = requirePermission(req, "plugins.manage");
      const { id } = req.params as { id: string };
      const body = packageAction.parse(req.body);
      const current = plugins.require(id);
      const plugin = await plugins.update(id, body.sourceDir, body.approvedCapabilities, body.confirmation);
      ctx.audit.record({
        actor: { type: "user", id: user.id, name: user.displayName },
        action: "plugin.update",
        target: { type: "plugin", id },
        details: { from: current.version, to: plugin.version, capabilities: plugin.capabilities.map((c) => c.id) },
      });
      ctx.activity.add("info", `${plugin.name} was updated from ${current.version} to ${plugin.version}.`);
      return plugin;
    });

    app.put("/api/v1/plugins/:id/enabled", async (req) => {
      const user = requirePermission(req, "plugins.manage");
      const { id } = req.params as { id: string };
      const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(req.body);
      const plugin = await plugins.setEnabled(id, enabled);
      ctx.audit.record({
        actor: { type: "user", id: user.id, name: user.displayName },
        action: enabled ? "plugin.enable" : "plugin.disable",
        target: { type: "plugin", id },
        outcome: plugin.status === "crashed" || plugin.status === "tampered" ? "failure" : "success",
        details: { status: plugin.status },
      });
      ctx.activity.add(
        plugin.status === "crashed" || plugin.status === "tampered" ? "problem" : "info",
        enabled ? `${plugin.name} was turned on (${plugin.status}).` : `${plugin.name} was turned off.`,
      );
      return plugin;
    });

    app.post("/api/v1/plugins/:id/restart", async (req) => {
      const user = requirePermission(req, "plugins.manage");
      const { id } = req.params as { id: string };
      const plugin = await plugins.restart(id);
      ctx.audit.record({
        actor: { type: "user", id: user.id, name: user.displayName },
        action: "plugin.restart",
        target: { type: "plugin", id },
      });
      return plugin;
    });

    app.delete("/api/v1/plugins/:id", async (req) => {
      const user = requirePermission(req, "plugins.manage");
      const { id } = req.params as { id: string };
      const { confirmation } = z
        .object({ confirmation: z.string().max(100) })
        .strict()
        .parse(req.body);
      const plugin = plugins.require(id);
      await plugins.uninstall(id, confirmation);
      ctx.audit.record({
        actor: { type: "user", id: user.id, name: user.displayName },
        action: "plugin.uninstall",
        target: { type: "plugin", id },
        details: { version: plugin.version },
      });
      ctx.activity.add("info", `${plugin.name} was removed.`);
      return { ok: true };
    });
  };
}
