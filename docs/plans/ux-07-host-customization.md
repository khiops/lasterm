---
doc-meta:
  status: canonical
  scope: web, shared, hub
  type: specification
  target_project: /mnt/wsl/shared/dev/lasterm
  created: 2026-03-07
  updated: 2026-03-07
  complexity: SIMPLE
  time-budget: 4h
  adversarial_applied: true
  llm_spec_applied: true
---

# Specification: UX-07 Host Customization & Visual Profiles

## 0. Quick Reference (ALWAYS VISIBLE)

| Item | Value |
|------|-------|
| Scope | web, shared, hub |
| Complexity | SIMPLE |
| Time budget | 4h |
| Blocks | 5 |
| BDD scenarios | 20 |
| Risk level | LOW |

## 1. Problem Statement

Users cannot visually distinguish terminal panes by host environment. When connected to production and staging simultaneously, there is no visual cue to prevent accidentally running commands on the wrong server. This story delivers per-host visual profiles: environment banner, accent border, and background tint with preset profiles for quick setup.

## 2. User Stories

### US-01: Environment Awareness
AS A user connected to multiple servers (prod, staging, dev)
I WANT each host to have a distinct visual identity in the terminal
SO THAT I never accidentally run a destructive command on the wrong server

ACCEPTANCE: Red banner "PRODUCTION" + red border + red tint on prod terminals; yellow for staging; none for dev

### US-02: Quick Preset Setup
AS A user adding a new production host
I WANT to select a "Danger" preset that auto-configures banner, border, and tint
SO THAT I get a safe visual profile in one click without manual color picking

ACCEPTANCE: 3 presets (None, Caution, Danger) + Custom; selecting preset fills all visual profile fields

## 3. Business Rules

### 3.1 Invariants (always true)

- INV-01: Visual profile is per-host only, not per-channel — it is an environment indicator
- INV-02: Visual profile is stored in hosts.profile_json alongside terminal profile (config cascade layer 3)
- INV-03: Color layers are independent: host.color (identity/rail), theme (palette), visualProfile.border.color, visualProfile.tint.color
- INV-04: Background tint opacity range: 0-15% (>15% impairs readability)
- INV-05: Banner text supports tokens: {host}, {ip}, {user}, {group} — resolved at render time. {user} uses host.sshUser field (added by UX-03). {group} uses host.hostGroup (added by UX-03, available since UX-03 runs before UX-07).
- INV-06: Accent border is CSS on the container div — xterm.js fit() recalculates automatically when border changes
- INV-07: Local host defaults to preset "none" (no banner, no border, no tint)
- INV-08: Banner text MUST be rendered via text content (Vue {{ }} or textContent), NEVER via v-html or innerHTML.
- INV-09: Color values (bgColor, textColor, border.color, tint.color) MUST match /^#[0-9a-fA-F]{6}$/ before applying to CSS. Invalid values fall back to defaults. Validated both client-side and server-side.

### 3.2 Preconditions (required before action)

- PRE-01: Visual profile settings require UX-03 Edit Host modal to be available (host scope only)
- PRE-02: Banner text requires at least 1 non-whitespace character when enabled
- PRE-03: Tint color must be a valid hex #rrggbb value

### 3.3 Effects (what changes)

- EFF-01: Select preset → banner, border, tint fields all populated with preset values
- EFF-02: Modify any preset field → preset auto-switches to "custom"
- EFF-03: Enable banner → bar appears between pane header and terminal content
- EFF-04: Enable border → CSS border on terminal container, terminal area shrinks by border width
- EFF-05: Enable tint → CSS background-color overlay with opacity on terminal pane
- EFF-06: Save visual profile → persisted in hosts.profile_json, applied on next render

### 3.4 Error Handling

- ERR-01: Invalid tint opacity (>15%) → clamp to 15% with warning
- ERR-02: Empty banner text when enabled → disable banner, show validation message
- ERR-03: Invalid color hex → show inline validation, prevent save
- ERR-04: Unresolvable token renders as literal '{token}' string, not empty.
- ERR-05: If resolved banner text is whitespace-only after token substitution, banner is hidden for that host at render time.

