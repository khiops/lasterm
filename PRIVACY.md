# Privacy policy

Effective 1 October 2026.

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
| Logs | the `logs` folder and the `.log` and `.log.old` files in the state folder |
| The agents downloaded for your remote hosts | `binaries` in the state folder |
| Components the hub unpacks from its own executable | the cache folder |

The interface keeps a few things in its own web storage: the access token, the layout of your tabs
and panes, your recent searches in terminals, your recent command palette entries, which host and
terminal groups you collapsed, the confirmations you chose to skip, the host selected in this
window, and the version of the hub it last reloaded for. In a browser, it also keeps a copy of the
interface's own files, so it opens without fetching them again. In the desktop app that storage is
in `%LOCALAPPDATA%\app.lasterm.desktop`; in a browser, it is the browser's storage for the hub's
address.

**Terminal output** is kept up to 10 MB per terminal and for up to 7 days, except the last screen
of a terminal that is still running. What a terminal printed is deleted 24 hours after it ends; the
terminal itself (its title, shell, command, working directory and how it ended) stays in your list
until you delete it. The `[gc]` section of `config.toml` changes the size and the delay.

**The logs** record events such as the hub starting, a browser signing in with the address it came
from, and a connection to a host with its name, address and user name. The agent's log also
records, for each terminal it starts, the program, its arguments and its working directory, so a
password written into a terminal's command would appear there. The logs never contain what you
type, what a terminal shows, or a password, passphrase or token you give Lasterm. Each of the hub's
logs is set aside when it reaches 10 MB, replacing the one set aside before. The agent writes one
log file per day and keeps the last 7 (`[logging] agent_files_kept` in `config.toml`); what it
prints when it starts goes to `agent-daemon.log` in the state folder, which is kept until you
delete it.

None of these files is encrypted. On Linux, the databases and the files holding keys and tokens are
readable by your user only. On Windows, they have the permissions of your user profile.

### On the hosts you add

Lasterm installs its agent on each host you connect to: `~/.local/bin/lasterm-agent` on Linux,
`%LOCALAPPDATA%\lasterm\lasterm-agent.exe` on Windows. If it finds an agent there already, in one of
those folders or in `/usr/local/bin`, `/usr/bin` or `/opt/lasterm`, it keeps it when it is the same
file as its own, and otherwise replaces it in place. A Linux host set to keep an agent running
also gets a folder, `~/.local/state/lasterm` (or `$XDG_STATE_HOME/lasterm`), holding the agent's
socket, its logs (as described above) and its records. The agent keeps what your terminals print in memory, never on
that host's disk.

### Passwords, passphrases and keys

- **An SSH password is never stored.** Lasterm asks for it when it connects.
- **A key passphrase is never written to disk.** The hub reuses it for 60 seconds, or for 15
  minutes when you tick *Remember for this session*, so that a reconnection does not ask again. It
  leaves the hub's memory the next time that host needs a passphrase, or when the hub stops.
- **A password for an elevated shell** (sudo and the like) is never written to disk. The hub reuses
  it for at most 15 minutes, and it leaves the hub's memory when the hub stops.
- **Lasterm stores the path of the private key you choose, not the key.** It writes a key only when
  you upload one while choosing a key, into your `.ssh` folder, and deletes one only when you delete
  it from the key picker.
- Lasterm looks through your `.ssh` folder to list your keys when you choose one, and creates that
  folder if it does not exist. It reads
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
download servers. The request names the version, system and architecture of the agent. If the file
is not found, the hub also asks for the agent's former file name and for the release page,
`https://github.com/khiops/lasterm/releases/tags/v<version>`. Every request carries the same user
agent, `lasterm-hub-agent-fetch`, and no identifier. The hub keeps the file in its `binaries` folder and does not download that version
again. The same download happens when you ask for it in *Settings › Agents* or with
`lasterm agent fetch`. You can instead import an agent you downloaded yourself, in
*Settings › Agents*.

**No update checks.** The desktop app has no updater and never checks for updates. The Microsoft
Store updates the version installed from it; a version installed from a GitHub release is updated
by installing a newer release over it.

**The installers, when WebView2 is missing.** The desktop app needs Microsoft Edge WebView2. If it
is not installed, the `setup.exe` installer downloads Microsoft's installer for it from
`go.microsoft.com` and runs it; the `.msi` installer is built with the same setting.

**Lasterm makes no other connection.** On your computer, the app reaches its hub at `127.0.0.1`,
and the hub reaches its local agent through a named pipe on Windows or a Unix socket on Linux. For
a host set to sign in with your SSH agent, the hub asks that agent (`SSH_AUTH_SOCK`, or the OpenSSH
agent's pipe on Windows) to sign. A second launch of the desktop app hands over to the first
through a local pipe or socket. None of these leaves your computer. The hub listens on `127.0.0.1`
only, so other computers cannot connect to it. Links you click in the
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
