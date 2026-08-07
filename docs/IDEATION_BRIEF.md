# lasterm — Ideation Brief

> Session terminal platform — local-first, multi-OS, hub/agent architecture

## Problem Statement

**Problem:** Les terminaux distants (SSH) n'ont pas de persistance session + reprise multi-device + UI moderne. On perd le contexte terminal quand on change de device ou de client.

**Root cause:** Il manque un hub local-first qui possède l'état (cache + snapshot) et orchestre les agents distants indépendamment du client UI.

**Target users:** Devs et SRE qui gèrent des machines distantes et veulent reprendre leurs sessions depuis n'importe quel device.

**Current solutions and gaps:**

| Solution | Gap |
|----------|-----|
| tmux/screen | CLI only, pas de cache local, UX archaïque |
| Tabby/Warp/iTerm | Pas de hub, pas de reprise multi-device |
| Eternal Terminal | Repair SSH seulement, pas multi-session |
| VS Code Remote | Lourd, IDE-centric, pas terminal-first |

## Proposed Solution

**Approach:** Hub local (daemon Node.js) + agents distants (lancés via SSH stdio) + UI PWA (Vue 3 + xterm.js). Local-first avec cache SQLite obligatoire.

**Why this approach:**
- SSH stdio = zéro port ouvert côté agent, réutilise auth SSH existante
- Hub local = possède l'état, survit aux déconnexions client
- PWA = cross-platform natif, packageable Tauri pour desktop
- SQLite WAL = persistance fiable, single-writer, concurrent reads

## Architecture Decisions

| Axe | Choix | Score | Alternative rejetée | Raison |
|-----|-------|-------|---------------------|--------|
| Transport agent↔hub | SSH stdio length-prefixed | 14 | WS agent (port ouvert), mosh UDP (complexe) | Simplicité + sécurité |
| Screen model | xterm.js headless + serialize | 14 | Custom VT parser (incompatible UI), raw buffer (pas de state) | Même parser front/back |
| Protocol framing | **MessagePack** | 14 | JSON (base64 overhead), Protobuf (overkill) | Uint8Array natif, compact |
| Storage | **2 SQLite** (meta + spool) | 14 | Single DB (GC couple meta), files (complexité) | GC/backup indépendants |
| Multi-client | Write-lock 3-tier (auto-release / request-approve / force) | 14 | CRDT (absurde pour terminal), LWW (corruption) | Terminal = séquentiel |
| Transport hub↔UI | **WS + REST** hybride, port unique | — | Tout WS (perd cache/curl), REST+SSE (latence) | WS=realtime, REST=CRUD |
| Session model | **1 session = N channels** (multiplex SSH) | — | 1:1 (N connexions SSH pour N shells) | Efficacité SSH |
| UI layout | **Discord-style 3-column** (host rail + channel sidebar + terminal) | — | Flat sidebar (no hierarchy), palette-only | Visual identity per host, scalable |
| UI navigation | **Sidebar + Command palette** (both) | — | Sidebar only, palette only | Flexibilité user |
| Host icons | **Auto-initials + color hash**, custom emoji/image | — | No icons (text only) | Instant visual identification |
| UI framework | **Vue 3** Composition API | 14 | React (= score, mais plus lourd runtime) | Léger, Tauri-ready, réactif |
| Desktop | PWA (MVP) → Tauri (P1) | 12 | Electron (150MB), Neutralino (écosystème limité) | PWA suffit, Tauri post-MVP |
| Config UX | **Cascade 4 layers** (defaults→TOML→host DB→channel DB) | — | Tout fichier (pas de per-host), tout DB (pas de dotfiles) | Deep merge, dotfiles + per-host override |
| Remote hints | **Agent visual hints in HELLO** (MVP) | — | Client-only config (no server-side hints) | Killer feature — serveur impose badge/theme |

## Key Features

### MVP (Must Have)

