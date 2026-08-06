---
doc-meta:
  status: canonical
  adversarial_applied: true
  llm_reviewed: true
  scope: web
  type: specification
  target_project: /mnt/wsl/shared/dev/lasterm
  created: 2026-03-09
  updated: 2026-03-09
  complexity: COMPLEX
  time-budget: 4h
---

# UX-11 — Connection Experience

## 0. Quick Reference

| Item | Value |
|------|-------|
| Scope | web (UI-only, no schema/protocol changes) |
| Complexity | COMPLEX |
| Time budget | 4h |
| Blocks | 6 |
| BDD scenarios | 37 |
| Risk level | LOW |

## 1. Problem Statement

The host creation/editing modal uses a flat form with a collapsible "Advanced"
section that hides important settings. The command palette (Ctrl+P) provides
basic substring search without fuzzy matching, prefix filters, or extended
actions. The host rail shows only initials and status dots, lacking connection
context at a glance. Together these gaps slow down power users navigating many
hosts and confuse new users configuring their first connection.

## 2. User Stories

### US-01: Power User Navigation
AS A power user managing 20+ hosts
I WANT a command palette (Cmd+K) with fuzzy search, prefix filters, and rich
descriptions
SO THAT I can switch hosts, channels, and trigger actions without touching the
mouse

ACCEPTANCE: Cmd+K opens palette, fuzzy match finds "prod" in
"my-production-server", `@` prefix filters to hosts only, recent items shown
when query is empty

### US-02: New User Onboarding
AS A new user setting up my first SSH connection
I WANT a clear, tabbed form with smart defaults and contextual help
SO THAT I understand each field without reading documentation

ACCEPTANCE: Modal has 3 tabs (Connection, Terminal, Appearance), auth method
selection hides irrelevant fields, port shows "22" as placeholder, typing
`root@192.168.1.1:2222` auto-fills hostname/user/port

### US-03: At-a-Glance Host Context
AS A user with multiple similar hosts
I WANT to see connection details (user@host:port) in the host rail
SO THAT I can distinguish hosts without hovering or opening edit

ACCEPTANCE: Subtitle appears below host badge in rail, tooltip shows connection
duration and channel count

## 3. Business Rules

### 3.1 Invariants

- INV-01: Command palette keybinding is Cmd+K (macOS) / Ctrl+K (Windows/Linux).
  Ctrl+P/Cmd+P no longer opens the palette.
- INV-02: Quick connect is a one-way binding: changes to the quick connect
  field always overwrite sshHost/sshUser/sshPort with the parsed values.
  Clearing the quick connect field does NOT clear the individual fields.
- INV-03: Port defaults to 22 when field is empty (placeholder, not value).
- INV-04: Fuzzy matching scores must be deterministic — same query + same data =
  same ranking.
- INV-05: Modal tab state resets to "Connection" when opening for a new host.
  When editing, tab state persists within the session.
- INV-06: Prefix filters are single-character: `>` (actions), `@` (hosts),
  `#` (channels). The prefix character is stripped from the search query.
- INV-07: Recent items are stored in localStorage (key: `lasterm:palette-recent`)
  as an array of item IDs (not full objects — survives host renames), max 8
  entries, MRU eviction (most recently used moves to front).
- INV-08: Fuzzy scoring uses named constants (EXACT_MATCH_SCORE,
  PREFIX_MATCH_SCORE, SUBSTRING_MATCH_SCORE, FUZZY_MATCH_BASE). No regex on
  user input — fuzzyMatch operates character-by-character.
- INV-09: Prefix filter with empty query after prefix (e.g., `>` alone) shows
  all items of that type unfiltered.
- INV-10: Save with empty port field omits sshPort from API body (not 0, not
  null) — server applies default 22.
- INV-11: Host preview respects iconType: emoji → show iconValue emoji, auto →
  show computed initials, image → show image.
