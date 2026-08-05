# termora — MVP Roadmap

> Version: 0.1.0 (MVP)
> Status: draft
> Last updated: 2026-03-02

## 1. Milestone Overview

```
M0: Foundation        ──── monorepo, shared types, build tooling
 │
M1: Local Terminal    ──── hub + agent + UI, local PTY via agent, basic I/O
 │
M2: Remote Terminal   ──── SSH transport, session manager, host API
 │
M3: Session Persist   ──── snapshot/restore, spool cache, reconnect
 │
M4: Multi-Client      ──── auth, write-lock, multi-device attach
 │
M5: Polish            ──── Discord UI, config cascade, CLI, onboarding
 │
MVP RELEASE
```

**Total estimated blocks:** 25–30 across 6 milestones.

## 2. Milestones

### M0 — Foundation (Blocks 1–4)

**Goal:** Monorepo scaffold with shared types, build pipeline, and dev tooling.

| Block | Description | Package(s) | Exit Criteria |
|-------|-------------|------------|---------------|
| 0.1 | Monorepo init | root | pnpm workspace, TypeScript strict, biome lint, vitest config |
| 0.2 | Shared types + protocol | shared | All message types (§ PROTOCOL), ULID helper, MessagePack encode/decode, frame reader/writer |
| 0.3 | Storage layer | hub | meta.db + spool.db schemas (§ STORAGE), migration runner, PRAGMA setup, basic CRUD for hosts table |
| 0.4 | Dev tooling | root | `pnpm dev` (concurrent hub + UI), `pnpm test`, `pnpm lint`, `pnpm build`, CI GitHub Actions |

**Dependencies:** None — all greenfield.

**Exit criteria (milestone):**
- `pnpm test` passes in CI
- `pnpm build` produces all 4 packages
- Shared types importable from hub, agent, and UI
- meta.db + spool.db created on first run with correct schemas
- Frame encode/decode round-trip test passes

---

### M1 — Local Terminal (Blocks 5–11)

**Goal:** Hub spawns local agent, agent manages PTY, UI renders terminal, user can type and see output.

| Block | Description | Package(s) | Exit Criteria |
|-------|-------------|------------|---------------|
| 1.1 | Hub HTTP server | hub | Fastify server on 127.0.0.1:4100, health endpoint, static file serving |
| 1.2 | Agent core | agent | stdin/stdout framing, PTY spawn via node-pty, HELLO on start, SPAWN/SPAWN_OK/SPAWN_ERR (moved from M2 — agent needed for local sessions) |
| 1.3 | Agent multiplexing | agent | Multiple channels per agent (HashMap<channel_id, PTY>), INPUT/OUTPUT routing, CHANNEL_EXIT (moved from M2) |
| 1.4 | Local agent spawn | hub | Hub spawns agent via child_process (--stdio), HELLO handshake, SPAWN creates PTY via agent, channel status BORN→LIVE |
| 1.5 | WS transport (hub side) | hub | WS upgrade on /ws, MessagePack frames, INPUT→Agent→PTY→OUTPUT pipeline |
| 1.6 | UI shell (Vue 3) | web | Vite + Vue 3, 3-column layout scaffold (host rail empty, sidebar stub, main area) |
| 1.7 | xterm.js integration | web | Terminal renders in main pane, WS connection, INPUT/OUTPUT flowing, fit addon for resize |

**Dependencies:** M0 complete.

**Exit criteria (milestone):**
- Launch `pnpm dev` → browser opens → terminal visible
- Type `echo hello` → see output
- Resize browser → terminal re-fits (RESIZE message sent)
- `Ctrl+C` works (signal handling)
- Local host auto-created in meta.db

**Demo scenario:**
```
$ pnpm dev
→ Hub: listening on 127.0.0.1:4100
→ Open browser: http://localhost:4100
→ Terminal visible, type commands, see output
→ Resize window → terminal adapts
```

---

### M2 — Remote Terminal (Blocks 12–14)

**Goal:** SSH transport to remote agents, session management, host CRUD API.

