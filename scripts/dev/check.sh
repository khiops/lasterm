#!/usr/bin/env bash
# The local safety net: what CI checks on a pull request, run on the checkout
# this is called from (any worktree), before pushing.
#
#   scripts/dev/check.sh [--desktop] [--log-dir DIR] [--dry-run] [label]
#
# Every step runs, even after one fails, and prints `<step>: exit=<code>`; a
# summary with the test counts follows. Each step's whole output goes to
# <log dir>/<step>.log, the summary to <log dir>/summary.txt. The log dir is
# ${TMPDIR:-/tmp}/lasterm-check/<label>, the label being the branch name unless
# given; --log-dir or LASTERM_CHECK_LOG_DIR replaces it. Exit status: 0 when
# every step passed, 1 when one failed, 2 when nothing could run.
#
#   --desktop  also compile, lint and test the desktop crate, as ci.yml's
#              "Clippy (desktop, Windows)" job does. The packaged app is
#              scripts/dev/desktop-ui.ps1 -Build (Windows) or build-desktop.sh.
#              Not from a worktree inside the main checkout (see desktop_cargo).
#   --dry-run  print the directories and the steps, run nothing.
#
# Keep the steps in sync with CI: .github/workflows/build.yml (jobs lint, test,
# build-agent) and .github/workflows/ci.yml (lint-desktop-windows,
# lint-tls-identity-windows). Not run here: the license checks (job licenses),
# the aarch64 cross build, and the hub and desktop builds with the specs that run
# them (the SEA spec, the webview e2e of ci.yml's Linux job).
#
# Requires node_modules (pnpm install --frozen-lockfile) and the Rust toolchain
# rust-toolchain.toml pins. Works in Git Bash on Windows and in bash on Linux.
set -u

usage() {
	awk 'NR > 1 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "$0"
}
usage_error() {
	echo "check.sh: $1" >&2
	echo "usage: scripts/dev/check.sh [--desktop] [--log-dir DIR] [--dry-run] [label]" >&2
	exit 2
}

desktop=0
dry_run=0
log_dir="${LASTERM_CHECK_LOG_DIR:-}"
label=""
while [ $# -gt 0 ]; do
	case "$1" in
	--desktop) desktop=1 ;;
	--dry-run) dry_run=1 ;;
	--log-dir)
		[ $# -ge 2 ] || usage_error "--log-dir takes a directory"
		log_dir="$2"
		shift
		;;
	--log-dir=*) log_dir="${1#*=}" ;;
	-h | --help)
		usage
		exit 0
		;;
	-*) usage_error "unknown option $1" ;;
	*)
		[ -z "$label" ] || usage_error "one label only, got $label and $1"
		label="$1"
		;;
	esac
	shift
done

case "$(uname -s)" in
MINGW* | MSYS* | CYGWIN*) windows=1 ;;
*) windows=0 ;;
esac
# Paths handed to Windows programs: C:\... for the profile variables, C:/... for
# cargo. -l expands 8.3 short names such as the one TMPDIR carries.
native() { if [ "$windows" = 1 ]; then cygpath -w -l "$1"; else printf '%s\n' "$1"; fi; }
mixed() { if [ "$windows" = 1 ]; then cygpath -m -l "$1"; else printf '%s\n' "$1"; fi; }

root="$(git rev-parse --show-toplevel 2>/dev/null)" || usage_error "not inside a git checkout"
root="$(mixed "$root")"
cd "$root" || exit 2

# The main checkout, which every worktree's builds go to: the parent of the git
# directory the worktrees share.
common_dir="$(git rev-parse --path-format=absolute --git-common-dir)"
if [ "$(basename "$common_dir")" = .git ]; then
	main="$(mixed "$(dirname "$common_dir")")"
else
	main="$root"
fi

