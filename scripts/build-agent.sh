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
# Use --target for cross-compilation, skip for native builds
if [ "$LASTERM_TARGET_TRIPLE" != "$DETECTED_TRIPLE" ]; then
  echo "  Cross-compiling for $LASTERM_TARGET_TRIPLE (native: $DETECTED_TRIPLE)"
  cargo build -p lasterm-agent --release --target "$LASTERM_TARGET_TRIPLE" --target-dir "$LASTERM_CARGO_TARGET_DIR"
  BINARY="$LASTERM_CARGO_TARGET_DIR/$LASTERM_TARGET_TRIPLE/release/lasterm-agent"
else
  cargo build -p lasterm-agent --release --target-dir "$LASTERM_CARGO_TARGET_DIR"
  BINARY="$LASTERM_CARGO_TARGET_DIR/release/lasterm-agent"
fi

# Copy binary to dist
if [ ! -f "$BINARY" ]; then
  echo "❌ Binary not found at $BINARY" >&2
  exit 1
fi
cp "$BINARY" "$LASTERM_DIST_DIR/lasterm-agent"
chmod +x "$LASTERM_DIST_DIR/lasterm-agent"

SIZE=$(du -h "$LASTERM_DIST_DIR/lasterm-agent" | cut -f1)
echo "✅ Rust agent built → $LASTERM_DIST_DIR/lasterm-agent ($SIZE)"
