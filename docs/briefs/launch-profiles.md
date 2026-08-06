# Launch Profiles — Ideation Brief

> Reviewed by 3 LLMs (Codex/Gemini/Copilot) — findings integrated below.

## Problem Statement

**Problem:** Users cannot launch terminals with predefined configurations. Every "+" spawns the default shell — no way to one-click into Python REPL, htop, Node, or a custom script. Additionally, the global `channels.defaultShell` in config.toml is OS-biased (bash on Windows hosts = broken).

**Root cause:** The profile concept was designed for visual customization only (fonts, theme, cursor), not as a "launch configuration" that defines the full terminal experience. Shell/command config is separate and disconnected from the UI spawn flow.

**Target users:** All lasterm users, especially power users with multiple workflows per host.

**Current solutions:**
- Windows Terminal: named profiles (shell+icon+colorScheme), dropdown on "+", auto-detect installed shells
- iTerm2: profiles with triggers, initial command, working directory
- VS Code: terminal profiles (shell+args+icon+env), dropdown on "+"
- Tabby: profiles per connection + shell

## Proposed Solution

**Approach:** Named Launch Profiles — a new first-class entity that bundles shell configuration + visual overrides, with OS-aware auto-filtering, per-host override bindings, and agent-reported shell discovery.

**Why this approach:**
- Protocol already supports shell/args/cwd/env in UiSpawnMessage — UI just doesn't use it
- Natural extension of existing entity model (Host → Session → Channel)
- OS-aware filtering with per-host overrides gives precision without excessive config
- Agent-reported shells solve the cross-OS default problem at the source

## Key Design Decisions

### LaunchProfile Entity

New first-class entity stored in meta.db:

```
LaunchProfile:
  id                ULID (PK)
  name              string (unique, display name — e.g., "Python REPL")
  shell             string (executable path — e.g., "/usr/bin/python3", "pwsh.exe")
  args              string[] (optional — e.g., ["-i", "--no-banner"])
  cwd               string (optional — working directory, supports ${VAR} expansion)
  env               Record<string, string> (optional — env var overrides, supports ${VAR} references)
  mode              "shell" | "process" (default: "shell")
                      shell   = spawn inside a shell wrapper (default, normal terminal)
                      process = spawn binary directly (htop, python3 -i, vim — better signal handling)
  elevated          boolean (default: false — request sudo/admin elevation at spawn)
  supported_os      "linux" | "darwin" | "windows" | "any" (default: "any")
  icon_type         "auto" | "emoji" | "image" (aligned with Host entity)
  icon_value        string (optional — emoji char, image filename, or auto-resolved)
  color             string (optional — hex color for visual distinction in UI)
  profile_overrides Partial<TerminalProfile> (optional — visual overrides: theme, font, cursor, scrollback, etc.)
  sort_order        number (global display ordering)
  created_at        ISO 8601
  updated_at        ISO 8601
```

**Variable expansion:** `args` and `cwd` support `${VAR}` syntax (e.g., `${HOME}/projects`, `${USER}`). Expansion is resolved by the **agent** at spawn time (not the hub), since the agent runs on the target OS and has access to the correct environment.

**Execution mode:** `mode: "process"` skips the shell wrapper, spawning the binary directly via node-pty. Essential for TUI apps (htop, vim) and REPLs (python3, node) where a wrapping shell interferes with signal handling (Ctrl+C, Ctrl+Z).

**Elevation:** `elevated: true` requests privilege escalation. On Linux: prefixes with `sudo -E`. On Windows: requests admin token. On macOS: uses `osascript` for admin prompt. The agent handles OS-specific elevation mechanics.

### Host Binding: OS-Aware + Override Join Table

Profiles use **dual-layer visibility**:

**Layer 1 — Automatic (OS-based):**
Profiles are auto-visible on hosts whose OS matches `supported_os`. A profile with `supported_os: "linux"` automatically appears on all Linux hosts without any binding. `supported_os: "any"` appears everywhere.

**Layer 2 — Override (join table):**
The join table is used ONLY for per-host overrides on top of the auto-filter:

```
host_launch_profiles (join table):
  host_id         FK → hosts.id (ON DELETE CASCADE)
  profile_id      FK → launch_profiles.id (ON DELETE CASCADE)
  override_type   "pin" | "hide" | "default" (what this override does)
  sort_order      number (host-specific ordering, NULL = use global sort_order)
  PK(host_id, profile_id)
```

**Override types:**
- `pin` — force-show this profile on the host even if OS doesn't match
- `hide` — hide this profile on the host even if OS matches
- `default` — set as the default profile for this host (★ in dropdown)

**Result:** A user with 20 Linux servers creates a "htop" profile once with `supported_os: "linux"` → visible on all 20 servers immediately. No manual binding needed. The join table is only for exceptions.

### Agent HELLO Enrichment

Extend the HELLO message with optional shell discovery (lightweight, no heavy scanning):

