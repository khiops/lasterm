---
doc-meta:
  status: canonical
  scope: ui
  type: specification
  target_project: /mnt/wsl/shared/dev/lasterm
  created: 2026-03-07
  updated: 2026-03-07
  complexity: COMPLEX
  time-budget: 6h
---

# Specification: UX-06 Theming & Color Schemes

## 0. Quick Reference (ALWAYS VISIBLE)

| Item | Value |
|------|-------|
| Scope | ui |
| Complexity | COMPLEX |
| Time budget | 6h |
| Blocks | 7 |
| BDD scenarios | 17 |
| Risk level | MEDIUM |

## 1. Problem Statement

All UI colors are hardcoded across 14 Vue components and the xterm.js terminal
theme. Users cannot change the color scheme, there is no dark/light switching,
and per-host theming (UX-07 dependency) is impossible. This blocks all visual
customization stories.

## 2. User Stories

### US-1: Theme Selection

AS A terminal user
I WANT to choose from bundled color schemes and see the change instantly
SO THAT I can work in a visually comfortable environment

ACCEPTANCE: Selecting a theme applies it to all terminals + UI chrome within
one frame, persists across restarts.

### US-2: Custom Theme Creation

AS A power user
I WANT to create, edit, import, and export custom themes with live preview
SO THAT I can personalize my terminal exactly how I like it

ACCEPTANCE: Color pickers modify theme in real-time, saved themes appear in
the picker, exported JSON re-imports cleanly.

### US-3: Automatic & Ambient Preferences

AS A user who switches between dark/light environments
I WANT the app to auto-switch themes based on OS mode and let me adjust
opacity and scrollbar appearance
SO THAT the experience adapts to my environment without manual toggling

ACCEPTANCE: OS dark/light toggle changes theme reactively; opacity and
scrollbar settings apply immediately.

## 3. Business Rules

### 3.1 Invariants (always true)

- INV-01: A valid theme must contain all 16 ANSI colors + fg/bg/cursor/selectionBackground + all `ui` chrome fields.
- INV-02: Theme color values must be valid CSS hex strings (`#RRGGBB` or `#RRGGBBAA`).
- INV-03: Exactly one theme is active per scope level at any time. The resolved theme name comes from the config cascade (global < host < channel).
- INV-04: All UI chrome colors must come from CSS custom properties (`--nt-*`). No hardcoded color literals in component styles.
- INV-05: xterm.js `terminal.options.theme` must stay in sync with the active theme's `colors` section.
- INV-06: Theme switch must be instant (CSS variable swap + xterm option update, no page reload, no flash).
- INV-07: Theme file names must be alphanumeric + hyphens only (`/^[a-z0-9-]+$/`). Validated on save/import.
- INV-08: Live preview hover must debounce xterm.js theme updates via `requestAnimationFrame` to avoid jank with multiple terminals.
- INV-09: Bundled theme init uses "copy if missing" strategy — existing files (even modified) are preserved. New bundled themes added on upgrade are copied.

### 3.2 Preconditions (required before action)

- PRE-01: Hub must copy bundled themes to `~/.config/lasterm/themes/` on first launch if the directory is empty or missing.
- PRE-02: Theme files must be valid JSON conforming to `LastermTheme` schema to appear in listings.
- PRE-03: Web client must load available themes from hub before rendering the theme picker.

### 3.3 Effects (what changes)

- EFF-01: Applying a theme updates `:root` CSS variables AND calls `terminal.options.theme = ...` on every mounted xterm.js instance.
- EFF-02: Saving a custom theme writes a JSON file to `~/.config/lasterm/themes/` and the theme appears in listings immediately.
- EFF-03: Deleting a custom theme removes the file. If it was active, the app falls back to the default theme (`catppuccin-mocha`).
- EFF-04: Auto-switch reactively changes the active theme when OS `prefers-color-scheme` changes.
- EFF-05: Opacity and scrollbar settings apply immediately via CSS (no terminal restart).

### 3.4 Error Handling

