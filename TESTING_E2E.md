# E2E Test Suite

Manual E2E tests run via Chrome DevTools (MCP) against `pnpm dev`.
Results are recorded ONLY in the Run Log section. Scenarios below are pure acceptance criteria.

## Prerequisites

- `pnpm dev` running (hub + web)
- Chrome DevTools MCP connected to `http://localhost:5173/`
- Start from a clean state (1 host "local", 0 or 1 channel)

## Coverage Matrix

| Range | Feature | Covered | Last Run |
|-------|---------|---------|----------|
| 1-18 | Core (MVP + daemon) | 17/18 | Run #1 |
| 19-25 | Theming (UX-06) | 0/7 | — |
| 26-36 | Tab Actions & Split Panes (UX-01) | 0/11 | — |
| 37-43 | Terminal Title (UX-02) | 0/7 | — |
| 44-58 | Scrollback Search (UX-04) | 0/15 | — |
| 59-70 | Host Management (UX-03) | 11/12 | Run #2 |
| 71-80 | Notifications (UX-05) | 8/10 | Run #4 |
| 81-88 | Host Customization (UX-07) | 6/8 | Run #3 |
| 89-93 | Regressions (batch 1) | 4/5 | Run #3 |
| 94-100 | Regressions (batch 2) | 7/7 | Run #5 |
| 101-110 | Launch Profiles | 6/10 | Run #7 |

**Total: 59/110 scenarios covered**

---

## Core (1-18)

### 1. Channel creation

- Click "+" in tab bar → new tab opens with prompt, Writer indicator, green sidebar dot
- Click "+" in sidebar header → same result
- Sidebar count increments (GENERAL: N)

### 2. Tab switching

- Click tab 1 → switches to tab 1, sidebar highlights matching channel
- Click tab 2 → switches to tab 2, sidebar highlights matching channel
- Click channel in sidebar → switches to its tab

### 3. Sidebar re-selection

- Click an already-selected channel → tab stays open (no blank state)
- Close a tab via "x" button → click the channel in sidebar → tab re-opens

### 4. Shell exit (dead channel — readonly mode)

- Type `exit` in terminal → "Closed" badge appears, tab stays open (readonly)
- Sidebar dot turns grey
- Write-lock indicator (Writer/Release) hidden on dead tab
- Other channel tabs remain unaffected
- Can still scroll and select text in dead tab (copy-paste)

### 5. Explicit channel deletion (context menu)

- Right-click dead channel in sidebar → "Close channel" → tab closes immediately
- Right-click live channel in sidebar → "Close channel" → tab closes immediately
- Sidebar count decrements
- Remaining tabs/channels unaffected
- No "Starting..." ghost tab appears

### 6. Delete fallback selection

- Delete the currently selected channel → selection falls back to next alive channel
- Fallback channel's tab opens/focuses automatically
- If no channels remain → empty state ("Select a channel or click +")

### 7. Multi-channel lifecycle

- Open 3 channels (A, B, C)
- Kill B with `exit` → B shows "Closed", A and C still live
- Delete B via context menu → B's tab closes, A and C intact
- Kill C with `exit` → C shows "Closed", A still live
- Delete A via context menu → falls back to C (dead, readonly)
- Delete C → empty state

### 8. Page reload persistence

- With 2 tabs open, reload page → tabs restored from localStorage
- Active tab preserved after reload
- Dead channel tabs restored with "Closed" badge

### 9. Write-lock indicator

- Live channel: shows green dot + "Writer" + "Release" button
- Dead channel: indicator completely hidden
- After releasing write lock: shows "No lock" (grey dot)
- After re-claiming: shows "Writer" again

### 10. Host rail status

- Local host shows green dot when agent is running
- Pulsing/red dot when agent is disconnected
- Status recovers after warm restart

### 11. Terminal I/O

- Type `echo HELLO` + Enter → output `HELLO` appears in terminal
- Type `pwd` + Enter → current directory shown
- Type `ls --color` → colored output renders correctly
- Rapid typing (paste a long string) → no dropped characters
- Ctrl+C interrupts a running command (e.g. `sleep 999`)

### 12. Channel rename (inline edit)

- Double-click channel name in sidebar → inline input appears
- Type new name + Enter → name updates in sidebar and tab bar
- Press Escape → cancels rename, original name preserved
- Double-click tab label → inline input appears (same behavior)
- Empty name rejected (reverts to original)

### 13. Channel group management

- Click "+ Add group" → new group appears in sidebar (e.g. "GROUP 2")
- New channel created in selected group appears under that group
- Drag channel from GENERAL to GROUP 1 → channel moves, counts update
- Drag channel back → channel returns to original group
- Delete empty group → group removed from sidebar
- Delete group with channels → channels move to default group (GENERAL)

### 14. Daemon survival (hub restart)

Precondition: 2+ live channels with output, agent running as daemon.

- Run `echo BEFORE_RESTART` in terminal A
- Stop hub (`dev-stop.sh` kills hub but agent survives — or restart hub only)
- Start hub again (`dev-start.sh`)
- Reload page → channels reappear in sidebar with green dots (alive)
- Click channel A → scrollback preserved (contains `BEFORE_RESTART`)
- Type `echo AFTER_RESTART` → terminal still functional
- Channel B also restored with its scrollback

### 15. Daemon death recovery

- Kill agent daemon process (`kill <agent-pid>`)
- Sidebar channels turn grey/dead (agent disconnected)
- Hub auto-restarts agent daemon (check `agent.sock` reappears)
- Create new channel → works normally (new agent)
- Old channels show as dead (PTYs lost with agent process)

### 16. WS reconnect (network blip)

