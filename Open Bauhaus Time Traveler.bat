@echo off
cd /d "%~dp0"
echo Starting Bauhaus Time Traveler...
echo The window can take about half a minute after a restart.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Open-Bauhaus-Chrome.ps1"
if errorlevel 1 (
  echo.
  echo The app did not start. You can close this window.
  pause
)
