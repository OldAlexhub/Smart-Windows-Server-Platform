/**
 * Domain contracts shared by the core service and the UI.
 * These are the words users see: Running, Healthy, Connected, Protected, Needs Attention.
 */
import type { FriendlyProblem } from "./errors";

// ---------- Applications ----------
export type AppStatus = "deploying" | "starting" | "running" | "stopped" | "crashed" | "needs_attention";

/** How an application is reachable from outside this computer. */
export type AccessMode =
  | "private" // this computer only
  | "internet" // public HTTPS
  | "authorized" // HTTPS, requires a Nexus login
  | "api"; // HTTPS, requires an API key

export type RuntimeKind = "node" | "python" | "static";

export interface ResourcePolicy {
  cpuLimitPercent: number | "auto";
  memoryLimitMb: number | "auto";
  priority: "low" | "normal" | "high";
}

export type HealthEndpointSource = "detected" | "user" | "framework";

export interface HealthMonitoring {
  /** Automatic validates detected candidates; custom trusts the endpoint selected by the user. */
  mode: "automatic" | "custom";
  /** Static-analysis suggestion. It is never authoritative by itself. */
  candidate: { path: string; evidence: string } | null;
  /** Endpoint allowed to use strict health semantics. Null means general HTTP liveness on "/". */
  endpoint: { path: string; source: HealthEndpointSource; validated: boolean } | null;
  /** Runtime evidence explaining why an automatic candidate was demoted. */
  rejection: { path: string; status: number | null; reason: string; at: string } | null;
}

export interface AppSummary {
  id: string;
  name: string;
  slug: string;
  status: AppStatus;
  runtime: RuntimeKind;
  framework: string;
  accessMode: AccessMode;
  localUrl: string;
  externalUrl: string | null;
  databaseId: string | null;
  cpuPercent: number;
  memoryBytes: number;
  storageBytes: number;
  currentRelease: string | null;
  lastDeployedAt: string | null;
  problem: FriendlyProblem | null;
}

// ---------- Databases ----------
export type DatabaseStatus = "healthy" | "offline" | "needs_attention";

export interface DatabaseSummary {
  id: string;
  name: string;
  /** postgresql = tables (relational); mongodb = collections of JSON-like documents. */
  engine: "postgresql" | "mongodb";
  dbName: string;
  status: DatabaseStatus;
  sizeBytes: number;
  /** Tables (PostgreSQL) or collections (MongoDB). */
  tableCount: number;
  /** MongoDB only: number of documents. */
  documentCount?: number;
  connectionCount: number;
  ownerAppIds: string[];
  /** Applications (that still exist) using this database: only these block deleting it. */
  usedBy?: { id: string; name: string }[];
  lastBackupAt: string | null;
  protected: boolean;
}

// ---------- Hardware ----------
export type DiskMedia = "nvme" | "ssd" | "hdd" | "unknown";

export interface DiskInfo {
  mount: string; // "C:\\"
  label: string;
  fileSystem: string;
  totalBytes: number;
  freeBytes: number;
  media: DiskMedia;
  /** Connection bus as reported by Windows: "NVMe", "SATA", "USB", ... */
  bus: string | null;
  model: string | null;
  removable: boolean;
  /** USB / Thunderbolt / SD attached — good for backups, not for live databases. */
  external: boolean;
}

export interface GpuInfo {
  name: string;
  vendor: "nvidia" | "amd" | "intel" | "other";
  vramBytes: number;
  driverVersion: string | null;
  cudaVersion: string | null;
  integrated: boolean;
}

export interface NetworkInterfaceInfo {
  name: string;
  address: string;
  family: "IPv4" | "IPv6";
  internal: boolean;
}

export interface HardwareProfile {
  detectedAt: string;
  os: { name: string; version: string; build: string; edition: string; arch: string };
  cpu: { model: string; vendor: string; cores: number; threads: number; baseMhz: number };
  memory: { totalBytes: number; freeBytes: number };
  disks: DiskInfo[];
  gpus: GpuInfo[];
  cuda: { available: boolean; version: string | null };
  network: NetworkInterfaceInfo[];
  virtualization: {
    firmwareEnabled: boolean | null;
    hypervisorPresent: boolean;
    /** WSL is installed and usable. */
    wsl2Available: boolean;
    /** WSL is not installed but this machine can run it. */
    wsl2Installable: boolean;
  };
  system: { manufacturer: string; model: string };
}

// ---------- AI ----------
export type AiAcceleration = "cuda" | "rocm" | "vulkan" | "cpu";
export type AiPermissionLevel = "observe" | "recommend" | "execute_after_approval";

// ---------- Activity ----------
export type ActivityKind = "success" | "info" | "warning" | "problem";

export interface ActivityItem {
  id: string;
  at: string;
  kind: ActivityKind;
  message: string;
  appId?: string;
}

// ---------- Jobs (long-running operations with progress) ----------
export type JobStatus = "running" | "succeeded" | "failed" | "waiting_for_input";

export interface JobStep {
  key: string;
  label: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  detail?: string;
}

export interface JobState {
  id: string;
  kind: string;
  title: string;
  status: JobStatus;
  steps: JobStep[];
  startedAt: string;
  finishedAt: string | null;
  result?: unknown;
  problem?: FriendlyProblem;
}
