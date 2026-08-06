---
doc-meta:
  status: canonical
  scope: agent, hub, shared, web
  type: specification
  target_project: /mnt/wsl/shared/dev/lasterm
  created: 2026-03-07
  updated: 2026-03-07
  complexity: COMPLEX
  time-budget: 7h
  adversarial_applied: true
  llm_spec_applied: true
---

# Specification: UX-05 Notifications

## 0. Quick Reference (ALWAYS VISIBLE)

| Item | Value |
|------|-------|
| Scope | agent, hub, shared, web |
| Complexity | COMPLEX |
| Time budget | 7h |
| Blocks | 7 |
| BDD scenarios | 32 |
| Risk level | MEDIUM |

## 1. Problem Statement

Users have no way to know when background terminals produce output or receive bell signals. There are no activity indicators, no bell badges, no desktop notifications, no sound alerts, and no "unread lines" tracking. This story delivers the full notification pipeline from agent bell/OSC 9 detection through hub routing to UI visual indicators, desktop notifications, sound, and scroll behavior management.

## 2. User Stories

### US-01: Activity & Bell Awareness
AS A lasterm user running multiple terminals
I WANT to see which background tabs have new output or bell alerts
SO THAT I can notice important events without constantly switching tabs

ACCEPTANCE: Blue dot for activity, red badge with count for bells, badges on tabs + sidebar + host rail

### US-02: Desktop Notifications
AS A user working in another application
I WANT to receive desktop notifications when a terminal rings the bell or sends OSC 9
SO THAT I don't miss build completions, errors, or explicit alerts

ACCEPTANCE: Notification API integration, grouping within 5s window, click-to-focus

### US-03: Scroll Resume & Unread Lines
AS A user switching between tabs
I WANT to see where I left off and how many new lines appeared
SO THAT I can review new output without losing my scroll position

ACCEPTANCE: Configurable scroll mode (auto/alwaysBottom/alwaysResume), unread lines bar, mark-as-read

## 3. Business Rules

### 3.1 Invariants (always true)

- INV-01: Activity dot is blue, bell badge is red — never the same color
- INV-02: Activity is detected UI-side only (any non-whitespace OUTPUT on inactive tab) — no protocol change. Whitespace-only output is ignored (SC-09).
- INV-03: Bell detection happens agent-side via xterm.js headless onBell() — sends BELL message
- INV-04: OSC 9 detection happens agent-side via parser hook — sends NOTIFICATION message
- INV-05: Desktop notifications only fire when document.hidden or tab is not focused
- INV-06: Sound plays only on bell, never on activity
- INV-07: Badge counts are per-channel, host rail shows aggregated sum across channels
- INV-08: Unread lines bar only appears on tab switch, not on scroll-up from bottom
- INV-09: Custom sound file MUST be a filename only (no path separators), resolved relative to ~/.config/lasterm/sounds/. Hub serves at /public/sounds/. Absolute paths and URLs rejected.
- INV-10: Agent MUST throttle BELL messages to at most 1 per 100ms per channel. OSC 9 NOTIFICATION messages throttled to 1 per 500ms per channel.
- INV-11: Hub MUST rate-limit BELL forwarding to at most 10 per second per channel. NOTIFICATION messages rate-limited to 5 per second per channel.
- INV-12: OSC 9 message text MUST be sanitized agent-side: strip control characters, strip HTML tags, truncate to 256 chars, trim whitespace.

### 3.2 Preconditions (required before action)

- PRE-01: Desktop notifications require Notification API permission granted by user
- PRE-02: Custom sound requires a valid audio file path configured
- PRE-03: Activity detection requires channel tab to be NOT the currently active tab

### 3.3 Effects (what changes)

- EFF-01: BEL char in PTY output → agent sends BELL message → hub forwards to UI → bell count increments
- EFF-02: OSC 9 escape in PTY output → agent sends NOTIFICATION message → hub forwards to UI → desktop notification shown
- EFF-03: OUTPUT received on inactive tab → activity dot appears (subject to debounce)
- EFF-04: Tab becomes active + scroll to bottom → both activity dot and bell badge clear
- EFF-05: "Mark as read" click → both badges clear, scroll position maintained
- EFF-06: "Jump to bottom" click → both badges clear, scrolls to bottom
- EFF-07: Natural scroll reaches bottom → both badges clear

