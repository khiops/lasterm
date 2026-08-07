---
doc-meta:
  status: canonical
  scope: ui
  type: specification
  target_project: /mnt/wsl/shared/dev/lasterm
  created: 2026-03-07
  updated: 2026-03-07
  complexity: COMPLEX
  time-budget: 8h
---

# Specification: UX-01 Tab Actions, Split Panes & Welcome Tab

## 0. Quick Reference (ALWAYS VISIBLE)

| Item | Value |
|------|-------|
| Scope | ui |
| Complexity | COMPLEX |
| Time budget | 8h |
| Blocks | 7 |
| BDD scenarios | 21 |
| Risk level | MEDIUM |

## 1. Problem Statement

The current tab/pane system has basic split and close but lacks: tab context
menus (close others, close all, close to right), vacant pane slots (closing a
pane auto-removes it), welcome tab, cross-tab DnD, process-spawned channels,
configure command dialog, and bulk close confirmations. These are table-stakes
features for a terminal app competing with iTerm2/WezTerm/Windows Terminal.

## 2. User Stories

### US-1: Tab & Pane Management

AS A power user with many terminals
I WANT context menus to close tabs selectively and manage split panes with
vacant slots
SO THAT I can organize my workspace efficiently without losing terminal state

ACCEPTANCE: Right-click tab shows context menu; close actions work correctly;
closing a pane leaves a vacant picker slot; tabs never auto-close.

### US-2: Welcome Tab & Process Channels

AS A user connecting to hosts
I WANT a configurable welcome tab that auto-opens and the ability to run
specific programs (btop, vim, etc.) as dedicated terminal channels
SO THAT I have a productive starting point and purpose-built terminals

ACCEPTANCE: Welcome tab opens on connect, survives "Close All", runs
configurable command; direct process channels show exit overlay with restart.

### US-3: Cross-Tab Drag & Drop

AS A user with split layouts across tabs
I WANT to drag a terminal pane from one tab into another tab's layout
SO THAT I can reorganize my workspace without recreating terminals

ACCEPTANCE: Drag pane to another tab shows drop zones; drop creates split;
source becomes vacant; within same host only.

## 3. Business Rules

### 3.1 Invariants (always true)

- INV-01: One tab = one host. A tab can only contain channels belonging to its host.
- INV-02: Max 4 panes per tab (hardcoded). Split actions disabled when limit reached.
- INV-03: Closing a pane NEVER kills the terminal. It detaches to "active + detached" state.
- INV-04: A tab NEVER auto-closes. Even with all panes vacant, the tab stays open showing pickers.
- INV-05: Only one welcome tab per host at any time.
- INV-06: Welcome tab is protected from "Close All" (but user can close it explicitly).
- INV-07: Cross-tab DnD only works between tabs of the same host.
- INV-08: PaneLayout tree is persisted to localStorage after every mutation.
- INV-09: All existing code that pattern-matches on `PaneLayout.type` must handle the `"vacant"` case. Grep for exhaustive switches before merging Block 2.
- INV-10: On layout load from localStorage, validate max panes (4). If exceeded, truncate tree to 4 terminal leaves (drop excess splits).

### 3.2 Preconditions (required before action)

- PRE-01: Tab context menu items ("Close Others", "Close to the Right") require > 1 tab to be enabled.
- PRE-02: "Split Right/Down" submenu requires < 4 panes in current tab.
- PRE-03: "Restart" in channel context menu requires channel state = "exited".
- PRE-04: "Set as Welcome Tab" toggles (unset if already welcome, set if not).

### 3.3 Effects (what changes)

- EFF-01: "Close Others" detaches all panes in other tabs of same host, vacates their slots.
- EFF-02: "Close All" detaches all non-welcome panes, vacates their slots.
- EFF-03: Vacant pane shows inline picker listing detached channels from the same host.
- EFF-04: "Rearrange" on a vacant slot removes it and redistributes space to siblings.
- EFF-05: Welcome tab auto-opens when connecting to a host with no other tabs.
- EFF-06: Direct process channels show exit overlay with [Restart] [Configure Command] [Close].
- EFF-07: Configure Command dialog updates channel's shell/args/cwd and optionally restarts.