- ERR-01: Invalid theme JSON on import -> reject with validation error listing missing/invalid fields, keep current theme unchanged.
- ERR-02: Active theme file missing on startup -> fall back to default theme, log warning.
- ERR-03: Corrupt JSON in themes directory -> skip in listing, log warning, do not crash.
- ERR-04: DELETE on bundled theme -> 409 Conflict with `{ code: "BUNDLED_THEME", message: "Cannot delete bundled theme" }`.
- ERR-05: POST with duplicate name -> 409 Conflict with `{ code: "THEME_EXISTS", message: "Theme already exists" }`.
- ERR-06: Theme name with invalid chars (spaces, special chars) -> 400 with `{ code: "INVALID_NAME", message: "Name must match /^[a-z0-9-]+$/" }`.
- ERR-07: Theme color value not valid hex -> 400 with validation error listing invalid fields.

## 4. Technical Design

### 4.1 Architecture Decision

**CSS variables as the single source of truth for all chrome colors.** Theme switch = update ~30 CSS custom properties on `:root` + update xterm.js `ITheme` on all terminal instances. No class toggling, no stylesheet swapping, no FOUC.

**Theme files on disk (not in DB).** Themes are JSON files in the config directory — portable, user-editable, git-friendly. Hub serves them via REST. The `theme` field in `TerminalProfile` (already in config cascade) selects which theme to load.

**Appearance config is global-only.** Auto-switch, opacity, scrollbar settings live in `config.toml [appearance]` section, not in the per-host/per-channel cascade. The theme NAME is per-host/per-channel (via existing TerminalProfile.theme), but visual chrome settings are app-wide.

### 4.2 Data Model Changes

| Entity | Change | Migration needed |
|--------|--------|------------------|
| `LastermTheme` (new interface, shared) | Theme file schema: name, author, type, colors, ui | No (new type) |
| `AppearanceConfig` (new interface, shared) | Auto-switch, opacity, scrollbar settings | No (new type) |
| `config.toml` | New `[appearance]` section | No (config file, not DB) |
| No DB schema changes | Themes are files, not rows | No |

### 4.3 API Contract

| Endpoint | Method | Auth | Request | Response |
|----------|--------|------|---------|----------|
| `/api/themes` | GET | Yes | - | `LastermTheme[]` |
| `/api/themes/:name` | GET | Yes | - | `LastermTheme` |
| `/api/themes` | POST | Yes | `LastermTheme` body | `201 { name }` |
| `/api/themes/:name` | PUT | Yes | `LastermTheme` body | `200 { name }` |
| `/api/themes/:name` | DELETE | Yes | - | `204` |
| `/api/config/appearance` | GET | Yes | - | `AppearanceConfig` |
| `/api/config/appearance` | PATCH | Yes | Partial `AppearanceConfig` | `200 AppearanceConfig` |

### 4.4 LastermTheme Interface

```typescript
interface LastermThemeColors {
  foreground: string
  background: string
  cursor: string
  cursorAccent?: string
  selectionBackground: string
  selectionForeground?: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

interface LastermThemeUi {
  tabBar: string
  tabActive: string
  tabInactive: string
  tabHover: string
  sidebar: string
  sidebarText: string
  sidebarActive: string
  hostRail: string
  border: string
  accent: string
  badge: string
  scrollbarThumb: string
  scrollbarTrack: string
  searchHighlight: string
  searchHighlightActive: string
}

interface LastermTheme {
  name: string
  author?: string
  type: 'dark' | 'light'
  colors: LastermThemeColors
  ui: LastermThemeUi
}
```

### 4.5 AppearanceConfig Interface

```typescript
interface AppearanceConfig {
  theme: string                      // active global theme name
  autoSwitch: {
    enabled: boolean
    darkTheme: string
    lightTheme: string
  }
  opacity: {
    terminal: number                 // 0-100
    sidebar: number
    hostRail: number
    tabBar: number
  }
  scrollbar: {
    style: 'thin' | 'wide' | 'hidden'
    thumbColor: string               // empty = from theme
    trackColor: string               // empty = from theme
    widthThin: number                // px
    widthWide: number                // px
  }
}
```

### 4.6 CSS Variable Map

