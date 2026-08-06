# Build Matrix Refactoring — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify build scripts as single source of truth for local and CI builds, add Windows dev support, clean up dead Node agent code.

**Architecture:** Per-component build scripts (.sh for Linux/macOS, .ps1 for Windows) called by CI workflows. A JSON build matrix controls which platforms are enabled. Orchestrator scripts compose component scripts for desktop builds.

**Tech Stack:** bash, PowerShell 7, GitHub Actions, pnpm, cargo, esbuild, Node SEA, Tauri v2

**Spec:** `docs/superpowers/specs/2026-03-23-build-matrix-design.md`

---

## File Map

### New Files

| File | Responsibility |
|------|---------------|
| `scripts/build-web.sh` | Build web UI + embed manifest (Linux/macOS) |
| `scripts/build-web.ps1` | Build web UI + embed manifest (Windows) |
| `scripts/build-agent.sh` | Build Rust agent binary (Linux/macOS) |
| `scripts/build-agent.ps1` | Build Rust agent binary (Windows) |
| `scripts/build-hub.sh` | Build hub SEA binary (Linux/macOS) |
| `scripts/build-hub.ps1` | Build hub SEA binary (Windows) |
| `scripts/build-desktop.sh` | Orchestrator: web + agent + hub + Tauri (Linux/macOS) |
| `scripts/build-desktop.ps1` | Orchestrator: web + agent + hub + Tauri (Windows) |
| `scripts/dev-start.ps1` | Start dev servers (Windows) |
| `scripts/dev-stop.ps1` | Stop dev servers (Windows) |
| `scripts/dev-restart.ps1` | Restart dev servers (Windows) |
| `.github/build-matrix.json` | Platform toggle matrix for CI |

### Modified Files

| File | Change |
|------|--------|
| `scripts/dev-start.sh` | Switch from Node agent to Rust agent daemon |
| `scripts/dev-stop.sh` | Update agent cleanup for Rust daemon |
| `scripts/package-sea-hub.ts` | Read `LASTERM_*` env vars |
| `scripts/build-sea-binary.ts` | Read `LASTERM_NODE_VERSION` env var |
| `.github/workflows/build.yml` | Rewrite: matrix-driven, calls scripts |
| `.github/workflows/release.yml` | Update artifact download patterns |
| `package.json` (root) | Remove dead scripts, update build:desktop |
| `pnpm-workspace.yaml` | Remove node-pty, agent-only catalog entries |
| `packages/clients/desktop/src-tauri/tauri.conf.json` | Empty `beforeBuildCommand` |

### Deleted Files

| File | Reason |
|------|--------|
| `packages/agent/` | Entire directory — replaced by Rust agent |
| `scripts/package-sea-agent.ts` | No more Node SEA agent |
| `scripts/build-sea-agent.ts` | No more Node SEA agent |
| `scripts/rename-sea-binaries.sh` | Superseded by per-component naming |
| `scripts/prepare-desktop.sh` | Replaced by `build-desktop.sh` |
| `scripts/build-desktop-windows.ps1` | Replaced by `build-desktop.ps1` |
| `.github/workflows/rust-agent.yml` | Merged into `build.yml` |

---

## Shared Preamble (for all .sh scripts)

All `.sh` build scripts share this preamble. Reference it — don't duplicate in each task.

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Auto-detect target triple
ARCH=$(uname -m)
case "$(uname -s)" in
  Linux)  DETECTED_TRIPLE="${ARCH}-unknown-linux-gnu" ;;
  Darwin) DETECTED_TRIPLE="${ARCH}-apple-darwin" ;;
  *)      echo "❌ Unsupported OS. Use .ps1 on Windows." >&2; exit 1 ;;
esac

LASTERM_TARGET_TRIPLE="${LASTERM_TARGET_TRIPLE:-$DETECTED_TRIPLE}"
LASTERM_DIST_DIR="${LASTERM_DIST_DIR:-$ROOT/dist/sea}"
LASTERM_BUILD_HASH="${LASTERM_BUILD_HASH:-$(git -C "$ROOT" rev-parse --short=8 HEAD)}"

mkdir -p "$LASTERM_DIST_DIR"
```

## Shared Preamble (for all .ps1 build scripts)

```powershell
#Requires -Version 7.0
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir

# Auto-detect target triple
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "aarch64" } else { "x86_64" }
$env:LASTERM_TARGET_TRIPLE ??= "$arch-pc-windows-msvc"
$env:LASTERM_DIST_DIR ??= "$Root\dist\sea"
if (-not $env:LASTERM_BUILD_HASH) {
    $env:LASTERM_BUILD_HASH = (git -C $Root rev-parse --short=8 HEAD).Trim()
}