- INV-12: Modal tabs use ARIA roles: `role="tablist"` on container,
  `role="tab"` + `aria-selected` on headers, `role="tabpanel"` +
  `aria-labelledby` on content panels. Hidden panels get `aria-hidden="true"`.
- INV-13: Auth method change clears irrelevant fields: switching from "key" to
  "agent" clears sshKeyPath. Hidden fields are excluded from the save body.
- INV-14: Quick connect parser accepts optional `ssh://` prefix (stripped
  before parsing). Supports `ssh://user@host:port`.
- INV-15: Quick connect reacts to `input` event (covers paste, drag-drop,
  autocomplete), not just keystrokes.
- INV-16: Tab headers show a validation error indicator (red dot) in real-time
  when any field within that tab has a validation error.

### 3.2 Preconditions

- PRE-01: Quick connect field is only shown in "Manual" source mode (not SSH
  config mode, where fields are pre-populated from config).
- PRE-02: Host preview widget requires a non-empty label to render.
- PRE-03: Connection string subtitle in rail only displays for SSH hosts
  (local host shows "Local").

### 3.3 Effects

- EFF-01: Quick connect parse: typing `user@host:port` sets form.sshUser,
  form.sshHost, form.sshPort. Partial formats supported:
  - `host` → sshHost only
  - `user@host` → sshUser + sshHost
  - `host:port` → sshHost + sshPort
  - `user@host:port` → all three
- EFF-02: Auth method change: selecting "agent" hides keyPath field, selecting
  "password" hides keyPath field, selecting "key" shows keyPath field.
- EFF-03: Palette prefix filter: typing `>settings` shows only actions matching
  "settings". Typing `@prod` shows only hosts matching "prod".
- EFF-04: Palette recent items: executing an item pushes it to front of recents
  list. Duplicates are deduplicated (moved to front, not added twice).
- EFF-05: New palette actions are registered:
  - `action:add-host` — opens Add Host modal
  - `action:settings` — opens Settings panel
  - `action:ssh-import` — opens Batch Import modal
  - `action:toggle-sidebar` — toggles channel sidebar visibility
- EFF-06: Connection string subtitle format: `user@host:port` (port omitted if
  22, user omitted if not set). CSS `text-overflow: ellipsis` with
  `max-width` = rail width for long hostnames.
- EFF-07: Recent items are filtered against existing items before display —
  deleted hosts/channels are silently removed from recents.
- EFF-08: When Save is clicked with validation errors, modal auto-switches to
  the first tab containing an error (Connection > Terminal > Appearance).

### 3.4 Error Handling

- ERR-01: Quick connect with invalid port (non-numeric, <1, >65535) → ignore
  port part, leave field empty.
- ERR-02: Quick connect with IPv6 address (contains `:`) → detect `[::1]:port`
  and `user@[::1]:port` bracket syntax, parse correctly.
- ERR-03: Fuzzy match with empty query → show recent items (if any), then all
  items ungrouped.
- ERR-04: localStorage unavailable (private browsing) → recent items degrade
  gracefully to empty list, no error.

## 4. Technical Design

### 4.1 Architecture Decisions

**Fuzzy matching**: Custom scoring function (~40 lines), no external dependency.
No regex on user input — operates character-by-character to avoid metachar
issues (e.g., `c++`, `host.name`). Score formula uses named constants:
EXACT_MATCH_SCORE (1000) > PREFIX_MATCH_SCORE (500 + length bonus) >
SUBSTRING_MATCH_SCORE (200 + position bonus) > FUZZY_MATCH_BASE (sum of
position-weighted hits). Word boundary bonus: characters matching at the start
of a word (after `-`, `_`, `.`, or at string start) score higher. Sufficient
for datasets <500 items.

**Quick connect parser**: Regex-based, handles 4 formats + IPv6 bracket syntax.
Lives in useHostForm composable as a `parseConnectionString(input: string)`
function.

**Modal tabs**: Vue component-level tabs (no router), using a `activeTab` ref
with values `"connection" | "terminal" | "appearance"`. Tab content rendered
via `v-show` (not `v-if`) to preserve form state across tab switches.