```
HELLO (agent → hub):
  ... existing fields ...
  os              string (already exists — "linux", "darwin", "windows")
  available_shells    string[] (optional — detected installed shells)
  default_shell       string (optional — OS default: $SHELL on Unix, pwsh on Windows)
```

- Local agent: reads `$SHELL` (zero I/O), optionally reads `/etc/shells` (fast, cached by OS)
- Remote agent: same detection on remote OS
- Hub caches in `hosts.discovered_shells` (JSON column) + `hosts.discovered_shells_at` (timestamp) for offline access
- Hub uses this to:
  1. Resolve OS for `supported_os` matching when host.os not yet known
  2. Set the "system default" fallback (when no profile is set as default)
  3. Populate shell autocomplete in profile creation UI
  4. De-duplicate: if a profile's `shell` matches an agent-reported shell, don't show a duplicate "system shell" entry

### "+" Button Behavior

```
[+] click         → spawn with host's default profile (or system shell if none)
[+] dropdown/▾    → show profiles visible for current host
                    ├── ★ Default Shell (/bin/zsh)
                    ├── 🐍 Python REPL
                    ├── 📦 Node.js
                    ├── 📊 htop
                    ├── ──────────────
                    ├── ⌨ Run command...     (quick command)
                    └── ⚙ Manage profiles...
```

- Profiles filtered by: `supported_os` match + join table overrides (pin/hide)
- Sorted by: host-specific sort_order (if set) → global sort_order
- Default profile marked with ★
- "Run command..." opens inline input for one-shot custom command (not saved)
- "Manage profiles..." opens Settings > Profiles tab
- Keyboard shortcut: Ctrl+Shift+1..9 for quick profile launch

### Config Cascade Integration

When spawning with a launch profile:
1. Profile's `shell`, `args`, `cwd`, `env`, `mode`, `elevated` → UiSpawnMessage fields
2. Profile's `profile_overrides` → deep-merged into new channel's `profile_json` at creation time
3. Profile's `id` → stored as `channel.launch_profile_id` (FK, optional) for provenance tracking
4. Cascade remains unchanged: defaults → config.toml → host.profileJson → channel.profileJson
5. The launch profile seeds the channel — after creation, channel can be further customized per-channel

No new cascade layer needed — the profile feeds INTO the existing layers at spawn time.
`channel.launch_profile_id` allows debugging "where did this channel's config come from?" without adding cascade complexity.

### Migration: channels.defaultShell + hosts.default_shell

**Two sources must be migrated** (finding from Copilot review):

**1. config.toml `[channels].defaultShell`:**
- On first startup after upgrade, if `channels.defaultShell` exists:
  - Validate the shell path exists on the current host
  - If valid: create a LaunchProfile named "Default Shell" with that value
  - Bind to local host as default (join table override_type: "default")
  - If invalid (e.g., Windows path on Linux from synced config): log warning, skip
  - Deprecate `defaultShell` key — keep readable for one release with deprecation warning in logs
- If no `defaultShell` configured:
  - System relies on agent-reported `default_shell` from HELLO
  - No profile created — "+" uses system default

**2. meta.db `hosts.default_shell` (per-host):**
- Iterate all hosts with non-NULL `default_shell`
- For each: create a LaunchProfile named "Default Shell ({host.label})" with the host's shell
- Set `supported_os` based on host.type context (local → current OS, SSH → unknown → "any")
- Bind to that specific host as default
- Nullify `hosts.default_shell` after successful migration

**Idempotency:** Migration checks for existing "Default Shell" profiles before creating duplicates. Uses a `migrations_applied` flag or similar mechanism.

**3. Cleanup (after one release cycle):**
- Remove `defaultShell` from `CHANNELS_CONFIG_KEYS`
- Remove `default_shell` column from hosts table (or keep as deprecated NULL)

### Profile Management UI (Settings > Profiles)

New tab in Settings panel:

```
┌─────────────────────────────────────────────┐
│ ⚙ Settings                                  │
├──────┬──────────────────────────────────────│
│ ...  │  Profiles                             │
│ Prof │                                       │
│ ...  │  [+ New Profile]                      │
│      │                                       │
│      │  ┌─────────────────────────────────┐  │
│      │  │ 🐍 Python REPL          linux   │  │
│      │  │ python3 -i  (process mode)      │  │
│      │  │ Auto-visible: all Linux hosts   │  │
│      │  │                        [Edit]   │  │
│      │  └─────────────────────────────────┘  │
│      │                                       │
│      │  ┌─────────────────────────────────┐  │
│      │  │ 📊 htop                 linux   │  │
│      │  │ htop  (process mode, elevated)  │  │
│      │  │ Auto-visible: all Linux hosts   │  │
│      │  │                        [Edit]   │  │
│      │  └─────────────────────────────────┘  │
│      │                                       │
│      │  ┌─────────────────────────────────┐  │
│      │  │ ⚡ PowerShell           windows  │  │
│      │  │ pwsh.exe                        │  │
│      │  │ Auto-visible: all Windows hosts │  │
│      │  │                        [Edit]   │  │
│      │  └─────────────────────────────────┘  │
└──────┴──────────────────────────────────────┘
```

