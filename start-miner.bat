@echo off
setlocal
cd /d "%~dp0"
where npm >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.12 or newer is required.
  pause
  exit /b 1
)
if not exist .env.local (
  echo Copy .env.example to .env.local and configure PostgreSQL and GitHub login first.
  pause
  exit /b 1
)
call npm run build
if errorlevel 1 (
  pause
  exit /b 1
)
echo Open http://127.0.0.1:8920 after the server is ready.
call npm start