1. **Local PTY via agent** — hub spawns agent locally (child_process --stdio), agent manages PTY: bash/zsh (Linux/macOS), pwsh/cmd/wsl (Windows) via node-pty
2. **Remote PTY via SSH stdio agent** — hub launches agent via SSH, same protocol as local. Agent is the universal PTY manager.
3. **Snapshot + reconnect** — xterm serialize, cache hub, restore instantané
4. **Multi-device attach** — un client se déconnecte, un autre attache au même channel
5. **Multi-tab/pane UI** — Vue 3 + xterm.js, split horizontal/vertical, tabs
6. **Cache local hub** — snapshot + tail dans spool.db, offline view
7. **Connection manager** — add/test host SSH, lister sessions distantes
8. **Resize cohérent** — PTY + screen model + UI synchronisés
9. **Auth locale** — token crypto, pairing code pour multi-device
10. **CLI** — start/stop, host add/list/test, session list/attach, workspace export/import
11. **Config cascade** — 4 layers (defaults→TOML→host profile→channel profile), deep merge
12. **Remote visual hints** — agent sends badge/theme in HELLO, hub applies per policy

13. **Write-lock 3-tier** — auto-release + request/approve + force override
14. **Discord-style 3-column UI** — host rail (icons) + channel sidebar (groups) + terminal main
15. **Channel groups** — user-defined categories per host (like Discord categories), collapsible
16. **Command palette** — Ctrl+P fuzzy search (hosts, channels, actions)
17. **Host icons** — auto-generated (initial + color hash), customizable (emoji/image)

### P1 (After MVP)

18. Tauri desktop packaging
19. Search in scrollback (full-text)
20. OS keychain pour SSH secrets (keytar)

### P2 (Later)

21. Workspace export/import avec blobs
22. SQLCipher encryption at-rest
23. OIDC/mTLS
24. Auto-install agent si Node absent (pkg/sea binary)
25. Collaboration multi-writers

## Technical Considerations

### Stack

| Component | Technology |
|-----------|-----------|
| Hub | Node.js + TypeScript strict |
| Agent | Node.js + TypeScript strict |
| UI | Vite + Vue 3 + Composition API |
| Terminal | xterm.js + addon-fit + addon-serialize |
| PTY | node-pty |
| Storage | better-sqlite3 (WAL mode) |
| Codec | @msgpack/msgpack |
| SSH | ssh2 (Node.js native) |
| Desktop (P1) | Tauri v2 |
| Monorepo | pnpm workspaces |

### Security Model

| Layer | MVP Solution |
|-------|-------------|
| Hub bind | 127.0.0.1 only (default) |
| WS/REST auth | Token crypto random → auth.json (chmod 600) |
| Multi-device auth | Pairing code (6 digits, 60s expiry) |
| SSH secrets | ssh-agent forwarding, fallback fichier chmod 600 |
| Spool protection | DB files chmod 600 |
| Agent transport | SSH (pas de port agent public) |

### Performance Targets

| Metric | Target |
|--------|--------|
| Input→output latency (local) | < 5ms |
| Input→output latency (remote) | SSH RTT + < 10ms |
| Sustained throughput/channel | 10 MB/s (backpressure) |
| Snapshot restore | < 200ms |
| Hub RSS (20 idle channels) | < 100MB |

### Config Architecture — Cascade 4 Layers

Resolution order (deep merge, last wins):

```
1. Built-in defaults         (code — sensible defaults, catppuccin-mocha)
2. User global config        ($LASTERM_CONFIG_DIR/config.toml — XDG on Linux, %APPDATA% on Windows)
3. Host profile override     (meta.db hosts.profile_json — per-host)
4. Channel profile override  (meta.db channels.profile_json — per-session)
```

Example: User sets font=JetBrains + theme=catppuccin globally (layer 2).
Host "prod-web-01" overrides background=#2d0000 + badge="PROD" (layer 3).
Result: JetBrains + catppuccin BUT red background + PROD badge on that pane.

```
Config dir ($XDG_CONFIG_HOME/lasterm/ or %APPDATA%\lasterm\):
├── config.toml          # Layer 2: theme, fonts, keybindings, defaults (user-editable)
└── auth.json            # Token (chmod 600 / ACL, auto-generated)

Data dir ($XDG_DATA_HOME/lasterm/ or %LOCALAPPDATA%\lasterm\):
├── meta.db              # Layers 3-4: host/channel profiles + relational data
└── spool.db             # Output chunks, snapshots

State dir ($XDG_STATE_HOME/lasterm/ or %LOCALAPPDATA%\lasterm\):
└── runtime.json         # { port, pid, started_at } — discovery for CLI/UI
```

