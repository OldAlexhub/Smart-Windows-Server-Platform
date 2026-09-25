import { describe, expect, it } from "vitest";
import { StateStore } from "@nexus/state";
import { AuditLog } from "@nexus/security";

describe("AuditLog", () => {
  const setup = () => {
    const store = StateStore.memory();
    return { store, audit: new AuditLog(store) };
  };

  it("records and queries entries newest first", () => {
    const { audit } = setup();
    audit.record({ actor: { type: "user", id: "u1", name: "Owner" }, action: "app.deploy", target: { type: "app", id: "taxiops" } });
    audit.record({ actor: { type: "ai" }, action: "sql.read", target: { type: "database", id: "db1" } });
    audit.record({
      actor: { type: "user", id: "u2" },
      action: "app.delete",
      target: { type: "app", id: "taxiops" },
      outcome: "denied",
    });
    const forApp = audit.query({ targetType: "app", targetId: "taxiops" });
    expect(forApp.map((e) => e.action)).toEqual(["app.delete", "app.deploy"]);
    expect(audit.query({ outcome: "denied" })).toHaveLength(1);
    expect(audit.query({ action: "app." })).toHaveLength(2);
  });

  it("redacts secret-looking fields", () => {
    const { audit } = setup();
    const e = audit.record({
      actor: { type: "system" },
      action: "database.create",
      details: { dbName: "taxiops", password: "p@ss", nested: { apiToken: "abc", ok: 1 } },
    });
    expect(e.details).toEqual({ dbName: "taxiops", password: "[redacted]", nested: { apiToken: "[redacted]", ok: 1 } });
  });

  it("is append-only at the database level", () => {
    const { audit, store } = setup();
    audit.record({ actor: { type: "system" }, action: "x" });
    expect(() => store.run("DELETE FROM audit_log")).toThrow(/append-only/);
    expect(() => store.run("UPDATE audit_log SET action = 'y'")).toThrow(/append-only/);
  });

  it("detects tampering through the hash chain", () => {
    const { audit, store } = setup();
    for (let i = 0; i < 5; i++) audit.record({ actor: { type: "system" }, action: `step.${i}` });
    expect(audit.verify()).toEqual({ intact: true, brokenAt: null, entries: 5 });
    // An attacker with raw file access drops the trigger and rewrites history.
    store.db.exec("DROP TRIGGER audit_no_update");
    store.run("UPDATE audit_log SET action = 'innocent' WHERE id = 3");
    expect(audit.verify()).toMatchObject({ intact: false, brokenAt: 3 });
  });
});