New-Item -ItemType Directory -Force -Path $env:LASTERM_DIST_DIR | Out-Null
```

---

## Task 1: build-web.sh + build-web.ps1

**Files:**
- Create: `scripts/build-web.sh`
- Create: `scripts/build-web.ps1`

- [ ] **Step 1: Create build-web.sh**

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LASTERM_BUILD_HASH="${LASTERM_BUILD_HASH:-$(git -C "$ROOT" rev-parse --short=8 HEAD)}"

echo "🔨 Building web UI (hash: $LASTERM_BUILD_HASH)..."

cd "$ROOT"
pnpm -F @lasterm/shared build
LASTERM_BUILD_HASH="$LASTERM_BUILD_HASH" pnpm -F @lasterm/web build
node scripts/embed-web.js

echo "✅ Web built → packages/hub/static/"
```

Run: `chmod +x scripts/build-web.sh`

- [ ] **Step 2: Create build-web.ps1**

```powershell
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
# LASTERM_BUILD_HASH is already set in process env — pnpm inherits it
pnpm -F @lasterm/web build
node scripts/embed-web.js

Write-Host "✅ Web built → packages\hub\static\" -ForegroundColor Green
```

- [ ] **Step 3: Verify locally (Linux)**

Run: `./scripts/build-web.sh`
Expected: Web build completes, `packages/hub/static/` populated with files.

- [ ] **Step 4: Commit**

```bash
git add scripts/build-web.sh scripts/build-web.ps1
git commit -m "feat(scripts): add build-web.sh/.ps1 — unified web build script"
```

---

## Task 2: build-agent.sh + build-agent.ps1

**Files:**
- Create: `scripts/build-agent.sh`
- Create: `scripts/build-agent.ps1`

- [ ] **Step 1: Create build-agent.sh**

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Auto-detect target triple
ARCH=$(uname -m)
case "$(uname -s)" in
  Linux)  DETECTED_TRIPLE="${ARCH}-unknown-linux-gnu" ;;
  Darwin) DETECTED_TRIPLE="${ARCH}-apple-darwin" ;;
  *)      echo "❌ Unsupported OS. Use .ps1 on Windows." >&2; exit 1 ;;
esac

LASTERM_TARGET_TRIPLE="${LASTERM_TARGET_TRIPLE:-$DETECTED_TRIPLE}"
LASTERM_DIST_DIR="${LASTERM_DIST_DIR:-$ROOT/dist/sea}"
LASTERM_CARGO_TARGET_DIR="${LASTERM_CARGO_TARGET_DIR:-$ROOT/target}"

echo "🔨 Building Rust agent (triple: $LASTERM_TARGET_TRIPLE)..."

mkdir -p "$LASTERM_DIST_DIR"
cd "$ROOT"
# Note: native build only (no --target). Cross-compilation would need --target $LASTERM_TARGET_TRIPLE.
# LASTERM_TARGET_TRIPLE is used for artifact naming and CI metadata.
cargo build -p lasterm-agent --release --target-dir "$LASTERM_CARGO_TARGET_DIR"

# Copy binary to dist
BINARY="$LASTERM_CARGO_TARGET_DIR/release/lasterm-agent"
if [ ! -f "$BINARY" ]; then
  echo "❌ Binary not found at $BINARY" >&2
  exit 1
fi
cp "$BINARY" "$LASTERM_DIST_DIR/lasterm-agent"
chmod +x "$LASTERM_DIST_DIR/lasterm-agent"

SIZE=$(du -h "$LASTERM_DIST_DIR/lasterm-agent" | cut -f1)
echo "✅ Rust agent built → $LASTERM_DIST_DIR/lasterm-agent ($SIZE)"
```

Run: `chmod +x scripts/build-agent.sh`

- [ ] **Step 2: Create build-agent.ps1**

```powershell
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
cargo build -p lasterm-agent --release --target-dir $env:LASTERM_CARGO_TARGET_DIR
if ($LASTEXITCODE -ne 0) { throw "cargo build failed" }

$binary = "$env:LASTERM_CARGO_TARGET_DIR\release\lasterm-agent.exe"
if (-not (Test-Path $binary)) { throw "Binary not found at $binary" }
Copy-Item $binary "$env:LASTERM_DIST_DIR\lasterm-agent.exe" -Force

$size = [math]::Round((Get-Item "$env:LASTERM_DIST_DIR\lasterm-agent.exe").Length / 1MB, 1)
Write-Host "✅ Rust agent built → $env:LASTERM_DIST_DIR\lasterm-agent.exe (${size}MB)" -ForegroundColor Green
```

- [ ] **Step 3: Verify locally (Linux)**

Run: `./scripts/build-agent.sh`
Expected: `dist/sea/lasterm-agent` exists, is executable.

- [ ] **Step 4: Commit**

```bash
git add scripts/build-agent.sh scripts/build-agent.ps1
git commit -m "feat(scripts): add build-agent.sh/.ps1 — unified Rust agent build script"
```

---

## Task 3: Env var support in TS scripts

**Files:**
- Modify: `scripts/package-sea-hub.ts`
- Modify: `scripts/build-sea-binary.ts`

- [ ] **Step 1: Add triple-to-Node helpers in `package-sea-hub.ts`**

Add at the top of the file (after imports):

```typescript
function tripleToNodePlatform(triple: string | undefined): NodeJS.Platform | undefined {
  if (!triple) return undefined;
  if (triple.includes('linux')) return 'linux';
  if (triple.includes('windows') || triple.includes('win32')) return 'win32';
  if (triple.includes('apple') || triple.includes('darwin')) return 'darwin';
  return undefined;
}

