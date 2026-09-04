@echo off
chcp 65001 >nul
title Claude Code Session Launcher
cd /d "%~dp0"

if exist "node_modules\node-pty" goto serve
echo [setup] First run - installing dependencies (node-pty, ws) ...
call npm install --no-audit --no-fund
if errorlevel 1 goto failed

:serve
echo.
echo Press Ctrl+C to stop.
echo Closing this window with X may leave embedded claude processes running.
echo.
node server.js
pause
exit /b 0

:failed
echo [setup] npm install failed. Is Node.js installed and on PATH?
pause
exit /b 1
