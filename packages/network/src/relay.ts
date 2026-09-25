import { createConnection, createServer, type Server, type Socket } from "node:net";

/** True when an IPv4 address (also IPv4-mapped IPv6) is inside a CIDR range like 10.73.0.0/24. */
export function inSubnet(address: string, cidr: string): boolean {
  const ip = address.replace(/^::ffff:/i, "");
  const [net, bitsText] = cidr.split("/");
  const bits = Number(bitsText);
  const toInt = (a: string) => {
    const p = a.split(".").map(Number);
    return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? ((p[0]! << 24) | (p[1]! << 16) | (p[2]! << 8) | p[3]!) >>> 0 : null;
  };
  const a = toInt(ip);
  const n = toInt(net ?? "");
  if (a === null || n === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) === (n & mask);
}

/**
 * Passes TCP connections from one network range (the private network) to a service on this computer
 * that only listens on 127.0.0.1. Anyone else is disconnected immediately — the firewall should
 * already keep them out; this is the second lock.
 */
export class SubnetRelay {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();

  constructor(
    private readonly opts: {
      listenPort: number;
      allowCidr: string;
      /** Where to send accepted connections (looked up per connection: the service may have moved). */
      target: () => Promise<{ host: string; port: number } | null>;
      onRefused?: (address: string) => void;
    },
  ) {}

  get port(): number {
    return this.opts.listenPort;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((client) => void this.accept(client));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      // All interfaces: the private network's adapter may appear after Nexus starts.
      server.listen(this.opts.listenPort, "0.0.0.0", () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
  }

  private async accept(client: Socket): Promise<void> {
    const from = client.remoteAddress ?? "";
    if (!inSubnet(from, this.opts.allowCidr)) {
      this.opts.onRefused?.(from);
      client.destroy();
      return;
    }
    this.sockets.add(client);
    client.on("close", () => this.sockets.delete(client));
    client.on("error", () => client.destroy());
    const target = await this.opts.target().catch(() => null);
    if (!target) return void client.destroy();
    const upstream = createConnection(target.port, target.host);
    this.sockets.add(upstream);
    upstream.on("close", () => {
      this.sockets.delete(upstream);
      client.destroy();
    });
    upstream.on("error", () => upstream.destroy());
    client.on("close", () => upstream.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }
}
