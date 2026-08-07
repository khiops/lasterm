---
doc-meta:
  status: canonical
  scope: launch-profiles
  type: specification
  target_project: /mnt/wsl/shared/dev/lasterm
  created: 2026-03-12
  updated: 2026-03-12
  complexity: COMPLEX
  time-budget: 8h
  adversarial_applied: true
---

# Specification: Launch Profiles

## 0. Quick Reference

| Item | Value |
|------|-------|
| Scope | launch-profiles |
| Complexity | COMPLEX |
| Time budget | ~8h |
| Blocks | 8 |
| BDD scenarios | 39 |
| Risk level | MEDIUM |
| Packages | shared, agent, hub, web |
| Migration | 009-launch-profiles.sql |
| Brief | docs/briefs/launch-profiles.md |

## 1. Problem Statement

Users cannot launch terminals with predefined configurations. Every "+" spawns the default shell. There is no way to one-click into Python REPL, htop, Node, or a custom script. The global `channels.defaultShell` in config.toml is OS-biased (bash on Windows hosts = broken). Additionally, shell configuration and visual profiles are disconnected — there is no unified "launch configuration" concept.

## 2. User Stories

### US-1: Profile-Based Terminal Launch
AS A terminal user
I WANT to launch terminals from named profiles that bundle shell, args, cwd, env, mode, and visual overrides
SO THAT I can one-click into my common workflows without manual configuration each time

ACCEPTANCE: "+" dropdown shows profiles, clicking one spawns a terminal with the profile's configuration. Profile settings seed the channel at spawn time.

### US-2: OS-Aware Profile Visibility
AS A multi-host user managing Linux, macOS, and Windows hosts
I WANT profiles to auto-filter by OS and allow per-host overrides (pin/hide/default)
SO THAT I see only relevant profiles for each host without manually binding every profile to every host

ACCEPTANCE: A profile with `supported_os: "linux"` appears on all Linux hosts. A per-host `hide` override hides it on a specific host. One default profile per host is enforced.

### US-3: Power User Launch Efficiency
AS A power user
I WANT to launch profiles via keyboard shortcuts, command palette, and quick commands
SO THAT my terminal workflow is as fast as possible

ACCEPTANCE: Ctrl+Shift+1..9 spawns the Nth profile. `~python` in command palette finds and launches the Python profile. "Run command..." in the dropdown spawns a one-shot command.

## 3. Business Rules

### 3.1 Invariants (always true)

- **INV-01:** A LaunchProfile has a unique `name` (case-insensitive, `COLLATE NOCASE`).
- **INV-02:** A LaunchProfile has a non-empty `shell` field.
- **INV-03:** At most ONE profile can be the `default` for any given host (enforced by partial unique index on `host_launch_profiles` where `override_type = 'default'`).
- **INV-04:** `supported_os` is one of: `linux`, `darwin`, `windows`, `any`.
- **INV-05:** `mode` is one of: `shell`, `process`.
- **INV-06:** A channel's `launch_profile_id` is a soft reference — deleting a profile sets it to NULL (ON DELETE SET NULL), does not affect running channels.
- **INV-07:** Variable expansion is one-pass, left-to-right, no recursion. Applied to `args`, `cwd`, and `env` values (not env keys).
- **INV-08:** Elevation over Windows SSH is not supported (MVP). The system must reject or ignore `elevated: true` for Windows SSH hosts. (Post-MVP: native helper via `CreateProcessWithLogonW`, deferred to agent packaging.)
- **INV-14:** `elevationSecret` is ephemeral: never persisted to DB, never logged, never included in protocol debug traces. Zeroed in memory after use by both hub and agent.
- **INV-15:** Elevation credential flow reuses the existing `AUTH_PROMPT`/`AUTH_PROMPT_RESPONSE` protocol with `promptType: 'elevation'`. No new message types needed.
- **INV-09:** `shell` must be a valid executable path: no shell metacharacters (`;`, `|`, `&`, `$`, `` ` ``). Parentheses `()` are allowed (Windows `Program Files (x86)`). Validated at API boundary.
- **INV-10:** `args` are always passed as an array to node-pty (never string-joined). No shell expansion on args, even in `mode="shell"`.
- **INV-11:** All `/api/launch-profiles` and `/api/hosts/:id/profiles` routes require Bearer token auth (same as existing `/api/` routes).
- **INV-12:** `env` values are stored plaintext in DB. API responses mask values where the key matches sensitive patterns (`password`, `secret`, `token`, `key`, `credential`, case-insensitive) → value replaced with `"********"`. UI shows masked dots. Plaintext only sent in spawn messages to the agent. **PUT semantics:** if a value equals the sentinel `"********"`, the key is left unchanged in DB (not overwritten with asterisks). This prevents round-trip clobber.
- **INV-13:** Keyboard shortcuts (Ctrl+Shift+1..9) only fire at app-level when the terminal PTY does NOT have focus. When PTY is focused, these key combinations pass through to the terminal application.

### 3.2 Preconditions (required before action)

- **PRE-01:** To spawn from a profile, the profile must exist in the database.
- **PRE-02:** To set a host override, both the host and profile must exist.
- **PRE-03:** To send `elevated` or `mode` fields to the agent, the agent must report capability `"launch-profiles"` in HELLO. Otherwise, fall back to `directProcess` (existing field) and ignore `elevated`.
- **PRE-04:** To use agent-reported shells for autocomplete/filtering, the host must have connected at least once (so HELLO was received).

### 3.3 Effects (what changes)

- **EFF-01:** Creating a LaunchProfile inserts a row in `launch_profiles` table.
- **EFF-02:** Spawning from a profile: profile's `shell`, `args`, `cwd`, `env` populate the UiSpawnMessage. Profile's `profile_overrides` are deep-merged into the new channel's `profile_json`. Profile's `id` is stored as `channel.launch_profile_id`.
- **EFF-03:** Agent HELLO with `available_shells`/`default_shell` updates `hosts.discovered_shells` and `hosts.discovered_shells_at`.
- **EFF-04:** Setting a `default` override on a host automatically removes any existing `default` override for that host (single transaction: DELETE old default + INSERT new, within `BEGIN IMMEDIATE`).
- **EFF-05:** Migration converts `channels.defaultShell` (config.toml) and `hosts.default_shell` (meta.db) into LaunchProfile entries.
- **EFF-06:** Variable expansion: `${VAR}` in args/cwd/env values is replaced by the agent's local env value. `\${VAR}` produces literal `${VAR}`. Undefined vars keep the literal `${VAR}` (fail-safe).

### 3.4 Error Handling

- **ERR-01:** When creating a profile with a duplicate `name` → 409 Conflict.
- **ERR-02:** When creating a profile with empty `shell` → 400 Bad Request.
- **ERR-03:** When setting a second `default` override for the same host → auto-replace (EFF-04), not error.
- **ERR-04:** When spawning with `elevated: true` on a Windows SSH host → ignore flag, log warning, spawn without elevation. (Windows local: gsudo + UAC caching, no password from hub.)
- **ERR-10:** When user cancels the elevation modal (or timeout expires) → spawn aborted, channel not created, UI notified.
- **ERR-05:** When spawning with `elevated: true` and agent doesn't support `launch-profiles` capability → ignore flag, spawn without elevation.
- **ERR-06:** When deleting a profile that has channels referencing it → channels keep `launch_profile_id = NULL` (ON DELETE SET NULL), deletion succeeds.
- **ERR-07:** When an elevated spawn requires sudo and the user cancels/fails authentication → normal PTY exit (non-zero exit code), channel transitions to `dead`.
- **ERR-08:** When quick command input is empty → no-op, dismiss the input. No spawn attempt.
- **ERR-09:** When `shell` contains shell metacharacters (`` ;|&$` ``) → 400 Bad Request with message "shell must be an executable path, not a command".

