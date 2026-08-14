# lasterm — Architecture Specification

> Version: 0.1.0 (MVP)
> Status: draft
> Last updated: 2026-03-02

## 1. Vision

lasterm is a **local-first session terminal platform** that lets developers and SREs manage persistent terminal sessions across local and remote machines from a modern web UI. Sessions survive client disconnects and device switches; local sessions also survive hub restarts. (Surviving a dropped SSH transport to a remote host is on the roadmap, not yet shipped.)

**Core differentiators:**
- Hub owns state (cache + snapshot) independently of UI clients
- SSH stdio transport — zero ports opened on remote machines
- Discord-style UI with per-host visual identity
- Remote visual hints — agents can impose badges/themes on their terminals
- Config cascade — 4-layer deep merge (defaults → user TOML → host profile → channel profile)

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         UI (PWA / Tauri)                        │
│   Vue 3 + xterm.js — served over HTTPS on the published port    │
│   Discord-style: host rail │ channel sidebar │ terminal panes   │
└──────────┬──────────────────────────────┬───────────────────────┘
           │ REST (/api/*)                │ WS (/ws)
           │ CRUD: hosts, sessions,       │ Realtime: INPUT, OUTPUT,
           │ workspaces, config, pair     │ ATTACH, DETACH, RESIZE,
           │                              │ SNAPSHOT, WRITE_*, HEARTBEAT
┌──────────▼──────────────────────────────▼───────────────────────┐
│                        Hub (Node.js daemon)                     │
│   Binds 127.0.0.1:<assigned port> — HTTPS + WSS server          │
│                                                                  │
│   ┌──────────┐ ┌──────────────┐ ┌────────────┐ ┌────────────┐  │
│   │ Client   │ │ Session      │ │ Cache      │ │ Config     │  │
│   │ Manager  │ │ Manager      │ │ Manager    │ │ Resolver   │  │
│   │          │ │              │ │            │ │            │  │
│   │ WS conns │ │ Local Agent  │ │ Snapshots  │ │ 4-layer    │  │
│   │ Auth     │ │ SSH → Agent  │ │ Tail spool │ │ cascade    │  │
│   │ WriteLock│ │ Reconnect    │ │ GC policy  │ │ deep merge │  │
│   └──────────┘ └──────────────┘ └────────────┘ └────────────┘  │
│                                                                  │
│   ┌───────────────────────────────────────────────────────────┐  │
│   │ Storage: meta.db (hosts, sessions, channels, workspaces) │  │
│   │          spool.db (output chunks, snapshots)              │  │
│   └───────────────────────────────────────────────────────────┘  │
└──────────┬──────────────────────────────────────────────────────┘
           │ Local: child_process.spawn("lasterm-agent --stdio")
           │   ─or─ UDS to standalone daemon ("lasterm-agent --daemon")
           │ Remote: SSH (ssh2) → "lasterm-agent --stdio"
           │ Transport: MessagePack framed over stdio or UDS (all modes)
           │
┌──────────▼──────────────────────────────────────────────────────┐
│                    Agent (Rust, local or remote)                 │
│   Universal PTY manager — same binary, same protocol            │
│                                                                  │
│   ┌──────────────┐ ┌────────────────┐ ┌──────────────────────┐  │
│   │ PTY Manager  │ │ Screen Model   │ │ Protocol Handler     │  │
│   │              │ │                │ │                      │  │
│   │ async-xpty   │ │ vt100 crate    │ │ MessagePack framed   │  │
│   │ spawn/resize │ │ headless       │ │ stdin/stdout         │  │
│   │ N channels   │ │ serialize()    │ │ multiplexed channels │  │
│   └──────────────┘ └────────────────┘ └──────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## 3. Component Details

### 3.1 Shared Package (`@lasterm/shared`)

TypeScript library used by hub, agent, and UI.

**Responsibilities:**
- Protocol message type definitions (TypeScript discriminated unions)
- MessagePack codec: encode/decode with Uint8Array support
- Frame encoder/decoder: 4-byte LE length prefix + MessagePack payload
- Config types (theme, keybindings, profile)
- Entity types (Host, Session, Channel, Workspace, ChannelGroup)
- Constants (protocol version, default port, default config values)

### 3.2 Agent (`crates/lasterm-agent`)

Universal PTY manager. Runs locally (child process) or remotely (via SSH). Same binary, same protocol.

**Responsibilities:**
- Protocol handshake (HELLO with version, capabilities, visual_hints)
- PTY lifecycle: spawn, resize, destroy (via `async-xpty`)
- Screen model: a `vt100` parser per channel in `headless.rs` — maintains accurate screen state
- Snapshot: serialize() on demand or periodic (3s idle, 5s forced)
- Channel multiplexing: N channels per agent process
- Backpressure: pause PTY read when output buffer exceeds threshold
- Daemon mode: standalone process listening on UDS, output buffering via `OutputBuffer` ring buffer
- `DaemonServer` (`daemon.rs`): UDS listener, HELLO handshake, connection displacement (last-writer-wins)
- `OutputBuffer` (`batch.rs`): per-channel ring buffer with per-channel cap and global cap, evicts from largest channel
- CLI: `lasterm-agent --daemon --socket <path> --buffer-per-channel <bytes> --buffer-global <bytes>`

**Process model (local — stdio, legacy):**
```
hub: child_process.spawn("lasterm-agent", ["--stdio"])
  → Agent starts, writes HELLO to stdout
  → Hub reads HELLO, sends SPAWN commands
  → Each SPAWN creates a PTY + a vt100 screen model
  → OUTPUT flows: PTY → vt100 model (for state) → framed stdout → Hub
  → INPUT flows: Hub → framed stdin → Agent → PTY
```

**Process model (local — daemon, preferred):**
```
hub: connectOrLaunch(socketPath, config, binaryPath)
  → Probes UDS socket via probeSocket()
  → If no daemon running: spawn detached "lasterm-agent --daemon --socket <path>"
  → Polls socket until ready (up to 5s)
  → Connects to UDS → Agent sends HELLO (with protocolVersion)
  → On reconnect: Agent sends N x AGENT_CHANNEL_STATE + CHANNEL_STATE_END
  → Hub reconciles channel state (adopt alive, mark dead)
  → Normal operation (same framed MessagePack protocol as stdio)
```

The `DaemonServer` class manages UDS connections with last-writer-wins displacement: a new hub connection immediately replaces the previous one. Output is buffered by `OutputBuffer`, a per-channel ring buffer with configurable per-channel cap (`bufferPerChannel`, default 1 MB) and global cap (`bufferGlobal`, default 20 MB). When the global cap is reached, the largest channel's oldest data is evicted.

**Process model (remote):**
```
hub: ssh2.exec("lasterm-agent --stdio")
  → Agent starts, writes HELLO to stdout
  → Hub reads HELLO, sends SPAWN commands
  → Each SPAWN creates a PTY + a vt100 screen model
  → OUTPUT flows: PTY → vt100 model (for state) → framed stdout → SSH → Hub
  → INPUT flows: Hub → SSH → framed stdin → Agent → PTY
```

The protocol is identical in all modes. Only the transport differs (stdio pipe, UDS, or SSH channel).

**Screen model:** the `vt100` crate parses the PTY stream into a screen the agent can
serialize on demand, so a reconnecting client is handed a terminal already in the right
state. This is what replaced the planned headless-xterm-plus-DOM-polyfill approach: the
spike that section described was overtaken by rewriting the agent in Rust, where no DOM
shim is needed at all.

**Agent installation:**
- The hub fetches the agent from GitHub Releases, version-matched to itself, and deploys
  it over SFTP; see §3.5. No npm package is involved, and nothing needs Node on the
  remote host — the agent is a static Rust binary.
- The hub runs `lasterm-agent --stdio` over SSH once the binary is in place.
- If no build exists for the remote's OS and architecture, the fetch fails with a named
  target rather than deploying something that cannot run.

### 3.3 Hub (`@lasterm/hub`)

Local daemon, single process, binds to 127.0.0.1.

**Responsibilities:**

**HTTPS Server (single port, OS-assigned by default, configurable):**
- REST API: CRUD for hosts, sessions, channels, workspaces, config
- WebSocket upgrade on `/ws` path
- Static file serving for UI (production build)
- Health endpoint (`GET /api/health`)
- Port resolution: CLI flag or `LASTERM_PORT` supplies an explicit override; otherwise the OS assigns a free port and the hub writes it to `runtime.json`.
- The certificate is the operator's configured pair, or one this hub generates for itself. In the generated case both the **key** and the leaf over it are created once and kept, in `hub-tls-key.pem` and `hub-tls-generated-cert.pem`; a restart serves the same bytes. A new leaf is signed only when the stored one cannot serve — absent, unreadable, for another key, expired or within seven days of it, dated in the future after a clock moved back, or failing the profile a generated leaf must have. Clients pin the recorded SPKI, which is the key's, so a reissue costs them nothing; a browser that accepted the certificate is asked again only when one happens.

**Session Manager:**
- Local sessions (daemon): connect to standalone agent via UDS (`connectOrLaunch`), auto-spawn if needed
- Local sessions (fallback): spawn agent as child process (`child_process.spawn`, --stdio)
- Remote sessions: open SSH via ssh2, launch agent, pipe stdio
- Hub never spawns PTYs directly — agent is the universal PTY manager
- `LastermAgent` (`lasterm-agent.ts`): hub-side class extending `AgentConnection`, `connectLocal(socketPath)` factory, `waitForChannelState()` for reconnect reconciliation
- `connectOrLaunch` (`agent-launcher.ts`): probes socket, spawns detached daemon if needed, polls for readiness
- Session state machine: STARTING → ACTIVE ↔ DISCONNECTED → CLOSED, with DETACHED branch
- Reconnect (remote): exponential backoff (1s, 2s, 4s, ... 30s max, 5min total timeout)
- Reconnect (local): respawn agent immediately on unexpected exit
- Channel multiplexing: multiple PTYs per agent connection

**Client Manager:**
- Track connected WS clients
- Auth: verify token on WS connect and REST requests
- Fanout: OUTPUT from one channel → all attached clients
- Write-lock: track who holds write per channel, handle claim/release/force

**Cache Manager:**
- Write-through: every OUTPUT chunk → spool.db
- Periodic snapshots: store serialized screen state
- Cache index: track last snapshot + last seq per channel
- GC: enforce retention policy (max age, max size per channel)
- Offline view: serve cached snapshot + tail when agent unreachable

**Config Resolver:**
- Layer 1: built-in defaults (code)
- Layer 2: `$LASTERM_CONFIG_DIR/config.toml` (user file — see § 7 for platform paths)
- Layer 3: host.profile_json (meta.db)
- Layer 3.5: agent visual_hints (from HELLO, if trust policy allows)
- Layer 4: channel.profile_json (meta.db)
- Resolution: deep merge in order, last wins

**CLI:**
- `lasterm start` — start daemon (foreground or background)
- `lasterm stop` — stop daemon
- `lasterm status` — show daemon status, active sessions
- `lasterm host add|list|test|remove` — manage hosts
- `lasterm session list|attach` — manage sessions
- `lasterm workspace export|import` — workspace portability
- `lasterm config edit` — open config.toml in $EDITOR
- `lasterm pair` — generate pairing code for multi-device
- `lasterm decode` — decode MessagePack frames from stdin (debug tool)

### 3.4 Web Client (`@lasterm/web`)

Vue 3 SPA built with Vite. Served by hub in production, dev server in development.

**Layout — Discord-style 3-column:**

| Column | Width | Content |
|--------|-------|---------|
| Host rail | 48px | Host icons (auto-initial + color), status dots, settings, [+] add |
| Channel sidebar | ~200px | Channels grouped by user-defined categories, collapsible |
| Main area | Remaining | Tab bar + split terminal panes |

**Components:**
- `HostRail` — vertical icon list, click to select, right-click for settings
- `ChannelSidebar` — channels for selected host, grouped, drag-reorder
- `TabBar` — open channels as tabs, [+] new, right-click context menu
- `TerminalPane` — xterm.js instance, fit addon, badge overlay
- `PaneSplitter` — horizontal/vertical split, drag resize
- `CommandPalette` — Ctrl+P, fuzzy search hosts/channels/actions
- `AddHostDialog` — form: label, host, port, auth, icon, color
- `HostSettings` — connection, appearance, theme override, remote hints policy
- `SettingsOverlay` — global settings (theme, keybindings, hub config)
- `StatusBar` — session count, host count, hub health, current channel info

**Connection flow:**
1. UI loads → `fetch /api/health` to verify hub
2. WS connect to `/ws` with auth token
3. `fetch /api/hosts` → populate host rail
4. User selects host → `fetch /api/channels?hostId=X` → populate sidebar
5. User clicks channel → WS: ATTACH → receive SNAPSHOT → restore xterm → stream OUTPUT

**State management:**
- Pinia store for: hosts, sessions, channels, config, write-locks
- Reactive: WS messages update store → Vue reactivity updates UI
- Persistent: workspace layout saved to hub via REST on change

### 3.5 Agent Binary Distribution

The agent binary reaches the machine it runs on through two distinct, deliberate paths.

**Local agent (same OS/arch as the hub) — bundled.**
The hub ships with the agent binary for its own platform, co-located with the hub (the SEA resolves it
next to itself via `sea-agent-resolver`; the desktop bundles it as a Tauri sidecar). Local sessions use
this agent. It is therefore available **offline and immediately** at install, and its version always
matches the hub by construction. A terminal app must open a local shell without a network round-trip, so
this is never fetched.

**Remote agents (other OS/arch, for SSH hosts) — fetched on demand.**
The hub does **not** bundle agents for platforms other than its own. When deploying to a remote host whose
`os/arch` is not yet cached, the hub downloads the matching release asset
(`lasterm-agent-<triple>-<version>`) from GitHub Releases — version-matched to the hub, verified against
`SHA256SUMS-<version>.txt`, placed in a hardened (0700, owned, non-symlink) cache — then uploads it to the
remote host over SFTP. Pre-population is available via `lasterm-hub agent fetch <os-arch>|--all`.

Two properties follow:
- **The remote host never needs outbound internet** — the *hub* fetches on its behalf, and the binary
  travels hub → remote over the existing SSH/SFTP channel. Deploying to a remote host is inherently online
  (it is an SSH connection), so the fetch always has connectivity.
- **Bundling every target triple in every installer is unnecessary** (and would bloat installers and defeat
  the fetch-on-demand design), so it is not done.

**Air-gapped hub caveat.**
The one case the fetch path cannot serve is a **hub that itself has no outbound internet**. There, a fetch
fails with an actionable error naming the manual gesture (download URL, cache path, and the exact filename
to rename to). The operator downloads the binary (and its `SHA256SUMS`) on a connected machine, transfers
it, and places it in the binary cache; the deployer then treats it like any cached binary. A GUI
agent-manager (list cached/missing agents per `os/arch`, fetch button, and an **import-with-integrity-check**
flow for air-gapped transfers) is a planned follow-up to the existing CLI — an imported binary must still
be integrity-verified (confirmed SHA256 or an imported `SHA256SUMS`) so it does not bypass the trust the
fetch path enforces.

**Trust model by provenance.** Bundled = build provenance (compiled and shipped together). Fetched = HTTPS
+ `SHA256SUMS` + hardened cache + atomic placement. Manually placed = operator-verified. In all three, a
binary found **already present on the remote host** still goes through the deployer's TOFU/verification gate
(`AGENT_BINARY_REJECTED`/`UNTRUSTED`); only uploads from the hub's own verified cache bypass that prompt, by
design. (Agent fetch + version-aware deploy: see #77.)

## 4. Entity Model

```
Host (permanent config)
 ├── id: string (ULID)
 ├── type: 'local' | 'ssh'
 ├── label: string (unique)
 ├── sshHost?: string
 ├── sshPort?: number
 ├── sshAuth?: 'agent' | 'key' | 'password'
 ├── sshKeyPath?: string
 ├── sshConfigHost?: string | null     // ssh_config Host alias
 ├── sshUser?: string | null           // ssh_config User override
 ├── sshFingerprint?: string | null    // SHA256:<base64> of trusted host key
 ├── iconType: 'auto' | 'emoji' | 'image'
 ├── iconValue?: string
 ├── color?: string                    // hex #rrggbb, auto from label hash if null
 ├── profileJson?: string              // JSON-encoded TerminalProfile (layer 3 overrides)
 ├── trustRemoteHints: 'apply' | 'ask' | 'ignore'
 ├── defaultShell?: string
 ├── defaultCwd?: string
 ├── elevationMethod?: 'sudo'|'doas'|'pkexec'|'gsudo'|'custom' | null
 ├── customCommand?: string | null     // used when elevationMethod = 'custom'
 ├── hostGroup?: string | null         // display group name
 ├── hostGroupId?: string | null       // FK → HostGroup (future)
 ├── sortOrder: number
 ├── keepAliveSeconds: number          // SSH keep-alive interval (0 = disabled)
 ├── historyRetentionDays: number      // spool.db GC policy per host
 ├── discoveredShells?: string[]       // shells found on remote at last connect
 ├── discoveredShellsAt?: string       // ISO 8601 — when shells were last probed
 ├── os: 'linux' | 'darwin' | 'windows' | null    // null = auto-detect on first connect
 ├── arch: 'x64' | 'arm64' | null                 // null = auto-detect on first connect
 ├── createdAt: string                 // ISO 8601
 └── updatedAt: string

ChannelGroup (organizational, per host)
 ├── id: string (ULID)
 ├── hostId: FK → Host
 ├── name: string
 ├── sortOrder: number
 ├── collapsed: boolean
 └── createdAt: string                 // ISO 8601

Session (runtime, tied to connection)
 ├── id: string (ULID)
 ├── hostId: FK → Host
 ├── status: 'starting' | 'active' | 'detached' | 'disconnected' | 'closed'
 ├── createdAt: string                 // ISO 8601
 └── updatedAt: string

Channel (PTY instance)
 ├── id: string (ULID)
 ├── sessionId: FK → Session
 ├── groupId?: FK → ChannelGroup
 ├── title?: string                    // user-editable label
 ├── shell: string
 ├── args?: string[]
 ├── cwd?: string
 ├── envJson?: string                  // JSON-encoded Record<string, string>
 ├── cols: number
 ├── rows: number
 ├── status: 'born' | 'live' | 'orphan' | 'dead'
 ├── exitCode?: number
 ├── profileJson?: string              // JSON-encoded TerminalProfile (layer 4 overrides)
 ├── isWelcome?: boolean               // hub-created welcome channel flag
 ├── icon?: string                     // emoji or icon name
 ├── directProcess?: boolean           // true = process mode (no shell wrapper)
 ├── dynamicTitle?: string             // title set by escape sequence (OSC 0/2)
 ├── processTitle?: string             // process name reported by agent
 ├── displayTitle?: string             // computed: dynamicTitle ?? processTitle ?? title
 ├── launchProfileId?: string          // FK → LaunchProfile used to create channel
 ├── elevated?: boolean                // was launched with elevation
 ├── elevationMethod?: string          // elevation method used at spawn time
 ├── createdAt: string                 // ISO 8601
 └── updatedAt: string

LaunchProfile (reusable spawn template)
 ├── id: string (ULID)
 ├── name: string
 ├── shell: string
 ├── args?: string[]
 ├── cwd?: string
 ├── env?: Record<string, string>
 ├── mode: 'shell' | 'process'
 ├── elevated: boolean
 ├── supportedOs: 'linux' | 'darwin' | 'windows' | 'any'
 ├── iconType: 'auto' | 'emoji' | 'image'
 ├── iconValue?: string
 ├── color?: string
 ├── profileOverrides?: Partial<TerminalProfile>
 ├── sortOrder: number
 ├── createdAt: string                 // ISO 8601
 └── updatedAt: string

Workspace (layout persistence)
 ├── id: string (ULID)
 ├── name: string (unique)
 ├── layoutJson: string                // JSON-encoded TabLayout
 ├── createdAt: string                 // ISO 8601
 └── updatedAt: string

CacheIndex (per channel, hub-side)
 ├── channelId: FK → Channel
 ├── lastSnapshotChunkId: FK → Chunk?
 ├── lastSeq: number
 └── lastSeenAt: ISO timestamp

TerminalProfile (config override — used in layers 3 & 4)
 ├── fontFamily?: string
 ├── fontSize?: number
 ├── theme?: Record<string, string>   // color overrides
 ├── cursorStyle?: 'block' | 'underline' | 'bar'
 ├── scrollback?: number
 └── [key: string]: unknown            // extensible for future settings

TabLayout (workspace persistence)
 ├── type: 'tabs'
 └── tabs: TabEntry[]
     ├── channelId: string
     ├── label?: string
     └── panes?: PaneLayout
         ├── direction: 'horizontal' | 'vertical'
         ├── ratio: number              // 0–1 split ratio
         ├── first: PaneLayout | { channelId: string }
         └── second: PaneLayout | { channelId: string }
```

### 4.1 Naming Convention

All protocol messages use **snake_case** for field names (e.g., `channel_id`, `cursor_x`). TypeScript interfaces in `@lasterm/shared` use **camelCase** (e.g., `channelId`, `cursorX`). The MessagePack codec layer handles conversion at encode/decode boundaries.

### 4.2 State Transition Rules

**Session transitions:**

| From | To | Trigger |
|------|----|---------|
| starting | active | SSH connected + HELLO received (or local PTY spawned) |
| active | disconnected | SSH connection lost (ssh2 'close' event) |
| active | detached | All clients DETACH from all channels in session AND no channels LIVE |
| disconnected | active | SSH reconnect succeeds + HELLO received |
| disconnected | closed | Reconnect timeout (5 min) |
| detached | active | Any client sends ATTACH for a channel in this session |
| detached | closed | Session detach timeout (configurable, default 1h) |

**Channel transitions:**

| From | To | Trigger |
|------|----|---------|
| born | live | First client sends ATTACH for this channel |
| live | orphan | Last attached client DETACHes (PTY still running) |
| orphan | live | Client sends ATTACH |
| live | dead | Agent reports CHANNEL_EXIT (PTY process exited) |
| orphan | dead | Agent reports CHANNEL_EXIT or session CLOSED |

### 4.3 Local Host Initialization

On **first hub start** (meta.db is empty — schema_version table has version 1 but hosts table has 0 rows):

1. Hub creates a local host record: `{ type: 'local', label: 'local', icon_type: 'auto', color: null }`
2. This host appears in the host rail as the first entry (always present, cannot be deleted)
3. On first UI load with no active channels: auto-spawn a local shell channel and open it

### 4.4 Remote Visual Hints Lifecycle

Agent visual hints from HELLO are **ephemeral** (session-scoped, not persisted):

1. Agent sends HELLO with `visual_hints: { badge, theme_overlay }`
2. Hub stores hints **in memory** (on the Session object, not in DB)
3. Config resolver applies hints as Layer 3.5 for all channels of this session
4. On session CLOSED: hints are discarded
5. On SSH reconnect: agent sends new HELLO with fresh hints
6. Rationale: hints may change between agent restarts (e.g., load badge)

User-configured host overrides (Layer 3) are persistent in meta.db and are not affected by agent hints.

### 4.5 SSH Auth Method

Each host record specifies exactly one auth method via `ssh_auth` field (`'agent'`, `'key'`, `'password'`). There is **no fallback chain**. If the chosen method fails, the connection fails and the user must reconfigure.

- `agent`: use SSH_AUTH_SOCK (ssh-agent). Fail if agent unavailable.
- `key`: read private key from `ssh_key_path`. If passphrase-protected, prompt user via UI dialog.
- `password`: prompt user via UI dialog at connect time. **Never stored.**

### 4.6 Known Hosts Verification

On first SSH connect to an unknown host (fingerprint not in `~/.ssh/known_hosts`):

1. Hub receives fingerprint from ssh2 `hostVerifier` callback
2. Hub sends a UI notification: `{ type: "HOST_VERIFY", hostId, fingerprint, algorithm }`
3. UI shows modal: "Trust host fingerprint? [sha256:XXXX] — [Trust once] [Trust permanently] [Cancel]"
4. "Trust permanently": hub appends to `~/.ssh/known_hosts` + stores in meta.db hosts table
5. "Trust once": hub accepts for this session only
6. "Cancel": connection aborted, session CLOSED

## 5. Data Flow Diagrams

### 5.1 Local PTY — Input/Output

```
User types "ls\n"
  │
  UI: xterm.js onData("ls\n")
  │
  UI → Hub (WS): INPUT { channelId: "ch-1", data: [0x6c, 0x73, 0x0a] }
  │
  Hub: find channel ch-1, verify write-lock
  │
  Hub → Agent (local stdio): [4-byte len][msgpack INPUT { channelId, data }]
  │
  Agent: find PTY for ch-1 → pty.write(data)
  │
  PTY → Agent: pty.onData(output)
  │
  Agent: feed output to the vt100 screen model (for screen state)
  Agent → Hub (local stdio): [4-byte len][msgpack OUTPUT { channelId, seqNo, ts, data }]
  │
  Hub: write to spool.db (chunk)
  │
  Hub → ALL attached clients (WS): OUTPUT { channelId: "ch-1", seqNo: 42, ts, data }
  │
  UI: xterm.js terminal.write(data) → renders on screen
```

Note: local and remote data flows are now identical — only the transport differs
(child_process stdio vs SSH stdio). Hub never touches PTYs directly.

### 5.2 Remote PTY — Input/Output

```
User types "ls\n"
  │
  UI → Hub (WS): INPUT { channelId: "ch-1", data }
  │
  Hub: find channel → session → SSH connection
  │
  Hub → Agent (SSH stdio): [4-byte len][msgpack INPUT { channelId, data }]
  │
  Agent: find PTY for ch-1 → pty.write(data)
  │
  PTY → Agent: pty.onData(output)
  │
  Agent: feed output to the vt100 screen model (for screen state)
  Agent → Hub (SSH stdio): [4-byte len][msgpack OUTPUT { channelId, seqNo, ts, data }]
  │
  Hub: write to spool.db (chunk), update cache_index
  │
  Hub → ALL attached clients (WS): OUTPUT { channelId, seqNo, ts, data }
  │
  UI: xterm.js terminal.write(data)
```

### 5.3 Attach + Snapshot Restore

```
Client connects, user clicks channel #bash (ORPHAN)
  │
  UI → Hub (WS): ATTACH { channelId: "ch-1" }
  │
  Hub: channel status ORPHAN → check if agent reachable
  │
  ┌─ Agent reachable:
  │  Hub → Agent: SNAPSHOT_REQ { channelId: "ch-1" }
  │  Agent → Hub: SNAPSHOT_RES { channelId, serialized, cols, rows, cursorX, cursorY }
  │  Hub: update cache (spool.db snapshot chunk + cache_index)
  │  Hub → UI: ATTACH_OK { channelId, snapshot, writeLockHolder, tailSinceSnapshot: [...] }
  │
  └─ Agent unreachable (cached mode):
     Hub: read last snapshot from spool.db
     Hub: read tail chunks since snapshot
     Hub → UI: ATTACH_OK { channelId, snapshot, writeLockHolder: null,
               tailSinceSnapshot: [...], cached: true }

UI: xterm.js restore snapshot → write tail chunks → channel LIVE (or cached READ-ONLY)
```

### 5.4 Agent Connection Lifecycle

**Local host:**
```
User clicks [+ channel] on local host
  │
  Hub: session exists for local host?
  │
  ├─ No → create Session (STARTING)
  │  Hub: connectOrLaunch(socketPath) → connect to daemon (or spawn it)
  │  Fallback: child_process.spawn("lasterm-agent", ["--stdio"])
  │  Read HELLO from agent
  │  Session → ACTIVE
  │  Proceed to SPAWN
  │
  └─ Yes (ACTIVE) → reuse agent connection (daemon UDS or stdio)
     Hub → Agent: SPAWN { shell, cwd, env, cols, rows }
     Agent: spawn PTY, create the vt100 screen model
     Agent → Hub: SPAWN_OK { channelId: "ch-new" }
     Hub: create Channel record (meta.db), status: BORN → LIVE
     Hub → UI: channel available, auto-ATTACH
```

**Remote host:**
```
User clicks [+ channel] on remote host
  │
  Hub: session exists for host?
  │
  ├─ No → create Session (STARTING)
  │  Hub: ssh2.connect(host.sshConfig)
  │  ├─ Success:
  │  │  ssh2.exec("lasterm-agent --stdio")
  │  │  Read HELLO from agent stdout
  │  │  Session → ACTIVE
  │  │  Proceed to SPAWN
  │  └─ Failure:
  │     Session → FAILED → CLOSED
  │     UI: error notification
  │
  └─ Yes (ACTIVE) → reuse SSH connection
     Hub → Agent: SPAWN { shell, cwd, env, cols, rows }
     Agent: spawn PTY, create the vt100 screen model
     Agent → Hub: SPAWN_OK { channelId: "ch-new" }
     Hub: create Channel record (meta.db), status: BORN → LIVE
     Hub → UI: channel available, auto-ATTACH
```

### 5.5 Disconnect + Reconnect

```
SSH connection drops (network issue)
  │
  Hub: ssh2 'close' event
  Session → DISCONNECTED
  Hub → ALL clients: SESSION_STATE { sessionId, status: 'disconnected' }
  UI: overlay "Reconnecting..." on affected panes
  │
  Hub: reconnect loop (backoff: 1s, 2s, 4s, ... 30s cap)
  │
  ├─ SSH recovers:
  │  Agent HELLO → Hub checks channels
  │  ├─ Agent still running: ATTACH each channel → SNAPSHOT → delta to UI → LIVE
  │  └─ Agent restarted (reboot): channels DEAD, session CLOSED
  │
  └─ Timeout (5min): session CLOSED, channels DEAD
     UI: host icon 🔴, cached content still viewable
```

### 5.6 Daemon Agent — Connect + Reconnect

```
Hub starts (or reconnects after restart)
  │
  Hub: connectOrLaunch(socketPath, config, binaryPath)
  │
  ├─ probeSocket(socketPath) succeeds (daemon already running):
  │  Hub: connect to UDS
  │  Agent → Hub: HELLO { protocolVersion, capabilities }
  │  Agent → Hub: AGENT_CHANNEL_STATE { channelId, title, pid, alive } (×N)
  │  Agent → Hub: CHANNEL_STATE_END
  │  Hub: reconcileChannelState()
  │  ├─ alive channels → adopt into session, update DB
  │  └─ dead channels → mark dead in DB, notify UI
  │  Normal operation resumes
  │
  └─ probeSocket(socketPath) fails (no daemon):
     Hub: spawn detached "lasterm-agent --daemon --socket <path>"
     Hub: poll probeSocket() every 200ms (up to 5s)
     ├─ Socket appears → connect, receive HELLO (no AGENT_CHANNEL_STATE on fresh start)
     └─ Timeout → fall back to child_process stdio mode (warm restart)
```

### 5.7 Write-Lock Flow

```
Channel ch-1: Client A = WRITER, Client B = READER

── Tier 1: Auto-release ──
A disconnects → lock freed → Hub broadcasts WRITE_LOCK { holder: null }
B sends WRITE_CLAIM → lock granted → Hub broadcasts WRITE_LOCK { holder: B }

── Tier 2: Request/Approve ──
B → Hub: WRITE_CLAIM
Hub → A: WRITE_REQUEST { from: B }
A → Hub: WRITE_GRANT { to: B }  (or WRITE_DENY)
Hub: transfer lock → broadcast WRITE_LOCK { holder: B }

── Tier 3: Force override ──
B → Hub: WRITE_FORCE
Hub: immediately transfer → A gets WRITE_REVOKED
Hub: broadcast WRITE_LOCK { holder: B }
```

## 6. Config Cascade

```
Layer 1: Built-in defaults (code)
  │ font: "monospace", fontSize: 14, theme: catppuccin-mocha
  │
Layer 2: config.toml (see § 7 for platform paths)
  │ Overrides: font, theme, keybindings, hub settings
  │
Layer 3: Host profile (meta.db hosts.profile_json)
  │ Overrides: theme colors, badge — per host
  │
Layer 3.5: Agent visual hints (from HELLO)
  │ Overrides: badge, theme_overlay — if trust policy = "apply"
  │
Layer 4: Channel profile (meta.db channels.profile_json)
  │ Overrides: any terminal setting — per channel
  ▼
Resolved config → xterm.js instance
```

Terminal background profile keys cascade through the same four layers:

| TOML key | Profile key | Values | Default | Notes |
|----------|-------------|--------|---------|-------|
| `background_mode` | `backgroundMode` | `image`, `solid`, `transparent` | `image` | `image` keeps existing wallpaper behavior; `image` with no wallpaper renders solid. In browser clients, `transparent` renders solid. |
| `window_effect` | `windowEffect` | `none`, `auto`, `mica`, `blur`, `acrylic`, `vibrancy-under-window`, `vibrancy-sidebar`, `vibrancy-hud` | `none` | Desktop-only native effect, used only when `backgroundMode` resolves to `transparent`. |

Native effect resolution:

| Requested effect | Linux | Windows 10 | Windows 11 | macOS |
|------------------|-------|------------|------------|-------|
| `auto` | none | `blur` | `mica` | `vibrancy-under-window` |
| `mica` | none | none | `mica` | none |
| `acrylic` | none | `acrylic` | `acrylic` | none |
| `blur` | none | `blur` | `blur` | none |
| `vibrancy-*` | none | none | none | matching macOS vibrancy material |

**Deep merge:** Object keys merge recursively. Scalars overwrite. `null` removes key. Arrays replace.

### 6.1 Agent Config (`[agent]` section in config.toml)

The `[agent]` section configures the local daemon agent. These settings are defined in the `AgentConfig` interface (`@lasterm/shared/agent-config.ts`):

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `socket_path` | string | Platform-dependent (see SECURITY.md) | UDS/named pipe path for daemon communication |
| `buffer_per_channel` | number | 1048576 (1 MB) | Max output buffer per channel (bytes) |
| `buffer_global` | number | 20971520 (20 MB) | Max total output buffer across all channels (bytes) |

### 6.2 Logging Config (`[logging]` section in config.toml)

The `[logging]` section is the single logging contract for both the hub and agent. The hub parses the section before initializing `HubLogger`, and passes the effective agent `level` and `format` through the same launch channel used for local daemon and remote stdio agents. For the hub, `format` governs only console/stderr rendering; the API-backing `logs/hub.jsonl` file is always JSONL when file output is enabled.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `level` | string | `"info"` | Hub and agent log level: trace, debug, info, warn, error |
| `format` | string | `"jsonl"` | Console/stderr line rendering: `jsonl` for machine-readable JSON lines, `text` for human-readable single-line records. The hub file sink remains JSONL; the agent applies this to its own output stream. |
| `output` | string | `"file"` | Hub output target: stderr, file, both. `file` and `both` write JSONL to `logs/hub.jsonl`. |
| `max_age_days` | number | 30 | Log retention in days; 0 keeps forever |
| `max_size_mb` | number | 50 | Per-channel log size limit in MB; 0 is unlimited |

## 7. File System Layout

### Platform Paths

| Purpose | Linux / macOS (XDG) | Windows |
|---------|---------------------|---------|
| **Config** | `$XDG_CONFIG_HOME/lasterm/` → `~/.config/lasterm/` | `%APPDATA%\lasterm\` |
| **Data** (DBs) | `$XDG_DATA_HOME/lasterm/` → `~/.local/share/lasterm/` | `%LOCALAPPDATA%\lasterm\` |
| **State** (runtime) | `$XDG_STATE_HOME/lasterm/` → `~/.local/state/lasterm/` | `%LOCALAPPDATA%\lasterm\` |

All XDG variables respect user overrides. Fall back to defaults shown above.

### Directory Contents

```
Config dir:
├── config.toml              # User preferences (layer 2)
└── auth.json                # { token: "crypto-random-hex" } (chmod 600 / ACL on Windows)

Data dir:
├── meta.db                  # Hosts, sessions, channels, workspaces, groups
├── meta.db-wal
├── spool.db                 # Output chunks, snapshots
└── spool.db-wal

State dir:
├── runtime.json             # { port, pid, started_at, spki } — written on start, deleted on shutdown
├── hub-tls-cert.pem         # 0600 — a copy of whatever certificate is in effect, an operator's
                             #        included. Nothing decides anything from it
├── hub-tls-generated-cert.pem # 0600 — the leaf this hub generated over its own key, reused across
                             #        restarts and replaced only when it can no longer serve
└── hub-tls-key.pem          # 0600 — the durable identity. Losing it re-pairs every client; back it
                             #        up with the same care as a private key, never share it
```

### runtime.json (TLS endpoint discovery)

Written at startup for CLI/UI discovery of the OS-assigned or explicitly overridden port,
and for the public-key identity serving it.

```json
{ "port": 41237, "pid": 12345, "started_at": "2026-03-03T10:00:00Z", "spki": "base64-DER-SPKI" }
```

CLI and UI read this file to find the HTTPS/WSS hub and pin its key. Deleted on clean shutdown; stale file detected via PID check.

## 8. Monorepo Structure

### 8.1 npm Naming Strategy

**Nothing here is published.** Every package is marked private, no workflow runs
`npm publish`, and the names below are workspace identifiers only.

| Package | npm name | Purpose |
|---------|----------|---------|
| Root | workspace root | CLI entrypoint, built from this repository |
| shared | `@lasterm/shared` | Types, codec, framing |
| hub | `@lasterm/hub` | Local daemon (imported by root CLI) |
| web | `@lasterm/web` | Vue SPA (built + served by hub) |
| desktop | `@lasterm/desktop` | Tauri desktop app |

There is no `@lasterm/agent`: the agent is the Rust crate `crates/lasterm-agent`, and no
npm package corresponds to it. The `@lasterm` scope itself is unclaimed on the registry —
what exists there is three `@termora/*` 0.0.1 placeholders published before the rename.

Root `lasterm` package is a thin CLI wrapper that depends on `@lasterm/hub`.
The built `lasterm-hub` binary launches the hub daemon. The agent is a Rust binary the hub fetches from GitHub Releases and deploys over SFTP; neither is distributed through npm.

### 8.2 Directory Layout

```
lasterm/
├── package.json             # lasterm (root CLI entrypoint)
├── pnpm-workspace.yaml
├── tsconfig.base.json       # Shared TS config (strict)
├── biome.json               # Linter/formatter config
├── docs/
│   ├── SPEC.md
│   ├── PROTOCOL.md
│   ├── STORAGE.md
│   ├── SECURITY.md
│   └── MVP_ROADMAP.md
├── packages/
│   ├── shared/              # @lasterm/shared — types, codec, framing
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts     # Barrel export
│   │       ├── protocol.ts  # Message types (discriminated unions)
│   │       ├── codec.ts     # MessagePack encode/decode + snake_case↔camelCase
│   │       ├── framing.ts   # Length-prefixed frame encoder/decoder
│   │       ├── config.ts    # Config types (TerminalProfile, TabLayout) + deep merge
│   │       ├── entities.ts  # Host, Session, Channel, Workspace, ChannelGroup
│   │       ├── constants.ts # Protocol version, defaults, error codes
│   │       ├── socket-path.ts # getSocketPath(override?) + probeSocket(path) for UDS
│   │       └── agent-config.ts # AgentConfig interface (daemon settings)
│   ├── hub/                 # @lasterm/hub — local daemon
│   │   ├── package.json
│   │   └── src/
│   │       ├── main.ts      # Daemon start (exported for root CLI)
│   │       ├── server.ts    # HTTP + WS server (Fastify)
│   │       ├── api/         # REST route handlers
│   │       ├── ws/          # WS message handlers
│   │       ├── session/     # Session manager (local + SSH + daemon)
│   │       │   ├── lasterm-agent.ts  # LastermAgent: hub-side AgentConnection over UDS
│   │       │   └── agent-launcher.ts # connectOrLaunch: probe, spawn, poll daemon
│   │       ├── ssh.ts       # SSH connection manager
│   │       ├── cache.ts     # Cache manager
│   │       ├── storage/     # SQLite DAL (meta.db + spool.db)
│   │       │   └── migrations/
│   │       │       ├── meta/    # 001-initial.sql, ...
│   │       │       └── spool/   # 001-initial.sql, ...
│   │       ├── config.ts    # Config resolver (4-layer cascade)
│   │       ├── auth.ts      # Token auth + pairing
│   │       └── cli.ts       # CLI commands (start, stop, host, pair, ...)
│   └── clients/
│       ├── web/             # @lasterm/web — Vue 3 SPA (MVP)
│       │   ├── package.json
│       │   ├── vite.config.ts
│       │   └── src/
│       │       ├── App.vue
│       │       ├── stores/      # Pinia (hosts, sessions, channels, config)
│       │       ├── composables/ # useTerminal, useWs, useConfig
│       │       ├── components/  # HostRail, ChannelSidebar, TerminalPane, ...
│       │       └── services/    # API client, WS client
│       └── desktop/         # @lasterm/desktop — Tauri v2 (P1, placeholder)
│           └── README.md
└── scripts/
    ├── dev.sh               # Start hub + web dev servers
    └── install-agent.sh     # Install agent on remote via SSH
```

### 8.3 Dependency Graph

```
lasterm (root CLI)
  └── @lasterm/hub
        ├── @lasterm/shared
        ├── @lasterm/web (build output embedded as static files)
        ├── better-sqlite3
        ├── ssh2
        └── fastify + @fastify/websocket

crates/lasterm-agent (a Rust binary, not an npm package)
  ├── async-xpty  (PTY, pinned by git rev)
  ├── vt100       (screen model)
  └── rmp-serde   (MessagePack framing)

Note: no Node process opens a PTY. Hub spawns the agent binary locally
(child_process) or deploys and runs it over SSH.

@lasterm/web
  ├── @lasterm/shared (types only, tree-shaken)
  ├── vue 3
  ├── pinia
  ├── xterm + @xterm/addon-fit + @xterm/addon-serialize
  └── @msgpack/msgpack

@lasterm/desktop (P1)
  └── @lasterm/web (embedded in Tauri webview)
```

## 9. Technology Stack

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Runtime | Node.js ≥ 24 LTS | Hub (the agent is a standalone Rust binary and needs no Node) |
| Language | TypeScript (strict) | All packages |
| Monorepo | pnpm workspaces | Package management |
| PTY | `async-xpty` (Rust) | Terminal spawn/resize — in the agent; no Node PTY exists |
| SSH | ssh2 | Remote connections |
| Terminal (UI) | xterm.js + addon-fit + addon-serialize | Rendering + restore |
| Terminal (Agent) | the `vt100` crate (Rust) | Screen model |
| Codec | @msgpack/msgpack | Binary protocol framing |
| Storage | better-sqlite3 | SQLite WAL persistence |
| HTTP/WS | Fastify + @fastify/websocket | REST + WS server |
| UI Framework | Vue 3 (Composition API) | Reactive UI |
| UI Build | Vite | Dev + production build |
| UI State | Pinia | Store management |
| Config parse | @iarna/toml | TOML config file |
| IDs | ulid | Sortable unique IDs |
| Desktop (P1) | Tauri v2 | Optional packaging |

## 10. Cross-Cutting Concerns

### 10.1 Observability

- Structured JSON logs, one line per event
- Trace IDs: `sid:<session-id>` and `cid:<channel-id>` prefixes
- Log levels: trace, debug, info, warn, error
- Health: `GET /api/health` → `{ status, uptime, sessions, channels, spool_size_bytes }`

### 10.2 Error Handling

- Hub: never crash on client error — log + respond ERROR message
- Agent crash: hub detects SSH close → reconnect loop
- SSH: try/catch with structured errors, retry with backoff
- Storage: WAL handles concurrency; busy_timeout for lock contention

### 10.3 Platform Support

| Platform | Hub | Agent | UI |
|----------|:---:|:-----:|:--:|
| Linux x64 | ✅ | ✅ | ✅ |
| macOS arm64/x64 | ✅ | ✅ | ✅ |
| Windows x64 | ✅ | ✅ | ✅ |
| WSL | ✅ | ✅ | ✅ |

Agent spawns PTYs for the host OS: bash/zsh (Linux/macOS), PowerShell/cmd/wsl.exe (Windows).
Hub never spawns PTYs directly — it delegates to the agent (local or remote).
