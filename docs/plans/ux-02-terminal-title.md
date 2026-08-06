---
doc-meta:
  status: canonical
  scope: ui
  type: specification
  target_project: /mnt/wsl/shared/dev/lasterm
  created: 2026-03-07
  updated: 2026-03-07
  complexity: COMPLEX
  time-budget: 4h
---

# Specification: UX-02 Terminal Title (OSC 0/2)

## 0. Quick Reference (ALWAYS VISIBLE)

| Item | Value |
|------|-------|
| Scope | ui |
| Complexity | COMPLEX |
| Time budget | 4h |
| Blocks | 5 |
| BDD scenarios | 15 |
| Risk level | LOW |

## 1. Problem Statement

Terminal tabs show static names ("Terminal 1"). Processes like vim, htop, or
shells with PROMPT_COMMAND emit OSC 0/2 escape sequences to set dynamic titles,
but lasterm ignores them. Users cannot see what each tab is running at a glance.
Titles also need truncation, sanitization, per-host prefixes, and browser window
title updates.

## 2. User Stories

### US-1: Dynamic Terminal Titles

AS A user with multiple terminals
I WANT tabs to show the running process name (e.g., "vim index.ts") via OSC
escape sequences
SO THAT I can identify each terminal at a glance

ACCEPTANCE: Shells with PROMPT_COMMAND and programs like vim update the tab
title in real-time; title persists on reconnect.

### US-2: Title Formatting & Prefix

AS an ops engineer managing multiple hosts
I WANT per-host title prefixes (e.g., "PROD") and configurable title
format/truncation
SO THAT I can distinguish environments and keep titles readable

ACCEPTANCE: Prefix shows in tab and window title; long titles truncate with
configurable strategy; browser tab shows formatted title.

### US-3: Title Safety & Fallback

AS a security-conscious user
I WANT terminal titles sanitized (no XSS, no control chars) and a sensible
fallback when no OSC title is emitted
SO THAT the UI remains safe and informative

ACCEPTANCE: HTML/control chars stripped; fallback title configurable; title
stack prevents blank titles during process transitions.

## 3. Business Rules

### 3.1 Invariants (always true)

- INV-01: Title priority (highest wins): Custom (F2 rename) > Dynamic (OSC 0/2) > Fallback (configurable).
- INV-02: OSC title content must be sanitized before display and before DB storage.
- INV-03: Titles must never exceed `maxRawLength` (256 chars) from the source.
- INV-04: The UI parses OSC locally from the OUTPUT stream for instant display (no round-trip to hub).
- INV-05: The agent sends TITLE_CHANGE to hub for DB persistence (reconnect recovery).
- INV-06: Browser window title updates only when `windowTitle` setting is enabled.
- INV-07: Agent must debounce TITLE_CHANGE emissions (100ms, last-write-wins) to prevent OSC title floods from fast-looping processes.
- INV-08: Hub must debounce `dynamic_title` DB writes (100ms, last-write-wins) to limit SQLite write pressure.
- INV-09: Empty OSC title must NOT be pushed to the title stack. An empty title triggers fallback display.
- INV-10: DB migration for `dynamic_title` column must be coordinated with UX-01 channel column additions (single migration).

### 3.2 Preconditions (required before action)

- PRE-01: Agent must have xterm.js headless loaded with `onTitleChange` handler to emit TITLE_CHANGE.
- PRE-02: Hub must have `channels.dynamic_title` column for persistence.
- PRE-03: ATTACH_OK must include `dynamic_title` field for reconnect recovery.

### 3.3 Effects (what changes)

- EFF-01: OSC 0/2 from process -> immediate tab title update (UI-local xterm.js parse).
- EFF-02: Agent emits TITLE_CHANGE -> hub stores in `channels.dynamic_title`.
- EFF-03: On reconnect, ATTACH_OK includes last known `dynamic_title` -> UI displays it.
- EFF-04: "Reset title to dynamic" clears custom title, reverts to OSC-driven title.
- EFF-05: Browser/window title updates to formatted string with host + prefix + title.
- EFF-06: Title stack in UI prevents blank titles during process exit/shell restore gap.

