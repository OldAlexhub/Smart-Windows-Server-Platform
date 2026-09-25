import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PG_HBA, reduceSharedBuffers, renderNexusConf, tunePostgres, type PostgresEngine } from "@nexus/database";
import { PG_BIN, startTestCluster } from "./pg-harness";

const GiB = 1024 ** 3;

describe("PostgreSQL tuning & configuration", () => {
  it("scales with memory and storage", () => {
    const big = tunePostgres({ totalMemoryBytes: 64 * GiB, cpuThreads: 32, storage: "nvme" });
    expect(big).toMatchObject({ shared_buffers: "8192MB", effective_cache_size: "24576MB", random_page_cost: 1.1, max_worker_processes: 32 });
    const small = tunePostgres({ totalMemoryBytes: 8 * GiB, cpuThreads: 4, storage: "hdd" });
    expect(small).toMatchObject({ shared_buffers: "1024MB", random_page_cost: 4, max_parallel_workers: 2, max_wal_size: "2GB" });
  });

  it("steps shared memory down when Windows can't provide it", () => {
    expect(reduceSharedBuffers({ shared_buffers: "6000MB", work_mem: "8MB" })).toEqual({ shared_buffers: "3000MB", work_mem: "8MB" });
    expect(reduceSharedBuffers({ shared_buffers: "200MB" })).toEqual({ shared_buffers: "128MB" });
    expect(reduceSharedBuffers({ shared_buffers: "128MB" })).toBeNull();
  });

  it("binds to loopback only and requires SCRAM passwords", () => {
    const conf = renderNexusConf(43500, { work_mem: "8MB" }, "D:\\Nexus\\Database\\log");
    expect(conf).toContain("listen_addresses = '127.0.0.1'");
    expect(conf).toContain("port = 43500");
    expect(conf).toContain("password_encryption = 'scram-sha-256'");
    expect(conf).toContain("log_directory = 'D:/Nexus/Database/log'");
    expect(PG_HBA).not.toMatch(/trust|0\.0\.0\.0|md5/);
  });
});

describe.runIf(!!PG_BIN)("PostgresEngine (real PostgreSQL)", () => {
  let engine: PostgresEngine;
  let dispose: () => Promise<void>;
  beforeAll(async () => {
    ({ engine, dispose } = await startTestCluster());
  }, 180_000);
  afterAll(async () => dispose?.(), 60_000);

  it("initializes, starts on a private loopback port, and accepts the superuser", async () => {
    expect(await engine.state()).toBe("running");
    const [row] = await engine.adminQuery<{ v: string; addr: string }>("SELECT current_setting('server_version') AS v, current_setting('listen_addresses') AS addr");
    expect(row!.v).toMatch(/^18\./);
    expect(row!.addr).toBe("127.0.0.1");
    expect(readFileSync(join(engine.dataDir, "pg_hba.conf"), "utf8")).toBe(PG_HBA);
  });

  it("rejects wrong passwords", async () => {
    const c = new pg.Client({ host: "127.0.0.1", port: engine.port, user: "nexus_admin", password: "wrong", database: "postgres" });
    await expect(c.connect()).rejects.toThrow(/password authentication failed/);
  });

  it("has pg_stat_statements for performance insights", async () => {
    const rows = await engine.adminQuery("SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'");
    expect(rows).toHaveLength(1);
  });

  it("stops and restarts cleanly (idempotent start)", async () => {
    await engine.stop();
    expect(await engine.state()).toBe("stopped");
    await engine.start();
    await engine.start();
    expect(await engine.state()).toBe("running");
  }, 120_000);
});
