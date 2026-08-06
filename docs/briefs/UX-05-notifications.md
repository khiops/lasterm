# UX-05: Notifications

## Overview

Terminal activity and bell notifications with badges, desktop notifications,
sound, unread lines tracking, and configurable scroll behavior.

## Notification Types

| Type | Trigger | Visual | Urgency |
|------|---------|--------|---------|
| Activity | Any OUTPUT on inactive tab | Blue dot | Informational |
| Bell | BEL char (\x07) in output | Red badge (count) | Urgent |
| OSC 9 | iTerm2/ConEmu notification escape | Desktop notification | Explicit |

Activity and bell are visually distinct (industry standard: iTerm2, tmux).

## Visual Indicators

### Tab Bar

```
+----------------+ +------------------+ +------------------+
| [>_] zsh    [x]| | [>_] npm      [*]| | [>_] build   [3]|
+----------------+ +------------------+ +------------------+
   active            blue dot =          red badge =
                     activity             3 bells
```

### Channel Sidebar

```
+------------------+
| Channels         |
|                  |
| [>_] zsh      .  |  active, visible in tab, no notifications
| [>_] npm    * .  |  blue dot = activity, visible in tab
| [>_] build  3 o  |  red badge = 3 bells, detached
+------------------+
```

### Host Rail

```
+----------+
|  H  🟢   |  local
|  local   |
|          |
|  C  🟢 3 |  red badge = aggregated notifications
|  prod    |  across all channels on this host
+----------+
```

Badge on host rail = simple sum of unread bell counts across all channels
on that host (e.g., 3 channels x 5 bells = badge "15").

## Desktop Notifications (Notification API)

```
+--------------------------------------+
| lasterm - prod-server                |
|                                      |
| Build finished!                      |
| Channel: build (Terminal 3)          |
|                                      |
| [Show]  [Dismiss]                    |
+--------------------------------------+
```

Triggered by: BEL or OSC 9.
Only when tab/window is NOT focused (document.hidden or tab inactive).

### OSC 9 Notification

```
echo -e '\e]9;Build finished!\a'
```

Extracts the message text and shows it in the desktop notification body.
If no OSC 9 message, desktop notification shows generic "Bell in <channel>".

### Notification Grouping

If N bells arrive within 5 seconds, group into single desktop notification:
"N alerts in <channel>" instead of N separate notifications.

## Sound

| Setting | Behavior |
|---------|----------|
| "system" | Play system beep (default) |
| "custom" | Play user-provided sound file |
| "mute" | No sound |

Sound only on bell, not on activity.

## Scroll Behavior on Tab Switch

### The Problem

When switching to a background tab that has new output, two behaviors:
1. Traditional: always scroll to bottom (lose your place)
2. Discord-style: resume where you left, show "X new lines" bar

### Solution: Configurable with Smart Default

```
Mode "auto" (default):
  - < 100 new lines: resume position + "X new lines" bar
  - >= 100 new lines: scroll to bottom + "100+ new lines" badge

Mode "alwaysBottom":
  - Always scroll to bottom, badge clears immediately

Mode "alwaysResume":
  - Always resume, even with 10000 lines
```

Threshold (100 lines) is configurable.

### "Unread Lines" Bar

```
+--------------------------------------------------------------+
|  ...previous output...                                       |
|  [14:02:32] Compiling src/types.ts...                       |
|                                                              |
|  +-- 47 new lines --------------- [Mark as read] [v Jump] --+|
|                                                              |
|  [14:02:33] Warning: unused import 'foo'                    |
|  [14:02:34] Error: type mismatch in bar.ts:42               |
+--------------------------------------------------------------+
```

Actions:
- [Jump]: scroll to bottom, mark as read, clear badge
- [Mark as read]: dismiss bar, stay at current position, clear badge
- Natural scroll to bottom: bar disappears, badge clears
- Scroll up from bottom: bar does NOT reappear (only shows on tab switch)

### Badge Clear Rules

| Action | Activity dot | Bell badge |
|--------|--------------|------------|
| Tab active + scroll to bottom | Clear | Clear |
| Tab active + resume (not scrolled) | Stays | Stays |
| "Mark as read" click | Clear | Clear |
| "Jump to bottom" click | Clear | Clear |
| Natural scroll reaches bottom | Clear | Clear |

## Activity Detection

User-configurable threshold to avoid noise.

Note: activity debounce and "unread lines" bar are independent systems.
Debounce controls dot frequency. Unread bar is a cumulative line counter
since last focus — not affected by debounce setting.

| Setting | Default | Meaning |
|---------|---------|---------|
| activityMinLines | 1 | Min lines of output to trigger activity dot |
| activityDebounceMs | 500 | Debounce: no new dot if one was shown within this window |
| activityIgnoreEmpty | true | Ignore empty/whitespace-only output |

## Implementation Notes

### Bell Detection (Agent-side)

xterm.js headless fires `terminal.onBell()`. Agent sends to hub:

```typescript
// Option A: new message type
interface BellMessage {
  type: "BELL"
  channel_id: string
}

// Option B: piggyback on OUTPUT (add bell flag)
// Less clean but fewer message types
```

Decision: Option A — dedicated BELL message. No piggyback on OUTPUT.

### Activity Detection (UI-side)

Activity is detected locally in the UI: any OUTPUT received for a channel
whose tab is not active. No protocol change needed.

### OSC 9 (Agent-side)

xterm.js headless doesn't natively fire on OSC 9. Custom parser hook:

```typescript
terminal.parser.registerOscHandler(9, (data) => {
  // Send notification message to hub
  agent.send({ type: "NOTIFICATION", channel_id, message: data })
})
```

Hub broadcasts to UI, which triggers desktop notification.

## Settings

```toml
[notifications]
desktopNotifications = true        # Notification API permission
groupingWindowMs = 5000            # group bells within this window

[notifications.activity]
enabled = true
minLines = 1                       # min output lines to trigger
debounceMs = 500
ignoreEmpty = true

[notifications.bell]
enabled = true
sound = "system"                   # "system" | "custom" | "mute"
customSoundFile = ""               # path to .wav/.mp3
desktopNotification = true         # show desktop notification on bell

[notifications.osc9]
enabled = true
desktopNotification = true

[notifications.scroll]
mode = "auto"                      # "auto" | "alwaysBottom" | "alwaysResume"
autoThreshold = 100                # lines threshold for auto mode
```

## Future / Backlog

- P2: Per-channel notification settings (mute specific noisy channels)
- P2: Notification history panel (list of past bells/alerts)
- P2: Notification actions (e.g., "Run command on bell")
- P2: Badge count in browser tab title: "lasterm (3)"
- P2: Tray icon with badge count (Tauri)
