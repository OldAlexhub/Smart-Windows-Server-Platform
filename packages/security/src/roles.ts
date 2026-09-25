/** Global roles, most to least privileged. */
export const ROLES = ["owner", "administrator", "developer", "operator", "viewer", "app_user"] as const;
export type Role = (typeof ROLES)[number];

/** Roles that can be granted on a single application. */
export const APP_ROLES = ["administrator", "developer", "operator", "viewer", "app_user"] as const;
export type AppRole = (typeof APP_ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  administrator: "Administrator",
  developer: "Developer",
  operator: "Operator",
  viewer: "Viewer",
  app_user: "Application User",
};

export function isRole(v: unknown): v is Role {
  return typeof v === "string" && (ROLES as readonly string[]).includes(v);
}

export function isAppRole(v: unknown): v is AppRole {
  return typeof v === "string" && (APP_ROLES as readonly string[]).includes(v);
}
