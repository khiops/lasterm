# Architecture Decisions

Decisions archived from workflow — newest first.

A section whose decision no longer holds, entirely or in part, says so on a **Status** line under its
heading, with a pointer to the section that replaced it. A section without one is current.

---

## ROUTE-BOUND-HOST-TRUST — a host key is trusted for the route it was seen on, and a revocation always wins (2026-10-02)

- A target's key is trusted for its address and the host's declared jump together: direct, a saved jump host (by its id and its current address), or a jump spec (by the bastion address `planJump` reads from it). Through a bastion the target's name is resolved on the bastion's side, so one address on two routes can be two machines (#685). A host with no SSH address has no route.
- The hub's run-long "trust once" cache is keyed by that route, for sessions, reconnects and the connection test alike: a key accepted on one route is asked about again on another. A changed route needs no cache invalidation, since it has another key.
- A host's stored pins belong to its current route. An update that changes the target's address (hostname or port) or its jump declaration clears the target pin (`ssh_fingerprint`), and one that changes the jump declaration also clears the spec jump pin (`ssh_proxy_fingerprint`), in the same update. Changing a saved jump host's own address clears its pin and the target pins of the hosts that go through it. Deleting a jump host changes the route of the hosts that went through it (`ON DELETE SET NULL`: direct, or a spec left beside the id), and their pins are cleared with it. A pin is read and written only for the route it belongs to: a connection prepared before an edit neither uses the new route's pin nor records one for a route the row no longer declares; an attempt whose pin write is refused for that reason ends with a message to connect again, and one that needs no write completes on the route it was prepared for, as a connection already open before an edit keeps running. A saved jump host is reached as a bastion directly at its address, so its pin serves that use only when the host is itself declared direct. A changed user name is not a route change (#684).
- A key `known_hosts` marks `@revoked` is refused on every connection — session, reconnect, connection test, bastion — even when it is pinned or was accepted earlier in the run. A revocation is the user's own SSH saying a key must no longer be trusted, and a pin recorded before it does not outrank it.
- Not decided here: applying `trust_known_hosts` to the connection test's target, and the `known_hosts` evidence its question omits (#685).

---

## STORE-ONLY-DESKTOP — the desktop app ships through the Microsoft Store only (2026-10-02)

- The only desktop package distributed is the one the Microsoft Store signs. The Store signs it at no cost; the GitHub installers were unsigned, so Windows warned about an unknown publisher, and Authenticode signing is a recurring cost not taken.
- The release workflow publishes the agents, the Windows hub executable and `SHA256SUMS-<version>.txt`, and no desktop package: no NSIS `setup.exe`, no MSI, no unsigned MSIX. It still packages the unsigned MSIX when the three `MSIX_*` variables are set, as the workflow-run artifact `msix-x86_64-pc-windows-msvc` (kept 30 days), for the Store submission (#619); that package is never uploaded to the release.
- Once the Store has certified a version, the package it signed may be attached to that release afterwards, with a checksum file of its own, and published to winget as an `msix` installer (#619, #620, planned). Both reach users with the Store's signature, as the Store install does. `SHA256SUMS-<version>.txt` keeps listing the agents only: the hub's agent fetch reads it.
- File-system virtualization stays on: the package does not declare `unvirtualizedResources`, which Microsoft reserves for some games and for apps packaged with an external location because it defeats a clean uninstall. A Store install therefore keeps the files it creates under `AppData` in the package's private folder, removed at uninstall; the paths this repository documents describe an unpackaged build, and the Store paths are documented once observed on Windows.
- Supersedes the second bullet of DESKTOP-UPDATES: the Store updates the desktop app, winget installs the package the Store signed, and there is no release-asset install to update by hand.

---

## REMOTE-DAEMON-PRESELECT — ask at host creation, with Yes preselected (2026-10-01)

- Refines REMOTE-DAEMON: the Add Host dialog asks, for a Unix SSH host, whether it may keep a small agent running, with Yes preselected and a disclosure of its 30-minute idle stop, systemd-without-lingering logout risk, and No behaviour. The batch import and Duplicate do not ask (below).
- The global `[ssh] remote_daemon` default remains false, and existing hosts and API-created hosts without the field retain their current inherited behaviour.
- The Add Host dialog offers Yes (preselected), No and "Follow the global setting"; the batch import offers one Yes/No checkbox for the whole batch, ticked by default; Duplicate copies the source host's answer.
- Windows hosts stay on stdio whatever is stored: the dialog stores no answer for a host it knows to be Windows, while the batch import cannot know the OS and may store a value that is then ignored.
- The hub-side operation to disable and stop an already-running agent is a separate change.

---

## AGENT-DAEMON-LOG — one file per day, and a number of them kept (#646, 2026-09-29)

- An agent daemon appended to `logs/agent-daemon.jsonl` for as long as it ran, never rotated: a remote daemon left for months, as on the Raspberry Pi, grew it without bound. It now writes one file per UTC day it logs something, `logs/agent-daemon.YYYY-MM-DD.jsonl`, through `tracing-appender`'s daily rotation, as Candeo's log does.
- **Days, not a size.** The hub's logs move aside at 10 MB (`hub.jsonl.old`), and doing the same here was the first design. It was dropped: a rename can be refused (on Windows, by anything holding the file without sharing deletion), and a daemon that keeps appending meanwhile grows the full file again, the very failure being fixed. A new day's file is a new name, which nothing holds; no file is ever renamed.
- **A count, not an age.** The `[logging] agent_files_kept` most recent files are kept, 7 by default (a week of activity covers "it started on Monday"), `0` keeping all, as OpenRGB's `file_count_limit`. Days without activity have no file, so a quiet daemon keeps a longer history in as many files. The cap counts files, not bytes: at INFO the daemon logs its lifecycle and little else, and it is the level that bounds a day.
- **Pruned by the daemon**, when it starts and when a new day's file starts, by the date in the names: only `agent-daemon.YYYY-MM-DD.jsonl` regular files. `tracing-appender`'s own `max_log_files` is not used: it goes by creation time, counts any file with the prefix and the suffix, and reports on stderr. A file that cannot be deleted is a warning in the log, tried again at the next occasion; the warning written from inside a write goes through a short-lived thread, so the log never re-enters itself.
- **The old file** `agent-daemon.jsonl` counts as one more file, dated by its last write, so it goes once as many newer days have their own file as are kept. It is not renamed: a daemon from before may still be appending to it while it is replaced.
- **A setting, passed at launch.** Settings › Agents › Agent logs writes it (`PUT /api/config/logging`). The hub reads it when it starts a daemon, local or remote, and passes `--log-files-kept`; one already running keeps its count. A remote binary is asked first (`--help`), as for `--idle-timeout`: a build of main deploys the last release's agent, which would refuse the option and never listen. The local agent ships with the hub and gets it unasked.

---

## DESKTOP-UPDATES — the desktop app does not update itself (#645, 2026-09-29)

**Status:** the second bullet is superseded by STORE-ONLY-DESKTOP (2026-10-02); the rest holds.

- The desktop ships no updater. `tauri-plugin-updater` was registered in builds without an MSIX identity, with an endpoint and a public key, but nothing ever called it, and no release published the `latest.json` and signature it would have read: a GitHub-release install never updated. It is removed with everything that served only it: its configuration and capability, the `@tauri-apps/plugin-updater` package, the MSIX-identity probe that kept it out of Store builds (#112), and `scripts/generate-updater-key.sh`.
- Each channel updates its own installs. The Microsoft Store updates the MSIX build, and winget the MSI and NSIS installs it makes once it lists Lasterm (#620). An install from a GitHub release asset is updated by hand, by installing the newer release.
- Wiring the updater instead would have taken a signing key kept as a CI secret and in step with the key in the app, a `latest.json` and a signature on every release, a request to GitHub at start-up to declare in the privacy policy, and a consent prompt, for the one channel no package manager covers.
- A notice that a newer version exists may come later. It would only say so; it would download and install nothing. Not now.

---

## KEYBOARD-NAV — tabs, panes and the window's zones from the keyboard alone (#637, 2026-09-28)

- Windows Terminal's default keys, added to the table of APP-SHORTCUTS: Ctrl+Tab and Ctrl+Shift+Tab go to the next and previous tab, wrapping; Ctrl+Alt+1..8 to tab N, and Ctrl+Alt+9, or a number past the count, to the last. Only the tabs the bar shows count: with `[tabs] scope = "perHost"`, those of the host in view. Alt+arrows move the focus to the pane on that side; Alt+Shift+arrows move a divider. Ctrl+Shift+W closes the focused pane (`pane.close`), no longer the whole tab.
- **Alt+arrows leave the shell.** `terminal-keys.ts` turned them into a word motion, as xterm 5 did (`altArrowSequence`); that mapping is gone, and the shell moves by word on Ctrl+←/→, which xterm sends untouched, as in Windows Terminal.
- **AltGr is not Ctrl+Alt.** A browser on Windows reports AltGr with `ctrlKey` and `altKey` both set, so AltGr+3 (# on AZERTY) would have been Ctrl+Alt+3. No chord matches while `getModifierState("AltGraph")` holds; the key reaches xterm, which types its character. A Ctrl+Alt+digit the browser does not report as AltGr goes to its tab. The tab numbers are matched on `ev.code` (`Digit1`..`Digit9`), so they are the digit row on every layout; the arrows on `ArrowLeft`.., which leaves the numeric keypad's to Windows' Alt codes.
- **Which pane.** The panes' rectangles come from the split tree (each split's ratio; the dividers are the same few pixels everywhere): Alt+arrow goes to the nearest pane on that side that overlaps the focused one along the other axis, the one it shares more of its side with between two as near, and nowhere at the tab's edge. Empty panes are panes like any other, so an empty pane's picker can be reached. The focused pane is the one holding the keyboard, else the tab's active pane.
- **Which divider.** Alt+Shift+arrow moves the nearest divider on that side of the pane towards the arrow, by 5% of its split, within the 10–90% the mouse drag enforces (`clampSplitRatio`, which `updateRatio` uses too). At the tab's edge, where there is none on that side, the divider on the other side moves the same way, as in Windows Terminal: the pane shrinks.
- **Closing a pane** runs the pane's own "Close Pane": a live terminal keeps running, an ended one is deleted unless "Keep ended terminals" says otherwise (`onClosePane`), and an empty pane gives its room to its neighbour. A tab's last pane closes the tab, as its × does (`onCloseTab`). The palette keeps a Close Tab row, now without a chord, and gains Close Pane with Ctrl+Shift+W.
- **Focus zones.** Ctrl+F6 and Ctrl+Shift+F6 go round the host rail, the terminal list, the tab bar and the focused pane from anywhere, a terminal included; a zone that is hidden or has nothing to focus is passed over. F6 and Shift+F6 do the same outside a terminal, as Windows' own F6 does in Explorer and Edge, but in a terminal they are its program's: htop sorts with F6 and Midnight Commander moves files with it. So the table gives each action one chord of its own, which holds everywhere and is kept from the PTY, and may give it another for outside a terminal (`OUTSIDE_TERMINAL_SHORTCUTS`), which the window's listener honours only when the key is not typed in xterm's input (`windowShortcutOf`, from the event's target) and a terminal's key handler never takes. Settings › Keybindings shows both: "Ctrl+F6 (F6 outside a terminal)". Each zone has one element that takes Tab (a roving `tabindex`: the selected host, the selected terminal, the active tab), and its arrows move between its items: the rail follows its grid (← and → within a row, ↑ and ↓ between rows, over the group headers; Home, End; Enter or Space selects the host), the tab bar goes ← and → (Enter or Space activates, Delete closes as the × does), the list ↑ and ↓ (Enter opens the terminal and takes the keyboard into its pane). Esc there goes back to the pane. The focus ring is the theme's accent.
- While a modal dialog has the keyboard (`aria-modal`), the chords that would move it — the tab switches, Alt+arrows, (Ctrl+)F6 — are taken from the page but not run, so the keyboard is never left behind the dialog.
- The empty pane's host picker leaves the keys held with Alt, Ctrl or Meta to the window: Alt+↑/↓ moves the focus to another pane without moving the picker's highlight on the way.
- **Settings from the keyboard** (added 2026-09-29). Ctrl+, opens and closes it, as in Windows Terminal and VS Code: `settings.open` in the table, kept from the PTY, matched on the comma character (unshifted on US, AZERTY and QWERTZ), and named on the palette's Settings row and the rail's gear tooltip. The panel is a modal dialog:
  - On open the keyboard lands on the current category of the menu; on close it goes back where it was, or to the pane when that was nowhere any more (opened from the palette).
  - The menu has a roving `tabindex`: ↑ and ↓ move and show each category as they go, Home and End go to the ends, → or Enter go into the detail's first control (the detail itself when it has none, as while the settings load; Keybindings' first is its link to the shortcuts overlay since #639).
  - Esc in the detail comes back to the category's item unless the control used the key (`defaultPrevented`); Shift+Tab from the detail's first control does too. Esc anywhere else in the panel closes it. The window's own Esc closes Settings only from outside a dialog, so the panel's rule holds.
  - The scope tabs (Global, Host, Channel) are an ARIA tablist: ← and → move and select, Home and End go to the ends.
  - F6 (outside a terminal) and Ctrl+F6 move between the menu, the detail and the close button: the window takes the zone keys behind a modal and runs none of its own, and the panel runs its own on them. Tab goes round inside the panel.
  - Every control of the panel and of its categories shows the theme's accent ring on `:focus-visible`.
  - What takes the keyboard is decided in one place (`utils/focusable.ts`): a control counts whatever its size or opacity, and only what the browser skips is left out (`display: none`, `visibility: hidden`, disabled, inert, `tabindex="-1"`). The switches (`SettingControl`'s toggle) were checkboxes of size 0 whose focus nobody could see: the checkbox now covers its track (`role="switch"`, Space turns it, as a checkbox; not Enter, which a checkbox does not take), and the ring is drawn on the track. Each control is named by its row's label.
  - Nothing in Settings is left to the mouse alone: a theme card's edit button, which sat inside the card's own button and showed only on hover, is beside it and shows on focus; an imported font's card and the agent import's drop zones were clickable divs and are buttons now; the font picker and the agent import are modal dialogs (the keyboard goes in and comes back, Esc closes, Tab stays inside), the font picker's tabs a tablist and its installed fonts a listbox walked with ↑ and ↓; the profile delete confirmation keeps its own keys and starts on Cancel. A spec reads every Settings component for a click handler on an element the keyboard cannot reach.
- **Key hints and the shortcuts overlay** (#639, added 2026-09-29). Nothing said which keys work where; no tooltip per control (it hides its neighbours, pops up on every move and turns into noise), and nothing extra for screen readers, which already announce each control's role and state. Instead:
  - **One source.** `utils/key-hints.ts` holds the keys that work in each place: Settings' menu, its scope tabs, and in a category's detail the focused control's own keys by its kind — read from its ARIA role, else its element: switch or checkbox (Space toggle), select (↑↓ choose), range or slider (←→ adjust, Home End ends), text or number field (none), radio or option (←→ choose) — then Esc back to the menu; the rail (←→↑↓ hosts, Enter select), the terminal list (↑↓ terminals, Enter open) and the tab bar (←→ tabs, Enter open, Delete close) on their items, each followed by F6 next area. The app's own keys come from the table, never written there: the zones' F6 is `outsideTerminalKeys("zone.next")`. Both strips and the overlay read this module.
  - **A select's hint says ↑↓, not Alt+↓.** Alt+↓ is the table's `pane.focusDown`, which the window takes from the page even behind a modal dialog (above), so a select in Settings never gets it.
  - **The strip.** A quiet line like the host picker's footer: at the bottom of Settings while it is open, and, for the rail, the list and the tab bar, in one place under the rail and the list, only while the keyboard is in one of them. It is a second row of the window's grid spanning the rail's and the list's columns; the terminals span both rows, so the strip coming and going never resizes a terminal and is never drawn over one. Too narrow for its keys (the rail alone, with the list folded away) it shows none. On a zone's other controls (a footer button) it names F6 alone; in a text field (a rename) and in the panes, nothing. The grid now places each column's element explicitly: by auto-placement, the terminals took the list's column, of width 0, when the list was folded away (`v-show`).
  - **For the keyboard only.** It shows while the last thing the user did was press a key other than a lone modifier, and goes on a click or a touch (`useKeyboardFocus`): the rule `:focus-visible` follows for the ring, kept in one tracker so that the strip can follow it and a spec can drive it (happy-dom matches `:focus-visible` on any focus). It is `aria-hidden`, and uses theme tokens only.
  - **The setting.** Settings › Appearance › Keyboard › Show key hints, global, on by default: `[keyboard] key_hints`, a UI section of its own, where the chords' overrides would go once they are configurable (#632); `PUT /api/config/ui` validates it as the other UI booleans.
  - **Ctrl+/** (`help.shortcuts`) opens and closes the overlay, kept from the PTY (readline's undo, which Ctrl+- still is). It is matched on the `/` character, as Ctrl+, is on the comma, but with whatever Shift typing it takes (`shiftAsTyped` in the chord): `/` is Shift+: on AZERTY and Shift+7 on QWERTZ, so Ctrl+Shift+: and Ctrl+Shift+7 there, and the numeric keypad's `/` everywhere. On US, Shift makes it `?`, so Ctrl+Shift+/ is no chord. It is shown as Ctrl+/.
  - **The overlay** is a modal dialog (`useModalFocus`: the keyboard goes onto its search field, Esc closes, Tab stays inside, the keyboard goes back where it was, or to the pane when that is gone, as when opened from the palette). It lists every action of the table in its order, grouped by its id — General (`palette.*`, `help.*`), Tabs, Panes, Areas (`zone.*`), Settings (`settings.*`) — under the names the table gives them (`APP_SHORTCUT_NAMES`, which Settings › Keybindings reads too), then the keys inside the rail, the list, the tab bar and Settings, from the hints' module. The search keeps the rows holding every word typed, in their name, their group or their keys. The palette's "Keyboard Shortcuts" row (Ctrl+/) opens it, and Settings › Keybindings links to it; it could become that page once #632 makes keys configurable. The terminal search's keys (Ctrl+Shift+F, Alt+C/R/W) are not in the table, so the overlay does not list them; Keybindings still does.
- The tab bar's tooltips name the chords, read from the table: each tab its Ctrl+Alt+N, the lowest that truly reaches it (tabs 1 to 8 of the bar, and the last one Ctrl+Alt+9 when it is further along), and a line for Ctrl+Tab / Ctrl+Shift+Tab; the "+" its Ctrl+Shift+T. The tab's × names none: Ctrl+Shift+W closes the focused pane, not the tab.
- A browser tab keeps Ctrl+Tab and Ctrl+Shift+Tab for itself, as it does Ctrl+Shift+T and Ctrl+Shift+W; the desktop app gets them.

---

## APP-SHORTCUTS — tabs and panes take Windows Terminal's chords, from one table (#631, 2026-09-28)

**Status:** one point superseded by KEYBOARD-NAV — Ctrl+Shift+W closes the focused pane
(`pane.close`), the tab only with its last pane; `tab.close` left the table. The rest holds.

- Ctrl+Shift+T opens a new tab, Ctrl+Shift+W closes the tab, Alt+Shift+= splits the focused pane right and Alt+Shift+- splits it down. The palette and Settings › Keybindings listed Ctrl+T, Ctrl+W, Ctrl+\ and Ctrl+-, which nothing handled; those stay the shell's: transpose, delete a word, SIGQUIT and readline's undo.
- One table, `APP_SHORTCUTS` (`utils/app-shortcuts.ts`), holds every app shortcut, the palette's included, keyed by a stable action id (`palette.open`, `tab.new`, `tab.close`, `pane.splitRight`, `pane.splitDown`), each chord as data: modifiers, and a key or a physical key. One matcher tests an event against a chord. The window's capture-phase listener runs the matching action, a terminal's key handler returns `false` for every chord of the table so none reaches a PTY, and the palette and Settings › Keybindings read their labels from the table. The table is the basis for configurable keybindings: a chord would be overridden by its id.
- An action runs as the tab bar and the panes run it, and the palette's rows for these actions run the same code as their chords: a new tab is the "+" button's (`onAddTab`), the tab closes as its × closes it (`onCloseTab`, which deletes the ended terminals the setting says to delete), and a split is the focused pane's, under Settings' pane limit (`onSplit`). The palette's rows had their own copies, which skipped the ended terminals and the limit.
- The split chords are matched on `ev.code`, `Equal` and `Minus`: with Shift held, `ev.key` is "+" and "_" on a US layout, and AZERTY and QWERTZ put = and - elsewhere or behind Shift. They are the two keys right of 0 on every layout, whatever it prints on them (on AZERTY, split down is Alt+Shift+)). Letters are matched on `ev.key`, so Ctrl+Shift+W is the key marked W. AltGr, reported as Ctrl+Alt, is none of the chords.
- No other binding of the app uses these chords: search is Ctrl+Shift+F, with Alt+C, Alt+R and Alt+W while it is open, and the profile shortcuts are Ctrl+Shift+1..9. The desktop app declares no native accelerator.
- A browser tab keeps Ctrl+Shift+T and Ctrl+Shift+W for itself (reopen a closed tab, close the window): Chrome never hands them to the page. The desktop app gets them; in a browser tab, the palette runs the same actions.

---

## PALETTE-SHORTCUT — the command palette opens with Ctrl+Shift+P (#624, 2026-09-28)

**Status:** the predicate `isPaletteShortcut` became the `palette.open` entry of the app's shortcut
table (APP-SHORTCUTS), which the window and the terminals still both read. The rest holds.

- Ctrl+Shift+P opens and closes the palette, as in Windows Terminal and VS Code; Cmd+Shift+P too, since the palette has always taken Cmd for Ctrl. It replaces Ctrl+K (UX-11), which the app no longer takes at all: readline's `kill-line`, nano's cut and emacs rely on it.
- The chord never reaches a PTY. The window's capture-phase listener opens the palette and calls `preventDefault()`, but xterm does not look at `defaultPrevented`: with Ctrl+K, the terminal still sent `^K` to the shell, and in bash or nano that erased what the user was typing. So the key handler a terminal gives xterm returns `false` for the chord, on keydown, keypress and keyup alike.
- One predicate, `isPaletteShortcut` (`utils/palette-shortcut.ts`), is read by both, so the window and the terminals cannot disagree on the chord. Settings › Keybindings shows it from the same module; it named Ctrl+P while Ctrl+K was the key that worked.
- No other binding of the app uses Ctrl+Shift+P. The profile shortcuts are Ctrl+Shift+1..9, and search is Ctrl+Shift+F.

---

## SSH-KEEPALIVE — one fixed keepalive, and no host setting for it (#607, #611, #612, 2026-09-28)

- Every SSH connection the hub opens carries ssh2's keepalive: a host's own, which a remote daemon is reached over too, a jump host's, and a Test connection's. A request goes out every 15 s, and the connection ends once 3 in a row go unanswered, so a host that went silent without closing TCP is lost 60 s after its last answer (`ssh-keepalive.ts`). That loss takes the path of any other: the session is disconnected, a reconnect is scheduled, and a restart waits for the host (#605).
- The values lean towards tolerance. A live server answers each request as it reads it, and at most a channel window (about 2 MB) is queued ahead of it, so only a saturated link slower than about 50 KB/s could lose a connection that was alive. On stdio that would end its terminals.
- A constant, not a setting. No other SSH timing is one, and a per-host value could only weaken this: "0 = off" brings back a host that shows connected while gone, and anything longer delays a restart that is waiting for it.
- The hosts' "Keep Alive (s)", which nothing ever read, is removed rather than wired (#611). Read as the interval, every stored 60 would have meant three to four minutes before a vanished host is noticed; read as a silence window, it would mean what no other SSH client means by it. "History (days)" went the same way (#612): spool GC's bounds are global and delete every chunk older than seven days, so its 30 days never applied, and a per-host bound would add a lookup across the two databases to GC for a privacy case nobody has asked for.
- The host routes ignore both fields, since clients from before still send them and a 400 would stop those saving a host. The columns stay: a downgraded hub opens a newer database as it is and still names them in its `INSERT` (STORAGE.md § 3.1, § 9.1).

---

## ENDED-TERMINALS — what a pane does over a terminal that has ended (#574, #580, #592, #605, 2026-09-28)

- "When a terminal ends" (Ask, Restart, Close) is a terminal profile key, `when_ended`, cascaded like the font: global, per host, per terminal. "Always do this" on the overlay writes it for the host or everywhere, and drops the overrides closer to that terminal so that the choice holds where it was made. Close asks no second question; `[panes] keep_ended` decides whether it deletes the terminal (#574).
- An end the hub caused is never acted on as it happens: a kill, a session closed, an agent replaced, a quit. The pane keeps the overlay and says the terminal was stopped from elsewhere, since restarting would undo a kill or race the replacement or the quit (#580).
- An end found later, at launch, on a reload or an attach, shows the overlay first, then follows the setting once, when its pane is on screen in the window that has the focus (#592). Never in the background, where nobody sees what restarts, and never in two windows at once. The hub also claims a terminal being brought back, so a second SPAWN naming it is refused while the first runs.
- The hub records why it ended a terminal, in `channels.end_reason`. Found later, `killed` keeps asking, because a deliberate stop is never undone by a setting; `stopped`, an agent replaced or a quit, follows the setting, which is the case that asked for this. STATE_SYNC names the killed ones, so a window that was away learns it before it could bring one back.
- The card shows only when the pane asks something; otherwise a quiet status line says what is happening (#595). A restart whose host is away waits for it instead of failing (#605).

---

## REMOTE-DAEMON-SCOPE — a remote daemon leaves the login session only where the host lingers (#600, 2026-09-27)

- Started by the hub's SSH `exec`, a remote daemon lives in that connection's logind session (`session-N.scope`), which `KillUserProcesses=yes` or a `loginctl terminate-session` ends, with every terminal it holds.
- The launch asks whether there is a `systemd-run`, whether lingering is on for the user, and whether the connection reaches the user's manager. When all three say yes, the daemon starts under `systemd-run --user --scope --collect` in a transient scope under `user@<uid>.service`. Otherwise, and when `systemd-run` refuses, it is detached in the session as before (`setsid`, else `nohup`). A refusal starts nothing, so the fallback never makes a second daemon.
- Only with linger: without it the user manager stops at the last logout and takes the scope with it, while the session scope survives the logout wherever `KillUserProcesses=no`, Debian's default. The scope is never worse than the session.
- A scope, not a service: it keeps the session's environment, the one the terminals inherit, where a service would get the user manager's; and it ends when its last process does, so a `nohup` job or a `tmux` server outlives the daemon as it did in the session.
- A new unit name at every launch, since `systemd-run` refuses a name still loaded. Nothing finds the daemon by its unit: the hub, `--stop` and the identity record go by the socket (SPEC.md § 3.2).

---

## TERMINAL-ENV — the agent builds each terminal's environment, and scopes store changes (#576, 2026-09-26)

- The agent spawns every PTY from a cleared environment and builds it in order: the base (`inherit`, the agent's own environment; `minimal`, a fixed list taken from it and never invented), the inherited `NO_COLOR` dropped, the terminal's identity (`TERM=xterm-256color` on Unix, `COLORTERM`, `TERM_PROGRAM`, `TERM_PROGRAM_VERSION`), `env_unset` then `env`, and elevation's variables last. It happens on the terminal's host because only the agent there knows that environment; the hub only ever knew its own.
- A scope, global, host or terminal, stores its changes, a value or a removal, never the environment they produce, so a variable that appears on the host later still reaches new terminals. The closer scope wins either way. A removal is `null` in a profile and `false` in `config.toml`, which has no null.
- Settings › Environment asks the host's agent for its variables live (`ENV_QUERY`), and neither side stores or logs them, names included. Only what a person types is stored.
- A terminal on an SSH host that runs the host's default shell with no arguments starts as a login shell, as `ssh host` gives, so `PATH` is right whatever the remote agent was started with. Local terminals are unchanged.
- An agent without the `env-modes` capability ignores the new SPAWN fields and is asked nothing.

---

## HUB-IDENTITY — a daemon serves several hubs, and a channel belongs to the hub that spawned it (#127, 2026-09-25)

- Before, the last connection won: it saw every channel, and received the output queued while nobody was connected. Channels live in a hub's `meta.db`, so the daemon now keeps them apart by who spawned them.
- The owner is the SHA-256 of a per-hub key, `hub-key` in the state directory, created once and sent in the AUTH of every daemon connection. The daemon keeps only the hash and compares it in constant time. A malformed key stops the hub rather than being replaced: a new key is a new owner, and the old one's channels would be out of reach with nothing to say why.
- Another owner's channel answers exactly as an unknown one does. Each owner has its own queue while it is away, and a new connection displaces only its own hub's previous one. A connection that presents no key is `legacy`, and the last one wins among those.
- STOP, sent over the hub's own connection, refuses while other hubs hold channels there unless it is forced; the host shows how many.
- Rejected as the identity: the TLS key, whose rotation (#193) would orphan every channel, and the primary token, which every hub reading the same `auth.json` shares and which a remote daemon is never given: its AUTH carries an empty token and the key.
- Not a boundary against the account itself (SECURITY.md § 3.6). Quit still stops a shared local agent, and with it the other hub's local terminals (#142).

---

## PWA-UPDATE — the hub decides which UI a page runs (#132, #564, 2026-09-25)

- A browser tab compares its build with the one `GET /api/health` reports on every connection, and takes a chunk that fails to load for the same news. A hidden tab reloads at once, a visible one shows a banner. The desktop does none of this: its UI is bundled with it.
- The service worker is hand-written and caches almost nothing: navigations go to the network every time and nothing caches `index.html`; only the build's hashed `/assets/*` are cached, per build. A precaching plugin such as vite-plugin-pwa would bring Workbox for the opposite default, a cached `index.html`, which is how a page gets stuck on an old version.
- It registers only in a browser, in a secure context, and a browser registers none over a certificate error, so with the hub's generated certificate the web UI stays an ordinary tab. Installing it takes an operator certificate from a CA the browser trusts, and a fixed port (SPEC.md § 3.4).

---

## REMOTE-DAEMON — a remote agent that outlives its SSH connection, on request (#79, 2026-09-22)

- Over stdio the agent is a child of the SSH session, so a dropped transport or a hub restart ends it and every PTY it holds. A daemon is started detached, listens on a Unix socket in its state directory on the remote, and the SSH connection reaches that socket through `direct-streamlocal`. What comes back speaks what the local daemon speaks, so `LastermAgent` drives it unchanged.
- Off by default (`[ssh] remote_daemon`), and a host's own answer wins: leaving a process on someone else's machine is a thing to agree to rather than to discover. Windows remotes stay on stdio, since no SSH channel carries a named pipe.
- Connect before launching, always. The agent unlinks a socket it cannot bind, so a daemon started on a live one's socket would take its place and leave its terminals unreachable.
- At hub start, such a host's terminals stay orphan and the hub does not dial out: reaching a host can need a password, and nobody is there to answer. Selecting the host reconnects and adopts them.
- The daemon exits after 30 minutes holding no terminal with no hub connected (`--idle-timeout 1800`): it lives on another machine and has to end by itself.

---

## RELEASE-PM-PIN — the release workflow rebuilds only tags that pin the package manager (#236, 2026-09-05)

- pnpm 11 reads its settings from `pnpm-workspace.yaml` and ignores the `pnpm` field of `package.json`, so a tag published before that move keeps its advisory overrides and build policy where pnpm 11 does not look. Rebuilding such a tag resolves dependencies differently from the artefacts that shipped under it, which is not a rebuild.
- Every `pnpm/action-setup` step therefore takes its version from `package.json`'s `packageManager` and passes no `version` input. The action compares the two literally and throws `Multiple versions of pnpm specified` when both are present and differ, and the comparison is string equality, so a matching input would be the same pin written eleven times.
- This narrows RELEASE-AUTO-CHAIN: `workflow_dispatch` remains a recovery path for a tag published since the migration **whose release is not published** — `create-release` refuses one it observes as published (#247) — and an older tag cannot be rebuilt by this workflow at all. There is no procedure for one: `workflow_dispatch` takes only a tag, and carrying the migration onto a branch cut from that tag produces a different commit, which the tag-versus-HEAD guard refuses by design. Ship the fix under a new version instead. `create-release` refuses such a ref before it touches the release, next to that guard, and admits only what `pnpm/action-setup` admits so that nothing it passes can fail in a later job.
- `.npmrc`'s `dangerouslyAllowAllBuilds=true` is gone. pnpm 11 ignores it — `better-sqlite3` was blocked with that line present — and it said the opposite of the `allowBuilds` map that now decides. Two descriptions of one policy, one of them dead.

---

## RELEASE-AUTO-CHAIN — merging the release PR is the whole release (2026-06-11)

- The multi-OS build chains directly off the release-please job via `workflow_call` (`release-build` job gated on `release_created`), in the same workflow run. Tag-triggered chaining is impossible by design: release-please pushes its tag with the default `GITHUB_TOKEN`, and GITHUB_TOKEN-created events never trigger workflows. The `push: tags` and `workflow_dispatch` triggers remain as recovery paths for re-building an existing tag whose release is still a draft. Once it is published, `create-release` refuses (#247): the release has to be converted back to a draft first, which immutable releases do not allow, and superseding it with a new version is then the only path.
- Releases are built as drafts, and one observed as published is refused: `create-release` exits before any cleanup or build when the tag already has a published release (#247). Reusing one meant every later job wrote to something users could see, and `gh release upload --clobber` replaces one asset at a time, so a failure halfway left the public release holding a mixture of old and new assets. The refusal is a snapshot taken when `create-release` runs: a writer can publish the admitted draft mid-run. `publish-release` looks again immediately before it writes and refuses a release it no longer finds as a draft; a publish between that look and its last upload stays outside what either can enforce. Recovering from a defective published release means either superseding it with a new version, or — when the release is mutable — converting that same release back to a draft — which immutable releases make unavailable, and which otherwise takes it out of public view at once. The next run's `publish-release` deletes every asset the draft carries, then uploads that run's one at a time; a rebuild that fails during that step leaves a draft holding part of the new set and none of the old. Delete any other draft for the tag first, since the cleanup keeps whichever release the API lists first (#270). A run that published the release and then reported failure also lands on the refusal; the release is complete and wants checking, not re-running. release-please creates a DRAFT release (`draft: true`), assets attach to it, and `publish-release` flips it public only when every build succeeded. `force-tag-creation: true` is required with drafts: GitHub defers tag creation for draft releases, which would otherwise break release-please's next version computation.
- The chained caller passes the exact commit SHA (`ref` input) alongside the tag. #250 made it resolved once instead of seven times, in a `resolve` job of its own; #275 moved that resolution into `matrix`, which already checks out the tree to build the job matrices. Every other job checks out the SHA it emits: a tag is a pointer, and one that moved mid-run left the later jobs building a commit the earlier guards had not inspected. `create-release` fails loudly if the tag exists on the remote but points at a different commit than the frozen SHA — GitHub ignores `target_commitish` once a tag exists, so retargeting a release is impossible and refusing to build is the only safe behavior. Where no tag exists yet, the binding is the release's own `target_commitish`, required to equal the frozen SHA on the reused draft and again in `publish-release` before the draft is flipped public: an empty tag lookup is not a pass, since a tag can be deleted between the two checks.
- `contents: write` is granted per job rather than at workflow level, and only to the two jobs that touch the release: `create-release` (the draft) and `publish-release` (its assets and its publication). The workflow declares `permissions: {}` as its baseline, and GitHub sets every permission a map does not list to `none`, so a job added without its own map gets nothing rather than the repository default. The builds run in `build.yml`, called with `contents: read`, and hand their outputs over as workflow artifacts instead of attaching them to the release (#260, #272): no job that runs `pnpm install`, a Cargo build script or the Tauri bundler holds a token that can replace release assets. `publish-release` installs nothing for the same reason — it resolves the artifacts with `scripts/release-assets.ts` under Node's own type stripping, then uses gh, jq and coreutils. Every checkout sets `persist-credentials: false`, so build code cannot recover the checkout credential; `create-release` and `publish-release` run `gh auth setup-git` before their `git ls-remote`, because that read is otherwise anonymous and would fail if the repository became private. It can still be handed the job token by an action's own default input (#280).
- Build hashes are stamped from `git rev-parse HEAD` of the checkout, never from the event SHA (wrong under dispatch on an older tag).
- release-please's draft (with its curated changelog body) is reused, never deleted/recreated; only duplicate drafts are pruned. Release listing uses `gh api --paginate` (a single 100-entry page would eventually miss the tag's release and duplicate the draft).

---

## RELEASE-VERSION-SYNC — release-please owns every version surface (#64, 2026-06-10)

- The release-please action is invoked in pure manifest mode (`manifest-file` + `config-file` only). `release-type` lives in the config's package block, never as an action input — as an input it selects the simple mode and silently ignores the config's `extra-files` (this is why three releases shipped without propagating versions).
- Every `extra-files` entry is a TYPED updater (`json`/`toml` with a jsonpath) targeting the version value directly. Bare strings are banned in this config: they select the annotation-based Generic updater, a guaranteed no-op on JSON files. `build-version.ts` is not an extra-file — it resolves its version at runtime (env → hub package.json).
- All version surfaces (root + 4 sub-packages + tauri.conf + 3 Cargo.toml) follow the single manifest version. The build-time jq/sed patch in `release.yml` remains as belt-and-braces for tag-dispatched builds.
- Known residual: release-please bumps Cargo.toml but not Cargo.lock; the lock self-heals at the next build (no CI cargo build uses `--locked`).
- Verification contract for any future config change: the open release PR's refreshed diff must list every declared extra-file (`gh pr diff <N> --name-only`) — a green action run alone proves nothing.

---

## HUB-DAEMON-SEA — SEA-aware daemon re-exec + readiness gate (#60, 2026-06-10)

- SEA daemon spawn re-execs the binary with CLI argv (`start --port N`) — the SEA bundle's entry IS cli.ts (footer auto-invokes `main(argv)`), so the existing foreground path provides everything (auth init, DBs, `persistRuntime`, shutdown handlers). No second entry point, no extracted script. `--daemon` is never re-passed (fork-bomb guard, locked by test). Dev mode keeps the compiled `main.js` sibling.
- Readiness is proven, never assumed: the parent polls `runtime.json` until `pid === child.pid` (immune to stale files/pid reuse), then probes `/api/health` on the published TLS endpoint. Success message only after a 200.
- Failure is loud and terminal: child stdout/stderr go to `hub-daemon.log` in the state dir (truncated per start so it can't grow unbounded — superseded: appended to since #133 so a losing start keeps the incumbent's log, and bounded at 10 MB by the hub holding the lock since #525; 0600 — daemon output may leak sensitive details); on child death or 5s timeout the CLI prints the cause plus a bounded log tail (64 KiB read cap) and exits 1. A timeout also SIGTERMs the child via the ChildProcess handle (never a raw pid kill — pid-reuse hazard): exit 1 must mean "no daemon is running".
- Health probes are individually bounded (single `healthTimeoutMs` constant feeding both the fetch AbortSignal and a race timeout) so a socket that accepts but never responds cannot hang the CLI past its deadline.
- Polling/probing logic lives in `daemon-launch.ts` as pure functions + injected-deps loop (no module mocks needed); the cmdStart wiring stays thin glue, untested by design (integration spawn test deferred — heavy and platform-fragile).

---

## DESKTOP-TRANSLUCENCY — Background modes + native window effects (#58, 2026-06-10)

- Three explicit background modes (image / solid / transparent) as per-scope `TerminalProfile` fields resolved through the 4-layer cascade — replaces the implicit "wallpaper set or not" model. Default `image`: with an empty wallpaper it renders solid, reproducing the pre-#58 states with zero profile migration.
- The desktop window is **built** for the background it is asked for, and a background that needs the other window lands at the next launch (Tauri: transparency is creation-time-only). See-through keeps the `transparent: true` window and lets CSS paint opacity in the other modes; a Windows material needs the opposite, because DWM paints Mica and Acrylic for a window and skips one carrying per-pixel alpha — which is why, while the window was transparent for good, the materials looked alike and none saw through (#62). Rebuilding the window under a running app was tried and rejected: the page it replaced could not close its hub relays, so a few changes of background exhausted them; the app ends with its last window, so the swap had to hold an exit back; and a rebuild caught mid-boot left a half-built page. The desktop keeps the asked-for background in `window-background` beside its configuration, since the window must be built before there is a hub to ask. Trade-off accepted: ~8× GPU power on macOS even for opaque content (tauri-apps/tauri#15471, open upstream) — macOS is not a tested distribution target; the mitigation, a macOS-only opt-out taking effect at the next launch like every other change of surface, is built only if real users report battery issues or upstream fixes the compositing path.
- `macos-private-api` feature accepted (required for macOS transparency) — App Store distribution is excluded by design (GitHub Releases only).
- The desktop single-instance lock lives at `/tmp/lasterm-<uid>/` on Unix and `%LOCALAPPDATA%\lasterm\runtime\` on Windows. The property is one path per user per host **whatever launched the app**, which is why `XDG_RUNTIME_DIR` cannot select it: a bare shell may not export it, so a launch from a desktop session and one from a terminal would take different paths and both become primary. `/tmp` is safe for this because its sticky bit lets only an entry's owner rename or remove it, and `$TMPDIR` on macOS is rejected for the same reason as `XDG_RUNTIME_DIR` — it is per-session. **This choice depends on the App Store exclusion above**: a sandboxed macOS application cannot write `/tmp`, so if that decision ever reverses, this one reverses with it.
- Window effects follow the active pane's scope like the window-wide wallpaper. The picker offers what the platform can actually paint: see-through, Mica and Acrylic on Windows 11, the vibrancy variants on macOS, nothing on Linux (compositor-dependent alpha only). `auto` and `blur` are gone from it — `auto` hid which material you would get, and blur is the legacy accent, drawn into the window rather than behind it, with documented drag and resize lag on 22621+. Stored values still resolve, so a profile carrying either keeps working. Unknown mode/effect values degrade at the render boundary (mode→image, effect→none) — there is deliberately no value validation in the hub resolve path.
- OS detection via `tauri-plugin-os` (canonical upstream surface) rather than a hand-rolled Rust command or registry-reading crate.
- The native effect follows WHAT IS DISPLAYED: useWindowEffects consumes a single `displayedEffectState` derived from useActiveWallpaper's displayed background (resolved, cached, or fallback) — no resolution/scope boolean gating; an effect can never outlive the painted background. IPC is latest-wins, serialized, with mandatory re-apply after stale completions and clearEffects only when an effect was actually applied.
- REST bodies for profile writes are camelCase only; snake_case exists solely in config.toml (algorithmic conversion at the file boundary — no lookup table to maintain).
- Settings UI: the mode selector is visible in ALL runtimes (per-scope server-side setting honored by desktop clients; "(desktop only)" hint in browsers); the effect picker is Tauri-only and hidden on Linux (no native effects there). No "None" wallpaper tile — the grid only picks which image; removing the wallpaper is expressed by switching the mode to Solid.
- Capability hygiene: `core:window:allow-set-effects` + `os:allow-platform` + `os:allow-version` granted minimally to the main window (narrowest set for the two plugin-os calls used), locked by a config regression test.
- Public asset embedding is token-gated: `/public/*` serves `Cross-Origin-Resource-Policy: cross-origin` ONLY when the URL carries the per-boot asset token (`?asset_token=`, constant-time compare), distributed via the authenticated `GET /api/assets/token`. The desktop webview (`tauri://localhost`) needs cross-origin embeds; without the token, assets stay same-origin-protected against drive-by localhost embedding. `GET /api/fonts` and `GET /api/wallpapers` now require auth (their responses carry signed URLs).

---

## MULTICLIENT-SYNC — Multi-client channel sync & SSH reconnect (2026-06-05)

- CHANNEL_CREATED broadcast: new channels are announced to all connected clients via a CHANNEL_CREATED message carrying the full channel payload (status live, resolved display title) so observers add the channel without a manual refresh; the web client filters by active host and dedupes by channel id.
- Consistency invariant: the hub persists the channel row to meta.db before broadcasting CHANNEL_CREATED and before sending SPAWN_OK (synchronous, no await between), so the spawning client's post-SPAWN_OK fetchChannels always observes the new channel in the REST snapshot. Observer clients whose fetchChannels is already in flight are covered by in-flight reconciliation: channels added via CHANNEL_CREATED during a fetch are preserved when the (pre-creation) REST snapshot resolves.
- fetchChannels generation guard: fetchChannels captures a monotonic generation counter before any I/O and commits all state (channels, groups, error, loading) in a single block behind a post-await generation check, so a slow stale fetch can never overwrite newer state or clobber error state.
- SSH reconnect passphrase policy: reconnect uses a cache-only passphrase callback that returns the cached passphrase for an encrypted key (non-interactive, never prompts the UI) and evicts expired entries on access, consistent with the interactive TTL policy.

---

## LOGGING-DAEMON — Unified per-channel logging + Windows daemon mode (2026-03-21)

- Log granularity: per-channel (1 JSONL file = 1 terminal tab), correlates directly with spool.db (output) and meta.db (metadata) by channel_id
- Format: JSONL with relative offset `t` (ms since channel creation), first entry stores absolute `created_at` ISO 8601 for wall-clock recovery on reattach
- Hub global log: hub.jsonl with ISO 8601 timestamps for events not tied to a channel (startup, auth, config)
- Agent stderr routing: process-global → hub.jsonl (multi-channel/daemon). Exception: stdio mode (single-channel) → attribute to the sole channel's log
- Hub always sets `src:"agent"` on agent entries (prevents log injection from agent-controlled data)
- LOG protocol message: new AgentToHub::Log(channel_id, level, msg) for agent diagnostics — NOT a replacement for OUTPUT (PTY data)
- Daemon logging fallback: agent in daemon mode writes to file when no hub is connected to capture stderr
- Config [logging] in config.toml: level (trace..error), output (stderr/file/both), max_age_days (default 30), max_size_mb (default 50 per channel)
- GC: delete channel log files older than max_age_days at hub startup, AFTER daemon reattach (active channel set must be built first — PRE-04)
- max_size_mb: stop writing when exceeded (no rotation), log warning to hub.jsonl
- Lazy open/close file handles: no persistent WriteStream, open/write/close per batch (avoids file handle exhaustion at 100+ channels)
- hub.jsonl runtime rotation: check size before each write, if >10MB rename to .old and start fresh
- File permissions: 0o600 (owner read/write only) on all log files
- HubLogger serialized writes: single writer task/mutex to prevent interleaved JSON lines
- Daemon reattach: reopen existing channel log in append mode, read first line's `created_at` to recover offset baseline
- Windows daemon: tokio NamedPipeServer at `\\.\pipe\lasterm-agent-<username>`, cfg-gated (no trait abstraction)
- Named pipe ACL: SecurityDescriptor restricting access to current user SID (defense layer 1)
- Auth token on daemon connections: hub sends AUTH with token on connect, agent rejects after 5s timeout if invalid (defense layer 2, works on both UDS and named pipe)
- Cross-platform signals: tokio::signal::ctrl_c() replaces Unix-only SIGTERM/SIGINT for daemon shutdown
- Log search API: GET /api/logs/channels/:channelId and /api/logs/hub with query params (level, from_t, to_t, search, limit)
- Log search UI: LogViewer.vue component with level/source/text filters, lazy load pagination
- ConPTY stdout leak fix (pre-requisite): SetHandleInformation(stdout, HANDLE_FLAG_INHERIT, 0) in agent main.rs prevents conhost.exe from inheriting protocol pipe
- Integration test stderr: Stdio::inherit() instead of Stdio::piped() — piping without reading fills OS buffer and deadlocks tracing subscriber

---

## RUST-AGENT — Full Rust agent rewrite (async-xpty + lasterm-agent) (2026-03-21)

- New public crate async-xpty: direct OS APIs (nix + windows-sys), not a fork of portable-pty (sync-only, broken v0.9.0)
- Full agent scope (all 17 message types, daemon mode, elevation, snapshots, process title) — not MVP subset
- MessagePack serialization: rmp-serde to_vec_named() for map format (struct-as-array was flagged by 3/3 LLMs as blocker)
- Secrets: zeroize crate (Rust optimizer removes naive String::clear())
- Unix PTY: TIOCSCTTY required for Ctrl+C to work in child process
- ConPTY: HPCON passed as value to UpdateProcThreadAttribute (not pointer to value) — root cause of all prior ConPTY issues
- ConPTY pipes: no SECURITY_ATTRIBUTES (non-inheritable) — inheritable handles cause cmd.exe to inherit agent stdout
- PSEUDOCONSOLE_INHERIT_CURSOR: skip initial cursor position query (prevents DSR deadlock)
- DSR response: pre-emptive \x1b[1;1R sent immediately + detection in output stream
- Agent CLI: --stdio (default), --daemon, --socket, --buffer-per-channel, --buffer-global flags
- OS-assigned port by default; an explicit port may retry on EADDRINUSE and the actual port is written to runtime.json
- Desktop reads runtime.json only (no hardcoded-port fallback)

---

## DESKTOP-LAUNCH — Desktop/Tauri launch fixes + shell discovery (2026-03-19)

- CSP disabled for Tauri webview (was blocking IPC + inline styles) — acceptable for local-first, permissive CSP deferred
- DevTools gated on `#[cfg(debug_assertions)]` — release builds don't auto-open
- Agent binary resolution: SEA mode uses co-located binary via `resolveAgentBinaryPath()`, dev mode uses `../../../agent/dist/main.js`
- PTY on Windows SEA: embed both `pty.node` (winpty) AND `conpty.node` (conpty) — node-pty auto-selects
- Default shell: `process.env.COMSPEC ?? "cmd.exe"` on Windows, `process.env.SHELL ?? "/bin/sh"` on Unix
- Shell discovery: parse `/etc/shells` on Unix (POSIX, works Linux+macOS), dedup by basename
- Shell discovery Windows: probe PowerShell Core, Windows PowerShell, cmd.exe, Git Bash, WSL distros
- Auto-seed launch profiles on first boot (idempotent, async non-blocking)
- Windows Terminal import: parse `settings.json` from `%LOCALAPPDATA%\Microsoft\Windows Terminal\`

---

## AUD-P0-SEC — P0 Security Audit Fixes: CORS allowlist, SSH TOFU, custom_command validation (2026-03-18)

- CORS: configurable origin allowlist via [server] cors_origins in config.toml, wildcard port matching
- CORS default: localhost + 127.0.0.1 any port + tauri://localhost + http://tauri.localhost
- CORS: strict ^...$ regex anchoring to prevent subdomain bypass
- custom_command: character ALLOWLIST [a-zA-Z0-9/\\._ :-], ASCII-only, absolute path
- custom_command: binary path only (no args), agent uses spawn with shell:false
- SSH TOFU: auto-accept first connect, reject+prompt on mismatch (30s timeout)
- SSH fingerprint: SHA256:<base64> format (OpenSSH compatible), self-hash raw key buffer
- SSH mismatch: HOST_VERIFY with promptId ULID + HOST_VERIFY_RESPONSE, pendingHostVerify Map
- SSH mismatch detection: explicit verificationState flag (lastKeyVerification.mismatch), not error text
- Bug fix: agent guard was `agent !== sshAgent` (wrong on first connect when agent=undefined); fixed to `agent != null`
- Review finding F-001 deferred: trust_once/trust_permanent both persist fingerprint (UI only exposes trust_permanent)

## PKG — Full Packaging Pipeline: SEA Binaries + CI + Auto-Deploy + Tauri (2026-03-13)

**Status:** superseded in part. The desktop's auto-updater was removed: see DESKTOP-UPDATES (#645).

- Two separate SEA binaries: lasterm-agent (node-pty) + lasterm-hub (better-sqlite3)
- Hub finds agent binary in same directory or PATH (sea-agent-resolver.ts)
- Node SEA assets + getRawAsset() + process.dlopen() for native addon loading
- --experimental-sea-config + postject workflow (Node 20+ compatible)
- Agent: node-pty external (extracted to cache dir at startup)
- Hub: better-sqlite3 external (same pattern)
- Web UI embedded as static-manifest.json SEA asset, served in-memory by Fastify
- Hub SQL migrations embedded inline via esbuild plugin (no filesystem reads at runtime)
- Host os/arch: nullable fields with auto-detect fallback (migration 012, uname + PROCESSOR_ARCHITECTURE)
- Auto-deploy: best-effort, SshAgentDeployOptions opt-in, SFTP fastPut for large binaries
- Binary cache: ~/.local/state/lasterm/binaries/lasterm-agent-{os}-{arch}
- sshExec utility: generic SSH command execution with configurable timeout
- checkRemoteAgent: which/where first, then common paths fallback
- CI: 3-job pipeline (build-web → build-sea 5-platform matrix → release), GitHub Releases
- Tauri v2: hub as sidecar (no glue layer), webview loads the published TLS endpoint
- System tray (show/quit), auto-updater (pubkey placeholder), shell plugin for sidecar

---

## ELEV-CONFIG — Configurable Elevation Methods + Passwordless-First Flow (2026-03-13)

- ElevationMethod includes 'custom' option for user-defined elevation commands
- Custom elevation: command receives '-- shell args...' suffix, no askpass flow
- Passwordless-first: try without password → SPAWN_ERR → prompt → retry
- Config cascade: global (config.toml) → per-host (meta.db)
- Methods: sudo, doas, pkexec (Linux/macOS), gsudo (Windows), custom (all)
- sudo -H flag fixes HOME issue (replaces -E alone)
- customCommand added to AgentSpawnMessage for agent-side custom elevation
- _sendSpawnAndWait extracted in session-manager for spawn retry pattern
- Migration 010: elevation_method + custom_command columns on hosts with CHECK constraint
- Per-OS custom commands: customCommandLinux/Darwin/Windows (not single customCommand)
- Custom ElevationCategory.vue: 3 OS sections, custom command field disabled unless method=custom
- Migration 011: elevated + elevation_method columns on channels (restart preserves elevation)
- restartChannel: two-step elevation flow mirrors handleSpawn (cache → passwordless → prompt)

---

## launch-profiles — Launch Profiles — Windows Terminal-style named launch configurations with elevation (2026-03-12)

- LaunchProfile as first-class entity in meta.db (not config.toml) — relational queries, CRUD API, FK references
- Dual-layer visibility: supported_os auto-filter + host_launch_profiles join table (pin/hide/default)
- Seed pattern: profile copied into channel at spawn time, not inherited live
- Variable expansion: one-pass left-to-right, agent-side, shared implementation
- Elevation: hub-centric credential management — collect (Web UI modal) → store (hub cache) → deliver (spawn msg) → execute (agent ASKPASS/gsudo)
- Linux/macOS elevation: sudo -A + ASKPASS script (password never in PTY stream)
- Windows local elevation: gsudo + UAC caching (no password from hub)
- Windows SSH elevation: NOT SUPPORTED MVP — deferred to agent packaging (CreateProcessWithLogonW)
- Reuse AUTH_PROMPT with promptType: 'elevation' (no new message types)
- Profile names: COLLATE NOCASE (case-insensitive uniqueness)
- Command palette prefix: ~ for profiles (# already used for channels)
- Shell validation: block ;|&$`, allow () for Windows paths
- Env masking: sentinel ******** preserved on PUT (no round-trip clobber)
- Migration 009: dual-source (hosts.default_shell + config.toml), per-host wins default slot

---

## TITLE-HUB-RESOLVE — Move title resolution from client to hub (2026-03-11)

- Hub resolves displayTitle using resolveChannelDisplayName (shared) — single source of truth
- displayTitle is computed (not stored in DB) — derived from title + dynamicTitle + processTitle + config
- Hub broadcasts displayTitle in TITLE_CHANGE/PROCESS_TITLE/ATTACH_OK messages
- Client uses channel.displayTitle everywhere — removes mode logic from 6 locations
- liveDynamicTitle (xterm.js local) stays as optimistic override in useTabTitle for active terminal only
- Config change (title section) triggers re-resolution of all active channels' displayTitles via broadcastDisplayTitles()
- ConfigResolver injected as optional 4th param to SessionManager constructor (null-safe)
- ChannelState tracks dynamicTitle/processTitle/displayTitle in memory (not stored in DB)
- handleAttach backfills ChannelState from DB on first attach (hub-restart scenario)
- notifyChannelRenamed() on SessionManager for F2 rename → displayTitle recompute + broadcast
- PUT /api/config/ui checks for 'title' key → calls sessionManager.broadcastDisplayTitles()
- F-002 fix: pendingAuthPrompts tracks clientId, cleaned on removeClient + shutdown
- F-003 fix: buildSshConnectConfig extracted in ssh-agent.ts (DRY for SshAgent.start + _testSshConnectivity)

---

## TEST-CONNECT-WS — Refactor test connectivity REST→WS via TEST_CONNECT message (2026-03-10)

- WS-only TEST_CONNECT replaces REST /api/hosts/:id/test and /api/hosts/test — single auth path
- TEST_CONNECT reuses AUTH_PROMPT mechanism from SPAWN for interactive password/passphrase prompting
- Lightweight SSH test (ssh2.Client ready event) — no agent spawn, no HELLO handshake
- REST routes and testSshConnectivity fully removed (no fallback)
- Unsaved hosts use generateId() as temporary hostId for WS correlation
- CLI cmdHostTest removed (can't do interactive auth via CLI)
- _buildPromptAuth extracted as DRY helper in SessionManager

---

## SSH-AUTH-PROMPT — SSH key passphrase + password prompting via AUTH_PROMPT/AUTH_PROMPT_RESPONSE (2026-03-10)

**Status:** one point superseded by MULTICLIENT-SYNC — a key's passphrase is cached for a limited
time, so a reconnect needs no prompt; it is no longer used once and dropped. The rest still holds.

- AUTH_PROMPT/AUTH_PROMPT_RESPONSE protocol messages (same pattern as HOST_VERIFY)
- SshAgent takes AuthPromptFn callback (DI) — hub provides WS-based impl
- Detect encrypted key via PEM header before connect (proactive prompt)
- Secret never stored — used once for ssh2 connect, then GC'd
- Keytar/OS keychain deferred to P1 (Tauri desktop only)
- pendingAuthPrompts keyed by hostId (one prompt per host at a time), 60s timeout
- AuthPromptDialog centered modal (not bottom-right like WriteRequest), 60s countdown, Enter/Escape keys
- F-001 fix: validate apr.secret type+length in ws-handler (OWASP input validation)
- F-004/F-005 deferred to TODO (L priority, single-user mitigates risk)

---

## SC-23 — Host Groups as First-Class Entities (2026-03-09)

- host_groups table is global (not per-workspace) — same as current behavior
- ON DELETE SET NULL on FK — deleting group moves hosts to ungrouped
- Collapsed state stays localStorage (per-device UI pref, not worth syncing)
- Migration 007 creates table + FK column; migrateHostGroupData() auto-migrates existing host_group strings at startup
- Old host_group TEXT column stays (SQLite can't drop columns) — becomes unused
- DAL methods named listHostGroupEntities/getHostGroupEntity/deleteHostGroupEntity to avoid collision with existing string-based methods (legacy cleanup deferred)
- API: /api/host-groups CRUD + /reorder replaces old /api/hosts/groups/:name routes
- PUT /api/hosts/reorder body changed from group (name string) to group_id (ULID)
- Frontend: hostGroups ref populated via fetchHostGroups API, auto-called from fetchHosts
- useHostGroups composable: sections from hostsStore.hostGroups (DB-backed), collapsed by ID in localStorage, empty groups visible
- RailContextMenu.vue: right-click rail background → "Add host" / "Add group"
- DnD cross-group: drop host on group header moves to that group, drop on ungrouped removes from group
- Group reorder via DnD persists to DB (reorderHostGroups API), no more localStorage for group order

---

## SC-22 — Host group DnD reorder in host rail (2026-03-09)

**Status:** partly superseded by SC-23 — group order is stored in the database, not localStorage.
The drag-and-drop mechanics below still hold.

- localStorage-based group ordering (not API) — host rail groups are derived from host.hostGroup strings, not ChannelGroup entities. Existing PUT /api/groups/reorder is for channel groups per host, not rail sections
- HTML5 DnD with text/x-lasterm-group dataTransfer type — same pattern as SC-21 tab reorder
- Splice index adjustment for forward drag: insertIdx = toIdx > fromIdx ? toIdx - 1 : toIdx (same pattern as TabBar.vue)

---

## SC-21 — Tab DnD reorder in tab bar (2026-03-09)

- Client-side only — no server API for tab order (localStorage via useLayout persist)
- dataTransfer type 'text/x-lasterm-tab' distinguishes tab DnD from pane DnD
- Reuse existing getDropInsertIndex() and CSS drop indicators
- reorderTab(from, to) splices tabs.value — existing watch auto-persists
- Guard against drag-during-rename (editingTabIndex check in onTabDragStart)
- toIndex adjusted by -1 when dragging right (removal shifts indices)

---

## UX-11 — Connection Experience (2026-03-09)

**Status:** one point superseded by PALETTE-SHORTCUT — the palette opens with Ctrl+Shift+P, and
Ctrl+K is left to the shell. The rest still holds.

- Fuzzy matching: custom scoring (~40 lines), no external dep, char-by-char (no regex on user input)
- Quick connect parser: char-by-char for IPv6 bracket detection, ssh:// prefix support
- Modal tabs: Vue component-level (no router), v-show for state preservation, full ARIA (tablist/tab/tabpanel with id linkage)
- Recent items: localStorage-backed composable (useRecentPaletteItems), max 8, MRU eviction, graceful degradation
- Keybinding: Cmd+K/Ctrl+K replaces Ctrl+P/Cmd+P
- Prefix filters: single-char (> @ #), stripped from query before fuzzy match
- UI-only: no schema/protocol/API changes
- sshPort type: number|undefined (not number), placeholder "22", omit from API when empty
- Auth method UX: watcher clears sshKeyPath on switch away from "key"
- Host preview: previewInitials computed (first 2 chars uppercase), emoji support
- Connection string display: formatConnectionString shared utility (DRY), used by both palette descriptions and rail subtitles
- Fuzzy scoring hierarchy: EXACT(1000) > PREFIX(500) > SUBSTRING(200) > FUZZY(10+boundary bonus)
- Review fixes: ARIA id/aria-controls/aria-hidden linkage, SC-05 invalid port splits host from port, explicit port 0 check

---

## WALLPAPER — Configurable terminal wallpaper with cascade (2026-03-08)

- Wallpaper fields in TerminalProfile (cascades via existing 4-layer system)
- Upload to ~/.config/lasterm/wallpapers/, served at signed /public/wallpapers/ URLs (same pattern as fonts)
- Cover only (no contain/tile), blur 0-20px, dim 0-100%
- Layer stack: wallpaper-bg (z0) → wallpaper-dim (z1) → terminal (z2) → tint (z3)
- Upload validation: jpg/jpeg/png/webp/gif/avif, max 10MB via @fastify/multipart
- GET /api/wallpapers, POST, and DELETE require auth; thumbnail/runtime URLs append the per-boot asset token
- Path traversal: basename + directory containment
- X-Content-Type-Options: nosniff on static wallpapers route
- Cache-busting ?t=timestamp plus asset_token on wallpaper URLs
- useWallpaper composable: profile ref → wallpaperStyle + dimStyle computeds
- TerminalPane z-index: wallpaper-bg(0) → dim(1) → terminal(2) → tint(3)
- WallpaperCategory.vue: picker grid + upload + blur/dim sliders + scope override

---

## UX-09 — Settings Panel — Config Cascade UI (2026-03-08)

- D1: Global config persisted to config.toml (4-layer cascade preserved, no 5th layer)
- D2: Comment-preserving round-trip via @rainbowatcher/toml-edit-js (supersedes original D2)
- D3: Absorb existing AppearancePanel into Settings Panel (Appearance category)
- D4: @iarna/toml for parsing (read), @rainbowatcher/toml-edit-js for writes
- D5: Single GET /api/config/cascade endpoint returns all 4 layers + resolved
- D6: UiConfig (tabs/panes/search/startup) Global scope only — not cascaded to host/channel
- D7: Keybindings = read-only grouped list for MVP (no editor, no conflict detection)
- D8: Schema-driven categories (settingsSchema registry, generic CategoryContent renderer)
- D9: Input validation — whitelist known TerminalProfile/UiConfig keys, reject unknown
- D10: 500ms debounce on all setting mutations
- D11: Auto-fallback to Global tab when host/channel removed
- D12: Create config.toml on first write if missing
- D13: @rainbowatcher/toml-edit-js (303KB WASM) for comment-preserving config.toml writes
- D14: appearance.json absorbed into config.toml [appearance] — single portable config
- D15: autoSwitch via prefers-color-scheme (system) — no manual day_start/night_start

---

## UX-07 — Host Customization & Visual Profiles (2026-03-07)

- Visual profile stored in hosts.profile_json (no DB migration)
- Presets + resolvePreset() in web package, NOT shared
- Banner position fixed between pane header and terminal content
- Tint via CSS ::after pseudo-element with will-change: opacity
- No detectPresetFromProfile() — preset stored explicitly
- hostId prop passed through PaneLayout → TerminalPane for per-pane visual profile

---

## UX-05 — Notifications (2026-03-07)

- BELL + NOTIFICATION: new protocol messages (agent→hub→UI), camelCase interfaces
- Agent throttle: BELL 1/100ms, OSC9 1/500ms per channel via timestamp comparison
- Hub rate limit: BELL 10/sec, NOTIFICATION 5/sec per channel via sliding window
- OSC 9 sanitization: strip control chars, strip HTML tags, truncate 256 chars, trim
- Sound serving: @fastify/static at /public/sounds/ (same pattern as /public/fonts/)
- Notification store: shallowRef<Map> with replace-on-mutate for Vue reactivity
- Activity detection: UI-side only, newline counting in OUTPUT data, debounced
- Desktop notifications: Notification API tag-based grouping, 5s window
- Bell sound: system (AudioContext 800Hz sine), custom (Audio element), mute
- Scroll modes: auto (threshold-based), alwaysBottom, alwaysResume
- UnreadLinesBar: 999+ cap, mark-as-read + jump buttons
- Badge clear: only via scroll behavior (markRead/jump/naturalScroll), NOT on tab switch alone

---

## UX-03 — Host Management (2026-03-07)

- Migration 006: 6 new columns with defaults, backfill sort_order per-group using rowid
- listHosts ordering: local first, then COALESCE(host_group, '~') ASC, sort_order ASC
- Label regex updated to allow dots: /^[a-zA-Z0-9._-]+$/ per INV-02
- SSH config parser: manual (no dependency), supports Host/HostName/Port/User/IdentityFile/ProxyJump
- Batch import: atomic transaction, 409 with conflicting_labels array on conflict
- Route ordering: static routes before parameterized :id routes in Fastify
- Duplicate host: -copy suffix, auto-increment, cannot duplicate local
- sortedHosts computed: use server order directly (no client re-sorting)
- Host groups: collapse state persisted in localStorage (lasterm:collapsed-host-groups)
- HostRail: DnD via HTML5 drag/drop, reorder API call + fetchHosts on drop
- BatchImportModal: snake_case wire → camelCase conversion, ProxyJump auto-check, 409 conflict display
- HostRailSettings: singleton composable with localStorage persistence (lasterm:host-rail-settings)
- Rate limiting: in-memory sliding window 5/60s on test connection endpoints (INV-11)

---

## UX-04 — Scrollback Search (2026-03-07)

- @xterm/addon-search ^0.16.0 via pnpm catalog
- Decoration colors from CSS vars: --nt-search-highlight, --nt-search-highlight-active with yellow/pink fallbacks
- Match count via SearchAddon.onDidChangeResults event
- Regex validation client-side before passing to SearchAddon
- SearchAddon loaded after term.open() + fitAddon.fit() per INV-09
- SearchOverlay positioned absolute within TerminalPane
- 3 position variants: top-right, bottom-right, bottom-bar
- Ctrl+Shift+F via terminal.attachCustomKeyEventHandler
- Alt+C/R/W shortcuts via useSearchShortcuts composable
- Scrollbar markers: native xterm.js overview ruler (overviewRulerWidth: 15)
- scrollbarMarkers in TerminalProfile (default true)
- Multi-pane search: useMultiPaneSearch with PaneSearchHandle registry via provide/inject
- collectTerminalChannelIds: layout tree walk, skips vacant nodes
- Cross-pane navigation with wrap-around, skip zero-match panes
- Scope toggle visible only when countPanes > 1
- shallowRef for handle registry
- Search history: localStorage lasterm:search-history, MRU order, dedup by query+regex
- SearchConfig: position, highlightOnClose (clear/fade/persist), historySize. It also had a scrollbarMarkers, which Settings wrote and no terminal read; removed in #614, the TerminalProfile key being the setting (a `[search] scrollbar_markers` still in config.toml is read as its global value until that key is set)
- Hub [search] section parser with DEFAULT_SEARCH_CONFIG
- highlightOnClose=fade uses 300ms setTimeout before clearDecorations
- getDecorationColors always returns matchOverviewRuler (transparent when disabled)
- historySize as MaybeRef<number> for reactive config

---

## UX-02 — Terminal Title / OSC 0/2 (2026-03-07)

- Dual approach: UI parses OSC locally for instant display (INV-04), agent sends TITLE_CHANGE to hub for DB persistence (INV-05)
- sanitizeTitle in shared/src/sanitize.ts: strips HTML tags (/<[^>]*>/g), strips C0/C1 control chars, trims, truncates to 256 — defense-in-depth (both agent and UI sanitize)
- Tag content preserved during HTML strip (e.g., `<script>alert(1)</script>vim` → `alert(1)vim`) — safe because Vue renders via .textContent, not innerHTML
- Agent debounce: per-channel 100ms last-write-wins timer for TITLE_CHANGE emission (INV-07)
- Hub debounce: per-channel 100ms last-write-wins timer for dynamic_title DB writes (INV-08), but broadcasts to UI immediately
- Empty OSC title suppressed (not sent as TITLE_CHANGE) per INV-09
- Migration 005-dynamic-title.sql: ALTER TABLE channels ADD COLUMN dynamic_title TEXT DEFAULT NULL
- dynamicTitle added to Channel entity + UiAttachOkMessage for reconnect recovery (SC-02)
- HeadlessTerminal.onTitleChange exposed for agent subscription, PtyManager.onTitleChange(channelId, cb)
- useTabTitle composable: INV-01 priority chain — custom > live dynamic > stored dynamic > fallback
- Title stack in useTerminal: max 5 entries, empty titles skipped, top of stack = currentDynamicTitle (SC-05)
- resolveTabLabel updated to accept dynamicTitle in channel objects
- TITLE_CHANGE WS handler in session store routes to channelsStore.setDynamicTitle
- ChannelItem shows dynamicTitle without prefix (SC-15)
- truncateTitle: 3 positions (end/middle/start), U+2026 ellipsis, default maxLength 50
- useWindowTitle: formatWindowTitle with {prefix},{host},{title},{channel},{shell} tokens, trailing/leading separator trimming, debounced 100ms
- TitleConfig interface: source, fallback, fallbackCustom, maxLength, truncation, prefix, windowTitle, windowFormat
- Hub [title] section parser with DEFAULT_TITLE_CONFIG, exposed via UiConfig
- resolvedTitle exposed from useTabTitle for window title composition (raw, no prefix/truncation)
- Prefix prepended BEFORE truncation (counts toward char limit), sidebar excluded from prefix
- Reset Title to Dynamic: clears channel.title via PATCH null, TabContextMenu enabled when isCustom
- clearTitle action in channels store wraps renameChannel(id, null)
- TitleConfig.source='static' disables dynamic titles, TitleConfig.fallback controls fallback strategy (channel/shell/custom)

---

## UX-01 — Tab Actions, Split Panes & Welcome Tab (2026-03-07)

**Status:** one point superseded by ENDED-TERMINALS — every ended terminal gets the exit overlay,
with Restart and Close, not only a direct process, and closing it asks no second question.

- TabContextMenu: Teleport to body, click-outside listener, fixed positioning from event coords
- Close actions (closeOthers/closeToRight/closeAll): vacate panes in other tabs, tabs stay open (never removed)
- vacateAllPanesInTab: walks layout tree, replaces all terminal nodes with vacant
- closeAll accepts optional exceptWelcomeId for welcome tab protection (INV-06)
- Vacant nodes carry unique id (generateId()) to distinguish multiple vacant slots in same tree
- vacatePane replaces terminal node in-place with vacant (preserving split structure)
- rearrangeVacant collapses parent split. A root vacant has no sibling: "Close Pane" on it closes the tab, as the tab's × does (#405). INV-04 still holds: that is the user closing the tab, never the tab closing on its own
- The vacant picker offers only detached channels, shown in no pane of any tab (EFF-03); it offered every live channel of the host, which put the same terminal twice in one tab
- onClosePane no longer kills terminals — INV-03 compliance (detach, never kill)
- countPanes exported as standalone function for max-4-pane enforcement (INV-02)
- Welcome tab: per-host, enforced via transaction (clears previous before setting new), migration 003
- Star icon: Unicode ★ with --nt-accent color in both TabBar and ChannelItem
- Cross-tab DnD: vacate-first strategy prevents duplicate channelId in same-tab moves
- DnD: paneId-based targeting for precise node replacement in tree, header as drag handle
- DnD: 5 drop zones (left/right 25%, top/bottom 25%, center 50%)
- Configure Command: migration 004 (icon, args, direct_process columns added to channels)
- SPAWN message extended with args/directProcess; agent PtyManager honors in pty.spawn
- POST /api/channels/:id/restart: kills + re-spawns with saved config
- Exit overlay for directProcess channels: Restart / Configure Command / Close buttons
- Channel sidebar: context menu inline in ChannelItem (no separate component — reduces indirection)
- Open in Current Tab: uses replaceChannelId to swap active tab content
- ConfirmDialog: generic reusable component with "Remember for host" / "Remember globally" checkboxes
- Remember preferences: localStorage lasterm:skipConfirm* keys with explicit actionKey (not title parsing)
- Config sections: [tabs] [panes] [channels] [startup] in config.toml
- Config defaults: confirmCloseAll=true, confirmCloseOthers=true, maxPanes=4, autoOpenWelcome=true
- Welcome endpoint cross-host check: verifies channel.hostId matches path param host ID

---

## UX-06 — Theming & Color Schemes (2026-03-07)

**Status:** one point superseded by UX-09 (D14) — appearance settings live in `config.toml`
under `[appearance]`, not in `appearance.json`. The rest still holds.

- CSS custom properties as single source of truth for all chrome colors (--nt-* prefix, 48+ vars in 3 tiers)
- Theme files on disk (~/.config/lasterm/themes/), not DB — portable, git-friendly
- 9 bundled presets (6 dark, 3 light), default catppuccin-mocha, copy-if-missing strategy
- AppearanceConfig = global only; theme NAME = per-host via TerminalProfile cascade
- AppearanceConfig persisted in appearance.json (not config.toml) — simpler read/write
- Theme name validation: /^[a-z0-9-]+$/ with path traversal prevention in get/delete
- LastermTheme = colors (22 terminal) + ui (15 chrome), validateTheme returns {valid, errors[]}
- BUNDLED_THEMES as Record<string, LastermTheme> in shared/themes/index.ts
- ThemeManager uses fs/promises (async), ThemeError for structured errors
- Terminal theme propagation via callback Set in theme store — toXtermTheme() + onTerminalThemeChange()
- Per-host theme override: useTerminal checks profile.theme, resolves from availableThemes (SC-03)
- Live preview hover debounced via requestAnimationFrame (INV-08)
- setTheme() disables autoSwitch when enabled (SC-14)
- AppearancePanel as Teleported right-side slide-out panel (480px) with overlay backdrop
- ThemeEditor: deep watcher on draft colors with rAF debounce for live preview
- useAutoSwitch composable with matchMedia listener, onScopeDispose cleanup
- Opacity via --nt-*-alpha CSS vars + rgba(var(--nt-*-rgb), var(--nt-*-alpha)) pattern
- Scrollbar: --nt-scrollbar-width CSS var, style thin/wide/hidden
- deepMerge generic constraint relaxed to T extends object (was Record<string,unknown>)

---

## AGENT-DAEMON — Standalone agent daemon with UDS/named pipe transport (2026-03-06)

**Status:** partly superseded by RUST-AGENT — the daemon is the Rust agent, not a Node `net`
server. The socket paths, the framing and the reconnect messages below still hold, and
last-connection-wins now applies only once a connection has authenticated, and only among the
connections of one hub (HUB-IDENTITY).

- Node.js net module for cross-platform socket transport (UDS + named pipes, same API)
- Socket path per-user: $XDG_RUNTIME_DIR/lasterm/agent.sock (Linux) / \\.\pipe\lasterm-agent-<username> (Windows)
- Socket probing for agent discovery (net.connect then close) — no PID file for liveness
- Hub auto-starts agent as detached process (spawn + unref) if socket not found
- --daemon (new, socket) / --stdio (unchanged, kept for SshAgent until Phase 2)
- Same MessagePack framing over socket as over stdio — only transport layer changes
- AGENT_CHANNEL_STATE + CHANNEL_STATE_END messages for reconnect reconciliation
- Output buffering: configurable per-channel cap (1MB default) + global cap (20MB default), ring buffer
- LastermAgent: single concrete class replacing AgentConnection abstract, constructor(Duplex), factory methods
- LocalAgent + SshAgent untouched — used until Phase 2 replaces SshAgent with SSH tunnel + LastermAgent
- Last-connection-wins: new hub connection displaces previous
- Warm restart (agent died) vs reconnect (hub died) — distinct documented flows
- Agent daemon logs to <stateDir>/agent.log when detached
- EACCES on probe: don't unlink, throw (different user's socket)
- [agent] section in config.toml for buffer caps, socket_path override, log_level
- Tests use real UDS in temp dirs, NOT stdio mocks
- Phase 2 = remote agent daemon via SSH tunnel (LastermAgent.connectTunnel) — separate story

---

## channel-delete-flow — DELETE endpoint + dead channel UI + tab scroll (2026-03-06)

- DELETE /api/channels/:id: sends DESTROY to agent, marks dead in DB, broadcasts CHANNEL_STATE
- SessionManager.destroyChannel(): centralizes PTY kill + scheduler/chunker untrack + channel map cleanup
- UI removeChannel: calls DELETE API, marks dead + nextTick (for watcher to close tab), then filters
- WriteLockIndicator isDead prop: hides Force Take / Request Write on dead AND orphan channels
- Tab bar horizontal scroll: visible thin scrollbar, mouse wheel→horizontal, auto-scroll to active tab on selection

---

## host-dot-dead-tab — Fix host status dot + configurable dead channel tab behavior (2026-03-06)

- New [ui] section in config.toml for UI behavioral config (separate from terminal profile)
- on_channel_dead: 'close' (default) | 'readonly' — configurable tab behavior
- GET /api/config/ui endpoint to expose UI config to frontend
- addClient sends initial SESSION_STATE for all active sessions
- sessionStatusToHostStatus: 'detached' maps to 'live' (green) — agent running = host reachable
- listChannels() excludes dead channels (WHERE status != 'dead') — dead channels are internal bookkeeping

---

## s-backlog-sweep — Fix all S-priority review backlog items (2026-03-05)

- DEFAULT_CHANNEL_NAME constant in shared/constants.ts replaces all hardcoded "Terminal"
- purgeDeadTabs and resolveTabLabel as pure functions in useLayout (DI, no store dependency)
- WS_RECONNECT refactored to dedicated onReconnect/onDisconnect lifecycle events on WsClient
- Auth hook uses URL pathname parsing for exact path matching
- Pairing code retry loop (5 attempts) with SQLite UNIQUE constraint catch
- cols/rows stored in meta.db channels table, passed through SPAWN and warm restart
- SnapshotScheduler max 4 concurrent snapshots with inFlight counter
- _spawnChannelsForHost 10s per-channel SPAWN timeout

---

## m-backlog-sweep — Fix all M-priority review backlog items (2026-03-05)

- GC dead_retention_hours and max_size_per_channel_mb configurable via config.toml [gc] section
- SendQueue extracted to shared class with pending/isDraining/frames getters
- Session reuse already implemented — backlog item was obsolete
- WS input validation in shared/validation.ts (ULID, dimensions, data size, env)
- useRename composable with onCommit callback pattern

---

## editable-channel-names — Editable channel names + backpressure + font fix (2026-03-05)

- channels.title column already exists in DB (nullable) — leverage existing schema
- Default channel name: "Terminal" (simplified from Shell #N counting approach)
- PATCH /api/channels/:id for rename with 1-128 char validation
- Optimistic UI update with rollback on PATCH failure
- Double-click to rename in both sidebar ChannelItem and TabBar
- v-show keep-alive for tabs: prevents terminal replay/destruction on tab switch
- Backpressure across agent→hub pipeline: pause/drain in agent, send queues in LocalAgent/SshAgent
- Font watcher race fix: removed ready.value guard, apply profile unconditionally

---

## [backfill] Channel lifecycle & session persistence (2026-03-04)

**Status:** the first point is superseded by AGENT-DAEMON and REMOTE-DAEMON — a hub restart no
longer marks every channel dead: one a daemon may still hold stays orphan until the hub reaches that
daemon again and adopts it.

- On hub restart: mark all channels dead + sessions closed via startup sweep (markAllChannelsDead)
- ATTACH protocol: TerminalPane sends ATTACH → hub replies ATTACH_OK with snapshot + tail → xterm restore
- Three ATTACH cases: new channel (empty), orphan with live agent (fresh snapshot), orphan with dead agent (cached from spool.db)
- Warm restart: respawn agent with same channel IDs to restore content (optional channelId in SPAWN message)
- CHANNEL_DEAD error code distinguishes "never existed" from "stale after restart"
- CHANNEL_STATE listener moved from App.vue watch to SessionStore.connect() — fixes race condition
- Terminal RESIZE deduplication: track lastSentCols/Rows, debounce 50ms, skip if unchanged
- canWrite ref in useTerminal: default true (single-client), set false until auth confirms ownership

---

## [backfill] Custom fonts & config cascade wiring (2026-03-04)

- Cross-platform font stack: Consolas → Liberation Mono → Courier New → monospace (no embedding, licensing)
- User fonts: drop .woff2/.woff/.ttf/.otf in ~/.config/lasterm/fonts/, auto-discovered
- Font serving: second @fastify/static at signed /public/fonts/ URLs (decorateReply: false for multi-static)
- Font filename heuristic: family slug from first segment, camelCase→spaces, suffixes→weight (Regular=400, Bold=700)
- GET /api/fonts requires auth because returned font URLs carry the per-boot asset token
- Dynamic @font-face injection: <style> element appended to <head> at startup
- Config load bug: ConfigResolver.loadFromFile() was never called — instantiated but not invoked
- Config store: Pinia useConfigStore.load() fetches /api/fonts + /api/config/resolved in parallel
- Profile propagation: useTerminal(containerRef, wsClient, profile?) — optional param, defaults to DEFAULT_PROFILE

---

## MVP-LASTERM — Implement full lasterm MVP (2026-03-03)

- Plan-provided mode: specs in docs/
- Continuous mode: no pauses between stages

- HostRail: djb2 hash → HSL palette, 48px column
- ChannelSidebar: groups in localStorage, drag not needed for MVP
- PaneLayout: recursive split tree, localStorage persistence
- CommandPalette: module-level singleton, fuzzy includes match
- ConfigResolver: 4-layer deep merge, null removes key, arrays replace
- CLI: manual argv parser (no yargs/commander), dynamic imports for heavy deps
- Onboarding: auto-create local host, openBrowser via execFile
- Token auth: 32-byte hex, timingSafeEqual, chmod 600 auth.json
- Pairing: 6-digit code (padStart), 60s expiry, max 3 active
- Write-lock: 3-tier (auto-claim, request/grant, force), first-attach=writer
- WriteLockManager: standalone class with DI callbacks
- @xterm/headless CJS: default import + destructure
- Auth hook skips /health and /pair/verify

---

## [backfill] Foundational architecture — Stack & design decisions (2026-03-03)

- HTTP server: Fastify (perf + TS-first + plugin ecosystem)
- Database: SQLite via better-sqlite3 with WAL mode — meta.db (state) + spool.db (output chunks/snapshots)
- PTY: node-pty for local spawn, agent-only PTY control (hub never touches PTY directly)
- SSH: ssh2 library, agent launched via `lasterm-agent --stdio` over SSH
- WebSocket codec: MessagePack binary serialization (snake_case on wire, camelCase in TS)
- UI: Vue 3 + Vite SPA with Pinia state management
- Terminal: xterm.js (browser rendering) + @xterm/headless (snapshot capture without DOM)
- IDs: ULID everywhere (sortable, monotonic, better DB indexing than UUID)
- Monorepo: pnpm workspaces — packages: agent, hub, web, shared, cli
- Protocol: unified protocol.ts — single source of truth for all message schemas (HELLO, SPAWN, ATTACH, AUTH, SNAPSHOT, LOCK...)
- Entity model: Host (permanent) → Session (runtime) → Channel (PTY instance)
- Session state machine: STARTING → ACTIVE → DISCONNECTED → CLOSED, persisted in meta.db
- Architecture: local-first hub daemon, agents spawned as children (local) or via SSH (remote)
- REST API: all routes under /api/ prefix, WebSocket at /ws (no /api)
- OS-assigned port by default, with an explicit-port override
- Snapshot: event-driven scheduler → chunks in spool.db with cache_index, GC preserves last per channel
- Formatting: biome with tabs
- Tests: vitest, colocated *.spec.ts

---

## issue-183 — TLS endpoint identity and startup authority (2026-08-10)

- The hub transport carries endpoint identity: browser, CLI, development proxy, and probes use HTTPS/WSS and validate the peer against the SPKI recorded in `runtime.json`.
- Pin only the SPKI, not a certificate fingerprint. The key is generated once when no operator certificate/key pair is configured, so certificate replacement does not silently become a new identity.
- The browser-token rule is unconditional: browser-originated requests and WebSocket connections carry a token; TLS identity does not replace application authorization.
- Startup uses a sweep of stale browser tokens before serving rather than an instance identifier. The sweep makes prior browser authority invalid before the new listener is observable.
