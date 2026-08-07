# UX-06: Theming & Color Schemes

## Overview

Color scheme system with bundled presets, custom theme editor, per-host
override, OS dark/light auto-switch, background opacity, scrollbar styling,
and live preview.

## Theme File Format

JSON files stored in `~/.config/lasterm/themes/`. Two sections:
- `colors`: standard terminal ANSI 16 + fg/bg/cursor/selection (xterm.js ITheme compatible)
- `ui`: lasterm app chrome colors

```typescript
interface LastermTheme {
  name: string
  author?: string
  type: "dark" | "light"
  colors: {
    foreground: string
    background: string
    cursor: string
    cursorAccent?: string
    selectionBackground: string
    selectionForeground?: string
    // ANSI 16
    black: string
    red: string
    green: string
    yellow: string
    blue: string
    magenta: string
    cyan: string
    white: string
    brightBlack: string
    brightRed: string
    brightGreen: string
    brightYellow: string
    brightBlue: string
    brightMagenta: string
    brightCyan: string
    brightWhite: string
  }
  ui: {
    tabBar: string
    tabActive: string
    tabInactive: string
    tabHover: string
    sidebar: string
    sidebarText: string
    sidebarActive: string
    hostRail: string
    border: string
    accent: string
    badge: string
    scrollbarThumb: string
    scrollbarTrack: string
    searchHighlight: string
    searchHighlightActive: string
  }
}
```

## Theme Storage

```
~/.config/lasterm/
  themes/
    one-half-dark.json         # bundled (copied on first launch)
    catppuccin-mocha.json
    dracula.json
    nord.json
    tokyo-night.json
    gruvbox-dark.json
    one-half-light.json
    solarized-light.json
    github-light.json
    my-custom-theme.json       # user-created
```

Bundled themes are copied to the themes directory on first launch so users
can modify them. Hub serves theme files via GET /api/themes endpoint.

## Bundled Presets

### Dark (6)

| Name | Foreground | Background |
|------|------------|------------|
| One Half Dark | #dcdfe4 | #282c34 |
| Catppuccin Mocha | #cdd6f4 | #1e1e2e |
| Dracula | #f8f8f2 | #282a36 |
| Nord | #d8dee9 | #2e3440 |
| Tokyo Night | #a9b1d6 | #1a1b26 |
| Gruvbox Dark | #ebdbb2 | #282828 |

### Light (3)

| Name | Foreground | Background |
|------|------------|------------|
| One Half Light | #383a42 | #fafafa |
| Solarized Light | #657b83 | #fdf6e3 |
| GitHub Light | #24292e | #ffffff |

## Config Cascade — Scope Tabs

Settings panel uses VSCode-style scope tabs matching the 4-layer config
cascade from SPEC.md:

```
+--------------------------------------------------------------+
| Settings                                              [x]    |
|--------------------------------------------------------------|
| [Global]  [Host: prod-server]  [Channel: vim]                |
|--------------------------------------------------------------|
|                                                              |
|  Left nav          Content                                   |
| +----------+  +------------------------------------------+   |
| | Appear.  |  |  ...                                     |   |
| | Terminal |  |                                          |   |
| | Tabs     |  |                                          |   |
| | Panes    |  |                                          |   |
| | Search   |  |                                          |   |
| | Startup  |  |                                          |   |
| | Keys     |  |                                          |   |
| +----------+  +------------------------------------------+   |
+--------------------------------------------------------------+
```

- Global tab: default for all hosts
- Host tab: appears when a host is selected, shows overrides
- Channel tab: appears when a channel is selected, shows overrides

### Override Indicators

```
  Host: prod-server tab:
  +--------------------------------------------------+
  |  Color Scheme               [reset to global]    |
  |  [Dracula v]  <- blue bar = overridden           |
  |  |                                               |
  |  Font Size                  (inherited: 14)      |
  |  [ ]  <- empty = inherits from global            |
  +--------------------------------------------------+
```