function tripleToNodeArch(triple: string | undefined): string | undefined {
  if (!triple) return undefined;
  if (triple.startsWith('x86_64') || triple.startsWith('x64')) return 'x64';
  if (triple.startsWith('aarch64') || triple.startsWith('arm64')) return 'arm64';
  return undefined;
}
```

- [ ] **Step 2: Replace hardcoded values with env var reads in `package-sea-hub.ts`**

Find where `process.platform`, `process.arch`, and output paths are used. Add env var overrides:

```typescript
// Near the top, after CLI arg parsing
const effectivePlatform = tripleToNodePlatform(process.env.LASTERM_TARGET_TRIPLE)
  ?? targetPlatformArg
  ?? process.platform;
const effectiveArch = tripleToNodeArch(process.env.LASTERM_TARGET_TRIPLE)
  ?? targetArchArg
  ?? process.arch;
const effectiveNodeVersion = process.env.LASTERM_NODE_VERSION
  ?? targetNodeVersionArg
  ?? process.version;
const distDir = process.env.LASTERM_DIST_DIR ?? join(root, 'dist', 'sea');
```

Use `effectivePlatform`, `effectiveArch`, `effectiveNodeVersion`, `distDir` throughout.

- [ ] **Step 3: Add `LASTERM_NODE_VERSION` support in `build-sea-binary.ts`**

In the `buildSeaBinary` function, add fallback:

```typescript
const targetNodeVersion = cfg.targetNodeVersion
  ?? process.env.LASTERM_NODE_VERSION
  ?? process.version;
```

- [ ] **Step 4: Verify hub SEA still builds**

Run: `pnpm run package:sea-hub`
Expected: Hub SEA binary produced in `dist/sea/lasterm-hub`.

- [ ] **Step 5: Verify env var override works**

Run: `LASTERM_DIST_DIR=/tmp/test-sea pnpm run package:sea-hub`
Expected: Hub SEA binary produced in `/tmp/test-sea/lasterm-hub`.

- [ ] **Step 6: Commit**

```bash
git add scripts/package-sea-hub.ts scripts/build-sea-binary.ts
git commit -m "feat(scripts): add LASTERM_* env var support to SEA packaging scripts"
```

---

## Task 4: build-hub.sh + build-hub.ps1

**Files:**
- Create: `scripts/build-hub.sh`
- Create: `scripts/build-hub.ps1`

Depends on: Task 3 (env vars in TS scripts)

- [ ] **Step 1: Create build-hub.sh**

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Auto-detect
ARCH=$(uname -m)
case "$(uname -s)" in
  Linux)  DETECTED_TRIPLE="${ARCH}-unknown-linux-gnu" ;;
  Darwin) DETECTED_TRIPLE="${ARCH}-apple-darwin" ;;
  *)      echo "❌ Unsupported OS. Use .ps1 on Windows." >&2; exit 1 ;;
esac

LASTERM_TARGET_TRIPLE="${LASTERM_TARGET_TRIPLE:-$DETECTED_TRIPLE}"
LASTERM_DIST_DIR="${LASTERM_DIST_DIR:-$ROOT/dist/sea}"
LASTERM_BUILD_HASH="${LASTERM_BUILD_HASH:-$(git -C "$ROOT" rev-parse --short=8 HEAD)}"
LASTERM_SKIP_WEB="${LASTERM_SKIP_WEB:-false}"

echo "🔨 Building hub SEA (triple: $LASTERM_TARGET_TRIPLE)..."

cd "$ROOT"
pnpm -F @lasterm/shared build

if [ "$LASTERM_SKIP_WEB" != "true" ]; then
  echo "  → Building web UI first..."
  "$SCRIPT_DIR/build-web.sh"
fi

export LASTERM_TARGET_TRIPLE LASTERM_DIST_DIR LASTERM_BUILD_HASH
# Also export LASTERM_NODE_VERSION if set (for cross-build Node version override)
[ -n "${LASTERM_NODE_VERSION:-}" ] && export LASTERM_NODE_VERSION
pnpm run package:sea-hub

SIZE=$(du -h "$LASTERM_DIST_DIR/lasterm-hub" 2>/dev/null | cut -f1 || echo "?")
echo "✅ Hub SEA built → $LASTERM_DIST_DIR/lasterm-hub ($SIZE)"
```