## 4. Technical Design

### 4.1 Architecture Decision

Visual profile is a subsection of the host profile (hosts.profile_json, config cascade layer 3). No new DB columns — all visual profile data fits in the existing JSON profile. Rendering is UI-only: banner, border, and tint are CSS-rendered in the terminal pane component. No protocol or agent changes. Hub validates color hex values in PUT /api/hosts/:id handler (INV-09 requires server-side validation).

Banner position is fixed: always between pane header and terminal content (per-pane). The 'aboveTabs' position was considered but deferred — it creates ambiguity with multi-host split panes and requires a different component hierarchy.

### 4.2 Data Model Changes

| Entity | Change | Migration needed |
|--------|--------|------------------|
| hosts.profile_json | Add visualProfile section to JSON | No (JSON field, backward-compatible) |

### 4.3 API Contract

No new endpoints. Visual profile is saved via existing PUT /api/hosts/:id (profile_json field).

### 4.4 Type Definitions (shared)

```typescript
type VisualPreset = "none" | "caution" | "danger" | "custom"
type BorderStyle = "none" | "subtle" | "strong"

interface VisualProfile {
  preset: VisualPreset

  banner: {
    enabled: boolean
    text: string                    // supports {host}, {ip}, {user}
    bgColor: string                 // hex #rrggbb
    textColor: string               // hex #rrggbb
  }

  border: {
    style: BorderStyle              // default "none"
    color: string                   // empty = use host.color
  }

  tint: {
    enabled: boolean
    color: string                   // hex #rrggbb
    opacity: number                 // 0-15 percent
  }
}
```

VISUAL_PRESETS constant and resolvePreset() live in the web package (`packages/clients/web/src/utils/visual-presets.ts`), NOT in shared. Preset is stored explicitly — no detectPresetFromProfile() reverse-detection.

### 4.5 Tint Implementation

Tint uses a CSS ::after pseudo-element on .terminal-pane: position absolute, inset 0, pointer-events none, background-color rgba(tintColor, tintOpacity/100), z-index above terminal canvas but below overlays (search, exit). Must include will-change: opacity for GPU compositing. Tint opacity is independent of terminal opacity (AppearanceConfig.opacity.terminal) — they do not compound.

### 4.6 Config Additions

No config.toml additions — visual profile is per-host only (stored in hosts.profile_json). No global defaults for visual profiles.

## 5. Acceptance Criteria (BDD)

### Scenario Group: Preset Profiles

```gherkin
@priority:high @type:nominal
Scenario: SC-01 Select Danger preset
  Given the user is editing host "prod" advanced settings
  When they select preset "Danger"
  Then banner is enabled with text "PRODUCTION - {host}", red bg, white text
  And border is "strong" with red color
  And tint is enabled at 5% red

@priority:high @type:nominal
Scenario: SC-02 Select Caution preset
  Given the user is editing host "staging"
  When they select preset "Caution"
  Then banner is enabled with text "STAGING - {host}", yellow bg, dark text
  And border is "subtle" with yellow color
  And tint is enabled at 3% yellow

@priority:medium @type:nominal
Scenario: SC-03 Select None preset
  Given host "dev-box" has preset "Danger" configured
  When the user switches to preset "None"
  Then banner is disabled, border is "none", tint is disabled

@priority:medium @type:edge
Scenario: SC-04 Modify preset switches to Custom
  Given host "prod" has preset "Danger"
  When the user changes tint opacity from 5% to 10%
  Then the preset automatically changes to "Custom"
  And all other values remain unchanged
```

### Scenario Group: Environment Banner

```gherkin
@priority:high @type:nominal
Scenario: SC-05 Banner renders with token substitution
  Given host "prod" has banner text "PRODUCTION - {host} ({ip}) [{group}]"
  And host label is "prod", ssh_host is "1.2.3.4", host_group is "Servers", ssh_user is "deploy"
  When a terminal pane for "prod" renders
  Then the banner shows "PRODUCTION - prod (1.2.3.4) [Servers]"

@priority:medium @type:edge
Scenario: SC-05b Token {group} null renders literal
  Given host "staging" has banner text "ENV: {host} [{group}]"
  And host_group is NULL
  When a terminal pane for "staging" renders
  Then the banner shows "ENV: staging [{group}]"

@priority:medium @type:error
Scenario: SC-06 Empty banner text validation
  Given banner is enabled
  When the user clears the text field
  Then a validation error shows "Banner text is required when enabled"
  And Save is disabled
```