### Remote Visual Hints (MVP — killer feature)

Agent can send visual hints in HELLO message:

```
HELLO {
  version, capabilities,
  visual_hints: {
    badge: { text: "PROD", color: "#ff4444" },
    theme_overlay: { background: "#2d0000" }
  }
}
```

Hub policy (user-configurable): `trust_remote_hints = "apply" | "ask" | "ignore"`

This is a layer 3.5 — applied after host profile, before channel profile.
No existing terminal does this. Differentiator.

### Transport Local (hub ↔ UI)

Single HTTP server on one port (default 4100):

```
HTTP server (port 4100)
├─ GET  /api/hosts              ← REST (CRUD)
├─ POST /api/hosts
├─ GET  /api/sessions
├─ POST /api/sessions/spawn
├─ GET  /api/workspaces
├─ PUT  /api/workspaces/:id
├─ GET  /api/health
├─ POST /api/pair
├─ GET  /api/config
└─ WS   /ws                     ← Upgrade
     ├─ INPUT, OUTPUT            (realtime terminal I/O)
     ├─ ATTACH, DETACH           (channel lifecycle)
     ├─ RESIZE, SNAPSHOT         (state management)
     ├─ WRITE_CLAIM/RELEASE/FORCE (write-lock)
     └─ HEARTBEAT
```

REST for CRUD (cacheable, idempotent, curl-friendly, OpenAPI-documentable).
WS for everything realtime (bidirectional, sub-ms latency on localhost).
Both on same HTTP server — WS via upgrade on `/ws` path.

Tauri (P1): same WS+REST from webview. Can add Tauri IPC commands later for perf.

### Session Model

Entity hierarchy: Host → Session → Channel

```
Host (machine: local or SSH remote)
  └── Session (SSH connection or local process group)
        └── Channel (individual PTY)
```

One SSH connection = one Session = N Channels (multiplexed).

**Session state machine:**

```
STARTING → ACTIVE ↔ DISCONNECTED → CLOSED
              ↕                        ↑
           DETACHED ───(timeout)───────┘
```

- STARTING: SSH connecting / PTY spawning
- ACTIVE: at least one channel live, SSH healthy
- DETACHED: all clients disconnected but PTY still running (agent-side)
- DISCONNECTED: SSH dropped, hub retrying (backoff: 1s→2s→4s→...→30s max)
- CLOSED: timeout expired or explicit close, channels dead, resources freed

**Channel state machine:**

```
BORN → LIVE ↔ ORPHAN → DEAD
               ↕
         (client attach/detach)
```

- BORN: PTY just spawned, not yet attached
- LIVE: at least one client attached
- ORPHAN: PTY running (agent-side) but no client attached; hub still caching output
- DEAD: PTY exited or GC'd

### Write-Lock Model (3-tier)

```
Tier 1 — Auto-release:
  Writer disconnects → lock freed → first WRITE_CLAIM wins

Tier 2 — Request/Approve:
  Writer connected → other client sends WRITE_CLAIM
  → Hub notifies current writer: "Device B requests write access"
  → Writer responds: WRITE_GRANT or WRITE_DENY
  → If GRANT: lock transfers, old writer becomes reader

Tier 3 — Force override:
  Client sends WRITE_FORCE → lock taken immediately
  → Previous writer receives WRITE_REVOKED notification
  → Becomes reader (not disconnected)
  → Use case: "I know what I'm doing, I need control NOW"
```

Messages: WRITE_CLAIM, WRITE_GRANT, WRITE_DENY, WRITE_FORCE, WRITE_RELEASE, WRITE_REVOKED, WRITE_LOCK (broadcast new holder to all clients on channel)

### UX / UI Design — Discord-style 3-Column Layout

**Core concept:** Hosts = Discord servers (permanent), Channel groups = categories,
Channels = PTY sessions (ephemeral but resumable). Sidebar + Command palette both available.

**3-column layout (main view):**

