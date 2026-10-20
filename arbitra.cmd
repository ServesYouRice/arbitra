@echo off
rem Double-click to start arbitra: checks Node.js 22 or newer, installs, builds, opens http://127.0.0.1:4178.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tooling\launch\start.ps1"
if errorlevel 1 (
  echo.
  echo arbitra could not start. Copy the lines above and send them to whoever gave you arbitra.
  pause
)
