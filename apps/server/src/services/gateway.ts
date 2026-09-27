import { userInfo } from "node:os";
import { join } from "node:path";
import { adminAlive, CaddyGateway, FirewallManager, isPortAvailable, portOwner, type GatewayConfig, type GatewayRuntime, type GatewaySite } from "@nexus/network";
import { BRAND, type FriendlyProblem } from "@nexus/shared";
import type { NexusContext } from "../context";

export interface GatewaySettings {
  httpPort: number;
  httpsPort: number;
  /** Port for *.nexus.localhost addresses; 80 when free. */
  localPort: number | null;
  acmeEmail: string | null;
  /** Public sites use internal certificates (tunnel mode). */
  tlsInternal: boolean;
  /** Development/tests only: public sites over plain HTTP. */
  insecureHttp: boolean;
  /** Open Windows Firewall for 80/443 when an app is on the internet. */
  manageFirewall: boolean;
}

/** The ports the gateway was last started with (persisted so a restarted Nexus can adopt it). */
interface ActivePorts {
  http: number;
  https: number;
  public: boolean;
  fallback?: boolean;
  /** Port of the local *.nexus.localhost addresses. */
  local?: number;
}

const CADDY_PROCESS = /^caddy(\.exe)?$/i;

export const DEFAULT_GATEWAY: GatewaySettings = {
  httpPort: 80,
  httpsPort: 443,
  localPort: null,
  acmeEmail: null,
  tlsInternal: false,
  insecureHttp: false,
  manageFirewall: true,
};

/**
 * Keeps the HTTPS gateway in sync with the applications. Every change (deploy, access mode,
 * domain, stop/start) re-renders the configuration and reloads it without dropping connections.
 */
export class GatewayService {
  private gateway: CaddyGateway | null = null;
  private resolvedLocalPort: number | null = null;
  private sitesProvider: () => GatewaySite[] = () => [];
  private privateNetworkProvider: () => Promise<GatewayConfig["privateNetwork"]> = async () => null;
  /** The configuration the running gateway is serving (last one it accepted). */
  private applied: GatewayConfig | null = null;
  lastError: string | null = null;
  /** Plain-language explanation when internet access can't use its normal ports. */
  problem: FriendlyProblem | null = null;

  constructor(private readonly ctx: NexusContext) {}

  get available(): boolean {
    return !!this.ctx.component("caddy");
  }

  settings(): GatewaySettings {
    return { ...DEFAULT_GATEWAY, ...this.ctx.settings.get<Partial<GatewaySettings>>("gateway", {}) };
  }

  setSitesProvider(fn: () => GatewaySite[]): void {
    this.sitesProvider = fn;
  }

  setPrivateNetworkProvider(fn: () => Promise<GatewayConfig["privateNetwork"]>): void {
    this.privateNetworkProvider = fn;
  }

  /**
   * Only the installed Nexus (the Windows service) may take the standard web ports. A portable or
   * test copy uses private ports, so it never blocks the installed Nexus from publishing apps.
   */
  private get mayUseWebPorts(): boolean {
    return process.env.NODE_ENV === "production" && !process.env.NEXUS_DATA_ROOT && userInfo().username.toUpperCase() === "SYSTEM";
  }

  /** The port behind http://<app>.nexus.localhost — 80 if free (installed Nexus only), otherwise a private one. */
  async localPort(): Promise<number> {
    if (this.resolvedLocalPort) return this.resolvedLocalPort;
    const s = this.settings();
    if (s.localPort) return (this.resolvedLocalPort = s.localPort);
    // Our gateway from before a restart still holds its local port: keep it rather than treating it as taken.
    const saved = this.savedPorts();
    if (saved?.local && (await adminAlive(await this.ctx.ports.allocate("gateway", "admin")))) return (this.resolvedLocalPort = saved.local);
    this.resolvedLocalPort = this.mayUseWebPorts && (await isPortAvailable(80)) ? 80 : await this.ctx.ports.allocate("gateway", "local-http");
    return this.resolvedLocalPort;
  }

  localUrl(slug: string): string {
    const p = this.resolvedLocalPort ?? 80;
    return `http://${slug}.${BRAND.localDomainSuffix}${p === 80 ? "" : `:${p}`}`;
  }

