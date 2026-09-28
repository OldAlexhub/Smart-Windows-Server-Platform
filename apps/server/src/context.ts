import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, join } from "node:path";
import { AiProposals } from "@nexus/ai";
import { BackupManager, RestoreManager } from "@nexus/backups";
import {
  DatabaseManager,
  DataBrowser,
  DocumentBrowser,
  DocumentDatabaseManager,
  CompatibleDocumentEngine,
  FerretDbFleet,
  locateFerretDb,
  locateMongoDb,
  locatePostgresBinaries,
  mongoAdminSecret,
  mongoKeyFileSecret,
  MongoDbFleet,
  PostgresEngine,
  tunePostgres,
} from "@nexus/database";
import { bundledPython, DeploymentManager, PythonLocator } from "@nexus/deployment";
import { HardwareDetector } from "@nexus/hardware";
import { LogManager } from "@nexus/logs";
import { MonitoringManager } from "@nexus/monitoring";
import { PortAllocator } from "@nexus/network";
import { defaultRuntimeContext, IsolationRegistry, PodmanIsolationProvider, ProcessIsolationProvider } from "@nexus/runtime";
import { AppTokens, AuditLog, defaultKeyProtector, LoginGuard, SecretVault, UserManager, type KeyProtector } from "@nexus/security";
import { NexusError, randomToken, silentLogger, type HardwareProfile, type Logger } from "@nexus/shared";
import { SettingsRepo, settingsMigrations, StateStore } from "@nexus/state";
import { StorageManager } from "@nexus/storage";
import { componentDir, type DataPaths, type ServicePaths } from "./paths";
import { ActivityFeed } from "./services/activity";
import { JobManager } from "./services/jobs";

export interface NexusOptions {
  paths: ServicePaths;
  /** Port of the management API / control center (loopback). */
  managementPort: number;
  keyProtector?: KeyProtector;
  logger?: Logger;
  hardwareDetector?: HardwareDetector;
  /** Private port range for apps and services (default 43000–43999). */
  portRange?: [number, number];
}

export const SETTINGS = {
  setupCompleted: "setup.completed",
  dataPaths: "setup.dataPaths",
  hardware: "hardware.profile",
  aiEnabled: "ai.enabled",
  aiLevel: "ai.level",
  aiModel: "ai.preferredModel",
  baseDomain: "network.baseDomain",
  acmeEmail: "network.acmeEmail",
  remoteAdmin: "remoteAdmin",
} as const;

/**
 * Composition root of the Nexus Core Service. Owns every manager and their lifecycle.
 * Core services exist from the first start; data services start once setup has chosen
 * where data lives.
 */
export class NexusContext {
  readonly log: Logger;
  readonly store: StateStore;
  readonly settings: SettingsRepo;
  readonly vault: SecretVault;
  readonly users: UserManager;
  readonly audit: AuditLog;
  readonly guard: LoginGuard;
  readonly appTokens: AppTokens;
  readonly activity: ActivityFeed;
  readonly jobs: JobManager;
  readonly logs: LogManager;
  readonly ports: PortAllocator;
  readonly isolation: IsolationRegistry;
  readonly aiProposals: AiProposals;
  readonly hardwareDetector: HardwareDetector;
  /** Secret the desktop app reads from disk to sign in locally. */
  readonly localToken: string;

  // Data services (available after setup)
  dataPaths: DataPaths | null = null;
  postgres: PostgresEngine | null = null;
  databases: DatabaseManager | null = null;
  dataBrowser: DataBrowser | null = null;
  /** Managed document databases: MongoDB replica sets plus legacy FerretDB databases. */
  documents: DocumentDatabaseManager | null = null;
  documentEngine: FerretDbFleet | null = null;
  /** Real MongoDB replica sets used by transaction-dependent applications. */
  documentMongoEngine: MongoDbFleet | null = null;
  /** Legacy engine apps connect to: the compatibility layer in front of FerretDB. */
  documentCompat: CompatibleDocumentEngine | null = null;
  documentBrowser: DocumentBrowser | null = null;
  /** The preferred engine for newly created document databases. */
  documentSource: { engine: "MongoDB" | "FerretDB"; source: "bundled" | "configured"; version: string; transactions: boolean } | null = null;
  deployments: DeploymentManager | null = null;
  storage: StorageManager | null = null;
  backups: BackupManager | null = null;
  restore: RestoreManager | null = null;
  monitoring: MonitoringManager | null = null;

  private readonly stopHooks: (() => Promise<void> | void)[] = [];

