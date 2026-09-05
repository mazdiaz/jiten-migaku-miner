@echo off
setlocal
cd /d "%~dp0"
where npm >nul 2>nul
if errorlevel 1 (
  echo Node.js/npm not found. Install Node.js 20 or newer.
  pause
  exit /b 1
)
where python >nul 2>nul
if errorlevel 1 (
  echo Python not found. Install Python 3 or newer.
  pause
  exit /b 1
)
call npm run build
if errorlevel 1 (
  echo Build failed. Fix reported errors before starting server.
  pause
  exit /b 1
)
start "" "http://127.0.0.1:8920/"
python -m http.server 8920 --bind 127.0.0.1 --directory dist
