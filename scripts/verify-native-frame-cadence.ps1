$ErrorActionPreference = 'Stop'
$project = Join-Path $PSScriptRoot '..\src-tauri\native-player\FrameCadenceTests\FrameCadenceTests.csproj'
& dotnet run --project $project --configuration Release
if ($LASTEXITCODE -ne 0) { throw 'NativePlayer cadence checks failed.' }