  private constructor(readonly opts: NexusOptions) {
    this.log = opts.logger ?? silentLogger;
    const p = opts.paths;
    this.store = new StateStore(p.stateDb);
    this.store.migrate(settingsMigrations);
    this.settings = new SettingsRepo(this.store);
    this.vault = SecretVault.open(this.store, p.keyFile, opts.keyProtector ?? defaultKeyProtector());
    this.users = new UserManager(this.store, this.vault);
    this.users.ensureOwner();
    this.audit = new AuditLog(this.store);
    this.guard = new LoginGuard(this.store);
    this.appTokens = new AppTokens(this.store);
    this.activity = new ActivityFeed(this.store);
    this.jobs = new JobManager();
    this.logs = new LogManager(this.store, join(p.logs, "apps"));
    this.ports = new PortAllocator(this.store, opts.portRange ? { rangeStart: opts.portRange[0], rangeEnd: opts.portRange[1] } : {});
    this.isolation = new IsolationRegistry();
    this.isolation.register(new ProcessIsolationProvider());
    this.isolation.register(new PodmanIsolationProvider());
    this.aiProposals = new AiProposals(this.store);
    this.hardwareDetector = opts.hardwareDetector ?? new HardwareDetector({ logger: this.log });
    this.localToken = this.writeLocalToken();
  }

  static async create(opts: NexusOptions): Promise<NexusContext> {
    const ctx = new NexusContext(opts);
    if (ctx.setupCompleted) await ctx.startDataServices();
    return ctx;
  }

  get setupCompleted(): boolean {
    return this.settings.get(SETTINGS.setupCompleted, false);
  }

  get hardware(): HardwareProfile | null {
    return this.settings.get<HardwareProfile | null>(SETTINGS.hardware, null);
  }

  /** Rotated on every service start; readable only by administrators and the service. */
  private writeLocalToken(): string {
    const token = randomToken(32);
    writeFileSync(this.opts.paths.localTokenFile, token, { mode: 0o600 });
    return token;
  }

  component(name: string): string | null {
    return componentDir(this.opts.paths, name);
  }

  /**
   * Python for applications and pipeline scripts: Nexus's own first, then installs for all users.
   * As the Windows service, per-user installs are ignored (their owner could change them).
   */
  pythonLocator(): PythonLocator {
    const dir = this.component("python");
    return new PythonLocator(undefined, bundledPython(dir, dir ? basename(dir) : null), userInfo().username.toUpperCase() === "SYSTEM");
  }

