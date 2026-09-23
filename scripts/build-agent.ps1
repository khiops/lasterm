#Requires -Version 7.0
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "aarch64" } else { "x86_64" }
$env:LASTERM_TARGET_TRIPLE ??= "$arch-pc-windows-msvc"
$env:LASTERM_DIST_DIR ??= "$Root\dist\sea"
# The target directory: LASTERM_CARGO_TARGET_DIR, else the CARGO_TARGET_DIR
# plain cargo reads, else the repository's own; empty counts as unset. A relative
# one is relative to the repository, where cargo runs below (#531). It stays in
# this script: written to $env:, it would outlive the script in the session that
# ran it and hold a later build to this one's directory.
$cargoTargetDir = if ($env:LASTERM_CARGO_TARGET_DIR) { $env:LASTERM_CARGO_TARGET_DIR }
elseif ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR }
else { "$Root\target" }

Write-Host "🔨 Building Rust agent (triple: $env:LASTERM_TARGET_TRIPLE)..." -ForegroundColor Cyan

New-Item -ItemType Directory -Force -Path $env:LASTERM_DIST_DIR | Out-Null
Set-Location $Root
# Note: native build only (no --target). Cross-compilation would need --target.
# LASTERM_TARGET_TRIPLE is used for artifact naming and CI metadata.
cargo build --locked -p lasterm-agent --release --target-dir $cargoTargetDir
if ($LASTEXITCODE -ne 0) { throw "cargo build failed" }

$binary = "$cargoTargetDir\release\lasterm-agent.exe"
if (-not (Test-Path $binary)) { throw "Binary not found at $binary" }
Copy-Item $binary "$env:LASTERM_DIST_DIR\lasterm-agent.exe" -Force

$size = [math]::Round((Get-Item "$env:LASTERM_DIST_DIR\lasterm-agent.exe").Length / 1MB, 1)
Write-Host "✅ Rust agent built → $env:LASTERM_DIST_DIR\lasterm-agent.exe (${size}MB)" -ForegroundColor Green
