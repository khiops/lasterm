# Build Matrix Refactoring — Design Spec

**Date:** 2026-03-23
**Status:** Draft
**Scope:** Build scripts, CI workflows, dead code cleanup, Node 24 prep

## Problem Statement

The lasterm build pipeline has five gaps:

1. **No macOS in CI** — SEA matrix only covers linux + windows
2. **No Linux desktop in CI** — Tauri `build-tauri` job is Windows-only
3. **No Windows dev scripts** — `dev-start.sh` is bash-only
4. **Scripts != CI** — CI duplicates logic instead of calling scripts
5. **Dead code** — Node TS agent (`@lasterm/agent`, `node-pty`, SEA agent scripts) superseded by Rust agent

## Goals

- Scripts are the **single source of truth** — CI calls them, never duplicates logic
- **Same pipeline locally and in CI** — env vars for platform differences
- **JSON build matrix** — toggle platforms with `"enabled": true/false` (CI minute budget)
- **Clean up dead code** — remove Node agent, node-pty, SEA agent scripts
- **Prepare Node 24** — env var support now, actual migration as separate block

## Non-Goals

- Linux desktop build (Tauri + webkit2gtk) — code ready but disabled
- macOS builds — code ready but disabled (CI minutes budget)
- CI test jobs — deferred until Windows build pipeline is stable
- Node 24 migration execution — separate verification block

## Architecture

### Script Layout

```
scripts/
  build-web.sh          # Linux/macOS: build web UI + embed manifest
  build-web.ps1         # Windows: same
  build-agent.sh        # Linux/macOS: cargo build Rust agent
  build-agent.ps1       # Windows: same
  build-hub.sh          # Linux/macOS: build hub SEA binary
  build-hub.ps1         # Windows: same
  build-desktop.sh      # Linux/macOS: orchestrator (web + agent + hub + Tauri)
  build-desktop.ps1     # Windows: same
  dev-start.sh          # Linux/macOS: start dev servers (exists, update)
  dev-start.ps1         # Windows: NEW
  dev-stop.sh           # Linux/macOS: stop dev servers (exists, update)
  dev-stop.ps1          # Windows: NEW
  dev-restart.sh        # Linux/macOS: stop + start (exists, update)
  dev-restart.ps1       # Windows: NEW
```

All `.sh` scripts target Linux + macOS only. Windows always uses `.ps1`.

### Environment Variables

| Variable | Default | Used by |
|----------|---------|---------|
| `LASTERM_NODE_VERSION` | Current Node version | `build-hub` via SEA binary packaging |
| `LASTERM_TARGET_TRIPLE` | Auto-detected via `uname` / PowerShell | All build scripts |
| `LASTERM_DIST_DIR` | `dist/sea` | `build-agent`, `build-hub` |
| `LASTERM_BUILD_HASH` | `git rev-parse --short=8 HEAD` | `build-web`, `build-hub` |
| `LASTERM_SKIP_WEB` | `false` | `build-hub`, `build-desktop` |
| `LASTERM_CARGO_TARGET_DIR` | `target` | `build-agent` |

### Auto-Detection

**bash (Linux/macOS):**
```bash
ARCH=$(uname -m)
case "$(uname -s)" in
  Linux)  TRIPLE="${ARCH}-unknown-linux-gnu" ;;
  Darwin) TRIPLE="${ARCH}-apple-darwin" ;;
  *)      echo "Unsupported OS. Use .ps1 on Windows." >&2; exit 1 ;;
esac
LASTERM_TARGET_TRIPLE="${LASTERM_TARGET_TRIPLE:-$TRIPLE}"
```

**PowerShell (Windows):**
```powershell
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "aarch64" } else { "x86_64" }
$env:LASTERM_TARGET_TRIPLE ??= "$arch-pc-windows-msvc"
```

## Script Flows

### build-web.sh / .ps1

```
1. LASTERM_BUILD_HASH ?= git rev-parse --short HEAD
2. pnpm -F @lasterm/shared build
3. LASTERM_BUILD_HASH=$hash pnpm -F @lasterm/web build
4. node scripts/embed-web.js    # dist/ -> packages/hub/static/
```

No native addons, no platform-specific logic. Identical everywhere.

### build-agent.sh / .ps1

