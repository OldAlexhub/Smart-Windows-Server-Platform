import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NexusContext } from "../src/context";
import { appRoutes } from "../src/http/routes/apps";
import { authRoutes } from "../src/http/routes/auth";
import { buildServer } from "../src/http/server";
import { AppManager } from "../src/services/apps";
import { GatewayService } from "../src/services/gateway";
import { createContext, tempHome } from "./helpers";
import { CSRF, ownerClient } from "./helpers-http";

let ctx: NexusContext;
let app: FastifyInstance;
let apps: AppManager;
let home: string;
let dispose: () => void;
let call: Awaited<ReturnType<typeof ownerClient>>;
let gwPorts: { httpPort: number; httpsPort: number; localPort: number };

/** A dependency-free app that says which version it is. `bootMs` makes it slow to start, like real apps. */
const server = (version: string, opts: { bootMs?: number; crash?: boolean; fixedPort?: number } = {}) => `
const http = require("http");
${opts.crash ? 'throw new Error("Cannot find module ./config");' : ""}
setTimeout(() => {
  http.createServer((req, res) => {
    if (req.url === "/health") return res.end("ok");
    res.end(JSON.stringify({ version: ${JSON.stringify(version)}, pid: process.pid }));
  }).listen(${opts.fixedPort ?? "Number(process.env.PORT)"}, "127.0.0.1");
}, ${opts.bootMs ?? 0});
`;

function project(dir: string, version: string, opts: Parameters<typeof server>[1] = {}) {
  const files = {
    "package.json": JSON.stringify({ name: "shop-api", version, scripts: { start: "node server.js" }, dependencies: {} }),
    "server.js": server(version, opts),
  };
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
}

function get(host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port: gwPorts.localPort, path: "/", headers: { Host: host }, agent: false }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode!, body }));
      })
      .on("error", reject);
  });
}
const version = async (host: string) => JSON.parse((await get(host)).body).version as string;

async function waitJob(id: string) {
  for (let i = 0; i < 2400; i++) {
    const r = await call("GET", `/api/v1/jobs/${id}`);
    if (["succeeded", "failed", "waiting_for_input"].includes(r.body.status)) return r.body;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error("job timeout");
}

/**
 * Requests the app non-stop while `during` runs, the way visitors would during an update.
 * Returns every answer: a status other than 200 means someone saw an error.
 */
async function visitorsDuring(host: string, during: () => Promise<void>) {
  const seen: { status: number; version: string | null }[] = [];
  let done = false;
  const load = (async () => {
    while (!done) {
      try {
        const r = await get(host);
        seen.push({ status: r.status, version: r.status === 200 ? JSON.parse(r.body).version : null });
      } catch {
        seen.push({ status: 0, version: null });
      }
      await new Promise((res) => setTimeout(res, 25));
    }
  })();
  try {
    await during();
    await new Promise((res) => setTimeout(res, 500));
  } finally {
    done = true;
    await load;
  }
  return seen;
}

/** Zips a folder with Windows' tar, the way someone would "Send to › Compressed folder". */
function zip(dir: string, file: string) {
  execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), ["-a", "-c", "-f", file, "-C", dir, "."]);
  return readFileSync(file);
}

async function multipart(fields: Record<string, { name: string; data: Buffer }>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, new Blob([v.data], { type: "application/zip" }), v.name);
  const req = new Request("http://x/", { method: "POST", body: fd });
  return { payload: Buffer.from(await req.arrayBuffer()), contentType: req.headers.get("content-type")! };
}

beforeAll(async () => {
  const t = tempHome();
  home = t.home;
  dispose = t.dispose;
  ctx = await createContext(home, { setup: true });
  gwPorts = {
    httpPort: await ctx.ports.allocate("test", "http"),
    httpsPort: await ctx.ports.allocate("test", "https"),
    localPort: await ctx.ports.allocate("test", "local"),
  };
  ctx.settings.set("gateway", { ...gwPorts, insecureHttp: true, manageFirewall: false });
  apps = new AppManager(ctx, new GatewayService(ctx));
  app = await buildServer(ctx, [authRoutes, appRoutes(apps)]);
  call = await ownerClient(app, ctx);
  project(join(home, "src", "Shop"), "1.0.0");
  const created = await call("POST", "/api/v1/apps", { sourceDir: join(home, "src", "Shop"), name: "Shop", data: { mode: "none" }, access: "private" });
  expect((await waitJob(created.body.jobId)).status).toBe("succeeded");
}, 240_000);

