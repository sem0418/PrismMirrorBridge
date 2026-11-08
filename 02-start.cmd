@echo off
cd /d "%~dp0"
call run.cmd serve
if errorlevel 1 pause