| Block | Description | Package(s) | Exit Criteria |
|-------|-------------|------------|---------------|
| 2.1 | SSH connector (hub) | hub | ssh2 connect, launch `termora-agent --stdio`, frame I/O over SSH stdin/stdout |
| 2.2 | Session manager | hub | Session state machine (STARTING→ACTIVE→DISCONNECTED→CLOSED), channel state (BORN→LIVE→DEAD), DB persistence |
| 2.3 | REST API: hosts + sessions | hub | CRUD /hosts, GET /sessions, POST /hosts/:id/test, host list in UI |

**Dependencies:** M1 complete.

**Exit criteria (milestone):**
- Add SSH host via REST API
- Test connection succeeds (agent check)
- SPAWN remote channel → remote terminal visible in UI
- Multiple channels on same SSH session
- `exit` in remote shell → channel DEAD, session stays ACTIVE
- Host list shows both local and SSH hosts

**Demo scenario:**
```
$ curl -X POST localhost:4100/api/hosts \
    -H "Authorization: Bearer <token>" \
    -d '{"label":"dev-box","type":"ssh","ssh_host":"user@192.168.1.50"}'
→ Host created
→ Click host in UI → new channel → remote bash visible
→ Type commands on remote → output streams
```

---

### M3 — Session Persistence (Blocks 15–19)

**Goal:** Snapshot/restore, spool cache, reconnect after SSH drop, offline cache view.

| Block | Description | Package(s) | Exit Criteria |
|-------|-------------|------------|---------------|
| 3.1 | xterm headless on agent | agent | jsdom/linkedom polyfill, xterm.js headless, serialize()/deserialize(), SNAPSHOT_REQ/SNAPSHOT_RES |
| 3.2 | Snapshot scheduler (hub) | hub | Idle 3s / forced 5s / on-detach snapshot requests, store in spool.db (kind=snapshot) |
| 3.3 | Output chunking + spool | hub | 256KB chunks / 1s timer, write to spool.db, seq numbering, cache_index updates |
| 3.4 | ATTACH with restore | hub, web | ATTACH → snapshot + tail → ATTACH_OK → xterm deserialize + replay tail → seamless resume |
| 3.5 | SSH reconnect | hub | Retry backoff (1s→2s→4s→...→30s), re-HELLO, re-ATTACH all channels, UI overlay "Reconnecting..." |

**Dependencies:** M2 complete.

**Spike required:** Block 3.1 — validate xterm.js headless in Node.js with minimal DOM polyfill. If polyfill too heavy (>2MB), fallback to raw VT state buffer.

**Exit criteria (milestone):**
- Close browser tab → reopen → terminal restored with full content
- Kill SSH connection → hub retries → reconnects → no data lost
- Scrollback available from spool.db after reconnect
- Snapshot < 200ms for 120×40 terminal with 5000 lines scrollback
- GC runs and cleans old chunks (verify spool size stays bounded)

**Demo scenario:**
```
→ Run `top` in remote terminal
→ Close browser tab, wait 30s
→ Reopen browser → terminal shows current top output (snapshot + tail)
→ Scroll up → see output history from spool cache
```

---

### M4 — Multi-Client (Blocks 20–23)

**Goal:** Auth, multi-device pairing, write-lock for concurrent attach.

| Block | Description | Package(s) | Exit Criteria |
|-------|-------------|------------|---------------|
| 4.1 | Token auth | hub | Generate auth.json (32 bytes, chmod 600), Bearer header for REST, AUTH message for WS, startup permission check |
| 4.2 | Pairing flow | hub, web | POST /pair (generate code), POST /pair/verify (validate + return token), pairing UI screen, rate limiting |
| 4.3 | Write-lock 3-tier | hub | WRITE_CLAIM/GRANT/DENY/FORCE/RELEASE/REVOKED/LOCK messages, auto-release on disconnect, lock state in ATTACH_OK |
| 4.4 | Multi-client UI | web | Write-lock indicators (✍ writer, 👁 reader), lock request/grant notifications, force override button |

**Dependencies:** M3 complete.

**Exit criteria (milestone):**
- Unauthenticated WS/REST requests rejected (401)
- auth.json auto-generated, hard fail if world-readable
- Device B pairs via 6-digit code → gets token → sees same hosts/channels
- Two browsers attached to same channel → one writes, one reads
- Write-lock transfer (request/approve and force) works
- Lock state correct after writer disconnects