```
1. Auto-detect LASTERM_TARGET_TRIPLE
2. cargo build -p lasterm-agent --release \
     --target-dir ${LASTERM_CARGO_TARGET_DIR:-target}
3. Copy binary -> ${LASTERM_DIST_DIR}/lasterm-agent{.exe}
```

Pure Rust build. `LASTERM_CARGO_TARGET_DIR` allows CI cache redirection.

### build-hub.sh / .ps1

```
1. Auto-detect LASTERM_TARGET_TRIPLE, LASTERM_BUILD_HASH
2. pnpm -F @lasterm/shared build
3. if LASTERM_SKIP_WEB != "true":
     call build-web script
4. LASTERM_DIST_DIR=$dist LASTERM_BUILD_HASH=$hash \
     tsx scripts/package-sea-hub.ts
```

Hub depends on web — builds it automatically unless `LASTERM_SKIP_WEB=true`.

### build-desktop.sh / .ps1 (orchestrator)

```
1. Auto-detect LASTERM_TARGET_TRIPLE
2. call build-web script
3. call build-agent script
4. LASTERM_SKIP_WEB=true call build-hub script
5. Copy sidecars -> packages/clients/desktop/src-tauri/
     lasterm-agent-${TRIPLE}{.exe}
     lasterm-hub-${TRIPLE}{.exe}
6. pnpm -F @lasterm/desktop tauri build --config '{"build":{"beforeBuildCommand":""}}'
```

Note: `tauri.conf.json`'s `beforeBuildCommand` points to the deleted `prepare-desktop.sh`.
We override it to empty at build time via `--config`. Alternatively, update `tauri.conf.json`
to remove `beforeBuildCommand` entirely in B7 (cleanup block).

### dev-start.sh / .ps1

```
1. Check: node, pnpm, cargo available
2. pnpm -F @lasterm/shared build
3. Start hub dev:  pnpm -F @lasterm/hub dev    (background, log -> .lasterm-hub.log)
4. Start web dev:  pnpm -F @lasterm/web dev    (background, log -> .lasterm-web.log)
5. Start agent daemon:
     Linux/macOS: cargo run -p lasterm-agent -- daemon
       Listens on UDS: ~/.local/state/lasterm/agent.sock
     Windows:     cargo run -p lasterm-agent -- daemon
       Listens on named pipe: \\.\pipe\lasterm-agent
6. Wait for agent readiness (poll socket/pipe existence, max 5s)
```

The `.ps1` is new — fills the Windows dev gap.

Agent daemon CLI: `lasterm-agent daemon [--socket <path>] [--buffer-per-channel <bytes>] [--buffer-global <bytes>]`.
On Windows, `--socket` accepts a named pipe path. Readiness check: test pipe existence via PowerShell `Test-Path \\.\pipe\lasterm-agent`.

### dev-stop.sh / .ps1

```
1. Kill hub dev (port 4100)
2. Kill web dev (port 5173)
3. Kill agent daemon (PID file / socket cleanup)
     Linux/macOS: rm ~/.local/state/lasterm/agent.sock
     Windows:     Stop-Process (agent PID from .lasterm-agent.pid)
```

### dev-restart.sh / .ps1

Thin wrapper: calls dev-stop then dev-start with same arguments.

## Dependency Graph

```
build-web ----------------------+
build-agent (Rust) -------------+---> build-desktop ---> Tauri
build-hub <--- build-web -------+
```

**CI model:** `build-agent` and `build-hub` run in parallel. `build-desktop` downloads pre-built artifacts — never rebuilds components.

**Local model:** `build-desktop.sh/.ps1` orchestrates all builds sequentially (web -> agent -> hub -> Tauri).

## CI Refactoring

### Build Matrix: `.github/build-matrix.json`

```json
{
  "targets": [
    {
      "triple": "x86_64-unknown-linux-gnu",
      "runner": "ubuntu-latest",
      "os": "linux",
      "arch": "x64",
      "shell_sh": true,
      "agent": true,
      "hub": true,
      "desktop": false,
      "enabled": true
    },
    {
      "triple": "x86_64-pc-windows-msvc",
      "runner": "windows-latest",
      "os": "windows",
      "arch": "x64",
      "shell_sh": false,
      "agent": true,
      "hub": true,
      "desktop": true,
      "enabled": true
    },
    {
      "triple": "aarch64-apple-darwin",
      "runner": "macos-latest",
      "os": "macos",
      "arch": "arm64",
      "shell_sh": true,
      "agent": true,
      "hub": true,
      "desktop": true,
      "enabled": false
    }
  ]
}
```

