#Requires -Version 7.0
# Stop the lasterm dev servers dev-start.ps1 started, and nothing else.
# Usage: .\scripts\dev-stop.ps1 [-Target hub|agent|all]   (default: all)
param(
    [ValidateSet("hub", "agent", "all")]
    [string]$Target = "all"
)

$ErrorActionPreference = "Continue"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir
$LogDir = "$env:TEMP\lasterm-dev"
$PidFile = "$LogDir\dev.pid"
$AgentPidFile = "$LogDir\agent.pid"

# ── Helper: say who holds a port, without touching it ────────────────────────
# A port is not an identity: whatever still listens after the recorded tree
# is gone was not started here, and may be another application entirely (#173).
function Show-PortHolder([int]$port) {
    $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    foreach ($conn in $conns) {
        $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
        $name = if ($proc) { $proc.ProcessName } else { "unknown" }
        Write-Host "! Port $port is still held by PID $($conn.OwningProcess) ($name); left alone." -ForegroundColor Yellow
    }
}

# ── Stop hub + web ────────────────────────────────────────────────────────────
function Stop-Hub {
    if (Test-Path $PidFile) {
        $savedPid = [int](Get-Content $PidFile -Raw).Trim()
        $proc = Get-Process -Id $savedPid -ErrorAction SilentlyContinue
        if ($proc) {
            Write-Host "Stopping dev servers (PID $savedPid)..." -ForegroundColor DarkGray
            # The whole tree, not one level: pnpm -> concurrently -> pnpm -F ->
            # tsx watch -> node is five deep, and stopping direct children only
            # left the hub and its watcher running with no parent.
            taskkill /PID $savedPid /T /F *> $null
            Write-Host "Stopped."
        } else {
            Write-Host "Process $savedPid already dead." -ForegroundColor DarkGray
        }
        Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    } else {
        Write-Host "No PID file found: nothing started by dev-start.ps1 is recorded, so nothing is stopped." -ForegroundColor DarkGray
    }

    # The hub listens on a port the OS assigns; only Vite has a fixed one.
    Start-Sleep -Milliseconds 500
    Show-PortHolder 5173
}

# ── Stop agent daemon (named pipe) ───────────────────────────────────────────
function Stop-Agent {
    # Where dev-start built it: CARGO_TARGET_DIR when set, relative to the
    # repository as cargo reads it from there, else target\ (#541).
    $targetDir = if ($env:CARGO_TARGET_DIR) {
        if ([System.IO.Path]::IsPathRooted($env:CARGO_TARGET_DIR)) { $env:CARGO_TARGET_DIR }
        else { Join-Path $Root $env:CARGO_TARGET_DIR }
    } else { Join-Path $Root "target" }
    $agentBin = Join-Path $targetDir "release\lasterm-agent.exe"
    Remove-Item $AgentPidFile -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path $agentBin)) {
        Write-Host "No agent binary at $agentBin; nothing to stop with." -ForegroundColor DarkGray
        return
    }
    # The endpoint the hub resolves (#161). The agent checks its own identity
    # record before stopping, so neither a reused pid nor another lasterm-agent
    # (a desktop's, say) is ever signalled.
    Push-Location $Root
    $socket = (& pnpm exec tsx scripts/dev/paths.mts agent-socket | Out-String).Trim()
    Pop-Location
    & $agentBin --stop --socket $socket
    if ($LASTEXITCODE -eq 0) {
        Write-Host "v Agent stopped ($socket)" -ForegroundColor Green
    } else {
        Write-Host "Agent not stopped ($socket); see above." -ForegroundColor DarkGray
    }
}

# ── Dispatch ─────────────────────────────────────────────────────────────────
switch ($Target) {
    "hub"   { Stop-Hub }
    "agent" { Stop-Agent }
    "all"   { Stop-Hub; Stop-Agent }
}
