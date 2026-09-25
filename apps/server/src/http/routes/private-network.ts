import { z } from "zod";
import type { RouteModule } from "../server";
import { requirePermission } from "../auth";
import type { PrivateNetworkService } from "../../services/private-network";

/** Settings › External Access › Private network (WireGuard, no account needed). */
export function privateNetworkRoutes(pn: PrivateNetworkService): RouteModule {
  return (app, ctx) => {
    const audit = (by: { id: string; displayName: string }, action: string, details?: Record<string, unknown>) =>
      ctx.audit.record({ actor: { type: "user", id: by.id, name: by.displayName }, action, target: { type: "network", id: "private-network" }, ...(details ? { details } : {}) });

    app.get("/api/v1/network/private", async (req) => {
      requirePermission(req, "server.view");
      return pn.status();
    });

    app.post("/api/v1/network/private/enable", async (req) => {
      const user = requirePermission(req, "network.manage");
      await pn.enable();
      audit(user, "network.private.enable");
      return pn.status();
    });

    app.post("/api/v1/network/private/disable", async (req) => {
      const user = requirePermission(req, "network.manage");
      await pn.disable();
      audit(user, "network.private.disable");
      return pn.status();
    });

    /** Checks the router again (after the owner changed a router setting, say). */
    app.post("/api/v1/network/private/router", async (req) => {
      requirePermission(req, "network.manage");
      return pn.openRouter();
    });

    app.put("/api/v1/network/private/settings", async (req) => {
      const user = requirePermission(req, "network.manage");
      const body = z.object({ endpointHost: z.string().max(253).nullable() }).parse(req.body);
      pn.setEndpointHost(body.endpointHost);
      audit(user, "network.private.settings");
      return pn.status();
    });

    /** Adds a phone or laptop. The configuration contains its private key and is shown only this once. */
    app.post("/api/v1/network/private/devices", async (req, reply) => {
      const user = requirePermission(req, "network.manage");
      const body = z.object({ name: z.string().min(1).max(60) }).parse(req.body);
      const r = await pn.addDevice(body.name);
      audit(user, "network.private.device.add", { device: r.device.name });
      reply.header("Cache-Control", "no-store");
      return r;
    });

    app.delete("/api/v1/network/private/devices/:id", async (req) => {
      const user = requirePermission(req, "network.manage");
      const { id } = req.params as { id: string };
      await pn.removeDevice(id);
      audit(user, "network.private.device.remove", { id });
      return { ok: true };
    });
  };
}
