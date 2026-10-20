# auto-yes-cowork.plugin 을 만든다. 위험 명령 검사는 팀용 자동 Yes 의 것을 그대로 복사해 넣는다.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1
# NOTE: keep this file ASCII-only (Windows PowerShell 5.1 reads BOM-less .ps1 as ANSI).
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$stage = Join-Path $env:TEMP ('auto-yes-cowork-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $stage | Out-Null
Copy-Item (Join-Path $here '.claude-plugin') $stage -Recurse
Copy-Item (Join-Path $here 'hooks') $stage -Recurse
Copy-Item (Join-Path $here 'README.md') $stage
Copy-Item (Join-Path $here '..\auto-yes\auto-yes.js') (Join-Path $stage 'hooks\lib-auto-yes.js')
$dist = Join-Path $here 'dist'
New-Item -ItemType Directory -Force $dist | Out-Null
$version = (Get-Content (Join-Path $here '.claude-plugin\plugin.json') -Raw | ConvertFrom-Json).version
$zip = Join-Path $dist "auto-yes-cowork-$version.zip"
$plugin = Join-Path $dist "auto-yes-cowork-$version.plugin"
Remove-Item $zip, $plugin -ErrorAction SilentlyContinue
# Compress-Archive (PS 5.1) stores entry names with backslashes, which break on Linux
# (Cowork may unpack inside its Linux VM). Write the entries ourselves with '/'.
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$fs = [IO.File]::Open($plugin, 'Create')
$archive = New-Object IO.Compression.ZipArchive($fs, [IO.Compression.ZipArchiveMode]::Create)
Get-ChildItem $stage -Recurse -File | ForEach-Object {
  $name = $_.FullName.Substring($stage.Length + 1).Replace('\', '/')
  [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $_.FullName, $name) | Out-Null
}
$archive.Dispose(); $fs.Dispose()
Remove-Item $stage -Recurse -Force
Write-Host "built: $plugin"
