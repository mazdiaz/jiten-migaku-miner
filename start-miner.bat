@echo off
rem Jiten Migaku Miner launcher - starts local server + opens page
cd /d "%~dp0"
where python >nul 2>nul
if %errorlevel% neq 0 (
  echo Python not found. Install from https://python.org or use Microsoft Store.
  pause
  exit /b 1
)
start "" "http://localhost:8920/jiten-migaku-miner-v1.html"
python -m http.server 8920 --bind 127.0.0.1