Run: `chmod +x scripts/build-hub.sh`

- [ ] **Step 2: Create build-hub.ps1**

```powershell
#Requires -Version 7.0
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "aarch64" } else { "x86_64" }
$env:LASTERM_TARGET_TRIPLE ??= "$arch-pc-windows-msvc"
$env:LASTERM_DIST_DIR ??= "$Root\dist\sea"
if (-not $env:LASTERM_BUILD_HASH) {
    $env:LASTERM_BUILD_HASH = (git -C $Root rev-parse --short=8 HEAD).Trim()
}
$env:LASTERM_SKIP_WEB ??= "false"

Write-Host "🔨 Building hub SEA (triple: $env:LASTERM_TARGET_TRIPLE)..." -ForegroundColor Cyan

Set-Location $Root
pnpm -F @lasterm/shared build

if ($env:LASTERM_SKIP_WEB -ne "true") {
    Write-Host "  → Building web UI first..." -ForegroundColor DarkGray
    & "$ScriptDir\build-web.ps1"
}

pnpm run package:sea-hub
if ($LASTEXITCODE -ne 0) { throw "package:sea-hub failed" }

$binary = "$env:LASTERM_DIST_DIR\lasterm-hub.exe"
if (Test-Path $binary) {
    $size = [math]::Round((Get-Item $binary).Length / 1MB, 1)
    Write-Host "✅ Hub SEA built → $binary (${size}MB)" -ForegroundColor Green
}
```

- [ ] **Step 3: Verify locally**

Run: `./scripts/build-hub.sh`
Expected: Hub SEA binary in `dist/sea/lasterm-hub`.

Run: `LASTERM_SKIP_WEB=true ./scripts/build-hub.sh`
Expected: Skips web build (must have been built before).

- [ ] **Step 4: Commit**

```bash
git add scripts/build-hub.sh scripts/build-hub.ps1
git commit -m "feat(scripts): add build-hub.sh/.ps1 — unified hub SEA build script"
```

---

## Task 5: build-desktop.sh + build-desktop.ps1 (orchestrator)

**Files:**
- Create: `scripts/build-desktop.sh`
- Create: `scripts/build-desktop.ps1`

Depends on: Tasks 1, 2, 4

- [ ] **Step 1: Create build-desktop.sh**

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Auto-detect
ARCH=$(uname -m)
case "$(uname -s)" in
  Linux)  DETECTED_TRIPLE="${ARCH}-unknown-linux-gnu" ;;
  Darwin) DETECTED_TRIPLE="${ARCH}-apple-darwin" ;;
  *)      echo "❌ Unsupported OS. Use .ps1 on Windows." >&2; exit 1 ;;
esac

LASTERM_TARGET_TRIPLE="${LASTERM_TARGET_TRIPLE:-$DETECTED_TRIPLE}"
LASTERM_DIST_DIR="${LASTERM_DIST_DIR:-$ROOT/dist/sea}"
TAURI_DIR="$ROOT/packages/clients/desktop/src-tauri"

echo "🔨 Building desktop (triple: $LASTERM_TARGET_TRIPLE)..."
echo ""

# Step 1: Web
echo "━━━ [1/4] Web UI ━━━"
"$SCRIPT_DIR/build-web.sh"
echo ""

# Step 2: Agent
echo "━━━ [2/4] Rust Agent ━━━"
"$SCRIPT_DIR/build-agent.sh"
echo ""

# Step 3: Hub (skip web, already built)
echo "━━━ [3/4] Hub SEA ━━━"
LASTERM_SKIP_WEB=true "$SCRIPT_DIR/build-hub.sh"
echo ""

# Step 4: Place sidecars and build Tauri
echo "━━━ [4/4] Tauri Desktop ━━━"

# .sh = Linux/macOS only — no .exe extension needed
cp "$LASTERM_DIST_DIR/lasterm-agent" "$TAURI_DIR/lasterm-agent-${LASTERM_TARGET_TRIPLE}"
cp "$LASTERM_DIST_DIR/lasterm-hub" "$TAURI_DIR/lasterm-hub-${LASTERM_TARGET_TRIPLE}"

echo "  → Sidecars placed in src-tauri/"

cd "$ROOT"
pnpm -F @lasterm/desktop tauri build \
  --config '{"build":{"beforeBuildCommand":""}}'

echo ""
echo "✅ Desktop built for $LASTERM_TARGET_TRIPLE"
```

Run: `chmod +x scripts/build-desktop.sh`

- [ ] **Step 2: Create build-desktop.ps1**

```powershell
#Requires -Version 7.0
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "aarch64" } else { "x86_64" }
$env:LASTERM_TARGET_TRIPLE ??= "$arch-pc-windows-msvc"
$env:LASTERM_DIST_DIR ??= "$Root\dist\sea"
$tauriDir = "$Root\packages\clients\desktop\src-tauri"