afterAll(async () => {
  await apps?.stopAll();
  await app?.close();
  await ctx?.shutdown();
  dispose?.();
}, 120_000);

describe("updates without downtime", () => {
  it("switches visitors to the new version only once it's ready: no failed request during the update", async () => {
    expect(await version("shop.nexus.localhost")).toBe("1.0.0");
    const before = apps.addresses("shop").find((a) => a.kind === "direct")!.url;
    project(join(home, "src", "Shop"), "1.1.0", { bootMs: 2500 }); // takes a while to start
    let job: { status: string; log: string[] } | null = null;
    const seen = await visitorsDuring("shop.nexus.localhost", async () => {
      job = await waitJob((await call("POST", "/api/v1/apps/shop/deploy")).body.jobId);
    });
    expect(job!.status).toBe("succeeded");
    expect(job!.log.join("\n")).toMatch(/keeps serving/);
    expect(seen.length).toBeGreaterThan(20);
    expect(seen.filter((s) => s.status !== 200)).toEqual([]);
    // Old version until the switch, then only the new one.
    const versions = seen.map((s) => s.version);
    expect(versions[0]).toBe("1.0.0");
    expect(versions.at(-1)).toBe("1.1.0");
    expect(versions.slice(versions.indexOf("1.1.0"))).not.toContain("1.0.0");
    // The app moved to its other port; its direct address follows.
    expect(apps.addresses("shop").find((a) => a.kind === "direct")!.url).not.toBe(before);
  }, 240_000);

  it("a new version that doesn't start leaves the current one running, untouched", async () => {
    project(join(home, "src", "Shop"), "1.2.0", { crash: true });
    let job: { status: string; problem: { title: string } | null } | null = null;
    const seen = await visitorsDuring("shop.nexus.localhost", async () => {
      job = await waitJob((await call("POST", "/api/v1/apps/shop/deploy")).body.jobId);
    });
    expect(job!.status).toBe("failed");
    expect(job!.problem!.title).toMatch(/still running the previous version/);
    expect(seen.every((s) => s.status === 200 && s.version === "1.1.0")).toBe(true);
    const detail = await call("GET", "/api/v1/apps/shop");
    expect(detail.body.status).toBe("running");
    expect(detail.body.problem ?? null).toBeNull();
  }, 240_000);

  it("if the gateway can't be switched, visitors stay on the current version and the new one is discarded", async () => {
    project(join(home, "src", "Shop"), "1.2.1");
    const gateway = (apps as unknown as { gateway: GatewayService }).gateway;
    const realSync = gateway.sync.bind(gateway);
    gateway.sync = async () => ({ ok: false, error: "simulated gateway failure" });
    let job: { status: string; log: string[] } | null = null;
    try {
      const seen = await visitorsDuring("shop.nexus.localhost", async () => {
        job = await waitJob((await call("POST", "/api/v1/apps/shop/deploy")).body.jobId);
      });
      expect(seen.every((s) => s.status === 200 && s.version === "1.1.0")).toBe(true);
    } finally {
      gateway.sync = realSync;
    }
    expect(job!.status).toBe("failed");
    expect(job!.log.join("\n")).toMatch(/visitors stay on the current version/);
    expect(await version("shop.nexus.localhost")).toBe("1.1.0");
    expect((await call("GET", "/api/v1/apps/shop")).body.status).toBe("running");
  }, 240_000);

  it("rolling back also switches without downtime", async () => {
    project(join(home, "src", "Shop"), "1.1.1");
    expect((await waitJob((await call("POST", "/api/v1/apps/shop/deploy")).body.jobId)).status).toBe("succeeded");
    const detail = await call("GET", "/api/v1/apps/shop");
    const v110 = detail.body.deployments.find((d: { version: string }) => d.version === "v1.1.0").id;
    const seen = await visitorsDuring("shop.nexus.localhost", async () => {
      expect((await call("POST", "/api/v1/apps/shop/rollback", { deploymentId: v110 })).body).toEqual({ status: "running" });
    });
    expect(seen.filter((s) => s.status !== 200)).toEqual([]);
    expect(await version("shop.nexus.localhost")).toBe("1.1.0");
  }, 240_000);

  it("an app stuck on one fixed port can't run twice, so it's restarted with the new version instead", async () => {
    project(join(home, "src", "Fixed"), "2.0.0");
    const created = await call("POST", "/api/v1/apps", { sourceDir: join(home, "src", "Fixed"), name: "Fixed", data: { mode: "none" }, access: "private" });
    expect((await waitJob(created.body.jobId)).status).toBe("succeeded");
    // The new version hard-codes the port it runs on now (ignoring PORT), as some apps do.
    const fixed = ctx.ports.get("app:fixed", "http")!;
    project(join(home, "src", "Fixed"), "2.1.0", { fixedPort: fixed });
    const job = await waitJob((await call("POST", "/api/v1/apps/fixed/deploy")).body.jobId);
    expect(job.status).toBe("succeeded");
    expect(job.log.join("\n")).toMatch(/always uses the same port/);
    expect(await version("fixed.nexus.localhost")).toBe("2.1.0");
    await call("DELETE", "/api/v1/apps/fixed", { confirmation: "Fixed" });
  }, 240_000);
});

