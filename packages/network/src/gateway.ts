import type { AccessMode } from "@nexus/shared";

/** One application as the gateway sees it. */
export interface GatewaySite {
  id: string;
  name: string;
  /** Always-available local address, e.g. "taxiops.nexus.localhost". */
  localHost: string;
  /** Public domains (empty for private apps). */
  publicHosts: string[];
  access: AccessMode;
  /** Backend port on 127.0.0.1, if the app has a running server. */
  upstreamPort: number | null;
  /** Built frontend / static site to serve directly. */
  static?: { root: string; spa: boolean } | null;
  /** When both static and upstream exist, requests under this prefix go to the backend. */
  apiPrefix?: string | null;
  maxBodyMb?: number;
  /** Behind a tunnel the public certificate lives at the tunnel edge; use an internal one here. */
  tlsInternal?: boolean;
}

export interface GatewayConfig {
  /** Caddy admin API port (loopback only). */
  adminPort: number;
  httpPort: number;
  httpsPort: number;
  /** Port for the local *.nexus.localhost addresses (loopback only). */
  localPort: number;
  /** Nexus management API port (loopback) — target for auth checks and the login pages. */
  nexusPort: number;
  acmeEmail: string | null;
  /** Where certificates and ACME state are kept. */
  storageDir: string;
  logFile: string;
  sites: GatewaySite[];
  /** Remote access to the Nexus control center itself (off unless the Owner enables it). */
  management?: { publicHost: string } | null;
  /**
   * Nexus's private network (WireGuard): every app and the control center on their own port,
   * answering only devices inside the network. The marker is a secret the gateway adds so Nexus
   * knows a request came through the private network (nobody outside can guess it).
   */
  privateNetwork?: { subnetCidr: string; marker: string; controlPort: number; sites: { siteId: string; port: number }[] } | null;
  /** Tests / LAN-only setups: serve public hosts over plain HTTP without certificates. */
  disableAutoHttps?: boolean;
}

/**
 * Abstraction over the HTTPS gateway so Caddy can be replaced (Traefik, nginx, a Windows
 * native proxy...) without touching the rest of Nexus.
 */
export interface GatewayProvider {
  readonly id: string;
  apply(config: GatewayConfig): Promise<void>;
  start(config: GatewayConfig): Promise<void>;
  stop(): Promise<void>;
  running(): Promise<boolean>;
  validate(config: GatewayConfig): Promise<{ valid: boolean; error?: string }>;
}

// ------------------------------------------------------------------ validation

const HOSTNAME = /^(?=.{1,253}$)(?!-)([a-z0-9-]{1,63}(?<!-)\.)+[a-z][a-z0-9-]{0,62}(?<!-)$/;

export function isValidHostname(h: string): boolean {
  return HOSTNAME.test(h.toLowerCase());
}

function host(h: string): string {
  const v = h.trim().toLowerCase();
  if (!isValidHostname(v)) throw new Error(`"${h}" is not a valid domain name.`);
  return v;
}