```
┌──┬──────────┬──────────────────────────────────────────────────┐
│  │ CHANNELS │ Tab 1: #bash │ Tab 2: #logs │ Tab 3: #htop  [+]│
│🟥│          ├──────────────────────────────────────────────────┤
│P │ ▾ Servers│                                                  │
│  │  #nginx  │  Terminal pane content                           │
│──│  #app  ● │                                                  │
│🟧│  #redis  │  $ tail -f /var/log/nginx/access.log            │
│S │          │  192.168.1.1 - - [15/Jan] "GET /api" 200        │
│  │ ▾ Maint. │  192.168.1.2 - - [15/Jan] "POST /api" 201      │
│──│  #bash ✍ │                                                  │
│🟦│  #htop 👁│                                                  │
│L │          │                                                  │
│  │ [+ chan] │  PROD  bash@prod-web-01  cols:120 rows:40        │
│──│          │                                                  │
│⚙ │ ──────── │                                                  │
│  │ [⚙] [?] │                                                  │
│[+]│         │                                                  │
└──┴──────────┴──────────────────────────────────────────────────┘
 ↑       ↑              ↑
 Host    Channel        Terminal (tabs + panes, splittable)
 rail    sidebar
(48px)  (~200px)
```

**Column 1 — Host rail (48px, always visible):**

```
┌──┐
│🟥│  prod-web-01 (auto: red bg + "P")     ● = SSH connected
│P │
│──│
│🟧│  staging-01 (auto: orange bg + "S")   ○ = available
│S │
│──│
│🟦│  local (auto: blue bg + "L")          ● = always on
│L │
│──│
│⚙ │  Settings
│──│
│+ │  Add host
└──┘

Icons: auto-generated (initial + deterministic color from name hash)
Custom: user can set emoji or upload image
Status: ● connected, ○ available, 🔴 error, ◐ reconnecting
```

**Column 2 — Channel sidebar (~200px, per selected host):**

```
┌──────────┐
│ PROD ▾   │  ← host label + collapse all
│ web-01   │  ← host subtitle
│──────────│
│ ▾ Servers│  ← channel group (collapsible, user-defined)
│  #nginx  │    LIVE, no special indicator
│  #app  ● │    ● = unread output since last view
│  #redis  │    DETACHED (dimmed)
│──────────│
│ ▾ Maint. │  ← another group
│  #bash ✍ │    ✍ = you hold write-lock
│  #htop 👁│    👁 = attached read-only
│──────────│
│ [+ chan] │  ← new channel in this host
│ [+ group]│  ← new group
│──────────│
│ⓘ 3 live  │  ← host stats footer
│  1 orphan│
└──────────┘
```

**Column 3 — Main area (tabs + split panes):**

```
┌──────────────────────────────────────────────────┐
│ Tab 1: #bash │ Tab 2: #logs │ Tab 3: #htop  [+] │
├──────────────────────┬───────────────────────────┤
│                      │                            │
│  Pane 1              │  Pane 2                   │
│  bash@prod (WRITER)  │  htop@prod (READ-ONLY 👁) │
│                      │                            │
│  $ ls -la            │  [htop display]           │
│  drwxr-xr-x ...     │                            │
│  $ █                 │                            │
│                      │                            │
├──────────────────────┴────────────────────────────┤
│  PROD  bash@prod-web-01  cols:120 rows:40  [🔍]  │
└───────────────────────────────────────────────────┘
 ↑ badge   ↑ channel info    ↑ dims    ↑ search
```

**Command palette (Ctrl+P):**

```
┌──────────────────────────────────────────┐
│ > connect prod                           │
│                                          │
│ 🟥 prod-web-01                           │
│     Connect SSH · 3 channels available   │
│ ● #bash@prod-web-01                      │
│     Attach · DETACHED · last: 2min ago   │
│ + New channel on prod-web-01             │
│ + Add new host...                        │
│ ⚙ Settings · ? Help · 🔍 Search output  │
└──────────────────────────────────────────┘
```

**Onboarding (first launch):**

```
┌──┬──────────────────────────────────────────────┐
│  │                                               │
│🟦│         Welcome to lasterm                   │
│L │                                               │
│  │   Your local terminal is ready.              │
│  │   ┌─────────────────────────────────────┐    │
│  │   │ $ echo "hello lasterm"              │    │
│  │   │ hello lasterm                        │    │
│  │   │ $ █                                  │    │
│  │   └─────────────────────────────────────┘    │
│  │                                               │
│[+]│  [+ Add a remote host] to get started       │
└──┴──────────────────────────────────────────────┘
 Local host auto-created. [+] = add more hosts.
```