### Scenario Group: Accent Border

```gherkin
@priority:high @type:nominal
Scenario: SC-07 Subtle border renders
  Given host "staging" has border style "subtle" with color "#e5c07b"
  When a terminal pane for "staging" renders
  Then a 2px yellow left border appears on the terminal container
  And xterm.js fit() recalculates terminal dimensions

@priority:high @type:nominal
Scenario: SC-08 Strong border renders
  Given host "prod" has border style "strong" with color "#e06c75"
  When a terminal pane for "prod" renders
  Then a 3px red border appears on left, right, and bottom
  And xterm.js fit() recalculates

@priority:medium @type:nominal
Scenario: SC-09 Border defaults to host color
  Given host "prod" has color "#e06c75" and border.color is empty
  When the border renders
  Then it uses the host color "#e06c75"

@priority:medium @type:edge
Scenario: SC-10 Border color overrides host color
  Given host "prod" has color "#e06c75" but border.color is "#61afef"
  When the border renders
  Then it uses the override color "#61afef" (blue, not red)
```

### Scenario Group: Background Tint

```gherkin
@priority:high @type:nominal
Scenario: SC-11 Background tint renders
  Given host "prod" has tint enabled, color "#e06c75", opacity 5%
  When a terminal pane for "prod" renders
  Then a red overlay with 5% opacity covers the terminal background
  And text remains readable

@priority:medium @type:edge
Scenario: SC-12 Tint opacity clamped at 15%
  Given the user sets tint opacity to 20%
  Then the value is clamped to 15%
  And a warning shows "Maximum opacity is 15%"

@priority:medium @type:nominal
Scenario: SC-13 Tint slider with live preview
  Given the user is editing tint settings
  When they move the opacity slider from 5% to 10%
  Then the preview pane updates in real-time showing the tint effect
```

### Scenario Group: Combined Visual Profile

```gherkin
@priority:high @type:nominal
Scenario: SC-14 Full visual profile renders correctly
  Given host "prod" has: banner (red, "PRODUCTION"), border (strong, red), tint (5% red)
  When a terminal pane for "prod" renders
  Then all three visual elements are visible simultaneously
  And the terminal content remains fully readable
  And the layout does not break with split panes

@priority:high @type:nominal
Scenario: SC-15 Split pane different hosts
  Given pane A connected to 'prod' (Danger) and pane B to 'staging' (Caution) in same tab
  When both render
  Then pane A shows red banner/border/tint and pane B shows yellow

@priority:medium @type:edge
Scenario: SC-16 Strong border in split panes
  Given host 'prod' has strong border and tab has 2 horizontal split panes both for 'prod'
  When both render
  Then interior borders do not double up

@priority:high @type:security
Scenario: SC-17 XSS in banner via host label
  Given host label is "<script>alert(1)</script>" and banner text is "{host}"
  When banner renders
  Then literal text is shown, no script execution

@priority:medium @type:nominal
Scenario: SC-18 Local host token resolution
  Given host is local (no sshHost) and banner text is "ENV: {host} ({ip})"
  When rendered
  Then shows "ENV: my-laptop (localhost)"

@priority:medium @type:edge
Scenario: SC-19 Tint + terminal opacity independence
  Given host has tint 5% red and terminal opacity is 80%
  When rendered
  Then tint is independent, text remains readable
```

### Coverage Matrix