  /**
   * Which ports the gateway listens on for public traffic:
   *  - nothing published → private ports (80/443 aren't needed, nothing to conflict with);
   *  - published and 80/443 free → 80/443;
   *  - published but another program holds 80/443 → private ports so local access keeps working,
   *    plus a plain-language problem naming the program.
   */
  private async publicPorts(needsPublic: boolean, adminPort: number): Promise<{ http: number; https: number }> {
    const s = this.settings();
    const saved = this.savedPorts();
    const ours = await adminAlive(adminPort);
    // Keep the ports our running (or left-over) gateway already holds — unless they are a
    // fallback, in which case check again whether the normal web ports have become free.
    if (saved && !saved.fallback && saved.public === needsPublic && ours) return { http: saved.http, https: saved.https };
    // Ports our own gateway holds are not a conflict (for example 80 for the local
    // *.nexus.localhost addresses when the first application goes public): the reload moves them.
    const held = new Set(ours && saved ? [saved.http, saved.https, saved.local] : []);
    const available = async (p: number) => held.has(p) || (await isPortAvailable(p));
    let ports: { http: number; https: number };
    this.problem = null;
    if (!needsPublic) {
      ports = await this.privatePorts(adminPort);
    } else if ((await available(s.httpPort)) && (await available(s.httpsPort))) {
      ports = { http: s.httpPort, https: s.httpsPort };
    } else {
      const owners = (await Promise.all([portOwner(s.httpPort), portOwner(s.httpsPort)])).filter((o): o is { pid: number; name: string } => !!o);
      // Another Nexus gateway (a portable or test copy) shows up as "caddy": say what it really is.
      const names = [...new Set(owners.map((o) => (CADDY_PROCESS.test(o.name) ? "another copy of Nexus (for example a portable copy)" : o.name)))].join(" and ") || "another program";
      this.problem = {
        title: "Internet access is blocked by another program",
        summary: `${names} is using the web ports (${s.httpPort}/${s.httpsPort}) that internet access needs. Your applications still work on this computer.`,
        checks: [
          { label: `Port ${s.httpPort}`, status: owners.some((o) => o) ? "failed" : "ok" },
          { label: "Secure gateway", status: "ok", detail: "Running on private ports" },
        ],
        cause: owners.some((o) => CADDY_PROCESS.test(o.name))
          ? "Stop the other copy of Nexus (in a portable copy, double-click Stop Nexus.cmd), then press Try Again."
          : `Stop or reconfigure ${names} (for example, turn off its web server), then press Try Again. Or publish through a secure tunnel, which doesn't need these ports.`,
        repair: { id: "gateway.retry", label: "Try Again", requiresConfirmation: false },
        technical: owners.map((o) => `${o.name} (process ${o.pid})`).join(", "),
      };
      ports = await this.privatePorts(adminPort);
    }
    this.ctx.settings.set("gateway.activePorts", { ...ports, public: needsPublic, fallback: !!this.problem, local: saved?.local } satisfies ActivePorts);
    return ports;
  }

  private savedPorts(): ActivePorts | null {
    return this.ctx.settings.get<ActivePorts | null>("gateway.activePorts", null);
  }

  private get storageDir(): string {
    return join(this.ctx.opts.paths.gateway, "data");
  }

  private get logFile(): string {
    return join(this.ctx.opts.paths.logs, "gateway.log");
  }

  /** Public addresses the gateway should serve (applications and remote administration). */
  private publicHosts(sites: GatewaySite[], management: GatewayConfig["management"]): string[] {
    return [...sites.filter((x) => x.access !== "private").flatMap((x) => x.publicHosts), ...(management ? [management.publicHost] : [])].map((h) => h.toLowerCase());
  }

  /** Private gateway ports, moved elsewhere if another program has taken them (unless it is our own gateway). */
  private async privatePorts(adminPort: number): Promise<{ http: number; https: number }> {
    const ours = await adminAlive(adminPort);
    const http = await this.ctx.ports.ensureAvailable("gateway", "http-private", ours);
    const https = await this.ctx.ports.ensureAvailable("gateway", "https-private", ours);
    return { http: http.port, https: https.port };
  }

  async config(): Promise<GatewayConfig> {
    const s = this.settings();
    const ra = this.ctx.settings.get<{ enabled: boolean; publicHost: string | null }>("remoteAdmin", { enabled: false, publicHost: null });
    const sites = this.sitesProvider();
    const management = ra.enabled && ra.publicHost ? { publicHost: ra.publicHost } : null;
    const adminPort = await this.ctx.ports.allocate("gateway", "admin");
    const ports = await this.publicPorts(this.publicHosts(sites, management).length > 0, adminPort);
    const localPort = await this.localPort();
    const saved = this.savedPorts();
    if (saved && saved.local !== localPort) this.ctx.settings.set("gateway.activePorts", { ...saved, local: localPort } satisfies ActivePorts);
    return {
      adminPort,
      httpPort: ports.http,
      httpsPort: ports.https,
      localPort,
      nexusPort: this.ctx.opts.managementPort,
      acmeEmail: s.acmeEmail,
      storageDir: this.storageDir,
      logFile: this.logFile,
      sites: sites.map((site) => ({ ...site, tlsInternal: s.tlsInternal || site.tlsInternal })),
      management,
      privateNetwork: await this.privateNetworkProvider(),
      disableAutoHttps: s.insecureHttp,
    };
  }

