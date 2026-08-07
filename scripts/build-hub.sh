#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Auto-detect
ARCH=$(uname -m)
case "$(uname -s)" in
  Linux)  DETECTED_TRIPLE="${ARCH}-unknown-linux-gnu"; LOCK_LIBRARY_NAME="liblasterm_hub_lock.so" ;;
  Darwin) DETECTED_TRIPLE="${ARCH}-apple-darwin"; LOCK_LIBRARY_NAME="liblasterm_hub_lock.dylib" ;;
  *)      echo "❌ Unsupported OS. Use .ps1 on Windows." >&2; exit 1 ;;
esac

LASTERM_TARGET_TRIPLE="${LASTERM_TARGET_TRIPLE:-$DETECTED_TRIPLE}"
LASTERM_DIST_DIR="${LASTERM_DIST_DIR:-$ROOT/dist/sea}"
LASTERM_BUILD_HASH="${LASTERM_BUILD_HASH:-$(git -C "$ROOT" rev-parse --short=8 HEAD)}"
LASTERM_SKIP_WEB="${LASTERM_SKIP_WEB:-false}"
LASTERM_CARGO_TARGET_DIR="${LASTERM_CARGO_TARGET_DIR:-$ROOT/target}"

echo "🔨 Building hub SEA (triple: $LASTERM_TARGET_TRIPLE)..."

cd "$ROOT"
pnpm -F @lasterm/shared build

# The hub's single-instance authority is a napi cdylib. Build it on the same
# host that packages this hub, then give the SEA asset its Node addon name.
if [ "$LASTERM_TARGET_TRIPLE" != "$DETECTED_TRIPLE" ]; then
  cargo build -p lasterm-hub-lock --release --target "$LASTERM_TARGET_TRIPLE" --target-dir "$LASTERM_CARGO_TARGET_DIR"
  LOCK_LIBRARY="$LASTERM_CARGO_TARGET_DIR/$LASTERM_TARGET_TRIPLE/release/$LOCK_LIBRARY_NAME"
else
  cargo build -p lasterm-hub-lock --release --target-dir "$LASTERM_CARGO_TARGET_DIR"
  LOCK_LIBRARY="$LASTERM_CARGO_TARGET_DIR/release/$LOCK_LIBRARY_NAME"
fi
if [ ! -f "$LOCK_LIBRARY" ]; then
  echo "❌ Hub lock addon not found at $LOCK_LIBRARY" >&2
  exit 1
fi
if [ "$LASTERM_SKIP_WEB" != "true" ]; then
  echo "  → Building web UI first..."
  "$SCRIPT_DIR/build-web.sh"
fi

export LASTERM_TARGET_TRIPLE LASTERM_DIST_DIR LASTERM_BUILD_HASH
export LASTERM_HUB_LOCK_ADDON="$LOCK_LIBRARY"
# Also export LASTERM_NODE_VERSION if set (for cross-build Node version override)
[ -n "${LASTERM_NODE_VERSION:-}" ] && export LASTERM_NODE_VERSION
pnpm run package:sea-hub

SIZE=$(du -h "$LASTERM_DIST_DIR/lasterm-hub" 2>/dev/null | cut -f1 || echo "?")
echo "✅ Hub SEA built → $LASTERM_DIST_DIR/lasterm-hub ($SIZE)"