**Demo scenario:**
```
→ Device A: open termora, type commands (WRITER ✍)
→ Device B: open termora, enter pairing code → authenticated
→ Device B: click same channel → attached READ-ONLY (👁)
→ Device B: "Request write" → Device A gets notification
→ Device A: "Allow" → lock transfers → Device B now WRITER
```

---

### M5 — Polish (Blocks 24–30)

**Goal:** Discord-style UI, config cascade, CLI, first-run UX, production readiness.

| Block | Description | Package(s) | Exit Criteria |
|-------|-------------|------------|---------------|
| 5.1 | Host rail + icons | web | Auto-generated initials + color hash, status dots (●/○/🔴/◐), click to select |
| 5.2 | Channel sidebar + groups | web | Channel list per host, drag to reorder, groups (create/rename/collapse), unread indicators |
| 5.3 | Tabs + split panes | web | Tab bar, [+] new channel, split horizontal/vertical, drag divider, workspace layout persistence |
| 5.4 | Command palette | web | Ctrl+P fuzzy search (hosts, channels, actions), keyboard navigation |
| 5.5 | Config cascade | hub, web | 4-layer deep merge (defaults→TOML→host profile→channel profile), settings UI, remote visual hints (trust policy) |
| 5.6 | CLI commands | hub | `termora start/stop`, `termora host add/list/test`, `termora pair`, `termora session list`, `termora config` |
| 5.7 | Onboarding + packaging | root, web | First-run UX (local terminal auto-opens), the built executable starts and serves. npm was dropped as a channel — the unscoped name belongs to another project and the executable embeds its own Node |

**Dependencies:** M4 complete for auth-dependent features. M1 sufficient for UI blocks (can be parallelized).

**Exit criteria (milestone):**
- Discord-style 3-column layout fully functional
- Host icons, channel groups, tab bar, split panes all working
- `termora pair` generates pairing code from CLI
- the built `termora-hub` binary starts the hub and opens the browser (npm is not a channel — the unscoped name belongs to another project)
- Config cascade resolves correctly (layer 1→2→3→3.5→4)
- Remote visual hints applied when agent sends HELLO with hints
- Command palette finds hosts, channels, and actions

---

## 3. Block Dependencies Graph

```
M0: [0.1] → [0.2] → [0.3]
                ↓       ↓
            [0.4] (parallel with 0.3)

M1: [1.1]                       (hub HTTP server)
     [1.2] → [1.3]              (agent core → multiplexing)
     [1.4] ← [1.2] + [1.1]     (local agent spawn needs agent + hub)
     [1.4] → [1.5]              (WS transport needs local spawn)
     [1.6] ─────────→ [1.7]     (UI blocks can start once 0.2 done)

M2: [2.1] → [2.2] → [2.3]  (hub SSH: connector → session mgr → REST API)
     (2.1 reuses agent from M1 — no new agent work)

M3: [3.1] ← SPIKE (can start during M2)
     [3.2] → [3.3] → [3.4]
                        ↓
                      [3.5]

M4: [4.1] → [4.2]
     [4.3] → [4.4]     (4.3 + 4.1 can be parallel)

M5: [5.1] → [5.2] → [5.3] → [5.4]  (UI progressive)
     [5.5] (independent)
     [5.6] (depends on hub features from M1-M4)
     [5.7] (last — integration)
```

## 4. Parallelization Opportunities

| Phase | Parallel Tracks | Rationale |
|-------|----------------|-----------|
| M0 | 0.3 (storage) ∥ 0.4 (tooling) | Independent concerns |
| M1 | 1.6–1.7 (UI) ∥ 1.1–1.5 (hub + agent) | UI scaffold needs only shared types |
| M2 | 2.1–2.3 (hub SSH, sequential) | Agent already built in M1 — no parallel track needed |
| M3 | 3.1 (xterm headless spike) ∥ 3.2–3.3 (hub cache) | Spike can start early |
| M5 | 5.1–5.4 (UI) ∥ 5.5 (config) ∥ 5.6 (CLI) | Three independent tracks |

## 5. Risk Register