### 3.4 Error Handling

- ERR-01: Notification API permission denied → silently skip desktop notifications, show setting as disabled
- ERR-02: Custom sound file not found → fall back to system beep, log warning
- ERR-03: OSC 9 with empty message → use generic "Bell in <channel>" for notification body
- ERR-04: After WS reconnect, all background channels SHOULD be conservatively marked with activity dots (output may have occurred during disconnect).

## 4. Technical Design

### 4.1 Architecture Decision

Three-layer pipeline: Agent detects (bell + OSC 9) → Hub routes (broadcast to UI clients) → UI renders (badges, notifications, sound, unread bar). Activity tracking is purely UI-side — no new protocol for OUTPUT activity, only BELL and NOTIFICATION are new message types. Unread lines bar is a UI component that counts OUTPUT messages per channel since last focus.

### 4.2 Data Model Changes

No database schema changes. Bell counts and activity state are ephemeral (in-memory in UI).

| Entity | Change | Migration needed |
|--------|--------|------------------|
| (none) | — | No |

### 4.3 API Contract

No new REST endpoints. All notification data flows through WebSocket.

### 4.4 Protocol Messages (new)

```typescript
// Agent → Hub (MessagePack, snake_case on wire)
interface AgentBellMessage {
  type: "BELL"
  channel_id: string
}

interface AgentNotificationMessage {
  type: "NOTIFICATION"
  channel_id: string
  message: string  // OSC 9 text
}

// Hub → UI (WebSocket, camelCase)
interface HubBellMessage {
  type: "BELL"
  channelId: string
}

interface HubNotificationMessage {
  type: "NOTIFICATION"
  channelId: string
  message: string
}
```

**Design note:** Agent-side throttling: BELL debounced to 1 per 100ms per channel, OSC 9 debounced to 1 per 500ms per channel. Hub-side rate limiting: max 10 BELL/sec and 5 NOTIFICATION/sec per channel forwarded to UI.

### 4.5 Type Definitions (shared)

```typescript
type ScrollMode = "auto" | "alwaysBottom" | "alwaysResume"
type BellSound = "system" | "custom" | "mute"

interface NotificationConfig {
  desktopNotifications: boolean
  groupingWindowMs: number  // default 5000

  activity: {
    enabled: boolean
    minLines: number          // default 1
    debounceMs: number        // default 500
  }

  bell: {
    enabled: boolean
    sound: BellSound          // default "system"
    customSoundFile: string   // filename only, no path separators
    desktopNotification: boolean  // default true
  }

  osc9: {
    enabled: boolean
    desktopNotification: boolean  // default true
  }

  scroll: {
    mode: ScrollMode          // default "auto"
    autoThreshold: number     // default 100
  }
}
```

### 4.6 Config Additions

```toml
[notifications]
desktopNotifications = true
groupingWindowMs = 5000

[notifications.activity]
enabled = true
minLines = 1
debounceMs = 500

[notifications.bell]
enabled = true
sound = "system"
customSoundFile = ""
desktopNotification = true

[notifications.osc9]
enabled = true
desktopNotification = true

[notifications.scroll]
mode = "auto"
autoThreshold = 100
```

## 5. Acceptance Criteria (BDD)

### Scenario Group: Bell Detection Pipeline

```gherkin
@priority:high @type:nominal
Scenario: SC-01 Bell character triggers badge
  Given channel "build" is running in a background tab
  When the PTY outputs BEL char (\x07)
  Then the agent sends a BELL message to hub
  And the hub forwards BELL to all connected UI clients
  And the bell badge on "build" tab shows "1"

@priority:high @type:nominal
Scenario: SC-02 Multiple bells accumulate count
  Given channel "build" has 2 unread bells
  When a 3rd bell arrives
  Then the bell badge shows "3"

@priority:medium @type:edge
Scenario: SC-03 Bell on active tab does not badge
  Given channel "build" is the currently active tab
  When the PTY outputs BEL char
  Then no bell badge appears
  But sound still plays (if enabled)
```

