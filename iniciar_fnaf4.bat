@echo off
chcp 65001 >nul
cd /d "%~dp0"
start "" "%~dp0control_fnaf4.html"
node "%~dp0control_fnaf4_bridge.js"
pause