- Blue left bar: this value overrides the parent level
- (inherited: X): shows the inherited value
- [reset to ...]: button to remove the override

## Theme Picker

```
  Settings > Appearance > Color Scheme
  +----------------------------------------------------------+
  |  Color Scheme                                            |
  |                                                          |
  |  [search themes...                                    ]  |
  |                                                          |
  |  Dark                                                    |
  |  +------------+ +------------+ +------------+            |
  |  | One Half   | | Catppuccin | | Dracula    |            |
  |  | Dark    [*]| | Mocha      | |            |            |
  |  +------------+ +------------+ +------------+            |
  |  +------------+ +------------+ +------------+            |
  |  | Nord       | | Tokyo Night| | Gruvbox    |            |
  |  +------------+ +------------+ +------------+            |
  |                                                          |
  |  Light                                                   |
  |  +------------+ +------------+ +------------+            |
  |  | One Half   | | Solarized  | | GitHub     |            |
  |  | Light      | | Light      | | Light      |            |
  |  +------------+ +------------+ +------------+            |
  |                                                          |
  |  Custom                                                  |
  |  [+ Import theme file]   [Edit current theme]           |
  |                                                          |
  +----------------------------------------------------------+
```

Each card shows mini-preview with the 8 ANSI colors as swatches.
[*] = currently active theme.

### Live Preview on Hover

When hovering a theme card, the entire app temporarily switches to that
theme (terminal + UI chrome). On mouse leave, reverts to current theme.

Implementation: inject theme CSS variables on mouseenter, restore on mouseleave.

## Theme Editor

```
  Settings > Appearance > [Edit current theme]
  +----------------------------------------------------------+
  |  Theme Editor: My Custom Theme                           |
  |                                                          |
  |  Based on: [Catppuccin Mocha v]     [Reset to base]     |
  |                                                          |
  |  Terminal Colors                                         |
  |  +------+ +------+ +------+ +------+ +------+ ...       |
  |  |      | |      | |      | |      | |      |           |
  |  +------+ +------+ +------+ +------+ +------+           |
  |  black    red      green    yellow   blue                |
  |                                                          |
  |  +------+ +------+ +------+ +------+ +------+ ...       |
  |  +------+ +------+ +------+ +------+ +------+           |
  |  br.blk   br.red   br.grn   br.yel   br.blu             |
  |                                                          |
  |  Foreground  [#dcdfe4] [pick]                            |
  |  Background  [#282c34] [pick]                            |
  |  Cursor      [#a3b3cc] [pick]                            |
  |  Selection   [#474e5d] [pick]                            |
  |                                                          |
  |  UI Chrome                                               |
  |  Tab bar     [#21252b] [pick]                            |
  |  Sidebar     [#21252b] [pick]                            |
  |  Host rail   [#1e2127] [pick]                            |
  |  Accent      [#61afef] [pick]                            |
  |  Border      [#181a1f] [pick]                            |
  |  Scrollbar   [#5c6370] [pick]                            |
  |                                                          |
  |  +---------------------------+                           |
  |  | Live Preview              |                           |
  |  | $ ls -la                  |                           |
  |  | drwxr-xr-x  user  src/   |                           |
  |  | -rw-r--r--  user  file   |                           |
  |  | $ git status              |                           |
  |  +---------------------------+                           |
  |                                                          |
  |  [Export JSON]  [Cancel]  [Save as "My Custom Theme"]   |
  +----------------------------------------------------------+
```

Clicking a color swatch opens native color picker + hex input field.
Live preview updates in real-time as colors change.

## Import / Export

- Import: file picker -> validate JSON format -> copy to ~/.config/lasterm/themes/
  -> instant preview
- Export: download current theme as .json file

## OS Dark/Light Auto-Switch

```
  Settings > Appearance
  +--------------------------------------------------+
  |  Auto-switch                                     |
  |  [x] Follow system dark/light mode              |
  |                                                  |
  |  When system is dark:  [Catppuccin Mocha v]      |
  |  When system is light: [One Half Light   v]      |
  |                                                  |
  |  (Currently: dark mode detected)                 |
  +--------------------------------------------------+
```

