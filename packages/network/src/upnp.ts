import { createSocket } from "node:dgram";
import { networkInterfaces } from "node:os";

/**
 * Asks the home/office router to forward a port (UPnP IGD), so the private network works without
 * anyone opening router settings. Many routers allow this; some have it switched off, in which case
 * Nexus explains the one port to forward by hand.
 */

const SSDP_ADDRESS = "239.255.255.250";
const SSDP_PORT = 1900;
const SERVICES = ["urn:schemas-upnp-org:service:WANIPConnection:2", "urn:schemas-upnp-org:service:WANIPConnection:1", "urn:schemas-upnp-org:service:WANPPPConnection:1"];

export interface Gateway {
  controlUrl: string;
  serviceType: string;
  /** This computer's address on the router's network (where forwarded traffic should go). */
  localAddress: string;
}

export interface UpnpOptions {
  /** Tests: where discovery is sent (normally the SSDP multicast group). */
  target?: { address: string; port: number };
  timeoutMs?: number;
  fetcher?: typeof fetch;
}

/** Finds the router's port-forwarding service, or null if the router doesn't offer UPnP. */
export async function discoverGateway(o: UpnpOptions = {}): Promise<Gateway | null> {
  const locations = await ssdpSearch(o);
  const f = o.fetcher ?? fetch;
  for (const location of locations) {
    try {
      const xml = await (await f(location, { signal: AbortSignal.timeout(3000) })).text();
      for (const serviceType of SERVICES) {
        const block = [...xml.matchAll(/<service>([\s\S]*?)<\/service>/g)].map((m) => m[1]!).find((b) => b.includes(`<serviceType>${serviceType}</serviceType>`));
        const control = block?.match(/<controlURL>\s*([^<\s]+)\s*<\/controlURL>/)?.[1];
        if (!control) continue;
        const url = new URL(control, location);
        return { controlUrl: url.href, serviceType, localAddress: localAddressFor(url.hostname) };
      }
    } catch {
      // Not a router, or it didn't answer: try the next one.
    }
  }
  return null;
}

function ssdpSearch(o: UpnpOptions): Promise<string[]> {
  return new Promise((resolve) => {
    const socket = createSocket({ type: "udp4", reuseAddr: true });
    const found = new Set<string>();
    const target = o.target ?? { address: SSDP_ADDRESS, port: SSDP_PORT };
    const done = () => {
      try {
        socket.close();
      } catch {
        // already closed
      }
      resolve([...found]);
    };
    socket.on("message", (msg) => {
      const loc = msg.toString().match(/^location:\s*(\S+)/im)?.[1];
      if (loc && /^http:\/\//i.test(loc)) found.add(loc);
    });
    socket.on("error", done);
    socket.bind(0, () => {
      const request = (st: string) =>
        Buffer.from(["M-SEARCH * HTTP/1.1", `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`, 'MAN: "ssdp:discover"', "MX: 2", `ST: ${st}`, "", ""].join("\r\n"));
      for (const st of ["urn:schemas-upnp-org:device:InternetGatewayDevice:1", ...SERVICES]) socket.send(request(st), target.port, target.address);
    });
    setTimeout(done, o.timeoutMs ?? 2500);
  });
}

/** The local IPv4 address in the same /24 as the router (best guess: the first private one). */
function localAddressFor(routerHost: string): string {
  const all = Object.values(networkInterfaces())
    .flat()
    .filter((n): n is NonNullable<typeof n> => !!n && n.family === "IPv4" && !n.internal);
  const prefix = routerHost.split(".").slice(0, 3).join(".");
  return (all.find((n) => n.address.startsWith(`${prefix}.`)) ?? all[0])?.address ?? "127.0.0.1";
}

async function soap(g: Gateway, action: string, args: Record<string, string | number>, f: typeof fetch): Promise<string> {
  const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${g.serviceType}">${Object.entries(args)
    .map(([k, v]) => `<${k}>${String(v).replace(/[<>&]/g, "")}</${k}>`)
    .join("")}</u:${action}></s:Body></s:Envelope>`;
  const r = await f(g.controlUrl, {
    method: "POST",
    headers: { "Content-Type": 'text/xml; charset="utf-8"', SOAPAction: `"${g.serviceType}#${action}"` },
    body,
    signal: AbortSignal.timeout(5000),
  });
  const text = await r.text();
  if (!r.ok) {
    const code = text.match(/<errorCode>(\d+)<\/errorCode>/)?.[1];
    const desc = text.match(/<errorDescription>([^<]*)<\/errorDescription>/)?.[1];
    throw new Error(`The router refused (${code ?? r.status}${desc ? ` ${desc}` : ""}).`);
  }
  return text;
}

/** Forwards `port` on the router to this computer. Lease 0 = until removed. */
export async function addPortMapping(g: Gateway, o: { port: number; protocol: "UDP" | "TCP"; description: string; leaseSeconds?: number }, f: typeof fetch = fetch): Promise<void> {
  await soap(
    g,
    "AddPortMapping",
    {
      NewRemoteHost: "",
      NewExternalPort: o.port,
      NewProtocol: o.protocol,
      NewInternalPort: o.port,
      NewInternalClient: g.localAddress,
      NewEnabled: 1,
      NewPortMappingDescription: o.description,
      NewLeaseDuration: o.leaseSeconds ?? 0,
    },
    f,
  );
}

export async function deletePortMapping(g: Gateway, o: { port: number; protocol: "UDP" | "TCP" }, f: typeof fetch = fetch): Promise<void> {
  await soap(g, "DeletePortMapping", { NewRemoteHost: "", NewExternalPort: o.port, NewProtocol: o.protocol }, f);
}

/** The address the router itself has on the internet side. */
export async function routerExternalAddress(g: Gateway, f: typeof fetch = fetch): Promise<string | null> {
  const text = await soap(g, "GetExternalIPAddress", {}, f);
  return text.match(/<NewExternalIPAddress>([^<]*)<\/NewExternalIPAddress>/)?.[1]?.trim() || null;
}

/**
 * True when the router's internet-side address is a private or carrier-shared one (CGNAT): the
 * internet provider shares one public address between customers and nothing can connect in.
 */
export function isSharedAddress(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n))) return false;
  const [a, b] = p as [number, number, number, number];
  return a === 10 || (a === 100 && b >= 64 && b <= 127) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 0;
}