Write-Host "🔨 Building desktop (triple: $env:LASTERM_TARGET_TRIPLE)..." -ForegroundColor Cyan
Write-Host ""

# Step 1: Web
Write-Host "━━━ [1/4] Web UI ━━━" -ForegroundColor Yellow
& "$ScriptDir\build-web.ps1"
Write-Host ""

# Step 2: Agent
Write-Host "━━━ [2/4] Rust Agent ━━━" -ForegroundColor Yellow
& "$ScriptDir\build-agent.ps1"
Write-Host ""

# Step 3: Hub (skip web, already built)
Write-Host "━━━ [3/4] Hub SEA ━━━" -ForegroundColor Yellow
$env:LASTERM_SKIP_WEB = "true"
& "$ScriptDir\build-hub.ps1"
$env:LASTERM_SKIP_WEB = $null
Write-Host ""

# Step 4: Place sidecars and build Tauri
Write-Host "━━━ [4/4] Tauri Desktop ━━━" -ForegroundColor Yellow

$triple = $env:LASTERM_TARGET_TRIPLE
Copy-Item "$env:LASTERM_DIST_DIR\lasterm-agent.exe" "$tauriDir\lasterm-agent-$triple.exe" -Force
Copy-Item "$env:LASTERM_DIST_DIR\lasterm-hub.exe" "$tauriDir\lasterm-hub-$triple.exe" -Force

Write-Host "  → Sidecars placed in src-tauri/" -ForegroundColor DarkGray

Set-Location $Root
pnpm -F @lasterm/desktop tauri build --config '{\"build\":{\"beforeBuildCommand\":\"\"}}'
if ($LASTEXITCODE -ne 0) { throw "tauri build failed" }

Write-Host ""
Write-Host "✅ Desktop built for $triple" -ForegroundColor Green
```

- [ ] **Step 3: Commit**

```bash
git add scripts/build-desktop.sh scripts/build-desktop.ps1
git commit -m "feat(scripts): add build-desktop.sh/.ps1 — unified desktop orchestrator"
```

---

## Task 6: Dev scripts (Windows)

**Files:**
- Modify: `scripts/dev-start.sh` (switch to Rust agent)
- Modify: `scripts/dev-stop.sh` (update agent cleanup)
- Create: `scripts/dev-start.ps1`
- Create: `scripts/dev-stop.ps1`
- Create: `scripts/dev-restart.ps1`

- [ ] **Step 1: Update dev-start.sh — switch agent from Node to Rust**

In `start_agent()` function, replace:
```bash
# OLD: Node agent
pnpm -F @lasterm/agent build > $LOG_DIR/agent-build.log 2>&1
AGENT_BIN=$ROOT/packages/agent/dist/main.js
setsid node $AGENT_BIN --daemon --socket $AGENT_SOCK ...
```

With:
```bash
# NEW: Rust agent
echo "  Building Rust agent..."
cargo build -p lasterm-agent --release > "$LOG_DIR/agent-build.log" 2>&1
AGENT_BIN="$ROOT/target/release/lasterm-agent"
setsid "$AGENT_BIN" --daemon --socket "$AGENT_SOCK" \
  --buffer-per-channel 1048576 --buffer-global 20971520 \
  > "$LOG_DIR/agent.log" 2>&1 &
```

Also update `start_hub()`: remove `pnpm -F @lasterm/agent build` step (no more Node agent).

- [ ] **Step 2: Update dev-stop.sh — update agent process finding**

In `stop_agent()`, the existing `lsof -U | grep $AGENT_SOCK` approach works for Unix sockets regardless of whether the agent is Node or Rust. No code change needed here — just verify it still works.

- [ ] **Step 3: Create dev-start.ps1**

```powershell
#Requires -Version 7.0
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

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Start-Hub {
    Write-Host "🔄 Starting hub + web dev servers..." -ForegroundColor Cyan

    # Stop existing first
    & "$ScriptDir\dev-stop.ps1" -Target hub

    # Build shared
    Write-Host "  Building shared..." -ForegroundColor DarkGray
    Set-Location $Root
    pnpm -F @lasterm/shared build *> "$LogDir\shared-build.log"

    # Start hub + web (concurrently via pnpm dev)
    $proc = Start-Process -FilePath "pnpm" -ArgumentList "dev" `
        -WorkingDirectory $Root -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput "$LogDir\dev-stdout.log" `
        -RedirectStandardError "$LogDir\dev-stderr.log"
    $proc.Id | Out-File -FilePath $PidFile -Force

    # Wait for hub health
    Write-Host "  Waiting for hub (port 4100)..." -ForegroundColor DarkGray
    $ok = $false
    for ($i = 0; $i -lt 30; $i++) {
        try {
            $null = Invoke-RestMethod -Uri "http://127.0.0.1:4100/api/health" -TimeoutSec 2
            $ok = $true
            break
        } catch {
            Start-Sleep -Seconds 1
        }
    }
    if (-not $ok) {
        Write-Host "❌ Hub failed to start. Logs: $LogDir\dev-stderr.log" -ForegroundColor Red
        Get-Content "$LogDir\dev-stderr.log" -Tail 20
        exit 1
    }

    # Wait for Vite
    Write-Host "  Waiting for Vite (port 5173)..." -ForegroundColor DarkGray
    for ($i = 0; $i -lt 15; $i++) {
        $conn = Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue
        if ($conn) { break }
        Start-Sleep -Seconds 1
    }

    Write-Host "✅ Hub:  http://127.0.0.1:4100" -ForegroundColor Green
    Write-Host "✅ Web:  http://127.0.0.1:5173" -ForegroundColor Green
    Write-Host "   Logs: $LogDir" -ForegroundColor DarkGray
}

