import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const script = resolve("scripts/ensure-runtime.ps1").replaceAll("'", "''");
function powershell(body: string) {
  return execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `
    $ErrorActionPreference = 'Stop'
    Import-Module Microsoft.PowerShell.Utility
    Import-Module Microsoft.PowerShell.Management
    . '${script}'
    $testRoot = Join-Path ([IO.Path]::GetTempPath()) ('nexus-runtime-qa-' + [Guid]::NewGuid())
    try { ${body} } finally {
      if ((Split-Path $testRoot -Parent) -ne ([IO.Path]::GetTempPath()).TrimEnd('\\')) { throw 'Unsafe cleanup' }
      if ([IO.Directory]::Exists($testRoot)) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
    }
  `,
    ],
    { encoding: "utf8", timeout: 45_000 },
  );
}

describe.skipIf(process.platform !== "win32")("installer native prerequisites", () => {
  it("installs or repairs offline, preserves a newer runtime, and handles restart/error exit codes", () => {
    powershell(`
      function Test-Path { return $true }
      function Get-FileHash { [pscustomobject]@{ Hash = '9c02c9ed120f671b900e6b9471d890e3b2414117a7e53f4ae2e855466fa2b7c9' } }
      $global:installedRuntime = $null
      function Get-ItemProperty { return $global:installedRuntime }
      $global:runtimeCode = 0
      $global:operations = @()
      function Start-Process {
        param($FilePath, $ArgumentList, $WindowStyle, [switch]$PassThru)
        if ($ArgumentList -notmatch '/quiet /norestart' -or $WindowStyle -ne 'Hidden') { throw 'Unattended installation required' }
        $global:operations += $ArgumentList.Split(' ')[0]
        $p = [pscustomobject]@{ ExitCode = $global:runtimeCode }
        $p | Add-Member ScriptMethod WaitForExit { param($ms) return $true }
        $p | Add-Member ScriptMethod Dispose { }
        return $p
      }
      if (Install-NexusRuntime -Path $testRoot -LogDir $testRoot) { throw 'Unexpected restart' }
      $global:installedRuntime = [pscustomobject]@{ Installed = 1; Version = 'v14.52.37029.0' }
      $global:runtimeCode = 3010
      if (!(Install-NexusRuntime -Path $testRoot -LogDir $testRoot)) { throw 'Lost restart requirement' }
      $global:runtimeCode = 1638
      if (Install-NexusRuntime -Path $testRoot -LogDir $testRoot) { throw 'Unexpected restart for newer runtime' }
      $global:runtimeCode = 1603
      $failed = $false
      try { Install-NexusRuntime -Path $testRoot -LogDir $testRoot } catch { $failed = $_.Exception.Message.Contains('1603') }
      if (!$failed) { throw 'Runtime failure was ignored' }
      $global:installedRuntime.Version = 'v14.99.99999.0'
      Install-NexusRuntime -Path $testRoot -LogDir $testRoot | Out-Null
      if (($global:operations -join ',') -ne '/install,/repair,/repair,/repair') { throw 'Incorrect runtime installation sequence' }
    `);
  });

  it("rejects damaged prerequisite packages before execution", () => {
    powershell(`
      $folder = Join-Path $testRoot 'components\\vc-runtime\\14.52.37029.0'
      [IO.Directory]::CreateDirectory($folder) | Out-Null
      [IO.File]::WriteAllText((Join-Path $folder 'VC_redist.x64.exe'), 'damaged')
      function Start-Process { throw 'Must not execute a damaged package' }
      $failed = $false
      try { Install-NexusRuntime -Path $testRoot -LogDir $testRoot } catch { $failed = $_.Exception.Message.Contains('missing or damaged') }
      if (!$failed) { throw 'Damaged prerequisite was not detected' }
    `);
  });

  it("checks real executables and rejects a missing component", () => {
    powershell(`
      Invoke-NexusNativeProbe '${process.execPath.replaceAll("'", "''")}'
      Invoke-NexusNativeProbe '${resolve("vendor/postgresql/18.4-1/bin/initdb.exe").replaceAll("'", "''")}'
      $failed = $false
      try { Invoke-NexusNativeProbe (Join-Path $testRoot 'missing.exe') } catch { $failed = $_.Exception.Message.Contains('missing') }
      if (!$failed) { throw 'Missing component accepted' }
    `);
  });

  it("prepares prerequisites before starting the service", () => {
    const hooks = readFileSync(resolve("apps/desktop/src-tauri/installer-hooks.nsh"), "utf8");
    expect(hooks.indexOf("ensure-runtime.ps1")).toBeLessThan(hooks.indexOf('service.mjs" install'));
    expect(hooks).toContain("SetRebootFlag true");
  });
});
