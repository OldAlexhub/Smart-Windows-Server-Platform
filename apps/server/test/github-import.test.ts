import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { NexusContext } from "../src/context";
import { authRoutes } from "../src/http/routes/auth";
import { appRoutes } from "../src/http/routes/apps";
import { buildServer } from "../src/http/server";
import { AppManager } from "../src/services/apps";
import { GatewayService } from "../src/services/gateway";
import { createContext, tempHome } from "./helpers";
import { ownerClient } from "./helpers-http";

describe("GitHub import through the application API", () => {
  let ctx: NexusContext, apps: AppManager, server: FastifyInstance, call: Awaited<ReturnType<typeof ownerClient>>, dispose: () => void, home: string;
  let sha = "a".repeat(40), archive: Buffer, failAccess = false;
  let request: { mockRestore(): void };
  let imported: { importId: string; sourceDir: string }, appId: string;
  const token = "test-private-repository-token";
  const input = { repository: "my-team/products", branch: "release/main", enabled: true, intervalMinutes: 1 };
  function code(text: string) {
    const dir = join(home, "fixture", "products-commit"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.html"), text);
    const zip = join(home, "fixture.zip");
    execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), ["-a", "-c", "-f", zip, "-C", join(home, "fixture"), "products-commit"]);
    archive = readFileSync(zip);
  }
  beforeAll(async () => {
    const temp = tempHome(); home = temp.home; dispose = temp.dispose;
    ctx = await createContext(home, { setup: true });
    const owner = ctx.users.ensureOwner();
    ctx.vault.set(`user:${owner.id}/github/account`, JSON.stringify({ token, login: "octocat" }), `user:${owner.id}`);
    const nativeFetch = globalThis.fetch;
    request = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
      const address = String(url);
      if (!address.startsWith("https://api.github.com/") && !address.startsWith("https://codeload.github.com/")) return nativeFetch(url, options);
      if (address.startsWith("https://api.github.com/")) {
        expect(new Headers(options?.headers).get("Authorization")).toBe(`Bearer ${token}`);
        if (failAccess) return new Response(null, { status: 401 });
        if (address.includes("/user/repos?")) return Response.json([{ full_name: "my-team/products", default_branch: "release/main", private: true }]);
        if (address.includes("/commits/")) return Response.json({ sha });
        return new Response(null, { status: 302, headers: { location: `https://codeload.github.com/my-team/products/zip/${sha}?token=signed` } });
      }
      expect(new Headers(options?.headers).has("Authorization")).toBe(false);
      return new Response(new Uint8Array(archive));
    });
    ctx.settings.set("gateway", { httpPort: await ctx.ports.allocate("test", "http"), httpsPort: await ctx.ports.allocate("test", "https"), localPort: await ctx.ports.allocate("test", "local"), insecureHttp: true, manageFirewall: false });
    apps = new AppManager(ctx, new GatewayService(ctx));
    server = await buildServer(ctx, [authRoutes, appRoutes(apps)]); call = await ownerClient(server, ctx);
    code("version one");
  }, 180_000);
  afterAll(async () => { await server?.close(); await ctx?.shutdown(); request?.mockRestore(); dispose?.(); }, 60_000);

  it("requires sign-in and lists accessible private repositories with their default branches", async () => {
    const denied = await server.inject({ method: "POST", url: "/api/v1/github/repositories", headers: { "x-nexus-request": "1" }, payload: { token } });
    expect(denied.statusCode).toBe(401);
    const result = await call("POST", "/api/v1/github/repositories", {});
    expect(result.body).toEqual({ repositories: [{ repository: "my-team/products", branch: "release/main", private: true }], nextPage: null });
    expect((await call("GET", "/api/v1/github/account")).body).toEqual({ connected: true, login: "octocat", pending: null });
    for (const url of ["/api/v1/github/account", "/api/v1/github/account/login"]) {
      const response = await server.inject({ method: "DELETE", url, headers: { "x-nexus-request": "1" } });
      expect(response.statusCode).toBe(401);
    }
  });
  it("reads a repository for analysis without starting an app or returning its token", async () => {
    const result = await call("POST", "/api/v1/github/imports", input);
    expect(result.status).toBe(200);
    expect(result.body.analysis.analysis.components.length).toBeGreaterThan(0);
    expect(JSON.stringify(result.body)).not.toContain(token);
    imported = result.body;
    expect(readFileSync(join(imported.sourceDir, "index.html"), "utf8")).toBe("version one");
    expect(apps.list()).toHaveLength(0);
    expect(() => apps.github.createImported(imported.importId, { id: "another-user", name: "Another" }, { name: "Stolen", access: "private", data: { mode: "none" } })).toThrow(/not found/);
  });
  it("creates directly from GitHub, saves read access, and keeps its source inside the app backup boundary", async () => {
    const result = await call("POST", "/api/v1/apps", { githubImportId: imported.importId, name: "GitHub Products", access: "private", data: { mode: "none" } });
    expect(result.status).toBe(200); appId = result.body.appId;
    expect((await ctx.jobs.wait(result.body.jobId)).status).toBe("succeeded");
    expect(apps.require(appId).sourceDir).toBe(apps.uploadedSourceDir(appId));
    expect(existsSync(imported.sourceDir)).toBe(false);
    expect(apps.github.status(appId)).toMatchObject({ repository: input.repository, branch: input.branch, enabled: true, attempted: sha });
    expect(ctx.vault.get(`app:${appId}/github/token`)).toBe(token);
    expect(JSON.stringify(ctx.settings.get(`githubSource:${appId}`, null))).not.toContain(token);
    expect((await call("POST", "/api/v1/apps", { githubImportId: imported.importId, name: "Replay", access: "private", data: { mode: "none" } })).status).toBe(404);
  });
  it("automatically deploys a newer commit through the scheduled check path and skips an unchanged commit", async () => {
    sha = "b".repeat(40); code("version two");
    ctx.settings.set(`githubSource:${appId}`, { ...ctx.settings.get<object>(`githubSource:${appId}`, {}), nextCheck: 0 });
    const next = await apps.github.check(appId);
    expect(next.jobId).toBeTruthy(); expect((await ctx.jobs.wait(next.jobId!)).status).toBe("succeeded");
    expect(readFileSync(join(ctx.deployments!.current(appId)!.releaseDir, "index.html"), "utf8")).toBe("version two");
    ctx.settings.set(`githubSource:${appId}`, { ...ctx.settings.get<object>(`githubSource:${appId}`, {}), nextCheck: 0 });
    expect(await apps.github.check(appId)).toMatchObject({ jobId: null, unchanged: true });
  });
  it("previews an uploaded .env, saves atomically, encrypts secrets and skips Nexus settings", async () => {
    const content = 'API_KEY="upload-secret"\nLABEL="two words"\nEMPTY=\nPORT=9999\nNEXUS_API_TOKEN=blocked';
    const endpoint = `/api/v1/apps/${appId}/env-file/upload`;
    const preview = await call("POST", endpoint, { content });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ settings: [{ name: "API_KEY", alreadySet: false }, { name: "LABEL", alreadySet: false }, { name: "EMPTY", alreadySet: false }], skipped: ["PORT", "NEXUS_API_TOKEN"], imported: [], restartNeeded: false });
    expect(JSON.stringify(preview.body)).not.toContain("upload-secret");
    expect(ctx.vault.get(`app:${appId}/env/API_KEY`)).toBeUndefined();
    const saved = await call("POST", endpoint, { content, preview: false });
    expect(saved.body).toMatchObject({ imported: ["API_KEY", "LABEL", "EMPTY"], restartNeeded: true });
    expect(ctx.vault.get(`app:${appId}/env/API_KEY`)).toBe("upload-secret");
    expect(apps.require(appId).env).toMatchObject({ LABEL: "two words", EMPTY: "" });
    expect(apps.require(appId).env).not.toHaveProperty("PORT");
    expect((await call("POST", endpoint, { content })).body.settings[0].alreadySet).toBe(true);
    expect((await call("POST", endpoint, { content: 'LABEL=changed\nINVALID LINE', preview: false })).status).toBe(400);
    expect(apps.require(appId).env.LABEL).toBe("two words");
    const denied = await server.inject({ method: "POST", url: endpoint, headers: { "x-nexus-request": "1" }, payload: { content, preview: false } });
    expect(denied.statusCode).toBe(401);
  });
  it("leaves the active version in place when GitHub access fails", async () => {
    failAccess = true;
    const before = ctx.deployments!.current(appId)!.id;
    await expect(apps.github.check(appId, true)).rejects.toThrow("401");
    expect(ctx.deployments!.current(appId)!.id).toBe(before);
    expect(apps.status(appId)).toBe("running"); failAccess = false;
  });
  it("still accepts local folders and cleans up canceled import drafts", async () => {
    const local = join(home, "local"); mkdirSync(local); writeFileSync(join(local, "index.html"), "local version");
    const result = await call("POST", "/api/v1/apps", { sourceDir: local, name: "Local Project", access: "private", data: { mode: "none" }, envFileContent: "CUSTOM_LABEL=from-upload\nSECRET_KEY=wizard-secret\nPORT=1234" });
    expect((await ctx.jobs.wait(result.body.jobId)).status).toBe("succeeded");
    expect(apps.require(result.body.appId).sourceDir).toBe(local);
    expect(apps.github.status(result.body.appId)).toBeNull();
    expect(apps.require(result.body.appId).env.CUSTOM_LABEL).toBe("from-upload");
    expect(ctx.vault.get(`app:${result.body.appId}/env/SECRET_KEY`)).toBe("wizard-secret");
    const draft = await call("POST", "/api/v1/github/imports", input);
    expect((await call("DELETE", `/api/v1/github/imports/${draft.body.importId}`)).status).toBe(200);
    expect(existsSync(draft.body.sourceDir)).toBe(false);
  });
});
