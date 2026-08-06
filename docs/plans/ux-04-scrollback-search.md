---
doc-meta:
  status: canonical
  scope: ui
  type: specification
  target_project: /mnt/wsl/shared/dev/lasterm
  created: 2026-03-07
  updated: 2026-03-07
  complexity: COMPLEX
  time-budget: 5h
---

# Specification: UX-04 Scrollback Search

## 0. Quick Reference (ALWAYS VISIBLE)

| Item | Value |
|------|-------|
| Scope | ui |
| Complexity | COMPLEX |
| Time budget | 5h |
| Blocks | 6 |
| BDD scenarios | 18 |
| Risk level | LOW |

## 1. Problem Statement

Users cannot search terminal scrollback. When output scrolls past, the only
option is manual scrolling. Every major terminal (iTerm2, WezTerm, Windows
Terminal, VS Code) has Ctrl+F or Ctrl+Shift+F search. xterm.js provides
SearchAddon but lasterm does not integrate it. This is a baseline feature gap.

## 2. User Stories

### US-1: Basic Scrollback Search

AS A developer reviewing terminal output
I WANT to search the scrollback buffer with highlighting and match navigation
SO THAT I can quickly find specific output (error messages, log lines, etc.)

ACCEPTANCE: Ctrl+Shift+F opens search overlay; typing highlights all matches;
Enter/Shift+Enter navigates between matches; Escape closes and refocuses terminal.

### US-2: Search Options & Scope

AS A power user working with split panes
I WANT regex/case/whole-word toggles and the ability to search across all panes
SO THAT I can find patterns efficiently regardless of which pane contains them

ACCEPTANCE: Toggles work correctly; "All panes" scope searches every pane in the
tab and navigates focus to the matching pane.

### US-3: Visual Feedback & History

AS a user frequently searching the same patterns
I WANT scrollbar markers showing match positions and a search history dropdown
SO THAT I can see match distribution at a glance and reuse previous searches

ACCEPTANCE: Yellow markers in scrollbar at match positions; dropdown shows
last 20 searches; regex searches show badge.

## 3. Business Rules

### 3.1 Invariants (always true)

- INV-01: Search is per-pane by default. Multi-pane scope is opt-in via toggle.
- INV-02: Search operates on xterm.js scrollback buffer (client-side only, no hub query).
- INV-03: Match highlighting uses theme colors (`searchHighlight` / `searchHighlightActive` from UX-06).
- INV-04: Search overlay never captures terminal keyboard input when closed.
- INV-05: Search history is stored in localStorage (per-browser, not synced).
- INV-06: Vacant panes are not searchable.
- INV-07: Scrollbar markers must be capped at ~100 per pane. When matches exceed 100, aggregate nearby markers.
- INV-08: Search on a live terminal (output still arriving) may produce changing match counts. This is expected behavior, not a bug.
- INV-09: Addon loading order in useTerminal: SearchAddon loads AFTER theme is applied (theme decorations need theme colors).

### 3.2 Preconditions (required before action)

- PRE-01: xterm.js SearchAddon must be loaded on each terminal instance.
- PRE-02: Search overlay requires at least one non-vacant pane in the active tab.
- PRE-03: Scrollbar markers require scrollbarMarkers setting enabled (default true).

### 3.3 Effects (what changes)

- EFF-01: Opening search focuses the search input; terminal input paused while search focused.
- EFF-02: Typing in search field triggers `findNext()` on each keystroke (incremental search).
- EFF-03: Enter navigates to next match; Shift+Enter to previous match.
- EFF-04: Toggling case/regex/wholeWord re-triggers search with updated options.
- EFF-05: "All panes" scope: when a match is in another pane, that pane receives focus and scrolls to match.
- EFF-06: Closing search clears decorations (or fades/persists per setting).
- EFF-07: Search query is added to history on Enter (deduplicated, most recent first).

### 3.4 Error Handling

- ERR-01: Invalid regex pattern -> show inline error, keep last valid results, do not crash.
- ERR-02: No matches found -> show "0/0" count, no navigation.
- ERR-03: Search on exited channel -> still works (frozen buffer is searchable).

## 4. Technical Design

### 4.1 Architecture Decision

**xterm.js SearchAddon is the search engine.** No custom search implementation.
The addon handles scrollback traversal, match finding, decoration rendering,
and scroll-to-match. lasterm provides the overlay UI, keyboard shortcuts,
multi-pane scope, scrollbar markers, and history.

