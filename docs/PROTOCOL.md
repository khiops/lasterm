# lasterm — Protocol Specification

> Version: 1 (MVP)
> Status: draft
> Last updated: 2026-10-28

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

No command decodes frames: the `decode` subcommand an earlier draft showed here was never built,
and `lasterm --help` lists what exists (SPEC.md § 3.3). At `[logging] level = "debug"` the agent
logs a one-line summary of each message a hub sends it: its type and a channel id's first
characters, never the bytes it carries.

## 2. Transport Layers

### 2.1 Hub ↔ Agent (stdio — SSH)

```
Hub ──── ssh2 session ──── Agent
             │                                │
             │ stdin  ◄────── framed messages ──────► stdout
             │                (MessagePack)
             │ stderr ──────  log output (text, not framed)
```

- Agent reads frames from stdin, writes frames to stdout
- stderr reserved for log output (not parsed by hub)
- SSH close = agent gone → hub enters reconnect loop
- A hub that stops reading stdout holds back the agent's terminals, as a daemon's connection does
  (§ 2.1b)
- Only remote agents run on stdio. The local agent is always a daemon (§ 2.1b)

### 2.1b Hub ↔ Agent (UDS — daemon mode)

```
Hub ──── Unix domain socket / named pipe ──── Agent (daemon)
                    │                              │
                    │ bidirectional framed messages │
                    │ (MessagePack, same framing)   │
```

- Agent runs as a standalone daemon: `lasterm-agent --daemon --socket <path>`
- Hub connects to the UDS via `connectOrLaunch(socketPath, config, binaryPath)`. A remote daemon's
  socket is reached through the host's SSH connection, over a `direct-streamlocal` channel
  (SPEC.md § 3.2); what that channel carries is the same
- Same length-prefixed MessagePack framing as stdio
- Connection displacement: a daemon serves several hubs at once, one connection per hub, and a new
  connection replaces only the same hub's previous one (§ 3.1b). The replaced connection gets
  `ERROR { code: "DISPLACED" }`, then EOF