  /** Starts PostgreSQL, deployments, storage, backups and monitoring using the chosen data paths. */
  async startDataServices(): Promise<void> {
    const dp = this.settings.get<DataPaths | null>(SETTINGS.dataPaths, null);
    if (!dp) throw new Error("Setup has not chosen where to store data yet.");
    this.dataPaths = dp;
    const hw = this.hardware;

    // Deployments & storage
    this.deployments = new DeploymentManager(this.store, { appsRoot: dp.apps, runtime: defaultRuntimeContext(), python: this.pythonLocator(), logger: this.log.child({ module: "deploy" }) });
    this.storage = new StorageManager(this.store, dp.files);

    // PostgreSQL
    const pgDir = this.component("postgresql");
    const bin = locatePostgresBinaries({ bundledRoots: pgDir ? [join(pgDir, "..")] : [] });
    if (bin) {
      let superPw = this.vault.get("system/postgres-superuser");
      if (!superPw) {
        superPw = randomToken(24);
        this.vault.set("system/postgres-superuser", superPw, "system");
      }
      const major = bin.version.split(".")[0];
      const makeEngine = (port: number) =>
        new PostgresEngine({
        bin,
        dataDir: join(dp.database, `pg${major}`),
        port,
        superuser: "nexus_admin",
        superuserPassword: superPw,
        tuning: tunePostgres({
          totalMemoryBytes: hw?.memory.totalBytes ?? 8 * 1024 ** 3,
          cpuThreads: hw?.cpu.threads ?? 4,
          storage: hw?.disks.find((d) => dp.database.toUpperCase().startsWith(d.mount.toUpperCase()))?.media ?? "unknown",
          memoryShare: 0.35,
        }),
        logger: this.log.child({ module: "postgres" }),
      });
      this.postgres = makeEngine(await this.ports.allocate("postgres", "sql"));
      try {
        await this.postgres.start();
      } catch (e) {
        // Self-healing: another program took our port between restarts → move PostgreSQL.
        const moved = await this.ports.ensureAvailable("postgres", "sql");
        if (moved.changedFrom === null) throw e;
        this.log.warn("postgres port was taken; moved", { from: moved.changedFrom, to: moved.port });
        this.activity.add("info", "The database server moved to a new private port because another program was using its old one.");
        this.postgres = makeEngine(moved.port);
        await this.postgres.start();
      }
      this.databases = new DatabaseManager(this.store, this.vault, this.postgres);
      await this.databases.hardenCluster();
      this.dataBrowser = new DataBrowser(this.databases);
      this.stopHooks.push(() => this.postgres?.stop());
    } else {
      this.log.warn("PostgreSQL binaries not found; database features disabled until the component is installed");
    }

    // Document databases: existing FerretDB databases remain supported; new databases use an
    // isolated MongoDB replica set so applications get real multi-document transactions.
    const ferretDir = this.component("ferretdb");
    // Advanced: an administrator may point Nexus at another FerretDB build.
    const ferret = locateFerretDb({ configured: this.settings.get<string | null>("documents.ferretdbPath", null), bundledRoots: ferretDir ? [join(ferretDir, "..")] : [] });
    let ferretCompat: CompatibleDocumentEngine | null = null;
    if (ferret && this.postgres) {
      const pg = this.postgres;
      this.documentEngine = new FerretDbFleet({ bin: ferret, pgPort: () => this.postgres?.port ?? pg.port, stateDir: join(this.opts.paths.root, "documents"), logger: this.log.child({ module: "documents" }) });
      // Apps talk to the compatibility layer; FerretDB listens on an internal port behind it.
      const fleet = this.documentEngine;
      this.documentCompat = new CompatibleDocumentEngine(
        fleet,
        async (pgDatabase, ownedByUs) => (await this.ports.ensureAvailable("ferretdb-engine", pgDatabase, ownedByUs)).port,
        this.log.child({ module: "documents" }),
      );
      ferretCompat = this.documentCompat;
    }
    const mongoDir = this.component("mongodb");
    const mongo = locateMongoDb({ configured: this.settings.get<string | null>("documents.mongodbPath", null), bundledRoots: mongoDir ? [join(mongoDir, "..")] : [] });
    if (mongo) {
      this.documentMongoEngine = new MongoDbFleet({
        bin: mongo,
        stateDir: join(dp.database, "mongodb"),
        credentials: (databaseKey) => ({
          username: "nexus_admin",
          password: this.vault.require(mongoAdminSecret(databaseKey)),
          keyFile: this.vault.require(mongoKeyFileSecret(databaseKey)),
        }),
        logger: this.log.child({ module: "mongodb" }),
      });
      this.documentSource = { engine: "MongoDB", source: mongo.source, version: mongo.version, transactions: true };
    } else if (ferret) {
      this.documentSource = { engine: "FerretDB", source: ferret.source, version: ferret.version, transactions: false };
    }
    if (ferretCompat || this.documentMongoEngine) {
      this.documents = new DocumentDatabaseManager(this.store, this.vault, this.postgres, ferretCompat, this.ports, this.documentMongoEngine);
      this.documentBrowser = new DocumentBrowser(this.documents);
      this.stopHooks.push(async () => {
        await this.documentMongoEngine?.stop();
        await this.documentCompat?.stop();
      });
    }

    // Backups
    const pgCfg =
      this.postgres && bin
        ? { binDir: bin.binDir, host: "127.0.0.1", port: this.postgres.port, user: this.postgres.superuser, password: this.vault.require("system/postgres-superuser") }
        : null;
    this.backups = new BackupManager(this.store, { root: dp.backups, backupKey: this.vault.deriveKey("backups"), pg: pgCfg, logger: this.log.child({ module: "backups" }) });
    this.restore = new RestoreManager(this.backups, pgCfg);

    // Monitoring
    this.monitoring = new MonitoringManager({
      mounts: () => [...new Set(Object.values(dp).map((p) => `${p.slice(0, 2)}\\`))],
      appPids: () => this.appPidsProvider(),
      logger: this.log.child({ module: "monitoring" }),
    });
    this.monitoring.start();
    this.stopHooks.push(() => this.monitoring?.stop());
    this.log.info("data services started", { postgres: !!this.postgres, documents: this.documentSource ? `${this.documentSource.source} ${this.documentSource.engine} ${this.documentSource.version}` : null });
  }

  /**
   * The document database manager ("Create Document Database", deploying a MongoDB app, backups).
   * Each database's endpoint starts on demand; this only checks the component is available.
   */
  startDocuments(): Promise<DocumentDatabaseManager> {
    if (!this.documents) {
      return Promise.reject(NexusError.conflict("The document database component is not installed. Reinstall Nexus to add it."));
    }
    return Promise.resolve(this.documents);
  }

  /** Run once setup completes while the service is already running (apps, backups, AI...). */
  readonly afterSetup: (() => Promise<void>)[] = [];

  /** Set by the application manager so monitoring can see app process trees. */
  appPidsProvider: () => { appId: string; pid: number }[] = () => [];

  onStop(fn: () => Promise<void> | void): void {
    this.stopHooks.push(fn);
  }

  async shutdown(): Promise<void> {
    for (const h of this.stopHooks.reverse()) {
      try {
        await h();
      } catch (e) {
        this.log.warn("shutdown step failed", { err: e as Error });
      }
    }
    this.logs.dispose();
    this.store.close();
  }

  /** Reads the local sign-in token as the desktop app would. */
  static readLocalToken(paths: ServicePaths): string | null {
    return existsSync(paths.localTokenFile) ? readFileSync(paths.localTokenFile, "utf8").trim() : null;
  }
}
