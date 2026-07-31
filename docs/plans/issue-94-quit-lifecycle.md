<!--
doc-meta:
  story_id: issue-94-quit-lifecycle
  status: canonical
  complexity: COMPLEX
  adversarial_applied: true
  llm_consensus_applied: true
  production_audit_applied: true
  issue: 94
  branch: feat/desktop-quit-lifecycle
-->

# #94 — Desktop clean shutdown / quit lifecycle

## §1 Scope

Give the desktop (Tauri) app a **clean, safe shutdown path** so the user never
has to manually `kill` the hub, with a configurable gesture model and a guard
for shared hubs.

**In scope (this workflow):**

1. **Configurable close behavior** — `closeBehavior` (`ask` | `tray` | `quit`,
   default `ask`), **stored desktop-local** (not hub config — see F17/C4),
   surfaced in the settings panel (desktop-only entry). On window close:
   - `tray` → hide to tray, hub keeps running.
   - `quit` → graceful hub stop (agent daemon persists — C5) then exit.
   - `ask` → close modal: **Quit completely** / **Minimize to tray** / Cancel,
     with `[x] Remember this choice` persisting `closeBehavior`.
2. **Tray "Quit"** — always a graceful full stop (independent of `closeBehavior`).
3. **Server-authoritative multi-client guard** — the hub itself refuses a stop
   that would cut other clients (HTTP `409` unless `force=1`); callers surface a
   confirm. The guard does not depend on a live webview (F18).
4. **Graceful, cross-platform shutdown** — `POST /api/shutdown`, **owner-token
   authenticated** (not the paired-client API token), **loopback-enforced**,
   idempotent, ordered teardown (agents awaited → DB closed → runtime.json
   removed last → exit) with a force-exit watchdog.
5. **Single-spawner fix** — release builds spawn the hub exactly once (Rust
   owns spawn in release; the Vue `startHub()` is gated dev-only).

