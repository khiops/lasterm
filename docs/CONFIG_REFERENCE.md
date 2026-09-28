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
| 3.5 | Agent visual hints (from HELLO message, ephemeral). No agent sends any today, so this layer is empty (SPEC.md § 4.4) | Per session |
| 4 | Per-channel profile (`channels.profile_json` in meta.db, set via API) | Per channel |

Merge rules: objects merge recursively, scalars overwrite, `null` removes a key (falls back to previous layer), arrays replace entirely. `[terminal] env` is the exception: a `null` there is a removal that reaches the terminal (see below).

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
| bell_sound | `"mute"` \| `"system"` \| `"custom"` | `"mute"` | Sound when the terminal receives BEL: none, a generated tone, or `bell_custom_file` |
| bell_custom_file | string | — | With `bell_sound = "custom"`: a file name in the config dir's `sounds/` (.wav, .mp3, .ogg) |
| bell_badge | boolean | `true` | Mark the terminal's tab when it receives BEL |
| scrollbar_markers | boolean | `true` | Mark a search's matches in the terminal's scrollbar. With `[appearance.scrollbar] style = "hidden"`, the gutter kept for them goes too. Settings › Search › Scrollbar Markers, for every host, one host or one terminal. Until this key is set, a `scrollbar_markers` under `[search]`, where Settings used to write the choice, stands in for it; the first write of this key from Settings removes that one (#614) |
| wallpaper | string | `""` | Wallpaper filename (jpg/jpeg/png/webp/gif/avif, max 10 MB) |
| wallpaper_blur | number (0–20) | `0` | Wallpaper blur in pixels |
| wallpaper_dim | number (0–100) | `0` | Wallpaper dim percentage |
| background_mode | `"image"` \| `"solid"` \| `"transparent"` | `"image"` | `image`: the wallpaper, solid when there is none; `solid`: the theme's opaque background; `transparent`: see-through in the desktop app, solid in a browser (SPEC.md § 6) |
| window_effect | `"none"` \| `"mica"` \| `"acrylic"` \| `"vibrancy-*"` | `"none"` | Desktop only, with `background_mode = "transparent"`: the native material behind the window. Windows 11 offers `none`, `mica` and `acrylic`, macOS the vibrancy variants; `auto` and `blur` still resolve. Moving between see-through and a material takes effect at the next launch (SPEC.md § 6) |
| env_mode | `"inherit"` \| `"minimal"` | `"inherit"` | What a terminal's environment starts from, applied by the agent on the terminal's host: `inherit`, the environment that agent runs with; `minimal`, only what programs need to run (`HOME`, `USER`, `PATH`, `LANG`, `LC_*`… on Unix; `SystemRoot`, `Path`, `USERPROFILE`, `TEMP`… on Windows — the full lists are in PROTOCOL.md § 3.2), taken from it, never invented. Either way the inherited `NO_COLOR` is dropped and the terminal says what it is: `TERM=xterm-256color` (Unix), `COLORTERM=truecolor`, `TERM_PROGRAM=lasterm`, `TERM_PROGRAM_VERSION`. `env` can remove or change any of them |
| env | table of name → string or `false` | `{}` | Changes to that start, for every terminal: a string sets the variable, `false` removes it (TOML has no null; host and terminal profiles write `null`). A host's `env` changes what this one sets, a terminal's both, and the same name set closer wins, either way. Only the changes are stored, never the environment they produce: a variable that appears on the host later still reaches new terminals unless it is removed. A launch profile's own `env`, then the spawn request's, are applied over these. Names compare without case on Windows hosts. Stored in the clear: no place for secrets. Reaches new and restarted terminals, never running ones. Example: `env = { EDITOR = "hx", PAGER = false }` |
| when_ended | `"ask"` \| `"restart"` \| `"close"` | `"ask"` | What a pane does when the terminal in it ends. `ask` shows Restart and Close over it. `restart` brings it back, except one that ended within 5 seconds of starting, one that runs a command, and one whose write lock another window holds: those show the overlay, saying why. `close` closes its pane, deleting the terminal unless `[panes] keep_ended` keeps it. Neither applies, as it happens, to a terminal stopped from elsewhere — killed, its session closed, its agent replaced, or Lasterm quit — which keeps the overlay, saying so. A terminal found already ended, at launch or on a reload or an attach, shows the overlay first, then follows the setting once, when its pane is on screen (its tab is shown, or it is a split beside the one shown) in the window that has the focus: never in the background, and never in two windows at once. That includes one that ended with its agent replaced or with Lasterm quitting. It keeps asking when it was killed, it or its session, when it runs a command, and when a restart from that pane ended before the pane could reach it; one restarted this way that ends again within 5 seconds is held back as above. Set for every host here, or for one host or one terminal in Settings › Terminal. "Always do this" on the overlay, for this host or everywhere, writes it too, and drop the overrides nearer to that terminal so that it holds there. The overlays already waiting in that window, on that host or everywhere, then do the same once each is on screen, when their own setting now says so; one that ended within 5 seconds of starting, runs a command, or whose write lock another window holds keeps asking. A restart, this setting's or Restart clicked, that finds the terminal's host away (the hub is reconnecting it, or lost it while the terminal started) shows "Waiting for" and the host's name, "Waiting for raspberrypi…", with Cancel, in place of the overlay, and restarts it once, on its own, when that host is connected again, whatever the view and the focus; Cancel brings the overlay back. A restart that fails for any other reason shows the overlay with that reason |

---

### [tabs] — Tab Bar

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| close_button | boolean | `true` | Show close button on tabs |
| new_tab_position | `"end"` \| `"afterActive"` | `"end"` | Where new tabs appear |
| confirm_close_all | boolean | `true` | Confirm before closing all tabs |
| confirm_close_others | boolean | `true` | Confirm before closing other tabs |
| scope | `"global"` \| `"perHost"` | `"global"` | Which tabs the bar shows: every tab whatever host is in view, or only the tabs whose terminals are on the host in view. Neither closes anything |
| host_marker | `"dot"` \| `"initials"` \| `"edge"` \| `"none"` | `"dot"` | How a tab says which host its terminal is on: a coloured dot, the host's initials, a coloured top edge, or nothing |

---

### [panes] — Panes

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| max_panes | number | `4` | Panes a tab may hold, empty ones included; a split past it is refused with a notice |
| keep_ended | boolean | `false` | Closing a terminal that has ended — its pane, or a tab holding it — leaves it greyed out in the sidebar, to restart later with the same settings, instead of deleting it. Its output is not kept |

---

### [channels] — Channel / PTY Defaults

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| default_shell | string | — | Not the shell a terminal starts: that is its launch profile's, or its agent's default. Read only when the hub finds no launch profile at all, to create one for this shell (`migrate-launch-profiles.ts`) |
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
| source | `"dynamic"` \| `"static"` \| `"process"` | `"dynamic"` | The title a program sets (OSC 0/2), a fixed one, or the foreground process's name |
| static_title | string | — | The title shown when `source = "static"` |
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
| history_size | number | `20` | Number of recent searches to remember |

Whether matches are marked in the scrollbar is `[terminal] scrollbar_markers`, which a host or a terminal can override. A `scrollbar_markers` left here is read only as that key's global value, while `[terminal]` does not set it.

---

### [layout] — UI Panel Dimensions

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| host_rail_columns | integer (1–5) | `1` | Host rail columns. More than one makes the rail a grid, filled left to right, then down |
| host_rail_badge_size | `"small"` \| `"medium"` \| `"large"` | `"medium"` | Host rail badge size: 28, 36 or 44 px. Set in *Settings › Appearance › Host rail*, global only |
| sidebar_width | number | `200` | Channel sidebar width in pixels (0 = collapsed) |

The rail's width follows from its columns and its badge size: `12 + n·badge + (n−1)·6` px, never under 48 px, so one Medium column is 48 px. Dragging the rail's edge snaps to whole columns, and a new badge size keeps the columns. `host_rail_width`, the width in pixels the rail kept before, is still read, as the Medium columns it holds (48 to 89 px is one column, 90 to 131 two), while `host_rail_columns` is not set; the first time the columns are written, it is removed.

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

### [ssh] — Reaching hosts over SSH

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| trust_known_hosts | boolean | `false` | Trust a host key that `~/.ssh/known_hosts` already holds, without asking. Applies to first connections only; a key that changed under a trusted one still stops the connection, and `@revoked` still refuses. See SECURITY.md §3.3. |
| remote_daemon | boolean | `false` | Leave an agent running on remote hosts, so their terminals outlive the SSH connection and a hub restart (#79). A host can answer for itself in its settings. Windows remotes ignore it. See the note below on lingering. |

**`remote_daemon` and lingering.** On a Linux host with systemd, the daemon runs in a systemd scope of its own, outside your login sessions, but only when lingering is on for your user there. Without lingering it runs in the SSH session that started it. That session outlives the logout where `KillUserProcesses=no`, the default on Debian and its derivatives. Where it is `yes`, the logout ends the daemon and its terminals. To keep them, run this on the host: `loginctl enable-linger <user>` (SPEC.md § 3.2).

---

### [agent] — Agent Daemon

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| socket_path | string | auto-detect | UDS / named pipe path for daemon IPC |

The agent's log level and format come from `[logging]` (SPEC.md § 6.2); a `log_level` under `[agent]` is not read. Neither are `buffer_per_channel` and `buffer_global`: no Rust agent ever applied them (SPEC.md § 3.2). A file that still sets them loads as before.

---

### [logging] — Hub and Agent Logs

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| level | `"trace"` \| `"debug"` \| `"info"` \| `"warn"` \| `"error"` | `"info"` | Hub and agent log level. The security events of SECURITY.md § 7.1 are written whatever it says |
| format | `"jsonl"` \| `"text"` | `"jsonl"` | How lines are rendered on stderr. `logs/hub.jsonl` is always JSONL |
| output | `"stderr"` \| `"file"` \| `"both"` | `"file"` | Where the hub writes its log; `file` and `both` write `logs/hub.jsonl` in the state directory |
| max_age_days | number | `30` | Channel log retention in days; 0 keeps them |
| max_size_mb | number | `50` | Size limit of one channel's log in MB; 0 is unlimited |

What each entry point writes is in SPEC.md § 6.2.

---

### [elevation] — Elevated Terminals

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| method_linux | `"sudo"` \| `"doas"` \| `"pkexec"` \| `"custom"` | `"sudo"` | How an elevated terminal starts on a Linux host |
| method_darwin | `"sudo"` \| `"doas"` \| `"custom"` | `"sudo"` | The same on macOS |
| method_windows | `"gsudo"` \| `"custom"` | `"gsudo"` | The same on Windows |
| custom_command_linux, custom_command_darwin, custom_command_windows | string | — | With `custom`: the absolute path of the command, without arguments. ASCII letters, digits and `/ \ . _ : -` and spaces only; anything else is ignored, with a line on stderr |

A host can choose its own method in its settings, which wins over these.

---

### [server] — Hub Endpoint

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| tls_certificate | string | — | Path of a PEM certificate for the hub to serve instead of the one it generates. Set with `tls_key`, both or neither: one without the other stops the hub. SPEC.md § 3.4 says when a browser can then install the web UI |
| tls_key | string | — | Path of that certificate's private key |
| cors_origins | array of strings | `["tauri://localhost", "http://tauri.localhost"]` | Origins allowed to call the hub from a page. Replaces the default list, so keep the desktop's two origins in it; `https://localhost:<port>` and `https://127.0.0.1:<port>` are added once the hub listens. A `*` matches the digits of a port, e.g. `"https://app.example:*"` |

---

### [auth] — Paired Browsers

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| token_ttl_days | number | `90` | Days a token issued by pairing stays valid after its last use; 0 never expires. Every hub start sweeps those tokens anyway, so a pairing lasts one hub run at most (SECURITY.md § 4.2). The primary token in `auth.json` does not expire |

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
env_mode = "inherit"
env = { EDITOR = "hx", PAGER = false }   # false removes the variable

[tabs]
new_tab_position = "afterActive"

[panes]
max_panes = 4

[title]
source = "dynamic"
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
```

---

## Notes

- All keys use `snake_case` in TOML. TypeScript interfaces use `camelCase`. Conversion between the two happens automatically at codec boundaries.
- Layers 3–4 (host/channel profiles) only support `[terminal]` keys. UI sections such as `[tabs]`, `[search]`, `[appearance]`, and `[gc]` are global-only.
- Setting a key to `null` in a profile JSON removes that key, causing resolution to fall back to the previous layer. Inside `env` it goes further: `null` on a variable removes the variable from the terminal's environment, whether an outer layer set it or the agent would have passed it on (`false` in `config.toml`).
- The `[terminal].wallpaper` value is a filename, not a path. Files must be placed in `$XDG_CONFIG_HOME/lasterm/` (or the platform equivalent) and served by the hub.
