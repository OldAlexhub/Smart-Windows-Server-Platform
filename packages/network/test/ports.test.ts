import net from "node:net";
import { describe, expect, it } from "vitest";
import { StateStore } from "@nexus/state";
import { isPortAvailable, isPortFree, PortAllocator } from "@nexus/network";

function listen(port: number, host = "127.0.0.1"): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(port, host, () => resolve(s));
  });
}
const close = (s: net.Server) => new Promise<void>((r) => s.close(() => r()));

describe("isPortFree", () => {
  it("sees a real listener", async () => {
    const s = await listen(0);
    const port = (s.address() as net.AddressInfo).port;
    expect(await isPortFree(port)).toBe(false);
    expect(await isPortAvailable(port)).toBe(false);
    await close(s);
    expect(await isPortFree(port)).toBe(true);
  });

  it("sees a program listening only on IPv6 (e.g. Caddy or IIS on [::])", async () => {
    let s: net.Server;
    try {
      s = await listen(0, "::");
    } catch {
      return; // no IPv6 on this machine
    }
    const port = (s.address() as net.AddressInfo).port;
    expect(await isPortAvailable(port)).toBe(false);
    await close(s);
    expect(await isPortAvailable(port)).toBe(true);
  });
});

describe("PortAllocator", () => {
  it("allocates unique, stable ports in the private range", async () => {
    const alloc = new PortAllocator(StateStore.memory(), { rangeStart: 43000, rangeEnd: 43999, probe: async () => true });
    const a = await alloc.allocate("app:taxiops");
    const b = await alloc.allocate("app:finance");
    expect(a).toBeGreaterThanOrEqual(43000);
    expect(a).toBeLessThanOrEqual(43999);
    expect(a).not.toBe(b);
    expect(await alloc.allocate("app:taxiops")).toBe(a); // idempotent
    expect(await alloc.allocate("app:taxiops", "metrics")).not.toBe(a);
  });

  it("never hands out the same port under concurrent requests", async () => {
    const alloc = new PortAllocator(StateStore.memory(), { rangeStart: 50000, rangeEnd: 50009, probe: async () => true });
    const ports = await Promise.all(Array.from({ length: 10 }, (_, i) => alloc.allocate(`app:${i}`)));
    expect(new Set(ports).size).toBe(10);
    await expect(alloc.allocate("app:eleven")).rejects.toThrow(/run out of private network ports/);
  });

  it("persists across restarts", async () => {
    const store = StateStore.memory();
    const port = await new PortAllocator(store, { probe: async () => true }).allocate("app:x");
    expect(new PortAllocator(store, { probe: async () => true }).get("app:x")).toBe(port);
  });

  it("skips ports already used by other programs (real sockets)", async () => {
    const blocker = await listen(0);
    const busy = (blocker.address() as net.AddressInfo).port;
    const alloc = new PortAllocator(StateStore.memory(), { rangeStart: busy, rangeEnd: busy + 20 });
    const got = await Promise.all(Array.from({ length: 5 }, (_, i) => alloc.allocate(`app:${i}`)));
    expect(got).not.toContain(busy);
    await close(blocker);
  });

  it("moves an app to a new port when another program grabs its port (self-healing)", async () => {
    const occupied = new Set<number>();
    const alloc = new PortAllocator(StateStore.memory(), { probe: async (p) => !occupied.has(p) });
    const original = await alloc.allocate("app:taxiops");
    expect(await alloc.ensureAvailable("app:taxiops")).toEqual({ port: original, changedFrom: null });

    occupied.add(original);
    expect(await alloc.ensureAvailable("app:taxiops", "http", true)).toEqual({ port: original, changedFrom: null });
    const moved = await alloc.ensureAvailable("app:taxiops");
    expect(moved.changedFrom).toBe(original);
    expect(moved.port).not.toBe(original);
    expect(alloc.get("app:taxiops")).toBe(moved.port);
  });

  it("releases ports", async () => {
    const alloc = new PortAllocator(StateStore.memory(), { probe: async () => true });
    await alloc.allocate("app:a");
    await alloc.allocate("app:a", "debug");
    alloc.release("app:a", "debug");
    expect(alloc.list("app:a")).toHaveLength(1);
    alloc.release("app:a");
    expect(alloc.list()).toEqual([]);
  });
});