### Scenario Group: OSC 9 Notifications

```gherkin
@priority:high @type:nominal
Scenario: SC-04 OSC 9 triggers desktop notification
  Given desktop notifications are enabled and permitted
  And channel "build" is running in a background tab
  When the PTY outputs '\e]9;Build finished!\a'
  Then a desktop notification shows: title "lasterm - prod-server", body "Build finished!"

@priority:medium @type:edge
Scenario: SC-05 OSC 9 with empty message
  Given channel "build" is in background
  When the PTY outputs '\e]9;\a' (empty message)
  Then the desktop notification shows generic "Bell in build"

@priority:medium @type:nominal
Scenario: SC-06 OSC 9 when tab is focused
  Given channel "build" is the active tab and window is focused
  When the PTY outputs OSC 9
  Then no desktop notification is shown
```

### Scenario Group: Activity Detection

```gherkin
@priority:high @type:nominal
Scenario: SC-07 Activity dot on background output
  Given channel "npm" is running in a background tab
  And activity detection is enabled with minLines=1
  When 1 line of OUTPUT arrives
  Then a blue activity dot appears on the "npm" tab

@priority:medium @type:nominal
Scenario: SC-08 Activity debounce
  Given channel "npm" already has an activity dot
  And debounceMs is 500
  When more OUTPUT arrives within 500ms
  Then no additional activity event fires (dot already visible)

@priority:medium @type:edge
Scenario: SC-09 Empty output ignored (hardcoded)
  Given activity detection is enabled
  When OUTPUT contains only whitespace
  Then no activity dot appears

@priority:medium @type:edge
Scenario: SC-10 Activity with high minLines threshold
  Given activityMinLines is 5
  When only 3 lines of OUTPUT arrive on a background tab
  Then no activity dot appears
  When 2 more lines arrive (total 5)
  Then the activity dot appears
```

### Scenario Group: Desktop Notifications

```gherkin
@priority:high @type:nominal
Scenario: SC-11 Desktop notification on bell (window hidden)
  Given the browser tab is hidden (document.hidden = true)
  And bell desktop notification is enabled
  When a BELL arrives for channel "build"
  Then a desktop notification shows: "lasterm - host", "Bell in build"

@priority:medium @type:nominal
Scenario: SC-12 Notification grouping within window
  Given groupingWindowMs is 5000
  When 5 bells arrive within 3 seconds for channel "build"
  Then only 1 desktop notification shows: "5 alerts in build"

@priority:medium @type:error
Scenario: SC-13 Notification permission denied
  Given the user denied Notification API permission
  When a bell arrives
  Then no desktop notification shows
  And the bell badge still increments normally

@priority:low @type:nominal
Scenario: SC-14 Click notification focuses tab
  Given a desktop notification is showing for channel "build"
  When the user clicks the notification
  Then the browser window focuses
  And the "build" tab becomes active
```

### Scenario Group: Sound

```gherkin
@priority:high @type:nominal
Scenario: SC-15 System bell sound on bell
  Given bell sound is set to "system"
  When a BELL arrives
  Then the system beep plays

@priority:medium @type:nominal
Scenario: SC-16 Custom sound file
  Given bell sound is set to "custom" with a valid .wav file path
  When a BELL arrives
  Then the custom sound file plays

@priority:medium @type:error
Scenario: SC-17 Muted bell
  Given bell sound is set to "mute"
  When a BELL arrives
  Then no sound plays
  But the bell badge still increments
```

### Scenario Group: Badge Clear Rules

```gherkin
@priority:high @type:nominal
Scenario: SC-18 Tab active + scroll to bottom clears both
  Given channel "build" has activity dot and bell badge "3"
  When the user switches to "build" tab
  And the terminal is scrolled to the bottom
  Then both activity dot and bell badge clear

@priority:high @type:nominal
Scenario: SC-19 Tab active but not scrolled keeps badges
  Given channel "build" has activity dot and bell badge "3"
  And the terminal has 200 unread lines (scroll position not at bottom)
  When the user switches to "build" tab
  Then badges remain visible
  And unread lines bar appears

@priority:medium @type:nominal
Scenario: SC-20 Mark as read clears badges
  Given channel "build" is active with unread lines bar visible
  When the user clicks "Mark as read"
  Then both activity dot and bell badge clear
  And unread lines bar disappears
  And scroll position is maintained
```

