import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkHttps,
  classifyTlsError,
  diagnoseHttps,
  explainAcmeError,
  parseAcmeActivity,
  readGatewayLog,
  type DnsCheck,
  type GatewayRuntime,
  type HttpsDiagnosisInput,
  type HttpsStatus,
  type TlsProbe,
} from "@nexus/network";

const HOST = "nexus-node-mongo-test.server.oldalexhub.com";
const NOW = Date.parse("2026-09-26T12:00:00Z");
const DAY = 86_400_000;

// The exact error a Caddy gateway produces when it has no certificate for the name yet.
const OPENSSL_ALERT_80 =
  "BC130000:error:0A000438:SSL routines:ssl3_read_bytes:tlsv1 alert internal error:openssl\\ssl\\record\\rec_layer_s3.c:916:SSL alert number 80";

const runtime = (over: Partial<GatewayRuntime> = {}): GatewayRuntime => ({
  installed: true,
  running: true,
  configuredHttpPort: 80,
  configuredHttpsPort: 443,
  activeHttpPort: 80,
  activeHttpsPort: 443,
  publicExpected: true,
  fallback: false,
  automaticHttps: true,
  internalCertificates: false,
  listener: { owner: { pid: 16288, name: "caddy" }, ownedByGateway: true },
  appliedHosts: [HOST],
  error: null,
  problem: null,
  storageDir: null,
  logFile: null,
  ...over,
});

const dnsOk: DnsCheck = { hostname: HOST, status: "connected", found: ["203.0.113.7"], message: `${HOST} is connected.`, action: null };
const dnsWrong: DnsCheck = {
  hostname: HOST,
  status: "wrong_target",
  found: ["198.51.100.4"],
  message: `${HOST} points to 198.51.100.4, but this server's address is 203.0.113.7.`,
  action: `Change the A record for ${HOST} to 203.0.113.7.`,
};

const publicCert = (over: Partial<NonNullable<TlsProbe["certificate"]>> = {}): TlsProbe => ({
  outcome: "certificate",
  error: null,
  certificate: {
    issuer: "Let's Encrypt",
    names: [HOST],
    validFrom: new Date(NOW - 10 * DAY).toISOString(),
    validTo: new Date(NOW + 80 * DAY).toISOString(),
    trusted: true,
    internal: false,
    ...over,
  },
});
const noCert: TlsProbe = { outcome: "no_certificate", certificate: null, error: OPENSSL_ALERT_80 };

const diagnose = (over: Partial<HttpsDiagnosisInput> = {}): HttpsStatus =>
  diagnoseHttps({ hostname: HOST, dns: dnsOk, gateway: runtime(), probe: publicCert(), stored: null, acme: null, now: NOW, ...over });

// Real lines from Caddy 2.11 (ACME attempt that failed), plus a CA-side challenge failure.
const ts = NOW / 1000;
const log = (o: Record<string, unknown>) => JSON.stringify({ level: "info", ts, ...o });
const obtaining = log({ logger: "tls.obtain", msg: "obtaining certificate", identifier: HOST });
const challengeFailed = log({
  level: "error",
  logger: "tls.issuance.acme.acme_client",
  msg: "challenge failed",
  identifier: HOST,
  challenge_type: "http-01",
  problem: { type: "urn:ietf:params:acme:error:connection", detail: "203.0.113.7: Timeout during connect (likely firewall problem)" },
});
const couldNotGet = log({
  level: "error",
  logger: "tls.obtain",
  msg: "could not get certificate from issuer",
  identifier: HOST,
  issuer: "acme-v02.api.letsencrypt.org-directory",
  error: "HTTP 400 urn:ietf:params:acme:error:connection - 203.0.113.7: Timeout during connect (likely firewall problem)",
});
const willRetry = JSON.stringify({ level: "error", ts: ts + 1, logger: "tls.obtain", msg: "will retry", error: `[${HOST}] Obtain: ...`, attempt: 2, retrying_in: 120 });
const obtained = log({ logger: "tls.obtain", msg: "certificate obtained successfully", identifier: HOST, issuer: "acme-v02.api.letsencrypt.org-directory" });

