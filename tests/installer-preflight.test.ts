import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, it } from "vitest";

const script = resolve("apps/desktop/src-tauri/installer-preflight.ps1").replace(/'/g, "''");
function powershell(body: string) {
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `
    $ErrorActionPreference = 'Stop'
    . '${script}'
    ${body}
  `,
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
}

describe.skipIf(process.platform !== "win32")("installer preflight", () => {
  it("moves the complete old npm tree aside so obsolete nested modules cannot survive an upgrade", () => {
    powershell(`
      $testRoot = Join-Path ([IO.Path]::GetTempPath()) ('nexus-npm-upgrade-' + [Guid]::NewGuid())
      try {
        $nested = Join-Path $testRoot 'app\\node\\node_modules\\npm\\node_modules\\minipass-flush\\node_modules\\minipass'
        [IO.Directory]::CreateDirectory($nested) | Out-Null
        [IO.File]::WriteAllText((Join-Path $nested 'package.json'), '{"version":"3.3.6"}')
        [IO.File]::WriteAllText((Join-Path $testRoot 'app\\node\\node.exe'), 'keep-runtime')
        Move-NexusInstallerNpmAside -Path $testRoot
        if (Test-Path -LiteralPath (Join-Path $testRoot 'app\\node\\node_modules\\npm')) { throw 'Old npm still resolves' }
        if ([IO.File]::ReadAllText((Join-Path $testRoot 'app\\node\\node.exe')) -ne 'keep-runtime') { throw 'Node changed' }
        $backup = @(Get-ChildItem -LiteralPath (Join-Path $testRoot 'upgrade-runtime-backups') -Directory)[0].FullName
        if (!(Test-Path -LiteralPath (Join-Path $backup 'node_modules\\minipass-flush\\node_modules\\minipass\\package.json'))) { throw 'Old runtime not preserved' }
        Move-NexusInstallerNpmAside -Path $testRoot
      } finally {
        if ((Split-Path $testRoot -Parent) -ne ([IO.Path]::GetTempPath()).TrimEnd('\\')) { throw 'Unsafe test cleanup' }
        if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
      }
    `);
  });
  it("checkpoints stopped state and keys without touching application data", () => {
    powershell(`
      $testRoot = Join-Path ([IO.Path]::GetTempPath()) ('nexus-upgrade-' + [Guid]::NewGuid())
      try {
        $nexusDataRoot = Join-Path $testRoot 'existing-data'
        $service = Join-Path $testRoot 'app\\service'
        foreach ($folder in @($service, (Join-Path $nexusDataRoot 'state'), (Join-Path $nexusDataRoot 'keys'), (Join-Path $nexusDataRoot 'apps'))) { [IO.Directory]::CreateDirectory($folder) | Out-Null }
        [IO.File]::WriteAllText((Join-Path $service 'NexusServer.xml'), ('<service><env name="NEXUS_HOME" value="' + $nexusDataRoot + '"/></service>'))
        [IO.File]::WriteAllText((Join-Path $nexusDataRoot 'state\\nexus.db'), 'state-fixture')
        [IO.File]::WriteAllText((Join-Path $nexusDataRoot 'keys\\master.key'), 'key-fixture')
        [IO.File]::WriteAllText((Join-Path $nexusDataRoot 'apps\\keep.txt'), 'app-fixture')
        Save-NexusUpgradeCheckpoint -Path $testRoot
        $checkpoint = @(Get-ChildItem -LiteralPath (Join-Path $nexusDataRoot 'upgrade-checkpoints') -Directory)[0].FullName
        if ([IO.File]::ReadAllText((Join-Path $checkpoint 'state\\nexus.db')) -ne 'state-fixture') { throw 'State not preserved' }
        if ([IO.File]::ReadAllText((Join-Path $checkpoint 'keys\\master.key')) -ne 'key-fixture') { throw 'Keys not preserved' }
        if ([IO.File]::ReadAllText((Join-Path $nexusDataRoot 'apps\\keep.txt')) -ne 'app-fixture') { throw 'App data changed' }
        if (!(Get-Acl -LiteralPath $checkpoint).AreAccessRulesProtected) { throw 'Checkpoint permissions not restricted' }
      } finally {
        if ((Split-Path $testRoot -Parent) -ne ([IO.Path]::GetTempPath()).TrimEnd('\\')) { throw 'Unsafe test cleanup' }
        if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
      }
    `);
  });
  it("allows a fresh install but fails closed when service inspection fails", () => {
    powershell(`
      function Get-Service { throw [System.Management.Automation.ErrorRecord]::new(
        [Exception]::new('missing'), 'NoServiceFoundForGivenName', 'ObjectNotFound', $null) }
      Stop-NexusInstallerService
      function Get-Service { throw 'access denied' }
      $failed = $false
      try { Stop-NexusInstallerService } catch { $failed = $_.Exception.Message -eq 'access denied' }
      if (!$failed) { throw 'Service query errors must block installation' }
    `);
  });

  it("waits for shutdown and handles already stopped and pending services", () => {
    powershell(`
      $global:stops = 0
      $global:waits = 0
      $global:fakeService = [pscustomobject]@{ Status = 'Running' }
      $global:fakeService | Add-Member ScriptMethod Stop { $global:stops++ }
      $global:fakeService | Add-Member ScriptMethod WaitForStatus {
        param($status, $timeout)
        if ($status -ne 'Stopped' -or $timeout.TotalSeconds -ne 90) { throw 'Wrong shutdown deadline' }
        $global:waits++
      }
      function Get-Service { $global:fakeService }
      Stop-NexusInstallerService
      $global:fakeService.Status = 'StopPending'
      Stop-NexusInstallerService
      $global:fakeService.Status = 'Stopped'
      Stop-NexusInstallerService
      if ($global:stops -ne 1 -or $global:waits -ne 2) { throw 'Incorrect stop/wait sequence' }
      $global:fakeService.Status = 'Running'
      $global:fakeService | Add-Member ScriptMethod WaitForStatus { throw 'shutdown timed out' } -Force
      $failed = $false
      try { Stop-NexusInstallerService } catch { $failed = $true }
      if (!$failed) { throw 'A shutdown timeout must block installation' }
    `);
  });

  it("detects real file locks, releases probe handles, and preserves file contents", () => {
    powershell(`
      $testRoot = Join-Path ([IO.Path]::GetTempPath()) ('nexus-preflight-' + [Guid]::NewGuid())
      $lock = $null
      try {
        Assert-NexusInstallerFilesWritable -Path $testRoot -TimeoutSeconds 0
        [IO.Directory]::CreateDirectory($testRoot) | Out-Null
        $file = Join-Path $testRoot 'runtime.dll'
        [IO.File]::WriteAllText($file, 'unchanged')
        Assert-NexusInstallerFilesWritable -Path $testRoot -TimeoutSeconds 0
        $lock = [IO.File]::Open($file, 'Open', 'Read', 'Read')
        $failed = $false
        try { Assert-NexusInstallerFilesWritable -Path $testRoot -TimeoutSeconds 0 }
        catch { $failed = $_.Exception.Message.Contains('runtime.dll') }
        if (!$failed) { throw 'A locked file must block installation and identify the file' }
        $lock.Dispose()
        $lock = $null
        Assert-NexusInstallerFilesWritable -Path $testRoot -TimeoutSeconds 0
        if ([IO.File]::ReadAllText($file) -ne 'unchanged') { throw 'Probe changed file contents' }
      } finally {
        if ($null -ne $lock) { $lock.Dispose() }
        # The only recursive deletion is this newly created test directory.
        if ((Split-Path $testRoot -Parent) -ne ([IO.Path]::GetTempPath()).TrimEnd('\\')) { throw 'Unsafe test cleanup' }
        if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
      }
    `);
  });
});
