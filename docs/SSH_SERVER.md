# Configuring an SSH server for Lasterm

What the hub needs from the sshd of a host it reaches, and what a hardened configuration can take
away. A default OpenSSH or Win32-OpenSSH configuration has all of it. How the hub deploys and starts
the agent is in [`SPEC.md` §3.5](SPEC.md).

## The account

- **One authentication method.** A public key, from a file or the SSH agent, or a password. The hub
  never answers keyboard-interactive and does not chain methods: a server with
  `PasswordAuthentication no` that asks for passwords through keyboard-interactive (PAM), or with
  `AuthenticationMethods publickey,password`, refuses it. On Windows, the default `sshd_config` reads
  the keys of an account in Administrators from `C:\ProgramData\ssh\administrators_authorized_keys`,
  not from the account's own `.ssh\authorized_keys`.
- **Admission.** `AllowUsers`, `AllowGroups`, `DenyUsers` and `DenyGroups` must let the account in.
- **Commands.** The hub detects the system, deploys and starts the agent with commands on exec
  channels. The account needs a shell that runs them (not `nologin`), and no `ForceCommand`: an
  account restricted to `internal-sftp` cannot run the agent.
- **Sessions.** The hub keeps one connection per host and holds up to three session channels on it
  at once: the agent's, a command beside it, and, where SFTP is refused, the refused SFTP request,
  which stays open. `MaxSessions` must be 3 or more; the default is 10.
- **Algorithms.** The hub speaks what its SSH library (ssh2 1.17) does: `curve25519-sha256`, ECDH
  over the NIST curves or Diffie-Hellman for the key exchange, and ed25519, ECDSA or RSA
  (`rsa-sha2-256`, `rsa-sha2-512`) host keys. A server limited to the post-quantum exchanges
  (`mlkem768x25519-sha256`, `sntrup761x25519-sha512@openssh.com`) refuses it: keep `curve25519-sha256`
  in `KexAlgorithms`.
- **A jump host** (ProxyJump) forwards the hub's TCP connection to the target: it needs
  `AllowTcpForwarding` set to `yes` or `local`, and not `DisableForwarding yes`.

## SFTP

The hub uploads the agent over SFTP where the server offers it (`Subsystem sftp …`, on by default),
and over an exec channel otherwise (#722), with the same checks before anything runs it. Nothing
requires SFTP; a host without it shows a note in its status.

## Keeping the agent running (#79)

A POSIX host that keeps its agent running as a daemon is reached through a `direct-streamlocal`
channel to the daemon's Unix socket. That needs `AllowStreamLocalForwarding` set to `yes` (the
default) or `local`, and not `DisableForwarding yes`. Without it the hub starts the daemon but cannot
reach it, and the connection fails after 5 s with the socket's path.

Windows hosts stay on stdio: no SSH channel carries a named pipe, so their terminals end with the
connection. A relay over an exec channel, planned in
[#755](https://github.com/khiops/lasterm/issues/755), would lift both limits.

## Windows: the default shell

Win32-OpenSSH runs every command through the `DefaultShell` set under `HKLM\SOFTWARE\OpenSSH`:
cmd.exe unless it names another. cmd.exe and PowerShell both work.

Under PowerShell, the account's profile runs before **every** command the hub sends, the agent's
included, because sshd passes no `-NoProfile` (#749). Keep it silent on stdout and fast. The hub reads
each answer after a marker and finds the agent's first frame behind up to 64 KiB of output, and it
measures the profile's time on each connection's first command, up to 30 s. But SFTP gets no such
care: by Win32-OpenSSH's source, sshd starts its SFTP server through the same shell, so a profile
that prints would break it, as a chatty `.bashrc` does on Linux, and the agent then travels over the
exec channel. A profile also must not
read stdin, exit, or redefine `echo` or `powershell`. [`SPEC.md` §3.5](SPEC.md), "What a PowerShell
profile may do", has the details. cmd.exe's AutoRun (`HKCU\Software\Microsoft\Command Processor`) runs
the same way under cmd.exe; a `chcp 65001` there prints "Active code page: 65001" before every
command, which the hub copes with too.

**Skipping the profile.** For Windows PowerShell (`powershell.exe`), set `DefaultShellCommandOption`
to `-NoProfile`:

```powershell
New-ItemProperty -Path HKLM:\SOFTWARE\OpenSSH -Name DefaultShellCommandOption -Value '-NoProfile' -PropertyType String -Force
```

sshd then runs `powershell.exe -NoProfile "<command>"` in place of `powershell.exe -c "<command>"`,
and Windows PowerShell takes an argument that is no switch for the command. This applies to every
command any client runs through that sshd; an interactive shell without a command is not affected.
How far this is verified: Win32-OpenSSH's source (`do_exec_windows`, branch `latestw_all`) passes the
value as one argument in place of `-c`, and the hub's whole deployment and an agent exchange pass
through that command line in the local test harness (`agent-deployer.spec.ts`). It has not been tried
against a running sshd.

What does not work:
- `-NoProfile -Command`: sshd passes the value as one argument, quoted because it holds a space, and
  PowerShell looks for a command named `-NoProfile`.
- `-NoProfile` with PowerShell 7 (`pwsh.exe`), which takes a bare argument for a script file. The same
  source shows that with `DefaultShellEscapeArguments` set to 0, sshd inserts the option as it is for
  a shell it does not recognise as Windows PowerShell, so `-NoProfile -Command` could work there.
  That is unverified.
