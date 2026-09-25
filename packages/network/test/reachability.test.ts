import { describe, expect, it } from "vitest";
import {
  addRuleArgs,
  CloudflareTunnelProvider,
  DirectProvider,
  FirewallManager,
  parseFirewallState,
  parseTailscaleStatus,
  recommendPublicProvider,
  renderCaddyfile,
  renderTunnelConfig,
  tailscaleServeArgs,
  TailscaleProvider,
} from "@nexus/network";

describe("firewall", () => {
  it("parses profile state", () => {
    const out = "Domain Profile Settings:\n----\nState                                 ON\n\nPrivate Profile Settings:\n---\nState    OFF\n\nPublic Profile Settings:\n---\nState ON\nOk.";
    expect(parseFirewallState(out)).toEqual({ domain: true, private: false, public: true });
  });

  it("builds program-scoped rules for the gateway only", () => {
    const args = addRuleArgs(FirewallManager.gatewayRule("C:\\Program Files\\Nexus\\caddy\\caddy.exe"));
    expect(args).toEqual([
      "advfirewall",
      "firewall",
      "add",
      "rule",
      "name=Nexus - Secure Gateway",
      "dir=in",
      "action=allow",
      "protocol=TCP",
      "localport=80,443",
      "program=C:\\Program Files\\Nexus\\caddy\\caddy.exe",
      "enable=yes",
      "profile=any",
    ]);
    expect(() => addRuleArgs({ name: 'x" dir=out', program: "a", ports: [1], protocol: "TCP" })).toThrow();
    expect(() => addRuleArgs({ name: "x", program: "a", ports: [70000], protocol: "TCP" })).toThrow();
  });

  it("replaces existing rules and explains missing admin rights", async () => {
    const calls: string[][] = [];
    const fw = new FirewallManager(async (_f, args) => {
      calls.push(args);
      return args[2] === "add" ? { code: 1, out: "The requested operation requires elevation (Run as administrator)." } : { code: 0, out: "" };
    });
    const r = await fw.ensureRule(FirewallManager.gatewayRule("caddy.exe"));
    expect(calls.map((c) => c[2])).toEqual(["delete", "add"]);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/administrator rights/) });
  });

  it.runIf(process.platform === "win32")("reads this machine's firewall state", async () => {
    const p = await new FirewallManager().profiles();
    expect([p.domain, p.private, p.public].every((x) => typeof x === "boolean")).toBe(true);
  });
});

describe("reachability providers", () => {
  it("direct: A records pointing at the public IP", async () => {
    const d = new DirectProvider({ publicIp: async () => "203.0.113.7" });
    expect((await d.status()).connected).toBe(true);
    expect(d.dnsRecords(["taxiops.example.com"], { publicIp: "203.0.113.7" })).toEqual([
      {
        type: "A",
        name: "taxiops.example.com",
        value: "203.0.113.7",
        instruction: "At your domain provider, create an A record for taxiops.example.com pointing to 203.0.113.7.",
      },
    ]);
    expect(d.inboundPorts).toEqual([80, 443]);
  });

  it("cloudflare tunnel: ingress to the local gateway, 404 for everything else", () => {
    const id = "6ff42ae2-765d-4adf-8112-31c55c1551ef";
    const yml = renderTunnelConfig(id, "C:\\ProgramData\\Nexus\\tunnel.json", [{ hostname: "taxiops.example.com", gatewayHttpsPort: 443 }]);
    expect(yml).toBe(
      [
        `tunnel: ${id}`,
        'credentials-file: "C:/ProgramData/Nexus/tunnel.json"',
        "ingress:",
        "  - hostname: taxiops.example.com",
        "    service: https://127.0.0.1:443",
        "    originRequest:",
        "      originServerName: taxiops.example.com",
        "      noTLSVerify: true",
        "  - service: http_status:404",
        "",
      ].join("\n"),
    );
    expect(() => renderTunnelConfig("nope", "x", [])).toThrow();
    const p = new CloudflareTunnelProvider({ tunnelId: id, exec: async () => ({ code: 0, out: "cloudflared version 2026.9.0" }) });
    expect(p.dnsRecords(["a.example.com"])[0]).toMatchObject({ type: "CNAME", value: `${id}.cfargotunnel.com` });
    expect(p.inboundPorts).toEqual([]); // no firewall or router changes
  });

  it("gateway uses an internal certificate for tunnel-published apps", () => {
    const c = renderCaddyfile({
      adminPort: 1,
      httpPort: 80,
      httpsPort: 443,
      localPort: 80,
      nexusPort: 7780,
      acmeEmail: null,
      storageDir: "C:\\d",
      logFile: "C:\\l.log",
      sites: [{ id: "a", name: "A", localHost: "a.nexus.localhost", publicHosts: ["a.example.com"], access: "internet", upstreamPort: 1234, tlsInternal: true }],
    });
    expect(c).toMatch(/a\.example\.com \{\n\t+tls internal/);
  });

  it("tailscale: status parsing and private serve commands", async () => {
    expect(parseTailscaleStatus(JSON.stringify({ BackendState: "Running", Self: { DNSName: "office-pc.tail1234.ts.net.", TailscaleIPs: ["100.64.0.5"] } }))).toEqual({
      running: true,
      dnsName: "office-pc.tail1234.ts.net",
      ips: ["100.64.0.5"],
    });
    expect(parseTailscaleStatus("garbage").running).toBe(false);
    expect(tailscaleServeArgs(8443, 80, "taxiops.nexus.localhost")).toEqual(["serve", "--bg", "--https=8443", "http://taxiops.nexus.localhost:80"]);
    const t = new TailscaleProvider({ exec: async () => ({ code: 1, out: "'tailscale' is not recognized" }) });
    expect(await t.status()).toMatchObject({ installed: false, connected: false, kind: "private" });
  });

  it("recommends a provider without asking", () => {
    const base = { label: "", description: "", kind: "public" as const, installed: true };
    expect(
      recommendPublicProvider([
        { ...base, id: "direct", configured: true, connected: true },
        { ...base, id: "cloudflare-tunnel", configured: true, connected: true },
      ]),
    ).toEqual({ provider: "cloudflare-tunnel", todo: null });
    expect(recommendPublicProvider([{ ...base, id: "direct", configured: true, connected: true }]).todo).toMatch(/forwards ports 80 and 443/);
  });
});
