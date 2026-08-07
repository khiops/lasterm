---
doc-meta:
  status: canonical
  scope: web,hub,shared
  type: specification
  target_project: /mnt/wsl/shared/dev/lasterm
  created: 2026-03-08
  updated: 2026-03-08
  complexity: COMPLEX
  time-budget: 90min
  adversarial_applied: true
---

# Specification: UX-09 — Settings Panel (Config Cascade UI)

## 0. Quick Reference

| Item | Value |
|------|-------|
| Scope | web, hub, shared |
| Complexity | COMPLEX |
| Time budget | ~90 min |
| Blocks | 5 |
| BDD scenarios | 20 |
| Risk level | MEDIUM |

### Decisions Log

| ID | Decision | Date |
|----|----------|------|
| D13 | Replace @iarna/toml with @rainbowatcher/toml-edit-js for writes (keep @iarna/toml for reads). 303 KB WASM wrapping Rust `toml_edit` crate. `edit(tomlString, 'dotted.key', value)` — surgical, comment-preserving round-trip. | 2026-03-08 |
| D14 | Absorb appearance.json into config.toml `[appearance]` / `[appearance.auto_switch]` / `[appearance.opacity]` / `[appearance.scrollbar]`. themes/*.json files remain as individual files. | 2026-03-08 |
| D15 | autoSwitch uses system `prefers-color-scheme` (matchMedia). `auto_switch.enabled = true` → follow OS dark/light mode using `light_theme`/`dark_theme`. No manual `day_start`/`night_start`. | 2026-03-08 |

## 1. Problem Statement

Users have no centralized UI to view or edit settings across the 4-layer config cascade. The only settings surface is AppearancePanel (themes/opacity/scrollbar, global only). Host and channel profile overrides require API calls. Users cannot see which layer a setting comes from, nor reset overrides to parent values.

## 2. User Stories

**US-1:** As a user, I want a centralized settings panel where I can view and edit all configurable settings grouped by category, so that I don't need to edit config.toml manually or make API calls.

**US-2:** As a user, I want to see and manage per-host and per-channel overrides with clear visual indicators showing which level provides each value, so that I understand the config cascade without guessing.

**US-3:** As a user, I want to reset any override to inherit from its parent scope, so that I can undo per-host or per-channel customizations.

## 3. Business Rules

### 3.1 Invariants

- INV-01: The 4-layer cascade order is immutable: defaults → config.toml → host → channel (last wins)
- INV-02: A setting with no override at a given scope inherits the resolved value from the parent scope
- INV-03: Resetting a setting at scope N removes only that scope's override — parent scopes are unaffected
- INV-04: The settings panel must never modify DEFAULT_PROFILE (Layer 1, code-level)
- INV-05: UiConfig settings (tabs, panes, search, startup, title) exist only at Global scope

### 3.2 Preconditions

- PRE-01: User must be authenticated (auth token valid) to access settings
- PRE-02: Host scope tab visible only when a host is selected in the sidebar
- PRE-03: Channel scope tab visible only when a channel is focused (active tab)

### 3.3 Effects

- EFF-01: Changing a Global setting writes to config.toml via @rainbowatcher/toml-edit-js surgical edit (comments and formatting preserved). If config.toml does not exist, it is created in the XDG config dir.
- EFF-02: Changing a Host setting writes to hosts.profile_json via PATCH /api/hosts/:id/profile
- EFF-03: Changing a Channel setting writes to channels.profile_json via PATCH /api/channels/:id/profile
- EFF-04: Appearance changes (theme, opacity, scrollbar, autoSwitch) write to config.toml [appearance] section via toml-edit-js (appearance.json eliminated — D14)
- EFF-05: Changes apply immediately to all open terminals (via existing profile resolution + CSS variable system)
- EFF-06: Resetting a setting at a scope deletes that key from the scope's override object

### 3.4 Error Handling

- ERR-01: When config.toml write fails (permissions, disk full) → show toast error, keep in-memory value, mark as "unsaved"
- ERR-02: When host/channel profile PATCH fails → rollback optimistic update, show toast error
- ERR-03: When config.toml is malformed on read → treat as empty (existing behavior in ConfigResolver.loadFromFile)
- ERR-04: When host/channel profile_json is malformed JSON → return {} with warning log (defensive parse)
- ERR-05: When host/channel is removed while its scope tab is active → auto-fall back to Global tab

## 4. Technical Design

### 4.1 Architecture

The settings panel unifies three existing config surfaces:
1. **AppearancePanel** (themes, opacity, scrollbar) → absorbed into Appearance category
2. **Config API** (TerminalProfile cascade) → exposed with override indicators
3. **UiConfig** (tabs, panes, search, startup, title) → exposed in Global-only categories

New hub endpoint `GET /api/config/cascade` returns all 4 layers in a single response, enabling the client to render override indicators without multiple round-trips.

### 4.2 Scope-Category Matrix

| Category | Global | Host | Channel | Config target |
|----------|--------|------|---------|---------------|
| Appearance | ✅ themes, opacity, scrollbar, autoSwitch | ✅ theme override | ✅ theme override | config.toml [appearance] + profile_json.theme |
| Terminal | ✅ font, cursor, scrollback, bell | ✅ same | ✅ same | config.toml [terminal] / profile_json |
| Tabs | ✅ closeButton, newTabPosition, confirms | — | — | config.toml [tabs] |
| Panes | ✅ maxPanes, defaultSplitDirection | — | — | config.toml [panes] |
| Search | ✅ position, highlightOnClose, historySize | — | — | config.toml [search] |
| Startup | ✅ autoOpenWelcome | — | — | config.toml [startup] |
| Keybindings | ✅ read-only list | — | — | — (MVP: display only) |

Categories not applicable to the selected scope are hidden from the left nav.

### 4.3 API Contract

#### New endpoints

| Endpoint | Method | Request | Response |
|----------|--------|---------|----------|
| `/api/config/cascade` | GET | `?host_id=&channel_id=` | `CascadeResponse` (see below) |
| `/api/config/global` | PUT | `{ terminal?: Partial<TerminalProfile> }` | `{ ok: true }` |
| `/api/config/ui` | PUT | `{ tabs?: Partial<TabsConfig>, panes?: ..., search?: ..., startup?: ..., title?: ... }` | `{ ok: true }` |
| `/api/hosts/:id/profile` | GET | — | `{ profile: Partial<TerminalProfile> }` |
| `/api/channels/:id/profile` | GET | — | `{ profile: Partial<TerminalProfile> }` |

#### CascadeResponse

```typescript
interface CascadeResponse {
	terminal: {
		defaults: TerminalProfile;          // Layer 1
		global: Partial<TerminalProfile>;   // Layer 2 (config.toml)
		host?: Partial<TerminalProfile>;    // Layer 3 (if host_id)
		channel?: Partial<TerminalProfile>; // Layer 4 (if channel_id)
		resolved: TerminalProfile;          // merged result (excludes Layer 3.5 agent hints — ephemeral, not user-editable)
	};
	ui: {
		defaults: UiConfig;
		global: Partial<UiConfig>;          // config.toml overrides
		resolved: UiConfig;
	};
	appearance: AppearanceConfig;           // from config.toml [appearance] (flat, not cascaded — D14)
}
```

**Note on Layer 3.5 (Agent Hints):** Agent visual hints (from HELLO message) are ephemeral and per-session. They are NOT exposed in the Settings Panel UI — they're applied transparently by ConfigResolver.resolve() at runtime. The Settings Panel shows layers 1-4 only.

#### PATCH Semantics

All profile PATCH endpoints use **merge-patch** semantics (existing deepMerge behavior):
- Partial payloads are merged into existing data (other keys preserved)
- Setting a key to `null` **removes** that override (reverts to parent inheritance)
- This is the mechanism for "reset to parent" — PATCH with `{ key: null }`

#### camelCase ↔ snake_case

config.toml uses snake_case (`font_family`), TypeScript uses camelCase (`fontFamily`).
- **Read path:** ConfigResolver.loadFromFile() already converts snake_case → camelCase
- **Write path:** PUT /api/config/global must convert camelCase → snake_case before TOML stringify
- Use the existing `toSnakeCase`/`toCamelCase` utilities in shared package

#### Theme Source Clarification (updated D14/D15)

Two distinct theme storage locations serve different purposes:
- `config.toml [appearance]` → global theme selection + autoSwitch + opacity/scrollbar (was appearance.json — absorbed by D14)
- `hosts.profile_json.theme` → per-host theme override (managed by cascade)
- No conflict: [appearance].theme is the "which theme globally", profile_json.theme is "which theme for this host"
- `auto_switch.enabled = true` → follows system `prefers-color-scheme` via `matchMedia` (uses `light_theme` / `dark_theme`); no manual day_start/night_start scheduling (D15)

#### Config.toml section-targeted write

`PUT /api/config/global` writes to config.toml using toml-edit-js:
1. Read raw file content (or empty string if file doesn't exist)
2. For each changed key, call `edit(tomlString, 'terminal.<key>', value)` — surgical, comment-preserving
3. Write atomically (write to temp file, rename)
4. Reload ConfigResolver cache

Same pattern for `PUT /api/config/ui` (writes `tabs.*`, `panes.*`, `search.*`, `startup.*`, `title.*` keys).
Same pattern for appearance settings (writes `appearance.*`, `appearance.auto_switch.*`, `appearance.opacity.*`, `appearance.scrollbar.*` keys).

**Comment-preserving write approach** (D13): Use `@rainbowatcher/toml-edit-js` for writes — `edit(tomlString, 'dotted.key', value)` performs surgical modification preserving all comments and formatting (303 KB WASM, wraps Rust `toml_edit` crate). Keep `@iarna/toml` for parsing (read path). If config.toml doesn't exist, create it.

**Input validation**: PUT /api/config/global must whitelist known TerminalProfile keys (fontFamily, fontSize, theme, cursorStyle, scrollback, bellSound, scrollbarMarkers). Reject unknown keys with 400 Bad Request. Same validation for PUT /api/config/ui with known UiConfig keys.

**Debounce**: Client-side debounce 500ms on all setting mutations before API call. Optimistic UI update is immediate; API call is batched.

### 4.4 Store Design

```typescript
// useSettingsStore
const cascade = ref<CascadeResponse | null>(null);
const activeScope = ref<'global' | 'host' | 'channel'>('global');
const dirty = ref(false);

// Cascade-aware getters
function getValue(scope: Scope, path: string): unknown;
function isOverridden(scope: Scope, path: string): boolean;
function inheritedFrom(scope: Scope, path: string): { value: unknown; source: string } | null;
function getResolved(path: string): unknown;

// Mutations
async function updateSetting(scope: Scope, path: string, value: unknown): Promise<void>;
async function resetSetting(scope: Scope, path: string): Promise<void>;
async function loadCascade(hostId?: string, channelId?: string): Promise<void>;
```

### 4.5 Settings Schema (data-driven categories)

Instead of per-category components with repetitive SettingRow lists, define a `settingsSchema` registry:

```typescript
interface SettingDefinition {
	key: string;              // dot-path e.g. "fontSize", "tabs.closeButton"
	label: string;
	description?: string;
	type: 'text' | 'number' | 'select' | 'toggle' | 'range' | 'color';
	category: string;         // "appearance" | "terminal" | "tabs" | etc.
	section?: string;         // config target: "terminal" | "ui" | "appearance"
	scopes: ('global' | 'host' | 'channel')[];
	options?: { label: string; value: string | number }[];
	min?: number; max?: number; step?: number;
}
```

A single `CategoryContent.vue` iterates the schema for the active category + scope. Category-specific components (AppearanceCategory for themes, KeybindingsCategory for keybindings) handle non-standard layouts.

### 4.6 Component Hierarchy

```
SettingsPanel.vue (overlay, Teleport to body)
├── ScopeTabBar.vue (Global | Host: name | Channel: name)
├── CategoryNav.vue (left nav, filtered by scope)
└── CategoryContent.vue (right content area)
    └── SettingRow.vue × N (per setting)
        ├── label + description
        ├── SettingControl.vue (input/select/toggle/range/color)
        ├── override indicator (blue left bar)
        ├── inherited text "(inherited: X from Y)"
        └── reset button "[reset to <parent>]"
```

### 4.7 SettingRow Visual States

| Scope | Has override? | Display |
|-------|---------------|---------|
| Global | N/A (always base) | Normal input, no indicator |
| Host | Yes | Blue left bar, editable, [reset to global] button |
| Host | No | Dimmed, "(inherited: X)" text, click to override |
| Channel | Yes | Blue left bar, editable, [reset to host] button |
| Channel | No | Dimmed, "(inherited: X from Host: name)" text |

## 5. Acceptance Criteria (BDD)

### Scenario Group: Panel Navigation

```gherkin
@priority:high @type:nominal
Scenario: SC-01 Open settings panel via gear icon
  Given the user is authenticated and on the main view
  When the user clicks the gear icon in the host rail footer
  Then the settings panel overlay appears on the right side
  And the Global scope tab is selected by default
  And the Appearance category is selected in the left nav

@priority:high @type:nominal
Scenario: SC-02 Scope tabs reflect current context
  Given the settings panel is open
  And host "prod-server" is selected in the sidebar
  And channel "btop" is focused
  Then three scope tabs are visible: "Global", "Host: prod-server", "Channel: btop"
  When the user deselects the host
  Then only "Global" tab remains visible

@priority:medium @type:nominal
Scenario: SC-03 Category nav filters by scope
  Given the settings panel is open on the Global tab
  Then all 7 categories are visible in the left nav
  When the user switches to the Host tab
  Then only Appearance and Terminal categories are visible
```

### Scenario Group: Override Indicators

```gherkin
@priority:high @type:nominal
Scenario: SC-04 Blue bar shows overridden setting at Host scope
  Given host "prod-server" has a fontSize override of 18
  And the global fontSize is 14
  When the user opens settings and selects the Host tab
  And navigates to the Terminal category
  Then the Font Size row shows a blue left bar
  And the value shows 18
  And a [reset to global] button is visible

@priority:high @type:nominal
Scenario: SC-05 Inherited value display
  Given host "prod-server" has no fontFamily override
  And the global fontFamily is "Consolas"
  When the user views Font Family on the Host tab
  Then the row shows "(inherited: Consolas)" in dimmed text
  And no blue left bar is shown
  And no reset button is shown

@priority:high @type:nominal
Scenario: SC-06 Channel inherits from host override
  Given host "prod-server" has fontSize 18
  And channel "btop" has no fontSize override
  When the user views Font Size on the Channel tab
  Then the row shows "(inherited: 18 — from Host: prod-server)"

@priority:medium @type:nominal
Scenario: SC-07 Click inherited row to set override
  Given host "prod-server" has no fontSize override (inherits 14)
  When the user clicks on the Font Size row on the Host tab
  And changes the value to 18
  Then a blue left bar appears
  And the value becomes 18
  And a [reset to global] button appears
  And the hub receives PATCH /api/hosts/:id/profile with { fontSize: 18 }
```

### Scenario Group: Reset Override

```gherkin
@priority:high @type:nominal
Scenario: SC-08 Reset host override to global
  Given host "prod-server" has fontSize 18
  When the user clicks [reset to global] on Font Size
  Then the override is removed
  And the row returns to inherited state showing "(inherited: 14)"
  And the hub receives PATCH /api/hosts/:id/profile with { fontSize: null }

@priority:medium @type:edge
Scenario: SC-09 Reset channel override reveals host override
  Given host "prod-server" has fontSize 18
  And channel "btop" has fontSize 20
  When the user resets fontSize on the Channel tab
  Then the row shows "(inherited: 18 — from Host: prod-server)"
  And not "(inherited: 14)" (the global value)
```

### Scenario Group: Global Config Write-Back

```gherkin
@priority:high @type:nominal
Scenario: SC-10 Edit global terminal setting writes config.toml
  Given the settings panel is on the Global tab
  When the user changes Font Size from 14 to 16
  Then the hub writes the terminal.font_size key in config.toml via toml-edit-js
  And all other sections, keys, comments, and formatting are preserved

@priority:high @type:nominal
Scenario: SC-11 Edit global UI setting writes config.toml
  Given the settings panel is on the Global tab, Tabs category
  When the user toggles "Close button" from true to false
  Then the hub writes the [tabs] section of config.toml
  And closeButton = false is persisted

@priority:medium @type:error
Scenario: SC-12 Config.toml write failure shows error
  Given config.toml is not writable (permissions)
  When the user changes a global setting
  Then a toast error appears: "Failed to save settings"
  And the in-memory value is kept (applied to terminals)
  And the setting row shows an "unsaved" indicator
```

### Scenario Group: Appearance Migration

```gherkin
@priority:high @type:nominal
Scenario: SC-13 Theme picker in Appearance category
  Given the settings panel is open on the Global tab
  And the Appearance category is selected
  Then the theme picker grid is displayed (same as old AppearancePanel)
  And auto-switch toggle is shown (follows system prefers-color-scheme when enabled — D15)
  And opacity sliders (terminal, sidebar, hostRail, tabBar) are shown
  And scrollbar style selector is shown
  And all appearance settings read from config.toml [appearance] (not appearance.json — D14)

@priority:medium @type:nominal
Scenario: SC-14 Per-host theme override
  Given host "prod-server" is selected
  When the user opens settings and selects the Host tab, Appearance category
  Then theme selection is shown with override indicators
  And opacity/scrollbar settings are NOT shown (global only)
  When the user selects "Dracula" theme
  Then a blue left bar appears on the theme row
  And PATCH /api/hosts/:id/profile is called with { theme: "dracula" }
```

### Scenario Group: Security

```gherkin
@priority:high @type:security
Scenario: SC-15 Unauthenticated user cannot access settings API
  Given the user has no valid auth token
  When a PUT /api/config/global request is made
  Then the response is 401 Unauthorized

@priority:medium @type:security
Scenario: SC-16 Settings panel not rendered before auth
  Given the app is on the pairing screen
  Then the gear icon is not visible
  And the settings panel cannot be opened
```

### Scenario Group: Edge Cases

```gherkin
@priority:medium @type:edge
Scenario: SC-17 Host deleted while Host tab active
  Given the settings panel is open on the Host tab for "prod-server"
  When "prod-server" is deleted (by another session or via API)
  Then the panel falls back to the Global tab automatically
  And a toast notification appears

@priority:medium @type:edge
Scenario: SC-18 Config.toml does not exist on first save
  Given no config.toml file exists in the XDG config dir
  When the user changes a global terminal setting
  Then config.toml is created with the [terminal] section
  And the change is persisted

@priority:medium @type:edge
Scenario: SC-19 Rapid setting changes are debounced
  Given the user is editing Font Size on the Global tab
  When the user types "1", "6" rapidly (within 500ms)
  Then only one PUT /api/config/global request is made (with fontSize: 16)
  And the visual feedback is immediate (no lag)

@priority:medium @type:security
Scenario: SC-20 Unknown keys rejected by PUT /api/config/global
  Given a PUT request with { terminal: { fontSize: 16, __proto__: {} } }
  When the request reaches the hub
  Then the response is 400 Bad Request
  And only whitelisted TerminalProfile keys are accepted
```

### Coverage Matrix

| Scenario | Nominal | Edge | Error | Security |
|----------|---------|------|-------|----------|
| SC-01 | ✓ | | | |
| SC-02 | ✓ | | | |
| SC-03 | ✓ | | | |
| SC-04 | ✓ | | | |
| SC-05 | ✓ | | | |
| SC-06 | ✓ | | | |
| SC-07 | ✓ | | | |
| SC-08 | ✓ | | | |
| SC-09 | | ✓ | | |
| SC-10 | ✓ | | | |
| SC-11 | ✓ | | | |
| SC-12 | | | ✓ | |
| SC-13 | ✓ | | | |
| SC-14 | ✓ | | | |
| SC-15 | | | | ✓ |
| SC-16 | | | | ✓ |
| SC-17 | | ✓ | | |
| SC-18 | | ✓ | | |
| SC-19 | | ✓ | | |
| SC-20 | | | | ✓ |

## 6. Implementation Plan

### Block 1: Hub API — Cascade endpoint + config write-back (~20 min)

**Type:** Feature slice (hub + shared)
**Dependencies:** None
**Packages:** hub, shared

**Files:**
- `packages/hub/src/api/config.ts` — add GET /api/config/cascade, PUT /api/config/global, PUT /api/config/ui, PUT /api/config/appearance, GET /api/hosts/:id/profile, GET /api/channels/:id/profile
- `packages/hub/src/config.ts` — add ConfigResolver.getGlobalOverrides(), saveKey() using toml-edit-js
- `packages/shared/src/config.ts` — add CascadeResponse type, AppearanceConfig type, section write types

**Exit criteria:**
- [ ] GET /api/config/cascade returns all 4 layers + resolved (including appearance from config.toml [appearance])
- [ ] PUT /api/config/global writes terminal.* keys to config.toml via toml-edit-js (comment-preserving)
- [ ] PUT /api/config/ui writes tabs/panes/search/startup/title keys to config.toml
- [ ] PUT /api/config/appearance writes appearance.* keys to config.toml (replaces old appearance.json API — D14)
- [ ] GET /api/hosts/:id/profile returns raw profile_json
- [ ] GET /api/channels/:id/profile returns raw profile_json
- [ ] All new endpoints require auth (except cascade with no params)
- [ ] Tests: 10+ (cascade response shape, write-back, comment preservation, appearance config, auth)

**Acceptance criteria covered:** SC-10, SC-11, SC-12, SC-15

---

### Block 2: Settings store + panel shell + SettingRow (~20 min)

**Type:** Feature slice (web)
**Dependencies:** Block 1
**Packages:** web

**Files:**
- `packages/clients/web/src/stores/settings.ts` — new useSettingsStore
- `packages/clients/web/src/components/settings/SettingsPanel.vue` — overlay layout
- `packages/clients/web/src/components/settings/ScopeTabBar.vue` — scope tabs
- `packages/clients/web/src/components/settings/CategoryNav.vue` — left nav
- `packages/clients/web/src/components/settings/SettingRow.vue` — row with overrides
- `packages/clients/web/src/components/settings/SettingControl.vue` — generic control

**Exit criteria:**
- [ ] useSettingsStore loads cascade, exposes getValue/isOverridden/inheritedFrom/resetSetting
- [ ] Panel opens via gear icon, closes via X or Escape
- [ ] Scope tabs show/hide based on host/channel context
- [ ] Category nav filters categories by scope
- [ ] SettingRow renders blue bar, inherited text, reset button based on cascade state
- [ ] SettingControl handles: text, number, select, toggle, range, color
- [ ] Tests: settings store (cascade logic, override detection, reset)

**Acceptance criteria covered:** SC-01, SC-02, SC-03, SC-04, SC-05, SC-06, SC-07, SC-08, SC-09

---

### Block 3: Appearance category (absorb AppearancePanel) (~15 min)

**Type:** Feature slice + refactor (web)
**Dependencies:** Block 2
**Packages:** web

**Files:**
- `packages/clients/web/src/components/settings/categories/AppearanceCategory.vue` — new
- `packages/clients/web/src/components/settings/AppearancePanel.vue` — delete (absorbed)
- `packages/clients/web/src/App.vue` — remove AppearancePanel, wire SettingsPanel

**Exit criteria:**
- [ ] Theme picker/editor rendered inside Appearance category (reuse ThemePicker, ThemeEditor, ThemeCard)
- [ ] Auto-switch toggle shown in Global scope: enabled → follows system `prefers-color-scheme` via `matchMedia('(prefers-color-scheme: dark)')`, uses `light_theme`/`dark_theme` fields; disabled → static theme from `[appearance].theme` (D15)
- [ ] No day_start/night_start fields — OS handles dark mode scheduling (D15)
- [ ] Opacity sliders, scrollbar style shown in Global scope
- [ ] Host/Channel scope: only theme selection (with override indicators)
- [ ] Reads from config cascade (config.toml [appearance]) instead of appearance.json (D14)
- [ ] Old AppearancePanel deleted, gear icon opens SettingsPanel
- [ ] Existing theme/appearance functionality preserved (no regressions)

**Acceptance criteria covered:** SC-13, SC-14

---

### Block 4: Settings schema + remaining categories (~20 min)

**Type:** Feature slice (web)
**Dependencies:** Block 2
**Packages:** web

**Files:**
- `packages/clients/web/src/components/settings/settingsSchema.ts` — schema registry
- `packages/clients/web/src/components/settings/categories/SchemaCategory.vue` — generic data-driven category renderer

**Exit criteria:**
- [ ] settingsSchema defines all settings: Terminal (fontFamily, fontSize, cursorStyle, scrollback, bellSound + title settings), Tabs, Panes, Search, Startup
- [ ] SchemaCategory renders SettingRow for each schema entry matching current category + scope
- [ ] Terminal cascaded fields (font, cursor, scrollback, bell) available at all scopes
- [ ] Terminal global-only fields (title settings) hidden on Host/Channel tabs
- [ ] UiConfig categories (Tabs, Panes, Search, Startup) only visible on Global tab
- [ ] Changes persist via appropriate API (PUT /api/config/global or /ui, PATCH host/channel profile)
- [ ] Debounce 500ms on all mutations

**Acceptance criteria covered:** SC-10, SC-11

---

### Block 5: Keybindings + integration + cleanup (~15 min)

**Type:** Feature slice + cleanup (web)
**Dependencies:** Blocks 3, 4
**Packages:** web

**Files:**
- `packages/clients/web/src/components/settings/categories/KeybindingsCategory.vue` — grouped list, read-only
- `packages/clients/web/src/App.vue` — final wiring (remove old AppearancePanel refs)
- `packages/clients/web/src/components/HostRail.vue` — update gear icon to emit toggle-settings

**Exit criteria:**
- [ ] Keybindings: grouped read-only list of all keyboard shortcuts by category
- [ ] Scope tabs wired to hostsStore.activeHostId + channelsStore.activeChannelId
- [ ] Old AppearancePanel component and its imports fully removed
- [ ] showAppearance ref replaced with showSettings ref
- [ ] SC-16: gear icon hidden on pairing screen (same guard as before)
- [ ] All 1078+ existing tests still pass
- [ ] Lint + typecheck clean

**Acceptance criteria covered:** SC-16

## 7. Test Strategy

### Test Pyramid

| Level | Count | Focus |
|-------|-------|-------|
| Unit | ~20 | Settings store cascade logic, ConfigResolver write-back, section-targeted TOML |
| Integration | ~8 | API endpoints (cascade, write, auth), config.toml round-trip |
| E2E | ~6 | Panel open/close, scope switching, override indicators, reset |

### Test Data

- **Fixtures:** config.toml with comments + multiple sections, host with profile_json overrides, channel with profile_json
- **Mocks:** @iarna/toml (parse), @rainbowatcher/toml-edit-js (edit writes) in tests, fetch (for store tests)
- **In-memory DB:** better-sqlite3 `:memory:` for integration tests (existing pattern)

### Key Test Scenarios

| Scenario | Unit | Integration | E2E |
|----------|------|-------------|-----|
| SC-01 Panel open | | | ✓ |
| SC-04 Override indicator | ✓ (store) | | ✓ |
| SC-08 Reset override | ✓ (store) | ✓ (API) | ✓ |
| SC-10 Config write-back | ✓ (resolver) | ✓ (API) | |
| SC-12 Write failure | ✓ (resolver) | ✓ (API) | |
| SC-15 Auth required | | ✓ (API) | |

## 8. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| config.toml write loses user comments within modified section | M | L | Mitigated by D13: toml-edit-js preserves all comments and formatting (surgical key-level edits). |
| Appearance migration breaks existing theme functionality | H | L | Reuse existing ThemePicker/ThemeEditor/ThemeCard components as-is. Only change parent container. |
| SettingRow complexity (many visual states) | M | M | Start with simple states (overridden/inherited), add edge cases incrementally. |
| Config.toml file locking on concurrent writes | L | L | Single hub per user per device. Use atomic write (temp + rename). |

## 9. Out of Scope (deferred → TODO.md)

- Search/filter within settings panel (P2)
- Settings sync across devices (P2)
- Settings export/import as JSON (P2)
- Keybindings editor with conflict detection (P2)
- HostRailSettings absorption (show labels/dots) — keep as-is, lightweight

## 10. Definition of Done

- [ ] All 5 blocks implemented
- [ ] All 16 BDD scenarios have passing tests
- [ ] All tests pass (unit + integration + e2e)
- [ ] Lint + typecheck pass
- [ ] Old AppearancePanel fully removed
- [ ] config.toml write-back preserves all comments and formatting (toml-edit-js — D13)
- [ ] appearance.json eliminated — all appearance config in config.toml [appearance] (D14)
- [ ] Code review clean (no blocking findings)
