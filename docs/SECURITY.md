# lasterm — Security Specification

> Version: 0.1.0 (MVP)
> Status: draft
> Last updated: 2026-03-02

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
| Token theft | Read auth.json | HIGH — full access | LOW (requires same user) | chmod 600, warn if world-readable |
| Spool data exposure | Read spool.db | MEDIUM — output history | LOW (requires same user) | chmod 600 on all DB files |
| Crafted agent messages | Compromised remote | MEDIUM — protocol abuse | LOW | Validate all agent messages, size limits |
| SSH credential theft | Read key files | HIGH — remote access | LOW (requires same user) | Use ssh-agent, never store passwords |
| DoS via large frames | Agent sends huge output | LOW — hub OOM | LOW | 10 MB frame limit, backpressure |
| Multi-device token sharing | Token copied insecurely | MEDIUM | MEDIUM | Pairing codes (short-lived, one-time) |

## 2. Authentication

### 2.1 Local Token Auth

**Token generation (on first start):**
```
1. Generate 32 bytes of crypto-random data
2. Encode as hex string (64 chars)
3. Write to $LASTERM_CONFIG_DIR/auth.json: { "token": "<hex>" }
4. Set file permissions: chmod 600 (Linux/macOS) or restrictive ACL (Windows)
```

**Token validation:**
- REST: `Authorization: Bearer <token>` header on every browser API request.
- WSS: First message must be `AUTH { token }`. Connection closed if invalid.
- Token comparison: constant-time (crypto.timingSafeEqual)

**Token rotation:**
- `lasterm token rotate` — generates new token, invalidates old
- All connected clients receive AUTH_FAIL and must re-authenticate

### 2.2 Startup Security Check

On every hub start:

```
1. Check auth.json permissions
   - If world-readable (o+r): HARD FAIL — refuse to start
   - If group-readable (g+r): WARN in logs
   - Expected: 0600 (-rw-------)

2. Check data directory permissions
   - If world-readable: WARN in logs
   - Expected: 0700 (drwx------)

3. Verify auth.json contains valid token (64 hex chars)
   - If missing or invalid: generate new token
```

### 2.3 Multi-Device Pairing

**Problem:** Second device needs the token. Copying files manually is insecure.

**Solution: One-time pairing code**

```
Device A (has token):
  $ lasterm pair
  Pairing code: 847293
  Expires in 60 seconds.
  Enter this code on the other device.
```

Remote-device pairing is not delivered in this branch (#183). The hub remains
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

- MVP: use system's `~/.ssh/known_hosts` (ssh2 `hostVerifier` callback)
- On first connect to unknown host: prompt user "Trust this host fingerprint? [Yes/No]"
- Store accepted fingerprints in meta.db (hosts table, optional column)

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
| UI ↔ Hub | TLS | Loopback HTTPS/WSS; the peer key must match `runtime.json`'s recorded SPKI |
| Hub ↔ Agent (daemon) | None (UDS) | Kernel-only IPC, same user, no network transit |
| Hub ↔ Agent (SSH) | SSH (AES-256-GCM or ChaCha20) | Standard SSH encryption |

**Note:** The hub is loopback-only. A configured certificate is used as supplied;
otherwise a key and certificate are generated once for the local hub identity.

### 4.3 In Memory

- Auth token: kept in memory for comparison
- SSH passwords: cleared after authentication (not stored)
- Terminal output (hub): buffer limited by backpressure (max ~1MB per channel in memory)
- Terminal output (daemon agent): `OutputBuffer` ring buffer — per-channel cap (default 1 MB) + global cap (default 20 MB), oldest data evicted from largest channel
- Snapshots: kept in cache, limited by GC policy

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

| Event | Log fields |
|-------|-----------|
| Hub start | bind address, port, permissions check result |
| Auth success | client_id, source IP (always 127.0.0.1 MVP) |
| Auth failure | source IP, reason |
| Pairing code generated | expires_at (NOT the code) |
| Pairing code verified | client_id |
| SSH connect | host_id, host label, auth method |
| SSH disconnect | host_id, reason |
| Write-lock force | channel_id, by client_id, from client_id |
| Token rotated | timestamp |

### 7.2 What is NOT logged

- Auth tokens (never in logs)
- SSH passwords (never in logs)
- Terminal output content (never in logs — goes to spool.db only)
- Pairing codes (never in logs — only expiry time)

## 8. Security Recommendations for Users

Included in first-run output and `lasterm --help`:

```
Security notes:
  • Hub listens on 127.0.0.1 only (not exposed to network)
  • Use ssh-agent for key management (recommended over key files)
  • auth.json must be readable only by you (chmod 600)
  • Do not share your auth token — use 'lasterm pair' for other devices
  • Terminal output is stored locally in data dir (see SPEC.md § 7 for platform paths)
  • To encrypt stored data, enable SQLCipher (P2 feature)
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
