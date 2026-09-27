import { X509Certificate } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { join } from "node:path";
import tls from "node:tls";
import type { FriendlyProblem, RepairAction } from "@nexus/shared";
import type { DnsCheck } from "./domains";

// ------------------------------------------------------------------ gateway runtime

/**
 * What the secure gateway is actually doing right now, as reported by the service that runs it.
 * Status checks read this instead of guessing from settings (the gateway may have moved to
 * private fallback ports, stopped, or failed to apply a configuration).
 */
export interface GatewayRuntime {
  /** The gateway component is installed. */
  installed: boolean;
  running: boolean;
  /** Ports internet access should use (settings; normally 80/443). */
  configuredHttpPort: number;
  configuredHttpsPort: number;
  /** Ports the gateway really listens on; null before it has ever started. */
  activeHttpPort: number | null;
  activeHttpsPort: number | null;
  /** At least one public address is configured, so public HTTPS is expected. */
  publicExpected: boolean;
  /** The standard web ports were unavailable, so the gateway runs on private ports instead. */
  fallback: boolean;
  /** Caddy obtains public certificates automatically (off only in development/tests). */
  automaticHttps: boolean;
  /** Tunnel mode: the public certificate lives at the tunnel edge; locally an internal one is expected. */
  internalCertificates: boolean;
  /** Who listens on the active HTTPS port. `ownedByGateway` is null when it couldn't be checked. */
  listener: { owner: { pid: number; name: string } | null; ownedByGateway: boolean | null };
  /** Public addresses in the configuration the gateway is currently serving. */
  appliedHosts: string[];
  /** Last configuration/start failure, verbatim. */
  error: string | null;
  /** Plain-language port conflict, when the gateway had to fall back to private ports. */
  problem: FriendlyProblem | null;
  /** Certificate storage and log locations (to read ACME progress). */
  storageDir: string | null;
  logFile: string | null;
}

// ------------------------------------------------------------------ TLS probe

export interface PresentedCertificate {
  issuer: string | null;
  names: string[];
  validFrom: string;
  validTo: string;
  /** Chain verifies against the public root store (independent of hostname). */
  trusted: boolean;
  /** Issued by Caddy's own local authority (tunnel mode / `tls internal`). */
  internal: boolean;
}

export type TlsProbeOutcome =
  /** A certificate was presented. */
  | "certificate"
  /** The gateway answered but has no certificate for this name (Caddy's TLS alert 80). */
  | "no_certificate"
  /** Nothing listens on the port. */
  | "refused"
  | "timeout"
  /** Any other handshake failure. */
  | "handshake_failed";

export interface TlsProbe {
  outcome: TlsProbeOutcome;
  certificate: PresentedCertificate | null;
  /** Raw error for technical details only — never shown as the main message. */
  error: string | null;
}

const INTERNAL_ISSUER = /Caddy Local Authority/i;

/**
 * Connects to the local gateway with the public hostname as SNI and reports what it presents.
 * Certificate verification is not relaxed: the chain is checked against the public root store
 * and the result reported as `trusted`; we only keep the connection open long enough to read it.
 */
export function probeTls(hostname: string, port: number, host = "127.0.0.1", timeoutMs = 5000): Promise<TlsProbe> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: TlsProbe) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(r);
    };
    const socket = tls.connect({ host, port, servername: hostname, rejectUnauthorized: false, timeout: timeoutMs, ALPNProtocols: ["http/1.1"] }, () => {
      const c = socket.getPeerCertificate();
      if (!c || !c.valid_to) return finish({ outcome: "no_certificate", certificate: null, error: null });
      const cn = c.subject?.CN;
      const names = [
        ...(Array.isArray(cn) ? cn : cn ? [cn] : []),
        ...(c.subjectaltname ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.startsWith("DNS:"))
          .map((s) => s.slice(4)),
      ];
      const issuer = first(c.issuer?.O) ?? first(c.issuer?.CN) ?? null;
      finish({
        outcome: "certificate",
        error: null,
        certificate: {
          issuer,
          names: [...new Set(names.map((n) => n.toLowerCase()))],
          validFrom: new Date(c.valid_from).toISOString(),
          validTo: new Date(c.valid_to).toISOString(),
          trusted: socket.authorized,
          internal: INTERNAL_ISSUER.test(`${first(c.issuer?.O) ?? ""} ${first(c.issuer?.CN) ?? ""}`),
        },
      });
    });
    socket.on("error", (e: NodeJS.ErrnoException) => finish({ outcome: classifyTlsError(e), certificate: null, error: e.message }));
    socket.on("timeout", () => finish({ outcome: "timeout", certificate: null, error: `No answer within ${timeoutMs / 1000} seconds.` }));
  });
}

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** Maps a TLS client error to what it means for a Caddy gateway. */
export function classifyTlsError(e: { code?: string; message: string }): TlsProbeOutcome {
  if (e.code === "ECONNREFUSED") return "refused";
  if (e.code === "ETIMEDOUT") return "timeout";
  // Caddy (Go crypto/tls) answers "internal error" (alert 80) when it has no certificate for
  // the requested name — because none has been issued yet, or the name isn't configured.
  if (e.code === "ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR" || /alert number 80\b|alert internal error/i.test(e.message)) return "no_certificate";
  if (e.code === "ERR_SSL_TLSV1_UNRECOGNIZED_NAME" || /alert number 112\b|unrecognized name/i.test(e.message)) return "no_certificate";
  return "handshake_failed";
}

