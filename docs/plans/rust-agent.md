---
doc-meta:
  status: canonical
  scope: agent
  type: specification
  target_project: /mnt/wsl/shared/dev/lasterm
  created: 2026-03-21
  updated: 2026-06-09
  complexity: COMPLEX
  time-budget: 50-60h
  adversarial_applied: true
---

# Specification: Rust Agent Rewrite (async-xpty + lasterm-agent)

## 0. Quick Reference

| Item | Value |
|------|-------|
| Scope | agent (full rewrite TS → Rust) |
| Complexity | COMPLEX |
| Time budget | ~50-60h |
| Blocks | 10 |
| BDD scenarios | 42 |
| Risk level | MEDIUM |
| Deliverables | `async-xpty` crate (public) + `lasterm-agent` binary |
| Adversarial | Applied (19 challenges, 18 valid, 1 deferred) |

## 1. Problem Statement

Node.js SEA cannot reliably distribute native addons like node-pty. ConPTY hangs and WinPTY crashes inside SEA on Windows. The packaging story (dlopen hacks, PATH manipulation, asset extraction) is fragile and unsustainable. A native Rust agent eliminates the entire Node.js SEA dependency chain — one static binary per platform, no runtime, no native addon loading.

Additionally, no production-quality async PTY crate exists in the Rust ecosystem. portable-pty is sync-only with a critical unpatched Windows regression (v0.9.0, issue #6783, 8 months open). Creating `async-xpty` fills this gap.

## 2. User Stories

### US-1: Reliable Windows Agent

```
AS A lasterm user on Windows
I WANT the agent binary to work without crashes or hangs
SO THAT I can use lasterm on Windows with the same reliability as Linux

ACCEPTANCE: Agent spawns PTY via ConPTY, handles I/O, resize, and exit
            without deadlocks or garbage reads on Windows 10+
```

### US-2: Single Native Binary

```
AS A lasterm developer/operator
I WANT a single native binary per platform for the agent
SO THAT distribution is trivial (no Node.js, no native addon hacks, no SEA)

ACCEPTANCE: `lasterm-agent` binary runs standalone on linux-x64, windows-x64,
            darwin-arm64 with zero runtime dependencies
```

### US-3: Protocol Compatibility

```
AS A lasterm hub
I WANT the Rust agent to speak the exact same MessagePack protocol
SO THAT zero hub modifications are needed — drop-in replacement

ACCEPTANCE: Hub cannot distinguish Rust agent from TS agent.
            All 17 message types work identically.
```

## 3. Business Rules

### 3.1 Invariants (always true)

- INV-01: All messages use 4-byte LE length prefix + MessagePack payload
- INV-02: All field names are snake_case on the wire
- INV-03: HELLO is always the first message sent by agent
- INV-04: Each channel has a monotonically increasing `seq` counter for OUTPUT
- INV-05: `channel_id` is a ULID (agent-generated if not provided in SPAWN)
- INV-06: Timestamps are ISO 8601 strings
- INV-07: Max frame size is 10 MB
- INV-08: Elevation secrets use `Zeroizing<String>` (zeroize crate) — never plain `String`
- INV-09: Agent never persists passwords to disk
- INV-10: DESTROY is idempotent — destroying an already-dead channel is a no-op (no error)
- INV-11: FrameReader handles partial frames (accumulates bytes across reads)
- INV-12: async-xpty stays at 0.x.y semver until stabilized (no premature 1.0)

### 3.2 Preconditions (required before action)

- PRE-01: Agent must send HELLO before hub sends any command
- PRE-02: SPAWN requires valid shell path (resolved by agent or provided)
- PRE-03: ATTACH requires channel to exist (alive or buffered)
- PRE-04: INPUT/RESIZE/DESTROY require channel to exist and be alive
- PRE-05: Daemon mode requires valid socket path (≤100 bytes)

### 3.3 Effects (what changes)

- EFF-01: SPAWN creates a PTY process + headless terminal mirror
- EFF-02: OUTPUT includes `seq` (per-channel counter) and `ts` (wall clock)
- EFF-03: RESIZE updates both PTY dimensions and headless terminal dimensions
- EFF-04: DESTROY kills PTY process and removes channel from registry (idempotent — no-op if already dead)
- EFF-05: CHANNEL_EXIT fires when PTY process exits (natural or killed); concurrent DESTROY + natural exit handled gracefully
- EFF-06: In daemon mode, new connection displaces previous (last-writer-wins)
- EFF-07: On daemon reconnect, agent enumerates all channels via AGENT_CHANNEL_STATE

### 3.4 Error Handling

- ERR-01: Unknown shell → SPAWN_ERR `SHELL_NOT_FOUND`
- ERR-02: Permission denied on PTY spawn → SPAWN_ERR `PERMISSION_DENIED`
- ERR-03: Generic PTY failure → SPAWN_ERR `PTY_SPAWN_FAILED`
- ERR-04: Elevation needs password but none given → SPAWN_ERR `ELEVATION_PASSWORD_REQUIRED`
- ERR-05: Unknown message type → ERROR `INVALID_MESSAGE`
- ERR-06: Operation on unknown channel → ERROR `CHANNEL_NOT_FOUND`
- ERR-07: stdin EOF (stdio mode) → graceful shutdown (destroy all PTYs)
- ERR-08: SIGTERM/SIGINT → graceful shutdown
- ERR-09: Frame > 10 MB → protocol error, close connection
- ERR-10: SPAWN with duplicate channel_id (already exists) → SPAWN_ERR `CHANNEL_EXISTS`

## 4. Technical Design

### 4.1 Architecture Decision

Two Rust crates in a Cargo workspace at monorepo root:

1. **async-xpty** — Public crate. Cross-platform async PTY. Direct OS API calls via `nix` (Unix) and `windows-sys` (Windows). Tokio AsyncRead/AsyncWrite. Not coupled to lasterm.

2. **lasterm-agent** — Binary crate. Full protocol implementation. Depends on async-xpty for PTY, rmp-serde for MessagePack, vt100 for terminal state mirror.

**Why new crate vs portable-pty dependency:** portable-pty is sync-only (requires spawn_blocking for every read), has a critical unpatched Windows regression (#6783), is tightly coupled to the wezterm monorepo with no independent release cycle, and no maintained fork exists. Building async-native from OS APIs is ~1000 LoC for both platforms, which is less maintenance burden than working around a broken dependency.

### 4.2 Monorepo Layout

```
lasterm/
├── Cargo.toml              ← workspace { members = ["crates/*"] }
├── crates/
│   ├── async-xpty/
│   │   ├── Cargo.toml      ← [lib] name = "async_xpty"
│   │   └── src/
│   │       ├── lib.rs       ← public API, PtyProcess trait, PtySize, ExitStatus
│   │       ├── command.rs   ← CommandBuilder (shell, args, cwd, env)
│   │       ├── unix.rs      ← openpty + forkpty + tokio::io
│   │       └── windows.rs   ← CreatePseudoConsole + tokio::io + \x1b[6n fix
│   └── lasterm-agent/
│       ├── Cargo.toml       ← [[bin]] name = "lasterm-agent"
│       └── src/
│           ├── main.rs       ← CLI args, stdio/daemon mode selection
│           ├── framing.rs    ← 4-byte LE + MessagePack encode/decode
│           ├── protocol.rs   ← All message structs (serde, snake_case)
│           ├── handler.rs    ← Message dispatch (SPAWN, INPUT, etc.)
│           ├── pty.rs        ← PtyManager (channels, seq, headless mirror)
│           ├── headless.rs   ← vt100::Parser wrapper (snapshot, title, bell)
│           ├── daemon.rs     ← UDS server, connection displacement, output buffer
│           ├── elevation.rs  ← sudo/doas/pkexec/gsudo/custom + ASKPASS
│           ├── shell.rs      ← Shell detection per OS
│           ├── process.rs    ← Process title polling per OS
│           ├── expand.rs     ← Variable expansion (${VAR} syntax)
│           └── batch.rs      ← Output batching (16ms / 4KB)
├── packages/                ← TypeScript (unchanged)
└── pnpm-workspace.yaml
```

### 4.3 Key Dependencies

| Crate | Purpose | Version |
|-------|---------|---------|
| tokio | Async runtime (full features) | 1.x |
| rmp-serde | MessagePack encode/decode | 1.x |
| serde | Serialization framework | 1.x |
| vt100 | Terminal state parser (snapshots, title, bell) | 0.15+ |
| nix | Unix syscalls (openpty, forkpty, ioctl, waitpid) | 0.29+ |
| windows-sys | Windows API (CreatePseudoConsole, etc.) | 0.59+ |
| ulid | ULID generation | 1.x |
| clap | CLI argument parsing | 4.x |
| tracing | Structured logging | 0.1.x |
| serde_bytes | Binary field serialization (Vec<u8> → MsgPack Bin) | 0.11+ |
| zeroize | Secure memory zeroing for secrets | 1.x |

### 4.4 Protocol Wire Format

All messages serialize with `#[serde(rename_all = "snake_case")]`. The `type` field is a string tag, NOT renamed (stays UPPER_SNAKE_CASE like `"SPAWN"`, `"OUTPUT"`).

**CRITICAL (from /llm review — 3/3 LLMs flagged):**
- rmp-serde default serializes structs as **MessagePack arrays** (positional). The TS hub expects **maps** (named keys). Must use `rmp_serde::encode::to_vec_named()` or `Serializer::with_struct_map()`. Without this, protocol is broken.
- Binary fields (`data` in INPUT/OUTPUT) must use `#[serde(with = "serde_bytes")]` to serialize as MessagePack Bin, not as integer arrays. Without this, `Uint8Array` in JS decodes incorrectly.

```rust
#[serde(tag = "type", rename_all = "snake_case")]
enum AgentMessage {
    #[serde(rename = "HELLO")]
    Hello { version: u32, agent_version: String, capabilities: Vec<String>, ... },
    #[serde(rename = "SPAWN_OK")]
    SpawnOk { request_id: String, channel_id: String },
    #[serde(rename = "OUTPUT")]
    Output {
        channel_id: String,
        seq: u64,
        ts: String,
        #[serde(with = "serde_bytes")]
        data: Vec<u8>,  // MessagePack Bin, NOT integer array
    },
    // ... all 17 message types
}

// Encoding: MUST use named/map serialization
let bytes = rmp_serde::to_vec_named(&message)?;
// NOT: rmp_serde::to_vec(&message)  ← this produces arrays!
```

Framing: `[4-byte LE u32 length][MessagePack payload]`. Max 10 MB.

### 4.5 Snapshot Format Compatibility

The TS agent uses xterm.js SerializeAddon which produces a proprietary string format. The Rust agent uses `vt100` crate which has a different internal representation.

**Strategy:** The snapshot `serialized` field contains VT escape sequences that reconstruct the terminal state. The `vt100` crate can produce this via `screen.contents_formatted()` which outputs ANSI escape sequences. The UI's xterm.js can consume raw ANSI — it doesn't need SerializeAddon format specifically.

**Known limitation (from /llm review — 3/3 LLMs flagged):** vt100 snapshots may not preserve soft-wrap status of lines. If the UI terminal is resized after snapshot restore, text won't reflow correctly (hard newlines baked in). This is acceptable for MVP — the TS agent's SerializeAddon has the same limitation in practice. Scrollback content must be included in snapshot (iterate full history, not just visible viewport).

**CSI 6n auto-response (from /llm review — 2/3 LLMs flagged):** When auto-responding to `\x1b[6n` cursor position queries, respond with the **actual cursor position from vt100 state** (not static `\x1b[1;1R`). This prevents issues with applications (vim, tmux) that use CPR for layout. The agent IS the terminal for the PTY process — responding is correct behavior.

**Verification needed:** Block 5 exit criteria includes a compatibility test confirming xterm.js renders vt100-produced snapshots identically, including cursor positioning via `\x1b[row;colH`.

## 5. Acceptance Criteria (BDD)

### Scenario Group: async-xpty Core

```gherkin
@priority:high @type:nominal
Scenario: SC-01 — Spawn PTY on Unix
  Given a Unix system with /bin/sh available
  When async-xpty spawns a PTY with shell="/bin/sh"
  Then a PtyProcess is returned with a valid child PID
  And the PTY reader implements AsyncRead
  And the PTY writer implements AsyncWrite

@priority:high @type:nominal
Scenario: SC-02 — Read PTY output
  Given a spawned PTY running "echo hello"
  When reading from the PTY reader
  Then the output contains "hello"
  And the read completes asynchronously (tokio)

@priority:high @type:nominal
Scenario: SC-03 — Write PTY input
  Given a spawned PTY running a shell
  When writing "ls\n" to the PTY writer
  Then the shell executes the command
  And output appears on the PTY reader

@priority:high @type:nominal
Scenario: SC-04 — Resize PTY
  Given a spawned PTY with cols=80, rows=24
  When resizing to cols=120, rows=40
  Then the PTY reports the new size
  And child processes see updated TIOCGWINSZ (Unix) / buffer size (Windows)

@priority:high @type:nominal
Scenario: SC-05 — PTY exit detection
  Given a spawned PTY running "exit 42"
  When the shell exits
  Then the exit status reports code=42
  And subsequent reads return EOF

@priority:high @type:edge
Scenario: SC-06 — Spawn with env and cwd
  Given a spawned PTY with env={"FOO": "bar"} and cwd="/tmp"
  When the shell runs "echo $FOO && pwd"
  Then output contains "bar" and "/tmp"

@priority:high @type:nominal @platform:windows
Scenario: SC-07 — Spawn PTY on Windows (ConPTY)
  Given a Windows 10+ system
  When async-xpty spawns a PTY with shell="cmd.exe"
  Then a PtyProcess is returned
  And I/O works via ConPTY pipes
  And the \x1b[6n cursor query is handled automatically (no deadlock)

@priority:high @type:error
Scenario: SC-08 — Spawn nonexistent shell
  Given shell="/nonexistent/shell"
  When async-xpty attempts to spawn
  Then an error is returned (not a panic)
  And the error indicates the shell was not found
```

### Scenario Group: Agent Protocol — Startup

```gherkin
@priority:high @type:nominal
Scenario: SC-09 — HELLO on startup
  Given an agent started in stdio mode
  When the agent initializes
  Then the first frame on stdout is a HELLO message
  And it contains version=1, capabilities, available_shells

@priority:high @type:nominal
Scenario: SC-10 — Shell detection in HELLO
  Given a Linux system with /bin/bash and /bin/zsh installed
  When the agent sends HELLO
  Then available_shells contains "/bin/bash" and "/bin/zsh"
  And default_shell matches $SHELL or /bin/sh
```

### Scenario Group: Agent Protocol — SPAWN

```gherkin
@priority:high @type:nominal
Scenario: SC-11 — Successful SPAWN
  Given a running agent
  When hub sends SPAWN with shell="/bin/bash", cols=80, rows=24
  Then agent responds with SPAWN_OK containing a ULID channel_id
  And a PTY process is running

@priority:high @type:nominal
Scenario: SC-12 — SPAWN with hub-provided channel_id
  Given a running agent
  When hub sends SPAWN with channel_id="01ABC..."
  Then SPAWN_OK echoes the same channel_id

@priority:high @type:error
Scenario: SC-13 — SPAWN with missing shell
  Given a running agent
  When hub sends SPAWN with shell="/nonexistent"
  Then agent responds with SPAWN_ERR code="SHELL_NOT_FOUND"

@priority:high @type:nominal
Scenario: SC-14 — SPAWN with variable expansion
  Given HOME=/home/user in environment
  When hub sends SPAWN with cwd="${HOME}/projects"
  Then the PTY starts in /home/user/projects
  And env values are expanded but env keys are NOT
  And shell path is NOT expanded

@priority:high @type:nominal
Scenario: SC-15 — SPAWN with elevation (passwordless sudo)
  Given sudo -n works without password
  When hub sends SPAWN with elevated=true, elevation_method="sudo"
  Then agent wraps shell with ["sudo", "-n", "-H", "-E", "--", shell, ...args]
  And SPAWN_OK is returned

@priority:high @type:error
Scenario: SC-16 — SPAWN with elevation requiring password (no secret)
  Given sudo requires a password
  When hub sends SPAWN with elevated=true, no elevation_secret
  Then agent responds with SPAWN_ERR code="ELEVATION_PASSWORD_REQUIRED"

@priority:high @type:nominal
Scenario: SC-17 — SPAWN with elevation + ASKPASS
  Given sudo requires a password
  When hub sends SPAWN with elevated=true, elevation_secret="pass123"
  Then agent creates temp ASKPASS script (mode 0700)
  And wraps shell with SUDO_ASKPASS env
  And elevation_secret is zeroed in memory immediately
  And ASKPASS script is deleted after 1 second
```

### Scenario Group: Agent Protocol — I/O

```gherkin
@priority:high @type:nominal
Scenario: SC-18 — INPUT forwarding
  Given channel "ch-1" is alive
  When hub sends INPUT with data="ls\n"
  Then agent writes data to PTY stdin
  And OUTPUT messages appear with seq incrementing

@priority:high @type:nominal
Scenario: SC-19 — OUTPUT batching
  Given channel "ch-1" producing continuous output
  Then OUTPUT messages are batched (16ms or 4KB, whichever first)
  And each OUTPUT has incrementing seq and ISO 8601 ts

@priority:high @type:nominal
Scenario: SC-20 — RESIZE forwarding
  Given channel "ch-1" is alive
  When hub sends RESIZE cols=120, rows=40
  Then PTY is resized
  And headless terminal mirror is resized

@priority:high @type:edge
Scenario: SC-21 — INPUT on dead channel
  Given channel "ch-1" has exited
  When hub sends INPUT for "ch-1"
  Then agent responds with ERROR code="CHANNEL_NOT_FOUND"
```

### Scenario Group: Agent Protocol — Snapshot & Attach

```gherkin
@priority:high @type:nominal
Scenario: SC-22 — SNAPSHOT_REQ/RES
  Given channel "ch-1" has received output "hello world"
  When hub sends SNAPSHOT_REQ for "ch-1"
  Then agent responds with SNAPSHOT_RES containing:
    - serialized: ANSI escape sequence string reconstructing terminal state
    - cols, rows matching current PTY dimensions
    - cursor_x, cursor_y reflecting cursor position
    - last_seq matching last OUTPUT seq sent

@priority:high @type:nominal
Scenario: SC-23 — Snapshot compatible with xterm.js
  Given a snapshot produced by vt100 crate
  When the UI writes snapshot.serialized to xterm.js terminal
  Then the terminal renders the same visual content as the original PTY

@priority:high @type:nominal
Scenario: SC-24 — ATTACH to existing channel
  Given channel "ch-1" exists in daemon mode
  When hub sends ATTACH for "ch-1"
  Then agent responds with ATTACH_OK containing snapshot + last_seq
  And subsequent PTY output is forwarded as OUTPUT messages
```

### Scenario Group: Agent Protocol — Lifecycle

```gherkin
@priority:high @type:nominal
Scenario: SC-25 — CHANNEL_EXIT on natural exit
  Given channel "ch-1" running "exit 0"
  When the shell exits
  Then agent sends CHANNEL_EXIT with exit_code=0, signal=null

@priority:high @type:nominal
Scenario: SC-26 — DESTROY kills channel
  Given channel "ch-1" is alive
  When hub sends DESTROY for "ch-1"
  Then PTY process is killed
  And CHANNEL_EXIT is sent

@priority:high @type:nominal
Scenario: SC-27 — HEARTBEAT/ACK
  Given a running agent
  When hub sends HEARTBEAT with ts="2026-03-21T00:00:00Z"
  Then agent responds with HEARTBEAT_ACK echoing the same ts

@priority:high @type:nominal
Scenario: SC-28 — Graceful shutdown on stdin EOF
  Given an agent in stdio mode with channels ch-1, ch-2
  When stdin reaches EOF
  Then all PTYs are destroyed
  And agent exits with code 0

@priority:high @type:nominal
Scenario: SC-29 — Graceful shutdown on SIGTERM
  Given an agent with active channels
  When SIGTERM is received
  Then all PTYs are destroyed
  And agent exits cleanly
```

### Scenario Group: Agent Protocol — Terminal Events

```gherkin
@priority:high @type:nominal
Scenario: SC-30 — TITLE_CHANGE via OSC 0
  Given channel "ch-1" is alive
  When PTY output contains "\x1b]0;My Title\x07"
  Then agent sends TITLE_CHANGE with title="My Title"

@priority:high @type:nominal
Scenario: SC-31 — BELL detection
  Given channel "ch-1" is alive
  When PTY output contains "\x07"
  Then agent sends BELL for "ch-1"
  And bell events are throttled to 100ms minimum interval

@priority:high @type:nominal
Scenario: SC-32 — NOTIFICATION via OSC 9
  Given channel "ch-1" is alive
  When PTY output contains "\x1b]9;Build complete\x07"
  Then agent sends NOTIFICATION with message="Build complete"
  And message is sanitized (control chars stripped, max 256 chars)
  And notifications are throttled to 500ms minimum interval

@priority:high @type:nominal
Scenario: SC-33 — PROCESS_TITLE polling
  Given channel "ch-1" running bash, then user runs "vim"
  When process title poller detects foreground change
  Then agent sends PROCESS_TITLE with title="vim"
```

### Scenario Group: Daemon Mode

```gherkin
@priority:high @type:nominal
Scenario: SC-34 — Daemon startup and UDS listen
  Given agent started with --daemon --socket /tmp/lasterm.sock
  When initialization completes
  Then agent listens on Unix domain socket at /tmp/lasterm.sock
  And socket file has restricted permissions

@priority:high @type:nominal
Scenario: SC-35 — Daemon reconnect handshake
  Given daemon has channels ch-1 (alive) and ch-2 (dead)
  When hub connects to daemon UDS
  Then agent sends HELLO
  Then agent sends AGENT_CHANNEL_STATE for ch-1 (alive=true, pid=N)
  Then agent sends AGENT_CHANNEL_STATE for ch-2 (alive=false, pid=0)
  Then agent sends CHANNEL_STATE_END

@priority:high @type:nominal
Scenario: SC-36 — Connection displacement
  Given hub-A is connected to daemon
  When hub-B connects to daemon
  Then hub-A's connection is closed (last-writer-wins)
  And hub-B receives HELLO + channel state enumeration

@priority:high @type:edge
Scenario: SC-37 — Fresh daemon (no channels)
  Given daemon just started (no prior channels)
  When hub connects
  Then agent sends HELLO then immediately CHANNEL_STATE_END
```

### Scenario Group: Error Handling & Edge Cases (hardened by /adversarial)

```gherkin
@priority:high @type:error
Scenario: SC-38 — Unknown message type
  Given a running agent
  When hub sends a message with type="UNKNOWN_TYPE"
  Then agent responds with ERROR code="INVALID_MESSAGE"
  And agent continues operating (does not crash)

@priority:high @type:edge
Scenario: SC-39 — Concurrent DESTROY + natural exit
  Given channel "ch-1" running "exit 0"
  When shell exits AND hub sends DESTROY for "ch-1" simultaneously
  Then exactly one CHANNEL_EXIT is sent (not two)
  And no error or crash occurs (idempotent destroy)

@priority:high @type:edge @platform:windows
Scenario: SC-40 — Shell path with spaces (Windows)
  Given shell="C:\Program Files\Git\bin\bash.exe"
  When hub sends SPAWN with this shell path
  Then SPAWN_OK is returned
  And the PTY runs the correct shell

@priority:high @type:error
Scenario: SC-41 — SPAWN with duplicate channel_id
  Given channel "ch-1" already exists
  When hub sends SPAWN with channel_id="ch-1"
  Then agent responds with SPAWN_ERR code="CHANNEL_EXISTS"

@priority:high @type:security
Scenario: SC-42 — Variable expansion no recursion
  Given env={"INJECT": "${HOME}/../../../etc/passwd"}
  When hub sends SPAWN with cwd="${INJECT}"
  Then cwd is literally "${HOME}/../../../etc/passwd" (expanded value NOT re-expanded)
  And no path traversal occurs from recursive expansion
```

### Coverage Matrix

| Scenario | Nominal | Edge | Error | Security | Platform |
|----------|---------|------|-------|----------|----------|
| SC-01–05 | ✓ | | | | Unix |
| SC-06 | | ✓ | | | All |
| SC-07 | ✓ | | | | Windows |
| SC-08 | | | ✓ | | All |
| SC-09–10 | ✓ | | | | All |
| SC-11–12 | ✓ | | | | All |
| SC-13 | | | ✓ | | All |
| SC-14 | ✓ | | | | All |
| SC-15 | ✓ | | | | Unix |
| SC-16 | | | ✓ | | Unix |
| SC-17 | ✓ | | | ✓ | Unix |
| SC-18–20 | ✓ | | | | All |
| SC-21 | | ✓ | | | All |
| SC-22–24 | ✓ | | | | All |
| SC-25–29 | ✓ | | | | All |
| SC-30–33 | ✓ | | | | All |
| SC-34–36 | ✓ | | | | Unix |
| SC-37 | | ✓ | | | Unix |
| SC-38 | | | ✓ | | All |

| SC-39 | | ✓ | | | All |
| SC-40 | | ✓ | | | Windows |
| SC-41 | | | ✓ | | All |
| SC-42 | | | | ✓ | All |

**Totals:** 42 scenarios (27 nominal, 6 edge, 6 error, 2 security, 1 platform-specific)

## 6. Implementation Plan

### Block 1: async-xpty — Unix PTY (S, ~3h)

**Type:** Feature slice (crate foundation)
**Dependencies:** None

**Files:**
- `Cargo.toml` (workspace root) — create Rust workspace
- `crates/async-xpty/Cargo.toml` — crate manifest
- `crates/async-xpty/src/lib.rs` — public API: `PtyProcess`, `PtySize`, `ExitStatus`, `CommandBuilder`
- `crates/async-xpty/src/command.rs` — `CommandBuilder` (shell, args, cwd, env)
- `crates/async-xpty/src/unix.rs` — `openpty()`, `forkpty()`, session isolation (`setsid`), **controlling terminal (`TIOCSCTTY`)**, FD cleanup, `TIOCSWINSZ`, tokio `AsyncFd` wrapper for async I/O

**Exit criteria:**
- [ ] `cargo build` succeeds on Linux/macOS
- [ ] `CommandBuilder::new("/bin/sh").spawn()` returns `PtyProcess`
- [ ] Async read from PTY returns shell prompt (using `AsyncFd`, NOT `spawn_blocking`)
- [ ] Async write sends input to shell
- [ ] `resize(cols, rows)` works
- [ ] Exit code detected on shell exit
- [ ] **Ctrl+C test:** writing `\x03` to PTY terminates a `sleep` command (validates `TIOCSCTTY` set correctly)
- [ ] **macOS explicit test:** `cargo test` passes on macOS (openpty/ioctl timing differences)
- [ ] SC-01, SC-02, SC-03, SC-04, SC-05, SC-06, SC-08 pass

### Block 2: async-xpty — Windows ConPTY (M, ~5h)

**Type:** Feature slice (platform implementation)
**Dependencies:** Block 1

**Files:**
- `crates/async-xpty/src/windows.rs` — `CreatePseudoConsole`, pipe setup, `STARTUPINFOEX`, attribute lists, `ResizePseudoConsole`, `ClosePseudoConsole`, async pipe I/O via tokio named pipes, `\x1b[6n` auto-response

**Exit criteria:**
- [ ] `cargo build --target x86_64-pc-windows-msvc` succeeds
- [ ] PTY spawn with `cmd.exe` works
- [ ] I/O works without deadlock (regression #6783 handled)
- [ ] Resize works
- [ ] Exit detection works
- [ ] SC-07 passes
- [ ] Cross-platform CI: `cargo test` on Linux + Windows

### Block 3: lasterm-agent — Scaffold + Framing + HELLO (S, ~3h)

**Type:** Feature slice (agent foundation)
**Dependencies:** Block 1

**Files:**
- `crates/lasterm-agent/Cargo.toml` — binary crate, depends on async-xpty
- `crates/lasterm-agent/src/main.rs` — CLI args (clap): `--daemon`, `--socket`, `--version`; stdio mode entry
- `crates/lasterm-agent/src/protocol.rs` — all message structs with serde `#[serde(tag = "type")]`, snake_case rename
- `crates/lasterm-agent/src/framing.rs` — `FrameReader` (4-byte LE prefix + msgpack decode, handles partial frames across reads), `encode_frame()` (length prefix + msgpack encode)
- `crates/lasterm-agent/src/shell.rs` — `detect_available_shells()`, `get_default_shell()` per OS
- `crates/lasterm-agent/src/handler.rs` — `AgentHandler` stub with `send_hello()`

**Exit criteria:**
- [ ] `lasterm-agent --version` prints version
- [ ] Agent started in stdio mode sends HELLO as first frame
- [ ] HELLO contains correct version, capabilities, available_shells
- [ ] Frame encoding uses `rmp_serde::to_vec_named()` (map serialization, NOT array)
- [ ] Binary fields use `#[serde(with = "serde_bytes")]` (MessagePack Bin, NOT integer array)
- [ ] Frame encoding matches TS agent format (verified with `@msgpack/msgpack` decode)
- [ ] SC-09, SC-10 pass

### Block 4: lasterm-agent — SPAWN + I/O (M, ~5h)

**Type:** Feature slice (core functionality)
**Dependencies:** Block 3

**Files:**
- `crates/lasterm-agent/src/handler.rs` — SPAWN, INPUT, RESIZE, DESTROY dispatch
- `crates/lasterm-agent/src/pty.rs` — `PtyManager`: channel registry (`HashMap<String, PtyChannel>`), spawn, write, resize, destroy
- `crates/lasterm-agent/src/batch.rs` — output batching: single global timer loop flushes all channels (NOT per-channel timers), 16ms interval or 4KB per channel threshold
- `crates/lasterm-agent/src/expand.rs` — `expand_vars()`: `${VAR}` syntax, one-pass, no recursion, case-insensitive on Windows

**Exit criteria:**
- [ ] SPAWN creates PTY, returns SPAWN_OK with ULID channel_id
- [ ] INPUT writes to PTY stdin
- [ ] OUTPUT messages flow with correct seq, ts, data
- [ ] Output batching: 16ms or 4KB whichever first
- [ ] RESIZE updates PTY and reports success
- [ ] DESTROY kills PTY, CHANNEL_EXIT sent (idempotent — no error if already dead)
- [ ] Duplicate channel_id → SPAWN_ERR `CHANNEL_EXISTS`
- [ ] Variable expansion works (`${HOME}` → value, `\${HOME}` → literal, shell NOT expanded, no recursive expansion)
- [ ] SC-11, SC-12, SC-13, SC-14, SC-18, SC-19, SC-20, SC-21, SC-25, SC-26, SC-39, SC-40, SC-41, SC-42 pass

### Block 5: lasterm-agent — Terminal Mirror + Snapshots (M, ~4h)

**Type:** Feature slice (terminal state)
**Dependencies:** Block 4

**Files:**
- `crates/lasterm-agent/src/headless.rs` — `HeadlessMirror`: wraps `vt100::Parser` (scrollback: 1000 lines default, configurable), feeds PTY output, extracts title (OSC 0/2), bell (`\x07`), notification (OSC 9), produces snapshot
- `crates/lasterm-agent/src/pty.rs` — integrate HeadlessMirror into PtyChannel

**Exit criteria:**
- [ ] All PTY output is mirrored to vt100 parser
- [ ] SNAPSHOT_REQ returns SNAPSHOT_RES with serialized terminal state (ANSI sequences)
- [ ] Snapshot includes correct cols, rows, cursor_x, cursor_y, last_seq
- [ ] TITLE_CHANGE sent on OSC 0/2 detection (debounced 100ms)
- [ ] BELL sent on `\x07` (throttled 100ms)
- [ ] NOTIFICATION sent on OSC 9 (sanitized, max 256 chars, throttled 500ms)
- [ ] **Snapshot compatibility test:** vt100-produced snapshot renders correctly in xterm.js
- [ ] SC-22, SC-23, SC-30, SC-31, SC-32 pass

### Block 6: lasterm-agent — Process Title + Events (S, ~3h)

**Type:** Feature slice (OS integration)
**Dependencies:** Block 4

**Files:**
- `crates/lasterm-agent/src/process.rs` — `ProcessTitlePoller`: periodic foreground process name detection
  - Linux: read `/proc/{pid}/comm` + `/proc/{pid}/cmdline`
  - macOS: `ps -p {pid} -o comm=`
  - Windows: `wmic process where ProcessId={pid} get Name`

**Exit criteria:**
- [ ] Process title changes detected and sent as PROCESS_TITLE
- [ ] Polling stops when channel exits
- [ ] Poll interval: 2s default, max 1 concurrent poll at a time (serialize, don't parallelize 50 wmic calls)
- [ ] Works on Linux (proc filesystem), macOS (ps), Windows (wmic)
- [ ] SC-33 passes

### Block 7: lasterm-agent — Elevation (M, ~4h)

**Type:** Feature slice (privilege escalation)
**Dependencies:** Block 4

**Files:**
- `crates/lasterm-agent/src/elevation.rs` — all elevation methods: sudo, doas, pkexec, gsudo, custom
  - Passwordless detection (sudo -n, doas -n)
  - ASKPASS script creation: `O_EXCL` + mode 0700, in user-private tmpdir (not world-readable /tmp)
  - Secret zeroing via `zeroize` crate (`Zeroizing<String>`) — NOT `String::clear()`
  - Cleanup: delete ASKPASS script after 1s + on shutdown (SIGTERM handler cleans up orphaned temp files)

**Exit criteria:**
- [ ] Passwordless sudo detection works
- [ ] ASKPASS temp file created with `O_EXCL` + mode 0700 in secure tmpdir
- [ ] ASKPASS script cleaned up after 1s AND on SIGTERM (no orphans)
- [ ] elevation_secret uses `Zeroizing<String>`, zeroed in memory after use
- [ ] All 5 methods work: sudo, doas, pkexec, gsudo, custom
- [ ] ELEVATION_PASSWORD_REQUIRED returned when password needed but not provided
- [ ] SC-15, SC-16, SC-17 pass

### Block 8: lasterm-agent — Daemon Mode (M, ~5h)

**Type:** Feature slice (persistence)
**Dependencies:** Block 4

**Files:**
- `crates/lasterm-agent/src/daemon.rs` — UDS server:
  - Socket bind with retry (3 attempts, random backoff 100-500ms)
  - Stale socket cleanup
  - **Socket permissions: 0600** (owner-only, no group/other access)
  - Connection handling with per-connection FrameReader
  - Connection displacement (last-writer-wins)
  - AGENT_CHANNEL_STATE enumeration on reconnect
  - Output buffer (ring buffer for disconnected periods)
  - Frame queue with backpressure (max 1000 frames)
  - Graceful shutdown (SIGTERM → destroy all, close socket, unlink)
  - Logging to file (state dir + agent.log)
  - **Windows:** UDS on Windows 10 1803+ (same as TS agent); named pipes as fallback if UDS unavailable

**Exit criteria:**
- [ ] `lasterm-agent --daemon --socket /tmp/test.sock` starts UDS server
- [ ] Socket file has permissions 0600 (owner-only)
- [ ] Hub connects, receives HELLO + channel state + CHANNEL_STATE_END
- [ ] New connection displaces old (last-writer-wins)
- [ ] Output buffered while no hub connected
- [ ] Backpressure: frame queue drains on socket.drain
- [ ] SIGTERM triggers clean shutdown
- [ ] SC-34, SC-35, SC-36, SC-37 pass

### Block 9: lasterm-agent — Robustness (S, ~3h)

**Type:** Feature slice (reliability)
**Dependencies:** Block 4

**Files:**
- `crates/lasterm-agent/src/handler.rs` — HEARTBEAT/ACK, ATTACH/ATTACH_OK, ERROR handling, unknown message handling
- `crates/lasterm-agent/src/main.rs` — stdin EOF detection, SIGTERM handler, graceful shutdown

**Exit criteria:**
- [ ] HEARTBEAT_ACK echoes ts from HEARTBEAT
- [ ] ATTACH returns ATTACH_OK with snapshot + last_seq
- [ ] Unknown message type → ERROR INVALID_MESSAGE (no crash)
- [ ] stdin EOF → destroy all PTYs, exit 0
- [ ] SIGTERM → destroy all PTYs, exit 0
- [ ] Backpressure in stdio mode: pause stdin when stdout full
- [ ] SC-24, SC-27, SC-28, SC-29, SC-38 pass

### Block 10: Integration + CI (M, ~5h)

**Type:** Integration / Infra
**Dependencies:** Blocks 1–9

**Files:**
- `crates/lasterm-agent/tests/integration/` — end-to-end tests: spawn Rust agent as child process, send MessagePack frames, verify responses
- `.github/workflows/rust-agent.yml` — CI: build + test on linux-x64, windows-x64, darwin-arm64
- `crates/lasterm-agent/tests/protocol_compat.rs` — decode/encode compatibility with TS `@msgpack/msgpack`
- `scripts/build-rust-agent.sh` — cross-compilation helper

**Exit criteria:**
- [ ] Integration test: spawn Rust agent → send HELLO check → SPAWN → INPUT → verify OUTPUT → DESTROY → verify CHANNEL_EXIT
- [ ] Protocol compatibility: Rust agent frames decodable by TS hub (and vice versa)
- [ ] CI passes on all 3 targets (linux-x64, windows-x64, darwin-arm64)
- [ ] Binary size < 10 MB per platform
- [ ] Hub TS can spawn Rust agent binary as child_process and communicate normally
- [ ] US-1, US-2, US-3 acceptance criteria met

## 7. Test Strategy

### Test Pyramid

| Level | Count | Focus |
|-------|-------|-------|
| Unit | ~60 | async-xpty API, framing, protocol serde, variable expansion, shell detection, elevation logic |
| Integration | ~20 | Agent binary spawned as subprocess, full protocol exchange |
| Cross-platform | ~10 | Platform-specific PTY (Unix/Windows), shell detection, process title |

### Test Framework

- **Rust tests:** `cargo test` with `#[tokio::test]` for async
- **Integration:** spawn `lasterm-agent` binary, communicate via stdin/stdout pipes
- **Protocol compat:** encode frames in Rust, decode in TS (and vice versa) using shared test vectors

### Test Data

- **Fixtures:** predefined MessagePack frames for each message type
- **Mocks:** None needed — tests use real PTY (real shell, real I/O)
- **Platform CI:** GitHub Actions matrix (ubuntu-latest, windows-latest, macos-latest)

### What NOT to test

- Hub behavior (unchanged, covered by existing 2163 TS tests)
- UI behavior (unchanged)
- SSH transport (hub responsibility)

## 8. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| ConPTY `\x1b[6n` deadlock | H | H | Built-in detection + auto-response in async-xpty (Block 2) |
| vt100 snapshot ≠ xterm.js SerializeAddon | M | M | Block 5 includes compatibility test; fallback: raw ANSI reconstruction |
| rmp-serde ↔ @msgpack/msgpack field ordering | M | L | Protocol compat test in Block 10; use `#[serde(rename_all)]` consistently |
| Cross-compile CI complexity | L | M | Start with native builds, add cross-compile incrementally |
| Process title polling platform gaps | L | L | Already solved in TS agent, direct port |
| Daemon mode on Windows (UDS vs named pipes) | M | M | UDS on Win10 1803+ (like TS agent); named pipe fallback in Block 8 |
| async-xpty takes longer than expected | M | M | Fallback: depend on portable-pty 0.8.1 + spawn_blocking temporarily |
| Rust optimizer removes secret zeroing | H | M | `zeroize` crate uses compiler barriers to prevent optimization |
| ASKPASS temp file race condition | H | L | `O_EXCL` + mode 0700 + user-private tmpdir + cleanup on shutdown |

## 9. Definition of Done

- [ ] All 10 blocks implemented
- [ ] All 42 BDD scenarios have passing tests
- [ ] `cargo test` passes (unit + integration)
- [ ] `cargo clippy` clean (no warnings)
- [ ] CI passes on linux-x64, windows-x64, darwin-arm64
- [ ] Hub TS spawns Rust agent and communicates normally (drop-in replacement)
- [ ] Binary < 10 MB per platform
- [ ] async-xpty has README + docs.rs documentation
- [ ] `docs/PROTOCOL.md` updated with Rust agent notes (if any deviations)
- [ ] TODO.md updated
