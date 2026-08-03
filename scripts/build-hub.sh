#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Auto-detect
ARCH=$(uname -m)
case "$(uname -s)" in
  Linux)  DETECTED_TRIPLE="${ARCH}-unknown-linux-gnu"; LOCK_LIBRARY_NAME="libtermora_hub_lock.so" ;;
  Darwin) DETECTED_TRIPLE="${ARCH}-apple-darwin"; LOCK_LIBRARY_NAME="libtermora_hub_lock.dylib" ;;
  *)      echo "❌ Unsupported OS. Use .ps1 on Windows." >&2; exit 1 ;;
esac

TERMORA_TARGET_TRIPLE="${TERMORA_TARGET_TRIPLE:-$DETECTED_TRIPLE}"
TERMORA_DIST_DIR="${TERMORA_DIST_DIR:-$ROOT/dist/sea}"
TERMORA_BUILD_HASH="${TERMORA_BUILD_HASH:-$(git -C "$ROOT" rev-parse --short=8 HEAD)}"
TERMORA_SKIP_WEB="${TERMORA_SKIP_WEB:-false}"
TERMORA_CARGO_TARGET_DIR="${TERMORA_CARGO_TARGET_DIR:-$ROOT/target}"

echo "🔨 Building hub SEA (triple: $TERMORA_TARGET_TRIPLE)..."

cd "$ROOT"
pnpm -F @termora/shared build

# The hub's single-instance authority is a napi cdylib. Build it on the same
# host that packages this hub, then give the SEA asset its Node addon name.
if [ "$TERMORA_TARGET_TRIPLE" != "$DETECTED_TRIPLE" ]; then
  cargo build -p termora-hub-lock --release --target "$TERMORA_TARGET_TRIPLE" --target-dir "$TERMORA_CARGO_TARGET_DIR"
  LOCK_LIBRARY="$TERMORA_CARGO_TARGET_DIR/$TERMORA_TARGET_TRIPLE/release/$LOCK_LIBRARY_NAME"
else
  cargo build -p termora-hub-lock --release --target-dir "$TERMORA_CARGO_TARGET_DIR"
  LOCK_LIBRARY="$TERMORA_CARGO_TARGET_DIR/release/$LOCK_LIBRARY_NAME"
fi
if [ ! -f "$LOCK_LIBRARY" ]; then
  echo "❌ Hub lock addon not found at $LOCK_LIBRARY" >&2
  exit 1
fi
if [ "$TERMORA_SKIP_WEB" != "true" ]; then
  echo "  → Building web UI first..."
  "$SCRIPT_DIR/build-web.sh"
fi

export TERMORA_TARGET_TRIPLE TERMORA_DIST_DIR TERMORA_BUILD_HASH
export TERMORA_HUB_LOCK_ADDON="$LOCK_LIBRARY"
# Also export TERMORA_NODE_VERSION if set (for cross-build Node version override)
[ -n "${TERMORA_NODE_VERSION:-}" ] && export TERMORA_NODE_VERSION
pnpm run package:sea-hub

SIZE=$(du -h "$TERMORA_DIST_DIR/termora-hub" 2>/dev/null | cut -f1 || echo "?")
echo "✅ Hub SEA built → $TERMORA_DIST_DIR/termora-hub ($SIZE)"