## 4. Technical Design

### 4.1 Architecture Decision

LaunchProfile is a **new first-class entity** in meta.db (not config.toml). Rationale:
- Relational queries needed ("which profiles for host X?")
- CRUD with REST API (Settings UI)
- FK references from channels (provenance)
- JSON in config.toml would create split-brain with meta.db hosts

Profiles use **dual-layer visibility**: automatic OS filtering + per-host override join table. This minimizes setup for fleet management while allowing exceptions.

Profile data is **copied into the channel at spawn time** (seed pattern), not inherited live. Changing a profile does not affect already-running channels.

### 4.2 Data Model Changes

#### New table: `launch_profiles`

```sql
CREATE TABLE launch_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    shell TEXT NOT NULL,
    args_json TEXT,                  -- JSON: string[]
    cwd TEXT,
    env_json TEXT,                   -- JSON: Record<string, string>
    mode TEXT NOT NULL DEFAULT 'shell' CHECK(mode IN ('shell', 'process')),
    elevated INTEGER NOT NULL DEFAULT 0,
    supported_os TEXT NOT NULL DEFAULT 'any'
        CHECK(supported_os IN ('linux', 'darwin', 'windows', 'any')),
    icon_type TEXT NOT NULL DEFAULT 'auto'
        CHECK(icon_type IN ('auto', 'emoji', 'image')),
    icon_value TEXT,
    color TEXT,
    profile_overrides_json TEXT,     -- JSON: Partial<TerminalProfile>
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
```

#### New table: `host_launch_profiles`

```sql
CREATE TABLE host_launch_profiles (
    host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
    profile_id TEXT NOT NULL REFERENCES launch_profiles(id) ON DELETE CASCADE,
    override_type TEXT NOT NULL CHECK(override_type IN ('pin', 'hide', 'default')),
    sort_order INTEGER,
    PRIMARY KEY (host_id, profile_id)
);

-- At most one default profile per host
CREATE UNIQUE INDEX idx_hlp_one_default_per_host
    ON host_launch_profiles(host_id) WHERE override_type = 'default';
```

#### Modified table: `channels`

```sql
ALTER TABLE channels ADD COLUMN launch_profile_id TEXT
    REFERENCES launch_profiles(id) ON DELETE SET NULL;

CREATE INDEX idx_channels_launch_profile_id ON channels(launch_profile_id);
```

#### Modified table: `hosts`

```sql
ALTER TABLE hosts ADD COLUMN discovered_shells TEXT;       -- JSON: string[]
ALTER TABLE hosts ADD COLUMN discovered_shells_at TEXT;     -- ISO 8601
```

#### Migration file: `009-launch-profiles.sql`

All four changes above in a single migration. Migration number: **009** (after 008-process-title.sql).

### 4.3 TypeScript Types (shared package)

```typescript
// New entity
export interface LaunchProfile {
    id: string;
    name: string;
    shell: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    mode: 'shell' | 'process';
    elevated: boolean;
    supportedOs: 'linux' | 'darwin' | 'windows' | 'any';
    iconType: 'auto' | 'emoji' | 'image';
    iconValue?: string;
    color?: string;
    profileOverrides?: Partial<TerminalProfile>;
    sortOrder: number;
    createdAt: string;
    updatedAt: string;
}

export interface HostLaunchProfileOverride {
    hostId: string;
    profileId: string;
    overrideType: 'pin' | 'hide' | 'default';
    sortOrder?: number;
}

// Extended HelloMessage (add to existing)
export interface HelloMessage {
    // ... existing fields ...
    availableShells?: string[];
    defaultShell?: string;
}

// Extended UiSpawnMessage (add to existing)
export interface UiSpawnMessage {
    // ... existing fields ...
    launchProfileId?: string;
    elevated?: boolean;
}

// Extended AgentSpawnMessage (add to existing)
export interface AgentSpawnMessage {
    // ... existing fields ...
    elevated?: boolean;
    elevationSecret?: string;  // ephemeral, never persisted/logged (INV-14)
}

// Extended AUTH_PROMPT (add promptType to existing)
export interface AuthPromptMessage {
    // ... existing fields (hostId, prompt, timeout) ...
    promptType: 'passphrase' | 'elevation';  // NEW: distinguish SSH vs sudo
}

// Extended Channel entity (add to existing)
export interface Channel {
    // ... existing fields ...
    launchProfileId?: string;
}
```

### 4.4 Variable Expansion Grammar

Applied by the **agent** at spawn time to: `args[]`, `cwd`, and `env` values.

```
EXPANSION RULES (one-pass, left-to-right):

  ${VAR_NAME}     → replace with process.env[VAR_NAME]
                     VAR_NAME matches: [A-Za-z_][A-Za-z0-9_]*
                     If VAR_NAME not in env → keep literal "${VAR_NAME}"

  \${VAR_NAME}    → literal "${VAR_NAME}" (backslash consumed)

  \\${VAR_NAME}   → literal "\" + expanded value of VAR_NAME

  $VAR (no braces) → NOT expanded (only braced ${} form supported)

  No recursion:    expanded value is NOT re-scanned
  Windows:         env lookup is case-insensitive
  Applied to:      args[] items, cwd string, env values (NOT env keys)
  NOT applied to:  shell field (must be exact path)
```

### 4.5 Elevation Architecture

#### 4.5.1 Separation of Concerns

```
COLLECT (password)    → Web UI modal (via AUTH_PROMPT WS message)
STORE (cache)         → Hub only (session Map, post-MVP: keytar)
DELIVER (transport)   → Hub → Agent via elevationSecret in AgentSpawnMessage
EXECUTE (elevate)     → Agent, platform-specific (sudo -A / gsudo)
```

The hub is the sole credential manager. The agent is ephemeral (no persistent state) — it receives the password at spawn time and zeros it after use.

#### 4.5.2 Elevation Flow

```
User spawns elevated profile
       │
       ▼
Hub resolves agent OS + transport
       │
       ├── Windows SSH? → ERR-04 (not supported)
       │
       ├── Windows local? → No password needed
       │     Hub sends: { elevated: true }
       │     Agent: gsudo <shell> [args]
       │     (UAC popup on user screen, gsudo caches token for subsequent calls)
       │
       └── Linux/macOS (any transport)? → Password needed
             Hub checks elevation cache: Map<hostId, {secret, expiresAt}>
               ├── Hit (not expired) → use cached secret
               └── Miss → AUTH_PROMPT(promptType='elevation') → Web UI
                     │
                     ▼
                   AuthElevationModal (reuses AuthPromptDialog.vue)
                   ┌────────────────────────────────────┐
                   │  🔒 Elevation required              │
                   │  Host: prod-server-1                │
                   │                                     │
                   │  Password: [________]               │
                   │  ☐ Remember this session             │
                   │                                     │
                   │  [Cancel]  [Elevate]           45s  │
                   └────────────────────────────────────┘
                     │
                     ▼
                   Hub receives AUTH_PROMPT_RESPONSE
                   If "remember" checked → cache with TTL (default 15 min)
                     │
                     ▼
             Hub sends: { elevated: true, elevationSecret: "..." }
             Agent: SUDO_ASKPASS mechanism (see §4.5.3)
             Agent: zeros secret in memory after PTY spawn
```

