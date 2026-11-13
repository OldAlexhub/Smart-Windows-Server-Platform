# Nexus Portable: keep the complete extracted folder together, including data.
param([ValidateSet('start', 'stop')] [string]$Action = 'start', [switch]$NoBrowser, [ValidateRange(1024, 65535)][int]$Port = 7781)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$app = Join-Path $here 'app'
$data = Join-Path $here 'data'
$pidFile = Join-Path $data 'portable-server.pid'
$node = Join-Path $app 'node\node.exe'
$entry = Join-Path $app 'server\main.mjs'
$env:NODE_ENV = 'production'
$env:NEXUS_HOME = Join-Path $data 'nexus'
$env:NEXUS_DATA_ROOT = $data
$env:NEXUS_INSTALL_DIR = $app
$env:NEXUS_PORT = "$port"
$stopFile = Join-Path $env:NEXUS_HOME 'stop-request'
$env:NEXUS_STOP_FILE = $stopFile
$logDir = Join-Path $env:NEXUS_HOME 'logs'
$stderrLog = Join-Path $logDir 'startup-error.log'
$stdoutLog = Join-Path $logDir 'startup-output.log'

function Get-Server {
    if (!(Test-Path -LiteralPath $pidFile)) { return $null }
    $serverId = 0
    if (![int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(), [ref]$serverId) -or $serverId -le 0) { return $null }
    $server = Get-Process -Id $serverId -ErrorAction SilentlyContinue
    if (!$server -or $server.Path -ne $node) { return $null }
    # A stale PID must never authorize stopping another Node application.
    $details = Get-CimInstance Win32_Process -Filter "ProcessId=$serverId"
    if (!$details.CommandLine -or !$details.CommandLine.Contains($entry)) { return $null }
    return $server
}

function Test-Nexus {
    try {
        $health = Invoke-RestMethod "http://127.0.0.1:$port/api/v1/health" -TimeoutSec 2
        return $health.status -eq 'ok' -and $health.product -eq 'Nexus Server'
    } catch { return $false }
}

function Test-PortablePort {
    $client = New-Object Net.Sockets.TcpClient
    try {
        $connecting = $client.ConnectAsync('127.0.0.1', $port)
        return $connecting.Wait(1000) -and $client.Connected
    } catch { return $false }
    finally { $client.Dispose() }
}

try {
    $server = Get-Server
    if ($Action -eq 'stop') {
        if (!$server) {
            Write-Host "This copy of Nexus Portable isn't running."
            exit 0
        }
        Set-Content -LiteralPath $stopFile -Value 'stop'
        Write-Host 'Stopping Nexus Portable (applications and databases first)...'
        if (!$server.WaitForExit(90000)) {
            throw 'Shutdown is still in progress. Keep this folder and drive connected; try Stop Nexus again shortly.'
        }
        Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue
        Write-Host 'Nexus Portable stopped.'
        exit 0
    }

    foreach ($required in @($node, $entry, (Join-Path $app 'ui\index.html'), (Join-Path $here 'relocate-portable.mjs'), (Join-Path $here 'start-portable.mjs'))) {
        if (!(Test-Path -LiteralPath $required -PathType Leaf)) {
            throw "A required portable file is missing: $required`r`nExtract the entire NexusPortable.zip first, then open Start Nexus.cmd inside the extracted folder."
        }
    }
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    # Probe loopback directly: listener enumeration can omit processes in a
    # different Windows network compartment, even when their ports are reachable.
    if (!$server -and (Test-PortablePort)) {
        throw "Port $port belongs to another program or another portable copy. Stop that copy using its own Stop Nexus.cmd, then try again."
    }

    if (!$server) {
        & $node '--disable-warning=ExperimentalWarning' (Join-Path $here 'relocate-portable.mjs')
        if ($LASTEXITCODE -ne 0) { throw 'Portable storage could not be prepared. See the message above; your data has not been reset.' }
        # A leftover request from an interrupted stop must not stop a fresh launch.
        Remove-Item -LiteralPath $stopFile -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue
        Write-Host 'Starting Nexus Portable...'
        # Start-Process resolves these paths as PowerShell patterns, including its
        # working directory. Escape brackets in folder names before resolution.
        $launcher = Start-Process -FilePath ([Management.Automation.WildcardPattern]::Escape($node)) `
            -ArgumentList "`"$(Join-Path $here 'start-portable.mjs')`"" `
            -WorkingDirectory ([Management.Automation.WildcardPattern]::Escape($app)) -WindowStyle Hidden -PassThru
        if (!$launcher.WaitForExit(15000)) { throw "The portable launcher timed out. Check $stderrLog" }
        $server = Get-Server
        if (!$server) {
            Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue
            throw "Nexus stopped while starting. Details are saved in $stderrLog"
        }
    }

    $deadline = (Get-Date).AddSeconds(90)
    while ($true) {
        $server.Refresh()
        if ($server.HasExited) {
            Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue
            throw "Nexus stopped while starting. Details are saved in $stderrLog"
        }
        if (Test-Nexus) { break }
        if ((Get-Date) -gt $deadline) { throw "Nexus has not become ready yet. Check $stderrLog and $logDir\nexus.log, then try again." }
        Start-Sleep -Milliseconds 500
    }
    $token = (Get-Content -LiteralPath (Join-Path $env:NEXUS_HOME 'local-access.token') -Raw).Trim()
    if (!$token) { throw 'The local sign-in key is empty. Stop Nexus and start it again.' }
    if ($NoBrowser) { Write-Host "Nexus Portable is running at http://127.0.0.1:$port" }
    else { Start-Process "http://127.0.0.1:$port/?local=$token" }
    exit 0
} catch {
    Write-Host "Nexus Portable: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
