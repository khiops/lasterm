---
doc-meta:
  status: canonical
  adversarial_applied: true
  scope: hub, agent, shared
  type: specification
  target_project: /mnt/wsl/shared/dev/lasterm
  created: 2026-03-21
  updated: 2026-03-21
  complexity: COMPLEX
  time-budget: 175min
---

# Specification: Unified Logging + Windows Daemon Mode

## 0. Quick Reference

| Item | Value |
|------|-------|
| Scope | hub, agent (Rust), shared |
| Complexity | COMPLEX |
| Time budget | ~175 min |
| Blocks | 8 |
| BDD scenarios | 21 |
| Risk level | MEDIUM |
| Adversarial | 5 perspectives, 14 challenges, 10 spec changes |

## 1. Problem Statement

The hub and agent produce diagnostic output (console.log, tracing) that is lost when running as a daemon or SEA binary. There is no structured logging that correlates with terminal sessions. Additionally, the Rust agent's daemon mode (PTY persistence across hub restarts) only works on Unix (UDS) — Windows users cannot benefit from session survival.

## 2. User Stories

### US-1: Structured per-terminal logs
AS A lasterm operator
I WANT diagnostic logs stored per terminal tab in structured files
SO THAT I can troubleshoot a specific terminal session without correlating multiple log sources

ACCEPTANCE: Each channel (terminal tab) has a JSONL log file with hub + agent events merged chronologically.

### US-2: Configurable logging
AS A lasterm administrator
I WANT to configure log level, line format, output target, and retention
SO THAT I can balance diagnostic detail vs disk usage

ACCEPTANCE: `[logging]` section in config.toml controls level, format, output, and max_age_days for both hub and agent logging.

### US-3: Windows daemon mode
AS A Windows user
I WANT the agent to run in daemon mode (named pipes)
SO THAT my terminal sessions survive hub restarts and client disconnects

ACCEPTANCE: `lasterm-agent --daemon` works on Windows with named pipes, same connection displacement behavior as Unix UDS.

## 3. Business Rules

### 3.1 Invariants
- INV-01: A channel log file is created when a channel is spawned, closed when the channel exits
- INV-02: Log entries within a channel file are strictly chronologically ordered
- INV-03: The `t` field (offset ms) is monotonically increasing within a file
- INV-04: Agent stderr is process-global — lines that cannot be attributed to a specific channel go to hub.jsonl with session/host context (`"src":"agent"`)
- INV-05: Hub events are attributed with `"src":"hub"` in the channel log
- INV-05b: Only channel-specific hub events (SPAWN, OUTPUT stats, EXIT) go to channel log. Agent stderr goes to hub.jsonl unless the agent is single-channel (stdio mode → attribute to the sole channel)
- INV-06: hub.jsonl uses ISO 8601 timestamps (no channel context for relative offset) and is always JSONL. `[logging].format` only controls the hub stderr/console rendering: `jsonl` emits JSON objects, `text` emits single-line human-readable records.
- INV-07: Named pipe path on Windows includes the current username for isolation
- INV-08: First entry in a channel log contains the absolute creation timestamp (ISO 8601) so offset `t` can be resolved to wall-clock time. On reattach (daemon mode), read the first line to recover `created_at` for offset computation.
- INV-09: Log files are created with mode 0o600 (owner read/write only); on Windows, inherit parent directory ACL
- INV-10: Agent stderr entries always get `"src":"agent"` set by the hub — never parsed from agent output (prevents log injection)
- INV-11: HubLogger serializes writes (single writer task or mutex) to prevent interleaved JSON lines

### 3.2 Preconditions
- PRE-01: State directory exists and is writable (`getStateDir()`)
- PRE-02: Config is loaded before loggers are initialized
- PRE-03: On Windows, named pipe path must be <= 256 chars
- PRE-04: GC runs AFTER daemon reattach (active channel set must be built first)