**Add host dialog:**

```
┌──────────────────────────────────────────────┐
│  Add Remote Host                             │
│                                              │
│  Label:    [prod-web-01              ]       │
│  Host:     [user@192.168.1.50        ]       │
│  Port:     [22                       ]       │
│  Auth:     (•) SSH agent                     │
│            ( ) Key file    [Browse...]       │
│            ( ) Password                      │
│                                              │
│  Icon:     [P] auto    [Change...]           │
│  Color:    [🟥] auto   [Change...]           │
│                                              │
│  [Test connection]    [Save]    [Cancel]     │
└──────────────────────────────────────────────┘
```

**Host settings (right-click host icon):**

```
┌──────────────────────────────────────────────┐
│  prod-web-01 — Settings                      │
│                                              │
│  CONNECTION                                  │
│  Host:  user@192.168.1.50:22                │
│  Auth:  SSH agent                            │
│  [Test] [Edit]                               │
│                                              │
│  APPEARANCE                                  │
│  Icon:    [🔥]  [Change...]                  │
│  Color:   [#ff4444]  [Pick...]               │
│  Badge:   [PROD]  (from remote hint)         │
│                                              │
│  THEME OVERRIDE (Layer 3)                    │
│  Background: [#2d0000]                       │
│  Foreground: [inherit]                       │
│  (inherits from config.toml for unset)       │
│                                              │
│  REMOTE HINTS                                │
│  Trust policy: [Apply ▾]                     │
│                                              │
│  DEFAULTS                                    │
│  Shell: [/bin/bash     ]                     │
│  CWD:   [~             ]                     │
│                                              │
│  [Delete host]              [Save] [Cancel]  │
└──────────────────────────────────────────────┘
```

**Key UX elements:**

| Element | Behavior |
|---------|----------|
| Host rail | Click = select host (shows its channels). Right-click = host settings. |
| Channel sidebar | Click channel = open/attach in tab. Drag = reorder/regroup. |
| Tab bar | Click [+] → new channel on selected host. Right-click → close/rename/split. |
| Pane splits | Drag divider. `Ctrl+Shift+H` (horizontal), `Ctrl+Shift+V` (vertical). |
| Command palette | `Ctrl+P` → fuzzy search hosts, channels, actions. |
| Sidebar toggle | `Ctrl+B` collapses channel sidebar. Host rail always visible. |
| Unread indicator | ● on channel = new output since last view (like Discord). |
| Settings | `⚙` in host rail → global settings overlay. |

### Hosts vs Sessions — Persistence Model

Hosts are **permanent** (configuration, survive reboots):
- Stored in meta.db, never auto-deleted
- Have identity: label, icon, color, SSH config, theme overrides
- Appear in host rail even when disconnected/offline

Sessions are **runtime** (tied to SSH connection):
- CLOSED when SSH timeout or explicit close
- After remote reboot: sessions die, host stays, user clicks to reconnect
- Hub cache retains scrollback from dead channels (spool.db)

```
Remote reboot scenario:
  Before: Host:prod ─── Session:ssh-42(ACTIVE) ─── #bash(LIVE), #logs(LIVE)
  After:  Host:prod ─── (no session)
          Cache: last snapshots + scrollback still readable from spool.db
          UI: host icon → 🔴, channels dimmed, user clicks to start new session
```

### User Flows

**Flow 1 — First launch (onboarding):**
1. `lasterm-hub start` → hub starts → opens http://localhost:4100  *(originally written as `npx lasterm`; npm was dropped as a channel)*
2. Local host (🟦 L) auto-created in host rail
3. Default local channel #bash auto-opened in main area
4. User types commands immediately — no setup needed
5. Bottom prompt: "[+ Add a remote host] to get started"

**Flow 2 — Add remote host + connect:**
1. Click [+] in host rail → "Add Remote Host" dialog
2. Fill: label, user@host, port, auth method. Optional: icon/color.
3. "Test connection" → SSH probe → success ✓ (agent check)
4. If agent absent → "Install lasterm-agent? [Yes]" → scripts/install-agent.sh via scp (MVP; npx auto-install is P2)
5. "Save" → host icon (🟥 P) appears in host rail
6. Click host → sidebar shows (empty channels list)
7. Click [+ channel] → SSH → agent HELLO (with visual_hints) → SPAWN
8. New tab with terminal, badge "PROD", theme overlay applied