```
--nt-fg, --nt-bg, --nt-cursor, --nt-cursor-accent, --nt-selection-bg,
--nt-selection-fg,
--nt-black, --nt-red, --nt-green, --nt-yellow, --nt-blue, --nt-magenta,
--nt-cyan, --nt-white,
--nt-bright-black, --nt-bright-red, --nt-bright-green, --nt-bright-yellow,
--nt-bright-blue, --nt-bright-magenta, --nt-bright-cyan, --nt-bright-white,
--nt-tab-bar, --nt-tab-active, --nt-tab-inactive, --nt-tab-hover,
--nt-sidebar, --nt-sidebar-text, --nt-sidebar-active,
--nt-host-rail, --nt-border, --nt-accent, --nt-badge,
--nt-scrollbar-thumb, --nt-scrollbar-track,
--nt-search-highlight, --nt-search-highlight-active
```

### 4.7 Bundled Theme Names

Dark (6): `one-half-dark`, `catppuccin-mocha`, `dracula`, `nord`,
`tokyo-night`, `gruvbox-dark`

Light (3): `one-half-light`, `solarized-light`, `github-light`

Default: `catppuccin-mocha`

## 5. Acceptance Criteria (BDD)

### Scenario Group: Theme Selection (US-1)

```gherkin
@priority:high @type:nominal
Scenario: SC-01 — Switch theme via picker
  Given the app is running with "catppuccin-mocha" as active theme
  When the user selects "dracula" from the theme picker
  Then all CSS variables update to Dracula colors
  And all xterm.js terminals update their ITheme
  And the config is persisted (GET /api/config/appearance returns theme: "dracula")

@priority:high @type:nominal
Scenario: SC-02 — Theme applies to all terminals instantly
  Given 3 terminal panes are open in a split layout
  When the active theme changes from "nord" to "gruvbox-dark"
  Then all 3 terminals reflect Gruvbox Dark colors within one frame
  And the UI chrome (tab bar, sidebar, host rail) also updates

@priority:medium @type:nominal
Scenario: SC-03 — Per-host theme override via config cascade
  Given global theme is "catppuccin-mocha"
  And host "prod-server" has profile_json with theme: "dracula"
  When a channel on "prod-server" is opened
  Then that terminal uses Dracula theme colors
  And terminals on other hosts still use Catppuccin Mocha

@priority:medium @type:error
Scenario: SC-04 — Missing theme file falls back to default
  Given the active theme name in config points to "deleted-theme"
  And no file "deleted-theme.json" exists in themes directory
  When the app starts
  Then the default theme "catppuccin-mocha" is applied
  And a warning is logged

@priority:medium @type:edge
Scenario: SC-05 — Theme persists across restart
  Given the user switches to "tokyo-night"
  When the hub restarts and the web client reconnects
  Then "tokyo-night" is still the active theme
```

### Scenario Group: Custom Theme Creation (US-2)

```gherkin
@priority:high @type:nominal
Scenario: SC-06 — Create custom theme based on preset
  Given the user opens the theme editor with "Based on: Dracula"
  When they modify the background color to "#1a1a2e"
  And click "Save as My Theme"
  Then POST /api/themes is called with the modified theme
  And the theme appears in the picker under "Custom" section

@priority:high @type:nominal
Scenario: SC-07 — Edit and save existing custom theme
  Given "My Theme" exists as a custom theme
  When the user opens it in the editor, changes accent to "#ff6b6b"
  And clicks Save
  Then PUT /api/themes/my-theme updates the file
  And the change is reflected immediately in the UI

@priority:medium @type:nominal
Scenario: SC-08 — Import external theme file
  Given the user has a valid theme JSON file on disk
  When they click "Import theme file" and select the file
  Then the theme is validated against LastermTheme schema
  And POST /api/themes stores it in the themes directory
  And the theme appears in the picker

@priority:low @type:nominal
Scenario: SC-09 — Export theme as JSON
  Given "My Theme" is the active theme
  When the user clicks "Export JSON" in the editor
  Then a JSON file named "my-theme.json" is downloaded
  And the file content matches the LastermTheme schema

@priority:high @type:error
Scenario: SC-10 — Invalid theme JSON rejected on import
  Given the user imports a JSON file missing the "ui" section
  When validation runs
  Then the import is rejected with a message listing missing fields
  And the current theme remains unchanged
  And no file is written to the themes directory

@priority:medium @type:nominal
Scenario: SC-11 — Delete custom theme
  Given "My Theme" is a custom (non-bundled) theme and is NOT active
  When the user deletes it
  Then DELETE /api/themes/my-theme removes the file
  And the theme disappears from the picker

@priority:medium @type:edge
Scenario: SC-12 — Cannot delete bundled theme
  Given "dracula" is a bundled theme
  When DELETE /api/themes/dracula is called
  Then the API returns 409 with code "BUNDLED_THEME"
  And the theme file is NOT removed
```

