#Requires -Version 7.0
# Run the built desktop app for UI tests, drivable over the Chrome DevTools
# Protocol with scripts/dev/ui/cdp.mjs.
#
#   .\scripts\dev\desktop-ui.ps1 [-Build] [-Port 9333]   (re)start it
#   .\scripts\dev\desktop-ui.ps1 -Stop                    stop it
#
# -Build rebuilds first with scripts/build-desktop.ps1, reusing the normal
# cache. The binaries then run from a copy in %LOCALAPPDATA%\lasterm-ui-test,
# never from target\release: an agent started there keeps its executable
# locked, and the next build fails to replace the sidecar ("access denied").
#
# It runs against the user's real profile, like an installed app. The agent is
# never stopped here: it holds the terminals, and a restarted hub reattaches
# them. The port must be free: another WebView2 app may already use 9222.
param(
	[switch]$Build,
	[switch]$Stop,
	[int]$Port = 9333
)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Release = Join-Path $Root "packages\clients\desktop\src-tauri\target\release"
$RunDir = Join-Path $env:LOCALAPPDATA "lasterm-ui-test"

function Stop-UiApp {
	# The desktop first: stopping only the hub would show the "hub stopped" dialog,
	# and stopping only the desktop would leave a hub holding the lock.
	foreach ($name in "lasterm-desktop.exe", "lasterm-hub.exe") {
		Get-CimInstance Win32_Process -Filter "Name='$name'" |
			Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($RunDir, [StringComparison]::OrdinalIgnoreCase) } |
			ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host "stopped $name ($($_.ProcessId))" }
		Start-Sleep -Milliseconds 500
	}
}

if ($Stop) { Stop-UiApp; return }

if ($Build) {
	& (Join-Path $Root "scripts\build-desktop.ps1")
	if ($LASTEXITCODE -ne 0) { throw "build-desktop.ps1 failed" }
}

$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listener) {
	$owner = (Get-Process -Id $listener[0].OwningProcess -ErrorAction SilentlyContinue).ProcessName
	if ($owner -notmatch "msedgewebview2") { throw "port $Port is held by $owner; pass -Port" }
}

Stop-UiApp
New-Item -ItemType Directory -Force $RunDir | Out-Null
foreach ($exe in "lasterm-desktop.exe", "lasterm-hub.exe", "lasterm-agent.exe") {
	$from = Join-Path $Release $exe
	if (-not (Test-Path $from)) { throw "$from is missing; run with -Build" }
	try {
		Copy-Item $from $RunDir -Force
	} catch {
		# A running agent of this copy keeps its file; the hub will use that agent.
		Write-Host "kept the running $exe"
	}
}

$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port"
Start-Process (Join-Path $RunDir "lasterm-desktop.exe")
$deadline = (Get-Date).AddSeconds(30)
do {
	Start-Sleep -Milliseconds 500
	$ready = node (Join-Path $PSScriptRoot "ui\cdp.mjs") --port $Port eval "document.readyState" 2>$null
} until ($ready -match "complete" -or (Get-Date) -gt $deadline)
if ($ready -notmatch "complete") { throw "the app did not expose its page on port $Port" }
Write-Host "Lasterm is up; drive it with: node scripts/dev/ui/cdp.mjs --port $Port eval|type|shot|watch ..."