### 3.4 Error Handling

- ERR-01: DnD to a tab at max panes (4) -> drop rejected, visual feedback "Max panes reached".
- ERR-02: DnD to a tab of a different host -> drop rejected, no drop zones shown.
- ERR-03: Configure Command with empty program field -> validation error, Apply disabled.
- ERR-04: Welcome command fails to spawn -> standard channel error overlay, log warning. Welcome tab still exists (not removed on spawn failure).
- ERR-05: Layout loaded from localStorage with > 4 panes -> truncated to 4, warning logged.
- ERR-06: Vacant pane picker with zero detached channels -> shows only "New Terminal" option (no empty state).

## 4. Technical Design

### 4.1 Architecture Decision

**Extend existing PaneLayout type with `"vacant"` node.** The current binary tree
layout engine in `useLayout.ts` already handles splits and terminals. Adding
`{ type: "vacant" }` as a leaf type enables the picker pattern without changing
the tree structure.

**Context menus as Vue components with teleport.** Tab and channel context menus
render via `<Teleport to="body">` for correct z-index. Position calculated from
right-click coordinates.

**Cross-tab DnD via HTML5 drag API** with `dataTransfer` carrying channelId + sourceTabId.
Drop zones rendered as overlay divs on the target tab's pane areas.

### 4.2 Data Model Changes

| Entity | Change | Migration needed |
|--------|--------|------------------|
| PaneLayout type (web) | Add `{ type: "vacant" }` leaf | No (localStorage, auto-migrates) |
| channels table | Add `icon TEXT DEFAULT NULL` | Yes (ALTER TABLE) |
| channels table | Add `shell TEXT DEFAULT NULL` | Yes (ALTER TABLE) |
| channels table | Add `args TEXT DEFAULT '[]'` | Yes (ALTER TABLE) |
| channels table | Add `cwd TEXT DEFAULT NULL` | Yes (ALTER TABLE) |
| channels table | Add `direct_process BOOLEAN DEFAULT 0` | Yes (ALTER TABLE) |
| channels table | Add `is_welcome BOOLEAN DEFAULT 0` | Yes (ALTER TABLE) |
| SPAWN message | Add optional `shell`, `args`, `cwd`, `directProcess` fields | No (additive) |

### 4.3 API Contract

| Endpoint | Method | Auth | Request | Response |
|----------|--------|------|---------|----------|
| `/api/channels/:id` | PATCH | Yes | `{ icon, shell, args, cwd, directProcess }` | `200 Channel` |
| `/api/channels/:id/restart` | POST | Yes | - | `200 { channelId }` |
| `/api/hosts/:id/welcome` | PUT | Yes | `{ channelId }` | `200` |
| `/api/hosts/:id/welcome` | DELETE | Yes | - | `204` |

### 4.4 PaneLayout Type Extension

```typescript
type PaneLayout =
  | { type: "terminal"; channelId: string }
  | { type: "vacant" }                              // NEW
  | { type: "split"; direction: "horizontal" | "vertical";
      ratio: number; first: PaneLayout; second: PaneLayout }
```

## 5. Acceptance Criteria (BDD)

### Scenario Group: Tab Context Menu (US-1)

```gherkin
@priority:high @type:nominal
Scenario: SC-01 -- Right-click tab shows context menu
  Given a tab "Terminal 1" is active
  When the user right-clicks the tab header
  Then a context menu appears with: Rename, Reset Title, Configure Command,
       Set as Welcome Tab, Split Right, Split Down, Close, Close Others,
       Close to the Right, Close All

@priority:high @type:nominal
Scenario: SC-02 -- Close Others detaches all other tabs
  Given tabs [T1, T2, T3] are open on host "local"
  When the user selects "Close Others" on T2
  Then T1 and T3 panes become vacant (channels detached)
  And T2 remains unchanged

@priority:high @type:nominal
Scenario: SC-03 -- Close to the Right
  Given tabs [T1, T2, T3, T4] are open
  When the user selects "Close to the Right" on T2
  Then T3 and T4 panes become vacant
  And T1 and T2 remain unchanged

@priority:high @type:nominal
Scenario: SC-04 -- Close All respects welcome tab
  Given tabs [Welcome, T2, T3] are open with Welcome marked as welcome
  When the user selects "Close All" on any tab
  And confirmation dialog is accepted
  Then T2 and T3 panes become vacant
  And Welcome tab remains unchanged
```

