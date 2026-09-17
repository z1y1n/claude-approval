@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Set NODE to a full path if node.exe is not on your PATH
set "NODE=node"
"%NODE%" toggle.cjs off
echo.
pause
