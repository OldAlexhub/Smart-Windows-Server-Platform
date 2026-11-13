@echo off
rem Stops Nexus Portable and the applications it runs.
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0nexus-portable.ps1" stop
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)
timeout /t 3 >nul