### 3.3 Effects
- EFF-01: `logs/channels/<channel_id>.jsonl` created per channel in state dir
- EFF-02: `logs/hub.jsonl` created for global hub events in state dir
- EFF-03: Files older than `max_age_days` deleted at hub startup
- EFF-04: On Windows, `lasterm-agent --daemon` listens on `\\.\pipe\lasterm-agent-<username>`
- EFF-05: When hub reattaches to a daemon agent channel, it reopens the existing channel log in append mode with a "hub reconnected" entry
- EFF-06: hub.jsonl > 10MB at startup → rename to hub.jsonl.old and start fresh

### 3.4 Error Handling
- ERR-01: When log directory is not writable → log warning to stderr, continue without file logging
- ERR-02: When GC fails to delete a file → log warning, skip file, continue
- ERR-03: When named pipe is already in use → retry with displacement (same as Unix UDS behavior)
- ERR-04: When agent stderr contains non-UTF8 → replace invalid bytes, log as-is
- ERR-05: When GC encounters a channel log for a still-active channel → skip (do not delete)

## 4. Technical Design

### 4.1 Architecture

```
Hub Process
├── HubLogger → logs/hub.jsonl (always JSONL, ISO 8601, global events)
├── optional hub stderr stream using [logging].level + [logging].format
├── ChannelLogger registry (Map<channelId, ChannelLogger>)
│   ├── ChannelLogger A → logs/channels/01KM8BH4.jsonl
│   │   ├── hub events (src: "hub")
│   │   └── agent stderr (src: "agent", parsed from stderr pipe)
│   └── ChannelLogger B → logs/channels/01KM8BH5.jsonl
└── LogGC → delete files > max_age_days at startup

Agent (Rust)
├── stdio mode → tracing to stderr using [logging].level + [logging].format
└── daemon mode → tracing to logs/agent-daemon.jsonl using [logging].level + [logging].format
    ├── Unix: UDS (unchanged)
    └── Windows: Named Pipe (NEW)
```

### 4.2 Log Entry Format

**Channel log (JSONL, offset relative):**
```jsonl
{"t":0,"src":"hub","lvl":"info","msg":"channel created","shell":"bash","host":"prod-web","created_at":"2026-03-21T14:07:04.876Z"}
{"t":12,"src":"agent","lvl":"info","msg":"SPAWN_OK","pid":42}
{"t":1045,"src":"agent","lvl":"debug","msg":"output 4096 bytes"}
{"t":5230,"src":"hub","lvl":"info","msg":"client disconnected"}
{"t":5231,"src":"hub","lvl":"info","msg":"channel exit","code":0}
```

Fields: `t` (u64, ms offset), `src` ("hub"|"agent"), `lvl` (trace/debug/info/warn/error), `msg` (string), plus optional context fields.

**Hub global file log (always JSONL, ISO 8601):**
```jsonl
{"ts":"2026-03-21T14:07:04.876Z","lvl":"info","msg":"hub started","port":4100}
{"ts":"2026-03-21T14:07:05.012Z","lvl":"info","msg":"client paired","client_id":"abc"}
```

**Hub stderr or agent text stream (`format="text"`, ISO 8601):**
```text
2026-03-21T14:07:04.876Z INFO hub started port=4100
2026-03-21T14:07:05.012Z WARN agent reconnect failed host=prod-web
```

### 4.3 Config Schema

```toml
[logging]
level = "info"           # trace | debug | info | warn | error
format = "jsonl"         # jsonl | text
output = "file"          # stderr | file | both
max_age_days = 30        # 0 = keep forever
max_size_mb = 50         # per-channel log file size limit (0 = unlimited)
```

Default: `level=info`, `format=jsonl`, `output=file`, `max_age_days=30`, `max_size_mb=50`.
The hub and agent both resolve `level` and `format` from this single `[logging]` contract. For the hub, `output=file` and `output=both` always write JSONL to `logs/hub.jsonl`; that file backs `/api/logs/hub` and file-tailing aggregators. `format` only changes the hub stderr/console rendering when `output=stderr` or `output=both`. The hub delivers the effective agent values when spawning local daemon agents and remote stdio agents; the agent applies `format` to its own output stream. `jsonl` is the behavior-preserving default for machine-readable logs; `text` is for human-readable single-line diagnostics.
When a channel log exceeds `max_size_mb`, the hub stops writing to it (logs a warning to hub.jsonl).

### 4.4 Data Model Changes

