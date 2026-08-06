#!/usr/bin/env bash
# Isolated Lasterm headless local-spawn harness.
# Lifecycle uses PID files only; no ps/pgrep/ss/fuser probes.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
TT="${TT_DIR:-$ROOT/.tt/headless-hub}"
PORT="${TT_PORT:-4199}"

export XDG_STATE_HOME="$TT/state"
export XDG_RUNTIME_DIR="$TT/rt"
export XDG_CONFIG_HOME="$TT/cfg"

CONFIG_DIR="$XDG_CONFIG_HOME/lasterm"
STATE_DIR="$XDG_STATE_HOME/lasterm"
RUNTIME_DIR="$XDG_RUNTIME_DIR/lasterm"
HUBLOG="$TT/hub.log"
PIDF="$TT/hub.pid"
SOCK="$RUNTIME_DIR/agent.sock"

ensure_dirs() {
	mkdir -p "$CONFIG_DIR" "$STATE_DIR" "$RUNTIME_DIR"
}

write_debug_config() {
	cat >"$CONFIG_DIR/config.toml" <<'EOF'
[logging]
level = "debug"
format = "text"
output = "both"
EOF
}

stop() {
	if [[ -f "$PIDF" ]]; then
		local pid
		pid="$(<"$PIDF")"
		if kill "$pid" 2>/dev/null; then
			echo "[headless] stopped hub pid $pid"
		fi
		rm -f "$PIDF"
	fi
	rm -f "$SOCK"
}

case "${1:-}" in
	start)
		ensure_dirs
		stop
		sleep 1
		ensure_dirs
		write_debug_config
		nohup bash -c 'cd "$1" && LASTERM_OPEN=0 LASTERM_PORT="$2" exec pnpm exec tsx src/main.ts' \
			_ "$ROOT/packages/hub" "$PORT" >"$HUBLOG" 2>&1 &
		echo $! >"$PIDF"
		echo "[headless] hub starting pid $(<"$PIDF") on :$PORT"
		echo "[headless] isolated root: $TT"
		for _ in $(seq 1 30); do
			if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
				echo "[headless] hub up"
				exit 0
			fi
			sleep 1
		done
		echo "[headless] hub did not come up; run: scripts/dev/headless-hub-test.sh logs"
		exit 1
		;;
	spawn)
		ensure_dirs
		cd "$ROOT"
		TT_AUTH="$CONFIG_DIR/auth.json" timeout 20 pnpm exec tsx scripts/dev/headless-spawn-probe.mts "$PORT"
		;;
	logs)
		if [[ -f "$HUBLOG" ]]; then
			grep -E 'lasterm-agent|agent-connection-manager|channel-lifecycle|spawn-handler|CHANNEL_STATE|SPAWN|hub started|error|warn' "$HUBLOG" 2>/dev/null | tail -80 || true
		else
			echo "[headless] no hub log at $HUBLOG"
		fi
		;;
	alog)
		if [[ -f "$STATE_DIR/logs/agent-daemon.jsonl" ]]; then
			tail -80 "$STATE_DIR/logs/agent-daemon.jsonl"
		elif [[ -f "$STATE_DIR/agent-daemon.log" ]]; then
			tail -80 "$STATE_DIR/agent-daemon.log"
		else
			echo "[headless] no agent log under $STATE_DIR"
		fi
		;;
	stop)
		stop
		;;
	reset)
		stop
		rm -rf "$TT"
		ensure_dirs
		echo "[headless] isolated state wiped: $TT"
		;;
	*)
		echo "usage: scripts/dev/headless-hub-test.sh {start|spawn|logs|alog|stop|reset}"
		exit 2
		;;
esac
