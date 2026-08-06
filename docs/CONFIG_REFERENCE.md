# lasterm — config.toml Reference

## Location

| Platform | Path |
|----------|------|
| Linux / macOS | `$XDG_CONFIG_HOME/lasterm/config.toml` (default: `~/.config/lasterm/config.toml`) |
| Windows | `%APPDATA%\lasterm\config.toml` |

## Config Cascade

Settings are resolved through four layers. Each layer deep-merges on top of the previous; the last layer wins.

| Priority | Source | Scope |
|----------|--------|-------|
| 1 | Built-in defaults (code) | Global |
| 2 | `config.toml` (this file) | Global |
| 3 | Per-host profile (`hosts.profile_json` in meta.db, set via API) | Per host |
| 3.5 | Agent visual hints (from HELLO message, ephemeral) | Per session |
| 4 | Per-channel profile (`channels.profile_json` in meta.db, set via API) | Per channel |

Merge rules: objects merge recursively, scalars overwrite, `null` removes a key (falls back to previous layer), arrays replace entirely.

Layers 3–4 (host and channel profiles) only accept `[terminal]` keys (font, theme, cursor, wallpaper, etc.). UI sections (`[tabs]`, `[search]`, `[appearance]`, etc.) are global-only and are ignored in per-host/per-channel profiles.

---

## Sections

### [terminal] — Terminal Profile Defaults

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| font_family | string | `"Consolas", "Liberation Mono", "Courier New", monospace` | Font family stack |
| font_size | number (8–72) | `14` | Font size in pixels |
| theme | string | `"catppuccin-mocha"` | Color theme name |
| theme_overrides | table | `{}` | Per-color overrides (e.g. `{ foreground = "#ffffff" }`) |
| cursor_style | `"block"` \| `"underline"` \| `"bar"` | `"block"` | Cursor shape |
| scrollback | number | `5000` | Scrollback buffer lines |
| bell_sound | boolean | `false` | Enable terminal bell sound |
| wallpaper | string | `""` | Wallpaper filename (jpg/jpeg/png/webp/gif/avif, max 10 MB) |
| wallpaper_blur | number (0–20) | `0` | Wallpaper blur in pixels |
| wallpaper_dim | number (0–100) | `0` | Wallpaper dim percentage |

---

### [tabs] — Tab Bar

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| close_button | boolean | `true` | Show close button on tabs |
| new_tab_position | `"end"` \| `"afterActive"` | `"end"` | Where new tabs appear |
| confirm_close_all | boolean | `true` | Confirm before closing all tabs |
| confirm_close_others | boolean | `true` | Confirm before closing other tabs |

---

### [panes] — Pane Splitting

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| max_panes | number | `4` | Max split panes per tab |
| default_split_direction | `"horizontal"` \| `"vertical"` | `"horizontal"` | Default split direction |

---

### [channels] — Channel / PTY Defaults

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| default_shell | string | system default | Shell to spawn (e.g. `/bin/zsh`) |
| default_group_name | string | `"General"` | Name for ungrouped channels |
| auto_group | `"none"` \| `"first"` | `"none"` | Auto-assign new channels to the first group |

---

### [startup] — Startup Behavior

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| auto_open_welcome | boolean | `true` | Auto-open welcome tab on host connect |

---

### [title] — Terminal and Window Title

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| source | `"dynamic"` \| `"static"` | `"dynamic"` | Use OSC escape codes or a static title |
| fallback | `"channel"` \| `"shell"` \| `"custom"` | `"channel"` | Fallback when no dynamic title is set |
| fallback_custom | string | — | Custom fallback string (when `fallback = "custom"`) |
| max_length | number | `50` | Max title display characters |
| truncation | `"start"` \| `"middle"` \| `"end"` | `"end"` | Ellipsis placement when title is truncated |
| prefix | string | — | Global prefix prepended to all tab titles |
| window_title | boolean | `true` | Update browser / window title |
| window_format | string | `"lasterm - {prefix}{host} - {title}"` | Window title format string |

---