- With active terminal, disconnect network briefly (disable adapter or DevTools offline)
- Reconnect → WS auto-reconnects (exponential backoff)
- Terminal resumes working (type command, see output)
- No duplicate tabs or ghost channels after reconnect

### 17. Multiple browser tabs (write-lock contention)

- Open lasterm in two browser tabs
- Tab A has write lock on channel X
- Tab B clicks channel X → sees "No lock" (reader mode)
- Tab B force-takes write lock → Tab A loses lock, shows "No lock"
- Tab A reclaims → Tab B loses lock

### 18. Page reload with daemon

- Open 3 channels, type distinct commands in each
- Reload page (F5) → all 3 tabs restored
- Each terminal shows its previous scrollback (snapshot restore)
- Write lock auto-claimed on active tab

---

## Theming — UX-06 (19-25)

### 19. Theme switching

- Open appearance panel → theme picker shows 9 bundled presets
- Click "dracula" → chrome colors update immediately (sidebar, tab bar, host rail)
- Terminal ANSI colors update (run `ls --color` → colors match dracula palette)
- Click "solarized-light" → light theme applied (bright backgrounds, dark text)
- Click "catppuccin-mocha" → back to default dark theme

### 20. Theme live preview on hover

- Hover over a theme in the picker → chrome + terminal preview instantly
- Move mouse away → reverts to current theme (no commit)
- Click the hovered theme → preview becomes permanent

### 21. Theme editor

- Open theme editor → color pickers for all 22 terminal + 15 UI colors
- Change a terminal color (e.g. red) → terminal updates live
- Change a UI color (e.g. --nt-bg-primary) → chrome updates live
- Save → theme file written, appears in picker
- Cancel → changes discarded, original theme restored

### 22. Theme import/export

- Export current theme → JSON file downloaded
- Import a valid theme JSON → theme appears in picker and is selectable
- Import invalid JSON → error message, no crash

### 23. OS auto-switch (dark/light)

- Enable auto-switch in appearance settings
- Set light theme for "light" and dark theme for "dark"
- Toggle OS dark mode → theme switches automatically
- Manually select a theme → auto-switch disables (SC-14)

### 24. Background opacity

- Adjust opacity slider → terminal + chrome background becomes translucent
- At 100% → fully opaque (default)
- At ~80% → desktop visible behind terminal area
- Reload page → opacity setting preserved

### 25. Scrollbar styling

- Set scrollbar style to "thin" → xterm scrollbar narrows
- Set to "wide" → scrollbar widens
- Set to "hidden" → scrollbar disappears (scroll still works via mouse wheel)
- --nt-scrollbar-width CSS var applied correctly

---

## Tab Actions & Split Panes — UX-01 (26-36)

### 26. Tab context menu

- Right-click a tab → context menu appears with: Close, Close Others, Close to the Right, Close All
- Click away → menu dismisses
- Menu positioned at click coordinates (no overflow off-screen)

### 27. Close Others / Close to the Right / Close All

Precondition: 4 tabs open (A, B, C, D), tab B selected.

- Right-click B → "Close Others" → A, C, D tabs vacated, B remains
- Undo: reopen channels. Right-click C → "Close to the Right" → D vacated, A, B, C remain
- Right-click any → "Close All" → all tabs vacated (panes show vacant state, tabs stay)

### 28. Confirm dialogs (close actions)

- "Close All" triggers confirmation dialog (if confirmCloseAll enabled)
- Dialog shows "Remember for host" and "Remember globally" checkboxes
- Check "Remember globally" + confirm → next "Close All" skips dialog
- Clear localStorage `lasterm:skipConfirm*` → dialogs return

### 29. Split panes — horizontal and vertical

- With 1 terminal open, use split action → pane splits into 2 (vacant + terminal)
- Split again → 3 panes visible
- Split once more → 4 panes (max reached)
- Attempt 5th split → blocked (max 4 panes enforced, INV-02)
- Each vacant pane shows channel picker

### 30. Vacant pane — channel picker

- Click a vacant pane → picker appears with available detached channels
- Select a channel → terminal loads in that pane (attach)
- Click "+" in picker → new channel created and assigned to pane
- Vacant pane with no available channels → shows "+" only

### 31. Pane close and collapse

- Close a pane (X button on pane header) → pane becomes vacant
- Close the last non-vacant pane in a split → split collapses, parent resizes
- Root pane close → tab stays open with vacant pane (INV-04: tab never auto-closes)

### 32. Cross-tab pane drag & drop

Precondition: 2 tabs, each with 1 terminal pane.

- Drag pane header from tab A → drop on tab B's center → replaces pane content
- Tab A shows vacant pane (channel detached, not killed — INV-03)
- Drop on left edge (25%) → horizontal split, dropped pane on left
- Drop on right edge → horizontal split, dropped pane on right
- Drop on top edge → vertical split, dropped pane on top
- Drop on bottom edge → vertical split, dropped pane on bottom
- Same-tab drag: move pane within a split → swaps positions

### 33. Pane resize (splitter drag)

- Drag the splitter between two panes → both resize proportionally
- Release → ratio preserved
- Resize persists after tab switch and return

### 34. Welcome tab

- First visit to host (or autoOpenWelcome=true) → welcome tab auto-opens with ★ icon
- Welcome tab shows configurable content (per-host)
- Star icon (★) visible in both tab bar and sidebar
- Only one welcome tab per host (enforce via transaction)
- Close welcome tab → can reopen via sidebar context menu

### 35. Configure command + direct process

- Right-click channel → "Configure Command" → dialog to set shell/args/directProcess
- Set command to `htop` with directProcess=true → channel runs htop directly
- When htop exits → exit overlay appears: Restart / Configure Command / Close
- Click "Restart" → htop relaunches in same channel
- Click "Configure Command" → back to dialog
- Click "Close" → channel vacated