Profile edit form:
- Name, Icon (icon_type + icon_value, aligned with Host schema), Color
- Shell (path with autocomplete from agent-reported shells), Args (list), CWD
- Mode (shell / process), Elevated (checkbox)
- Supported OS (linux / darwin / windows / any)
- Env vars (key-value editor, with masking for sensitive values)
- Visual overrides (theme, font, cursor, scrollback — optional, inherits from host/global if empty)
- Host overrides (table: which hosts pin/hide/default this profile)

### Command Palette Integration

Profiles are searchable via the existing command palette (Cmd+K):
- `#` prefix filters launch profiles: `#python` → shows "Python REPL" profile
- Selecting a profile in command palette spawns it on the current host
- Recent profiles shown in command palette "recent items"

### Keyboard Shortcuts

- Ctrl+Shift+1..9: spawn the Nth profile (by sort_order) on the current host
- Keybindings configurable per-profile in Settings

## Key Features (All MVP)

1. **LaunchProfile entity + CRUD API** — meta.db table, REST endpoints, validation
2. **OS-aware auto-filtering** — `supported_os` field, profiles auto-visible on matching hosts
3. **Host override bindings (join table)** — pin/hide/default per host
4. **Agent-reported shells** — HELLO enrichment with available_shells + default_shell, cached in hosts
5. **"+" dropdown** — profile selection at spawn time, default profile on single click
6. **Quick command** — one-shot command input in "+" dropdown (not saved as profile)
7. **Profile management UI** — Settings > Profiles tab with full CRUD
8. **Execution mode** — shell vs process (direct spawn without shell wrapper)
9. **Elevation support** — sudo/admin request at spawn time
10. **Variable expansion** — `${VAR}` in args/cwd, resolved by agent
11. **Visual overrides** — profile can override theme, font, cursor, scrollback
12. **Migration** — auto-convert both channels.defaultShell and hosts.default_shell
13. **Channel provenance** — `channel.launch_profile_id` FK for debugging
14. **Env var management** — key-value with masking for sensitive values in API/UI
15. **Command palette integration** — `#` prefix to filter and launch profiles
16. **Keyboard shortcuts** — Ctrl+Shift+1..9 for quick profile launch
17. **Icon/color** — aligned with Host entity schema (icon_type + icon_value + color)

## Technical Considerations

**Constraints:**
- Must work with existing config cascade (no new layer — profile seeds channel at spawn)
- Backward compatible with agents that don't report shells (fallback to $SHELL)
- meta.db migration (new tables: launch_profiles, host_launch_profiles; modified: channels adds launch_profile_id)
- UiSpawnMessage already supports shell/args/cwd/env — extend with mode + elevated
- HELLO message change is additive (optional fields)
- Variable expansion happens agent-side (agent has correct env context)
- Env secrets: mask in API responses and UI, never log plaintext

**Affected packages:**
- shared: LaunchProfile type, HELLO type extension, UiSpawnMessage extension (mode, elevated), remove channels.defaultShell from config
- agent: shell detection in HELLO handler, variable expansion in spawn, elevation mechanics (sudo/admin)
- hub: new DAL, API routes, migration (dual: config.toml + hosts.default_shell), SessionManager spawn resolution, channel.launch_profile_id
- web: dropdown component, Settings > Profiles tab, host binding UI, command palette integration, keyboard shortcuts

## Risks

| Risk | Mitigation |
|------|------------|
| HELLO backward-compat (old agents) | Fields optional, hub fallbacks to process.env.SHELL |
| Config cascade confusion | Profile seeds channel.profileJson + launch_profile_id for provenance — no new layer |
| Migration dual-source edge cases | Idempotent migration, validate shell exists, deprecate-then-remove over 2 releases |
| Cross-OS config.toml sync | Validate shell path exists before creating profile from migration |
| Env secrets exposure | Mask in API responses (redact values), UI shows dots, never log plaintext |
| Elevation security | Agent verifies caller auth before honoring elevated flag. No password storage |
| UI density in Settings | Dedicated "Profiles" tab, card-based layout |

## Resolved Questions (from LLM review)

1. **directProcess** → YES: `mode: "process"` field. Essential for htop, python, vim.
2. **Recent commands in dropdown** → YES: "Run command..." quick input (one-shot, not saved).
3. **Visual overrides scope** → Full `Partial<TerminalProfile>`. Profile can override any visual setting.
4. **Built-in profiles** → NO: too opinionated. Migration creates from user's existing config. User creates new ones from scratch or from agent-reported shells.
5. **Icon schema** → Aligned with Host entity: `icon_type` + `icon_value` (not a simple string).
6. **Variable expansion** → YES: `${VAR}` in args/cwd, resolved agent-side.
7. **Elevation** → YES: `elevated` boolean, OS-specific mechanics in agent.
8. **Deduplication** → UI de-duplicates based on shell path (agent-reported vs user profile).

## Next Steps

→ Generate executable specification from this brief
→ Then create implementation plan