function Start-Agent {
    Write-Host "🔄 Starting Rust agent daemon..." -ForegroundColor Cyan

    & "$ScriptDir\dev-stop.ps1" -Target agent

    # Build Rust agent
    Write-Host "  Building Rust agent..." -ForegroundColor DarkGray
    Set-Location $Root
    cargo build -p lasterm-agent --release *> "$LogDir\agent-build.log"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ Agent build failed. Log: $LogDir\agent-build.log" -ForegroundColor Red
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
    Write-Host "  Waiting for agent pipe ($PipeName)..." -ForegroundColor DarkGray
    $ok = $false
    for ($i = 0; $i -lt 10; $i++) {
        if (Test-Path $PipePath) { $ok = $true; break }
        Start-Sleep -Milliseconds 500
    }
    if (-not $ok) {
        Write-Host "❌ Agent pipe not found after 5s. Log: $LogDir\agent-stderr.log" -ForegroundColor Red
        Get-Content "$LogDir\agent-stderr.log" -Tail 20 -ErrorAction SilentlyContinue
        exit 1
    }
    Write-Host "✅ Agent daemon running (pipe: $PipeName)" -ForegroundColor Green
}

function Show-AgentStatus {
    if (Test-Path $PipePath) {
        Write-Host "   Agent: running (pipe: $PipeName)" -ForegroundColor DarkGray
    } else {
        Write-Host "   Agent: not running" -ForegroundColor DarkGray
    }
}

# Dispatch
switch ($Target) {
    "hub"   { Start-Hub; Show-AgentStatus }
    "agent" { Start-Agent }
    "all"   { Start-Hub; Start-Agent }
}
```

- [ ] **Step 4: Create dev-stop.ps1**

```powershell
#Requires -Version 7.0
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

function Stop-Hub {
    Write-Host "🛑 Stopping hub + web..." -ForegroundColor Yellow

    if (Test-Path $PidFile) {
        $pid = [int](Get-Content $PidFile -Raw).Trim()
        $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
        if ($proc) {
            # Kill the process tree
            $children = Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $pid }
            foreach ($child in $children) {
                Stop-Process -Id $child.ProcessId -Force -ErrorAction SilentlyContinue
            }
            Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
        }
        Remove-Item $PidFile -Force
    }

    # Fallback: clean up by port
    Stop-PortProcess 4100
    Stop-PortProcess 5173

    Write-Host "✅ Hub stopped" -ForegroundColor Green
}

function Stop-Agent {
    Write-Host "🛑 Stopping agent daemon..." -ForegroundColor Yellow

    if (Test-Path $AgentPidFile) {
        $pid = [int](Get-Content $AgentPidFile -Raw).Trim()
        Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
        Remove-Item $AgentPidFile -Force
        Write-Host "✅ Agent stopped (PID $pid)" -ForegroundColor Green
    } else {
        # Fallback: find lasterm-agent process
        $agents = Get-Process -Name "lasterm-agent" -ErrorAction SilentlyContinue
        foreach ($a in $agents) {
            Stop-Process -Id $a.Id -Force -ErrorAction SilentlyContinue
            Write-Host "  Killed lasterm-agent PID $($a.Id)" -ForegroundColor DarkGray
        }
        if (-not $agents) {
            Write-Host "  No agent daemon running" -ForegroundColor DarkGray
        }
    }
}

