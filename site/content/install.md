---
# Install, at /install/. The page opens with the InstallBlock expanded (its channels are below, and
# Home's InstallBlock shows the same ones), then the body.
title: Install Lasterm
description: >-
  Install Lasterm on Windows 10 or 11 from a GitHub release; the Microsoft Store and winget are
  planned. The installers, the requirements, the first launch.
path: /install/
lead: >-
  Lasterm is a desktop app for Windows, x64. Install it from a GitHub release today; the Microsoft
  Store and winget come next.

# The InstallBlock's tabs, in this order. Each has one action. `planned` shows the Planned chip
# beside the action and keeps the action visible, so the page keeps its shape when it ships.
channels:
  - id: store
    label: Microsoft Store
    status: planned # submission by hand: #618
    action:
      kind: primary
      label: Get it from the Microsoft Store
      href: null # the listing's address, once the Store has published it
    note: Updates arrive through the Store.
  - id: winget
    label: winget
    status: planned # manifests and automation: #620
    command: winget install O2CSI.Lasterm
    note: Upgrade later with `winget upgrade O2CSI.Lasterm`.
  - id: github
    label: GitHub release
    status: live
    action:
      kind: secondary
      label: Download from GitHub releases
      href: https://github.com/khiops/lasterm/releases/latest
    note: >-
      MSI and setup.exe installers for Windows x64. The app does not update itself: install a
      newer release over it.
---

## From a GitHub release

Each release carries two installers for Windows x64:

- `Lasterm_<version>_x64-setup.exe` asks whether to install for your account only or for every
  account of the computer.
- `Lasterm_<version>_x64_en-US.msi` installs for every account, and asks for administrator
  rights.

The installers are not signed yet, so Windows SmartScreen may warn about an unknown publisher.
Choose *More info*, then *Run anyway*.

GitHub lists the SHA-256 digest of every file on the release page. To check a download, compare it
with what PowerShell computes:

```powershell
Get-FileHash .\Lasterm_<version>_x64-setup.exe -Algorithm SHA256
```

To update, quit Lasterm with *Quit completely*, then install the newer release. Quitting completely
ends the terminals on this computer: it frees the files the installer replaces.

The other files of a release are not needed to install Lasterm: the hub on its own, the agents the
hub downloads by itself for remote hosts, their checksums in `SHA256SUMS-<version>.txt`, and the
`.msix` package for the Microsoft Store, which is not signed and does not install on its own.

## Requirements

- **Windows 10 version 1903 or later, or Windows 11, on x64.**
- **Microsoft Edge WebView2**, which draws the app's window. When it is missing, the installers
  download it from Microsoft and install it.
- **For a remote host**, an SSH server you can sign in to with a key, your SSH agent or a
  password. The host runs Linux on x64 or arm64 (a glibc-based distribution), or Windows on x64.
  macOS is not supported.
- **Internet access for the hub**, when a host needs an agent the hub does not carry, such as a
  Linux host: the hub downloads it from GitHub, once per version. The remote host itself needs no
  internet access. A hub without it can import an agent you downloaded elsewhere, in
  *Settings › Agents*.

On a Windows host, terminals end when the connection does. Keeping an agent running, so terminals
outlive the connection, works on Linux hosts.

The releases carry no desktop app and no hub for Linux. On Linux, you can build the hub from the
repository and use Lasterm in a browser: see the
[README](https://github.com/khiops/lasterm#quick-start).

## First launch

1. Open Lasterm from the Start menu. It starts its hub and opens a terminal on this computer.
2. To add a remote machine, select **+** at the foot of the host rail. Give it a name, its
   hostname and your username there, and choose how to sign in: an SSH key, your SSH agent, or a
   password asked each time. *From SSH config* fills these in from your `~/.ssh/config`.
3. Select the host in the rail, then **+** at the top of the terminal list to open a terminal
   there.
4. The first time Lasterm connects to a host, it shows the fingerprint of the host's key, and
   tells you when your own SSH already trusts that key. Check it, then choose *Trust Permanently*,
   *Trust Once* or *Reject*.
5. Lasterm copies its agent to the host, and the terminal opens.

Closing the window asks what to do: *Minimize to tray* keeps every terminal running; *Quit
completely* stops the hub and ends the terminals on this computer. *Remember this choice* skips
the question next time, and *Settings › Desktop* changes it later.
