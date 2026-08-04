# termora — CLAUDE.md

## Vision

Local-first session terminal platform: hub daemon + remote agents + SSH transport + PWA UI.
Sessions survive client disconnects and device switches; local sessions also survive hub restarts.

## Documentation

**Read these FIRST before any implementation:**

| Doc | What | When to read |
|-----|------|-------------|
| `docs/SPEC.md` | Architecture, components, entity model, data flows, config cascade | Always — primary reference |
| `docs/PROTOCOL.md` | MessagePack framing, all message types, REST API schemas | When touching protocol/API |
| `docs/STORAGE.md` | SQLite schemas, chunking, GC, migrations | When touching DB/storage |
| `docs/SECURITY.md` | Threat model, auth, SSH security, input validation | When touching auth/SSH/validation |
| `docs/MVP_ROADMAP.md` | 6 milestones, ~30 blocks, exit criteria, dependencies | For implementation planning |
| `docs/IDEATION_BRIEF.md` | Original ideation with rationale for all decisions | When questioning "why" |

## Stack

| Key | Value |
|-----|-------|
| Runtime | Node.js >= 20 LTS |
| Language | TypeScript strict (all packages) |
| Monorepo | pnpm workspaces |
| Package manager | pnpm |
| Linter/formatter | biome |
| Test framework | vitest |
| Test pattern | `*.spec.ts` (colocated) |
| PTY | node-pty |
| SSH (client + mock server) | ssh2 (Client + Server) |
| Terminal (UI) | xterm.js + addon-fit + addon-serialize |
| Terminal (Agent) | xterm.js headless + addon-serialize |
| Codec | @msgpack/msgpack |
| Storage | better-sqlite3 (WAL mode) |
| HTTP/WS | Fastify + @fastify/websocket |
| UI framework | Vue 3 (Composition API) |
| UI build | Vite |
| UI state | Pinia |
| Config parse | @iarna/toml |
| IDs | ulid |

## Monorepo Structure

```
termora (root)        → npm: termora (CLI entrypoint, `npx termora`)
packages/
├── shared/           → npm: @termora/shared (published)
├── agent/            → npm: @termora/agent  (published)
├── hub/              → npm: @termora/hub    (published)
└── clients/
    ├── web/          → @termora/web (NOT published, embedded by hub)
    └── desktop/      → @termora/desktop (P1, Tauri)
```

Dependencies: shared ← agent, shared ← hub, shared ← web.
hub depends on agent (spawns it locally via child_process for local sessions).
hub embeds web build output as static files.
Root `termora` CLI wraps `@termora/hub`.
Hub does NOT depend on node-pty — all PTY management is in the agent.

## Commands

```bash
pnpm install              # Install all deps
pnpm dev                  # Start hub + UI dev servers (concurrent)
pnpm build                # Build all packages
pnpm test                 # Run all tests (vitest)
pnpm lint                 # Lint + format check (biome)
pnpm lint:fix             # Auto-fix lint issues
pnpm -F @termora/hub test # Test single package
pnpm -F @termora/web dev  # Dev single package
```

### Production build & run (local, Linux/macOS native)

```bash
./scripts/build-agent.sh   # Rust agent → dist/sea/termora-agent (cargo --release)
./scripts/build-hub.sh     # Hub SEA (builds+embeds web, bundles better-sqlite3) → dist/sea/termora-hub
cd dist/sea && ./termora-hub start --port 4100   # serve PWA at http://127.0.0.1:4100 (--daemon/--open)
./termora-hub pair         # 8-digit code to authorise a browser client; also: status | stop
```

- Hub SEA resolves the agent **co-located** in the same dir (`dist/sea/`) via `sea-agent-resolver.ts`; the agent spawns lazily on first local session.
- Native SEA embeds the host Node — build cross-platform binaries on their target OS (Windows hub on Windows). Rust agent verify must include `cargo clippy --target x86_64-pc-windows-msvc --all-targets -- -D warnings` (cfg(windows) lints invisible to Linux clippy).
- Config: `~/.config/termora` · State: `~/.local/state/termora`.

## Conventions

### Code

- All protocol messages use **snake_case** on the wire (MessagePack)
- All TypeScript interfaces use **camelCase**
- Codec layer handles conversion at encode/decode boundaries
- IDs: ULID everywhere (sortable, no UUID)
- Timestamps: ISO 8601 strings in DB and protocol
- SQL: parameterized queries ONLY (never interpolate)
- Errors: structured `{ code, message }` — never throw raw strings
- File permissions: chmod 600 for auth.json, DB files

