@echo off
REM ============================================================================
REM  TTV Short Drama - Rust 后端编译脚本
REM ============================================================================
REM  为什么要单独一个脚本
REM    1) cargo 可能不在 PATH 里（Rust 安装时可以选"不加入 PATH"）。
REM       脚本按 TTV_CARGO → PATH 的顺序查找。
REM    2) 必须把 TEMP/TMP 指到项目盘，否则系统盘满盘会导致
REM       "os error 5 / 拒绝访问" 之类的链接失败。
REM    3) 不要设置 CARGO_TARGET_DIR 到项目根下的新目录
REM       （实测会触发同样的 os error 5）；用默认的 src-tauri\target 即可。
REM ============================================================================

setlocal

set "PROJ=%~dp0"
set "TMPDIR=%PROJ%.tmp"
if not exist "%TMPDIR%" mkdir "%TMPDIR%"

set "TEMP=%TMPDIR%"
set "TMP=%TMPDIR%"

set "CARGO="
if defined TTV_CARGO set "CARGO=%TTV_CARGO%"
if not defined CARGO for /f "delims=" %%i in ('where cargo 2^>nul') do if not defined CARGO set "CARGO=%%i"

if not defined CARGO (
  echo [TTV] 错误：找不到 cargo。
  echo [TTV] 请把 Rust 的 bin 目录加入 PATH，或设 TTV_CARGO 指向 cargo.exe。
  pause
  exit /b 1
)

if not exist "%CARGO%" (
  echo [TTV] 错误：找不到 cargo: %CARGO%
  echo [TTV] 请检查 TTV_CARGO 指向的路径。
  pause
  exit /b 1
)

echo [TTV] cargo = %CARGO%
echo [TTV] TEMP  = %TEMP%
echo [TTV] 开始编译（debug）...
echo.

pushd "%PROJ%src-tauri"
"%CARGO%" build --message-format short
set "RC=%ERRORLEVEL%"
popd

echo.
if "%RC%"=="0" (
  echo [TTV] 编译成功。
  echo [TTV] 产物：%PROJ%src-tauri\target\debug\ttv-short-drama.exe
) else (
  echo [TTV] 编译失败，退出码 %RC%。
)
pause
endlocal
exit /b %RC%
