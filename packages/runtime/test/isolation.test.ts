import { describe, expect, it } from "vitest";
import {
  buildPodmanRunArgs,
  containerName,
  defaultImage,
  IsolationRegistry,
  PodmanIsolationProvider,
  ProcessIsolationProvider,
  type Exec,
  type LaunchSpec,
} from "@nexus/runtime";

const spec = (over: Partial<LaunchSpec> = {}): LaunchSpec => ({
  appId: "TaxiOps",
  cwd: "D:\\Nexus\\Apps\\taxiops\\releases\\3",
  executable: "C:\\Nexus\\node\\node.exe",
  args: [],
  env: {
    SystemRoot: "C:\\Windows",
    PATH: "C:\\x",
    PORT: "43127",
    HOST: "127.0.0.1",
    DATABASE_URL: "postgres://taxiops:pw@127.0.0.1:43500/taxiops",
  },
  port: 43127,
  resources: { cpuLimitPercent: 200, memoryLimitMb: 2048, priority: "normal" },
  onOutput: () => {},
  logical: { runtime: "node", command: "npm", args: ["run", "start"], runtimeVersion: ">=20" },
  ...over,
});

describe("Podman command construction", () => {
  it("builds a hardened, loopback-only container with no secrets on the command line", () => {
    const { args, env } = buildPodmanRunArgs(spec(), "docker.io/library/node:20-slim");
    const line = args.join(" ");
    expect(line).toContain("-p 127.0.0.1:43127:43127");
    expect(line).toContain("--cap-drop ALL");
    expect(line).toContain("--security-opt no-new-privileges");
    expect(line).toContain("--memory 2048m");
    expect(line).toContain("--cpus 2.00");
    expect(line).toContain("--name nexus-taxiops");
    expect(line).not.toContain("pw@"); // secret stays out of argv
    expect(args.slice(-4)).toEqual(["docker.io/library/node:20-slim", "npm", "run", "start"]);
    expect(env.DATABASE_URL).toBe("postgres://taxiops:pw@host.nexus.internal:43500/taxiops");
    expect(env.HOST).toBe("0.0.0.0");
    expect(env.PATH).toBeUndefined();
    expect(env.SystemRoot).toBeUndefined();
  });

  it("chooses images from the detected runtime version", () => {
    expect(defaultImage("node", ">=20")).toBe("docker.io/library/node:20-slim");
    expect(defaultImage("node", null)).toBe("docker.io/library/node:22-slim");
    expect(defaultImage("python", "3.11")).toBe("docker.io/library/python:3.11-slim");
    expect(containerName("Taxi Ops")).toBe("nexus-taxi-ops");
  });
});

describe("PodmanIsolationProvider availability", () => {
  const exec = (versionCode: number, infoCode: number): Exec => async (_c, args) =>
    args[0] === "--version" ? { code: versionCode, stdout: "podman version 5.4", stderr: "" } : { code: infoCode, stdout: "linux", stderr: "" };

  it("explains what is missing", async () => {
    expect(await new PodmanIsolationProvider("podman", exec(1, 1)).available()).toEqual({
      available: false,
      reason: "Podman is not installed.",
    });
    expect((await new PodmanIsolationProvider("podman", exec(0, 125)).available()).reason).toMatch(/WSL2 machine/);
    expect(await new PodmanIsolationProvider("podman", exec(0, 0)).available()).toEqual({ available: true });
  });

  it("is reported unavailable on this machine (no Podman installed)", async () => {
    const r = await new PodmanIsolationProvider().available();
    expect(r.available).toBe(false);
  });
});

describe("IsolationRegistry", () => {
  const fakeContainer = (available: boolean) => ({
    id: "podman",
    label: "Linux container",
    available: async () => ({ available }),
    launch: async () => {
      throw new Error("n/a");
    },
  });

  it("defaults to native isolated processes", async () => {
    const reg = new IsolationRegistry();
    reg.register(new ProcessIsolationProvider());
    reg.register(fakeContainer(true));
    expect((await reg.choose({})).provider.id).toBe("process");
  });

  it("honours an available Advanced preference, else falls back", async () => {
    const reg = new IsolationRegistry();
    reg.register(new ProcessIsolationProvider());
    reg.register(fakeContainer(true));
    expect((await reg.choose({ preference: "podman" })).provider.id).toBe("podman");
    const reg2 = new IsolationRegistry();
    reg2.register(new ProcessIsolationProvider());
    reg2.register(fakeContainer(false));
    expect((await reg2.choose({ preference: "podman" })).provider.id).toBe("process");
  });

  it("routes Linux-only apps to containers and explains when unavailable", async () => {
    const reg = new IsolationRegistry();
    reg.register(new ProcessIsolationProvider());
    reg.register(fakeContainer(true));
    expect((await reg.choose({ requiresLinux: true })).reason).toBe("This application needs Linux");
    const none = new IsolationRegistry();
    none.register(new ProcessIsolationProvider());
    await expect(none.choose({ requiresLinux: true })).rejects.toThrow(/Linux containers/);
    expect((await none.status())[0]).toMatchObject({ id: "process", available: true });
  });
});