### Dependencies

- External deps via `catalog:` in pnpm-workspace.yaml
- Internal deps via `workspace:*`

### Testing

- Unit: vitest, colocated `*.spec.ts`
- Integration: better-sqlite3 in-memory (`:memory:`)
- E2E (remote): mock SSH server (never real SSH in CI)
- PTY: real node-pty on all platforms
- WS: mock for UI tests, real for E2E

### Git

- Commit format: `type(scope): description`
- Types: feat, fix, refactor, docs, test, chore
- Scopes: shared, agent, hub, web, desktop, root
- Branch: `main` for trunk, `feat/xxx` for features

## Architecture Quick Reference

```
UI (Vue 3 + xterm.js) ──── WS + REST ──── Hub (Fastify, 127.0.0.1:4100)
                                            ├── Local Agent (child_process, stdio)
                                            ├── Remote Agent (ssh2, stdio)
                                            ├── meta.db (config, relational)
                                            └── spool.db (output, snapshots)

Agent (local or remote, same binary):
  stdin → MessagePack frames → PTY manager (node-pty) → N channels
  stdout ← MessagePack frames ← OUTPUT/SNAPSHOT
  Hub never touches PTY directly — agent is the universal PTY manager.
```

### Three tiers, and what "local" means

| Tier | Relationship |
|------|--------------|
| GUI client | Bundles a hub and launches it, **and** can pair to a hub on another machine with a pairing code (`termora pair`). |
| Hub | The client drives one hub, its own or a paired one. It asks *that hub* to reach a host the hub can see. |
| Agent | Deployed **by the hub** onto the target, matched to its OS and architecture. |

**"Local" is relative to the hub, never to the client.** The hub a client drives
may not be the hub it launched. A gesture that ends things — quit, stop — acts on
the hub the client *owns*, i.e. launched; never on one it merely connected to,
whose terminals belong to other people. That rule is not yet enforced anywhere
(#142) and today only holds because the code happens to target the local runtime
record.

The hub binds `127.0.0.1` today. That is a stopgap, not the design: pairing
exists because clients are meant to reach a hub across the network, and #96
covers hardening it for a non-local interface. Do not read the current binding as
the architecture.

### Why quitting kills process trees when an API exists

Scope: the **local** hub and the **local** agent — the binaries a new
installation replaces. Remote agents are peers the hub deployed elsewhere; no
local install touches them, and no gesture stops them.

The API chain reaches only what cooperates: hub → agent → shell. It stops there.
The shell's descendants — a dev server, a compose stack, anything detached — get
nothing, and on Windows they are what holds handles on the files an update
replaces. So `kill_tree()` and the Job Object are load-bearing, not belt-and-braces:
without them a cold start cannot replace the binaries.

`DestroyAllSummary::confirmed_shell_exits` says so in code — it confirms shells,
not descendants. On Unix the promise is only the shell's **process group**, so a
`setsid` escapee survives (#113); Windows is strictly stronger. That asymmetry is
deliberate, and the identity-validated stop is what turns "asked it to go" into
"confirmed it went".

## Entity Model

Host (permanent) → Session (runtime) → Channel (PTY instance)
ChannelGroup (organizational, per host)
Workspace (layout persistence)

## Config Cascade (4 layers, deep merge, last wins)

1. Built-in defaults (code)
2. `config.toml` (XDG config dir on Linux, %APPDATA% on Windows — see SPEC.md § 7)
3. `hosts.profile_json` (per-host, meta.db)
3.5. Agent visual hints (from HELLO, ephemeral)
4. `channels.profile_json` (per-channel, meta.db)

**Port:** default 4100, configurable via CLI flag > `TERMORA_PORT` env > config.toml > default.
`zero_conf` mode: auto-increment 4100→4199 if port taken, write `runtime.json` in state dir.

## Common Pitfalls

- xterm.js headless needs DOM polyfill — see spike criteria in SPEC.md § 3.2
- never store SSH passwords (prompt at connect, clear after auth)
- spool.db writes are continuous/heavy — use INCREMENTAL auto_vacuum, not full VACUUM
- MessagePack Uint8Array: use `@msgpack/msgpack` with `useBigInt64: false`
- SQLite cross-DB: no FK between meta.db and spool.db — use cache_index for consistency
- Auth token comparison: always `crypto.timingSafeEqual` (constant-time)
- astix auto-indexes via file watcher — NEVER call `reindex_project` explicitly unless you get a stale index error after a `get_symbol`/`get_symbols` failure. Write → get_symbols works without reindex.
