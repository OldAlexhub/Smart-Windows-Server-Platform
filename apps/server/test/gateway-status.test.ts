import type { GatewaySite } from "@nexus/network";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NexusContext } from "../src/context";
import { GatewayService } from "../src/services/gateway";
import { createContext, tempHome } from "./helpers";

let ctx: NexusContext;
let dispose: () => void;
let gateway: GatewayService;
let webPort: number;
let httpsPort: number;
let sites: GatewaySite[] = [];

const site = (publicHosts: string[]): GatewaySite => ({ id: "shop", name: "Shop", localHost: "shop.nexus.localhost", publicHosts, access: "internet", upstreamPort: null });

beforeAll(async () => {
  const t = tempHome();
  dispose = t.dispose;
  ctx = await createContext(t.home);
  webPort = await ctx.ports.allocate("t", "web");
  httpsPort = await ctx.ports.allocate("t", "s");
  // Like an installed Nexus: the local *.nexus.localhost addresses share the public web port.
  ctx.settings.set("gateway", { httpPort: webPort, httpsPort, localPort: webPort, insecureHttp: true, manageFirewall: false });
  gateway = new GatewayService(ctx);
  gateway.setSitesProvider(() => sites);
}, 60_000);

afterAll(async () => {
  await ctx?.shutdown();
  dispose?.();
}, 60_000);

describe.runIf(process.platform === "win32")("gateway runtime", () => {
  it("before anything is public, the gateway runs on private ports and reports them", async () => {
    sites = [site([])];
    expect(await gateway.sync()).toEqual({ ok: true });
    const rt = await gateway.runtime({ inspectListener: false });
    expect(rt).toMatchObject({ installed: true, running: true, publicExpected: false, fallback: false, configuredHttpsPort: httpsPort, appliedHosts: [] });
    expect(rt.activeHttpsPort).not.toBe(httpsPort);
  }, 60_000);

  it("publishing the first app takes the web ports even though our own gateway already holds one of them locally", async () => {
    // Regression: the gateway's own loopback listener for local addresses was mistaken for
    // "another program", so internet access fell back to private ports and HTTPS never started.
    sites = [site(["shop.example.com"])];
    expect(await gateway.sync()).toEqual({ ok: true });
    expect(gateway.problem).toBeNull();
    const rt = await gateway.runtime({ inspectListener: false });
    expect(rt).toMatchObject({ running: true, publicExpected: true, fallback: false, activeHttpPort: webPort, activeHttpsPort: httpsPort, appliedHosts: ["shop.example.com"] });
  }, 60_000);

  it("Try Again for certificates reloads the unchanged configuration", async () => {
    expect(await gateway.sync({ force: true })).toEqual({ ok: true });
    expect((await gateway.runtime({ inspectListener: false })).running).toBe(true);
  }, 60_000);
});
