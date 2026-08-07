#!/usr/bin/env bash
# Restart lasterm dev servers (stop + start).
# Usage: ./scripts/dev-restart.sh [hub|agent|all]   (default: all)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec "$ROOT/scripts/dev-start.sh" "${1:-all}"