**Overlay position is configurable** with 3 options: top-right (default),
bottom-right, bottom-bar (full-width sticky). Position is a global setting,
not per-pane.

### 4.2 Data Model Changes

| Entity | Change | Migration needed |
|--------|--------|------------------|
| No DB changes | Search is entirely client-side | No |
| localStorage | `lasterm:search-history` key (JSON array) | No |

### 4.3 SearchAddon API

```typescript
// Loaded per terminal instance
const searchAddon = new SearchAddon()
terminal.loadAddon(searchAddon)

// Core API
searchAddon.findNext(query, { regex, caseSensitive, wholeWord, decorations })
searchAddon.findPrevious(query, options)
searchAddon.clearDecorations()

// Decoration options
decorations: {
  matchBackground: theme.searchHighlight,       // from UX-06 theme
  activeMatchBackground: theme.searchHighlightActive,
  matchOverviewRuler: theme.searchHighlight     // scrollbar marker color
}
```

### 4.4 Search Overlay Structure

```
Compact (top-right / bottom-right):
+----------------------------------------------+
| [search input        ]  1/3  [<] [>] [x]    |
+----------------------------------------------+

Expanded (toggle or option active):
+----------------------------------------------+
| [search input        ]  1/3  [<] [>] [x]    |
| [Aa] [.*] [W]  [scope: this pane v]         |
+----------------------------------------------+

Bottom-bar (full-width, always expanded):
+------------------------------------------------------+
| Search: [query...          ]  1/3  < >  [Aa] [.*] [W]  [scope v]  x |
+------------------------------------------------------+
```

### 4.5 Scrollbar Markers

Map match line numbers to scrollbar height percentage:

```typescript
function computeMarkers(matches: {line: number}[], totalLines: number, scrollbarHeight: number): {top: number}[] {
  return matches.map(m => ({ top: (m.line / totalLines) * scrollbarHeight }))
}
```

Rendered as thin (2px) horizontal lines in an overlay div positioned over the
xterm.js scrollbar area. Color from theme `searchHighlight`.

## 5. Acceptance Criteria (BDD)

### Scenario Group: Basic Search (US-1)

```gherkin
@priority:high @type:nominal
Scenario: SC-01 -- Open search with keyboard shortcut
  Given a terminal pane is focused
  When the user presses Ctrl+Shift+F
  Then the search overlay appears at configured position
  And the search input is focused
  And the terminal stops receiving keyboard input

@priority:high @type:nominal
Scenario: SC-02 -- Incremental search with highlighting
  Given the search overlay is open
  When the user types "error"
  Then all occurrences of "error" in the scrollback are highlighted
  And the match count shows "X/Y" (current/total)
  And the terminal scrolls to the first match

@priority:high @type:nominal
Scenario: SC-03 -- Navigate between matches
  Given search for "error" found 5 matches
  When the user presses Enter
  Then the next match is highlighted as active
  And the terminal scrolls to it
  And the count updates to "2/5"
  When the user presses Shift+Enter
  Then the previous match becomes active (back to "1/5")

@priority:high @type:nominal
Scenario: SC-04 -- Close search and refocus terminal
  Given the search overlay is open
  When the user presses Escape
  Then the search overlay closes
  And match decorations are cleared (per highlightOnClose setting)
  And the terminal regains keyboard focus

@priority:medium @type:edge
Scenario: SC-05 -- Search on exited channel works
  Given a terminal where the process has exited (frozen output)
  When the user opens search and types "warning"
  Then matches are found in the frozen buffer
  And navigation works normally

@priority:medium @type:error
Scenario: SC-06 -- No matches shows zero count
  Given the search overlay is open
  When the user types "xyznonexistent"
  Then the match count shows "0/0"
  And no decorations are rendered
  And Enter/Shift+Enter do nothing
```

### Scenario Group: Search Options (US-2)

