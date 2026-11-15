import { describe, expect, it } from "vitest";
import { ResourcePressurePolicy } from "../src/resource-pressure";

describe("adaptive memory pressure", () => {
  it("lets busy apps use spare memory and only deprioritizes persistently idle apps under pressure", () => {
    const policy = new ResourcePressurePolicy();
    const apps = [{ appId: "busy", cpuPercent: 60 }, { appId: "idle", cpuPercent: 0 }];
    for (let i = 0; i < 4; i++) expect([...policy.sample(100, 50, apps).values()]).toEqual([false, false]);
    expect([...policy.sample(100, 90, apps).values()]).toEqual([false, true]);
    // Hysteresis avoids oscillation; active work immediately restores normal priority.
    expect(policy.sample(100, 84, apps).get("idle")).toBe(true);
    expect(policy.sample(100, 84, [{ appId: "idle", cpuPercent: 10 }]).get("idle")).toBe(false);
    expect(policy.sample(100, 70, apps).get("idle")).toBe(false);
  });
  it("does not immediately trim newly started or restarted apps", () => {
    const policy = new ResourcePressurePolicy();
    const apps = [{ appId: "new", cpuPercent: 0 }];
    expect(policy.sample(100, 95, apps).get("new")).toBe(false);
    expect(policy.sample(100, 95, apps).get("new")).toBe(false);
    expect(policy.sample(100, 95, apps).get("new")).toBe(true);
    policy.sample(100, 95, []);
    expect(policy.sample(100, 95, apps).get("new")).toBe(false);
  });
});