// ------------------------------------------------------------------ stored certificates

export interface StoredCertificate {
  /** Caddy's issuer folder, e.g. "acme-v02.api.letsencrypt.org-directory" or "local". */
  issuerKey: string;
  issuer: string | null;
  validTo: string;
  internal: boolean;
}

/** The newest certificate Caddy has saved for `hostname`, or null. Reads only; never writes. */
export async function findStoredCertificate(storageDir: string | null, hostname: string): Promise<StoredCertificate | null> {
  if (!storageDir) return null;
  const root = join(storageDir, "certificates");
  if (!existsSync(root)) return null;
  let best: StoredCertificate | null = null;
  for (const issuerKey of await fs.readdir(root).catch(() => [] as string[])) {
    const file = join(root, issuerKey, hostname, `${hostname}.crt`);
    if (!existsSync(file)) continue;
    try {
      const x = new X509Certificate(await fs.readFile(file));
      const validTo = new Date(x.validTo).toISOString();
      const issuer = /(?:^|\n)O=([^\n]+)/.exec(x.issuer)?.[1] ?? /(?:^|\n)CN=([^\n]+)/.exec(x.issuer)?.[1] ?? null;
      const cand = { issuerKey, issuer, validTo, internal: issuerKey === "local" || INTERNAL_ISSUER.test(x.issuer) };
      if (!best || cand.validTo > best.validTo) best = cand;
    } catch {
      /* unreadable certificate file: ignore */
    }
  }
  return best;
}

// ------------------------------------------------------------------ ACME progress (from Caddy's log)

export interface AcmeActivity {
  /** What Caddy last did for this name. */
  state: "in_progress" | "failed" | "obtained";
  at: string;
  /** Most recent failure since the last success, verbatim from Caddy. */
  lastError: string | null;
  lastErrorAt: string | null;
  attempts: number;
  nextRetryAt: string | null;
}

/** Reads the end of the gateway log (Caddy writes all of its output there as JSON lines). */
export async function readGatewayLog(logFile: string | null, maxBytes = 2 * 1024 * 1024): Promise<string[]> {
  if (!logFile || !existsSync(logFile)) return [];
  try {
    const fh = await fs.open(logFile, "r");
    try {
      const { size } = await fh.stat();
      const start = Math.max(0, size - maxBytes);
      const buf = Buffer.alloc(size - start);
      await fh.read(buf, 0, buf.length, start);
      const lines = buf.toString("utf8").split(/\r?\n/);
      if (start > 0) lines.shift(); // partial first line
      return lines.filter(Boolean);
    } finally {
      await fh.close();
    }
  } catch {
    return [];
  }
}

interface CaddyLogLine {
  ts?: number;
  level?: string;
  logger?: string;
  msg?: string;
  identifier?: string;
  domains?: string[];
  error?: string;
  retrying_in?: number;
  attempt?: number;
  /** acmez reports the CA's problem either as an object or as flat fields, depending on version. */
  problem?: { type?: string; title?: string; detail?: string };
  problem_type?: string;
}