| Risk | Milestone | Impact | Mitigation | Fallback |
|------|-----------|--------|------------|----------|
| xterm.js headless DOM polyfill too heavy | M3 | HIGH | Spike in block 3.1 before committing | Raw VT state buffer (lose serialize compatibility) |
| node-pty Windows build issues | M1 | MEDIUM | Pin known-good version, CI matrix (Linux, macOS, Windows). node-pty only in agent, not hub. | Pin to known-good Windows version |
| ssh2 library limitations | M2 | MEDIUM | Test early with key/agent/password auth | Spawn `ssh` process as fallback |
| MessagePack debugging difficulty | M0 | LOW | Build CLI decode tool in block 0.2 | Hex dump mode in agent |
| Spool DB growth | M3 | MEDIUM | GC mandatory from day 1 (block 3.3) | Aggressive defaults (3 days, 200MB) |
| Vue 3 + xterm.js integration pain | M1 | MEDIUM | xterm.js well-supported, existing Vue wrappers | Direct DOM mount (skip Vue reactivity for terminal) |

## 6. Testing Strategy

### Per-Block Testing

| Layer | Tool | Coverage Target |
|-------|------|----------------|
| Unit | vitest | Shared types, protocol encode/decode, config merge |
| Integration | vitest + better-sqlite3 in-memory | Storage CRUD, migration runner, GC |
| E2E (local) | vitest + actual PTY | Hub spawns PTY, UI WS client sends INPUT, receives OUTPUT |
| E2E (remote) | vitest + mock SSH server | Hub connects to mock agent, full protocol flow |
| UI | vitest + @vue/test-utils | Component rendering, WS mock, state management |

### Mock Strategy

| Component | Mock | Real |
|-----------|------|------|
| SSH server | Always in CI (mock agent on localhost) | Manual testing only |
| PTY | Real (node-pty) on all platforms | — |
| SQLite | In-memory (`:memory:`) for unit tests | File-based for integration |
| WS | Mock WS server for UI tests | Real for E2E |

### CI Matrix

| Platform | Node | Priority |
|----------|------|----------|
| Ubuntu 22.04 | 20, 22 | P0 |
| macOS latest | 22 | P0 |
| Windows latest | 22 | P1 (after M1 validated) |

## 7. Non-Functional Requirements (MVP)

| Requirement | Target | Measured By |
|-------------|--------|------------|
| Input→output latency (local) | < 5ms | Benchmark: timestamp in INPUT vs OUTPUT |
| Input→output latency (remote) | SSH RTT + < 10ms | Same benchmark, account for network |
| Throughput per channel | 10 MB/s sustained | `cat /dev/urandom | head -c 100M` |
| Snapshot restore | < 200ms | Measure ATTACH→ATTACH_OK→rendered |
| Hub RSS (20 idle channels) | < 100 MB | Process memory after idle |
| Cold start (hub) | < 2s | Time from `termora start` to health endpoint responding |
| Spool GC | No user-visible pause | GC runs incremental_vacuum, not full VACUUM |

## 8. Post-MVP Priorities

| Feature | Priority | Milestone | Depends On |
|---------|----------|-----------|------------|
| Tauri desktop packaging | P1 | M6 | MVP stable |
| Search in scrollback | P1 | M6 | spool.db full-text index |
| OS keychain for auth token | P1 | M6 | — |
| Workspace export/import with blobs | P2 | M7 | — |
| SQLCipher encryption | P2 | M7 | — |
| OIDC / mTLS | P2 | M8 | — |
| Auto-install agent binary | P2 | M7 | Node SEA or pkg |
| Collaboration (multi-writer CRDT) | P2 | M8+ | Research required |

## 9. Success Criteria (MVP Release)

The MVP is ready for release when ALL of the following are true:

1. **Local terminal works:** Launch → type → see output → resize → no bugs
2. **Remote terminal works:** Add host → connect → remote shell → output streams
3. **Session persistence:** Close browser → reopen → terminal restored from snapshot
4. **SSH reconnect:** Kill connection → hub reconnects → no data lost
5. **Multi-device:** Pair device → attach to same channel → write-lock works
6. **Discord UI:** Host rail, channel sidebar, tabs, split panes — functional
7. **Config cascade:** Defaults → TOML → host → channel — merge correct
8. **Remote hints:** Agent HELLO with badge/theme → applied in UI
9. **CLI:** `termora start/stop/pair/host add/host list` all work
10. **the built `termora-hub` binary** starts and serves without a separate runtime install
11. **Tests pass** on Linux + macOS (Windows P1)
12. **No known CRITICAL or HIGH bugs**
