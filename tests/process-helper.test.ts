import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const buildModule = "../scripts/build-process-helper.mjs";
describe.skipIf(process.platform !== "win32")("Windows process-tree CPU sharing", () => {
  let root: string;
  let helper: string;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "nexus-helper-"));
    helper = join(root, "NexusProcess.exe");
    (await import(buildModule)).buildProcessHelper(helper);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("preserves arguments, environment, working directory, output and exit code", () => {
    const args = ["", "with spaces", 'quote"inside', "trailing\\", "& $()"];
    const script = "console.log(JSON.stringify({args:process.argv.slice(1),cwd:process.cwd(),value:process.env.NEXUS_TEST}));console.error('stderr intact')";
    const output = execFileSync(helper, ["5", process.execPath, "-e", script, ...args], { cwd: root, env: { ...process.env, NEXUS_TEST: "preserved" }, encoding: "utf8", windowsHide: true });
    expect(JSON.parse(output)).toEqual({ args, cwd: root, value: "preserved" });
    try { execFileSync(helper, ["5", process.execPath, "-e", "process.exit(23)"], { windowsHide: true }); throw new Error("Expected exit 23"); }
    catch (error) { expect((error as { status: number }).status).toBe(23); }
  });

  it("applies a CPU weight to descendants without imposing a hard cap", () => {
    const script = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class Probe { [StructLayout(LayoutKind.Sequential)] public struct CPU { public uint flags, value; } [DllImport("kernel32.dll")] public static extern bool QueryInformationJobObject(IntPtr job, int kind, ref CPU cpu, uint size, IntPtr returned); }'; $cpu = New-Object Probe+CPU; if (![Probe]::QueryInformationJobObject([IntPtr]::Zero,15,[ref]$cpu,8,[IntPtr]::Zero)) { throw 'No CPU job' }; Write-Output ($cpu.flags.ToString() + ':' + $cpu.value.ToString())`;
    const output = execFileSync(helper, ["5", join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"), "-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true });
    expect(output.trim()).toBe("3:5");
  });

  it("keeps the private control pipe out of application stdin", async () => {
    const child = spawn(helper, ["5", process.execPath, "-e", "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{console.log(JSON.stringify(s));setTimeout(()=>process.exit(0),100)})"], { windowsHide: true });
    let output = "";
    child.stdout.on("data", (value) => output += value);
    child.stdin.on("error", () => {});
    child.stdin.write("memory:2\nmemory:5\n");
    const code = await new Promise((resolve) => child.on("close", resolve));
    expect(code).toBe(0);
    expect(JSON.parse(output)).toBe("");
  });
});
