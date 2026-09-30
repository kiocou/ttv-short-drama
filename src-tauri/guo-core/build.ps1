param(
    [string]$Output = "$PSScriptRoot\..\resources\guo-core\duanju_core.dll",
    [string]$GoExe = "go"
)

$ErrorActionPreference = "Stop"
$env:CGO_ENABLED = "1"

$gcc = Get-Command x86_64-w64-mingw32-gcc -ErrorAction SilentlyContinue
if ($null -eq $gcc) {
    $gcc = Get-Command gcc -ErrorAction SilentlyContinue
}
if ($null -eq $gcc) {
    throw "构建 guo-core 需要 MinGW-w64 的 gcc，并将其加入 PATH。"
}

$env:CC = $gcc.Source
New-Item -ItemType Directory -Force (Split-Path -Parent $Output) | Out-Null
& $GoExe build -trimpath -buildmode=c-shared -ldflags="-s -w -X duanjuapp/native/core.buildAllSources=true" -o $Output ./bridge
if ($LASTEXITCODE -ne 0) {
    throw "guo-core 编译失败。"
}
Write-Host "已生成 $Output"
