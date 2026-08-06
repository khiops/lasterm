#Requires -Version 7.0
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir
if (-not $env:LASTERM_BUILD_HASH) {
    $env:LASTERM_BUILD_HASH = (git -C $Root rev-parse --short=8 HEAD).Trim()
}

Write-Host "🔨 Building web UI (hash: $env:LASTERM_BUILD_HASH)..." -ForegroundColor Cyan

Set-Location $Root
pnpm -F @lasterm/shared build
if ($LASTEXITCODE -ne 0) { throw "shared build failed" }
# LASTERM_BUILD_HASH is already set in process env — pnpm inherits it
pnpm -F @lasterm/web build
if ($LASTEXITCODE -ne 0) { throw "web build failed" }
node scripts/embed-web.js
if ($LASTEXITCODE -ne 0) { throw "embed-web.js failed" }

Write-Host "✅ Web built → packages\hub\static\" -ForegroundColor Green
