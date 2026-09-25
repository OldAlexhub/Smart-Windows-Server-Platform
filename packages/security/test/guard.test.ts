import { describe, expect, it } from "vitest";
import { StateStore } from "@nexus/state";
import { LoginGuard, RateLimiter } from "@nexus/security";

describe("RateLimiter", () => {
  it("allows bursts up to capacity then refills over time", () => {
    const clock = { t: 0 };
    const rl = new RateLimiter(3, 1, () => clock.t);
    expect([1, 2, 3].map(() => rl.take("k").allowed)).toEqual([true, true, true]);
    const denied = rl.take("k");
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(1000);
    clock.t += 1000;
    expect(rl.take("k").allowed).toBe(true);
    expect(rl.take("other").allowed).toBe(true); // independent keys
  });
});

describe("LoginGuard", () => {
  const setup = () => {
    const clock = { t: 1_000_000 };
    const guard = new LoginGuard(StateStore.memory(), undefined, () => clock.t);
    return { guard, clock };
  };

  it("locks an account after 5 failures and escalates lockout duration", () => {
    const { guard, clock } = setup();
    for (let i = 0; i < 4; i++) expect(guard.recordFailure("john", "203.0.113.9").allowed).toBe(true);
    const locked = guard.recordFailure("john", "203.0.113.9");
    expect(locked).toMatchObject({ allowed: false, reason: "account_locked" });
    expect(locked.retryAfterMs).toBe(15 * 60_000);
    expect(guard.check("JOHN", "198.51.100.1").allowed).toBe(false); // any IP, case-insensitive

    clock.t += 15 * 60_000 + 1;
    expect(guard.check("john", "203.0.113.9").allowed).toBe(true);
    for (let i = 0; i < 5; i++) guard.recordFailure("john", "203.0.113.9");
    expect(guard.check("john", "203.0.113.9").retryAfterMs).toBe(30 * 60_000); // doubled
  });

  it("blocks an IP spraying many usernames but never loopback", () => {
    const { guard } = setup();
    for (let i = 0; i < 20; i++) guard.recordFailure(`user${i}`, "203.0.113.50");
    expect(guard.check("someone-new", "203.0.113.50")).toMatchObject({ allowed: false, reason: "ip_blocked" });
    for (let i = 0; i < 25; i++) guard.recordFailure(`u${i}`, "127.0.0.1");
    expect(guard.check("fresh", "127.0.0.1").allowed).toBe(true);
  });

  it("success clears the account counter", () => {
    const { guard } = setup();
    for (let i = 0; i < 4; i++) guard.recordFailure("amy", "10.0.0.2");
    guard.recordSuccess({ userId: "u1", username: "amy", ip: "10.0.0.2", remote: false });
    for (let i = 0; i < 4; i++) expect(guard.recordFailure("amy", "10.0.0.2").allowed).toBe(true);
  });

  it("flags suspicious sign-ins", () => {
    const { guard } = setup();
    const base = { userId: "u1", username: "amy", userAgent: "Edge/Windows" };
    expect(guard.recordSuccess({ ...base, ip: "127.0.0.1", remote: false })).toEqual({ level: "none", signals: [] });
    expect(guard.recordSuccess({ ...base, ip: "127.0.0.1", remote: false }).level).toBe("none");

    for (let i = 0; i < 3; i++) guard.recordFailure("amy", "198.51.100.7");
    const risk = guard.recordSuccess({ ...base, ip: "198.51.100.7", userAgent: "Unknown/Linux", remote: true });
    expect(risk.level).toBe("high");
    expect(risk.signals).toEqual(
      expect.arrayContaining([
        "Sign-in from a new network address",
        "Sign-in from a new device or browser",
        "First sign-in from outside this computer",
        "3 failed attempts before this sign-in",
      ]),
    );
  });
});
