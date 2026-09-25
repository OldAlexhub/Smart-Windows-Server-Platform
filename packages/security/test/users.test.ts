import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { StateStore } from "@nexus/state";
import {
  base32Decode,
  base32Encode,
  checkPasswordStrength,
  hashPassword,
  otpauthUri,
  SecretVault,
  totpCode,
  UserManager,
  userMigrations,
  verifyPassword,
  verifyTotp,
} from "@nexus/security";

const STRONG = "correct horse battery staple";

function setup(now = { t: Date.UTC(2027, 0, 1) }) {
  const store = StateStore.memory();
  const vault = SecretVault.withKey(store, randomBytes(32));
  const users = new UserManager(store, vault, { now: () => now.t, sessionTtlMs: 8 * 3600e3, idleTimeoutMs: 3600e3 });
  return { store, vault, users, now };
}

describe("passwords", () => {
  it("hashes with scrypt and verifies", async () => {
    const h = await hashPassword(STRONG);
    expect(h).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await verifyPassword(STRONG, h)).toBe(true);
    expect(await verifyPassword("wrong password here", h)).toBe(false);
    expect(await hashPassword(STRONG)).not.toBe(h); // salted
  });
  it("rejects malformed hashes", async () => {
    expect(await verifyPassword("x", "md5$abc")).toBe(false);
    expect(await verifyPassword("x", null)).toBe(false);
  });
  it("applies a plain-language strength policy", () => {
    expect(checkPasswordStrength("short").acceptable).toBe(false);
    expect(checkPasswordStrength("aaaaaaaaaaaaaaa").acceptable).toBe(false);
    expect(checkPasswordStrength("johnsmith-2027!", ["johnsmith"]).problems).toContain(
      "Don't include your name or username.",
    );
    expect(checkPasswordStrength(STRONG).acceptable).toBe(true);
  });
});

describe("TOTP (RFC 6238)", () => {
  const secret = Buffer.from("12345678901234567890");
  it("matches RFC test vectors (SHA1, 8 digits)", () => {
    expect(totpCode(secret, 59_000, { digits: 8 })).toBe("94287082");
    expect(totpCode(secret, 1111111109_000, { digits: 8 })).toBe("07081804");
    expect(totpCode(secret, 20000000000_000, { digits: 8 })).toBe("65353130");
  });
  it("verifies with drift window", () => {
    const t = 1_700_000_000_000;
    const code = totpCode(secret, t - 30_000);
    expect(verifyTotp(secret, code, t)).not.toBeNull();
    expect(verifyTotp(secret, code, t + 90_000)).toBeNull();
    expect(verifyTotp(secret, "abc", t)).toBeNull();
  });
  it("base32 round-trips", () => {
    const b = randomBytes(20);
    expect(base32Decode(base32Encode(b)).equals(b)).toBe(true);
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
  });
  it("builds otpauth URIs", () => {
    expect(otpauthUri("ABC", "owner", "Nexus")).toBe(
      "otpauth://totp/Nexus%3Aowner?secret=ABC&issuer=Nexus&algorithm=SHA1&digits=6&period=30",
    );
  });
});