| Scenario | Nominal | Edge | Error | Security |
|----------|---------|------|-------|----------|
| SC-01 | X | | | |
| SC-02 | X | | | |
| SC-03 | X | | | |
| SC-04 | | X | | |
| SC-05 | X | | | |
| SC-05b | | X | | |
| SC-06 | | | X | |
| SC-07 | X | | | |
| SC-08 | X | | | |
| SC-09 | X | | | |
| SC-10 | | X | | |
| SC-11 | X | | | |
| SC-12 | | X | | |
| SC-13 | X | | | |
| SC-14 | X | | | |
| SC-15 | X | | | |
| SC-16 | | X | | |
| SC-17 | | | | X |
| SC-18 | X | | | |
| SC-19 | | X | | |

**Coverage: 12 nominal, 6 edge, 1 error, 1 security = 20 total**

## 6. Implementation Plan

### Block 1: Shared Types + Web Preset Constants — 30min
**Type:** Feature slice
**Dependencies:** None
**Packages:** shared, web

**Files:**
- `packages/shared/src/types.ts` — VisualProfile, VisualPreset, BorderStyle types (NO BannerPosition)
- `packages/clients/web/src/utils/visual-presets.ts` — VISUAL_PRESETS constant, resolvePreset()

VISUAL_PRESETS and resolvePreset() live in the web package, NOT in shared. No detectPresetFromProfile() — preset is stored explicitly, not reverse-detected.

**Exit criteria:**
- [ ] VisualProfile type defined with banner, border, tint sub-objects
- [ ] 4 presets defined (none, caution, danger, custom)
- [ ] resolvePreset(preset) returns full VisualProfile defaults
- [ ] Shared package builds cleanly
- [ ] Web package builds cleanly

### Block 2: Environment Banner Component — 1h
**Type:** Feature slice
**Dependencies:** Block 1
**Packages:** web

**Files:**
- `packages/clients/web/src/components/EnvironmentBanner.vue` — banner component with token substitution (no collapse/expand)
- `packages/clients/web/src/composables/useVisualProfile.ts` — resolve visual profile from host profile_json, token replacement

Banner position is always between pane header and terminal content (per-pane). No position config needed.

**Exit criteria:**
- [ ] Banner renders with correct text and colors
- [ ] Token substitution: {host} → host.label, {ip} → host.sshHost, {user} → host.sshUser, {group} → host.hostGroup (all from UX-03)
- [ ] Banner text rendered via {{ }} (textContent), NEVER v-html
- [ ] Unresolvable tokens render as literal '{token}' string
- [ ] Whitespace-only resolved text hides banner at render time
- [ ] {user} falls back to empty string when host.sshUser is null/undefined

### Block 3: Accent Border + Background Tint — 45min
**Type:** Feature slice
**Dependencies:** Block 1
**Packages:** web

**Files:**
- `packages/clients/web/src/components/TerminalPane.vue` — add border CSS + tint overlay based on visual profile
- `packages/clients/web/src/composables/useVisualProfile.ts` — extend with border/tint CSS computation

Tint implementation: CSS ::after pseudo-element on .terminal-pane with will-change: opacity for GPU compositing. See section 4.5.

**Exit criteria:**
- [ ] Subtle border: 2px left only, color from visual profile or host.color fallback
- [ ] Strong border: 3px left + right + bottom
- [ ] Interior borders between same-host panes should not double up
- [ ] Border triggers xterm.js fit() recalculation via ResizeObserver (already in place)
- [ ] Tint: CSS ::after pseudo-element with rgba(color, opacity/100) on terminal pane
- [ ] Tint does NOT affect sidebar/tabs — only terminal content area
- [ ] Tint opacity independent of terminal opacity (AppearanceConfig.opacity.terminal)

### Block 4: Visual Profile Settings UI — 1h
**Type:** Feature slice
**Dependencies:** Block 1, Block 2, Block 3
**Packages:** web

**Files:**
- `packages/clients/web/src/components/VisualProfileSettings.vue` — preset selector, banner/border/tint config forms
- `packages/clients/web/src/components/TintPreview.vue` — live preview of tint effect