```gherkin
@priority:high @type:nominal
Scenario: SC-07 -- Case-sensitive toggle
  Given search for "Error" with case-sensitive OFF finds 10 matches
  When the user toggles case-sensitive ON (Alt+C)
  Then only exact-case "Error" matches remain (fewer matches)
  And the count updates

@priority:high @type:nominal
Scenario: SC-08 -- Regex toggle
  Given search for "^\d+\." is entered with regex OFF
  Then it searches for the literal string "^\d+\."
  When the user toggles regex ON (Alt+R)
  Then it searches using the regex pattern
  And matches lines starting with "1.", "2.", etc.

@priority:medium @type:nominal
Scenario: SC-09 -- Whole word toggle
  Given search for "log" with whole-word OFF matches "log", "logging", "dialog"
  When the user toggles whole-word ON (Alt+W)
  Then only standalone "log" matches remain

@priority:medium @type:error
Scenario: SC-10 -- Invalid regex shows error
  Given regex toggle is ON
  When the user types "[invalid("
  Then an inline error message appears ("Invalid regex")
  And no crash occurs
  And previous valid results are kept until a new valid query is entered

@priority:high @type:nominal
Scenario: SC-11 -- All-panes scope searches across splits
  Given a tab with 2 panes [Term1 | Term2]
  And "auth" appears in Term2 but not Term1
  And search is open on Term1 with scope "All panes"
  When the user types "auth"
  Then matches are found in Term2
  And pressing Enter focuses Term2 and scrolls to the match
  And the overlay shows "Match 1/N in: Term2"

@priority:medium @type:edge
Scenario: SC-12 -- Scope toggle only appears with splits
  Given a tab with a single pane (no splits)
  When the search overlay is open
  Then the scope dropdown is hidden
  Given the tab is split into 2 panes
  When the search overlay is reopened
  Then the scope dropdown appears with "This pane" and "All panes"
```

### Scenario Group: Visual Feedback & History (US-3)

```gherkin
@priority:medium @type:nominal
Scenario: SC-13 -- Scrollbar markers at match positions
  Given search for "error" found matches at lines 100, 500, 2000
  And the scrollback has 5000 lines
  When the search is active
  Then yellow markers appear in the scrollbar at 2%, 10%, and 40% positions
  And marker color matches theme.searchHighlight

@priority:medium @type:nominal
Scenario: SC-14 -- Search history dropdown
  Given the user has previously searched "auth", "error", "connection"
  When the user focuses the empty search input
  Then a dropdown shows recent searches: ["connection", "error", "auth"]
  And clicking "error" fills the input and triggers search

@priority:low @type:nominal
Scenario: SC-15 -- Regex searches show badge in history
  Given the user searched "^\d+" with regex ON
  When the history dropdown renders
  Then the entry "^\d+" shows a [.*] badge

@priority:medium @type:nominal
Scenario: SC-16 -- Highlight fade on close
  Given highlightOnClose is "fade"
  When the user closes the search overlay
  Then match decorations fade out over 300ms
  And then are fully removed

@priority:medium @type:edge
Scenario: SC-17 -- History deduplication
  Given "error" is already in history
  When the user searches "error" again and presses Enter
  Then "error" moves to the top of history (not duplicated)
  And history size stays the same

@priority:low @type:nominal
Scenario: SC-18 -- Overlay position configuration
  Given search position is set to "bottom-bar"
  When the user opens search
  Then the search bar appears as a full-width sticky bar at the bottom
  With all toggles inline (no expand button needed)
```

### Coverage Matrix

| Scenario | Nominal | Edge | Error | Security |
|----------|---------|------|-------|----------|
| SC-01 | x | | | |
| SC-02 | x | | | |
| SC-03 | x | | | |
| SC-04 | x | | | |
| SC-05 | | x | | |
| SC-06 | | | x | |
| SC-07 | x | | | |
| SC-08 | x | | | |
| SC-09 | x | | | |
| SC-10 | | | x | |
| SC-11 | x | | | |
| SC-12 | | x | | |
| SC-13 | x | | | |
| SC-14 | x | | | |
| SC-15 | x | | | |
| SC-16 | x | | | |
| SC-17 | | x | | |
| SC-18 | x | | | |

## 6. Implementation Plan

### Block 1: SearchAddon Integration + Basic Search -- 45min

**Type:** Feature slice
**Dependencies:** None (xterm.js dependency only)
**Packages:** web

**Files:**
- `packages/clients/web/src/composables/useTerminalSearch.ts` -- new: SearchAddon lifecycle, findNext/findPrevious, match count tracking, decoration options from theme
- `packages/clients/web/src/composables/useTerminal.ts` -- load SearchAddon on terminal init, expose search composable

