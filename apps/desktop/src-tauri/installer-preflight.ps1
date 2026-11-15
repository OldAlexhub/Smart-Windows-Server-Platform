# Runs from the installer's temporary directory, never from the runtime being replaced.
[CmdletBinding()]
param([string]$InstallDir)

$ErrorActionPreference = 'Stop'

function Stop-NexusInstallerService {
    try {
        $service = Get-Service -Name 'NexusServer' -ErrorAction Stop
    } catch {
        if ($_.FullyQualifiedErrorId -like 'NoServiceFoundForGivenName*') { return }
        throw
    }
    if ($service.Status -ne 'Stopped') {
        Write-Output 'Stopping the Nexus background service...'
        # Stop() sends the request without the unbounded wait of Stop-Service.
        if ($service.Status -ne 'StopPending') { $service.Stop() }
        $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(90))
    }
}

function Assert-NexusInstallerFilesWritable {
    param([Parameter(Mandatory)][string]$Path, [int]$TimeoutSeconds = 20)

    if (!(Test-Path -LiteralPath $Path)) { return }
    # Check every existing payload file: DLLs, native modules and runtime executables
    # can remain locked even after Windows reports that the service has stopped.
    $pending = @(Get-ChildItem -LiteralPath $Path -Recurse -File -Force -ErrorAction Stop)
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $blocked = @()
        foreach ($file in $pending) {
            $stream = $null
            try {
                $stream = [IO.File]::Open($file.FullName, 'Open', 'ReadWrite', 'None')
            } catch {
                $blocked += $file
            } finally {
                if ($null -ne $stream) { $stream.Dispose() }
            }
        }
        if ($blocked.Count -eq 0) { return }
        $pending = $blocked
        if ([DateTime]::UtcNow -ge $deadline) { break }
        Start-Sleep -Milliseconds 500
    } while ($true)
    $examples = ($blocked | Select-Object -First 5 -ExpandProperty FullName) -join "`r`n"
    throw "Nexus files are still in use or not writable ($($blocked.Count) files):`r`n$examples"
}

function Save-NexusUpgradeCheckpoint {
    param([Parameter(Mandatory)][string]$Path)
    $configFile = Join-Path $Path 'app\service\NexusServer.xml'
    if (!(Test-Path -LiteralPath $configFile)) { return }
    [xml]$config = [IO.File]::ReadAllText($configFile)
    $nexusDataRoot = @($config.service.env | Where-Object { $_.name -eq 'NEXUS_HOME' })[0].value
    if ([string]::IsNullOrWhiteSpace($nexusDataRoot) -or ![IO.Path]::IsPathRooted($nexusDataRoot)) {
        throw 'The existing service data location is invalid. Setup has preserved the previous installation.'
    }
    if (!(Test-Path -LiteralPath $nexusDataRoot)) { throw 'The existing Nexus data folder is unavailable. Reconnect its drive before updating.' }
    $checkpoint = Join-Path $nexusDataRoot ('upgrade-checkpoints\' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($checkpoint) | Out-Null
    # Restrict before copying: this checkpoint contains vault material and account state.
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544', [Security.Principal.WindowsIdentity]::GetCurrent().User.Value)) {
        $identity = New-Object Security.Principal.SecurityIdentifier($sid)
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $checkpoint -AclObject $acl
    foreach ($name in @('state', 'keys', 'desktop-users.txt')) {
        $source = Join-Path $nexusDataRoot $name
        if (!(Test-Path -LiteralPath $source)) { continue }
        $items = @((Get-Item -LiteralPath $source -Force))
        if ($items[0].PSIsContainer) { $items += @(Get-ChildItem -LiteralPath $source -Recurse -Force) }
        if (@($items | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) {
            throw 'Nexus state or keys contain a linked path. Setup stopped before replacing any files.'
        }
        Copy-Item -LiteralPath $source -Destination (Join-Path $checkpoint $name) -Recurse -Force
    }
    Copy-Item -LiteralPath $configFile -Destination (Join-Path $checkpoint 'NexusServer.xml')
    [IO.File]::WriteAllText((Join-Path $checkpoint 'README.txt'), "Pre-update Nexus state and keys. Not a backup of application databases or uploaded files. Restore only while Nexus is stopped, together with the matching Nexus version. Keep normal Nexus app backups for data recovery.")
    Write-Output ('Saved pre-update state and keys to ' + $checkpoint)
}

function Move-NexusInstallerNpmAside {
    param([Parameter(Mandatory)][string]$Path)
    # NSIS overwrites files but cannot remove obsolete nested modules. Keep the old npm
    # outside Node's resolution paths so extraction starts with a completely empty tree.
    $installRoot = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $source = [IO.Path]::GetFullPath((Join-Path $installRoot 'app\node\node_modules\npm'))
    if (!(Test-Path -LiteralPath $source)) { return }
    $backupRoot = [IO.Path]::GetFullPath((Join-Path $installRoot 'upgrade-runtime-backups'))
    $target = [IO.Path]::GetFullPath((Join-Path $backupRoot ('npm-' + [Guid]::NewGuid().ToString('N'))))
    foreach ($candidate in @($source, $target)) {
        if (!$candidate.StartsWith($installRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe npm replacement path.' }
    }
    foreach ($relative in @('', 'app', 'app\node', 'app\node\node_modules', 'app\node\node_modules\npm', 'upgrade-runtime-backups')) {
        $candidate = if ($relative) { Join-Path $installRoot $relative } else { $installRoot }
        if ((Test-Path -LiteralPath $candidate) -and ((Get-Item -LiteralPath $candidate -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'The npm runtime contains a linked path. Setup stopped before replacing it.'
        }
    }
    [IO.Directory]::CreateDirectory($backupRoot) | Out-Null
    Move-Item -LiteralPath $source -Destination $target -ErrorAction Stop
    Write-Output ('Preserved the previous npm runtime at ' + $target)
}

if ($MyInvocation.InvocationName -ne '.') {
    $resumeService = $false
    try {
        if ([string]::IsNullOrWhiteSpace($InstallDir)) { throw 'The installation directory is required.' }
        $resumeService = (Get-Service -Name 'NexusServer' -ErrorAction SilentlyContinue).Status -eq 'Running'
        Stop-NexusInstallerService
        Assert-NexusInstallerFilesWritable -Path (Join-Path $InstallDir 'app')
        Save-NexusUpgradeCheckpoint -Path $InstallDir
        Move-NexusInstallerNpmAside -Path $InstallDir
        Write-Output 'Nexus is stopped and its files are ready to be replaced.'
        exit 0
    } catch {
        Write-Output $_.Exception.Message
        if ($resumeService) {
            try { Start-Service -Name 'NexusServer' -ErrorAction Stop }
            catch { Write-Output ('Could not resume the previous service: ' + $_.Exception.Message) }
        }
        exit 1
    }
}