describe("new versions from a zip file", () => {
  it("uploading a zip puts that version live without downtime, from then on the app's code", async () => {
    const dir = join(home, "build", "shop-1.3.0", "shop-api"); // zipped with a top folder, like GitHub's "Download ZIP"
    project(dir, "1.3.0");
    const body = await multipart({ file: { name: "shop.zip", data: zip(join(home, "build", "shop-1.3.0"), join(home, "build", "shop-1.3.0.zip")) } });
    const cookie = await sessionCookie();
    const r = await app.inject({ method: "POST", url: "/api/v1/apps/shop/upload", headers: { cookie, ...CSRF, "content-type": body.contentType }, payload: body.payload });
    expect(r.statusCode).toBe(200);
    const seen = await visitorsDuring("shop.nexus.localhost", async () => {
      expect((await waitJob(r.json().jobId)).status).toBe("succeeded");
    });
    expect(seen.filter((s) => s.status !== 200)).toEqual([]);
    expect(await version("shop.nexus.localhost")).toBe("1.3.0");
    const delivery = (await call("GET", "/api/v1/apps/shop/delivery")).body;
    expect(delivery.source).toMatchObject({ uploaded: true, exists: true });
    expect(existsSync(join(delivery.source.dir, "server.js"))).toBe(true);
  }, 240_000);

  it("refuses a zip without an app in it, and changes nothing", async () => {
    const dir = join(home, "build", "notes");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "readme.txt"), "just notes");
    const body = await multipart({ file: { name: "notes.zip", data: zip(dir, join(home, "build", "notes.zip")) } });
    const cookie = await sessionCookie();
    const r = await app.inject({ method: "POST", url: "/api/v1/apps/shop/upload", headers: { cookie, ...CSRF, "content-type": body.contentType }, payload: body.payload });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/couldn't recognise an application/);
    expect(await version("shop.nexus.localhost")).toBe("1.3.0");
  }, 60_000);
});