### 36. Channel sidebar context menu

- Right-click channel in sidebar → context menu: Open in Current Tab, Open in New Tab, Rename, Close Channel
- "Open in Current Tab" → replaces active pane content with this channel
- "Open in New Tab" → creates new tab with this channel
- "Rename" → inline rename input
- "Close Channel" → channel deleted (with confirmation if live)

---

## Terminal Title — UX-02 (37-43)

### 37. Dynamic title from OSC sequences

- Run `vim` → tab title changes to "vim" (OSC 0/2 sequence)
- Exit vim → tab title reverts to previous (title stack)
- Run `ssh user@server` → title changes to "user@server"
- Run `htop` → title changes to "htop"
- Sidebar also shows dynamic title (without prefix)

### 38. Title priority chain

- Channel with no activity → shows fallback ("Terminal" or custom)
- Run a command → dynamic title appears (live OSC override)
- Double-click tab to rename (F2) → custom title overrides dynamic
- While custom title set, run vim → custom title stays (custom > dynamic)

### 39. Title truncation

- Run a command that produces a very long title (e.g. deep nested path)
- Tab title truncates with "…" at end (default position)
- Full title visible on hover (tooltip)
- Sidebar title also truncates appropriately

### 40. Window title (document.title)

- Switch to a tab → browser window/tab title updates to formatted string
- Format includes host prefix, channel title (configurable tokens)
- Switch tabs → window title follows active pane
- With no tabs → window title shows app name only

### 41. Per-host title prefix

- Configure a host with prefix "PROD" → all channels on that host show "PROD: <title>"
- Prefix applied before truncation (counts toward char limit)
- Sidebar titles do NOT show prefix (SC-15)

### 42. Reset title to dynamic

- Rename a channel to custom title via double-click
- Right-click tab → "Reset Title to Dynamic" appears (only when custom title set)
- Click "Reset" → title reverts to current dynamic title (or fallback if no OSC)
- Menu item grayed out when title is already dynamic

### 43. Title persistence across reconnect

- Run vim → dynamic title "vim" displayed
- Reload page → after reattach, dynamic title restored from DB (ATTACH_OK carries dynamicTitle)
- Custom title also preserved after reload

---

## Scrollback Search — UX-04 (44-58)

### 44. Open/close search overlay

- Press Ctrl+Shift+F → search overlay appears in terminal pane (top-right default)
- Input is auto-focused
- Press Escape → overlay closes, terminal refocused
- Press Ctrl+Shift+F again → overlay reopens with previous query

### 45. Incremental search + highlighting

- Type a query (e.g. "echo") → matches highlighted in terminal as you type
- Match count displayed (e.g. "3/12" — current match / total)
- Typing more characters narrows results (incremental)
- Clear input → highlights removed, count resets to "0/0"

### 46. Match navigation

- Press Enter → scrolls to next match, current match counter increments
- Press Shift+Enter → scrolls to previous match, counter decrements
- Click "▼" button → next match
- Click "▲" button → previous match
- At last match + Enter → wraps to first match
- At first match + Shift+Enter → wraps to last match

### 47. Case-sensitive toggle

- Click "Aa" button (or Alt+C) → case-sensitive mode enabled (button highlighted)
- Search "Echo" case-sensitive → only matches exact case
- Toggle off → "echo", "Echo", "ECHO" all match
- Toggle state reflected in button appearance

### 48. Regex search

- Click ".*" button (or Alt+R) → regex mode enabled
- Type `echo\s+\w+` → matches "echo" followed by word
- Regex badge "[.*]" appears in input area
- Type invalid regex (e.g. `[unclosed`) → inline error message displayed
- Fix regex → error clears, matches appear

### 49. Whole word toggle

- Click "W" button (or Alt+W) → whole-word mode enabled
- Search "echo" → matches standalone "echo" but not "echotest"
- Toggle off → "echotest" also matches

### 50. Scrollbar markers

- Search a query with multiple matches → orange/yellow marks appear on scrollbar
- Active match shown with different color (pink) on scrollbar
- Navigate matches → active marker moves on scrollbar
- Clear search → markers disappear
- Scrollbar markers respect terminal profile setting (can be disabled)

### 51. Search on dead/exited channel

- Exit a channel (type `exit`)
- Press Ctrl+Shift+F → search overlay opens on dead channel
- Search previous output → matches found and highlighted
- Navigation works normally on frozen buffer

### 52. Highlight on close behavior

- With highlightOnClose="clear" → close overlay → highlights removed immediately
- With highlightOnClose="fade" → close overlay → highlights fade after ~300ms
- With highlightOnClose="persist" → close overlay → highlights remain visible

### 53. Multi-pane search — scope toggle

Precondition: 2+ panes visible in current tab (split view).

- Open search → scope toggle visible ("1" = current pane, "All" = all panes)
- Default scope: current pane ("1" active)
- Click "All" → search expands to all panes, total match count aggregates
- Match count shows combined total across all panes

### 54. Multi-pane search — cross-pane navigation

Precondition: 2 panes with matches in both, scope="All".

- Press Enter → navigates through current pane matches
- After last match in current pane → focus jumps to next pane with matches
- Next pane highlights and scrolls to its first match
- Continue → cycles through all panes with wrap-around
- Shift+Enter → reverse direction, same cross-pane behavior
- Pane with zero matches → skipped during navigation

### 55. Multi-pane search — single pane

- With only 1 pane visible → scope toggle NOT visible
- Search works normally (single-pane mode)

### 56. Search history

