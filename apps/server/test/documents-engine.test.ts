import { copyFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { NexusContext, SETTINGS } from "../src/context";
import { componentDir, resolveServicePaths } from "../src/paths";
import { InsecurePlainKeyProtector } from "@nexus/security";
import { FAKE_HARDWARE, FakeDetector, tempHome } from "./helpers";

describe.runIf(!!componentDir(resolveServicePaths(), "ferretdb"))("document engine adapters", () => {
  const { home, dispose } = tempHome();
  let ctx: NexusContext | null = null;
  afterAll(async () => {
    await ctx?.shutdown();
    dispose();
  }, 60_000);

  it("keeps an administrator-chosen FerretDB build available for legacy databases", async () => {
    const paths = resolveServicePaths({ ...process.env, NEXUS_HOME: join(home, "service") });
    ctx = await NexusContext.create({ paths, managementPort: 0, keyProtector: new InsecurePlainKeyProtector(), hardwareDetector: new FakeDetector(), portRange: [42900, 42919] });
    const bundled = componentDir(resolveServicePaths(), "ferretdb")!;
    const custom = join(home, "tools", `ferretdb-${basename(bundled)}.exe`);
    mkdirSync(join(home, "tools"), { recursive: true });
    copyFileSync(join(bundled, "ferretdb.exe"), custom);
    const data = { apps: "Apps", database: "Database", files: "Storage", backups: "Backups", ai: "AI" };
    for (const k of Object.keys(data) as (keyof typeof data)[]) mkdirSync((data[k] = join(home, "data", data[k])), { recursive: true });
    ctx.settings.set(SETTINGS.hardware, FAKE_HARDWARE);
    ctx.settings.set(SETTINGS.dataPaths, data);
    ctx.settings.set("documents.ferretdbPath", custom);
    await ctx.startDataServices();

    expect(ctx.documentEngine).toMatchObject({ version: basename(bundled) });
    expect(ctx.documentSource).toEqual({ engine: "MongoDB", source: "bundled", version: expect.any(String), transactions: true });
    const docs = await ctx.startDocuments();
    const { database, connection } = await docs.createDatabase({ displayName: "Inventory", appId: "inv", provider: "ferretdb" });
    expect(database).toMatchObject({ provider: "ferretdb", transactions: false });
    expect(await docs.testConnection(connection!)).toEqual({ ok: true });
  }, 120_000);

  it("explains clearly when document databases can't run", async () => {
    const t = tempHome();
    const paths = resolveServicePaths({ ...process.env, NEXUS_HOME: join(t.home, "service") });
    paths.componentRoots = [];
    const c = await NexusContext.create({ paths, managementPort: 0, keyProtector: new InsecurePlainKeyProtector(), hardwareDetector: new FakeDetector(), portRange: [42920, 42939] });
    try {
      await expect(c.startDocuments()).rejects.toThrow(/document database component is not installed|need the database server/);
    } finally {
      await c.shutdown();
      t.dispose();
    }
  });
});