**Flow 3 — Reconnect (same device):**
1. User closes browser / laptop sleeps
2. Agent keeps PTY alive, hub caches OUTPUT in spool.db
3. User reopens http://localhost:4100
4. Host rail shows hosts with status dots
5. Click host → sidebar shows channels: #bash (◌ ORPHAN), #logs (◌ ORPHAN)
6. Click #bash → ATTACH → hub sends SNAPSHOT → restore → tail catch-up → LIVE ✍

**Flow 4 — Multi-device:**
1. Device A working (WRITER ✍ on #bash@prod)
2. Device B: opens lasterm, needs auth
3. Device A: `lasterm pair` → 6-digit code (60s expiry)
4. Device B enters code → gets token → connected to same hub
5. Device B sees same hosts/channels → clicks #bash@prod → ATTACH
6. Device B is READER (👁)
7. Option A: "Request write" → A gets notification → Allow/Deny
8. Option B: WRITE_FORCE → takes lock immediately, A becomes 👁

**Flow 5 — SSH drop + recovery:**
1. SSH to prod-web-01 drops
2. Hub: session → DISCONNECTED, retry backoff (1s→2s→4s→...→30s)
3. UI: host icon → ◐ (reconnecting), pane overlay "Reconnecting..."
4. Terminal still shows last content from local cache
5. SSH recovers → HELLO + ATTACH → SNAPSHOT → delta → LIVE
6. If timeout (5min) → session CLOSED, host icon → 🔴. User clicks to reconnect.

**Flow 6 — Resize:**
1. User resizes browser / drags pane splitter
2. xterm fit addon → new cols×rows
3. UI → WS: RESIZE → Hub → Agent: RESIZE
4. Agent: pty.resize() + headless xterm.resize()
5. PTY app SIGWINCH → re-renders → OUTPUT → Hub → UI

**Flow 7 — Organize channels:**
1. Right-click in channel sidebar → "New group" → name "Monitoring"
2. Drag #logs and #htop into "Monitoring"
3. Groups collapsible (▾/▸), persisted in meta.db per host
4. Groups survive session restarts (organizational, not runtime)

### Protocol (MessagePack framed)

Messages: HELLO, AUTH, HOST_LIST, SESSION_LIST, SPAWN, ATTACH, DETACH, INPUT, OUTPUT, RESIZE, SNAPSHOT_REQ, SNAPSHOT_RES, HEARTBEAT, ERROR

Frame format: `[4 bytes LE length][MessagePack payload]`

OUTPUT carries: `{ type, channelId, seqNo, ts, data: Uint8Array }`

### Storage Schema (2 DBs)

**meta.db:** hosts, workspaces, sessions, channels, cache_index
**spool.db:** chunks (output/snapshot/resize), chunked 256KB-1MB

GC policy: keep N days + last snapshot per channel. VACUUM spool independently.

### Observability

- Structured logs (JSON) with trace IDs per session/channel
- `/health` REST endpoint
- Metrics: active sessions, channels, spool size, WS clients

## Risks

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| xterm.js headless needs DOM polyfill | M | M | Spike before committing; fallback VT parser |
| node-pty Windows compatibility | M | L | Well-maintained, used by VS Code |
| SSH connection instability | H | M | Retry/backoff, session survive disconnect |
| Spool DB growth uncontrolled | M | M | GC policy mandatory, configurable limits |
| MessagePack debugging difficulty | L | M | CLI decode tool, protocol dump mode |

## Open Questions (to resolve in spike)

1. xterm.js headless in Node.js — quelle est la taille minimale du polyfill DOM nécessaire ?
2. ssh2 vs exec `ssh` process — quel contrôle pour agent forwarding ?
3. Performance de serialize() sur un terminal 250×80 avec scrollback 10K lignes ?

## Next Steps

→ Run `/prd` with this brief to generate full documentation:
  - SPEC.md (architecture + flux)
  - PROTOCOL.md (messages, framing, exemples)
  - STORAGE.md (schema, pragmas, GC, migration)
  - SECURITY.md (threat model, auth flows)
  - MVP_ROADMAP.md (milestones, blocks, exit criteria)