**Recent items**: `useRecentPaletteItems()` composable, localStorage-backed,
returns `{ recentItems, pushRecent, clearRecent }`. Separated from
useCommandPalette to keep concerns clean.

### 4.2 Data Model Changes

None. All changes are UI-only.

### 4.3 API Contract Changes

None. All changes are UI-only.

## 5. Acceptance Criteria (BDD)

### Scenario Group: Quick Connect (A1)

```gherkin
@priority:high @type:nominal
Scenario: SC-01 Parse full connection string
  Given the Add Host modal is open in Manual mode
  When the user types "deploy@prod.example.com:2222" in the quick connect field
  Then sshHost is set to "prod.example.com"
  And sshUser is set to "deploy"
  And sshPort is set to 2222

@priority:high @type:nominal
Scenario: SC-02 Parse host-only string
  Given the Add Host modal is open in Manual mode
  When the user types "192.168.1.50" in the quick connect field
  Then sshHost is set to "192.168.1.50"
  And sshUser remains empty
  And sshPort remains empty (placeholder 22)

@priority:medium @type:edge
Scenario: SC-03 Parse user@host without port
  Given the Add Host modal is open in Manual mode
  When the user types "root@myserver" in the quick connect field
  Then sshHost is set to "myserver"
  And sshUser is set to "root"
  And sshPort remains empty

@priority:medium @type:edge
Scenario: SC-04 Parse IPv6 with bracket syntax
  Given the Add Host modal is open in Manual mode
  When the user types "[::1]:2222" in the quick connect field
  Then sshHost is set to "::1"
  And sshPort is set to 2222

@priority:medium @type:edge
Scenario: SC-04b Parse user@IPv6 with bracket syntax
  Given the Add Host modal is open in Manual mode
  When the user types "root@[fd00::1]:2222" in the quick connect field
  Then sshUser is set to "root"
  And sshHost is set to "fd00::1"
  And sshPort is set to 2222

@priority:medium @type:edge
Scenario: SC-04c Parse ssh:// prefix
  Given the Add Host modal is open in Manual mode
  When the user pastes "ssh://deploy@web.io:2222" in the quick connect field
  Then sshUser is set to "deploy"
  And sshHost is set to "web.io"
  And sshPort is set to 2222

@priority:medium @type:error
Scenario: SC-05 Invalid port ignored
  Given the Add Host modal is open in Manual mode
  When the user types "host:99999" in the quick connect field
  Then sshHost is set to "host"
  And sshPort remains empty
```

### Scenario Group: Auth Method UX (A2)

```gherkin
@priority:high @type:nominal
Scenario: SC-06 Key auth shows key path field
  Given the Add Host modal is open
  When the user selects auth method "key"
  Then the key path input field is visible
  And no info note is shown

@priority:high @type:nominal
Scenario: SC-07 Agent auth hides key path
  Given the Add Host modal is open
  When the user selects auth method "agent"
  Then the key path input field is hidden
  And an info note "SSH agent will be used" is visible

@priority:high @type:nominal
Scenario: SC-08 Password auth shows prompt note
  Given the Add Host modal is open
  When the user selects auth method "password"
  Then the key path input field is hidden
  And an info note "Password prompted at connect" is visible
```

### Scenario Group: Port Placeholder (A3)

```gherkin
@priority:high @type:nominal
Scenario: SC-09 Port shows placeholder not default value
  Given the Add Host modal is open for a new host
  Then the port field value is empty
  And the port field placeholder is "22"

@priority:medium @type:edge
Scenario: SC-10 Empty port saves as undefined
  Given the Add Host modal is open with port field empty
  When the user saves the host
  Then sshPort is sent as null/undefined to the API (server defaults to 22)
```

### Scenario Group: Host Preview (A4)