No DB schema changes. Log files are filesystem-only (outside SQLite).

| Path | Content | Lifecycle |
|------|---------|-----------|
| `<state>/logs/hub.jsonl` | Hub global events | Append-only, no rotation (P2) |
| `<state>/logs/channels/<ch_id>.jsonl` | Per-channel merged logs | Created at spawn, closed at exit |

### 4.5 Named Pipe Design (Windows Daemon)

| Aspect | Unix (existing) | Windows (new) |
|--------|----------------|---------------|
| Transport | `UnixListener` | `NamedPipeServer` (tokio) |
| Path | `<state>/agent.socket` | `\\.\pipe\lasterm-agent-<username>` |
| Permissions | chmod 0o600 | Default (ACL hardening deferred) |
| Signals | SIGTERM/SIGINT | `tokio::signal::ctrl_c()` |
| Path limit | 100 bytes | 256 chars |

Abstract via `cfg` platform gates — no trait needed (code duplication is minimal, ~30 lines per platform).

### 4.6 I/O Strategy

- Channel loggers use `fs.createWriteStream({ flags: 'a' })` — non-blocking, buffered
- HubLogger uses a single write stream with serialized access (write queue or mutex)
- File permissions: `mode: 0o600` on creation
- On hub reattach (daemon mode): reopen existing file with `{ flags: 'a' }`
- hub.jsonl rotation: if > 10MB at startup, rename to `.old` and start fresh

### 4.7 Log Reading (Human Usage)

```bash
# Read channel log as human-readable
cat logs/channels/01KM8BH4.jsonl | jq -r '"\(.t)ms [\(.src)] \(.msg)"'
# Output: 0ms [hub] channel created
#         12ms [agent] SPAWN_OK
#         1045ms [agent] output 4096 bytes
```

## 5. Acceptance Criteria (BDD)

### Scenario Group: Channel Logging

```gherkin
@priority:high @type:nominal
Scenario: SC-01 Channel log file created on spawn
  Given the hub is running with logging output=file
  When a SPAWN message creates channel "ch-1"
  Then a file logs/channels/ch-1.jsonl exists in state dir
  And the first entry has t=0, src="hub", msg containing "channel created"

@priority:high @type:nominal
Scenario: SC-02 Agent stderr merged into channel log
  Given channel "ch-1" is active with a local agent
  When the agent writes "info: SPAWN_OK pid=42" to stderr
  Then a log entry appears in ch-1.jsonl with src="agent"

@priority:high @type:nominal
Scenario: SC-03 Offset timestamps are monotonically increasing
  Given channel "ch-1" has been active for 500ms
  When a new log entry is written
  Then its t field is >= 500

@priority:medium @type:edge
Scenario: SC-04 Channel log closed on channel exit
  Given channel "ch-1" is active
  When the channel exits with code 0
  Then a final entry with msg "channel exit" is written
  And the file handle is closed

@priority:medium @type:edge
Scenario: SC-05 Non-UTF8 agent stderr
  Given the agent writes binary data to stderr
  When the hub captures it
  Then invalid bytes are replaced with U+FFFD
  And the entry is written without error
```

### Scenario Group: Hub Global Logging

```gherkin
@priority:high @type:nominal
Scenario: SC-06 Hub startup logged
  Given logging output=file
  When the hub starts
  Then logs/hub.jsonl contains an entry with msg="hub started"
  And the entry has an ISO 8601 ts field

@priority:medium @type:nominal
Scenario: SC-07 Auth events logged
  Given logging output=file
  When a new client pairs via auth token
  Then hub.jsonl contains an entry with msg="client paired"
```

### Scenario Group: Configuration

```gherkin
@priority:high @type:nominal
Scenario: SC-08 Config [logging] section parsed
  Given config.toml contains [logging] with level="debug" and format="text"
  When the hub loads config
  Then the logging level is set to debug
  And the logging format is set to text

@priority:medium @type:edge
Scenario: SC-09 Missing [logging] section uses defaults
  Given config.toml has no [logging] section
  When the hub loads config
  Then logging defaults to level=info, format=jsonl, output=file, max_age_days=30

@priority:medium @type:nominal
Scenario: SC-10 GC deletes old log files
  Given max_age_days=7
  And a channel log file is 10 days old
  When the hub starts
  Then that file is deleted
  And files <= 7 days old are kept
```

