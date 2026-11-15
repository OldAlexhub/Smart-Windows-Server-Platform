import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StateStore, SettingsRepo, settingsMigrations } from "@nexus/state";
import { SecretVault } from "@nexus/security";
import { GitHubSourceService, githubRepository } from "../src/services/github-source";
import type { NexusContext } from "../src/context";
import type { AppManager } from "../src/services/apps";

describe("GitHub project updates", () => {
  const stores: StateStore[] = [];
  afterEach(() => { for (const store of stores.splice(0)) store.close(); });
  function fixture() {
    const store = StateStore.memory(); stores.push(store); store.migrate(settingsMigrations);
    const settings = new SettingsRepo(store), vault = SecretVault.withKey(store, randomBytes(32));
    const app = { id: "app", sourceDir: "C:\\projects\\local", desiredState: "running" };
    const apps = { require: () => app, delivery: () => ({ updating: null }), setAutoDeploy: vi.fn(), restoreLocalSource: vi.fn(), uploadSource: vi.fn(async (_id: string, zip: string) => { expect(readFileSync(zip).toString()).toBe("archive"); return { jobId: "job" }; }) };
    const request = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (String(url).includes("/commits/")) return Response.json({ sha: "a".repeat(40) });
      if (String(url).includes("/zipball/")) return new Response(null, { status: 302, headers: { location: "https://codeload.github.com/owner/repo/legacy.zip/sha?token=signed" } });
      return new Response("archive");
    });
    const source = new GitHubSourceService({ store, settings, vault, onStop: () => {}, audit: { record: vi.fn() } } as unknown as NexusContext, apps as unknown as AppManager, request);
    return { source, apps, request, settings, app };
  }
  const config = { repository: "https://github.com/owner/repo", branch: "feature/updates", enabled: true, intervalMinutes: 1, token: "private-token" };
  it("uses only GitHub URLs, encrypts credentials and retains the local source", async () => {
    const f = fixture(); await f.source.configure("app", config);
    expect(JSON.stringify(f.source.status("app"))).not.toContain(config.token);
    expect(f.apps.setAutoDeploy).toHaveBeenCalledWith("app", false);
    expect(await f.source.check("app")).toEqual({ jobId: "job" });
    const download = f.request.mock.calls.find(([url]) => String(url).includes("codeload"))!;
    expect(download[1]?.headers).toBeUndefined();
    expect(f.request.mock.calls.some(([url]) => String(url).includes("feature%2Fupdates"))).toBe(true);
    f.source.disconnect("app"); expect(f.apps.restoreLocalSource).toHaveBeenCalledWith("app", "C:\\projects\\local");
  });
  it("does not redeploy an attempted commit automatically, but permits explicit retry", async () => {
    const f = fixture(); await f.source.configure("app", config); await f.source.check("app");
    f.settings.set("githubSource:app", { ...f.settings.get<object>("githubSource:app", {}), nextCheck: 0 });
    expect(await f.source.check("app")).toMatchObject({ unchanged: true });
    expect(f.apps.uploadSource).toHaveBeenCalledTimes(1);
    await f.source.check("app", true); expect(f.apps.uploadSource).toHaveBeenCalledTimes(2);
  });
  it("refuses unexpected redirects and leaves deployment alone on access failures", async () => {
    const f = fixture(); await f.source.configure("app", config);
    f.request.mockImplementation(async (url) => String(url).includes("/commits/") ? Response.json({ sha: "a".repeat(40) }) : new Response(null, { status: 302, headers: { location: "https://attacker.example/archive" } }));
    await expect(f.source.check("app", true)).rejects.toThrow("unexpected archive");
    expect(f.apps.uploadSource).not.toHaveBeenCalled();
    f.request.mockResolvedValue(new Response(null, { status: 401 }));
    await expect(f.source.check("app", true)).rejects.toThrow("401");
    expect(f.apps.uploadSource).not.toHaveBeenCalled();
  });
  it("does not start stopped apps automatically or accept arbitrary source hosts", async () => {
    const f = fixture(); await f.source.configure("app", config); f.app.desiredState = "stopped";
    await f.source.check("app"); expect(f.apps.uploadSource).not.toHaveBeenCalled();
    for (const url of ["https://github.com.evil/repo", "http://127.0.0.1/a", "owner/..", "owner/repo?token=secret"]) expect(() => githubRepository(url)).toThrow();
  });
  it("rejects invalid header characters without sending or echoing the token", async () => {
    const f = fixture();
    for (const token of ["secret\0value", "secret\r\nvalue", "secret\u0100value"]) {
      await expect(f.source.repositories(token)).rejects.toThrow("Provide a GitHub fine-grained token");
    }
    expect(f.request).not.toHaveBeenCalled();
  });
  it("follows GitHub pagination links rather than truncating a repository list", async () => {
    const f = fixture();
    f.request.mockResolvedValue(Response.json([{ full_name: "owner/repo", default_branch: "develop", private: true }], { headers: { link: '<https://api.github.com/user/repos?page=2>; rel="next"' } }));
    expect(await f.source.repositories(config.token)).toEqual({ repositories: [{ repository: "owner/repo", branch: "develop", private: true }], nextPage: 2 });
    f.request.mockResolvedValue(Response.json([{ full_name: "owner/last", default_branch: "main", private: false }]));
    expect((await f.source.repositories(config.token, 2)).nextPage).toBeNull();
  });
});
