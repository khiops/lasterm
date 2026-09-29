# Privacy policy

Effective 29 September 2026.

> **No account. No telemetry.**
>
> Lasterm sends nothing about you, your computer or your terminals to its developers or to anyone
> else. Beyond your computer, the app connects only to:
>
> - the hosts you add, over SSH;
> - GitHub, to download the agent it installs on a host.

This policy covers the Lasterm desktop application for Windows and what comes with it: the hub,
the agent, and the web interface the hub serves. It applies however you install Lasterm: from a
release on GitHub, from the Microsoft Store, or built from this repository.

## No account, no telemetry

- There is no account to create and nothing to sign in to. Lasterm assigns you no identifier. The
  keys it creates, such as the hub's key, are used only between its own parts: the app, the hub and
  its agents.
- Lasterm contains no analytics, no usage statistics and no crash reporting. It does not report
  what you do, which hosts you use, or what your terminals show.
- Lasterm has no server of its own. Apart from the hosts you add, the only service it contacts is
  GitHub, to download the files described under
  [Connections Lasterm makes](#connections-lasterm-makes).

## What stays on your computer

What Lasterm keeps stays on the computer that runs its hub, in these folders, apart from what it
installs on your hosts ([below](#on-the-hosts-you-add)):

| Folder | Windows | Linux |
|---|---|---|
| Configuration | `%APPDATA%\lasterm` | `~/.config/lasterm`, or `$XDG_CONFIG_HOME/lasterm` |
| State | `%LOCALAPPDATA%\lasterm` | `~/.local/state/lasterm`, or `$XDG_STATE_HOME/lasterm` |
| Cache | `%LOCALAPPDATA%\lasterm\cache` | `~/.cache/lasterm`, or `$XDG_CACHE_HOME/lasterm` |

| What | Where |
|---|---|
| Your settings | `config.toml` and `appearance.json` in the configuration folder, and `close-behavior.json` for the desktop app |
| Themes, the bundled ones and those you add, and the fonts, wallpapers and bell sounds you add | `themes`, `fonts`, `wallpapers` and `sounds` in the configuration folder |
| The access token the app and your browser use to reach the hub | `auth.json` in the configuration folder |
| Your hosts: name, address, port, user name, how to sign in and the path of the key file you chose, the jump host, the fingerprint of each host key you accepted, the system and shells found there, colour, group and settings | `meta.db` in the state folder |
| Your terminals: title, shell, command, working directory and the environment changes you set; your launch profiles | `meta.db` |
| Browser pairings: a hash of each token and of each pairing code, when they were used, and the addresses that used or tried them | `meta.db` |
| What your terminals print, kept so a screen can be restored when you come back | `spool.db` in the state folder |
| What the app needs to find and verify its hub: its port, keys and certificate | `runtime.json`, `hub-key`, `hub-tls-key.pem` and `hub-tls-generated-cert.pem` in the state folder; for the desktop app, also `identity\known_hubs.json` in `%LOCALAPPDATA%\lasterm` |
| Logs | the `logs` folder and the `.log` files in the state folder |
| The agents downloaded for your remote hosts | `binaries` in the state folder |
| Components the hub unpacks from its own executable | the cache folder |

The interface keeps a few things in its own web storage: the access token, the layout of your tabs
and panes, your recent searches in terminals, and your recent command palette entries. In the
desktop app that storage is in `%LOCALAPPDATA%\app.lasterm.desktop`; in a browser, it is the
browser's storage for the hub's address.

**Terminal output** is kept up to 10 MB per terminal and for up to 7 days, except the last screen
of a terminal that is still running. Everything a terminal left is deleted 24 hours after it ends.
The `[gc]` section of `config.toml` changes the size and the delay.

**The logs** record events such as the hub starting, a browser signing in with the address it came
from, and a connection to a host with its name, address and user name. They never contain what you
type, what a terminal shows, or a password, passphrase or token. Each of the hub's logs is set
aside when it reaches 10 MB, replacing the one set aside before. The local agent's logs are kept
until you delete them.

None of these files is encrypted. On Linux, the databases and the files holding keys and tokens are
readable by your user only. On Windows, they have the permissions of your user profile.

### On the hosts you add

Lasterm installs its agent on each host you connect to, unless it finds one there already:
`~/.local/bin/lasterm-agent` on Linux, `%LOCALAPPDATA%\lasterm\lasterm-agent.exe` on Windows. A Linux host set to keep an agent running
also gets a folder, `~/.local/state/lasterm` (or `$XDG_STATE_HOME/lasterm`), holding the agent's
socket, its logs and its records. The agent keeps what your terminals print in memory, never on
that host's disk.

### Passwords, passphrases and keys

- **An SSH password is never stored.** Lasterm asks for it when it connects.
- **A key passphrase is never written to disk.** The hub keeps it in memory for 60 seconds, or for
  15 minutes when you tick *Remember for this session*, so that a reconnection does not ask again.
- **A password for an elevated shell** (sudo and the like) stays in the hub's memory for at most
  15 minutes, and is never written to disk.
- **Lasterm stores the path of the private key you choose, not the key.** It writes a key only when
  you upload one while choosing a key, into your `.ssh` folder.
- Lasterm looks through your `.ssh` folder to list your keys when you choose one. It reads
  `~/.ssh/known_hosts` to tell you whether your own SSH already trusts a host's key, and
  `~/.ssh/config` when you import hosts from it. It never writes to either file.

## Connections Lasterm makes

**To the hosts you add, over SSH.** Lasterm connects to each host you add, on the port you set,
directly or through the jump host you set. Over that connection it runs your terminals, copies its
agent (by SFTP), and runs a few commands to find the agent and the host's system, such as `uname`
and a checksum of the agent. It opens no port on those hosts.

**To GitHub, to download an agent.** The hub carries the agent for its own system. When a host
needs another one, a Linux host reached from Windows for example, the hub downloads it from this
repository's releases on GitHub, `https://github.com/khiops/lasterm/releases/download/v<version>/`,
with the list of checksums it checks the file against. GitHub serves the file from its own
download servers. The request names the version, system and architecture of the agent, and carries
no identifier. The hub keeps the file in its `binaries` folder and does not download that version
again. The same download happens when you ask for it in *Settings › Agents* or with
`lasterm agent fetch`. You can instead import an agent you downloaded yourself, in
*Settings › Agents*.

**No update checks.** The desktop app installed from GitHub includes an updater set to this
repository's releases, but no part of the app starts a check, so it makes no request. In the
Microsoft Store version the updater is not loaded at all: the Store updates the app.

**The installers, when WebView2 is missing.** The desktop app needs Microsoft Edge WebView2. If it
is not installed, the `setup.exe` and `.msi` installers download Microsoft's installer for it from
`go.microsoft.com` and run it.

**Lasterm makes no other connection.** On your computer, the app reaches its hub at `127.0.0.1`,
and the hub reaches its local agent through a named pipe on Windows or a Unix socket on Linux. The
hub listens on `127.0.0.1` only, so other computers cannot connect to it. Links you click in the
app, such as those in *About*, open in your web browser. The programs you run in a terminal make
their own connections; those are theirs, not Lasterm's.

## What others do on their side

- **GitHub** receives the download requests above, with your IP address, as it does for any
  download. The [GitHub General Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement)
  covers what it does with them.
- **The Microsoft Store**, if you install Lasterm from it, installs and updates the app under the
  [Microsoft Privacy Statement](https://privacy.microsoft.com/privacystatement).
- **Microsoft Edge WebView2** is the Microsoft runtime that draws the desktop app's window. What it
  does on its own is covered by the Microsoft Privacy Statement.

## Removing your data

The installers from GitHub leave the `lasterm` folders above in place when you uninstall. To remove
what Lasterm kept, quit it with *Quit completely*, then delete those folders and
`%LOCALAPPDATA%\app.lasterm.desktop`. On a remote host, delete the agent and
`~/.local/state/lasterm`.

## Children

Lasterm is a tool for developers. It is not directed at children, and it collects nothing from
anyone.

## Changes

This policy is kept in the Lasterm repository, and every change to it is a commit in its history. A
new connection made by the app is a change to this policy.

## Contact

For a question about this policy, or about what Lasterm does with anything, open an issue at
<https://github.com/khiops/lasterm/issues>. Issues are public: leave out anything private.
