---
# Features, at /features/. One section per capability: the body holds each section's text under
# its H2, and `sections` below holds, under the same id (the H2's slug), what the section shows
# beside the text and the facts line under its title.
#
# `release` is the first release that has everything the section says. `next` means it is on
# main but in no release yet (merged after 0.13.0): publish the page with that release, or leave
# the section out until then. Screenshots come later, taken from a clean profile; until then a
# section shows a TerminalWindow, a HostBadge strip, a CodeBlock or nothing.
title: Features
description: >-
  What Lasterm does: terminals that outlive the window, remote hosts over SSH, a rail of hosts,
  the keyboard, themes, and the limits of each.
path: /features/
lead: >-
  Each part of Lasterm, what it does, and where it stops.

sections:
  - id: sessions-outlive-the-window
    detail: "survives: closed window · reload · hub restart (local)"
    release: 0.13.0
    illustration:
      kind: terminal-window
      aria-label: >-
        Lasterm on the host pi, with a development server still running in its terminal.
      caption: >-
        Closed the window to the tray at 12:10 and opened it again at 12:40. The server kept
        running, and its screen came back.
      rail:
        - { label: local, initials: LO, color: badge-azure, status: live }
        - { label: pi, initials: PI, color: badge-pink, status: live, selected: true }
      tabs:
        - { title: server, active: true }
        - { title: bash }
      prompt: { user: dev@pi, path: ~/site }
      steps:
        - { command: npm run dev }
        - { output: [{ dim: "> site@1.4.0 dev" }] }
        - { output: [{ dim: "> vite" }] }
        - { output: "" }
        - { output: [{ ok: "  VITE v7.1.0  ready in 412 ms" }] }
        - { output: "" }
        - { output: "  ➜  Local:   http://localhost:5173/" }
  - id: remote-hosts-over-ssh
    detail: jump host · keepalive every 15 s · Linux x64 and arm64 · Windows x64
    release: 0.13.0
    illustration:
      kind: terminal-window
      aria-label: >-
        Lasterm connected to the host pi, reached through a jump host, where uname reports an arm64
        machine.
      caption: >-
        pi is reached through a bastion. The hub copied the arm64 agent to it on the first
        connection.
      rail:
        - { label: local, initials: LO, color: badge-azure, status: live }
        - { label: bastion, initials: BA, color: badge-orange, status: live }
        - { label: pi, initials: PI, color: badge-pink, status: live, selected: true }
      tabs:
        - { title: bash, active: true }
      prompt: { user: dev@pi, path: "~" }
      steps:
        - { command: uname -m }
        - { output: aarch64 }
        - { command: "" }
  - id: terminals-that-outlive-the-connection
    detail: "[ssh] remote_daemon · Linux hosts · ends after 30 minutes idle"
    release: 0.13.0
    illustration:
      kind: code-block
      code: |
        # config.toml: keep an agent running on remote hosts
        [ssh]
        remote_daemon = true
  - id: a-rail-of-hosts
    detail: live · reconnecting · offline · error
    release: 0.13.0
    # The grid and the badge sizes (#630) are on main only: they need the next release.
    unreleased: The rail as a grid, and the badge sizes
    illustration:
      kind: host-badges
      badges:
        - { initials: LO, color: badge-azure, status: live, caption: live }
        - { initials: PI, color: badge-pink, status: reconnecting, selected: true, caption: reconnecting }
        - { initials: NA, color: badge-teal, status: offline, caption: offline }
        - { initials: WP, color: badge-orange, status: error, caption: error }
  - id: an-empty-pane-lists-your-hosts
    detail: search · reattach · new terminal · connect
    release: next # #633
  - id: tabs-panes-and-search
    detail: up to 4 panes a tab by default · search one pane or all
    release: 0.13.0
  - id: the-whole-app-from-the-keyboard
    detail: Windows Terminal's keys · key hints · Ctrl+/ for the list
    release: next # #627, #634, #638, #640
  - id: the-terminals-environment
    detail: Inherited or Minimal · everywhere, per host, per terminal
    release: 0.13.0
    illustration:
      kind: code-block
      code: |
        # config.toml: every terminal, on every host
        [terminal]
        env_mode = "inherit"                     # or "minimal"
        env = { EDITOR = "hx", PAGER = false }   # false removes the variable
  - id: ended-terminals
    detail: Ask · Restart · Close
    release: 0.13.0
    illustration:
      kind: code-block
      code: |
        # config.toml: what a pane does when its terminal ends
        [terminal]
        when_ended = "ask"                       # or "restart", "close"
  - id: launch-profiles-and-elevation
    detail: sudo · doas · pkexec · gsudo · a command of your own
    release: 0.13.0
  - id: themes-and-backgrounds
    detail: 9 themes · per host · per terminal · Mica and Acrylic on Windows 11
    release: 0.13.0
  - id: the-desktop-app-and-your-browser
    detail: pairing code · same computer · one writer at a time
    release: 0.13.0
    # Pairing a browser on another device is not delivered (#193).
    planned: Pairing a browser on another device
