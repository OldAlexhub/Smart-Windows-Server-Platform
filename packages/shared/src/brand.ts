/**
 * Single source of truth for product branding.
 * Rename the product by editing this file only — UI, service names, installer
 * metadata and data folders all derive from it.
 */
export const BRAND = {
  productName: "Nexus Server",
  shortName: "Nexus",
  assistantName: "Nexus AI",
  publisher: "Nexus",
  /** Windows service id (no spaces). */
  serviceId: "NexusServer",
  serviceDisplayName: "Nexus Server Core",
  /** Folder name used under ProgramData and on data drives. */
  dataFolderName: "Nexus",
  backupFolderName: "NexusBackups",
  /** Local-only hostname suffix for friendly app URLs, e.g. taxiops.nexus.localhost */
  localDomainSuffix: "nexus.localhost",
  /** Prefix for environment variables injected into applications and scripts. */
  envPrefix: "NEXUS_",
  installerName: "NexusSetup.exe",
  accentColor: "#5b6cff",
  tagline: "This computer can become your private application server.",
} as const;

export type Brand = typeof BRAND;
