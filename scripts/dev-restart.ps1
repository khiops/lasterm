#Requires -Version 7.0
# Restart lasterm dev servers (stop + start).
# Usage: .\scripts\dev-restart.ps1 [-Target hub|agent|all]   (default: all)
param(
    [ValidateSet("hub", "agent", "all")]
    [string]$Target = "all"
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
& "$ScriptDir\dev-start.ps1" -Target $Target
