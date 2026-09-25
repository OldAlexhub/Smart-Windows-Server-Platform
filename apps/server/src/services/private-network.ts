import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  addPortMapping,
  DEFAULT_WIREGUARD_PORT,
  deletePortMapping,
  detectPublicIp,
  discoverGateway,
  FirewallManager,
  isSharedAddress,
  locateWireGuard,
  nextDeviceAddress,
  pickSubnet,
  presharedKey,
  renderDeviceConfig,
  renderServerConfig,
  routerExternalAddress,
  serverAddress,
  subnetCidr,
  wireguardKeys,
  WireGuardTunnel,
  type GatewayConfig,
  type Subnet,
  type WireGuardDevice,
  type WireGuardProgram,
} from "@nexus/network";
import { NexusError } from "@nexus/shared";
import type { NexusContext } from "../context";
import type { AppManager } from "./apps";
import type { GatewayService } from "./gateway";

export const PRIVATE_NETWORK_SETTING = "privateNetwork";
const SERVER_KEY = "system/private-network/server-key";
const MARKER_KEY = "system/private-network/marker";
const psk = (id: string) => `system/private-network/psk/${id}`;
const PORT_OWNER = "private-network";

export interface PrivateNetworkSettings {
  enabled: boolean;
  subnet: Subnet | null;
  port: number;
  serverPublicKey: string | null;
  /** What devices dial: a domain name, or empty to use this network's public address. */
  endpointHost: string | null;
  devices: (Omit<WireGuardDevice, "presharedKey"> & { createdAt: string })[];
  /** Rotated when the network is switched off, so pending sign-ins through it stop working. */
  authRevision: string;
}

const DEFAULTS: PrivateNetworkSettings = { enabled: false, subnet: null, port: DEFAULT_WIREGUARD_PORT, serverPublicKey: null, endpointHost: null, devices: [], authRevision: "0" };

export interface RouterState {
  status: "forwarded" | "manual" | "shared_address" | "unknown";
  message: string;
}

/**
 * Nexus's own private network (WireGuard): no account and no company in the middle. Phones and
 * laptops get a QR code; once connected they reach this computer's apps and control center (with
 * sign-in and two-step verification) — and nothing else on the local network.
 */
export class PrivateNetworkService {
  private router: RouterState = { status: "unknown", message: "" };

  constructor(
    private readonly ctx: NexusContext,
    private readonly gateway: GatewayService,
    private readonly apps: AppManager,
  ) {
    gateway.setPrivateNetworkProvider(() => this.gatewayPart());
  }

  settings(): PrivateNetworkSettings {
    return { ...DEFAULTS, ...this.ctx.settings.get<Partial<PrivateNetworkSettings>>(PRIVATE_NETWORK_SETTING, {}) };
  }

  private save(s: PrivateNetworkSettings): void {
    this.ctx.settings.set(PRIVATE_NETWORK_SETTING, s);
  }

  private program(): WireGuardProgram {
    const p = locateWireGuard();
    if (!p) {
      throw new NexusError("conflict", "WireGuard isn't installed on this computer yet.", {
        problem: {
          title: "Install WireGuard first",
          summary: "The private network uses WireGuard: free, open source, and no account needed. Install it from wireguard.com/install (choose Windows), then press Set up again.",
          checks: [{ label: "WireGuard for Windows", status: "failed" }],
        },
      });
    }
    return p;
  }

  private get configFile(): string {
    return join(this.ctx.opts.paths.root, "wireguard", "nexus.conf");
  }

  /** The secret the gateway adds to requests from the private network (see gateway.ts). */
  marker(): string | null {
    return this.settings().enabled ? (this.ctx.vault.get(MARKER_KEY) ?? null) : null;
  }

  private async gatewayPart(): Promise<GatewayConfig["privateNetwork"]> {
    const s = this.settings();
    const marker = this.marker();
    if (!s.enabled || !s.subnet || !marker) return null;
    const sites = [];
    for (const a of this.apps.list()) sites.push({ siteId: a.id, port: await this.ctx.ports.allocate(PORT_OWNER, a.id) });
    return { subnetCidr: subnetCidr(s.subnet), marker, controlPort: await this.ctx.ports.allocate(PORT_OWNER, "control-center"), sites };
  }