- Perform several searches: "foo", "bar", "baz"
- Close and reopen search → click empty input or focus → history dropdown appears
- History shows recent queries in MRU order: "baz", "bar", "foo"
- Click a history entry → populates input, executes search
- Search "foo" again → deduplicates, "foo" moves to top
- Regex searches show [.*] badge in history dropdown
- History persists across page reload (localStorage)

### 57. Search overlay position

- Default position: top-right of terminal pane
- Change config to "bottom-right" → overlay moves to bottom-right
- Change config to "bottom-bar" → overlay spans full width at bottom
- Overlay does not cover terminal text (scrolls content if needed)

### 58. Search keyboard shortcuts summary

- Ctrl+Shift+F → open search (from terminal)
- Escape → close search (refocus terminal)
- Enter → next match
- Shift+Enter → previous match
- Alt+C → toggle case-sensitive
- Alt+R → toggle regex
- Alt+W → toggle whole word
- Typing in search input does NOT send keystrokes to terminal

---

## Host Management — UX-03 (59-70)

### 59. Add host modal

- Click [+] button in host rail → Add Host modal opens
- Fill Name, Hostname, Port (default 22), Username, Auth method
- Click Save → host appears in host rail with auto-generated icon + color
- Click Cancel → modal closes, no host created

### 60. Edit host

- Right-click host in rail → context menu with "Edit Host"
- Click "Edit Host" → modal opens pre-filled with current values
- Modify hostname and username → Save
- Verify changes persist (hover tooltip shows updated values)

### 61. Delete host

- Right-click host → "Delete Host" → confirmation dialog appears
- Cancel deletion → host remains
- Confirm deletion → host removed from rail, associated channels closed
- Attempt delete on local host → option NOT available in context menu

### 62. Duplicate host

- Right-click host → "Duplicate" → new host appears as "hostname-copy"
- Duplicate again → "hostname-copy-2" created
- Verify duplicate inherits SSH config from original

### 63. SSH config import (single)

- Click [+] in host rail → select "From SSH config" source
- Dropdown lists hosts from ~/.ssh/config
- Select a host → fields auto-fill (hostname, port, user, key)
- Click Save → host created with ssh_config_host field set
- If ~/.ssh/config missing → error message shown

### 64. Batch SSH config import

- Open batch import dialog → all hosts from ~/.ssh/config listed
- Git hosts (github.com, gitlab.com) unchecked by default with "(skipped)" label
- Check/uncheck hosts → "Import N hosts" button updates count
- Click Import → all selected hosts appear in rail
- ProxyJump dependencies auto-checked with explanation tooltip

### 65. Host groups — create & assign

- In Add Host modal, click Group dropdown → existing groups listed
- Click "+ New group" → type group name → group created
- Save host → host appears under correct group separator in rail
- New host without group → appears in default/ungrouped section

### 66. Host groups — collapse/expand

- Click group separator → group collapses (shows "N hosts hidden")
- Click again → group expands showing all hosts
- Collapse state persists across page reload

### 67. Host groups — rename & delete

- Right-click group separator → "Rename Group" → inline edit
- Type new name + Enter → separator label updates
- Right-click group → "Delete Group" → confirmation
- Confirm → group removed, hosts move to ungrouped section
- Active sessions on moved hosts continue uninterrupted

### 68. Host DnD reorder

- Drag host within same group → host moves to new position
- Release → order persists after page reload
- Drag host from one group to another → host moves to target group
- Group host counts update accordingly

### 69. Test connection

- Fill Add Host form (do NOT save) → click "Test Connection"
- Button shows "Testing..." spinner
- Success → shows "Connected (Xms, OpenSSH X.Y)"
- Auth failure → shows "Auth failed" error
- Unreachable host → shows "Timeout after 10s"
- Test does NOT save the host

### 70. Host rail context menu & local host

- Right-click SSH host → full menu: Edit, Delete, Duplicate, Move to Group
- Right-click local host → only "Edit Name / Icon" available
- Delete, Disconnect, Duplicate NOT shown for local host
- Hover host → tooltip shows hostname, port, user, auth method

---

## Notifications — UX-05 (71-80)

### 71. Bell badge on inactive tab

- Open 2 channels (A, B), switch to B
- In A (background), run `echo -e '\a'` → red badge "1" appears on A's tab
- Run bell again → badge increments to "2"
- Bell on active tab (B) → no badge (already focused)

### 72. Activity dot on background output

- Switch to channel B, channel A is background
- Channel A receives output (e.g., running script) → blue dot on A's tab
- Whitespace-only output does NOT trigger dot
- Activity dot is separate from bell badge (blue vs red)

### 73. Badge/dot clear on tab focus

- Channel A has activity dot + bell badge "3"
- Click A's tab → terminal auto-scrolls to bottom
- Both activity dot and bell badge clear
- If not scrolled to bottom → badges remain, unread bar shows

### 74. Unread line bar

Precondition: channel A has new lines while inactive.

- Click A's tab → unread bar appears: "N new lines"
- Click "Jump to bottom" → terminal scrolls to bottom, bar + badges clear
- Click "Mark as read" → badges clear, scroll position unchanged
- Manually scroll to bottom → bar dismisses automatically
- After reaching bottom, scrolling up does NOT re-show bar

### 75. Desktop notification on bell

Precondition: Notification API permission granted, document hidden (minimized/other browser tab).

- Background channel outputs BEL → desktop notification with channel name
- Multiple bells within 5s → grouped: "N alerts in channel"
- Click notification → browser focuses, channel tab activates
- Permission denied → no notification, but badge still increments

### 76. OSC 9 notification