### Scenario Group: Vacant Panes (US-1)

```gherkin
@priority:high @type:nominal
Scenario: SC-05 -- Closing a pane shows vacant picker
  Given a tab with 2 panes split horizontally [Term1 | Term2]
  When the user closes the Term2 pane
  Then Term2 detaches to sidebar (active + detached)
  And the right pane shows a picker listing available channels

@priority:medium @type:nominal
Scenario: SC-06 -- Vacant picker lists detached channels
  Given a vacant pane on host "local"
  And channels [T2 (detached), T3 (detached)] exist on "local"
  When the picker renders
  Then it shows "New Terminal" option and lists T2, T3
  And clicking T2 places it in the vacant slot

@priority:medium @type:nominal
Scenario: SC-07 -- Rearrange removes vacant and redistributes space
  Given a tab with layout [Term1 | VACANT]
  When the user clicks "Rearrange" on the vacant pane
  Then the split is removed
  And Term1 expands to fill the entire tab

@priority:medium @type:edge
Scenario: SC-08 -- Tab with all panes vacant stays open
  Given a tab with 2 panes, both vacant
  When no action is taken
  Then the tab remains in the tab bar
  And both vacant pickers are visible
```

### Scenario Group: Welcome Tab (US-2)

```gherkin
@priority:high @type:nominal
Scenario: SC-09 -- Welcome tab auto-opens on host connect
  Given host "local" has welcome tab enabled with command "/bin/bash"
  And no tabs are open for "local"
  When the user selects "local" in the host rail
  Then a welcome tab opens running "/bin/bash"
  And it shows a star icon in tab bar and sidebar

@priority:medium @type:nominal
Scenario: SC-10 -- Set as Welcome Tab via context menu
  Given tab "T1" is a regular terminal on host "local"
  When the user right-clicks T1 and selects "Set as Welcome Tab"
  Then T1 becomes the welcome tab (star icon)
  And any previous welcome tab on "local" loses its welcome status

@priority:medium @type:edge
Scenario: SC-11 -- Explicit close of welcome tab shows empty state
  Given only the welcome tab is open
  When the user explicitly closes it (not via Close All)
  Then a minimal empty state shows: "Press Ctrl+T to open a terminal"
```

### Scenario Group: Process-Spawned Channels (US-2)

```gherkin
@priority:high @type:nominal
Scenario: SC-12 -- Direct process channel shows exit overlay
  Given a channel running "btop" with directProcess = true
  When btop exits (process terminates)
  Then the terminal shows frozen output
  And an overlay appears with [Restart] [Configure Command] [Close]

@priority:medium @type:nominal
Scenario: SC-13 -- Configure Command dialog changes shell
  Given a channel running "/bin/bash"
  When the user opens Configure Command and sets program to "/usr/bin/btop"
  And clicks "Apply & Restart"
  Then the channel restarts with btop
  And the sidebar shows the updated process

@priority:medium @type:nominal
Scenario: SC-14 -- Channel icon set in Configure Command
  Given a channel with no custom icon
  When the user opens Configure Command and selects "cpu" icon
  And clicks Apply
  Then the tab bar shows [cpu] prefix
  And the channel sidebar shows [cpu] prefix
```

### Scenario Group: Cross-Tab DnD (US-3)

