import type { MongoClient } from "mongodb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForMongoPrimary } from "../src/mongodb";

describe("authenticated MongoDB startup readiness", () => {
  afterEach(() => vi.useRealTimers());

  it("allows an authenticated secondary to finish electing itself", async () => {
    vi.useFakeTimers();
    const command = vi.fn()
      .mockResolvedValueOnce({ setName: "nexus_test", isWritablePrimary: false })
      .mockResolvedValue({ setName: "nexus_test", isWritablePrimary: true });
    const client = { db: () => ({ command }) } as unknown as MongoClient;
    const ready = waitForMongoPrimary(client, "nexus_test");
    await vi.advanceTimersByTimeAsync(100);
    await expect(ready).resolves.toBeUndefined();
  });

  it("rejects a different replica set even when it is writable", async () => {
    const client = { db: () => ({ command: async () => ({ setName: "wrong_set", isWritablePrimary: true }) }) } as unknown as MongoClient;
    await expect(waitForMongoPrimary(client, "nexus_test")).rejects.toThrow("identity does not match");
  });

  it("fails within the readiness deadline when no primary is elected", async () => {
    vi.useFakeTimers();
    const client = { db: () => ({ command: async () => ({ setName: "nexus_test", isWritablePrimary: false }) }) } as unknown as MongoClient;
    const result = expect(waitForMongoPrimary(client, "nexus_test", 500)).rejects.toThrow("did not elect its primary");
    await vi.advanceTimersByTimeAsync(500);
    await result;
  });
});
