@echo off
rem Starts Held Open on Windows. Double-click this file.
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo Python was not found. Install it from https://www.python.org/downloads/ and run this again.
  pause
  exit /b 1
)
python server\server.py
pause
