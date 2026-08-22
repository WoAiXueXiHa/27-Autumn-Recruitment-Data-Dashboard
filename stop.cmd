@echo off
cd /d "%~dp0"
rem v10: stop only the Career War Room service on its configured local port.
py -3 app.py --stop >nul 2>nul
exit /b 0
