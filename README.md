# termora

A local-first session terminal platform. Hub daemon + remote agents + SSH transport + PWA UI.
Sessions survive client disconnects and device switches; local sessions also survive hub restarts.

![Status](https://img.shields.io/badge/status-under%20active%20development-yellow)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![License](https://img.shields.io/badge/license-AGPL--3.0--only-blue)

> **Not yet published to npm.** Under active development.

---

## Features

- **Session persistence** — terminal sessions outlive client/UI disconnects and device switches; reconnect and resume exactly where you left off. Local sessions also survive hub restarts. (Surviving a dropped SSH *transport* to a remote host — so a remote session keeps running across a network blip — is on the roadmap, not yet shipped.)
- **SSH stdio transport** — agents run over SSH stdio; no extra ports opened on remote machines
- **Local-first** — the hub daemon owns all state; the UI is a thin client that can come and go
- **Multi-device** — attach to the same session from any browser or device; write-lock prevents conflicting input
- **Remote agents** — same agent binary runs locally (child process) or remotely (SSH); hub handles both identically
- **Custom themes** — per-host and per-channel visual identity with Discord-style host rail
- **Launch profiles** — named shell configurations with environment, working directory, and elevation settings
- **Elevation support** — configurable elevation methods per host (sudo, doas, pkexec, gsudo, custom)
- **Config cascade** — 4-layer deep merge: built-in defaults → `config.toml` → host profile → channel profile

---

## Quick Start

Once published to npm:

```sh
npx termora
```

Open `http://localhost:4100` in your browser.

---

## Architecture

```
UI (Vue 3 + xterm.js) ──── WS + REST ──── Hub (Fastify, 127.0.0.1:4100)
                                            ├── Local Agent (child_process, stdio)
                                            ├── Remote Agent (ssh2, stdio)
                                            ├── meta.db  (hosts, sessions, workspaces)
                                            └── spool.db (output chunks, snapshots)

Agent (local or remote, same binary):
	stdin  → MessagePack frames → PTY manager (node-pty) → N channels
	stdout ← MessagePack frames ← OUTPUT / SNAPSHOT

Hub never touches PTY directly — the agent is the universal PTY manager.
```

The hub daemon binds to `127.0.0.1:4100` and serves both the REST API (`/api/*`) and the WebSocket endpoint (`/ws`). All PTY management is delegated to the agent process, whether local or remote.

### Agent distribution

The hub bundles the agent binary for **its own** OS/arch (used for local sessions, available offline at
install). Agents for **remote** SSH hosts of other OS/arch are **not** bundled — the hub downloads the
matching, version-matched, checksum-verified binary from GitHub Releases on demand and uploads it to the host
over SFTP, so the remote host never needs outbound internet. Pre-populate with `termora-hub agent fetch
<os-arch> | --all`.

> **Air-gapped note:** this assumes the **hub** has outbound internet. If the hub itself is air-gapped, a
> fetch fails with an actionable message (download URL + cache path + filename); download the binary and its
> `SHA256SUMS` on a connected machine, transfer them, and drop them in the binary cache. See
> [`docs/SPEC.md` §3.5](docs/SPEC.md) for the full distribution model.

---

## Packages

| Package | npm name | Description |
|---------|----------|-------------|
| `packages/shared` | `@termora/shared` | Protocol types, MessagePack codec, entity types, config types |
| `packages/agent` | `@termora/agent` | PTY manager — node-pty + xterm.js headless + MessagePack protocol handler |
| `packages/hub` | `@termora/hub` | Fastify daemon — session manager, client manager, storage, SSH transport |
| `packages/clients/web` | `@termora/web` | Vue 3 PWA — embedded in hub at build time, not published separately |
| `packages/clients/desktop` | `@termora/desktop` | Tauri desktop app wrapping the hub as a sidecar (P1) |
| root | `termora` | CLI entrypoint — thin wrapper around `@termora/hub` (`npx termora`) |

---

## Development

### Prerequisites

- Node.js >= 20 LTS
- pnpm >= 9

### Setup

```sh
# Install all dependencies
pnpm install

# Start hub + UI dev servers concurrently
pnpm dev
```

The hub starts on `http://localhost:4100` and the Vite dev server on `http://localhost:5173`.

### Commands

```sh
pnpm build            # Build all packages
pnpm test             # Run all tests (vitest)
pnpm lint             # Lint + format check (biome)
pnpm lint:fix         # Auto-fix lint issues

# Single-package operations
pnpm -F @termora/hub test
pnpm -F @termora/web dev
```

### Headless local-spawn testing

Use the headless harness to exercise the hub WebSocket `AUTH` + `SPAWN` path without opening
the browser or touching your real Termora state:

```sh
scripts/dev/headless-hub-test.sh start   # isolated hub on :4199 with debug logging enabled
scripts/dev/headless-hub-test.sh spawn   # run AUTH + SPAWN probe
scripts/dev/headless-hub-test.sh logs    # hub connection-lifecycle log tail
scripts/dev/headless-hub-test.sh alog    # local agent daemon log tail
scripts/dev/headless-hub-test.sh stop
scripts/dev/headless-hub-test.sh reset
```

The harness writes all config, runtime, and state under `.tt/headless-hub/`. Override the
location or port with `TT_DIR=/tmp/termora-headless` or `TT_PORT=4201`. The hub's dev
agent resolver uses `target/release/termora-agent`, so rebuild that binary after Rust changes
before relying on the agent daemon log tail.

### Production build (single executable)

Build a self-contained release locally (Linux/macOS native):

```sh
./scripts/build-agent.sh   # Rust agent → dist/sea/termora-agent  (cargo --release)
./scripts/build-hub.sh     # Hub SEA    → dist/sea/termora-hub
                           #   builds the web UI, embeds it, bundles better-sqlite3,
                           #   and produces a Node Single Executable Application
```

Both binaries land co-located in `dist/sea/`; the hub resolves the agent next to its own executable. Run it:

```sh
cd dist/sea
./termora-hub start --port 4100   # serves the PWA at http://127.0.0.1:4100  (add --daemon / --open)
./termora-hub pair                # prints an 8-digit code to authorise a new browser client
./termora-hub status              # or: ./termora-hub stop
```

Config lives in `~/.config/termora`, runtime state in `~/.local/state/termora`.

> A native SEA embeds the host Node runtime, so build on the OS you target — a cross-platform binary
> (e.g. the Windows hub) must be produced on that platform.

### Release MSIX identity

The release workflow only builds and uploads the MSIX installer when the repository has the Partner Center
package identity configured as GitHub repository variables. Set these once under
`Settings` -> `Secrets and variables` -> `Actions` -> `Variables`:

| Variable | Value |
|----------|-------|
| `MSIX_IDENTITY_NAME` | Partner Center package/identity name |
| `MSIX_PUBLISHER` | Partner Center publisher subject, for example `CN=...` |
| `MSIX_PUBLISHER_DISPLAY_NAME` | Publisher display name shown for the app |

If any of these variables are unset, `release.yml` skips the MSIX build and upload but still ships the NSIS
and MSI desktop installers. The CI inspection build in `build.yml` still creates its placeholder MSIX artifact
unconditionally.

---

## Configuration

termora reads configuration from a TOML file:

- **Linux / macOS:** `~/.config/termora/config.toml`
- **Windows:** `%APPDATA%\termora\config.toml`

State (databases, runtime socket) is stored in:

- **Linux / macOS:** `~/.local/state/termora/`
- **Windows:** `%LOCALAPPDATA%\termora\`

The port defaults to `4100` and can be overridden via:

1. CLI flag `--port`
2. Environment variable `TERMORA_PORT`
3. `port` key in `config.toml`

Terminal background settings live in `[terminal]` and cascade to host/channel profiles:

```toml
[terminal]
wallpaper = "forest.webp"
wallpaper_blur = 4
wallpaper_dim = 25

# image = wallpaper when set, otherwise solid; solid = opaque theme background;
# transparent = desktop transparency in Tauri, solid fallback in browsers.
background_mode = "transparent"

# Desktop-only native effect. auto maps to blur on Windows 10, mica on Windows 11,
# vibrancy-under-window on macOS, and none on Linux.
window_effect = "auto"
```

In `zero_conf` mode the hub auto-increments from 4100 to 4199 if the default port is taken, and writes the actual port to `runtime.json` in the state directory.

---

## License

termora is licensed per component:

| Component | License |
|-----------|---------|
| `termora` (CLI), `@termora/hub`, `@termora/web`, `@termora/desktop`, `crates/termora-agent` | [AGPL-3.0-only](./LICENSE) |
| [`@termora/shared`](./packages/shared) | [MIT](./packages/shared/LICENSE-MIT) OR [Apache-2.0](./packages/shared/LICENSE-APACHE) |

The async PTY library was extracted to its own repository,
[khiops/async-xpty](https://github.com/khiops/async-xpty) (MIT OR Apache-2.0).

The application is AGPL so termora stays fully free software and self-hostable — including
when run as a network service. The standalone libraries are permissively dual-licensed for
ecosystem adoption.

**This licensing is permanent.** The launch license is a commitment, not a starting point:
the application components will remain AGPL-3.0-only and the libraries will remain
MIT OR Apache-2.0.

Contributions are accepted under the [Developer Certificate of Origin](https://developercertificate.org/)
(inbound = outbound). There is no CLA.