---

## Sessions outlive the window

Your terminals run in the hub and its agent, not in the window. Close the window to the tray, or
close the browser tab, and they keep running. When you come back, the hub restores each screen as
it was.

Terminals on this computer also survive a restart of the hub. They run in an agent that stays up on
its own, and the hub reconnects to it when it starts again. The same holds when the app closes
unexpectedly.

When a host cannot be reached, its terminal keeps showing the last screen it had, marked as not
connected, with a **Reconnect** button.

After a reload or a restart, the screen comes back, but not the lines that had scrolled off it.
*Quit completely* ends the terminals on this computer, on purpose: it frees the files an update
replaces.

## Remote hosts over SSH

Add a host with its hostname, port and username, and sign in with a key file, your SSH agent, or a
password asked at each connection. You can also import hosts from your `~/.ssh/config`.

The hub copies its agent to the host over SSH, matched to the host's system and architecture. When
it does not carry that agent, it downloads it from the GitHub release of its own version and checks
it against the release's checksums. The agent talks to the hub over the SSH connection: no port is
opened on the remote machine, and the host needs no internet access.

A host can be reached through a jump host (ProxyJump), and every reconnection goes through it too.

The first connection shows the fingerprint of the host's key and waits for your answer. A key that
changes later stops the connection until you accept the new one.

The hub sends a keepalive every 15 seconds, so a host that stops answering is noticed within a
minute. The hub then reconnects it, retrying for up to five minutes.

One jump host, not a chain of them. Remote hosts run Linux on x64 or arm64, or Windows on x64;
macOS is not supported.

## Terminals that outlive the connection

A Linux host can keep an agent running. Its terminals then survive a dropped connection, which the
hub reconnects on its own, and a restart of the hub, after which selecting the host brings them
back.

Turn it on for one host with *Keep an agent running there* in its settings, or for every host in
*Settings › Agents* or in `config.toml`. The agent ends by itself after 30 minutes with no terminal
and no hub connected. If logging out of the host ends your processes, run `loginctl enable-linger`
there: the agent then runs outside your login sessions.

Without a running agent, and always on a Windows host, terminals end with the connection. When the
hub reconnects, it starts new shells in their place.

## A rail of hosts

Every host has a badge in the rail on the left: its initials, an emoji or an image, on its colour,
with a dot for its state: live, reconnecting, offline or error. Hover over a badge for the host's
address, its group, its number of terminals and how long it has been connected.

Put hosts in groups, and drag hosts and groups into the order you want.

The rail can also be a grid. Drag its edge to show up to five columns, and choose Small, Medium or
Large badges in *Settings › Appearance*.

## An empty pane lists your hosts

A new tab, by default, and a split open on an empty pane that lists your hosts, grouped and ordered
as in the rail, each with its address, its number of terminals and its state in words. The
terminals of this tab's host that no pane shows come first, to reattach. Type to search, then
choose a host to open a terminal on it, connecting it first if it is offline. The command palette
lists hosts the same way.

## Tabs, panes and search

Split a tab into panes, to the right or down, from the menu of a tab or a pane, and drag a pane by
its header to move it. A tab holds up to 4 panes; *Settings › Panes* allows up to 8.

