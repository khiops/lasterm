#Requires -Version 7.0
# Start lasterm dev servers in background with log capture.
# Usage: .\scripts\dev-start.ps1 [-Target hub|agent|all]   (default: all)
param(
    [ValidateSet("hub", "agent", "all")]
    [string]$Target = "all"
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir
$LogDir = "$env:TEMP\lasterm-dev"
$PidFile = "$LogDir\dev.pid"
$PipeName = "lasterm-agent-$env:USERNAME"
$PipePath = "\\.\pipe\$PipeName"
$HubStateDir = Join-Path $env:LOCALAPPDATA "lasterm"
$HubRuntimePath = Join-Path $HubStateDir "runtime.json"
$HubCertificatePath = Join-Path $HubStateDir "hub-tls-cert.pem"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# ── Start hub + web ──────────────────────────────────────────────────────────
function Start-Hub {
    Write-Host "Stopping existing hub + web..." -ForegroundColor DarkGray
    & "$ScriptDir\dev-stop.ps1" -Target hub

    # Build shared
    Write-Host "Building shared..." -ForegroundColor DarkGray
    Set-Location $Root
    pnpm -F @lasterm/shared build *> "$LogDir\shared-build.log"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "X Shared build failed. Log: $LogDir\shared-build.log" -ForegroundColor Red
        Get-Content "$LogDir\shared-build.log" -Tail 20
        exit 1
    }

    # Start hub + web (concurrently via pnpm dev)
    Write-Host "Starting hub + web..." -ForegroundColor DarkGray
    $proc = Start-Process -FilePath "pnpm" -ArgumentList "dev" `
        -WorkingDirectory $Root -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput "$LogDir\dev-stdout.log" `
        -RedirectStandardError "$LogDir\dev-stderr.log"
    $proc.Id | Out-File -FilePath $PidFile -Force

    # The shared probe verifies both certificate validation and the TLS peer's
    # recorded SPKI; a certificate bundle alone is not an identity assertion.
    Write-Host -NoNewline "Waiting for hub TLS listener"
    $hubOk = $false
    $hubPort = $null
    for ($i = 0; $i -lt 30; $i++) {
        if ((Test-Path $HubRuntimePath) -and (Test-Path $HubCertificatePath)) {
            try {
                $candidatePort = & pnpm exec tsx "$Root\scripts\dev\hub-health-probe.mts" 2>$null
                if ($LASTEXITCODE -eq 0 -and [int]$candidatePort -ge 1 -and [int]$candidatePort -le 65535) {
                    $hubPort = [int]$candidatePort
                    $hubOk = $true
                    break
                }
            } catch {
                # The runtime record may be mid-publication; retry.
            }
        }
        Write-Host -NoNewline "."
        Start-Sleep -Seconds 1
    }
    if (-not $hubOk) {
        Write-Host ""
        Write-Host "X Hub did not respond after 30s. Check $LogDir\dev-stderr.log" -ForegroundColor Red
        Get-Content "$LogDir\dev-stderr.log" -Tail 20 -ErrorAction SilentlyContinue
        exit 1
    }
    Write-Host " v"

    # Wait for Vite dev server (port 5173)
    Write-Host -NoNewline "Waiting for Vite on :5173"
    $viteOk = $false
    for ($i = 0; $i -lt 15; $i++) {
        $conn = Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue
        if ($conn) { $viteOk = $true; break }
        Write-Host -NoNewline "."
        Start-Sleep -Seconds 1
    }
    if ($viteOk) {
        Write-Host " v"
    } else {
        Write-Host ""
        Write-Host "! Vite not detected on :5173 (may still be starting)" -ForegroundColor Yellow
    }

    Write-Host ""
    Write-Host "Hub + web running (PID $($proc.Id))"
    Write-Host "  Hub:    https://127.0.0.1:$hubPort"
    Write-Host "  Web:    http://localhost:5173"
    Write-Host "  Logs:   $LogDir"
}

# ── Start agent daemon ───────────────────────────────────────────────────────
function Start-Agent {
    Write-Host "Stopping existing agent daemon..." -ForegroundColor DarkGray
    & "$ScriptDir\dev-stop.ps1" -Target agent

    # Build Rust agent
    Write-Host "Building Rust agent..." -ForegroundColor DarkGray
    Set-Location $Root
    cargo build -p lasterm-agent --release *> "$LogDir\agent-build.log"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "X Agent build failed. Log: $LogDir\agent-build.log" -ForegroundColor Red
        Get-Content "$LogDir\agent-build.log" -Tail 20
        exit 1
    }

    $agentBin = "$Root\target\release\lasterm-agent.exe"
    $proc = Start-Process -FilePath $agentBin `
        -ArgumentList "--daemon", "--socket", $PipePath, "--buffer-per-channel", "1048576", "--buffer-global", "20971520" `
        -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput "$LogDir\agent-stdout.log" `
        -RedirectStandardError "$LogDir\agent-stderr.log"
    $proc.Id | Out-File -FilePath "$LogDir\agent.pid" -Force

    # Wait for named pipe
    Write-Host -NoNewline "Waiting for agent pipe ($PipeName)"
    $pipeOk = $false
    for ($i = 0; $i -lt 10; $i++) {
        if (Test-Path $PipePath) { $pipeOk = $true; break }
        Write-Host -NoNewline "."
        Start-Sleep -Milliseconds 500
    }
    if (-not $pipeOk) {
        Write-Host ""
        Write-Host "X Agent pipe not found after 5s. Log: $LogDir\agent-stderr.log" -ForegroundColor Red
        Get-Content "$LogDir\agent-stderr.log" -Tail 20 -ErrorAction SilentlyContinue
        exit 1
    }
    Write-Host " v"
    Write-Host "  Agent:  running (pipe: $PipeName)"
}

# ── Summary helper ───────────────────────────────────────────────────────────
function Show-AgentStatus {
    if (Test-Path $PipePath) {
        Write-Host "  Agent:  running (pipe: $PipeName)"
    } else {
        Write-Host "  Agent:  not running (hub will auto-start on first connection)"
    }
}

# ── Dispatch ─────────────────────────────────────────────────────────────────
switch ($Target) {
    "hub" {
        Start-Hub
        Show-AgentStatus
        Write-Host ""
        Write-Host "Stop with:  .\scripts\dev-stop.ps1 -Target hub"
        Write-Host "Tail logs:  Get-Content $LogDir\dev-stdout.log -Wait"
    }
    "agent" {
        Start-Agent
        Write-Host ""
        Write-Host "Stop with:  .\scripts\dev-stop.ps1 -Target agent"
        Write-Host "Tail logs:  Get-Content $LogDir\agent-stdout.log -Wait"
    }
    "all" {
        Start-Hub
        Start-Agent
        Write-Host ""
        Write-Host "Stop with:  .\scripts\dev-stop.ps1"
        Write-Host "Tail logs:  Get-Content $LogDir\dev-stdout.log -Wait"
    }
}