### Scenario Group: Windows Daemon

```gherkin
@priority:high @type:nominal
Scenario: SC-11 Agent starts daemon on Windows via named pipe
  Given the platform is Windows
  When lasterm-agent --daemon is executed
  Then a named pipe \\.\pipe\lasterm-agent-<username> is created
  And the agent accepts connections

@priority:high @type:nominal
Scenario: SC-12 Hub connects to Windows daemon agent
  Given the agent is running in daemon mode on Windows
  When the hub opens the named pipe
  Then HELLO handshake completes
  And SPAWN/OUTPUT messages flow correctly

@priority:high @type:nominal
Scenario: SC-13 Connection displacement on Windows
  Given hub-A is connected to the daemon agent on Windows
  When hub-B connects to the same named pipe
  Then hub-A is displaced
  And hub-B receives the active state

@priority:medium @type:nominal
Scenario: SC-14 CtrlC graceful shutdown on Windows
  Given the agent is running in daemon mode on Windows
  When CtrlC is pressed
  Then all channels are cleaned up
  And the named pipe is closed

@priority:medium @type:edge
Scenario: SC-15 Daemon mode file logging fallback
  Given the agent runs in daemon mode (no hub capturing stderr)
  When the agent produces log output
  Then logs are written to logs/agent-daemon.jsonl in state dir
```

### Scenario Group: Error Handling

```gherkin
@priority:medium @type:error
Scenario: SC-16 Log directory not writable
  Given the state dir logs/ subdirectory is not writable
  When the hub tries to create a channel logger
  Then a warning is logged to stderr
  And the hub continues operating without file logging

@priority:medium @type:error
Scenario: SC-17 GC skips active channel log files
  Given max_age_days=1
  And channel "ch-old" was created 3 days ago but is still active (daemon mode)
  When GC runs at hub startup
  Then ch-old.jsonl is NOT deleted
  And only truly inactive old files are removed
```

**Coverage matrix:**

| Scenario | Nominal | Edge | Error | Security |
|----------|---------|------|-------|----------|
| SC-01 | ✓ | | | |
| SC-02 | ✓ | | | |
| SC-03 | ✓ | | | |
| SC-04 | | ✓ | | |
| SC-05 | | ✓ | | |
| SC-06 | ✓ | | | |
| SC-07 | ✓ | | | |
| SC-08 | ✓ | | | |
| SC-09 | | ✓ | | |
| SC-10 | ✓ | | | |
| SC-11 | ✓ | | | |
| SC-12 | ✓ | | | |
| SC-13 | ✓ | | | |
| SC-14 | ✓ | | | |
| SC-15 | | ✓ | | |
| SC-16 | | | ✓ | |
| SC-17 | | | ✓ | |

### Scenario Group: LOG Protocol + Search API

```gherkin
@priority:high @type:nominal
Scenario: SC-18 Agent sends LOG message in daemon mode
  Given the agent runs in daemon mode with a hub connected
  When the agent produces a channel-specific diagnostic
  Then it sends a LOG message with channel_id, level, and msg
  And the hub writes it to the corresponding channel log with src="agent"

@priority:high @type:nominal
Scenario: SC-19 Named pipe ACL restricts to current user
  Given the agent runs in daemon mode on Windows
  When another user's process tries to connect to the pipe
  Then the connection is rejected

@priority:high @type:nominal
Scenario: SC-20 Auth token required on daemon connection
  Given the agent runs in daemon mode
  When a client connects without sending a valid AUTH token
  Then the connection is rejected after timeout

@priority:medium @type:nominal
Scenario: SC-21 Log search API returns filtered entries
  Given channel "ch-1" has 100 log entries at various levels
  When GET /api/logs/channels/ch-1?level=error is called
  Then only error-level entries are returned
```

| SC-18 | ✓ | | | |
| SC-19 | | | | ✓ |
| SC-20 | | | | ✓ |
| SC-21 | ✓ | | | |

## 6. Implementation Plan

