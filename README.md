# lasterm

A local-first session terminal platform. Hub daemon + remote agents + SSH transport + PWA UI.
Sessions survive client disconnects and device switches; local sessions also survive hub restarts,
and so do remote ones on hosts that keep an agent running.

![Status](https://img.shields.io/badge/status-under%20active%20development-yellow)
![Node](https://img.shields.io/badge/node-%3E%3D24-brightgreen)
![License](https://img.shields.io/badge/license-AGPL--3.0--only-blue)

> **Not yet published to npm.** Under active development.

---

## Features

- **Session persistence** — terminals outlive client/UI disconnects and device switches; reattach and the hub restores the screen from its snapshot and spool. Local terminals also survive hub restarts: they run in a detached agent daemon the hub reconnects to.
- **Remote terminals that outlive the connection** — a remote host can keep an agent running (`[ssh] remote_daemon`, or "Keep an agent running there" in the host's settings). Its terminals then survive a dropped SSH connection and a hub restart. Without it, and on Windows remotes, their shells end with the connection, and a reconnect starts new ones in their place.
- **SSH transport** — agents are reached over SSH, on stdio or through a daemon's Unix socket; no port is opened on remote machines. A host can be reached through a jump host (ProxyJump), reconnects included, and one that stops answering is noticed within a minute.
- **Local-first** — the hub daemon owns all state; the UI is a thin client that can come and go
- **Multi-client** — the desktop app and browsers on the same machine attach to the same terminal; a write lock keeps one writer at a time. Pairing another device is not delivered yet (#193)
- **Remote agents** — the same Rust agent binary runs locally (a detached daemon) or remotely (over SSH); the hub deploys it to each host, matched to its OS and architecture
- **Terminal environment** — each terminal starts from its agent's environment or a minimal one, says what it is (`TERM`, `COLORTERM`, `TERM_PROGRAM`), and takes the changes set globally, per host or per terminal in Settings › Environment. On an SSH host, the host's default shell starts as a login shell, as `ssh host` gives one
- **Ended terminals** — a pane over an ended terminal offers Restart and Close, or follows "When a terminal ends" (Ask, Restart, Close), set globally, per host or per terminal. A restart whose host is away waits for it
- **Custom themes** — per-host and per-channel visual identity with Discord-style host rail
- **Launch profiles** — named shell configurations with environment, working directory, and elevation settings
- **Elevation support** — configurable elevation methods per host (sudo, doas, pkexec, gsudo, custom)
- **Config cascade** — 4-layer deep merge: built-in defaults → `config.toml` → host profile → channel profile
- **Installable web UI, and a desktop app** — the hub serves a PWA, and a tab that outlived a hub upgrade reloads onto the hub's UI. The Tauri desktop app launches its own hub, and on Windows 11 can paint Mica or Acrylic behind the terminal

---

## Quick Start

Build it from this repository:

```sh
pnpm install
./scripts/build-agent.sh        # Rust agent → dist/sea/lasterm-agent
./scripts/build-hub.sh          # hub SEA    → dist/sea/lasterm-hub
./dist/sea/lasterm-hub start
```

Both binaries, in that order: `build-hub.sh` does not build the agent, and the hub
resolves it next to its own executable. Without it the UI serves but the first local
terminal fails. On Windows use `scripts\build-agent.ps1` and `scripts\build-hub.ps1`.

Open the `https://127.0.0.1:<port>` address printed at startup. The default is an
OS-assigned free port; pass `--port <port>` when a stable port is required. The
hub uses the operator's configured certificate or generates one on first start.

The web UI is an installable PWA where the browser trusts the hub's certificate
without an exception, which takes a certificate you configure from a CA your browser
trusts, and a fixed port. With the generated certificate the browser runs it as an
ordinary tab. [SPEC.md § 3.4](docs/SPEC.md) lists which setups are installable.

There is no `npx lasterm`, and there will not be one under that name: the unscoped
`lasterm` on npm belongs to an unrelated project. The hub ships as a single
executable that embeds its own Node, so npm would add a runtime requirement it
exists to remove. Packaged builds land in the [releases](../../releases).

The desktop app does not update itself. An install from a release asset is updated by
installing the newer release; the Microsoft Store and winget update the installs they made.

---

## Architecture

```
UI (Vue 3 + xterm.js) ──── WSS + HTTPS ──── Hub (Fastify, 127.0.0.1:<assigned port>)
                                            ├── Local agent daemon (Unix socket / named pipe)
                                            ├── Remote agent (ssh2: stdio, or a daemon's socket)
                                            ├── meta.db  (hosts, sessions, channels, tokens)
                                            └── spool.db (output chunks, snapshots)

Agent (local or remote, same binary):
	stdio or socket → MessagePack frames → PTY manager (async-xpty, Rust) → N channels
	                ← MessagePack frames ← OUTPUT / SNAPSHOT

Hub never touches PTY directly — the agent is the universal PTY manager.
```

The local agent is a detached daemon listening on a Unix socket, or a named pipe on
Windows. The hub starts it for the first local terminal and connects to it again after a
restart, which is why local terminals outlive the hub. One daemon can serve several hubs
of the same OS user, each seeing only the terminals it started (#127).

The hub daemon binds to `127.0.0.1` on an OS-assigned port by default and serves
both the HTTPS REST API (`/api/*`) and WSS endpoint (`/ws`). An explicit port is
an override. The certificate is configured by the operator, or generated by the
hub itself — in which case the key and the leaf certificate over it are created
once and kept, and a new leaf is signed over the same key only when the stored one
can no longer serve, as when it nears expiry. The public key's fingerprint is
recorded with the endpoint identity in `runtime.json`, and that is what a client
pins.

### Agent distribution

The hub bundles the agent binary for **its own** OS/arch (used for local sessions, available offline at
install). Agents for **remote** SSH hosts of other OS/arch are **not** bundled — the hub downloads the
matching, version-matched, checksum-verified binary from GitHub Releases on demand and uploads it to the host
over SFTP, so the remote host never needs outbound internet. Pre-populate with `lasterm-hub agent fetch
<os-arch> | --all`.

> **Air-gapped note:** this assumes the **hub** has outbound internet. If the hub itself is air-gapped, a
> fetch fails with an actionable message (download URL + cache path + filename); download the binary and its
> `SHA256SUMS` on a connected machine, transfer them, and drop them in the binary cache. See
> [`docs/SPEC.md` §3.5](docs/SPEC.md) for the full distribution model.

### Remote hosts

By default a remote agent runs on SSH stdio: it ends with the connection, and its
terminals' shells with it; when the hub reconnects, it starts a new shell in each. A host that keeps an agent running (`[ssh] remote_daemon = true`, or the
host's own "Keep an agent running there", which wins) starts it detached instead, on a Unix
socket in its state directory, and the hub reaches that socket through the SSH connection
(`direct-streamlocal`). Its terminals then survive a dropped connection and a hub restart.
The daemon exits by itself after 30 minutes with no terminal and no hub connected.

On a Linux host with systemd and lingering on (`loginctl enable-linger <user>`), the daemon
runs in a systemd scope of its own, outside the login sessions. Without lingering it stays in
the SSH session that started it, which a host with `KillUserProcesses=yes` ends at logout.
Windows remotes always stay on stdio: no SSH channel carries a named pipe. See
[`docs/SPEC.md` §3.2](docs/SPEC.md).

The hub sends an SSH keepalive every 15 s, so a host that goes silent without closing the
connection is dropped within a minute. The hub then reconnects it, retrying for up to five
minutes, through its jump host when it has one, and a terminal restart asked for meanwhile
waits for the host rather than fail.

A remote host's menu (right-click its badge in the rail) connects it without opening a
terminal, reconnects it, or disconnects it. A host that keeps an agent running keeps its
terminals through both: they run on, and the next connection takes them up. On stdio they end
with the connection, so Reconnect and Disconnect first say how many and ask. After a Disconnect
the hub leaves the host alone, even when a window reopens its terminals, until you connect it,
reconnect it, or open or restart a terminal there. A hub restart forgets that, and reaches the
host as usual. See [`docs/SPEC.md` §5.5b](docs/SPEC.md).

---

## Packages

| Package | npm name | Description |
|---------|----------|-------------|
| `packages/shared` | `@lasterm/shared` | Protocol types, MessagePack codec, entity types, config types |
| `crates/lasterm-agent` | a Rust binary | PTY manager — async-xpty + the vt100 crate + MessagePack framing |
| `packages/hub` | `@lasterm/hub` | Fastify daemon — session manager, client manager, storage, SSH transport |
| `packages/clients/web` | `@lasterm/web` | Vue 3 PWA — embedded in hub at build time, not published separately |
| `packages/clients/desktop` | `@lasterm/desktop` | Tauri desktop app that launches its own hub as a sidecar |
| `crates/lasterm-hub-lock` | a napi-rs addon | The hub's single-instance lock, loaded by the hub |
| `crates/lasterm-tls-identity` | a napi-rs addon | Generates and keeps the hub's TLS key and certificate |
| `crates/lasterm-process-lock`, `crates/lasterm-protected-fs` | Rust libraries | The kernel lock under the hub lock; descriptor-relative access to protected files |
| root | workspace root | CLI entrypoint — thin wrapper around `@lasterm/hub`. Not published |

---

## Development

### Prerequisites

- Node.js >= 24 LTS
- pnpm 12.4.1, the version `packageManager` in `package.json` pins (corepack provides it)
- Rust 1.98.0, as `rust-toolchain.toml` pins, for the agent and the hub's native addons

### Setup

```sh
# Install all dependencies
pnpm install

# Start hub + UI dev servers concurrently
pnpm dev
```

The hub starts on HTTPS at an OS-assigned port and the Vite dev server on
`http://localhost:5173`. Vite resolves the published `runtime.json` for each
proxied request, so it can follow the port chosen after Vite itself starts.

### Commands

```sh
pnpm build            # Build all packages
pnpm build:test-tls-material   # Native addons the hub specs load; before `pnpm test`, and after editing a crate
pnpm test             # Run all tests (vitest)
pnpm typecheck        # Type-check every package
pnpm lint             # Lint + format check (biome)
pnpm lint:fix         # Auto-fix lint issues
cargo test --workspace   # The agent and the other Rust crates
scripts/dev/check.sh     # Everything CI checks on a pull request, one log per step (bash)

# Single-package operations
pnpm -F @lasterm/hub test   # builds the native addons itself
pnpm -F @lasterm/web dev
```

### Headless local-spawn testing

Use the headless harness to exercise the hub WebSocket `AUTH` + `SPAWN` path without opening
the browser or touching your real Lasterm state:

```sh
scripts/dev/headless-hub-test.sh start   # isolated hub on :4199 with debug logging enabled
scripts/dev/headless-hub-test.sh spawn   # run AUTH + SPAWN probe
scripts/dev/headless-hub-test.sh logs    # hub connection-lifecycle log tail
scripts/dev/headless-hub-test.sh alog    # local agent daemon log tail
scripts/dev/headless-hub-test.sh stop
scripts/dev/headless-hub-test.sh reset
```

The harness writes all config, runtime, and state under `.tt/headless-hub/`. Override the
location or port with `TT_DIR=/tmp/lasterm-headless` or `TT_PORT=4201`. The hub's dev
agent resolver uses `target/release/lasterm-agent`, so rebuild that binary after Rust changes
before relying on the agent daemon log tail.

### Production build (single executable)

Build a self-contained release locally (Linux native; on Windows, `scripts/build-hub.ps1`). macOS is
not a supported target: nothing builds or tests it (#224).

```sh
./scripts/build-agent.sh   # Rust agent → dist/sea/lasterm-agent  (cargo --release)
./scripts/build-hub.sh     # Hub SEA    → dist/sea/lasterm-hub
                           #   builds the web UI, embeds it, bundles better-sqlite3,
                           #   and produces a Node Single Executable Application
```

Both binaries land co-located in `dist/sea/`; the hub resolves the agent next to its own executable. Run it:

```sh
cd dist/sea
./lasterm-hub start --port 4100   # serves the PWA at https://127.0.0.1:4100  (add --daemon / --open)
./lasterm-hub pair                # prints an 8-digit code to authorise a new browser client
./lasterm-hub status
./lasterm-hub stop                # the hub alone: the local agent keeps its terminals for the next one
./lasterm-hub quit                # the local agent first, ending its terminals, then the hub
```

Only the hub's owner can end it: `stop` and `quit` read the owner token from `runtime.json`,
which only the hub's OS user on its machine can read, and a paired browser cannot end the hub
(#142). Config lives in `~/.config/lasterm`, runtime state in `~/.local/state/lasterm`.

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

lasterm reads configuration from a TOML file:

- **Linux:** `~/.config/lasterm/config.toml`
- **Windows:** `%APPDATA%\lasterm\config.toml`

State (databases, `runtime.json`, logs, the TLS key) is stored in:

- **Linux:** `~/.local/state/lasterm/`
- **Windows:** `%LOCALAPPDATA%\lasterm\`

The local agent daemon listens on `$XDG_RUNTIME_DIR/lasterm/agent.sock` on Linux
(`/tmp/lasterm-<uid>/agent.sock` without that variable), and on the named pipe
`\\.\pipe\lasterm-agent-<user>` on Windows.

The hub chooses an OS-assigned free port by default. Set an explicit port via:

1. CLI flag `--port`
2. Environment variable `LASTERM_PORT`

The flag wins. `lasterm start` and the daemon entry point both read the two (#175); a `port`
key in `config.toml` is **not** read.

Every key is listed in [docs/CONFIG_REFERENCE.md](docs/CONFIG_REFERENCE.md). Terminal
background settings live in `[terminal]` and cascade to host/channel profiles:

```toml
[terminal]
wallpaper = "forest.webp"
wallpaper_blur = 4
wallpaper_dim = 25

# image = wallpaper when set, otherwise solid; solid = opaque theme background;
# transparent = desktop transparency in Tauri, solid fallback in browsers.
background_mode = "transparent"

# Desktop-only native background. On Windows 11 the picker offers none (see
# through, the page's own opacity reaches the desktop), mica and acrylic (DWM
# paints the material behind the page). A window is built see-through or built
# for a material and cannot change under a running app, so moving between the
# two takes effect at the next launch, which the app offers to do.
window_effect = "none"
```

A terminal's environment, what a pane does when its terminal ends, and remote hosts:

```toml
[terminal]
env_mode = "inherit"                     # or "minimal"; applied by the agent on the terminal's host
env = { EDITOR = "hx", PAGER = false }   # false removes the variable
when_ended = "ask"                       # or "restart", "close"; a host or a terminal can override it

[panes]
keep_ended = false                       # true: closing an ended terminal keeps it in the sidebar

[ssh]
remote_daemon = true                     # remote terminals outlive the connection; a host can override it
trust_known_hosts = false                # true: accept a first key ~/.ssh/known_hosts already trusts
```

The chosen endpoint and its SPKI are written to `runtime.json` in the state directory.

---

## License

lasterm is licensed per component:

| Component | License |
|-----------|---------|
| `lasterm` (CLI), `@lasterm/hub`, `@lasterm/web`, `@lasterm/desktop`, every crate under `crates/` | [AGPL-3.0-only](./LICENSE) |
| [`@lasterm/shared`](./packages/shared) | [MIT](./packages/shared/LICENSE-MIT) OR [Apache-2.0](./packages/shared/LICENSE-APACHE) |

The async PTY library was extracted to its own repository,
[khiops/async-xpty](https://github.com/khiops/async-xpty) (MIT OR Apache-2.0).

The application is AGPL so lasterm stays fully free software and self-hostable — including
when run as a network service. The standalone libraries are permissively dual-licensed for
ecosystem adoption.

**This licensing is permanent.** The launch license is a commitment, not a starting point:
the application components will remain AGPL-3.0-only and the libraries will remain
MIT OR Apache-2.0.

Contributions are accepted under the [Developer Certificate of Origin](https://developercertificate.org/)
(inbound = outbound). There is no CLA.
