import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { expect, it } from "vitest";
import { AppManager } from "../src/services/apps";
import { BackupService } from "../src/services/backups";
import { GatewayService } from "../src/services/gateway";
import { createContext, tempHome } from "./helpers";

it("restores a deployed app's code, deployment registry, uploads and settings together", async () => {
  const temp = tempHome();
  const ctx = await createContext(temp.home, { setup: true });
  const gateway = new GatewayService(ctx);
  ctx.settings.set("gateway", { httpPort: await ctx.ports.allocate("test", "http"), httpsPort: await ctx.ports.allocate("test", "https"), localPort: await ctx.ports.allocate("test", "local"), insecureHttp: true, manageFirewall: false });
  const apps = new AppManager(ctx, gateway);
  try {
    const source = join(temp.home, "source"); mkdirSync(source); writeFileSync(join(source, "index.html"), "original app");
    const created = apps.create({ sourceDir: source, name: "SavedApp", access: "private", data: { mode: "none" } }, { id: "test", name: "Test" });
    expect((await ctx.jobs.wait(created.jobId)).status).toBe("succeeded");
    const id = created.appId;
    apps.setEnv(id, "MY_SECRET", "original-secret");
    const uploaded = await ctx.storage!.put(id, { name: "photo.txt", contentType: "text/plain" }, Readable.from(["original photo"]));
    const original = ctx.deployments!.current(id)!;
    const service = new BackupService(ctx, apps);
    const point = await service.backupNow(id);
    expect(point.contents.application).toBe(true);
    writeFileSync(join(source, "index.html"), "new app");
    expect((await ctx.jobs.wait(apps.deploy(id).id)).status).toBe("succeeded");
    apps.setEnv(id, "MY_SECRET", "changed-secret"); apps.setEnv(id, "LATER_SECRET", "remove-me");
    await ctx.storage!.delete(id, uploaded.id);
    const result = await service.restore(id, point.id, "entire", "SavedApp");
    expect(result.restored).toEqual(["files", "config"]);
    expect(ctx.deployments!.current(id)!.id).toBe(original.id);
    expect(readFileSync(join(original.releaseDir, "index.html"), "utf8")).toBe("original app");
    expect(ctx.store.get("SELECT id FROM storage_objects WHERE id = ?", [uploaded.id])).toBeTruthy();
    expect(ctx.vault.get(`app:${id}/env/MY_SECRET`)).toBe("original-secret");
    expect(ctx.vault.get(`app:${id}/env/LATER_SECRET`)).toBeUndefined();
  } finally { await apps.stopAll(); await ctx.shutdown(); temp.dispose(); }
}, 180_000);
