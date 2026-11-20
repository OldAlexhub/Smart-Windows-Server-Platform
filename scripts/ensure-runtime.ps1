# Runs inside the elevated installer, before any bundled native executable is started.
param([string]$AppDir)
$ErrorActionPreference = 'Stop'

function Invoke-NexusNativeProbe {
    param([string]$File)
    if (!(Test-Path -LiteralPath $File -PathType Leaf)) { throw "A required component is missing: $File" }
    if (!('NexusInstaller.NativeErrors' -as [type])) {
        Add-Type -TypeDefinition 'namespace NexusInstaller { public static class NativeErrors { [System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern uint SetErrorMode(uint mode); } }'
    }
    # Missing DLLs must produce a diagnosable exit, never an invisible modal dialog.
    $previousMode = [NexusInstaller.NativeErrors]::SetErrorMode(3)
    $probe = New-Object Diagnostics.Process
    try {
        $probe.StartInfo.FileName = $File
        $probe.StartInfo.Arguments = '--version'
        $probe.StartInfo.UseShellExecute = $false
        $probe.StartInfo.CreateNoWindow = $true
        $probe.StartInfo.RedirectStandardOutput = $true
        $probe.StartInfo.RedirectStandardError = $true
        if (!$probe.Start()) { throw "Could not start $File" }
        $stdout = $probe.StandardOutput.ReadToEndAsync()
        $stderr = $probe.StandardError.ReadToEndAsync()
        if (!$probe.WaitForExit(30000)) {
            $probe.Kill()
            throw "The component check timed out: $File"
        }
        $output = $stdout.Result + $stderr.Result
        if ($probe.ExitCode -ne 0) { throw "$File could not start (exit $($probe.ExitCode)). $output" }
        if ([string]::IsNullOrWhiteSpace($output)) { throw "The component did not return its version: $File" }
    } finally {
        $probe.Dispose()
        [void][NexusInstaller.NativeErrors]::SetErrorMode($previousMode)
    }
}

function Get-NexusRuntimePackage {
    param([string]$Path)
    $runtime = Join-Path $Path 'components\vc-runtime\14.52.37029.0\VC_redist.x64.exe'
    $expected = '9c02c9ed120f671b900e6b9471d890e3b2414117a7e53f4ae2e855466fa2b7c9'
    if (!(Test-Path -LiteralPath $runtime) -or (Get-FileHash -LiteralPath $runtime -Algorithm SHA256).Hash -ne $expected) {
        throw 'The bundled Windows runtime is missing or damaged. Download Nexus setup again.'
    }
    return $runtime
}

function Install-NexusRuntime {
    param([string]$Path, [string]$LogDir)
    $runtime = Get-NexusRuntimePackage -Path $Path
    $installed = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64' -ErrorAction SilentlyContinue
    $version = if ($installed -and $installed.Installed -eq 1 -and $installed.Version) { [version]$installed.Version.TrimStart('v') } else { [version]'0.0' }
    if ($version -gt [version]'14.52.37029.0') { return $false }
    $operation = if ($version -eq [version]'14.52.37029.0') { '/repair' } else { '/install' }
    [IO.Directory]::CreateDirectory($LogDir) | Out-Null
    $runtimeLog = Join-Path $LogDir 'windows-runtime.log'
    $process = Start-Process -FilePath ([Management.Automation.WildcardPattern]::Escape($runtime)) -ArgumentList "$operation /quiet /norestart /log `"$runtimeLog`"" -WindowStyle Hidden -PassThru
    if (!$process.WaitForExit(600000)) { throw 'Windows is still preparing a required component. Wait for it to finish, then run Nexus setup again.' }
    $code = $process.ExitCode
    $process.Dispose()
    if ($code -notin @(0, 1638, 3010)) { throw "Windows could not prepare a required component (exit $code). Details: $runtimeLog" }
    return ($code -eq 3010)
}

function Assert-NexusNativeComponents {
    param([string]$Path)
    [void](Get-NexusRuntimePackage -Path $Path)
    Invoke-NexusNativeProbe (Join-Path $Path 'node\node.exe')
    $postgres = @(Get-ChildItem -LiteralPath (Join-Path $Path 'components\postgresql') -Directory)
    if ($postgres.Count -eq 0) { throw 'The bundled database is missing. Download Nexus setup again.' }
    foreach ($version in $postgres) {
        foreach ($tool in @('initdb', 'postgres', 'pg_ctl', 'pg_dump', 'pg_restore')) {
            Invoke-NexusNativeProbe (Join-Path $version.FullName "bin\$tool.exe")
        }
        foreach ($file in @('share\postgres.bki', 'share\postgresql.conf.sample', 'lib\pg_stat_statements.dll')) {
            if (!(Test-Path -LiteralPath (Join-Path $version.FullName $file) -PathType Leaf)) { throw "A required database file is missing: $file" }
        }
    }
    $mongodb = @(Get-ChildItem -LiteralPath (Join-Path $Path 'components\mongodb') -Directory)
    if ($mongodb.Count -eq 0) { throw 'The bundled document database is missing. Download Nexus setup again.' }
    foreach ($version in $mongodb) {
        Invoke-NexusNativeProbe (Join-Path $version.FullName 'bin\mongod.exe')
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        if ([string]::IsNullOrWhiteSpace($AppDir)) { throw 'The application directory is required.' }
        $logDir = Join-Path $env:ProgramData 'Nexus\logs\setup'
        Write-Output 'Preparing required Windows components...'
        $restart = Install-NexusRuntime -Path $AppDir -LogDir $logDir
        Assert-NexusNativeComponents -Path $AppDir
        Write-Output 'The database and application runtime are ready.'
        if ($restart) { exit 3010 }
        exit 0
    } catch {
        Write-Output $_.Exception.Message
        if ($restart) { Write-Output 'Restart Windows, then run Nexus setup again to finish.' }
        exit 1
    }
}
