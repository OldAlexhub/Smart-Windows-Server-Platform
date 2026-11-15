import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "@nexus/state";
import { SecretVault } from "@nexus/security";
import { GitHubAccountService, type GitHubLoginFactory } from "../src/services/github-account";
import type { NexusContext } from "../src/context";

describe("GitHub browser sign-in", () => {
  const disposers: (() => void)[] = [];
  afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); vi.useRealTimers(); });
  function fixture() {
    const store = StateStore.memory(), vault = SecretVault.withKey(store, randomBytes(32));
    let stop = () => {};
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ login: "octocat" }));
    const attempts: { resolve: (value: string) => void; reject: (error: Error) => void; cancel: ReturnType<typeof vi.fn> }[] = [];
    const begin: GitHubLoginFactory = (onCode) => {
      let resolve!: (value: string) => void, reject!: (error: Error) => void;
      const promise = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
      const pending = { promise, resolve, reject };
      const cancel = vi.fn(() => pending.reject(new Error("canceled")));
      attempts.push({ ...pending, cancel });
      onCode({ userCode: "ABCD-EFGH", verificationUri: "https://github.com/login/device" });
      return { result: pending.promise, cancel };
    };
    const service = new GitHubAccountService({ vault, onStop: (fn: () => void) => { stop = fn; } } as unknown as NexusContext, request, begin);
    disposers.push(() => { stop(); store.close(); });
    return { service, vault, request, attempts };
  }
  it("keeps codes and account credentials isolated by Nexus user, and never exposes tokens", async () => {
    const f = fixture();
    const first = f.service.start("alice");
    expect(first.pending).toMatchObject({ userCode: "ABCD-EFGH", status: "waiting" });
    expect(f.service.status("bob")).toEqual({ connected: false, login: null, pending: null });
    expect(f.service.start("alice").pending?.id).toBe(first.pending?.id);
    expect(f.attempts).toHaveLength(1);
    f.attempts[0]!.resolve("gho_testsecret");
    await vi.waitFor(() => expect(f.service.status("alice").connected).toBe(true));
    expect(f.service.token("alice")).toBe("gho_testsecret");
    expect(() => f.service.token("bob")).toThrow("Connect your GitHub");
    expect(JSON.stringify(f.service.status("alice"))).not.toContain("gho_testsecret");
    expect(f.request).toHaveBeenCalledWith("https://api.github.com/user", expect.objectContaining({ redirect: "error" }));
    f.service.disconnect("alice"); expect(() => f.service.token("alice")).toThrow();
  });
  it("canceling cannot connect an account from a late result", async () => {
    const f = fixture(); f.service.start("alice");
    f.attempts[0]!.resolve("gho_late");
    f.service.cancel("alice");
    await Promise.resolve();
    expect(f.service.status("alice")).toMatchObject({ connected: false, pending: null });
    expect(f.request).not.toHaveBeenCalled();
  });
  it("reuses the saved account after service recreation without another sign-in", async () => {
    const f = fixture(); f.service.start("alice"); f.attempts[0]!.resolve("gho_saved");
    await vi.waitFor(() => expect(f.service.status("alice").connected).toBe(true));
    const begin = vi.fn<GitHubLoginFactory>();
    const restarted = new GitHubAccountService({ vault: f.vault, onStop: () => {} } as unknown as NexusContext, f.request, begin);
    expect(restarted.status("alice")).toEqual({ connected: true, login: "octocat", pending: null });
    expect(restarted.token("alice")).toBe("gho_saved");
    expect(begin).not.toHaveBeenCalled();
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it("expires sign-ins and hides provider errors that might contain credentials", async () => {
    vi.useFakeTimers();
    const f = fixture(); f.service.start("alice");
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(f.service.status("alice").pending).toMatchObject({ status: "failed", error: expect.stringContaining("expired") });
    expect(f.attempts[0]!.cancel).toHaveBeenCalled();
    f.service.start("alice"); f.attempts[1]!.reject(new Error("provider secret-token"));
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.stringify(f.service.status("alice"))).not.toContain("secret-token");
    expect(f.service.status("alice").pending?.status).toBe("failed");
  });
  it("does not save a credential when GitHub denies profile access", async () => {
    const f = fixture(); f.request.mockResolvedValue(new Response(null, { status: 401 }));
    f.service.start("alice"); f.attempts[0]!.resolve("gho_revoked");
    await vi.waitFor(() => expect(f.service.status("alice").pending?.status).toBe("failed"));
    expect(() => f.service.token("alice")).toThrow();
  });
});