### Scenario Group: Unread Lines Bar

```gherkin
@priority:high @type:nominal
Scenario: SC-21 Unread lines bar on tab switch (auto mode)
  Given scroll mode is "auto" with threshold 100
  And channel "build" received 47 new lines while inactive
  When the user switches to "build" tab
  Then an unread lines bar shows "47 new lines" with [Mark as read] [Jump] buttons
  And the terminal resumes at the previous scroll position

@priority:medium @type:nominal
Scenario: SC-22 Auto mode scrolls to bottom above threshold
  Given scroll mode is "auto" with threshold 100
  And channel "build" received 150 new lines while inactive
  When the user switches to "build" tab
  Then the terminal scrolls to bottom
  And a "150+ new lines" badge shows briefly

@priority:medium @type:nominal
Scenario: SC-23 Always bottom mode
  Given scroll mode is "alwaysBottom"
  When the user switches to a tab with 50 new lines
  Then the terminal always scrolls to bottom
  And no unread lines bar appears

@priority:medium @type:nominal
Scenario: SC-24 Always resume mode
  Given scroll mode is "alwaysResume"
  When the user switches to a tab with 500 new lines
  Then the terminal resumes at previous position
  And unread lines bar shows "500 new lines"
```

### Scenario Group: Host Rail Aggregation

```gherkin
@priority:medium @type:nominal
Scenario: SC-25 Host rail aggregated badge
  Given host "prod" has 3 channels: 2 with bell badges (5 + 3)
  Then the host rail shows badge "8" on the "prod" host icon
```

### Scenario Group: Bell Flood Protection

```gherkin
@priority:high @type:edge
Scenario: SC-26 Bell flood throttled at agent
  Given a PTY outputs BEL char 100 times within 100ms
  When the agent processes the output
  Then only 1 BELL message is sent to the hub
```

### Scenario Group: Security

```gherkin
@priority:high @type:security
Scenario: SC-27 OSC 9 HTML injection stripped
  Given a PTY outputs OSC 9 with message '<script>alert(1)</script>'
  When the agent processes it
  Then the NOTIFICATION message has HTML tags stripped

@priority:medium @type:security
Scenario: SC-28 OSC 9 long message truncated
  Given a PTY outputs OSC 9 with 500-char message
  When processed
  Then truncated to 256 chars

@priority:high @type:security
Scenario: SC-29 Custom sound path traversal rejected
  Given notifications.bell.customSoundFile is '../../etc/passwd'
  When validated
  Then rejected (path separators not allowed), falls back to system
```

### Scenario Group: Activity Detection (continued)

```gherkin
@priority:medium @type:edge
Scenario: SC-30 WS reconnect marks background channels with activity
  Given WS reconnects after 10s with 3 background channels
  When STATE_SYNC received
  Then all 3 channels show activity dots (conservative)
```

### Scenario Group: Bell Detection Pipeline (continued)

```gherkin
@priority:medium @type:edge
Scenario: SC-31 Bell on active tab plays sound but no badge
  Given channel 'build' is active tab and bell sound='system'
  When BELL arrives
  Then sound plays BUT badge does NOT increment
```

### Scenario Group: Hub Bell Rate Limiting

```gherkin
@priority:high @type:nominal
Scenario: SC-32 Hub rate-limits bell forwarding
  Given remote agent sends 50 BELL in 1s
  When hub processes
  Then at most 10 forwarded to UI
```

### Coverage Matrix

