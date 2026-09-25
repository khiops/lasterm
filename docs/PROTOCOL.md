# lasterm — Protocol Specification

> Version: 1 (MVP)
> Status: draft
> Last updated: 2026-09-24

## 1. Framing

All messages (hub↔agent and hub↔UI) use the same framing:

```
┌────────────────┬──────────────────────────────┐
│ 4 bytes LE     │ MessagePack payload          │
│ (payload len)  │ (variable length)            │
└────────────────┴──────────────────────────────┘
```

- **Length prefix:** 4 bytes, little-endian unsigned 32-bit integer
- **Max frame size:** 10 MB (hard limit, reject larger)
- **Payload:** MessagePack-encoded object with `type` field (string)

### 1.1 Why MessagePack

- Native Uint8Array support (no base64 for terminal output)
- ~30% smaller than JSON for binary-heavy payloads
- Same schema flexibility as JSON (no code generation)
- Library: `@msgpack/msgpack`

### 1.2 Frame Reading

```
1. Read 4 bytes → payloadLength (LE uint32)
2. If payloadLength > 10MB → protocol error, close
3. Read payloadLength bytes → payload
4. Decode as MessagePack → message object
5. Dispatch on message.type
```

### 1.3 Debugging

```bash
# Decode frames from a capture file
./dist/sea/lasterm-hub decode < capture.bin

# Pipe SSH stdio through decoder
ssh user@host "lasterm-agent --stdio" | ./dist/sea/lasterm-hub decode --hex
```

## 2. Transport Layers

### 2.1 Hub ↔ Agent (stdio — SSH or local child process)

```
Hub ──── ssh2 session / child_process ──── Agent
             │                                │
             │ stdin  ◄────── framed messages ──────► stdout
             │                (MessagePack)
             │ stderr ──────  log output (text, not framed)
```

- Agent reads frames from stdin, writes frames to stdout
- stderr reserved for log output (not parsed by hub)
- SSH close = agent gone → hub enters reconnect loop

### 2.1b Hub ↔ Agent (UDS — daemon mode)

```
Hub ──── Unix domain socket / named pipe ──── Agent (daemon)
                    │                              │
                    │ bidirectional framed messages │
                    │ (MessagePack, same framing)   │
```

- Agent runs as a standalone daemon: `lasterm-agent --daemon --socket <path>`
- Hub connects to the UDS via `connectOrLaunch(socketPath, config, binaryPath)`
- Same length-prefixed MessagePack framing as stdio
- Connection displacement: an agent with the `hub-identity` capability serves several hubs at once,
  one connection per hub, and a new connection replaces only the same hub's previous one (§ 3.1b).
  An agent without it serves one hub at a time, and the newest authenticated connection replaces the
  previous one (last-writer-wins). The replaced connection gets `ERROR { code: "DISPLACED" }`, then EOF