### Scenario Group: Auto-Switch & Ambient Preferences (US-3)

```gherkin
@priority:high @type:nominal
Scenario: SC-13 — Auto-switch follows OS dark mode toggle
  Given auto-switch is enabled with dark="catppuccin-mocha" light="github-light"
  And OS is currently in dark mode
  When the user toggles OS to light mode
  Then the app switches to "github-light" within 100ms
  And all terminals + UI chrome update

@priority:medium @type:edge
Scenario: SC-14 — Manual theme change overrides auto-switch
  Given auto-switch is enabled (dark=catppuccin, light=github-light)
  And OS is in dark mode (catppuccin active)
  When the user manually selects "nord" from the picker
  Then auto-switch is disabled
  And "nord" becomes the active theme
  And the auto-switch toggle in settings shows unchecked

@priority:high @type:nominal
Scenario: SC-15 — Opacity slider affects terminal background
  Given the active theme has background "#1e1e2e"
  When the user sets terminal opacity to 85%
  Then the terminal background renders as rgba(30, 30, 46, 0.85)
  And the sidebar/host-rail/tab-bar retain their own opacity values

@priority:medium @type:nominal
Scenario: SC-16 — Scrollbar style switch
  Given the scrollbar style is "thin" (6px)
  When the user switches to "wide" (14px)
  Then the terminal scrollbar width changes to 14px
  And the thumb/track colors match the active theme

@priority:low @type:edge
Scenario: SC-17 — Auto-switch disabled by default
  Given a fresh installation
  When the user opens appearance settings
  Then auto-switch toggle is off
  And dark/light theme dropdowns are disabled
```

### Coverage Matrix

| Scenario | Nominal | Edge | Error | Security |
|----------|---------|------|-------|----------|
| SC-01 | x | | | |
| SC-02 | x | | | |
| SC-03 | x | | | |
| SC-04 | | | x | |
| SC-05 | | x | | |
| SC-06 | x | | | |
| SC-07 | x | | | |
| SC-08 | x | | | |
| SC-09 | x | | | |
| SC-10 | | | x | |
| SC-11 | x | | | |
| SC-12 | | x | | |
| SC-13 | x | | | |
| SC-14 | | x | | |
| SC-15 | x | | | |
| SC-16 | x | | | |
| SC-17 | | x | | |

## 6. Implementation Plan

### Block 1: Theme Model + Bundled Presets — 30min

**Type:** Feature slice (shared package)
**Dependencies:** None
**Packages:** shared

**Files:**
- `packages/shared/src/theme.ts` — `LastermTheme`, `LastermThemeColors`, `LastermThemeUi` interfaces, `validateTheme()` function, `BUNDLED_THEME_NAMES` set
- `packages/shared/src/themes/` — directory with 9 bundled theme JSON files (imported as const objects)
- `packages/shared/src/themes/index.ts` — re-exports all bundled themes as `Record<string, LastermTheme>`
- `packages/shared/src/appearance.ts` — `AppearanceConfig` interface, `DEFAULT_APPEARANCE` const
- `packages/shared/src/index.ts` — re-export new types

**Exit criteria:**
- [ ] `LastermTheme` interface exported from shared
- [ ] `validateTheme()` returns `{ valid: boolean, errors: string[] }`
- [ ] All 9 bundled themes pass validation
- [ ] `AppearanceConfig` interface + defaults exported
- [ ] Unit tests: validation accepts valid themes, rejects partial/corrupt ones

### Block 2: Theme File Storage + REST API — 45min