Search a terminal's output, in one pane or in all of them, with case, regular expressions and whole
words, and your recent searches kept.

## The whole app from the keyboard

Most keys are Windows Terminal's:

| Keys | Action |
|---|---|
| <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>P</kbd> | Command palette |
| <kbd>Ctrl</kbd> <kbd>,</kbd> | Settings |
| <kbd>Ctrl</kbd> <kbd>/</kbd> | Keyboard shortcuts |
| <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>T</kbd> | New tab |
| <kbd>Ctrl</kbd> <kbd>Tab</kbd>, <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>Tab</kbd> | Next tab, previous tab |
| <kbd>Ctrl</kbd> <kbd>Alt</kbd> <kbd>1</kbd> to <kbd>8</kbd>, <kbd>9</kbd> | Tab 1 to 8, last tab |
| <kbd>Alt</kbd> <kbd>Shift</kbd> <kbd>=</kbd>, <kbd>Alt</kbd> <kbd>Shift</kbd> <kbd>-</kbd> | Split right, split down |
| <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>W</kbd> | Close the pane |
| <kbd>Alt</kbd> and an arrow | Move to the pane on that side |
| <kbd>Alt</kbd> <kbd>Shift</kbd> and an arrow | Move the divider on that side |
| <kbd>Ctrl</kbd> <kbd>F6</kbd>, <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>F6</kbd> | Next area, previous area: the host rail, the terminal list, the tab bar, the pane |

In the rail, the list and the tab bar, the arrows move and <kbd>Enter</kbd> chooses;
<kbd>Esc</kbd> goes back to the pane. A line under the rail and the list names the keys that work
there. It shows only while you use the keyboard, and *Settings › Appearance* turns it off.

A browser keeps <kbd>Ctrl</kbd> <kbd>Tab</kbd>, <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>Tab</kbd>,
<kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>T</kbd> and <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>W</kbd> for
itself: those work in the desktop app. The keys cannot be changed yet.

## The terminal's environment

Each terminal starts from the environment of its agent, or from a minimal one, and says what it is:
`TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=lasterm`. In *Settings › Environment*,
set, change or remove variables for every terminal, for one host, or for one terminal, with the
host's own variables shown beside them. On an SSH host, the default shell starts as a login shell,
as `ssh host` gives one.

Values are stored in the clear: keep secrets out of them. A change reaches new and restarted
terminals, not running ones.

## Ended terminals

When a shell exits, its pane stays, with its exit code, **Restart** and **Close**. *When a terminal
ends* can do it for you instead: Ask, Restart or Close, set for every host, one host or one
terminal, or with *Always do this* on the pane.

A restart whose host is away waits for it, and runs once the host is back. With *Keep ended
terminals in the sidebar*, closing an ended terminal keeps it in the list, greyed out, to restart
later with the same settings. Its output is not kept.

## Launch profiles and elevation

*Settings › Profiles* holds named launch profiles: a shell or a program, its arguments, a working
directory, environment changes, its own font, icon and colour, and whether it runs elevated.
Elevation uses sudo, doas, pkexec, gsudo on Windows, or a command of your own, chosen per host.

## Themes and backgrounds

Nine themes come with Lasterm: Catppuccin Mocha (the default), One Half Dark, Dracula, Nord, Tokyo
Night, Gruvbox Dark, One Half Light, Solarized Light and GitHub Light. Create your own or import
one, and give a host or a single terminal its own theme, font or wallpaper. Lasterm can follow the
system's dark mode, with a theme for each.

Behind the terminal, show a wallpaper with blur and dimming, or let the desktop show through. On
Windows 11, the desktop app can paint Mica or Acrylic there instead.

## The desktop app and your browser

The hub serves the same interface to a browser on the same computer, at its `https://127.0.0.1`
address. Unless you configure a certificate, the hub makes its own, which the browser asks you to
accept. Pair the browser with an 8-digit code, from *Generate Pairing Code* in the command palette.
A code works once, within 60 seconds. After the hub restarts, a browser pairs again.

The desktop app and the browser can show the same terminal. One of them types at a time: the
others watch until they take over.

Pairing a browser on another device is planned.