describe("UserManager", () => {
  it("migrates legacy sessions without signing application users out", () => {
    const store = StateStore.memory();
    store.migrate([userMigrations[0]!]);
    store.run(
      `INSERT INTO users (id, username, display_name, role, created_at)
       VALUES ('u1', 'legacy', 'Legacy', 'viewer', '2027-01-01T00:00:00.000Z')`,
    );
    for (const [token, remote] of [
      ["local", 0],
      ["remote", 1],
    ] as const) {
      store.run(
        `INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at, remote, method)
         VALUES (?, 'u1', 1, 1, 9999999999999, ?, 'password')`,
        [token, remote],
      );
    }
    store.migrate(userMigrations);
    expect(
      store.all<{ token_hash: string; audience: string }>(
        "SELECT token_hash, audience FROM sessions ORDER BY token_hash",
      ),
    ).toEqual([
      { token_hash: "local", audience: "management" },
      { token_hash: "remote", audience: "application" },
    ]);
  });

  it("creates exactly one owner without a password", () => {
    const { users } = setup();
    const owner = users.ensureOwner();
    expect(owner.role).toBe("owner");
    expect(owner.hasPassword).toBe(false);
    expect(users.ensureOwner().id).toBe(owner.id);
  });

  it("authenticates with password and rejects bad credentials", async () => {
    const { users } = setup();
    await users.createUser({ username: "john", displayName: "John", role: "developer", password: STRONG });
    expect((await users.verifyCredentials("john", STRONG)).status).toBe("ok");
    expect((await users.verifyCredentials("JOHN", STRONG)).status).toBe("ok"); // case-insensitive username
    expect((await users.verifyCredentials("john", "nope nope nope")).status).toBe("invalid");
    expect((await users.verifyCredentials("ghost", STRONG)).status).toBe("invalid");
  });

  it("rejects weak passwords, duplicate usernames and a second owner", async () => {
    const { users } = setup();
    users.ensureOwner();
    await expect(
      users.createUser({ username: "a1b", displayName: "A", role: "viewer", password: "123" }),
    ).rejects.toThrow(/12 characters/);
    await users.createUser({ username: "amy", displayName: "Amy", role: "viewer" });
    await expect(users.createUser({ username: "AMY", displayName: "Amy2", role: "viewer" })).rejects.toThrow(/taken/);
    await expect(users.createUser({ username: "boss", displayName: "B", role: "owner" })).rejects.toThrow(
      /already an Owner/,
    );
  });

  it("disabled users cannot log in and lose their sessions", async () => {
    const { users } = setup();
    const u = await users.createUser({ username: "oper", displayName: "Op", role: "operator", password: STRONG });
    const { token } = users.createSession(u.id, { method: "password" });
    users.setDisabled(u.id, true);
    expect(users.validateSession(token)).toBeNull();
    expect((await users.verifyCredentials("oper", STRONG)).status).toBe("invalid");
  });

  it("sessions expire on idle timeout and absolute lifetime; tokens are stored hashed", async () => {
    const { users, store, now } = setup();
    const u = await users.createUser({ username: "dev", displayName: "Dev", role: "developer", password: STRONG });
    const s = users.createSession(u.id, { method: "password", ip: "10.0.0.5" });
    expect(store.get<{ token_hash: string }>("SELECT token_hash FROM sessions")!.token_hash).not.toBe(s.token);
    expect(users.validateSession(s.token)?.session.audience).toBe("management");
    now.t += 30 * 60e3;
    expect(users.validateSession(s.token)?.user.id).toBe(u.id);
    now.t += 61 * 60e3; // idle > 1h
    expect(users.validateSession(s.token)).toBeNull();

    const s2 = users.createSession(u.id, { method: "password" });
    for (let i = 0; i < 9; i++) {
      now.t += 55 * 60e3; // stay active but exceed 8h absolute
      users.validateSession(s2.token);
    }
    expect(users.validateSession(s2.token)).toBeNull();
  });

  it("password change revokes all sessions", async () => {
    const { users } = setup();
    const u = await users.createUser({ username: "x_user", displayName: "X", role: "viewer", password: STRONG });
    const { token } = users.createSession(u.id, { method: "password" });
    await users.setPassword(u.id, "another strong passphrase");
    expect(users.validateSession(token)).toBeNull();
  });

  it("revokes remote management sessions without signing users out of applications", async () => {
    const { users } = setup();
    const u = await users.createUser({
      username: "remote_user",
      displayName: "Remote",
      role: "viewer",
      password: STRONG,
    });
    const management = users.createSession(u.id, { method: "mfa", remote: true, audience: "management" });
    const application = users.createSession(u.id, { method: "password", remote: true, audience: "application" });
    const local = users.createSession(u.id, { method: "local_trust", remote: false, audience: "management" });

    expect(users.revokeRemoteManagementSessions()).toBe(1);
    expect(users.validateSession(management.token)).toBeNull();
    expect(users.validateSession(application.token)?.session.audience).toBe("application");
    expect(users.validateSession(local.token)?.session.audience).toBe("management");
  });

  it("enforces TOTP MFA with replay protection and recovery codes", async () => {
    const { users, vault, now } = setup();
    const u = await users.createUser({ username: "mfa", displayName: "M", role: "administrator", password: STRONG });
    const { secret, otpauthUri: uri } = users.beginMfaEnrollment(u.id, "Nexus");
    expect(uri).toContain("otpauth://totp/");
    expect(() => users.confirmMfaEnrollment(u.id, "000000")).toThrow(/didn't match/);
    const recovery = users.confirmMfaEnrollment(u.id, totpCode(base32Decode(secret), now.t));
    expect(recovery).toHaveLength(10);
    expect(vault.has(`user:${u.id}/totp`)).toBe(true);

    const first = await users.verifyCredentials("mfa", STRONG);
    expect(first).toEqual({ status: "mfa_required", userId: u.id });

    now.t += 30_000;
    const code = totpCode(base32Decode(secret), now.t);
    expect(users.completeMfa(u.id, code).status).toBe("ok");
    expect(users.completeMfa(u.id, code).status).toBe("invalid"); // replay rejected

    expect(users.completeMfa(u.id, recovery[0]!).status).toBe("ok");
    expect(users.completeMfa(u.id, recovery[0]!).status).toBe("invalid"); // one-time
  });

  it("stores per-application roles", async () => {
    const { users } = setup();
    const u = await users.createUser({ username: "john2", displayName: "John", role: "viewer" });
    users.setAppRole(u.id, "taxiops", "administrator");
    users.setAppRole(u.id, "finance", "viewer");
    expect(users.require(u.id).appRoles).toEqual({ taxiops: "administrator", finance: "viewer" });
    users.setAppRole(u.id, "finance", null);
    expect(users.require(u.id).appRoles).toEqual({ taxiops: "administrator" });
  });

  it("protects the owner account", () => {
    const { users } = setup();
    const owner = users.ensureOwner();
    expect(() => users.deleteUser(owner.id)).toThrow();
    expect(() => users.setDisabled(owner.id, true)).toThrow();
    expect(() => users.setRole(owner.id, "viewer")).toThrow();
  });
});
