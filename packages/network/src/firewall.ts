import { execFile } from "node:child_process";
import { BRAND } from "@nexus/shared";

export interface FirewallProfiles {
  domain: boolean | null;
  private: boolean | null;
  public: boolean | null;
}

export interface FirewallRule {
  name: string;
  program: string;
  ports: number[];
  protocol: "TCP" | "UDP";
  /** Only accept connections from these addresses (e.g. "10.73.0.0/24"). Default: any. */
  remoteIps?: string[];
}

type Exec = (file: string, args: string[]) => Promise<{ code: number; out: string }>;
const defaultExec: Exec = (file, args) =>
  new Promise((resolve) =>
    execFile(file, args, { windowsHide: true, timeout: 30_000 }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: `${stdout}${stderr}` }),
    ),
  );

/** Parses `netsh advfirewall show allprofiles state`. */
export function parseFirewallState(out: string): FirewallProfiles {
  const result: FirewallProfiles = { domain: null, private: null, public: null };
  let current: keyof FirewallProfiles | null = null;
  for (const line of out.split(/\r?\n/)) {
    const h = line.match(/^(Domain|Private|Public) Profile/i);
    if (h) current = h[1]!.toLowerCase() as keyof FirewallProfiles;
    const s = line.match(/^State\s+(ON|OFF)/i);
    if (s && current) result[current] = s[1]!.toUpperCase() === "ON";
  }
  return result;
}

/** All Nexus rules share a name prefix so they can be listed and removed together. */
export const RULE_PREFIX = `${BRAND.shortName} - `;

/** Builds netsh arguments for a program-scoped inbound allow rule (only that program may listen). */
export function addRuleArgs(rule: FirewallRule): string[] {
  if (!rule.ports.length || rule.ports.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) throw new Error("Invalid firewall ports.");
  if (/["\r\n]/.test(rule.program) || /["\r\n]/.test(rule.name)) throw new Error("Invalid firewall rule.");
  if (rule.remoteIps?.some((r) => !/^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(r))) throw new Error("Invalid firewall address.");
  return [
    "advfirewall",
    "firewall",
    "add",
    "rule",
    `name=${RULE_PREFIX}${rule.name}`,
    "dir=in",
    "action=allow",
    `protocol=${rule.protocol}`,
    `localport=${rule.ports.join(",")}`,
    `program=${rule.program}`,
    ...(rule.remoteIps?.length ? [`remoteip=${rule.remoteIps.join(",")}`] : []),
    "enable=yes",
    "profile=any",
  ];
}

export function deleteRuleArgs(name: string): string[] {
  return ["advfirewall", "firewall", "delete", "rule", `name=${RULE_PREFIX}${name}`];
}

/**
 * Windows Firewall awareness. Nexus only ever opens the gateway's public ports (80/443),
 * scoped to the gateway program. Databases, AI and internal services listen on 127.0.0.1
 * and never need — or get — a firewall opening.
 */
export class FirewallManager {
  constructor(private readonly exec: Exec = defaultExec) {}

  async profiles(): Promise<FirewallProfiles> {
    const r = await this.exec("netsh", ["advfirewall", "show", "allprofiles", "state"]);
    return r.code === 0 ? parseFirewallState(r.out) : { domain: null, private: null, public: null };
  }

  /** Idempotent: replaces any existing rule with the same name. Requires administrator rights (the service has them). */
  async ensureRule(rule: FirewallRule): Promise<{ ok: boolean; error?: string }> {
    await this.exec("netsh", deleteRuleArgs(rule.name));
    const r = await this.exec("netsh", addRuleArgs(rule));
    if (r.code === 0) return { ok: true };
    return {
      ok: false,
      error: /elevation|administrator|requested operation requires/i.test(r.out)
        ? "Nexus needs administrator rights to allow internet connections. The Nexus service normally has them."
        : r.out.trim(),
    };
  }

  async removeRule(name: string): Promise<void> {
    await this.exec("netsh", deleteRuleArgs(name));
  }

  /** The only rule Nexus needs for direct internet access. */
  static gatewayRule(caddyExe: string, httpPort = 80, httpsPort = 443): FirewallRule {
    return { name: "Secure Gateway", program: caddyExe, ports: [httpPort, httpsPort], protocol: "TCP" };
  }

  /** The private network: WireGuard's port, open to the internet (it answers only devices with a key). */
  static wireguardRule(wireguardExe: string, port: number): FirewallRule {
    return { name: "Private Network", program: wireguardExe, ports: [port], protocol: "UDP" };
  }

  /** The gateway's private-network ports, reachable only from devices inside the private network. */
  static privateNetworkGatewayRule(caddyExe: string, ports: number[], subnetCidr: string): FirewallRule {
    return { name: "Private Network Apps", program: caddyExe, ports, protocol: "TCP", remoteIps: [subnetCidr] };
  }
}
