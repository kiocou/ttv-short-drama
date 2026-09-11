@echo off
REM ============================================================================
REM  TTV Short Drama - C: 盘满盘环境下的启动脚本
REM ============================================================================
REM  背景
REM    本机系统盘 C:（卷标「日常系统」）剩余空间为 0 字节。这会导致两类故障：
REM
REM    1) 窗口整片纯黑
REM       WebView2 默认把 GPU / 着色器 / user-data 缓存写在 C:。
REM       没有可用空间时合成管线初始化失败 —— HTML/CSS 其实已加载，
REM       但内容不会被光栅化到窗口表面，表现为纯黑。
REM
REM    2) 启动即崩 / 编译失败
REM       cargo 的 TEMP 与 Tauri 的 app_data_dir() 都落在 C:，
REM       SQLite 建库会以 "disk I/O error" 让 setup 钩子 panic；
REM       cargo 链接阶段也会报 "os error 5 / 拒绝访问"。
REM
REM  对策
REM    把所有临时目录与运行期数据目录全部落到 D:（有 190GB+ 富余），
REM    并关闭 WebView2 的 GPU 合成走软件光栅。
REM
REM  用法
REM    先确保 C: 至少有几百 MB（清一下临时目录），然后双击本脚本。
REM    应用代码已在 main.rs 里内置了同样的兜底逻辑。
REM ============================================================================

setlocal

set "PROJ=%~dp0"
set "TMPDIR=%PROJ%.tmp"
if not exist "%TMPDIR%" mkdir "%TMPDIR%"

REM --- 构建链临时目录迁到项目盘 ---
set "TEMP=%TMPDIR%"
set "TMP=%TMPDIR%"

REM --- WebView2：软件光栅 + 数据目录落到项目盘 ---
set "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--disable-gpu-compositing"
set "WEBVIEW2_USER_DATA_FOLDER=%PROJ%.webview-data"

set "NODE=D:\Program Files\nodejs\node.exe"
set "VITE=%PROJ%node_modules\vite\bin\vite.js"
set "EXE=%PROJ%src-tauri\target\debug\ttv-short-drama.exe"

echo [TTV] TEMP        = %TEMP%
echo [TTV] WEBVIEW2    = %WEBVIEW2_USER_DATA_FOLDER%
echo [TTV] 说明：若 exe 不存在或源码有改动，请先执行 build.bat 重新编译。
echo.

REM --- 1. 启动前端 dev server（5175）---
echo [TTV] 启动 Vite (127.0.0.1:5175) ...
start "TTV Vite" /min "%NODE%" "%VITE%" --host 127.0.0.1 --port 5175 --strictPort

REM --- 2. 等端口就绪 ---
set /a TRIES=0
:WAITVITE
set /a TRIES+=1
>nul 2>&1 powershell -NoProfile -Command "if ((Test-NetConnection 127.0.0.1 -Port 5175 -InformationLevel Quiet)) { exit 0 } else { exit 1 }"
if errorlevel 1 (
  if %TRIES% GEQ 30 (
    echo [TTV] 警告：5175 端口 30 秒内未就绪，仍继续尝试启动应用。
    goto LAUNCH
  )
  timeout /t 1 /nobreak >nul
  goto WAITVITE
)

:LAUNCH
echo [TTV] 启动 Tauri 应用 ...
if not exist "%EXE%" (
  echo [TTV] 错误：找不到 %EXE%
  echo [TTV] 请先运行 build.bat 编译。
  pause
  exit /b 1
)
start "" "%EXE%"

echo [TTV] 已启动。关闭 Vite 窗口即可停止前端服务。
endlocal
