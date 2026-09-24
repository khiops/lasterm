#!/usr/bin/env bash
# Stop the lasterm dev servers dev-start.sh started, and nothing else.
# Usage: ./scripts/dev-stop.sh [hub|agent|all]   (default: all)
set -euo pipefail

TARGET="${1:-all}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Where cargo builds the agent: CARGO_TARGET_DIR when set, relative to the
# repository as cargo reads it from there, else target/ (#541).
case "${CARGO_TARGET_DIR:-}" in
	"") TARGET_DIR="$ROOT/target" ;;
	/* | [A-Za-z]:*) TARGET_DIR="$CARGO_TARGET_DIR" ;;
	*) TARGET_DIR="$ROOT/$CARGO_TARGET_DIR" ;;
esac
LOG_DIR="/tmp/lasterm-dev"
PID_FILE="$LOG_DIR/dev.pid"
AGENT_BIN="$TARGET_DIR/release/lasterm-agent"

# ── Helper: say who holds a port, without touching it ────────────────────────
# A port is not an identity: whatever still listens after the recorded group is
# gone was not started here, and may be another application entirely (#173).
report_port() {
	local port=$1 holders
	holders=$(ss -tlnp 2>/dev/null | grep ":$port " || true)
	if [ -n "$holders" ]; then
		echo "⚠  Port $port is still in use, left alone: $holders"
	fi
}

# ── Stop hub + web (process group from dev-start.sh) ─────────────────────────
stop_hub() {
	if [ -f "$PID_FILE" ]; then
		DEV_PID=$(cat "$PID_FILE")
		if kill -0 "$DEV_PID" 2>/dev/null; then
			echo "Stopping dev servers (PID $DEV_PID)…"
			# Kill the process group (setsid was used to start)
			kill -- -"$DEV_PID" 2>/dev/null || kill "$DEV_PID" 2>/dev/null || true
			sleep 1
			# Ensure children are dead
			kill -9 -- -"$DEV_PID" 2>/dev/null || true
			echo "Stopped."
		else
			echo "Process $DEV_PID already dead."
		fi
		rm -f "$PID_FILE"
	else
		echo "No PID file found: nothing started by dev-start.sh is recorded, so nothing is stopped."
	fi

	# The hub listens on a port the OS assigns; only Vite has a fixed one.
	sleep 0.5
	report_port 5173
}

# ── Stop agent daemon ────────────────────────────────────────────────────────
stop_agent() {
	if [ ! -x "$AGENT_BIN" ]; then
		echo "No agent binary at $AGENT_BIN; nothing to stop with."
		return
	fi
	# The endpoint the hub resolves (#161), not a shell copy of the rule. The
	# agent checks its own identity record before stopping, so neither a reused
	# pid nor someone else's daemon is ever signalled, and the endpoint is the
	# daemon's to remove.
	local socket
	socket="$(cd "$ROOT" && pnpm exec tsx scripts/dev/paths.mts agent-socket)"
	if "$AGENT_BIN" --stop --socket "$socket"; then
		echo "✓ Agent stopped ($socket)."
	else
		echo "Agent not stopped ($socket); see above."
	fi
}

# ── Dispatch ─────────────────────────────────────────────────────────────────
case "$TARGET" in
	hub)
		stop_hub
		;;
	agent)
		stop_agent
		;;
	all)
		stop_hub
		stop_agent
		;;
	*)
		echo "Usage: $0 [hub|agent|all]"
		exit 1
		;;
esac