```gherkin
@priority:high @type:nominal
Scenario: SC-11 Preview updates with label
  Given the Add Host modal is open
  When the user types "production" in the label field
  Then the host preview widget shows initials "PR" in a badge
  And the preview badge matches the selected color

@priority:medium @type:nominal
Scenario: SC-12 Preview shows custom color
  Given the Add Host modal is open with label "staging"
  When the user selects color "#ff6600" in the Appearance tab
  Then the preview badge background is "#ff6600"

@priority:medium @type:edge
Scenario: SC-13 Preview hidden when label empty
  Given the Add Host modal is open
  When the label field is empty
  Then the host preview widget is not rendered

@priority:medium @type:edge
Scenario: SC-11b Preview shows emoji when iconType is emoji
  Given the Add Host modal is open with label "staging"
  When the user sets iconType to "emoji" and iconValue to "🔥"
  Then the preview shows "🔥" instead of initials

@priority:medium @type:nominal
Scenario: SC-10c Tab header shows error indicator
  Given the Add Host modal is open on the Connection tab
  And the hostname field is empty (required)
  Then the Connection tab header shows a red error dot
  And the Terminal and Appearance tab headers have no error dot

@priority:medium @type:edge
Scenario: SC-10b Save auto-switches to tab with validation error
  Given the Add Host modal is open on the Appearance tab
  And the hostname field (Connection tab) is empty
  When the user clicks Save
  Then the modal switches to the Connection tab
  And the hostname field shows a validation error
```

### Scenario Group: Command Palette v2 (B1')

```gherkin
@priority:high @type:nominal
Scenario: SC-14 Cmd+K opens palette (keybinding change)
  Given the app is loaded
  When the user presses Cmd+K (macOS) or Ctrl+K (Windows/Linux)
  Then the command palette opens
  And pressing Ctrl+P does NOT open the palette

@priority:high @type:nominal
Scenario: SC-15 Fuzzy matching ranks by relevance
  Given hosts exist: "my-production-server", "dev-proxy", "prod-db"
  When the user opens the palette and types "prod"
  Then "prod-db" ranks first (prefix match)
  And "my-production-server" ranks second (substring match)
  And "dev-proxy" is excluded (no match)

@priority:high @type:nominal
Scenario: SC-16 Prefix filter @ shows hosts only
  Given hosts and channels and actions exist
  When the user types "@prod" in the palette
  Then only hosts matching "prod" are shown
  And no channels or actions appear in results

@priority:medium @type:edge
Scenario: SC-16b Prefix filter with empty query shows all of type
  Given 3 hosts and 5 actions exist
  When the user types ">" in the palette (prefix only, no query)
  Then all 5 actions are shown
  And no hosts or channels appear

@priority:high @type:nominal
Scenario: SC-17 Prefix filter > shows actions only
  Given hosts and actions exist
  When the user types ">set" in the palette
  Then only actions matching "set" are shown (e.g., "Settings")
  And no hosts or channels appear

@priority:high @type:nominal
Scenario: SC-18 Prefix filter # shows channels only
  Given channels exist with titles "bash", "zsh"
  When the user types "#bash" in the palette
  Then only channels matching "bash" are shown

@priority:high @type:nominal
Scenario: SC-19 Host search includes hostname
  Given a host with label "production" and sshHost "10.0.0.5"
  When the user types "10.0.0" in the palette
  Then the host "production" appears in results (matched by hostname)

@priority:high @type:nominal
Scenario: SC-20 Rich descriptions show connection info
  Given a host with label "web", sshUser "deploy", sshHost "web.io", sshPort 22
  When the host appears in palette results
  Then its description shows "deploy@web.io"
  And the type badge shows "Host"

@priority:medium @type:nominal
Scenario: SC-21 Recent items shown on empty query
  Given the user previously executed "production" host from the palette
  When the user opens the palette with empty query
  Then "production" appears in a "Recent" section at the top

@priority:medium @type:nominal
Scenario: SC-19b Fuzzy word boundary bonus
  Given hosts exist: "production-database-server", "prod-db"
  When the user types "pds" in the palette
  Then "production-database-server" appears (word boundary: p...d...s)

@priority:medium @type:nominal
Scenario: SC-22 Extended action: Add Host
  Given the palette is open
  When the user types ">add"
  Then "Add Host" action appears in results
  And executing it opens the Add Host modal

@priority:medium @type:nominal
Scenario: SC-23 Extended action: Settings
  Given the palette is open
  When the user types ">settings"
  Then "Settings" action appears in results
  And executing it opens the Settings panel

@priority:medium @type:edge
Scenario: SC-24 Recent items deduplication
  Given the user executes "production" host twice from the palette
  Then the recent items list contains "production" only once (at front)

@priority:medium @type:edge
Scenario: SC-24b Recent items with deleted host
  Given "staging" host was in recent items
  When the "staging" host is deleted
  And the palette opens with empty query
  Then "staging" does NOT appear in recent items

@priority:low @type:error
Scenario: SC-25 localStorage unavailable
  Given localStorage is not available (private browsing)
  When the palette opens with empty query
  Then no recent items section is shown
  And no error is thrown
```