#### 4.5.3 Platform Mechanics

| Agent OS | Transport | Mechanism | Password from hub? | Notes |
|----------|-----------|-----------|:------------------:|-------|
| Linux | Local/SSH | `sudo -A` + ASKPASS | YES | Non-interactive, password never in PTY stream |
| macOS | Local/SSH | `sudo -A` + ASKPASS | YES | Same as Linux |
| Windows | Local | `gsudo <shell> [args]` | NO | UAC popup first time, gsudo caches token |
| Windows | SSH | **NOT SUPPORTED (MVP)** | — | ERR-04. Post-MVP: native helper via `CreateProcessWithLogonW`, deferred to agent packaging. |

**Linux/macOS — SUDO_ASKPASS mechanism:**

```
Agent receives AgentSpawnMessage with elevationSecret:
  1. Create temp script (chmod 700, user-only):
       #!/bin/sh
       echo "$_LASTERM_ELEV"
  2. Set env: SUDO_ASKPASS=<temp script>, _LASTERM_ELEV=<secret>
  3. Spawn PTY: sudo -A -E <shell> [args]
  4. sudo calls askpass script → gets password → authenticates
  5. Delete temp script immediately
  6. Zero _LASTERM_ELEV and elevationSecret in memory
  7. User sees elevated shell prompt — no password prompt in PTY
```

Why `sudo -A` (askpass) not `sudo -S` (stdin): `-S` reads from stdin = the PTY → password would be echoed by terminal driver. `-A` calls an external script → password never transits PTY stream.

**Windows local — gsudo:**

```
Agent receives AgentSpawnMessage with elevated=true (no secret):
  1. Check gsudo in PATH → if missing: log error, spawn without elevation
  2. Spawn PTY: gsudo <shell> [args]
  3. First invocation: UAC consent popup on user's screen
  4. gsudo caches elevation token (CacheMode Auto, configurable TTL)
  5. Subsequent elevated spawns: automatic (no UAC popup)
```

#### 4.5.4 Hub Elevation Cache

```typescript
// In SessionManager (hub)
private elevationCache = new Map<string, { secret: string, expiresAt: number }>();

// TTL: configurable via config.toml [channels].elevationCacheTtl (default: 900 = 15 min)
// Cache key: hostId (one cached password per host)
// Cleared on: hub shutdown, TTL expiry, explicit user action
```

#### 4.5.5 Post-MVP: Windows Password-Based Elevation

Deferred to **agent packaging milestone** (not Tauri — agent has its own packaging). When the agent ships as a native binary (or bundles a compiled helper):

- Agent includes a small native helper calling `CreateProcessWithLogonW` (Win32 API)
- Takes username + password → creates elevated process without UAC
- Works for both local AND SSH transports (unifies Windows with Linux/macOS flow)
- The hub-side flow (modal → cache → deliver) is identical — only agent execution changes

Agent checks for `elevated` field AND `launch-profiles` capability. If agent version predates launch-profiles, the `elevated` field is stripped by the hub before sending AgentSpawnMessage.

### 4.6 Spawn Resolution Flow (updated handleSpawn)

```
UI sends UiSpawnMessage { hostId, launchProfileId?, shell?, args?, ... }

Hub handleSpawn():
  1. If launchProfileId set:
       a. Load LaunchProfile from DB
       b. Resolve: shell = profile.shell, args = profile.args, cwd = profile.cwd,
          env = profile.env, mode = profile.mode, elevated = profile.elevated
       c. UiSpawnMessage fields override profile fields (explicit > profile)
  2. Else: use UiSpawnMessage fields directly (existing behavior)
  3. Shell fallback: resolved shell ?? host.defaultShell ?? agent.defaultShell ?? '/bin/sh'
  4. CWD fallback: resolved cwd ?? host.defaultCwd ?? HOME ?? '/'
  5. Map mode to directProcess: mode === 'process' → directProcess = true
  6. Check agent capabilities for 'launch-profiles':
       - If supported: send elevated flag
       - If not: strip elevated, use directProcess for mode mapping
  7. If elevated AND agent OS = linux|darwin:
       a. Check elevationCache for hostId
       b. If miss → send AUTH_PROMPT(promptType='elevation') to client, await response
       c. If user cancels or timeout → ERR-10, abort spawn
       d. If "remember" → cache secret with TTL
       e. Attach elevationSecret to AgentSpawnMessage
  8. If elevated AND agent OS = windows AND transport = local:
       a. No secret needed (gsudo handles UAC)
       b. Set elevated=true on AgentSpawnMessage (no elevationSecret)
  9. If elevated AND agent OS = windows AND transport = ssh:
       a. ERR-04: strip elevated, log warning
  10. Build AgentSpawnMessage, send to agent
  11. On SPAWN_OK: persist channel with launch_profile_id, profile_overrides → channel.profileJson

Agent receives AgentSpawnMessage:
  1. Expand variables in args, cwd, env values (one-pass ${VAR})
  2. If elevated:
       a. Linux/macOS + elevationSecret: SUDO_ASKPASS mechanism (§4.5.3)
       b. Windows local (no secret): gsudo wrapper (§4.5.3)
       c. Zero elevationSecret in memory immediately after PTY spawn
  3. Spawn PTY via node-pty
```

### 4.7 Profile Visibility Resolution

```sql
-- Profiles visible on a host (for dropdown)
SELECT p.*, hlp.override_type, COALESCE(hlp.sort_order, p.sort_order) AS effective_sort
FROM launch_profiles p
LEFT JOIN host_launch_profiles hlp
    ON p.id = hlp.profile_id AND hlp.host_id = :hostId
WHERE
    hlp.override_type = 'pin'                                    -- pinned: always show
    OR hlp.override_type = 'default'                             -- default: always show
    OR (
        p.supported_os IN ('any', :hostOs)                       -- OS matches
        AND (hlp.override_type IS NULL OR hlp.override_type != 'hide')  -- not hidden
    )
ORDER BY
    CASE WHEN hlp.override_type = 'default' THEN 0 ELSE 1 END,  -- default first
    effective_sort,
    p.name;
```

**Host OS resolution:** `hosts.discovered_shells_at IS NOT NULL` → use OS from last HELLO. Otherwise: `host.type = 'local'` → `process.platform`. `host.type = 'ssh'` with no prior HELLO → OS is `'unknown'`. When `:hostOs = 'unknown'`, the SQL uses `p.supported_os = 'any'` (only `any` profiles visible), plus any `pin`/`default` overrides from the join table. The query passes `'unknown'` as `:hostOs` — since no profile has `supported_os = 'unknown'`, the `IN ('any', 'unknown')` clause only matches `'any'`.