/** Summarises Caddy's certificate work for one hostname from its JSON log lines (oldest first). */
export function parseAcmeActivity(lines: string[], hostname: string): AcmeActivity | null {
  const h = hostname.toLowerCase();
  let out: AcmeActivity | null = null;
  // A "challenge failed" line carries the CA's specific reason; the "could not get certificate"
  // line that follows in the same attempt only wraps it, so the specific one is kept.
  let challengeReason = false;
  for (const raw of lines) {
    if (!raw.includes(h)) continue;
    let l: CaddyLogLine;
    try {
      l = JSON.parse(raw) as CaddyLogLine;
    } catch {
      continue;
    }
    const logger = l.logger ?? "";
    if (!/^(tls|http\.acme_client|tls\.issuance)/.test(logger)) continue;
    const about = (l.identifier ?? "").toLowerCase() === h || (l.domains ?? []).some((d) => d.toLowerCase() === h) || (l.error ?? "").toLowerCase().includes(`[${h}]`);
    if (!about) continue;
    const at = new Date((l.ts ?? 0) * 1000).toISOString();
    const msg = l.msg ?? "";
    const cur: AcmeActivity = out ?? { state: "in_progress", at, lastError: null, lastErrorAt: null, attempts: 0, nextRetryAt: null };
    if (/certificate (obtained|renewed) successfully/.test(msg)) {
      out = { state: "obtained", at, lastError: null, lastErrorAt: null, attempts: 0, nextRetryAt: null };
    } else if (/^(obtaining|renewing) certificate$/.test(msg)) {
      // A retry after a failure keeps reporting the last reason until a certificate arrives.
      challengeReason = false;
      out = { ...cur, state: cur.state === "failed" ? "failed" : "in_progress", at };
    } else if (msg === "challenge failed") {
      challengeReason = true;
      const detail = [l.problem?.type ?? l.problem_type, l.problem?.detail ?? l.error].filter(Boolean).join(" - ") || "challenge failed";
      out = { ...cur, state: "failed", at, lastError: detail, lastErrorAt: at };
    } else if (msg === "could not get certificate from issuer") {
      out = { ...cur, state: "failed", at, lastError: challengeReason ? cur.lastError : (l.error ?? "certificate request failed"), lastErrorAt: at };
    } else if (msg === "will retry") {
      out = {
        ...cur,
        state: "failed",
        at,
        lastError: cur.lastError ?? l.error ?? null,
        lastErrorAt: cur.lastErrorAt ?? at,
        attempts: l.attempt ?? cur.attempts + 1,
        nextRetryAt: l.retrying_in ? new Date(((l.ts ?? 0) + l.retrying_in) * 1000).toISOString() : null,
      };
    }
  }
  return out;
}

export type AcmeFailureKind = "unreachable" | "wrong_server" | "dns" | "tls" | "rate_limited" | "caa" | "rejected" | "ca_unreachable" | "other";

/** Plain-language reason for a certificate authority error from Caddy. */
export function explainAcmeError(error: string): { kind: AcmeFailureKind; cause: string } {
  const e = error.toLowerCase();
  // Errors without an ACME problem document happened on the way *to* the CA (this server's outbound
  // connection), so their "refused"/"timeout" wording must not be read as inbound port trouble.
  if (!e.includes("urn:ietf:params:acme:error") && /performing request|provisioning client|dial tcp|no such host|tls handshake timeout|i\/o timeout|context deadline exceeded/.test(e))
    return { kind: "ca_unreachable", cause: "This server couldn't contact the certificate authority. Check this computer's internet connection." };
  if (/acme:error:ratelimited|too many (certificates|failed authorizations|new orders)|rate ?limit/.test(e))
    return { kind: "rate_limited", cause: "The certificate authority has temporarily limited new certificates for this domain after several attempts. Nexus will keep trying automatically; this usually clears within a few hours." };
  if (/acme:error:caa|caa record/.test(e))
    return { kind: "caa", cause: "A CAA record on this domain doesn't allow the certificate authority Nexus uses. Remove or update the CAA record at your domain provider." };
  if (/acme:error:dns|nxdomain|no valid (a|aaaa) records|servfail|dns problem/.test(e))
    return { kind: "dns", cause: "The certificate authority couldn't find this address in DNS. Check the DNS record at your domain provider, then wait a few minutes." };
  if (/acme:error:connection|timeout during connect|likely firewall problem|connection refused|connection reset/.test(e))
    return { kind: "unreachable", cause: "The certificate authority could not reach this server. Check that ports 80 and 443 are forwarded to this computer and allowed through any firewall." };
  if (/acme:error:unauthorized|invalid response from|incorrect validation certificate/.test(e))
    return { kind: "wrong_server", cause: "The certificate authority reached a different device or server instead of Nexus. Check that ports 80 and 443 on your router are forwarded to this computer." };
  if (/acme:error:tls/.test(e))
    return { kind: "tls", cause: "The certificate authority could not make a secure connection to this server on port 443. Check that port 443 is forwarded to this computer." };
  if (/acme:error:rejectedidentifier|policy forbids/.test(e))
    return { kind: "rejected", cause: "The certificate authority won't issue certificates for this name." };
  return { kind: "other", cause: "The certificate authority didn't issue a certificate for this address." };
}

