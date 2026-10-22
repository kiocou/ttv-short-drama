@echo off
chcp 936 >nul
title 修复完整性标签（Low -> Medium）
echo ============================================================
echo  检查并修复项目目录的完整性标签
echo.
echo  背景：某些沙箱工具会给工作目录打上 "Low Mandatory Level"。
echo  一旦被打上，exe 无论谁启动都是 Low 完整性，写不进
echo  %%LOCALAPPDATA%%（日志 / 封面缓存 / 转码分片全部失败），
echo  表现为：播放一直缓冲、封面全空、日志不更新。
echo.
echo  本脚本不需要管理员权限。
echo ============================================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\ensure-integrity.ps1"
echo.
if errorlevel 1 (
  echo [失败] 自动修复未成功，请把上面的输出发给开发者。
) else (
  echo [完成] 现在可以直接启动应用了。
)
echo.
pause