### 4.8 API Contract

| Endpoint | Method | Request Body | Response | Notes |
|----------|--------|-------------|----------|-------|
| `/api/launch-profiles` | GET | — | `LaunchProfile[]` | All profiles, sorted by sort_order |
| `/api/launch-profiles` | POST | `Partial<LaunchProfile>` (name, shell required) | `LaunchProfile` | 201 Created |
| `/api/launch-profiles/:id` | GET | — | `LaunchProfile` | 404 if not found |
| `/api/launch-profiles/:id` | PUT | `Partial<LaunchProfile>` | `LaunchProfile` | 404 if not found |
| `/api/launch-profiles/:id` | DELETE | — | 204 | ON DELETE SET NULL for channels |
| `/api/launch-profiles/reorder` | POST | `{ ids: string[] }` | 204 | Update sort_order |
| `/api/hosts/:id/profiles` | GET | — | `(LaunchProfile & { overrideType?, effectiveSort })[]` | Filtered by OS + overrides |
| `/api/hosts/:id/profiles/:profileId` | PUT | `{ overrideType: 'pin'\|'hide'\|'default', sortOrder?: number }` | 204 | Upsert override |
| `/api/hosts/:id/profiles/:profileId` | DELETE | — | 204 | Remove override |

**Validation rules:**
- `name`: 1-100 chars, unique
- `shell`: 1-512 chars, non-empty, must not contain shell metacharacters (`` ;|&$` ``). Parentheses allowed (Windows paths).
- `args`: max 64 items, each max 1024 chars (always passed as array to node-pty, never string-joined)
- `cwd`: max 1024 chars
- `env`: max 100 entries, keys max 256 chars, values max 4096 chars
- `color`: hex format `#rrggbb` or null
- `icon_value`: max 256 chars (emoji char or image filename — not inline data)
- `icon_type`: enum
- `supported_os`: enum
- `mode`: enum
- `profile_overrides`: valid partial TerminalProfile (same validation as host/channel profileJson)

**Env value masking (INV-12):** GET responses mask `env` values where the key matches `/password|secret|token|key|credential/i`. Masked format: `"********"`. POST/PUT accept plaintext for storage. **Round-trip safety:** PUT ignores values equal to the sentinel `"********"` — the existing DB value is preserved for that key. This prevents accidental clobber when UI round-trips a masked response. The hub sends plaintext values to the agent in spawn messages only (never exposed via API reads).

**Wire format (snake_case):** API accepts/returns snake_case. TypeScript uses camelCase. Conversion at API boundary (same pattern as existing endpoints).

### 4.9 HELLO Protocol Extension

```
HELLO (agent → hub, MessagePack, snake_case on wire):
{
    type: "HELLO",
    version: 1,
    agent_version: "0.2.0",
    capabilities: ["multiplex", "snapshot", "resize", "launch-profiles"],  // NEW capability
    visual_hints: { ... },
    available_shells: ["/bin/bash", "/bin/zsh", "/usr/bin/fish"],          // NEW optional
    default_shell: "/bin/zsh"                                              // NEW optional
}
```

**Shell detection (agent-side):**
- Linux: read `/etc/shells` (skip comments/empty lines) + `$SHELL`
- macOS: read `/etc/shells` + `$SHELL`
- Windows: scan known paths (`C:\Windows\System32\cmd.exe`, `C:\Program Files\PowerShell\*\pwsh.exe`, `C:\Windows\System32\WindowsPowerShell\*\powershell.exe`, WSL paths)
- Fallback: `[process.env.SHELL ?? '/bin/sh']`

**Capability `launch-profiles`:** indicates the agent understands `elevated` field in SPAWN. Hub checks this before sending elevated.

### 4.10 Migration Logic (Startup)

Runs once at hub startup, idempotent via migration number in `meta.db` schema_version.

**Step 1: hosts.default_shell → LaunchProfile per-host**
```
FOR each host WHERE default_shell IS NOT NULL:
    profileName = "Default Shell (" + host.label + ")"
    IF NOT EXISTS launch_profile WHERE name = profileName:
        INSERT launch_profile(name=profileName, shell=host.default_shell, supported_os='any')
        INSERT host_launch_profiles(host_id, profile_id, override_type='default')
    UPDATE host SET default_shell = NULL
```

**Step 2: config.toml channels.defaultShell → LaunchProfile for local host**
```
IF config.toml has [channels].defaultShell:
    shell = config[channels].defaultShell
    localHost = getLocalHost()
    IF localHost AND NOT EXISTS host_launch_profiles WHERE host_id=localHost.id AND override_type='default':
        profileName = "Default Shell"
        IF NOT EXISTS launch_profile WHERE name = profileName:
            INSERT launch_profile(name=profileName, shell=shell, supported_os='any')
        INSERT host_launch_profiles(localHost.id, profile_id, override_type='default')
    Log deprecation warning for channels.defaultShell
```

**Collision handling:** Per-host default (Step 1) takes priority. If Step 1 already created a default for the local host, Step 2 creates the profile but does NOT set it as default.

**Rollback safety:** Old fields (`hosts.default_shell`, config.toml `channels.defaultShell`) are NOT deleted in this release. They're deprecated with log warnings. Removal in next major release.

## 5. Acceptance Criteria (BDD)

### Scenario Group: Profile CRUD

```gherkin
@priority:high @type:nominal
Scenario: SC-01 Create a launch profile with all fields
    Given no profiles exist
    When I POST /api/launch-profiles with name="Python REPL", shell="python3",
         args=["-i"], cwd="${HOME}", mode="process", supported_os="linux",
         icon_type="emoji", icon_value="🐍", color="#3776AB"
    Then response is 201 with a LaunchProfile containing all fields
    And the profile exists in the database with a ULID id

@priority:high @type:nominal
Scenario: SC-02 Create a minimal profile (name + shell only)
    Given no profiles exist
    When I POST /api/launch-profiles with name="htop", shell="htop"
    Then response is 201
    And profile has mode="shell", elevated=false, supported_os="any",
        icon_type="auto", sort_order=0

@priority:high @type:error
Scenario: SC-03 Reject duplicate profile name
    Given a profile named "Python REPL" exists
    When I POST /api/launch-profiles with name="Python REPL", shell="python3"
    Then response is 409 Conflict

@priority:medium @type:error
Scenario: SC-04 Reject empty shell
    When I POST /api/launch-profiles with name="Bad", shell=""
    Then response is 400 Bad Request

@priority:high @type:nominal
Scenario: SC-05 Delete profile with channel references
    Given a profile "Python REPL" (id=P1) exists
    And a channel C1 has launch_profile_id=P1
    When I DELETE /api/launch-profiles/P1
    Then response is 204
    And channel C1 has launch_profile_id=NULL
    And the profile no longer exists
```

### Scenario Group: OS-Aware Visibility

```gherkin
@priority:high @type:nominal
Scenario: SC-06 Profile auto-visible on matching OS
    Given a profile "htop" with supported_os="linux"
    And a Linux host "server-1"
    When I GET /api/hosts/server-1/profiles
    Then "htop" is in the response

@priority:high @type:nominal
Scenario: SC-07 Profile hidden on non-matching OS
    Given a profile "PowerShell" with supported_os="windows"
    And a Linux host "server-1"
    When I GET /api/hosts/server-1/profiles
    Then "PowerShell" is NOT in the response

@priority:high @type:nominal
Scenario: SC-08 Pin override shows profile on non-matching OS
    Given a profile "PowerShell" with supported_os="windows"
    And a Linux host "server-1"
    And a pin override for "PowerShell" on "server-1"
    When I GET /api/hosts/server-1/profiles
    Then "PowerShell" IS in the response

@priority:high @type:nominal
Scenario: SC-09 Hide override hides profile on matching OS
    Given a profile "htop" with supported_os="linux"
    And a Linux host "server-1"
    And a hide override for "htop" on "server-1"
    When I GET /api/hosts/server-1/profiles
    Then "htop" is NOT in the response

@priority:high @type:nominal
Scenario: SC-10 supported_os="any" visible on all hosts
    Given a profile "vim" with supported_os="any"
    And a Linux host "linux-1" and a Windows host "win-1"
    When I GET /api/hosts/linux-1/profiles
    Then "vim" is in the response
    When I GET /api/hosts/win-1/profiles
    Then "vim" is in the response
```

### Scenario Group: Default Profile

```gherkin
@priority:high @type:nominal
Scenario: SC-11 One default per host enforced
    Given a profile "bash" is default on host "server-1"
    And a profile "zsh" exists
    When I PUT /api/hosts/server-1/profiles/zsh with override_type="default"
    Then "zsh" is default on "server-1"
    And "bash" no longer has a default override on "server-1"

@priority:high @type:nominal
Scenario: SC-12 Spawn with default profile on "+" click
    Given a profile "zsh" (shell="/bin/zsh") is default on the current host
    When the user clicks "+" (not the dropdown)
    Then a SPAWN message is sent with shell="/bin/zsh"
    And the new channel has launch_profile_id set to the zsh profile
```

### Scenario Group: Spawn Resolution

```gherkin
@priority:high @type:nominal
Scenario: SC-13 Spawn from profile populates channel fields
    Given a profile "Python" with shell="python3", args=["-i"],
          cwd="${HOME}", mode="process", profile_overrides={theme: "dracula"}
    When user spawns from this profile
    Then AgentSpawnMessage has shell="python3", args=["-i"], directProcess=true
    And the new channel has launch_profile_id set
    And the new channel's profile_json contains {theme: "dracula"}

@priority:high @type:nominal
Scenario: SC-14 Variable expansion in cwd and args
    Given a profile with cwd="${HOME}/projects" and args=["--user", "${USER}"]
    And the agent's env has HOME="/home/alice" and USER="alice"
    When the profile is spawned
    Then the PTY is spawned with cwd="/home/alice/projects" and args=["--user", "alice"]

@priority:medium @type:edge
Scenario: SC-15 Undefined variable keeps literal
    Given a profile with cwd="${NONEXISTENT}/work"
    When the profile is spawned
    Then the PTY is spawned with cwd="${NONEXISTENT}/work" (literal)

@priority:medium @type:edge
Scenario: SC-16 Escaped variable produces literal
    Given a profile with args=["echo", "\\${HOME}"]
    When the profile is spawned
    Then the PTY receives args=["echo", "${HOME}"] (literal, not expanded)

@priority:high @type:nominal
Scenario: SC-17 UiSpawnMessage fields override profile
    Given a profile "Python" with cwd="/default/path"
    When user spawns with launchProfileId=Python AND cwd="/override/path"
    Then the channel is spawned with cwd="/override/path" (override wins)
```

### Scenario Group: Elevation

```gherkin
@priority:high @type:nominal
Scenario: SC-18 Elevated spawn on Linux uses ASKPASS with hub-provided password
    Given a profile "System Monitor" with elevated=true, shell="htop", mode="process"
    And the agent is Linux with capability "launch-profiles"
    And no elevation secret is cached for this host
    When user spawns this profile
    Then hub sends AUTH_PROMPT(promptType='elevation') to the client
    And the UI shows an elevation password modal
    When user enters password and clicks "Elevate"
    Then hub sends AgentSpawnMessage with elevated=true and elevationSecret
    And the agent creates a temp ASKPASS script
    And the agent spawns: sudo -A -E htop
    And the password never appears in the PTY stream
    And the agent zeros the secret after spawn

@priority:high @type:nominal
Scenario: SC-18b Elevated spawn with cached credential skips modal
    Given a profile with elevated=true
    And the agent is Linux with capability "launch-profiles"
    And an elevation secret IS cached for this host (not expired)
    When user spawns this profile
    Then hub sends AgentSpawnMessage with elevationSecret immediately
    And NO AUTH_PROMPT is sent (no modal shown)

@priority:high @type:nominal
Scenario: SC-18c Elevated spawn on Windows local uses gsudo
    Given a profile with elevated=true, shell="htop"
    And the agent is Windows local with capability "launch-profiles"
    When user spawns this profile
    Then hub sends AgentSpawnMessage with elevated=true (no elevationSecret)
    And the agent spawns: gsudo htop
    And UAC popup appears on user screen (first time) or is cached

@priority:high @type:edge
Scenario: SC-19 Elevated spawn on Windows SSH is ignored
    Given a profile with elevated=true
    And the host is SSH, Windows
    When user spawns this profile
    Then elevated flag is stripped (not sent to agent)
    And the spawn proceeds without elevation
    And a warning is logged

@priority:medium @type:edge
Scenario: SC-20 Elevated spawn with old agent is ignored
    Given a profile with elevated=true
    And the agent does NOT report "launch-profiles" capability
    When user spawns this profile
    Then elevated flag is stripped
    And the spawn proceeds without elevation

@priority:high @type:edge
Scenario: SC-20b User cancels elevation modal
    Given a profile with elevated=true
    And no cached credential
    When hub sends AUTH_PROMPT(promptType='elevation')
    And user clicks "Cancel" (or timeout expires)
    Then spawn is aborted (ERR-10)
    And no channel is created
    And client is notified
```

### Scenario Group: Shell Discovery

```gherkin
@priority:high @type:nominal
Scenario: SC-21 Agent reports shells in HELLO
    Given an agent on Linux with /bin/bash, /bin/zsh, /usr/bin/fish installed
    When the agent connects and sends HELLO
    Then HELLO contains available_shells=["/bin/bash", "/bin/zsh", "/usr/bin/fish"]
    And default_shell="/bin/zsh" (from $SHELL)

@priority:high @type:nominal
Scenario: SC-22 Hub caches discovered shells
    Given an agent sends HELLO with available_shells=["/bin/bash", "/bin/zsh"]
    Then hosts.discovered_shells is updated to '["\/bin\/bash","\/bin\/zsh"]'
    And hosts.discovered_shells_at is set to current timestamp

@priority:medium @type:edge
Scenario: SC-23 Old agent without shell discovery
    Given an agent that does NOT send available_shells in HELLO
    Then hosts.discovered_shells remains NULL
    And profile visibility falls back to supported_os matching only
    And spawn shell fallback uses process.env.SHELL (for local) or /bin/sh
```

### Scenario Group: Migration

```gherkin
@priority:high @type:nominal
Scenario: SC-24 Migrate hosts.default_shell to LaunchProfile
    Given a host "prod-db" with default_shell="/bin/bash"
    When hub starts and runs migration
    Then a profile "Default Shell (prod-db)" exists with shell="/bin/bash"
    And a default override links it to host "prod-db"
    And hosts.default_shell for "prod-db" is NULL

@priority:high @type:edge
Scenario: SC-25 Migration collision: per-host wins over config.toml
    Given host "local" has default_shell="/bin/zsh" in meta.db
    And config.toml has channels.defaultShell="/bin/bash"
    When hub starts and runs migration
    Then the local host's default profile is "/bin/zsh" (per-host wins)
    And a "Default Shell" profile with "/bin/bash" is created but NOT set as default for local

@priority:medium @type:edge
Scenario: SC-26 Migration is idempotent
    Given migration has already run (profiles exist)
    When hub restarts
    Then no duplicate profiles are created
    And existing profiles are unchanged
```

### Scenario Group: UI

```gherkin
@priority:high @type:nominal
Scenario: SC-27 Quick command spawns one-shot
    Given the user opens the "+" dropdown and clicks "Run command..."
    When the user types "python3 -i" and presses Enter
    Then a channel is spawned with shell="python3", args=["-i"], mode="process"
    And no LaunchProfile is created

@priority:high @type:nominal
Scenario: SC-28 Command palette ~ prefix finds profiles
    Given profiles "Python REPL", "Node.js", "htop" exist
    When the user opens command palette and types "~pyt"
    Then "Python REPL" is shown as a match
    When the user selects it
    Then the profile is spawned on the current host
```

### Scenario Group: Adversarial Edge Cases

```gherkin
@priority:medium @type:edge @source:adversarial
Scenario: SC-29 Quick command with empty input is no-op
    Given the user opens the "+" dropdown and clicks "Run command..."
    When the user presses Enter without typing anything
    Then no spawn occurs
    And the input is dismissed

@priority:medium @type:edge @source:adversarial
Scenario: SC-30 Update profile does not affect active channels
    Given a profile "Python" with shell="python3", cwd="/home/dev"
    And channel C1 was spawned from "Python" (launch_profile_id=P1)
    When I PUT /api/launch-profiles/P1 with cwd="/home/other"
    Then the profile's cwd is "/home/other"
    And channel C1 still has its original spawned cwd (seed-not-live)

@priority:medium @type:edge @source:adversarial
Scenario: SC-31 Delete host cascades overrides
    Given a profile "htop" with a pin override on host "server-1"
    When host "server-1" is deleted
    Then the pin override for "htop" on "server-1" is removed
    And the profile "htop" still exists

@priority:medium @type:edge @source:adversarial
Scenario: SC-32 Reorder with missing/invalid IDs
    Given profiles A (sort_order=0), B (sort_order=1), C (sort_order=2)
    When I POST /api/launch-profiles/reorder with ids=[C, A]
    Then C has sort_order=0, A has sort_order=1
    And B retains its current sort_order (unchanged)

@priority:medium @type:edge @source:adversarial
Scenario: SC-33 Profile name uniqueness is case-insensitive
    Given a profile named "Python REPL" exists
    When I POST /api/launch-profiles with name="python repl", shell="python3"
    Then response is 409 Conflict

@priority:medium @type:edge @source:adversarial
Scenario: SC-34 Visibility for SSH host with unknown OS
    Given a profile "vim" with supported_os="any"
    And a profile "htop" with supported_os="linux"
    And an SSH host "remote-1" that has never connected (no HELLO received)
    When I GET /api/hosts/remote-1/profiles
    Then "vim" is in the response (any matches unknown)
    And "htop" is NOT in the response (linux does not match unknown)

@priority:high @type:error @source:adversarial
Scenario: SC-35 Reject shell with metacharacters
    When I POST /api/launch-profiles with name="evil", shell="/bin/sh; rm -rf /"
    Then response is 400 Bad Request with message containing "executable path"

@priority:medium @type:security @source:adversarial
Scenario: SC-36 Env values masked in API response
    Given a profile with env={"DB_PASSWORD": "secret123", "PATH": "/usr/bin"}
    When I GET /api/launch-profiles/:id
    Then the response has env.DB_PASSWORD="********" (masked)
    And the response has env.PATH="/usr/bin" (not masked)
```

### Coverage Matrix

| Scenario | Nominal | Edge | Error | Security |
|----------|:-------:|:----:|:-----:|:--------:|
| SC-01 | x | | | |
| SC-02 | x | | | |
| SC-03 | | | x | |
| SC-04 | | | x | |
| SC-05 | x | | | |
| SC-06 | x | | | |
| SC-07 | x | | | |
| SC-08 | x | | | |
| SC-09 | x | | | |
| SC-10 | x | | | |
| SC-11 | x | | | |
| SC-12 | x | | | |
| SC-13 | x | | | |
| SC-14 | x | | | |
| SC-15 | | x | | |
| SC-16 | | x | | |
| SC-17 | x | | | |
| SC-18 | x | | | x |
| SC-18b | x | | | x |
| SC-18c | x | | | x |
| SC-19 | | x | | x |
| SC-20 | | x | | x |
| SC-20b | | x | | x |
| SC-21 | x | | | |
| SC-22 | x | | | |
| SC-23 | | x | | |
| SC-24 | x | | | |
| SC-25 | | x | | |
| SC-26 | | x | | |
| SC-27 | x | | | |
| SC-28 | x | | | |

| SC-29 | | x | | |
| SC-30 | | x | | |
| SC-31 | | x | | |
| SC-32 | | x | | |
| SC-33 | | | x | |
| SC-34 | | x | | |
| SC-35 | | | x | |
| SC-36 | | | | x |

**Totals:** 20 nominal, 14 edge, 4 error, 7 security = 39 scenarios (8 security hardening, 3 from elevation rewrite)

## 6. Implementation Plan

### Block 1: Data Model + DAL + REST API — M

**Type:** Feature slice (foundation)
**Dependencies:** None
**Packages:** shared, hub

**Files:**
- `packages/shared/src/entities.ts` — Add `LaunchProfile`, `HostLaunchProfileOverride` interfaces. Extend `Channel` with `launchProfileId`. Extend `Host` with `discoveredShells`, `discoveredShellsAt`.
- `packages/shared/src/protocol.ts` — Extend `HelloMessage` (availableShells, defaultShell). Extend `UiSpawnMessage` (launchProfileId, elevated). Extend `AgentSpawnMessage` (elevated).
- `packages/shared/src/config.ts` — Remove `defaultShell` from `CHANNELS_CONFIG_KEYS`. Add `LaunchProfileMode`, `SupportedOs` types.
- `packages/hub/src/storage/migrations/meta/009-launch-profiles.sql` — New tables + ALTER statements.
- `packages/hub/src/storage/meta.ts` — Add DAL methods: `createLaunchProfile`, `getLaunchProfile`, `listLaunchProfiles`, `updateLaunchProfile`, `deleteLaunchProfile`, `reorderLaunchProfiles`, `getProfilesForHost` (visibility query), `upsertHostProfileOverride`, `deleteHostProfileOverride`, `getHostProfileOverrides`, `updateHostDiscoveredShells`.
- `packages/hub/src/api/launch-profiles.ts` — `registerLaunchProfileRoutes(app, dbManager)`. All endpoints from §4.8.
- `packages/hub/src/api/hosts.ts` — Add `/api/hosts/:id/profiles` GET and per-profile PUT/DELETE override routes.
- `packages/hub/src/server.ts` — Register launch-profile routes.

**Exit criteria:**
- [ ] Migration 009 creates tables correctly
- [ ] CRUD operations work via API (28+ test assertions)
- [ ] Visibility query returns correct profiles per host OS + overrides
- [ ] Partial unique index enforces one default per host
- [ ] Validation rules enforced (name uniqueness, shell non-empty, enum checks)
- [ ] SC-01 through SC-11 pass

### Block 2: Agent Shell Discovery — S

**Type:** Feature slice
**Dependencies:** Block 1 (types)
**Packages:** shared, agent, hub

**Files:**
- `packages/agent/src/shell-detection.ts` — New file: `detectAvailableShells(): Promise<string[]>`, `getDefaultShell(): string`. Platform-specific logic (Linux: /etc/shells, macOS: /etc/shells, Windows: registry + known paths).
- `packages/agent/src/handler.ts` — In HELLO construction, call `detectAvailableShells()` and `getDefaultShell()`, add to HELLO message.
- `packages/hub/src/session/session-manager.ts` — In `_handleHello()`, extract `availableShells`/`defaultShell` and call `dbManager.meta.updateHostDiscoveredShells(hostId, shells, timestamp)`.

**Exit criteria:**
- [ ] Agent detects shells on Linux (reads /etc/shells)
- [ ] Agent reports shells in HELLO message
- [ ] Hub caches shells in hosts table
- [ ] Old agents without shells don't break hub
- [ ] SC-21, SC-22, SC-23 pass

### Block 3: Spawn Resolution + Variable Expansion — M

**Type:** Feature slice
**Dependencies:** Block 1 (DAL), Block 2 (shell discovery for fallback)
**Packages:** shared, agent, hub

**Files:**
- `packages/hub/src/session/session-manager.ts` — Update `handleSpawn()`: resolve from LaunchProfile when `launchProfileId` is set. Profile fields → UiSpawnMessage fields. Seed `channel.profileJson` with `profile_overrides`. Store `launch_profile_id` on channel. Check agent capabilities before sending `elevated`.
- `packages/shared/src/var-expansion.ts` — New file: `expandVars(input: string, env: Record<string, string>): string`. One-pass, left-to-right. Handles `${VAR}`, `\${VAR}`, undefined vars. Single implementation in shared — agent and hub import from here.
- `packages/agent/src/handler.ts` — Before spawning PTY, import `expandVars` from `@lasterm/shared` and run on args, cwd, env values.

**Exit criteria:**
- [ ] Spawning with launchProfileId resolves profile fields
- [ ] Profile overrides seed channel.profileJson
- [ ] channel.launch_profile_id is persisted
- [ ] Variable expansion works: `${HOME}` → value, `\${HOME}` → literal, `${UNDEF}` → literal
- [ ] UiSpawnMessage fields override profile fields
- [ ] SC-13 through SC-17 pass

### Block 4: Elevation Support — M

**Type:** Feature slice
**Dependencies:** Block 3 (spawn resolution)
**Packages:** shared, agent, hub, web

**Files:**
- `packages/shared/src/protocol.ts` — Extend `AuthPromptMessage` with `promptType: 'passphrase' | 'elevation'` (INV-15). Extend `AgentSpawnMessage` with `elevationSecret?: string`.
- `packages/agent/src/elevation.ts` — New file: `buildAskpassEnv(secret: string): { env: Record<string, string>, cleanup: () => void }` (creates temp ASKPASS script, returns env + cleanup fn). `wrapWithElevation(shell: string, args: string[], platform: string, transport: 'local' | 'ssh'): { shell: string, args: string[] }` — Linux/macOS: prepend `sudo -A -E`. Windows local: prepend `gsudo`. Windows SSH: return unchanged.
- `packages/agent/src/handler.ts` — If `elevated` in SPAWN: call `buildAskpassEnv()` (Linux/macOS) or gsudo wrapper (Windows local), spawn PTY, cleanup. Zero `elevationSecret` after use.
- `packages/hub/src/session/session-manager.ts` — In `handleSpawn()`: if elevated + Linux/macOS → check `elevationCache` → if miss → AUTH_PROMPT(promptType='elevation') → await response → cache if "remember". If elevated + Windows SSH → ERR-04. Strip `elevated` if agent lacks capability.
- `packages/hub/src/session/session-manager.ts` — Add `elevationCache: Map<string, {secret, expiresAt}>`. TTL from config (`channels.elevationCacheTtl`, default 900s). Clear on shutdown.
- `packages/clients/web/src/components/AuthPromptDialog.vue` — Handle `promptType='elevation'`: different title/icon, "Remember this session" checkbox. Reuse existing modal structure.

**Exit criteria:**
- [ ] Linux/macOS elevated spawn uses ASKPASS (password not in PTY stream)
- [ ] Windows local elevated spawn uses gsudo (no password from hub)
- [ ] Windows SSH elevated is stripped with warning
- [ ] Old agent without capability: elevated stripped
- [ ] Elevation modal shown when no cached credential
- [ ] Cached credential skips modal
- [ ] User cancel aborts spawn (ERR-10)
- [ ] elevationSecret zeroed after use (agent + hub)
- [ ] SC-18, SC-18b, SC-18c, SC-19, SC-20, SC-20b pass

### Block 5: Migration Logic — S

**Type:** Data migration
**Dependencies:** Block 1 (DAL)
**Packages:** hub

**Files:**
- `packages/hub/src/storage/migrate-launch-profiles.ts` — New file: `migrateLegacyShellDefaults(dbManager, configResolver)`. Runs at startup. Handles both sources (hosts.default_shell + config.toml channels.defaultShell). Idempotent via name-based existence check + migration_marker.
- `packages/hub/src/server.ts` — Call migration after DB init, before route registration.

**Exit criteria:**
- [ ] hosts.default_shell → per-host LaunchProfile + default override
- [ ] config.toml defaultShell → LaunchProfile (not default if per-host already set)
- [ ] Collision: per-host wins default slot
- [ ] Idempotent: no duplicates on restart
- [ ] Deprecation warning logged for config.toml key
- [ ] SC-24, SC-25, SC-26 pass

### Block 6: UI — "+" Dropdown — M

**Type:** Feature slice
**Dependencies:** Block 1 (API), Block 3 (spawn)
**Packages:** web

**Files:**
- `packages/clients/web/src/components/ProfileDropdown.vue` — New component: dropdown menu triggered by chevron on "+" button. Shows filtered profiles for current host. Default profile, separator, quick command, manage link.
- `packages/clients/web/src/components/QuickCommandInput.vue` — New component: inline input for one-shot command. Parses first token as shell, rest as args. Spawns with mode="process".
- `packages/clients/web/src/components/TabBar.vue` — Replace simple "+" button with split button: click = default profile spawn, chevron = ProfileDropdown.
- `packages/clients/web/src/stores/profiles.ts` — New Pinia store: `useProfilesStore()`. Actions: `fetchProfiles()`, `fetchHostProfiles(hostId)`, `createProfile()`, `updateProfile()`, `deleteProfile()`, `spawnFromProfile(profileId)`, `spawnQuickCommand(command)`.
- `packages/clients/web/src/stores/channels.ts` — Update `spawnChannel()` to accept optional `launchProfileId` and `elevated` params.

**Exit criteria:**
- [ ] "+" click spawns default profile for current host
- [ ] Dropdown shows OS-filtered profiles
- [ ] Quick command input spawns one-shot
- [ ] "Manage profiles..." navigates to Settings > Profiles
- [ ] SC-12, SC-27 pass

### Block 7: UI — Settings > Profiles Tab — L

**Type:** Feature slice
**Dependencies:** Block 1 (API), Block 2 (shell autocomplete)
**Packages:** web

**Files:**
- `packages/clients/web/src/components/settings/ProfilesSettings.vue` — New component: profile list with card layout. New/Edit/Delete actions. Drag-to-reorder.
- `packages/clients/web/src/components/settings/ProfileForm.vue` — New component: full profile edit form. Fields: name, shell (autocomplete from discovered shells), args (tag input), cwd, mode, elevated, supported_os, icon, color, env vars (key-value editor with masking), visual overrides (TerminalProfile subset), host overrides table.
- `packages/clients/web/src/components/settings/HostOverridesTable.vue` — New component: table showing all hosts with pin/hide/default toggle per profile.
- `packages/clients/web/src/components/settings/CategoryNav.vue` — Add "profiles" tab to navigation.
- `packages/clients/web/src/stores/settings.ts` — Add "profiles" to scope categories.

**Exit criteria:**
- [ ] Profiles tab shows all profiles with cards
- [ ] Create/Edit/Delete workflows work
- [ ] Shell autocomplete shows agent-reported shells
- [ ] Host overrides table allows pin/hide/default per host
- [ ] Env var editor masks sensitive values
- [ ] Visual overrides form works

### Block 8: Command Palette + Keyboard Shortcuts — S

**Type:** Feature slice
**Dependencies:** Block 6 (profiles store)
**Packages:** web

**Files:**
- `packages/clients/web/src/composables/useCommandPalette.ts` — Add `"profile"` item type. `~` prefix filters profiles (note: `#` is already used for channels). Selecting a profile calls `profilesStore.spawnFromProfile()`.
- `packages/clients/web/src/components/CommandPalette.vue` — Render profile items with icon/color.
- `packages/clients/web/src/composables/useKeyboardShortcuts.ts` — Add Ctrl+Shift+1..9 bindings. Map N to Nth profile (by sort_order) for current host. **Important (INV-13):** these shortcuts only fire when the terminal PTY does NOT have focus. When the xterm.js terminal element is focused, key events pass through to the PTY.

**Exit criteria:**
- [ ] `~python` in command palette shows Python profile
- [ ] Selecting profile in palette spawns it
- [ ] Ctrl+Shift+1 spawns first profile for current host
- [ ] Ctrl+Shift+N does NOT fire when terminal is focused (passthrough to PTY)
- [ ] SC-28 passes

## 7. Test Strategy

### Test Pyramid

| Level | Count | Focus |
|-------|-------|-------|
| Unit | ~55 | DAL CRUD, var expansion, shell detection, visibility query, ASKPASS builder, gsudo wrapper, migration logic, shell validation, env masking, elevation cache TTL |
| Integration | ~30 | API endpoints, spawn resolution, HELLO handling, profile→channel seeding, reorder edge cases, cascade deletes, elevation prompt flow |
| Component (web) | ~15 | ProfileDropdown, ProfileForm, HostOverridesTable, CommandPalette with profiles, AuthPromptDialog elevation mode |

### Test Data Requirements

**Fixtures:**
- `testLaunchProfile(overrides?)` — factory for LaunchProfile with defaults
- `testHostWithOs(os)` — factory for Host with discovered_shells pre-set
- Extend existing `testHost()` factory with `discoveredShells` field

**Mocks:**
- Agent shell detection: mock `/etc/shells` reads and `process.env.SHELL`
- Agent HELLO: mock messages with/without `available_shells`
- Profile store (web): mock API calls

**In-memory DB:** All DAL/integration tests use `:memory:` SQLite (existing pattern).

### Key Test Files

| File | Block | Tests |
|------|-------|-------|
| `packages/hub/src/storage/meta.spec.ts` | 1 | DAL CRUD, visibility query, override constraints |
| `packages/hub/src/api/launch-profiles.spec.ts` | 1 | REST API integration |
| `packages/agent/src/shell-detection.spec.ts` | 2 | Platform shell scanning |
| `packages/shared/src/var-expansion.spec.ts` | 3 | Variable expansion grammar |
| `packages/hub/src/session/session-manager.spec.ts` | 3 | Spawn resolution from profile |
| `packages/agent/src/elevation.spec.ts` | 4 | Elevation wrappers |
| `packages/hub/src/storage/migrate-launch-profiles.spec.ts` | 5 | Migration scenarios |
| `packages/clients/web/src/components/ProfileDropdown.spec.ts` | 6 | Dropdown behavior |
| `packages/clients/web/src/stores/profiles.spec.ts` | 6 | Store actions |
| `packages/clients/web/src/components/settings/ProfilesSettings.spec.ts` | 7 | Settings CRUD |
| `packages/clients/web/src/composables/useCommandPalette.spec.ts` | 8 | ~ prefix filtering |
| `packages/agent/src/elevation.spec.ts` | 4 | ASKPASS builder, gsudo wrapper, secret zeroing |

## 8. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|:------:|:-----------:|------------|
| Elevation cross-platform complexity | H | M | ASKPASS for Linux/macOS, gsudo for Win local, Win SSH disabled. Password-based Win elevation deferred to agent packaging. |
| ASKPASS temp script security | M | L | chmod 700, user-only, deleted immediately after spawn. Race window < 100ms. |
| Elevation credential in transit | M | L | Local: stdio (same machine). Remote: SSH tunnel (encrypted). Never in REST API or logs. |
| Migration dual-source collision | M | L | Strict precedence (per-host wins), idempotent, deprecate-don't-delete |
| Variable expansion edge cases | M | L | Strict grammar (one-pass, no recursion), keep literal for undefined |
| Agent backward compatibility | H | L | Capability check (`launch-profiles`), graceful fallback to existing fields |
| Settings UI density (17-field form) | M | M | Tabbed form (Basic / Advanced / Overrides), progressive disclosure |
| Scope creep (17 features in one story) | H | M | Strict block ordering, exit criteria per block, defer polish |

## 9. Definition of Done

- [ ] All 8 blocks implemented
- [ ] All 39 BDD scenarios have passing tests
- [ ] All tests pass (unit + integration + component)
- [ ] `pnpm lint` clean
- [ ] `pnpm build` succeeds
- [ ] Migration 009 applies cleanly on existing databases
- [ ] Legacy defaultShell deprecation logged (not deleted)
- [ ] Code review clean (no blocking findings)
- [ ] Documentation updated (SPEC.md §4 entity model, PROTOCOL.md §3.1 HELLO, STORAGE.md §3 schema)