- A terminal's output and events (CHANNEL_EXIT, TITLE_CHANGE, PROCESS_TITLE, BELL, NOTIFICATION,
  LOG) go to the current connection of the hub that owns the terminal, whichever of its connections
  spawned it (#549, § 3.1b).
  Replies (SPAWN_OK, ATTACH_OK, SNAPSHOT_RES, ERROR) go to the connection that asked.
- Agent queues output and events while no hub is connected: each channel's newest, up to 1 MiB per
  channel and 16 MiB per hub, the oldest dropped first and a channel's CHANNEL_EXIT always kept
  (SPEC.md § 3.2). Each hub has its own queue, flushed only to that hub's next
  connection, as soon as it has authenticated: before its channel state and before any reply. A
  CHANNEL_EXIT queued while the hub was away therefore never follows the SPAWN_OK of a terminal
  restarted under the same id
- A connected hub that does not read holds back its own terminals: once 1 MiB of their output waits
  for its connection, the agent stops reading them until it drains to 256 KiB, and their programs
  block (SPEC.md § 3.2, #553). Nothing is dropped. INPUT and every request are still acted on, and
  replies are never held back, though each goes out behind the output already queued
- On reconnect: agent sends HELLO, reads the hub's AUTH, then enumerates channel state (see section 3.16)

### 2.2 Hub ↔ UI (WebSocket)

```
UI ──── wss://127.0.0.1:<port>/ws ──── Hub
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
  agent_version: "0.12.0",
  capabilities: ["multiplex", "resize", "snapshot", "launch-profiles", "env-modes"],
                            // a daemon adds "hub-identity"
  available_shells?: string[],  // the shells the agent found on its host
  default_shell?: string,       // its user's default shell
  visual_hints?: {              // declared, never sent: no agent sends hints (SPEC.md § 4.4)
    badge?: { text: string, color: string },
    theme_overlay?: Record<string, string>
  }
}
```

The hub records `available_shells` and `default_shell` on the host, and seeds a launch profile
for each shell.

**Capabilities.** The hub logs the list, and gates nothing on it: every agent it can meet has all five, and every daemon `"hub-identity"` too. `"multiplex"` means agent supports multiple channels per process; `"snapshot"`, that it answers SNAPSHOT_REQ; `"resize"`, that it takes RESIZE. `"launch-profiles"` means an agent that takes SPAWN's elevation fields. `"env-modes"` means an agent that builds each terminal's environment itself from SPAWN's `env_mode`, `env_unset` and `login_shell` (§ 3.2), and answers ENV_QUERY (§ 3.18). `"hub-identity"` means a daemon that serves several hubs at once, each owning its own channels, requires AUTH (§ 3.1b) and understands STOP (§ 3.17).

### 3.1b AUTH (Hub → Agent, daemon mode)

The first frame the hub sends on a daemon connection, after HELLO.

```typescript
{
  type: "AUTH",
  token: string,      // checked against the daemon's auth.json, when it has one
  hub_key: string     // names the hub; 64 lowercase hex characters (#127)
}
```

**Token.** The local daemon reads the same `auth.json` as the hub and gets the primary token. A
remote daemon gets an empty token: the hub's token opens the hub, and a machine it merely reaches over
SSH is never given it.

**Hub key.** Each hub has a key, created once in its state directory as `hub-key` (SPEC.md § 7,
SECURITY.md § 3.6). The daemon takes the lowercase hex SHA-256 of the key's string
as the connection's **owner**, keeps only that, and compares it in constant time.

**When the hub sends it:**

| Agent | AUTH sent |
|-------|-----------|
| Local daemon | `{ token: <primary token>, hub_key }`, as soon as HELLO is in |
| Remote daemon (over SSH) | `{ token: "", hub_key }`, before the hub waits for the channel state |
| stdio | nothing: a stdio agent is a child of one connection |

A daemon requires AUTH as the first frame after HELLO, with or without an
`auth.json`, and takes the owner from its `hub_key`. What the hub sends right behind its AUTH is kept
and processed once the channel state is sent. A connection is refused, sent one `ERROR` without a
`channel_id`, and closed, when:

| What came | `ERROR` code |
|-----------|--------------|
| Nothing within 5 s | `AUTH_REQUIRED` |
| A first frame that is not AUTH, or an AUTH without `hub_key` | `AUTH_REQUIRED` |
| An AUTH whose token does not match the daemon's `auth.json` | `AUTH_INVALID` |
| An AUTH with an empty `hub_key` | `AUTH_INVALID` |

Nothing else of a refused connection is acted on, and it is told nothing of the channels. A daemon
whose `auth.json` is missing beside a `meta.db`, unreadable or malformed refuses every AUTH, one with
an empty token included.

**What the owner decides.** SPAWN makes the connection's owner the channel's owner, for good. INPUT,
RESIZE, DESTROY, ATTACH and SNAPSHOT_REQ on a channel another owner holds behave exactly as for an
unknown channel. Everything a channel emits goes to its owner's current connection, or to that
owner's own bounded queue while it has none. `AGENT_CHANNEL_STATE` lists only the owner's channels
(§ 3.16). A new connection replaces only its own owner's previous one, which gets `DISPLACED`: to a
hub, `DISPLACED` means a newer connection of its own took over, and the stale one is dropped quietly.

### 3.2 SPAWN / SPAWN_OK / SPAWN_ERR

```typescript
// Hub → Agent
{
  type: "SPAWN",
  request_id: string,
  channel_id?: string,  // hub-provided ID for warm restart; if omitted, agent generates one
  shell?: string,       // "/bin/bash"; only a shell the terminal has of its own, on a restart too (#583);
                        // absent: the agent's user's default shell (SHELL on Unix, COMSPEC on Windows)
  args?: string[],      // the shell's arguments; absent when there are none
  cwd?: string,         // only a directory the terminal has of its own, on a restart too (#581);
                        // absent: the agent's user's home (HOME on Unix, USERPROFILE on Windows),
                        // or where the agent runs when that is not a directory
  env?: Record<string, string>,  // set after env_unset: the scopes', the launch profile's, the request's
  cols: number,         // terminal columns; the hub sends 80 when its client gave none
  rows: number,         // terminal rows; the hub sends 24 when its client gave none
  env_mode: "inherit" | "minimal",  // what the environment starts from; unknown = inherit.
                        // Required: a SPAWN without it does not decode (INVALID_MESSAGE)
  env_unset?: string[], // removed before env is applied: what a scope set to null
  login_shell?: boolean, // start the shell as a login shell (Unix agents, known shells)
  direct_process?: boolean,   // a launch profile's `process` mode; the agent ignores it
  elevated?: boolean,         // run the shell elevated; the hub asks it of a local agent only
  elevation_method?: string,  // "sudo", "doas", "pkexec", "gsudo" or "custom"
  custom_command?: string,    // the elevation command, for "custom"
  elevation_secret?: string   // the password an elevated SPAWN needs (§ 4.10)
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

**The environment a terminal starts with (`env-modes`, #576).** The agent builds it whole and
starts the PTY from a cleared environment, in this order:

1. The base. `inherit`: the agent's own environment. `minimal`: only these, taken from the agent's
   environment, never invented — Unix: `HOME`, `USER`, `LOGNAME`, `SHELL`, `PATH`, `LANG`,
   `LANGUAGE`, `LC_*`, `TZ`, `TMPDIR`, `XDG_RUNTIME_DIR`; Windows: `SystemRoot`, `SystemDrive`,
   `windir`, `ComSpec`, `PATHEXT`, `Path`, `USERPROFILE`, `USERNAME`, `USERDOMAIN`, `HOMEDRIVE`,
   `HOMEPATH`, `APPDATA`, `LOCALAPPDATA`, `TEMP`, `TMP`, `ProgramData`, `ALLUSERSPROFILE`,
   `PUBLIC`, `ProgramFiles*`, `ProgramW6432`, `CommonProgramFiles*`, `CommonProgramW6432`,
   `PROCESSOR_*`, `NUMBER_OF_PROCESSORS`, `OS`, `COMPUTERNAME`, `PSModulePath`.
2. The inherited `NO_COLOR` is dropped.
3. The identity is set, over whatever was inherited: `TERM=xterm-256color` (Unix agents only;
   ConPTY translates on Windows), `COLORTERM=truecolor`, `TERM_PROGRAM=lasterm`,
   `TERM_PROGRAM_VERSION=<agent version>`.
4. `env_unset`, then `env`: a profile can remove or change any of the above.
5. What elevation needs, last.

On Windows names compare without case: `Path` and `PATH` are one variable, which keeps the casing
it first had. A name that is empty or holds `=` or NUL, and a value holding NUL, are skipped.

`login_shell` asks for a login shell. A Unix agent then adds `-l` when `args` is empty and the
shell is one known to take it (`bash`, `zsh`, `ksh`, `mksh`, `fish`, `sh`, `dash`, `ash`, by file
name); arguments the request names are passed as they are. A Windows agent ignores it. The hub asks
for one only on an SSH host, for the shell the host's agent reported as its default (or none named),
with no arguments, as a shell rather than a direct process: `ssh host` gives a login shell, and a
remote terminal takes its place. Local terminals are unchanged.

The agent logs the mode, `login_shell` and the counts of `env` and `env_unset`, never a name or a
value.

### 3.3 ATTACH / ATTACH_OK

Re-attach to existing channel (after reconnect).

```typescript
// Hub → Agent
{ type: "ATTACH", channel_id: string, request_id?: string }

// Agent → Hub
{
  type: "ATTACH_OK",
  channel_id: string,
  request_id?: string,  // the ATTACH's, echoed
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

An ATTACH the agent cannot answer, for a channel it does not have or cannot see (§ 3.1b), gets
`ERROR { code: "CHANNEL_NOT_FOUND", channel_id, request_id }`. The hub names every ATTACH with a
`request_id`, and the agent echoes it in the ATTACH_OK or the ERROR that answers it, and in nothing
else. That is how the hub tells the answer from an ERROR about the same channel for another reason:
an INPUT or a RESIZE to a terminal the agent does not have gets the same `CHANNEL_NOT_FOUND` with
the same `channel_id`, and an INPUT can get `INPUT_DROPPED` (§ 3.4), while an ATTACH waits (#767).
An ERROR without the ATTACH's `request_id` never answers it, and is handled as itself.

The agent answers every ATTACH it receives, and at once. The snapshot comes from the channel's
reader, which serves it while it reads the PTY. Once the PTY has closed, the channel is ending: an
ATTACH whose request finds that reader gone, or reaches it as it stops and is dropped, gets the
same `CHANNEL_NOT_FOUND` as one for a channel the agent no longer has, with its `request_id`. It
does not wait for the channel's workload to exit, and the hub never waits out its 5 s for it
(#777).

`request_id` is optional both ways. An agent older than it answers without one: the hub matches its
ATTACH_OK by `channel_id`, which only an ATTACH can produce, and an ATTACH such an agent refuses
goes unanswered until the hub stops waiting (5 s), when the hub answers its client from the spool
(§ 4.2). A hub older than it sends none, and is answered without one, as before.

### 3.4 INPUT (Hub → Agent)

```typescript
{
  type: "INPUT",
  channel_id: string,
  data: Uint8Array       // raw bytes
}
```

The agent queues each channel's INPUT and writes it to the PTY in order, apart from the connection's
other messages: a terminal that takes no input holds up nothing else (#740). A channel's queue holds at
most 1 MiB. An INPUT that would take it past that is dropped whole, and so is every INPUT to that channel
after it until its terminal has taken what is queued. The first one dropped is answered with
`ERROR { code: "INPUT_DROPPED", channel_id }`; the rest of that gap is dropped without one. The hub
relays each one to the clients attached to that channel as `INPUT_DROPPED` (§ 4.12), and the pane
says in its terminal that what was typed was dropped because the terminal is not taking input.

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

Agent MUST resize both the PTY and the channel's `vt100` screen, so the next snapshot has the new size.

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

An agent answers HEARTBEAT with HEARTBEAT_ACK. The hub sends none today, and judges no agent by
it: a remote host that stops answering is found by the SSH keepalive (SPEC.md § 5.5), and a local
daemon's connection ends when the daemon does.

### 3.11 ERROR

```typescript
{
  type: "ERROR",
  code: string,
  message: string,
  channel_id?: string,
  other_owner_channels?: number,  // OTHER_HUBS_HOLD_CHANNELS only (§ 3.17)
  request_id?: string             // on the ERROR that answers an ATTACH only: its request_id (§ 3.3)
}
```

Of the ERRORs that carry a `channel_id`, only one carrying an ATTACH's `request_id` answers a
request (§ 3.3). The others speak of that channel and answer nothing the hub waits on: the hub
relays `INPUT_DROPPED` to that channel's clients (§ 3.4) and does nothing with the rest.

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
  other_owner_channels: number    // channels other hubs hold on this daemon
}
```

The list holds only the channels of the connection's owner (§ 3.1b), sent
once the daemon has read the AUTH. What the owner's terminals sent while it had no connection comes
before it (§ 2.1b), so a hub may get OUTPUT or CHANNEL_EXIT before CHANNEL_STATE_END. Every channel in it is therefore this hub's, and one the hub does
not know — neither tracked nor recorded as alive, such as a SPAWN whose answer was lost — is its own
orphan: the hub sends it DESTROY, and logs how many once, at INFO. `other_owner_channels` counts the
channels of other owners. It is informational: the hub shows it with the host's session state
(§ 4.7) and never acts on those channels, which it cannot name anyway.

**Reconnect handshake flow (daemon mode):**
```
Hub connects to daemon UDS
  │
  Agent → Hub: HELLO { version, capabilities, ... }
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
    └─ one the hub does not know → DESTROY
  │
  Normal operation (SPAWN, INPUT, OUTPUT, etc.)
```

On a fresh daemon start (no prior channels), the agent sends HELLO followed immediately by CHANNEL_STATE_END (zero AGENT_CHANNEL_STATE messages).

**An answer speaks of the terminals as they were when it was asked** (#599). A remote daemon's
connection is the way to its host before its list arrives, so a pane can start a terminal meanwhile:
one brought back under its own id, or a new one. The list does not name it, and its SPAWN_OK can be
read before the list. So the hub notes when it asks — before the AUTH, and before each ATTACH — and
stamps each terminal with when its SPAWN_OK arrived. A list, or an ATTACH answered "channel not
found", judges only a terminal started before the question and not being started again right now;
anything else is its start's to answer for. The judgement is made as the answer arrives, before any
client can hear of an end it decides, so no pane can bring a terminal back before it has been judged.
An attach that waited for the host to be reached starts over once it has: that reconnect's own list
may have judged the terminal already, and asking the daemon about it again would only ask about one
already judged.

### 3.17 STOP (Hub → Agent, daemon mode)

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

The hub's `requestDaemonStop` does not count DISPLACED or a hub-issued close as confirmation;
a close while the hub is quitting is also unconfirmed. Replace's response is defined in § 6.

The hub sends it to every daemon. It takes the count from the refusal's `other_owner_channels`
when that is a whole number of zero or more, and knows none otherwise. It never reads a count out
of the message. When no protocol
connection can carry the STOP, the hub runs the agent's own `--stop` instead: the out-of-band path,
which knows nothing of owners. See `POST /api/hosts/:id/agent/replace` (§ 6).

### 3.18 ENV_QUERY / ENV (`env-modes`)

```typescript
// Hub → Agent
{ type: "ENV_QUERY", request_id: string, mode: "inherit" | "minimal" }

// Agent → Hub
{
  type: "ENV",
  request_id: string,
  env: Record<string, string>,  // names kept as the agent has them
  os: string                    // "linux", "windows", "darwin"…: how the names compare
}
```

The variables a terminal would start with in `mode`, before any profile changes them: steps 1 to 3
of the environment a SPAWN builds (§ 3.2). Agent-wide, not scoped to the connection's owner
(§ 3.1b): it is what any hub could read by typing `env` in a terminal it opens there, and it is
asked over that hub's own authenticated connection. Stdio and daemon agents both answer it. The
values can be secrets: neither side stores or logs them, at any level. The hub sends it for
`GET /api/hosts/:id/agent-environment` (§ 6).

### 3.19 LOG (Agent → Hub)

```typescript
{
  type: "LOG",
  channel_id: string,   // empty when the line is about no channel, e.g. a SPAWN that failed
  level: string,        // "trace", "debug", "info", "warn" or "error"
  msg: string
}
```

A diagnostic about a channel: a SPAWN that failed, at `error`, or a PTY that closed, at `debug`.
The hub writes it to that channel's log when it keeps one, else to its own log under the channel's
id, and reads any other level as `info`. It never reaches a client.

## 4. Message Types — Hub ↔ UI (WS)

### 4.1 AUTH

```typescript
// UI → Hub (must be first message)
{ type: "AUTH", token: string }

// Hub → UI
{ type: "AUTH_OK", client_id: string, echoes_spawn_request_id?: true }
{ type: "AUTH_FAIL", message: string }
```

`echoes_spawn_request_id` says that this hub echoes a SPAWN's `request_id` in everything that
answers it (§ 4.4, #777). A hub older than it leaves it out.

A first frame that is not AUTH is also answered `AUTH_FAIL`, and the socket closed. A socket that
sends no AUTH within 10 s is closed with code `4001`, reason `AUTH_TIMEOUT`.

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
  cached: boolean,             // true = from local cache, agent unreachable
  truncated?: true,            // output after the snapshot was too much to send, and is left out
  dynamic_title?: string,      // the title the terminal set (OSC 0/2), when it set one
  process_title?: string,      // its foreground process, when known
  display_title: string        // the title a tab shows
}

// UI → Hub
{ type: "DETACH", channel_id: string }
```

An ATTACH on a terminal that has ended is answered `ERROR { code: "CHANNEL_DEAD", channel_id }`,
whether the hub still holds it in memory or only in meta.db, and whether its host is connected or
not. One the hub has no record of is answered `CHANNEL_NOT_FOUND`. An ATTACH never starts a
terminal: bringing an ended one back is a SPAWN that names it, which is the user's Restart (#559).

The answer is what a pane shows, and a pane attaches again whenever its socket is replaced: an
ATTACH_OK from the terminal leaves it uncovered, one with `cached: true` shows it is not connected,
and `CHANNEL_DEAD` shows it has ended, whatever the pane showed before.

### 4.3 INPUT / OUTPUT / RESIZE

Same as agent messages (section 3.4–3.6).
Hub verifies write-lock on INPUT. Rejects with ERROR (`WRITE_LOCK_DENIED`) if not holder.
Hub passes RESIZE on to the agent and stores the size; it sends it to no other client.

### 4.4 SPAWN / SPAWN_OK

```typescript
// UI → Hub
{
  type: "SPAWN",
  host_id: string,
  request_id?: string, // a ULID naming this SPAWN, echoed in what answers it (below)
  shell?: string,     // default: the launch profile's, else the host's first profile's, else none: the agent's default (§ 3.2)
  args?: string[],    // default: taken with the shell, as above
  cwd?: string,       // default: the launch profile's, else none: the agent starts the shell in its user's home (§ 3.2)
  env?: Record<string, string>,  // set over the scopes' and the launch profile's (max 256 entries)
  cols?: number,      // 1 to 500; default 80
  rows?: number,      // 1 to 500; default 24
  launch_profile_id?: string,  // the launch profile to start; the request's own fields win
  direct_process?: boolean,    // default: the launch profile's `mode` is `process`
  elevated?: boolean, // default: the launch profile's; ignored on an SSH host
  group_id?: string,  // optional channel group to place new channel in
  reuse_channel_id?: string,  // bring this ended terminal back under its own id (Restart)
  automatic?: boolean  // nobody asked for it: "When a terminal ends", or its host's return (#648)
}

// Hub → UI
{ type: "SPAWN_OK", channel_id: string, host_id: string, session_id: string, request_id?: string }
```

A SPAWN that names itself with `request_id` gets it back in the SPAWN_OK and in every ERROR that
answers it, the refusal of a field it carries included, and in nothing else (#777). A window's
socket carries every ERROR the hub has for it: another pane's ATTACH refused, a write lock denied,
an input refused. Most name no host, and only the id tells the SPAWN's answer from them. A
`request_id` that is not a ULID is refused with `INVALID_INPUT`, without it.

`request_id` is optional both ways. A client that sends none is answered without one, as before.
A client of a hub whose `AUTH_OK` says `echoes_spawn_request_id` takes an answer as its SPAWN's
only if it carries that SPAWN's id. One of an older hub, which names no answer, matches them as
before: an answer naming another host, or another terminal than the one it brings back, is not
its own, and the first other one is. The web sends one with every SPAWN.

A SPAWN with `reuse_channel_id` is refused with `ERROR { code: "CHANNEL_NOT_REUSABLE",
channel_id }`, and starts nothing, when that terminal is not one this hub knows, belongs to
another host, is still running, or is already starting: another SPAWN naming it, or a
`POST /api/channels/:id/restart`, was accepted and has not had its answer yet. The id is claimed
as the SPAWN is accepted, with no await between the check and the claim, and released once the
hub has the agent's answer, by which time the terminal is live or did not start. Two windows
following "When a terminal ends" over the same terminal therefore start it once (#592).

A SPAWN, new or with `reuse_channel_id`, whose host is away is refused with
`ERROR { code: "HOST_UNREACHABLE", host_id, host_status, channel_id? }` (#605). `channel_id`
names the terminal being brought back, and is absent for a new one. It says nothing about the
terminal: started again once the host is back, it may well run. Two cases:

- **At once**, starting nothing, when the hub lost that host and is reaching for it again: its
  connection dropped, and a reconnect is scheduled or under way. `host_status` is
  `"disconnected"`. The next attempt is the reconnect's; the SPAWN neither opens a second
  connection beside it nor waits out a host that does not answer. A host the hub is not
  reaching for, a first terminal there or one whose reconnect gave up, is still connected by the
  SPAWN itself, and a local host's agent still started by it.
- **After the agent's ten seconds**, when the connection the SPAWN went over went down
  meanwhile: `host_status` is what the host's session is then, `"disconnected"` while the hub
  reaches for it again, or `"active"` when it came back over another connection. A SPAWN left
  unanswered over a connection that is still up is the terminal's failure, `SPAWN_FAILED`, as
  before, and so is one whose host the hub has stopped reaching for.

A client waits for that host's `SESSION_STATE` to say it is `active` (or `detached`) again,
rather than show a failure (§ 4.14). Its own deadline for a SPAWN is longer than the hub's ten
seconds, so that it hears the hub's answer.

A host its user disconnected (`POST /api/hosts/:id/disconnect`, § 6, #648) is not connected
again by a start nobody asked for. A SPAWN with `automatic: true` on it is refused at once with
the same `HOST_UNREACHABLE`, `host_status` being its session's status, or `"closed"` when it has
none; its pane waits for the host as above, and starts its terminal once someone connects it.
Any other SPAWN on it, a new terminal or a Restart someone pressed, is that person acting on the
host: the hub stops holding back, and connects it as for a first terminal. The web sends
`automatic: true` for a terminal brought back by "When a terminal ends", by a choice made on
another pane's overlay, or by its host's return; `automatic` changes nothing on any other host.

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
    other_owner_channels?: number,                            // as in SESSION_STATE
    connected_through_remote_daemon?: boolean,                 // as in SESSION_STATE
    sftp_unavailable?: true,                                   // as in SESSION_STATE
    socket_forwarding_refused?: true                           // as in SESSION_STATE
  }>,
  channels: Array<{
    channel_id: string,
    session_id: string,
    status: "born" | "live" | "orphan" | "dead",
    exit_code?: number,
    display_title?: string,
    // Only on a "dead" entry: "killed", as on CHANNEL_STATE (§ 4.7) (#592).
    end_reason?: "killed"
  }>,
  // The hosts their user disconnected (#648), with a session or without one: a host
  // whose connection ran its terminals has none left. Absent when there are none.
  user_disconnected_hosts?: string[]
}
```

`channels` lists every channel the hub holds that has not ended, and every one killed
that it still lists: `dead`, with `end_reason: "killed"`, read from
`channels.end_reason` in meta.db (STORAGE.md § 3.4). A window that was away when such a
terminal was killed, or that opens later, learns it here rather than from a report it
never heard, and no pane of it brings the terminal back (#592). A terminal `stopped`
with its agent or the hub is not listed: a pane that finds it ended follows its setting
anyway, and reads the reason from the channel list if it wants it. Any other channel
absent from `channels` has ended, or is unknown.

### 4.7 State Notifications

```typescript
{
  type: "SESSION_STATE",
  // StateBroadcaster.agentStatusOn: true only for a connected SshAgent using a daemon.
  // Absent after release, which re-announces the session. Adopting a daemon connection
  // re-announces it when the session is already active; otherwise the next publication
  // carries it.
  connected_through_remote_daemon?: boolean,
  session_id: string,
  host_id: string,
  status: "starting" | "active" | "detached" | "disconnected" | "closed",
  // Only when the agent serving the host is not the version this hub carries (#456).
  outdated_agent?: { running: string, expected: string },
  // Only when other hubs hold channels on that agent, as its CHANNEL_STATE_END said
  // (§ 3.16, #127). Informational: replacing the agent would end them too. Sent
  // again with the same status once the count is known.
  other_owner_channels?: number,
  // Only when the SSH server the host's connection reached refused the SFTP
  // subsystem, which the hub asks once per connection, as soon as it is up (#722).
  // A note, not an error: the hub sends its agent over an exec channel there
  // (SPEC.md § 3.5). Said from the first SESSION_STATE of that connection, and
  // absent once another connection serves the host.
  sftp_unavailable?: true,
  // Only when the host keeps a daemon (#79) and the hub saw its SSH server refuse the
  // socket forwarding a daemon is reached through (#765): the hub runs the agent on
  // stdio there, so the host's terminals end with its connection (SPEC.md § 3). A note,
  // not an error. Remembered in the hub's memory for the route it was seen on, so said
  // with or without a connection, until that route changes, a person's Connect or
  // Reconnect of the host asks the server again, or the hub restarts.
  socket_forwarding_refused?: true,
  // Only while the host's user has disconnected it (POST /api/hosts/:id/disconnect,
  // § 6, #648): the hub does not reach for it again until someone acts on it. Every
  // SESSION_STATE of that host carries it until then, and none after: a client takes
  // its absence as the flag gone. A client shows such a host apart from one merely
  // offline, or one the hub lost.
  disconnected_by_user?: true
}

// Hub → every client, attached to the channel or not: each one holds every
// channel in its state, as STATE_SYNC gives it (#559).
// A status can be said again without having changed: once a host is reached
// again, a terminal it still runs that has clients attached is said to be
// "live", since their last ATTACH_OK may have been `cached` (#556).
{
  type: "CHANNEL_STATE",
  channel_id: string,
  session_id: string,
  status: "born" | "live" | "orphan" | "dead",
  exit_code?: number,
  // Only with "dead", when the hub ended the terminal itself (#580). Absent when
  // its shell or command exited, or when the hub found it gone. Stored with the
  // end in channels.end_reason and cleared when the terminal runs again, so
  // the channel list (§ 6) carries it too, and STATE_SYNC (§ 4.6) a "killed" (#592).
  end_reason?: "killed" | "stopped"
}

// end_reason "killed": that terminal, or its session, was stopped on purpose.
//   - DELETE /api/channels/:id on a live channel (the UI's Kill), including one
//     this hub run does not hold, which it marks dead with the reason directly;
//   - DELETE /api/sessions/:id, for every terminal of that session.
// end_reason "stopped": it ended with its agent or its hub, which nobody aimed at it.
//   - POST /api/hosts/:id/agent/replace, for each CHANNEL_EXIT the stopping agent
//     sends while the hub stops it, and, once the stop is confirmed, for every other
//     terminal the hub held on that host: a daemon's connection ends before its
//     terminals' CHANNEL_EXITs reach the hub (#599);
//   - quit (POST /api/quit), for every "dead" the hub reports once it is quitting and
//     that was not a kill: the local agent's CHANNEL_EXITs, and the session closing
//     when it goes.
// A client never restarts or closes a terminal on such an end as it happens, whatever
// "When a terminal ends" says, and shows that it was stopped from elsewhere: a kill
// was meant, and acting on a stop would race the replacement or the quit (#580).
// Found later, at a reload or the next launch, an end follows the setting once its
// pane is on screen in the window that has the focus (#592), save a "killed" one,
// which keeps asking: the pane reads the reason from STATE_SYNC or the channel list.

// Hub → ALL connected clients: a new channel was created by any client.
// Observers use this to add the channel to their list without a fetchChannels.
// The spawning client receives it too and deduplicates (no-op if already present).
{
  type: "CHANNEL_CREATED",
  host_id: string,
  channel_id: string,
  session_id: string,
  shell?: string,       // absent: none of its own, its agent's default (#583)
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

The hub answers a PING with a PONG. No client sends one on a timer today, and the hub closes no
socket for a missing one.

### 4.9 HOST_VERIFY (SSH Fingerprint)

```typescript
// Hub → UI (unknown host key, or key mismatch warning)
{
  type: "HOST_VERIFY",
  host_id: string,
  fingerprint: string,         // "SHA256:<base64>", unpadded as OpenSSH prints it
  algorithm: string,           // the fingerprint's hash: "SHA256"
  old_fingerprint?: string,    // set when stored key differs — MITM warning
  prompt_id: string,           // correlation ID, echoed in the response
  delivery_epoch: number,      // as on AUTH_PROMPT (§ 4.10); not echoed
  first_connect?: boolean,     // no key pinned for this host yet
  hostname?: string,           // the address that presented the key
  known_hosts?: {              // what this machine's OpenSSH already says about the key (SECURITY.md § 3.3)
    verdict: "trusted" | "other-key",
    file: string,
    line: number               // 1-based
  }
}

// UI → Hub (user decision)
{
  type: "HOST_VERIFY_RESPONSE",
  host_id: string,
  action: "trust_permanent" | "trust_once" | "reject",
  prompt_id: string            // echoes HOST_VERIFY's prompt_id
}
```

The hub answers a response without a `prompt_id`, or with another `action`, with an
`INVALID_INPUT` error. It ignores a response from any client but the one the prompt was last sent
to.

### 4.10 AUTH_PROMPT / AUTH_PROMPT_RESPONSE (SSH Credentials)

Used when the hub needs to obtain a secret from the user interactively during SSH connection (password auth, key passphrase, or elevation prompt).

```typescript
// Hub → UI
{
  type: "AUTH_PROMPT",
  host_id: string,
  prompt_type: "password" | "passphrase" | "elevation",
  message: string,   // human-readable prompt text (e.g. "Enter password for user@host")
  prompt_id: string, // correlation ID, echoed in the response
  delivery_epoch: number // rises each time the prompt is sent again to another client
}

// UI → Hub
{
  type: "AUTH_PROMPT_RESPONSE",
  host_id: string,
  secret: string | null,   // null = user cancelled
  remember_session?: boolean,  // a key's passphrase: keep it in the hub's memory for 15 min
  prompt_id: string,       // echoes AUTH_PROMPT's prompt_id
  delivery_epoch: number   // echoes AUTH_PROMPT's delivery_epoch
}
```

The hub answers a response without a valid `prompt_id` or `delivery_epoch` with an `INVALID_INPUT`
error. It ignores a response from any client but the one the prompt was last sent to, and one whose
`delivery_epoch` is not the prompt's latest.

```typescript
// Hub → UI: dismiss a prompt the hub no longer waits on
{ type: "PROMPT_CANCEL", prompt_id: string }
```

The hub sends PROMPT_CANCEL for an AUTH_PROMPT, a HOST_VERIFY (§ 4.9) or an AGENT_BINARY_VERIFY
(§ 4.15) to the client it asked: when it asks another client instead, which gets the prompt again
with a higher `delivery_epoch`, and when the connection the prompt was for is given up.

**Security note:** The hub writes none of these secrets to disk. A password is used for the SSH
handshake and dropped. A key's passphrase is kept in the hub's memory, per host, for 60 s, or 15 min
with `remember_session`, so that a reconnect needs no prompt. An elevation password is kept in the
hub's memory, per host and client, for 5 min when it was typed to open an elevated terminal and
15 min when it was typed to restart one, and sent to the agent in the SPAWN that needs it
(SECURITY.md § 4.3).

### 4.11 TEST_CONNECT (SSH Connectivity Test)

Allows the UI to test SSH connectivity for a host without creating a full session, through its declared jump under the session's jump rules (`docs/SECURITY.md` §3.3b). The hub may send `AUTH_PROMPT` messages for the target or bastion and `HOST_VERIFY` for the target; an unknown bastion is refused without a `HOST_VERIFY`, possibly after its credential was asked for. Invalid proxy fields receive `TEST_CONNECT_FAIL` with the request's `host_id`.

The optional `platform` reports `system`, optional `os` and `arch`, `agent` (`ready`, `download`, `unsupported`, or `unknown`), and `agentVersion`.

```typescript
// UI → Hub
{
  type: "TEST_CONNECT",
  host_id: string,       // real host ID for saved hosts, client-generated temp ID for unsaved
  hostname: string,
  port: number,
  ssh_auth: "agent" | "key" | "password",
  ssh_key_path?: string,
  ssh_user?: string,
  ssh_proxy_host_id?: string, // saved jump host; mutually exclusive with spec
  ssh_proxy_spec?: string    // ProxyJump address
}

// Hub → UI (success)
{ type: "TEST_CONNECT_OK", host_id: string, platform?: TestConnectPlatform }

// Hub → UI (failure)
{ type: "TEST_CONNECT_FAIL", host_id: string, message: string }
```

### 4.12 Terminal Event Relay (Hub → UI)

These messages originate from the agent (see §3.12–3.15, above, and § 3.4) and are relayed by the hub to all UI clients attached to the affected channel.

```typescript
// Terminal title changed (OSC 0/2)
{ type: "TITLE_CHANGE",   channel_id: string, title: string, display_title?: string }

// Foreground process name changed
{ type: "PROCESS_TITLE",  channel_id: string, title: string, display_title?: string }

// Terminal bell (\x07)
{ type: "BELL",           channel_id: string }

// OSC 9 desktop notification
{ type: "NOTIFICATION",   channel_id: string, message: string }

// Input typed into this terminal was dropped: it takes no input (§ 3.4, #767)
{ type: "INPUT_DROPPED",  channel_id: string }
```

`INPUT_DROPPED` is the agent's `ERROR { code: "INPUT_DROPPED" }`, relayed once per gap as the agent
says it, under a type of its own: a client waiting on an answer to its own request takes an ERROR for
that answer, and this one answers nothing. The pane writes a dimmed line of its own in the terminal,
saying that what was typed was dropped because the terminal is not taking input.

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
{
  type: "ERROR",
  code: string,
  message: string,
  channel_id?: string,
  host_id?: string,
  host_status?: "starting" | "active" | "detached" | "disconnected" | "closed",  // on HOST_UNREACHABLE only: the host's session, as SESSION_STATE says it (§ 4.7)
  request_id?: string  // on an ERROR that answers a SPAWN naming itself only: its request_id (§ 4.4)
}
```

**Error codes:**

An unknown or refused token is not an ERROR: it is `AUTH_FAIL` (§ 4.1).

| Code | Meaning |
|------|---------|
| `MALFORMED_MESSAGE` | The frame does not decode as MessagePack |
| `INVALID_INPUT` | A field the hub checks is refused: an id that is not a ULID, `cols` or `rows`, `shell`, `cwd`, `env`, INPUT over 64 KiB, a prompt's answer |
| `CHANNEL_NOT_FOUND` | ATTACH on a terminal the hub has no record of (§ 4.2) |
| `CHANNEL_DEAD` | ATTACH on a terminal that has ended (§ 4.2) |
| `CHANNEL_NOT_REUSABLE` | SPAWN with `reuse_channel_id` refused; `channel_id` names that terminal (§ 4.4) |
| `WRITE_LOCK_DENIED` | INPUT from a client that does not hold the write lock; carries `channel_id` |
| `HOST_NOT_FOUND` | SPAWN on a host this hub does not list; carries `host_id` |
| `HOST_BUSY` | SPAWN refused while Replace holds the host, at `SessionManager.spawnOnHost` or, for one already under way, before its frame is written: "This host's agent is being stopped." |
| `HOST_UNREACHABLE` | SPAWN refused because its host is away: the hub is reconnecting it, or lost it while the terminal started, or, for a SPAWN marked `automatic`, its user disconnected it (#648). Carries `host_id` and `host_status`, and `channel_id` for a terminal being brought back (§ 4.4, #605) |
| `HUB_QUITTING` | SPAWN refused: the hub is quitting |
| `SSH_CONNECT_FAILED` | The SSH connection a SPAWN needed failed |
| `SSH_HOST_KEY_REJECTED` | The user rejected the host's key (§ 4.9) |
| `SSH_HOST_KEY_REVOKED` | The host's key is marked `@revoked` in a `known_hosts` file; carries `host_id` |
| `SSH_JUMP_UNUSABLE` | The host's jump cannot be used (SECURITY.md § 3.3b); carries `host_id` |
| `AGENT_BINARY_REJECTED` | The user refused the agent binary found on the host (§ 4.15); carries `host_id` |
| `AGENT_BINARY_UNTRUSTED` | The agent binary found on the host cannot be checked; carries `host_id` |
| `AGENT_NOT_AVAILABLE` | The hub has no agent binary for the host, and could not fetch one; carries `host_id` |
| `AGENT_VERSION_MISMATCH` | The agent the hub deployed reports another version than the hub's. Sent to every client, with `host_id` |
| `ELEVATION_CANCELLED` | The user cancelled the password an elevated SPAWN needs (§ 4.10) |
| `INVALID_CUSTOM_COMMAND` | The custom elevation command is not one the hub runs |
| `SPAWN_FAILED` | A SPAWN failed for another reason, the agent's ten seconds running out included |
| A SPAWN_ERR code | The agent refused the SPAWN: its code is passed on (Agent Error Codes, § 6) |

### 4.15 AGENT_BINARY_VERIFY (Remote Agent Binary)

```typescript
// Hub → UI: an agent binary on an SSH host that no one here has approved
{
  type: "AGENT_BINARY_VERIFY",
  prompt_id: string,
  delivery_epoch: number,      // as on AUTH_PROMPT (§ 4.10); not echoed
  host_id: string,
  hostname: string,
  remote_path: string,
  remote_sha256: string,
  os: "linux" | "darwin" | "windows",
  arch: "x64" | "arm64",
  mismatch: boolean,           // true: it is not the binary pinned for this host
  pinned_sha256?: string       // the pinned hash, when mismatch
}

// UI → Hub
{
  type: "AGENT_BINARY_VERIFY_RESPONSE",
  prompt_id: string,
  action: "trust_permanent" | "trust_once" | "reject"
}
```

`trust_permanent` pins the hash on the host, `trust_once` trusts it for this hub run, and `reject`
ends the connection with `AGENT_BINARY_REJECTED` (§ 4.14). The response is checked and routed as
HOST_VERIFY_RESPONSE's is (§ 4.9).

### 4.16 AGENT_SYNCED (Hub → UI)

```typescript
{ type: "AGENT_SYNCED", host_id: string, hostname: string, message: string }
```

Sent to every client when the hub has replaced the agent binary on an SSH host with its own. A
daemon already running there still answers until it is replaced (§ 4.7, `outdated_agent`).

### 4.17 CONFIG_CHANGED (Hub → UI)

```typescript
{
  type: "CONFIG_CHANGED",
  scope: "ui" | "appearance" | "global" | "host" | "channel",
  host_id?: string,     // scope "host"
  channel_id?: string   // scope "channel"
}
```

Sent to every client once configuration is written, so each reads that scope again (#479):
`PUT /api/config/ui` (`ui`), `PUT /api/config/appearance` and every theme write (`appearance`),
`PUT /api/config/global` (`global`), and `PATCH` of a host's or a channel's profile (§ 6).

## 5. Protocol Sequences

### 5.1 Local Session

```
UI                          Hub                        Local agent (daemon)
 │── AUTH ──────────────────►│                           │
 │◄── AUTH_OK ──────────────│                           │
 │── SPAWN {host:"local"} ─►│── SPAWN {shell} ─────────►│── spawn PTY
 │                           │◄── SPAWN_OK {ch_id} ─────│
 │◄── SPAWN_OK {ch_id} ────│                           │
 │── ATTACH {ch_id} ───────►│── SNAPSHOT_REQ ──────────►│
 │◄── ATTACH_OK {snapshot} ─│◄── SNAPSHOT_RES ──────────│
 │── INPUT {data} ──────────►│── INPUT ─────────────────►│── pty.write()
 │◄── OUTPUT {data} ────────│◄── OUTPUT ────────────────│◄── PTY output
 │── RESIZE {cols,rows} ───►│── RESIZE ────────────────►│── pty.resize()
 │── DETACH ────────────────►│── channel → ORPHAN        │
```

The hub reaches the local agent over its daemon socket, having sent AUTH after its HELLO
(§ 3.1b); it never opens a PTY itself.

### 5.2 Remote Session

```
UI                          Hub                        Agent
 │── AUTH ──────────────────►│                           │
 │◄── AUTH_OK ──────────────│                           │
 │── SPAWN {host:"prod"} ──►│── ssh2.connect() ────────►│
 │                           │◄── HELLO ────────────────│
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

A host that keeps a remote daemon (SPEC.md § 3.2):

```
Hub                        Agent (remote daemon)
 │ ×× SSH drops ×× ─────────│ (agent keeps PTYs)
 │── retry 1s ───────────►  fail
 │── retry 2s ───────────►  fail
 │── retry 4s ───────────►  success
 │◄── HELLO ─────────────────│
 │── AUTH {token:"", hub_key}►│ (§ 3.1b)
 │◄── AGENT_CHANNEL_STATE ───│ (ch-1, alive)
 │◄── CHANNEL_STATE_END ─────│
 │  adopt ch-1; resume OUTPUT │
```

On stdio the agent ended with the connection. The reconnect starts a new agent, and the hub
sends it a SPAWN for each terminal that had not ended, naming its `channel_id`: a new shell under
the same id. The backoff and the five-minute limit are in SPEC.md § 5.5.

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

Base: `https://127.0.0.1:<port>/api`, the port `runtime.json` records (SPEC.md § 7)
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

#### Ending the hub

| Method | Path | Auth | Body / Notes |
|--------|------|------|--------------|
| POST | `/api/shutdown` | owner | Stops the hub alone. The local agent keeps its terminals for the next hub. `lasterm stop` |
| POST | `/api/quit` | owner | Stops the local agent first, and its terminals end, then the hub. The desktop's **Quit completely**, `lasterm quit` |

Only the hub's owner may end it (#142, SPEC.md § 3.3): both routes take the owner token and a
loopback connection. The bearer token is neither needed nor enough, so a paired client can drive
the hub but never end it.

- `X-Lasterm-Owner` (required): `ownerToken` from `runtime.json`, which the hub draws anew at each
  start and compares in constant time. Only a process of the hub's OS user, on its machine, can
  read that file.
- `X-Lasterm-Client-Id` (optional; `X-Lasterm-Client` is read when it is absent): the `client_id`
  the caller's own WebSocket received in `AUTH_OK` (§ 4.1), so that the caller is not counted among
  the other clients. The desktop sends it. `lasterm stop` and `lasterm quit` have no WebSocket and
  send none, so every connected client counts.
- `?force=1`: end the hub even while other clients are connected. Any other value is not a force.

Answers, in the order the hub checks:

| Status | Body | When |
|--------|------|------|
| 401 | `{ error: "OWNER_TOKEN_REQUIRED", message }` | `X-Lasterm-Owner` is missing or is not this hub's. Checked first, so a request that also comes from off loopback gets this one |
| 403 | `{ error: "LOOPBACK_REQUIRED", message }` | The connection does not come from `127.0.0.0/8`, `::1` or `::ffff:127.0.0.1` |
| 501 | `{ ok: false, error: "QUIT_UNAVAILABLE", message: "Quit is unavailable" }` | `/api/quit` only: this hub has no quit to run, no quit lifecycle or no session layer and so no agent to stop (#538). Nothing was begun, and no teardown follows |
| 409 | `/api/shutdown`: `{ others }`. `/api/quit`: `{ others, message }` | `others` WebSocket clients besides the caller are connected, and the request has no `?force=1`. Nothing was stopped. Once a quit has begun, `/api/quit` skips this check: a second request joins that quit and gets its answer |
| 200 | `/api/shutdown`: `{ ok: true }`. `/api/quit`: `{ ok: true, message, override?, stdout?, stderr? }` | `/api/shutdown`: always, past the checks above. `/api/quit`: the local agent confirmed it stopped |
| 503 | `/api/quit`: `{ ok: false, message, override?, stdout?, stderr? }` | The stopper did not confirm that the local agent stopped; `message` says why. The hub tears down all the same |
| 500 | Fastify's error | `/api/quit` threw before it scheduled any teardown, for instance on a quit asked before startup finished |

After a 200, `/api/shutdown` closes the hub's listener and its connections to agents, closes its
databases, withdraws `runtime.json` and exits 0. The local agent daemon keeps running, and its
terminals with it: the next hub takes them back (§ 5.4). A shutdown that arrives during a quit
joins that quit instead of running a teardown of its own.

`/api/quit` first latches the hub, so that no session starts or reconnects from then on. It then
runs the local agent's own stopper, `lasterm-agent --stop` for the agent's socket, bounded at
12 s. The stopper checks the daemon's identity record before stopping it, and the daemon's
terminals end with their process trees. Only then does the hub answer, 200 or 503. `stdout` and
`stderr` carry the stopper's output, its last 8 KiB each, when it printed any. `override: true`
records that the request carried `?force=1`, not that a person confirmed anything. Once the answer
is sent, the hub tears down as `/api/shutdown` does, and exits 0 after a 200 and 1 after a 503.
The local agent can serve more than one local hub of the same OS user (#127), and the terminals
of every hub it serves end. With the agent and the hub gone, nothing holds their executables open any
more, which is what an update needs.

What the callers do with the answers:

- `lasterm stop`: on a 409, prints the count and exits 1. `--force` sends `?force=1`.
- `lasterm quit`: on a 409, asks on a terminal for `quit` to be typed and sends the request again
  with `?force=1`, and refuses when there is no terminal to ask on. After a 200, a 503 or an answer
  that never came, it waits up to 15 s for this hub, by its `instanceId`, to withdraw
  `runtime.json` and exit. A second 409, any other 4xx, a 501 or a 500 began nothing, and it says
  so without waiting.
- The desktop's **Quit completely**: on a 409, asks in a native dialog before sending the request
  again with `?force=1`. After a 200, a 503 or an answer that never came, it waits for the hub to
  go, as `lasterm quit` does.

#### Hosts

| Method | Path | Auth | Body / Notes |
|--------|------|------|--------------|
| GET | `/api/hosts` | ● | `Host[]`, or a page with `?limit=&offset=` (see Pagination) |
| POST | `/api/hosts` | ● | CreateHost → `Host` (201) |
| PUT | `/api/hosts/order` | ● | `{ group_id, host_ids }` → 204 |
| GET | `/api/hosts/:id` | ● | `Host` |
| PUT | `/api/hosts/:id` | ● | UpdateHost → `Host` (partial update: each field sent replaces the stored one). 409 `CONFLICT` for a label in use |
| DELETE | `/api/hosts/:id` | ● | 204 |
| POST | `/api/hosts/:id/duplicate` | ● | → `Host` (201). The copy takes a free `<label>-copy`, `-copy-2`… label and the host's settings, jump, elevation and OS included, and goes into its group right after it, renumbering that group's `sort_order` (#746). Its pinned host key, jump key and agent hash are not copied: its first connection treats them as a new host's. 400 `VALIDATION_ERROR` for the local host or an unknown id |
| PUT | `/api/hosts/:id/welcome` | ● | `{ channel_id }` → `{ ok: true }`. 404 for an unknown channel, 400 `VALIDATION_ERROR` for one of another host |
| DELETE | `/api/hosts/:id/welcome` | ● | 204 |
| POST | `/api/hosts/:id/agent/replace` | ● | `{ force?: boolean }` → `{ replaced: true, message }`. Stops the remote daemon serving this host, ending every terminal it holds, so the next connection starts the agent this hub carries (#456). Once the stop is confirmed, every terminal this hub held there is reported dead with `end_reason: "stopped"` (§ 4.7, #599). The daemon gets STOP over the hub's own connection (§ 3.17): while other hubs hold terminals there it refuses, and the answer is 409 `{ error: { code: "OTHER_HUBS_HOLD_CHANNELS", message, other_owner_channels? } }`; the same request with `force: true` ends those too. One the STOP cannot reach is stopped with its own `--stop`. 409 `HOST_BUSY` while another Replace holds the host (`SessionManager.replaceAgent`). A displaced or hub-closed connection is not replaced: `requestDaemonStop` classifies it as unconfirmed, and Replace answers 409 `AGENT_NOT_REPLACED`. 409 `AGENT_NOT_REPLACED` when nothing was stopped for another reason, 400 `VALIDATION_ERROR` for a `force` that is not a boolean, 404 for an unknown host |
| GET | `/api/hosts/:id/agent-environment` | ● | `?mode=inherit\|minimal` (default `inherit`) → `{ mode, os, env }`: the variables a terminal on this host would start with in that mode, before any profile changes them, asked live of the agent over ENV_QUERY (§ 3.18) and answered with `Cache-Control: no-store` (#576). Never stored, never logged, names included. 409 `HOST_NOT_CONNECTED` when no agent of this host is connected to this hub, 504 `AGENT_TIMEOUT` after 5 s without an answer, 400 `VALIDATION_ERROR` for another mode, 404 for an unknown host |
| POST | `/api/hosts/:id/connect` | ● | `{ client_id? }` → 202 `{ status: "connecting", ended: 0 }`, or 200 `{ status: "connected" }` when it is already. Connects an SSH host and readies its agent, without starting a terminal (#648): the first connection of a terminal, less the terminal, through the same SPAWN acquisition, so a SPAWN, a restart or an attach meanwhile waits for it rather than dial again. What a remote daemon still holds is taken up; on stdio, terminals a lost link left waiting start again under their ids. It answers at once: the host's `SESSION_STATE` says `starting`, then `active`, or `closed` / `disconnected` when it failed. Its questions (host key, passphrase, agent binary) go to the window `client_id` names, the id its `AUTH_OK` gave it, or else to the first window connected; a failure is an `ERROR` sent to that window, as for a SPAWN. A pending automatic reconnect gives way to it |
| POST | `/api/hosts/:id/reconnect` | ● | `{ client_id?, force? }` → 202 `{ status: "connecting", ended }`. Closes the host's connection, then connects as above. A remote daemon keeps its terminals, taken up on the new connection. An agent on stdio ends with its connection, and its terminals with it (`end_reason: "stopped"`, § 4.7): unless `force` is `true`, the hub does nothing and answers 409 `{ error: { code: "TERMINALS_WOULD_END", message, terminals } }` with how many, for the client to ask its user and send `force: true`. With no connection up there is nothing to close and nothing ends |
| POST | `/api/hosts/:id/disconnect` | ● | `{ force? }` → 200 `{ status: "disconnected", ended }`. Closes the host's connection, and stops any reconnect waiting or under way. A remote daemon's terminals keep running on the host, their session `disconnected`, as after a hub restart. On stdio they end (`end_reason: "stopped"`) and the session closes; 409 `TERMINALS_WOULD_END` as for reconnect until `force: true`. The hub then marks the host disconnected by its user (`disconnected_by_user`, § 4.6, § 4.7) and does not reach for it again by itself: no reconnect after a lost link or a keepalive, none for a window attaching to its terminals (answered from the spool, `cached: true`), and no start marked `automatic` (§ 4.4), until someone acts on it: connect, reconnect, a new terminal there, or a terminal restarted there (SPAWN, or `POST /api/channels/:id/restart`). Kept in memory only: a hub restart forgets it, and reaches the host as it always did. A host with nothing connected, nothing connecting and no session answers 200 `ended: 0` and is not marked |
| POST | `/api/hosts/:id/agent/stop-keeping` | ● | `readStopKeepingBody` accepts `{ end_terminals?: boolean, force?: boolean }`; `SessionManager.stopKeepingAgent` tries to stop the remote daemon the host is connected through, and stores No after the attempt. 200 `{ outcome: "stopped", ended, host }` or `{ outcome: "disabled_not_stopped", message, host }`, with the saved host in the GET host shape. Admission and refusals are listed below |
| GET | `/api/hosts/:id/profiles` | ● | `LaunchProfile[]` (query: `?os=linux\|darwin\|windows`) |
| PUT | `/api/hosts/:id/profiles/:profileId` | ● | `{ override_type: "pin" \| "hide" \| "default", sort_order? }` → 204 |
| DELETE | `/api/hosts/:id/profiles/:profileId` | ● | 204 |

`SessionManager.stopKeepingAgent` admits requests in this order: 404 `NOT_FOUND`,
400 `NOT_SSH_HOST`, 409 `HUB_QUITTING`, 409 `HOST_BUSY` (stop or acquisition),
409 `HOST_NOT_CONNECTED`, then 409 `NO_DAEMON_CONNECTION` (connected over stdio).
`readStopKeepingBody` takes an absent or `null` body as empty, and rejects any other
non-object body or a non-boolean consent field with 400 `VALIDATION_ERROR`. Its consent
fields are optional; unknown fields are ignored.

The operation's refusal answers change nothing: 409 `TERMINALS_WOULD_END` carries
`error.terminals`, this hub's live terminals filed under that host, until
`end_terminals: true`. The daemon ends every terminal it holds, so terminals that
another host entry of this hub reaches through the same daemon, or a SPAWN not yet
answered, are not counted (#701); a STOP refusal answers
409 `OTHER_HUBS_HOLD_CHANNELS` with `error.other_owner_channels` when known.
A forced retry sends a forced STOP. When no STOP can be written, only a forced request goes on to
the agent's own `--stop`, over SSH: without a refusal, nothing says whether other hubs hold
terminals there.

`stopKeepingAgent` stores No only after the stop outcome. A confirmed stop closes
that host's session and ends the channels filed under it with `end_reason: "stopped"`. An
unconfirmed stop stores No, releases the connection, and publishes `disconnected`
with `disconnected_by_user`; its message says the agent may still be running.
A failed save answers 500: a confirmed stop still ends the session; an unconfirmed
stop keeps the connection as it is. Quitting during the wait saves nothing.

`registerHostCrudRoutes` validates PUT `ssh_remote_daemon` as boolean or null.
A PUT carrying `ssh_remote_daemon` or `os` that turns the host's effective Yes into No
while this hub is connected to it through a daemon answers 409 `DAEMON_CONNECTED`; use
stop-keeping to revoke it. A PUT carrying neither field is not checked, a change of
`type` included.

The three connection routes answer alike when they refuse: 404 `NOT_FOUND` for an unknown host,
400 `VALIDATION_ERROR` for a body that is not an object, a `force` that is not a boolean or a
`client_id` that is not a ULID (`readHostConnectionBody`, `api/host-connection.ts`), 400
`NOT_SSH_HOST` for the local host, which has no connection to act on, and 409 `HUB_QUITTING`
while the hub quits. `SessionManager.connectHost`, `reconnectHost` and `disconnectHost`
refuse with 409 `HOST_BUSY` while Replace holds the host, before changing its user-disconnect
state. Connect reads `client_id` only.

While Replace holds the host, `SessionManager.restartChannel` and `closeSession` also refuse
a Restart or DELETE session that starts then with 409 `HOST_BUSY`. A Restart already under way
that reaches its SPAWN while Replace still holds the host sends none and answers 503, as any
Restart that did not start does (`HOST_UNREACHABLE` when its host is away, `RESTART_FAILED`
otherwise); one that resumes after Replace has released the host goes on. `registerHostCrudRoutes` refuses DELETE host
and PUT carrying `ssh_remote_daemon` or `os` with the same error; a label-only PUT can save.
`requestDaemonStop` treats DISPLACED, a hub-issued close, and a close while quitting as
unconfirmed, so none of those closes lets Replace end channels as `stopped`.

#### SSH Config Import

| Method | Path | Auth | Body / Notes |
|--------|------|------|--------------|
| GET | `/api/ssh-config` | ● | `{ entries, has_include }` — parses `~/.ssh/config`. 404 `NOT_FOUND` when there is none |
| POST | `/api/hosts/import` | ● | `{ entries: { name, label, sshRemoteDaemon?: boolean \| null }[] }` (the key is camelCase) → `Host[]` (201). 409 `CONFLICT` with `error.conflicting_labels` when a label is in use, and nothing is created; 400 `VALIDATION_ERROR` for a `name` not in `~/.ssh/config` |

#### SSH Keys

The private keys in `~/.ssh` of the hub's user, or in a directory below it named by `dir`. A `dir`
that leaves `~/.ssh` answers 400 `INVALID_PATH`.

| Method | Path | Auth | Body / Notes |
|--------|------|------|--------------|
| GET | `/api/ssh-keys` | ● | `?dir=` → `{ path, entries }`, each `{ name, type: "directory" \| "key", items?, algorithm?, bits?, fingerprint?, encrypted?, mtime? }`. Public keys, `config`, `known_hosts` and `authorized_keys` are left out |
| POST | `/api/ssh-keys` | ● | multipart: an optional `dir` field, then the key file (`dir` must come first) → `{ name, algorithm?, bits?, fingerprint?, encrypted?, mtime? }`, stored mode 600. 400 `NO_FILE`, `INVALID_FILENAME` or `INVALID_KEY`; 413 `FILE_TOO_LARGE` over 100 KB; 409 `DUPLICATE` |
| DELETE | `/api/ssh-keys` | ● | `?name=&dir=` → 204. 400 `MISSING_PARAM` without `name`, 404 `NOT_FOUND` |

#### Sessions

| Method | Path | Auth | Body / Notes |
|--------|------|------|--------------|
| GET | `/api/sessions` | ● | `Session[]` (query: `?host_id=X`) |
| GET | `/api/sessions/:id` | ● | `Session` (includes channels) |
| DELETE | `/api/sessions/:id` | ● | 204 (close) |

#### Channels

| Method | Path | Auth | Body / Notes |
|--------|------|------|--------------|
| GET | `/api/channels` | ● | `Channel[]`, each with `display_title` and `host_id` (query: `?host_id=X` or `?session_id=Y`). A dead channel the hub ended itself carries `end_reason`: `"killed"` or `"stopped"` (§ 4.7, #592) |
| GET | `/api/channels/:id` | ● | `Channel`, with `display_title`, and `end_reason` as in the list |
| PATCH | `/api/channels/:id` | ● | At least one of `{ title?, group_id?, icon?, shell?, args?, cwd?, direct_process? }`, and no other key → `Channel`. A `null` clears `title`, `group_id`, `icon`, `shell` or `cwd` |
| POST | `/api/channels/:id/restart` | ● | Restart dead channel → `{ channel_id }`; 503 while a SPAWN or another restart is already starting it (§ 4.4); 503 `{ error: { code: "HOST_UNREACHABLE", message, host_id, host_status } }` while the hub is reconnecting its host, refused at once, or when the host dropped while it started (§ 4.4, #605); 503 `RESTART_FAILED` otherwise; 500 `RESTART_ERROR` when the restart threw |
| DELETE | `/api/channels/:id` | ● | `{ ok: true }`. A live channel is ended, and stored `dead` with `end_reason: "killed"`. A dead one is removed with its output: `{ ok: true, purged: true }`, answered once its row is gone; the output follows in the spool GC's bounded batches (STORAGE.md § 7.2) |
| DELETE | `/api/channels/dead` | ● | Remove all dead channels, or a host's with `{ host_id }` → `{ ok: true, purged }`, their output as above |

#### Channel Groups (tab groups)

| Method | Path | Auth | Body / Notes |
|--------|------|------|--------------|
| GET | `/api/groups` | ● | `Group[]` (query: `?host_id=X`, required: 400 `VALIDATION_ERROR` without it) |
| POST | `/api/groups` | ● | CreateGroup → `Group` (201) |
| PUT | `/api/groups/order` | ● | `{ host_id, group_ids }` → `{ ok: true }`. 400 `VALIDATION_ERROR` for a group of another host |
| PATCH | `/api/groups/:id` | ● | UpdateGroup → `{ ok: true }` |
| DELETE | `/api/groups/:id` | ● | `{ ok: true }` |

#### Host Groups

| Method | Path | Auth | Body / Notes |
|--------|------|------|--------------|
| GET | `/api/host-groups` | ● | `HostGroup[]`, or a page with `?limit=&offset=` (see Pagination) |
| POST | `/api/host-groups` | ● | CreateHostGroup → `HostGroup` (201). 409 `CONFLICT` for a name in use |
| PUT | `/api/host-groups/order` | ● | `{ group_ids }`, every host group once → `{ ok: true }` |
| PUT | `/api/host-groups/:id` | ● | UpdateHostGroup → `HostGroup`. 409 `CONFLICT` for a name in use |
| DELETE | `/api/host-groups/:id` | ● | 204 |

#### Launch Profiles

| Method | Path | Auth | Body / Notes |
|--------|------|------|--------------|
| GET | `/api/launch-profiles` | ● | `LaunchProfile[]`, or a page with `?limit=&offset=` (see Pagination) |
| POST | `/api/launch-profiles` | ● | CreateLaunchProfile → `LaunchProfile` (201) |
| PUT | `/api/launch-profiles/order` | ● | `{ ids }` → 204 |
| GET | `/api/launch-profiles/:id` | ● | `LaunchProfile` |
| PUT | `/api/launch-profiles/:id` | ● | UpdateLaunchProfile → `LaunchProfile` |
| DELETE | `/api/launch-profiles/:id` | ● | 204. 400 `LAST_PROFILE` for the only one left |
| POST | `/api/launch-profiles/import-windows-terminal` | ● | — → `{ imported, skipped, profiles }`, from Windows Terminal's `settings.json`. 501 `NOT_SUPPORTED` on a hub not on Windows, 404 `NOT_FOUND` when there is no such file |

#### Configuration

| Method | Path | Auth | Body / Notes |
|--------|------|------|--------------|
| GET | `/api/config/defaults` | ● | Layer 1 built-in defaults |
| GET | `/api/config/ui` | ● | UI behavioral config |
| GET | `/api/config/cascade` | ● | Full 4-layer cascade, the merged result included (query: `?host_id=X&channel_id=Y`) |
| PUT | `/api/config/global` | ● | `{ terminal: {...} }` → `{ ok }`. A `null` inside `terminal.env` is a removal, written `false` in `config.toml` (which has no null) and read back as `null` |
| PUT | `/api/config/ui` | ● | `{ <section>: { <key>: value } }` → `{ ok }` |
| PUT | `/api/config/appearance` | ● | `{ theme?, autoSwitch?, ... }` → `{ ok }` |
| GET | `/api/config/elevation` | ● | Current elevation config |
| PUT | `/api/config/elevation` | ● | `{ methodLinux?, methodDarwin?, ... }` → `{ ok }`. A method the OS does not have, or an empty custom command, 400 `INVALID_VALUE` |
| GET | `/api/config/ssh` | ● | `{ trustKnownHosts, remoteDaemon }`, the `[ssh]` section |
| PUT | `/api/config/ssh` | ● | `{ trustKnownHosts?, remoteDaemon? }`, booleans → the section, as saved. Any other key or value 400 `VALIDATION_ERROR` |
| GET | `/api/config/logging` | ● | What Settings edits of `[logging]`: `{ agentFilesKept }`, the log files an agent daemon keeps (STORAGE.md § 12.1) |
| PUT | `/api/config/logging` | ● | `{ agentFilesKept }` → `{ agentFilesKept }`, as saved. A whole number from 0 (all) to 3650, else 400 `INVALID_VALUE`; any other key 400 `VALIDATION_ERROR`. Reaches each agent daemon when it next starts |
| GET | `/api/hosts/:id/profile` | ● | `{ profile: object }` — raw host Layer 3 profile |
| PATCH | `/api/hosts/:id/profile` | ● | `{ profile: object }` → `{ ok: true }` — merge into host Layer 3 profile. Each top-level key replaces the stored one, and a top-level `null` deletes it; inside `env`, a `null` is kept: it removes the variable (#576). A key that is not a profile key 400 `VALIDATION_ERROR` |
| GET | `/api/channels/:id/profile` | ● | `{ profile: object }` — raw channel Layer 4 profile |
| PATCH | `/api/channels/:id/profile` | ● | `{ profile: object }` → `{ ok: true }` — merge into channel Layer 4 profile, as for a host |

#### Fonts

| Method | Path | Auth | Body / Notes |
|--------|------|------|--------------|
| GET | `/api/fonts` | ● | `FontFamily[]` — the imported fonts in the config dir's `fonts/`; returned public font URLs carry the per-boot asset token |
| POST | `/api/fonts` | ● | multipart, one font file → `FontFamily[]`. 400 `NO_FILE`, `INVALID_FILENAME`, `UNSUPPORTED_TYPE` or `INVALID_FILE_TYPE`; 413 `FILE_TOO_LARGE` over 10 MB; 409 `DUPLICATE` for a file name in use |
| DELETE | `/api/fonts/:family` | ● | 204: removes every file of that family. 404 `FONT_FAMILY_NOT_FOUND` |
| GET | `/api/fonts/system` | ● | `SystemFontFamily[]` — `.ttf`/`.otf` fonts installed where the hub runs (#100), with `monospace` and each face's `localNames` for `local()`. Scanned from the OS font directories at most every five minutes |

#### Themes

| Method | Path | Auth | Body / Notes |
|--------|------|------|--------------|
| GET | `/api/themes` | ● | `Theme[]` (built-in + user) |
| GET | `/api/themes/:name` | ● | `Theme` |
| POST | `/api/themes` | ● | CreateTheme → `{ name }` (201). 409 `THEME_EXISTS` |
| PUT | `/api/themes/:name` | ● | UpdateTheme → `{ name }` |
| DELETE | `/api/themes/:name` | ● | 204. 409 `BUNDLED_THEME` for a theme the hub ships |

#### Wallpapers

| Method | Path | Auth | Body / Notes |
|--------|------|------|--------------|
| GET | `/api/wallpapers` | ● | `{ wallpapers: string[] }` — user wallpaper filenames; clients build signed public URLs |
| POST | `/api/wallpapers` | ● | multipart upload → `{ filename }` |
| DELETE | `/api/wallpapers/:filename` | ● | `{ ok: true }`. 404 `NOT_FOUND` |

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
| POST | `/api/pair` | ● | — → `{ code, expires_at }` (201); max 3 active codes, then 429 `RATE_LIMIT` |
| POST | `/api/pair/verify` | ○ | `{ code }` → `{ token }`. 400 `INVALID_FORMAT`, 404 `CODE_NOT_FOUND`, 409 `CODE_USED`, 410 `CODE_EXPIRED`, 429 `RATE_LIMIT` for too many attempts from one address |

#### Auth Tokens

| Method | Path | Auth | Body / Notes |
|--------|------|------|--------------|
| GET | `/api/auth/tokens` | ● | `{ tokens }`, each `{ id, label, created_at, expires_at, revoked_at, swept_at, last_used_at }`; never the hash |
| DELETE | `/api/auth/tokens/:id` | ● | → `{ ok: true }`, or 404 `TOKEN_NOT_FOUND` if unknown or already revoked. Closes the WebSockets the token authenticated (`1008 AUTH_REVOKED`). `primary` answers 409 `PRIMARY_TOKEN_NOT_REVOCABLE` and closes nothing: it is retired by replacing `auth.json` (SECURITY.md § 2.1). Every answer is recorded as `token.revoke` (SECURITY.md § 7.1) |

#### Logs

| Method | Path | Auth | Body / Notes |
|--------|------|------|--------------|
| GET | `/api/logs/hub` | ● | `{ entries, total }` from `hub.jsonl`, in file order. Query: `level` (minimum), `from_t` and `to_t` (ISO 8601), `search` (in `msg`, any case), `limit`, `offset` (see Pagination) |
| GET | `/api/logs/channels/:channelId` | ● | `{ entries, total }` for one channel, with the same query; `from_t` and `to_t` are milliseconds since the channel opened. An id that is not 26 alphanumerics answers 400 `INVALID_CHANNEL_ID`. No hub writes a channel's log (SPEC.md § 7), so the list is always empty |

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
  ssh_auth?: 'agent' | 'key' | 'password',
  ssh_key_path?: string,              // required if ssh_auth=key
  ssh_config_host?: string,           // Host alias from ~/.ssh/config
  ssh_proxy_host_id?: string | null,  // jump host this hub knows (SPEC.md § 4.5b)
  ssh_proxy_spec?: string | null,     // or a jump as user@host:port; never both
  ssh_remote_daemon?: boolean | null, // keep an agent running there (#79); null follows [ssh] remote_daemon
  icon_type?: 'auto' | 'emoji' | 'image',   // default 'auto'
  icon_value?: string | null,         // emoji char, or for 'image' a data:image/png|jpeg|gif|webp;base64 URI of at most 65536 chars
  color?: string | null,              // hex "#rrggbb" or null for auto
  default_shell?: string,
  default_cwd?: string,
  trust_remote_hints?: 'apply' | 'ask' | 'ignore',  // default 'apply'
  host_group_id?: string | null,      // host group ID
  profile_json?: string | object,     // host-level terminal profile (Layer 3)
  elevation_method?: 'sudo' | 'doas' | 'pkexec' | 'gsudo' | 'custom' | null,
  custom_command?: string,            // the elevation command, when elevation_method is "custom"
  os?: 'linux' | 'darwin' | 'windows' | null,
  arch?: 'x64' | 'arm64' | null
}
```

**UpdateHost:** Same fields as CreateHost, all optional (partial update, deep merge).

A field these routes do not know is ignored.

**CreateGroup:** (tab channel groups; no other key)
```typescript
{
  host_id: string,              // required, the host the group is for
  name: string                  // required, 1-128 chars, not only whitespace
}
```

**UpdateGroup:** (no other key)
```typescript
{
  name: string                  // required, 1-128 chars, not only whitespace
}
```

**CreateHostGroup:**
```typescript
{
  name: string,                 // required, 1-32 chars once trimmed: letters, digits, space, - and _; unique
  color?: string | null         // hex "#rrggbb"
}
```

**UpdateHostGroup:**
```typescript
{
  name?: string,                // as for CreateHostGroup
  color?: string | null         // null clears it
}
```

A host group answers `{ id, name, sort_order, color, created_at, updated_at }`.

**CreateLaunchProfile:**
```typescript
{
  name: string,                 // required, 1-100 chars, unique (case-insensitive)
  shell: string,                // required, an executable path, not a command
  args?: string[] | null,       // at most 64, each at most 1024 chars
  cwd?: string | null,          // working directory, at most 1024 chars
  env?: Record<string, string> | null, // at most 100 (values masked in responses)
  mode?: 'shell' | 'process',   // default 'shell'
  elevated?: boolean,           // default false
  supported_os?: 'linux' | 'darwin' | 'windows' | 'any', // default 'any'
  icon_type?: 'auto' | 'emoji' | 'image', // default 'auto'
  icon_value?: string | null,   // at most 256 chars
  color?: string | null,        // hex "#rrggbb"
  profile_overrides?: Partial<TerminalProfile> | null, // stored as sent, camelCase inside
  sort_order?: number
}
```

**UpdateLaunchProfile:** Same fields as CreateLaunchProfile, all optional. A field left out keeps
its stored value. `null` clears a field that may be empty (`args`, `cwd`, `env`, `icon_value`,
`color`, `profile_overrides`), and is refused on the others (#665). In `env`, the mask
`"********"` keeps the stored value of that variable.

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
// Most non-2xx responses return, as the agent manager's do:
{
  error: {
    code: string,               // machine-readable (e.g., "NOT_FOUND", "VALIDATION_ERROR")
    message: string             // human-readable description
  }
}

// The bearer check (401, 503) and the routes that end the hub return the older flat shape:
{
  error: string,                // "AUTH_REQUIRED", "AUTH_INVALID", "AUTH_UNAVAILABLE", ...
  message: string
}
```

A body that a route's JSON schema refuses (`POST /api/groups`, `PATCH /api/channels/:id`, ...)
gets Fastify's own 400: `{ statusCode, code: "FST_ERR_VALIDATION", error: "Bad Request", message }`.

### Agent Error Codes

Complete list of codes returned in SPAWN_ERR and ERROR messages:

| Code | Origin | Meaning |
|------|--------|---------|
| `SHELL_NOT_FOUND` | Agent | Shell binary not found at path |
| `PERMISSION_DENIED` | Agent | Cannot spawn PTY (user/cgroup restriction) |
| `PTY_SPAWN_FAILED` | Agent | The PTY could not be spawned, for any other reason |
| `CHANNEL_EXISTS` | Agent | SPAWN named a `channel_id` the agent already holds |
| `ELEVATION_PASSWORD_REQUIRED` | Agent | An elevated SPAWN needs a password; the hub asks for one (AUTH_PROMPT) and sends the SPAWN again |
| `ELEVATION_CUSTOM_CMD_MISSING` | Agent | An elevated SPAWN with `elevation_method: "custom"` and no `custom_command` |
| `ELEVATION_FAILED` | Agent | The elevation command could not be prepared |
| `CHANNEL_NOT_FOUND` | Agent | ATTACH/INPUT/RESIZE for unknown channel_id (DESTROY and SNAPSHOT_REQ answer nothing); also for a channel another hub owns, which is never told apart from an unknown one, byte for byte. Only the ATTACH's carries its `request_id` (§ 3.3) |
| `INVALID_MESSAGE` | Agent | A frame it cannot decode, an unknown type included, or STOP to a stdio agent (§ 3.17, § 7) |
| `DISPLACED` | Agent | A newer connection of the same hub took this one's place, and this one ends (§ 3.1b) |
| `OTHER_HUBS_HOLD_CHANNELS` | Agent | STOP without `force`, refused while other hubs hold channels; `other_owner_channels` carries how many, and the message says it too (§ 3.17) |
| `AUTH_REQUIRED` | Agent | A daemon connection did not open with an AUTH carrying `hub_key` within 5 s; the connection is closed (§ 3.1b) |
| `AUTH_INVALID` | Agent | The AUTH that opened a daemon connection carried a token the daemon refuses, or an empty `hub_key`; the connection is closed (§ 3.1b) |
| `INPUT_DROPPED` | Agent | An INPUT was dropped: its terminal takes no input and the channel's input queue (1 MiB) is full. Every INPUT to that channel is dropped until the terminal has taken what is queued; said once per gap, with `channel_id` (§ 3.4). The hub relays it to that channel's clients as `INPUT_DROPPED` (§ 4.12) |

### Pairing Code Format

- 8 numeric digits (`0-9`), leading zeros allowed (e.g., `00729316`)
- Generated via `crypto.randomInt(0, 100_000_000).toString().padStart(8, '0')`
- Expires: ISO 8601 timestamp, 60 seconds from creation
- Stored only as a keyed hash, under a key the hub holds for one run: a code issued before the
  hub's last start is unknown to it (SECURITY.md § 2.3)

## 7. Version Negotiation

HELLO includes `version: 1`. The hub accepts only its own protocol version
(`AgentConnection.handleData`, strict equality with `PROTOCOL_VERSION`):

| Agent | Hub | Result |
|:-----:|:---:|--------|
| 1 | 1 | Compatible |
| any other | 1 | Hub closes the connection, sending nothing; the agent is not used |

There is no downgrade. The agent's own version is a separate check: a deployed agent whose
`agent_version` is not the hub's is refused with `AGENT_VERSION_MISMATCH` (§ 4.14), and a remote
daemon left by an older hub is reported `outdated_agent` (§ 4.7).

An agent skips a frame it cannot decode, an unknown type included, and answers
`ERROR { code: "INVALID_MESSAGE" }`. The hub ignores a message type it does not know, from an
agent or a client.