**Type:** Feature slice (hub package)
**Dependencies:** Block 1
**Packages:** hub

**Files:**
- `packages/hub/src/theme-manager.ts` — `ThemeManager` class: `init()` (copy bundled if missing), `list()`, `get(name)`, `save(theme)`, `delete(name)`, `isBundled(name)`
- `packages/hub/src/api/themes.ts` — Fastify route plugin: GET/POST/PUT/DELETE /api/themes
- `packages/hub/src/api/config.ts` — extend with GET/PATCH /api/config/appearance
- `packages/hub/src/server.ts` — register themes routes, init ThemeManager on startup

**Exit criteria:**
- [ ] `ThemeManager.init()` copies bundled themes to config dir on first run
- [ ] `GET /api/themes` returns all valid themes from disk
- [ ] `POST /api/themes` validates + writes new theme file
- [ ] `PUT /api/themes/:name` updates existing theme file
- [ ] `DELETE /api/themes/:name` removes custom themes, rejects bundled (409)
- [ ] `GET /api/config/appearance` returns current AppearanceConfig
- [ ] `PATCH /api/config/appearance` deep-merges and persists to config.toml
- [ ] Integration tests: CRUD operations, bundled protection, invalid JSON rejection

### Block 3: CSS Variable System + Theme Store — 60min

**Type:** Feature slice (web package)
**Dependencies:** Block 2
**Packages:** web

**Files:**
- `packages/clients/web/src/styles/base.css` — new global CSS file with `--nt-*` variable declarations and component resets using vars
- `packages/clients/web/src/stores/theme.ts` — `useThemeStore` Pinia store: `loadThemes()`, `applyTheme()`, `previewHover()`, `clearPreview()`, `currentTheme`, `availableThemes`, `previewTheme`
- `packages/clients/web/src/main.ts` — import base.css
- All 14 `.vue` component `<style>` blocks — replace hardcoded hex colors with `var(--nt-*)` references

**Key implementation details:**
- `applyTheme(theme)`: iterate theme.colors + theme.ui, set `document.documentElement.style.setProperty('--nt-*', value)` for each
- `previewHover(theme)`: same as applyTheme but save previous state; `clearPreview()`: restore
- `base.css` defines defaults (from catppuccin-mocha) so the app renders before JS loads
- Component color migration: replace every hardcoded `#hex` in `<style>` with corresponding `var(--nt-*)` token

**Exit criteria:**
- [ ] All 14 components use only `var(--nt-*)` for colors (no hardcoded hex in `<style>`)
- [ ] `useThemeStore.applyTheme()` sets all CSS variables on `:root`
- [ ] Theme switch has no visible flash or layout shift
- [ ] Preview hover/clear works without race conditions
- [ ] Unit tests: applyTheme sets correct CSS vars, clearPreview restores

### Block 4: xterm.js Theme Integration — 30min

**Type:** Feature slice (web package)
**Dependencies:** Block 3
**Packages:** web

**Files:**
- `packages/clients/web/src/composables/useTerminal.ts` — remove hardcoded theme, add `applyTheme(theme: LastermThemeColors)`, watch theme store changes
- `packages/clients/web/src/stores/theme.ts` — emit event / expose reactive ref for terminal consumers

**Key implementation details:**
- `useTerminal.init()`: get theme from `useThemeStore().currentTheme.colors` instead of hardcoded object
- `useTerminal.applyTheme(colors)`: map `LastermThemeColors` to xterm.js `ITheme`, set `terminal.options.theme`
- Watch `useThemeStore().currentTheme` — on change, call `applyTheme()` on all mounted terminals
- Per-host override: if `TerminalProfile.theme` differs from global, resolve that theme from store and apply to that terminal only

**Exit criteria:**
- [ ] No hardcoded theme object in useTerminal.ts
- [ ] Theme change propagates to all mounted xterm.js instances
- [ ] Per-host theme override works (host profile_json.theme != global theme)
- [ ] Unit tests: applyTheme maps colors correctly, watcher triggers on theme change

### Block 5: Theme Picker + Live Preview — 60min

**Type:** Feature slice (web package)
**Dependencies:** Block 4
**Packages:** web

