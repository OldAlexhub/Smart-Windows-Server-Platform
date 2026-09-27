import { promises as dnsPromises } from "node:dns";
import { NexusError } from "@nexus/shared";
import { isValidHostname } from "./gateway";
import type { DnsRecord } from "./reachability";

/** "https://TaxiOps.Example.com/" → "taxiops.example.com" with friendly errors. */
export function normalizeDomain(input: string): string {
  let d = input.trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "").replace(/\.$/, "");
  if (d.startsWith("*.")) throw NexusError.invalid("Wildcard domains aren't supported yet. Use a specific name like taxiops.example.com.");
  if (!isValidHostname(d)) throw NexusError.invalid(`"${input.trim()}" doesn't look like a domain name. Example: taxiops.example.com`);
  return d;
}

/** Suggests an address for an app under the owner's base domain. */
export function suggestHostname(appSlug: string, baseDomain: string): string {
  return normalizeDomain(`${appSlug}.${normalizeDomain(baseDomain)}`);
}

// ------------------------------------------------------------------ public IP

const IP_SERVICES = ["https://api.ipify.org", "https://icanhazip.com", "https://ifconfig.me/ip"];

/** This network's public IPv4 address, or null when offline. Never required for local use. */
export async function detectPublicIp(fetcher: typeof fetch = fetch, services = IP_SERVICES): Promise<string | null> {
  for (const url of services) {
    try {
      const r = await fetcher(url, { signal: AbortSignal.timeout(4000) });
      if (!r.ok) continue;
      const ip = (await r.text()).trim();
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) || /^[0-9a-f:]+$/i.test(ip)) return ip;
    } catch {
      /* try next */
    }
  }
  return null;
}

// ------------------------------------------------------------------ DNS verification

export interface Resolver {
  resolve4(host: string): Promise<string[]>;
  resolve6(host: string): Promise<string[]>;
  resolveCname(host: string): Promise<string[]>;
}

/** Public resolvers, so the check sees what the internet sees (not a local cache). */
export function publicResolver(): Resolver {
  const r = new dnsPromises.Resolver({ timeout: 4000, tries: 2 });
  r.setServers(["1.1.1.1", "8.8.8.8", "9.9.9.9"]);
  return r;
}

export type DnsCheckStatus = "connected" | "pending" | "wrong_target" | "error";

export interface DnsCheck {
  hostname: string;
  status: DnsCheckStatus;
  found: string[];
  message: string;
  /** Exactly what to change, if anything. */
  action: string | null;
}

const CLOUDFLARE_PROXY = [/^104\.(1[6-9]|2[0-9]|3[01])\./, /^172\.(6[4-9]|7[01])\./, /^188\.114\./, /^190\.93\./, /^162\.15[89]\./, /^198\.41\./];

export async function verifyDns(record: DnsRecord, resolver: Resolver = publicResolver()): Promise<DnsCheck> {
  const h = record.name;
  try {
    if (record.type === "CNAME") {
      const found = await resolver.resolveCname(h).catch(async (e) => {
        if (isNotFound(e)) return [];
        throw e;
      });
      const ok = found.some((f) => f.replace(/\.$/, "").toLowerCase() === record.value.toLowerCase());
      return ok
        ? { hostname: h, status: "connected", found, message: `${h} is connected.`, action: null }
        : found.length
          ? { hostname: h, status: "wrong_target", found, message: `${h} points to ${found[0]}, not to this server.`, action: record.instruction }
          : { hostname: h, status: "pending", found, message: `${h} isn't set up yet.`, action: record.instruction };
    }
    const found = await (record.type === "AAAA" ? resolver.resolve6(h) : resolver.resolve4(h)).catch((e) => {
      if (isNotFound(e)) return [] as string[];
      throw e;
    });
    if (found.includes(record.value)) return { hostname: h, status: "connected", found, message: `${h} is connected.`, action: null };
    if (found.length === 0) {
      return {
        hostname: h,
        status: "pending",
        found,
        message: `${h} isn't pointing anywhere yet. DNS changes can take a few minutes to appear.`,
        action: record.instruction,
      };
    }
    if (found.some((ip) => CLOUDFLARE_PROXY.some((re) => re.test(ip)))) {
      return {
        hostname: h,
        status: "connected",
        found,
        message: `${h} goes through Cloudflare's proxy. That works; Nexus can't see the final address, so it will test the connection directly.`,
        action: null,
      };
    }
    return {
      hostname: h,
      status: "wrong_target",
      found,
      message: `${h} points to ${found.join(", ")}, but this server's address is ${record.value}.`,
      action: `Change the ${record.type} record for ${h} to ${record.value}.`,
    };
  } catch (e) {
    return { hostname: h, status: "error", found: [], message: `Nexus couldn't check ${h} right now (${(e as Error).message}).`, action: null };
  }
}

function isNotFound(e: unknown): boolean {
  const code = (e as { code?: string }).code;
  return code === "ENOTFOUND" || code === "ENODATA" || code === "NXDOMAIN" || code === "ESERVFAIL";
}
