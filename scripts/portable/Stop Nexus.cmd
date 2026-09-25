@echo off
rem Stops Nexus Portable and the applications it runs.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0nexus-portable.ps1" stop
timeout /t 3 >nul
