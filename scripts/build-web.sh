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
