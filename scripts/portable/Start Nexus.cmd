@echo off
rem Starts Nexus Portable and opens it in your browser.
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0nexus-portable.ps1" start
if errorlevel 1 (
  echo.
  echo Nexus Portable could not start. See the message above.
  pause
  exit /b 1
)
