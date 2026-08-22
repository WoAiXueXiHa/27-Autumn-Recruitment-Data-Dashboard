@echo off
rem v10: remove the Career War Room startup shortcut.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$p=Join-Path ([Environment]::GetFolderPath('Startup')) 'Career War Room.lnk'; if(Test-Path -LiteralPath $p){Remove-Item -LiteralPath $p -Force}"
echo Removed from Windows startup. Press any key to close.
pause >nul
