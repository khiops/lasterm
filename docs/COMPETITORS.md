# Terminal and SSH clients on the Microsoft Store: competitive analysis

Date: 2026-10-31. Ratings, prices, versions and features are as of that date. Read-only research: nothing was installed, and no account was used.

Scope: terminal and SSH client apps distributed through the Microsoft Store, compared with lasterm (Store product 9P82QRJ6VDWL). A few notable apps that are not on the Store are covered briefly. This analysis updates the competitor table in [`IDEATION_BRIEF.md`](IDEATION_BRIEF.md) and, in the website repository (khiops/lasterm-website), `BRIEF.md` and the positioning sources in `docs/brief-sources/` (`positioning-statement.md`, `messaging-implications.md`).

Conventions:

- A cell or claim followed by a source tag such as `[T3]` was verified against that source on 2026-10-31. Tags resolve in [Sources](#sources).
- "(unverified)" means no source was read for that claim. It is stated only where a cell would otherwise be blank, and it is never used as evidence.
- Ratings are those the Store shows. See the method notes for what the two rating figures mean.

---

## 0. Summary

- **Traction in this Store category goes to two apps.** Windows Terminal has 51,142 ratings across all markets, and it is a local shell host. Termius has 3,008 ratings and is the only dedicated SSH client with real Store traction. Every other SSH or terminal app has fewer than 1,100 ratings, and most have fewer than 50.
- **Many well-known Windows SSH clients are not on the Store.** Tabby, MobaXterm, WindTerm, Xshell, Solar-PuTTY, Warp, Wave, Termix, SecureCRT, Bitvise and mRemoteNG are absent. The listed ones ship through winget or direct download instead. In Store search, lasterm's direct rivals are therefore Termius, PuTTY, electerm, DR-Terminal and a long tail of small apps.
- **DR-Terminal is new** (first released 2026-07-06), has no ratings yet, and has the most complete Windows-native feature set of the new entrants. That set covers a dual-pane SFTP/SCP commander, a key toolbox with YubiKey support, parameterized snippets, an MCP bridge for AI agents, and serial and telnet.
- **Session persistence is no longer unique.** Since v0.14 (2026-02-12), Wave Terminal runs a job manager on the remote host so SSH shells survive network drops and Wave restarts [Wv1]. Haven now also has an iPhone client [Hv1]. lasterm's combined claim (hub, any client, local and remote persistence, no account) still holds. Section 5 lists the earlier competitor statements that are now wrong.
- **The largest gaps for lasterm:** file transfer (#721), port forwarding and agent forwarding, snippets and broadcast input, key generation and import, and hub-side workspaces. Section 4 has the details.

---

## 1. Inventory of Store-distributed terminal and SSH apps

### 1.1 Method

The Store was searched three ways:

1. **The winget `msstore` catalog API** [M1]: `POST https://storeedgefd.dsx.mp.microsoft.com/v9.0/manifestSearch` with `{"Query":{"KeyWord":"…","MatchType":"Substring"}}`.
   - It works, but it matches mostly on the package name and returns very few rows. For example, `ssh` returns only Termius, `terminal` returns four apps, and `telnet` returns nothing.
   - It found DR-Terminal (9N1NR8M5TMX2), electerm, nxshell, Royal TS, PuTTY and lasterm when searched by name. It found nothing for Tabby, MobaXterm, WindTerm, Warp, Wave, Termix or Solar-PuTTY.
2. **The Store's own search API** [M2]: `GET https://storeedgefd.dsx.mp.microsoft.com/v9.0/search?query=…&market=US&locale=en-US&deviceFamily=windows.desktop`, paged through `NextUri`, up to 100 results per keyword.
   - Keywords tried: ssh, terminal, sftp, telnet, serial, "ssh client", "terminal emulator", "ssh terminal", "serial terminal", mosh, "ssh tunnel", "port forwarding", "ai terminal", "telnet client", "connection manager" and others.
   - About 40 product names were also searched individually: Tabby, MobaXterm, WindTerm, Xshell, Solar-PuTTY, Warp, "Wave terminal", Termix, Hyper, WezTerm, Alacritty, SecureCRT, Bitvise, mRemoteNG, Tera Term, ZOC, FinalShell, Nexterm and others.
3. **Product details:**
   - The Store product API [M3] (`/v9.0/products/<ID>`) gave the description, features, release notes, architectures, first release date and catalog update date.
   - The display catalog [M4] (`displaycatalog.mp.microsoft.com/v7.0/products?bigIds=…`) gave rating aggregates.

Cross-check against the web pages [M5]:

- `apps.microsoft.com/search?query=ssh` is rendered client-side. A plain HTTP fetch, curl included, gets only the page shell with no results.
- The detail pages (`apps.microsoft.com/detail/<ID>`) return server-rendered titles that match the API's titles for Termius, DR-Terminal, electerm, PuTTY, Royal TS, Intelligent Terminal and Lasterm.
- The Termius detail page embeds `ratingValue 4.4` and `ratingCount 560`, the same figures the product API gives for market=US.

Caveats:

- **Ratings are per market.** The Store web page and the product API show one market's ratings (US here). The display catalog's `AllTime` and `30Days` aggregates are identical whichever market is queried, so they are taken here as all-market totals.
  - Termius shows 560 on the US page and 3,008 in the all-market total.
  - Win32 listings (IDs starting with `XP`) have no display-catalog entry. For those, the US figure is given, and for PuTTY a sum over 16 markets.
- **The "last update" date is the catalog revision date** (`LastUpdateDateUtc`), not necessarily a new package. Many apps show dates in a 2026-05-26 to 2026-05-31 batch, which looks like a catalog refresh. Upstream release dates are given where they were checked.
- **Win32 listings** (`XP…`) install the publisher's own installer. Their catalog dates can be years old while the app itself is current (for example, PuTTY shows 2022-03-15 while its site has 0.85 from 2026-08-16 [P4]).

### 1.2 Main list, ranked by apparent traction

Ranking order: all-market Store ratings, then US-page ratings for Win32 listings, then other signals.

| # | App | Store ID | Publisher | Price model | US page rating (count) | All markets: rating / count (last 30 days) | Platforms | First release / catalog update | Positioning |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Windows Terminal | 9N0DX20HK701 | Microsoft | Free, open source [W1] | 4.2 (9,476) | 4.5 / 51,142 (40) | x64, x86, ARM64; Windows only | 2019-06-21 / 2026-10-02; GitHub v1.25.2733.0 on 2026-10-02 | Tabbed, split-pane host for local shells (cmd, PowerShell, WSL) [W1]. SSH only by running OpenSSH in a profile [W6]. |
| 2 | Termius - Modern SSH Client | 9NK1GDVPX09V | Termius Corporation | Freemium. Starter free; Pro $10/mo; Team $20/seat/mo; Business $30/seat/mo, all billed annually [T1]. Store: free with in-app purchases [S1] | 4.4 (560) | 4.6 / 3,008 (20) | x86, x64; also macOS, Linux, iOS, Android [T3] | 2018-07-10 / 2026-10-30; changelog 10.3.0 [T12] | Cross-platform SSH client with an end-to-end encrypted cloud vault, team vaults and AI autocomplete. The Store's leading dedicated SSH client. |
| 3 | 1Remote | 9PNMNF92JNFP | Shawn Veck | Free, GPL-3.0 [R2] | 4.8 (50) | 4.9 / 1,086 (12) | x86, x64, ARM, ARM64; Windows | 2020-12-01 / 2026-03-19; GitHub 1.3.1 on 2026-10-16 [R2] | Remote session launcher, RDP first, that also does SSH, VNC, Telnet and (S)FTP [R2]. |
| 4 | PuTTY | XPFNZKSKLBP7RJ | Simon Tatham, official per the PuTTY FAQ [P2] | Free [P1] | 4.6 (138) | Win32 listing, so no all-market figure. Sum over 16 markets: 177 | x64, ARM64, x86, ARM; Windows | Catalog date 2022-03-15; upstream 0.85 on 2026-08-16 [P4] | Classic single-session SSH, telnet and serial client with Pageant, PuTTYgen and PSCP/PSFTP [P1]. |
| 5 | electerm | 9NCN7272GTFF | ZHAO Xudong | Free, MIT [E1] | none | 4.7 / 48 (0) | x64; also macOS, Linux, Android, iOS, HarmonyOS [E1] | 2021-06-16 / 2026-10-30; v5.8.0 on 2026-10-30; 15.5k GitHub stars | Open-source all-in-one terminal and file manager: SSH, SFTP, FTP, telnet, serial, RDP and VNC. Data sync through gist, WebDAV or a server; AI assistant; MCP [E1]. |
| 6 | Intelligent Terminal | 9NMQC2SSJX24 | Microsoft | Free | 3.8 (5) | 4.1 / 20 (3) | x64, x86, ARM64 | 2026-06-02 / 2026-09-14 | Experimental Windows Terminal fork with an AI agent in a dedicated pane that sees shell context [W8]. |
| 7 | Devolutions Remote Desktop Manager | XPFCXHF337W98S | Devolutions | Free edition; Team edition paid (price unverified) | 4.9 (19) | Win32 listing | x64 | Catalog date 2022-09-18 | Enterprise multi-protocol connection manager with password management, RBAC and audit [S7]. |
| 8 | Tempest 3 - SSH, RDP & FTP | 9PFV6RP97JB2 | Altas Express LLC | Free tier plus Pro (Pro price unverified) [G2] | none | 3.9 / 13 (0) | x64, ARM64; also macOS, Linux, Android, iOS, web [G2] | 2024-02-16 / 2026-10-31 | Cross-platform SSH, Mosh and Kubernetes client with E2E-encrypted sync, an AI agent and live session sharing [G1][G2]. |
| 9 | XPipe | XP9KK2PJ9JDQ6G | XPipe UG | Community free; Homelab $5/mo; Professional $10/mo [X2] | 4.0 (5) | Win32 listing | x64, ARM64 | Catalog date 2023-09-17; GitHub 24.10 on 2026-10-29; 14.6k stars | Connection hub and remote file manager that opens sessions in your own terminal emulator [X1]. |
| 10 | Royal TS | XP99WVBK3KNN3S | Royal Apps GmbH | Lite free (10 connections, 10 credentials, 1 document); Single User €49, no subscription [Y2] | 5.0 (5) | Win32 listing | x64, ARM64; also macOS (Royal TSX), iOS, Android [Y2] | Catalog date 2023-09-21 | Multi-protocol connection manager for IT teams, with credential objects and shared documents [Y1][Y2]. |
| 11 | DR-Terminal | 9N1NR8M5TMX2 | DR-Online | Free download. 7-day full trial without an account, then the core SSH/SFTP features stay usable with license reminders; license price not shown in the Store [D1]. iOS PRO: $1.99/week to $24.99 lifetime [D2] | none | 0 / 0 | ARM64, x64; also iOS/iPadOS [D2]; Android listing seen in search (unverified) | 2026-07-06 / 2026-10-12 | Windows-native all-in-one: SSH, SFTP/SCP, telnet, serial and local shells, a dual-pane commander, key tools with YubiKey, snippets, and MCP for AI agents [D1]. |
| 12 | Xcasca (NetSarang, replaces PortX) | 9P38GFZ2W07N | NetSarang | Free plan plus Plus plan with sync, offered as a trial [S2] | none | 5.0 / 3 (0) | x64; "desktop and mobile" [S2] | 2025-10-14 / 2026-10-29 | Lightweight cross-platform SSH and SFTP client with sync. Recent notes add ZModem and free port forwarding [S2]. |
| — | *Lasterm (reference)* | 9P82QRJ6VDWL | O2CS&I | Free | none | 0 / 0 | **x64 only** | 2026-10-28 / 2026-10-31 | Hub, remote agents and PWA/desktop UI, with persistent sessions and no account [L1]. |

Search visibility in the US market on 2026-10-31 [M2]:

| Query | Top hits | lasterm | DR-Terminal |
|---|---|---|---|
| `ssh` | 1 Termius, 2 PuTTY, 3 1Remote, 4 Devolutions RDM | not in top 100 | not in top 100 |
| `terminal` | 1 Windows Terminal, 4 Termius | not in top 100 | not in top 100 |
| `ssh client` | 1 PuTTY, 2 Termius | not in top 100 | not in top 100 |
| `sftp` | 1 Termius, 2 PuTTY | not in top 100 | not in top 100 |

Both lasterm and DR-Terminal are found only by name. VPN apps fill most of the top 100 for `ssh`.

### 1.3 Also on the Store: small, niche, stale or abandoned apps

Figures are all-market rating / count unless marked "US".

**Microsoft and file transfer:**

- **Windows Terminal Preview**, 9N8G5RFZ9XK3: 4.8 / 1,891.
- **WinSCP**, 9P0PQ8B65N8X, $19.99 on the Store: 4.9 / 592.
  - It is a file-transfer client, not a terminal.
  - It is the reference for dual-pane transfer UX.

**Stale or abandoned:**

- **Fluent Terminal**, 9P2KRLMFXF9T: 4.4 / 453.
  - Last GitHub release 0.7.7.0 on 2022-03-13, so it is stale.
  - UWP terminal for PowerShell, CMD and WSL with built-in SSH and Mosh [S3].
- **nxshell**, 9N0NP4JJ192W: 4.3 / 114.
  - Last release v1.9.3 on 2023-03-22 and last push 2023-12, so it is abandoned.
- **PortX** (NetSarang), 9PC9D7XXZM5S: 4.3 / 40.
  - Its own listing says it "will be deprecated soon" and points to Xcasca [S2].
- **Janaikore Telnet Terminal**, 9WZDNCRDN3DT: 3.7 / 66. First released 2013.
- **Remote Terminal 2**, 9NBLGGH52TCD: 4.1 / 9. Repository last pushed in 2016.

**Small or new terminal and SSH clients:**

- **Shell Assistant**, 9NR2G5QKF1BK: 4.3 / 27.
  - Offers "Workspaces": separate saved layouts that reload at the next start.
  - Drag and drop or copy and paste of files between hosts over SFTP; generates rsync, sftp and cp command lines [S4].
- **quardCRT**, 9P6102K9QB3T: 5.0 / 11.
  - Open source; x/y/zmodem; one-click SFTP window from an SSH2 session [S5].
- **SFTP Explorer**, 9N6S8V9QQ224: 3.6 / 14. A Windows 11 SFTP client with an integrated terminal.
- **SSH Tunnel**, 9NR7P38PKLT4: 2.8 / 19.
- **SSH Client - SFTP Terminal and Telnet** (Moon Technolabs), 9PKGBV7S35T0: 2.8 / 18. Its description talks about iOS and Mac.
- **AbsoluteTelnet SSH Client**, 9N77H85H11VS: 3.6 / 13.
  - 30-day trial, purchased on the publisher's website.
  - X/Y/ZMODEM in all connection types [S6].
- **iLead - SSH Manager**, 9NQDL0439Z4S: 0 ratings, released 2026-09-10.
  - Local AES-encrypted vault with a master password and "no cloud account".
  - Tag-based smart groups, visual multi-hop bastion chaining, multi-exec on many servers, snippets with placeholders [S8].
- **WinSSHTerm MSIX**, 9P47TJ9QJL5P: 5.0 / 2. Tabbed wrapper around PuTTY, WinSCP and VcXsrv.
- **tinyTerm**, 9NXGN9LJTL05: 3.4 / 5. Drag and drop transfers over SCP [S9].
- **terminalpp**, 9NNH6JQFJ7HD: 4.1 / 9.
- **SSH++**, 9MXP8J9TVJ7J: 3.8 / 8.

**Paid apps with no ratings:**

- **TerminalX**, 9PJC2H3PXNFR: $3.49.
- **VxTerm English**, 9N68P7ZQ6SDZ: $27.99.
- **NexTerm**, 9MV73700RGWZ, publisher 수카버스: $0.99, released 2026-10-01.
  - A "workspace-based terminal multiplexer for AI coding agents".
  - Not the self-hosted Nexterm web project.

**Adjacent tools (not terminals):**

- **HelloUKey - SSH Agent & Key Vault**, 9N0WBPRDGF78: 3.7 / 6. A TPM and Windows Hello SSH agent [S10].
- **Serial tools:**
  - Serial Debug Assistant, 9NBLGGH43HDM: 4.6 / 2,037.
  - SST Simple Serial Terminal, 9P6M6GJSF3HN.
  - Multi Comm Terminal, 9MW99375981Z.
  - CRMT, 9NF2H969R452.
- **Remote desktop launchers:** many, not listed here.

### 1.4 Checked and not on the Store

The following returned no Store listing from either API [M1][M2] when searched by name:

- **Tabby**: winget `Eugeny.Tabby` [Tb6].
- **MobaXterm**: winget `Mobatek.MobaXterm` [Mb3].
- **Warp**: winget `Warp.Warp` [Wp2].
- **Wave Terminal**.
- **WindTerm**.
- **Xshell**: NetSarang's Store app is Xcasca.
- **Solar-PuTTY**.
- **Termix**: EXE, MSI, portable and Chocolatey [Tx1].
- **SecureCRT**, **Bitvise**, **mRemoteNG**, **WezTerm**, **Alacritty**, **Hyper**, **Tera Term**, **ZOC**, **FinalShell**.

---

## 2. Feature matrix

Rows follow the brief. Section 3 expands the file-transfer row.

### 2.1 Termius, Windows Terminal, PuTTY, electerm, DR-Terminal

| Feature | Termius | Windows Terminal | PuTTY | electerm | DR-Terminal |
|---|---|---|---|---|---|
| SSH / telnet / serial | SSH, Mosh, Telnet, Serial [T8]. Serial can show a blank screen in the Store build [T14] | SSH by running OpenSSH `ssh` in a profile [W9]. Profiles can be generated for OpenSSH config hosts (profile source `Windows.Terminal.SSH`) [W6]. Telnet and serial: none built in (unverified) | SSH, Telnet, Rlogin, SUPDUP, serial [P1] | SSH, SFTP, FTP, telnet, serial, RDP, VNC, Spice [E1] | SSH, Telnet, serial (UART), SFTP and SCP [D1] |
| Local shells (WSL, PowerShell) | Local terminal with a configurable shell path [T8]. Autocomplete is not available in PowerShell or CMD [T11] | cmd, PowerShell, WSL [W1] | none (unverified) | Local terminal [E1] | cmd, Windows PowerShell, PowerShell 7, WSL [D1] |
| Session persistence across app restarts | No live process survives (unverified). Workspace templates reopen the connections and restore the working directory and running application [T10][T12 9.32.2] | Restores layout and screen contents on startup (1.21+) [W3]. Process restoration is not documented | none (unverified) | Workspaces reopen a saved layout and bookmark tabs [E4]. Live processes are not kept (unverified) | Keep-alive in the background; restart a session in place [D1]. Nothing documented across app restarts |
| Session persistence across devices | Vault data follows the account; sessions do not (unverified) | none (unverified) | none (unverified) | none (unverified) | none listed [D1] |
| Multi-device sync, and how | Termius cloud, E2E-encrypted vault, Pro and above [T1][T6]. Credential sync can be turned off [T5] | none (unverified) | none. Sessions are stored in the registry [P2] | GitHub or Gitee secret gist, WebDAV, custom server, or "electerm cloud" [E1] | No sync. Encrypted backup and restore of connections, keys and settings [D1] |
| Account required | No for local use: "log out and use Termius locally" [T4]. Yes for sync, and new installs start with sign-in or a trial [T4] | No (unverified) | No (unverified) | No (unverified) | No: "no account or payment details are required" for the trial [D1] |
| Where secrets live, encryption | Keychain of passwords, keys, certificates and identities [T7]. Vault encrypted with a personal key wrapped by the encryption password (Argon2id, SRP) [T6] | None of its own; OpenSSH files (unverified) | Keys in PuTTYgen files and Pageant [P1]. Saved sessions in the registry [P2] | Electron safeStorage, which is DPAPI on Windows [E10] | Windows secure storage, AES-256-GCM, "no credentials stored in plaintext" [D1] |
| Agent forwarding; ssh-agent / Windows OpenSSH agent | Agent forwarding through Termius' built-in agent, "not the OS agent" [T8]. Free since 10.1.0 [T12] | Through Windows OpenSSH (unverified) | Pageant. `--openssh-config` lets Windows `ssh.exe` use it (0.77) [P3] | Uses `SSH_AUTH_SOCK` or a custom agent path per bookmark [E5]. Agent-forwarding tests in the repo [E12] | Not listed (unverified) |
| FIDO / hardware keys | FIDO2 keys generated in-app and synced; biometric keys; SSH ID passkeys [T7]. FIDO2 on the free plan since 9.19.0 [T12] | Through OpenSSH (unverified) | Not in the changelog (unverified) | Not listed (unverified) | FIDO2 / YubiKey (Ed25519-SK, ECDSA-SK); keys generated on the YubiKey [D1] |
| Key generation / import | Ed25519, ECDSA, RSA and ML-DSA generation; import by file or paste; certificates; export to a server [T7] | none (unverified) | PuTTYgen [P1]; OpenSSH certificates (0.78) [P3] | Certificates, OTP [E1]. Generation unverified | Generation, import and export; a converter for OpenSSH, PEM, PPK, PKCS#1, PKCS#8 and DER; a password-to-key migration wizard [D1] |
| Host organisation | Nested groups with inherited settings, plus tags [T15] | Profiles in a dropdown menu [W5] | Flat saved-session list (unverified) | Bookmarks (groups unverified) [E1] | Connection groups; LAN discovery over mDNS [D1] |
| "Workspaces" (what the term means) | A task-oriented set of sessions with Focus and Split views, broadcast, and templates that restore connections, working directories and running apps [T2][T10] | None yet. 1.26 lays "groundwork for per-window settings" for "each Window or Workspace" [W5] | none | A saved layout (single, two columns, 2x2) plus the bookmark tabs in it. Loading one closes the open tabs [E4] | Not offered [D1] |
| Snippets / macros | Snippets run on several hosts, startup snippets, AI-generated snippets [T9]. "Snippets automation" on Pro [T1] | Snippets pane of `sendInput` actions, plus the suggestions UI (1.22) [W4] | none (unverified) | Quick commands and triggers [E1] | Parameterized snippets with typed fields, a 120+ DevOps catalog, and variants chosen by OS [D1] |
| Port forwarding / tunnels | Local, remote and dynamic; on the free Starter plan [T1][T16] | none built in (unverified) | Unverified in the pages read | SSH tunnels [E1] | Not listed (unverified) |
| Jump hosts | Multi-hop host chains; SOCKS5 and HTTP proxy [T8]. Free since 10.1.0 [T12] | Through `~/.ssh/config` (unverified) | SSH proxy (0.77); command or subsystem proxy modes (0.78) [P3] | "Connection hopping" [E1] | ProxyJump, "multi-hop connections" [D1] |
| SFTP / file transfer (section 3) | Dual-pane SFTP tab [T3] | None. A dropped file inserts its path [W5] | PSCP and PSFTP on the command line [P1][P3] | Terminal and SFTP panes in each tab, with an optional cwd-following SFTP view. Dropping on the terminal offers trzsz or zmodem [E6][E9] | Dual-pane "Commander" over SFTP or SCP [D1] |
| Split panes and tabs | Tabs and split view [S1] | Tabs and split panes [W1] | none (unverified) | Tabs; layouts up to 2x2 [E4] | Tabs and detachable windows. Split not listed [D1] |
| Broadcast input | Yes, in workspaces. On the free plan since 9.17.1 [T10][T12] | Broadcast to all panes in a tab (1.19) [W2] | none (unverified) | "Quick input/mirror input to one or all terminals" [E1] | Not listed (unverified) |
| Themes | Per-connection themes and fonts [S1] | Custom themes [W1] | none (unverified) | Themes and background image [E1] | 435 color themes; per-connection theme and font size [D1] |
| AI features | AI autocomplete on the free plan [T1]; text to command (9.9.0) [T12]; AI snippet generation [T9] | Terminal Chat with GitHub Copilot, Canary builds only [W7]. Intelligent Terminal is a separate Store app [W8] | none | AI assistant with an agent mode, and an MCP widget [E1] | MCP mode (Trial and Pro): Claude Code, Codex, Antigravity and Copilot CLI drive the live session, and sensitive actions need approval [D1] |
| Team sharing | Team vaults, real-time collaboration and shared session logs (Team, $20/seat/mo) [T1] | none | none | none (unverified) | none listed [D1] |
| Mobile apps | iOS, Android [T3] | none | none | Android, iOS, HarmonyOS [E1] | iOS/iPadOS [D2]; Android (unverified) |
| Price | Starter free; Pro $10/mo; Team $20/seat/mo; Business $30/seat/mo, all billed annually [T1] | Free [W1] | Free [P1] | Free, MIT [E11] | 7-day trial, then reminders until a license is bought [D1] |

### 2.2 1Remote, XPipe, Royal TS, Tempest 3, and lasterm today

| Feature | 1Remote | XPipe | Royal TS | Tempest 3 | lasterm (today) |
|---|---|---|---|---|---|
| SSH / telnet / serial | RDP, SSH, VNC, Telnet, (S)FTP, RemoteApp [R2] | SSH, Kubernetes, Docker, Podman, LXD, Proxmox, Hyper-V, VMware, PowerShell Remoting, plus VNC and RDP launchers [X1] | RDP, VNC, SSH, Telnet, web, file transfer; Rebex- and PuTTY-based terminals [Y1][Y2] | SSH, Mosh, SFTP, Kubernetes, RDP, S3, FTP, serial [G1][G2] | SSH only [L1] |
| Local shells | none (unverified) | WSL, Cygwin and MSYS2 instances, opened in your own terminal [X1] | PowerShell connection type [Y2] | Local terminal [G2] | bash and zsh on Linux; PowerShell, cmd and wsl.exe on Windows, through launch profiles [L1][L2 §10.3] |
| Persistence across app restarts | none documented [R3] | none (unverified) | none (unverified) | Auto-recovery after Wi-Fi drops, sleep or VPN loss [G2]; "background connection persistence" on Pro [G1] | Yes. Local terminals survive UI and hub restarts. Remote ones survive a dropped link and a hub restart where the host keeps an agent [L1] |
| Persistence across devices | none | none | none | Sessions open on any device; live share by link [G2] | Desktop and browsers on the same machine attach to the same terminal under a write lock. Another device needs pairing, not delivered yet (#193) [L1] |
| Multi-device sync, and how | Shared MySQL database [R1][R3] | Vault git sync, on the free plan [X2] | Shared document on a network share or cloud storage [Y2] | Vendor cloud, end-to-end encrypted [G2] | None needed: the hub holds all state; no cloud [L1] |
| Account required | none (unverified) | No. An email address only, for a license [X2] | none (unverified) | Yes for sync ("1 Account, 7 platforms") [G2] | No [L1] |
| Where secrets live, encryption | unverified | "Exclusively on your computer"; secrets encrypted [X1] | Credential objects with inheritance; encrypted documents; KeePass and LastPass integrations; dynamic credentials [Y2] | E2E encrypted; 1Password integration [G1][G2] | Passwords are asked for and never stored. Key passphrases are asked for. Keys stay in `~/.ssh`, with a key browser to list, upload and delete [L2 §4.5][L3] |
| Agent forwarding; ssh-agent / Windows OpenSSH agent | unverified | unverified | unverified | "Tempest-managed keys or a system or 1Password agent" [G2] | Authenticates through the local agent, including the Windows OpenSSH agent pipe [L2 §4.5]. No agent forwarding (not in the code) |
| FIDO / hardware keys | unverified | unverified | unverified | FIDO2 / YubiKey [G1][G2] | Only through the agent (unverified) |
| Key generation / import | unverified | unverified | unverified | unverified | Key upload into `~/.ssh` [L3]. No generation |
| Host organisation | Tags with include and exclude filters, icons, colors [R2][R3] | Hierarchical categories [X1] | Folders with credential inheritance; dynamic folders from scripts [Y2] | unverified | Host groups, channel groups per host, a host rail with colors and icons [L1][L2] |
| "Workspaces" (what the term means) | none | The Community plan includes "one workspace" [X2]; meaning unverified | The dockable UI layout ("customizable workspace") [Y2] | No feature by that name [G2] | Tabs and splits kept in the browser's localStorage; "the hub keeps no layout" [L2 §3.4] |
| Snippets / macros | Auto-command after an SSH connect [R1]; pre- and post-connection scripts in cmd, PowerShell or Python [R3] | Reusable scripts, templates and groups, put on the remote PATH [X1] | Command Tasks; Key Sequence Tasks sent to one or more connections [Y2] | Saved commands and Markdown notes [G2] | none |
| Port forwarding / tunnels | "SSH Tunnel" page in the docs navigation; content unverified [R3] | SSH tunnels [X1]; one active tunnel on the free plan [X2] | Secure Gateway (SSH tunnels) through Royal Server [Y2] | Local and remote tunnels [G1] | none user-facing |
| Jump hosts | unverified | unverified | Through Secure Gateway [Y2] | "Recursive bastion hops, GUI-driven" [G2] | One ProxyJump hop; chains refused [L2 §4.5b] |
| SFTP / file transfer | "Windows explorer style" SFTP and FTP [R1]; the runner can be swapped for another tool [R2] | Own file browser over shell sessions (section 3) [X3] | File Transfer connection type for FTP, SFTP and SCP [Y2] | SFTP side panel [G2] | None (#721 open). SFTP is used only to deploy the agent [L4] |
| Split panes and tabs | Tabs that drag out into windows [R2] | File browser tabs; terminals open in your own emulator [X1][X3] | Connection tabs and dock panels [Y2] | Grid, plus sessions pulled out into floating windows [G2] | Tabs and split panes with keyboard chords [L2 §3.4] |
| Broadcast input | unverified | unverified | Key sequences sent to multiple connections [Y2] | "Open sessions on a dozen hosts in parallel"; broadcast not named [G2] | none (one writer per terminal, by design) |
| Themes | Changeable terminal theme [R1] | unverified | Light and dark themes [Y1] | unverified | Per-host and per-channel themes, wallpapers, Mica and Acrylic [L1] |
| AI features | none (unverified) | unverified | unverified | Storm AI agent; bring your own provider [G1][G2] | none |
| Team sharing | Shared MySQL with read-only permissions [R3] | "Team vaults" in the feature matrix; plan unclear [X2] | Share a document without sharing credentials [Y2] | Live session share by link [G2] | none |
| Mobile apps | none (unverified) | none (unverified) | Royal TSi (iOS), Royal TSD (Android) [Y2] | Android, iOS [G2] | PWA from the hub; another device needs pairing (#193) [L1] |
| Price | Free, GPL-3.0 [R2] | Community free; Homelab $5/mo ($40/yr); Professional $10/mo ($80/yr) [X2] | Lite free (10 connections); Single User €49 [Y2] | Free tier; Pro price unverified [G2] | Free, AGPL-3.0 [L1] |

### 2.3 Notable apps not on the Store (one line each)

- **Tabby** (75k GitHub stars, v1.0.238 on 2026-10-07):
  - SSH, Telnet and serial; split panes; X11 and port forwarding; automatic jump-host management.
  - Agent forwarding, "incl. Pageant and Windows native OpenSSH Agent"; an encrypted container for secrets.
  - A web app, also self-hostable (`tabby-web`) [Tb1].
  - Zmodem built in; an SFTP panel that opens in the shell's cwd via OSC 1337 [Tb2].
  - Free.
- **MobaXterm**:
  - SSH sidebar browser (SFTP or SCP) with "Follow SSH path (experimental)".
  - MultiExec broadcast, a tunneling UI, an SSH gateway (jump host), a master password for stored passwords [Mb1].
  - Home edition free (12 sessions, 2 tunnels, 4 macros); Professional $69 or €49 per user [Mb2].
- **Warp**:
  - AI-centred terminal.
  - Plans: Free, Build $20/mo, Max $200/mo, Business $50/user/mo [Wp1]. Installed through winget or an installer [Wp2].
  - SSH and file transfer are not covered by the pages read.
- **Wave Terminal** (22.6k stars, Apache-2.0, v0.14.5 on 2026-04-16):
  - **Durable Sessions** for SSH (v0.14): a lightweight job manager on the remote host keeps the shell running, buffers output, and reattaches after network drops and Wave restarts. No remote ports.
  - It is off by default and SSH-only; local and WSL terminals are not durable [Wv1][Wv3].
  - Drag and drop of files and directories between directory views across machines; `wsh file cp` [Wv3].
- **Haven**:
  - macOS app plus an iPhone app.
  - An open-source per-host daemon keeps remote PTY sessions alive across disconnects, and the phone sees the same live stream, end-to-end encrypted from remote hosts. Local shells end when Haven quits.
  - SFTP browser that opens in the session's working directory. Free download [Hv1].
- **Nexterm** (MIT, about 5.1k stars):
  - Self-hosted web app for SSH, VNC and RDP, with SFTP file management, Docker and Proxmox.
  - 2FA and OIDC; encrypted passwords and keys. Session persistence across tab close is not stated [Nx1].
- **Termix** (Apache-2.0):
  - Self-hosted, with web, Windows (EXE, MSI, Chocolatey), Linux, macOS, iOS and Android clients.
  - Plugins: SSH terminal with split screen and macros, tunnels that reconnect, an SFTP manager with server-to-server transfers, **Workspaces** (saved tabs and split layouts), snippets across hosts, session recording.
  - Can pull secrets from 1Password [Tx1].

---

## 3. File transfer UX in detail

This section is the input for #721 ("Send files to a host by dropping them on its terminal").

### 3.1 Per app

**Termius** [T3][T13]

- **Where:**
  - A separate `SFTP` tab with two panes. The local file system opens in one pane by default, and the user picks a host in the other.
  - "Desktop supports two active SFTP panes at a time."
  - One click switches between the terminal and the SFTP session of the same host.
- **Sending a local file:**
  - Drag it from the OS file manager onto the target pane, or drag it between panes.
  - Or right-click and choose "Copy to target directory", after opening the destination in the other pane.
- **Destination:**
  - The folder open in the target pane. The path bar is editable.
  - There is no default SFTP path setting. The documented workaround is server-side (`Subsystem sftp … -d "/home/"`) [T13].
  - Nothing documented links the SFTP pane to the terminal's cwd, even though shell integration detects the cwd for autocomplete [T11].
- **Progress, cancel, conflicts:**
  - Not documented for desktop.
  - On mobile, a Transfers sheet shows progress, errors and conflict resolution ("replace or keep both").
- **Other:**
  - **Multiple files and folders:** "file or folder" in the context menu; multi-select is not documented.
  - **Remote-to-remote:** two panes can hold two hosts.
  - **Edit:** a remote file opens from a temporary copy, and Termius "detects the changes and prompts you to upload".
  - **zmodem / trzsz:** not mentioned.
  - **Sandboxing:** sandboxed Mac App Store and Snap builds have limited file access. The Windows Store build is not mentioned.

**electerm** [E2][E3][E6][E7][E8][E9]

- **Where:**
  - Each SSH tab has a terminal pane and a file-manager pane. They can be shown side by side (`sshSftpSplitView`) or switched [E9].
- **Dropping files on the terminal** (`term-file-drop.js`) [E6]:
  - On an SSH tab, a modal (setting `dragDropBehavior`, default "ask") offers three actions:
    - upload with **trzsz**, which types `trz`;
    - upload with **zmodem**, which types `rz`;
    - "input only", which types the quoted paths.
  - On a serial tab, the modal also offers XMODEM.
  - Unsafe file names are refused.
  - The destination is the shell's cwd, since `rz` and `trz` receive into the current directory.
- **Dropping in the SFTP list:**
  - Uploads to the folder the pane shows (an `onDrop` handler in the SFTP list component).
- **Following the cwd:**
  - "SFTP follow terminal path" reads `OSC 633 ; P ; Cwd=` from shell integration [E2].
  - It is marked experimental and can disturb the terminal. It supports bash, zsh, sh and ash, but not fish or Windows shells [E3].
- **Progress:** a transfer list with source, target, speed and percent, plus pause, resume and cancel [E8].
- **Conflicts:** a modal with skip, overwrite (files) or merge (folders), rename, an "all" variant of each, and cancel [E7].
- **Edit:** double-click a small remote file to edit it in place [E1].

**DR-Terminal** [D1][D2]

- **Where:**
  - "Commander" file-manager tabs, separate from terminals: a dual-pane, Norton-style view of SFTP, SCP and local drives.
  - Several commander tabs can sit alongside terminal sessions.
- **Sending:** drag and drop, select by mask (gray +/-), glob filters.
- **Destination:** the pane's folder. There is a default directory per connection, plus directory bookmarks.
- **Progress, conflicts:** "Overwrite confirmation and clear transfer progress."
- **Remote-to-remote:** direct copy or move between two servers.
- **Transport:**
  - SFTP or SCP. "Auto" picks SCP for hosts without SFTP (OpenWrt, Dropbear, BusyBox). Either can be pinned per connection.
- **Extras:**
  - ZIP, TAR and ISO archives browse in place over SFTP without a full download.
  - F3 viewer for text, hex, images, PDF and ELF/PE headers.
  - iOS share sheet sends a file to a server [D2].
  - The MCP tools include SFTP transfers [D1].
- **Drop on the terminal:** not described.

**Tabby** (not on the Store) [Tb2][Tb3][Tb4][Tb5]

- **Where:** an SFTP panel opened from the SSH tab ("Open SFTP panel" hotkey or tab menu). It has a breadcrumb path, "Upload files" and "Upload folder" buttons, and a body that accepts drops.
- **Destination:**
  - The panel's current path. It opens in the shell's cwd when the remote shell reports it with `OSC 1337;CurrentDir=` (a line added to the remote profile).
  - Without that, the panel shows a tip linking to the cwd-detection docs.
- **Drop on the terminal:** inserts the quoted local path, with bracketed paste. It does not upload [Tb3].
- **Progress:** a "File transfers" menu with a progress bar, size, speed and cancel [Tb5].
- **Conflicts:** no handling found in the panel code (unverified).
- **Download:** to a save dialog; folders download recursively [Tb4].
- **zmodem / trzsz:** zmodem built in [Tb1]; trzsz through the `tabby-trzsz` plugin [Tz1].

**MobaXterm** (not on the Store) [Mb1]

- **Where:** a graphical SSH browser in the left sidebar opens automatically at SSH login. It does not open for keyboard-interactive authentication.
- **Sending and receiving:** drag and drop to and from Windows.
- **Destination:** the browser folder. "Follow SSH path (experimental)" keeps it in the terminal's directory, though not on old Unix systems.
- **Transport:** SFTP, "SCP (enhanced speed)" or "SCP (normal speed)".
- **Edit:** double-click to edit; changes save back automatically.

**Wave Terminal** (not on the Store) [Wv2][Wv3]

- Directory views per connection, with drag and drop of files and directories between views "across machines".
- `wsh file cp` between `wsh://` URIs.
- A file dropped on a terminal block pastes its quoted path.
- Remote file views need the optional `wsh` helper on the host.

**XPipe** [X3]

- **Where:** its own file-browser tabs, working over plain shell sessions.
- **Local to remote:** copy in the OS, then Ctrl+V into the remote folder. Dragging from Explorer is not described.
- **Remote to remote:** drag from tab to tab. Data goes "directly from source to target" without local staging.
- **Remote to local:** drag into a download pane, then out to the desktop.
- **Progress:** in the status bar, with cancel. A cancelled transfer leaves a partial file. Conflicts are not documented.
- **Edit:** opens remote files in a local editor, with automatic upload and an offer to elevate with sudo.

**Other apps:**

- **Windows Terminal:** no transfer. A dropped file inserts its path. 1.26 made the delimiter between several dropped paths configurable (`dragDropDelimiter`) [W5].
- **PuTTY:** PSCP and PSFTP on the command line only [P1][P3]. The WinSSHTerm Store wrapper uses WinSCP for "Copy Files" [S11].
- **1Remote:** an "explorer style" SFTP and FTP view [R1], whose runner can be replaced by an external tool [R2].
- **Royal TS:** a File Transfer connection type for FTP, SFTP and SCP [Y2]. UI details unverified.
- **Tempest 3:** "Browse, edit and transfer files from a side panel" [G2]. Drag and drop is not described.
- **Haven:** an SFTP browser and editor that opens in the session's working directory [Hv1].
- **Shell Assistant:** drag and drop or copy and paste between hosts over SFTP; generates rsync, sftp and cp command lines [S4].
- **tinyTerm:** drag and drop transfers files over SCP [S9].
- **Terminals with zmodem:**
  - Xcasca: ZModem, remote edit, path bookmarks [S2].
  - quardCRT: x/y/zmodem, plus a one-click SFTP window [S5].
  - AbsoluteTelnet: X/Y/ZMODEM on every connection type [S6].

**trzsz** (a tool used by several terminals) [Tz1]

- `trz` and `tsz` run on the server and work through tmux.
- Features: drag files and directories onto the terminal to upload; a progress bar with speed and ETA; resume with `-y`; directories with `-d`.
- Supported by:
  - trzsz-ssh (`tssh`);
  - iTerm2;
  - Tabby, through a plugin;
  - electerm ≥ 1.19;
  - ttyd;
  - trzsz-go, for any terminal with a local shell;
  - **trzsz.js**, "making webshell in browser and electron terminal supports trzsz".

### 3.2 Patterns

1. **A separate dual-pane transfer view.**
   - Used by Termius, DR-Terminal, 1Remote, Royal TS and WinSCP.
   - The user picks the destination by browsing, and it is independent of the shell. A default folder per connection is a plus (DR-Terminal); Termius lacks one.
2. **A side panel attached to the SSH session, optionally following the cwd.**
   - Used by MobaXterm, Tabby, electerm, Tempest and Haven.
   - Following the cwd needs shell cooperation (OSC 1337 or OSC 633), and both MobaXterm and electerm mark it **experimental**.
3. **A file dropped on the terminal.** Two variants:
   - It inserts the path: Windows Terminal, Tabby, Wave.
   - It starts an in-band transfer into the shell's cwd: electerm (asks first; trzsz, zmodem or path), trzsz-ssh and tinyTerm (SCP). This needs `trz` or `rz` on the host, except in tinyTerm.
4. **A file browser with clipboard and drag between machines:** XPipe, Wave, Shell Assistant.
5. **Edit-in-place round trip** (temporary copy, watch, upload): Termius, XPipe, MobaXterm, electerm.

Across all patterns:

- **Conflicts:** explicit only in electerm (skip, overwrite or merge, rename, each with an "all" variant), Termius mobile (replace or keep both) and DR-Terminal (overwrite confirmation). Elsewhere they are undocumented.
- **Hosts without SFTP:** DR-Terminal falls back to SCP automatically, and MobaXterm offers SCP modes.

### 3.3 Facts that bear on #721 (no recommendation implied)

- **Detecting the cwd without the shell's help.** Every competitor that targets the cwd relies on the shell, either through escape sequences (OSC 1337 or OSC 633, opt-in or experimental) or through `rz`/`trz` running in the shell. lasterm's agent runs on the host and owns the PTY. #721 already lists "the agent reading it from the process" as an option, and none of the reviewed apps can do that.
- **Reaching hosts without SFTP.** lasterm already copes with hosts that offer no SFTP subsystem for its own deployment, using an exec channel (#722/#723). DR-Terminal needed an SCP fallback for the same hosts.
- **Existing user expectation.** #822 records a file dropped on a remote terminal in the expectation of an upload, and lists "A file dropped onto a remote terminal uploads" as expected behaviour. The only drop-to-upload competitor, electerm, asks first by default.
- **Browser clients.** `trzsz.js` targets browser and Electron terminals, so it is a precedent for a web UI like lasterm's [Tz1].

---

## 4. Gaps for lasterm

Each gap lists the competitors that have it (all from sections 2–3) and why it is placed in its category.

### 4.1 Table stakes for a Store terminal

1. **File transfer (upload and download with progress, conflicts, folders).**
   - Have it: Termius, electerm, DR-Terminal, Xcasca, 1Remote, Royal TS, Tempest, Shell Assistant, MobaXterm, Tabby.
   - lasterm has none (#721).
   - Why table stakes: every dedicated SSH client in the Store top results has it, and #822 shows a user expecting a dropped file to upload.
2. **Port forwarding.**
   - Have it: Termius (free plan), Xcasca (free plan), electerm, XPipe, Royal TS, Tempest, MobaXterm, Tabby.
   - lasterm has no user-facing forwarding.
   - Why table stakes: Termius now gives it away free, so it is no longer a paid differentiator.
3. **Agent forwarding.**
   - Have it: Termius (free since 10.1.0), Tabby (including Pageant and Windows OpenSSH), PuTTY (Pageant), electerm (tests).
   - lasterm authenticates through the agent but does not forward it.
   - Why table stakes: it is needed for `git` on remote hosts without copying keys.
4. **Multi-hop jump chains.**
   - Have it: Termius host chains (free), DR-Terminal "multi-hop", iLead visual chaining, electerm "connection hopping".
   - lasterm refuses `ProxyJump a,b` [L2 §4.5b].
5. **Snippets / saved commands.**
   - Have it: Termius, electerm, DR-Terminal, Windows Terminal (1.22), XPipe, Royal TS, Tempest, Termix.
   - lasterm has none.
   - Why table stakes: present in every reviewed app with real traction except PuTTY.
6. **Broadcast input.**
   - Have it: Windows Terminal, Termius (free), electerm, MobaXterm MultiExec, Royal TS key sequences.
   - lasterm has none, and its write lock (one writer per terminal) is a different concept.
   - It would need its own design, for example broadcast from one client holding the lock on several terminals.
7. **Key generation and import in the app.**
   - Have it: Termius, DR-Terminal (with a converter and an on-YubiKey generator), PuTTY (PuTTYgen), MobaXterm (MobaKeyGen).
   - lasterm can upload a key file to `~/.ssh` but cannot generate or convert one [L3].
8. **Serial and telnet.**
   - Have it: Termius, PuTTY, electerm, DR-Terminal, Tabby, MobaXterm, AbsoluteTelnet, quardCRT.
   - Why table stakes: expected by network and embedded users who search the Store for "serial" or "telnet".
   - Lower relevance to lasterm's developer and SRE audience.
   - On MSIX, Termius reports that serial can fail in its Store build [T14].
9. **Store listing basics.**
   - **ARM64 package:** shipped by Windows Terminal, DR-Terminal, XPipe, Royal TS, Tempest, 1Remote and PuTTY. lasterm ships x64 only.
   - **Keywords in the title:** the top `ssh` result is titled "Termius - Modern SSH Client", while "Lasterm" carries no keyword. lasterm is not in the top 100 for ssh, terminal or sftp [M2].
   - **Ratings:** lasterm has none yet.

### 4.2 Differentiators worth considering

These fit the hub and agent architecture and the "self-hosted, no account, persistent sessions" positioning.

1. **cwd-aware file transfer from the agent.**
   - Drop on the terminal or open a side panel at the terminal's real cwd, without shell integration and without `rz`/`trz` or an SFTP subsystem on the host.
   - Competitors mark cwd-following as experimental (MobaXterm, electerm) or need an OSC hook (Tabby). See section 3.3.
2. **Workspaces kept in the hub.**
   - Termius, electerm, Shell Assistant and Termix all use the word for saved sets of sessions and layouts. Termius templates even restore cwd and running apps by re-running them.
   - lasterm keeps layout in each browser's localStorage, and "the hub keeps no layout".
   - A hub-side workspace would follow the user to any paired client (#193). Its terminals would still be alive, which no competitor can offer: they all reopen new sessions.
3. **An AI-agent bridge (MCP) over persistent sessions.**
   - DR-Terminal (MCP, approval for sensitive actions), electerm (MCP widget, agent mode), Intelligent Terminal (agent pane), Tempest (Storm AI), Haven and NexTerm (built around Claude Code) all moved here in 2026.
   - lasterm's sessions outlive the client, so an agent could run unattended and be checked later. That matches the "check on AI agents from anywhere" search keyword in the website brief (khiops/lasterm-website `BRIEF.md`), which waits on #193.
   - "Job finished" notifications are part of the same trend: DR-Terminal (taskbar alert), Termius (background command finished) and Haven (marks sessions waiting) all have them.
4. **Session logs and search over history.**
   - Termius Pro session logs, Termix session recording, quardCRT terminal video recording.
   - lasterm's hub already spools output (`spool.db`), so a searchable history would build on existing data.
5. **Host insight.**
   - DR-Terminal shows OS, CPU, load, memory and disk gauges in the session sidebar.
   - lasterm already runs an agent on each host.
6. **OS-protected secret storage, opt-in.**
   - DR-Terminal (Windows secure storage), electerm (DPAPI through safeStorage), HelloUKey (TPM and Windows Hello).
   - lasterm never stores passwords. Optionally keeping key passphrases under DPAPI would remove repeated prompts after a hub restart without adding a vault service.
7. **Encrypted export and backup of hosts and settings.**
   - DR-Terminal offers it, and XPipe does git sync.
   - It gives a migration path between machines with no cloud, so it fits "no account".

### 4.3 Out of scope for lasterm's positioning

1. **Vendor-cloud sync of vaults and settings, behind an account.**
   - Termius Pro, Tempest, Xcasca Plus, electerm cloud.
   - It conflicts with "self-hosted, no account". The in-scope equivalent is the hub itself plus export and backup (4.2 item 7).
2. **Team vaults, SSO, RBAC, audit.**
   - Termius Team and Business, Devolutions RDM, Royal Server.
   - The README reserves organisation-only features for possible separate commercial products.
3. **RDP, VNC, Kubernetes, S3 and other multi-protocol connection management.**
   - 1Remote, Royal TS, RDM, XPipe, Tempest, electerm.
   - This is a different category (connection launchers).
4. **Vendor-hosted AI autocomplete or chat** (Termius AI, Warp).
   - It needs a vendor service. A bring-your-own-agent bridge (4.2 item 3) fits better.
5. **Native mobile apps** (Termius, DR-Terminal, Tempest, electerm, Termix).
   - lasterm's mobile answer is the PWA plus device pairing (#193), not separate native apps.
6. **Mosh** (Termius, Fluent Terminal, Tempest).
   - It solves the same problem as lasterm's remote daemon, by another route, and needs `mosh-server` and open UDP ports.
7. **Real-time collaboration through a vendor relay** (Termius multiplayer, Tempest share links).
   - lasterm's multi-client write lock is the local form. Remote sharing depends on pairing and the hub's exposure, not on a relay.

---

## 5. What changed versus the existing analysis

- **The competitor table in [`IDEATION_BRIEF.md`](IDEATION_BRIEF.md)** gives Tabby, Warp and iTerm as having no hub and no multi-device resume.
  - Wave Terminal (v0.14, 2026-02-12) now has **durable SSH sessions** through a remote job manager over the existing SSH connection, with no remote ports. They survive network drops and Wave restarts [Wv1].
  - Local and WSL terminals are not durable in Wave, and there is no hub or browser client.
- **The website's `docs/brief-sources/positioning-statement.md`** (context of the Onliness statement) describes Haven as macOS-only with "no multi-device access".
  - Haven's site now shows an **iPhone app** following the same live sessions, end-to-end encrypted from remote hosts [Hv1]. Local Haven sessions still end when the app quits.
- **The website's `docs/brief-sources/messaging-implications.md`** (Words to Use) says "Termius mandatory account pain".
  - The Termius FAQ now says "Can you use Termius without an account? Yes. You can log out and use Termius locally" [T4].
  - Sync still needs an account and a subscription, and new installs start with sign-in and a trial.
  - Since 10.1.0, the free plan also includes proxy, agent forwarding, host chains and serial [T12].
- **Termix** is no longer only a web app: it ships Windows, Linux, macOS, iOS and Android clients, plus Workspaces and Snippets plugins [Tx1].
- **New Store entrants not in any brief:**
  - DR-Terminal (2026-07)
  - Intelligent Terminal (Microsoft, 2026-06)
  - iLead (2026-09)
  - Xcasca (NetSarang, 2025-10)
  - Tempest 3

---

## Sources

All accessed 2026-10-31.

### Microsoft Store

- [M1] Store catalog API used by winget `msstore`: `POST https://storeedgefd.dsx.mp.microsoft.com/v9.0/manifestSearch`
- [M2] Store search API: `https://storeedgefd.dsx.mp.microsoft.com/v9.0/search?query=<keyword>&market=US&locale=en-US&deviceFamily=windows.desktop`
- [M3] Store product API: `https://storeedgefd.dsx.mp.microsoft.com/v9.0/products/<ID>?market=US&locale=en-US&deviceFamily=windows.desktop`
- [M4] Display catalog (rating aggregates): `https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=<IDs>&market=US&languages=en-US`
- [M5] Store web pages: https://apps.microsoft.com/search?query=ssh (client-rendered, empty to fetch) and `https://apps.microsoft.com/detail/<ID>`

### Store listings

Each listing was read through [M3]. Web URL form: `https://apps.microsoft.com/detail/<ID>`.

- [S1] Termius: https://apps.microsoft.com/detail/9NK1GDVPX09V
- [S2] Xcasca: https://apps.microsoft.com/detail/9P38GFZ2W07N; PortX: https://apps.microsoft.com/detail/9PC9D7XXZM5S
- [S3] Fluent Terminal: https://apps.microsoft.com/detail/9P2KRLMFXF9T; last release https://github.com/felixse/FluentTerminal/releases
- [S4] Shell Assistant: https://apps.microsoft.com/detail/9NR2G5QKF1BK
- [S5] quardCRT: https://apps.microsoft.com/detail/9P6102K9QB3T
- [S6] AbsoluteTelnet SSH Client: https://apps.microsoft.com/detail/9N77H85H11VS
- [S7] Devolutions Remote Desktop Manager: https://apps.microsoft.com/detail/XPFCXHF337W98S
- [S8] iLead - SSH Manager: https://apps.microsoft.com/detail/9NQDL0439Z4S
- [S9] tinyTerm: https://apps.microsoft.com/detail/9NXGN9LJTL05
- [S10] HelloUKey: https://apps.microsoft.com/detail/9N0WBPRDGF78
- [S11] WinSSHTerm MSIX: https://apps.microsoft.com/detail/9P47TJ9QJL5P

Others cited by ID in section 1:

- 9N8G5RFZ9XK3 (Windows Terminal Preview)
- 9P0PQ8B65N8X (WinSCP)
- 9N0NP4JJ192W (nxshell; https://github.com/nxshell/nxshell)
- 9WZDNCRDN3DT (Janaikore Telnet Terminal)
- 9NBLGGH52TCD (Remote Terminal 2)
- 9N6S8V9QQ224 (SFTP Explorer)
- 9NR7P38PKLT4 (SSH Tunnel)
- 9PKGBV7S35T0 (SSH Client - SFTP Terminal and Telnet)
- 9PJC2H3PXNFR (TerminalX)
- 9N68P7ZQ6SDZ (VxTerm English)
- 9MV73700RGWZ (NexTerm)
- 9NNH6JQFJ7HD (terminalpp)
- 9MXP8J9TVJ7J (SSH++)
- 9NBLGGH43HDM (Serial Debug Assistant)
- 9P6M6GJSF3HN (SST Simple Serial Terminal)
- 9MW99375981Z (Multi Comm Terminal)
- 9NF2H969R452 (CRMT)

### Termius

- [T1] Pricing: https://termius.com/pricing
- [T2] Workspaces blog post: https://www.termius.com/blog/workspaces-focus-without-losing-context
- [T3] Managing files with SFTP: https://docs.termius.com/organize-and-connect-to-hosts/managing-files-with-sftp
- [T4] Why am I required to create an account?: https://docs.termius.com/help-center/faq/why-am-i-required-to-create-an-account
- [T5] Sync of keys and passwords: https://docs.termius.com/keychain/sync-of-keys-and-passwords
- [T6] Encryption overview: https://docs.termius.com/security/encryption-overview
- [T7] SSH keys and certificates: https://docs.termius.com/keychain/ssh-keys-and-certificates
- [T8] Connecting to a server: https://docs.termius.com/organize-and-connect-to-hosts/connecting-to-a-server
- [T9] Snippets: https://docs.termius.com/terminal/snippets
- [T10] Workspaces: https://docs.termius.com/terminal/workspaces
- [T11] Autocomplete and shell integration: https://docs.termius.com/terminal/autocomplete-and-shell-integration
- [T12] Desktop changelog: https://docs.termius.com/changelog/desktop
- [T13] How to set a default SFTP path: https://docs.termius.com/help-center/faq/how-to-set-a-default-sftp-path
- [T14] Serial connections on Microsoft Store builds: https://docs.termius.com/help-center/troubleshooting/serial-connections-dont-work-on-microsoft-windows-store-builds
- [T15] Groups and tags: https://docs.termius.com/organize-and-connect-to-hosts/groups-and-tags
- [T16] Docs index (lists local, remote and dynamic forwarding): https://docs.termius.com/llms.txt

### electerm

- [E1] README: https://github.com/electerm/electerm
- [E2] cwd for "SFTP Follow Terminal Path": https://github.com/electerm/electerm/wiki/How-Electerm-Gets-the-Current-Working-Directory-(pwd)-in-Terminal-When-%22SFTP-Follow-Terminal-Path%22-Is-Enabled
- [E3] Warning about the follow-path function: https://github.com/electerm/electerm/wiki/Warning-about-sftp-follow-ssh-path-function
- [E4] Workspace feature: https://github.com/electerm/electerm/wiki/Workspace-Feature
- [E5] SSH agent: https://github.com/electerm/electerm/wiki/ssh-agent
- [E6] Terminal file drop: https://github.com/electerm/electerm/blob/master/src/client/components/terminal/mixins/term-file-drop.js
- [E7] Conflict modal: https://github.com/electerm/electerm/blob/master/src/client/components/file-transfer/conflict-resolve.jsx
- [E8] Transfer list UI: https://github.com/electerm/electerm/blob/master/src/client/components/sidebar/transport-ui.jsx
- [E9] Terminal and SFTP session view: https://github.com/electerm/electerm/blob/master/src/client/components/session/session.jsx
- [E10] Secret storage: https://github.com/electerm/electerm/blob/master/src/app/lib/safe-storage.js
- [E11] Releases (v5.8.0) and license: https://github.com/electerm/electerm/releases
- [E12] Agent-forwarding test: https://github.com/electerm/electerm/blob/master/src/test/unit-ci/session-ssh-agent-forward.spec.js

### DR-Terminal

- [D1] Store listing (description, features, notes): https://apps.microsoft.com/detail/9N1NR8M5TMX2
- [D2] App Store listing: https://apps.apple.com/app/id6759794328

The publisher site http://www.dr-online.pl/ returned only "DR-ONLINE".

### Windows Terminal

- [W1] Store listing: https://apps.microsoft.com/detail/9N0DX20HK701
- [W2] v1.19 release notes (broadcast input): https://github.com/microsoft/terminal/releases/tag/v1.19.2682.0
- [W3] Terminal Preview 1.21 (restore screen contents): https://devblogs.microsoft.com/commandline/windows-terminal-preview-1-21-release/
- [W4] Terminal Preview 1.22 (Snippets pane): https://devblogs.microsoft.com/commandline/windows-terminal-preview-1-22-release
- [W5] v1.26 release notes (`dragDropDelimiter`, per-window/workspace groundwork, "Dropdown" page): https://github.com/microsoft/terminal/releases/tag/v1.26.2734.0
- [W6] Dynamic profiles (`Windows.Terminal.SSH` source): https://learn.microsoft.com/en-us/windows/terminal/dynamic-profiles
- [W7] GitHub Copilot in Windows Terminal: https://devblogs.microsoft.com/commandline/github-copilot-in-windows-terminal/ and https://devblogs.microsoft.com/commandline/terminal-chat-now-included-in-github-copilot-free/
- [W8] Intelligent Terminal Store listing: https://apps.microsoft.com/detail/9NMQC2SSJX24
- [W9] SSH tutorial: https://learn.microsoft.com/en-us/windows/terminal/tutorials/ssh

### PuTTY

- [P1] Store listing: https://apps.microsoft.com/detail/XPFNZKSKLBP7RJ
- [P2] FAQ A.5.2 and A.8.4: https://www.chiark.greenend.org.uk/~sgtatham/putty/faq.html
- [P3] Change log: https://www.chiark.greenend.org.uk/~sgtatham/putty/changes.html
- [P4] Home page (0.85, 2026-08-16): https://www.chiark.greenend.org.uk/~sgtatham/putty/

### 1Remote

- [R1] Store listing: https://apps.microsoft.com/detail/9PNMNF92JNFP
- [R2] README and releases: https://github.com/1Remote/1Remote
- [R3] Docs overview: https://1remote.github.io/usage/overview/

### XPipe

- [X1] Store listing: https://apps.microsoft.com/detail/XP9KK2PJ9JDQ6G
- [X2] Pricing: https://xpipe.io/pricing
- [X3] File browser guide: https://docs.xpipe.io/guide/file-browser

### Royal TS

- [Y1] Store listing: https://apps.microsoft.com/detail/XP99WVBK3KNN3S
- [Y2] Features and pricing: https://www.royalapps.com/ts/win/features

### Tempest 3

- [G1] Store listing: https://apps.microsoft.com/detail/9PFV6RP97JB2
- [G2] Home page: https://gotempest.app

### Not on the Store

**Tabby:**

- [Tb1] README: https://github.com/Eugeny/tabby
- [Tb2] Shell working directory reporting: https://github.com/Eugeny/tabby/wiki/Shell-working-directory-reporting
- [Tb3] Path drop: https://github.com/Eugeny/tabby/blob/master/tabby-electron/src/pathDrop.ts
- [Tb4] SFTP panel: https://github.com/Eugeny/tabby/blob/master/tabby-ssh/src/components/sftpPanel.component.ts and `.pug`
- [Tb5] Transfers menu: https://github.com/Eugeny/tabby/blob/master/tabby-core/src/components/transfersMenu.component.pug
- [Tb6] winget package: https://wingetly.io/apps/eugeny/tabby

**MobaXterm:**

- [Mb1] Documentation: https://mobaxterm.mobatek.net/documentation.html
- [Mb2] Download and editions: https://mobaxterm.mobatek.net/download.html
- [Mb3] winget package: https://winstall.app/apps/Mobatek.MobaXterm

**Warp:**

- [Wp1] Pricing: https://www.warp.dev/pricing
- [Wp2] Installation: https://docs.warp.dev/getting-started/installation

**Wave:**

- [Wv1] Durable Sessions: https://docs.waveterm.dev/durable-sessions
- [Wv2] Connections: https://docs.waveterm.dev/connections
- [Wv3] Release notes: https://github.com/wavetermdev/waveterm/blob/main/docs/docs/releasenotes.mdx; releases https://github.com/wavetermdev/waveterm/releases

**Others:**

- [Hv1] Haven: https://haventerminal.com
- [Nx1] Nexterm: https://github.com/gnmyt/Nexterm
- [Tx1] Termix: https://github.com/Termix-SSH/Termix
- [Tz1] trzsz: https://github.com/trzsz/trzsz

### lasterm

Files and issues of this repository, read 2026-10-31.

- [L1] [`README.md`](../README.md)
- [L2] [`docs/SPEC.md`](SPEC.md): §3.4 web client and layout; §4 entity model; §4.5 SSH auth; §4.5b ProxyJump; §10.3 platforms
- [L3] [`docs/PROTOCOL.md`](PROTOCOL.md): `/api/ssh-keys`
- [L4] Issue #721 (file drop over SFTP, open)
- [L5] Issue #822 and PR #823 (a file dropped on a remote terminal broke the desktop's link to the hub; the upload itself does not exist yet)
- Store listing: https://apps.microsoft.com/detail/9P82QRJ6VDWL
