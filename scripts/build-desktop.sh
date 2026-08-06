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
