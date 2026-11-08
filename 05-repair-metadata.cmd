@echo off
setlocal
cd /d "%~dp0"
echo Prism Mirror Bridge - repair metadata source state
echo Close ALL Prism processes first. This preserves the old meta folder as a backup.
echo It does not change accounts, instances, mod files, or certificate trust.
set "PRISM_CFG=%~1"
if defined PRISM_CFG goto selected
for /f "usebackq delims=" %%F in (`powershell -NoProfile -STA -Command "Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.OpenFileDialog; $d.Title='Select prismlauncher.cfg in the affected Prism data directory'; $d.Filter='Prism configuration (prismlauncher.cfg)^|prismlauncher.cfg'; $d.InitialDirectory=Join-Path $env:APPDATA 'PrismLauncher'; if ($d.ShowDialog() -eq 'OK') { $d.FileName }"`) do set "PRISM_CFG=%%F"
if not defined PRISM_CFG exit /b 1
:selected
call run.cmd repair-metadata --prism-config "%PRISM_CFG%"
if errorlevel 1 goto failed
echo Repair complete. Start the bridge, then reopen Prism and retry.
pause
exit /b 0
:failed
echo Repair stopped. Keep all metadata backups and read the error above.
pause
exit /b 1