// ------------------------------------------------------------------ diagnosis

export type HttpsState =
  | "ready"
  | "pending"
  | "dns_problem"
  | "gateway_problem"
  | "certificate_problem"
  | "port_problem"
  | "unreachable"
  /** Development/tests: public addresses are served over plain HTTP by design. */
  | "disabled";

export interface HttpsStatus {
  state: HttpsState;
  hostname: string;
  /** Short label, e.g. "Certificate being prepared". */
  title: string;
  /** Plain-language explanation — never raw TLS/OpenSSL output. */
  message: string;
  likelyCause: string | null;
  /** One-click repair, when there is one. */
  repair: RepairAction | null;
  /** Raw details (OpenSSL, Caddy, ACME) for "Technical details" only. */
  technicalDetails: string | null;
  dnsConnected: boolean | null;
  gatewayRunning: boolean;
  /** The port the gateway actually serves HTTPS on (what was checked). */
  httpsPort: number | null;
  configuredHttpsPort: number;
  usingFallbackPorts: boolean;
  certificatePresent: boolean;
  certificateValid: boolean;
  certificateIssuer: string | null;
  expiresAt: string | null;
  daysLeft: number | null;
  /** When Caddy will try to get the certificate again (after a failure). */
  nextRetryAt: string | null;
  applicationRunning: boolean | null;
}

export interface HttpsDiagnosisInput {
  hostname: string;
  dns: DnsCheck | null;
  gateway: GatewayRuntime;
  probe: TlsProbe | null;
  stored: StoredCertificate | null;
  acme: AcmeActivity | null;
  /** The application behind the address is serving (null if unknown). */
  applicationRunning?: boolean | null;
  now?: number;
}

const RETRY_GATEWAY: RepairAction = { id: "gateway.retry", label: "Try Again", requiresConfirmation: false };
const RETRY_CERTIFICATE: RepairAction = { id: "certificates.retry", label: "Try Again", requiresConfirmation: false };