Toggle platform: change `"enabled"` — one field, one file.

### Workflow: `.github/workflows/build.yml`

```yaml
jobs:
  matrix:
    runs-on: ubuntu-latest
    outputs:
      agent: ${{ steps.filter.outputs.agent }}
      hub: ${{ steps.filter.outputs.hub }}
      desktop: ${{ steps.filter.outputs.desktop }}
    steps:
      - uses: actions/checkout@v4
      - id: filter
        run: |
          jq -c '{include:[.targets[]|select(.enabled and .agent)]}' \
            .github/build-matrix.json > /tmp/agent.json
          jq -c '{include:[.targets[]|select(.enabled and .hub)]}' \
            .github/build-matrix.json > /tmp/hub.json
          jq -c '{include:[.targets[]|select(.enabled and .desktop)]}' \
            .github/build-matrix.json > /tmp/desktop.json
          echo "agent=$(cat /tmp/agent.json)" >> "$GITHUB_OUTPUT"
          echo "hub=$(cat /tmp/hub.json)" >> "$GITHUB_OUTPUT"
          echo "desktop=$(cat /tmp/desktop.json)" >> "$GITHUB_OUTPUT"

  build-web:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: "22", cache: "pnpm" }
      - run: pnpm install --frozen-lockfile
      - run: ./scripts/build-web.sh
      - uses: actions/upload-artifact@v4
        with: { name: web-dist-raw, path: packages/clients/web/dist/ }
      - uses: actions/upload-artifact@v4
        with: { name: web-dist-embedded, path: packages/hub/static/ }

  build-agent:
    needs: [matrix]
    strategy:
      matrix: ${{ fromJson(needs.matrix.outputs.agent) }}
    runs-on: ${{ matrix.runner }}
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with: { components: "clippy, rustfmt" }
      - uses: Swatinem/rust-cache@v2
      - name: Format check
        run: cargo fmt --all -- --check
      - name: Clippy
        run: cargo clippy --all-targets -- -D warnings
      - name: Test
        run: cargo test
      - name: Build (bash)
        if: matrix.shell_sh
        run: ./scripts/build-agent.sh
        env:
          LASTERM_TARGET_TRIPLE: ${{ matrix.triple }}
      - name: Build (pwsh)
        if: ${{ !matrix.shell_sh }}
        shell: pwsh
        run: .\scripts\build-agent.ps1
        env:
          LASTERM_TARGET_TRIPLE: ${{ matrix.triple }}
      - uses: actions/upload-artifact@v4
        with:
          name: agent-${{ matrix.triple }}
          path: dist/sea/lasterm-agent*

  build-hub:
    needs: [matrix, build-web]
    strategy:
      matrix: ${{ fromJson(needs.matrix.outputs.hub) }}
    runs-on: ${{ matrix.runner }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: "22" }
      - run: pnpm install --frozen-lockfile
      - uses: actions/download-artifact@v4
        with: { name: web-dist-embedded, path: packages/hub/static/ }
      - name: Build (bash)
        if: matrix.shell_sh
        run: ./scripts/build-hub.sh
        env:
          LASTERM_SKIP_WEB: "true"
          LASTERM_TARGET_TRIPLE: ${{ matrix.triple }}
      - name: Build (pwsh)
        if: ${{ !matrix.shell_sh }}
        shell: pwsh
        run: .\scripts\build-hub.ps1
        env:
          LASTERM_SKIP_WEB: "true"
          LASTERM_TARGET_TRIPLE: ${{ matrix.triple }}
      - uses: actions/upload-artifact@v4
        with:
          name: hub-${{ matrix.triple }}
          path: dist/sea/lasterm-hub*

  build-desktop:
    needs: [matrix, build-agent, build-hub, build-web]
    strategy:
      matrix: ${{ fromJson(needs.matrix.outputs.desktop) }}
    runs-on: ${{ matrix.runner }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: "22" }
      - uses: dtolnay/rust-toolchain@stable
      - uses: Swatinem/rust-cache@v2
      - run: pnpm install --frozen-lockfile
      - uses: actions/download-artifact@v4
        with: { name: agent-${{ matrix.triple }}, path: dist/sea/ }
      - uses: actions/download-artifact@v4
        with: { name: hub-${{ matrix.triple }}, path: dist/sea/ }
      - uses: actions/download-artifact@v4
        with: { name: web-dist-raw, path: packages/clients/web/dist/ }
      - name: Place sidecars + build (bash)
        if: matrix.shell_sh
        run: |
          TRIPLE="${{ matrix.triple }}"
          cp dist/sea/lasterm-agent "packages/clients/desktop/src-tauri/lasterm-agent-${TRIPLE}"
          cp dist/sea/lasterm-hub "packages/clients/desktop/src-tauri/lasterm-hub-${TRIPLE}"
          pnpm -F @lasterm/desktop tauri build --config '{"build":{"beforeBuildCommand":""}}'
      - name: Place sidecars + build (pwsh)
        if: ${{ !matrix.shell_sh }}
        shell: pwsh
        run: |
          $triple = "${{ matrix.triple }}"
          Copy-Item dist\sea\lasterm-agent.exe "packages\clients\desktop\src-tauri\lasterm-agent-$triple.exe"
          Copy-Item dist\sea\lasterm-hub.exe "packages\clients\desktop\src-tauri\lasterm-hub-$triple.exe"
          pnpm -F @lasterm/desktop tauri build --config '{\"build\":{\"beforeBuildCommand\":\"\"}}'
      - uses: actions/upload-artifact@v4
        with:
          name: desktop-${{ matrix.triple }}
          path: |
            packages/clients/desktop/src-tauri/target/release/bundle/**/*.msi
            packages/clients/desktop/src-tauri/target/release/bundle/**/*.exe
            packages/clients/desktop/src-tauri/target/release/bundle/**/*.dmg
            packages/clients/desktop/src-tauri/target/release/bundle/**/*.deb
```