  /**
   * Applies the current configuration, starting the gateway if needed. Never throws — reports instead.
   * `force` reloads even an unchanged configuration, which restarts certificate issuance now.
   */
  async sync(opts: { force?: boolean } = {}): Promise<{ ok: boolean; error?: string }> {
    const dir = this.ctx.component("caddy");
    if (!dir) {
      this.lastError = "The secure gateway component is not installed.";
      return { ok: false, error: this.lastError };
    }
    try {
      const cfg = await this.config();
      if (!this.gateway) {
        this.gateway = new CaddyGateway({
          caddyExe: join(dir, "caddy.exe"),
          configPath: join(this.ctx.opts.paths.gateway, "Caddyfile"),
          logger: this.ctx.log.child({ module: "gateway" }),
          onOutput: (l) => this.ctx.logs.write("system:gateway", "stdout", l),
        });
        this.ctx.onStop(() => this.gateway?.stop());
      }
      const v = await this.gateway.validate(cfg);
      if (!v.valid) throw new Error(v.error ?? "Invalid gateway configuration");
      if (opts.force && (await this.gateway.running())) await this.gateway.apply(cfg, { force: true });
      else await this.gateway.start(cfg);
      this.applied = cfg;
      if (!this.problem && this.settings().manageFirewall && this.publicHosts(cfg.sites, cfg.management).length && !this.settings().insecureHttp) {
        const fw = await new FirewallManager().ensureRule(FirewallManager.gatewayRule(join(dir, "caddy.exe"), cfg.httpPort, cfg.httpsPort));
        if (!fw.ok) this.ctx.log.warn("firewall rule not applied", { error: fw.error });
      }
      if (cfg.privateNetwork && this.settings().manageFirewall) {
        const pn = cfg.privateNetwork;
        const fw = await new FirewallManager().ensureRule(FirewallManager.privateNetworkGatewayRule(join(dir, "caddy.exe"), [pn.controlPort, ...pn.sites.map((x) => x.port)], pn.subnetCidr));
        if (!fw.ok) this.ctx.log.warn("private network firewall rule not applied", { error: fw.error });
      }
      this.lastError = null;
      return { ok: true };
    } catch (e) {
      this.lastError = (e as Error).message;
      this.ctx.log.error("gateway sync failed", { err: e as Error });
      return { ok: false, error: this.lastError };
    }
  }

  async running(): Promise<boolean> {
    return (await this.gateway?.running()) ?? false;
  }

  /**
   * The gateway's real state, for status checks: the ports it actually listens on (which may be
   * private fallback ports), whether it is running, which addresses it is serving, and who owns
   * the HTTPS listener. Other modules use this instead of inferring from settings.
   */
  async runtime(opts: { inspectListener?: boolean } = {}): Promise<GatewayRuntime> {
    const s = this.settings();
    const saved = this.savedPorts();
    const cfg = this.applied;
    const running = this.available && (await this.running());
    const activeHttpsPort = cfg?.httpsPort ?? saved?.https ?? null;
    const ra = this.ctx.settings.get<{ enabled: boolean; publicHost: string | null }>("remoteAdmin", { enabled: false, publicHost: null });
    const publicExpected = this.publicHosts(this.sitesProvider(), ra.enabled && ra.publicHost ? { publicHost: ra.publicHost } : null).length > 0;
    const listener: GatewayRuntime["listener"] = { owner: null, ownedByGateway: null };
    if (opts.inspectListener !== false && publicExpected && !s.insecureHttp && activeHttpsPort !== null) {
      listener.owner = await portOwner(activeHttpsPort);
      const pid = this.gateway?.pid() ?? null;
      // An adopted gateway (left running by an earlier Nexus) has no known pid: recognise it by name.
      if (listener.owner) listener.ownedByGateway = running && (pid !== null ? listener.owner.pid === pid : CADDY_PROCESS.test(listener.owner.name));
    }
    return {
      installed: this.available,
      running,
      configuredHttpPort: s.httpPort,
      configuredHttpsPort: s.httpsPort,
      activeHttpPort: cfg?.httpPort ?? saved?.http ?? null,
      activeHttpsPort,
      publicExpected,
      fallback: !!saved?.fallback && saved.public,
      automaticHttps: !s.insecureHttp,
      internalCertificates: s.tlsInternal,
      listener,
      appliedHosts: cfg ? this.publicHosts(cfg.sites, cfg.management) : [],
      error: this.lastError,
      problem: this.problem,
      storageDir: this.storageDir,
      logFile: this.logFile,
    };
  }
}