### Scenario Group: Connection String Display (B2)

```gherkin
@priority:high @type:nominal
Scenario: SC-26 SSH host shows subtitle in rail
  Given a host with label "web", sshUser "deploy", sshHost "web.io", sshPort 2222
  Then the host rail item shows subtitle "deploy@web.io:2222"

@priority:medium @type:edge
Scenario: SC-27 Default port omitted from subtitle
  Given a host with sshUser "root", sshHost "db.local", sshPort 22
  Then the subtitle shows "root@db.local" (no :22)

@priority:medium @type:edge
Scenario: SC-28 Local host shows "Local" subtitle
  Given the local host exists
  Then its rail item shows subtitle "Local"
```

### Coverage Matrix

| Scenario | Nominal | Edge | Error |
|----------|---------|------|-------|
| SC-01 | x | | |
| SC-02 | x | | |
| SC-03 | | x | |
| SC-04 | | x | |
| SC-04b | | x | |
| SC-05 | | | x |
| SC-06 | x | | |
| SC-07 | x | | |
| SC-08 | x | | |
| SC-09 | x | | |
| SC-10 | | x | |
| SC-10b | | x | |
| SC-11 | x | | |
| SC-11b | | x | |
| SC-12 | x | | |
| SC-13 | | x | |
| SC-14 | x | | |
| SC-15 | x | | |
| SC-16 | x | | |
| SC-16b | | x | |
| SC-17 | x | | |
| SC-18 | x | | |
| SC-19 | x | | |
| SC-20 | x | | |
| SC-21 | x | | |
| SC-22 | x | | |
| SC-23 | x | | |
| SC-24 | | x | |
| SC-24b | | x | |
| SC-25 | | | x |
| SC-26 | x | | |
| SC-27 | | x | |
| SC-28 | | x | |

**Totals: 20 nominal, 15 edge, 2 error** (no security scenarios needed — all
changes are local UI state, no auth/data boundaries crossed)