### Deleted Workflows

- `.github/workflows/rust-agent.yml` — absorbed into `build-agent` job

### Workflow: `.github/workflows/ci.yml`

Kept as-is — thin wrapper that calls `build.yml` via `workflow_call`.
Triggers: `push` to main, `pull_request` to main, `workflow_dispatch`.
No changes needed since `build.yml` retains `on: workflow_call`.

### Workflow: `.github/workflows/release.yml`

Structure unchanged — calls `build.yml` then creates GitHub Release.
**Artifact download patterns must be updated:**

| Old pattern | New pattern |
|-------------|-------------|
| `sea-*` | `agent-*`, `hub-*` |
| `tauri-*` | `desktop-*` |

Release assets naming:
```
lasterm-agent-x86_64-unknown-linux-gnu
lasterm-agent-x86_64-pc-windows-msvc.exe
lasterm-hub-x86_64-unknown-linux-gnu
lasterm-hub-x86_64-pc-windows-msvc.exe
lasterm-desktop-x86_64-pc-windows-msvc.msi
lasterm-desktop-x86_64-pc-windows-msvc-setup.exe
```

## TS Script Modifications

### `scripts/package-sea-hub.ts`

Add env var reading at the top:

```typescript
const distDir = process.env.LASTERM_DIST_DIR ?? 'dist/sea';
const buildHash = process.env.LASTERM_BUILD_HASH
  ?? execFileSync('git', ['rev-parse', '--short', 'HEAD']).toString().trim();
const targetPlatform = tripleToNodePlatform(process.env.LASTERM_TARGET_TRIPLE)
  ?? process.platform;
const targetArch = tripleToNodeArch(process.env.LASTERM_TARGET_TRIPLE)
  ?? process.arch;
const nodeVersion = process.env.LASTERM_NODE_VERSION ?? process.version;
```

Helper function `tripleToNodePlatform`:
- `x86_64-unknown-linux-gnu` -> `linux`
- `x86_64-pc-windows-msvc` -> `win32`
- `aarch64-apple-darwin` -> `darwin`

Existing CLI args (`--target-platform`, etc.) remain as overrides during transition.

### `scripts/build-sea-binary.ts`

Read `LASTERM_NODE_VERSION` as fallback for `targetNodeVersion`.

## Dead Code Cleanup