# Target directories: the main checkout's, whichever worktree this is. Never a
# new one per worktree: a fresh target recompiles every dependency, which costs
# minutes and gigabytes, and runs every crate's build script as a new executable,
# which the maintainer's antivirus flags outside their development folder
# (CLAUDE.md, "Desktop UI tests"). LASTERM_CARGO_TARGET_DIR, else
# CARGO_TARGET_DIR, still wins, in that order as in scripts/build-agent.sh and
# build-hub.sh; the one chosen is exported under both names, so the hub test
# setup (CARGO_TARGET_DIR) and those scripts agree. A relative one is taken from
# the checkout, as packages/hub/src/cargo-target-dir.ts does.
absolute() {
	case "$1" in
	/* | [A-Za-z]:*) mixed "$1" ;;
	*) mixed "$root/$1" ;;
	esac
}
target="${LASTERM_CARGO_TARGET_DIR:-${CARGO_TARGET_DIR:-}}"
if [ -n "$target" ]; then target="$(absolute "$target")"; else target="$main/target"; fi
export CARGO_TARGET_DIR="$target" LASTERM_CARGO_TARGET_DIR="$target"
# The desktop crate is its own cargo workspace, with its own target directory.
desktop_crate="$root/packages/clients/desktop/src-tauri"
desktop_target="${LASTERM_DESKTOP_CARGO_TARGET_DIR:-}"
if [ -n "$desktop_target" ]; then
	desktop_target="$(absolute "$desktop_target")"
else
	desktop_target="$main/packages/clients/desktop/src-tauri/target"
fi

if [ -z "$label" ]; then
	label="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
	[ "$label" != HEAD ] || label="$(git rev-parse --short HEAD)"
fi
label="$(printf '%s' "$label" | tr -c 'A-Za-z0-9._-' '-')"
[ -n "$log_dir" ] || log_dir="$(mixed "${TMPDIR:-/tmp}")/lasterm-check/$label"

# ─── Steps ─────────────────────────────────────────────────────────────────────

if [ "$windows" = 1 ]; then
	# cfg(windows) code, which a Linux clippy never sees, named explicitly as in
	# CLAUDE.md; --all-features compiles the TLS test material generator too.
	clippy_args=(--target x86_64-pc-windows-msvc --all-targets --all-features -- -D warnings)
	sidecar_triple=x86_64-pc-windows-msvc
	sidecar_ext=.exe
else
	clippy_args=(--all-targets --all-features -- -D warnings)
	sidecar_triple="$(uname -m)-unknown-linux-gnu"
	sidecar_ext=""
fi

# The desktop crate's cargo, in its directory and target. From a worktree nested
# in the main checkout, as Claude's are (.claude/worktrees), cargo refuses to run
# there: looking for the crate's workspace, it passes the worktree's root
# manifest, which excludes the crate, and takes it for a stray member of the main
# checkout's. So --desktop needs a worktree outside the main checkout.
desktop_cargo() { (cd "$desktop_crate" && CARGO_TARGET_DIR="$desktop_target" cargo "$@"); }

# What `cargo fmt --all -- --check` runs in the desktop crate (ci.yml), without
# cargo and so from any worktree: rustfmt on each target's root file, with the
# crate's edition, which follows the modules from there.
desktop_fmt() {
	local edition file roots=()
	edition="$(sed -n 's/^edition *= *"\([0-9]*\)".*/\1/p' "$desktop_crate/Cargo.toml" | head -n 1)"
	for file in build.rs src/lib.rs src/main.rs src/bin/*.rs tests/*.rs benches/*.rs examples/*.rs; do
		[ ! -f "$desktop_crate/$file" ] || roots+=("$file")
	done
	(cd "$desktop_crate" && rustfmt --check --edition "${edition:-2021}" "${roots[@]}")
}

# Tauri resolves the sidecars while compiling; clippy and the tests neither run
# nor package them, so empty files do, as in ci.yml. A real one is kept.
desktop_clippy() {
	local name file
	for name in lasterm-agent lasterm-hub; do
		file="$desktop_crate/$name-$sidecar_triple$sidecar_ext"
		if [ ! -e "$file" ]; then
			: >"$file"
			echo "placed an empty $file for tauri to resolve"
		fi
	done
	desktop_cargo clippy --all-targets -- -D warnings
}

# The tests run against a throwaway profile. lasterm finds its state, config and
# cache directories from these variables alone (packages/shared/src/platform-dirs.ts,
# crates/lasterm-agent/src/platform_dirs.rs), so nothing a test starts can reach
# the user's own hub, agent or settings. The tools keep their real homes, which
# the same variables would otherwise move: corepack's cache above all, without
# which pnpm is fetched again, and fails without network before any test runs.
profile=""
isolated() {
	(
		if [ "$windows" = 1 ]; then
			local_app_data="$(cygpath -u "$LOCALAPPDATA")"
			[ -n "${VOLTA_HOME:-}" ] || [ ! -d "$local_app_data/Volta" ] ||
				export VOLTA_HOME="$(native "$local_app_data/Volta")"
			[ -n "${PNPM_HOME:-}" ] || [ ! -d "$local_app_data/pnpm" ] ||
				export PNPM_HOME="$(native "$local_app_data/pnpm")"
			export COREPACK_HOME="${COREPACK_HOME:-$(native "$local_app_data/node/corepack")}"
			export LOCALAPPDATA="$(native "$profile/LocalAppData")"
			export APPDATA="$(native "$profile/AppData")"
		else
			[ -n "${PNPM_HOME:-}" ] || [ ! -d "${XDG_DATA_HOME:-$HOME/.local/share}/pnpm" ] ||
				export PNPM_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/pnpm"
			export COREPACK_HOME="${COREPACK_HOME:-${XDG_CACHE_HOME:-$HOME/.cache}/node/corepack}"
			export XDG_CONFIG_HOME="$profile/config" XDG_STATE_HOME="$profile/state"
			export XDG_DATA_HOME="$profile/data" XDG_CACHE_HOME="$profile/cache"
			export XDG_RUNTIME_DIR="$profile/runtime"
		fi
		# Corepack has what it needs by now: the steps before ran pnpm unisolated.
		export COREPACK_ENABLE_NETWORK=0
		"$@"
	)
}

names=()
commands=()
step() {
	names+=("$1")
	shift
	commands+=("$*")
}
step biome pnpm exec biome check . --error-on-warnings
step shared-build pnpm -F @lasterm/shared build
step typecheck pnpm typecheck
step tls-material pnpm build:test-tls-material --locked
step test isolated pnpm test:run
step cargo-test isolated cargo test --workspace --no-fail-fast
step cargo-fmt cargo fmt --all -- --check
step clippy cargo clippy "${clippy_args[@]}"
step desktop-fmt desktop_fmt
if [ "$desktop" = 1 ]; then
	step desktop-clippy desktop_clippy
	step desktop-test isolated desktop_cargo test
fi

echo "checkout      $root"
dirty=""
[ -z "$(git status --porcelain)" ] || dirty=" + uncommitted changes"
echo "HEAD          $(git rev-parse --short HEAD)$dirty"
echo "cargo target  $CARGO_TARGET_DIR"
echo "desktop       $desktop_target"
echo "logs          $(mixed "$log_dir")"
if [ "$dry_run" = 1 ]; then
	for i in "${!names[@]}"; do printf '%-15s %s\n' "${names[$i]}" "${commands[$i]}"; done
	exit 0
fi

[ -d node_modules ] || {
	echo "no node_modules in $root: run pnpm install --frozen-lockfile first" >&2
	exit 2
}
mkdir -p "$log_dir" || exit 2
rm -f "$log_dir"/*.log "$log_dir/summary.txt"
profile="$(mktemp -d "${TMPDIR:-/tmp}/lasterm-check-profile.XXXXXX")" || exit 2
mkdir -p "$profile/LocalAppData" "$profile/AppData" "$profile/config" "$profile/state" \
	"$profile/data" "$profile/cache" "$profile/runtime"
# XDG_RUNTIME_DIR must be the user's alone; Windows has no use for it.
[ "$windows" = 1 ] || chmod 700 "$profile/runtime"
# A process a test left behind may still hold a file on Windows; the system
# temp folder then keeps what it holds.
trap 'rm -rf "$profile" 2>/dev/null' EXIT
echo

codes=()
started_all=$SECONDS
for i in "${!names[@]}"; do
	name="${names[$i]}"
	log="$log_dir/$name.log"
	started=$SECONDS
	printf '$ %s\n\n' "${commands[$i]}" >"$log"
	# The words were joined for the log only; eval runs them split again. Every
	# word in `step` above is a plain token, so nothing is re-expanded.
	eval "${commands[$i]}" >>"$log" 2>&1 </dev/null
	code=$?
	codes+=("$code")
	printf '%s: exit=%s (%ss)\n' "$name" "$code" "$((SECONDS - started))"
done

# ─── Summary ───────────────────────────────────────────────────────────────────

strip_colors() { sed -E 's/\x1b\[[0-9;]*[A-Za-z]//g' "$1"; }
cargo_counts() {
	strip_colors "$1" | awk '
		/^test result:/ {
			for (i = 2; i <= NF; i++) {
				if ($i == "passed;") passed += $(i - 1)
				if ($i == "failed;") failed += $(i - 1)
				if ($i == "ignored;") ignored += $(i - 1)
			}
			binaries++
		}
		END {
			if (binaries) printf "%d passed, %d failed, %d ignored (%d test binaries)\n", passed, failed, ignored, binaries
			else print "no test result"
		}'
}

summary() {
	local failed=() i name code
	echo "== summary: $label, $((SECONDS - started_all))s =="
	for i in "${!names[@]}"; do
		name="${names[$i]}"
		code="${codes[$i]}"
		echo "$name: exit=$code"
		[ "$code" = 0 ] || failed+=("$name")
	done
	echo
	if [ -f "$log_dir/test.log" ]; then
		echo "vitest:"
		strip_colors "$log_dir/test.log" | grep -E '^ *(Test Files|Tests|Errors) ' | sed 's/^ */  /'
		strip_colors "$log_dir/test.log" | grep -E '^ *(FAIL|×) ' | sort -u | head -20 | sed 's/^ */  /'
	fi
	for name in cargo-test desktop-test; do
		[ -f "$log_dir/$name.log" ] || continue
		echo "$name: $(cargo_counts "$log_dir/$name.log")"
		strip_colors "$log_dir/$name.log" | grep -E '^test .* \.\.\. FAILED$' | head -20 | sed 's/^/  /'
	done
	echo
	if [ ${#failed[@]} -eq 0 ]; then
		echo "all ${#names[@]} steps passed"
	else
		echo "${#failed[@]} of ${#names[@]} steps failed: ${failed[*]}"
		for name in "${failed[@]}"; do echo "  $(mixed "$log_dir/$name.log")"; done
	fi
}
echo
summary | tee "$log_dir/summary.txt"
for code in "${codes[@]}"; do [ "$code" = 0 ] || exit 1; done
exit 0
