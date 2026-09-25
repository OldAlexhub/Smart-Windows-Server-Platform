import { FirewallManager, serverAddress, subnetCidr, SubnetRelay } from "@nexus/network";
import { NexusError } from "@nexus/shared";
import type { NexusContext } from "../context";
import type { PrivateNetworkService } from "./private-network";

export type DatabaseKind = "tables" | "documents";

/** The login other servers use; kept apart from every application's own login. */
const LINK_LOGIN = "network-link";
const SETTING = "databaseLinks";
const FIREWALL_RULE = "Database Links";

interface LinkRecord {
  kind: DatabaseKind;
  databaseId: string;
  port: number;
  createdAt: string;
}

export interface DatabaseLink {
  available: boolean;
  /** Why it can't be used right now, in plain words. */
  blocker: string | null;
  enabled: boolean;
  host: string | null;
  port: number | null;
  database: string | null;
  user: string | null;
  /** The full address; the password is masked unless revealed. */
  url: string | null;
}

/**
 * "Connect from another server": a database made reachable from Nexus's private network (WireGuard)
 * — never from the internet. Each link has its own login for that one database, a relay that only
 * accepts private-network addresses, and a firewall rule limited to the same range.
 */
export class DatabaseLinkService {
  private readonly relays = new Map<string, SubnetRelay>();

  constructor(
    private readonly ctx: NexusContext,
    private readonly privateNetwork: PrivateNetworkService,
  ) {}

  private records(): Record<string, LinkRecord> {
    return this.ctx.settings.get<Record<string, LinkRecord>>(SETTING, {});
  }

  private save(records: Record<string, LinkRecord>): void {
    this.ctx.settings.set(SETTING, records);
  }

  private key = (kind: DatabaseKind, id: string) => `${kind}:${id}`;

  private manager(kind: DatabaseKind) {
    const m = kind === "tables" ? this.ctx.databases : this.ctx.documents;
    if (!m) throw NexusError.conflict("The database server isn't running.");
    return m;
  }

  private network(): { base: string; cidr: string } | null {
    const pn = this.privateNetwork.settings();
    return pn.enabled && pn.subnet ? { base: serverAddress(pn.subnet), cidr: subnetCidr(pn.subnet) } : null;
  }

  status(kind: DatabaseKind, databaseId: string, reveal = false): DatabaseLink {
    const m = this.manager(kind);
    if (!m.get(databaseId)) throw NexusError.notFound("Database");
    const net = this.network();
    const rec = this.records()[this.key(kind, databaseId)];
    const blocker = net ? null : "Set up the private network first (Settings → External Access → Private network).";
    if (!rec) return { available: !blocker, blocker, enabled: false, host: net?.base ?? null, port: null, database: null, user: null, url: null };
    const info = m.connectionInfo(databaseId, LINK_LOGIN);
    const host = net?.base ?? "10.73.0.1";
    const password = reveal ? info.password : "••••••••";
    const user = encodeURIComponent(info.user);
    const db = encodeURIComponent(info.database);
    const url =
      kind === "tables"
        ? `postgres://${user}:${reveal ? encodeURIComponent(password) : password}@${host}:${rec.port}/${db}`
        : `mongodb://${user}:${reveal ? encodeURIComponent(password) : password}@${host}:${rec.port}/${db}?authMechanism=PLAIN&authSource=%24external&directConnection=true`;
    return { available: !blocker, blocker, enabled: true, host, port: rec.port, database: info.database, user: info.user, url };
  }

  async enable(kind: DatabaseKind, databaseId: string): Promise<DatabaseLink> {
    const net = this.network();
    if (!net) throw NexusError.conflict("Set up the private network first (Settings → External Access → Private network), then share the database.");
    const m = this.manager(kind);
    if (!m.get(databaseId)) throw NexusError.notFound("Database");
    await m.grantAppAccess(databaseId, LINK_LOGIN);
    const records = this.records();
    const k = this.key(kind, databaseId);
    records[k] ??= { kind, databaseId, port: await this.ctx.ports.allocate("database-link", k), createdAt: new Date().toISOString() };
    this.save(records);
    await this.startRelay(records[k]!, net.cidr);
    await this.syncFirewall();
    this.ctx.activity.add("info", `${m.get(databaseId)!.name} can now be reached from your private network.`);
    return this.status(kind, databaseId, true);
  }

  async disable(kind: DatabaseKind, databaseId: string): Promise<void> {
    const k = this.key(kind, databaseId);
    await this.relays.get(k)?.stop();
    this.relays.delete(k);
    const records = this.records();
    delete records[k];
    this.save(records);
    this.ctx.ports.release("database-link", k);
    const m = this.manager(kind);
    if (m.get(databaseId)) await m.revokeAppAccess(databaseId, LINK_LOGIN);
    await this.syncFirewall();
  }

  /** A new password for the link (the old one stops working at once). */
  async rotate(kind: DatabaseKind, databaseId: string): Promise<DatabaseLink> {
    if (!this.records()[this.key(kind, databaseId)]) throw NexusError.conflict("This database isn't shared.");
    await this.manager(kind).rotatePassword(databaseId, LINK_LOGIN);
    return this.status(kind, databaseId, true);
  }

  private async startRelay(rec: LinkRecord, cidr: string): Promise<void> {
    const k = this.key(rec.kind, rec.databaseId);
    if (this.relays.has(k)) return;
    const relay = new SubnetRelay({
      listenPort: rec.port,
      allowCidr: cidr,
      target: async () => {
        const m = rec.kind === "tables" ? this.ctx.databases : this.ctx.documents;
        if (!m?.get(rec.databaseId)) return null;
        if (rec.kind === "documents") await this.ctx.documents!.ensureRunning(rec.databaseId);
        const info = m.connectionInfo(rec.databaseId, LINK_LOGIN);
        return { host: "127.0.0.1", port: info.port };
      },
      onRefused: (from) => this.ctx.log.warn("refused a database connection from outside the private network", { from, database: rec.databaseId }),
    });
    await relay.start();
    this.relays.set(k, relay);
  }

  /** One firewall rule for all links: Nexus's own program, those ports, private-network addresses only. */
  private async syncFirewall(): Promise<void> {
    const fw = new FirewallManager();
    const ports = Object.values(this.records()).map((r) => r.port);
    const net = this.network();
    if (!ports.length || !net) return void (await fw.removeRule(FIREWALL_RULE));
    const r = await fw.ensureRule({ name: FIREWALL_RULE, program: process.execPath, ports, protocol: "TCP", remoteIps: [net.cidr] });
    if (!r.ok) this.ctx.log.warn("database link firewall rule not applied", { error: r.error });
  }

  /** On start: bring back the links (dropping any whose database was deleted). */
  async resume(): Promise<void> {
    const net = this.network();
    const records = this.records();
    let changed = false;
    for (const [k, rec] of Object.entries(records)) {
      const m = rec.kind === "tables" ? this.ctx.databases : this.ctx.documents;
      if (!m?.get(rec.databaseId)) {
        delete records[k];
        changed = true;
        continue;
      }
      if (net) await this.startRelay(rec, net.cidr).catch((e) => this.ctx.log.warn("database link could not start", { err: e as Error, database: rec.databaseId }));
    }
    if (changed) this.save(records);
    await this.syncFirewall();
  }

  async stop(): Promise<void> {
    for (const r of this.relays.values()) await r.stop();
    this.relays.clear();
  }
}
