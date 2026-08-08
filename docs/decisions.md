# Architecture Decisions

Decisions archived from workflow — newest first.

---

## RELEASE-AUTO-CHAIN — merging the release PR is the whole release (2026-06-11)

- The multi-OS build chains directly off the release-please job via `workflow_call` (`release-build` job gated on `release_created`), in the same workflow run. Tag-triggered chaining is impossible by design: release-please pushes its tag with the default `GITHUB_TOKEN`, and GITHUB_TOKEN-created events never trigger workflows. The `push: tags` and `workflow_dispatch` triggers remain as recovery paths for re-building an existing tag.
- Releases are draft-until-built: release-please creates a DRAFT release (`draft: true`), assets attach to it, and `publish-release` flips it public only when every build succeeded — a mid-build failure can no longer leave a public release with partial assets. `force-tag-creation: true` is required with drafts: GitHub defers tag creation for draft releases, which would otherwise break release-please's next version computation.
- The chained caller passes the exact commit SHA (`ref` input) alongside the tag; all checkouts pin to `ref || tag`. `create-release` fails loudly if the tag exists but points at a different commit than the checkout — GitHub ignores `target_commitish` once a tag exists, so retargeting a release is impossible and refusing to build is the only safe behavior.
- Build hashes are stamped from `git rev-parse HEAD` of the checkout, never from the event SHA (wrong under dispatch on an older tag).
- release-please's draft (with its curated changelog body) is reused, never deleted/recreated; only duplicate drafts are pruned. Release listing uses `gh api --paginate` (a single 100-entry page would eventually miss the tag's release and duplicate the draft).

---

## RELEASE-VERSION-SYNC — release-please owns every version surface (#64, 2026-06-10)

- The release-please action is invoked in pure manifest mode (`manifest-file` + `config-file` only). `release-type` lives in the config's package block, never as an action input — as an input it selects the simple mode and silently ignores the config's `extra-files` (this is why three releases shipped without propagating versions).
- Every `extra-files` entry is a TYPED updater (`json`/`toml` with a jsonpath) targeting the version value directly. Bare strings are banned in this config: they select the annotation-based Generic updater, a guaranteed no-op on JSON files. `build-version.ts` is not an extra-file — it resolves its version at runtime (env → hub package.json).
- All version surfaces (root + 4 sub-packages + tauri.conf + 3 Cargo.toml) follow the single manifest version. The build-time jq/sed patch in `release.yml` remains as belt-and-braces for tag-dispatched builds.
- Known residual: release-please bumps Cargo.toml but not Cargo.lock; the lock self-heals at the next build (no CI cargo build uses `--locked`).
- Verification contract for any future config change: the open release PR's refreshed diff must list every declared extra-file (`gh pr diff <N> --name-only`) — a green action run alone proves nothing.

---

## HUB-DAEMON-SEA — SEA-aware daemon re-exec + readiness gate (#60, 2026-06-10)

