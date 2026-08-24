@echo off
cd /d "%~dp0"
rem v12: wait for the refreshed service, then open its confirmed version URL.
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0launch.ps1"
exit /b 0