**Files:**
- `packages/clients/web/src/components/settings/ThemePicker.vue` — grid of theme cards, search, dark/light sections, custom section
- `packages/clients/web/src/components/settings/ThemeCard.vue` — mini card with 8 ANSI color swatches, active indicator, mouseenter preview
- `packages/clients/web/src/components/settings/AppearancePanel.vue` — container wrapping ThemePicker + opacity/scrollbar (mounted by settings flow)

**Key implementation details:**
- ThemeCard: shows theme name + 8 ANSI swatches (black..white as colored squares)
- `@mouseenter` -> `themeStore.previewHover(theme)`, `@mouseleave` -> `themeStore.clearPreview()`
- `@click` -> `themeStore.applyTheme(theme)` + PATCH /api/config/appearance
- Search: client-side filter on theme name
- Active indicator: checkmark on current theme card
- Sections: Dark, Light, Custom (user-created themes)

**Exit criteria:**
- [ ] Theme picker renders all available themes in categorized sections
- [ ] Search filters themes by name
- [ ] Hovering a card previews the theme (UI + terminals change)
- [ ] Clicking a card applies and persists the theme
- [ ] Active theme has visual indicator

### Block 6: Theme Editor + Import/Export — 75min

**Type:** Feature slice (web package)
**Dependencies:** Block 5
**Packages:** web

**Files:**
- `packages/clients/web/src/components/settings/ThemeEditor.vue` — color swatch grid, hex inputs, color pickers, live preview terminal, base-on selector, save/export/cancel actions
- `packages/clients/web/src/composables/useColorPicker.ts` — wrapper around native `<input type="color">` with hex validation

**Key implementation details:**
- "Based on" dropdown: select a preset, copy its values as starting point
- Color swatches: clickable grid, each opens a color picker popover
- Live preview: embed a small xterm.js instance rendering sample `ls -la` output with current editor colors
- Save: if new -> POST /api/themes, if editing -> PUT /api/themes/:name
- Export: `URL.createObjectURL(new Blob([JSON.stringify(theme)]))` -> download link
- Import: `<input type="file" accept=".json">` -> read + validate + POST /api/themes
- Cancel: discard changes, close editor

**Exit criteria:**
- [ ] Color pickers update theme in real-time
- [ ] Live preview terminal reflects edits immediately
- [ ] "Based on" loads a preset as template
- [ ] Save persists to hub (POST or PUT as appropriate)
- [ ] Export downloads valid JSON
- [ ] Import validates schema before saving
- [ ] Cancel discards without persisting

### Block 7: OS Auto-Switch + Opacity + Scrollbar — 45min

**Type:** Feature slice (web + hub)
**Dependencies:** Block 3
**Packages:** web, hub

**Files:**
- `packages/clients/web/src/composables/useAutoSwitch.ts` — `matchMedia('(prefers-color-scheme: dark)')` listener, reactive integration with theme store
- `packages/clients/web/src/components/settings/AppearancePanel.vue` — extend with auto-switch toggle, dark/light dropdowns, opacity sliders, scrollbar settings
- `packages/clients/web/src/stores/theme.ts` — add opacity + scrollbar state, applyOpacity(), applyScrollbar()
- `packages/hub/src/config-resolver.ts` — parse `[appearance]` section from config.toml

**Key implementation details:**
- Auto-switch: `window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', handler)`
- When enabled, OS mode change -> `themeStore.applyTheme(darkTheme | lightTheme)`
- Manual theme pick while auto-switch on -> disable auto-switch (SC-14)
- Opacity: parse theme hex to RGB, apply as `rgba(r, g, b, opacity/100)` on surface elements via CSS vars `--nt-bg-alpha`, `--nt-sidebar-alpha`, etc.
- Scrollbar: CSS `::webkit-scrollbar` rules + xterm.js scrollbar width option
- All settings persisted via PATCH /api/config/appearance

**Exit criteria:**
- [ ] OS dark/light toggle changes theme reactively
- [ ] Manual theme selection disables auto-switch
- [ ] Opacity sliders affect individual surfaces immediately
- [ ] Scrollbar style (thin/wide/hidden) applies to terminals
- [ ] Settings persist across restart via config.toml
- [ ] Unit tests: media query mock, opacity calculation, scrollbar CSS

