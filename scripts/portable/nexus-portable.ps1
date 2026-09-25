# Nexus Portable: runs Nexus from this folder, without installing anything.
# Everything (settings, applications, databases, files, backups) stays in the "data" folder next to it.
param([ValidateSet("start", "stop")] [string]$Action = "start", [switch]$NoBrowser)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$app = Join-Path $here "app"
$data = Join-Path $here "data"
$port = 7781   # the installed Nexus uses 7780, so both can run on one computer
$pidFile = Join-Path $data "portable-server.pid"

$env:NODE_ENV = "production"
$env:NEXUS_HOME = Join-Path $data "nexus"
$env:NEXUS_DATA_ROOT = $data
$env:NEXUS_INSTALL_DIR = $app
$env:NEXUS_PORT = "$port"
$stopFile = Join-Path $env:NEXUS_HOME "stop-request"
$env:NEXUS_STOP_FILE = $stopFile

function Test-Nexus {
  try { (Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$port/api/v1/health" -TimeoutSec 2).StatusCode -eq 200 } catch { $false }
}

function Get-Server {
  if (-not (Test-Path $pidFile)) { return $null }
  $p = Get-Process -Id ([int](Get-Content $pidFile)) -ErrorAction SilentlyContinue
  if ($p -and $p.Path -eq (Join-Path $app "node\node.exe")) { return $p }
  return $null
}

if ($Action -eq "stop") {
  $p = Get-Server
  if ($p) {
    # Ask for a clean shutdown: Nexus stops its applications, databases and gateway first.
    Set-Content -Path $stopFile -Value "stop"
    Write-Host "Stopping Nexus Portable (applications and databases first)..."
    if (-not $p.WaitForExit(90000)) { Stop-Process -Id $p.Id -Force }
    Remove-Item $pidFile -ErrorAction SilentlyContinue
    Write-Host "Nexus Portable stopped."
  } else {
    Write-Host "Nexus Portable isn't running."
  }
  exit 0
}

New-Item -ItemType Directory -Force -Path $env:NEXUS_HOME | Out-Null
if (-not (Test-Nexus)) {
  if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
    Write-Host "Port $port is used by another program. Close it and try again."
    Read-Host "Press Enter to close"
    exit 1
  }
  Write-Host "Starting Nexus Portable..."
  $p = Start-Process -FilePath (Join-Path $app "node\node.exe") `
    -ArgumentList "--enable-source-maps", "--disable-warning=ExperimentalWarning", "`"$(Join-Path $app 'server\main.mjs')`"" `
    -WorkingDirectory $app -WindowStyle Hidden -PassThru
  Set-Content -Path $pidFile -Value $p.Id
  $deadline = (Get-Date).AddSeconds(90)
  while (-not (Test-Nexus)) {
    if ($p.HasExited) { Write-Host "Nexus stopped while starting. See $($env:NEXUS_HOME)\logs\nexus.log"; Read-Host "Press Enter to close"; exit 1 }
    if ((Get-Date) -gt $deadline) { Write-Host "Nexus is taking long to start. Try again in a minute."; Read-Host "Press Enter to close"; exit 1 }
    Start-Sleep -Milliseconds 500
  }
}

# Sign in on this computer with the one-time local key (like the installed desktop app does).
$token = (Get-Content (Join-Path $env:NEXUS_HOME "local-access.token") -Raw).Trim()
if ($NoBrowser) { Write-Host "Nexus Portable is running at http://127.0.0.1:$port" } else { Start-Process "http://127.0.0.1:$port/?local=$token" }
