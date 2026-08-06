---
doc-meta:
  status: canonical
  created: 2026-03-09
  updated: 2026-03-13
---

# Packaging & Distribution Strategy

> **Project:** termora

## Problem

termora has three distinct runtime components:
- **Agent** — PTY manager (node-pty, MessagePack codec). Runs on remote machines.
- **Hub** — Orchestrator (Fastify, better-sqlite3, ssh2). Runs on the user's machine or a server.
- **Web UI** — Vue 3 SPA (embedded by hub as static files, or served by Vite in dev)

Distribution must support two parallel channels:
1. ~~**npm** — full ecosystem support, every package installable via npm/npx~~
   **Dropped (#158.)** The unscoped `termora` on npm belongs to an unrelated
   project, so this channel was never available under that name; the standalone
   binary also embeds its own Node, which removes the requirement npm would add
   back. Every package is now marked private.
2. **Standalone binaries** — zero-prerequisite deployment, no Node.js needed

The agent binary is the highest-impact deliverable: remote machines should not require Node.js.

## Architecture: Two Binaries + Optional Desktop Shell

```
┌─────────────────────────────────────────────────────────┐
│  BINARIES                                               │
│                                                         │
│  termora-agent  (Node SEA, ~20-30MB)                    │
│    └── node-pty, msgpack codec                          │
│                                                         │
│  termora-hub    (Node SEA, ~50-60MB)                    │
│    └── fastify, better-sqlite3, web UI static           │
│                                                         │
│  Tauri app      (optional desktop shell)                │
│    └── sidecar: termora-hub                             │
│    └── webview → hub's web UI                           │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│  DISTRIBUTION CHANNELS                                  │
│                                                         │
│  npm (all packages) — GitHub Releases (binaries)        │
│  winget / scoop (Windows) — brew (macOS/Linux)          │
│  Tauri installers (.exe / .dmg / .AppImage)             │
└─────────────────────────────────────────────────────────┘
```

## Decisions (validated 2026-03-13)

| # | Decision | Chosen | Rejected | Why |
|---|----------|--------|----------|-----|
| D1 | Binary split | Two separate binaries (agent + hub) | Single combined binary | Independent deployment, agent on remote machines |
| D2 | Hub ↔ Agent local | Hub finds `termora-agent` in PATH or same directory | Embedded/extracted agent | Simple, installer handles placement |
| D3 | Native addons | Node SEA native `assets` field + `getRawAsset()` + `process.dlopen()` (tmpdir extraction) | Ship .node files alongside, @aspect/node-addon-loader (does not exist) | Official Node.js API, single file, tmpdir available on all platforms |
| D4 | SEA engine | Node SEA (Node 22+) | pkg (abandoned), nexe (fragile), Bun compile (no native addons) | Official Node.js feature, maintained |
| D5 | Desktop shell | Tauri v2 | Electron (150MB), Neutralino | Lightweight (~5MB), system webview, native features |
| D6 | Tauri sidecar | Hub binary directly (no glue) | Intermediate manager process | Tauri has native sidecar lifecycle API |
| D7 | npm publishing | ~~ALL packages published~~ — **superseded, #158** | Hub excluded | The unscoped name belongs to another project, and the binary embeds its own Node |
| D8 | Auto-deploy agent | Hub deploys agent binary via SSH | Manual install only | Zero-setup remote machines, killer feature |
| D9 | Remote OS detection | Host `os`/`arch` field in DB + auto-detect fallback | SSH-only detection | User knows target OS at host creation, more reliable |
| D10 | Windows installer | NSIS .exe | .msix (requires signing cert) | No signing cert needed for MVP |

## Host OS/Arch Model

Hosts gain `os` and `arch` fields:

```typescript
interface Host {
  // ... existing fields
  os: 'linux' | 'darwin' | 'windows' | null;    // null = auto-detect
  arch: 'x64' | 'arm64' | null;                 // null = auto-detect
}
```

- **Host add modal:** OS/arch selector (optional, default "Auto-detect")
- **First SSH connection:** if null, detect via `uname -sm` (Linux/macOS) or `%PROCESSOR_ARCHITECTURE%` (Windows), update host record
- **Used by:** auto-deploy agent, launch profiles (OS-aware filtering), UI hints

## Phase 1: npm pack (current)

**Goal:** Test on Windows immediately, no publishing required.

```bash
cd /mnt/wsl/shared/dev/termora
pnpm build && npm pack          # → termora-0.1.0.tgz
# On target: npm i -g ./termora-0.1.0.tgz && termora
```

Native addons mitigated via `prebuild-install` (both node-pty & better-sqlite3 support prebuilt binaries).

## Phase 2a: Agent SEA Binary

**Goal:** Standalone agent binary deployable via `scp` on any remote machine.

### What goes in

| Dependency | Included | Why |
|------------|----------|-----|
| node-pty | yes (native addon via loader) | PTY management |
| @msgpack/msgpack | yes (bundled JS) | Wire protocol |
| @termora/shared (codec) | yes (bundled JS) | Framing, types |
| better-sqlite3 | **no** | Agent has no DB |
| fastify | **no** | Agent has no HTTP |

### Build process

```bash
# 1. Bundle agent JS into single file
esbuild packages/agent/src/main.ts --bundle --platform=node --outfile=dist/agent.cjs

# 2. Configure native addon loader for node-pty
# (embeds .node as asset, extracts to tmpdir at runtime)

# 3. Generate SEA blob + inject into Node binary
node --experimental-sea-config sea-config-agent.json
cp $(which node) dist/termora-agent
npx postject dist/termora-agent NODE_SEA_BLOB dist/sea-prep.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
```

### Result

- `termora-agent` / `termora-agent.exe` — ~20-30MB single file
- Deploy: `scp termora-agent user@host:~/bin/ && chmod +x ~/bin/termora-agent`
- No Node.js, no npm, no build tools on the remote machine

## Phase 2b: Hub SEA Binary

**Goal:** Standalone hub binary with embedded web UI.

### What goes in

| Dependency | Included | Why |
|------------|----------|-----|
| fastify + plugins | yes (bundled JS) | HTTP/WS server |
| better-sqlite3 | yes (native addon via loader) | Storage |
| ssh2 | yes (bundled JS) | Remote agent connections |
| @termora/shared | yes (bundled JS) | Codec, types, config |
| Web UI (dist/) | yes (embedded static) | Serves at / |
| node-pty | **no** | Agent's responsibility |

### Result

- `termora-hub` / `termora-hub.exe` — ~50-60MB single file
- Requires `termora-agent` in PATH or same directory for local sessions
- Serves web UI at `http://localhost:4100`

## Phase 2c: CI Build Matrix

GitHub Actions matrix (`.github/build-matrix.json`). Agents build for ALL
architectures — release assets feed the remote-deploy binary cache. The hub
and desktop app build in CI for Windows only: Linux is the daily local dev
platform (`./scripts/build-hub.sh`), and macOS has no test hardware.

| Platform | Agent | Hub | Desktop |
|----------|-------|-----|---------|
| Windows x64 | `termora-agent.exe` | `termora-hub.exe` | NSIS/MSI |
| Linux x64 | `termora-agent` | local build only | — |
| Linux arm64 | `termora-agent` | — | — |
| macOS | disabled (no test hardware) | — | — |

Artifacts uploaded to GitHub Releases per version tag.

## Phase 2d: Auto-Deploy Agent

**Goal:** Hub automatically deploys agent binary on remote hosts via SSH.

### Flow

1. User adds host (OS/arch from modal, or "auto-detect")
2. User clicks "Connect" → hub opens SSH to host
3. If agent not found on remote:
   a. Detect OS/arch if not set: `uname -sm` (Linux/macOS) or `echo %PROCESSOR_ARCHITECTURE%` (Windows cmd)
   b. Select matching binary from local cache (`~/.local/state/termora/binaries/`)
   c. Upload via SFTP: `~/.local/bin/termora-agent` (Linux/macOS) or `%LOCALAPPDATA%\termora\termora-agent.exe` (Windows)
   d. `chmod +x` (Linux/macOS)
   e. Launch agent over SSH as usual

### Binary cache

Hub downloads or ships with agent binaries for all platforms:
```
~/.local/state/termora/binaries/
├── termora-agent-linux-x64
├── termora-agent-linux-arm64
├── termora-agent-darwin-arm64
├── termora-agent-darwin-x64
└── termora-agent-windows-x64.exe
```

Source: embedded in hub package, or downloaded from GitHub Releases on first need.

## Phase 3: Tauri Desktop App

**Goal:** Native desktop experience replacing the browser tab.

### Architecture

```
┌─────────────────────────────────────────────────┐
│  Tauri app (~5MB Rust shell)                    │
│  ├── System webview (Edge/WebKit/WebKitGTK)     │
│  │   └── loads hub web UI (localhost:4100)       │
│  ├── Sidecar: termora-hub (Node SEA binary)     │
│  │   └── spawns termora-agent for local sessions│
│  └── Native features:                           │
│      ├── System tray icon + menu                │
│      ├── Auto-updater (GitHub Releases)         │
│      ├── Native notifications                   │
│      ├── Deep links (termora://)                │
│      └── Global keyboard shortcuts              │
└─────────────────────────────────────────────────┘
```

### Tauri as browser replacement

Tauri is an **optional client**, not a prerequisite. The web UI remains the reference client.

| Mode | Description | Use case |
|------|-------------|----------|
| **Browser** | `http://localhost:4100` in any browser | Dev, headless servers, quick access |
| **Tauri local** | App starts hub as sidecar, loads webview | Daily desktop use |
| **Tauri remote** | App connects to a remote hub | Multi-device, mobile (future) |

### Sidecar = hub binary directly

No glue layer. Tauri's built-in sidecar API manages the hub process:

```json
// tauri.conf.json
{
  "bundle": {
    "externalBin": ["binaries/termora-hub"]
  }
}
```

Tauri start → spawn `termora-hub --port 4100` → webview loads `localhost:4100`.
Tauri close → kill hub gracefully.

### Build output

| Platform | Installer | Size |
|----------|-----------|------|
| Windows | `.exe` (NSIS) | ~65MB |
| macOS | `.dmg` | ~60MB |
| Linux | `.AppImage` + `.deb` | ~60MB |

## npm Publishing (parallel channel) — SUPERSEDED, see #158

The decision below is kept as the record of what was decided; it no longer describes
what happens. Nothing publishes to npm, every package is marked private, and a
recursive publish releases nothing.

| Package | npm name | bin | Use case |
|---------|----------|-----|----------|
| Root CLI | `termora` | not published | built from this repository — npm dropped, see #158 |
| Agent | `@termora/agent` | `termora-agent` | `npm i -g` on remote machines with Node |
| Hub | `@termora/hub` | — | `npm i -g` for Node.js users |
| Shared | `@termora/shared` | — | Library for integrators/plugins |
| Web | `@termora/web` | — | NOT published (embedded in hub) |

## Distribution Channels

### Phase 2 (SEA binaries)

| Channel | Format | Priority |
|---------|--------|----------|
| GitHub Releases | Single-file per platform | P0 |
| npm registry | All packages | P0 |
| Scoop (Windows) | Bucket manifest | P1 |
| Homebrew (macOS/Linux) | Tap formula | P1 |

### Phase 3 (Tauri app)

| Channel | Format | Priority |
|---------|--------|----------|
| GitHub Releases | Platform installers | P0 |
| winget (Windows) | .exe + YAML manifest | P1 |
| Homebrew Cask (macOS) | Cask formula | P1 |
| Flathub (Linux) | Flatpak manifest | P2 |
| Snap Store (Linux) | snapcraft.yaml | P2 |

## Implementation Phases

| Phase | What | Depends on | Deliverable |
|-------|------|------------|-------------|
| **2a** | Agent SEA binary | esbuild + postject + node-addon-loader | `termora-agent` single file |
| **2b** | Hub SEA binary | 2a + embed web build | `termora-hub` single file |
| **2c** | CI matrix | 2a + 2b | GitHub Actions → Releases |
| **2d** | Auto-deploy agent | 2a + 2c + host os/arch field | Hub deploys agent via SSH |
| **3** | Tauri desktop app | 2b | Native app + installers |