```gherkin
@priority:high @type:nominal
Scenario: SC-15 -- Drag pane to another tab creates split
  Given tab A has [Term1] and tab B has [Term2]
  When the user drags Term1's pane to tab B
  And drops on the RIGHT drop zone of Term2
  Then tab B becomes [Term2 | Term1] split horizontally
  And tab A's pane becomes vacant

@priority:medium @type:nominal
Scenario: SC-16 -- Drop between tabs creates new tab
  Given tabs [A, B] in the tab bar
  When the user drags a pane and drops between tab A and tab B in the tab bar
  Then a new tab C is created between A and B containing the dragged pane
  And the source pane becomes vacant

@priority:medium @type:error
Scenario: SC-17 -- DnD to tab at max panes is rejected
  Given tab B has 4 panes (max)
  When the user drags a pane to tab B
  Then no drop zones appear on tab B
  And a tooltip shows "Max panes reached"

@priority:medium @type:edge
Scenario: SC-18 -- DnD between different hosts is rejected
  Given tab A belongs to host "local" and tab B belongs to host "prod"
  When the user drags a pane from tab A toward tab B
  Then no drop zones appear on tab B
```

### Scenario Group: Confirmations & Settings (US-1)

```gherkin
@priority:medium @type:nominal
Scenario: SC-19 -- Close All shows confirmation dialog
  Given 4 tabs are open
  When the user selects "Close All"
  Then a dialog shows "Close all 4 terminals?"
  With checkboxes: "Remember for this host" and "Remember globally"

@priority:medium @type:edge
Scenario: SC-20 -- Remembered confirmation skips dialog
  Given the user previously checked "Remember globally" for Close All
  When the user selects "Close All"
  Then no dialog appears
  And the action executes immediately

@priority:low @type:nominal
Scenario: SC-21 -- Tab DnD reorder
  Given tabs [A, B, C]
  When the user drags tab B before tab A in the tab bar
  Then tabs become [B, A, C]
  And the layout is persisted
```

### Coverage Matrix

| Scenario | Nominal | Edge | Error | Security |
|----------|---------|------|-------|----------|
| SC-01 | x | | | |
| SC-02 | x | | | |
| SC-03 | x | | | |
| SC-04 | x | | | |
| SC-05 | x | | | |
| SC-06 | x | | | |
| SC-07 | x | | | |
| SC-08 | | x | | |
| SC-09 | x | | | |
| SC-10 | x | | | |
| SC-11 | | x | | |
| SC-12 | x | | | |
| SC-13 | x | | | |
| SC-14 | x | | | |
| SC-15 | x | | | |
| SC-16 | x | | | |
| SC-17 | | | x | |
| SC-18 | | x | | |
| SC-19 | x | | | |
| SC-20 | | x | | |
| SC-21 | x | | | |

## 6. Implementation Plan

### Block 1: Tab Context Menu + Close Actions -- 60min

**Type:** Feature slice
**Dependencies:** None
**Packages:** web

**Files:**
- `packages/clients/web/src/components/TabContextMenu.vue` -- context menu component with all actions
- `packages/clients/web/src/components/TabBar.vue` -- add right-click handler, emit context-menu event
- `packages/clients/web/src/composables/useLayout.ts` -- add `closeOthers(tabId)`, `closeToRight(tabId)`, `closeAll(exceptWelcome)`, `detachPane(tabId, channelId)`

**Exit criteria:**
- [ ] Right-click tab shows full context menu
- [ ] Close, Close Others, Close to Right, Close All work correctly
- [ ] Close All skips welcome tab
- [ ] Middle-click close still works
- [ ] Unit tests: closeOthers/closeToRight/closeAll logic

### Block 2: Vacant Pane Slots + Picker -- 75min

**Type:** Feature slice
**Dependencies:** Block 1
**Packages:** web

**Files:**
- `packages/clients/web/src/composables/useLayout.ts` -- add `"vacant"` PaneLayout type, update close to leave vacant
- `packages/clients/web/src/components/VacantPane.vue` -- picker UI listing detached channels + "New Terminal" + "Rearrange"
- `packages/clients/web/src/components/PaneLayout.vue` -- render VacantPane for `type: "vacant"` nodes
- `packages/clients/web/src/stores/channels.ts` -- add `detachedChannels` computed (active + not in any tab)

**Exit criteria:**
- [ ] Closing a pane leaves a vacant slot (not auto-removed)
- [ ] Vacant picker lists detached channels from same host
- [ ] Selecting a channel places it in the vacant slot
- [ ] "Rearrange" removes vacant and redistributes space
- [ ] Tabs never auto-close even with all panes vacant
- [ ] Unit tests: vacant node creation, rearrange logic

### Block 3: Welcome Tab -- 60min

