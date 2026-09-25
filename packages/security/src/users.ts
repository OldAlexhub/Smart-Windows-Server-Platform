import { createHash, randomBytes } from "node:crypto";
import { newId, NexusError } from "@nexus/shared";
import type { Migration, StateStore } from "@nexus/state";
import { checkPasswordStrength, hashPassword, verifyPassword } from "./passwords";
import { isAppRole, isRole, type AppRole, type Role } from "./roles";
import type { SecretVault } from "./secrets";
import { base32Decode, generateTotpSecret, otpauthUri, verifyTotp } from "./totp";

export const userMigrations: Migration[] = [
  {
    id: "security/002_users",
    up: `CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL,
      email TEXT,
      role TEXT NOT NULL,
      password_hash TEXT,
      mfa_enabled INTEGER NOT NULL DEFAULT 0,
      mfa_last_step INTEGER,
      recovery_codes TEXT,
      disabled INTEGER NOT NULL DEFAULT 0,
      server_settings_access INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      last_login_at TEXT
    );
    CREATE TABLE user_app_roles (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      app_id TEXT NOT NULL,
      role TEXT NOT NULL,
      PRIMARY KEY (user_id, app_id)
    );
    CREATE TABLE sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      ip TEXT,
      user_agent TEXT,
      remote INTEGER NOT NULL DEFAULT 0,
      method TEXT NOT NULL
    );
    CREATE INDEX sessions_user ON sessions(user_id);`,
  },
  {
    id: "security/003_session_audience",
    // Preserve signed-in application users during upgrade. Existing remote control-center
    // sessions deliberately fall into the application audience and must complete MFA again.
    up: `ALTER TABLE sessions ADD COLUMN audience TEXT NOT NULL DEFAULT 'application';
    UPDATE sessions SET audience = 'management' WHERE remote = 0;
    CREATE INDEX sessions_remote_audience ON sessions(remote, audience);`,
  },
];

export interface User {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  role: Role;
  hasPassword: boolean;
  mfaEnabled: boolean;
  disabled: boolean;
  serverSettingsAccess: boolean;
  appRoles: Record<string, AppRole>;
  createdAt: string;
  lastLoginAt: string | null;
}

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  email: string | null;
  role: string;
  password_hash: string | null;
  mfa_enabled: number;
  mfa_last_step: number | null;
  recovery_codes: string | null;
  disabled: number;
  server_settings_access: number;
  created_at: string;
  last_login_at: string | null;
}

export interface Session {
  userId: string;
  createdAt: number;
  expiresAt: number;
  remote: boolean;
  method: "password" | "mfa" | "local_trust" | "recovery";
  audience: "management" | "application";
}

export type LoginResult =
  { status: "ok"; user: User } | { status: "mfa_required"; userId: string } | { status: "invalid" };

export interface UserManagerOptions {
  /** Absolute session lifetime. */
  sessionTtlMs?: number;
  /** Sessions idle longer than this expire. */
  idleTimeoutMs?: number;
  now?: () => number;
}

const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
const mfaSecretName = (userId: string) => `user:${userId}/totp`;

export class UserManager {
  private readonly sessionTtlMs: number;
  private readonly idleTimeoutMs: number;
  private readonly now: () => number;

  constructor(
    private readonly store: StateStore,
    private readonly vault: SecretVault,
    options: UserManagerOptions = {},
  ) {
    store.migrate(userMigrations);
    this.sessionTtlMs = options.sessionTtlMs ?? 12 * 60 * 60 * 1000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 60 * 60 * 1000;
    this.now = options.now ?? Date.now;
  }

  // ---------------- users ----------------

  /** Ensures the machine owner account exists. It has no password until remote access is enabled. */
  ensureOwner(displayName = "Owner"): User {
    const existing = this.store.get<UserRow>("SELECT * FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1");
    if (existing) return this.toUser(existing);
    return this.createUserSync({ username: "owner", displayName, role: "owner", passwordHash: null });
  }

