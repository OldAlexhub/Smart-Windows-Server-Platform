import { createHash } from "node:crypto";
import net from "node:net";
import { NexusError } from "@nexus/shared";
import type { Migration, StateStore } from "@nexus/state";

export const portMigrations: Migration[] = [
  {
    id: "network/001_ports",
    up: `CREATE TABLE port_allocations (
      port INTEGER PRIMARY KEY,
      owner TEXT NOT NULL,
      purpose TEXT NOT NULL,
      allocated_at TEXT NOT NULL,
      UNIQUE (owner, purpose)
    )`,
  },
];

/** Returns true when nothing is listening on host:port. */
export function isPortFree(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once("error", (e: NodeJS.ErrnoException) => {
      // No IPv6 on this computer: nothing can be listening there either.
      resolve(host.includes(":") && (e.code === "EAFNOSUPPORT" || e.code === "EADDRNOTAVAIL"));
    });
    srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

/**
 * A port counts as free only if loopback, IPv4 wildcard and IPv6 wildcard binds all succeed.
 * On Windows a dual-stack listener on [::] (Caddy, IIS, …) does not block IPv4 binds, so the
 * IPv6 check is what catches it.
 */
export async function isPortAvailable(port: number): Promise<boolean> {
  return (await isPortFree(port, "127.0.0.1")) && (await isPortFree(port, "0.0.0.0")) && (await isPortFree(port, "::"));
}

export interface PortAllocation {
  port: number;
  owner: string;
  purpose: string;
}

export interface PortAllocatorOptions {
  rangeStart?: number;
  rangeEnd?: number;
  /** Injected for tests. */
  probe?: (port: number) => Promise<boolean>;
}

/**
 * Hands out private loopback ports (default 43000–43999) to apps and services.
 * Allocations are persisted so an app keeps its port across restarts, and
 * re-validated against the OS so a port grabbed by another program is replaced.
 */
export class PortAllocator {
  private readonly start: number;
  private readonly end: number;
  private readonly probe: (port: number) => Promise<boolean>;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: StateStore,
    options: PortAllocatorOptions = {},
  ) {
    store.migrate(portMigrations);
    this.start = options.rangeStart ?? 43000;
    this.end = options.rangeEnd ?? 43999;
    this.probe = options.probe ?? isPortAvailable;
    if (this.start > this.end || this.start < 1024) throw new Error("Invalid port range.");
  }

  get(owner: string, purpose = "http"): number | null {
    return (
      this.store.get<{ port: number }>("SELECT port FROM port_allocations WHERE owner = ? AND purpose = ?", [owner, purpose])
        ?.port ?? null
    );
  }

  list(owner?: string): PortAllocation[] {
    return this.store.all<PortAllocation>(
      owner
        ? "SELECT port, owner, purpose FROM port_allocations WHERE owner = ? ORDER BY port"
        : "SELECT port, owner, purpose FROM port_allocations ORDER BY port",
      owner ? [owner] : [],
    );
  }

  /** Returns the owner's existing port, or allocates a new free one. Serialised to avoid races. */
  allocate(owner: string, purpose = "http"): Promise<number> {
    return this.serial(async () => {
      const existing = this.get(owner, purpose);
      if (existing !== null) return existing;
      return this.pickAndRecord(owner, purpose);
    });
  }

  /**
   * Called before (re)starting an app. If the owner's port is now used by some other
   * program, moves the owner to a new port and reports it (self-healing port conflict).
   * `ownedByUs` lets callers say "the listener on that port is our own process".
   */
  ensureAvailable(owner: string, purpose = "http", ownedByUs = false): Promise<{ port: number; changedFrom: number | null }> {
    return this.serial(async () => {
      const existing = this.get(owner, purpose);
      if (existing !== null && (ownedByUs || (await this.probe(existing)))) return { port: existing, changedFrom: null };
      if (existing !== null) this.store.run("DELETE FROM port_allocations WHERE port = ?", [existing]);
      const port = await this.pickAndRecord(owner, purpose, existing ?? undefined);
      return { port, changedFrom: existing };
    });
  }

  release(owner: string, purpose?: string): void {
    if (purpose) this.store.run("DELETE FROM port_allocations WHERE owner = ? AND purpose = ?", [owner, purpose]);
    else this.store.run("DELETE FROM port_allocations WHERE owner = ?", [owner]);
  }

  private async pickAndRecord(owner: string, purpose: string, avoid?: number): Promise<number> {
    const taken = new Set(this.store.all<{ port: number }>("SELECT port FROM port_allocations").map((r) => r.port));
    const size = this.end - this.start + 1;
    // Start from a stable per-owner offset so ports look consistent across reinstalls.
    const offset = createHash("sha1").update(`${owner}:${purpose}`).digest().readUInt32BE(0) % size;
    for (let i = 0; i < size; i++) {
      const port = this.start + ((offset + i) % size);
      if (taken.has(port) || port === avoid) continue;
      if (!(await this.probe(port))) continue;
      this.store.run("INSERT INTO port_allocations (port, owner, purpose, allocated_at) VALUES (?, ?, ?, ?)", [
        port,
        owner,
        purpose,
        new Date().toISOString(),
      ]);
      return port;
    }
    throw new NexusError("infrastructure", "Nexus has run out of private network ports for applications.", {
      problem: {
        title: "No free ports",
        summary: `All ${size} private ports reserved for Nexus applications are in use.`,
        checks: [{ label: "Port range", status: "failed", detail: `${this.start}–${this.end}` }],
        cause: "Too many applications or another program is using the Nexus port range.",
      },
    });
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

/** Which program is listening on a port (Windows), e.g. { pid: 4120, name: "httpd" }. */
export async function portOwner(port: number): Promise<{ pid: number; name: string } | null> {
  if (process.platform !== "win32") return null;
  const { execFile } = await import("node:child_process");
  const script = `$c = Get-NetTCPConnection -LocalPort ${Math.floor(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue; "$($c.OwningProcess)|$($p.ProcessName)" }`;
  return new Promise((resolve) =>
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 15_000 }, (_e, out) => {
      const [pid, name] = String(out ?? "").trim().split("|");
      resolve(pid && Number(pid) > 0 ? { pid: Number(pid), name: name || "unknown program" } : null);
    }),
  );
}