**Type:** Feature slice
**Dependencies:** Block 2
**Packages:** web, hub

**Files:**
- `packages/clients/web/src/composables/useLayout.ts` -- add welcome tab tracking, auto-open on host connect
- `packages/clients/web/src/components/TabBar.vue` -- star icon for welcome tab
- `packages/clients/web/src/components/ChannelItem.vue` -- star icon for welcome channel
- `packages/hub/src/api/hosts.ts` -- PUT/DELETE /api/hosts/:id/welcome endpoints
- `packages/hub/src/dal/meta-dal.ts` -- channels.is_welcome column, toggle logic

**Exit criteria:**
- [ ] Welcome tab auto-opens on host connect when no tabs exist
- [ ] Star icon in tab bar and sidebar
- [ ] "Close All" skips welcome tab
- [ ] "Set as Welcome Tab" context menu toggles status
- [ ] Only one welcome tab per host at a time
- [ ] Integration tests: welcome API endpoints

### Block 4: Cross-Tab Pane DnD -- 75min

**Type:** Feature slice
**Dependencies:** Block 2
**Packages:** web

**Files:**
- `packages/clients/web/src/components/TerminalPane.vue` -- draggable attribute, dragstart handler
- `packages/clients/web/src/components/PaneLayout.vue` -- drop zone overlays (LEFT/RIGHT/TOP/BOTTOM/CENTER)
- `packages/clients/web/src/components/TabBar.vue` -- drop handler for between-tabs and on-tab drops
- `packages/clients/web/src/composables/useLayout.ts` -- `movePaneBetweenTabs(sourceTab, targetTab, channelId, dropZone)`

**Exit criteria:**
- [ ] Drag pane to another tab shows directional drop zones
- [ ] Drop on LEFT/RIGHT creates horizontal split, TOP/BOTTOM creates vertical
- [ ] Drop on CENTER replaces pane content
- [ ] Drop between tabs creates new standalone tab
- [ ] Source pane becomes vacant after drop
- [ ] DnD rejected for different hosts or maxed tabs
- [ ] Unit tests: movePaneBetweenTabs logic

### Block 5: Configure Command Dialog + Direct Process -- 75min

**Type:** Feature slice
**Dependencies:** Block 1 (context menu)
**Packages:** web, hub, shared, agent

**Files:**
- `packages/clients/web/src/components/ConfigureCommandDialog.vue` -- modal with program/args/cwd/icon/directProcess fields
- `packages/shared/src/protocol.ts` -- extend SPAWN message with shell/args/cwd/directProcess
- `packages/hub/src/api/channels.ts` -- extend PATCH /api/channels/:id with new fields
- `packages/hub/src/dal/meta-dal.ts` -- channels table migration (icon, shell, args, cwd, direct_process)
- `packages/hub/src/session-manager.ts` -- use channel config on spawn/restart
- `packages/agent/src/pty-manager.ts` -- honor shell/args/cwd from SPAWN if provided
- `packages/clients/web/src/components/TerminalPane.vue` -- exit overlay for direct process channels

**Exit criteria:**
- [ ] Configure Command dialog opens from tab/channel context menu
- [ ] PATCH /api/channels/:id persists shell/args/cwd/icon/directProcess
- [ ] SPAWN message carries configured shell/args/cwd
- [ ] Agent spawns configured process instead of default shell
- [ ] Direct process channels show exit overlay with Restart/Configure/Close
- [ ] Restart re-spawns same command via POST /api/channels/:id/restart
- [ ] Integration tests: spawn with custom command, restart

### Block 6: Channel Sidebar Context Menu + States -- 45min

**Type:** Feature slice
**Dependencies:** Block 2, Block 5
**Packages:** web

**Files:**
- `packages/clients/web/src/components/ChannelContextMenu.vue` -- context menu for sidebar items
- `packages/clients/web/src/components/ChannelItem.vue` -- right-click handler, state-based icon rendering (filled/open/dim dot)
- `packages/clients/web/src/components/ChannelSidebar.vue` -- wire context menu

