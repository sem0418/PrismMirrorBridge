@echo off
setlocal
cd /d "%~dp0"
echo Prism Mirror Bridge - restore original Prism network settings
powershell -NoProfile -Command "if (Get-Process -Name prismlauncher -ErrorAction SilentlyContinue) { exit 1 }"
if errorlevel 1 goto running
set "PRISM_CFG=%~1"
if defined PRISM_CFG goto selected
for /f "usebackq delims=" %%F in (`powershell -NoProfile -STA -Command "Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.OpenFileDialog; $d.Title='Select the same prismlauncher.cfg'; $d.Filter='Prism configuration (prismlauncher.cfg)^|prismlauncher.cfg'; $d.InitialDirectory=Join-Path $env:APPDATA 'PrismLauncher'; if ($d.ShowDialog() -eq 'OK') { $d.FileName }"`) do set "PRISM_CFG=%%F"
if not defined PRISM_CFG exit /b 1
:selected
call run.cmd restore --prism-config "%PRISM_CFG%"
if errorlevel 1 goto failed
call run.cmd untrust-ca
if errorlevel 1 goto failed
echo Original settings restored and this installation's CA trust removed.
pause
exit /b 0
:running
echo Close Prism first.
pause
exit /b 1
:failed
echo Restore failed. Read the error above.
pause
exit /b 1
