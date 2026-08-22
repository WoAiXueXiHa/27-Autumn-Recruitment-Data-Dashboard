@echo off
rem v10: the startup shortcut uses start.cmd, which refreshes the latest service.
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$w=New-Object -ComObject WScript.Shell; $p=Join-Path ([Environment]::GetFolderPath('Startup')) 'Career War Room.lnk'; $s=$w.CreateShortcut($p); $s.TargetPath='%~dp0start.cmd'; $s.WorkingDirectory='%~dp0'; $s.Description='Career dashboard and reminders'; $s.Save()"
echo Added to Windows startup. Press any key to close.
pause >nul
