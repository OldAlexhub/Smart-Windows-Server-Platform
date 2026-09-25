import { execFile } from "node:child_process";

/**
 * How this computer can be reached from outside. Nexus hides the technology;
 * the user only picks "Private only" / "Internet accessible" / "Authorized users" / "API only".
 */
export type ProviderId = "direct" | "cloudflare-tunnel" | "tailscale";

export interface ProviderStatus {
  id: ProviderId;
  label: string;
  /** Plain-language explanation shown in Settings > External Access. */
  description: string;
  kind: "public" | "private";
  installed: boolean;
  configured: boolean;
  connected: boolean;
  detail?: string;
}

export interface DnsRecord {
  type: "A" | "AAAA" | "CNAME";
  name: string;
  value: string;
  /** "Point taxiops.example.com to 203.0.113.7" */
  instruction: string;
}

export interface PublishTarget {
  hostname: string;
  /** Local HTTPS gateway port the provider forwards to. */
  gatewayHttpsPort: number;
}

export interface ReachabilityProvider {
  readonly id: ProviderId;
  status(): Promise<ProviderStatus>;
  /** DNS records the owner must create (if any) for these hostnames. */
  dnsRecords(hostnames: string[], ctx: { publicIp?: string | null }): DnsRecord[];
  /** Whether public certificates can be issued automatically via ACME HTTP/TLS challenges. */
  readonly acmeCompatible: boolean;
  /** Ports that must be allowed inbound in Windows Firewall. */
  readonly inboundPorts: number[];
}

type Exec = (file: string, args: string[]) => Promise<{ code: number; out: string }>;
const defaultExec: Exec = (file, args) =>
  new Promise((resolve) =>
    execFile(file, args, { windowsHide: true, timeout: 15_000 }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: `${stdout}${stderr}` }),
    ),
  );

// ------------------------------------------------------------------ direct (port forwarding)

export class DirectProvider implements ReachabilityProvider {
  readonly id = "direct" as const;
  readonly acmeCompatible = true;
  readonly inboundPorts = [80, 443];

  constructor(private readonly opts: { publicIp?: () => Promise<string | null> } = {}) {}

  async status(): Promise<ProviderStatus> {
    const ip = (await this.opts.publicIp?.()) ?? null;
    return {
      id: this.id,
      label: "Direct connection",
      description: "Visitors connect straight to this computer. Your router must forward ports 80 and 443 to it.",
      kind: "public",
      installed: true,
      configured: ip !== null,
      connected: ip !== null,
      ...(ip ? { detail: `Public address ${ip}` } : { detail: "Public address unknown (offline?)" }),
    };
  }

  dnsRecords(hostnames: string[], ctx: { publicIp?: string | null }): DnsRecord[] {
    const ip = ctx.publicIp;
    if (!ip) return [];
    const v6 = ip.includes(":");
    return hostnames.map((h) => ({
      type: v6 ? "AAAA" : "A",
      name: h,
      value: ip,
      instruction: `At your domain provider, create an ${v6 ? "AAAA" : "A"} record for ${h} pointing to ${ip}.`,
    }));
  }
}

// ------------------------------------------------------------------ Cloudflare Tunnel

export interface TunnelIngress {
  hostname: string;
  service: string;
  originRequest: { originServerName: string; noTLSVerify: boolean };
}

/**
 * Renders a cloudflared config: every public hostname goes to the local HTTPS gateway (so
 * authentication, headers and routing still happen in Nexus), unknown hosts get a 404.
 */
export function renderTunnelConfig(tunnelId: string, credentialsFile: string, targets: PublishTarget[]): string {
  if (!/^[0-9a-f-]{36}$/i.test(tunnelId)) throw new Error("Invalid tunnel id.");
  const lines = [`tunnel: ${tunnelId}`, `credentials-file: "${credentialsFile.replace(/\\/g, "/").replace(/"/g, "")}"`, "ingress:"];
  for (const t of targets) {
    if (!/^[a-z0-9.-]+$/i.test(t.hostname)) throw new Error(`Invalid hostname ${t.hostname}`);
    lines.push(
      `  - hostname: ${t.hostname}`,
      `    service: https://127.0.0.1:${t.gatewayHttpsPort}`,
      "    originRequest:",
      `      originServerName: ${t.hostname}`,
      // The gateway uses an internal certificate behind the tunnel; the tunnel itself is encrypted.
      "      noTLSVerify: true",
    );
  }
  lines.push("  - service: http_status:404", "");
  return lines.join("\n");
}