**Exit criteria:**
- [ ] SearchAddon loaded on every terminal instance
- [ ] `useTerminalSearch` exposes: search(query, opts), next(), previous(), clear(), matchCount, currentMatch
- [ ] Decoration colors come from UX-06 theme (searchHighlight, searchHighlightActive)
- [ ] Unit tests: search lifecycle, option toggling

### Block 2: Search Overlay UI -- 60min

**Type:** Feature slice
**Dependencies:** Block 1
**Packages:** web

**Files:**
- `packages/clients/web/src/components/SearchOverlay.vue` -- search input, match count, prev/next/close buttons, position variants (top-right, bottom-right, bottom-bar)
- `packages/clients/web/src/components/TerminalPane.vue` -- mount SearchOverlay, wire to useTerminalSearch

**Key implementation details:**
- Overlay positioned absolute within TerminalPane (not body teleport)
- Position class: `search-top-right`, `search-bottom-right`, `search-bottom-bar`
- Input debounce: 0ms for short queries (< 3 chars trigger after 150ms)
- Compact/expanded toggle: click chevron or when any option is active

**Exit criteria:**
- [ ] Ctrl+Shift+F opens overlay in configured position
- [ ] Typing triggers incremental search with highlighting
- [ ] Match count shows "current/total"
- [ ] Prev/Next buttons and Enter/Shift+Enter navigate matches
- [ ] Escape closes overlay and refocuses terminal
- [ ] 3 position variants render correctly

### Block 3: Search Toggles + Keyboard Shortcuts -- 45min

**Type:** Feature slice
**Dependencies:** Block 2
**Packages:** web

**Files:**
- `packages/clients/web/src/components/SearchOverlay.vue` -- add toggle buttons (Aa, .*, W), expanded row
- `packages/clients/web/src/composables/useTerminalSearch.ts` -- pass toggle state to SearchAddon options
- `packages/clients/web/src/composables/useSearchShortcuts.ts` -- new: keyboard shortcut handler for search-specific keys

**Exit criteria:**
- [ ] Case-sensitive, regex, whole-word toggles update search results
- [ ] Alt+C, Alt+R, Alt+W shortcuts toggle options when search open
- [ ] Invalid regex shows inline error (no crash)
- [ ] Toggles persist during session (reset on page reload)
- [ ] Unit tests: toggle state management, invalid regex handling

### Block 4: Scrollbar Markers -- 45min

**Type:** Feature slice
**Dependencies:** Block 1
**Packages:** web

**Files:**
- `packages/clients/web/src/components/ScrollbarMarkers.vue` -- new: overlay div rendering match position markers
- `packages/clients/web/src/composables/useTerminalSearch.ts` -- expose match positions (line numbers) for marker computation
- `packages/clients/web/src/components/TerminalPane.vue` -- mount ScrollbarMarkers alongside terminal

**Key implementation details:**
- Position markers as absolute-positioned 2px-tall divs in an overlay
- Overlay sits on top of xterm.js scrollbar area (right edge)
- Match positions computed: `(matchLine / totalLines) * containerHeight`
- Marker color from theme `searchHighlight`
- Markers update reactively when search results change

**Exit criteria:**
- [ ] Yellow markers appear in scrollbar at match positions
- [ ] Markers use theme color (not hardcoded)
- [ ] Markers update on search query change
- [ ] Markers cleared when search closed
- [ ] Configurable: scrollbarMarkers setting can disable them

### Block 5: Multi-Pane Search Scope -- 60min

**Type:** Feature slice
**Dependencies:** Block 2
**Packages:** web

**Files:**
- `packages/clients/web/src/composables/useTerminalSearch.ts` -- extend with multi-pane search: iterate panes, aggregate match counts, cross-pane navigation
- `packages/clients/web/src/components/SearchOverlay.vue` -- scope dropdown (This pane / All panes), pane indicator line

**Key implementation details:**
- "All panes" iterates over all terminal panes in the active tab's layout tree
- Match count aggregated across all panes
- Navigation: when Enter crosses into another pane, that pane receives focus
- Overlay shows "Match X/Y in: [pane name]" when match is in another pane
- Scope dropdown hidden when tab has no splits (single pane)

**Exit criteria:**
- [ ] Scope dropdown appears only when tab has multiple panes
- [ ] "All panes" searches all non-vacant panes in tab
- [ ] Navigation crosses pane boundaries and shifts focus
- [ ] Match indicator shows which pane contains the current match
- [ ] Unit tests: multi-pane match aggregation, cross-pane navigation

