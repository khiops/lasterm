# UX-03: Host Management

## Overview

Full CRUD for SSH hosts: add/edit/delete modal, SSH config import, Windows
Terminal import, host groups, connection status, test connection, and
host rail UX.

## App Layout — Host Rail

```
+----------+-------------+-------------------------------------------+
|          |             |                                           |
|   Host   |  Channels   |  Tabs + Panes                             |
|   Rail   |  Sidebar    |                                           |
|  (~72px) |             |                                           |
|          |             |                                           |
+----------+-------------+-------------------------------------------+
```

Rail width: ~72px default, user-configurable in settings.
Local host always first, always visible, not deletable.

### Host Rail Visual

```
+----------+
|          |
|   H 🟢   |  local (always first)
|  local   |
|          |
+--PROD----+  group separator (collapsible)
|          |
|   C 🟢   |  prod — connected
|  prod    |
|   C 🔴   |  staging — error
|  staging |
|          |
+--DEV-----+  group separator
|          |
|   C ⚪   |  dev-box — idle
|  dev-box |
|          |
|   [+]    |  add host button
+----------+
```

### Connection Status Indicator

Small dot at bottom-right of host icon:

| Status | Dot | Meaning |
|--------|-----|---------|
| Connected | green | Active session, agent running |
| Connecting | yellow | SSH handshake in progress |
| Error | red | Connection failed / dropped |
| Idle | white/gray | Never connected or cleanly disconnected |

### Tooltip on Hover

```
+------------------------------+
| prod-server                  |
|                              |
| Host:  192.168.1.100:22     |
| User:  deploy                |
| Auth:  Key (~/.ssh/id_ed25519)|
| Via:   bastion (ProxyJump)   |
| Group: Production            |
|                              |
| 3 terminals running          |
| Connected since 2h ago       |
+------------------------------+
```

### Host Groups — Collapsible

```
  Expanded:              Collapsed:
  +----------+           +----------+
  |  local   |           |  local   |
  |--PROD v--|           |--PROD >--|  (2 hosts hidden)
  |  prod    |           |--DEV  v--|
  |  staging |           |  dev-box |
  |--DEV  v--|           +----------+
  |  dev-box |
  +----------+
```

Click on group separator toggles collapse/expand.
Group label: short text (max ~6 chars), horizontal on separator bar.

### DnD Reorder

Hosts can be dragged within the rail to reorder. Can drag between groups.
Order persisted in meta.db `hosts.sort_order` column.

Groups can also be reordered by dragging the separator.

## Context Menus

### Host (SSH) — Right-click

```
+----------------------------+
| Connect                    |
| Disconnect                 |  (when connected)
+----------------------------+
| Edit Host            Ctrl+E|
| Duplicate                  |
| Move to Group          >   |
|  +----------------------+  |
|  | Production           |  |
|  | Staging              |  |
|  | Development       v  |  |
|  | -- New group --      |  |
|  +----------------------+  |
+----------------------------+
| Delete Host                |
+----------------------------+
```

### Local Host — Right-click (reduced)

```
+------------------------+
| Edit Name / Icon       |
+------------------------+
```

No: Delete, Disconnect, Duplicate, Move to Group.
Local host connection is implicit. Shell config is per-channel (UX-01
Configure Command).

Host icon (set here) is visible ONLY in host rail.
Channel icon (set in UX-01 Configure Command) is visible in tab bar + sidebar.
These are independent — no inheritance.

### Group Separator — Right-click

```
+------------------------+
| Rename Group           |
| Delete Group           |  (moves hosts to ungrouped)
+------------------------+
```

## Add Host Modal

Single modal (no wizard — not complex enough).

```
+------------------------------------------------+
|  Add Host                                      |
|                                                |
|  Name:     [                                ]  |
|  Icon:     [server v]  [preview]               |
|  Color:    [#e06c75] [pick]   (host rail tint) |
|  Group:    [Production v]  [+ New group]       |
|                                                |
|  --- Connection ---                            |
|  Source:                                       |
|  (*) Manual configuration                      |
|  ( ) From SSH config  [Select host v]          |
|  ( ) From Windows Terminal                     |
|                                                |
|  Hostname: [                                ]  |
|  Port:     [22                              ]  |
|  Username: [                                ]  |
|                                                |
|  SSH Config Host:  [                        ]  |
|  (use ~/.ssh/config entry for ProxyJump, etc.) |
|                                                |
|  Auth:     (*) Key file                        |
|            ( ) Password (prompted at connect)  |
|            ( ) SSH agent forwarding            |
|  Key file: [~/.ssh/id_ed25519       ]  [...]   |
|  Passphrase: (prompted at connect)             |
|                                                |
|  --- Advanced ---                     [v]      |
|  ProxyJump:     [bastion             ]         |
|  Default shell: [/bin/bash           ]         |
|  Keep alive:    [60] seconds                   |
|  History retention: [30 days v]                |
|    "Purge on delete" | "7 days" | "30 days"    |
|    | "Custom: [  ] days"                       |
|                                                |
|  [Test Connection]   [Cancel]        [Save]    |
+------------------------------------------------+
```

### Source: "From SSH config"

When selected, shows a dropdown of hosts found in ~/.ssh/config.
Selecting one pre-fills: hostname, port, user, key file, ProxyJump.
The SSH Config Host field is set to the config entry name for runtime
resolution (ssh2 uses the config directly for connection).

