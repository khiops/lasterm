#!/usr/bin/env bash
# Start lasterm dev servers in background with log capture.
# Usage: ./scripts/dev-start.sh [hub|agent|all]   (default: all)
set -euo pipefail

TARGET="${1:-all}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="/tmp/lasterm-dev"
PID_FILE="$LOG_DIR/dev.pid"
AGENT_SOCK="${XDG_RUNTIME_DIR:-/tmp/lasterm-$(id -u)}/lasterm/agent.sock"
HUB_STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/lasterm"

mkdir -p "$LOG_DIR"

# ── Start hub + web ──────────────────────────────────────────────────────────
start_hub() {
	"$ROOT/scripts/dev-stop.sh" hub
	echo ""

	echo "Building shared…"
	(cd "$ROOT" && pnpm -F @lasterm/shared build) > "$LOG_DIR/shared-build.log" 2>&1

	echo "Starting hub + web…"
	cd "$ROOT"
	setsid pnpm dev > "$LOG_DIR/dev.log" 2>&1 &
	DEV_PID=$!
	echo "$DEV_PID" > "$PID_FILE"

	# The hub chooses an OS-assigned port unless explicitly configured. Its runtime
	# record and self-signed certificate appear only after TLS is listening.
	echo -n "Waiting for hub TLS listener"
	HUB_OK=0
	HUB_PORT=""
	for i in $(seq 1 30); do
		if [ -r "$HUB_STATE_DIR/runtime.json" ] && [ -r "$HUB_STATE_DIR/hub-tls-cert.pem" ]; then
			HUB_PORT="$(sed -n 's/^[[:space:]]*"port"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$HUB_STATE_DIR/runtime.json" | head -n 1)"
		fi
		if [ -n "$HUB_PORT" ] && curl --cacert "$HUB_STATE_DIR/hub-tls-cert.pem" -sf "https://127.0.0.1:$HUB_PORT/api/health" > /dev/null 2>&1; then
			echo " ✓"
			HUB_OK=1
			break
		fi
		echo -n "."
		sleep 1
	done

	if [ "$HUB_OK" -eq 0 ]; then
		echo ""
		echo "✗ Hub did not respond after 30s. Check $LOG_DIR/dev.log"
		tail -20 "$LOG_DIR/dev.log"
		exit 1
	fi

	# Wait for Vite dev server (port 5173)
	echo -n "Waiting for Vite on :5173"
	VITE_OK=0
	for i in $(seq 1 15); do
		if ss -tlnp 2>/dev/null | grep -q ':5173 '; then
			echo " ✓"
			VITE_OK=1
			break
		fi
		echo -n "."
		sleep 1
	done

	if [ "$VITE_OK" -eq 0 ]; then
		echo ""
		echo "⚠  Vite not detected on :5173 (may still be starting)"
	fi

	# Check for warnings in log
	if grep -q "MaxListenersExceeded" "$LOG_DIR/dev.log" 2>/dev/null; then
		echo "⚠  MaxListenersExceededWarning detected in logs"
	fi

	echo ""
	echo "Hub + web running (PID $DEV_PID)"
	echo "  Hub:    https://127.0.0.1:$HUB_PORT"
	echo "  Web:    http://localhost:5173"
	echo "  Logs:   $LOG_DIR/dev.log"
}

# ── Start agent daemon ───────────────────────────────────────────────────────
start_agent() {
	"$ROOT/scripts/dev-stop.sh" agent
	echo ""

	echo "Building Rust agent…"
	(cd "$ROOT" && cargo build -p lasterm-agent --release) > "$LOG_DIR/agent-build.log" 2>&1

	echo "Starting agent daemon…"
	local AGENT_BIN="$ROOT/target/release/lasterm-agent"
	setsid "$AGENT_BIN" --daemon --socket "$AGENT_SOCK" \
		--buffer-per-channel 1048576 --buffer-global 20971520 \
		> "$LOG_DIR/agent.log" 2>&1 &

	# Wait for socket to appear
	echo -n "Waiting for agent socket"
	AGENT_OK=0
	for i in $(seq 1 10); do
		if [ -S "$AGENT_SOCK" ]; then
			echo " ✓"
			AGENT_OK=1
			break
		fi
		echo -n "."
		sleep 0.5
	done

	if [ "$AGENT_OK" -eq 0 ]; then
		echo ""
		echo "⚠  Agent socket not found after 5s (hub will auto-start on first connection)"
	else
		echo "  Agent:  running ($AGENT_SOCK)"
	fi
}

# ── Summary helper ───────────────────────────────────────────────────────────
print_agent_status() {
	if [ -S "$AGENT_SOCK" ]; then
		echo "  Agent:  running ($AGENT_SOCK)"
	else
		echo "  Agent:  not running (hub will auto-start on first connection)"
	fi
}

# ── Dispatch ─────────────────────────────────────────────────────────────────
case "$TARGET" in
	hub)
		start_hub
		print_agent_status
		echo ""
		echo "Stop with: ./scripts/dev-stop.sh hub"
		echo "Tail logs: tail -f $LOG_DIR/dev.log"
		;;
	agent)
		start_agent
		echo ""
		echo "Stop with: ./scripts/dev-stop.sh agent"
		echo "Tail logs: tail -f $LOG_DIR/agent.log"
		;;
	all)
		start_hub
		print_agent_status
		echo ""
		echo "Stop with: ./scripts/dev-stop.sh"
		echo "Tail logs: tail -f $LOG_DIR/dev.log"
		;;
	*)
		echo "Usage: $0 [hub|agent|all]"
		exit 1
		;;
esac