**Out of scope (deferred):** see §8 (updater orchestration → #86).

## §2 Reality constraints & scope pivots (load-bearing — do not re-litigate)

This workflow implements volets **1 (gestures)** + **3 (multi-client guard)** of
issue #94 and **defers volet 2 (updater stop→install→relaunch)** to **#86**
(code-signing prerequisite); volet 2 is a design sketch only (§8).

- **C1 — Windows has no graceful SIGTERM.** CLI `termora-hub stop`
  (`process.kill(pid,"SIGTERM")`, `cli.ts:721`) is non-graceful on Windows
  (`TerminateProcess`). The issue's "wire `termora-hub stop`" intent is realized
  via a **REST shutdown endpoint the hub serves itself**, so teardown is
  identical on every OS. CLI `stop` is refactored to prefer HTTP, SIGTERM only as
  fallback. Do not revert the desktop to raw SIGTERM.
- **C2 — `app.exit(0)` orphans the hub.** Tauri v2 does not reliably kill a
  managed sidecar on hard exit → the user's reported orphan. Fix = stop the hub
  explicitly before exit.
- **C3 — Shutdown is a process-kill primitive; it must be MORE privileged than
  ordinary `/api/*`.** Remote clients reach the hub via SSH tunnel → their
  traffic arrives at `127.0.0.1`, so loopback alone does NOT exclude them, and a
  paired-client token must NOT be able to kill the hub. Shutdown is gated on an
  **owner token** written to `runtime.json` (chmod 600) at start, readable only
  by local processes (desktop/CLI on the same machine); a tunneled remote client
  cannot read it. (codex #1, opus F7/F18.)
- **C4 — `closeBehavior` is a per-device desktop preference, not hub state.**
  Storing it hub-global leaks across devices sharing one hub (opus F17). It lives
  in desktop-local storage (`localStorage`, gated on the existing
  `isTauriRuntime()`); the hub config cascade is not involved.
- **C5 — "Quit" stops the HUB gracefully; the local agent DAEMON intentionally
  persists.** The local agent is a detached/`unref`'d daemon by design (local
  PTYs survive hub restarts; reality audit confirmed the hub retains no child
  handle/PID — `agent-launcher.ts:163`). Killing it requires a NEW PID-tracking
  capability AND fights the local-first persistence model. Per the audit, this
  slice stops the hub gracefully (agent socket closed, agent daemon keeps
  running and is re-attached on next launch). **Full agent teardown is deferred
  to the updater path (#86, volet 2)** — that is the only flow that genuinely
  needs the agent stopped (to replace its locked binary on Windows). This is the
  headline decision surfaced at validation §2.6.

## §3 Current state (grounded — corrected per opus F16)

| Area | Location | Current behavior |
|------|----------|------------------|
| Hub spawn (Rust, release) | `desktop/src-tauri/src/lib.rs:266-286` `setup_app()` `#[cfg(not(dev))]` | **already probes** `runtime.json` + `is_hub_alive` before spawning `termora-hub start`; `app.manage(_child)` |
| Hub spawn (Vue) | `desktop/src/main.ts:8` → `desktop/src/lib.ts:6` `startHub()` | **unconditional** spawn `termora-hub --port N`, no gating → in release runs IN ADDITION to Rust = the real double-spawn |
| Tray "Quit" | `desktop/src-tauri/src/lib.rs:254` | `app.exit(0)` — no stop, hub orphaned |
| Window close | `desktop/src/main.ts:17` `onCloseRequested` | `preventDefault` → `stopHub()` (`child.kill()`) → `destroy()` |
| CLI stop | `hub/src/cli.ts:710` `cmdStop()` | reads runtime, `process.kill(SIGTERM)` then **immediately** `deleteRuntime()` (delete-before-dead race, F15) |
| Graceful shutdown | `cli.ts:701` SIGTERM/SIGINT → `deleteRuntime()` → `server.close()` → onClose (`server.ts:397`) → `sessionManager.shutdown()` (`session-manager.ts:257`) | teardown clears timers, `agent.close()` (**synchronous, not awaited**, :281), maps; **no DB close**; deleteRuntime BEFORE close |
| Auth hook | `server.ts:209-217` onRequest | uniform Bearer auth on `/api/*`; **`/api/health` exempt** (:217) |
| Bind host | `server.ts:416` | defaults `127.0.0.1` but **configurable**; auth hook does NOT check `request.ip` |
| Health endpoint | `server.ts:275` `GET /api/health` | `{status,version,build}` — unauthenticated |
| Clients map | `session-context.ts:165` `SharedSessionContext.clients` | `Map<clientId,WsClient>`; eviction-on-disconnect timing must be confirmed (F12) |
| Settings store | `web/src/stores/settings.ts:50-64` | cascade **lazy-loaded** only when `authStore.token !== null` → may be unloaded at close (F13) |
| Tauri | `desktop/src-tauri/Cargo.toml:19` | v2, `tray-icon` enabled |

## §4 Design (hardened)

### §4.1 Shared `gracefulShutdown()` (hub) — idempotent, ordered, bounded

One function called by SIGTERM, SIGINT, and the HTTP route. (codex #2/#3/#4,
opus F2/F3/F4/F8b/F9.)

1. **Idempotency latch** — module-level `let shutdownPromise`. First caller runs;
   later callers return the same promise (no double teardown). (F2)
2. **`await server.close()`** — stops accepting new connections and fires the
   `onClose` hook → `await sessionManager.shutdown()` (which aborts in-flight
   acquisitions — `Acq.shutdownAll`, documented/asserted, not "a bug" — clears
   timers, and **`await`s each `agent.close()`**). Agent close must be made
   awaitable: `AgentConnection.close()` becomes `Promise<void>`, `TermoraAgent`
   resolves on the socket `close` event, with a per-agent timeout. **The local
   agent daemon is NOT killed** (C5 — persists; socket closed only). (F1, F4)
3. **Close the database AFTER `server.close()`** — `sessionManager.shutdown()`
   uses `ctx.metaDal`/`ctx.chunker`, so the DB must still be open during step 2.
   The reality audit found the current `main.ts:67-70` order is INVERTED
   (`deleteRuntime → dbManager.close → server.close`) → use-after-close. Correct
   order: `server.close()` → `dbManager.close()`. Add an explicit
   `metaDb.pragma("wal_checkpoint(TRUNCATE)")` before close (durable WAL, unlocks
   files for #86 on Windows — better-sqlite3's implicit passive checkpoint is not
   sufficient). (F9, audit §1)
4. **Delete `runtime.json` LAST** (after DB close), then `process.exit(0)`. (F3)
5. **Force-exit watchdog** — `Promise.race([teardown, timeout(N)])`; on timeout
   log the stuck phase, `deleteRuntime()`, `process.exit(1)`. Never hang with
   runtime.json deleted. (F8b)

Ordered: latch → `server.close()` (→ shutdown→await agents) → `dbManager.close()`
(checkpoint) → `deleteRuntime()` → exit; watchdog wraps the whole teardown.

### §4.2 `POST /api/shutdown` (hub) — privileged, loopback, server-side guard

- **Owner token** required (header, e.g. `X-Termora-Owner: <token>`), NOT the
  paired-client Bearer. Token generated at hub start, written to `runtime.json`
  (chmod 600). Missing/invalid → `401`. (C3, codex #1)
- **Loopback enforced** — reject if `request.ip` not `127.0.0.1`/`::1`,
  independent of bind host → `403`. (F7)
- **POST only**, owner-token via header (never cookie/query) — this is what
  blocks CSRF/DNS-rebind; documented as load-bearing. (F8)
- **Server-side multi-client guard** — if connected clients other than the
  caller > 0 and `force` not set → `409 {others: N}`. With `?force=1` → proceed.
  Any caller (Rust tray, CLI, webview) gets the guard for free. (F18)
- Respond before teardown; then call `gracefulShutdown()`. Clients tolerate
  connection reset after the body. (codex S, F1)

### §4.3 Client count (hub) — authenticated

- `SessionManager.getOthersCount(callerClientId): number` — count clients whose
  id ≠ caller, after pruning dead entries. Computed relative to the caller, not
  `clientCount-1` arithmetic. (F12, codex #7)
- Exposed only to authed callers (the `409 {others}` body carries it; no
  separate unauthenticated surface). **`/api/health` shape unchanged** (the
  Rust spawn-probe has no token). (F6)

### §4.4 closeBehavior — desktop-local pref (C4)

Stored in desktop-local storage (Tauri store plugin or `localStorage` in the
webview), key `termora.closeBehavior`, default `"ask"`. Surfaced as a
desktop-only entry in `SettingsPanel.vue` (gated on `isTauri()`), read/written
directly to local storage — no hub `PUT /api/config`. The close modal's
`[x] Remember` writes the same key. (F17)

### §4.5 Desktop lifecycle wiring

Pure helpers in new `desktop/src/lifecycle.ts` (unit-tested):

- `resolveCloseAction(behavior): "modal" | "hide" | "quit"` — **`undefined`/
  unknown → "modal"** (treat as `ask`; never fall through to an un-prevented
  close). (F13)

`quitCompletely()` (shared by tray "Quit" and modal "Quit"):

1. `POST /api/shutdown` with owner token. On `409 {others:N}` → confirm
   "N other clients connected — stop anyway?"; on confirm retry with `force=1`;
   on cancel abort (window stays). (server-side guard, F18)
2. On `2xx`, or on fetch error/timeout (hub already down → treat as 0 others,
   proceed) → exit. (F14)
3. Keep the window alive until resolved, THEN `app.exit`. (F10)

`onCloseRequested` (`main.ts`): **`event.preventDefault()` FIRST on every
branch** (F10), then per `resolveCloseAction(localStorage.closeBehavior)`:

- `quit` → `quitCompletely()`.
- `tray` → if a tray icon is actually available → `getCurrentWindow().hide()`;
  else fall back to minimize (never strand the user). (F11)
- `modal` → show **CloseModal** (Quit / Minimize to tray / Cancel + `[x]
  Remember`); on resolve act as above and persist if remembered.

Tray "Quit" (`lib.rs`): the **authoritative** path is server-side (owner token +
409 guard), so the Rust handler reads the owner token from `runtime.json` and
`POST`s `/api/shutdown` **directly** (native confirm dialog on 409), independent
of the webview (F18). When the window is open it may instead delegate to the
webview modal for richer UX, but correctness does not depend on it.

Single-instance recovery: a second launch of the binary `show()`+`focus()`es the
existing window (recovery if hidden-to-tray and tray is gone). (F11 — minimal;
full single-instance plugin may be a follow-up.)

### §4.6 Single-spawner fix (F16/F5)

Release: **only Rust spawns** (it already probes, `lib.rs:266-277`). Gate
`main.ts`'s `startHub()` to **dev-only** (detect Tauri release via env/`__TAURI__`
build flag) so it does not run in release. The probe-before-spawn alone is TOCTOU
across two processes (F5); the gate is the real fix. Dev keeps the Vue spawn.

## §5 BDD scenarios

```
Scenario: Quit completely stops the hub gracefully (no orphan)
  Given closeBehavior = "quit"
  When the user closes the window
  Then POST /api/shutdown (owner token) is sent
  And the hub awaits agent close, closes the DB, removes runtime.json, exits 0
  And the app exits

Scenario: Shutdown is owner-token privileged (tunneled client cannot kill)
  Given a request to POST /api/shutdown with a paired-client Bearer but no owner token
  Then it is rejected 401
  And a request from a non-loopback remote address is rejected 403

Scenario: Server-side multi-client guard
  Given 1 other client is connected
  When POST /api/shutdown is sent without force
  Then the hub responds 409 {others:1} and does NOT shut down
  When the caller retries with force=1
  Then the hub shuts down

Scenario: Shutdown is idempotent
  Given a shutdown is in flight (HTTP)
  When SIGTERM also arrives
  Then it is a no-op (same in-flight promise); no double server.close

Scenario: Force-exit on hung close
  Given server.close() does not resolve within the timeout
  Then the hub deletes runtime.json and force-exits (nonzero)

Scenario: Close to tray keeps the hub alive (tray available)
  Given closeBehavior = "tray" and a tray icon is present
  When the user closes the window
  Then the window hides and GET /api/health still returns 200
  And if no tray is available, the window minimizes instead of hiding

Scenario: Ask modal + remember
  Given closeBehavior = "ask"
  When the user closes and picks "Minimize to tray" with [x] Remember
  Then the window hides and closeBehavior persists as "tray" (desktop-local)

Scenario: closeBehavior undefined at close (cascade unloaded)
  Given the settings/local store has no closeBehavior yet
  When the user closes the window
  Then resolveCloseAction returns "modal" (preventDefault, no orphan)

Scenario: Quit when hub already dead exits cleanly
  Given the hub is not running
  When quitCompletely() runs
  Then the shutdown fetch error is treated as 0 others and the app exits, no hang

Scenario: No double-spawn in release
  Given the Rust sidecar spawned the hub
  Then main.ts startHub() does not run in release (dev-only gate)
```

## §6 Implementation blocks (vertical slices)

| Block | Package | Scope / files | Observable success | Deps |
|-------|---------|---------------|--------------------|------|
| **B1a** Graceful shutdown core | hub | extract shared `gracefulShutdown()`: idempotency latch; **fix inverted order** (`server.close()` → `dbManager.close()` → `deleteRuntime()` → exit); make `AgentConnection.close()` async (`Promise<void>`, `TermoraAgent` resolves on socket close), `sessionManager.shutdown()` awaits agents (**no daemon kill** — C5); add `wal_checkpoint(TRUNCATE)` in `db.ts close()`; force-exit watchdog; wire SIGTERM/SIGINT; refactor `cmdStop` (prefer HTTP, SIGTERM fallback NOT deleting runtime on live-kill) | Integration: double-call no-op; agents awaited (socket closed); DB checkpointed+closed AFTER server.close; runtime.json removed last; force-exits on hung close; cmdStop fallback | none |
| **B1b** Shutdown route + owner token + guard | hub | `POST /api/shutdown` (branch in existing `onRequest`: `X-Termora-Owner` header + loopback `request.ip` check; server-side `409 {others}` guard, respond-then-teardown); generate `ownerToken` at start, add to `RuntimeInfo`, **apply chmod-600 to `persistRuntime`** (copy `auth.ts:103` fd pattern); `getOthersCount(callerId)` stale-prune; `/api/health` unchanged | Integration: 401 missing/invalid owner token; 403 non-loopback; 409 others>0 no force; 200+shutdown with force; runtime.json mode 600; health shape unchanged | B1a |
| **B2** closeBehavior desktop pref | desktop/web | `localStorage` key `termora.closeBehavior` default ask (**no new dep**); desktop-only entry in `SettingsPanel.vue` gated on existing `isTauriRuntime()` (`hub-url.ts:20`); no hub config | Unit: get/set default ask; persists in localStorage; non-Tauri does not show it | none |
| **B3** Desktop wiring | desktop | new `lifecycle.ts` (`resolveCloseAction` incl. undefined→modal, quit flow); `main.ts` close handler (preventDefault ALL branches, tray-availability fallback via new `is_tray_available` command); `CloseModal` + 409 confirm UI; `lib.rs`: **fix `_tray` drop bug (`app.manage(tray)`)** + `is_tray_available` command + tray-Quit → direct owner-token POST /api/shutdown + native confirm; gate `startHub()` dev-only (single-spawner) | Unit: `resolveCloseAction` truth table; quit flow handles 409→confirm→force and hub-dead→exit (fake fetch). Manual Windows+Linux smoke: §5 scenarios incl. tray actually visible | B1b, B2 |

B1a→B1b sequential (hub). B2 independent. B3 depends on B1b + B2.
Force-exit, DB-close ordering, re-entrancy, loopback, count, spawn-gate, the
`_tray` drop bug, and runtime.json perms are all explicitly owned above.

## §7 Test strategy

- **Hub (B1a/B1b):** vitest integration, real Fastify + in-memory SQLite, no
  mocks. Assert teardown ordering (spy real `dbManager.close`/`sessionManager`),
  child reaping, force-exit timeout, owner-token 401, loopback 403, guard 409,
  idempotency. cmdStop fallback against a dead port.
- **Desktop (B2/B3):** vitest unit on pure helpers + local-store pref + quit-flow
  decisions (injected fetch returning 200/409/error). Tauri-bound glue (tray
  emit, hide/destroy, native dialog) verified by a documented manual Windows +
  Linux smoke (Tauri runtime not in CI).
- Coverage 80/80 on new pure modules (`lifecycle.ts`, shutdown core helpers).

## §8 Deferred — updater orchestration (volet 2 → #86)

Design sketch only. Post-#86 (signing): version check (already shown by #92) →
user accepts → `POST /api/shutdown` (this PR, owner token) → installer replaces
now-unlocked `termora-hub.exe`/`termora-agent.exe` (the DB-close in §4.1 ensures
no lingering WAL locks) → relaunch. The clean stop here is the prerequisite.

## §12.5 Adversarial findings ledger (opus, 19 findings)

| # | Sev | Concern | Resolution |
|---|-----|---------|-----------|
| F1 | M | respond-then-exit drops in-flight handlers | §4.1.2 bounded grace + abort-acq documented; SHUTTING_DOWN broadcast → follow-up |
| F2 | M | double-shutdown re-entrancy | §4.1.1 idempotency latch |
| F3 | M | deleteRuntime before close → invisible orphan | §4.1.5 delete runtime LAST |
| F4 | M | agent.close() not awaited → orphan agent | §4.1.3 await closes + child-kill + assert PID |
| F5 | S | probe-before-spawn TOCTOU | §4.6 single designated spawner (gate, not probe) |
| F6 | M | clientCount on unauth /api/health = oracle | §4.3 authed-only; health unchanged |
| F7 | M | loopback assumed not enforced; bind configurable | §4.2 explicit request.ip 403 |
| F8 | S | CSRF blocked only by Bearer header | §4.2 POST+header load-bearing note |
| F8b | M | server.close may hang → never exit | §4.1.6 force-exit watchdog |
| F9 | M | no DB close before exit (WAL/Windows lock) | §4.1.4 dbManager.close() |
| F10 | M | webview torn down before exit fires | §4.5 preventDefault all branches, keep window alive |
| F11 | S | hide() strands user if no tray | §4.5 tray-availability fallback + single-instance re-show |
| F12 | M | clientCount-1 wrong on reconnect/stale | §4.3 getOthersCount(callerId) + prune |
| F13 | M | closeBehavior undefined at close | §4.5 resolveCloseAction(undefined)→modal |
| F14 | S | guard fetch failure aborts quit | §4.5.2 error→0 others, proceed |
| F15 | S | cmdStop deletes runtime before pid dead | §6 B1a fallback no-delete on live-kill |
| F16 | M | §3 evidence wrong (Rust already probes) | §3 corrected; root cause = main.ts unconditional |
| F17 | M | closeBehavior hub-global = cross-device leak | §4.4 desktop-local (C4) |
| F18 | M | guard+modal in torn-down webview fragile | §4.2 server-side 409 guard; Rust direct POST |
| F19 | S | block split leaves items unowned | §6 explicit ownership |

## §12.7 Spec-vs-reality audit ledger (sonnet)

| Topic | Verdict | Action folded |
|-------|---------|---------------|
| DB close/checkpoint | MISMATCH | `db.ts:103` `close()` exists but no WAL TRUNCATE; `main.ts:67-70` order INVERTED (DB closed before `server.close()`→`sessionManager.shutdown()` uses DB) → §4.1 reordered + `wal_checkpoint(TRUNCATE)` added |
| Agent close awaitable | GAP | `close():void` sync; local agent detached/`unref`'d, no retained PID → §4.1.2 makes close async on socket; **daemon kill deferred to #86** (C5) |
| Owner-token auth | GAP (clean) | single `onRequest` hook → add `/api/shutdown` branch (`X-Termora-Owner`+`request.ip`) |
| runtime.json perms | MISMATCH | `persistRuntime` uses default-mode `writeFileSync` (no 600) → apply `auth.ts:103` fd pattern; `ownerToken` field safe (Rust serde ignores unknowns) |
| Platform detect + store | EXISTS+GAP | `isTauriRuntime()` exists (`hub-url.ts:20`); `plugin-store` absent → use `localStorage` |
| Tray availability + single-instance | MISMATCH+GAP | **`_tray` dropped immediately (`lib.rs:245`) → tray non-functional in prod**; fix `app.manage(tray)` + add `is_tray_available`; single-instance plugin deferred |

## §12.6 /llm --spec consensus ledger

codex: success — converges with opus on owner-token (F7/F18), idempotent latch
(F2), ordered teardown + DB durability (F3/F9), awaited agent reaping (F4),
DNS-rebind/CSRF (F8), clientCount by identity (F12), default `ask` when unloaded
(F13). All folded above. gemini: failed (API error, exogenous). copilot: failed
(exit 1, exogenous). Consensus stage satisfied by one orthogonal engine; the
binding codex+copilot gate runs at pre-PR (§2.10.0).