### 3.4 Error Handling

- ERR-01: OSC title containing HTML tags -> stripped before display/storage.
- ERR-02: OSC title containing control chars (non-printable) -> stripped.
- ERR-03: OSC title exceeding maxRawLength -> truncated to maxRawLength before processing.
- ERR-04: Agent TITLE_CHANGE for unknown channel_id -> hub ignores, logs warning.

## 4. Technical Design

### 4.1 Architecture Decision

**Dual approach:** UI parses OSC locally for instant display; agent sends
TITLE_CHANGE to hub for persistence. This avoids round-trip latency for title
updates while ensuring titles survive reconnects.

**Title stack in UI (not agent).** The shell naturally restores its title via
PROMPT_COMMAND after a child process exits. The UI stack is a safety net for
the brief gap.

### 4.2 Data Model Changes

| Entity | Change | Migration needed |
|--------|--------|------------------|
| `channels` table | Add `dynamic_title TEXT DEFAULT NULL` | Yes (ALTER TABLE) |
| TITLE_CHANGE message | New protocol message type | No (additive) |
| ATTACH_OK message | Add optional `dynamic_title` field | No (additive) |

### 4.3 Protocol Messages

```typescript
// New: Agent -> Hub
interface TitleChangeMessage {
  type: 'TITLE_CHANGE'
  channel_id: string
  title: string            // sanitized by agent before sending
}

// Extended: Hub -> UI (existing ATTACH_OK)
interface AttachOkMessage {
  // ... existing fields
  dynamic_title?: string   // last known title from DB
}
```

### 4.4 Sanitization Pipeline

```
Raw OSC title (from process)
  -> strip control chars (except printable ASCII + common Unicode)
  -> strip HTML tags (regex: /<[^>]*>/g)
  -> truncate to maxRawLength (256)
  -> result: safe title string
```

Applied in both agent (before TITLE_CHANGE) and UI (before display) as defense in depth.

### 4.5 Title Truncation

```typescript
function truncateTitle(title: string, max: number, position: 'end' | 'middle' | 'start'): string
```

- `end`: `"vim: src/components/v..."` (default)
- `middle`: `"vim: src/co...t-name.vue"`
- `start`: `"...long-component-name.vue"`

Ellipsis character: `\u2026` (single char).

### 4.6 Window Title Format

```typescript
function formatWindowTitle(format: string, vars: { prefix: string, host: string, title: string, channel: string, shell: string }): string
```

Default format: `"lasterm - {prefix}{host} - {title}"`
When title is empty, trailing ` - ` is trimmed.

## 5. Acceptance Criteria (BDD)

### Scenario Group: Dynamic Title Display (US-1)

```gherkin
@priority:high @type:nominal
Scenario: SC-01 -- OSC 0 updates tab title instantly
  Given a terminal tab is active running bash
  When the shell emits OSC 0 with title "vim index.ts"
  Then the tab title updates to "vim index.ts" within one frame
  And no network round-trip to hub is needed for the display update

@priority:high @type:nominal
Scenario: SC-02 -- Title persists on reconnect
  Given a terminal with dynamic title "htop"
  When the WebSocket connection drops and reconnects
  Then ATTACH_OK includes dynamic_title: "htop"
  And the tab title shows "htop" after reconnect

@priority:high @type:nominal
Scenario: SC-03 -- Custom title overrides dynamic
  Given a terminal with dynamic title "vim file.ts"
  When the user renames the tab via F2 to "Editor"
  Then the tab shows "Editor" (static)
  And subsequent OSC 0 emissions do NOT change the tab title

@priority:medium @type:nominal
Scenario: SC-04 -- Reset title to dynamic
  Given a tab with custom title "Editor"
  When the user right-clicks and selects "Reset Title to Dynamic"
  Then the tab reverts to the last known dynamic title
  And future OSC 0 emissions update the tab title again

@priority:medium @type:edge
Scenario: SC-05 -- Title stack prevents blank during process exit
  Given vim is running with title "vim index.ts"
  When vim exits (process terminates)
  And the shell has not yet emitted its PROMPT_COMMAND title
  Then the tab briefly shows "vim index.ts" (from title stack)
  And when the shell emits its title, the tab updates to it
```

