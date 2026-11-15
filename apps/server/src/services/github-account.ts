import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { NexusError } from "@nexus/shared";
import type { NexusContext } from "../context";

const credential = (userId: string) => `user:${userId}/github/account`;
const LIFETIME = 15 * 60_000;
const FAILURE = "GitHub sign-in did not complete. Try again and approve the code in your browser.";
interface Account { token: string; login: string }
interface Code { userCode: string; verificationUri: string }
export interface GitHubLogin { result: Promise<string>; cancel(): void }
export type GitHubLoginFactory = (onCode: (code: Code) => void) => GitHubLogin;
interface Pending { id: string; expiresAt: number; code: Code | null; error: string | null; login?: GitHubLogin; timer?: NodeJS.Timeout }

/** Use the official bundled OAuth client; never borrow the host user's gh login or launch a browser on the server. */
export function startGitHubCliLogin(ctx: NexusContext, onCode: (code: Code) => void): GitHubLogin {
  const component = ctx.component("github-cli");
  const exe = component && join(component, "bin", "gh.exe");
  if (!exe || !existsSync(exe)) throw NexusError.invalid("GitHub sign-in is missing from this installation. Install the latest Nexus update.");
  const root = join(ctx.opts.paths.root, "github-auth");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(root, "login-"));
  try {
    // gh briefly writes its OAuth result here. Restrict access before it starts, including in development.
    if (process.platform === "win32") {
      const sid = execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true, timeout: 10_000 }).match(/S-1-[0-9-]+/)?.[0];
      if (!sid) throw new Error("Cannot identify service account");
      execFileSync("icacls.exe", [directory, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "/Q"], { stdio: "pipe", windowsHide: true, timeout: 10_000 });
    }
  } catch {
    rmSync(directory, { recursive: true, force: true });
    throw NexusError.invalid("Nexus could not prepare secure GitHub sign-in storage.");
  }
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(GH_|GITHUB_)/i.test(key)) delete env[key];
  Object.assign(env, { GH_CONFIG_DIR: directory, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_NO_EXTENSION_UPDATE_NOTIFIER: "1", GH_TELEMETRY: "0", NO_COLOR: "1" });
  const child = spawn(exe, ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--insecure-storage", "--expiring=false", "--clipboard=false", "--skip-ssh-key"], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let canceled = false, output = "", sentCode = false;
  const capture = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-16_384);
    const code = output.match(/one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i)?.[1];
    if (code && !sentCode && !canceled) { sentCode = true; onCode({ userCode: code, verificationUri: "https://github.com/login/device" }); }
  };
  child.stdout.on("data", capture); child.stderr.on("data", capture);
  const result = new Promise<string>((resolve, reject) => {
    child.once("error", () => reject(new Error(FAILURE)));
    child.once("close", async (code) => {
      if (canceled || code !== 0) { reject(new Error(FAILURE)); return; }
      try {
        const { stdout } = await promisify(execFile)(exe, ["auth", "token", "--hostname", "github.com"], { env, encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 4096 });
        const token = stdout.trim();
        if (canceled || !/^[A-Za-z0-9_.-]{1,500}$/.test(token)) throw new Error(FAILURE);
        resolve(token);
      } catch { reject(new Error(FAILURE)); }
    });
  }).finally(() => { output = ""; rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
  return { result, cancel: () => { canceled = true; child.kill(); } };
}

/** Credentials belong to the signed-in Nexus user; HTTP responses contain only account and one-time-code state. */
export class GitHubAccountService {
  private pending = new Map<string, Pending>();
  private stopped = false;
  constructor(private readonly ctx: NexusContext, private readonly request: typeof fetch = fetch, private readonly begin: GitHubLoginFactory = (code) => startGitHubCliLogin(ctx, code)) {
    ctx.onStop(() => { this.stopped = true; for (const user of this.pending.keys()) this.cancel(user); });
  }
  status(userId: string) {
    const account = this.account(userId), pending = this.pending.get(userId);
    return { connected: !!account, login: account?.login ?? null, pending: pending ? { id: pending.id, expiresAt: pending.expiresAt, ...pending.code, status: pending.error ? "failed" : pending.code ? "waiting" : "starting", error: pending.error } : null };
  }
  private account(userId: string): Account | null {
    const value = this.ctx.vault.get(credential(userId));
    return value ? JSON.parse(value) as Account : null;
  }
  token(userId: string): string {
    const account = this.account(userId);
    if (!account) throw NexusError.invalid("Connect your GitHub account before choosing a repository.");
    return account.token;
  }
  start(userId: string) {
    if (this.stopped) throw NexusError.conflict("Nexus is shutting down.");
    const existing = this.pending.get(userId);
    if (existing && !existing.error) return this.status(userId);
    // Discard terminal attempts before enforcing the concurrent-login bound.
    for (const [user, attempt] of this.pending) if (attempt.error) this.cancel(user);
    if (this.pending.size >= 10) throw NexusError.conflict("Too many GitHub sign-ins are in progress. Try again shortly.");
    const pending: Pending = { id: randomUUID(), expiresAt: Date.now() + LIFETIME, code: null, error: null };
    this.pending.set(userId, pending);
    void this.complete(userId, pending);
    return this.status(userId);
  }
  private async complete(userId: string, pending: Pending) {
    const current = () => !this.stopped && this.pending.get(userId) === pending && !pending.error;
    try {
      pending.login = this.begin((code) => { if (current()) pending.code = code; });
      pending.timer = setTimeout(() => { if (current()) { pending.error = "GitHub sign-in expired. Connect again to get a new code."; pending.code = null; pending.login?.cancel(); } }, LIFETIME);
      pending.timer.unref();
      const token = await pending.login.result;
      if (!current()) return;
      const response = await this.request("https://api.github.com/user", { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "Nexus-Server", "X-GitHub-Api-Version": "2022-11-28" }, redirect: "error", signal: AbortSignal.timeout(30_000) });
      if (!response.ok) { await response.body?.cancel(); throw new Error(FAILURE); }
      const profile = await response.json() as { login?: string };
      if (!profile.login || !/^[A-Za-z0-9-]{1,39}$/.test(profile.login)) throw new Error(FAILURE);
      if (!current()) return;
      this.ctx.vault.set(credential(userId), JSON.stringify({ token, login: profile.login } satisfies Account), `user:${userId}`);
      this.pending.delete(userId);
    } catch {
      if (current()) { pending.error = FAILURE; pending.code = null; }
    } finally { if (pending.timer) clearTimeout(pending.timer); }
  }
  cancel(userId: string) {
    const pending = this.pending.get(userId);
    this.pending.delete(userId);
    if (pending?.timer) clearTimeout(pending.timer);
    pending?.login?.cancel();
  }
  disconnect(userId: string) { this.cancel(userId); this.ctx.vault.delete(credential(userId)); }
}
