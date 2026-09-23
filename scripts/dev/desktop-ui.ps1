#Requires -Version 7.0
# Run the built desktop app for UI tests, drivable over the Chrome DevTools
# Protocol with scripts/dev/ui/cdp.mjs.
#
#   .\scripts\dev\desktop-ui.ps1 [-Build] [-Port 9333]   (re)start it
#   .\scripts\dev\desktop-ui.ps1 -Stop                    stop it
#
# -Build rebuilds first with scripts/build-desktop.ps1 -NoBundle, always in the
# same directory, target\desktop-ui\build, so cargo recompiles only what
# changed: a fresh directory would rerun every crate's build script, each a new
# executable for an antivirus to inspect. Both directories stay inside the
# repository, so a folder excluded from scanning for development covers them.
# The binaries then run from a copy in target\desktop-ui\bin, never from a
# build directory: an agent started there keeps its executable locked, and the
# next build fails to replace the sidecar ("access denied").
#
# It runs against the user's real profile, like an installed app. The agent is
# left running when it is the one just built: it holds the terminals, and a
# restarted hub reattaches them. A newly built agent does replace it — a
# running agent keeps its file, so the copy used to fail in silence and the hub
# went on spawning the old binary, which looks exactly like a fix that did not
# work. The port must be free: another WebView2 app may already use 9222.
param(
	[switch]$Build,
	[switch]$Stop,
	[int]$Port = 9333
)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$UiRoot = Join-Path $Root "target\desktop-ui"
$BuildDir = Join-Path $UiRoot "build"
$Release = Join-Path $BuildDir "release"
$RunDir = Join-Path $UiRoot "bin"

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
	# Only the Tauri build goes to $BuildDir. The agent and the hub keep the
	# directory they build in otherwise: their scripts take it from
	# LASTERM_CARGO_TARGET_DIR before CARGO_TARGET_DIR (#531), so it is pinned
	# there before CARGO_TARGET_DIR moves. Both are put back afterwards.
	$saved = @{
		CARGO_TARGET_DIR = $env:CARGO_TARGET_DIR
		LASTERM_CARGO_TARGET_DIR = $env:LASTERM_CARGO_TARGET_DIR
	}
	$env:LASTERM_CARGO_TARGET_DIR = if ($env:LASTERM_CARGO_TARGET_DIR) { $env:LASTERM_CARGO_TARGET_DIR }
	elseif ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR }
	else { Join-Path $Root "target" }
	$env:CARGO_TARGET_DIR = $BuildDir
	try {
		& (Join-Path $Root "scripts\build-desktop.ps1") -NoBundle
		if ($LASTEXITCODE -ne 0) { throw "build-desktop.ps1 failed" }
	} finally {
		# Assigning $null removes the variable, as it was when unset.
		$env:CARGO_TARGET_DIR = $saved.CARGO_TARGET_DIR
		$env:LASTERM_CARGO_TARGET_DIR = $saved.LASTERM_CARGO_TARGET_DIR
	}
}

$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listener) {
	$owner = (Get-Process -Id $listener[0].OwningProcess -ErrorAction SilentlyContinue).ProcessName
	if ($owner -notmatch "msedgewebview2") { throw "port $Port is held by $owner; pass -Port" }
}

function Get-RunningFromRunDir([string]$name) {
	Get-CimInstance Win32_Process -Filter "Name='$name'" |
		Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($RunDir, [StringComparison]::OrdinalIgnoreCase) }
}

# Stop the running agent so the one just built can take its place. Its
# terminals end with it: that is the price of testing the agent you built.
function Stop-RunningAgent {
	$running = Get-RunningFromRunDir "lasterm-agent.exe"
	if (-not $running) { return }
	Write-Host "replacing the running agent with the one just built; its terminals end here"
	$running | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
	for ($i = 0; $i -lt 40; $i++) {
		Start-Sleep -Milliseconds 250
		if (-not (Get-RunningFromRunDir "lasterm-agent.exe")) { return }
	}
	Write-Host "the agent did not stop; keeping the one that runs"
}

Stop-UiApp
New-Item -ItemType Directory -Force $RunDir | Out-Null
foreach ($exe in "lasterm-desktop.exe", "lasterm-hub.exe", "lasterm-agent.exe") {
	$from = Join-Path $Release $exe
	if (-not (Test-Path $from)) { throw "$from is missing; run with -Build" }
	$to = Join-Path $RunDir $exe
	$newer = -not (Test-Path $to) -or (Get-Item $from).LastWriteTimeUtc -gt (Get-Item $to).LastWriteTimeUtc
	if ($exe -eq "lasterm-agent.exe" -and $newer) { Stop-RunningAgent }
	try {
		Copy-Item $from $RunDir -Force
	} catch {
		# A running agent of this copy keeps its file. Reaching here means it is
		# the same build, or it refused to stop: either way the hub uses it.
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