### Scenario Group: Title Formatting & Prefix (US-2)

```gherkin
@priority:high @type:nominal
Scenario: SC-06 -- Per-host prefix in tab title
  Given host "prod-server" has prefix "PROD "
  And a terminal on "prod-server" has dynamic title "htop"
  When the tab renders
  Then the tab title shows "PROD htop"

@priority:medium @type:nominal
Scenario: SC-07 -- Window title updates with format string
  Given windowTitle is enabled with format "lasterm - {prefix}{host} - {title}"
  And active terminal is on host "prod" with prefix "PROD " and title "vim"
  When focus is on that terminal
  Then document.title updates to "lasterm - PROD prod - vim"

@priority:medium @type:nominal
Scenario: SC-08 -- Title truncation at end
  Given maxLength is 25 and truncation is "end"
  When a terminal title is "vim: src/components/very-long-component-name.vue"
  Then it displays as "vim: src/components/ve\u2026"

@priority:medium @type:nominal
Scenario: SC-09 -- Title truncation at middle
  Given maxLength is 25 and truncation is "middle"
  When a terminal title is "vim: src/components/very-long-component-name.vue"
  Then it displays as "vim: src/com\u2026nt-name.vue"

@priority:low @type:edge
Scenario: SC-10 -- Empty title with fallback
  Given fallback is "shell" and the shell is "zsh"
  And no OSC title has been emitted
  When the tab renders
  Then the tab title shows "zsh"
```

### Scenario Group: Title Safety (US-3)

```gherkin
@priority:high @type:nominal
Scenario: SC-11 -- HTML tags stripped from title
  Given a process emits OSC 0 with title "<script>alert(1)</script>vim"
  When the title is processed
  Then the tab displays "vim" (tags stripped)
  And the DB stores "vim" (sanitized by agent)

@priority:high @type:nominal
Scenario: SC-12 -- Control characters stripped
  Given a process emits OSC 0 with title "vim\x07\x1b[31m file.ts"
  When the title is processed
  Then the tab displays "vim file.ts" (control chars removed)

@priority:medium @type:edge
Scenario: SC-13 -- Title exceeding maxRawLength truncated at source
  Given a process emits OSC 0 with a 500-char title
  When the agent processes it
  Then TITLE_CHANGE.title is truncated to 256 chars
  And the UI further truncates to maxLength for display

@priority:medium @type:error
Scenario: SC-14 -- TITLE_CHANGE for unknown channel ignored
  Given the agent sends TITLE_CHANGE with channel_id "nonexistent"
  When the hub receives it
  Then the hub logs a warning
  And no DB update occurs

@priority:low @type:edge
Scenario: SC-15 -- Channel sidebar shows dynamic title
  Given a channel with dynamic title "vim index.ts"
  When the sidebar renders
  Then the channel item shows "vim index.ts" (not the static channel name)
  And no prefix is shown in sidebar (prefix = tab/window only)
```

### Coverage Matrix

| Scenario | Nominal | Edge | Error | Security |
|----------|---------|------|-------|----------|
| SC-01 | x | | | |
| SC-02 | x | | | |
| SC-03 | x | | | |
| SC-04 | x | | | |
| SC-05 | | x | | |
| SC-06 | x | | | |
| SC-07 | x | | | |
| SC-08 | x | | | |
| SC-09 | x | | | |
| SC-10 | | x | | |
| SC-11 | x | | | x |
| SC-12 | x | | | x |
| SC-13 | | x | | |
| SC-14 | | | x | |
| SC-15 | | x | | |

## 6. Implementation Plan