/** Pure decision: turns everything Nexus knows about one address into one plain-language state. */
export function diagnoseHttps(input: HttpsDiagnosisInput): HttpsStatus {
  const { hostname, dns, gateway: g, probe, stored, acme } = input;
  const now = input.now ?? Date.now();
  const cert = probe?.certificate ?? null;
  const h = hostname.toLowerCase();
  const nameMatches = !!cert && cert.names.some((n) => n === h || (n.startsWith("*.") && h.endsWith(n.slice(1)) && h.split(".").length === n.split(".").length));
  const expiresAt = cert?.validTo ?? stored?.validTo ?? null;
  const daysLeft = expiresAt ? Math.floor((Date.parse(expiresAt) - now) / 86_400_000) : null;
  const expired = !!cert && Date.parse(cert.validTo) <= now;
  const trustedEnough = !!cert && (cert.trusted || (g.internalCertificates && cert.internal));
  const certificateValid = !!cert && nameMatches && !expired && trustedEnough;
  const port = g.activeHttpsPort;

  const base: HttpsStatus = {
    state: "pending",
    hostname,
    title: "",
    message: "",
    likelyCause: null,
    repair: null,
    technicalDetails: null,
    dnsConnected: dns ? dns.status === "connected" : null,
    gatewayRunning: g.running,
    httpsPort: port,
    configuredHttpsPort: g.configuredHttpsPort,
    usingFallbackPorts: g.fallback,
    certificatePresent: !!cert || !!stored,
    certificateValid,
    certificateIssuer: cert?.issuer ?? stored?.issuer ?? null,
    expiresAt,
    daysLeft,
    nextRetryAt: acme?.state === "failed" ? acme.nextRetryAt : null,
    applicationRunning: input.applicationRunning ?? null,
  };
  const out = (s: Partial<HttpsStatus> & Pick<HttpsStatus, "state" | "title" | "message">): HttpsStatus => ({ ...base, ...s });
  const technical = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join("\n") || null;
  const probeDetail = probe?.error ? `TLS check on 127.0.0.1:${port} (SNI ${hostname}): ${probe.error}` : null;

  // 1. HTTPS deliberately off (development/tests).
  if (!g.automaticHttps) return out({ state: "disabled", title: "HTTPS off", message: "This Nexus serves public addresses over plain HTTP (test mode). Certificates are not used." });

  // 2. The gateway itself.
  if (!g.installed)
    return out({ state: "gateway_problem", title: "Secure gateway missing", message: "The secure gateway component isn't installed, so Nexus can't serve HTTPS.", likelyCause: "Reinstall or repair Nexus to restore the secure gateway." });
  if (g.fallback) {
    return out({
      state: "port_problem",
      title: "Port in use",
      message: `Another program is using port ${g.configuredHttpsPort}, so Nexus can't serve HTTPS for this address.`,
      likelyCause: g.problem?.cause ?? g.problem?.summary ?? null,
      repair: RETRY_GATEWAY,
      technicalDetails: technical(g.problem?.technical, port ? `Secure gateway moved to private port ${port}.` : null),
    });
  }
  if (g.listener.ownedByGateway === false && g.listener.owner) {
    return out({
      state: "port_problem",
      title: "Port in use",
      message: `Another program (${g.listener.owner.name}) is using port ${port ?? g.configuredHttpsPort}.`,
      likelyCause: `Stop or reconfigure ${g.listener.owner.name}, then press Try Again.`,
      repair: RETRY_GATEWAY,
      technicalDetails: technical(`${g.listener.owner.name} (process ${g.listener.owner.pid}) listens on port ${port ?? g.configuredHttpsPort}.`, g.error),
    });
  }
  if (!g.running) {
    return out({
      state: "gateway_problem",
      title: "Secure gateway stopped",
      message: "The secure gateway isn't running, so this address can't be reached.",
      likelyCause: g.error ? "Nexus could not start the secure gateway." : null,
      repair: RETRY_GATEWAY,
      technicalDetails: technical(g.error),
    });
  }
  if (!g.appliedHosts.includes(h)) {
    return out({
      state: "gateway_problem",
      title: "Not applied yet",
      message: g.error ? "Nexus could not apply the secure gateway configuration for this address." : "Nexus hasn't applied this address to the secure gateway yet.",
      repair: RETRY_GATEWAY,
      technicalDetails: technical(g.error),
    });
  }

  // 3. DNS (only proves the name points here — not that the internet can reach the ports).
  if (dns && (dns.status === "pending" || dns.status === "wrong_target")) {
    return out({
      state: "dns_problem",
      title: dns.status === "pending" ? "Waiting for DNS" : "DNS needs a change",
      message: dns.status === "pending" ? "This address doesn't point to this server yet. HTTPS starts automatically once it does." : "This address does not currently point to this server.",
      likelyCause: dns.action,
      technicalDetails: technical(dns.found.length ? `DNS answers: ${dns.found.join(", ")}` : "No DNS answer.", acme?.lastError),
    });
  }

  // 4. What the gateway presents.
  const acmeFailure = acme && acme.state === "failed" && acme.lastError ? { ...explainAcmeError(acme.lastError), raw: acme.lastError } : null;
  const acmeTechnical = acmeFailure ? `Certificate authority: ${acmeFailure.raw}${acme?.attempts ? ` (attempt ${acme.attempts})` : ""}` : null;

  if (cert && nameMatches && !expired) {
    if (cert.internal && !g.internalCertificates) {
      return out({
        state: "certificate_problem",
        title: "Private certificate",
        message: "This address uses a certificate only this computer trusts, so visitors will see a security warning.",
        likelyCause: "Internal certificates are meant for secure tunnels. Switch off tunnel mode for direct internet access, then press Try Again.",
        repair: RETRY_CERTIFICATE,
        technicalDetails: technical(`Issuer: ${cert.issuer ?? "unknown"}`),
      });
    }
    if (!trustedEnough) {
      return out({
        state: "certificate_problem",
        title: "Certificate not trusted",
        message: "The certificate for this address isn't from a trusted certificate authority, so visitors will see a security warning.",
        repair: RETRY_CERTIFICATE,
        technicalDetails: technical(`Issuer: ${cert.issuer ?? "unknown"}`, acmeTechnical),
      });
    }
    const renewNote = daysLeft !== null && daysLeft <= 7 && acmeFailure ? ` Renewal is failing: ${acmeFailure.cause}` : "";
    const appNote = input.applicationRunning === false ? " The application itself isn't running right now, so visitors see a “not running” page." : "";
    return out({
      state: "ready",
      title: "HTTPS active",
      message: `${g.internalCertificates ? "HTTPS is provided through the secure tunnel." : `HTTPS is active. Renews automatically (valid ${daysLeft} more days).`}${renewNote}${appNote}`,
      likelyCause: renewNote ? acmeFailure!.cause : null,
      technicalDetails: technical(`Issuer: ${cert.issuer ?? "unknown"}; expires ${cert.validTo}`, acmeTechnical),
    });
  }

  if (cert && expired) {
    return out({
      state: "certificate_problem",
      title: "Certificate expired",
      message: "The certificate for this address has expired, so visitors see a security warning.",
      likelyCause: acmeFailure?.cause ?? "Nexus will renew it automatically; press Try Again to renew now.",
      repair: RETRY_CERTIFICATE,
      technicalDetails: technical(`Expired ${cert.validTo}; issuer ${cert.issuer ?? "unknown"}`, acmeTechnical),
    });
  }

  if (probe && (probe.outcome === "refused" || probe.outcome === "timeout")) {
    return out({
      state: "gateway_problem",
      title: "Secure gateway not answering",
      message: probe.outcome === "refused" ? `The secure gateway isn't accepting secure connections on port ${port}.` : "The secure gateway didn't answer in time.",
      repair: RETRY_GATEWAY,
      technicalDetails: technical(probeDetail, g.error),
    });
  }

  // No usable certificate for this name yet (Caddy's alert 80, a wrong-name certificate, or no probe).
  if (acmeFailure) {
    const state: HttpsState = acmeFailure.kind === "unreachable" || acmeFailure.kind === "wrong_server" || acmeFailure.kind === "tls" ? "unreachable" : acmeFailure.kind === "dns" ? "dns_problem" : "certificate_problem";
    return out({
      state,
      title: "Certificate could not be issued",
      message: "Nexus could not complete secure HTTPS setup for this address.",
      likelyCause: acmeFailure.cause,
      repair: RETRY_CERTIFICATE,
      technicalDetails: technical(acmeTechnical, probeDetail),
    });
  }
  if (probe?.outcome === "handshake_failed") {
    return out({
      state: "certificate_problem",
      title: "Secure connection failed",
      message: "The secure gateway couldn't complete a secure connection for this address.",
      repair: RETRY_CERTIFICATE,
      technicalDetails: technical(probeDetail),
    });
  }
  const recent = acme && acme.state !== "failed";
  return out({
    state: "pending",
    title: "Certificate being prepared",
    message: "Nexus is setting up HTTPS. This can take a short time after connecting a new domain.",
    likelyCause:
      !recent && dns?.status === "connected"
        ? "If this doesn't change within a few minutes, check that ports 80 and 443 are forwarded to this computer — DNS alone doesn't prove the internet can reach it."
        : null,
    technicalDetails: technical(probeDetail, cert && !nameMatches ? `Presented certificate is for ${cert.names.join(", ") || "another name"}.` : null),
  });
}

/** Everything needed to check one address, gathered with the gateway's real runtime state. */
export async function checkHttps(opts: {
  hostname: string;
  dns: DnsCheck | null;
  gateway: GatewayRuntime;
  /** Pre-read gateway log lines (read once per request when checking many addresses). */
  logLines?: string[];
  applicationRunning?: boolean | null;
  probe?: typeof probeTls;
  now?: number;
}): Promise<HttpsStatus> {
  const { hostname, gateway: g } = opts;
  const canProbe = g.installed && g.running && g.automaticHttps && g.activeHttpsPort !== null;
  const [probe, stored, lines] = await Promise.all([
    canProbe ? (opts.probe ?? probeTls)(hostname, g.activeHttpsPort!) : Promise.resolve(null),
    g.automaticHttps ? findStoredCertificate(g.storageDir, hostname) : Promise.resolve(null),
    opts.logLines ? Promise.resolve(opts.logLines) : g.automaticHttps ? readGatewayLog(g.logFile) : Promise.resolve([]),
  ]);
  return diagnoseHttps({ hostname, dns: opts.dns, gateway: g, probe, stored, acme: parseAcmeActivity(lines, hostname), applicationRunning: opts.applicationRunning, now: opts.now });
}