/** Quote a filesystem path for the Caddyfile; refuse characters that could break out. */
function path(p: string): string {
  if (/["\r\n{}]/.test(p)) throw new Error("Unsupported characters in path.");
  return `"${p.replace(/\\/g, "/")}"`;
}

function prefix(p: string): string {
  if (!/^\/[A-Za-z0-9_\-./]*$/.test(p)) throw new Error(`Invalid path prefix "${p}".`);
  return p.replace(/\/+$/, "");
}

const port = (n: number) => {
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`Invalid port ${n}.`);
  return n;
};

// ------------------------------------------------------------------ rendering

const indent = (lines: string[], n = 1) => lines.map((l) => (l ? `${"\t".repeat(n)}${l}` : l));

function contentHandlers(site: GatewaySite): string[] {
  const upstream = site.upstreamPort !== null ? `reverse_proxy 127.0.0.1:${port(site.upstreamPort)}` : null;
  const staticLines = site.static
    ? [
        `root * ${path(site.static.root)}`,
        ...(site.static.spa ? ["try_files {path} /index.html"] : []),
        "encode zstd gzip",
        "file_server",
      ]
    : null;
  if (upstream && staticLines) {
    const api = prefix(site.apiPrefix ?? "/api");
    return [`handle ${api}/* {`, ...indent([upstream]), "}", "handle {", ...indent(staticLines), "}"];
  }
  if (upstream) return [upstream];
  if (staticLines) return staticLines;
  return ['respond "This application is not running right now." 503'];
}

function authLines(site: GatewaySite, nexusPort: number): string[] {
  if (site.access !== "authorized" && site.access !== "api") return [];
  const mode = site.access === "authorized" ? "user" : "api";
  const lines = [
    `forward_auth 127.0.0.1:${port(nexusPort)} {`,
    ...indent([
      `uri /api/v1/gateway/authorize?app=${encodeURIComponent(site.id)}&mode=${mode}`,
      "copy_headers X-Nexus-User X-Nexus-User-Id X-Nexus-Client",
    ]),
    "}",
  ];
  return lines;
}

const MARKER = /^[A-Za-z0-9_-]{16,128}$/;
const CIDR = /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/;

function privateNetworkBlocks(cfg: GatewayConfig): string[] {
  const pn = cfg.privateNetwork;
  if (!pn) return [];
  if (!MARKER.test(pn.marker) || !CIDR.test(pn.subnetCidr)) throw new Error("Invalid private network settings.");
  // `route` runs its directives in the order written (Caddy otherwise orders them itself, and
  // would serve the request before refusing it): refuse anyone outside first.
  const guarded = (lines: string[]) => [`@outside not remote_ip ${pn.subnetCidr}`, "route {", ...indent(["abort @outside", ...lines]), "}"];
  const toNexus = (extra: string[] = []) => [`reverse_proxy 127.0.0.1:${port(cfg.nexusPort)} {`, ...indent(["header_up X-Nexus-Remote 1", `header_up X-Nexus-Private-Network ${pn.marker}`, ...extra]), "}"];
  const out = ["# Nexus control center (private network)", `http://:${port(pn.controlPort)} {`, ...indent(guarded(toNexus())), "}", ""];
  for (const { siteId, port: p } of pn.sites) {
    const site = cfg.sites.find((x) => x.id === siteId);
    if (!site) continue;
    const auth = authLines(site, cfg.nexusPort);
    // forward_auth is a reverse proxy to Nexus too: mark it the same way.
    const markedAuth = auth.length ? [...auth.slice(0, -1), ...indent([`header_up X-Nexus-Private-Network ${pn.marker}`]), auth.at(-1)!] : [];
    const body = ["request_body {", ...indent([`max_size ${Math.max(1, site.maxBodyMb ?? 100)}MB`]), "}"];
    if (site.access === "authorized") body.push("handle /.nexus/* {", ...indent(toNexus()), "}");
    body.push("handle {", ...indent([...markedAuth, ...contentHandlers(site)]), "}");
    out.push(`# ${sanitizeComment(site.name)} (private network)`, `http://:${port(p)} {`, ...indent(guarded(body)), "}", "");
  }
  return out;
}

function publicSiteBlock(site: GatewaySite, cfg: GatewayConfig): string[] {
  const addresses = site.publicHosts.map((h) => (cfg.disableAutoHttps ? `http://${host(h)}:${cfg.httpPort}` : host(h)));
  const body: string[] = [
    ...(site.tlsInternal && !cfg.disableAutoHttps ? ["tls internal"] : []),
    "import nexus_security",
    `request_body {`,
    ...indent([`max_size ${Math.max(1, site.maxBodyMb ?? 100)}MB`]),
    "}",
  ];
  if (site.access === "authorized") {
    // Nexus's sign-in pages live on the app's own domain so the session cookie belongs to it.
    body.push(
      "handle /.nexus/* {",
      ...indent([`reverse_proxy 127.0.0.1:${port(cfg.nexusPort)} {`, ...indent(["header_up X-Nexus-Remote 1"]), "}"]),
      "}",
    );
  }
  body.push("handle {", ...indent([...authLines(site, cfg.nexusPort), ...contentHandlers(site)]), "}");
  return [`# ${sanitizeComment(site.name)} (${site.access})`, `${addresses.join(", ")} {`, ...indent(body), "}", ""];
}

function localSiteBlock(site: GatewaySite, cfg: GatewayConfig): string[] {
  return [
    `# ${sanitizeComment(site.name)} — this computer only`,
    `http://${host(site.localHost)}:${port(cfg.localPort)} {`,
    ...indent(["bind 127.0.0.1 [::1]", ...contentHandlers(site)]),
    "}",
    "",
  ];
}

const sanitizeComment = (s: string) => s.replace(/[\r\n]/g, " ").slice(0, 80);

/**
 * Renders the complete gateway configuration. The gateway is the only listener on the
 * public ports; every upstream is on 127.0.0.1. PostgreSQL, the AI runtime and internal
 * services are never routed.
 */
export function renderCaddyfile(cfg: GatewayConfig): string {
  const out: string[] = [
    "# Generated by Nexus — do not edit. Changes are made in Nexus and applied automatically.",
    "{",
    ...indent([
      `admin 127.0.0.1:${port(cfg.adminPort)}`,
      `http_port ${port(cfg.httpPort)}`,
      `https_port ${port(cfg.httpsPort)}`,
      `storage file_system ${path(cfg.storageDir)}`,
      ...(cfg.acmeEmail ? [`email ${cfg.acmeEmail.replace(/[^A-Za-z0-9@._+-]/g, "")}`] : []),
      ...(cfg.disableAutoHttps ? ["auto_https off"] : []),
      // Never modify the Windows certificate store silently; tunnel/local certificates don't need it.
      "skip_install_trust",
      "log {",
      ...indent([
        `output file ${path(cfg.logFile)} {`,
        ...indent(["roll_size 20MiB", "roll_keep 5"]),
        "}",
        "format json",
      ]),
      "}",
    ]),
    "}",
    "",
    "(nexus_security) {",
    ...indent([
      "header {",
      ...indent([
        'Strict-Transport-Security "max-age=31536000; includeSubDomains"',
        "X-Content-Type-Options nosniff",
        "Referrer-Policy strict-origin-when-cross-origin",
        "X-Frame-Options SAMEORIGIN",
        "-Server",
      ]),
      "}",
    ]),
    "}",
    "",
  ];

  const seen = new Set<string>();
  for (const site of cfg.sites) {
    for (const h of [site.localHost, ...site.publicHosts]) {
      const k = h.toLowerCase();
      if (seen.has(k)) throw new Error(`The address ${h} is used by more than one application.`);
      seen.add(k);
    }
    out.push(...localSiteBlock(site, cfg));
    if (site.access !== "private" && site.publicHosts.length > 0) out.push(...publicSiteBlock(site, cfg));
  }

  if (cfg.management) {
    const h = host(cfg.management.publicHost);
    if (seen.has(h)) throw new Error(`The address ${h} is already used by an application.`);
    out.push(
      "# Nexus control center (remote administration)",
      `${cfg.disableAutoHttps ? `http://${h}:${cfg.httpPort}` : h} {`,
      ...indent([
        "import nexus_security",
        `reverse_proxy 127.0.0.1:${port(cfg.nexusPort)} {`,
        ...indent(["header_up X-Nexus-Remote 1", "header_up X-Nexus-Remote-Host {host}"]),
        "}",
      ]),
      "}",
      "",
    );
  }

  out.push(...privateNetworkBlocks(cfg));

  // Anything not explicitly routed (unknown domains, apps switched to private) gets nothing.
  out.push("# Everything else", `http://:${port(cfg.httpPort)} {`, ...indent(['respond "Not found" 404']), "}", "");
  return out.join("\n");
}