### Block 1: TITLE_CHANGE Protocol + DB Migration -- 45min

**Type:** Feature slice (agent + hub + shared)
**Dependencies:** None
**Packages:** shared, agent, hub

**Files:**
- `packages/shared/src/protocol.ts` -- add TITLE_CHANGE message type + TitleChangeMessage interface
- `packages/shared/src/sanitize.ts` -- new: `sanitizeTitle(raw: string, maxRawLength?: number): string`
- `packages/agent/src/message-handler.ts` -- subscribe to xterm.js headless `onTitleChange`, emit TITLE_CHANGE
- `packages/hub/src/dal/meta-dal.ts` -- ALTER TABLE channels ADD dynamic_title; updateDynamicTitle(channelId, title)
- `packages/hub/src/session-manager.ts` -- handle TITLE_CHANGE from agent, call DAL
- `packages/hub/src/session-manager.ts` -- include dynamic_title in ATTACH_OK response

**Exit criteria:**
- [ ] TITLE_CHANGE message type defined in shared protocol
- [ ] sanitizeTitle strips HTML + control chars + enforces maxRawLength
- [ ] Agent emits TITLE_CHANGE when xterm.js headless fires onTitleChange
- [ ] Hub stores dynamic_title in channels table
- [ ] ATTACH_OK includes dynamic_title for reconnect
- [ ] Unit tests: sanitizeTitle (5 cases), TITLE_CHANGE handling

### Block 2: UI Dynamic Title Display + Title Stack -- 45min

**Type:** Feature slice (web)
**Dependencies:** Block 1
**Packages:** web

**Files:**
- `packages/clients/web/src/composables/useTerminal.ts` -- add `onTitleChange` handler, title stack, `currentTitle` reactive ref
- `packages/clients/web/src/composables/useTabTitle.ts` -- new: title priority logic (custom > dynamic > fallback), prefix application
- `packages/clients/web/src/components/TabBar.vue` -- use `useTabTitle` for tab label rendering
- `packages/clients/web/src/components/ChannelItem.vue` -- show dynamic title in sidebar (no prefix)
- `packages/clients/web/src/stores/channels.ts` -- store dynamic_title per channel (from STATE_SYNC + ATTACH_OK)

**Exit criteria:**
- [ ] OSC 0/2 updates tab title instantly (local xterm.js parse)
- [ ] Title stack prevents blank titles during process transitions
- [ ] Custom title (F2 rename) overrides dynamic title
- [ ] Dynamic title from ATTACH_OK restores on reconnect
- [ ] Channel sidebar shows dynamic title
- [ ] Unit tests: title priority, title stack behavior

### Block 3: Title Truncation + Sanitization -- 30min

**Type:** Feature slice (shared + web)
**Dependencies:** Block 2
**Packages:** shared, web

**Files:**
- `packages/shared/src/sanitize.ts` -- add `truncateTitle(title, maxLength, position)` function
- `packages/clients/web/src/composables/useTabTitle.ts` -- apply truncation before display

**Exit criteria:**
- [ ] truncateTitle handles end/middle/start positions correctly
- [ ] Ellipsis uses single unicode char (U+2026)
- [ ] Titles shorter than maxLength pass through unchanged
- [ ] Unit tests: truncation for all 3 positions, edge cases (empty, exact length)

### Block 4: Window Title + Per-Host Prefix -- 30min

**Type:** Feature slice (web + hub)
**Dependencies:** Block 2
**Packages:** web, hub

**Files:**
- `packages/clients/web/src/composables/useWindowTitle.ts` -- new: `document.title` updater with format string, reactive to active pane title
- `packages/clients/web/src/composables/useTabTitle.ts` -- integrate prefix from host profile
- `packages/hub/src/config-resolver.ts` -- parse `[terminal.title]` section from config.toml