**Adversarial additions (+5):** SC-04b, SC-10b, SC-11b, SC-16b, SC-24b
**LLM review additions (+4):** SC-04c (ssh://), SC-10c (tab error dot),
SC-19b (word boundary), SC-05b (auth field clear — covered by INV-13)

## 6. Implementation Plan

### Block 1: Port Placeholder + Auth Method UX — 20min
**Type:** Feature slice
**Dependencies:** None
**Items:** A3, A2
**Files:**
- `packages/clients/web/src/components/HostModal.vue` — change port field from
  value to placeholder, add v-if/v-show on auth method fields, add info notes
- `packages/clients/web/src/composables/useHostForm.ts` — change sshPort default
  from `22` to `0` (or empty), handle undefined → 22 at save time

**Exit criteria:**
- [ ] Port field shows "22" as placeholder, empty by default (SC-09, SC-10)
- [ ] Auth "key" shows key path, "agent"/"password" hide it with info note (SC-06..08)
- [ ] Tests: 5 unit tests for auth method visibility + port placeholder behavior

### Block 2: Quick Connect Parser — 30min
**Type:** Feature slice
**Dependencies:** Block 1 (port is now placeholder-based)
**Items:** A1
**Files:**
- `packages/clients/web/src/composables/useHostForm.ts` — add
  `parseConnectionString(input: string)` function, add `quickConnect` ref,
  add watcher to parse and auto-fill form fields
- `packages/clients/web/src/components/HostModal.vue` — add quick connect input
  field above hostname/port/user fields in Connection section

**Exit criteria:**
- [ ] All 4 formats parsed correctly (SC-01..04), including user@IPv6 (SC-04b)
- [ ] Invalid port ignored (SC-05)
- [ ] Tests: 9 unit tests for parseConnectionString (4 formats + IPv6 bare +
  user@IPv6 + invalid port + empty string + host:port)

### Block 3: Modal Tabs — 40min
**Type:** Refactor
**Dependencies:** Blocks 1-2 (form fields settled)
**Items:** B3
**Files:**
- `packages/clients/web/src/components/HostModal.vue` — replace
  `<details class="advanced-section">` with tab navigation. Three tabs:
  Connection (hostname, port, user, auth, key, quick connect, test button),
  Terminal (default shell, keep-alive, history, remote hints),
  Appearance (VisualProfileSettings component). Use `v-show` for tab content.

**Exit criteria:**
- [ ] Three tabs render with correct content distribution
- [ ] Tab state persists within modal session (v-show, not v-if)
- [ ] Default tab is "Connection" on add, preserved on edit
- [ ] Save with validation error auto-switches to first errored tab (SC-10b)
- [ ] Tests: 4 unit tests for tab switching + content visibility + error tab switch

### Block 4: Host Preview in Modal — 30min
**Type:** Feature slice
**Dependencies:** Block 3 (tabs exist, preview placement decided)
**Items:** A4
**Files:**
- `packages/clients/web/src/components/HostModal.vue` — add preview widget in
  modal header area (above tabs). Shows badge with initials (same logic as
  HostRail), color from form.color, status dot mock (gray).
- `packages/clients/web/src/composables/useHostForm.ts` — add `initials`
  computed (first 2 chars of label, uppercased)

**Exit criteria:**
- [ ] Preview updates reactively with label and color (SC-11, SC-12)
- [ ] Preview hidden when label empty (SC-13)
- [ ] Preview shows emoji when iconType="emoji" (SC-11b)
- [ ] Tests: 4 unit tests for initials, emoji icon, color, hidden-when-empty

### Block 5: Connection String in Rail — 30min
**Type:** Feature slice
**Dependencies:** None (independent of modal changes)
**Items:** B2
**Files:**
- `packages/clients/web/src/components/HostRail.vue` — add subtitle line below
  badge (when rail is wide enough / labels shown), update `getTooltip()` to
  include channel count and connection duration
- `packages/clients/web/src/composables/useHostGroups.ts` — (if exists) or
  inline in HostRail: add `getSubtitle(host)` helper returning formatted
  connection string

**Exit criteria:**
- [ ] SSH hosts show `user@host:port` subtitle, port omitted if 22 (SC-26, SC-27)
- [ ] Local host shows "Local" subtitle (SC-28)
- [ ] Tests: 4 unit tests for subtitle formatting (full, no-port, no-user, local)

### Block 6: Command Palette v2 — 90min
**Type:** Feature slice
**Dependencies:** None (independent of modal/rail changes)
**Items:** B1'
**Files:**
- `packages/clients/web/src/composables/useCommandPalette.ts` — refactor
  `results` computed:
  - Replace substring filter with `fuzzyMatch(query, text): number` scoring
  - Add prefix detection (`>`, `@`, `#`) with type filtering
  - Search hosts by `label + sshHost` (concatenated)
  - Add `description` field to PaletteItem (rich subtitle)
  - Register 4 new actions (add-host, settings, ssh-import, toggle-sidebar)
  - Sort results by fuzzy score descending
- `packages/clients/web/src/composables/useRecentPaletteItems.ts` — new
  composable: `{ recentItems, pushRecent, clearRecent }`, localStorage-backed,
  max 5 items, FIFO eviction, deduplication
- `packages/clients/web/src/components/CommandPalette.vue` — add description
  line under item label, add "Recent" group header, update empty state
- `packages/clients/web/src/App.vue` — change keybinding from `p`/`P` to
  `k`/`K` in `onGlobalKeydown()`

**Exit criteria:**
- [ ] Cmd+K/Ctrl+K opens palette, Ctrl+P does not (SC-14)
- [ ] Fuzzy matching with relevance ranking (SC-15)
- [ ] Prefix filters work for all 3 types (SC-16..18)
- [ ] Host search includes sshHost (SC-19)
- [ ] Rich descriptions on host items (SC-20)
- [ ] Recent items on empty query (SC-21, SC-24, SC-24b, SC-25)
- [ ] Prefix with empty query shows all of type (SC-16b)
- [ ] New actions: Add Host, Settings (SC-22, SC-23)
- [ ] Tests: 18 unit tests (fuzzy scoring, prefix parsing incl. empty-after-prefix,
  recent items CRUD + deleted item filtering, new actions, keybinding,
  description formatting)

## 7. Test Strategy

### Test Pyramid

| Level | Count | Focus |
|-------|-------|-------|
| Unit | ~43 | Fuzzy matching, parsing, formatting, composable logic |
| Integration | 0 | No API changes |
| E2E | 0 | Optional manual verification via dev server |

### Test Data Requirements

- **Fixtures:** Mock host list (5 hosts with varied labels/hostnames), mock
  channel list (3 channels), mock action list
- **Mocks:** `useHostsStore` (sortedHosts), `useChannelsStore` (channels),
  `useLayout` (splitPane, closeTab), `useAuthStore`, `useWriteLockStore`,
  localStorage (for recent items)
- **New test files:**
  - `useCommandPalette.spec.ts` — extend existing 18 tests with ~15 new
  - `useRecentPaletteItems.spec.ts` — ~5 tests
  - `useHostForm.spec.ts` — extend with ~8 tests for parseConnectionString
  - `HostModal.spec.ts` — extend with ~7 tests for tabs + auth UX + preview
  - `HostRail.spec.ts` — extend with ~3 tests for subtitle

### Fuzzy Match Test Cases

| Query | Input | Expected Score | Reason |
|-------|-------|---------------|--------|
| "prod" | "prod-db" | 500+ | Prefix match |
| "prod" | "my-production-server" | 200+ | Substring match |
| "prod" | "dev-proxy" | 0 | No match |
| "pdb" | "prod-db" | 50+ | Fuzzy: p...d...b |
| "" | any | 0 | Empty query matches all (no scoring) |

## 8. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Fuzzy match too slow on 500+ hosts | L | L | Score is O(n*m) per item, <1ms for 500 items |
| Modal tab refactor breaks existing tests | M | M | v-show preserves DOM, tests should still find elements |
| Ctrl+K conflicts with browser "focus URL bar" | M | M | preventDefault() stops browser default; document in help |
| Recent items localStorage quota | L | L | Max 5 items = ~500 bytes, negligible |
| Recent items reference deleted host | M | M | Filter recents against existing store items before display |
| Cross-tab validation blind spot | M | M | Auto-switch to first tab with error on Save |

## 9. Definition of Done

- [ ] All 6 blocks implemented
- [ ] All 37 BDD scenarios have passing tests
- [ ] All tests pass (unit: ~48 new + existing)
- [ ] `pnpm lint` clean
- [ ] `pnpm -F @lasterm/web build` succeeds (vue-tsc)
- [ ] Manual smoke test: Cmd+K, fuzzy search, prefix filters, quick connect,
  modal tabs, host preview, rail subtitles
- [ ] Code review clean (no blocking findings)
