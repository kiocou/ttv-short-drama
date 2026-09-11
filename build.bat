@echo off
REM ============================================================================
REM  TTV Short Drama - Rust 后端编译脚本
REM ============================================================================
REM  为什么要单独一个脚本
REM    1) cargo 不在 PATH 里，实际安装位置为：
REM         C:\Program Files\Rust stable MSVC 1.96\bin\cargo.exe
REM    2) 必须把 TEMP/TMP 指到 D:，否则 C: 满盘会导致
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

set "CARGO=C:\Program Files\Rust stable MSVC 1.96\bin\cargo.exe"

if not exist "%CARGO%" (
  echo [TTV] 错误：找不到 cargo: %CARGO%
  echo [TTV] 请检查 Rust 安装路径，并修改本脚本中的 CARGO 变量。
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