**Exit criteria:**
- [ ] Browser window title updates reactively on pane focus change
- [ ] Format string supports {prefix}, {host}, {title}, {channel}, {shell} tokens
- [ ] Per-host prefix from host profile applied to tab title
- [ ] Prefix NOT shown in channel sidebar
- [ ] Trailing separator trimmed when title is empty
- [ ] Unit tests: format string parsing, prefix integration

### Block 5: Title Settings + Reset to Dynamic -- 30min

**Type:** Feature slice (web + hub)
**Dependencies:** Block 4
**Packages:** web, hub, shared

**Files:**
- `packages/shared/src/config.ts` -- add TitleConfig interface
- `packages/hub/src/config-resolver.ts` -- parse title settings from config.toml
- `packages/clients/web/src/composables/useTabTitle.ts` -- read settings (source, fallback, maxLength, truncation)
- `packages/clients/web/src/components/TabContextMenu.vue` -- "Reset Title to Dynamic" action (from UX-01, integrated here)

**Exit criteria:**
- [ ] Title source setting ("dynamic" | "static") controls behavior
- [ ] Fallback setting ("channel" | "shell" | "custom") used when no OSC title
- [ ] maxLength and truncation position configurable
- [ ] "Reset Title to Dynamic" clears custom title, reverts to dynamic mode
- [ ] Unit tests: settings integration, fallback logic

## 7. Test Strategy

### Test Pyramid

| Level | Count | Focus |
|-------|-------|-------|
| Unit | ~25 | Sanitization, truncation, title priority, format string, title stack |
| Integration | ~8 | TITLE_CHANGE flow (agent->hub->DB), ATTACH_OK with title |
| E2E | ~3 | Dynamic title update, reconnect recovery, prefix display |

### Test Data Requirements

**Fixtures:**
- OSC 0/2 escape sequences (valid, malicious, oversized)
- Title strings with HTML, control chars, Unicode
- Host profiles with/without prefix

**Mocks:**
- xterm.js Terminal.onTitleChange for UI tests
- xterm.js headless onTitleChange for agent tests
- document.title for window title tests

## 8. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| xterm.js headless onTitleChange not firing | H | L | Already used for snapshot; test in agent spike |
| Title flicker during process transitions | M | M | Title stack with debounce prevents blank |
| OSC sanitization too aggressive (strips valid Unicode) | M | L | Allow printable Unicode, only strip C0/C1 control chars |
| Window title update rate too high | L | M | Debounce document.title updates (100ms) |
| OSC title flood from fast-looping process | M | M | 100ms debounce in agent before TITLE_CHANGE emission |
| DB write pressure from rapid title changes | M | M | Hub debounces dynamic_title writes (100ms last-write-wins) |
| DB migration coordination with UX-01 | M | L | Single migration for all channel column additions |

## 9. Definition of Done

- [ ] All 5 blocks implemented
- [ ] All 15 BDD scenarios have passing tests
- [ ] All tests pass (unit + integration)
- [ ] Lint/typecheck pass
- [ ] Dynamic title updates in real-time from OSC 0/2
- [ ] Title survives WebSocket reconnect
- [ ] HTML/control chars stripped (XSS-safe)
- [ ] Window title updates with configurable format
- [ ] Code review clean (no blocking findings)

## 10. Dependencies & Integration Notes

### UX-01 (Tab Actions) Integration

UX-01 defines the tab context menu where "Reset Title to Dynamic" lives.
UX-02 Block 5 integrates with UX-01's TabContextMenu component. If UX-01
is not yet implemented, "Reset Title to Dynamic" can be added as a standalone
action triggered via a different UI affordance.

### UX-06 (Theming) Dependency

Title display components must use `var(--nt-*)` CSS variables. No hardcoded
colors in title-related UI.

### Existing Code

- `useTerminal.ts` already wraps xterm.js -- Block 2 extends it with onTitleChange
- `TabBar.vue` already renders tab labels -- Block 2 changes the label source
- Agent's `message-handler.ts` already processes OUTPUT -- Block 1 adds TITLE_CHANGE alongside
- `meta-dal.ts` already has channels table -- Block 1 adds dynamic_title column