### Source: "From Windows Terminal"

Parses Windows Terminal settings.json for WSL distributions and SSH
profiles. Pre-fills connection details.

## Batch Import (SSH Config)

```
+------------------------------------------------+
|  Import from SSH Config                        |
|                                                |
|  Found 5 hosts in ~/.ssh/config:               |
|                                                |
|  [x] prod (1.2.3.4, user: deploy)             |
|  [x] staging (1.2.3.5, user: deploy)          |
|  [ ] bastion (10.0.0.1, user: admin)          |
|  [ ] github.com (skipped - not a server)       |
|  [x] dev-box (192.168.1.50, user: me)         |
|                                                |
|  ProxyJump relationships detected:             |
|  prod -> via bastion (will import bastion too) |
|  staging -> via bastion                        |
|                                                |
|           [Cancel]    [Import 4 hosts]         |
+------------------------------------------------+
```

Smart detection:
- Skip github.com, gitlab.com, etc. (known git hosts)
- Detect ProxyJump dependencies and suggest importing them too
- Pre-check hosts that look like servers

## Edit Host

Same modal as Add Host, pre-filled with current values.
Accessible from:
- Right-click host rail > Edit Host
- Settings Panel > Host tab > Edit Connection

## Delete Host

```
+--------------------------------------------+
|  Delete host "prod-server"?                |
|                                            |
|  This will:                                |
|  - Disconnect 2 active sessions            |
|  - Remove 5 saved channels                 |
|                                            |
|  Channel history:                          |
|  Retained for 30 days (host setting)       |
|  [Purge immediately instead]               |
|                                            |
|  Type "prod-server" to confirm:            |
|  [                                      ]  |
|                                            |
|           [Cancel]    [Delete]              |
+--------------------------------------------+
```

Confirmation by typing host name required when host has active sessions.
Simple confirm button when host is idle with no channels.

## Duplicate Host

Clones config with name suffixed "(copy)". Cannot clone local host.
Useful for similar setups (staging = prod with different IP).

DnD host across groups changes `group_name` in DB.

## Test Connection

Inline feedback in the modal:

```
[Test Connection]  ->  [Testing... *]  ->  ok Connected (180ms, OpenSSH 8.9)
                                       ->  xx Connection refused (port 22)
                                       ->  xx Auth failed (key rejected)
                                       ->  xx Timeout after 10s
```

Tests: TCP connect, SSH handshake, auth, shell spawn.
Shows server SSH version on success.

## SSH Config Runtime Resolution

When a host has `sshConfigHost` set (from import or manual entry), ssh2
resolves the full connection config from ~/.ssh/config at connect time.
Re-read at every connection (no caching — file is small, cost negligible).
This means:
- ProxyJump chains work automatically
- IdentityFile paths from config are used
- Any SSH config directive is honored
- Changes to ~/.ssh/config take effect without editing lasterm

Note: "Default shell" field = path on the **remote machine** (e.g., /bin/bash).
Placeholder in the UI should clarify this.

## Security

- Passwords: NEVER stored. Prompted at each connection.
- Passphrases: NEVER stored. Prompted at each connection.
- Key files: path stored, content NOT stored. Read at connect time.
- Future (P1): OS keychain integration for password/passphrase caching.
- auth.json permissions: 0600 (existing).

## API

```
GET    /api/hosts                -> list all hosts
POST   /api/hosts                -> create host
GET    /api/hosts/:id            -> get host details
PUT    /api/hosts/:id            -> update host
DELETE /api/hosts/:id            -> delete host
POST   /api/hosts/:id/test       -> test connection
POST   /api/hosts/:id/connect    -> initiate connection
POST   /api/hosts/:id/disconnect -> disconnect
GET    /api/ssh-config           -> parse ~/.ssh/config, return hosts
POST   /api/hosts/import         -> batch import from SSH config
```

## DB Schema

```sql
-- Existing hosts table, add columns:
ALTER TABLE hosts ADD COLUMN icon TEXT DEFAULT 'server';
ALTER TABLE hosts ADD COLUMN color TEXT DEFAULT NULL;
ALTER TABLE hosts ADD COLUMN group_name TEXT DEFAULT NULL;
ALTER TABLE hosts ADD COLUMN sort_order INTEGER DEFAULT 0;
ALTER TABLE hosts ADD COLUMN ssh_config_host TEXT DEFAULT NULL;
ALTER TABLE hosts ADD COLUMN keep_alive_seconds INTEGER DEFAULT 60;
ALTER TABLE hosts ADD COLUMN history_retention_days INTEGER DEFAULT 30;

-- Host groups (ordering)
-- Groups are implicit from hosts.group_name, no separate table needed.
-- Group sort order derived from first host in group.
```

## Settings

```toml
[hostRail]
width = 72                         # px, user-configurable
showLabels = true                  # show host name under icon
showStatusDot = true

[hosts.defaults]
defaultShell = "/bin/bash"         # overridable per-host
keepAliveSeconds = 60
historyRetentionDays = 30
```

## Future / Backlog

- P1: OS keychain for password/passphrase caching
- P2: Host tags (alternative to groups — non-exclusive categorization)
- P2: Host health monitoring (periodic ping, uptime tracking)
- P2: SSH tunnel management UI (port forwarding)
- P2: SFTP file browser per host
