@echo off
chcp 65001 >nul
title Claude Code Session Launcher
cd /d "%~dp0"

rem 이미 이 대시보드가 떠 있으면 두 번째 서버 대신 기존 화면만 연다.
powershell -NoProfile -Command "$ok=$false; foreach($u in @('http://127.0.0.1:7788/api/health','http://127.0.0.1:7788/')) { try { $r=Invoke-WebRequest -UseBasicParsing $u -TimeoutSec 2; if ($r.StatusCode -eq 200 -and $r.Content -match 'cc-launcher|AI 코딩 세션 런처') { $ok=$true; break } } catch {} }; if($ok){exit 0}else{exit 1}" >nul 2>nul
if not errorlevel 1 (
  echo Dashboard is already running. Opening the existing window...
  start "" "http://127.0.0.1:7788/"
  exit /b 0
)

if exist "node_modules\node-pty" goto serve
echo [setup] First run - installing dependencies (node-pty, ws) ...
call npm install --no-audit --no-fund
if errorlevel 1 goto failed

:serve
echo.
echo Press Ctrl+C to stop.
echo Closing this window with X may leave embedded AI processes running.
echo.
node server.js
pause
exit /b 0

:failed
echo [setup] npm install failed. Is Node.js installed and on PATH?
pause
exit /b 1
