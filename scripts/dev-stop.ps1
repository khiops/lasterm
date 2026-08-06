#Requires -Version 7.0
# Stop lasterm dev servers and clean up orphan processes.
# Usage: .\scripts\dev-stop.ps1 [-Target hub|agent|all]   (default: all)
param(
    [ValidateSet("hub", "agent", "all")]
    [string]$Target = "all"
)

$ErrorActionPreference = "Continue"
$LogDir = "$env:TEMP\lasterm-dev"
$PidFile = "$LogDir\dev.pid"
$AgentPidFile = "$LogDir\agent.pid"

# ── Helper: kill process(es) listening on a port ─────────────────────────────
function Stop-PortProcess([int]$port) {
    $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    foreach ($conn in $conns) {
        $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
        if ($proc) {
            Write-Host "  Killing PID $($proc.Id) on port $port ($($proc.ProcessName))" -ForegroundColor DarkGray
            Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        }
    }
}

# ── Stop hub + web ────────────────────────────────────────────────────────────
function Stop-Hub {
    if (Test-Path $PidFile) {
        $savedPid = [int](Get-Content $PidFile -Raw).Trim()
        $proc = Get-Process -Id $savedPid -ErrorAction SilentlyContinue
        if ($proc) {
            Write-Host "Stopping dev servers (PID $savedPid)..." -ForegroundColor DarkGray
            # Kill the process tree
            $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $savedPid" -ErrorAction SilentlyContinue
            foreach ($child in $children) {
                Stop-Process -Id $child.ProcessId -Force -ErrorAction SilentlyContinue
            }
            Stop-Process -Id $savedPid -Force -ErrorAction SilentlyContinue
            Write-Host "Stopped."
        } else {
            Write-Host "Process $savedPid already dead." -ForegroundColor DarkGray
        }
        Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    } else {
        Write-Host "No PID file found -- cleaning up by port." -ForegroundColor DarkGray
    }

    Stop-PortProcess 4100
    Stop-PortProcess 5173

    Start-Sleep -Milliseconds 500
    $still4100 = Get-NetTCPConnection -LocalPort 4100 -State Listen -ErrorAction SilentlyContinue
    $still5173 = Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue

    if (-not $still4100 -and -not $still5173) {
        Write-Host "v Ports 4100 and 5173 are free." -ForegroundColor Green
    } else {
        if ($still4100) { Write-Host "! Port 4100 still in use" -ForegroundColor Yellow }
        if ($still5173) { Write-Host "! Port 5173 still in use" -ForegroundColor Yellow }
    }
}

# ── Stop agent daemon (named pipe) ───────────────────────────────────────────
function Stop-Agent {
    if (Test-Path $AgentPidFile) {
        $savedPid = [int](Get-Content $AgentPidFile -Raw).Trim()
        Stop-Process -Id $savedPid -Force -ErrorAction SilentlyContinue
        Remove-Item $AgentPidFile -Force -ErrorAction SilentlyContinue
        Write-Host "v Agent stopped (PID $savedPid)" -ForegroundColor Green
    } else {
        # Fallback: find lasterm-agent process by name
        $agents = Get-Process -Name "lasterm-agent" -ErrorAction SilentlyContinue
        if ($agents) {
            foreach ($a in $agents) {
                Stop-Process -Id $a.Id -Force -ErrorAction SilentlyContinue
                Write-Host "  Killed lasterm-agent PID $($a.Id)" -ForegroundColor DarkGray
            }
        } else {
            Write-Host "No agent daemon running." -ForegroundColor DarkGray
        }
    }
}

# ── Dispatch ─────────────────────────────────────────────────────────────────
switch ($Target) {
    "hub"   { Stop-Hub }
    "agent" { Stop-Agent }
    "all"   { Stop-Hub; Stop-Agent }
}