### Block 1: Shared types + config (~15 min)
**Type:** Foundation
**Dependencies:** None
**Packages:** shared, hub
**Files:**
- `packages/shared/src/entities.ts` — `LogConfig`, `LogEntry`, `HubLogEntry` interfaces
- `packages/shared/src/protocol.ts` — `AgentLogMessage` type (LOG protocol message)
- `packages/hub/src/config.ts` — parse `[logging]` section (level, format, output, max_age_days, max_size_mb)

**Exit criteria:**
- [ ] Types exported from shared
- [ ] Config parser reads `[logging]` with defaults (SC-08, SC-09)
- [ ] Unit test: config with/without [logging]

### Block 2: Hub loggers + lazy handles + rotation (~25 min)
**Type:** Feature slice
**Dependencies:** Block 1
**Packages:** hub
**Files:**
- `packages/hub/src/logging/channel-logger.ts` — per-channel JSONL (offset `t`, lazy open/close, max_size_mb)
- `packages/hub/src/logging/hub-logger.ts` — global JSONL (ISO 8601, runtime rotation >10MB)
- `packages/hub/src/logging/log-gc.ts` — GC (delete old, skip active channels, runs after reattach)
- `packages/hub/src/logging/index.ts` — barrel + LoggerRegistry (Map<channelId, ChannelLogger>)

**Exit criteria:**
- [ ] ChannelLogger: JSONL with offset `t`, first entry has `created_at` (SC-01, SC-03)
- [ ] ChannelLogger: lazy open/close (no persistent file handles)
- [ ] ChannelLogger: stops writing when > max_size_mb
- [ ] HubLogger: runtime rotation when > 10MB
- [ ] GC: deletes old files, skips active channels (SC-10, SC-17)
- [ ] File permissions 0o600
- [ ] Unit tests for all components

### Block 3: Hub integration — stderr + lifecycle + LOG handling (~20 min)
**Type:** Feature slice
**Dependencies:** Block 2
**Packages:** hub
**Files:**
- `packages/hub/src/session/local-agent.ts` — stderr → hub.jsonl (multi-channel) or channel log (single-channel stdio)
- `packages/hub/src/session/ssh-agent.ts` — capture `stream.stderr`, forward to logger
- `packages/hub/src/session/channel-lifecycle-manager.ts` — create/close logger on spawn/exit
- `packages/hub/src/session/session-manager.ts` — inject LoggerRegistry, handle LOG protocol message
- `packages/hub/src/main.ts` — initialize HubLogger + GC at startup

**Exit criteria:**
- [ ] Stderr routed correctly: hub.jsonl (multi-ch) or channel log (single-ch) (SC-02)
- [ ] LOG protocol messages from agent → channel log with src="agent" (SC-18)
- [ ] Channel log closed on exit (SC-04)
- [ ] Hub startup event in hub.jsonl (SC-06)
- [ ] Integration test: spawn channel, verify log entries

### Block 4: Agent LOG protocol message (~15 min)
**Type:** Feature slice
**Dependencies:** None (independent of blocks 1-3)
**Packages:** agent (Rust)
**Files:**
- `crates/lasterm-agent/src/protocol.rs` — add `Log` variant to `AgentToHub`
- `crates/lasterm-agent/src/handler.rs` — send LOG messages for key events (spawn, exit, errors)
- `crates/lasterm-agent/src/main.rs` — daemon mode file fallback when no hub connected

**Exit criteria:**
- [ ] Agent sends LOG messages with channel_id, level, msg (SC-18)
- [ ] Daemon mode without hub: logs to file fallback (SC-15)
- [ ] Unit test: LOG message serialization

### Block 5: Windows named pipe transport (~25 min)
**Type:** Feature slice
**Dependencies:** Block 4
**Packages:** agent (Rust)
**Files:**
- `crates/lasterm-agent/src/daemon.rs` — `#[cfg(windows)]` named pipe listener + accept loop
- `crates/lasterm-agent/src/main.rs` — remove `#[cfg(not(unix))]` error, cross-platform signals
- `crates/lasterm-agent/Cargo.toml` — tokio `net` feature for named pipe

