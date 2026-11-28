#Requires -Version 7.0
# File Explorer's "Open in lasterm" command (#1236): the x64 COM server the MSIX
# package registers. Writes dist\sea\lasterm_explorer_command.dll, which
# pack-msix.ps1 takes from src-tauri.
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir

$env:LASTERM_DIST_DIR ??= "$Root\dist\sea"
# The target directory, as build-agent.ps1 chooses it: LASTERM_CARGO_TARGET_DIR,
# else CARGO_TARGET_DIR, else the repository's own; empty counts as unset.
$cargoTargetDir = if ($env:LASTERM_CARGO_TARGET_DIR) { $env:LASTERM_CARGO_TARGET_DIR }
elseif ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR }
else { "$Root\target" }
# Explorer loads an extension of its own architecture, and the package is x64.
$triple = "x86_64-pc-windows-msvc"

Write-Host "🔨 Building File Explorer's command ($triple)..." -ForegroundColor Cyan

New-Item -ItemType Directory -Force -Path $env:LASTERM_DIST_DIR | Out-Null
Set-Location $Root
cargo build --locked --release -p lasterm-explorer-command --target $triple --target-dir $cargoTargetDir
if ($LASTEXITCODE -ne 0) { throw "cargo build failed" }

$library = "$cargoTargetDir\$triple\release\lasterm_explorer_command.dll"
if (-not (Test-Path $library)) { throw "Library not found at $library" }
Copy-Item $library "$env:LASTERM_DIST_DIR\lasterm_explorer_command.dll" -Force

Write-Host "✅ File Explorer's command built → $env:LASTERM_DIST_DIR\lasterm_explorer_command.dll" -ForegroundColor Green
