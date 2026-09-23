# lasterm — Security Specification

> Version: 0.1.0 (MVP)
> Status: draft
> Last updated: 2026-09-05

## 1. Threat Model

### 1.1 Architecture Security Context

```
┌──────────────────────────────────────────────────────────┐
│ User's machine (trusted)                                  │
│                                                           │
│  Browser (PWA) ──── WSS/HTTPS ──── Hub daemon             │
│  127.0.0.1:<port>   │            127.0.0.1:<assigned port>│
│                      │            ┌───────────────┐       │
│  Token auth          │            │ meta.db       │       │
│  (Bearer header)     │            │ spool.db      │ 0600  │
│                      │            │ auth.json     │       │
│                      │            │ config.toml   │       │
│                      │            └───────────────┘       │
│                      │                                     │
│                      │ UDS (local daemon agent)            │
│                      │ agent.sock 0700 parent dir          │
│                      │ No auth (filesystem perms)          │
└──────────────────────┼────────────────────────────────────┘
                       │ SSH (encrypted)
                       │ No port opened on remote
┌──────────────────────▼────────────────────────────────────┐
│ Remote machine                                             │
│                                                            │
│  lasterm-agent ──── stdin/stdout ──── SSH server            │
│  (no network listener)               (port 22, standard)  │
│                                                            │
│  PTY processes run as the SSH user                         │
└────────────────────────────────────────────────────────────┘
```

### 1.2 Trust Boundaries

| Boundary | Trust level | Notes |
|----------|-------------|-------|
| Hub process ↔ local filesystem | High | Same user, same machine |
| Hub ↔ Agent daemon (UDS) | High | Same user, filesystem perms enforce access |
| Browser ↔ Hub (localhost) | Medium | Any local process can connect |
| Hub ↔ Remote (SSH) | High | SSH provides encryption + auth |
| Agent ↔ PTY | High | Same user on remote machine |
| Browser ↔ Internet | N/A | Hub never exposed to internet |

### 1.3 Threat Actors

| Actor | Access | Capability |
|-------|--------|------------|
| Malicious local process | Same machine, different user | Can attempt TLS connections to the loopback hub |
| Malicious local process | Same user | Can read auth.json, DB files |
| Network attacker | On same LAN | Cannot reach 127.0.0.1 (loopback only) |
| Compromised remote | Agent's SSH user | Can send crafted protocol messages |

### 1.4 Threat Matrix

