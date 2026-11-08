@echo off
setlocal
cd /d "%~dp0"
set "BRIDGE_NODE=%~dp0runtime\node.exe"
if not exist "%BRIDGE_NODE%" set "BRIDGE_NODE=node"
"%BRIDGE_NODE%" --test --test-concurrency=1 tests/*.test.mjs
pause