| Scenario | Nominal | Edge | Error | Security |
|----------|---------|------|-------|----------|
| SC-01 | X | | | |
| SC-02 | X | | | |
| SC-03 | | X | | |
| SC-04 | X | | | |
| SC-05 | | X | | |
| SC-06 | X | | | |
| SC-07 | X | | | |
| SC-08 | X | | | |
| SC-09 | | X | | |
| SC-10 | | X | | |
| SC-11 | X | | | |
| SC-12 | X | | | |
| SC-13 | | | X | |
| SC-14 | X | | | |
| SC-15 | X | | | |
| SC-16 | X | | | |
| SC-17 | | | X | |
| SC-18 | X | | | |
| SC-19 | X | | | |
| SC-20 | X | | | |
| SC-21 | X | | | |
| SC-22 | X | | | |
| SC-23 | X | | | |
| SC-24 | X | | | |
| SC-25 | X | | | |
| SC-26 | | X | | |
| SC-27 | | | | X |
| SC-28 | | | | X |
| SC-29 | | | | X |
| SC-30 | | X | | |
| SC-31 | | X | | |
| SC-32 | X | | | |

**Coverage: 18 nominal, 7 edge, 2 error, 3 security = 32 total**


## 6. Implementation Plan

### Block 1: Protocol + Shared Types — 30min
**Type:** Feature slice
**Dependencies:** None
**Packages:** shared

**Files:**
- `packages/shared/src/protocol.ts` — add BELL, NOTIFICATION to AgentToHubMessage and HubToUiMessage unions
- `packages/shared/src/config.ts` — add NotificationConfig type, extend DEFAULT_PROFILE with notification defaults

**Exit criteria:**
- [ ] BELL and NOTIFICATION message types defined in protocol
- [ ] NotificationConfig type with all sub-sections
- [ ] DEFAULT_PROFILE includes notification defaults
- [ ] Shared package builds cleanly

### Block 2: Agent Bell + OSC 9 Detection — 45min
**Type:** Feature slice
**Dependencies:** Block 1
**Packages:** agent

**Files:**
- `packages/agent/src/headless.ts` — add onBell(callback) method wrapping terminal.onBell, add registerOsc9Handler(callback) wrapping terminal.parser.registerOscHandler(9, ...). OSC 9 handler returns true (handled). Store IDisposable, call dispose() in HeadlessTerminal.dispose().
- `packages/agent/src/pty.ts` — add onBell(channelId, callback) and onOsc9(channelId, callback) delegation, same pattern as onTitleChange().
- `packages/agent/src/handler.ts` — add setupBellHandler() and setupOsc9Handler() following setupTitleChangeHandler pattern, called from handleSpawn(). Include per-channel throttle timers (100ms bell, 500ms OSC 9).

**Exit criteria:**
- [ ] HeadlessTerminal detects BEL char via onBell() callback
- [ ] HeadlessTerminal detects OSC 9 via parser.registerOscHandler(9, ...)
- [ ] BELL message sent with correct channelId
- [ ] NOTIFICATION message sent with OSC 9 text
- [ ] Empty OSC 9 sends empty string (UI handles fallback text)
- [ ] OSC 9 message sanitized: strip control chars, strip HTML, truncate 256 chars, trim
- [ ] Bell throttled to 1 per 100ms per channel
- [ ] OSC 9 throttled to 1 per 500ms per channel

### Block 3: Hub Routing + Sound Serving — 45min
**Type:** Feature slice
**Dependencies:** Block 1
**Packages:** hub

**Files:**
- `packages/hub/src/session/session-manager.ts` — wire BELL/NOTIFICATION from agent events to _broadcastToChannel
- `packages/hub/src/api/server.ts` — register @fastify/static for `~/.config/lasterm/sounds/` at `/public/sounds/` (same pattern as `/public/fonts/`, `decorateReply: false`). Auth bypass for `/public/sounds/` path.

**Exit criteria:**
- [ ] BELL messages from agent forwarded to all connected UI WS clients
- [ ] NOTIFICATION messages from agent forwarded to all connected UI WS clients
- [ ] Messages include channelId for UI routing
- [ ] Hub rate-limits BELL to 10/sec/channel, NOTIFICATION to 5/sec/channel
- [ ] BELL and NOTIFICATION branches added to _wireAgentEvents if/else chain
- [ ] Hub serves custom sound files from ~/.config/lasterm/sounds/ at /public/sounds/
- [ ] Sound file validation: filename-only (no path separators), .wav/.mp3/.ogg extensions only