- Background channel outputs `echo -e '\e]9;Build done!\a'` → bell badge + activity dot
- Desktop notification shows "Build done!" in body (when document hidden)
- Empty OSC 9 message → generic "Bell in channel" text
- OSC 9 on active/focused tab → no desktop notification
- HTML in OSC 9 message → tags stripped (XSS prevention)

### 77. Bell sound

- Set bell sound to "system" → BEL char triggers system beep
- Set to "mute" → no sound, badge still increments
- Set to "custom" with valid .wav/.mp3 file → custom sound plays
- Activity (OUTPUT) never triggers sound — only BEL does

### 78. Scroll mode — auto

- Set scroll.mode to "auto" with threshold 100 (default)
- Channel receives few lines while inactive → activate tab → resumes position, unread bar "N new lines"
- Channel receives 150+ lines → activate tab → scrolls to bottom, no bar

### 79. Scroll mode — alwaysBottom / alwaysResume

- Set scroll.mode to "alwaysBottom" → any new output, tab always scrolls to bottom on focus
- Set scroll.mode to "alwaysResume" → always resumes position with unread bar, even for 500+ lines

### 80. Host rail & sidebar indicators

- Host with 3 channels with bells (5 + 3 + 0) → host rail shows aggregated badge "8"
- Channel sidebar: activity → blue dot, bells → red badge with count
- Both indicators visible simultaneously on different channels

---

## Host Customization — UX-07 (81-88)

### 81. Visual preset selection

- Open host modal → Advanced section → Visual Profile
- Select "None" → all visual elements disabled (default)
- Select "Caution" → banner "STAGING - {host}" (yellow), subtle border, 3% yellow tint
- Select "Danger" → banner "PRODUCTION - {host}" (red), strong border, 5% red tint
- Save → open terminal for host → visual profile applied

### 82. Custom preset (modify switches)

- Select "Danger" preset → change tint opacity from 5% to 10%
- Preset auto-switches to "Custom"
- Other values (banner text, border) remain unchanged
- Save → reload → "Custom" preset persisted with modified values

### 83. Environment banner

- Host with banner enabled → banner appears between pane header and terminal
- Banner text centered, uppercase, bold
- Banner background + text colors match configured values
- Banner with `flex-shrink: 0` — does not collapse on small panes

### 84. Banner token substitution

- Set banner text to "ENV: {host} ({ip}) [{group}]"
- Open terminal → banner shows host/ip/group substituted
- Host without group → {group} renders as literal "{group}"
- Local host without sshHost → {ip} renders as "localhost"
- HTML in host name → rendered as text, NOT executed (XSS safe)

### 85. Accent border styles

- Border "none" → no visible border on terminal pane
- Border "subtle" → 2px left border in configured color
- Border "strong" → 3px border on left, right, and bottom
- Empty border color → falls back to host's primary color
- Custom border color overrides host color

### 86. Background tint

- Enable tint with color + 5% opacity → colored overlay visible on terminal
- Tint overlay: pointer-events: none (clicks pass through to terminal)
- Text remains readable under tint
- Attempt to set opacity > 15% → clamped to 15%

### 87. Tint slider with live preview

- Open Visual Profile settings → enable tint
- TintPreview shows fake terminal lines with current tint applied
- Drag opacity slider → preview updates in real-time
- Color picker change → preview updates immediately

### 88. Split panes with different host profiles

Precondition: 2 hosts configured — "prod" (Danger preset) and "staging" (Caution preset).

- Open terminal with pane A connected to "prod"
- Split → assign pane B to "staging"
- Pane A: red banner, strong red border, red tint
- Pane B: yellow banner, subtle yellow border, yellow tint
- Each pane renders its own host's profile independently (not global)

---

## Regressions (89-93)

### 89. Bell badge on active tab (regression: 1f55b40, e74cc37)

Precondition: 1 host "local", 2 channels, active tab = "Terminal".

- Type `printf '\x07'` + Enter in the active terminal
- Bell badge "1" appears on host rail, channel sidebar, and tab bar within 200ms
- All three badges auto-dismiss after ~1s (still on same tab)
- Bell on background channel → badge persists until user clicks back

### 90. Scroll does not clear bell badge (regression: 1f55b40)

Precondition: 1 host "local", 1 channel with scrollback output.

- Type `printf '\x07'` → bell badge appears on all 3 locations
- Scroll up in terminal → bell badge still visible
- Scroll back to bottom → bell badge still visible (only auto-dismiss timer clears it)
- Unread lines bar (if shown) clears independently of bell badge

### 91. No auto-spawn on SSH host switch (regression: b013a6c)

Precondition: 1 local host with channels, 1+ SSH host without active session.

- Click SSH host in rail → sidebar shows "No channels yet", no "Starting..." tab
- Wait 10s — no SPAWN timeout error appears
- Click back on local host → existing channels listed, no phantom tab
- Repeat switch 3 times — no ghost tabs accumulate

### 92. Group action dialogs (regression: 73336ae)

Precondition: 1 host "local", 1+ channel group.

- Right-click group header → "Rename group" → application modal (NOT system prompt())
- Type new name, click Rename → group renamed
- Press Escape or click outside → modal closes, no rename
- Right-click group header → "Delete group" → danger confirmation modal (NOT system confirm())
- Click Cancel → group still exists
- Click Delete → group removed, channels moved to default

### 93. Hidden pane scroll does not clear unread lines (regression: useScrollBehavior fix)

Precondition: 1 host "local", 2 channels (A, B), both alive.

- Switch to channel A (active), B is inactive/hidden via v-show
- B receives output in background → unreadLines accumulates for B
- xterm.js auto-scroll on hidden pane does NOT clear unreadLines
- Switch to B → unread bar appears with correct line count
- "Jump ↓" clears bar and scrolls to bottom

### 94. Duplicate context menus on channel groups (regression: b037c40)