## 7. Test Strategy

### Test Pyramid

| Level | Count | Focus |
|-------|-------|-------|
| Unit | ~35 | Theme validation, CSS var mapping, color parsing, store logic |
| Integration | ~15 | Theme CRUD API, config persistence, cascade resolution |
| E2E | ~5 | Theme switch flow, editor save, auto-switch toggle |

### Test Data Requirements

**Fixtures:**
- Valid theme JSON (dark + light)
- Invalid theme JSON (missing colors, missing ui, bad hex, wrong type)
- Minimal theme (only required fields)

**Mocks:**
- `window.matchMedia` for auto-switch tests
- Filesystem (fs) for ThemeManager tests (use temp directory)
- xterm.js Terminal for theme application tests

### Per-Block Test Mapping

| Block | Unit | Integration | E2E |
|-------|------|-------------|-----|
| B1: Theme model | validateTheme (5 cases) | - | - |
| B2: Theme API | ThemeManager (8 cases) | CRUD routes (7 cases) | - |
| B3: CSS vars | applyTheme, clearPreview (5 cases) | - | Theme switch (1) |
| B4: xterm integration | color mapping (3 cases) | - | Multi-terminal sync (1) |
| B5: Theme picker | search filter, card render (4 cases) | - | Picker flow (1) |
| B6: Theme editor | color picker, save (5 cases) | Import/export (3 cases) | Editor flow (1) |
| B7: Auto-switch | media query mock (5 cases) | Config persistence (5 cases) | Auto-switch (1) |

## 8. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| CSS variable migration breaks existing styles | H | M | Block 3 includes full component audit; use find-and-replace with verification |
| xterm.js theme update causes flicker | M | L | Use `terminal.options.theme` (batch update), not individual setOption calls |
| Color picker browser compatibility | L | L | Use native `<input type="color">` + manual hex input fallback |
| Large number of CSS variables (30+) | L | L | Flat namespace with `--nt-` prefix, documented in spec |
| Config.toml parsing for new [appearance] section | M | M | Reuse existing @iarna/toml parser, add to configResolver |
| Theme file I/O race conditions | M | L | ThemeManager uses sync fs operations (startup) or mutex for writes |
| Live preview jank with many terminals | M | M | Debounce hover via rAF; batch terminal.options.theme updates |
| Theme editor complexity (Block 6) | M | M | Heaviest block — candidate for deferral to Sprint 2 if time-constrained |
| Addon loading order (SearchAddon + theme) | L | L | Define explicit addon loading sequence in useTerminal.init() |

## 9. Definition of Done

- [ ] All 7 blocks implemented
- [ ] All 17 BDD scenarios have passing tests
- [ ] All tests pass (unit + integration)
- [ ] Lint/typecheck pass (`pnpm lint && pnpm exec tsc --noEmit`)
- [ ] Zero hardcoded color literals in web package component styles
- [ ] All 9 bundled themes render correctly (visual check)
- [ ] Theme switch is instant (<16ms for CSS + xterm update)
- [ ] Code review clean (no blocking findings)

## 10. Dependencies & Integration Notes

### UX-07 (Host Customization) Dependency

UX-07 builds on this story's per-host theme override (SC-03). The `TerminalProfile.theme` field in the config cascade already supports this. UX-07 adds environment banners and accent borders on top.

### UX-09 (Settings Panel) Integration

The `AppearancePanel.vue`, `ThemePicker.vue`, `ThemeCard.vue`, and `ThemeEditor.vue` components are built as standalone composable components. UX-09 will embed `AppearancePanel` inside its full settings panel with scope tabs. For now, the appearance panel can be accessed via a command palette action or a temporary route.

### Existing Config Cascade

The `theme` field already exists in `TerminalProfile`. This story does NOT change the cascade logic — it adds:
1. Theme file storage + API (hub)
2. Theme resolution (name -> full LastermTheme object) on the client
3. CSS variable application layer
4. Appearance config (separate from TerminalProfile, global-only)