### Block 4: Notification Store + Activity Tracking — 1h
**Type:** Feature slice
**Dependencies:** Block 1
**Packages:** web

**Design note:** Bell counts use shallowRef<Map<string, number>>. Notification store exposes two entry points: incrementBellCount(channelId) for badges (only when not active tab), and onBellReceived event (always, for sound). Move existing unreadChannels from channelsStore to notificationStore. Coordination: clearChannel(id) called on channel removal, clearAll(id) on select+scroll-bottom.

**Files:**
- `packages/clients/web/src/stores/notifications.ts` — Pinia store for bell counts, activity dots, unread line counts
- `packages/clients/web/src/composables/useActivityTracker.ts` — debounced activity detection on OUTPUT messages

**Exit criteria:**
- [ ] Bell counts tracked per channel, increment on BELL message
- [ ] Activity dot tracked per channel, set on OUTPUT for inactive tab
- [ ] Activity debounce respects debounceMs setting
- [ ] Activity minLines threshold enforced
- [ ] Empty output ignored (hardcoded behavior, always true)
- [ ] Badge clear on: tab active + scroll bottom, mark-as-read, jump-to-bottom
- [ ] Host rail aggregation: sum of bell counts across channels per host

### Block 5: Visual Indicators (Tab, Sidebar, Rail) — 1h
**Type:** Feature slice
**Dependencies:** Block 4
**Packages:** web

**Files:**
- `packages/clients/web/src/components/TabBar.vue` — blue dot + red badge rendering
- `packages/clients/web/src/components/ChannelSidebar.vue` — blue dot + red badge
- `packages/clients/web/src/components/HostRail.vue` — aggregated red badge (depends on UX-03, adapt if not yet done)

**Exit criteria:**
- [ ] Blue dot (activity) visible on tab + sidebar for inactive channels with output
- [ ] Red badge with count visible on tab + sidebar for channels with bells
- [ ] Host rail shows aggregated bell count badge
- [ ] Badges styled distinctly (blue dot = 6px circle, red badge = rounded rect with number)

### Block 6: Desktop Notifications + Sound — 1h
**Type:** Feature slice
**Dependencies:** Block 4
**Packages:** web

**Files:**
- `packages/clients/web/src/composables/useDesktopNotifications.ts` — Notification API wrapper, grouping, click handler
- `packages/clients/web/src/composables/useBellSound.ts` — audio playback (system beep, custom file, mute)

**Exit criteria:**
- [ ] Permission request on first bell (if not already granted)
- [ ] Desktop notification shows on BELL when document.hidden
- [ ] Desktop notification shows on NOTIFICATION (OSC 9) with message text
- [ ] Grouping: N bells within groupingWindowMs → single notification "N alerts in <channel>"
- [ ] Click notification → focus window + activate channel tab
- [ ] Sound: system beep (AudioContext sine wave), custom file (Audio element), mute
- [ ] Sound only on bell, not on activity
- [ ] AudioContext created lazily on first user interaction (click/keypress) — not on first bell
- [ ] OSC 9 message HTML-stripped before Notification API body (defense-in-depth for Linux daemons)
- [ ] Grouping uses Notification API tag parameter: lasterm-bell-${channelId}. BELL and OSC 9 have separate tags.
- [ ] Grouping timers cleared on: channel removal, WS disconnect, composable unmount. dispose() returned.

### Block 7: Unread Lines Bar + Scroll Behavior — 1.5h
**Type:** Feature slice
**Dependencies:** Block 4
**Packages:** web

**Design note:** Unread line count = newline chars (0x0A) in OUTPUT Uint8Array data. Approximation (no terminal wrapping). Display caps at '999+ new lines'. Activity minLines uses same 0x0A counting for consistency.

**Files:**
- `packages/clients/web/src/components/UnreadLinesBar.vue` — overlay bar with line count, Mark as read, Jump buttons
- `packages/clients/web/src/composables/useScrollBehavior.ts` — scroll mode logic, line counter, resume/jump

