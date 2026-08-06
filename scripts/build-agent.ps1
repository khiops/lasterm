#Requires -Version 7.0
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "aarch64" } else { "x86_64" }
$env:LASTERM_TARGET_TRIPLE ??= "$arch-pc-windows-msvc"
$env:LASTERM_DIST_DIR ??= "$Root\dist\sea"
$env:LASTERM_CARGO_TARGET_DIR ??= "$Root\target"

Write-Host "🔨 Building Rust agent (triple: $env:LASTERM_TARGET_TRIPLE)..." -ForegroundColor Cyan

New-Item -ItemType Directory -Force -Path $env:LASTERM_DIST_DIR | Out-Null
Set-Location $Root
# Note: native build only (no --target). Cross-compilation would need --target.
# LASTERM_TARGET_TRIPLE is used for artifact naming and CI metadata.
cargo build -p lasterm-agent --release --target-dir $env:LASTERM_CARGO_TARGET_DIR
if ($LASTEXITCODE -ne 0) { throw "cargo build failed" }

$binary = "$env:LASTERM_CARGO_TARGET_DIR\release\lasterm-agent.exe"
if (-not (Test-Path $binary)) { throw "Binary not found at $binary" }
Copy-Item $binary "$env:LASTERM_DIST_DIR\lasterm-agent.exe" -Force

$size = [math]::Round((Get-Item "$env:LASTERM_DIST_DIR\lasterm-agent.exe").Length / 1MB, 1)
Write-Host "✅ Rust agent built → $env:LASTERM_DIST_DIR\lasterm-agent.exe (${size}MB)" -ForegroundColor Green