**Exit criteria:**
- [ ] Right-click channel shows context menu (Open in New Tab, Open in Current Tab, Rename, Configure Command, Set as Welcome, Restart, Destroy)
- [ ] "Restart" only visible when channel state = exited
- [ ] Channel icons: filled dot (active+visible), open dot (detached), dim dot (exited), star (welcome)
- [ ] "Open in New Tab" creates tab with channel
- [ ] "Destroy" kills channel definitively

### Block 7: Settings + Confirmations -- 45min

**Type:** Feature slice
**Dependencies:** Block 1
**Packages:** web, hub

**Files:**
- `packages/clients/web/src/components/ConfirmDialog.vue` -- generic confirmation dialog with "Remember" checkboxes
- `packages/clients/web/src/composables/useLayout.ts` -- integrate confirmation before close-all/close-others
- `packages/shared/src/config.ts` -- add tabs/panes/channels/startup config interfaces
- `packages/hub/src/config-resolver.ts` -- parse [tabs], [panes], [channels], [startup] from config.toml

**Exit criteria:**
- [ ] "Close All" and "Close Others" show confirmation dialog
- [ ] "Remember for this host" and "Remember globally" checkboxes work
- [ ] Remembered preference persisted via config cascade
- [ ] Tab settings (closeButton, newTabPosition, etc.) read from config
- [ ] Pane settings (maxPanes, defaultSplitDirection, etc.) respected
- [ ] Unit tests: confirmation logic, config parsing

## 7. Test Strategy

### Test Pyramid

| Level | Count | Focus |
|-------|-------|-------|
| Unit | ~30 | Layout mutations, close logic, DnD validation, config |
| Integration | ~12 | Welcome API, channel PATCH, restart, spawn with config |
| E2E | ~5 | Context menu flow, DnD flow, welcome tab, direct process |

### Test Data Requirements

**Fixtures:**
- Multi-tab layout with 2-4 tabs and splits
- Channel list with mixed states (active, detached, exited)
- Host with welcome tab configured

**Mocks:**
- HTML5 Drag API (DataTransfer, DragEvent)
- localStorage for layout persistence
- WS client for spawn/attach messages

## 8. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Cross-tab DnD complexity | H | M | Start with basic single-direction drop, iterate |
| Vacant pane picker UX | M | L | Minimal viable picker first, polish in review |
| DB migration for 5 new columns | M | L | Single ALTER TABLE migration, all DEFAULT NULL |
| PaneLayout type change breaks persistence | M | M | Validate on load, fallback to fresh layout |
| DirectProcess spawn requires agent changes | M | L | Agent already has shell param, just needs forwarding |
| PaneLayout.type exhaustive matching | H | M | Grep all switch/if on PaneLayout.type before merging Block 2; add "vacant" case everywhere |
| DB migration coordination with UX-02 | M | L | Combine channel column additions (UX-01 + UX-02) into single migration |

## 9. Definition of Done

- [ ] All 7 blocks implemented
- [ ] All 21 BDD scenarios have passing tests
- [ ] All tests pass (unit + integration)
- [ ] Lint/typecheck pass
- [ ] Tab context menu fully functional
- [ ] Cross-tab DnD works for same-host tabs
- [ ] Welcome tab auto-opens and survives Close All
- [ ] Direct process channels show exit overlay
- [ ] Code review clean (no blocking findings)

## 10. Dependencies & Integration Notes

### UX-02 (Terminal Title) Integration

Block 7 of this spec defines tab title settings (`[tabs.title]`). UX-02 provides
the dynamic title source (OSC 0/2). The title priority chain (custom > dynamic >
fallback) is defined in UX-01 but implemented jointly: UX-01 handles the
custom/fallback logic, UX-02 handles the dynamic source.

### UX-06 (Theming) Dependency

All new components (context menus, vacant picker, configure dialog, confirm
dialog) must use `var(--nt-*)` CSS variables from UX-06. UX-06 MUST be
implemented first.

### Existing Code

The `useLayout.ts` composable, `PaneLayout.vue`, `PaneSplitter.vue`, and
`TabBar.vue` already exist and handle basic tab/split/close operations. This
spec EXTENDS them, not replaces. The `"vacant"` PaneLayout type is the main
structural addition.