### Delete Entirely

| Path | Reason |
|------|--------|
| `packages/agent/` | Node TS agent replaced by Rust agent |
| `scripts/package-sea-agent.ts` | SEA agent packaging — no longer needed |
| `scripts/build-sea-agent.ts` | SEA agent esbuild config — no longer needed |
| `scripts/rename-sea-binaries.sh` | Old SEA naming, superseded by per-component artifacts |
| `scripts/prepare-desktop.sh` | Replaced by `build-desktop.sh` |
| `scripts/build-desktop-windows.ps1` | Replaced by `build-desktop.ps1` |
| `.github/workflows/rust-agent.yml` | Merged into `build.yml` |

Also delete any test files for removed scripts (e.g. `*.spec.ts` files for `build-sea-agent`, `package-sea-agent`, `rename-sea-binaries`) if they exist.

### Modify

| File | Change |
|------|--------|
| `package.json` (root) | Remove `build:sea-agent`, `package:sea-agent` scripts |
| `pnpm-workspace.yaml` | Remove `node-pty` from `onlyBuiltDependencies` |
| `pnpm-workspace.yaml` | Remove agent-only catalog entries: `node-pty`, `@xterm/headless`, `@xterm/addon-serialize` |
| `pnpm-workspace.yaml` | Remove `packages/agent` from workspace if listed explicitly |
| `tauri.conf.json` | Remove or empty `beforeBuildCommand` (pointed to deleted `prepare-desktop.sh`) |

### Keep

- `@msgpack/msgpack` — shared/hub/web still use it
- `scripts/build-sea-binary.ts` — still used by hub SEA packaging
- `scripts/package-sea-hub.ts` — still used, gets env var additions
- `scripts/embed-web.js` — still used by build-web

### Prerequisite: `pnpm install` on target platform

The `build-hub` script requires `pnpm install` to have been run on the target platform
so that `better-sqlite3` (sole remaining native Node addon) is compiled for the correct
platform. This is implicit — CI does it via `pnpm install --frozen-lockfile` on each runner.

## Node 24 Migration (Separate Block)

**Not part of this implementation.** Executed after scripts are functional.

Steps:
1. Install Node 24 LTS locally
2. `pnpm install` (rebuild native addons)
3. `pnpm test` (all tests pass?)
4. `pnpm run package:sea-hub` (SEA blob works?)
5. Execute resulting SEA binary
6. If pass: bump `engines`, CI `node-version`, `LASTERM_NODE_VERSION` default

## Implementation Blocks

| Block | Description | Files | Depends on |
|-------|-------------|-------|------------|
| B1 | Build scripts (component) | `build-web.sh/.ps1`, `build-agent.sh/.ps1`, `build-hub.sh/.ps1` | — |
| B2 | Build script (orchestrator) | `build-desktop.sh/.ps1` | B1 |
| B3 | Dev scripts (Windows) | `dev-start.ps1`, `dev-stop.ps1`, `dev-restart.ps1` | — |
| B4 | Env var support in TS | `package-sea-hub.ts`, `build-sea-binary.ts` | — |
| B5 | Build matrix JSON | `.github/build-matrix.json` | — |
| B6 | CI refactoring | `build.yml`, `release.yml`, `ci.yml` (verify) | B1, B4, B5 |
| B7 | Dead code cleanup | Delete agent package, SEA agent scripts, old workflows, update `tauri.conf.json` | B1, B6 |
| B8 | Node 24 migration | Verification + bump | B1-B7 complete |

Parallelizable: B1 + B3 + B4 + B5 (all independent). B2 after B1. B6 after B1 + B4 + B5. B7 after B6.

## Exit Criteria

- [ ] All build scripts work locally on Linux (tested in WSL)
- [ ] All build scripts work locally on Windows (tested natively)
- [ ] CI produces artifacts for linux-x64 and windows-x64
- [ ] macOS target exists in matrix but `enabled: false`
- [ ] Linux desktop target exists in matrix but `enabled: false`
- [ ] `packages/agent/` deleted, no `node-pty` in dependencies
- [ ] `rust-agent.yml` deleted, Rust agent tested in `build.yml`
- [ ] No hardcoded paths in build scripts — all configurable via env vars
- [ ] Node 24 migration verified locally (separate block)
