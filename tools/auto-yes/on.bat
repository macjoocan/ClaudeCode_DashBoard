@echo off
chcp 65001 >nul
where node >nul 2>nul || (echo Node.js is required: https://nodejs.org & pause & exit /b 1)
node "%~dp0auto-yes.js" on
ping -n 3 127.0.0.1 >nul
