import { createPublicKey, createPrivateKey, diffieHellman } from "node:crypto";
import { createSocket } from "node:dgram";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addPortMapping,
  addRuleArgs,
  CaddyGateway,
  discoverGateway,
  FirewallManager,
  isSharedAddress,
  nextDeviceAddress,
  parseWgDump,
  pickSubnet,
  renderCaddyfile,
  renderDeviceConfig,
  renderServerConfig,
  routerExternalAddress,
  wireguardKeys,
  type GatewayConfig,
} from "@nexus/network";

const CADDY = join(__dirname, "..", "..", "..", "vendor", "caddy", "2.11.4", "caddy.exe");

const raw = (b64: string) => Buffer.from(b64, "base64").toString("base64url");
const priv = (k: { privateKey: string; publicKey: string }) => createPrivateKey({ key: { kty: "OKP", crv: "X25519", d: raw(k.privateKey), x: raw(k.publicKey) }, format: "jwk" });
const pub = (k: string) => createPublicKey({ key: { kty: "OKP", crv: "X25519", x: raw(k) }, format: "jwk" });

describe("WireGuard keys and configuration", () => {
  it("makes real Curve25519 key pairs in WireGuard's format", () => {
    const a = wireguardKeys();
    const b = wireguardKeys();
    for (const k of [a.privateKey, a.publicKey]) expect(k).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    // Both sides derive the same secret: the pairs belong together.
    expect(diffieHellman({ privateKey: priv(a), publicKey: pub(b.publicKey) }).equals(diffieHellman({ privateKey: priv(b), publicKey: pub(a.publicKey) }))).toBe(true);
  });

  it("picks an address range that doesn't clash with the local network", () => {
    expect(pickSubnet(["192.168.1.20"])).toEqual({ base: "10.73.0" });
    expect(pickSubnet(["10.73.0.5", "172.29.73.9"])).toEqual({ base: "10.173.73" });
    expect(nextDeviceAddress({ base: "10.73.0" }, ["10.73.0.2", "10.73.0.3"])).toBe("10.73.0.4");
  });

  it("renders the server and device files; devices reach only this computer", () => {
    const server = wireguardKeys();
    const phone = wireguardKeys();
    const device = { id: "d1", name: "Mohamed's phone", address: "10.73.0.2", publicKey: phone.publicKey, presharedKey: wireguardKeys().publicKey };
    const s = renderServerConfig({ subnet: { base: "10.73.0" }, port: 51820, privateKey: server.privateKey, devices: [device] });
    expect(s).toContain("ListenPort = 51820\r\nAddress = 10.73.0.1/24");
    expect(s).toContain(`# Mohamed's phone\r\n[Peer]\r\nPublicKey = ${phone.publicKey}`);
    expect(s).toContain("AllowedIPs = 10.73.0.2/32");
    const d = renderDeviceConfig({ device, devicePrivateKey: phone.privateKey, serverPublicKey: server.publicKey, subnet: { base: "10.73.0" }, endpoint: "65.33.27.76:51820" });
    expect(d).toContain("Address = 10.73.0.2/32");
    expect(d).toContain("AllowedIPs = 10.73.0.1/32");
    expect(d).toContain("Endpoint = 65.33.27.76:51820");
    expect(() => renderServerConfig({ subnet: { base: "10.73.0" }, port: 1, privateKey: "not-a-key\n[Peer]", devices: [] })).toThrow("Invalid WireGuard key.");
  });

  it("reads who is connected from wg show dump", () => {
    const out = "privkey\tpubkey\t51820\toff\nPEER1=\t(none)\t203.0.113.9:4500\t10.73.0.2/32\t1790000000\t1200\t3400\t25\nPEER2=\t(none)\t(none)\t10.73.0.3/32\t0\t0\t0\t25\n";
    expect(parseWgDump(out)).toEqual([
      { publicKey: "PEER1=", endpoint: "203.0.113.9:4500", lastHandshake: new Date(1790000000 * 1000), receivedBytes: 1200, sentBytes: 3400 },
      { publicKey: "PEER2=", endpoint: null, lastHandshake: null, receivedBytes: 0, sentBytes: 0 },
    ]);
  });

  it("firewall: WireGuard's port for everyone, app ports only from inside the private network", () => {
    expect(addRuleArgs(FirewallManager.wireguardRule("C:\\Program Files\\WireGuard\\wireguard.exe", 51820))).toContain("protocol=UDP");
    const args = addRuleArgs(FirewallManager.privateNetworkGatewayRule("C:\\caddy.exe", [8401, 8402], "10.73.0.0/24"));
    expect(args).toContain("localport=8401,8402");
    expect(args).toContain("remoteip=10.73.0.0/24");
    expect(() => addRuleArgs({ name: "x", program: "y", ports: [1], protocol: "TCP", remoteIps: ["any dir=out"] })).toThrow("Invalid firewall address.");
  });
});

