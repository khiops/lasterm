---
doc-meta:
  status: canonical
  adversarial_applied: true
  scope: agent, hub, shared
  type: specification
  target_project: /mnt/wsl/shared/dev/lasterm
  created: 2026-03-06
  updated: 2026-03-06
  complexity: COMPLEX
  time-budget: 2h30
---

# Specification: Standalone Agent Daemon with UDS/Named Pipe Transport

## 0. Quick Reference

| Item | Value |
|------|-------|
| Scope | agent, hub, shared |
| Complexity | COMPLEX |
| Time budget | ~2h30 |
| Blocks | 7 |
| BDD scenarios | 21 |
| Risk level | MEDIUM |
| Hardening | Security review: 5/5 scenarios, 2 LLM audits |

## 1. Problem Statement

The local agent currently runs as a child process of the hub (`child_process.spawn` with stdio pipes). When the hub restarts (code changes during development, crash, manual restart), the child process is killed, destroying all local PTYs. Users lose long-running tasks (builds, SSH sessions) on every hub restart — this is unacceptable for a local-first terminal platform.

The agent must run as an independent daemon communicating over a Unix domain socket (UDS) or Windows named pipe, so local PTYs survive hub restarts indefinitely.

## 2. User Stories

### US-1: PTY Survival
AS A developer running long-running tasks in lasterm
I WANT my local terminals to survive hub restarts
SO THAT I never lose work when the hub is restarted or crashes

ACCEPTANCE: After hub restart, all local channels reconnect automatically with full scrollback preserved.

### US-2: Transparent Agent Management
AS A lasterm user
I WANT the hub to auto-start the agent daemon if it's not running
SO THAT I don't have to manually manage the agent lifecycle

ACCEPTANCE: First launch of hub with no agent running results in agent being spawned as a detached daemon; subsequent hub launches reuse the existing agent.

### US-3: Cross-Platform Transport
AS A developer on Windows or Linux
I WANT the same agent daemon architecture to work on both platforms
SO THAT the experience is consistent regardless of OS

ACCEPTANCE: Agent listens on UDS (Linux/macOS) or named pipe (Windows); hub connects using the same client code.

## 3. Business Rules

### 3.1 Invariants (always true)

- INV-01: The agent process MUST be independent of the hub process (no parent-child relationship in daemon mode).
- INV-02: All PTY channels MUST survive hub process termination.
- INV-03: MessagePack framing protocol (4-byte LE uint32 length + payload) MUST be identical over socket and stdio.
- INV-04: Only ONE agent daemon instance per socket path at any time.
- INV-05: The hub MUST be able to reconnect to an existing agent and receive HELLO + channel state.
- INV-06: Output buffers MUST be in-memory only, never persisted to disk. Discarded on agent shutdown.
- INV-07: On reconnect, agent MUST send ALL CHANNEL_STATE messages before flushing any buffered output.
- INV-08: Agent MUST send a `CHANNEL_STATE_END` sentinel after all CHANNEL_STATE messages (hub knows enumeration is complete).
- INV-09: HELLO message MUST include a `protocolVersion` field. Hub rejects incompatible versions.
- INV-10: Total output buffer across all channels MUST NOT exceed global cap (default 20 MB, configurable). Individual channels capped at per-channel limit (default 1 MB, configurable).
- INV-11: Agent daemon MUST log to `<stateDir>/agent.log` — no stdout/stderr when detached.

### 3.2 Preconditions (required before action)

- PRE-01: Before spawning a daemon agent, the hub MUST probe the socket path to check if an agent is already running.
- PRE-02: Before connecting, the socket file (UDS) or pipe name (Windows) must exist and accept connections.
- PRE-03: The agent's runtime directory (`$XDG_RUNTIME_DIR/lasterm/` or equivalent) must be created with `0700` permissions.

### 3.3 Effects (what changes)

