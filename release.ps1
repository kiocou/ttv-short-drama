<#
.SYNOPSIS
  TTV Short Drama 一键发布：检查 → 构建 → 发布到 GitHub Release。

.DESCRIPTION
  为什么需要这个脚本：这套流程里有四个坑，手工发布每次都要重踩一遍——

    1. **cargo 不在 PATH**（实际装在 C:\Program Files\Rust stable MSVC 1.96\bin），
       而且 TEMP/TMP 必须指到项目盘，否则链接阶段会报 "os error 5 / 拒绝访问"。
    2. **必须是 npm run tauri build**：它自动带上 tauri/custom-protocol 特性；
       手写 cargo build --release 产出的包启动后仍会去连 127.0.0.1:5175，
       表现为"无法访问此页面"。
    3. **GitHub Release 单文件上限 100 MB**：本项目的 MSI 恒在 105 MB 上下，
       **传不上去**；只有 NSIS 的 *-setup.exe（约 77 MB）能传。脚本会自动挑包。
    4. **release notes 应当等于 CHANGELOG 里该版本那一段**：手抄必然与正文脱节。
       脚本直接从 CHANGELOG 抽取。

  默认行为：四项检查 → 构建 → 抽 notes → gh release create（已存在则
  gh release upload --clobber 覆盖同名资产）。

.PARAMETER Version
  要发布的版本号（形如 0.2.8）。省略时从 src-tauri/tauri.conf.json 读取——
  那个文件是构建产物与 UI 展示的同一事实来源，避免"包里的版本和 tag 不一致"。

.PARAMETER SkipChecks
  跳过 tsc / fmt / clippy / test。只在明确知道自己在干什么时用（例如只改文档）。

.PARAMETER NoPublish
  只构建、不上传。想先本地验包时用。

.EXAMPLE
  pwsh -NoProfile -File release.ps1
.EXAMPLE
  pwsh -NoProfile -File release.ps1 -Version 0.2.9 -NoPublish
#>
[CmdletBinding()]
param(
    [string]$Version,
    [switch]$SkipChecks,
    [switch]$NoPublish
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location $root

# --- 项目已知环境事实（见 build.bat 的说明，不要改成"更通用"的写法）---
$CargoBin = 'C:\Program Files\Rust stable MSVC 1.96\bin'
$TmpDir = Join-Path $root '.tmp'
$nl = [Environment]::NewLine

function Write-Step([string]$text) { Write-Host (("==> " + $text)) -ForegroundColor Cyan }

# 1. 版本号与 tauri.conf.json 对齐
if (-not $Version) {
    $conf = Get-Content (Join-Path $root 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json
    $Version = $conf.version
}
$tag = "v$Version"
Write-Step "发布 $tag"

# 2. 工作区必须干净：否则打出来的包无法回溯到任何提交
$dirty = git status --porcelain
if ($dirty) {
    Write-Host "工作区有未提交的改动，先提交再发布：" -ForegroundColor Yellow
    $dirty | Select-Object -First 10 | ForEach-Object { Write-Host ("  " + $_) }
    throw "工作区不干净"
}
$commit = (git rev-parse --short HEAD).Trim()
Write-Host ("提交: " + $commit)

# 3. 检查（与 CI 同一套，见 AGENTS.md）
if (-not $SkipChecks) {
    $env:Path += ";$CargoBin"
    if (-not (Test-Path $TmpDir)) { New-Item -ItemType Directory -Path $TmpDir | Out-Null }
    $env:TEMP = $TmpDir
    $env:TMP = $TmpDir

    Write-Step 'npx tsc --noEmit'
    npx tsc --noEmit
    if ($LASTEXITCODE -ne 0) { throw 'tsc 失败' }

    Write-Step 'cargo fmt --check'
    cargo fmt --manifest-path src-tauri\Cargo.toml --check
    if ($LASTEXITCODE -ne 0) { throw 'fmt 未通过（跑 cargo fmt 修一下）' }

    Write-Step 'cargo clippy -D warnings'
    cargo clippy --manifest-path src-tauri\Cargo.toml --all-targets -- -D warnings
    if ($LASTEXITCODE -ne 0) { throw 'clippy 未通过' }

    Write-Step 'cargo test --bins'
    cargo test --manifest-path src-tauri\Cargo.toml --bins
    if ($LASTEXITCODE -ne 0) { throw '测试未通过' }
}

# 4. 构建
$env:Path += ";$CargoBin"
if (-not (Test-Path $TmpDir)) { New-Item -ItemType Directory -Path $TmpDir | Out-Null }
$env:TEMP = $TmpDir
$env:TMP = $TmpDir

Write-Step 'npx tauri build'
npx tauri build
if ($LASTEXITCODE -ne 0) { throw '构建失败' }

# 5. 挑包：GitHub Release 单文件上限 100 MB，MSI 超限只能留本地
$bundle = Join-Path $root 'src-tauri\target\release\bundle'
$setup = Get-ChildItem (Join-Path $bundle 'nsis\*-setup.exe') -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
$msi = Get-ChildItem (Join-Path $bundle 'msi\*.msi') -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1

if (-not $setup) { throw '没找到 NSIS 安装包' }
Write-Host ("NSIS: {0} ({1} MB)" -f $setup.Name, [math]::Round($setup.Length / 1MB, 1))
if ($msi) {
    Write-Host ("MSI : {0} ({1} MB) —— 超过 GitHub 100 MB 上限，仅保留本地" -f $msi.Name, [math]::Round($msi.Length / 1MB, 1))
}
$assets = @($setup.FullName)

# 6. release notes = CHANGELOG 里该版本那一段
Write-Step '从 CHANGELOG 抽取 release notes'
$changelog = Get-Content (Join-Path $root 'CHANGELOG.md') -Raw
$pattern = "(?ms)^##\s+" + [regex]::Escape($Version) + "\b.*?(?=^##\s|\z)"
$section = [regex]::Match($changelog, $pattern)
if (-not $section.Success) {
    Write-Host ("CHANGELOG 里没有 " + $Version + " 这一段，请先补写") -ForegroundColor Yellow
    throw '缺少 CHANGELOG 段落'
}
$notesPath = Join-Path $TmpDir ("release-notes-" + $tag + ".md")
# 用显式拼接 + WriteAllText，不要用 Set-Content 拼接字符串：
# 后者会把 header 与正文并成同一行，GitHub 上那一整行会被当成引用块，
# 版本标题不再渲染成标题（0.2.8 发布时踩过）。
$headerLine = "> 提交 " + $commit + " ｜ 产物：" + $setup.Name + "（NSIS, x64）"
$notesText = $headerLine + $nl + $nl + $section.Value.Trim() + $nl
[System.IO.File]::WriteAllText($notesPath, $notesText, (New-Object System.Text.UTF8Encoding($false)))
Write-Host ("notes: " + $notesPath)

if ($NoPublish) {
    Write-Step '已按要求跳过上传'
    return
}

# 7. 发布（幂等：已存在的 release 改为覆盖同名资产）
Write-Step ("发布到 GitHub Release " + $tag)
gh release view $tag *> $null
if ($LASTEXITCODE -eq 0) {
    Write-Host ("release " + $tag + " 已存在，覆盖资产")
    gh release upload $tag @assets --clobber
} else {
    gh release create $tag @assets --title ("TTV Short Drama " + $tag) --notes-file $notesPath
}
if ($LASTEXITCODE -ne 0) { throw 'GitHub Release 发布失败' }

Write-Host ("完成：https://github.com/kiocou/ttv-short-drama/releases/tag/" + $tag) -ForegroundColor Green
