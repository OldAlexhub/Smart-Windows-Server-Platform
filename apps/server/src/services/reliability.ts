import { ReliabilityRepository, type DiskReliabilitySummary } from "@nexus/monitoring";
import type { HealthEvent, ProbeResult } from "@nexus/runtime";
import type { AppReliabilitySummary, DatabaseHealth } from "@nexus/shared";
import type { NexusContext } from "../context";
import type { AppManager, AppRecord, AppReliabilityObserver } from "./apps";

const SAMPLE_INTERVAL_MS = 60_000;

/** Connects runtime health signals to the bounded, durable reliability rollups. */
export class ReliabilityService implements AppReliabilityObserver {
  readonly history: ReliabilityRepository;
  private timer: NodeJS.Timeout | null = null;
  private started = false;

  constructor(
    private readonly ctx: NexusContext,
    private readonly apps: AppManager,
  ) {
    this.history = new ReliabilityRepository(ctx.store);
    apps.setReliabilityObserver(this);
    ctx.onStop(() => this.stop());
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.tick();
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async sample(at = Date.now()): Promise<void> {
    const applications = this.apps.list();
    const relationalHealth = this.relationalHealth(applications);
    const documentHealth = this.documentHealth(applications);

    await Promise.all(
      applications.map(async (app) => {
        const status = this.apps.status(app.id);
        const usage = this.ctx.monitoring?.app(app.id);
        this.history.recordAppSample({
          appId: app.id,
          status,
          expectedUp: app.desiredState === "running",
          cpuPercent: usage?.cpuPercent ?? null,
          memoryBytes: usage?.memoryBytes ?? null,
          databaseHealth: await this.databaseHealth(app, relationalHealth, documentHealth),
          at,
        });
      }),
    );

    for (const disk of this.ctx.monitoring?.latest()?.disks ?? []) {
      this.history.recordDisk(disk.mount, disk.totalBytes, disk.freeBytes, at);
    }
    this.history.prune(at);
  }

  onProbe(appId: string, probe: ProbeResult): void {
    this.history.recordProbe(appId, probe.ok, probe.ms);
  }

  onHealthEvent(appId: string, event: HealthEvent): void {
    if (event.kind === "process_crashed") this.history.recordEvent(appId, "crash");
    if (event.kind === "restarting") this.history.recordEvent(appId, "restart");
  }

  onManualRestart(appId: string): void {
    this.history.recordEvent(appId, "restart");
  }

  deleteApp(appId: string): void {
    this.history.deleteApp(appId);
  }

  appSummary(appId: string): AppReliabilitySummary {
    return this.history.appSummary(appId);
  }

  diskSummary(days: 7 | 30): DiskReliabilitySummary[] {
    return this.history.diskSummary(days);
  }

  private async tick(): Promise<void> {
    try {
      await this.sample();
    } catch (e) {
      this.ctx.log.warn("reliability sample failed", { err: e as Error });
    } finally {
      if (this.started) {
        this.timer = setTimeout(() => void this.tick(), SAMPLE_INTERVAL_MS);
        this.timer.unref();
      }
    }
  }

  /** One real application-credential check per PostgreSQL database. */
  private relationalHealth(apps: AppRecord[]): Map<string, Promise<DatabaseHealth>> {
    const checks = new Map<string, Promise<DatabaseHealth>>();
    for (const app of apps) {
      const id = app.databaseId;
      if (!id || checks.has(id)) continue;
      checks.set(
        id,
        (async () => {
          if (!this.ctx.databases?.get(id)) return "offline";
          try {
            const info = this.ctx.databases.connectionInfo(id, app.id);
            return (await this.ctx.databases.testConnection(info)).ok ? "healthy" : "offline";
          } catch {
            return "offline";
          }
        })(),
      );
    }
    return checks;
  }

  /** One connectivity check per document database, shared by every attached application. */
  private documentHealth(apps: AppRecord[]): Map<string, Promise<DatabaseHealth>> {
    const checks = new Map<string, Promise<DatabaseHealth>>();
    for (const app of apps) {
      const id = app.documentDatabaseId;
      if (!id || checks.has(id)) continue;
      checks.set(
        id,
        (async () => {
          if (!this.ctx.documents?.get(id)) return "offline";
          try {
            const info = this.ctx.documents.connectionInfo(id, app.id);
            return (await this.ctx.documents.testConnection(info)).ok ? "healthy" : "offline";
          } catch {
            return "offline";
          }
        })(),
      );
    }
    return checks;
  }

  private async databaseHealth(
    app: AppRecord,
    relational: Map<string, Promise<DatabaseHealth>>,
    documents: Map<string, Promise<DatabaseHealth>>,
  ): Promise<DatabaseHealth> {
    if (app.databaseId) return (await relational.get(app.databaseId)) ?? "unknown";
    if (app.documentDatabaseId) return (await documents.get(app.documentDatabaseId)) ?? "unknown";
    return app.dataMode === "external" ? "unknown" : "not_configured";
  }
}