  private async writeAndInstall(s: PrivateNetworkSettings): Promise<void> {
    const privateKey = this.ctx.vault.get(SERVER_KEY);
    if (!privateKey || !s.subnet) throw new Error("The private network isn't set up.");
    const devices = s.devices.map((d) => ({ ...d, presharedKey: this.ctx.vault.require(psk(d.id)) }));
    mkdirSync(join(this.ctx.opts.paths.root, "wireguard"), { recursive: true });
    writeFileSync(this.configFile, renderServerConfig({ subnet: s.subnet, port: s.port, privateKey, devices }));
    await new WireGuardTunnel(this.program()).install(this.configFile);
  }

  async status() {
    const s = this.settings();
    const program = locateWireGuard();
    const tunnel = program ? new WireGuardTunnel(program) : null;
    const running = s.enabled && tunnel ? await tunnel.running() : false;
    const peers = running && tunnel ? await tunnel.peers() : [];
    const address = s.subnet ? serverAddress(s.subnet) : null;
    const part = s.enabled ? await this.gatewayPart() : null;
    const byId = new Map(this.apps.list().map((a) => [a.id, a.name]));
    return {
      wireguardInstalled: !!program,
      enabled: s.enabled,
      running,
      address,
      port: s.port,
      endpointHost: s.endpointHost,
      router: this.router,
      controlCenterUrl: part && address ? `http://${address}:${part.controlPort}` : null,
      apps: part && address ? part.sites.map((x) => ({ appId: x.siteId, name: byId.get(x.siteId) ?? x.siteId, url: `http://${address}:${x.port}` })) : [],
      devices: s.devices.map((d) => {
        const p = peers.find((x) => x.publicKey === d.publicKey);
        return { id: d.id, name: d.name, address: d.address, createdAt: d.createdAt, lastSeen: p?.lastHandshake?.toISOString() ?? null };
      }),
    };
  }

  /** Turns the private network on (idempotent): keys, tunnel, firewall, router, gateway. */
  async enable(): Promise<void> {
    const program = this.program();
    const s = this.settings();
    if (!this.ctx.vault.get(SERVER_KEY) || !s.serverPublicKey) {
      const keys = wireguardKeys();
      this.ctx.vault.set(SERVER_KEY, keys.privateKey, "system");
      s.serverPublicKey = keys.publicKey;
    }
    if (!this.ctx.vault.get(MARKER_KEY)) this.ctx.vault.set(MARKER_KEY, randomBytes(24).toString("base64url"), "system");
    s.subnet ??= pickSubnet();
    s.enabled = true;
    this.save(s);
    try {
      await this.writeAndInstall(s);
    } catch (e) {
      this.save({ ...s, enabled: false });
      throw e;
    }
    const fw = new FirewallManager();
    const r = await fw.ensureRule(FirewallManager.wireguardRule(program.wireguard, s.port));
    if (!r.ok) this.ctx.log.warn("private network firewall rule not applied", { error: r.error });
    await this.syncGateway();
    this.ctx.activity.add("success", "The private network is on. Add your phone or laptop to reach Nexus from anywhere.");
    void this.openRouter();
  }

  async disable(): Promise<void> {
    const s = this.settings();
    const program = locateWireGuard();
    if (program) await new WireGuardTunnel(program).uninstall();
    rmSync(this.configFile, { force: true });
    const fw = new FirewallManager();
    await fw.removeRule(FirewallManager.wireguardRule("", s.port).name);
    await fw.removeRule(FirewallManager.privateNetworkGatewayRule("", [1], "10.0.0.0/24").name);
    this.save({ ...s, enabled: false, authRevision: randomUUID() });
    await this.gateway.sync();
    void this.closeRouter(s.port);
    this.router = { status: "unknown", message: "" };
    this.ctx.activity.add("info", "The private network was switched off.");
  }

  /** Re-applies the gateway (which also opens its private-network ports to the network only). */
  async syncGateway(): Promise<void> {
    await this.gateway.sync();
  }