describe("router port forwarding (UPnP)", () => {
  let ssdp: ReturnType<typeof createSocket>;
  let router: http.Server;
  const calls: string[] = [];
  let ssdpPort = 0;

  beforeAll(async () => {
    router = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.url === "/desc.xml") {
          return res.end(`<root><device><serviceList><service><serviceType>urn:schemas-upnp-org:service:Layer3Forwarding:1</serviceType><controlURL>/l3f</controlURL></service><service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>/ctl/IPConn</controlURL></service></serviceList></device></root>`);
        }
        calls.push(`${req.headers.soapaction} ${body}`);
        if (String(req.headers.soapaction).includes("GetExternalIPAddress")) return res.end("<s:Envelope><s:Body><u:GetExternalIPAddressResponse><NewExternalIPAddress>100.72.4.9</NewExternalIPAddress></u:GetExternalIPAddressResponse></s:Body></s:Envelope>");
        res.end("<ok/>");
      });
    });
    await new Promise<void>((r) => router.listen(0, "127.0.0.1", r));
    const routerPort = (router.address() as net.AddressInfo).port;
    ssdp = createSocket("udp4");
    ssdp.on("message", (_msg, rinfo) => ssdp.send(Buffer.from(`HTTP/1.1 200 OK\r\nLOCATION: http://127.0.0.1:${routerPort}/desc.xml\r\n\r\n`), rinfo.port, rinfo.address));
    await new Promise<void>((r) => ssdp.bind(0, "127.0.0.1", r));
    ssdpPort = ssdp.address().port;
  });

  afterAll(() => {
    ssdp?.close();
    router?.close();
  });

  it("finds the router, forwards the port, and spots a carrier-shared address", async () => {
    const g = await discoverGateway({ target: { address: "127.0.0.1", port: ssdpPort }, timeoutMs: 800 });
    expect(g).toMatchObject({ controlUrl: expect.stringMatching(/\/ctl\/IPConn$/), serviceType: "urn:schemas-upnp-org:service:WANIPConnection:1" });
    await addPortMapping(g!, { port: 51820, protocol: "UDP", description: "Nexus private network" });
    expect(calls[0]).toContain("#AddPortMapping");
    expect(calls[0]).toContain("<NewExternalPort>51820</NewExternalPort><NewProtocol>UDP</NewProtocol>");
    const external = await routerExternalAddress(g!);
    expect(external).toBe("100.72.4.9");
    expect(isSharedAddress(external!)).toBe(true);
    expect(isSharedAddress("65.33.27.76")).toBe(false);
  });

  it("returns null when no router answers", async () => {
    expect(await discoverGateway({ target: { address: "127.0.0.1", port: 9 }, timeoutMs: 300 })).toBeNull();
  });
});

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

const get = (port: number, path = "/") =>
  new Promise<{ status: number; body: string } | { error: string }>((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path, headers: { "X-Nexus-Private-Network": "forged-by-visitor-000000" } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", (e) => resolve({ error: e.message }));
  });

describe.runIf(existsSync(CADDY))("gateway on the private network (real Caddy)", () => {
  let dir: string;
  let app: http.Server;
  let nexus: http.Server;
  let gw: CaddyGateway;
  let config: GatewayConfig;
  const MARKER = "s3cret-marker-0123456789abcdef";

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "nexus-pn-"));
    app = http.createServer((req, res) => res.end(`app saw ${req.url}`));
    nexus = http.createServer((req, res) => res.end(`nexus remote=${req.headers["x-nexus-remote"]} marker=${req.headers["x-nexus-private-network"]}`));
    const [appPort, nexusPort] = [await freePort(), await freePort()];
    await new Promise<void>((r) => app.listen(appPort, "127.0.0.1", r));
    await new Promise<void>((r) => nexus.listen(nexusPort, "127.0.0.1", r));
    config = {
      adminPort: await freePort(),
      httpPort: await freePort(),
      httpsPort: await freePort(),
      localPort: await freePort(),
      nexusPort,
      acmeEmail: null,
      storageDir: join(dir, "data"),
      logFile: join(dir, "gateway.log"),
      disableAutoHttps: true,
      sites: [{ id: "taxiops", name: "TaxiOps", localHost: "taxiops.nexus.localhost", publicHosts: [], access: "private", upstreamPort: appPort }],
      // The test machine itself plays a device inside the private network.
      privateNetwork: { subnetCidr: "127.0.0.0/8", marker: MARKER, controlPort: await freePort(), sites: [{ siteId: "taxiops", port: await freePort() }] },
    };
    gw = new CaddyGateway({ caddyExe: CADDY, configPath: join(dir, "Caddyfile") });
  }, 60_000);

  afterAll(async () => {
    await gw?.stop();
    app?.close();
    nexus?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves private apps and the control center to devices inside, marking control-center traffic", async () => {
    expect(await gw.validate(config)).toEqual({ valid: true });
    await gw.start(config);
    const pn = config.privateNetwork!;
    expect(await get(pn.sites[0]!.port, "/drivers")).toEqual({ status: 200, body: "app saw /drivers" });
    // The gateway replaces whatever a visitor sends with the real marker.
    expect(await get(pn.controlPort, "/api/v1/me")).toEqual({ status: 200, body: `nexus remote=1 marker=${MARKER}` });
  }, 60_000);

  it("refuses everyone outside the private network", async () => {
    await gw.apply({ ...config, privateNetwork: { ...config.privateNetwork!, subnetCidr: "10.73.0.0/24" } });
    const r = await get(config.privateNetwork!.sites[0]!.port);
    expect("error" in r || r.status !== 200).toBe(true);
    expect(renderCaddyfile(config)).toContain("@outside not remote_ip 127.0.0.0/8\n\troute {\n\t\tabort @outside");
  }, 60_000);
});
