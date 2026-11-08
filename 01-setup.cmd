@echo off
setlocal
cd /d "%~dp0"
echo Prism Mirror Bridge - setup
echo This configures Prism and trusts this installation's local CA for the current Windows user.
echo Close Prism before continuing. Microsoft login traffic stays encrypted end to end.
powershell -NoProfile -Command "if (Get-Process -Name prismlauncher -ErrorAction SilentlyContinue) { exit 1 }"
if errorlevel 1 goto running
set "PRISM_CFG=%~1"
if defined PRISM_CFG goto selected
for /f "usebackq delims=" %%F in (`powershell -NoProfile -STA -Command "Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.OpenFileDialog; $d.Title='Select prismlauncher.cfg in the Prism data directory'; $d.Filter='Prism configuration (prismlauncher.cfg)^|prismlauncher.cfg'; $d.InitialDirectory=Join-Path $env:APPDATA 'PrismLauncher'; if ($d.ShowDialog() -eq 'OK') { $d.FileName }"`) do set "PRISM_CFG=%%F"
if not defined PRISM_CFG goto cancelled
:selected
call run.cmd init
if errorlevel 1 goto failed
call run.cmd configure --prism-config "%PRISM_CFG%"
if errorlevel 1 goto failed
call run.cmd trust-ca
if errorlevel 1 goto rollback
echo Setup complete. Run 02-start.cmd, then open Prism.
pause
exit /b 0
:rollback
call run.cmd restore --prism-config "%PRISM_CFG%"
goto failed
:running
echo Prism is still running. Close it and run this script again.
pause
exit /b 1
:cancelled
echo No configuration selected. No Prism settings were changed.
pause
exit /b 1
:failed
echo Setup failed. Read the error above.
pause
exit /b 1