  /** Adds a phone or laptop. The returned configuration (and its QR code) is shown once. */
  async addDevice(name: string): Promise<{ device: { id: string; name: string; address: string }; config: string }> {
    const label = name.trim().slice(0, 60);
    if (!label) throw NexusError.invalid("Give the device a name, like “My phone”.");
    const s = this.settings();
    if (!s.enabled || !s.subnet || !s.serverPublicKey) throw NexusError.conflict("Set up the private network first.");
    const endpointHost = s.endpointHost || (await detectPublicIp());
    if (!endpointHost) throw NexusError.conflict("Nexus couldn't find this network's public address. Check the internet connection, or enter the address devices should use.");
    const keys = wireguardKeys();
    const device = { id: randomUUID(), name: label, address: nextDeviceAddress(s.subnet, s.devices.map((d) => d.address)), publicKey: keys.publicKey };
    const shared = presharedKey();
    this.ctx.vault.set(psk(device.id), shared, "system");
    const next = { ...s, devices: [...s.devices, { ...device, createdAt: new Date().toISOString() }] };
    this.save(next);
    try {
      await this.writeAndInstall(next);
    } catch (e) {
      this.save(s);
      this.ctx.vault.delete(psk(device.id));
      throw e;
    }
    const endpoint = `${endpointHost.includes(":") ? `[${endpointHost}]` : endpointHost}:${s.port}`;
    return {
      device: { id: device.id, name: device.name, address: device.address },
      config: renderDeviceConfig({ device: { ...device, presharedKey: shared }, devicePrivateKey: keys.privateKey, serverPublicKey: s.serverPublicKey, subnet: s.subnet, endpoint }),
    };
  }

  async removeDevice(id: string): Promise<void> {
    const s = this.settings();
    if (!s.devices.some((d) => d.id === id)) throw NexusError.notFound("Device");
    const next = { ...s, devices: s.devices.filter((d) => d.id !== id) };
    this.save(next);
    this.ctx.vault.delete(psk(id));
    if (next.enabled) await this.writeAndInstall(next);
  }

  setEndpointHost(host: string | null): void {
    const h = host?.trim().toLowerCase() || null;
    if (h && !/^[a-z0-9.-]{1,253}$/.test(h)) throw NexusError.invalid("Enter a domain name like home.example.com, or leave it empty.");
    this.save({ ...this.settings(), endpointHost: h });
  }

  /** Asks the router to forward WireGuard's port, and checks whether outside connections are possible at all. */
  async openRouter(): Promise<RouterState> {
    const s = this.settings();
    const manual = `Forward UDP port ${s.port} on your router to this computer, or turn on UPnP in the router's settings.`;
    try {
      const g = await discoverGateway();
      if (!g) return (this.router = { status: "manual", message: `Your router didn't answer automatic setup. ${manual}` });
      const external = await routerExternalAddress(g).catch(() => null);
      if (external && isSharedAddress(external)) {
        return (this.router = {
          status: "shared_address",
          message: "Your internet provider shares one public address between customers (CGNAT), so devices outside can't connect in. Ask your provider for a public IP address; until then the private network works only at home.",
        });
      }
      try {
        await addPortMapping(g, { port: s.port, protocol: "UDP", description: "Nexus private network" });
      } catch {
        // Some routers only accept time-limited forwards.
        await addPortMapping(g, { port: s.port, protocol: "UDP", description: "Nexus private network", leaseSeconds: 7 * 24 * 3600 });
      }
      return (this.router = { status: "forwarded", message: `Your router forwards UDP port ${s.port} to this computer.` });
    } catch (e) {
      return (this.router = { status: "manual", message: `${(e as Error).message} ${manual}` });
    }
  }

  private async closeRouter(port: number): Promise<void> {
    const g = await discoverGateway().catch(() => null);
    if (g) await deletePortMapping(g, { port, protocol: "UDP" }).catch(() => undefined);
  }

  /** On service start: renew the router forward (routers forget them) and re-apply firewall rules. */
  async resume(): Promise<void> {
    if (!this.settings().enabled) return;
    await this.syncGateway().catch((e) => this.ctx.log.warn("private network gateway sync failed", { err: e as Error }));
    await this.openRouter();
  }
}
