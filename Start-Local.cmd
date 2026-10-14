@echo off
setlocal
cd /d "%~dp0"
if not exist "node_modules\vite\bin\vite.js" (
  echo Dependencies are missing. Install Node 22.12+ and run npm ci in this folder.
  pause
  exit /b 1
)
echo Starting Mermaid to Visio. Keep this window open while using the app.
call npm exec --yes --package=node@22 -- node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5173 --open
if errorlevel 1 pause