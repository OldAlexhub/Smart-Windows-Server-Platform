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

if ($MyInvocation.InvocationName -ne '.') {
    try {
        if ([string]::IsNullOrWhiteSpace($InstallDir)) { throw 'The installation directory is required.' }
        Stop-NexusInstallerService
        Assert-NexusInstallerFilesWritable -Path (Join-Path $InstallDir 'app')
        Write-Output 'Nexus is stopped and its files are ready to be replaced.'
        exit 0
    } catch {
        Write-Output $_.Exception.Message
        exit 1
    }
}