export class CloudflareTunnelProvider implements ReachabilityProvider {
  readonly id = "cloudflare-tunnel" as const;
  /** Traffic arrives through the tunnel, so the gateway uses internal certificates. */
  readonly acmeCompatible = false;
  readonly inboundPorts: number[] = [];

  constructor(
    private readonly opts: { cloudflaredExe?: string; tunnelId?: string | null; exec?: Exec } = {},
  ) {}

  async status(): Promise<ProviderStatus> {
    const exe = this.opts.cloudflaredExe ?? "cloudflared";
    const v = await (this.opts.exec ?? defaultExec)(exe, ["--version"]);
    const installed = v.code === 0;
    return {
      id: this.id,
      label: "Secure tunnel (Cloudflare)",
      description: "Works behind any router with no open ports. Requires a free Cloudflare account and a domain managed by Cloudflare.",
      kind: "public",
      installed,
      configured: installed && !!this.opts.tunnelId,
      connected: false,
      ...(installed ? { detail: v.out.trim().split("\n")[0] } : { detail: "Not installed" }),
    };
  }

  dnsRecords(hostnames: string[]): DnsRecord[] {
    if (!this.opts.tunnelId) return [];
    const target = `${this.opts.tunnelId}.cfargotunnel.com`;
    return hostnames.map((h) => ({
      type: "CNAME",
      name: h,
      value: target,
      instruction: `Nexus creates this automatically through the tunnel (CNAME ${h} → ${target}).`,
    }));
  }
}

// ------------------------------------------------------------------ Tailscale (private)

export interface TailscaleStatus {
  running: boolean;
  dnsName: string | null;
  ips: string[];
}

export function parseTailscaleStatus(json: string): TailscaleStatus {
  try {
    const s = JSON.parse(json) as { BackendState?: string; Self?: { DNSName?: string; TailscaleIPs?: string[] } };
    return {
      running: s.BackendState === "Running",
      dnsName: s.Self?.DNSName?.replace(/\.$/, "") ?? null,
      ips: s.Self?.TailscaleIPs ?? [],
    };
  } catch {
    return { running: false, dnsName: null, ips: [] };
  }
}

/** `tailscale serve` arguments publishing one app privately on its own HTTPS port inside the tailnet. */
export function tailscaleServeArgs(httpsPort: number, localPort: number, localHost: string): string[] {
  if (!/^[a-z0-9.-]+$/i.test(localHost)) throw new Error("Invalid host.");
  return ["serve", "--bg", `--https=${httpsPort}`, `http://${localHost}:${localPort}`];
}

export class TailscaleProvider implements ReachabilityProvider {
  readonly id = "tailscale" as const;
  readonly acmeCompatible = false;
  readonly inboundPorts: number[] = [];

  constructor(private readonly opts: { tailscaleExe?: string; exec?: Exec } = {}) {}

  async status(): Promise<ProviderStatus> {
    const r = await (this.opts.exec ?? defaultExec)(this.opts.tailscaleExe ?? "tailscale", ["status", "--json"]);
    const s = r.code === 0 ? parseTailscaleStatus(r.out) : null;
    return {
      id: this.id,
      label: "Private network (Tailscale)",
      description: "Reach private apps from your own phone and laptop anywhere, without exposing them to the internet. Requires a Tailscale account; the built-in private network below doesn't.",
      kind: "private",
      installed: r.code === 0 || /stopped|logged out|NeedsLogin/i.test(r.out),
      configured: !!s?.dnsName,
      connected: !!s?.running,
      ...(s?.dnsName ? { detail: s.dnsName } : {}),
    };
  }

  dnsRecords(): DnsRecord[] {
    return []; // Tailscale MagicDNS handles names inside the private network.
  }
}

// ------------------------------------------------------------------ recommendation

/**
 * Picks the public provider without asking: a configured tunnel wins (no router changes),
 * otherwise a direct connection. Returns what still needs doing in plain words.
 */
export function recommendPublicProvider(statuses: ProviderStatus[]): { provider: ProviderId; todo: string | null } {
  const tunnel = statuses.find((s) => s.id === "cloudflare-tunnel");
  if (tunnel?.configured) return { provider: "cloudflare-tunnel", todo: null };
  const direct = statuses.find((s) => s.id === "direct");
  return {
    provider: "direct",
    todo: direct?.connected
      ? "Make sure your router forwards ports 80 and 443 to this computer. Nexus will test it for you."
      : "Nexus couldn't find this network's public address. Check the internet connection.",
  };
}
