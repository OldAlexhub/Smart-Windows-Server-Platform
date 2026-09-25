/**
 * PowerShell probe run once per detection. Emits a single JSON document.
 * Kept as a TS string so it bundles into the service without extra files.
 * Every section is wrapped in try/catch so one failing CIM class never breaks detection.
 */
export const PROBE_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$r = [ordered]@{}
try {
  $os = Get-CimInstance Win32_OperatingSystem
  $cv = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
  $r.os = @{ caption = $os.Caption; version = $os.Version; build = $os.BuildNumber; arch = $os.OSArchitecture; edition = $cv.EditionID; displayVersion = $cv.DisplayVersion; freeMemKb = $os.FreePhysicalMemory }
} catch {}
try {
  $r.cpu = @(Get-CimInstance Win32_Processor | ForEach-Object { @{ name = $_.Name; manufacturer = $_.Manufacturer; cores = $_.NumberOfCores; threads = $_.NumberOfLogicalProcessors; mhz = $_.MaxClockSpeed; virt = $_.VirtualizationFirmwareEnabled } })
} catch {}
try {
  $cs = Get-CimInstance Win32_ComputerSystem
  $r.system = @{ totalMem = $cs.TotalPhysicalMemory; hypervisor = $cs.HypervisorPresent; model = $cs.Model; manufacturer = $cs.Manufacturer }
} catch {}
try {
  $phys = @{}
  Get-PhysicalDisk | ForEach-Object { $phys[[string]$_.DeviceId] = @{ media = [string]$_.MediaType; bus = [string]$_.BusType; name = $_.FriendlyName } }
  $r.volumes = @(Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DriveType -in 2,3 } | ForEach-Object {
    $letter = $_.DeviceID.TrimEnd(':')
    $diskNo = $null
    try { $diskNo = [string](Get-Partition -DriveLetter $letter -ErrorAction Stop | Select-Object -First 1).DiskNumber } catch {}
    $p = if ($diskNo -ne $null) { $phys[$diskNo] } else { $null }
    @{ id = $_.DeviceID; label = $_.VolumeName; fs = $_.FileSystem; size = $_.Size; free = $_.FreeSpace; driveType = $_.DriveType; media = $p.media; bus = $p.bus; model = $p.name }
  })
} catch {}
try {
  # AdapterRAM is a uint32 capped at 4 GB; the driver's registry key has the real 64-bit size.
  $mems = @{}
  Get-ChildItem 'HKLM:\SYSTEM\ControlSet001\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}' -ErrorAction SilentlyContinue | ForEach-Object {
    $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
    if ($p.DriverDesc -and $p.'HardwareInformation.qwMemorySize') { $mems[$p.DriverDesc] = [uint64]$p.'HardwareInformation.qwMemorySize' }
  }
  $r.gpus = @(Get-CimInstance Win32_VideoController | ForEach-Object {
    $q = $null; if ($mems.ContainsKey($_.Name)) { $q = $mems[$_.Name] }
    @{ name = $_.Name; vendor = $_.AdapterCompatibility; ram = $_.AdapterRAM; qwMem = $q; driver = $_.DriverVersion; pnp = $_.PNPDeviceID }
  })
} catch {}
$r | ConvertTo-Json -Depth 6 -Compress
`;