### [search] — Find in Terminal

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| position | `"top-right"` \| `"bottom-right"` \| `"bottom-bar"` | `"top-right"` | Search box position |
| highlight_on_close | `"clear"` \| `"fade"` \| `"persist"` | `"clear"` | Search highlight behavior when closing the box |
| scrollbar_markers | boolean | `true` | Show match indicators in the scrollbar |
| history_size | number | `20` | Number of recent searches to remember |

---

### [layout] — UI Panel Dimensions

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| host_rail_width | number | `48` | Host rail width in pixels |
| sidebar_width | number | `200` | Channel sidebar width in pixels (0 = collapsed) |

---

### [ui] — UI Behavior

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| on_channel_dead | `"close"` \| `"readonly"` | `"readonly"` | Action when a channel process exits |

---

### [appearance] — Theme and Visual

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| theme | string | `"catppuccin-mocha"` | UI theme name |

#### [appearance.auto_switch] — Auto Theme Switching

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| enabled | boolean | `false` | Auto-switch theme based on system dark/light preference |
| dark_theme | string | `"catppuccin-mocha"` | Theme to apply in dark mode |
| light_theme | string | `"one-half-light"` | Theme to apply in light mode |

#### [appearance.opacity] — Component Opacity

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| terminal | number (0–100) | `100` | Terminal pane opacity % |
| sidebar | number (0–100) | `100` | Channel sidebar opacity % |
| host_rail | number (0–100) | `100` | Host rail opacity % |
| tab_bar | number (0–100) | `100` | Tab bar opacity % |

#### [appearance.scrollbar] — Scrollbar Customization

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| style | `"thin"` \| `"wide"` \| `"hidden"` | `"thin"` | Scrollbar size preset |
| thumb_color | string | from theme | Custom thumb color (hex, e.g. `"#888888"`) |
| track_color | string | from theme | Custom track color (hex) |
| width_thin | number | `6` | Pixel width used for the `thin` style |
| width_wide | number | `14` | Pixel width used for the `wide` style |

---

### [gc] — Garbage Collection

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| dead_retention_hours | number | `24` | Hours to keep dead channel output before GC (0 = immediate) |
| max_size_per_channel_mb | number | `10` | Max output storage per channel in MB |

---

### [agent] — Agent Daemon

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| socket_path | string | auto-detect | UDS / named pipe path for daemon IPC |
| buffer_per_channel | number \| string | `"1MB"` | Per-channel output buffer size (supports `KB`, `MB`, `GB`) |
| buffer_global | number \| string | `"20MB"` | Global output buffer limit across all channels |
| log_level | `"trace"` \| `"debug"` \| `"info"` \| `"warn"` \| `"error"` | `"info"` | Agent daemon log level |

---

## Example config.toml

```toml
# ~/.config/lasterm/config.toml

[terminal]
font_family = "JetBrains Mono, Consolas, monospace"
font_size = 13
theme = "catppuccin-mocha"
cursor_style = "bar"
scrollback = 10000

[tabs]
new_tab_position = "afterActive"

[panes]
max_panes = 4

[channels]
default_shell = "/bin/zsh"

[title]
source = "dynamic"
fallback = "channel"
max_length = 40
truncation = "middle"
window_title = true

[search]
position = "top-right"
history_size = 50

[appearance]
theme = "catppuccin-mocha"

[appearance.auto_switch]
enabled = true
dark_theme = "catppuccin-mocha"
light_theme = "one-half-light"

[appearance.opacity]
terminal = 95

[appearance.scrollbar]
style = "thin"

[gc]
dead_retention_hours = 48

[agent]
buffer_per_channel = "2MB"
log_level = "info"
```

---

## Notes

- All keys use `snake_case` in TOML. TypeScript interfaces use `camelCase`. Conversion between the two happens automatically at codec boundaries.
- Layers 3–4 (host/channel profiles) only support `[terminal]` keys. UI sections such as `[tabs]`, `[search]`, `[appearance]`, and `[gc]` are global-only.
- Setting a key to `null` in a profile JSON removes that key, causing resolution to fall back to the previous layer.
- The `[terminal].wallpaper` value is a filename, not a path. Files must be placed in `$XDG_CONFIG_HOME/lasterm/` (or the platform equivalent) and served by the hub.
- `buffer_per_channel` and `buffer_global` accept plain integers (bytes) or strings with a unit suffix: `"512KB"`, `"2MB"`, `"1GB"`.
