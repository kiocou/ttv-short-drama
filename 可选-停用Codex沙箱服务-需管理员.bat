@echo off
chcp 936 >nul
title 停用 Codex 沙箱服务（需管理员）
echo ============================================================
echo  可选操作：停用 Codex 的 Windows 沙箱服务
echo.
echo  已确认的标签来源：CodexSandboxService.OpenAI.Codex
echo  它会在某些情况下给工作目录打 Low 完整性标签。
echo.
echo  你的 Codex 配置是 sandbox_mode = "danger-full-access"，
echo  本身并不需要这个沙箱服务；但停用它可能影响 Codex 的
echo  部分功能（例如 computer-use 的隔离执行）。
echo.
echo  停用后若发现 Codex 某些功能异常，可执行：
echo      sc config CodexSandboxService.OpenAI.Codex start= auto
echo      sc start  CodexSandboxService.OpenAI.Codex
echo ============================================================
echo.
net session >nul 2>&1
if errorlevel 1 (
  echo [需要管理员] 请右键本文件 -^> "以管理员身份运行"
  echo.
  pause
  exit /b 1
)
echo 正在停止并设为手动启动 ...
sc stop CodexSandboxService.OpenAI.Codex >nul 2>&1
sc config CodexSandboxService.OpenAI.Codex start= demand >nul 2>&1
sc query CodexSandboxService.OpenAI.Codex | findstr /i "STATE"
echo.
echo [完成] 服务已设为“手动”，不会随开机自启。
echo.
pause
