import { existsSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CaddyGateway, isValidHostname, renderCaddyfile, type GatewayConfig, type GatewaySite } from "@nexus/network";

const CADDY = join(__dirname, "..", "..", "..", "vendor", "caddy", "2.11.4", "caddy.exe");
const hasCaddy = existsSync(CADDY);

const site = (over: Partial<GatewaySite> = {}): GatewaySite => ({
  id: "taxiops",
  name: "TaxiOps",
  localHost: "taxiops.nexus.localhost",
  publicHosts: ["taxiops.example.com"],
  access: "internet",
  upstreamPort: 43127,
  ...over,
});

const cfg = (sites: GatewaySite[], over: Partial<GatewayConfig> = {}): GatewayConfig => ({
  adminPort: 43990,
  httpPort: 80,
  httpsPort: 443,
  localPort: 80,
  nexusPort: 7780,
  acmeEmail: "owner@example.com",
  storageDir: "D:\\Nexus\\Gateway\\data",
  logFile: "D:\\Nexus\\Logs\\gateway.log",
  sites,
  ...over,
});

describe("renderCaddyfile", () => {
  it("internet access: HTTPS domain + security headers, upstream on loopback only", () => {
    const c = renderCaddyfile(cfg([site()]));
    expect(c).toContain("admin 127.0.0.1:43990");
    expect(c).toContain("taxiops.example.com {");
    expect(c).toContain("import nexus_security");
    expect(c).toContain("reverse_proxy 127.0.0.1:43127");
    expect(c).toContain('Strict-Transport-Security "max-age=31536000; includeSubDomains"');
    expect(c).toContain("http://taxiops.nexus.localhost:80 {");
    expect(c).toContain("bind 127.0.0.1 [::1]");
    expect(c).not.toContain("forward_auth");
    expect(c).toContain('storage file_system "D:/Nexus/Gateway/data"');
  });

  it("private apps get only the local address", () => {
    const c = renderCaddyfile(cfg([site({ access: "private" })]));
    expect(c).not.toContain("taxiops.example.com {");
    expect(c).toContain("http://taxiops.nexus.localhost:80");
  });

  it("authorized users only: Nexus sign-in on the app domain + forward auth", () => {
    const c = renderCaddyfile(cfg([site({ access: "authorized" })]));
    expect(c).toContain("handle /.nexus/* {");
    expect(c).toContain("forward_auth 127.0.0.1:7780 {");
    expect(c).toContain("uri /api/v1/gateway/authorize?app=taxiops&mode=user");
    expect(c).toContain("header_up X-Nexus-Remote 1");
  });

  it("API access only: API key check, no sign-in pages", () => {
    const c = renderCaddyfile(cfg([site({ access: "api", publicHosts: ["api.example.com"] })]));
    expect(c).toContain("mode=api");
    expect(c).not.toContain("/.nexus/*");
  });

  it("frontend + backend: static SPA with /api to the backend", () => {
    const c = renderCaddyfile(
      cfg([
        site({ static: { root: "D:\\Nexus\\Apps\\taxiops\\releases\\3\\client\\dist", spa: true }, apiPrefix: "/api" }),
      ]),
    );
    expect(c).toContain("handle /api/* {");
    expect(c).toContain('root * "D:/Nexus/Apps/taxiops/releases/3/client/dist"');
    expect(c).toContain("try_files {path} /index.html");
  });

  it("remote administration only when enabled", () => {
    expect(renderCaddyfile(cfg([site()]))).not.toContain("control center");
    const c = renderCaddyfile(cfg([site()], { management: { publicHost: "server.example.com" } }));
    expect(c).toContain("server.example.com {");
    expect(c).toContain("header_up X-Nexus-Remote 1");
    expect(c).toContain("header_up X-Nexus-Remote-Host {host}");
  });

  it("rejects injection and duplicate addresses", () => {
    expect(() => renderCaddyfile(cfg([site({ publicHosts: ["evil.com {\n respond hacked\n}"] })]))).toThrow(
      /not a valid domain/,
    );
    expect(() => renderCaddyfile(cfg([site(), site({ id: "b", name: "B", localHost: "b.nexus.localhost" })]))).toThrow(
      /more than one application/,
    );
    expect(() => renderCaddyfile(cfg([site({ static: { root: 'C:\\x"}\nadmin :80', spa: false } })]))).toThrow(
      /Unsupported characters/,
    );
    expect(isValidHostname("taxiops.example.com")).toBe(true);
    expect(isValidHostname("-bad.example.com")).toBe(false);
    expect(isValidHostname("localhost")).toBe(false);
  });
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

function get(
  port: number,
  hostHeader: string,
  path = "/",
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, headers: { Host: hostHeader, ...headers } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode!, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe.runIf(hasCaddy)("CaddyGateway (real Caddy)", () => {
  let dir: string;
  let app: http.Server;
  let auth: http.Server;
  let gw: CaddyGateway;
  let config: GatewayConfig;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "nexus-gw-"));
    const appPort = await freePort();
    const nexusPort = await freePort();
    app = http
      .createServer((q, s) =>
        s.end(
          `app saw ${q.url} user=${q.headers["x-nexus-user"] ?? "-"} xff=${q.headers["x-forwarded-for"] ? "yes" : "no"}`,
        ),
      )
      .listen(appPort, "127.0.0.1");
    // Fake Nexus authorize endpoint: accepts a known API key only.
    auth = http
      .createServer((q, s) => {
        if (q.headers["x-nexus-remote"] === "1") {
          s.statusCode = 200;
          s.end(`remote host=${q.headers["x-nexus-remote-host"] ?? "-"}`);
          return;
        }
        if (q.headers["x-api-key"] === "good-key") {
          s.setHeader("X-Nexus-Client", "integration-partner");
          s.statusCode = 200;
        } else s.statusCode = 401;
        s.end();
      })
      .listen(nexusPort, "127.0.0.1");
    config = cfg(
      [
        site({ upstreamPort: appPort, publicHosts: ["taxiops.test.example"] }),
        site({
          id: "api",
          name: "API",
          localHost: "api.nexus.localhost",
          publicHosts: ["api.test.example"],
          access: "api",
          upstreamPort: appPort,
        }),
      ],
      {
        adminPort: await freePort(),
        httpPort: await freePort(),
        httpsPort: await freePort(),
        localPort: await freePort(),
        nexusPort,
        storageDir: join(dir, "data"),
        logFile: join(dir, "gateway.log"),
        disableAutoHttps: true,
        acmeEmail: null,
      },
    );
    gw = new CaddyGateway({ caddyExe: CADDY, configPath: join(dir, "Caddyfile") });
  }, 60_000);

  afterAll(async () => {
    await gw?.stop();
    app?.close();
    auth?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("validates generated configuration with Caddy itself", async () => {
    expect(await gw.validate(config)).toEqual({ valid: true });
    const full = cfg([site({ access: "authorized", static: { root: dir, spa: true } })], {
      storageDir: join(dir, "d2"),
      logFile: join(dir, "g2.log"),
      management: { publicHost: "server.example.com" },
    });
    expect(await gw.validate(full)).toEqual({ valid: true });
  });

  it("serves apps through the gateway and enforces API keys", async () => {
    await gw.start(config);
    const local = await get(config.localPort, "taxiops.nexus.localhost", "/drivers");
    expect(local).toMatchObject({ status: 200 });
    expect(local.body).toContain("app saw /drivers");

    const pub = await get(config.httpPort, "taxiops.test.example", "/x");
    expect(pub.body).toContain("app saw /x");
    expect(pub.body).toContain("xff=yes");
    expect(pub.headers["x-content-type-options"]).toBe("nosniff");
    expect(pub.headers.server).toBeUndefined();

    expect((await get(config.httpPort, "api.test.example", "/v1/trips")).status).toBe(401);
    const ok = await get(config.httpPort, "api.test.example", "/v1/trips", { "X-API-Key": "good-key" });
    expect(ok.status).toBe(200);
    expect(ok.body).toContain("app saw /v1/trips");

    // Unknown hosts are not served.
    expect((await get(config.httpPort, "other.example")).status).not.toBe(200);
  }, 60_000);

  it("marks remote control-center traffic with the gateway-verified hostname", async () => {
    await gw.apply({ ...config, management: { publicHost: "server.test.example" } });
    const remote = await get(config.httpPort, "server.test.example", "/api/v1/auth/login");
    expect(remote).toMatchObject({ status: 200, body: "remote host=server.test.example" });
  }, 60_000);

  it("adopts a gateway left running by a crashed Nexus instead of failing", async () => {
    // A new manager (as after a service restart) finds the old Caddy still holding the ports.
    const second = new CaddyGateway({ caddyExe: CADDY, configPath: join(dir, "Caddyfile") });
    await second.start(config);
    expect(await second.running()).toBe(true);
    expect((await get(config.localPort, "taxiops.nexus.localhost")).status).toBe(200);
  }, 60_000);

  it("reloads configuration without restarting (switch app to private)", async () => {
    await gw.apply({ ...config, sites: [{ ...config.sites[0]!, access: "private" }, config.sites[1]!] });
    expect((await get(config.httpPort, "taxiops.test.example")).status).not.toBe(200);
    expect((await get(config.localPort, "taxiops.nexus.localhost")).status).toBe(200);
  }, 60_000);
});