**Exit criteria:**
- [ ] Preset selector: radio buttons (None/Caution/Danger/Custom)
- [ ] Selecting preset fills banner/border/tint fields
- [ ] Modifying any field auto-switches preset to "Custom"
- [ ] Banner config: text, bgColor (picker), textColor (picker) — no position radio, no collapsible checkbox, no shortText field
- [ ] Border config: style (radio), color (picker with "from host color" default)
- [ ] Tint config: enabled (checkbox), color (picker), opacity (slider 0-15%, live preview)
- [ ] Tint slider preview uses requestAnimationFrame, preview targets static mock element
- [ ] Validation: non-empty text when banner enabled, valid hex colors (/^#[0-9a-fA-F]{6}$/), opacity clamped 0-15

### Block 5: Integration with Host Edit Modal + Hub Validation — 45min
**Type:** Feature slice
**Dependencies:** Block 4, UX-03 Block 5 (host modal)
**Packages:** web, hub

**Files:**
- `packages/clients/web/src/components/HostModal.vue` — add Visual Profile section under Advanced
- `packages/clients/web/src/stores/hosts.ts` — serialize/deserialize visualProfile in profile_json
- `packages/hub/src/api/hosts.ts` — add server-side validation for visualProfile color values in PUT /api/hosts/:id handler

**Exit criteria:**
- [ ] Visual Profile section appears in Edit Host modal > Advanced
- [ ] Profile loaded from host.profile_json on open
- [ ] Profile saved to profile_json on Save
- [ ] Default visual profile for new hosts: preset "none"
- [ ] Works correctly with split panes (all panes of same host get same visual profile)
- [ ] Hub validates color hex values (/^#[0-9a-fA-F]{6}$/) in profile_json.visualProfile on PUT — rejects 400 on invalid

## 7. Test Strategy

### Test Pyramid

| Level | Count | Focus |
|-------|-------|-------|
| Unit | 12 | Preset resolution, token substitution, opacity clamping, CSS computation, color validation |
| Integration | 4 | Visual profile rendering in terminal pane, banner + border + tint combined, split pane rendering |
| E2E | 3 | Preset selection flow, banner rendering, tint slider live preview |

### Test Data Requirements

**Fixtures:**
- Host objects with various visual profiles (none, caution, danger, custom)
- Token values for substitution testing
- Edge case profiles (max opacity, empty border color, invalid hex colors, XSS in host labels)

**Mocks:**
- Host data in stores (mock Pinia store)
- xterm.js fit() for border dimension changes

### Per-Block Test Mapping

| Block | Unit | Integration | E2E |
|-------|------|-------------|-----|
| 1: Shared Types + Presets | 4 | — | — |
| 2: Banner Component | 3 | 1 | 1 |
| 3: Border + Tint | 2 | 2 | — |
| 4: Settings UI | 2 | — | 1 |
| 5: Integration | 1 | 1 | 1 |

## 8. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Tint overlay interferes with text readability | M | L | Max 15% opacity cap; preview in settings UI |
| Border + split panes layout issues | M | L | Test with max 4 panes; CSS grid/flex handles border naturally |
| UX-03 not complete when UX-07 starts | M | M | Block 5 can be implemented after UX-03; Blocks 1-4 are independent |
| Banner height reduces terminal area | L | L | 24px expanded is minimal; collapse feature can be added later if needed |

## 9. Definition of Done

- [ ] All 5 blocks implemented
- [ ] All 19 BDD scenarios have passing tests
- [ ] All tests pass (unit + integration + e2e)
- [ ] Lint/typecheck pass
- [ ] Presets work (None, Caution, Danger fill all fields correctly)
- [ ] Banner renders with token substitution
- [ ] Border renders (subtle/strong) with correct colors
- [ ] Tint renders with opacity slider and live preview
- [ ] Combined visual profile renders correctly with split panes
- [ ] Code review clean (no blocking findings)

## 10. Dependencies & Integration Notes

- **UX-03 (Sprint 2):** Host edit modal — visual profile settings are in the Advanced section; Block 5 depends on UX-03 Block 5
- **UX-06 (complete):** Theming — tint is additive on top of theme background; border colors independent of theme
- **UX-01 (complete):** Split panes — all panes of same host share visual profile; banner renders per-pane based on the pane's host
- **Config cascade:** Visual profile lives in hosts.profile_json (layer 3); no global defaults (visual profiles are inherently per-host)