### Block 6: Search History + Settings -- 45min

**Type:** Feature slice
**Dependencies:** Block 2
**Packages:** web, hub, shared

**Files:**
- `packages/clients/web/src/composables/useSearchHistory.ts` -- new: localStorage-backed search history (max 20, deduplicated, MRU order)
- `packages/clients/web/src/components/SearchOverlay.vue` -- history dropdown on input focus, regex badge
- `packages/shared/src/config.ts` -- add SearchConfig interface
- `packages/hub/src/config-resolver.ts` -- parse [search] section from config.toml

**Exit criteria:**
- [ ] Search history stored in localStorage (max historySize entries)
- [ ] Dropdown appears on empty input focus, shows recent searches
- [ ] Clicking history entry fills input and triggers search
- [ ] Regex searches show [.*] badge in dropdown
- [ ] Duplicate entries deduplicated (MRU order)
- [ ] Settings (position, highlightOnClose, scrollbarMarkers, historySize) read from config
- [ ] highlightOnClose: "clear" removes instantly, "fade" 300ms transition, "persist" keeps
- [ ] Unit tests: history CRUD, deduplication, config parsing

## 7. Test Strategy

### Test Pyramid

| Level | Count | Focus |
|-------|-------|-------|
| Unit | ~25 | Search lifecycle, toggles, history, markers, multi-pane logic |
| Integration | ~5 | SearchAddon with real xterm.js, config loading |
| E2E | ~3 | Search flow, multi-pane navigation, history dropdown |

### Test Data Requirements

**Fixtures:**
- Terminal buffer with known content (repeated patterns for match testing)
- History array with duplicates and regex entries

**Mocks:**
- SearchAddon (findNext/findPrevious/clearDecorations) for unit tests
- xterm.js Terminal for integration tests
- localStorage for history tests
- Keyboard events for shortcut tests

## 8. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| SearchAddon decoration API limitations | M | L | Use addon's built-in decorations, add markers as separate overlay |
| Multi-pane search performance (large buffers) | M | M | Search per pane sequentially, not all at once; lazy search on focus |
| Scrollbar marker positioning accuracy | L | M | Use xterm.js rows count for denominator, test with various scrollback sizes |
| Keyboard shortcut conflicts with shell | M | M | Ctrl+Shift+F (not Ctrl+F) avoids shell capture; all shortcuts configurable |
| Scrollbar markers with 500+ matches | M | M | Cap at ~100 markers, aggregate nearby; use thin overlay div, not individual elements |
| ReDoS with user regex | L | L | V8 has linear time regex; xterm.js SearchAddon uses native RegExp; document as known low-risk |
| Live output during search | L | M | Match count may update; document as expected behavior |

## 9. Definition of Done

- [ ] All 6 blocks implemented
- [ ] All 18 BDD scenarios have passing tests
- [ ] All tests pass (unit + integration)
- [ ] Lint/typecheck pass
- [ ] Ctrl+Shift+F opens search, Escape closes
- [ ] Regex/case/whole-word toggles work
- [ ] Multi-pane scope searches across splits
- [ ] Scrollbar markers show match positions
- [ ] Search history persists in localStorage
- [ ] Code review clean (no blocking findings)

## 10. Dependencies & Integration Notes

### UX-06 (Theming) Dependency

Match highlight colors (`searchHighlight`, `searchHighlightActive`) come from the
active theme. The SearchAddon decoration options must read from the theme store.
UX-06 MUST be implemented first.

### UX-01 (Tab Actions) Integration

Multi-pane search scope depends on the tab's PaneLayout tree (from useLayout).
The `"vacant"` node type from UX-01 must be skipped during pane iteration.
If UX-01 is not yet implemented, multi-pane scope works with the existing
PaneLayout type (no vacant nodes).

### xterm.js SearchAddon

Package: `@xterm/addon-search`. Must be added to web package dependencies.
The addon is mature and stable (part of xterm.js org).

### Existing Code

- `useTerminal.ts` manages xterm.js lifecycle -- Block 1 adds SearchAddon loading
- `TerminalPane.vue` renders terminal -- Blocks 2/4 add overlay and markers
- No existing search code to extend -- this is all new