**Exit criteria:**
- [ ] `lasterm-agent --daemon` works on Windows (SC-11)
- [ ] Named pipe at `\\.\pipe\lasterm-agent-<username>` (SC-11)
- [ ] Connection displacement works (SC-13)
- [ ] CtrlC graceful shutdown (SC-14)
- [ ] Integration tests on Windows

### Block 6: Named pipe ACL + auth token (~20 min)
**Type:** Security hardening
**Dependencies:** Block 5
**Packages:** agent (Rust), shared
**Files:**
- `crates/lasterm-agent/src/daemon.rs` — `SecurityDescriptor` restrict to current user SID
- `crates/lasterm-agent/src/daemon.rs` — AUTH handshake on pipe/UDS connection (token from hub)
- `crates/lasterm-agent/Cargo.toml` — windows-sys features for security APIs

**Exit criteria:**
- [ ] Named pipe restricted to current user SID (SC-19)
- [ ] Connection without valid auth token rejected (SC-20)
- [ ] Auth token mechanism works on both UDS and named pipe
- [ ] Integration tests: unauthorized connection rejected

### Block 7: Log search API (~15 min)
**Type:** Feature slice
**Dependencies:** Block 2
**Packages:** hub
**Files:**
- `packages/hub/src/api/logs.ts` — GET /api/logs/channels/:channelId, GET /api/logs/hub
- `packages/hub/src/api/logs.ts` — query params: level, from_t, to_t, search, limit
- `packages/hub/src/server.ts` — register log routes

**Exit criteria:**
- [ ] GET /api/logs/channels/:id returns filtered JSONL entries (SC-21)
- [ ] GET /api/logs/hub returns filtered hub log entries
- [ ] Query params: level, from_t, to_t, search (text), limit
- [ ] Unit tests for filtering logic

### Block 8: Log search UI (~20 min)
**Type:** Feature slice
**Dependencies:** Block 7
**Packages:** web
**Files:**
- `packages/clients/web/src/components/LogViewer.vue` — log panel component
- `packages/clients/web/src/composables/useLogs.ts` — API client composable
- `packages/clients/web/src/views/` — integrate into settings or channel context menu

**Exit criteria:**
- [ ] LogViewer shows entries with level/source filters
- [ ] Filter by channel, level, search text
- [ ] Lazy load / virtual scroll for large logs
- [ ] Basic styling consistent with app theme

## 7. Test Strategy

### Test pyramid

| Level | Count | Focus |
|-------|-------|-------|
| Unit | 14 | Config, logger format, GC, path resolution, API filtering, LOG serialization |
| Integration | 6 | Channel lifecycle + logging, daemon named pipe, auth handshake |
| E2E (Windows) | 4 | Named pipe spawn, displacement, ACL rejection, CtrlC |

### Test data requirements
- Fixtures: sample config.toml with/without [logging]
- Mocks: filesystem (vitest `vi.mock("fs")` for GC tests)
- Real: in-memory SQLite for hub integration tests
- Windows: real named pipe for daemon tests (`#[cfg(windows)]`)

## 8. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Named pipe API differences from UDS | M | M | Platform-gated code, not trait abstraction |
| Log file accumulation (hub.jsonl) | L | M | Runtime rotation >10MB |
| Agent stderr format unpredictable | L | M | Pass through as-is, hub sets src field (INV-10) |
| tokio named pipe availability | L | L | Stable since tokio 1.x, well-documented |
| Named pipe security | H | M | ACL (SID) + auth token (defense in depth) |
| Daemon reattach: channel log continuity | M | M | Read first line created_at for offset recovery |
| File handle exhaustion (100+ channels) | L | L | Lazy open/close (no persistent handles) |
| Windows SecurityDescriptor API complexity | M | M | windows-sys crate, well-documented pattern |

## 9. Definition of Done

- [ ] All 8 blocks implemented
- [ ] All 21 BDD scenarios have passing tests
- [ ] All tests pass (unit + integration + Windows E2E)
- [ ] Lint/typecheck pass (`pnpm lint`, `cargo clippy`)
- [ ] Config documented in docs/CONFIG_REFERENCE.md
- [ ] TODO.md updated
- [ ] /review clean (no blocking findings)