- Right-click channel group header → ONE context menu appears (not two overlapping)
- Rename via menu → single modal, no stale menu behind
- "Clean Up Dead Terminals" visible only when group has dead channels

### 95. Dead channel purge FK constraint (regression: b037c40)

- Dead channel → right-click → "Delete" → channel removed (no HTTP 500)
- "Clean Up Dead Terminals" in group menu → all dead channels in group purged
- Sidebar "Clear" button → bulk purge dead channels
- Remaining live channels unaffected

### 96. Dead channel restart visual state (regression: b037c40)

- Dead channel (black/grey) → right-click → "Restart" → channel turns alive (green dot)
- Terminal becomes usable immediately (no page refresh needed)
- Tab title updates from "Closed" to active state

### 97. Pairing code preserves current session (regression: b037c40)

- Command palette → "Generate Pairing Code" → modal appears with 6-digit code
- Current session NOT interrupted (auth token preserved)
- Code expires after 60s (countdown bar visible)
- Copy button works, code can be used on another browser

### 98. Post-pairing config initialization (regression: b037c40)

- Pair new browser with 6-digit code → theme, fonts, hosts loaded before layout shows
- PairingScreen stays visible during config loading (no flash of default theme)
- After init complete → layout appears with correct theme

### 99. Auto-switch theme at boot (regression: b037c40)

- Auto-switch enabled with dark=one-half-dark, light=one-half-light
- Browser B (OS dark mode) → page load → dark theme applied immediately
- Browser A (OS light mode) → page load → light theme applied
- Does NOT fall back to hardcoded "catppuccin-mocha" default
- Settings panel shows correct dark/light theme selections

### 100. App refresh theme flash (regression: b037c40)

- Ctrl+R refresh → spinner shown while config loads (no theme flash)
- Spinner uses `--nt-bg` background (matches theme once loaded)
- Layout appears only after theme + fonts are ready

---

## Launch Profiles (101-110)

### 101. Profile dropdown from "+" chevron

- Tab bar shows split button: wide "+" (spawn default) + narrow "▾" chevron
- Click chevron → dropdown appears below with profile list
- Click profile → terminal spawns with that profile's config
- Click outside dropdown → closes
- Escape key → closes

### 102. Profile dropdown — default indicator

- Profile marked as default for current host shows ✓ mark and bold text
- Default profile listed first (or sorted by effectiveSort)
- Non-default profiles show ▶ icon (or custom emoji if set)

### 103. Quick command (Run command...)

- Profile dropdown shows "Run command..." action below profile list
- Click → inline input appears in dropdown
- Type "htop" + Enter → terminal spawns running htop (directProcess mode)
- Empty submit → no-op
- Escape → closes dropdown

### 104. Create profile via Settings

- Open Settings → Profiles tab visible in category nav
- Click "+ New Profile" → form appears
- Fill name "My Shell", shell "/bin/bash", save → profile appears in list
- Profile card shows name, shell path, icon
- Duplicate name (case-insensitive) → error

### 105. Edit profile via Settings

- Click profile card → edit form opens pre-filled
- Modify shell to "/bin/zsh" → Save → updated in list
- Cancel → no changes
- Delete profile → removed from list + dropdown

### 106. Profile env editor with masking

- Edit a profile → env section shows key-value pairs
- Add key "API_TOKEN" with value "secret123" → Save
- Re-open profile → API_TOKEN value shows "********" (masked)
- Edit without touching masked value → Save → original value preserved (no clobber)
- Clear masked field and type new value → Save → new value stored

### 107. Command palette — ~ prefix

- Open command palette (Ctrl+K) → type "~" → only profiles listed
- Type "~My" → filters to profiles matching "My"
- Select a profile → terminal spawns with that profile
- Without "~" prefix, profiles still appear (with lower score) in general results

### 108. Keyboard shortcut — Ctrl+Shift+1

- With terminal NOT focused (e.g., click sidebar) → Ctrl+Shift+1 spawns 1st profile
- With terminal focused (cursor in xterm) → Ctrl+Shift+1 does nothing (INV-13)
- Ctrl+Shift+2 spawns 2nd profile (if exists)
- Ctrl+Shift+N where N > profile count → no-op

### 109. Profile reorder in Settings

- Settings > Profiles shows profiles in sort_order
- Click up/down arrows on profile card → profile moves position
- New order reflected in dropdown and command palette

### 110. Host-specific profile visibility

- Profile with supportedOs="linux" → visible on Linux hosts, hidden on Windows
- Profile with supportedOs="any" → visible on all hosts
- Per-host override "hide" → profile hidden for that host only
- Per-host override "pin" → profile pinned to top for that host

---

## Run Log

Each run records which scenarios passed/failed. Commit = HEAD at time of run.

### Run #1 — 2026-03-06 — `feat/agent-daemon` (7bf51c3)

