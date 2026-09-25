import { existsSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CaddyGateway,
  checkCertificate,
  detectPublicIp,
  normalizeDomain,
  suggestHostname,
  verifyDns,
  type DnsRecord,
  type Resolver,
} from "@nexus/network";

const record: DnsRecord = {
  type: "A",
  name: "taxiops.example.com",
  value: "203.0.113.7",
  instruction: "At your domain provider, create an A record for taxiops.example.com pointing to 203.0.113.7.",
};

const resolver = (answers: Record<string, string[] | Error>): Resolver => {
  const lookup = async (h: string) => {
    const a = answers[h];
    if (a instanceof Error) throw a;
    if (!a) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    return a;
  };
  return { resolve4: lookup, resolve6: lookup, resolveCname: lookup };
};

describe("normalizeDomain", () => {
  it("cleans what people paste", () => {
    expect(normalizeDomain("https://TaxiOps.Example.com/login")).toBe("taxiops.example.com");
    expect(normalizeDomain(" api.example.com:443 ")).toBe("api.example.com");
    expect(suggestHostname("taxiops", "Example.com")).toBe("taxiops.example.com");
  });
  it("explains invalid input", () => {
    expect(() => normalizeDomain("taxi ops")).toThrow(/doesn't look like a domain/);
    expect(() => normalizeDomain("*.example.com")).toThrow(/Wildcard/);
  });
});

describe("detectPublicIp", () => {
  it("falls back across services and returns null offline", async () => {
    const calls: string[] = [];
    const fake = (async (url: string) => {
      calls.push(url);
      if (url.includes("a")) throw new Error("down");
      return new Response("198.51.100.20\n");
    }) as unknown as typeof fetch;
    expect(await detectPublicIp(fake, ["https://a.test", "https://b.test"])).toBe("198.51.100.20");
    expect(calls).toHaveLength(2);
    const offline = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await detectPublicIp(offline, ["https://x.test"])).toBeNull();
  });
});

describe("verifyDns", () => {
  it("connected", async () => {
    expect(await verifyDns(record, resolver({ "taxiops.example.com": ["203.0.113.7"] }))).toMatchObject({ status: "connected", action: null });
  });
  it("pending with the exact instruction", async () => {
    const r = await verifyDns(record, resolver({}));
    expect(r.status).toBe("pending");
    expect(r.action).toBe(record.instruction);
  });
  it("wrong target explains what to change", async () => {
    const r = await verifyDns(record, resolver({ "taxiops.example.com": ["198.51.100.4"] }));
    expect(r).toMatchObject({
      status: "wrong_target",
      message: "taxiops.example.com points to 198.51.100.4, but this server's address is 203.0.113.7.",
      action: "Change the A record for taxiops.example.com to 203.0.113.7.",
    });
  });
  it("recognises the Cloudflare proxy", async () => {
    expect((await verifyDns(record, resolver({ "taxiops.example.com": ["104.21.3.4"] }))).status).toBe("connected");
  });
  it("CNAME records (tunnels)", async () => {
    const c: DnsRecord = { type: "CNAME", name: "a.example.com", value: "abc.cfargotunnel.com", instruction: "x" };
    expect((await verifyDns(c, resolver({ "a.example.com": ["abc.cfargotunnel.com."] }))).status).toBe("connected");
    expect((await verifyDns(c, resolver({ "a.example.com": ["other.host"] }))).status).toBe("wrong_target");
  });
  it("reports lookup failures without guessing", async () => {
    expect((await verifyDns(record, resolver({ "taxiops.example.com": Object.assign(new Error("timeout"), { code: "ETIMEOUT" }) }))).status).toBe("error");
  });
});

const CADDY = join(__dirname, "..", "..", "..", "vendor", "caddy", "2.11.4", "caddy.exe");
const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

describe.runIf(existsSync(CADDY))("checkCertificate (real gateway)", () => {
  it("reads the certificate the gateway serves for a hostname", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexus-cert-"));
    const appPort = await freePort();
    const app = http.createServer((_q, s) => s.end("ok")).listen(appPort, "127.0.0.1");
    const httpsPort = await freePort();
    const gw = new CaddyGateway({ caddyExe: CADDY, configPath: join(dir, "Caddyfile") });
    try {
      await gw.start({
        adminPort: await freePort(),
        httpPort: await freePort(),
        httpsPort,
        localPort: await freePort(),
        nexusPort: 1,
        acmeEmail: null,
        storageDir: join(dir, "data"),
        logFile: join(dir, "gw.log"),
        sites: [{ id: "t", name: "T", localHost: "t.nexus.localhost", publicHosts: ["taxiops.example.com"], access: "internet", upstreamPort: appPort, tlsInternal: true }],
      });
      let cert = await checkCertificate("taxiops.example.com", httpsPort);
      for (let i = 0; i < 80 && !cert.active; i++) {
        await new Promise((r) => setTimeout(r, 250));
        cert = await checkCertificate("taxiops.example.com", httpsPort);
      }
      expect(cert.message).toMatch(/HTTPS is active/);
      expect(cert.active).toBe(true);
      expect(cert.issuer).toMatch(/Caddy/);
      expect((await checkCertificate("taxiops.example.com", await freePort())).active).toBe(false);
    } finally {
      await gw.stop();
      app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
