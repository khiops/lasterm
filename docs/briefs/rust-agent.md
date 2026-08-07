# Rust Agent + async-xpty — Ideation Brief

## Problem Statement

**Problem:** node-pty + Node.js SEA = broken on Windows. ConPTY hangs, WinPTY crashes, SEA native addon loading is fragile (dlopen, PATH hacks, extraction). Linux works in dev but the packaging story is unsustainable.

**Root cause:** Node.js SEA is fundamentally unsuitable for distributing binaries with complex native addons like node-pty (which wraps conpty.dll / winpty.dll). As long as the agent is Node.js, packaged distribution will be fragile.

**Target users:** All lasterm users — the agent is the universal PTY manager for local and remote sessions.

**Current solutions tried:** conpty backend (hangs in SEA), winpty backend (crashes in SEA), PATH hacks for winpty.dll (fragile), cmd.exe-first shell order (workaround, not fix).

## Proposed Solution

### 1. async-xpty — Public Rust crate (crates.io)

New cross-platform async PTY crate filling an ecosystem gap. No production-quality async PTY crate exists in Rust today.

**Architecture:**
- Inspired by portable-pty's trait-based design, NOT a fork
- Direct OS API calls via `nix` (Unix) and `windows-sys` (Windows)
- Async/tokio native from day one (AsyncRead/AsyncWrite)
- Independent repo governance — not coupled to any terminal emulator
- Built-in ConPTY `\x1b[6n` deadlock fix (the portable-pty v0.9.0 regression #6783)

**Scope:**
- Spawn PTY process (with env, cwd, shell)
- Async read/write (tokio AsyncRead/AsyncWrite traits)
- Resize (cols/rows)
- Exit detection (exit code + signal)
- Cross-platform: Linux (openpty), macOS (openpty), Windows (ConPTY via CreatePseudoConsole)

**Out of scope (agent responsibility, not crate):**
- Process title polling (OS-specific, not PTY)
- Shell detection
- Protocol/framing
- Terminal state mirroring

**Key dependencies:** tokio, nix (Unix), windows-sys (Windows)

### 2. lasterm-agent — Full Rust agent binary

Complete rewrite of `packages/agent/` in Rust. Same MessagePack protocol — hub sees zero changes.

**Full scope (NOT MVP — everything the TS agent does today):**
- Protocol: all 15 message types (HELLO, SPAWN, SPAWN_OK, SPAWN_ERR, INPUT, OUTPUT, RESIZE, DESTROY, SNAPSHOT_REQ, SNAPSHOT_RES, ATTACH, ATTACH_OK, HEARTBEAT, HEARTBEAT_ACK, CHANNEL_EXIT, TITLE_CHANGE, PROCESS_TITLE, BELL, NOTIFICATION, ERROR)
- Multi-channel concurrent (N PTYs in parallel)
- Mode stdio (hub child_process, stdin/stdout MessagePack framing)
- Mode daemon (Unix domain socket server, PTYs survive hub restarts)
- Shell detection (per-OS: /etc/shells on Unix, registry on Windows)
- Process title polling (per-OS: /proc on Linux, wmic on Windows, ps on macOS)
- Variable expansion (args, cwd, env — NOT shell path)
- Elevation wrapping (sudo/doas/pkexec/gsudo/custom + ASKPASS env)
- Backpressure (pause stdin when stdout buffer full)
- VT state mirror via `vt100` crate (snapshots, title change OSC 0/2, bell \x07)
- Graceful shutdown (SIGTERM → destroyAll, stdin EOF → clean exit)

**Key dependencies:** async-xpty, tokio, rmp-serde (MessagePack), vt100, nix, windows-sys

## Architecture

### Monorepo integration

```
lasterm/
├── Cargo.toml              ← Rust workspace root
├── crates/
│   ├── async-xpty/         ← public crate (crates.io)
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── unix.rs
│   │       └── windows.rs
│   └── lasterm-agent/      ← agent binary
│       ├── Cargo.toml
│       └── src/
│           ├── main.rs
│           ├── handler.rs
│           ├── pty.rs
│           ├── daemon.rs
│           ├── elevation.rs
│           ├── shell_detection.rs
│           ├── process_title.rs
│           └── headless.rs
├── packages/               ← TypeScript (unchanged)
│   ├── shared/
│   ├── hub/
│   ├── agent/              ← kept temporarily for reference
│   └── clients/
└── pnpm-workspace.yaml
```

### Hub ↔ Agent interface (unchanged)

```
Hub ──stdio──► Agent Rust
     │                │
     │ [4-byte LE len][MessagePack payload]
     │                │
     │ snake_case on wire, camelCase in TS
     │                │
     └────────────────┘

Hub sees no difference between TS agent and Rust agent.
```

### Tauri

Tauri = one client among others. Hub stays standalone, PWA = primary client. Desktop is an optional wrapper. The Rust agent is NOT a Tauri plugin — it's a standalone binary spawned by the hub.

## Technical Considerations

**Constraints:**
- Same MessagePack framing protocol (4-byte LE length prefix + payload)
- snake_case on wire (rmp-serde with rename)
- Hub = zero modifications
- Cross-compile: linux-x64, windows-x64, darwin-arm64 (minimum)
- Agent binary name: `lasterm-agent` (same as today)

**ConPTY assessment (no fork needed):**
- ConPTY limitations (DCS stripping, OSC reordering, grid caching) don't affect lasterm
- lasterm is a PTY manager doing raw I/O, not shell-integrated UI like Warp
- Warp forked ConPTY for advanced shell integration — we don't need that
- portable-pty v0.9.0 `\x1b[6n` regression: fix built into async-xpty

## Risks

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| ConPTY `\x1b[6n` deadlock | H | H (known bug) | Built-in detection + auto-response in async-xpty |
| ConPTY escape seq limitations | M | L (raw I/O OK) | Acceptable for lasterm's use case |
| Snapshot format compatibility | M | M | `vt100` crate state → format compatible with xterm.js UI |
| Process title polling cross-platform | L | L | Already solved in TS, direct port to Rust |
| `vt100` crate gaps | M | L | Mature crate (used by alacritty/others), fallback: raw VT parser |

## Research Summary

| Crate evaluated | Verdict |
|-----------------|---------|
| portable-pty | Production-proven but sync-only, v0.9.0 broken on Windows, coupled to wezterm monorepo |
| pseudoterminal | Eliminated — async advertised but NOT implemented, 16 stars, docs.rs build broken |
| xpty | Eliminated — lazy fork of portable-pty, 1 star, zero modifications |
| pty-process | Unix-only, no Windows support |
| conpty (crate) | Windows-only, sync |
| rust-pty | Low adoption (~1k dl/month), risky |
| **Decision** | **New crate (async-xpty)** — fills ecosystem gap, async-native, independent |

## Next Steps

→ `/spec` for async-xpty crate + lasterm-agent implementation plan
→ Blocks, exit criteria, test strategy, CI cross-compilation
