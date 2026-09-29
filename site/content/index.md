---
# Home, at /. Everything on this page is a component of the site's design system, so its content
# is data here and the body is empty: the hero (label, headline, lead, InstallBlock), the
# TerminalWindow that types `terminal.steps` once, the FeatureList, "How it works", the footer.
title: Lasterm
description: >-
  Lasterm runs your local and SSH terminals in a hub on your computer, so they outlive the window
  and come back as you left them. A Windows desktop app, and free software.
path: /

hero:
  label: A terminal for Windows and your SSH hosts
  headline: Terminals that stay where you left them
  lead: >-
    Lasterm runs your shells in a hub on your computer, not in the window. Close the window to the
    tray and they keep running, SSH ones included. Open it again and each screen is as you left it.
  # The InstallBlock shows the channels of install.md, in their order, with the first selected.
  install: install.md#channels

# The TerminalWindow: a miniature of the app (host rail, tab bar, one terminal). It types the
# steps once: a command 55 ms a character, an output line 260 ms after the one before. With
# prefers-reduced-motion it shows the last frame at once, with a steady cursor.
terminal:
  aria-label: >-
    Lasterm with three hosts in its rail. On the host pi, a build runs to 100 percent.
  caption: >-
    Closed the window to the tray at 18:02, opened it again at 20:14. The build finished in the
    meantime.
  rail:
    - { label: local, initials: LO, color: badge-azure, status: live }
    - { label: pi, initials: PI, color: badge-pink, status: live, selected: true }
    - { label: nas, initials: NA, color: badge-teal, status: offline }
  tabs:
    - { title: build, active: true }
    - { title: logs }
    - { title: htop }
  prompt: { user: dev@pi, path: ~/firmware }
  steps:
    - { command: uptime }
    - { output: " 18:01:47 up 12 days,  3:41,  1 user,  load average: 0.08, 0.05, 0.01" }
    - { command: make -j4 }
    - { output: [{ dim: "[ 12%]" }, " Building C object src/net/link.o"] }
    - { output: [{ dim: "[ 38%]" }, " Building C object src/net/dhcp.o"] }
    - { output: [{ dim: "[ 64%]" }, " Building C object src/fs/spool.o"] }
    - { output: [{ dim: "[ 91%]" }, " Linking C executable firmware.elf"] }
    - { output: [{ ok: "[100%] Built target firmware" }] }
    - { command: "" }

features:
  label: What it does
  heading: One window onto every shell you keep open
  # Three items, each true of the current release. The Features page has the rest.
  items:
    - title: Sessions outlive the window
      text: >-
        Close the window to the tray or reload the page: the hub keeps every terminal running and
        restores its screen when you come back. Local terminals also survive a restart of the hub.
      detail: "survives: closed window · reload · hub restart (local)"
    - title: Remote hosts over SSH
      text: >-
        The hub copies its agent to each host over SSH, matched to its system, and opens no port
        there. A Linux host can keep the agent running, so its terminals outlive a dropped
        connection.
      detail: jump host · reconnect · Linux x64 and arm64 · Windows x64
    - title: A rail of hosts
      text: >-
        Every host has a badge, a colour and a status dot. Group them, drag them into order, and
        see at a glance which ones answer.
      detail: live · reconnecting · offline · error

how:
  label: How it works
  heading: The window, the hub and the agent
  parts:
    - term: app
      text: >-
        The window you type in: the desktop app, or a browser on the same computer. It only shows
        what the hub holds.
    - term: hub
      text: >-
        A small server on your computer, listening on 127.0.0.1 only. It keeps your hosts, your
        settings and the output of every terminal.
    - term: agent
      text: >-
        Runs the shells, on this computer or on a remote host. The hub starts it here, and copies
        it to a remote host over SSH.
  # A CodeBlock without a prompt or a Copy button. Nodes in ink, edges in ink-muted.
  diagram: |
    app ── https ── hub (127.0.0.1)
                    ├── local agent ── pwsh, cmd
                    └── ssh ── agent on pi ── bash

footer:
  text: Lasterm is free software under the AGPL-3.0.
  links:
    - { label: Source, href: "https://github.com/khiops/lasterm" }
    - { label: Docs, href: /docs/ }
    - { label: Privacy, href: /privacy/ }
---