- A terminal's output and events (CHANNEL_EXIT, TITLE_CHANGE, PROCESS_TITLE, BELL, NOTIFICATION,
  LOG) go to the hub connected when they are sent, whichever connection spawned the terminal (#549);
  with `hub-identity`, to the current connection of the hub that owns the terminal (§ 3.1b).
  Replies (SPAWN_OK, ATTACH_OK, SNAPSHOT_RES, ERROR) go to the connection that asked.
- Agent queues output and events while no hub is connected (up to 1000 frames, oldest dropped);
  with `hub-identity`, each hub has its own queue, flushed only to that hub's next connection, as
  soon as it has authenticated: before its channel state and before any reply. A CHANNEL_EXIT
  queued while the hub was away therefore never follows the SPAWN_OK of a terminal restarted under
  the same id
- On reconnect: agent sends HELLO, reads the hub's AUTH, then enumerates channel state (see section 3.16)

### 2.2 Hub ↔ UI (WebSocket)

```
UI ──── ws://localhost:4100/ws ──── Hub
             │                         │
             │ binary WS frames        │
             │ (one frame = one msg)   │
```

- WS binary mode (opcode 0x02)
- Each WS message = one MessagePack-encoded message (no length prefix needed)
- First message must be AUTH with valid token

### 2.3 Hub ↔ UI (REST)

Standard HTTP JSON API for CRUD. See section 6.

## 3. Message Types — Hub ↔ Agent

### 3.1 HELLO (Agent → Hub)

First message, sent immediately on start.

```typescript
{
  type: "HELLO",
  version: 1,
  agent_version: "0.1.0",
  capabilities: ["multiplex", "snapshot", "resize"],
  visual_hints?: {
    badge?: { text: string, color: string },
    theme_overlay?: Record<string, string>
  }
}
```

**Capability handling:** Hub checks `capabilities` array. If `"snapshot"` is missing, hub will not send SNAPSHOT_REQ (relies on local cache only). If `"resize"` is missing, hub skips RESIZE messages. All capabilities are optional — hub degrades gracefully. `"multiplex"` means agent supports multiple channels per process. `"hub-identity"` means a daemon that serves several hubs at once, each owning its own channels (§ 3.1b); the hub reads it from the HELLO of each connection, never from an earlier one.

### 3.1b AUTH (Hub → Agent, daemon mode)

The first frame the hub sends on a daemon connection, after HELLO.

```typescript
{
  type: "AUTH",
  token: string,      // checked against the daemon's auth.json, when it has one
  hub_key?: string    // names the hub; 64 lowercase hex characters (#127)
}
```

**Token.** The local daemon reads the same `auth.json` as the hub and gets the primary token. A
remote daemon gets an empty token: the hub's token opens the hub, and a machine it merely reaches over
SSH is never given it.

**Hub key.** Each hub has a key, created once in its state directory as `hub-key` (SPEC.md § 7,
SECURITY.md § 3.6). An agent with `hub-identity` takes the lowercase hex SHA-256 of the key's string
as the connection's **owner**, keeps only that, and compares it in constant time. A connection that
presents no key belongs to the owner `legacy`, which keeps the behaviour from before #127 among such
connections: the last one wins.

**When the hub sends it:**

| Daemon | HELLO has `hub-identity` | AUTH sent |
|--------|--------------------------|-----------|
| Local | either | `{ token: <primary token>, hub_key }`, as soon as HELLO is in. An agent without `hub-identity` ignores `hub_key` |
| Remote (over SSH) | yes | `{ token: "", hub_key }`, before the hub waits for the channel state |
| Remote (over SSH) | no | nothing, as before |
| stdio | — | nothing: a stdio agent is a child of one connection |

An agent with `hub-identity` reads the first frame after HELLO even when it has no `auth.json`: an
AUTH sets the owner from `hub_key`; any other frame from a hub that sends none makes the connection
`legacy`, and is processed normally, once the channel state is sent. What the hub sends right behind
its AUTH is kept and processed after the state too. How long the agent waits for that first frame:

| Daemon | Nothing arrives in time |
|--------|-------------------------|
| With a token | 5 s, then the connection is closed, as before #127 |
| Without a token | 2 s, then the connection is `legacy` and gets its channel state. A hub from before #127 sends nothing to such a daemon and waits 5 s for the state; this is what still serves it |

A daemon whose `auth.json` is missing beside a `meta.db`, unreadable or malformed refuses every
AUTH, one with an empty token included. An empty `hub_key` counts as none.

**What the owner decides.** SPAWN makes the connection's owner the channel's owner, for good. INPUT,
RESIZE, DESTROY, ATTACH and SNAPSHOT_REQ on a channel another owner holds behave exactly as for an
unknown channel. Everything a channel emits goes to its owner's current connection, or to that
owner's own bounded queue while it has none. `AGENT_CHANNEL_STATE` lists only the owner's channels
(§ 3.16). A new connection replaces only its own owner's previous one, which gets `DISPLACED`: to a
hub, `DISPLACED` from an agent with `hub-identity` means a newer connection of its own took over,
and the stale one is dropped quietly.

### 3.2 SPAWN / SPAWN_OK / SPAWN_ERR

```typescript
// Hub → Agent
{
  type: "SPAWN",
  request_id: string,
  channel_id?: string,  // hub-provided ID for warm restart; if omitted, agent generates one
  shell: string,        // "/bin/bash"
  cwd: string,
  env: Record<string, string>,
  cols: number,         // terminal columns; defaults to 80
  rows: number          // terminal rows; defaults to 24
}

// Agent → Hub (success)
{
  type: "SPAWN_OK",
  request_id: string,
  channel_id: string
}

// Agent → Hub (failure)
{
  type: "SPAWN_ERR",
  request_id: string,
  code: string,         // "SHELL_NOT_FOUND", "PERMISSION_DENIED"
  message: string
}
```

A warm restart reuses the channel id of the terminal it replaces, so an id
names a *terminal*, not a workload: after the DESTROY that precedes the SPAWN,
the same id can briefly cover the shell that is ending and the one that is
starting. Inside the agent only the pid tells them apart, and the reader of the
ending shell must speak for its own pid alone — one that waited on whatever the
id held wedged the agent for good (#432). No CHANNEL_EXIT is sent for a
workload whose id has already been taken over: the hub asked for it to end and
has the SPAWN_OK that says what replaced it.

### 3.3 ATTACH / ATTACH_OK

Re-attach to existing channel (after reconnect).

```typescript
// Hub → Agent
{ type: "ATTACH", channel_id: string }

// Agent → Hub
{
  type: "ATTACH_OK",
  channel_id: string,
  snapshot: {
    serialized: string,
    cols: number,
    rows: number,
    cursor_x: number,
    cursor_y: number
  },
  last_seq: number
}
```

### 3.4 INPUT (Hub → Agent)

```typescript
{
  type: "INPUT",
  channel_id: string,
  data: Uint8Array       // raw bytes
}
```

### 3.5 OUTPUT (Agent → Hub)

```typescript
{
  type: "OUTPUT",
  channel_id: string,
  seq: number,           // monotonically increasing per channel
  ts: string,            // ISO 8601
  data: Uint8Array       // raw terminal output (ANSI included)
}
```

**Batching:** Buffer 16ms or 4KB, whichever comes first, then flush. Any other frame about a
channel (CHANNEL_EXIT, TITLE_CHANGE, PROCESS_TITLE, BELL, NOTIFICATION, LOG) first flushes that
channel's buffered output, so none of its OUTPUT arrives after its CHANNEL_EXIT.

### 3.6 RESIZE (Hub → Agent)

```typescript
{ type: "RESIZE", channel_id: string, cols: number, rows: number }
```

Agent MUST: pty.resize() AND headless xterm.resize().

### 3.7 SNAPSHOT_REQ / SNAPSHOT_RES

```typescript
// Hub → Agent
{ type: "SNAPSHOT_REQ", channel_id: string }

// Agent → Hub
{
  type: "SNAPSHOT_RES",
  channel_id: string,
  snapshot: { serialized: string, cols: number, rows: number,
              cursor_x: number, cursor_y: number },
  last_seq: number
}
```

### 3.8 CHANNEL_EXIT (Agent → Hub)

```typescript
{
  type: "CHANNEL_EXIT",
  channel_id: string,
  exit_code: number,
  signal?: string        // "SIGTERM", "SIGKILL"
}
```

### 3.9 DESTROY (Hub → Agent)

```typescript
{ type: "DESTROY", channel_id: string }
```

### 3.10 HEARTBEAT

```typescript
{ type: "HEARTBEAT", ts: string }      // Hub → Agent
{ type: "HEARTBEAT_ACK", ts: string }  // Agent → Hub
```

Interval: 15s. 3 consecutive misses (45s) → agent unresponsive.

### 3.11 ERROR

```typescript
{
  type: "ERROR",
  code: string,
  message: string,
  channel_id?: string,
  other_owner_channels?: number   // OTHER_HUBS_HOLD_CHANNELS only (§ 3.17)
}
```

### 3.12 TITLE_CHANGE (Agent → Hub)

Terminal title changed via OSC 0/2 escape sequence. Hub relays to all attached UI clients.

```typescript
{
  type: "TITLE_CHANGE",
  channel_id: string,
  title: string,          // sanitized by agent
  display_title?: string  // formatted version (e.g. with host prefix)
}
```

### 3.13 PROCESS_TITLE (Agent → Hub)

Foreground process name changed (polled from PTY PID). Hub relays to all attached UI clients.

```typescript
{
  type: "PROCESS_TITLE",
  channel_id: string,
  title: string,
  display_title?: string
}
```

### 3.14 BELL (Agent → Hub)

Terminal bell character (`\x07`) received. Hub relays to all attached UI clients.

```typescript
{ type: "BELL", channel_id: string }
```

### 3.15 NOTIFICATION (Agent → Hub)

OSC 9 desktop notification request. Hub relays to all attached UI clients.

```typescript
{
  type: "NOTIFICATION",
  channel_id: string,
  message: string
}
```

### 3.16 AGENT_CHANNEL_STATE / CHANNEL_STATE_END (Daemon Reconnect)

Sent by the agent to the hub immediately after HELLO when reconnecting to a daemon that has existing channels. The agent enumerates all known channels (alive and dead), then signals the end of enumeration.

```typescript
// Agent → Hub (one per channel)
{
  type: "AGENT_CHANNEL_STATE",
  channel_id: string,
  title: string,
  pid: number,           // OS process ID of the PTY (0 if dead)
  alive: boolean         // true = PTY still running, false = exited
}

// Agent → Hub (signals end of enumeration)
{
  type: "CHANNEL_STATE_END",
  other_owner_channels?: number   // hub-identity: channels other hubs hold on this daemon
}
```

**With `hub-identity`** the list holds only the channels of the connection's owner (§ 3.1b), sent
once the daemon has read the AUTH. What the owner's terminals sent while it had no connection comes
before it (§ 2.1b), so a hub may get OUTPUT or CHANNEL_EXIT before CHANNEL_STATE_END. Every channel in it is therefore this hub's, and one the hub does
not know — neither tracked nor recorded as alive, such as a SPAWN whose answer was lost — is its own
orphan: the hub sends it DESTROY, and logs how many once, at INFO. `other_owner_channels` counts the
channels of other owners. It is informational: the hub shows it with the host's session state
(§ 4.7) and never acts on those channels, which it cannot name anyway.

**Without it** the list may hold other hubs' channels, so the hub leaves every channel it does not
know alone.

**Reconnect handshake flow (daemon mode):**
```
Hub connects to daemon UDS
  │
  Agent → Hub: HELLO { protocol_version, capabilities, ... }
  Hub → Agent: AUTH { token, hub_key }   (§ 3.1b)
  Agent → Hub: AGENT_CHANNEL_STATE { channel_id: "ch-1", title: "bash", pid: 4521, alive: true }
  Agent → Hub: AGENT_CHANNEL_STATE { channel_id: "ch-2", title: "vim", pid: 0, alive: false }
  Agent → Hub: CHANNEL_STATE_END
  │
  Hub: reconcileChannelState()
    ├─ ch-1 (alive) → adopt into session, re-attach, resume OUTPUT; notify UI
    │                 CHANNEL_STATE { status: "live" } if it was orphan, or if a client is
    │                 attached (it may have been answered from the spool, § 4.7)
    ├─ ch-2 (dead) → mark dead in DB, notify UI CHANNEL_STATE { status: "dead" }
    └─ one the hub does not know → DESTROY, with hub-identity only; left alone otherwise
  │
  Normal operation (SPAWN, INPUT, OUTPUT, etc.)
```

On a fresh daemon start (no prior channels), the agent sends HELLO followed immediately by CHANNEL_STATE_END (zero AGENT_CHANNEL_STATE messages).

### 3.17 STOP (Hub → Agent, daemon mode, `hub-identity`)

```typescript
{ type: "STOP", force: boolean }
```

Asks the daemon at the other end of the hub's own connection to stop (#127). Without `force`, a
daemon that other owners still hold channels on refuses, and stops nothing:

```typescript
{
  type: "ERROR",
  code: "OTHER_HUBS_HOLD_CHANNELS",
  message: string,               // states the count in words too
  other_owner_channels: number   // how many channels other owners hold
}
```

`other_owner_channels` is absent on every other ERROR. The message starts with the count, e.g.
`2 terminals on this agent belong to other hubs; …`.

Otherwise the daemon shuts down as on SIGTERM, ending every channel it holds, and is recorded as a
stop that was asked for, under the same deadline. It sends nothing first. From the STOP on it
refuses any new SPAWN, so no terminal can start between the count and the teardown; once the
terminals are torn down it closes every hub connection, what each had queued going out first. The
connection ending is the answer. A stdio agent answers `ERROR { code: "INVALID_MESSAGE" }` and keeps
running: it ends when its input closes.

The hub sends it only to an agent that advertises `hub-identity`. It takes the count from the
refusal's `other_owner_channels` when that is a whole number of zero or more; failing that, from
the first whole number in the message; failing that, from the `other_owner_channels` of the
connection's CHANNEL_STATE_END. To any other agent, and when no protocol connection can carry the
STOP, the hub runs the agent's own `--stop` instead: the forced, out-of-band path, which knows
nothing of owners. See `POST /api/hosts/:id/agent/replace` (§ 6).

## 4. Message Types — Hub ↔ UI (WS)

### 4.1 AUTH

```typescript
// UI → Hub (must be first message)
{ type: "AUTH", token: string }

// Hub → UI
{ type: "AUTH_OK", client_id: string }
{ type: "AUTH_FAIL", message: string }
```

`AUTH_FAIL` is a verdict on the token: a client that receives it discards the token and pairs
again. When the hub cannot read its token store it has no verdict, so it sends no `AUTH_FAIL` and
closes the socket with code `1013` (Try Again Later), reason `AUTH_UNAVAILABLE`. The client keeps
its token and reconnects.

`AUTH_OK` is not the last check. The hub checks the token again before it acts on each later frame
the client sends. If the token no longer validates because it was revoked, has expired or was swept
by a restart, the hub drops the frame and closes the socket with `1008` (Policy Violation), reason
`AUTH_REVOKED`. A client that reconnects then gets `AUTH_FAIL`. If the store cannot answer, the
socket closes with `1013` as above. Revoking a token through `DELETE /api/auth/tokens/:id` closes
the sockets it authenticated at once, without waiting for their next frame. Output the hub pushes is
not re-checked, so an idle socket whose token merely expires keeps receiving it until the client
sends a frame or disconnects.

### 4.2 ATTACH / ATTACH_OK / DETACH

```typescript
// UI → Hub
{ type: "ATTACH", channel_id: string }

// Hub → UI
{
  type: "ATTACH_OK",
  channel_id: string,
  snapshot: { serialized, cols, rows, cursor_x, cursor_y } | null,
  tail: Uint8Array[],          // output since last snapshot
  write_lock_holder: string | null,
  cached: boolean              // true = from local cache, agent unreachable
}

// UI → Hub
{ type: "DETACH", channel_id: string }
```

### 4.3 INPUT / OUTPUT / RESIZE

Same as agent messages (section 3.4–3.6).
Hub verifies write-lock on INPUT. Rejects with ERROR if not holder.
Hub broadcasts RESIZE to other attached clients.

### 4.4 SPAWN / SPAWN_OK

```typescript
// UI → Hub
{
  type: "SPAWN",
  host_id: string,
  shell?: string,     // default: host.default_shell ?? system default (/bin/bash or pwsh)
  cwd?: string,       // default: host.default_cwd ?? user home dir
  env?: Record<string, string>,  // merged with system env (max 100 entries)
  group_id?: string   // optional channel group to place new channel in
}

// Hub → UI
{ type: "SPAWN_OK", channel_id: string, host_id: string, session_id: string }
```

### 4.5 Write-Lock Messages

```typescript
{ type: "WRITE_CLAIM",    channel_id: string }
{ type: "WRITE_RELEASE",  channel_id: string }
{ type: "WRITE_FORCE",    channel_id: string }

// Hub → current writer: someone requests
{ type: "WRITE_REQUEST",  channel_id: string, from_client_id: string }

// Writer → Hub: response
{ type: "WRITE_GRANT",    channel_id: string, to_client_id: string }
{ type: "WRITE_DENY",     channel_id: string, to_client_id: string }

// Hub → previous writer: lock taken away
{ type: "WRITE_REVOKED",  channel_id: string }

// Hub → ALL on channel: lock state broadcast
{ type: "WRITE_LOCK",     channel_id: string, holder: string | null }
```

### 4.6 STATE_SYNC (Hub → UI)

Sent immediately after `AUTH_OK`. Full snapshot of all active sessions and channels so the UI can hydrate without polling.

```typescript
{
  type: "STATE_SYNC",
  sessions: Array<{
    session_id: string,
    host_id: string,
    status: "starting" | "active" | "detached" | "disconnected" | "closed",
    outdated_agent?: { running: string, expected: string },  // as in SESSION_STATE
    other_owner_channels?: number                             // as in SESSION_STATE
  }>,
  channels: Array<{
    channel_id: string,
    session_id: string,
    status: "born" | "live" | "orphan" | "dead",
    exit_code?: number,
    display_title?: string
  }>
}
```

### 4.7 State Notifications

```typescript
{
  type: "SESSION_STATE",
  session_id: string,
  host_id: string,
  status: "starting" | "active" | "detached" | "disconnected" | "closed",
  // Only when the agent serving the host is not the version this hub carries (#456).
  outdated_agent?: { running: string, expected: string },
  // Only when other hubs hold channels on that agent, as its CHANNEL_STATE_END said
  // (§ 3.16, #127). Informational: replacing the agent would end them too. Sent
  // again with the same status once the count is known.
  other_owner_channels?: number
}

// A status can be said again without having changed: once a host is reached
// again, the clients attached to a terminal it still runs hear "live", since
// their last ATTACH_OK may have been `cached` (#556).
{
  type: "CHANNEL_STATE",
  channel_id: string,
  session_id: string,
  status: "born" | "live" | "orphan" | "dead",
  exit_code?: number
}

// Hub → ALL connected clients: a new channel was created by any client.
// Observers use this to add the channel to their list without a fetchChannels.
// The spawning client receives it too and deduplicates (no-op if already present).
{
  type: "CHANNEL_CREATED",
  host_id: string,
  channel_id: string,
  session_id: string,
  shell: string,
  args?: string[],
  cwd?: string,
  cols: number,
  rows: number,
  status: "live",
  display_title: string,
  created_at: string,   // ISO 8601
  updated_at: string    // ISO 8601
}
```

### 4.8 PING / PONG

```typescript
{ type: "PING" }
{ type: "PONG" }
```

Interval: 30s. 2 misses (60s) → client disconnected.

### 4.9 HOST_VERIFY (SSH Fingerprint)

```typescript
// Hub → UI (unknown host key, or key mismatch warning)
{
  type: "HOST_VERIFY",
  host_id: string,
  fingerprint: string,         // "sha256:XXXXXXXXXXXX"
  algorithm: string,           // "ssh-ed25519", "ssh-rsa"
  old_fingerprint?: string,    // set when stored key differs — MITM warning
  prompt_id?: string           // correlation ID; must be echoed in response for mismatch prompts
}

// UI → Hub (user decision)
{
  type: "HOST_VERIFY_RESPONSE",
  host_id: string,
  action: "trust_permanent" | "trust_once" | "reject",
  prompt_id?: string           // must match HOST_VERIFY.prompt_id when responding to a mismatch
}
```

### 4.10 AUTH_PROMPT / AUTH_PROMPT_RESPONSE (SSH Credentials)

Used when the hub needs to obtain a secret from the user interactively during SSH connection (password auth, key passphrase, or elevation prompt).

```typescript
// Hub → UI
{
  type: "AUTH_PROMPT",
  host_id: string,
  prompt_type: "password" | "passphrase" | "elevation",
  message: string    // human-readable prompt text (e.g. "Enter password for user@host")
}

// UI → Hub
{
  type: "AUTH_PROMPT_RESPONSE",
  host_id: string,
  secret: string | null    // null = user cancelled
}
```

**Security note:** The secret is never persisted — it is used once for the SSH handshake then discarded.

### 4.11 TEST_CONNECT (SSH Connectivity Test)

Allows the UI to test SSH connectivity for a host without creating a full session. The hub may send `AUTH_PROMPT` messages during the test if credentials are needed.

```typescript
// UI → Hub
{
  type: "TEST_CONNECT",
  host_id: string,       // real host ID for saved hosts, client-generated temp ID for unsaved
  hostname: string,
  port: number,
  ssh_auth: "agent" | "key" | "password",
  ssh_key_path?: string,
  ssh_user?: string
}

// Hub → UI (success)
{ type: "TEST_CONNECT_OK", host_id: string }

// Hub → UI (failure)
{ type: "TEST_CONNECT_FAIL", host_id: string, message: string }
```

### 4.12 Terminal Event Relay (Hub → UI)

These messages originate from the agent (see §3.12–3.15, above) and are relayed by the hub to all UI clients attached to the affected channel.

```typescript
// Terminal title changed (OSC 0/2)
{ type: "TITLE_CHANGE",   channel_id: string, title: string, display_title?: string }

// Foreground process name changed
{ type: "PROCESS_TITLE",  channel_id: string, title: string, display_title?: string }

// Terminal bell (\x07)
{ type: "BELL",           channel_id: string }

// OSC 9 desktop notification
{ type: "NOTIFICATION",   channel_id: string, message: string }
```

### 4.13 Agent Fetch Messages (Hub → UI)

Broadcast to all authenticated UI clients for agent-manager fetch jobs accepted by `POST /api/agents/fetch`. Wire keys are snake_case.

```typescript
// Progress
{
  type: "AGENT_FETCH_PROGRESS",
  job_id: string,
  os: "linux" | "windows" | "darwin",
  arch: "x64" | "arm64",
  downloaded: number,
  total?: number,
  phase: "download" | "verify"
}

// Success
{
  type: "AGENT_FETCH_DONE",
  job_id: string,
  path: string
}

// Failure
{
  type: "AGENT_FETCH_ERROR",
  job_id: string,
  code: string,
  message: string
}
```

### 4.14 ERROR

```typescript
{ type: "ERROR", code: string, message: string, channel_id?: string }
```

**Error codes:**

| Code | Meaning |
|------|---------|
| `AUTH_REQUIRED` | No AUTH sent yet |
| `AUTH_INVALID` | Bad token |
| `CHANNEL_NOT_FOUND` | Unknown channel ID |
| `NOT_ATTACHED` | Op requires ATTACH first |
| `WRITE_LOCK_HELD` | INPUT rejected, not the writer |
| `HOST_NOT_FOUND` | Unknown host ID |
| `SSH_FAILED` | SSH connection failed |
| `AGENT_ERROR` | Agent returned error |
| `FRAME_TOO_LARGE` | Payload > 10 MB |
| `PROTOCOL_ERROR` | Malformed message |

## 5. Protocol Sequences

### 5.1 Local Session

```
UI                          Hub
 │── AUTH ──────────────────►│
 │◄── AUTH_OK ──────────────│
 │── SPAWN {host:"local"} ─►│── spawn PTY
 │◄── SPAWN_OK {ch_id} ────│
 │── ATTACH {ch_id} ───────►│
 │◄── ATTACH_OK {snapshot} ─│
 │── INPUT {data} ──────────►│── pty.write()
 │                           │◄── pty.onData()
 │◄── OUTPUT {data} ────────│
 │── RESIZE {cols,rows} ───►│── pty.resize()
 │── DETACH ────────────────►│── channel → ORPHAN
```

### 5.2 Remote Session

```
UI                          Hub                        Agent
 │── AUTH ──────────────────►│                           │
 │◄── AUTH_OK ──────────────│                           │
 │── SPAWN {host:"prod"} ──►│── ssh2.connect() ────────►│
 │                           │◄── HELLO {hints} ────────│
 │                           │── SPAWN {shell} ─────────►│
 │                           │◄── SPAWN_OK {ch_id} ─────│
 │◄── SPAWN_OK ─────────────│                           │
 │── ATTACH ────────────────►│── SNAPSHOT_REQ ──────────►│
 │                           │◄── SNAPSHOT_RES ──────────│
 │◄── ATTACH_OK ────────────│                           │
 │── INPUT ─────────────────►│── INPUT ─────────────────►│
 │                           │◄── OUTPUT ────────────────│
 │◄── OUTPUT ────────────────│                           │
```

### 5.3 Reconnect After SSH Drop

```
Hub                        Agent
 │ ×× SSH drops ×× ─────────│ (agent keeps PTYs)
 │── retry 1s ───────────►  fail
 │── retry 2s ───────────►  fail
 │── retry 4s ───────────►  success
 │◄── HELLO ─────────────────│
 │── ATTACH {ch-1} ─────────►│
 │◄── ATTACH_OK {snapshot} ──│
 │── ATTACH {ch-2} ─────────►│
 │◄── ATTACH_OK {snapshot} ──│
 │  (resume OUTPUT)           │
```

### 5.4 Daemon Reconnect (Hub Restart)

```
Hub                        Agent (daemon, has channels)
 │── connect to UDS ───────►│
 │◄── HELLO ─────────────────│
 │── AUTH {token, hub_key} ─►│ (§ 3.1b)
 │◄── AGENT_CHANNEL_STATE ───│ (ch-1, alive)
 │◄── AGENT_CHANNEL_STATE ───│ (ch-2, alive)
 │◄── AGENT_CHANNEL_STATE ───│ (ch-3, dead)
 │◄── CHANNEL_STATE_END ─────│
 │  reconcile: adopt ch-1,2; mark ch-3 dead
 │── SPAWN (new channel) ───►│
 │◄── SPAWN_OK ──────────────│
 │  (normal operation)        │
```

### 5.5 Write-Lock Transfer

```
Client A (WRITER)           Hub                Client B (READER)
 │                           │◄── WRITE_CLAIM ──────────│
 │◄── WRITE_REQUEST {B} ────│                           │
 │── WRITE_GRANT {B} ───────►│                           │
 │                           │── WRITE_LOCK {B} ───────►│
 │◄── WRITE_LOCK {B} ───────│                           │
 │  (now READER)             │            (now WRITER)   │
```

## 6. REST API

Base: `http://localhost:4100/api`
Auth: `Authorization: Bearer <token>` (except `/health`).

A bearer that is missing or malformed answers `401 AUTH_REQUIRED`, and one that is unknown,
revoked, swept or expired answers `401 AUTH_INVALID`. A bearer the hub cannot check because its
token store cannot be read answers `503 AUTH_UNAVAILABLE`: the request is still refused, but the
token was not judged, and the client should keep it and retry.

### Pagination

Five list routes page: `GET /api/hosts`, `/api/host-groups`, `/api/launch-profiles`,
`/api/logs/hub` and `/api/logs/channels/:channelId`. All five read `limit` and `offset` through
one parser (`packages/hub/src/api/pagination.ts`), so they accept and refuse the same values:

| Parameter | Accepted | When absent |
|-----------|----------|-------------|
| `limit` | an integer from 1 to 1000 | The host, host-group and launch-profile lists answer the whole list as a plain array. The log routes serve 100 entries. |
| `offset` | an integer from 0 to 9007199254740991 (2^53 − 1) | 0 |

A value is decimal digits only. A sign, a decimal point, an exponent, whitespace, an empty value
or a parameter given twice is refused. A refused value answers `400` with
`{ error: { code: "VALIDATION_ERROR", message } }`, and the message names the parameter and its
range.

Given a `limit`, the three entity lists answer `{ data, total, limit, offset }`
(`PaginatedResponse`). The log routes always answer `{ entries, total }`. An `offset` past the end
gives an empty page, not an error. On the entity lists, an `offset` without a `limit` is checked,
then has no effect.

### Endpoints

Auth column: `●` = `Authorization: Bearer <token>` required, `○` = unauthenticated.

#### Health

| Method | Path | Auth | Response |
|--------|------|------|----------|
| GET | `/api/health` | ○ | `{ status, version, build }` |

The route is unauthenticated, and the hub is planned to listen beyond loopback (#96, #193), so it
reports no process details: no uptime, pid or start time. A local caller that wants the start time
reads `started_at` from `runtime.json`, as `lasterm status` does.

#### Hosts

| Method | Path | Auth | Body / Notes |
|--------|------|------|--------------|
| GET | `/api/hosts` | ● | `Host[]`, or a page with `?limit=&offset=` (see Pagination) |
| POST | `/api/hosts` | ● | CreateHost → `Host` (201) |
| PUT | `/api/hosts/order` | ● | `{ group_id, host_ids }` → 204 (alias: `/api/hosts/reorder`) |
| GET | `/api/hosts/:id` | ● | `Host` |
| PUT | `/api/hosts/:id` | ● | UpdateHost → `Host` (partial update, deep merge) |
| DELETE | `/api/hosts/:id` | ● | 204 |
| POST | `/api/hosts/:id/duplicate` | ● | → `Host` (201) |
| PUT | `/api/hosts/:id/welcome` | ● | `{ channel_id }` → 200 |
| DELETE | `/api/hosts/:id/welcome` | ● | 204 |
| POST | `/api/hosts/:id/agent/replace` | ● | `{ force?: boolean }` → `{ replaced: true, message }`. Stops the remote daemon serving this host, ending every terminal it holds, so the next connection starts the agent this hub carries (#456). An agent with `hub-identity` gets STOP over the hub's own connection (§ 3.17): while other hubs hold terminals there it refuses, and the answer is 409 `{ error: { code: "OTHER_HUBS_HOLD_CHANNELS", message, other_owner_channels? } }`; the same request with `force: true` ends those too. Any other agent, or one the STOP cannot reach, is stopped with its own `--stop`. 409 `AGENT_NOT_REPLACED` when nothing was stopped for another reason, 400 `VALIDATION_ERROR` for a `force` that is not a boolean, 404 for an unknown host |
| GET | `/api/hosts/:id/profiles` | ● | `LaunchProfile[]` (query: `?os=linux\|darwin\|windows`) |
| PUT | `/api/hosts/:id/profiles/:profileId` | ● | `{ override_type, sort_order? }` → 204 |
| DELETE | `/api/hosts/:id/profiles/:profileId` | ● | 204 |

#### SSH Config Import

| Method | Path | Auth | Body / Notes |
|--------|------|------|--------------|
| GET | `/api/ssh-config` | ● | `{ entries, has_include }` — parses `~/.ssh/config` |
| POST | `/api/hosts/import` | ● | `{ entries: SshConfigImport[] }` → `Host[]` (201) |

#### Sessions

| Method | Path | Auth | Body / Notes |
|--------|------|------|--------------|
| GET | `/api/sessions` | ● | `Session[]` (query: `?host_id=X`) |
| GET | `/api/sessions/:id` | ● | `Session` (includes channels) |
| DELETE | `/api/sessions/:id` | ● | 204 (close) |

#### Channels

| Method | Path | Auth | Body / Notes |
|--------|------|------|--------------|
| GET | `/api/channels` | ● | `Channel[]` (query: `?host_id=X`) |
| GET | `/api/channels/:id` | ● | `Channel` |
| PATCH | `/api/channels/:id` | ● | Partial update (e.g. title) → `Channel` |
| POST | `/api/channels/:id/restart` | ● | Restart dead channel → 200 |
| DELETE | `/api/channels/:id` | ● | 204 |
| DELETE | `/api/channels/dead` | ● | Remove all dead channels → `{ purged }` (alias: `POST /api/channels/purge-dead`) |

#### Channel Groups (tab groups)

| Method | Path | Auth | Body / Notes |
|--------|------|------|--------------|
| GET | `/api/groups` | ● | `Group[]` |
| POST | `/api/groups` | ● | CreateGroup → `Group` (201) |
| PUT | `/api/groups/order` | ● | `{ group_ids }` → 204 (alias: `/api/groups/reorder`) |
| PATCH | `/api/groups/:id` | ● | UpdateGroup → `Group` |
| DELETE | `/api/groups/:id` | ● | 204 |

#### Host Groups

| Method | Path | Auth | Body / Notes |
|--------|------|------|--------------|
| GET | `/api/host-groups` | ● | `HostGroup[]`, or a page with `?limit=&offset=` (see Pagination) |
| POST | `/api/host-groups` | ● | CreateHostGroup → `HostGroup` (201) |
| PUT | `/api/host-groups/order` | ● | `{ group_ids }` → 204 (alias: `/api/host-groups/reorder`) |
| PUT | `/api/host-groups/:id` | ● | UpdateHostGroup → `HostGroup` |
| DELETE | `/api/host-groups/:id` | ● | 204 |

#### Launch Profiles

| Method | Path | Auth | Body / Notes |
|--------|------|------|--------------|
| GET | `/api/launch-profiles` | ● | `LaunchProfile[]`, or a page with `?limit=&offset=` (see Pagination) |
| POST | `/api/launch-profiles` | ● | CreateLaunchProfile → `LaunchProfile` (201) |
| PUT | `/api/launch-profiles/order` | ● | `{ ids }` → 204 (alias: `POST /api/launch-profiles/reorder`) |
| GET | `/api/launch-profiles/:id` | ● | `LaunchProfile` |
| PUT | `/api/launch-profiles/:id` | ● | UpdateLaunchProfile → `LaunchProfile` |
| DELETE | `/api/launch-profiles/:id` | ● | 204 |

#### Configuration

| Method | Path | Auth | Body / Notes |
|--------|------|------|--------------|
| GET | `/api/config/defaults` | ● | Layer 1 built-in defaults |
| GET | `/api/config/ui` | ● | UI behavioral config |
| GET | `/api/config/resolved` | ● | Merged config (query: `?host_id=X&channel_id=Y&session_id=Z`) |
| GET | `/api/config/cascade` | ● | Full 4-layer cascade (query: `?host_id=X&channel_id=Y`) |
| PUT | `/api/config/global` | ● | `{ terminal: {...} }` → `{ ok }` |
| PUT | `/api/config/ui` | ● | `{ <section>: { <key>: value } }` → `{ ok }` |
| PUT | `/api/config/appearance` | ● | `{ theme?, autoSwitch?, ... }` → `{ ok }` |
| GET | `/api/config/elevation` | ● | Current elevation config |
| PUT | `/api/config/elevation` | ● | `{ methodLinux?, methodDarwin?, ... }` → `{ ok }` |
| GET | `/api/hosts/:id/profile` | ● | `{ profile: object }` — raw host Layer 3 profile |
| PATCH | `/api/hosts/:id/profile` | ● | `{ profile: object }` — merge into host Layer 3 profile |
| GET | `/api/channels/:id/profile` | ● | `{ profile: object }` — raw channel Layer 4 profile |
| PATCH | `/api/channels/:id/profile` | ● | `{ profile: object }` — merge into channel Layer 4 profile |

#### Fonts

| Method | Path | Auth | Body / Notes |
|--------|------|------|--------------|
| GET | `/api/fonts` | ● | `FontFamily[]` — the imported fonts in the config dir's `fonts/`; returned public font URLs carry the per-boot asset token |
| GET | `/api/fonts/system` | ● | `SystemFontFamily[]` — `.ttf`/`.otf` fonts installed where the hub runs (#100), with `monospace` and each face's `localNames` for `local()`. Scanned from the OS font directories at most every five minutes |

#### Themes

| Method | Path | Auth | Body / Notes |
|--------|------|------|--------------|
| GET | `/api/themes` | ● | `Theme[]` (built-in + user) |
| GET | `/api/themes/:name` | ● | `Theme` |
| POST | `/api/themes` | ● | CreateTheme → `Theme` (201) |
| PUT | `/api/themes/:name` | ● | UpdateTheme → `Theme` |
| DELETE | `/api/themes/:name` | ● | 204 |

#### Wallpapers

| Method | Path | Auth | Body / Notes |
|--------|------|------|--------------|
| GET | `/api/wallpapers` | ● | `WallpaperFile[]` — user wallpaper filenames; clients build signed public URLs |
| POST | `/api/wallpapers` | ● | multipart upload → `{ filename }` (201) |
| DELETE | `/api/wallpapers/:filename` | ● | 204 |

#### Asset Token

| Method | Path | Auth | Body / Notes |
|--------|------|------|--------------|
| GET | `/api/assets/token` | ● | `{ assetToken, token }` — per-boot token appended to `/public/*` URLs as `asset_token` |

#### Agent Manager

| Method | Path | Auth | Body / Notes |
|--------|------|------|--------------|
| GET | `/api/agents/targets` | ● | `{ hub_version, targets }` |
| POST | `/api/agents/fetch` | ● | `{ os, arch, version? }` → 202 `{ job_id, snapshot }` or 200 `{ status: "already_cached" }`; Origin guard |
| POST | `/api/agents/prune` | ● | `{ version? }` → `{ removed }`; Origin guard |
| POST | `/api/agents/import` | ● | multipart fields `os`, `arch`, `version`, `attested`, `force?` before files `binary`, `manifest` → `{ path, version, verified }`; Origin guard |

#### Pairing

| Method | Path | Auth | Body / Notes |
|--------|------|------|--------------|
| POST | `/api/pair` | ● | — → `{ code, expires_at }` (201); max 3 active codes |
| POST | `/api/pair/verify` | ○ | `{ code }` → `{ token }` |

#### Auth Tokens

| Method | Path | Auth | Body / Notes |
|--------|------|------|--------------|
| GET | `/api/auth/tokens` | ● | `{ tokens }`, each `{ id, label, created_at, expires_at, revoked_at, swept_at, last_used_at }`; never the hash |
| DELETE | `/api/auth/tokens/:id` | ● | → `{ ok: true }`, or 404 `TOKEN_NOT_FOUND` if unknown or already revoked. Closes the WebSockets the token authenticated (`1008 AUTH_REVOKED`). `primary` answers 409 `PRIMARY_TOKEN_NOT_REVOCABLE` and closes nothing: it is retired by replacing `auth.json` (SECURITY.md § 2.1). Every answer is recorded as `token.revoke` (SECURITY.md § 7.1) |

#### Logs

| Method | Path | Auth | Body / Notes |
|--------|------|------|--------------|
| GET | `/api/logs/hub` | ● | `{ entries, total }` from `hub.jsonl`, in file order. Query: `level` (minimum), `from_t` and `to_t` (ISO 8601), `search` (in `msg`, any case), `limit`, `offset` (see Pagination) |
| GET | `/api/logs/channels/:channelId` | ● | `{ entries, total }` for one channel, with the same query; `from_t` and `to_t` are milliseconds since the channel opened. An id that is not 26 alphanumerics answers 400 `INVALID_CHANNEL_ID` |

#### Static Assets (served by @fastify/static)

| Prefix | Source | Notes |
|--------|--------|-------|
| `/public/fonts/` | `~/.config/lasterm/fonts/` | User custom fonts; `Cross-Origin-Resource-Policy: cross-origin` only when `asset_token` is valid |
| `/public/system-fonts/<id>.ttf\|.otf` | OS font directories | A font the last `/api/fonts/system` scan found, by an opaque id (never a path); asset token required |
| `/public/sounds/` | `~/.config/lasterm/sounds/` | User custom bell sounds; `Cross-Origin-Resource-Policy: cross-origin` only when `asset_token` is valid |
| `/public/wallpapers/` | `~/.config/lasterm/wallpapers/` | User wallpapers; `Cross-Origin-Resource-Policy: cross-origin` only when `asset_token` is valid |
| `/` (fallback) | `static/` dir or SEA blob | Web UI bundle (unauthenticated) |

### Request/Response Body Schemas

**CreateHost:**
```typescript
{
  type: 'local' | 'ssh',             // required
  label: string,                      // required, 1-64 chars, alphanumeric + dot/dash/underscore, unique
  ssh_host?: string,                  // required if type=ssh, "hostname" or "ip"
  ssh_port?: number,                  // default 22, range 1-65535
  ssh_user?: string,                  // SSH username
  ssh_auth?: 'agent' | 'key' | 'password',  // required if type=ssh
  ssh_key_path?: string,              // required if ssh_auth=key
  ssh_config_host?: string,           // Host alias from ~/.ssh/config
  icon_type?: 'auto' | 'emoji' | 'image',   // default 'auto'
  icon_value?: string,                // emoji char or image path
  color?: string,                     // hex "#rrggbb" or null for auto
  default_shell?: string,
  default_cwd?: string,
  trust_remote_hints?: 'apply' | 'ask' | 'ignore',  // default 'apply'
  host_group?: string,                // group name (legacy)
  host_group_id?: string,             // host group ID
  keep_alive_seconds?: number,        // SSH keepalive interval
  history_retention_days?: number,    // spool retention
  profile_json?: string | object,     // host-level terminal profile (Layer 3)
  elevation_method?: string,          // e.g. "sudo", "doas", "pkexec", "gsudo"
  custom_command?: string,            // custom SSH/connect command template
  os?: 'linux' | 'darwin' | 'windows' | null,
  arch?: 'x64' | 'arm64' | null
}
```

**UpdateHost:** Same fields as CreateHost, all optional (partial update, deep merge).

**CreateGroup:** (tab channel groups)
```typescript
{
  name: string,                 // required, 1-64 chars
  sort_order?: number           // default 0
}
```

**UpdateGroup:**
```typescript
{
  name?: string,
  sort_order?: number,
  collapsed?: boolean
}
```

**CreateHostGroup:**
```typescript
{
  name: string,                 // required, 1-64 chars
  sort_order?: number
}
```

**UpdateHostGroup:**
```typescript
{
  name?: string,
  sort_order?: number,
  collapsed?: boolean
}
```

**CreateLaunchProfile:**
```typescript
{
  name: string,                 // required, 1-64 chars, unique
  shell?: string,               // shell binary path
  args?: string[],              // shell arguments
  cwd?: string,                 // working directory
  env?: Record<string, string>, // environment variables (values masked in responses)
  description?: string,
  color?: string,               // hex "#rrggbb"
  icon?: string,                // emoji
  os_filter?: 'linux' | 'darwin' | 'windows' | null,
  sort_order?: number
}
```

**UpdateLaunchProfile:** Same fields as CreateLaunchProfile, all optional.

**AgentTarget:**
```typescript
{
  os: 'linux' | 'windows' | 'darwin',
  arch: 'x64' | 'arm64',
  triple: string | null,
  status: 'bundled' | 'error' | 'cached' | 'stale' | 'missing' | 'untrusted' | 'unsupported',
  version?: string,
  expected_version: string,
  size?: number,
  mtime?: string                  // ISO 8601
}
```

**Agent targets:**
```typescript
// GET /api/agents/targets
{
  hub_version: string,
  targets: AgentTarget[]
}
```

Errors: `AGENT_STATUS_ERROR` (500).

**Agent fetch:**
```typescript
// POST /api/agents/fetch
{ os: 'linux' | 'windows' | 'darwin', arch: 'x64' | 'arm64', version?: string }

// 202 Accepted
{
  job_id: string,
  snapshot: {
    os: 'linux' | 'windows' | 'darwin',
    arch: 'x64' | 'arm64',
    downloaded: number,
    total?: number,
    phase: 'download' | 'verify'
  }
}

// 200 OK
{ status: 'already_cached' }
```

Errors: `UNSUPPORTED_TARGET`, `BUNDLED_TARGET`, `BAD_VERSION`.

**Agent prune:**
```typescript
// POST /api/agents/prune
{ version?: string }

// 200 OK
{ removed: number }
```

Errors: `BAD_VERSION`.

**Agent import:**
```typescript
// POST /api/agents/import
// multipart/form-data; all fields must precede files
fields: {
  os: 'linux' | 'windows' | 'darwin',
  arch: 'x64' | 'arm64',
  version: string,
  attested: 'true',
  force?: 'true'
}
files: {
  binary: File,
  manifest: File
}

// 200 OK
{
  path: string,
  version: string,
  verified: true
}
```

Errors: `CHECKSUM_MISMATCH`/`CHECKSUM_MISSING` (422), `INSECURE_CACHE_DIR`/`ALREADY_CURRENT` (409), `UNSUPPORTED_TARGET`/`BUNDLED_TARGET`/`BAD_VERSION`/`ATTESTATION_REQUIRED`/`BAD_MULTIPART` (400), `TOO_LARGE` (413), `DISK` (500).

**Agent manager error responses:**
```typescript
{
  error: {
    code: string,
    message: string
  }
}
```

All agent-manager routes require `Authorization: Bearer <token>` (`AUTH_REQUIRED`, `AUTH_INVALID`, or `AUTH_UNAVAILABLE` with a 503 while the token store cannot be read). Mutation routes also enforce the Origin guard (`ORIGIN_FORBIDDEN`).

**Error responses:**
```typescript
// Most legacy non-2xx responses return:
{
  error: string,                // machine-readable code (e.g., "NOT_FOUND", "VALIDATION_ERROR")
  message: string               // human-readable description
}
```

### Agent Error Codes

Complete list of codes returned in SPAWN_ERR and ERROR messages:

| Code | Origin | Meaning |
|------|--------|---------|
| `SHELL_NOT_FOUND` | Agent | Shell binary not found at path |
| `PERMISSION_DENIED` | Agent | Cannot spawn PTY (user/cgroup restriction) |
| `PTY_SPAWN_FAILED` | Agent | node-pty.spawn() threw (generic) |
| `CHANNEL_LIMIT` | Agent | Max channels reached (default 50 per agent) |
| `CHANNEL_NOT_FOUND` | Agent | ATTACH/INPUT/RESIZE for unknown channel_id (DESTROY and SNAPSHOT_REQ answer nothing); with `hub-identity`, also for a channel another hub owns, which is never told apart from an unknown one, byte for byte |
| `INVALID_MESSAGE` | Both | Unrecognized or malformed message |
| `VERSION_MISMATCH` | Hub | Agent protocol version too new |
| `DISPLACED` | Agent | A newer connection took this one's place, and this one ends. With `hub-identity`, only ever a newer connection of the same hub (§ 3.1b) |
| `OTHER_HUBS_HOLD_CHANNELS` | Agent | STOP without `force`, refused while other hubs hold channels; `other_owner_channels` carries how many, and the message says it too (§ 3.17) |

### Pairing Code Format

- 8 numeric digits (`0-9`), leading zeros allowed (e.g., `00729316`)
- Generated via `crypto.randomInt(0, 100_000_000).toString().padStart(8, '0')`
- Expires: ISO 8601 timestamp, 60 seconds from creation
- Stored only as a keyed hash, under a key the hub holds for one run: a code issued before the
  hub's last start is unknown to it (SECURITY.md § 2.3)

## 7. Version Negotiation

HELLO includes `version: 1`. Hub checks:

| Agent | Hub | Result |
|:-----:|:---:|--------|
| 1 | 1 | Compatible |
| 1 | 2 | Hub downgrades to v1 |
| 2 | 1 | Hub sends ERROR, closes |

Unknown message types MUST be ignored (forward compatibility).
