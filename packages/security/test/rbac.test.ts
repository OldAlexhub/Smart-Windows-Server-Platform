import { describe, expect, it } from "vitest";
import { assertAuthorized, authorize, permissionsFor, visibleAppIds, type Principal } from "@nexus/security";

const p = (role: Principal["role"], extra: Partial<Principal> = {}): Principal => ({
  role,
  serverSettingsAccess: true,
  appRoles: {},
  ...extra,
});

describe("RBAC", () => {
  it("owner can do everything, administrator everything except owner-only actions", () => {
    expect(authorize(p("owner"), "server.recovery_key")).toBe(true);
    expect(authorize(p("owner"), "app.delete", "taxiops")).toBe(true);
    expect(authorize(p("administrator"), "users.manage")).toBe(true);
    expect(authorize(p("administrator"), "server.recovery_key")).toBe(false);
    expect(authorize(p("administrator"), "server.remote_admin")).toBe(false);
  });

  it("developer deploys and configures but cannot manage users, network or restores", () => {
    const dev = p("developer");
    expect(authorize(dev, "app.deploy", "x")).toBe(true);
    expect(authorize(dev, "app.secrets.read", "x")).toBe(true);
    expect(authorize(dev, "apps.create")).toBe(true);
    expect(authorize(dev, "users.manage")).toBe(false);
    expect(authorize(dev, "network.manage")).toBe(false);
    expect(authorize(dev, "app.restore", "x")).toBe(false);
  });

  it("operator operates and backs up but cannot deploy or write data", () => {
    const op = p("operator");
    expect(authorize(op, "app.operate", "x")).toBe(true);
    expect(authorize(op, "app.backup", "x")).toBe(true);
    expect(authorize(op, "app.deploy", "x")).toBe(false);
    expect(authorize(op, "app.data.write", "x")).toBe(false);
  });

  it("viewer is read-only", () => {
    const v = p("viewer");
    expect(authorize(v, "app.view", "x")).toBe(true);
    expect(authorize(v, "app.operate", "x")).toBe(false);
    expect(authorize(v, "app.secrets.read", "x")).toBe(false);
  });

  it("app roles grant access on that application only (John example)", () => {
    const john = p("viewer", { appRoles: { taxiops: "administrator", finance: "viewer" }, serverSettingsAccess: false });
    expect(authorize(john, "app.configure", "taxiops")).toBe(true);
    expect(authorize(john, "app.restore", "taxiops")).toBe(true);
    expect(authorize(john, "app.configure", "finance")).toBe(false);
    expect(authorize(john, "app.view", "finance")).toBe(true);
    expect(authorize(john, "app.configure")).toBe(false); // needs the app id
    expect(authorize(john, "server.settings")).toBe(false);
  });

  it("server settings require the per-user switch even for administrators", () => {
    expect(authorize(p("administrator", { serverSettingsAccess: false }), "server.settings")).toBe(false);
    expect(authorize(p("administrator"), "server.settings")).toBe(true);
  });

  it("application users can only use their assigned applications", () => {
    const u = p("app_user", { appRoles: { taxiops: "app_user" } });
    expect(authorize(u, "app.use", "taxiops")).toBe(true);
    expect(authorize(u, "app.use", "finance")).toBe(false);
    expect(authorize(u, "app.view", "taxiops")).toBe(false);
    expect(authorize(u, "server.view")).toBe(false);
    expect(visibleAppIds(u, ["taxiops", "finance"])).toEqual(["taxiops"]);
  });

  it("disabled principals are denied everything", () => {
    expect(permissionsFor(p("owner", { disabled: true }))).toEqual([]);
    expect(() => assertAuthorized(p("owner", { disabled: true }), "server.view")).toThrow(/permission/);
  });

  it("visible apps for global roles include all", () => {
    expect(visibleAppIds(p("viewer"), ["a", "b"])).toEqual(["a", "b"]);
  });
});
