import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { silentLogger, type Logger } from "@nexus/shared";
import { renderCaddyfile, type GatewayConfig, type GatewayProvider } from "./gateway";

function exec(file: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) =>
    execFile(file, args, { windowsHide: true, timeout: 60_000 }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: `${stdout}${stderr}` }),
    ),
  );
}

/** Caddy as the HTTPS gateway: automatic certificates (ACME) and renewal, zero-downtime reloads. */
export class CaddyGateway implements GatewayProvider {
  readonly id = "caddy";
  private child: ChildProcess | null = null;
  /** Admin port of a gateway left running by an earlier Nexus process that we took over. */
  private adoptedAdmin: number | null = null;
  private readonly log: Logger;

  constructor(
    private readonly opts: { caddyExe: string; configPath: string; logger?: Logger; onOutput?: (line: string) => void },
  ) {
    this.log = opts.logger ?? silentLogger;
  }

  private write(config: GatewayConfig): void {
    mkdirSync(dirname(this.opts.configPath), { recursive: true });
    mkdirSync(config.storageDir, { recursive: true });
    mkdirSync(dirname(config.logFile), { recursive: true });
    writeFileSync(this.opts.configPath, renderCaddyfile(config));
  }

  async validate(config: GatewayConfig): Promise<{ valid: boolean; error?: string }> {
    try {
      this.write(config);
    } catch (e) {
      return { valid: false, error: (e as Error).message };
    }
    const r = await exec(this.opts.caddyExe, ["validate", "--config", this.opts.configPath, "--adapter", "caddyfile"]);
    return r.code === 0 ? { valid: true } : { valid: false, error: r.out.trim().split("\n").slice(-3).join("\n") };
  }

  async running(): Promise<boolean> {
    if (this.adoptedAdmin !== null) return adminAlive(this.adoptedAdmin);
    if (!this.child || this.child.exitCode !== null) return false;
    return true;
  }

  async start(config: GatewayConfig): Promise<void> {
    if (await this.running()) return this.apply(config);
    // Self-healing: if Nexus stopped abruptly earlier, its gateway may still be running on our
    // private admin port (holding ports 80/443). Take it over instead of failing to start.
    if (await adminAlive(config.adminPort)) {
      this.adoptedAdmin = config.adminPort;
      this.log.warn("adopting a gateway left running by a previous Nexus process", { admin: config.adminPort });
      return this.apply(config);
    }
    this.write(config);
    const child = spawn(this.opts.caddyExe, ["run", "--config", this.opts.configPath, "--adapter", "caddyfile"], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    for (const s of [child.stdout, child.stderr]) {
      if (s) createInterface({ input: s }).on("line", (l) => this.opts.onOutput?.(l));
    }
    await waitForAdmin(config.adminPort, 15_000, () => child.exitCode === null);
    if (child.exitCode !== null) throw new Error("The secure gateway could not start. See the gateway log for details.");
    this.log.info("gateway started", { admin: config.adminPort });
  }

  /** Applies a new configuration without dropping connections. */
  async apply(config: GatewayConfig): Promise<void> {
    if (!(await this.running())) return this.start(config);
    this.write(config);
    const r = await exec(this.opts.caddyExe, [
      "reload",
      "--config",
      this.opts.configPath,
      "--adapter",
      "caddyfile",
      "--address",
      `127.0.0.1:${config.adminPort}`,
    ]);
    if (r.code !== 0) throw new Error(`The secure gateway rejected the new configuration: ${r.out.trim().split("\n").pop()}`);
  }

  async stop(): Promise<void> {
    if (this.adoptedAdmin !== null) {
      await exec(this.opts.caddyExe, ["stop", "--address", `127.0.0.1:${this.adoptedAdmin}`]);
      this.adoptedAdmin = null;
      return;
    }
    const c = this.child;
    if (!c || c.exitCode !== null) return;
    const exited = new Promise<void>((r) => c.once("exit", () => r()));
    c.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    this.child = null;
  }
}

/**
 * Probes Caddy's admin API. Uses node:http deliberately: fetch() sends browser-style
 * Sec-Fetch headers, which Caddy's admin origin check rejects with 403.
 */
export function adminAlive(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/config/", timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
  });
}

async function waitForAdmin(port: number, timeoutMs: number, alive: () => boolean): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && alive()) {
    if (await adminAlive(port)) return;
    await new Promise((r) => setTimeout(r, 150));
  }
}
