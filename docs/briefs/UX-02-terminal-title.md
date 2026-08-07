# UX-02: Terminal Title (OSC 0/2)

## Overview

Dynamic terminal titles from OSC escape sequences, configurable prefix,
window title, title history, and process icons.

## Technical Flow

```
PTY process           Agent                    Hub                    UI
    |                   |                        |                     |
    |-- OSC 0/2 ------->|                        |                     |
    |   "vim index.ts"  |                        |                     |
    |              xterm.js headless              |                     |
    |              onTitleChange()                |                     |
    |                   |                        |                     |
    |                   |-- TITLE_CHANGE ------->|                     |
    |                   |   { channel_id,        |                     |
    |                   |     title: "vim..." }  |                     |
    |                   |                        |                     |
    |                   |                   UPDATE DB                  |
    |                   |                   channels.dynamic_title     |
    |                   |                        |                     |
    |                   |-- OUTPUT (raw) ------->|-- WS OUTPUT ------->|
    |                   |                        |               xterm.js
    |                   |                        |           onTitleChange()
    |                   |                        |           tab update
    |                   |                        |           (instant,
    |                   |                        |            no round-trip)
```

### Dual approach

- UI: xterm.js parses OSC locally from OUTPUT stream -> instant tab update
- Agent -> Hub: TITLE_CHANGE message -> hub persists to DB for reconnect
- On reconnect: ATTACH_OK includes dynamicTitle from DB
- Multi-client: all connected clients receive same OUTPUT stream, all parse
  OSC locally. Reconnecting clients get title from DB.

## OSC Sequences Handled

| Sequence | Meaning | Action |
|----------|---------|--------|
| OSC 0 ; title ST | Set window + tab title | Update dynamic_title |
| OSC 2 ; title ST | Set window title only | Update dynamic_title |
| OSC 1 ; title ST | Set icon name | Ignored (backlog L) |

## Protocol Message

New message type (Agent -> Hub only):

```typescript
interface TitleChangeMessage {
  type: "TITLE_CHANGE"
  channel_id: string
  title: string
}
```

No new Hub -> UI message needed. UI handles title via local xterm.js
onTitleChange event from the OUTPUT stream.

On reconnect, ATTACH_OK includes the stored title:

```typescript
interface AttachOkMessage {
  // ... existing fields
  dynamic_title?: string  // last known title from DB
}
```

## DB Schema Change

```sql
ALTER TABLE channels ADD COLUMN dynamic_title TEXT DEFAULT NULL;
```

Updated on every TITLE_CHANGE from agent. Queried for:
- GET /api/channels responses (include dynamicTitle)
- ATTACH_OK on reconnect
- Channel sidebar display

## Tab Title Display

```
  Static mode:
  +------------+ +------------+ +------------+
  | Terminal 1  | | Terminal 2  | | Terminal 3  |
  +------------+ +------------+ +------------+

  Dynamic mode (user cd ~/projects then launches vim):
  +--------------+ +-------------------+ +--------------+
  | [cpu] btop   | | [>_] vim index.ts | | [>_] ~/proj   |
  +--------------+ +-------------------+ +--------------+
                     ^                      ^
                     OSC 0 from vim         OSC 0 from zsh PROMPT_COMMAND
```

## Window Title Format

Configurable format string with tokens:

```
Format: "lasterm - {prefix}{host} - {title}"

Examples:
  prefix=""      host="local"   title="vim"    -> "lasterm - local - vim"
  prefix="PROD " host="srv-01"  title="htop"   -> "lasterm - PROD srv-01 - htop"
  prefix=""      host="local"   title=""        -> "lasterm - local"
```

Available tokens: `{prefix}`, `{host}`, `{title}`, `{channel}`, `{shell}`

Prefix is per-host (with global fallback). The same prefix is used for
both static and dynamic title modes.

## Title History (UI-side)

The UI maintains a lightweight title stack per channel to handle fallback
when a child process exits and the title becomes empty before the shell
re-emits its PROMPT_COMMAND OSC:

```typescript
// In useTerminal composable
let titleStack: string[] = []
terminal.onTitleChange((title) => {
  if (title) titleStack.push(title)
  currentTitle.value = title || titleStack.at(-1) || fallbackTitle
})
```

The agent does NOT maintain a stack. The shell naturally restores the
title via PROMPT_COMMAND when a child process exits. The UI stack is
only a safety net for the brief gap between process exit and next prompt.

## Truncation

When title exceeds maxLength, truncate based on configured position:

| Position | Example (max 25) | Use case |
|----------|------------------|----------|
| end | `vim: src/components/v...` | Default, simplest |
| middle | `vim: src/co...t-name.vue` | Paths (keeps start + extension) |
| start | `...long-component-name.vue` | Deep paths (keeps filename) |

## Sanitization

All OSC title content is sanitized before storage and display:

- Strip HTML tags
- Strip control characters (except printable)
- Enforce maxRawLength (256 chars) before any processing
- XSS prevention: never inject raw title into innerHTML

## Title Priority (cross-ref UX-01)

Priority (highest wins):
1. **Custom** — user renamed tab via F2 → static, overrides all OSC
2. **Dynamic** — OSC 0/2 from process → real-time
3. **Fallback** — configurable (see below)

To restore dynamic mode after a custom rename: right-click tab →
"Reset title to dynamic" (see UX-01 context menu).

## Title Fallback

When no OSC title has been received (process never sends one), the tab
displays a configurable fallback:

| Fallback | Display |
|----------|---------|
| "channel" | Channel name (e.g., "Terminal 1") |
| "shell" | Shell basename (e.g., "zsh") |
| "custom" | User-defined string |

## Process Icons (from UX-01 Configure Command)

Icons are configured per-channel in the Configure Command dialog (UX-01),
not derived from OSC. They appear in both tab bar and channel sidebar.

```
Tab bar:
+--------------+ +------------------+ +--------------+
| [cpu] btop   | | [penguin] Ubuntu | | [>_] zsh      |
+--------------+ +------------------+ +--------------+

Channel sidebar (NO prefix here):
| [cpu] btop      * |
| [penguin] Ubuntu . |
| [>_] zsh        o |
```

Two icon sources:
1. Configured: user sets in Configure Command dialog (penguin for WSL, etc.)
2. Default: `[>_]` for standard shell (configurable globally)

Channel icon (tab bar + sidebar) and host icon (host rail only) are
independent — no inheritance between them. See UX-03 for host icons.

Auto-detection from process name deferred to P2.

## Prefix Scope

- Per-host: set in host profile (e.g., "PROD " for production server)
- Global fallback: set in global config
- Prefix appears in: tab title, window title
- Prefix does NOT appear in: channel sidebar

## Settings

```toml
[terminal.title]
source = "dynamic"                 # "dynamic" | "static"
fallback = "channel"               # "channel" | "shell" | "custom"
fallbackCustom = ""                # when fallback = "custom"
prefix = ""                        # per-host overridable via host profile
windowTitle = true                 # update browser/window title
windowTitleFormat = "lasterm - {prefix}{host} - {title}"
maxLength = 30
truncation = "end"                 # "end" | "middle" | "start"

[terminal.title.sanitize]
stripHtml = true
stripControlChars = true
maxRawLength = 256

[terminal.icon]
default = ">_"                     # default icon for shells
# Per-channel icons set via Configure Command dialog
```

## Backlog

- OSC 1 (icon name): currently ignored, backlog L priority
- P2: auto-detect process icon from running process name
- P2: per-host icon presets (e.g., all channels on prod get a red dot)