- SEA daemon spawn re-execs the binary with CLI argv (`start --port N`) — the SEA bundle's entry IS cli.ts (footer auto-invokes `main(argv)`), so the existing foreground path provides everything (auth init, DBs, `persistRuntime`, shutdown handlers). No second entry point, no extracted script. `--daemon` is never re-passed (fork-bomb guard, locked by test). Dev mode keeps the compiled `main.js` sibling.
- Readiness is proven, never assumed: the parent polls `runtime.json` until `pid === child.pid` (immune to stale files/pid reuse), then probes `/api/health` on the port from runtime.json (zero_conf may shift it from the requested one). Success message only after a 200.
- Failure is loud and terminal: child stdout/stderr go to `hub-daemon.log` in the state dir (truncated per start so it can't grow unbounded; 0600 — daemon output may leak sensitive details); on child death or 5s timeout the CLI prints the cause plus a bounded log tail (64 KiB read cap) and exits 1. A timeout also SIGTERMs the child via the ChildProcess handle (never a raw pid kill — pid-reuse hazard): exit 1 must mean "no daemon is running".
- Health probes are individually bounded (single `healthTimeoutMs` constant feeding both the fetch AbortSignal and a race timeout) so a socket that accepts but never responds cannot hang the CLI past its deadline.
- Polling/probing logic lives in `daemon-launch.ts` as pure functions + injected-deps loop (no module mocks needed); the cmdStart wiring stays thin glue, untested by design (integration spawn test deferred — heavy and platform-fragile).

---

## DESKTOP-TRANSLUCENCY — Background modes + native window effects (#58, 2026-06-10)

- Three explicit background modes (image / solid / transparent) as per-scope `TerminalProfile` fields resolved through the 4-layer cascade — replaces the implicit "wallpaper set or not" model. Default `image`: with an empty wallpaper it renders solid, reproducing the pre-#58 states with zero profile migration.
- Desktop window is created `transparent: true` permanently on ALL OS (Tauri: transparency is creation-time-only); CSS paints opacity in non-transparent modes, so mode switches are instant and there is a single code path. Trade-off accepted: ~8× GPU power on macOS even for opaque content (tauri-apps/tauri#15471, open upstream) — macOS is not a tested distribution target; the mitigation (macOS-only restart-gated opt-out) is designed in `docs/briefs/desktop-translucency.md` and built only if real users report battery issues or upstream fixes the compositing path.
- `macos-private-api` feature accepted (required for macOS transparency) — App Store distribution is excluded by design (GitHub Releases only).
- The desktop single-instance lock lives at `/tmp/lasterm-<uid>/` on Unix and `%LOCALAPPDATA%\lasterm\runtime\` on Windows. The property is one path per user per host **whatever launched the app**, which is why `XDG_RUNTIME_DIR` cannot select it: a bare shell may not export it, so a launch from a desktop session and one from a terminal would take different paths and both become primary. `/tmp` is safe for this because its sticky bit lets only an entry's owner rename or remove it, and `$TMPDIR` on macOS is rejected for the same reason as `XDG_RUNTIME_DIR` — it is per-session. **This choice depends on the App Store exclusion above**: a sandboxed macOS application cannot write `/tmp`, so if that decision ever reverses, this one reverses with it.
- Window effects (mica/blur/acrylic/vibrancy) are runtime-settable and follow the active pane's scope like the window-wide wallpaper; `auto` resolves per OS + Windows build (Win11→mica, Win10→blur — never acrylic by default, documented lag); Linux gets no effects (compositor-dependent alpha only). Unknown mode/effect values degrade at the render boundary (mode→image, effect→none) — there is deliberately no value validation in the hub resolve path.
- OS detection via `tauri-plugin-os` (canonical upstream surface) rather than a hand-rolled Rust command or registry-reading crate.
- The native effect follows WHAT IS DISPLAYED: useWindowEffects consumes a single `displayedEffectState` derived from useActiveWallpaper's displayed background (resolved, cached, or fallback) — no resolution/scope boolean gating; an effect can never outlive the painted background. IPC is latest-wins, serialized, with mandatory re-apply after stale completions and clearEffects only when an effect was actually applied.
- REST bodies for profile writes are camelCase only; snake_case exists solely in config.toml (algorithmic conversion at the file boundary — no lookup table to maintain).
- Settings UI: the mode selector is visible in ALL runtimes (per-scope server-side setting honored by desktop clients; "(desktop only)" hint in browsers); the effect picker is Tauri-only and hidden on Linux (no native effects there). No "None" wallpaper tile — the grid only picks which image; removing the wallpaper is expressed by switching the mode to Solid.
- Capability hygiene: `core:window:allow-set-effects` + `os:allow-platform` + `os:allow-version` granted minimally to the main window (narrowest set for the two plugin-os calls used), locked by a config regression test.
- Public asset embedding is token-gated: `/public/*` serves `Cross-Origin-Resource-Policy: cross-origin` ONLY when the URL carries the per-boot asset token (`?asset_token=`, constant-time compare), distributed via the authenticated `GET /api/assets/token`. The desktop webview (`tauri://localhost`) needs cross-origin embeds; without the token, assets stay same-origin-protected against drive-by localhost embedding. `GET /api/fonts` and `GET /api/wallpapers` now require auth (their responses carry signed URLs).

---

## MULTICLIENT-SYNC — Multi-client channel sync & SSH reconnect (2026-06-05)

- CHANNEL_CREATED broadcast: new channels are announced to all connected clients via a CHANNEL_CREATED message carrying the full channel payload (status live, resolved display title) so observers add the channel without a manual refresh; the web client filters by active host and dedupes by channel id.
- Consistency invariant: the hub persists the channel row to meta.db before broadcasting CHANNEL_CREATED and before sending SPAWN_OK (synchronous, no await between), so the spawning client's post-SPAWN_OK fetchChannels always observes the new channel in the REST snapshot. Observer clients whose fetchChannels is already in flight are covered by in-flight reconciliation: channels added via CHANNEL_CREATED during a fetch are preserved when the (pre-creation) REST snapshot resolves.
- fetchChannels generation guard: fetchChannels captures a monotonic generation counter before any I/O and commits all state (channels, groups, error, loading) in a single block behind a post-await generation check, so a slow stale fetch can never overwrite newer state or clobber error state.
- SSH reconnect passphrase policy: reconnect uses a cache-only passphrase callback that returns the cached passphrase for an encrypted key (non-interactive, never prompts the UI) and evicts expired entries on access, consistent with the interactive TTL policy.

---

## LOGGING-DAEMON — Unified per-channel logging + Windows daemon mode (2026-03-21)

- Log granularity: per-channel (1 JSONL file = 1 terminal tab), correlates directly with spool.db (output) and meta.db (metadata) by channel_id
- Format: JSONL with relative offset `t` (ms since channel creation), first entry stores absolute `created_at` ISO 8601 for wall-clock recovery on reattach
- Hub global log: hub.jsonl with ISO 8601 timestamps for events not tied to a channel (startup, auth, config)
- Agent stderr routing: process-global → hub.jsonl (multi-channel/daemon). Exception: stdio mode (single-channel) → attribute to the sole channel's log
- Hub always sets `src:"agent"` on agent entries (prevents log injection from agent-controlled data)
- LOG protocol message: new AgentToHub::Log(channel_id, level, msg) for agent diagnostics — NOT a replacement for OUTPUT (PTY data)
- Daemon logging fallback: agent in daemon mode writes to file when no hub is connected to capture stderr
- Config [logging] in config.toml: level (trace..error), output (stderr/file/both), max_age_days (default 30), max_size_mb (default 50 per channel)
- GC: delete channel log files older than max_age_days at hub startup, AFTER daemon reattach (active channel set must be built first — PRE-04)
- max_size_mb: stop writing when exceeded (no rotation), log warning to hub.jsonl
- Lazy open/close file handles: no persistent WriteStream, open/write/close per batch (avoids file handle exhaustion at 100+ channels)
- hub.jsonl runtime rotation: check size before each write, if >10MB rename to .old and start fresh
- File permissions: 0o600 (owner read/write only) on all log files
- HubLogger serialized writes: single writer task/mutex to prevent interleaved JSON lines
- Daemon reattach: reopen existing channel log in append mode, read first line's `created_at` to recover offset baseline
- Windows daemon: tokio NamedPipeServer at `\\.\pipe\lasterm-agent-<username>`, cfg-gated (no trait abstraction)
- Named pipe ACL: SecurityDescriptor restricting access to current user SID (defense layer 1)
- Auth token on daemon connections: hub sends AUTH with token on connect, agent rejects after 5s timeout if invalid (defense layer 2, works on both UDS and named pipe)
- Cross-platform signals: tokio::signal::ctrl_c() replaces Unix-only SIGTERM/SIGINT for daemon shutdown
- Log search API: GET /api/logs/channels/:channelId and /api/logs/hub with query params (level, from_t, to_t, search, limit)
- Log search UI: LogViewer.vue component with level/source/text filters, lazy load pagination
- ConPTY stdout leak fix (pre-requisite): SetHandleInformation(stdout, HANDLE_FLAG_INHERIT, 0) in agent main.rs prevents conhost.exe from inheriting protocol pipe
- Integration test stderr: Stdio::inherit() instead of Stdio::piped() — piping without reading fills OS buffer and deadlocks tracing subscriber

---

## RUST-AGENT — Full Rust agent rewrite (async-xpty + lasterm-agent) (2026-03-21)

- New public crate async-xpty: direct OS APIs (nix + windows-sys), not a fork of portable-pty (sync-only, broken v0.9.0)
- Full agent scope (all 17 message types, daemon mode, elevation, snapshots, process title) — not MVP subset
- MessagePack serialization: rmp-serde to_vec_named() for map format (struct-as-array was flagged by 3/3 LLMs as blocker)
- Secrets: zeroize crate (Rust optimizer removes naive String::clear())
- Unix PTY: TIOCSCTTY required for Ctrl+C to work in child process
- ConPTY: HPCON passed as value to UpdateProcThreadAttribute (not pointer to value) — root cause of all prior ConPTY issues
- ConPTY pipes: no SECURITY_ATTRIBUTES (non-inheritable) — inheritable handles cause cmd.exe to inherit agent stdout
- PSEUDOCONSOLE_INHERIT_CURSOR: skip initial cursor position query (prevents DSR deadlock)
- DSR response: pre-emptive \x1b[1;1R sent immediately + detection in output stream
- Agent CLI: --stdio (default), --daemon, --socket, --buffer-per-channel, --buffer-global flags
- Zero-conf port: hub retries port+1 on EADDRINUSE (up to +99), writes actual port to runtime.json
- Desktop reads runtime.json only (no hardcoded port 4100 fallback)

---

## DESKTOP-LAUNCH — Desktop/Tauri launch fixes + shell discovery (2026-03-19)

- CSP disabled for Tauri webview (was blocking IPC + inline styles) — acceptable for local-first, permissive CSP deferred
- DevTools gated on `#[cfg(debug_assertions)]` — release builds don't auto-open
- Agent binary resolution: SEA mode uses co-located binary via `resolveAgentBinaryPath()`, dev mode uses `../../../agent/dist/main.js`
- PTY on Windows SEA: embed both `pty.node` (winpty) AND `conpty.node` (conpty) — node-pty auto-selects
- Default shell: `process.env.COMSPEC ?? "cmd.exe"` on Windows, `process.env.SHELL ?? "/bin/sh"` on Unix
- Shell discovery: parse `/etc/shells` on Unix (POSIX, works Linux+macOS), dedup by basename
- Shell discovery Windows: probe PowerShell Core, Windows PowerShell, cmd.exe, Git Bash, WSL distros
- Auto-seed launch profiles on first boot (idempotent, async non-blocking)
- Windows Terminal import: parse `settings.json` from `%LOCALAPPDATA%\Microsoft\Windows Terminal\`

---

## AUD-P0-SEC — P0 Security Audit Fixes: CORS allowlist, SSH TOFU, custom_command validation (2026-03-18)

- CORS: configurable origin allowlist via [server] cors_origins in config.toml, wildcard port matching
- CORS default: localhost + 127.0.0.1 any port + tauri://localhost + http://tauri.localhost
- CORS: strict ^...$ regex anchoring to prevent subdomain bypass
- custom_command: character ALLOWLIST [a-zA-Z0-9/\\._ :-], ASCII-only, absolute path
- custom_command: binary path only (no args), agent uses spawn with shell:false
- SSH TOFU: auto-accept first connect, reject+prompt on mismatch (30s timeout)
- SSH fingerprint: SHA256:<base64> format (OpenSSH compatible), self-hash raw key buffer
- SSH mismatch: HOST_VERIFY with promptId ULID + HOST_VERIFY_RESPONSE, pendingHostVerify Map
- SSH mismatch detection: explicit verificationState flag (lastKeyVerification.mismatch), not error text
- Bug fix: agent guard was `agent !== sshAgent` (wrong on first connect when agent=undefined); fixed to `agent != null`
- Review finding F-001 deferred: trust_once/trust_permanent both persist fingerprint (UI only exposes trust_permanent)

## PKG — Full Packaging Pipeline: SEA Binaries + CI + Auto-Deploy + Tauri (2026-03-13)

- Two separate SEA binaries: lasterm-agent (node-pty) + lasterm-hub (better-sqlite3)
- Hub finds agent binary in same directory or PATH (sea-agent-resolver.ts)
- Node SEA assets + getRawAsset() + process.dlopen() for native addon loading
- --experimental-sea-config + postject workflow (Node 20+ compatible)
- Agent: node-pty external (extracted to cache dir at startup)
- Hub: better-sqlite3 external (same pattern)
- Web UI embedded as static-manifest.json SEA asset, served in-memory by Fastify
- Hub SQL migrations embedded inline via esbuild plugin (no filesystem reads at runtime)
- Host os/arch: nullable fields with auto-detect fallback (migration 012, uname + PROCESSOR_ARCHITECTURE)
- Auto-deploy: best-effort, SshAgentDeployOptions opt-in, SFTP fastPut for large binaries
- Binary cache: ~/.local/state/lasterm/binaries/lasterm-agent-{os}-{arch}
- sshExec utility: generic SSH command execution with configurable timeout
- checkRemoteAgent: which/where first, then common paths fallback
- CI: 3-job pipeline (build-web → build-sea 5-platform matrix → release), GitHub Releases
- Tauri v2: hub as sidecar (no glue layer), webview loads localhost:4100
- System tray (show/quit), auto-updater (pubkey placeholder), shell plugin for sidecar

---

## ELEV-CONFIG — Configurable Elevation Methods + Passwordless-First Flow (2026-03-13)

- ElevationMethod includes 'custom' option for user-defined elevation commands
- Custom elevation: command receives '-- shell args...' suffix, no askpass flow
- Passwordless-first: try without password → SPAWN_ERR → prompt → retry
- Config cascade: global (config.toml) → per-host (meta.db)
- Methods: sudo, doas, pkexec (Linux/macOS), gsudo (Windows), custom (all)
- sudo -H flag fixes HOME issue (replaces -E alone)
- customCommand added to AgentSpawnMessage for agent-side custom elevation
- _sendSpawnAndWait extracted in session-manager for spawn retry pattern
- Migration 010: elevation_method + custom_command columns on hosts with CHECK constraint
- Per-OS custom commands: customCommandLinux/Darwin/Windows (not single customCommand)
- Custom ElevationCategory.vue: 3 OS sections, custom command field disabled unless method=custom
- Migration 011: elevated + elevation_method columns on channels (restart preserves elevation)
- restartChannel: two-step elevation flow mirrors handleSpawn (cache → passwordless → prompt)

---

## launch-profiles — Launch Profiles — Windows Terminal-style named launch configurations with elevation (2026-03-12)

- LaunchProfile as first-class entity in meta.db (not config.toml) — relational queries, CRUD API, FK references
- Dual-layer visibility: supported_os auto-filter + host_launch_profiles join table (pin/hide/default)
- Seed pattern: profile copied into channel at spawn time, not inherited live
- Variable expansion: one-pass left-to-right, agent-side, shared implementation
- Elevation: hub-centric credential management — collect (Web UI modal) → store (hub cache) → deliver (spawn msg) → execute (agent ASKPASS/gsudo)
- Linux/macOS elevation: sudo -A + ASKPASS script (password never in PTY stream)
- Windows local elevation: gsudo + UAC caching (no password from hub)
- Windows SSH elevation: NOT SUPPORTED MVP — deferred to agent packaging (CreateProcessWithLogonW)
- Reuse AUTH_PROMPT with promptType: 'elevation' (no new message types)
- Profile names: COLLATE NOCASE (case-insensitive uniqueness)
- Command palette prefix: ~ for profiles (# already used for channels)
- Shell validation: block ;|&$`, allow () for Windows paths
- Env masking: sentinel ******** preserved on PUT (no round-trip clobber)
- Migration 009: dual-source (hosts.default_shell + config.toml), per-host wins default slot

---

## TITLE-HUB-RESOLVE — Move title resolution from client to hub (2026-03-11)

- Hub resolves displayTitle using resolveChannelDisplayName (shared) — single source of truth
- displayTitle is computed (not stored in DB) — derived from title + dynamicTitle + processTitle + config
- Hub broadcasts displayTitle in TITLE_CHANGE/PROCESS_TITLE/ATTACH_OK messages
- Client uses channel.displayTitle everywhere — removes mode logic from 6 locations
- liveDynamicTitle (xterm.js local) stays as optimistic override in useTabTitle for active terminal only
- Config change (title section) triggers re-resolution of all active channels' displayTitles via broadcastDisplayTitles()
- ConfigResolver injected as optional 4th param to SessionManager constructor (null-safe)
- ChannelState tracks dynamicTitle/processTitle/displayTitle in memory (not stored in DB)
- handleAttach backfills ChannelState from DB on first attach (hub-restart scenario)
- notifyChannelRenamed() on SessionManager for F2 rename → displayTitle recompute + broadcast
- PUT /api/config/ui checks for 'title' key → calls sessionManager.broadcastDisplayTitles()
- F-002 fix: pendingAuthPrompts tracks clientId, cleaned on removeClient + shutdown
- F-003 fix: buildSshConnectConfig extracted in ssh-agent.ts (DRY for SshAgent.start + _testSshConnectivity)

---

## TEST-CONNECT-WS — Refactor test connectivity REST→WS via TEST_CONNECT message (2026-03-10)

- WS-only TEST_CONNECT replaces REST /api/hosts/:id/test and /api/hosts/test — single auth path
- TEST_CONNECT reuses AUTH_PROMPT mechanism from SPAWN for interactive password/passphrase prompting
- Lightweight SSH test (ssh2.Client ready event) — no agent spawn, no HELLO handshake
- REST routes and testSshConnectivity fully removed (no fallback)
- Unsaved hosts use generateId() as temporary hostId for WS correlation
- CLI cmdHostTest removed (can't do interactive auth via CLI)
- _buildPromptAuth extracted as DRY helper in SessionManager

---

## SSH-AUTH-PROMPT — SSH key passphrase + password prompting via AUTH_PROMPT/AUTH_PROMPT_RESPONSE (2026-03-10)

- AUTH_PROMPT/AUTH_PROMPT_RESPONSE protocol messages (same pattern as HOST_VERIFY)
- SshAgent takes AuthPromptFn callback (DI) — hub provides WS-based impl
- Detect encrypted key via PEM header before connect (proactive prompt)
- Secret never stored — used once for ssh2 connect, then GC'd
- Keytar/OS keychain deferred to P1 (Tauri desktop only)
- pendingAuthPrompts keyed by hostId (one prompt per host at a time), 60s timeout
- AuthPromptDialog centered modal (not bottom-right like WriteRequest), 60s countdown, Enter/Escape keys
- F-001 fix: validate apr.secret type+length in ws-handler (OWASP input validation)
- F-004/F-005 deferred to TODO (L priority, single-user mitigates risk)

---

## SC-23 — Host Groups as First-Class Entities (2026-03-09)

- host_groups table is global (not per-workspace) — same as current behavior
- ON DELETE SET NULL on FK — deleting group moves hosts to ungrouped
- Collapsed state stays localStorage (per-device UI pref, not worth syncing)
- Migration 007 creates table + FK column; migrateHostGroupData() auto-migrates existing host_group strings at startup
- Old host_group TEXT column stays (SQLite can't drop columns) — becomes unused
- DAL methods named listHostGroupEntities/getHostGroupEntity/deleteHostGroupEntity to avoid collision with existing string-based methods (legacy cleanup deferred)
- API: /api/host-groups CRUD + /reorder replaces old /api/hosts/groups/:name routes
- PUT /api/hosts/reorder body changed from group (name string) to group_id (ULID)
- Frontend: hostGroups ref populated via fetchHostGroups API, auto-called from fetchHosts
- useHostGroups composable: sections from hostsStore.hostGroups (DB-backed), collapsed by ID in localStorage, empty groups visible
- RailContextMenu.vue: right-click rail background → "Add host" / "Add group"
- DnD cross-group: drop host on group header moves to that group, drop on ungrouped removes from group
- Group reorder via DnD persists to DB (reorderHostGroups API), no more localStorage for group order

---

## SC-22 — Host group DnD reorder in host rail (2026-03-09)

- localStorage-based group ordering (not API) — host rail groups are derived from host.hostGroup strings, not ChannelGroup entities. Existing PUT /api/groups/reorder is for channel groups per host, not rail sections
- HTML5 DnD with text/x-lasterm-group dataTransfer type — same pattern as SC-21 tab reorder
- Splice index adjustment for forward drag: insertIdx = toIdx > fromIdx ? toIdx - 1 : toIdx (same pattern as TabBar.vue)

---

## SC-21 — Tab DnD reorder in tab bar (2026-03-09)

- Client-side only — no server API for tab order (localStorage via useLayout persist)
- dataTransfer type 'text/x-lasterm-tab' distinguishes tab DnD from pane DnD
- Reuse existing getDropInsertIndex() and CSS drop indicators
- reorderTab(from, to) splices tabs.value — existing watch auto-persists
- Guard against drag-during-rename (editingTabIndex check in onTabDragStart)
- toIndex adjusted by -1 when dragging right (removal shifts indices)

---

## UX-11 — Connection Experience (2026-03-09)

- Fuzzy matching: custom scoring (~40 lines), no external dep, char-by-char (no regex on user input)
- Quick connect parser: char-by-char for IPv6 bracket detection, ssh:// prefix support
- Modal tabs: Vue component-level (no router), v-show for state preservation, full ARIA (tablist/tab/tabpanel with id linkage)
- Recent items: localStorage-backed composable (useRecentPaletteItems), max 8, MRU eviction, graceful degradation
- Keybinding: Cmd+K/Ctrl+K replaces Ctrl+P/Cmd+P
- Prefix filters: single-char (> @ #), stripped from query before fuzzy match
- UI-only: no schema/protocol/API changes
- sshPort type: number|undefined (not number), placeholder "22", omit from API when empty
- Auth method UX: watcher clears sshKeyPath on switch away from "key"
- Host preview: previewInitials computed (first 2 chars uppercase), emoji support
- Connection string display: formatConnectionString shared utility (DRY), used by both palette descriptions and rail subtitles
- Fuzzy scoring hierarchy: EXACT(1000) > PREFIX(500) > SUBSTRING(200) > FUZZY(10+boundary bonus)
- Review fixes: ARIA id/aria-controls/aria-hidden linkage, SC-05 invalid port splits host from port, explicit port 0 check

---

## WALLPAPER — Configurable terminal wallpaper with cascade (2026-03-08)

- Wallpaper fields in TerminalProfile (cascades via existing 4-layer system)
- Upload to ~/.config/lasterm/wallpapers/, served at signed /public/wallpapers/ URLs (same pattern as fonts)
- Cover only (no contain/tile), blur 0-20px, dim 0-100%
- Layer stack: wallpaper-bg (z0) → wallpaper-dim (z1) → terminal (z2) → tint (z3)
- Upload validation: jpg/jpeg/png/webp/gif/avif, max 10MB via @fastify/multipart
- GET /api/wallpapers, POST, and DELETE require auth; thumbnail/runtime URLs append the per-boot asset token
- Path traversal: basename + directory containment
- X-Content-Type-Options: nosniff on static wallpapers route
- Cache-busting ?t=timestamp plus asset_token on wallpaper URLs
- useWallpaper composable: profile ref → wallpaperStyle + dimStyle computeds
- TerminalPane z-index: wallpaper-bg(0) → dim(1) → terminal(2) → tint(3)
- WallpaperCategory.vue: picker grid + upload + blur/dim sliders + scope override

---

## UX-09 — Settings Panel — Config Cascade UI (2026-03-08)

- D1: Global config persisted to config.toml (4-layer cascade preserved, no 5th layer)
- D2: Comment-preserving round-trip via @rainbowatcher/toml-edit-js (supersedes original D2)
- D3: Absorb existing AppearancePanel into Settings Panel (Appearance category)
- D4: @iarna/toml for parsing (read), @rainbowatcher/toml-edit-js for writes
- D5: Single GET /api/config/cascade endpoint returns all 4 layers + resolved
- D6: UiConfig (tabs/panes/search/startup) Global scope only — not cascaded to host/channel
- D7: Keybindings = read-only grouped list for MVP (no editor, no conflict detection)
- D8: Schema-driven categories (settingsSchema registry, generic CategoryContent renderer)
- D9: Input validation — whitelist known TerminalProfile/UiConfig keys, reject unknown
- D10: 500ms debounce on all setting mutations
- D11: Auto-fallback to Global tab when host/channel removed
- D12: Create config.toml on first write if missing
- D13: @rainbowatcher/toml-edit-js (303KB WASM) for comment-preserving config.toml writes
- D14: appearance.json absorbed into config.toml [appearance] — single portable config
- D15: autoSwitch via prefers-color-scheme (system) — no manual day_start/night_start

---

## UX-07 — Host Customization & Visual Profiles (2026-03-07)

- Visual profile stored in hosts.profile_json (no DB migration)
- Presets + resolvePreset() in web package, NOT shared
- Banner position fixed between pane header and terminal content
- Tint via CSS ::after pseudo-element with will-change: opacity
- No detectPresetFromProfile() — preset stored explicitly
- hostId prop passed through PaneLayout → TerminalPane for per-pane visual profile

---

## UX-05 — Notifications (2026-03-07)

- BELL + NOTIFICATION: new protocol messages (agent→hub→UI), camelCase interfaces
- Agent throttle: BELL 1/100ms, OSC9 1/500ms per channel via timestamp comparison
- Hub rate limit: BELL 10/sec, NOTIFICATION 5/sec per channel via sliding window
- OSC 9 sanitization: strip control chars, strip HTML tags, truncate 256 chars, trim
- Sound serving: @fastify/static at /public/sounds/ (same pattern as /public/fonts/)
- Notification store: shallowRef<Map> with replace-on-mutate for Vue reactivity
- Activity detection: UI-side only, newline counting in OUTPUT data, debounced
- Desktop notifications: Notification API tag-based grouping, 5s window
- Bell sound: system (AudioContext 800Hz sine), custom (Audio element), mute
- Scroll modes: auto (threshold-based), alwaysBottom, alwaysResume
- UnreadLinesBar: 999+ cap, mark-as-read + jump buttons
- Badge clear: only via scroll behavior (markRead/jump/naturalScroll), NOT on tab switch alone

---

## UX-03 — Host Management (2026-03-07)

- Migration 006: 6 new columns with defaults, backfill sort_order per-group using rowid
- listHosts ordering: local first, then COALESCE(host_group, '~') ASC, sort_order ASC
- Label regex updated to allow dots: /^[a-zA-Z0-9._-]+$/ per INV-02
- SSH config parser: manual (no dependency), supports Host/HostName/Port/User/IdentityFile/ProxyJump
- Batch import: atomic transaction, 409 with conflicting_labels array on conflict
- Route ordering: static routes before parameterized :id routes in Fastify
- Duplicate host: -copy suffix, auto-increment, cannot duplicate local
- sortedHosts computed: use server order directly (no client re-sorting)
- Host groups: collapse state persisted in localStorage (lasterm:collapsed-host-groups)
- HostRail: DnD via HTML5 drag/drop, reorder API call + fetchHosts on drop
- BatchImportModal: snake_case wire → camelCase conversion, ProxyJump auto-check, 409 conflict display
- HostRailSettings: singleton composable with localStorage persistence (lasterm:host-rail-settings)
- Rate limiting: in-memory sliding window 5/60s on test connection endpoints (INV-11)

---

## UX-04 — Scrollback Search (2026-03-07)

- @xterm/addon-search ^0.16.0 via pnpm catalog
- Decoration colors from CSS vars: --nt-search-highlight, --nt-search-highlight-active with yellow/pink fallbacks
- Match count via SearchAddon.onDidChangeResults event
- Regex validation client-side before passing to SearchAddon
- SearchAddon loaded after term.open() + fitAddon.fit() per INV-09
- SearchOverlay positioned absolute within TerminalPane
- 3 position variants: top-right, bottom-right, bottom-bar
- Ctrl+Shift+F via terminal.attachCustomKeyEventHandler
- Alt+C/R/W shortcuts via useSearchShortcuts composable
- Scrollbar markers: native xterm.js overview ruler (overviewRulerWidth: 15)
- scrollbarMarkers in TerminalProfile (default true)
- Multi-pane search: useMultiPaneSearch with PaneSearchHandle registry via provide/inject
- collectTerminalChannelIds: layout tree walk, skips vacant nodes
- Cross-pane navigation with wrap-around, skip zero-match panes
- Scope toggle visible only when countPanes > 1
- shallowRef for handle registry
- Search history: localStorage lasterm:search-history, MRU order, dedup by query+regex
- SearchConfig: position, highlightOnClose (clear/fade/persist), scrollbarMarkers, historySize
- Hub [search] section parser with DEFAULT_SEARCH_CONFIG
- highlightOnClose=fade uses 300ms setTimeout before clearDecorations
- getDecorationColors always returns matchOverviewRuler (transparent when disabled)
- historySize as MaybeRef<number> for reactive config

---

## UX-02 — Terminal Title / OSC 0/2 (2026-03-07)

- Dual approach: UI parses OSC locally for instant display (INV-04), agent sends TITLE_CHANGE to hub for DB persistence (INV-05)
- sanitizeTitle in shared/src/sanitize.ts: strips HTML tags (/<[^>]*>/g), strips C0/C1 control chars, trims, truncates to 256 — defense-in-depth (both agent and UI sanitize)
- Tag content preserved during HTML strip (e.g., `<script>alert(1)</script>vim` → `alert(1)vim`) — safe because Vue renders via .textContent, not innerHTML
- Agent debounce: per-channel 100ms last-write-wins timer for TITLE_CHANGE emission (INV-07)
- Hub debounce: per-channel 100ms last-write-wins timer for dynamic_title DB writes (INV-08), but broadcasts to UI immediately
- Empty OSC title suppressed (not sent as TITLE_CHANGE) per INV-09
- Migration 005-dynamic-title.sql: ALTER TABLE channels ADD COLUMN dynamic_title TEXT DEFAULT NULL
- dynamicTitle added to Channel entity + UiAttachOkMessage for reconnect recovery (SC-02)
- HeadlessTerminal.onTitleChange exposed for agent subscription, PtyManager.onTitleChange(channelId, cb)
- useTabTitle composable: INV-01 priority chain — custom > live dynamic > stored dynamic > fallback
- Title stack in useTerminal: max 5 entries, empty titles skipped, top of stack = currentDynamicTitle (SC-05)
- resolveTabLabel updated to accept dynamicTitle in channel objects
- TITLE_CHANGE WS handler in session store routes to channelsStore.setDynamicTitle
- ChannelItem shows dynamicTitle without prefix (SC-15)
- truncateTitle: 3 positions (end/middle/start), U+2026 ellipsis, default maxLength 50
- useWindowTitle: formatWindowTitle with {prefix},{host},{title},{channel},{shell} tokens, trailing/leading separator trimming, debounced 100ms
- TitleConfig interface: source, fallback, fallbackCustom, maxLength, truncation, prefix, windowTitle, windowFormat
- Hub [title] section parser with DEFAULT_TITLE_CONFIG, exposed via UiConfig
- resolvedTitle exposed from useTabTitle for window title composition (raw, no prefix/truncation)
- Prefix prepended BEFORE truncation (counts toward char limit), sidebar excluded from prefix
- Reset Title to Dynamic: clears channel.title via PATCH null, TabContextMenu enabled when isCustom
- clearTitle action in channels store wraps renameChannel(id, null)
- TitleConfig.source='static' disables dynamic titles, TitleConfig.fallback controls fallback strategy (channel/shell/custom)

---

## UX-01 — Tab Actions, Split Panes & Welcome Tab (2026-03-07)

- TabContextMenu: Teleport to body, click-outside listener, fixed positioning from event coords
- Close actions (closeOthers/closeToRight/closeAll): vacate panes in other tabs, tabs stay open (never removed)
- vacateAllPanesInTab: walks layout tree, replaces all terminal nodes with vacant
- closeAll accepts optional exceptWelcomeId for welcome tab protection (INV-06)
- Vacant nodes carry unique id (generateId()) to distinguish multiple vacant slots in same tree
- vacatePane replaces terminal node in-place with vacant (preserving split structure)
- rearrangeVacant collapses parent split; does nothing if root vacant (INV-04: tab never auto-closes)
- onClosePane no longer kills terminals — INV-03 compliance (detach, never kill)
- countPanes exported as standalone function for max-4-pane enforcement (INV-02)
- Welcome tab: per-host, enforced via transaction (clears previous before setting new), migration 003
- Star icon: Unicode ★ with --nt-accent color in both TabBar and ChannelItem
- Cross-tab DnD: vacate-first strategy prevents duplicate channelId in same-tab moves
- DnD: paneId-based targeting for precise node replacement in tree, header as drag handle
- DnD: 5 drop zones (left/right 25%, top/bottom 25%, center 50%)
- Configure Command: migration 004 (icon, args, direct_process columns added to channels)
- SPAWN message extended with args/directProcess; agent PtyManager honors in pty.spawn
- POST /api/channels/:id/restart: kills + re-spawns with saved config
- Exit overlay for directProcess channels: Restart / Configure Command / Close buttons
- Channel sidebar: context menu inline in ChannelItem (no separate component — reduces indirection)
- Open in Current Tab: uses replaceChannelId to swap active tab content
- ConfirmDialog: generic reusable component with "Remember for host" / "Remember globally" checkboxes
- Remember preferences: localStorage lasterm:skipConfirm* keys with explicit actionKey (not title parsing)
- Config sections: [tabs] [panes] [channels] [startup] in config.toml
- Config defaults: confirmCloseAll=true, confirmCloseOthers=true, maxPanes=4, autoOpenWelcome=true
- Welcome endpoint cross-host check: verifies channel.hostId matches path param host ID

---

## UX-06 — Theming & Color Schemes (2026-03-07)

- CSS custom properties as single source of truth for all chrome colors (--nt-* prefix, 48+ vars in 3 tiers)
- Theme files on disk (~/.config/lasterm/themes/), not DB — portable, git-friendly
- 9 bundled presets (6 dark, 3 light), default catppuccin-mocha, copy-if-missing strategy
- AppearanceConfig = global only; theme NAME = per-host via TerminalProfile cascade
- AppearanceConfig persisted in appearance.json (not config.toml) — simpler read/write
- Theme name validation: /^[a-z0-9-]+$/ with path traversal prevention in get/delete
- LastermTheme = colors (22 terminal) + ui (15 chrome), validateTheme returns {valid, errors[]}
- BUNDLED_THEMES as Record<string, LastermTheme> in shared/themes/index.ts
- ThemeManager uses fs/promises (async), ThemeError for structured errors
- Terminal theme propagation via callback Set in theme store — toXtermTheme() + onTerminalThemeChange()
- Per-host theme override: useTerminal checks profile.theme, resolves from availableThemes (SC-03)
- Live preview hover debounced via requestAnimationFrame (INV-08)
- setTheme() disables autoSwitch when enabled (SC-14)
- AppearancePanel as Teleported right-side slide-out panel (480px) with overlay backdrop
- ThemeEditor: deep watcher on draft colors with rAF debounce for live preview
- useAutoSwitch composable with matchMedia listener, onScopeDispose cleanup
- Opacity via --nt-*-alpha CSS vars + rgba(var(--nt-*-rgb), var(--nt-*-alpha)) pattern
- Scrollbar: --nt-scrollbar-width CSS var, style thin/wide/hidden
- deepMerge generic constraint relaxed to T extends object (was Record<string,unknown>)

---

## AGENT-DAEMON — Standalone agent daemon with UDS/named pipe transport (2026-03-06)

- Node.js net module for cross-platform socket transport (UDS + named pipes, same API)
- Socket path per-user: $XDG_RUNTIME_DIR/lasterm/agent.sock (Linux) / \\.\pipe\lasterm-agent-<username> (Windows)
- Socket probing for agent discovery (net.connect then close) — no PID file for liveness
- Hub auto-starts agent as detached process (spawn + unref) if socket not found
- --daemon (new, socket) / --stdio (unchanged, kept for SshAgent until Phase 2)
- Same MessagePack framing over socket as over stdio — only transport layer changes
- AGENT_CHANNEL_STATE + CHANNEL_STATE_END messages for reconnect reconciliation
- Output buffering: configurable per-channel cap (1MB default) + global cap (20MB default), ring buffer
- LastermAgent: single concrete class replacing AgentConnection abstract, constructor(Duplex), factory methods
- LocalAgent + SshAgent untouched — used until Phase 2 replaces SshAgent with SSH tunnel + LastermAgent
- Last-connection-wins: new hub connection displaces previous
- Warm restart (agent died) vs reconnect (hub died) — distinct documented flows
- Agent daemon logs to <stateDir>/agent.log when detached
- EACCES on probe: don't unlink, throw (different user's socket)
- [agent] section in config.toml for buffer caps, socket_path override, log_level
- Tests use real UDS in temp dirs, NOT stdio mocks
- Phase 2 = remote agent daemon via SSH tunnel (LastermAgent.connectTunnel) — separate story

---

## channel-delete-flow — DELETE endpoint + dead channel UI + tab scroll (2026-03-06)

- DELETE /api/channels/:id: sends DESTROY to agent, marks dead in DB, broadcasts CHANNEL_STATE
- SessionManager.destroyChannel(): centralizes PTY kill + scheduler/chunker untrack + channel map cleanup
- UI removeChannel: calls DELETE API, marks dead + nextTick (for watcher to close tab), then filters
- WriteLockIndicator isDead prop: hides Force Take / Request Write on dead AND orphan channels
- Tab bar horizontal scroll: visible thin scrollbar, mouse wheel→horizontal, auto-scroll to active tab on selection

---

## host-dot-dead-tab — Fix host status dot + configurable dead channel tab behavior (2026-03-06)

- New [ui] section in config.toml for UI behavioral config (separate from terminal profile)
- on_channel_dead: 'close' (default) | 'readonly' — configurable tab behavior
- GET /api/config/ui endpoint to expose UI config to frontend
- addClient sends initial SESSION_STATE for all active sessions
- sessionStatusToHostStatus: 'detached' maps to 'live' (green) — agent running = host reachable
- listChannels() excludes dead channels (WHERE status != 'dead') — dead channels are internal bookkeeping

---

## s-backlog-sweep — Fix all S-priority review backlog items (2026-03-05)

- DEFAULT_CHANNEL_NAME constant in shared/constants.ts replaces all hardcoded "Terminal"
- purgeDeadTabs and resolveTabLabel as pure functions in useLayout (DI, no store dependency)
- WS_RECONNECT refactored to dedicated onReconnect/onDisconnect lifecycle events on WsClient
- Auth hook uses URL pathname parsing for exact path matching
- Pairing code retry loop (5 attempts) with SQLite UNIQUE constraint catch
- cols/rows stored in meta.db channels table, passed through SPAWN and warm restart
- SnapshotScheduler max 4 concurrent snapshots with inFlight counter
- _spawnChannelsForHost 10s per-channel SPAWN timeout

---

## m-backlog-sweep — Fix all M-priority review backlog items (2026-03-05)

- GC dead_retention_hours and max_size_per_channel_mb configurable via config.toml [gc] section
- SendQueue extracted to shared class with pending/isDraining/frames getters
- Session reuse already implemented — backlog item was obsolete
- WS input validation in shared/validation.ts (ULID, dimensions, data size, env)
- useRename composable with onCommit callback pattern

---

## editable-channel-names — Editable channel names + backpressure + font fix (2026-03-05)

- channels.title column already exists in DB (nullable) — leverage existing schema
- Default channel name: "Terminal" (simplified from Shell #N counting approach)
- PATCH /api/channels/:id for rename with 1-128 char validation
- Optimistic UI update with rollback on PATCH failure
- Double-click to rename in both sidebar ChannelItem and TabBar
- v-show keep-alive for tabs: prevents terminal replay/destruction on tab switch
- Backpressure across agent→hub pipeline: pause/drain in agent, send queues in LocalAgent/SshAgent
- Font watcher race fix: removed ready.value guard, apply profile unconditionally

---

## [backfill] Channel lifecycle & session persistence (2026-03-04)

- On hub restart: mark all channels dead + sessions closed via startup sweep (markAllChannelsDead)
- ATTACH protocol: TerminalPane sends ATTACH → hub replies ATTACH_OK with snapshot + tail → xterm restore
- Three ATTACH cases: new channel (empty), orphan with live agent (fresh snapshot), orphan with dead agent (cached from spool.db)
- Warm restart: respawn agent with same channel IDs to restore content (optional channelId in SPAWN message)
- CHANNEL_DEAD error code distinguishes "never existed" from "stale after restart"
- CHANNEL_STATE listener moved from App.vue watch to SessionStore.connect() — fixes race condition
- Terminal RESIZE deduplication: track lastSentCols/Rows, debounce 50ms, skip if unchanged
- canWrite ref in useTerminal: default true (single-client), set false until auth confirms ownership

---

## [backfill] Custom fonts & config cascade wiring (2026-03-04)

- Cross-platform font stack: Consolas → Liberation Mono → Courier New → monospace (no embedding, licensing)
- User fonts: drop .woff2/.woff/.ttf/.otf in ~/.config/lasterm/fonts/, auto-discovered
- Font serving: second @fastify/static at signed /public/fonts/ URLs (decorateReply: false for multi-static)
- Font filename heuristic: family slug from first segment, camelCase→spaces, suffixes→weight (Regular=400, Bold=700)
- GET /api/fonts requires auth because returned font URLs carry the per-boot asset token
- Dynamic @font-face injection: <style> element appended to <head> at startup
- Config load bug: ConfigResolver.loadFromFile() was never called — instantiated but not invoked
- Config store: Pinia useConfigStore.load() fetches /api/fonts + /api/config/resolved in parallel
- Profile propagation: useTerminal(containerRef, wsClient, profile?) — optional param, defaults to DEFAULT_PROFILE

---

## MVP-LASTERM — Implement full lasterm MVP (2026-03-03)

- Plan-provided mode: specs in docs/
- Continuous mode: no pauses between stages

- HostRail: djb2 hash → HSL palette, 48px column
- ChannelSidebar: groups in localStorage, drag not needed for MVP
- PaneLayout: recursive split tree, localStorage persistence
- CommandPalette: module-level singleton, fuzzy includes match
- ConfigResolver: 4-layer deep merge, null removes key, arrays replace
- CLI: manual argv parser (no yargs/commander), dynamic imports for heavy deps
- Onboarding: auto-create local host, openBrowser via execFile
- Token auth: 32-byte hex, timingSafeEqual, chmod 600 auth.json
- Pairing: 6-digit code (padStart), 60s expiry, max 3 active
- Write-lock: 3-tier (auto-claim, request/grant, force), first-attach=writer
- WriteLockManager: standalone class with DI callbacks
- @xterm/headless CJS: default import + destructure
- Auth hook skips /health and /pair/verify

---

## [backfill] Foundational architecture — Stack & design decisions (2026-03-03)

- HTTP server: Fastify (perf + TS-first + plugin ecosystem)
- Database: SQLite via better-sqlite3 with WAL mode — meta.db (state) + spool.db (output chunks/snapshots)
- PTY: node-pty for local spawn, agent-only PTY control (hub never touches PTY directly)
- SSH: ssh2 library, agent launched via `lasterm-agent --stdio` over SSH
- WebSocket codec: MessagePack binary serialization (snake_case on wire, camelCase in TS)
- UI: Vue 3 + Vite SPA with Pinia state management
- Terminal: xterm.js (browser rendering) + @xterm/headless (snapshot capture without DOM)
- IDs: ULID everywhere (sortable, monotonic, better DB indexing than UUID)
- Monorepo: pnpm workspaces — packages: agent, hub, web, shared, cli
- Protocol: unified protocol.ts — single source of truth for all message schemas (HELLO, SPAWN, ATTACH, AUTH, SNAPSHOT, LOCK...)
- Entity model: Host (permanent) → Session (runtime) → Channel (PTY instance)
- Session state machine: STARTING → ACTIVE → DISCONNECTED → CLOSED, persisted in meta.db
- Architecture: local-first hub daemon, agents spawned as children (local) or via SSH (remote)
- REST API: all routes under /api/ prefix, WebSocket at /ws (no /api)
- Default port: 4100 with zero-conf auto-increment fallback
- Snapshot: event-driven scheduler → chunks in spool.db with cache_index, GC preserves last per channel
- Formatting: biome with tabs
- Tests: vitest, colocated *.spec.ts
