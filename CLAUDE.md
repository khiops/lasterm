# lasterm — CLAUDE.md

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
| Runtime | Node.js >= 24 LTS (hub, web, desktop shell — the agent is a Rust binary and needs none) |
| Language | TypeScript strict (all packages) |
| Monorepo | pnpm workspaces |
| Package manager | pnpm |
| Linter/formatter | biome |
| Test framework | vitest |
| Test pattern | `*.spec.ts` (colocated) |
| PTY | `async-xpty` — Rust, inside the agent. No Node PTY anywhere |
| SSH (client + mock server) | ssh2 (Client + Server) |
| Terminal (UI) | xterm.js + addon-fit + addon-serialize |
| Terminal (Agent) | the `vt100` crate — Rust screen model in `headless.rs` |
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
lasterm (root)        → workspace root + CLI entrypoint. NOT published.
packages/
├── shared/           → @lasterm/shared (private, never published)
├── hub/              → @lasterm/hub    (private, never published)
└── clients/
    ├── web/          → @lasterm/web (not published, embedded by hub)
    └── desktop/      → @lasterm/desktop (Tauri)
crates/
├── lasterm-agent/    → the agent. A Rust binary, not an npm package.
└── lasterm-hub-lock/ → napi-rs addon holding the single-hub lock
```

**No working Lasterm reaches users through npm, and nothing here publishes.** No
workflow runs `npm publish`, and every package is marked private so a recursive
publish cannot release one by accident.

**`@lasterm` is unclaimed on npm.** What exists there is three `@termora/*` names
holding 0.0.1 placeholders, published before the rename, which now reserve a scope this
product does not use. The unscoped `lasterm` belongs to an unrelated project. Since
nothing here publishes, the only thing the scope buys is that nobody else takes it —
worth an hour, and it is not done. Verified against the registry on 2026-08-07 rather
than inferred: `npm view @termora/hub version` answers 0.0.1, `@lasterm/hub` answers
that it does not exist.

The hub ships as a single executable that embeds its own Node, so an npm install
would reintroduce the runtime requirement that executable exists to remove. Today the
only channel that works end to end is **building from this repository or downloading
a release asset**. The Microsoft Store path has packaging in CI but submission is
manual and not yet done (#110), and winget is a plan with no manifest.

Dependencies: shared ← hub, shared ← web.
The hub spawns the agent binary for local sessions and deploys it over SSH for remote
ones, fetching it from GitHub Releases version-matched to itself (SPEC.md §3.5).
hub embeds web build output as static files.
No Node process opens a PTY: the agent does it in Rust, through `async-xpty`.

## Commands

```bash
pnpm install              # Install all deps
pnpm dev                  # Start hub + UI dev servers (concurrent)
pnpm build                # Build all packages
pnpm test                 # Run all tests (vitest)
pnpm lint                 # Lint + format check (biome)
pnpm lint:fix             # Auto-fix lint issues
pnpm -F @lasterm/hub test # Test single package
pnpm -F @lasterm/web dev  # Dev single package
```

### TypeScript test prerequisite

The hub TypeScript specs load the `lasterm-hub-lock` and `lasterm-tls-identity`
Rust addons, and run the `lasterm-tls-test-material` generator, from the cargo target
directory. Build them before a hub or root test run, and again after editing a crate:

```bash
cargo build --release -p lasterm-hub-lock -p lasterm-tls-identity --features lasterm-tls-identity/test-tls-material
pnpm -F @lasterm/hub test # or: pnpm test
```

Nothing in the TypeScript loop rebuilds them. The hub test setup compares each one
with the sources cargo recorded for it, and refuses to run on a build that predates
them or came from another checkout's different sources (#129).

Worktrees that share one `CARGO_TARGET_DIR` also share cargo's record of which
crates are fresh, and it goes by modification time. After another worktree has
built, the build above can compile nothing and only relabel that worktree's
artifacts as this checkout's, and the setup then accepts them.
`pnpm build:test-tls-material`, which `pnpm -F @lasterm/hub test` runs first, cleans
the crates before it builds when a dep-info file names another checkout. By hand,
clean them first:

```bash
cargo clean --release -p lasterm-protected-fs -p lasterm-process-lock -p lasterm-tls-identity -p lasterm-hub-lock
```

### Production build & run (local, Linux native)

macOS is not a supported target: nothing builds or tests it (#224). On Windows, use
`scripts/build-hub.ps1` and `scripts/build-desktop.ps1`.

```bash
./scripts/build-agent.sh   # Rust agent → dist/sea/lasterm-agent (cargo --release)
./scripts/build-hub.sh     # Hub SEA (builds+embeds web, bundles better-sqlite3) → dist/sea/lasterm-hub
cd dist/sea && ./lasterm-hub start --port 4100   # serve PWA at https://127.0.0.1:4100 (--daemon/--open)
./lasterm-hub pair         # 8-digit code to authorise a browser client; also: status | stop
```

- Hub SEA resolves the agent **co-located** in the same dir (`dist/sea/`) via `sea-agent-resolver.ts`; the agent spawns lazily on first local session.
- Native SEA embeds the host Node — build cross-platform binaries on their target OS (Windows hub on Windows). Rust agent verify must include `cargo clippy --target x86_64-pc-windows-msvc --all-targets -- -D warnings` (cfg(windows) lints invisible to Linux clippy).
- Config: `~/.config/lasterm` · State: `~/.local/state/lasterm`.

### Desktop UI tests (Windows)

```powershell
.\scripts\dev\desktop-ui.ps1 [-Build]        # run the built app with a CDP port (9333)
node scripts/dev/ui/cdp.mjs eval "<js>"      # also: type "<text>", shot <file.png>, watch <s> "<js>"
powershell -NoProfile -STA -File scripts\dev\ui\drag-file.ps1 -File <path> -X <cssX> -Y <cssY>
.\scripts\dev\desktop-ui.ps1 -Stop
```

- `-Build` always compiles into `target\desktop-ui\build` and keeps it, so a rebuild recompiles only
  what changed. Never build in a fresh target directory, and never outside the repository: every
  crate's build script is a new executable, and the maintainer's antivirus flags each one outside
  their development folder.
- The app runs from a copy in `target\desktop-ui\bin`, against the real profile. An agent started
  from a `target\release` locks its executable, and the next build then fails with "access denied".
- A drag dispatched over CDP skips the window's native drop handling. `drag-file.ps1` performs a real
  OLE drag instead: it moves the user's mouse for a few seconds, then puts it back. Run it with
  `-SelfTest` first, before trusting a result it gives on the app.

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

### Logging

A terminal sees everything its user types, so its logs must never turn into a keylogger.

- **INFO is what ships.** The shipped hub and agent log at INFO, and those logs are kept: the desktop writes the hub's output to `hub.log`, and there are also `hub.jsonl` and `agent-daemon.jsonl`. A line at INFO or above is for rare events only: lifecycle, errors, security events.
- **Hot paths log at DEBUG, or not at all.** Nothing that runs per WebSocket frame, keystroke, output chunk or routine request may log at INFO or above. A line per keystroke records when and how fast someone types, even without the bytes.
- **Never log user content, at any level.** That means input bytes, terminal output, clipboard, and secrets (tokens, pairing codes, passwords, passphrases, the asset token inside a URL). Name the type, size or id instead.
- **Security events** go through `SecurityLog`, and they carry no secret either.
- **Adding a hot path:** extend the keystroke spec in `packages/hub/src/security-events.spec.ts`, which fails if a burst of INPUT frames leaves anything at INFO or above, or the routine-request spec beside it, which does the same for REST requests.

### Testing

- Unit: vitest, colocated `*.spec.ts`
- Integration: better-sqlite3 in-memory (`:memory:`)
- E2E (remote): mock SSH server (never real SSH in CI)
- PTY: exercised by the agent's Rust tests (`cargo test`), Linux and Windows
- WS: mock for UI tests, real for E2E
- A new validation rule gets a unit test on its table or validator, beside it, so a broken rule fails under its own name rather than a route's (#459).
- The route keeps **one** test proving it consults that table: a refused value gets its 4xx and error shape, an accepted one is stored.

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
  stdin → MessagePack frames → PTY manager (async-xpty, Rust) → N channels
  stdout ← MessagePack frames ← OUTPUT/SNAPSHOT
  Hub never touches PTY directly — agent is the universal PTY manager.
```

### Three tiers, and what "local" means

| Tier | Relationship |
|------|--------------|
| GUI client | Bundles a hub and launches it, **and** can pair to a hub on another machine with a pairing code (`lasterm pair`). |
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

The API chain reaches only what cooperates: hub → agent → shell, and it stops
there — `DestroyAllSummary::confirmed_shell_exits` says as much in code. The
shell's descendants (a dev server, a compose stack, anything detached) get
nothing, and on Windows they hold the handles on the files an update replaces.
`kill_tree()` and the Job Object are therefore load-bearing: without them a cold
start cannot replace the binaries.

On Unix the promise is only the shell's **process group**, so a `setsid` escapee
survives (#113); Windows is strictly stronger, and that asymmetry is chosen. The
identity-validated stop is what turns "asked it to go" into "confirmed it went".

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

**Port:** the `--port` flag, else `LASTERM_PORT`, gives an explicit port; otherwise the OS assigns
a free one, and the hub writes the port it took to `runtime.json` in the state dir (SPEC.md § 3).
Both entry points resolve it through `resolveStartPort` (`packages/hub/src/start-port.ts`). An
explicit port that is taken moves up to 99 ports higher (`zero_conf`).

## Common Pitfalls

- never store SSH passwords (prompt at connect, clear after auth)
- spool.db writes are continuous/heavy — use INCREMENTAL auto_vacuum, not full VACUUM
- MessagePack Uint8Array: use `@msgpack/msgpack` with `useBigInt64: false`
- SQLite cross-DB: no FK between meta.db and spool.db — use cache_index for consistency
- Auth token comparison: always `crypto.timingSafeEqual` (constant-time)
- astix auto-indexes via file watcher — NEVER call `reindex_project` explicitly unless you get a stale index error after a `get_symbol`/`get_symbols` failure. Write → get_symbols works without reindex.
