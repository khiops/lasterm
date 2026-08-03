#Requires -Version 7.0
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "aarch64" } else { "x86_64" }
$env:TERMORA_TARGET_TRIPLE ??= "$arch-pc-windows-msvc"
$env:TERMORA_DIST_DIR ??= "$Root\dist\sea"
if (-not $env:TERMORA_BUILD_HASH) {
    $env:TERMORA_BUILD_HASH = (git -C $Root rev-parse --short=8 HEAD).Trim()
}
$env:TERMORA_SKIP_WEB ??= "false"
$env:TERMORA_CARGO_TARGET_DIR ??= "$Root\target"

Write-Host "🔨 Building hub SEA (triple: $env:TERMORA_TARGET_TRIPLE)..." -ForegroundColor Cyan

Set-Location $Root
pnpm -F @termora/shared build
if ($LASTEXITCODE -ne 0) { throw "shared build failed" }

cargo build -p termora-hub-lock --release --target $env:TERMORA_TARGET_TRIPLE --target-dir $env:TERMORA_CARGO_TARGET_DIR
if ($LASTEXITCODE -ne 0) { throw "termora-hub-lock build failed" }
$lockLibrary = Join-Path $env:TERMORA_CARGO_TARGET_DIR "$env:TERMORA_TARGET_TRIPLE\release\termora_hub_lock.dll"
if (-not (Test-Path $lockLibrary)) { throw "Hub lock addon not found at $lockLibrary" }
$env:TERMORA_HUB_LOCK_ADDON = $lockLibrary

if ($env:TERMORA_SKIP_WEB -ne "true") {
    Write-Host "  → Building web UI first..." -ForegroundColor DarkGray
    & "$ScriptDir\build-web.ps1"
    if ($LASTEXITCODE -ne 0) { throw "build-web.ps1 failed" }
}

pnpm run package:sea-hub
if ($LASTEXITCODE -ne 0) { throw "package:sea-hub failed" }

$binary = "$env:TERMORA_DIST_DIR\termora-hub.exe"
if (Test-Path $binary) {
    $size = [math]::Round((Get-Item $binary).Length / 1MB, 1)
    Write-Host "✅ Hub SEA built → $binary (${size}MB)" -ForegroundColor Green
}