describe("deploy key: pushing updates from another computer", () => {
  it("deploys a zip sent with the key, reports progress, and refuses wrong keys and the open internet", async () => {
    const { key, url } = (await call("POST", "/api/v1/apps/shop/deploy-key")).body;
    expect(key).toMatch(/^nxd_/);
    expect(url).toBe("/api/v1/hooks/deploy/shop");
    expect((await call("GET", "/api/v1/apps/shop/delivery")).body.deployKey.enabled).toBe(true);

    const dir = join(home, "build", "shop-1.4.0");
    project(dir, "1.4.0");
    const data = zip(dir, join(home, "build", "shop-1.4.0.zip"));

    const wrong = await app.inject({ method: "POST", url, headers: { authorization: "Bearer nxd_wrong", "content-type": "application/zip" }, payload: data });
    expect(wrong.statusCode).toBe(401);
    const internet = await app.inject({ method: "POST", url, headers: { authorization: `Bearer ${key}`, "content-type": "application/zip", "x-forwarded-for": "203.0.113.9" }, payload: data });
    expect(internet.statusCode).toBe(403);

    // What `curl -X POST --data-binary @app.zip -H "Authorization: Bearer nxd_…"` sends.
    const ok = await app.inject({ method: "POST", url, headers: { authorization: `Bearer ${key}`, "content-type": "application/zip" }, payload: data });
    expect(ok.statusCode).toBe(202);
    const { jobId, follow } = ok.json();
    let progress: { status: string } = { status: "running" };
    for (let i = 0; i < 1200 && progress.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 100));
      progress = (await app.inject({ method: "GET", url: follow, headers: { authorization: `Bearer ${key}` } })).json();
    }
    expect(progress.status).toBe("succeeded");
    expect(jobId).toBeTruthy();
    expect(await version("shop.nexus.localhost")).toBe("1.4.0");
    // Someone else's job isn't visible with this key.
    expect((await app.inject({ method: "GET", url: `${url}/jobs/not-a-job`, headers: { authorization: `Bearer ${key}` } })).statusCode).toBe(404);

    // Revoked: the key stops working at once.
    await call("DELETE", "/api/v1/apps/shop/deploy-key");
    expect((await app.inject({ method: "POST", url, headers: { authorization: `Bearer ${key}` } })).statusCode).toBe(401);
  }, 240_000);
});

describe("automatic updates when the app's folder changes", () => {
  it("waits for the files to settle, deploys once, and doesn't retry a change that failed", async () => {
    // Back to a folder on this computer.
    const folder = join(home, "src", "ShopLive");
    project(folder, "1.5.0");
    ctx.store.run("UPDATE apps SET source_dir = ? WHERE id = 'shop'", [folder]);
    expect((await waitJob((await call("POST", "/api/v1/apps/shop/deploy")).body.jobId)).status).toBe("succeeded");
    expect((await call("PUT", "/api/v1/apps/shop/auto-deploy", { enabled: true })).body.autoDeploy).toBe(true);

    expect(await apps.autoDeployTick()).toEqual([]); // nothing changed

    await new Promise((r) => setTimeout(r, 1100));
    project(folder, "1.6.0");
    expect(await apps.autoDeployTick()).toEqual([]); // just saved: waits for the files to settle
    const [jobId] = await apps.autoDeployTick(Date.now() + 60_000);
    expect(jobId).toBeTruthy();
    expect((await waitJob(jobId!)).status).toBe("succeeded");
    expect(await version("shop.nexus.localhost")).toBe("1.6.0");
    expect(await apps.autoDeployTick(Date.now() + 60_000)).toEqual([]); // already live

    // A broken change is tried once, then left until the files change again.
    await new Promise((r) => setTimeout(r, 1100));
    project(folder, "1.7.0", { crash: true });
    const [bad] = await apps.autoDeployTick(Date.now() + 60_000);
    expect((await waitJob(bad!)).status).toBe("failed");
    expect(await apps.autoDeployTick(Date.now() + 60_000)).toEqual([]);
    expect(await version("shop.nexus.localhost")).toBe("1.6.0");
    const later = new Date(Date.now() + 5_000);
    utimesSync(join(folder, "server.js"), later, later);
    expect(await apps.autoDeployTick(Date.now() + 60_000)).toHaveLength(1);

    await call("PUT", "/api/v1/apps/shop/auto-deploy", { enabled: false });
  }, 300_000);
});

async function sessionCookie(): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/local", headers: CSRF, payload: { token: ctx.localToken } });
  return String(res.headers["set-cookie"]).split(";")[0]!;
}