| Threat | Vector | Impact | Likelihood | Mitigation |
|--------|--------|--------|------------|------------|
| Unauthorized hub access | Local process connects to WSS/HTTPS | HIGH — terminal access | MEDIUM | TLS SPKI pinning plus a browser token on every authenticated browser request/connection |
| Token theft | Read auth.json | HIGH — full access | LOW on a current install, where the hub creates auth.json 0600 and its directory 0700 whatever the umask; higher on a directory an earlier version created under a umask of 002, or one whose permissions were widened by hand | chmod 600, and on Unix the hub refuses to start when the file is group- or world-readable or writable. Windows is not checked: both checks return before doing anything there, and the file relies on the profile's default ACL; a DACL check was judged not worth its cost (#200) |
| Token planting | Write the configuration directory as another account, before the hub's first start | HIGH — the attacker chooses the credential the hub then honours, which is terminal access | LOW on a current install, where the hub creates the directory 0700 whatever the umask; higher on a directory an earlier version created under a umask of 002, or one widened by hand | The hub adopts an existing token at first start rather than refusing it, so this is takeover and not denial of service. On Unix both the desktop and the hub now refuse a directory group or other can write, before reading a token from it and before writing one into it, and the hub also refuses a directory it does not own. On Windows the protection is the single leaf handle and the profile's own ACL, since the reader inspects neither ownership nor a DACL, and the hub's check returns immediately there, which relies on the profile's default ACL (#200) |
| Spool data exposure | Read spool.db | MEDIUM — output history | LOW (requires same user) | chmod 600 on all DB files |
| Crafted agent messages | Compromised remote | MEDIUM — protocol abuse | LOW | Validate all agent messages, size limits |
| SSH credential theft | Read key files | HIGH — remote access | LOW (requires same user) | Use ssh-agent, never store passwords |
| DoS via large frames | Agent sends huge output | LOW — hub OOM | LOW | 10 MB frame limit, backpressure |
| Multi-device token sharing | Token copied insecurely | MEDIUM | MEDIUM | For a browser on this machine, `lasterm pair` issues an 8-digit code valid for 60 seconds and usable once. No other device can pair yet (#193) |
| Hub TLS key disclosure | Read `hub-tls-key.pem` | HIGH — the holder can impersonate the hub to every pinning client | LOW (requires same user) | chmod 600. **No supported rotation exists yet (#193)**, and clearing a client's pin revokes nothing. **The invariant: never clear a pin while the compromised key can still be served** — do that and the client pins the compromised identity again. Until then, stop the hub first, then replace the key at its source: delete `hub-tls-key.pem` and `hub-tls-cert.pem` for a generated identity, or replace the configured pair for an operator-supplied one — deleting the generated files does nothing when a certificate is configured, since the hub reloads the same key. Start the hub, confirm the recorded fingerprint changed, and only then clear each client's pin and let it re-pin on a first contact you are watching. Every browser exception must be accepted again |
| Protected file substitution | Any process able to rewrite a directory on the path to `auth.json`, `runtime.json`, the pinned-key store or the TLS key | HIGH — a substituted `runtime.json` or pin store points a client at a stranger's hub; a substituted `auth.json` supplies a token of the attacker's choosing | LOW | On Unix, every directory component is opened relative to the one above it, from the filesystem root, without following links, and the file is judged on the descriptor it is then read through. On Windows, ancestors and pathname-based publication remain unprotected — see § 4.4. |
| Native addon substitution | Another account able to write a directory on the path to the addon cache leaves a library where the single executable extracts its native addons | HIGH — the library runs inside the hub, which holds the token and terminal authority | LOW | Every addon is authenticated against the SHA-256 of the copy embedded in the executable, read through the descriptor it is opened with. On Linux the cache is used only when every directory on its path is private to this account or root — otherwise the addons are extracted under `XDG_RUNTIME_DIR`, checked the same way, or the hub does not start — and the addon is loaded through that descriptor. On Windows neither holds: the chain is not examined and LoadLibrary resolves the name again — see § 4.5 |

## 2. Authentication

### 2.1 Local Token Auth

**Token generation (on first start):**
```
1. Generate 32 bytes of crypto-random data
2. Encode as hex string (64 chars)
3. Write to $LASTERM_CONFIG_DIR/auth.json: { "token": "<hex>" }
4. Set file permissions: chmod 600 (Linux/macOS). On Windows the file inherits the
   profile's ACL and nothing here sets or checks one; the profile's default ACL is
   relied on (#200)
```

**Token validation:**
- REST: `Authorization: Bearer <token>` header on every browser API request.
- WSS: First message must be `AUTH { token }`. Connection closed if invalid. The token is checked
  again before each later frame is acted on, and the socket is closed once the token no longer
  validates. Revoking a token closes the sockets it opened at once (PROTOCOL.md § 4.1).
- Token comparison: constant-time (crypto.timingSafeEqual). A token the hub holds in memory — the
  primary token on the agent routes, the owner token of a shutdown or quit, the asset token of a
  public URL — is compared through `tokensEqual` in `auth.ts`. A credential the store checks is
  looked up by its SHA-256 hash, which a guess cannot steer. A spec refuses a plain `===` against a
  token anywhere in the hub's sources (#514).

**Token revocation:** `DELETE /api/auth/tokens/:id` revokes a paired token, and closes the sockets it
opened. The primary token cannot be revoked: the request answers `409 PRIMARY_TOKEN_NOT_REVOCABLE`.
The desktop authenticates with it, so a revoked primary token locked the desktop out of its own hub,
and a restart did not undo it (#515). It is retired by replacing `auth.json`, below. A revocation of
the primary token that a version before this rule recorded is cleared at the next start, which
records it as `token.reinstate` (§ 7.1).

**Token rotation:** there is none. No command replaces the token, and no broadcast tells connected
clients to re-authenticate. Replacing it today means stopping the hub, removing `auth.json`, and
starting again, which invalidates every browser pairing. The next start records the replacement as
`token.rotate` (§ 7.1). No issue tracks a token rotation; replacing the TLS key is part of **#193**.

### 2.2 Startup Security Check

On every hub start:

```
The permission checks below — items 1 to 3 — are Unix-only: each returns immediately on
Windows, which relies on the profile's default ACL (#200). The token-format check in item 4
runs everywhere.

1. Check the configuration directory holding auth.json, before reading a token from it
   and before writing one into it
   - If group- or world-writable, not a directory, or owned by another user: HARD FAIL
   - Expected: 0700, owned by the user running the hub
   - This is one lstat of that directory. An ancestor able to rename or replace it
     defeats the check; establishing more would need the descriptor walk that
     `lasterm-protected-fs` performs, and that crate is Rust

2. Check auth.json permissions
   - If group- or world-readable or writable (g+rw or o+rw): HARD FAIL — refuse to start
   - If not a regular file, including a symlink: HARD FAIL
   - Expected: 0600 (-rw-------)

3. Check data directory permissions — NOT IMPLEMENTED
   - Nothing inspects the state directory holding meta.db and spool.db. The hub's
     only permission checks are the two above, both in `auth.ts`
   - Expected once it exists: 0700 (drwx------)
   - The hub creates that directory 0700 wherever it first makes it (#352), but does not
     inspect one that already exists

4. Verify auth.json contains valid token (64 lowercase hex characters, as the hub generates)
   - If missing: generate one
   - If present but not JSON, or not 64 lowercase hex characters: refuse to start, naming the file. A hub that quietly
     replaced an unreadable token would invalidate every paired client without saying so.
```

### 2.3 Multi-Device Pairing

**Problem:** Second device needs the token. Copying files manually is insecure.

**Solution: One-time pairing code**

```
Device A (has token):
  $ lasterm pair
  Pairing code: 84729316
  Expires in 60 seconds.
  Enter this code on the other device.
```

Remote-device pairing is not delivered (#193). The hub remains
loopback-only; do not open a LAN port or direct another device to a hub URL.

## 3. SSH Security

### 3.1 Authentication Methods

| Method | How | Security level |
|--------|-----|---------------|
| **ssh-agent** (recommended) | Hub uses running ssh-agent via `SSH_AUTH_SOCK` | HIGH — keys never touch disk via lasterm |
| Key file | Hub reads private key path | MEDIUM — key on disk, lasterm doesn't copy it |
| Password | Hub sends password over SSH | LOW — password in memory (not stored) |

**MVP:** Support all three. Recommend ssh-agent in UI. Never store passwords in meta.db.

### 3.2 SSH Key Handling

- lasterm NEVER copies private keys
- Key path stored in meta.db (hosts.ssh_key_path) — points to user's existing key
- Passphrase: prompted by ssh2 library callback, never stored
- ssh-agent: preferred — lasterm just requests signing, never sees key material

### 3.3 Known Hosts

- A host key is trusted per host, in meta.db: nothing is accepted until someone accepts it, and a key that changes under an accepted one stops the connection.
- On a first connection the fingerprint is shown and the answer is the person's: trust permanently, trust for this run, or refuse.
- `~/.ssh/known_hosts` (and `known_hosts2`) are **read** to tell the person what their own SSH already believes: "your SSH configuration already trusts this exact key, `~/.ssh/known_hosts:10`". These files are never written — what OpenSSH trusts is OpenSSH's to record.
  - Hashed names (`HashKnownHosts yes`, the default on many distributions), `[host]:port`, comma-separated patterns, wildcards and negations are all read as `sshd(8)` defines them. A parser that missed them would report "unknown host" on a machine that knows the host perfectly well.
  - `@revoked` is a refusal, not a hesitation: the connection stops and no prompt offers to trust it.
  - `@cert-authority` delegates to a signature this does not check, so such a line says nothing about the key in hand and is ignored.
  - A host known there under a **different** key is shown as the warning it is, and never offered as a reason to trust.
- `[ssh] trust_known_hosts` (default `false`) lets someone say, once and in front of the evidence, that a key their own SSH already trusts needs no second question. It applies only to first connections; a key that changes under a pinned one still stops everything. Accepting this way still pins the fingerprint in meta.db, so the trust decision is recorded here and survives a later edit of `known_hosts`.

### 3.3b Jump hosts (ProxyJump)

- A host may be reached through another: the SSH connection to it is carried inside a channel opened on a bastion, so the target needs no route of its own.
- The jump is named **either** as a host this hub knows — which brings its own authentication and its own pinned host key, described once — **or** as a `user@host:port` spec, which authenticates through the SSH agent and is pinned on the host that jumps through it (`hosts.ssh_proxy_fingerprint`).
- **The jump's host key is verified like any other.** It is matched against what is already trusted for it: its pin, or `known_hosts` when `[ssh] trust_known_hosts` allows. A jump nothing trusts yet is **refused**, with a message saying to connect to it once as a host of its own. A first connection is a question for a person, and this one happens on the way to somewhere else, where nobody is looking.
- A chain (`ProxyJump a,b`) is refused rather than half-honoured: taking only the first hop would connect somewhere nobody asked for.
- The bastion's connection ends with the connection it carries: nothing is left logged in with nothing going through it.

### 3.3c Questions for a person

A wait on a person does not expire. What must be bounded is what a machine waits for from another machine, where anything can happen — dialling, the SSH handshake, the agent's answer to a SPAWN, teardown confirmation — and those keep their bounds.

A deadline on a human decision throws away the answer that arrives a second later, and teaches the one lesson a security question must never teach: answer without reading. So the host-key question, the password and passphrase questions, and the remote-agent-binary question wait for as long as they take.

That is only safe because none of them holds anything open while it waits:

- A password or passphrase is asked **before anything is dialled** (`buildSshConnectConfig` prompts, then connects).
- A host key is asked **after the verifier refused it** and the client was destroyed.
- The remote agent binary is found over a live connection — so that connection is **closed before the question is asked**. The deploy hands back what it saw (`AgentBinaryDecisionNeeded`) instead of asking from inside itself; the caller closes, asks, and connects again with the answer.

**A resumed attempt re-reads the remote binary.** The person answered about the hash they were shown, and a binary that changed while the question was open was never the one anybody approved: the attempt that resumes compares what it finds against the approved hash and asks again if they differ.

What ends such a wait, since time does not: the answer; the person leaving (their client is gone and no other can route the prompt, so the context is cleared and every prompt it holds resolves); an explicit cancel; the hub quitting. A **reconnect** asks nobody at all — it runs while the person may not be looking — so a binary nothing trusts ends the reconnect rather than deciding for them.

Elevation keeps a bound: its connection is the session the person is already using, not something the question opened.

### 3.4 Agent Launch Security

**Remote (SSH stdio):**
```
ssh user@host "lasterm-agent --stdio"
```

- Agent runs as the SSH user (no privilege escalation)
- Agent has no network listener (stdio only)
- Agent spawns PTYs as the same user
- Hub controls what commands agent receives (validated protocol)

**Local (daemon mode):**
```
lasterm-agent --daemon --socket $XDG_RUNTIME_DIR/lasterm/agent.sock
```

- Daemon spawned detached by hub via `connectOrLaunch()` (survives hub restart)
- Listens on UDS only — no TCP listener, not reachable from network
- Runs as the same user as the hub (inherited from parent process)
- Socket parent directory permissions (0700) prevent other users from connecting

### 3.5 Daemon Socket Security (UDS / Named Pipe)

The agent daemon communicates with the hub over a Unix domain socket (Linux/macOS) or named pipe (Windows).

**Socket paths:**
- Linux: `$XDG_RUNTIME_DIR/lasterm/agent.sock` (typically `/run/user/<uid>/lasterm/agent.sock`)
- Windows: `\\.\pipe\lasterm-agent-<username>`

**Filesystem protection:**
- Parent directory (`$XDG_RUNTIME_DIR/lasterm/`) created with mode 0700 — only the owning user can list or access contents
- `probeSocket(path)` throws on EACCES, preventing connection to another user's socket
- No authentication on the UDS itself — OS filesystem permissions serve as the trust boundary (same model as Docker socket, ssh-agent socket)

**Connection model:**
- Last-writer-wins displacement: a new hub connection immediately replaces the previous one
- No multi-client support — the daemon serves exactly one hub at a time
- Stale socket detection: `probeSocket()` distinguishes ECONNREFUSED (stale, safe to unlink) from EACCES (another user's socket, must not touch)

**Future hardening (deferred):**
- Linux: `SO_PEERCRED` peer UID verification (verify connecting process runs as the same user)
- Windows: named pipe ACL hardening (restrict access to current user SID)

## 4. Data Protection

### 4.1 At Rest

| Data | Location | Protection (MVP) | Protection (P2) |
|------|----------|-------------------|-----------------|
| Auth token | auth.json | chmod 600 | OS keychain |
| SSH key paths | meta.db | chmod 600 on DB | SQLCipher |
| Host configs | meta.db | chmod 600 | SQLCipher |
| Terminal output | spool.db | chmod 600 | SQLCipher |
| Snapshots | spool.db | chmod 600 | SQLCipher |
| Config prefs | config.toml | Standard file perms | — |

### 4.2 In Transit

| Path | Encryption | Notes |
|------|-----------|-------|
| Desktop, CLI, dev proxy ↔ Hub | TLS, key-pinned | The peer key must match `runtime.json`'s recorded SPKI. This is **key** identity, not certificate identity: these clients accept when the handshake proves possession of that key and refuse otherwise, with chain, expiry, hostname and trust roots taking no part. An expired certificate over the pinned key connects |
| Browser ↔ Hub | TLS, **not pinned** | A browser applies its own trust decision — its root store, or an exception the user accepted for the hub's self-signed certificate. It does not read `runtime.json` and does not check the recorded key, so a certificate the browser trusts for another reason is accepted. What bounds the exposure there is that a browser pairing does not outlive the hub run it was made against |
| Hub ↔ Agent (daemon) | None (UDS) | Kernel-only IPC, same user, no network transit |
| Hub ↔ Agent (SSH) | SSH (AES-256-GCM or ChaCha20) | Standard SSH encryption |

**Note:** the hub binds `127.0.0.1` today, which is the default of the local launch rather than the
design — pairing exists so a client can reach a hub across a network, and #96 covers hardening that
binding. A configured certificate is used as supplied; otherwise the hub generates its own key **once** and
keeps it, and **reuses a stored leaf over that key while it can still serve, reissuing over the same
key when it cannot**. The key is what stays fixed; the leaf is not. A new leaf is signed when the
stored one is absent, unreadable, belonging to another key, expired or within seven days of it,
dated in the future, or no longer matching the shape a generated leaf must have.
**That decision is taken when the hub starts, and not again while it runs** — a hub up for longer than
its leaf's remaining validity serves an expired certificate until it is restarted, which browsers
refuse and pinning clients do not care about (#193). A
client pins the key, so a reissue costs it nothing; a browser that accepted the certificate is asked
again, which is now roughly every two and a quarter years rather than every restart.

### 4.3 In Memory

- Auth token: kept in memory for comparison
- SSH passwords: cleared after authentication (not stored)
- Terminal output (hub): buffer limited by backpressure (max ~1MB per channel in memory)
- Terminal output (daemon agent): `OutputBuffer` ring buffer — per-channel cap (default 1 MB) + global cap (default 20 MB), oldest data evicted from largest channel
- Snapshots: kept in cache, limited by GC policy

### 4.4 How a protected file is reached

The files are `auth.json`, `runtime.json`, the pinned-key store, the TLS private key and the
generated certificate. What protects them differs by platform, and there is no summary that is
true of both.

**On Unix** no component of the path is resolved by the kernel from a name this process hands it
whole. Every directory is opened relative to the one above it, starting at the filesystem root and
following no link, and the leaf is opened by a fixed name relative to the parent that was just
checked. The checks that decide whether to trust the file read the descriptor it will be read
through. Within one resolved operation no component is re-resolved, so the name cannot come to
mean something else between the check and the read.

A later operation on the same path descends again, and that is where the guarantee currently
stops: a protected file's parent policy and its use can be established by two separate descents,
so an actor with rename rights over an ancestor can replace it — with a different real directory,
not a link — between them. Holding one directory capability across a whole operation would close
it. That actor already has rename rights over the user's own directories, so this is an accepted
residual rather than planned work (#231, #235).

Each ancestor must be readable as well as searchable: the walk opens directories, and no portable
search-only descriptor exists.

**On Windows** a protected file is opened once, with any reparse point left unfollowed, and every
check and read uses that one handle — the leaf-read race is closed, and that is the whole of what
is protected. Directories are held as pathnames, so ancestors are not protected and the leaf is
re-resolved by name whenever it is opened again. Publication, meaning rename, delete and hard
link, is pathname-based and is not protected against concurrent namespace changes. Closing either
needs handle-relative opens through `NtCreateFile`, which this does not use. The residual actor is
a process able to write one of these directories, which a process running as the same user
commonly can: a bounded and accepted risk rather than an absent one.

A handle-based publication was built and removed. Windows offers no write-through equivalent for
it, so it dropped a durability guarantee the pathname form carries, and withholding the
delete-sharing it needs broke both failure cleanup and concurrent replacement. None of that would
have been observable here: no test executes these paths on Windows.

### 4.5 How a native addon is loaded

The single executable embeds its native addons (better-sqlite3, the hub lock, the TLS identity) and
extracts them to `addons/<version>/<platform>-<arch>` under the cache directory before loading
them. What must hold is that only the embedded addon is executed from there. The actor is another
account able to write a directory on that path; a process running as the same user already has
everything a substituted addon would give it, and root is trusted.

**Everywhere**, a file in the cache is loaded only when the descriptor opened on it reads the
SHA-256 of the embedded copy. Anything else is replaced by a fresh extraction, written beside it and
renamed into place, and the result is opened and checked the same way.

**On Linux** the directory chain is examined from `/` down before the cache is used: every directory
a name is looked up in must be owned by this account or root and writable by neither group nor
others unless it is sticky, and every directory and link passed through must be owned by this
account or root. Links are followed and their targets examined the same way. Inside lasterm's own
cache directory, a loose directory this account owns is tightened. A directory that fails anywhere
else is most often a umask of 002 rather than an attack — Debian and Ubuntu use it for a user with a
private group, so a `~/.cache` that pip, npm or `mkdir -p` creates there is 0775 although nobody else
is in the group — and nothing here can tell those apart, since group membership may come from NSS or
LDAP. The cache is then not used: the addons are extracted to
`$XDG_RUNTIME_DIR/lasterm/addons/<version>/<platform>-<arch>`, walked by the same rules, and one
line on stderr names the refused directory, its mode and the fix (tighten it, or set
`XDG_CACHE_HOME`). On systemd that directory is a tmpfs, 0700 and owned by the user, so the fallback
costs one extraction per boot — or per login, where the directory goes with the user's last session
because lingering is off. The hub refuses to start only when the fallback is refused too, or
`XDG_RUNTIME_DIR` is not set, and the message names both places; it also refuses outright when the
failure is inside lasterm's own directory, where it cannot be a umask.

The file must be a regular file, reached without following a link, owned by this account or root
and not writable by group or others. It is then loaded through `/proc/self/fd/N`, so what `dlopen`
maps is the file that was hashed. A POSIX ACL granting write to another account shows in the group
bits and is refused; ACLs the mode bits do not reflect are not read.

**On Windows** neither the chain nor the file's ACL is examined: Node reports no owner and no DACL
there, so the cache relies on the profile's default ACL, as `auth.json` does (#200). A cache
redirected into a directory other accounts may write — as folders made at the root of a drive
usually are — is not detected. `LoadLibrary` takes a name and resolves it again, so the check and
the load cannot be made one operation. The verified handle is held across the load, and while it is
open NTFS refuses to rename any directory above the file: what remains is a change to the cache
directory's own entries or a write to the file, by whoever its ACL lets do that.

## 5. Input Validation

### 5.1 Protocol Messages

All incoming messages (from agent or UI) must be validated:

| Field | Validation |
|-------|-----------|
| `type` | Must be a known message type string |
| `channel_id` | Must be a valid ULID, must exist in session |
| `host_id` | Must be a valid ULID, must exist |
| `data` (Uint8Array) | Max 1 MB per message |
| `cols`, `rows` | Positive integers, 1 ≤ cols ≤ 500, 1 ≤ rows ≤ 200 |
| `shell` | Non-empty string, no null bytes |
| `cwd` | Non-empty string, no null bytes |
| `env` | Object with string keys/values, max 100 entries |
| Frame size | Max 10 MB total |

### 5.2 REST API

| Field | Validation |
|-------|-----------|
| Host label | 1-64 chars, alphanumeric + dash/underscore |
| SSH host | Valid hostname or IP, no shell metacharacters |
| SSH port | 1-65535 |
| Workspace name | 1-64 chars, alphanumeric + dash/underscore/space |
| Config TOML | Parse-validated before saving |
| Pairing code | Exactly 6 digits |

### 5.3 SQL Injection Prevention

- Use parameterized queries exclusively (better-sqlite3 `prepare().run()`)
- Never interpolate user input into SQL strings
- JSON columns: validate JSON structure before storing

## 6. Rate Limiting

| Endpoint / Action | Limit | Window |
|-------------------|-------|--------|
| POST /api/pair/verify | 10 attempts | 1 minute |
| POST /api/pair | 3 active codes | — |
| WS AUTH_FAIL | 5 failures → 30s cooldown | Per IP |
| SPAWN requests | 20 per host | 1 minute |

## 7. Logging & Audit

### 7.1 Security Events (always logged at INFO)

**Where.** Every hub writes these events to `logs/hub.jsonl` in its state directory —
`%LOCALAPPDATA%\lasterm\logs\hub.jsonl` on Windows, `~/.local/state/lasterm/logs/hub.jsonl` on
Linux — whichever entry point started it, `lasterm start` included, which is what the desktop runs.
They are written whatever `[logging] level` says; `[logging] output` still chooses between that file
and stderr (SPEC.md § 6.2). In a hub started by `lasterm start` they are the only entries in the file.

The file rotates at 10 MB into `hub.jsonl.old`, so it holds the recent past rather than a history.
Anything able to reach the port can produce failures faster than they are read and push older
entries out. A store that keeps them is the audit log of § 9, which is a separate decision.

**Shape.** One JSON line per event: `ts`, `lvl` (`info`), `msg` (`security: …`), `event`, then the
fields below. `clientId` is the id a WebSocket connection receives in `AUTH_OK`, so the same value
names that client in a later `write_lock.force`. `tokenId` is the credential's row: `primary` for
`auth.json`'s token, or the id a pairing gave the token it issued.

| Event | `event` | Fields | Recorded when |
|-------|---------|--------|---------------|
| Hub start | `hub.start` | `bindAddress`, `port`, `permissionsCheck` (`passed`; `not_checked_on_windows`, § 2.2) | The runtime record is published and the hub is serving |
| Auth success | `auth.success` | `via` (`ws`, `rest`), `sourceIp`, `tokenId`, `clientId` (WebSocket) | Every accepted WebSocket AUTH. On REST, the first accepted request of each credential from each address in a hub run: every request carries the bearer, and recording each would bury the rest |
| Auth failure | `auth.failure` | `via` (`ws`, `rest`, `pair`), `sourceIp`, `reason`, `clientId` (WebSocket), `tokenStatus` (with `invalid_token`) | REST: `missing_header`, `malformed_header`, `invalid_token`, `database_unavailable`. WebSocket: `auth_timeout`, `not_auth_first`, `invalid_token`, `database_unavailable`, `token_no_longer_valid`. Pairing verification: `rate_limited`, `invalid_format`, `unknown_code`, `code_used`, `code_expired`. `invalid_token` is refused the same way whatever its cause, and `tokenStatus` says which: `unknown` (no credential has that value), `revoked`, `swept` (by a restart) or `expired`. A revoked or swept token still being offered is a device that kept a credential it was meant to lose. `token_no_longer_valid` is a WebSocket the hub had accepted and then closed because its token stopped validating, on its next frame or at once when the token was revoked; `tokenStatus` says why, and `clientId` matches the `auth.success` that opened it. `database_unavailable` is a hub built with no token store at all; a store that exists but cannot be read is not an authentication failure (below) |
| Pairing code generated | `pairing.generated` | `pairingId`, `expiresAt`, `sourceIp` of the request | `POST /api/pair` issues a code |
| Pairing code verified | `pairing.verified` | `pairingId`, `tokenId` of the token issued, `sourceIp` | `POST /api/pair/verify` redeems a code |
| SSH connect | `ssh.connect` | `hostId`, `hostLabel`, `authMethod` (`agent`, `key`, `password`) | A host session takes up an authenticated connection: its first connect and every reconnect. A Test connection is not recorded |
| SSH disconnect | `ssh.disconnect` | `hostId`, `reason` (`closed_by_hub`; `connection_lost`, ended by the network, the server or the remote agent) | That connection ends |
| Write-lock force | `write_lock.force` | `channelId`, `byClientId`, `fromClientId` | A force takes the lock from another client. Forcing a free lock, or one already held, takes nothing and is not recorded |
| Token rotated | `token.rotate` | `tokenId` (`primary`) | The hub starts with a token in `auth.json` other than the one it last recorded: the replacement of § 2.1, or a substitution nobody asked for |
| Token reinstated | `token.reinstate` | `tokenId` (`primary`), `revokedAt` (when it had been revoked) | The hub starts, finds the primary token revoked, and clears the revocation (§ 2.1). Nothing in the hub revokes it any more: the revocation was left by a version before #515, which accepted `DELETE /api/auth/tokens/primary`, or by a hand edit of `meta.db` |

Fastify's request log keeps its own auth lines on stdout (WARN on a failure, INFO on a WebSocket
acceptance), which the desktop captures into `hub.log`. They are diagnostics beside this record,
not part of it. A routine request leaves no line there at INFO, only a request the hub failed
does (ERROR, or WARN for a 5xx a route chose), and the desktop moves `hub.log` to `hub.log.old` at
10 MB, replacing the one before (#512). `lasterm start --daemon` keeps the same output in
`hub-daemon.log` in the state directory, and the hub moves its content to `hub-daemon.log.old` at
the same size (#525).

**A token store that cannot be read is not recorded here.** While `meta.db` is closed, corrupt or
locked, every credential is refused (503 on REST, a `1013` close on the WebSocket) without being
judged. Nobody failed to authenticate, and one `auth.failure` per refused request would read as a
burst of failures from every client, the pattern a brute-force alert looks for. The outage goes to
the diagnostic log instead, once: ERROR when the store first fails to answer, WARN when it answers
again, with the number of credentials refused meanwhile. The same holds for an open WebSocket closed
because the store stopped answering. A store that can be read but not written accepts credentials
and fails to record their use; that is a WARN once, and another when a use is recorded again, with
the number that were not.

### 7.2 What is NOT logged

- Auth tokens (never in logs)
- SSH passwords (never in logs)
- Terminal output content (never in logs — goes to spool.db only)
- Pairing codes (never in logs — only expiry time)
- Asset tokens, and every other query value (#511)

A request URL reaches a line only through the request serializer of
`packages/hub/src/logging/request-log.ts`, which keeps its path and the names of its query
parameters, and writes `[redacted]` for each value. Fastify also composes a few messages around the
raw URL itself, so every line then passes a last filter that redacts `asset_token` wherever it
appears. Request headers are never logged: the one error that carries them, Node's report of a
request it could not parse, is logged without the raw bytes it holds.

For the events of § 7.1 this holds by construction, in `packages/hub/src/logging/security-log.ts`.
Each event is a method whose parameter names every field it can carry, and the record is built from
those names alone: the compiler refuses another field, and one passed on an object it did not see is
never read. No field is free text except a host's label, which the person chose. Every other value
must have the shape of what it names — a ULID, an IP address, an ISO 8601 time, a port, one of a
closed list — or it is written as `<withheld>`; a token (64 hex characters) or a pairing code (8
digits) has none of those shapes.

## 8. Security Recommendations for Users

Neither the first-run output nor `lasterm --help` prints these notes today. They are what a user
should know:

```
Security notes:
  • Hub listens on 127.0.0.1 only (not exposed to network)
  • Use ssh-agent for key management (recommended over key files)
  • auth.json must be readable only by you (chmod 600)
  • Do not share your auth token — use 'lasterm pair' for another browser on this machine
  • Terminal output is stored locally in data dir (see SPEC.md § 7 for platform paths)
  • Stored data is not encrypted at rest (SQLCipher is a P2 idea, not a feature)
```

## 9. Future Security Enhancements (post-MVP)

| Feature | Priority | Description |
|---------|----------|-------------|
| UDS SO_PEERCRED | P1 | Verify connecting process UID matches socket owner (Linux) |
| Named pipe ACL | P1 | Restrict Windows named pipe access to current user SID |
| SQLCipher | P2 | Encrypt meta.db and spool.db at rest |
| OS keychain | P1 | Store auth token in OS keychain (keytar) |
| TLS for non-localhost | P2 | If hub exposed beyond loopback |
| OIDC | P2 | Enterprise SSO for multi-user |
| mTLS | P2 | Mutual TLS for hub ↔ remote |
| Audit log | P1 | Persistent security event log |
| Session recording | P2 | Immutable audit trail of terminal sessions |