| # | Scenario | Result | Notes |
|---|----------|--------|-------|
| 1 | Channel creation | ✅ | + tab bar, sidebar count |
| 2 | Tab switching | ✅ | Tab 1↔2, sidebar highlight |
| 3 | Sidebar re-selection | ✅ | Close tab → reopen via sidebar click |
| 4 | Shell exit (dead channel) | ✅ | Closed badge, grey dot, no write-lock |
| 5 | Channel deletion | ✅ | Context menu → Close channel |
| 6 | Delete fallback | ✅ | Deleted current → fallback to next alive |
| 7 | Multi-channel lifecycle | ✅ | 3 ch: kill B→Closed, delete B→A/C intact, kill C, delete A→fallback C dead, delete C→empty |
| 8 | Page reload persistence | ✅ | 2 tabs restored, active preserved, RELOAD_TEST in scrollback |
| 9 | Write-lock indicator | ✅ | Writer+Release, released→No lock+Request/Force, reclaimed, dead→hidden |
| 10 | Host rail status | ✅ | Green dot (status-dot--live), agent running |
| 11 | Terminal I/O | ✅ | pwd, ls --color, sleep+Ctrl+C |
| 12 | Channel rename | ✅ | Sidebar dbl-click, tab dbl-click, Escape cancels, name syncs everywhere |
| 13 | Group management | ✅ | Create group, move channel↔groups, delete empty group |
| 14 | Daemon survival | ✅ | Hub restart → scrollback preserved, terminal functional |
| 15 | Daemon death recovery | ✅ | kill agent → hub auto-relaunched new daemon, old channels dead, new channels work |
| 16 | WS reconnect | ⏭️ | Requires network disruption — manual test |
| 17 | Multi-browser write-lock | ✅ | Tab A Writer → Tab B force-take → A loses → A reclaims → B loses |
| 18 | Page reload + daemon | ✅ | 5 tabs restored, scrollback preserved, write lock auto-claimed |

**Summary: 17/18 tested, 17 pass, 1 skipped**

### Run #2 — 2026-03-07 — `main` (1be5f86)

| # | Scenario | Result | Notes |
|---|----------|--------|-------|
| 59 | Add host modal | ✅ | Form fields, save creates host, cancel discards |
| 60 | Edit host | ✅ | Pre-filled, modified hostname+user persist |
| 61 | Delete host | ✅ | Confirm dialog, cancel preserves, confirm removes |
| 62 | Duplicate host | ✅ | "-copy" suffix, SSH config inherited |
| 63 | SSH config import (single) | ✅ | Dropdown lists hosts, auto-fill hostname/user/key |
| 64 | Batch SSH import | ⏭️ | Only 1 host in SSH config |
| 65 | Host groups — create | ✅ | Inline new group in modal, host assigned on save |
| 66 | Host groups — collapse | ✅ | Collapse hides hosts, expand restores |
| 67 | Host groups — rename/delete | ✅ | Application modals (not system dialogs), rename+delete+cancel |
| 68 | Host DnD reorder | ❌ | DnD does not work — tabs nor hosts (investigating) |
| 69 | Test connection | ✅ | Unreachable → "EHOSTUNREACH", doesn't save |
| 70 | Host rail context menu | ✅ | Local: only "Edit Name / Icon", SSH: full menu |
| 71 | Bell badge inactive tab | ✅ | Badge "1"→"2" on rail+sidebar+tab |
| 73 | Badge clear on focus | ✅ | Click tab → all badges clear |
| 80 | Host rail aggregation | ✅ | 5+3=8 aggregated, activity dot + bell coexist |
| 81 | Visual preset selection | ✅ | None/Danger radio, all elements toggle |
| 83 | Environment banner | ✅ | Red banner "LOCAL DEV - local", white text |
| 85 | Accent border | ✅ | Strong 3px solid #e06c75 on L/R |
| 86 | Background tint | ✅ | rgba(224,108,117,0.05), pointer-events:none |
| 87 | Tint slider preview | ✅ | Slider 0-15%, preview with fake terminal lines |
| 89 | Bell on active tab (reg.) | ✅ | Badge appears, auto-clears after ~1s |
| 91 | No SSH auto-spawn (reg.) | ✅ | No "Starting…" tab on SSH host switch |
| 92 | Group action dialogs (reg.) | ✅ | Application modals for rename/delete |

**Summary: 22/23 tested, 21 pass, 1 fail (Sc.68), 1 skipped (Sc.64)**

### Run #3 — 2026-03-07 — `main` (post bug-fix)

Focused run: Sc.74 (unread bar), Sc.78 (auto scroll), Sc.84 (banner tokens), Sc.93 (regression).

| # | Scenario | Result | Notes |
|---|----------|--------|-------|
| 68 | Host DnD reorder | 🔧 | Fixed `.prevent` on `@drop` + race condition in reorder/fetch |
| 74 | Unread line bar | ✅ | Required 2 fixes: useActivityTracker (min 1 line) + useScrollBehavior (skip hidden panes) |
| 75 | Desktop notification (bell) | ⏭️ | Requires manual Notification permission grant |
| 76 | OSC 9 notification | ⏭️ | Requires manual Notification permission grant |
| 78 | Scroll mode — auto | ✅ | <threshold shows bar, ≥threshold scrolls to bottom |
| 84 | Banner token substitution | ✅ | {host}→LOCAL, {ip}→LOCALHOST, {group}→literal |
| 93 | Hidden pane scroll (reg.) | ✅ | onNaturalScrollToBottom guarded by isActiveTab |

**Summary: 5/7 tested, 5 pass, 2 skipped**

### Run #4 — 2026-03-08 — `main`

Focused run: Sc.75-76 (desktop notifications), Sc.79 (scroll modes).

| # | Scenario | Result | Notes |
|---|----------|--------|-------|
| 75 | Desktop notification (bell) | ✅ | Bell badge on tab/host rail, desktop notif gated by document.hidden |
| 76 | OSC 9 notification | ✅ | NOTIFY handler fires, bell badge + activity dot, showSimpleNotification with msg.message |
| 79 | Scroll modes (alwaysBottom/alwaysResume) | ✅ | alwaysBottom: 10 lines → scroll to bottom, no bar. alwaysResume: 200 lines → bar shown, position resumed |

**Summary: 3/3 tested, 3 pass**

### Run #5 — 2026-03-10 — `fix/ux-bugfixes-batch-2` (b037c40)

Focused run: channel lifecycle, pairing, theming regressions.