switch ($Target) {
    "hub"   { Stop-Hub }
    "agent" { Stop-Agent }
    "all"   { Stop-Hub; Stop-Agent }
}
```

- [ ] **Step 5: Create dev-restart.ps1**

```powershell
#Requires -Version 7.0
param(
    [ValidateSet("hub", "agent", "all")]
    [string]$Target = "all"
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
& "$ScriptDir\dev-start.ps1" -Target $Target
```

Note: dev-start.ps1 already calls dev-stop first, matching the bash pattern.

- [ ] **Step 6: Verify dev-restart.sh — no changes needed**

The existing `dev-restart.sh` is a thin wrapper that calls `dev-start.sh` (which calls `dev-stop.sh` internally). Since we're updating `dev-start.sh` and `dev-stop.sh`, `dev-restart.sh` works without modification. Verify by reading it.

- [ ] **Step 7: Verify dev-start.sh still works (Linux)**

Run: `./scripts/dev-start.sh`
Expected: Hub at :4100, web at :5173, Rust agent daemon running.

Run: `./scripts/dev-stop.sh`
Expected: All processes stopped.

- [ ] **Step 8: Commit**

```bash
git add scripts/dev-start.sh scripts/dev-stop.sh \
       scripts/dev-start.ps1 scripts/dev-stop.ps1 scripts/dev-restart.ps1
git commit -m "feat(scripts): add Windows dev scripts, switch to Rust agent daemon"
```

---

## Task 7: Build matrix JSON + CI refactoring

**Files:**
- Create: `.github/build-matrix.json`
- Modify: `.github/workflows/build.yml`
- Modify: `.github/workflows/release.yml`
- Delete: `.github/workflows/rust-agent.yml`

Depends on: Tasks 1-4 (scripts exist)

- [ ] **Step 1: Create `.github/build-matrix.json`**

```json
{
  "targets": [
    {
      "triple": "x86_64-unknown-linux-gnu",
      "runner": "ubuntu-latest",
      "os": "linux",
      "arch": "x64",
      "shell_sh": true,
      "agent": true,
      "hub": true,
      "desktop": false,
      "enabled": true
    },
    {
      "triple": "x86_64-pc-windows-msvc",
      "runner": "windows-latest",
      "os": "windows",
      "arch": "x64",
      "shell_sh": false,
      "agent": true,
      "hub": true,
      "desktop": true,
      "enabled": true
    },
    {
      "triple": "aarch64-apple-darwin",
      "runner": "macos-latest",
      "os": "macos",
      "arch": "arm64",
      "shell_sh": true,
      "agent": true,
      "hub": true,
      "desktop": true,
      "enabled": false
    }
  ]
}
```

- [ ] **Step 2: Rewrite `.github/workflows/build.yml`**

Full content — see spec section "Workflow: `.github/workflows/build.yml`" for the complete YAML.

Key structure:
```
on: workflow_call

jobs:
  matrix → load-matrix.json, filter by enabled + component
  build-web → scripts/build-web.sh, upload web-dist-raw + web-dist-embedded
  build-agent → matrix, scripts/build-agent.sh/.ps1, upload agent-{triple}
  build-hub → matrix, needs build-web, scripts/build-hub.sh/.ps1, upload hub-{triple}
  build-desktop → matrix, needs agent+hub+web, place sidecars + tauri build
```

Use the complete YAML from the spec. Ensure:
- `setup-node` has `cache: "pnpm"`
- `pnpm/action-setup@v4` is used (pnpm version from packageManager field)
- `Swatinem/rust-cache@v2` for Rust jobs
- `dtolnay/rust-toolchain@stable` with `components: "clippy, rustfmt"`
- Separate steps for `cargo fmt` and `cargo clippy --all-targets`

- [ ] **Step 3: Update `.github/workflows/release.yml`**

In the `release` job, update artifact downloads from:
```yaml
# OLD
- uses: actions/download-artifact@v4
  with:
    pattern: sea-*
    path: release-assets/
    merge-multiple: true
- uses: actions/download-artifact@v4
  with:
    pattern: tauri-*
    path: release-assets/
    merge-multiple: true
```

To:
```yaml
# NEW
- uses: actions/download-artifact@v4
  with:
    pattern: agent-*
    path: release-assets/
    merge-multiple: true
- uses: actions/download-artifact@v4
  with:
    pattern: hub-*
    path: release-assets/
    merge-multiple: true
- uses: actions/download-artifact@v4
  with:
    pattern: desktop-*
    path: release-assets/
    merge-multiple: true
```

Update any `ls` or glob commands that list release assets to match the new names.

- [ ] **Step 4: Verify ci.yml still works**

Read `.github/workflows/ci.yml` — it should call `build.yml` via `workflow_call`. Since `build.yml` retains `on: workflow_call`, no changes needed. Verify this.

- [ ] **Step 5: Delete `.github/workflows/rust-agent.yml`**

Run: `git rm .github/workflows/rust-agent.yml`

- [ ] **Step 6: Commit**

```bash
git add .github/build-matrix.json .github/workflows/build.yml \
       .github/workflows/release.yml
git rm .github/workflows/rust-agent.yml
git commit -m "feat(ci): rewrite build pipeline — matrix-driven, script-based, Rust agent"
```

---

## Task 8: Dead code cleanup

**Files:**
- Delete: `packages/agent/` (entire directory)
- Delete: `scripts/package-sea-agent.ts`
- Delete: `scripts/build-sea-agent.ts`
- Delete: `scripts/rename-sea-binaries.sh`
- Delete: `scripts/prepare-desktop.sh`
- Delete: `scripts/build-desktop-windows.ps1`
- Modify: `package.json` (root) — remove dead scripts
- Modify: `pnpm-workspace.yaml` — remove agent-only entries
- Modify: `tauri.conf.json` — empty beforeBuildCommand

Depends on: Task 7 (CI no longer references these)

- [ ] **Step 1: Delete Node agent package**

Run:
```bash
git rm -r packages/agent/
```

- [ ] **Step 2: Delete obsolete scripts**

Run:
```bash
git rm scripts/package-sea-agent.ts
git rm scripts/build-sea-agent.ts
git rm scripts/rename-sea-binaries.sh
git rm scripts/prepare-desktop.sh
git rm scripts/build-desktop-windows.ps1
```

- [ ] **Step 3: Clean up package.json scripts**

In root `package.json`, remove these scripts:
```
"build:sea-agent"
"package:sea-agent"
"prepare:desktop"
```

Update `build:desktop`:
```json
"build:desktop": "bash scripts/build-desktop.sh"
```

- [ ] **Step 4: Clean up pnpm-workspace.yaml**

Remove from `onlyBuiltDependencies`:
```
node-pty
```

Remove from `catalog`:
```
node-pty
@xterm/headless
@xterm/addon-serialize
```

- [ ] **Step 5: Update tauri.conf.json**

Change `beforeBuildCommand` from:
```json
"beforeBuildCommand": "cd ../../.. && bash scripts/prepare-desktop.sh"
```
To:
```json
"beforeBuildCommand": ""
```

- [ ] **Step 6: Run pnpm install to clean lockfile**

Run: `pnpm install`

This will remove `node-pty` and other deleted deps from the lockfile.

- [ ] **Step 7: Verify everything still builds**

Run:
```bash
pnpm build          # All remaining packages build
pnpm test           # Tests pass (agent tests are gone with the package)
pnpm lint           # No lint errors
```

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml \
       packages/clients/desktop/src-tauri/tauri.conf.json
git commit -m "chore: remove Node agent, node-pty, and obsolete build scripts

BREAKING: @lasterm/agent package removed — Rust agent is the sole agent.
Removed: node-pty, @xterm/headless, @xterm/addon-serialize from deps.
Removed: SEA agent scripts, prepare-desktop.sh, rust-agent.yml.
Updated: package.json scripts, pnpm-workspace.yaml, tauri.conf.json."
```

Note: `git rm` commands in steps 1-2 already staged those deletions.

---

## Task 9: Final verification

- [ ] **Step 1: Full build from clean state (Linux)**

```bash
git clean -fd dist/sea/
./scripts/build-web.sh
./scripts/build-agent.sh
LASTERM_SKIP_WEB=true ./scripts/build-hub.sh
ls -la dist/sea/
```

Expected: `lasterm-agent` and `lasterm-hub` in `dist/sea/`.

- [ ] **Step 2: Dev workflow (Linux)**

```bash
./scripts/dev-start.sh
curl -sf http://127.0.0.1:4100/api/health
./scripts/dev-stop.sh
```

Expected: Hub responds, clean shutdown.

- [ ] **Step 3: Document Windows testing checklist**

The following must be tested on native Windows (not WSL):
- `.\scripts\build-web.ps1`
- `.\scripts\build-agent.ps1`
- `.\scripts\build-hub.ps1`
- `.\scripts\build-desktop.ps1`
- `.\scripts\dev-start.ps1`
- `.\scripts\dev-stop.ps1`

---

## Task 10: Node 24 migration (DEFERRED)

**Status:** Not part of this implementation. Execute as a separate PR after Tasks 1-9 are merged and verified.

**Spec reference:** Section "Node 24 Migration (Separate Block)" in the design spec.

**Steps (for future PR):**
1. Install Node 24 LTS locally
2. `pnpm install` (rebuild better-sqlite3 for Node 24 ABI)
3. `pnpm test` (all tests pass?)
4. `./scripts/build-hub.sh` (SEA blob works with Node 24?)
5. Execute the resulting SEA binary — verify it starts and serves
6. If pass: bump `"engines"` in `package.json`, CI `node-version: "24"`, `LASTERM_NODE_VERSION` defaults
7. `pnpm install` again to regenerate lockfile
8. Test Windows build (`.ps1` scripts with Node 24)

---

## Execution Order

```
Tasks 1,2,3 ──── parallel (no dependencies)
     ↓
Task 4 ───────── depends on Task 3 (env vars in TS)
     ↓
Task 5 ───────── depends on Tasks 1,2,4 (component scripts)
     ↓
Tasks 6,7 ────── parallel (dev scripts independent of CI)
     ↓
Task 8 ───────── depends on Task 7 (CI no longer refs dead code)
     ↓
Task 9 ───────── final verification
```