describe("HTTPS diagnosis", () => {
  it("1. DNS correct + valid public certificate → ready", () => {
    const s = diagnose();
    expect(s).toMatchObject({ state: "ready", title: "HTTPS active", dnsConnected: true, gatewayRunning: true, httpsPort: 443, certificatePresent: true, certificateValid: true, certificateIssuer: "Let's Encrypt", daysLeft: 80 });
    expect(s.message).toMatch(/HTTPS is active/);
  });

  it("2. DNS incorrect → DNS problem with the exact change to make", () => {
    const s = diagnose({ dns: dnsWrong, probe: noCert });
    expect(s.state).toBe("dns_problem");
    expect(s.message).toBe("This address does not currently point to this server.");
    expect(s.likelyCause).toBe(dnsWrong.action);
  });

  it("5. TLS alert 80 while the certificate is being issued → friendly pending state", () => {
    const s = diagnose({ probe: noCert, acme: parseAcmeActivity([obtaining], HOST) });
    expect(s).toMatchObject({ state: "pending", title: "Certificate being prepared", certificatePresent: false, certificateValid: false });
    expect(s.message).toBe("Nexus is setting up HTTPS. This can take a short time after connecting a new domain.");
    expect(s.technicalDetails).toContain("SSL alert number 80");
  });

  it("5b. no ACME activity yet: still pending, and hints that DNS alone doesn't prove reachability", () => {
    const s = diagnose({ probe: noCert });
    expect(s.state).toBe("pending");
    expect(s.likelyCause).toMatch(/ports 80 and 443/);
  });

  it("6. ACME failure → plain-language diagnosis from Caddy's log", () => {
    const acme = parseAcmeActivity([obtaining, challengeFailed, couldNotGet, willRetry], HOST);
    const s = diagnose({ probe: noCert, acme });
    expect(s).toMatchObject({ state: "unreachable", title: "Certificate could not be issued", message: "Nexus could not complete secure HTTPS setup for this address." });
    expect(s.likelyCause).toBe("The certificate authority could not reach this server. Check that ports 80 and 443 are forwarded to this computer and allowed through any firewall.");
    expect(s.repair?.id).toBe("certificates.retry");
    expect(s.technicalDetails).toMatch(/Timeout during connect/);
    expect(s.nextRetryAt).toBe(new Date((ts + 1 + 120) * 1000).toISOString());
  });

  it("6b. a later success clears an earlier ACME failure", () => {
    const acme = parseAcmeActivity([obtaining, couldNotGet, willRetry, obtaining, obtained], HOST);
    expect(acme?.state).toBe("obtained");
    expect(diagnose({ acme }).state).toBe("ready");
  });

  it("7. gateway stopped → gateway problem with Try Again", () => {
    const s = diagnose({ gateway: runtime({ running: false, error: "The secure gateway could not start." }), probe: null });
    expect(s).toMatchObject({ state: "gateway_problem", title: "Secure gateway stopped", gatewayRunning: false });
    expect(s.repair?.id).toBe("gateway.retry");
    expect(s.technicalDetails).toBe("The secure gateway could not start.");
  });

  it("7b. address not in the applied configuration → gateway problem (config failure)", () => {
    const s = diagnose({ gateway: runtime({ appliedHosts: [], error: "The secure gateway rejected the new configuration: adapting config" }) });
    expect(s.state).toBe("gateway_problem");
    expect(s.message).toBe("Nexus could not apply the secure gateway configuration for this address.");
  });

  it("8. another process owns 443 → port problem", () => {
    const s = diagnose({ gateway: runtime({ listener: { owner: { pid: 4, name: "System" }, ownedByGateway: false } }), probe: noCert });
    expect(s.state).toBe("port_problem");
    expect(s.message).toBe("Another program (System) is using port 443.");
    const fb = diagnose({ gateway: runtime({ fallback: true, activeHttpsPort: 43443, problem: { title: "Internet access is blocked by another program", summary: "IIS is using the web ports", checks: [], cause: "Stop IIS." } }) });
    expect(fb).toMatchObject({ state: "port_problem", message: "Another program is using port 443, so Nexus can't serve HTTPS for this address.", likelyCause: "Stop IIS.", usingFallbackPorts: true, httpsPort: 43443 });
  });

  it("9. certificate expired → certificate problem", () => {
    const s = diagnose({ probe: publicCert({ validTo: new Date(NOW - 2 * DAY).toISOString() }) });
    expect(s).toMatchObject({ state: "certificate_problem", title: "Certificate expired", certificateValid: false });
    expect(s.repair?.id).toBe("certificates.retry");
  });

  it("an internal certificate on a direct public address is a problem; in tunnel mode it is expected", () => {
    const internal = publicCert({ issuer: "Caddy Local Authority - ECC Intermediate", trusted: false, internal: true });
    expect(diagnose({ probe: internal }).state).toBe("certificate_problem");
    expect(diagnose({ probe: internal, gateway: runtime({ internalCertificates: true }) }).state).toBe("ready");
  });

  it("an untrusted certificate is never reported as ready", () => {
    expect(diagnose({ probe: publicCert({ trusted: false }) }).state).toBe("certificate_problem");
  });

  it("nothing listening on the active HTTPS port → gateway problem, not a TLS error", () => {
    const s = diagnose({ probe: { outcome: "refused", certificate: null, error: "connect ECONNREFUSED 127.0.0.1:443" } });
    expect(s.state).toBe("gateway_problem");
    expect(s.message).toBe("The secure gateway isn't accepting secure connections on port 443.");
  });

  it("ready but the application is down says so", () => {
    expect(diagnose({ applicationRunning: false }).message).toMatch(/application itself isn't running/);
  });

  it("test mode (plain HTTP) is reported as such", () => {
    expect(diagnose({ gateway: runtime({ automaticHttps: false }), probe: null }).state).toBe("disabled");
  });

  it("10. raw OpenSSL/Caddy errors are never the primary user-facing message", () => {
    const raw = /SSL routines|alert number|ssl3_|urn:ietf|ECONNREFUSED|rec_layer/;
    const cases: Partial<HttpsDiagnosisInput>[] = [
      { probe: noCert },
      { probe: noCert, acme: parseAcmeActivity([obtaining, couldNotGet], HOST) },
      { probe: { outcome: "handshake_failed", certificate: null, error: OPENSSL_ALERT_80.replace("80", "40") } },
      { probe: { outcome: "refused", certificate: null, error: "connect ECONNREFUSED 127.0.0.1:443" } },
      { probe: { outcome: "timeout", certificate: null, error: "timeout" } },
      { dns: dnsWrong, probe: noCert },
      { gateway: runtime({ running: false, error: OPENSSL_ALERT_80 }) },
    ];
    for (const c of cases) {
      const s = diagnose(c);
      expect(s.message).not.toMatch(raw);
      expect(s.title).not.toMatch(raw);
      expect(s.likelyCause ?? "").not.toMatch(raw);
    }
  });
});

describe("checkHttps uses the gateway's actual HTTPS port", () => {
  const spy = () => {
    const ports: number[] = [];
    const probe = async (_h: string, port: number) => {
      ports.push(port);
      return publicCert();
    };
    return { ports, probe };
  };

  it("3. Caddy running on 443 → checks 443", async () => {
    const { ports, probe } = spy();
    const s = await checkHttps({ hostname: HOST, dns: dnsOk, gateway: runtime(), logLines: [], probe, now: NOW });
    expect(ports).toEqual([443]);
    expect(s.httpsPort).toBe(443);
  });

  it("4. Caddy moved to a fallback port → checks the active port, not the configured one", async () => {
    const { ports, probe } = spy();
    const s = await checkHttps({ hostname: HOST, dns: dnsOk, gateway: runtime({ activeHttpsPort: 43443, fallback: true }), logLines: [], probe, now: NOW });
    expect(ports).toEqual([43443]);
    expect(s).toMatchObject({ httpsPort: 43443, configuredHttpsPort: 443, usingFallbackPorts: true, state: "port_problem" });
  });

  it("does not probe a stopped gateway", async () => {
    const { ports, probe } = spy();
    await checkHttps({ hostname: HOST, dns: dnsOk, gateway: runtime({ running: false }), logLines: [], probe });
    expect(ports).toEqual([]);
  });

  it("reads ACME progress and stored certificates from the gateway's own files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexus-https-"));
    try {
      const logFile = join(dir, "gateway.log");
      writeFileSync(logFile, ["not json", obtaining, challengeFailed, couldNotGet, willRetry, ""].join("\n"));
      expect(await readGatewayLog(logFile)).toHaveLength(5);
      mkdirSync(join(dir, "data", "certificates"), { recursive: true });
      const s = await checkHttps({
        hostname: HOST,
        dns: dnsOk,
        gateway: runtime({ logFile, storageDir: join(dir, "data") }),
        probe: async () => noCert,
        now: NOW,
      });
      expect(s.state).toBe("unreachable");
      expect(s.certificatePresent).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Caddy error translation", () => {
  it("classifies TLS client errors", () => {
    expect(classifyTlsError({ code: "ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR", message: OPENSSL_ALERT_80 })).toBe("no_certificate");
    expect(classifyTlsError({ message: OPENSSL_ALERT_80 })).toBe("no_certificate");
    expect(classifyTlsError({ code: "ECONNREFUSED", message: "connect ECONNREFUSED" })).toBe("refused");
    expect(classifyTlsError({ code: "ECONNRESET", message: "socket hang up" })).toBe("handshake_failed");
  });

  it("explains common certificate authority errors", () => {
    expect(explainAcmeError("urn:ietf:params:acme:error:connection - Timeout during connect (likely firewall problem)").kind).toBe("unreachable");
    expect(explainAcmeError("urn:ietf:params:acme:error:unauthorized - Invalid response from http://x/.well-known/acme-challenge/abc: 404").kind).toBe("wrong_server");
    expect(explainAcmeError("urn:ietf:params:acme:error:dns - DNS problem: NXDOMAIN looking up A").kind).toBe("dns");
    expect(explainAcmeError("urn:ietf:params:acme:error:rateLimited - too many certificates already issued").kind).toBe("rate_limited");
    expect(explainAcmeError("urn:ietf:params:acme:error:caa - CAA record forbids issuance").kind).toBe("caa");
    expect(explainAcmeError('registering account [] with server: provisioning client: performing request: Get "https://acme-v02.api.letsencrypt.org/directory": dial tcp: lookup acme-v02.api.letsencrypt.org: no such host').kind).toBe("ca_unreachable");
    // Outbound failures say "connection refused" too; they must not be blamed on port forwarding.
    expect(explainAcmeError('performing request: Get "https://acme-v02.api.letsencrypt.org/directory": dial tcp 1.2.3.4:443: connect: connection refused').kind).toBe("ca_unreachable");
  });

  it("DNS failure seen by the certificate authority → DNS problem", () => {
    const line = log({ level: "error", logger: "tls.obtain", msg: "could not get certificate from issuer", identifier: HOST, error: "HTTP 400 urn:ietf:params:acme:error:dns - DNS problem: NXDOMAIN looking up A for " + HOST });
    expect(diagnose({ probe: noCert, acme: parseAcmeActivity([obtaining, line], HOST) }).state).toBe("dns_problem");
  });

  it("ignores log lines about other names", () => {
    const other = couldNotGet.replaceAll(HOST, "other.example.com");
    expect(parseAcmeActivity([other], HOST)).toBeNull();
  });
});
