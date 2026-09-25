import { NexusError } from "@nexus/shared";
import type { AppRole, Role } from "./roles";

/**
 * Every protected action in Nexus maps to exactly one permission.
 * App-scoped permissions can be granted per application via app roles.
 */
export const PERMISSIONS = [
  // server-wide
  "server.view",
  "server.settings",
  "server.remote_admin",
  "server.recovery_key",
  "users.manage",
  "audit.view",
  "network.manage",
  "ai.use",
  "ai.approve",
  "plugins.manage",
  "apps.create",
  "databases.create",
  // app-scoped
  "app.view",
  "app.use",
  "app.operate",
  "app.deploy",
  "app.configure",
  "app.secrets.read",
  "app.delete",
  "app.logs",
  "app.data.read",
  "app.data.write",
  "app.backup",
  "app.restore",
  "app.access.configure",
  "pipelines.view",
  "pipelines.run",
  "pipelines.edit",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const APP_SCOPED = new Set<Permission>([
  "app.view",
  "app.use",
  "app.operate",
  "app.deploy",
  "app.configure",
  "app.secrets.read",
  "app.delete",
  "app.logs",
  "app.data.read",
  "app.data.write",
  "app.backup",
  "app.restore",
  "app.access.configure",
]);

export const isAppScoped = (p: Permission): boolean => APP_SCOPED.has(p);

const ALL = new Set<Permission>(PERMISSIONS);
const OWNER_ONLY = new Set<Permission>(["server.remote_admin", "server.recovery_key"]);

const VIEWER: Permission[] = ["server.view", "app.view", "app.logs", "pipelines.view", "ai.use"];
const OPERATOR: Permission[] = [...VIEWER, "app.use", "app.operate", "app.backup", "app.data.read", "pipelines.run"];
const DEVELOPER: Permission[] = [
  ...OPERATOR,
  "apps.create",
  "databases.create",
  "app.deploy",
  "app.configure",
  "app.secrets.read",
  "app.data.write",
  "pipelines.edit",
];

const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  owner: ALL,
  administrator: new Set([...ALL].filter((p) => !OWNER_ONLY.has(p))),
  developer: new Set(DEVELOPER),
  operator: new Set(OPERATOR),
  viewer: new Set(VIEWER),
  app_user: new Set<Permission>([]),
};

/** What a per-application role allows on that application. */
const APP_ROLE_PERMISSIONS: Record<AppRole, ReadonlySet<Permission>> = {
  administrator: new Set([...APP_SCOPED]),
  developer: new Set([...APP_SCOPED].filter((p) => p !== "app.delete" && p !== "app.restore" && p !== "app.access.configure")),
  operator: new Set<Permission>(["app.view", "app.use", "app.operate", "app.logs", "app.backup", "app.data.read"]),
  viewer: new Set<Permission>(["app.view", "app.logs"]),
  app_user: new Set<Permission>(["app.use"]),
};

/** The subset of a user needed for authorization decisions. */
export interface Principal {
  role: Role;
  disabled?: boolean;
  serverSettingsAccess: boolean;
  appRoles: Record<string, AppRole>;
}

/**
 * Decides whether `principal` may perform `permission` (optionally on application `appId`).
 * - Global role grants apply everywhere.
 * - An app role grants app-scoped permissions on that app only (it can raise access,
 *   e.g. a global Viewer who administers TaxiOps).
 * - Server settings additionally require the per-user "Server Settings" switch.
 */
export function authorize(principal: Principal, permission: Permission, appId?: string): boolean {
  if (principal.disabled) return false;
  if (permission === "server.settings" && !principal.serverSettingsAccess) return false;
  if (ROLE_PERMISSIONS[principal.role].has(permission)) return true;
  if (isAppScoped(permission) && appId) {
    const appRole = principal.appRoles[appId];
    return !!appRole && APP_ROLE_PERMISSIONS[appRole].has(permission);
  }
  return false;
}

export function assertAuthorized(principal: Principal, permission: Permission, appId?: string): void {
  if (!authorize(principal, permission, appId)) throw NexusError.forbidden();
}

/** Applications the principal can see at all. */
export function visibleAppIds(principal: Principal, allAppIds: readonly string[]): string[] {
  if (principal.disabled) return [];
  if (ROLE_PERMISSIONS[principal.role].has("app.view")) return [...allAppIds];
  return allAppIds.filter((id) => {
    const r = principal.appRoles[id];
    return !!r && (APP_ROLE_PERMISSIONS[r].has("app.view") || APP_ROLE_PERMISSIONS[r].has("app.use"));
  });
}

export function permissionsFor(principal: Principal, appId?: string): Permission[] {
  return PERMISSIONS.filter((p) => authorize(principal, p, appId));
}