Implementation: `window.matchMedia('(prefers-color-scheme: dark)')` with
change listener. Stores dark/light theme pair in config.

## Background Opacity

Applies to entire app surface (terminal, sidebars, menus, tab bar).
Not browser window transparency (that requires Tauri, P2).

```
  Settings > Appearance > Opacity
  +--------------------------------------------------+
  |  Background Opacity                              |
  |                                                  |
  |  Terminal     [====|======] 85%                  |
  |  Sidebar      [====|======] 85%                  |
  |  Host rail    [=====|=====] 90%                  |
  |  Tab bar      [=====|=====] 90%                  |
  +--------------------------------------------------+
```

Implementation: CSS `background: rgba(r, g, b, opacity)` on all app
surfaces. Parse theme hex colors and apply opacity at render time.

In browser mode: opacity reveals the page background (white/dark).
In Tauri (P2): opacity reveals the desktop wallpaper.

## Scrollbar Styling

```
  Settings > Appearance > Scrollbar
  +--------------------------------------------------+
  |  Scrollbar                                       |
  |                                                  |
  |  Style:                                          |
  |  (*) Thin     ( ) Wide     ( ) Hidden            |
  |                                                  |
  |  Thumb color:  [from theme v]  [pick]            |
  |  Track color:  [transparent v] [pick]            |
  |                                                  |
  |  Width (thin): [ 6 ] px                          |
  |  Width (wide): [14 ] px                          |
  +--------------------------------------------------+
```

Colors default to theme values (scrollbarThumb, scrollbarTrack) but can
be overridden independently.

## Settings

```toml
[appearance]
theme = "catppuccin-mocha"         # theme file name (without .json)
# Per-host overridable via host profile

[appearance.autoSwitch]
enabled = false
darkTheme = "catppuccin-mocha"
lightTheme = "one-half-light"

[appearance.opacity]
terminal = 100                     # 0-100 percent
sidebar = 100
hostRail = 100
tabBar = 100

[appearance.scrollbar]
style = "thin"                     # "thin" | "wide" | "hidden"
thumbColor = ""                    # empty = from theme
trackColor = ""                    # empty = from theme
widthThin = 6                      # px
widthWide = 14                     # px
```

## Implementation Notes

### CSS Variables

All theme colors exposed as CSS custom properties for instant switching:

```css
:root {
  --nt-fg: #dcdfe4;
  --nt-bg: #282c34;
  --nt-cursor: #a3b3cc;
  --nt-tab-bar: #21252b;
  --nt-sidebar: #21252b;
  --nt-accent: #61afef;
  /* ... all colors */
}
```

Theme switch = update CSS variables on :root. No class toggling, no
stylesheet swapping. Instant, no flash.

### xterm.js Integration

xterm.js `ITheme` is set from the `colors` section:

```typescript
terminal.options.theme = {
  foreground: theme.colors.foreground,
  background: theme.colors.background,
  cursor: theme.colors.cursor,
  // ... map all colors
}
```

When theme changes, update `terminal.options.theme` on all active terminals.

### Pinia Store

```typescript
// useThemeStore
const currentTheme = ref<LastermTheme>(...)
const availableThemes = ref<LastermTheme[]>([])
const previewTheme = ref<LastermTheme | null>(null)  // hover preview

function applyTheme(theme: LastermTheme) { /* set CSS vars */ }
function previewHover(theme: LastermTheme) { /* temporary apply */ }
function clearPreview() { /* restore currentTheme */ }
```

## Future / Backlog

- P2: Tauri window transparency (true desktop transparency)
- P2: Theme marketplace / community themes
- P2: Auto-generate ui colors from terminal colors (derive sidebar/tab
  colors from the 16 ANSI colors for simpler theme creation)
- P2: Per-pane theme override (different theme per split pane)
