import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { NexusError } from "@nexus/shared";
import type { NexusContext } from "../context";
import type { AppManager, CreateAppInput } from "./apps";
import { extractZip, projectRoot } from "./project-archive";
import { GitHubAccountService } from "./github-account";

interface Source { repository: string; branch: string; enabled: boolean; intervalMinutes: number; revision: string; attempted: string | null; checkedAt: string | null; error: string | null; nextCheck: number; localSource: string }
const setting = (id: string) => `githubSource:${id}`;
const credential = (id: string) => `app:${id}/github/token`;
export interface GitHubImportInput { repository: string; branch: string; token: string; enabled: boolean; intervalMinutes: number }
interface PendingImport extends GitHubImportInput { id: string; ownerId: string; directory: string; sourceDir: string; sha: string; expiresAt: number }
const IMPORT_LIFETIME = 60 * 60_000;

export function githubRepository(input: string): string {
  const text = input.trim().replace(/^https:\/\/github\.com\//i, "").replace(/\/$/, "").replace(/\.git$/, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(text) || text.split("/")[1] === "." || text.split("/")[1] === "..") throw NexusError.invalid("Enter owner/repository or an https://github.com/owner/repository URL.");
  return text;
}

/** Outbound-only GitHub access. Credentials never enter URLs, subprocess arguments or logs. */
export class GitHubSourceService {
  readonly accounts: GitHubAccountService;
  private running = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly imports = new Map<string, PendingImport>();
  constructor(private readonly ctx: NexusContext, private readonly apps: AppManager, private readonly request: typeof fetch = fetch) {
    this.accounts = new GitHubAccountService(ctx, request);
    ctx.onStop(() => {
      this.stopped = true; if (this.timer) clearInterval(this.timer);
      for (const item of this.imports.values()) rmSync(item.directory, { recursive: true, force: true });
      this.imports.clear();
    });
  }

  private validate(input: GitHubImportInput): GitHubImportInput {
    const repository = githubRepository(input.repository), branch = input.branch.trim(), token = input.token.trim();
    if (!branch || branch.length > 200 || /[\x00-\x20\x7f]/.test(branch)) throw NexusError.invalid("Enter a valid branch name.");
    this.validateToken(token);
    if (!Number.isInteger(input.intervalMinutes) || input.intervalMinutes < 1 || input.intervalMinutes > 1440) throw NexusError.invalid("Choose an update check interval from 1 to 1440 minutes.");
    return { ...input, repository, branch, token };
  }
  private validateToken(token: string): void {
    if (!token || token.length > 500 || !/^[A-Za-z0-9_.-]+$/.test(token)) throw NexusError.invalid("Provide a GitHub fine-grained token with Contents: read-only for this repository.");
  }
  async repositories(token: string, page = 1) {
    token = token.trim(); this.validateToken(token);
    if (!Number.isInteger(page) || page < 1 || page > 100) throw NexusError.invalid("Invalid repository page.");
    const response = await this.request(`https://api.github.com/user/repos?sort=updated&per_page=100&page=${page}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "Nexus-Server", "X-GitHub-Api-Version": "2022-11-28" }, redirect: "error", signal: AbortSignal.timeout(30_000),
    }).catch(() => { throw NexusError.invalid("GitHub could not be reached. Check your connection and try again."); });
    if (!response.ok) { await response.body?.cancel(); throw NexusError.invalid(`GitHub returned ${response.status}. Reconnect your GitHub account and check its repository access.`); }
    const rows = await response.json() as { full_name: string; default_branch: string; private: boolean }[];
    if (!Array.isArray(rows) || rows.length > 100) throw NexusError.invalid("GitHub returned an invalid repository list.");
    return { repositories: rows.map((row) => ({ repository: githubRepository(row.full_name), branch: row.default_branch, private: !!row.private })), nextPage: /rel="next"/.test(response.headers.get("link") ?? "") ? page + 1 : null };
  }
  private importRoot(): string {
    if (!this.ctx.dataPaths) throw NexusError.conflict("Finish setting up Nexus before importing a repository.");
    return join(this.ctx.dataPaths.apps, ".github-imports");
  }
  private pruneImports(): void {
    for (const item of this.imports.values()) if (item.expiresAt <= Date.now()) { this.imports.delete(item.id); rmSync(item.directory, { recursive: true, force: true }); }
    const root = this.importRoot();
    if (existsSync(root)) for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[a-f0-9-]{36}$/.test(entry.name) || this.imports.has(entry.name)) continue;
      const directory = join(root, entry.name);
      if (statSync(directory).mtimeMs + IMPORT_LIFETIME < Date.now()) rmSync(directory, { recursive: true, force: true });
    }
  }
  async prepareImport(input: GitHubImportInput, ownerId: string) {
    input = this.validate(input); this.pruneImports();
    if (this.running.has(`import:${ownerId}`)) throw NexusError.conflict("Wait for your current GitHub import to finish.");
    if (this.imports.size + [...this.running].filter((key) => key.startsWith("import:")).length >= 20 || [...this.imports.values()].filter((item) => item.ownerId === ownerId).length >= 3) throw NexusError.conflict("Finish or cancel an existing GitHub import before starting another.");
    this.running.add(`import:${ownerId}`);
    const id = randomUUID(), directory = join(this.importRoot(), id);
    try {
      mkdirSync(directory, { recursive: true });
      const sha = await this.head(input.repository, input.branch, input.token);
      const zip = join(directory, "source.zip"), unpacked = join(directory, "project");
      await this.download(input.repository, sha, input.token, zip);
      mkdirSync(unpacked); await extractZip(zip, unpacked); rmSync(zip);
      const sourceDir = projectRoot(unpacked);
      if (!this.apps.analyze(sourceDir).components.length) throw NexusError.invalid("Nexus couldn't recognise an application in this repository. Choose a repository containing a supported application.");
      if (this.stopped) throw NexusError.conflict("Nexus is shutting down. Import the repository again after it restarts.");
      this.imports.set(id, { ...input, id, directory, sourceDir, ownerId, sha, expiresAt: Date.now() + IMPORT_LIFETIME });
      return { importId: id, sourceDir, repository: input.repository, branch: input.branch };
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      throw error instanceof NexusError ? error : NexusError.invalid("GitHub import failed. Check connectivity and repository access, then try again.");
    } finally { this.running.delete(`import:${ownerId}`); }
  }
  private requireImport(id: string, ownerId: string): PendingImport {
    const item = this.imports.get(id);
    if (!item || item.ownerId !== ownerId) throw NexusError.notFound("GitHub import");
    if (item.expiresAt <= Date.now()) { this.cancelImport(id, ownerId); throw NexusError.invalid("This GitHub import expired. Analyze the repository again."); }
    return item;
  }
  cancelImport(id: string, ownerId: string): void {
    const item = this.imports.get(id);
    if (!item || item.ownerId !== ownerId) throw NexusError.notFound("GitHub import");
    this.imports.delete(id); rmSync(item.directory, { recursive: true, force: true });
  }
  createImported(id: string, actor: { id: string; name: string }, input: Omit<CreateAppInput, "sourceDir">) {
    const item = this.requireImport(id, actor.id);
    const created = this.apps.create({ ...input, sourceDir: item.sourceDir }, actor, (appId) => {
      const target = this.apps.uploadedSourceDir(appId);
      mkdirSync(dirname(target), { recursive: true });
      if (existsSync(target)) throw NexusError.conflict("This app's source folder already exists. Choose a different application name.");
      renameSync(item.sourceDir, target);
      try {
        this.ctx.store.transaction(() => {
          this.apps.adoptImportedSource(appId, target);
          this.ctx.vault.set(credential(appId), item.token, `app:${appId}`);
          this.ctx.settings.set(setting(appId), { repository: item.repository, branch: item.branch, enabled: item.enabled, intervalMinutes: item.intervalMinutes, revision: randomUUID(), attempted: item.sha, checkedAt: new Date().toISOString(), error: null, nextCheck: Date.now() + item.intervalMinutes * 60_000, localSource: target } satisfies Source);
        });
      } catch (error) { renameSync(target, item.sourceDir); throw error; }
    });
    this.imports.delete(id); rmSync(item.directory, { recursive: true, force: true });
    return created;
  }
  status(id: string) {
    this.apps.require(id);
    const source = this.ctx.settings.get<Source | null>(setting(id), null);
    if (!source) return null;
    const { revision: _revision, nextCheck: _next, ...publicState } = source;
    return { ...publicState, tokenConfigured: !!this.ctx.vault.get(credential(id)) };
  }
  async configure(id: string, input: { repository: string; branch: string; enabled: boolean; intervalMinutes: number; token?: string }) {
    this.apps.require(id);
    if (this.running.has(id)) throw NexusError.conflict("Wait for the GitHub update check to finish.");
    const { repository, branch, token } = this.validate({ ...input, token: input.token?.trim() || this.ctx.vault.get(credential(id)) || "" });
    this.running.add(id);
    try {
      await this.head(repository, branch, token);
      const previous = this.ctx.settings.get<Source | null>(setting(id), null);
      this.ctx.vault.set(credential(id), token, `app:${id}`);
      this.ctx.settings.set(setting(id), { repository, branch, enabled: input.enabled, intervalMinutes: input.intervalMinutes, revision: randomUUID(), attempted: previous?.repository === repository && previous.branch === branch ? previous.attempted : null, checkedAt: null, error: null, nextCheck: 0, localSource: previous?.localSource ?? this.apps.require(id).sourceDir } satisfies Source);
      if (input.enabled) this.apps.setAutoDeploy(id, false);
      return this.status(id);
    } finally { this.running.delete(id); }
  }
  disconnect(id: string) {
    this.apps.require(id);
    if (this.running.has(id)) throw NexusError.conflict("Wait for the GitHub update check to finish.");
    const source = this.ctx.settings.get<Source | null>(setting(id), null);
    if (source) this.apps.restoreLocalSource(id, source.localSource);
    this.ctx.settings.delete(setting(id));
    this.ctx.vault.delete(credential(id));
  }
  pause(id: string) {
    if (this.running.has(id)) throw NexusError.conflict("Wait for the GitHub update check to finish.");
    const source = this.ctx.settings.get<Source | null>(setting(id), null);
    if (source) this.ctx.settings.set(setting(id), { ...source, enabled: false });
  }
  private async head(repository: string, branch: string, token: string): Promise<string> {
    const response = await this.request(`https://api.github.com/repos/${repository}/commits/${encodeURIComponent(branch)}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "Nexus-Server", "X-GitHub-Api-Version": "2022-11-28" }, redirect: "error", signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) { await response.body?.cancel(); throw NexusError.invalid(`GitHub returned ${response.status}. Check the repository and branch, or reconnect GitHub and save the connection again.`); }
    const data = await response.json() as { sha?: string };
    if (!data.sha || !/^[a-f0-9]{40,64}$/.test(data.sha)) throw NexusError.invalid("GitHub returned an invalid commit identifier.");
    return data.sha;
  }
  private async download(repository: string, sha: string, token: string, zip: string): Promise<void> {
    const response = await this.request(`https://api.github.com/repos/${repository}/zipball/${sha}`, {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": "Nexus-Server", "X-GitHub-Api-Version": "2022-11-28" }, redirect: "manual", signal: AbortSignal.timeout(30_000),
    });
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (response.status !== 302 || !location) throw NexusError.invalid(`GitHub could not prepare the project archive (${response.status}).`);
    const url = new URL(location);
    if (url.protocol !== "https:" || url.hostname !== "codeload.github.com" || url.port || url.username || url.password) throw NexusError.invalid("GitHub returned an unexpected archive location.");
    // Signed download URL; deliberately do not forward the token to another host.
    const archive = await this.request(url, { redirect: "error", signal: AbortSignal.timeout(300_000) });
    if (!archive.ok || !archive.body) throw NexusError.invalid("The GitHub project archive could not be downloaded.");
    let bytes = 0;
    await pipeline(Readable.fromWeb(archive.body as import("node:stream/web").ReadableStream), new Transform({ transform(chunk: Buffer, _encoding, done) { bytes += chunk.length; done(bytes > 2 * 1024 ** 3 ? new Error("The project archive exceeds 2 GB.") : null, chunk); } }), createWriteStream(zip));
  }
  async check(id: string, manual = false): Promise<{ jobId: string | null; unchanged?: boolean }> {
    const app = this.apps.require(id);
    const source = this.ctx.settings.get<Source | null>(setting(id), null);
    if (!source) throw NexusError.invalid("Connect a GitHub repository first.");
    if (this.running.has(id) || this.apps.delivery(id).updating) return { jobId: null };
    if (!manual && (!source.enabled || app.desiredState !== "running" || Date.now() < source.nextCheck)) return { jobId: null };
    this.running.add(id);
    let temp: string | undefined;
    try {
      const token = this.ctx.vault.require(credential(id));
      const sha = await this.head(source.repository, source.branch, token);
      source.checkedAt = new Date().toISOString();
      source.nextCheck = Date.now() + source.intervalMinutes * 60_000;
      source.error = null;
      if (sha === source.attempted && !manual) { this.ctx.settings.set(setting(id), source); return { jobId: null, unchanged: true }; }
      temp = mkdtempSync(join(tmpdir(), "nexus-github-"));
      const zip = join(temp, "source.zip");
      await this.download(source.repository, sha, token, zip);
      if (this.stopped) return { jobId: null };
      const result = await this.apps.uploadSource(id, zip);
      source.attempted = sha;
      this.ctx.settings.set(setting(id), source);
      this.ctx.audit.record({ actor: { type: "system", id: "github", name: "GitHub updates" }, action: "app.redeploy", target: { type: "app", id }, details: { repository: source.repository, commit: sha } });
      return { jobId: result.jobId };
    } catch (error) {
      // Never include fetch exceptions (which may contain signed URLs) in UI or logs.
      source.error = error instanceof NexusError ? error.message : "The GitHub update check failed. Check connectivity, token access and the deployment log.";
      source.nextCheck = Date.now() + Math.max(15, source.intervalMinutes) * 60_000;
      this.ctx.settings.set(setting(id), source);
      throw NexusError.invalid(source.error);
    } finally { this.running.delete(id); if (temp) rmSync(temp, { recursive: true, force: true }); }
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.ctx.dataPaths) { try { this.pruneImports(); } catch { /* Retry cleanup at the next check. */ } }
      for (const app of this.apps.list()) if (this.ctx.settings.get<Source | null>(setting(app.id), null)?.enabled) void this.check(app.id).catch(() => {});
    }, 30_000);
    this.timer.unref();
  }
}