  async createUser(input: {
    username: string;
    displayName: string;
    role: Role;
    email?: string;
    password?: string;
  }): Promise<User> {
    if (!/^[a-zA-Z0-9._-]{3,64}$/.test(input.username)) {
      throw NexusError.invalid("Usernames use 3–64 letters, numbers, dots, dashes or underscores.");
    }
    if (!isRole(input.role)) throw NexusError.invalid("Unknown role.");
    if (input.role === "owner" && this.store.get("SELECT 1 FROM users WHERE role='owner'")) {
      throw NexusError.conflict("There is already an Owner. Transfer ownership instead.");
    }
    if (this.store.get("SELECT 1 FROM users WHERE username = ?", [input.username])) {
      throw NexusError.conflict(`The username "${input.username}" is already taken.`);
    }
    let passwordHash: string | null = null;
    if (input.password !== undefined) {
      this.assertStrong(input.password, [input.username, input.displayName]);
      passwordHash = await hashPassword(input.password);
    }
    return this.createUserSync({ ...input, passwordHash });
  }

  private createUserSync(input: {
    username: string;
    displayName: string;
    role: Role;
    email?: string;
    passwordHash: string | null;
  }): User {
    const id = newId();
    this.store.run(
      `INSERT INTO users (id, username, display_name, email, role, password_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, input.username, input.displayName, input.email ?? null, input.role, input.passwordHash, this.iso()],
    );
    return this.require(id);
  }

  get(id: string): User | undefined {
    const row = this.store.get<UserRow>("SELECT * FROM users WHERE id = ?", [id]);
    return row ? this.toUser(row) : undefined;
  }

  require(id: string): User {
    const u = this.get(id);
    if (!u) throw NexusError.notFound("User");
    return u;
  }

  findByUsername(username: string): User | undefined {
    const row = this.store.get<UserRow>("SELECT * FROM users WHERE username = ?", [username]);
    return row ? this.toUser(row) : undefined;
  }

  list(): User[] {
    return this.store.all<UserRow>("SELECT * FROM users ORDER BY created_at").map((r) => this.toUser(r));
  }

  setRole(userId: string, role: Role): User {
    if (!isRole(role)) throw NexusError.invalid("Unknown role.");
    const user = this.require(userId);
    if (user.role === "owner" && role !== "owner")
      throw NexusError.conflict("Transfer ownership before changing the Owner's role.");
    if (role === "owner") throw NexusError.conflict("Use ownership transfer to make someone the Owner.");
    this.store.run("UPDATE users SET role = ? WHERE id = ?", [role, userId]);
    return this.require(userId);
  }

  setAppRole(userId: string, appId: string, role: AppRole | null): User {
    this.require(userId);
    if (role === null) {
      this.store.run("DELETE FROM user_app_roles WHERE user_id = ? AND app_id = ?", [userId, appId]);
    } else {
      if (!isAppRole(role)) throw NexusError.invalid("Unknown application role.");
      this.store.run(
        `INSERT INTO user_app_roles (user_id, app_id, role) VALUES (?, ?, ?)
         ON CONFLICT(user_id, app_id) DO UPDATE SET role = excluded.role`,
        [userId, appId, role],
      );
    }
    return this.require(userId);
  }

  setServerSettingsAccess(userId: string, allowed: boolean): void {
    this.store.run("UPDATE users SET server_settings_access = ? WHERE id = ?", [allowed ? 1 : 0, userId]);
  }

  setDisabled(userId: string, disabled: boolean): void {
    const user = this.require(userId);
    if (user.role === "owner" && disabled) throw NexusError.conflict("The Owner account cannot be disabled.");
    this.store.run("UPDATE users SET disabled = ? WHERE id = ?", [disabled ? 1 : 0, userId]);
    if (disabled) this.revokeAllSessions(userId);
  }

  async setPassword(userId: string, password: string): Promise<void> {
    const user = this.require(userId);
    this.assertStrong(password, [user.username, user.displayName]);
    this.store.run("UPDATE users SET password_hash = ? WHERE id = ?", [await hashPassword(password), userId]);
    this.revokeAllSessions(userId);
  }

  deleteUser(userId: string): void {
    const user = this.require(userId);
    if (user.role === "owner") throw NexusError.conflict("The Owner account cannot be deleted.");
    this.vault.delete(mfaSecretName(userId));
    this.store.run("DELETE FROM users WHERE id = ?", [userId]);
  }

  // ---------------- authentication ----------------

  /**
   * Password step of login. Callers must apply the LoginGuard (rate limiting / lockout) around this.
   * When MFA is enabled the caller must follow up with `completeMfa`.
   */
  async verifyCredentials(username: string, password: string): Promise<LoginResult> {
    const row = this.store.get<UserRow>("SELECT * FROM users WHERE username = ?", [username]);
    // Always run a hash comparison to keep timing similar for unknown users.
    const valid = await verifyPassword(password, row?.password_hash ?? DUMMY_HASH);
    if (!row || !row.password_hash || !valid || row.disabled) return { status: "invalid" };
    if (row.mfa_enabled) return { status: "mfa_required", userId: row.id };
    this.touchLogin(row.id);
    return { status: "ok", user: this.toUser(row) };
  }

  /** Second factor: TOTP code or one-time recovery code. */
  completeMfa(userId: string, code: string): LoginResult {
    const row = this.store.get<UserRow>("SELECT * FROM users WHERE id = ?", [userId]);
    if (!row || row.disabled || !row.mfa_enabled) return { status: "invalid" };
    const secret = this.vault.get(mfaSecretName(userId));
    if (secret) {
      const step = verifyTotp(base32Decode(secret), code, this.now());
      if (step !== null && (row.mfa_last_step === null || step > row.mfa_last_step)) {
        this.store.run("UPDATE users SET mfa_last_step = ? WHERE id = ?", [step, userId]);
        this.touchLogin(userId);
        return { status: "ok", user: this.toUser(row) };
      }
    }
    if (this.consumeRecoveryCode(row, code)) {
      this.touchLogin(userId);
      return { status: "ok", user: this.require(userId) };
    }
    return { status: "invalid" };
  }

  // ---------------- MFA enrollment ----------------

  beginMfaEnrollment(userId: string, issuer: string): { secret: string; otpauthUri: string } {
    const user = this.require(userId);
    const secret = generateTotpSecret();
    this.vault.set(`${mfaSecretName(userId)}.pending`, secret, `user:${userId}`);
    return { secret, otpauthUri: otpauthUri(secret, user.username, issuer) };
  }

  /** Confirms enrollment with a code from the app. Returns one-time recovery codes (shown once). */
  confirmMfaEnrollment(userId: string, code: string): string[] {
    const pending = this.vault.get(`${mfaSecretName(userId)}.pending`);
    if (!pending) throw NexusError.invalid("Start MFA setup first.");
    if (verifyTotp(base32Decode(pending), code, this.now()) === null) {
      throw NexusError.invalid("That code didn't match. Check the time on your phone and try again.");
    }
    this.vault.set(mfaSecretName(userId), pending, `user:${userId}`);
    this.vault.delete(`${mfaSecretName(userId)}.pending`);
    const codes = Array.from({ length: 10 }, () =>
      randomBytes(5)
        .toString("hex")
        .toUpperCase()
        .replace(/(.{5})/, "$1-"),
    );
    const hashed = codes.map((c) => hashToken(c.replace("-", "")));
    this.store.run("UPDATE users SET mfa_enabled = 1, mfa_last_step = NULL, recovery_codes = ? WHERE id = ?", [
      JSON.stringify(hashed),
      userId,
    ]);
    return codes;
  }

  disableMfa(userId: string): void {
    this.vault.delete(mfaSecretName(userId));
    this.store.run("UPDATE users SET mfa_enabled = 0, recovery_codes = NULL WHERE id = ?", [userId]);
  }

  private consumeRecoveryCode(row: UserRow, code: string): boolean {
    const hashes: string[] = row.recovery_codes ? JSON.parse(row.recovery_codes) : [];
    const h = hashToken(code.replace(/[\s-]/g, "").toUpperCase());
    const idx = hashes.indexOf(h);
    if (idx < 0) return false;
    hashes.splice(idx, 1);
    this.store.run("UPDATE users SET recovery_codes = ? WHERE id = ?", [JSON.stringify(hashes), row.id]);
    return true;
  }

  // ---------------- sessions ----------------

  createSession(
    userId: string,
    meta: {
      ip?: string;
      userAgent?: string;
      remote?: boolean;
      method: Session["method"];
      audience?: Session["audience"];
    },
  ): { token: string; expiresAt: number } {
    const user = this.require(userId);
    if (user.disabled) throw NexusError.forbidden("This account is disabled.");
    const token = randomBytes(32).toString("base64url");
    const now = this.now();
    const expiresAt = now + this.sessionTtlMs;
    this.store.run(
      `INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at, ip, user_agent, remote, method, audience)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        hashToken(token),
        userId,
        now,
        now,
        expiresAt,
        meta.ip ?? null,
        meta.userAgent ?? null,
        meta.remote ? 1 : 0,
        meta.method,
        meta.audience ?? "management",
      ],
    );
    return { token, expiresAt };
  }

  /** Returns the session's user if the token is valid; slides the idle timeout. */
  validateSession(token: string): { user: User; session: Session } | null {
    if (!token) return null;
    const h = hashToken(token);
    const row = this.store.get<{
      user_id: string;
      created_at: number;
      last_seen_at: number;
      expires_at: number;
      remote: number;
      method: Session["method"];
      audience: Session["audience"];
    }>("SELECT * FROM sessions WHERE token_hash = ?", [h]);
    if (!row) return null;
    const now = this.now();
    if (now >= row.expires_at || now - row.last_seen_at > this.idleTimeoutMs) {
      this.store.run("DELETE FROM sessions WHERE token_hash = ?", [h]);
      return null;
    }
    const user = this.get(row.user_id);
    if (!user || user.disabled) return null;
    this.store.run("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?", [now, h]);
    return {
      user,
      session: {
        userId: row.user_id,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        remote: !!row.remote,
        method: row.method,
        audience: row.audience,
      },
    };
  }

  revokeSession(token: string): void {
    this.store.run("DELETE FROM sessions WHERE token_hash = ?", [hashToken(token)]);
  }

  revokeAllSessions(userId: string): void {
    this.store.run("DELETE FROM sessions WHERE user_id = ?", [userId]);
  }

  /** Revokes remote control-center sessions without signing people out of published applications. */
  revokeRemoteManagementSessions(): number {
    return this.store.run("DELETE FROM sessions WHERE remote = 1 AND audience = 'management'").changes;
  }

  purgeExpiredSessions(): number {
    return this.store.run("DELETE FROM sessions WHERE expires_at <= ?", [this.now()]).changes;
  }

  // ---------------- helpers ----------------

  private assertStrong(password: string, context: string[]): void {
    const check = checkPasswordStrength(password, context);
    if (!check.acceptable) throw NexusError.invalid(check.problems.join(" "));
  }

  private touchLogin(userId: string): void {
    this.store.run("UPDATE users SET last_login_at = ? WHERE id = ?", [this.iso(), userId]);
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  private toUser(row: UserRow): User {
    const appRoles: Record<string, AppRole> = {};
    for (const r of this.store.all<{ app_id: string; role: AppRole }>(
      "SELECT app_id, role FROM user_app_roles WHERE user_id = ?",
      [row.id],
    )) {
      appRoles[r.app_id] = r.role;
    }
    return {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      email: row.email,
      role: row.role as Role,
      hasPassword: !!row.password_hash,
      mfaEnabled: !!row.mfa_enabled,
      disabled: !!row.disabled,
      serverSettingsAccess: !!row.server_settings_access,
      appRoles,
      createdAt: row.created_at,
      lastLoginAt: row.last_login_at,
    };
  }
}

// A valid-format hash of a random password, used to equalise timing for unknown usernames.
const DUMMY_HASH = "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
