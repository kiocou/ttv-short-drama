# ============================================================
#  ensure-integrity.ps1 — 确保项目目录的完整性标签是 Medium
#
#  为什么需要它：
#    某些沙箱工具（已知：Codex 的 CodexSandboxService.OpenAI.Codex）
#    会给工作目录打上 `Mandatory Label\Low Mandatory Level`。
#    Windows 的规则是「进程完整性 = min(父进程, 可执行文件)」，
#    所以 exe 一旦带上 Low 标签，**任何人启动它都是 Low 完整性**，
#    也就写不进 Medium 级别的 %LOCALAPPDATA%（日志、封面缓存、
#    VSR 转码分片、worker 下载全部失败），表现为：
#        播放一直缓冲 / 封面全空 / 日志不更新
#    而这个故障在 UI 上完全看不出原因，极易误判成代码 bug。
#
#  本脚本做两件事（均不需要管理员权限，目录属主即可）：
#    1) 检查项目根标签，是 Low 就恢复成 Medium 并开启继承；
#    2) 单独确认 exe 也是 Medium（防止它曾被显式设成 Low）。
#
#  退出码：0 = 正常或已修复；1 = 修复失败（需要人工介入）。
# ============================================================

$ErrorActionPreference = 'Continue'

# 让中文输出在 chcp 65001 的 cmd 窗口里正常显示
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$exe  = Join-Path $root 'src-tauri\target\debug\ttv-short-drama.exe'

function Get-IntegrityLabel {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $line = icacls $Path 2>&1 | Select-String -Pattern 'Mandatory Label' | Select-Object -First 1
    if (-not $line) { return $null }
    if ($line -match '(Low|Medium|High|System)\s+Mandatory\s+Level') { return $matches[1] }
    return 'Unknown'
}

function Set-Medium {
    param([string]$Path, [switch]$Recurse)
    if ($Recurse) {
        icacls $Path /setintegritylevel "(OI)(CI)M" 2>&1 | Out-Null
    } else {
        icacls $Path /setintegritylevel M 2>&1 | Out-Null
    }
}

$fixed = $false
$failed = $false

# ---- 1. 项目根 ----
$rootLabel = Get-IntegrityLabel $root
if ($rootLabel -eq $null) {
    Write-Host "[integrity] 项目根没有显式标签（等效 Medium），无需处理。"
} elseif ($rootLabel -ne 'Medium') {
    Write-Host "[integrity] 检测到项目根标签 = $rootLabel，正在恢复为 Medium ..."
    Set-Medium $root -Recurse
    $after = Get-IntegrityLabel $root
    if ($after -eq 'Medium') {
        Write-Host "[integrity] 已恢复：项目根 -> Medium（子项通过继承生效）"
        $fixed = $true
    } else {
        Write-Host "[integrity] 恢复失败：当前仍为 $after"
        $failed = $true
    }
} else {
    Write-Host "[integrity] 项目根 = Medium，正常。"
}

# ---- 2. exe（防显式 Low）----
if (Test-Path -LiteralPath $exe) {
    $exeLabel = Get-IntegrityLabel $exe
    if ($exeLabel -eq 'Low') {
        Write-Host "[integrity] exe 标签 = Low（显式设置），单独恢复 ..."
        Set-Medium $exe
        $exeAfter = Get-IntegrityLabel $exe
        if ($exeAfter -eq 'Medium') {
            Write-Host "[integrity] 已恢复：exe -> Medium"
            $fixed = $true
        } else {
            Write-Host "[integrity] exe 恢复失败：当前 $exeAfter"
            $failed = $true
        }
    } else {
        Write-Host "[integrity] exe = $exeLabel，正常。"
    }
} else {
    Write-Host "[integrity] 尚未构建 exe，跳过。"
}

if ($fixed) { Write-Host "[integrity] 本次已修复。若反复出现，见 修复权限.bat 里的说明。" }
if ($failed) { exit 1 }
exit 0