- EFF-01: New `LastermAgent` class replaces `AgentConnection` abstract + `LocalAgent`. Single concrete class that accepts any `Duplex` stream. Factory methods for transport variants.
- EFF-02: Agent entry point (`main.ts`) gains `--daemon` mode: listens on a socket, stays alive indefinitely.
- EFF-03: Hub startup sequence: probe socket → if alive, connect → if dead/absent, spawn detached agent, wait for socket, connect.
- EFF-04: On hub disconnect, agent keeps all PTYs alive and buffers output (up to configurable limit).
- EFF-05: On hub reconnect, agent sends HELLO followed by channel state (alive channels + buffered output since disconnect).
- EFF-06: New `[agent]` section in `config.toml` for buffer caps, socket path override, log level.

### 3.4 Error Handling

- ERR-01: When socket probe fails with ECONNREFUSED → stale socket file → unlink and spawn new agent.
- ERR-01b: When socket probe fails with EACCES → permission error → do NOT unlink, throw error (different user's socket).
- ERR-01c: When agent spawn gets EADDRINUSE → another agent just started → retry connect with randomized backoff (100-500ms).
- ERR-02: When agent spawn fails → log error, mark session as "error", surface to UI.
- ERR-03: When hub disconnects unexpectedly → agent continues, buffers output (per-channel cap, global cap).
- ERR-03b: When agent binary path is invalid or binary doesn't exist → hub logs error, marks session as "error" (no spawn attempt).
- ERR-04: When agent detects hub reconnect → flush buffered output via backpressure-aware SendQueue, resume streaming.
- ERR-05: When socket path directory doesn't exist → create with `0700` permissions.
- ERR-06: When agent receives SIGTERM → graceful shutdown: close all PTYs, remove socket file, exit.
- ERR-07: When agent receives SIGINT → same as SIGTERM (graceful shutdown).

## 4. Technical Design

### 4.1 Architecture Decision

**Socket transport via Node.js `net` module.** The `net` module natively abstracts Unix domain sockets (Linux/macOS) and named pipes (Windows) behind the same `net.createServer()` / `net.connect()` API. No external dependencies needed.

**Agent as detached process** spawned via `child_process.spawn` with `{ detached: true, stdio: 'ignore' }` and `unref()`. The agent writes its PID to the socket directory for diagnostics (not for discovery — socket probing is the canonical liveness check).

**Single agent class: `LastermAgent`.** Replaces the `AgentConnection` abstract class and `LocalAgent`/`DaemonAgent` hierarchy. `LastermAgent` accepts any `Duplex` stream — the transport concern is separated into factory methods:

```typescript
class LastermAgent extends EventEmitter {
  constructor(stream: Duplex)

  static connectLocal(socketPath: string): Promise<LastermAgent>
  // Phase 2: static connectTunnel(sshChannel: Channel): LastermAgent
}
```

This design means:
- No abstract class needed (one concrete implementation)
- Transport flexibility via factory methods (Open/Closed principle)
- Phase 2 (SSH tunnel) adds `connectTunnel()` without touching existing code
- `LocalAgent` and `SshAgent` remain untouched for `--stdio` mode (SshAgent uses it until Phase 2)

**Connection displacement:** Agent accepts one hub connection at a time. When a new connection arrives, the previous connection is closed (last-writer-wins).

**Warm restart vs reconnect distinction:**
- **Warm restart**: Agent process died → hub spawns new agent → sends SPAWN with channelId for orphaned channels (respawns PTYs).
- **Reconnect**: Hub process died → hub connects to running agent → receives CHANNEL_STATE (PTYs already alive, no respawn needed).

### 4.2 Socket Path Convention

| Platform | Path |
|----------|------|
| Linux/macOS | `$XDG_RUNTIME_DIR/lasterm/agent.sock` (fallback: `/tmp/lasterm-$UID/agent.sock`) |
| Windows | `\\.\pipe\lasterm-agent-<username>` |

Both paths are per-user by construction:
- Linux: `$XDG_RUNTIME_DIR` = `/run/user/<UID>/` (per-user), fallback includes `$UID`
- Windows: named pipe includes `<username>` for multi-user isolation

The path is computed by a shared `getSocketPath()` function in `@lasterm/shared` so both hub and agent agree. It can be overridden via `config.toml` `[agent].socket_path`.

### 4.3 Agent Configuration

New `[agent]` section in `config.toml`:

```toml
[agent]
# Socket path override (empty = auto-detect per platform)
socket_path = ""
# Per-channel output buffer cap
buffer_per_channel = "1MB"
# Global output buffer cap across all channels
buffer_global = "20MB"
# Log level for agent daemon
log_level = "info"
```

The hub reads `config.toml` and passes relevant config to the agent at spawn via CLI flags:
`lasterm-agent --daemon --socket <path> --buffer-per-channel 1048576 --buffer-global 20971520`

The agent also reads `config.toml` directly (shared `getConfigDir()`) as a fallback when CLI flags are not provided (e.g., manually started daemon).

### 4.4 Data Model Changes

| Entity | Change | Migration needed |
|--------|--------|-----------------|
| Agent entry point | Add `--daemon` flag + config flags | No |
| `AgentConnection` abstract | Replaced by `LastermAgent` concrete class | No |
| New `LastermAgent` class | `Duplex` stream + factory methods | No (runtime only) |
| `LocalAgent` | Unchanged — used by SshAgent until Phase 2 | No |
| `SshAgent` | Unchanged — uses --stdio until Phase 2 | No |
| Agent `main.ts` | Add socket server mode alongside stdio mode | No |
| `@lasterm/shared` | Add `getSocketPath()`, `probeSocket()` | No |
| `config.toml` | Add `[agent]` section | No (additive) |

### 4.5 Agent Daemon Lifecycle

```
Hub startup:
  1. getSocketPath() (from config or auto-detect)
  2. probeSocket(path)  →  success? → LastermAgent.connectLocal(path) → HELLO (check protocolVersion) → done
                         →  ECONNREFUSED? → unlink(path) → goto 3
                         →  ENOENT? → goto 3
                         →  EACCES? → throw (permission denied, different user)
  3. spawnDaemon(agentBinaryPath, socketPath, config)
     →  EADDRINUSE? → wait 100-500ms random backoff → retry probeSocket
  4. waitForSocket(path, timeout=5s, poll=100ms)
  5. LastermAgent.connectLocal(path) → HELLO exchange → done

Hub shutdown:
  - Close socket connection (agent keeps running)

Agent daemon startup (--daemon):
  1. Ensure runtime dir exists (mkdir -p, 0700)
  2. Redirect stdout/stderr to <stateDir>/agent.log (append mode)
  3. Read config (CLI flags > config.toml > defaults)
  4. net.createServer() → listen(socketPath)
  5. On connection: close previous connection if any, FrameReader + SendQueue
  6. Send HELLO (with protocolVersion) on each new connection
  7. Send CHANNEL_STATE per alive channel + CHANNEL_STATE_END

Agent daemon shutdown (SIGTERM/SIGINT):
  1. Close all PTYs gracefully
  2. Close server socket
  3. Unlink socket file
  4. Exit 0
```

### 4.6 Reconnection Protocol

When hub reconnects to a running agent:

1. Hub connects to socket via `LastermAgent.connectLocal(path)`.
2. Agent sends HELLO (protocolVersion, capabilities, platform info). Hub checks protocolVersion compatibility.
3. Agent sends CHANNEL_STATE for each alive channel: `{ channelId, title, pid, alive }`.
4. Agent sends CHANNEL_STATE_END sentinel: `{ type: "channel_state_end" }`. Hub now knows enumeration is complete.
5. Hub reconciles: channels in CHANNEL_STATE → mark active. Channels in meta.db but NOT in agent's list → mark dead/orphaned.
6. Agent flushes buffered output per channel as OUTPUT messages (through SendQueue for backpressure).
7. Normal streaming resumes.

### 4.7 Output Buffering (Agent-Side)

When the hub is disconnected, the agent buffers PTY output per channel:

- **Per-channel cap**: configurable (default 1 MB). Ring buffer — drop oldest bytes when cap reached.
- **Global cap**: configurable (default 20 MB) across all channels. When exceeded, evict from the channel with the largest buffer.
- **On reconnect**: Buffered output is flushed as regular OUTPUT messages through SendQueue (backpressure-aware) before resuming live streaming.
- **Implementation**: `Map<channelId, Buffer[]>` with per-channel byte counter + global counter.
- **Security**: Buffers are in-memory only, never written to disk. Discarded on agent shutdown.

### 4.8 API Contract

No new REST endpoints. Changes are internal (agent ↔ hub transport).

New shared exports from `@lasterm/shared`:

| Export | Signature | Purpose |
|--------|-----------|---------|
| `getSocketPath()` | `() => string` | Compute platform-appropriate socket path (per-user) |
| `probeSocket(path)` | `(path: string) => Promise<boolean>` | Check if agent is listening |
| `AGENT_SOCKET_TIMEOUT` | `number` (5000) | Max wait for agent to start listening |

HELLO message extended field:

| Field | Type | Purpose |
|-------|------|---------|
| `protocolVersion` | `number` | Protocol version (starts at 1). Hub rejects if incompatible. |

New message types in protocol:

| Type | Direction | Fields |
|------|-----------|--------|
| `CHANNEL_STATE` | agent → hub | `channelId: string, title: string, pid: number, alive: boolean` |
| `CHANNEL_STATE_END` | agent → hub | (no fields) — sentinel marking end of channel enumeration |

## 5. Acceptance Criteria (BDD)

### Scenario Group: Agent Daemon Lifecycle

```gherkin
@priority:high @type:nominal
Scenario: SC-01 Agent starts as daemon and listens on socket
  Given no agent is running
  When the agent binary is launched with --daemon flag
  Then it creates the runtime directory with 0700 permissions
  And it listens on the platform-appropriate socket path
  And it logs to <stateDir>/agent.log

@priority:high @type:nominal
Scenario: SC-02 Hub connects to running agent via LastermAgent
  Given the agent daemon is listening on the socket
  When the hub calls LastermAgent.connectLocal(socketPath)
  Then the connection succeeds
  And the agent sends a HELLO message with protocolVersion

@priority:high @type:nominal
Scenario: SC-03 Hub auto-starts agent when not running
  Given no agent daemon is running
  And no socket file exists
  When the hub starts
  Then the hub spawns the agent as a detached process
  And waits for the socket to become available (max 5s)
  And connects via LastermAgent.connectLocal()
  And receives HELLO

@priority:high @type:nominal
Scenario: SC-04 PTYs survive hub restart
  Given the agent daemon is running with 2 active channels
  When the hub process is terminated
  And a new hub process starts
  Then the hub connects to the existing agent
  And the agent sends CHANNEL_STATE for both channels
  And sends CHANNEL_STATE_END
  And both channels are alive with preserved PIDs

@priority:high @type:edge
Scenario: SC-05 Stale socket file is cleaned up
  Given a socket file exists but no agent is listening (stale)
  When the hub probes the socket
  Then the probe fails with ECONNREFUSED
  And the hub unlinks the stale socket file
  And spawns a new agent daemon

@priority:high @type:edge
Scenario: SC-06 Agent handles hub disconnect gracefully
  Given the agent is connected to the hub with 1 active channel
  And the channel is producing output
  When the hub disconnects (socket closes)
  Then the agent continues running
  And the channel PTY continues running
  And output is buffered in memory

@priority:medium @type:nominal
Scenario: SC-07 Buffered output is flushed on reconnect
  Given the agent buffered output while hub was disconnected
  When the hub reconnects
  Then the agent sends HELLO
  And sends CHANNEL_STATE for alive channels + CHANNEL_STATE_END
  And flushes all buffered output as OUTPUT messages
  And resumes live streaming
```

### Scenario Group: Cross-Platform Transport

```gherkin
@priority:high @type:nominal
Scenario: SC-08 Socket path follows platform convention (Linux)
  Given the platform is Linux with XDG_RUNTIME_DIR set
  When getSocketPath() is called
  Then it returns "$XDG_RUNTIME_DIR/lasterm/agent.sock"

@priority:high @type:nominal
Scenario: SC-09 Named pipe path on Windows includes username
  Given the platform is Windows
  And the current username is "alice"
  When getSocketPath() is called
  Then it returns "\\.\pipe\lasterm-agent-alice"

@priority:medium @type:edge
Scenario: SC-10 Fallback when XDG_RUNTIME_DIR is unset
  Given the platform is Linux
  And XDG_RUNTIME_DIR is not set
  When getSocketPath() is called
  Then it returns "/tmp/lasterm-<UID>/agent.sock"

@priority:medium @type:nominal
Scenario: SC-11 Socket path overridden via config
  Given config.toml has [agent] socket_path = "/custom/path.sock"
  When getSocketPath() is called with config
  Then it returns "/custom/path.sock"
```

### Scenario Group: Error Handling

```gherkin
@priority:high @type:error
Scenario: SC-12 Agent spawn timeout
  Given the hub spawns a new agent daemon
  When the socket does not become available within 5 seconds
  Then the hub logs an error
  And marks the session as "error"
  And surfaces the error to the UI

@priority:medium @type:error
Scenario: SC-13 Agent crash recovery
  Given the agent daemon crashes unexpectedly
  When the hub detects socket close
  Then the hub marks the session as "disconnected"
  And attempts to spawn a new agent daemon
  And channels are marked as orphaned in meta.db

@priority:medium @type:error
Scenario: SC-14 Buffer overflow protection
  Given the agent is buffering output (hub disconnected)
  When a channel's buffer exceeds the per-channel cap
  Then the agent truncates oldest bytes from that channel's buffer
  And continues buffering new output

@priority:high @type:nominal
Scenario: SC-15 Graceful shutdown on SIGTERM
  Given the agent daemon is running with channels
  When SIGTERM is received
  Then all PTY processes are killed gracefully
  And the socket file is removed
  And the process exits with code 0

@priority:medium @type:error
Scenario: SC-16 EACCES on socket probe
  Given a socket file exists owned by a different user
  When the hub probes the socket
  Then the probe fails with EACCES
  And the hub does NOT unlink the socket
  And throws a permission error
```

### Scenario Group: Security

```gherkin
@priority:high @type:security
Scenario: SC-17 Socket file permissions
  Given the agent creates the runtime directory
  Then the directory has 0700 permissions (owner only)
  And the socket file is accessible only by the owning user

@priority:medium @type:security
Scenario: SC-18 Only one agent per socket path
  Given an agent daemon is already listening on the socket
  When a second agent attempts to listen on the same path
  Then the second agent detects EADDRINUSE
  And exits with an error message (does not kill the first)
```

### Scenario Group: Adversarial Hardening

```gherkin
@priority:medium @type:edge
Scenario: SC-19 Second hub connection displaces first
  Given the agent has an active connection from hub A
  When hub B connects to the agent socket
  Then hub A's connection is closed
  And hub B receives HELLO and CHANNEL_STATE
  And hub B becomes the active connection

@priority:medium @type:error
Scenario: SC-20 Agent binary missing at launch
  Given the agent binary path does not exist
  When the hub attempts to spawn the agent daemon
  Then the hub logs an error with the invalid path
  And marks the session as "error"
  And does not attempt to wait for socket

@priority:high @type:nominal
Scenario: SC-21 Buffered output flushed with backpressure
  Given the agent has 500KB buffered output for a channel
  When the hub reconnects
  Then the agent flushes buffered output through SendQueue
  And respects socket backpressure (drain events)
  And resumes live streaming only after flush completes
```

### Coverage Matrix

| Scenario | Nominal | Edge | Error | Security |
|----------|---------|------|-------|----------|
| SC-01 | X | | | |
| SC-02 | X | | | |
| SC-03 | X | | | |
| SC-04 | X | | | |
| SC-05 | | X | | |
| SC-06 | | X | | |
| SC-07 | X | | | |
| SC-08 | X | | | |
| SC-09 | X | | | |
| SC-10 | | X | | |
| SC-11 | X | | | |
| SC-12 | | | X | |
| SC-13 | | | X | |
| SC-14 | | | X | |
| SC-15 | X | | | |
| SC-16 | | | X | |
| SC-17 | | | | X |
| SC-18 | | | | X |
| SC-19 | | X | | |
| SC-20 | | | X | |
| SC-21 | X | | | |

## 6. Implementation Plan

### Block 1: Shared socket utilities + agent config — ~25 min
**Type:** Feature slice
**Dependencies:** None
**Packages:** shared
**Files:**
- `packages/shared/src/socket-path.ts` — `getSocketPath()`, `probeSocket()`, constants
- `packages/shared/src/socket-path.spec.ts` — unit tests
- `packages/shared/src/agent-config.ts` — `[agent]` config types + defaults + parser
- `packages/shared/src/agent-config.spec.ts` — unit tests
- `packages/shared/src/index.ts` — re-export new utilities

**What:**
- `getSocketPath(override?)`: returns platform-appropriate path (UDS with UID fallback, named pipe with username on Windows). Override from config.
- `probeSocket(path)`: attempts `net.connect()`, resolves `true` if connected (then closes), `false` on ECONNREFUSED/ENOENT, throws on EACCES
- `AGENT_SOCKET_TIMEOUT` constant (5000ms)
- `AgentConfig` type: `{ socketPath?: string, bufferPerChannel: number, bufferGlobal: number, logLevel: string }`
- `parseAgentConfig(toml)`: reads `[agent]` section with defaults

**Exit criteria:**
- [ ] `getSocketPath()` returns correct path on Linux (with and without XDG_RUNTIME_DIR)
- [ ] `getSocketPath()` returns `\\.\pipe\lasterm-agent-<username>` on Windows (mocked)
- [ ] `probeSocket()` returns true for listening socket, false for absent/stale, throws on EACCES
- [ ] `AgentConfig` parsed from TOML with defaults
- [ ] All tests pass, typecheck clean

### Block 2: Agent daemon mode (socket server + buffer) — ~30 min
**Type:** Feature slice
**Dependencies:** Block 1
**Packages:** agent, shared
**Files:**
- `packages/agent/src/main.ts` — add `--daemon` mode alongside existing `--stdio`
- `packages/agent/src/daemon.ts` — `DaemonServer` class: socket server, connection management, FrameReader
- `packages/agent/src/buffer.ts` — `OutputBuffer` class: per-channel ring buffer with global cap
- `packages/agent/src/buffer.spec.ts` — buffer unit tests
- `packages/agent/src/daemon.spec.ts` — daemon unit tests (real UDS in temp dir)

**What:**
- Agent CLI: `--daemon` (listen on socket, new), `--stdio` (stdin/stdout, unchanged)
- `DaemonServer`: `net.createServer()`, one connection at a time (new displaces old), FrameReader + SendQueue
- `OutputBuffer`: per-channel ring buffers (configurable cap) + global cap. Drop-oldest on overflow.
- On connection: close previous, send HELLO (protocolVersion), send ALL CHANNEL_STATE + END, flush buffers
- On disconnect: start buffering output per channel
- SIGTERM/SIGINT: graceful shutdown (close PTYs, unlink socket, discard buffers, exit)
- Log to `<stateDir>/agent.log` when in daemon mode

**Exit criteria:**
- [ ] Agent with `--daemon` listens on real UDS in temp dir and accepts connections
- [ ] New connection displaces previous (last-writer-wins)
- [ ] OutputBuffer respects per-channel and global caps
- [ ] Buffer flush uses SendQueue for backpressure
- [ ] Graceful shutdown removes socket file
- [ ] HELLO includes protocolVersion
- [ ] All tests pass (real UDS, no mock transport)

### Block 3: LastermAgent (hub-side unified agent class) — ~25 min
**Type:** Feature slice
**Dependencies:** Block 1, Block 2
**Packages:** hub
**Files:**
- `packages/hub/src/session/lasterm-agent.ts` — `LastermAgent` class (replaces AgentConnection abstract)
- `packages/hub/src/session/lasterm-agent.spec.ts` — unit tests (real UDS in temp dir)

**What:**
- `LastermAgent extends EventEmitter`: takes any `Duplex` stream
  - `constructor(stream: Duplex)`: attaches SendQueue + FrameReader
  - `static connectLocal(socketPath: string): Promise<LastermAgent>` — `net.connect()`, returns connected agent
  - `send(msg)`: encode + send frame
  - `close()`: close stream (agent keeps running)
  - `get connected()`: stream not destroyed
  - Events: `ready` (HELLO received), `message`, `close`, `error`
- `LocalAgent` and `SshAgent` remain untouched (used until Phase 2)

**Exit criteria:**
- [ ] LastermAgent.connectLocal() connects to a real agent daemon (temp UDS)
- [ ] Receives HELLO and emits 'ready'
- [ ] close() disconnects without killing agent
- [ ] send/receive framing works correctly
- [ ] All tests pass (real UDS)

### Block 4: Hub auto-start and reconnect logic — ~25 min
**Type:** Feature slice
**Dependencies:** Block 3
**Packages:** hub
**Files:**
- `packages/hub/src/session/agent-launcher.ts` — `connectOrLaunch()`, `launchDaemon()`, `waitForSocket()`
- `packages/hub/src/session/agent-launcher.spec.ts` — unit tests
- `packages/hub/src/session/session-manager.ts` — integrate daemon lifecycle for local hosts

**What:**
- `connectOrLaunch(socketPath, agentBinaryPath, agentConfig)`:
  0. Verify `agentBinaryPath` exists → if missing, throw with clear error
  1. `probeSocket(path)` → if alive → `LastermAgent.connectLocal(path)` → return
  2. If stale (ECONNREFUSED) → `unlink(path)`
  3. `launchDaemon(agentBinaryPath, path, config)` — `child_process.spawn` with `detached: true, stdio: 'ignore'`, `unref()`
  4. On EADDRINUSE → randomized backoff (100-500ms) → retry probeSocket
  5. `waitForSocket(path, timeout=5s, poll=100ms)` → `LastermAgent.connectLocal(path)` → return
- SessionManager: use `connectOrLaunch()` for local hosts instead of `new LocalAgent()`
- Handle reconnect: on LastermAgent 'close' event → attempt reconnect
- Handle CHANNEL_STATE + CHANNEL_STATE_END: reconcile with meta.db

**Exit criteria:**
- [ ] Hub connects to existing agent when socket is alive
- [ ] Hub spawns daemon when no agent is running
- [ ] Hub cleans stale socket and respawns
- [ ] Hub handles EADDRINUSE with backoff
- [ ] CHANNEL_STATE reconciliation marks missing channels as dead
- [ ] All tests pass

### Block 5: CHANNEL_STATE protocol messages — ~15 min
**Type:** Feature slice
**Dependencies:** Block 2, Block 3
**Packages:** shared, agent, hub
**Files:**
- `packages/shared/src/messages.ts` — add CHANNEL_STATE + CHANNEL_STATE_END message types
- `packages/shared/src/index.ts` — re-export
- `packages/agent/src/daemon.ts` — send CHANNEL_STATE on connect
- `packages/hub/src/session/lasterm-agent.ts` — handle CHANNEL_STATE
- `packages/hub/src/ws/ws-handler.ts` — minor: handle reconciled channels

**What:**
- `CHANNEL_STATE`: `{ type: "channel_state", channelId, title, pid, alive }`
- `CHANNEL_STATE_END`: `{ type: "channel_state_end" }` — sentinel
- Agent sends all CHANNEL_STATE then CHANNEL_STATE_END immediately after HELLO on each new connection
- Hub processes: channels present → mark active; channels absent from agent but in meta.db → mark dead/orphaned
- Hub notifies connected WS clients of state changes

**Exit criteria:**
- [ ] Message types defined in shared
- [ ] Agent sends complete enumeration on reconnect
- [ ] Hub reconciliation handles present + missing channels
- [ ] Existing tests still pass

### Block 6: Integration tests — ~25 min
**Type:** Integration
**Dependencies:** Block 4, Block 5
**Packages:** hub, agent
**Files:**
- `packages/hub/src/session/session-manager.spec.ts` — add daemon integration tests
- `packages/hub/src/session/session-manager.ts` — update `startup()` and `_warmRestartLocal()` for daemon path

**What:**
- Update `SessionManager.startup()`: use `connectOrLaunch()` for local hosts
- Distinguish warm restart (agent died → respawn PTYs) from reconnect (hub died → CHANNEL_STATE)
- Integration tests with **real agent daemon + real UDS** in temp dir:
  - Agent daemon starts, hub connects, creates channel
  - Hub disconnects, agent buffers output
  - Hub reconnects, receives CHANNEL_STATE + buffered output
  - Verify channel alive with preserved PID
- Existing session-manager tests continue to work (LocalAgent mocks unchanged for SshAgent paths)

**Exit criteria:**
- [ ] Integration test proves PTY survives simulated hub restart (real UDS)
- [ ] Buffered output delivered on reconnect
- [ ] CHANNEL_STATE reconciliation works end-to-end
- [ ] Full test suite passes (all packages)
- [ ] Lint + typecheck clean

### Block 7: Architecture docs update — ~15 min
**Type:** Documentation
**Dependencies:** Block 6
**Packages:** docs
**Files:**
- `docs/SPEC.md` — update architecture diagram, transport section, entity relationships, add LastermAgent
- `docs/PROTOCOL.md` — add CHANNEL_STATE + CHANNEL_STATE_END messages, protocolVersion in HELLO
- `docs/SECURITY.md` — add UDS/named pipe security model, socket permissions

**What:**
- SPEC.md: update architecture diagram (hub → UDS → agent daemon), explain LastermAgent class, config cascade with `[agent]` section
- PROTOCOL.md: document CHANNEL_STATE, CHANNEL_STATE_END, protocolVersion field in HELLO
- SECURITY.md: document socket file permissions (0700 dir), per-user isolation, Windows named pipe per-username

**Exit criteria:**
- [ ] All three docs updated and consistent with implementation
- [ ] No stale references to old LocalAgent-for-local pattern

## 7. Test Strategy

### Test Pyramid

| Level | Count | Focus |
|-------|-------|-------|
| Unit | ~18 | Socket path, probe, buffer, config parsing, LastermAgent, launcher |
| Integration | ~8 | Real agent daemon + real UDS: connect, reconnect, channel state, buffer flush |
| E2E | ~3 | Chrome DevTools: hub start → agent auto-start → create channel → hub restart → channel alive |

### Test Data Requirements

**Fixtures:**
- Real UDS sockets in temp dirs (vitest `beforeEach` creates, `afterEach` cleans)
- Real agent daemon process in integration tests

**Mocks:**
- `process.platform` + `os.userInfo()` for cross-platform getSocketPath() tests
- `child_process.spawn` for launchDaemon() unit tests only

### Platform Testing
- UDS tested natively on Linux (real sockets in temp dir)
- Named pipe path logic tested via platform mock (no Windows CI required for MVP)

## 8. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Stale socket file after agent crash | M | M | Socket probing + unlink + respawn |
| Output buffer memory pressure | M | L | Configurable per-channel + global caps |
| Race: two hubs spawn simultaneously | L | L | EADDRINUSE + randomized backoff |
| Windows named pipe multi-user | M | L | Username in pipe name + platform tests |
| Agent binary path resolution | M | M | Verify exists before spawn, clear error |
| Agent log file growth | L | L | Log rotation can be added later |

## 9. Out of Scope (deferred)

- **Phase 2: Remote agent daemon via SSH tunnel** — SshAgent uses `connectTunnel()` factory, PTYs survive SSH drops (next story)
- Agent authentication (local-only for now — directory permissions sufficient)
- Multiple simultaneous hub connections to one agent
- Agent auto-update mechanism
- Agent as system service (systemd/launchd)
- Configurable socket bind timeout (currently hardcoded 5s)
- Peer UID verification on Unix via SO_PEERCRED
- Windows named pipe ACL hardening
- Unix socket path length validation

## 10. Definition of Done

- [ ] All 7 blocks implemented
- [ ] All 21 BDD scenarios have passing tests
- [ ] All tests pass (unit + integration with real UDS)
- [ ] Lint/typecheck pass
- [ ] E2E: hub restart with running agent preserves channels
- [ ] Documentation updated (SPEC.md, PROTOCOL.md, SECURITY.md)
- [ ] Code review clean (no blocking findings)
