import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { locatePostgresBinaries, PostgresEngine, tunePostgres } from "@nexus/database";

export const PG_BIN = locatePostgresBinaries({ bundledRoots: [join(__dirname, "..", "..", "..", "vendor", "postgresql")] });

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

/** Spins up a real throwaway PostgreSQL cluster for integration tests. */
export async function startTestCluster(): Promise<{ engine: PostgresEngine; dispose: () => Promise<void> }> {
  if (!PG_BIN) throw new Error("PostgreSQL binaries not found — run: node scripts/fetch-components.mjs postgresql");
  const dir = mkdtempSync(join(tmpdir(), "nexus-pg-"));
  const engine = new PostgresEngine({
    bin: PG_BIN,
    dataDir: join(dir, "data"),
    port: await freePort(),
    superuser: "nexus_admin",
    superuserPassword: "test-superuser-password-123",
    tuning: tunePostgres({ totalMemoryBytes: 4 * 1024 ** 3, cpuThreads: 4, storage: "ssd", memoryShare: 0.1 }),
  });
  await engine.start();
  return {
    engine,
    dispose: async () => {
      await engine.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
