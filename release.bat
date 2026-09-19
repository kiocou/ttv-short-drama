@echo off
REM TTV Short Drama - 一键发布（包装 release.ps1，方便双击）
REM 用法：release.bat [版本号]   例如 release.bat 0.2.9
setlocal
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0release.ps1" %*
echo.
pause
