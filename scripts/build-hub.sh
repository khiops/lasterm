#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Auto-detect
ARCH=$(uname -m)
case "$(uname -s)" in
  Linux)  DETECTED_TRIPLE="${ARCH}-unknown-linux-gnu"; LOCK_LIBRARY_NAME="liblasterm_hub_lock.so"; TLS_LIBRARY_NAME="liblasterm_tls_identity.so" ;;
  Darwin) DETECTED_TRIPLE="${ARCH}-apple-darwin"; LOCK_LIBRARY_NAME="liblasterm_hub_lock.dylib"; TLS_LIBRARY_NAME="liblasterm_tls_identity.dylib" ;;
  *)      echo "❌ Unsupported OS. Use .ps1 on Windows." >&2; exit 1 ;;
esac

LASTERM_TARGET_TRIPLE="${LASTERM_TARGET_TRIPLE:-$DETECTED_TRIPLE}"
LASTERM_DIST_DIR="${LASTERM_DIST_DIR:-$ROOT/dist/sea}"
LASTERM_BUILD_HASH="${LASTERM_BUILD_HASH:-$(git -C "$ROOT" rev-parse --short=8 HEAD)}"
LASTERM_SKIP_WEB="${LASTERM_SKIP_WEB:-false}"
# The target directory: LASTERM_CARGO_TARGET_DIR, else the CARGO_TARGET_DIR
# plain cargo and the hub specs read, else the repository's own. A relative one
# is relative to the repository, where cargo runs below (#531).
LASTERM_CARGO_TARGET_DIR="${LASTERM_CARGO_TARGET_DIR:-${CARGO_TARGET_DIR:-$ROOT/target}}"

# The hub embeds the Node running this build, so it is built on the platform it
# targets; package-sea-hub refuses anything else (#148).
if [ "$LASTERM_TARGET_TRIPLE" != "$DETECTED_TRIPLE" ]; then
  echo "❌ The hub is built on the platform it targets: this host builds $DETECTED_TRIPLE, not $LASTERM_TARGET_TRIPLE." >&2
  exit 1
fi

echo "🔨 Building hub SEA (triple: $LASTERM_TARGET_TRIPLE)..."

cd "$ROOT"
pnpm -F @lasterm/shared build

# The hub's single-instance authority is a napi cdylib. Build it on the same
# host that packages this hub, then give the SEA asset its Node addon name.
cargo build --locked -p lasterm-hub-lock -p lasterm-tls-identity --release --target-dir "$LASTERM_CARGO_TARGET_DIR"
LOCK_LIBRARY="$LASTERM_CARGO_TARGET_DIR/release/$LOCK_LIBRARY_NAME"
TLS_LIBRARY="$LASTERM_CARGO_TARGET_DIR/release/$TLS_LIBRARY_NAME"
if [ ! -f "$LOCK_LIBRARY" ]; then
  echo "❌ Hub lock addon not found at $LOCK_LIBRARY" >&2
  exit 1
fi
if [ ! -f "$TLS_LIBRARY" ]; then
  echo "❌ TLS identity addon not found at $TLS_LIBRARY" >&2
  exit 1
fi
if [ "$LASTERM_SKIP_WEB" != "true" ]; then
  echo "  → Building web UI first..."
  "$SCRIPT_DIR/build-web.sh"
fi

export LASTERM_TARGET_TRIPLE LASTERM_DIST_DIR LASTERM_BUILD_HASH
export LASTERM_HUB_LOCK_ADDON="$LOCK_LIBRARY"
export LASTERM_TLS_IDENTITY_ADDON="$TLS_LIBRARY"
pnpm run package:sea-hub

SIZE=$(du -h "$LASTERM_DIST_DIR/lasterm-hub" 2>/dev/null | cut -f1 || echo "?")
echo "✅ Hub SEA built → $LASTERM_DIST_DIR/lasterm-hub ($SIZE)"