**Exit criteria:**
- [ ] Unread line counter increments for each OUTPUT on inactive tab
- [ ] On tab switch (auto mode, < threshold): resume position + bar with "N new lines"
- [ ] On tab switch (auto mode, >= threshold): scroll to bottom + brief badge
- [ ] "Mark as read" clears badges, dismisses bar, keeps scroll position
- [ ] "Jump to bottom" clears badges, scrolls to bottom
- [ ] Natural scroll to bottom clears badges and dismisses bar
- [ ] Scroll up from bottom does NOT re-show bar
- [ ] alwaysBottom mode: always scrolls to bottom, no bar
- [ ] alwaysResume mode: always resumes, always shows bar if new lines
- [ ] Buffer trimming: if scrollback exceeded and resume marker is invalid/disposed, fall back to top of available buffer

## 7. Test Strategy

### Test Pyramid

| Level | Count | Focus |
|-------|-------|-------|
| Unit | 20 | Activity tracker, bell counter, grouping logic, scroll mode, sound selection |
| Integration | 8 | Agent bell/OSC 9 pipeline, hub routing, notification store lifecycle |
| E2E | 5 | Bell badge flow, activity dot flow, unread bar, desktop notification, sound |

### Test Data Requirements

**Fixtures:**
- PTY output containing BEL char (\x07)
- PTY output containing OSC 9 escape ('\e]9;message\a')
- Multiple OUTPUT messages for activity threshold testing
- NotificationConfig variations (all combos of enabled/disabled)

**Mocks:**
- Notification API (window.Notification)
- AudioContext for system beep
- document.hidden for visibility detection
- xterm.js onBell/parser for agent tests

### Per-Block Test Mapping

| Block | Unit | Integration | E2E |
|-------|------|-------------|-----|
| 1: Protocol + Types | 2 | — | — |
| 2: Agent Bell + OSC 9 | 4 | 2 | — |
| 3: Hub Routing | — | 2 | — |
| 4: Notification Store | 6 | 2 | — |
| 5: Visual Indicators | 3 | — | 2 |
| 6: Desktop + Sound | 3 | 1 | 2 |
| 7: Unread Bar + Scroll | 2 | 1 | 1 |

## 8. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Notification API not available (non-HTTPS in dev) | M | M | localhost is exempted; Vite dev server already serves on localhost |
| OSC 9 handler conflicts with xterm.js internal handling | M | L | Test thoroughly; xterm.js headless has no built-in OSC 9 handler |
| High-frequency bells overwhelming UI | M | M | Grouping window (5s) + badge cap display (show "99+" for > 99) |
| Audio autoplay blocked by browser | M | M | User interaction required before AudioContext creation; request on first bell click |
| Performance: line counting on every OUTPUT | L | L | Simple counter increment, no content parsing needed |

## 9. Definition of Done

- [ ] All 7 blocks implemented
- [ ] All 32 BDD scenarios have passing tests
- [ ] All tests pass (unit + integration + e2e)
- [ ] Lint/typecheck pass
- [ ] Bell detection works end-to-end (agent → hub → UI badge)
- [ ] OSC 9 triggers desktop notification with message
- [ ] Activity dot appears on background tab output
- [ ] Desktop notifications group within 5s window
- [ ] Sound plays on bell (system/custom/mute modes)
- [ ] Unread lines bar works in all 3 scroll modes
- [ ] Badge clear rules verified for all trigger conditions
- [ ] Code review clean (no blocking findings)

## 10. Dependencies & Integration Notes

- **UX-01 (complete):** TabBar, ChannelSidebar — badges render inside these components
- **UX-03 (Sprint 2):** HostRail — aggregated badge on host icon; if UX-03 not yet done, skip host rail badge (add in UX-03)
- **UX-06 (complete):** Theming — badge colors use CSS vars
- **Protocol:** BELL and NOTIFICATION added to shared protocol types; both use existing broadcast pattern (like TITLE_CHANGE)
- **Config:** notifications section added to config.toml and DEFAULT_PROFILE