| # | Scenario | Result | Notes |
|---|----------|--------|-------|
| 94 | Duplicate context menus | ✅ | Removed GroupContextMenu for channel groups, consolidated into ChannelGroupHeader |
| 95 | Dead channel purge FK | ✅ | Fixed: delete cache_index before channels row |
| 96 | Dead channel restart visual | ✅ | Optimistic `status = "born"` after successful restart API call |
| 97 | Pairing code preserves session | ✅ | Modal with PairingCodeGenerator replaces token-clearing behavior |
| 98 | Post-pairing config init | ✅ | postAuthLoading flag keeps PairingScreen visible during config load |
| 99 | Auto-switch theme at boot | ✅ | useAutoSwitch in App.vue + fix assignment order (names before enabled) |
| 100 | App refresh theme flash | ✅ | appReady gate with spinner prevents layout render before theme loaded |

**Summary: 7/7 tested, 7 pass**

### Run #6 — 2026-03-10 — `fix/ux-bugfixes-batch-2` (uncommitted)

Manual verification of SSH auth + sidebar UX fixes.

| # | Scenario | Result | Notes |
|---|----------|--------|-------|
| 1 | Channel creation (sidebar +) | ✅ | Sidebar "+" now uses openPendingTab (same as tab bar "+"), auto-focuses new tab |
| 69 | Test connection | ✅ | Form values read correctly in edit mode, tilde expansion, encrypted ed25519 key detected via ssh2.utils.parseKey, passphrase dialog appears (z-index 10100 > modal 10000), no client/server timeouts during passphrase entry |

**Summary: 2/2 tested, 2 pass (manual verification)**

### Run #7 — 2026-03-12 — `feat/launch-profiles` (ee8dfff)

Launch Profiles feature E2E validation.

| # | Scenario | Result | Notes |
|---|----------|--------|-------|
| 101 | Profile dropdown chevron | ✅ | Split button in tab bar, dropdown with profiles + "Run command..." action |
| 102 | Default indicator | ✅ | No ✓ shown (no default configured) — correct, --default CSS class absent |
| 103 | Quick command | ⚠️ | UI correct (inline input, Enter dispatches), spawn fails: local session "Closed" (env issue, not code) |
| 104 | Create profile (Settings) | ✅ | Full form: name, shell, mode, OS, cwd, elevated, args, icon, color, env, overrides. Saves + appears in list |
| 105 | Edit profile (Settings) | ✅ | Pre-filled, host overrides table (pin/hide/default per host), immediate update |
| 107 | Command palette ~ prefix | ✅ | ~ filters to PROFILES section only, badge "Profile", other types hidden |
| 109 | Reorder profiles | ✅ | Up/down arrows, boundary disable logic, DOM reorders immediately |

**Summary: 6/7 tested, 6 pass, 1 env warning (Sc.103)**

**Not tested (require active session):** Sc.106 (env masking round-trip), Sc.108 (Ctrl+Shift+1..9), Sc.110 (host OS visibility)

---

## Regression Markers

When a test fails, note the commit hash and which test. Fix before merging.

| Date | Test | Commit | Issue |
|------|------|--------|-------|
| 2026-03-06 | 3, 5, 6 | 0988ddb | Sidebar re-click + delete didn't open/close tabs |
| 2026-03-07 | 89 | 1f55b40, e74cc37 | Bell badge not showing on channel sidebar/tab bar for active tab |
| 2026-03-07 | 90 | 1f55b40 | Scroll-to-bottom cleared bell badge via clearChannel |
| 2026-03-07 | 91 | b013a6c | Auto-spawn on SSH host caused "Starting..." timeout tab |
| 2026-03-07 | 92 | 73336ae | Group rename/delete used system prompt()/confirm() |
| 2026-03-07 | 74, 93 | 3a95d32 | Unread bar: countNewlines returned 0 for Uint8Array + hidden pane scroll cleared unreadLines |
| 2026-03-07 | 68 | 3a95d32 | Host DnD: missing .prevent on @drop + race condition in reorder/fetchHosts |
| 2026-03-10 | 94 | 47b03c9 | Duplicate context menus: GroupContextMenu + ChannelGroupHeader inline menu both fired |
| 2026-03-10 | 95 | 47b03c9 | Dead channel DELETE failed: FK constraint on cache_index.channel_id without CASCADE |
| 2026-03-10 | 96 | 47b03c9 | Dead channel restart: local status not updated (stayed black) |
| 2026-03-10 | 97 | 47b03c9 | Pairing code action cleared auth token instead of generating code |
| 2026-03-10 | 98 | 47b03c9 | Post-pairing: theme/fonts/config not loaded (flash of defaults) |
| 2026-03-10 | 99 | 47b03c9 | Auto-switch: flush:sync watcher applied catppuccin-mocha default before server config loaded |
| 2026-03-10 | 100 | 47b03c9 | Ctrl+R refresh: layout rendered before theme loaded (theme flash) |
| 2026-03-10 | 1 | b037c40 | Sidebar "+" spawned directly (no tab), unlike tab bar "+" which uses openPendingTab |
| 2026-03-10 | 69 | b037c40 | Test connection read editHost values instead of form.value (ignored user input in edit mode) |
| 2026-03-10 | 69 | b037c40 | Tilde not expanded in SSH key paths (readFileSync("~/.ssh/...") fails) |
| 2026-03-10 | 69 | b037c40 | Encrypted OpenSSH ed25519 keys not detected (PEM header check missed modern format) |
| 2026-03-10 | 69 | b037c40 | AuthPromptDialog z-index 9500 hidden behind HostModal 10000 |
| 2026-03-10 | 69 | b037c40 | Client 15s timeout + server 60s timeout fired before user could enter passphrase |
