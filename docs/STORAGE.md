# lasterm — Storage Specification

> Version: 0.1.0 (MVP)
> Status: draft
> Last updated: 2026-03-02

## 1. Overview

Two SQLite databases, both in WAL mode:

| Database | Path | Purpose | Size profile |
|----------|------|---------|-------------|
| **meta.db** | `$LASTERM_DATA_DIR/meta.db` | Config + relational data | Small (KB–MB) |
| **spool.db** | `$LASTERM_DATA_DIR/spool.db` | Output chunks + snapshots | Large (MB–GB) |

Platform paths for `$LASTERM_DATA_DIR`: see SPEC.md § 7 (Linux: `~/.local/share/lasterm/`, Windows: `%LOCALAPPDATA%\lasterm\`).

**Why 2 databases:**
- VACUUM spool without blocking meta reads
- Backup meta alone = tiny (all config, no output)
- Different GC policies (meta: keep forever, spool: age out)
- Different write patterns (meta: rare, spool: continuous heavy writes)

## 2. SQLite Configuration

Applied at connection open for both databases:

```sql
PRAGMA journal_mode = WAL;           -- Write-ahead logging
PRAGMA synchronous = NORMAL;         -- Safe with WAL (fsync on checkpoint, not every commit)
PRAGMA foreign_keys = ON;            -- Enforce referential integrity
PRAGMA busy_timeout = 5000;          -- Wait 5s on lock contention before SQLITE_BUSY
PRAGMA cache_size = -8000;           -- 8MB page cache (negative = KB)
PRAGMA wal_autocheckpoint = 1000;    -- Checkpoint every 1000 pages (~4MB)
```

Additional for spool.db (write-heavy):

```sql
PRAGMA auto_vacuum = INCREMENTAL;    -- Free pages without full VACUUM
PRAGMA wal_autocheckpoint = 2000;    -- Less frequent checkpoints (more batching)
```

**File permissions:** Both DB files and WAL/SHM files: `chmod 600` (owner read/write only).

## 3. Schema — meta.db

### 3.1 hosts

```sql
CREATE TABLE hosts (
  id          TEXT PRIMARY KEY,                          -- ULID
  type        TEXT NOT NULL CHECK(type IN ('local', 'ssh')),
  label       TEXT NOT NULL UNIQUE,
  ssh_host    TEXT,                                      -- user@hostname or IP
  ssh_port    INTEGER DEFAULT 22,
  ssh_auth    TEXT CHECK(ssh_auth IN ('agent', 'key', 'password')),
  ssh_key_path TEXT,                                     -- path to private key (if auth=key)
  icon_type   TEXT NOT NULL DEFAULT 'auto'
              CHECK(icon_type IN ('auto', 'emoji', 'image')),
  icon_value  TEXT,                                      -- emoji char or image path
  color       TEXT,                                      -- hex color (#rrggbb), null = auto
  profile_json TEXT,                                     -- JSON: layer 3 theme/config overrides
  trust_remote_hints TEXT NOT NULL DEFAULT 'apply'
              CHECK(trust_remote_hints IN ('apply', 'ask', 'ignore')),
  default_shell TEXT,
  default_cwd   TEXT,
  created_at  TEXT NOT NULL,                             -- ISO 8601
  updated_at  TEXT NOT NULL
);
```

### 3.2 channel_groups

```sql
CREATE TABLE channel_groups (
  id         TEXT PRIMARY KEY,                           -- ULID
  host_id    TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  collapsed  INTEGER NOT NULL DEFAULT 0,                 -- boolean (0/1)
  created_at TEXT NOT NULL
);

CREATE INDEX idx_groups_host ON channel_groups(host_id, sort_order);
```

### 3.3 sessions

```sql
CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,                           -- ULID
  host_id    TEXT NOT NULL REFERENCES hosts(id),
  status     TEXT NOT NULL DEFAULT 'starting'
             CHECK(status IN ('starting', 'active', 'detached',
                              'disconnected', 'closed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_sessions_host   ON sessions(host_id);
CREATE INDEX idx_sessions_status ON sessions(status);
```

### 3.4 channels

```sql
CREATE TABLE channels (
  id          TEXT PRIMARY KEY,                          -- ULID
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  group_id    TEXT REFERENCES channel_groups(id) ON DELETE SET NULL,
  title       TEXT,                                      -- user-editable display name
  shell       TEXT NOT NULL,
  cwd         TEXT,
  env_json    TEXT,                                      -- JSON: Record<string,string>, max 100 entries, nullable
  cols        INTEGER NOT NULL DEFAULT 80,
  rows        INTEGER NOT NULL DEFAULT 24,
  status      TEXT NOT NULL DEFAULT 'born'
              CHECK(status IN ('born', 'live', 'orphan', 'dead')),
  exit_code   INTEGER,                                   -- set when DEAD
  profile_json TEXT,                                     -- JSON: layer 4 overrides
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX idx_channels_session ON channels(session_id);
CREATE INDEX idx_channels_status  ON channels(status);
CREATE INDEX idx_channels_group   ON channels(group_id);
```

### 3.5 workspaces

```sql
CREATE TABLE workspaces (
  id         TEXT PRIMARY KEY,                           -- ULID
  name       TEXT NOT NULL UNIQUE,
  layout_json TEXT NOT NULL,                             -- JSON: tree of tabs/panes/channels
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### 3.6 cache_index

```sql
CREATE TABLE cache_index (
  channel_id             TEXT PRIMARY KEY REFERENCES channels(id),
  last_snapshot_chunk_id TEXT,                            -- FK to spool.chunks.id
  last_seq               INTEGER NOT NULL DEFAULT 0,     -- last OUTPUT seq cached
  last_seen_at           TEXT NOT NULL                    -- ISO 8601
);
```

### 3.7 pairing_codes

```sql
CREATE TABLE pairing_codes (
  id         TEXT PRIMARY KEY,                           -- ULID
  code       TEXT NOT NULL UNIQUE,                       -- 6-digit string
  created_at TEXT NOT NULL,                              -- ISO 8601
  expires_at TEXT NOT NULL,                              -- ISO 8601 (60s from creation)
  used       INTEGER NOT NULL DEFAULT 0,                 -- boolean
  used_at    TEXT,                                       -- ISO 8601, set when redeemed
  used_by_ip TEXT                                        -- IP of the client that redeemed
);

CREATE INDEX idx_pairing_codes_code ON pairing_codes(code);
```

### 3.8 Schema version

```sql
CREATE TABLE schema_version (
  version    INTEGER NOT NULL,
  applied_at TEXT NOT NULL
);

-- Initial version
INSERT INTO schema_version VALUES (1, datetime('now'));
```

## 4. Schema — spool.db

### 4.1 chunks

```sql
CREATE TABLE chunks (
  id                TEXT PRIMARY KEY,                    -- ULID
  channel_id        TEXT NOT NULL,                       -- references meta.channels.id (no FK cross-db)
  seq               INTEGER NOT NULL,                    -- per-channel sequence number
  ts                TEXT NOT NULL,                       -- ISO 8601
  kind              TEXT NOT NULL
                    CHECK(kind IN ('output', 'snapshot', 'resize')),
  codec             TEXT NOT NULL DEFAULT 'raw'
                    CHECK(codec IN ('raw', 'zstd')),
  data_blob         BLOB NOT NULL,
  uncompressed_len  INTEGER NOT NULL,

  UNIQUE(channel_id, seq)
);

CREATE INDEX idx_chunks_channel_seq  ON chunks(channel_id, seq);
CREATE INDEX idx_chunks_channel_kind ON chunks(channel_id, kind);
CREATE INDEX idx_chunks_ts           ON chunks(ts);
```

### 4.2 Schema version

```sql
CREATE TABLE schema_version (
  version    INTEGER NOT NULL,
  applied_at TEXT NOT NULL
);

INSERT INTO schema_version VALUES (1, datetime('now'));
```

## 5. Chunking Strategy

### 5.1 Output Chunks

Terminal output is written to spool.db in chunks:

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Max chunk size | 256 KB | Avoid large transactions; fast sequential reads |
| Flush trigger | Buffer ≥ 256 KB OR timer 1s | Whichever comes first |
| Codec | `raw` (MVP), `zstd` (P1) | Compression deferred to P1 |

**Flow:**
1. Agent sends OUTPUT (may be batched, typically 1–16 KB)
2. Hub accumulates in memory buffer per channel
3. When buffer ≥ 256 KB or 1s elapsed → write chunk to spool.db
4. Assign seq = previous chunk seq + 1

### 5.2 Snapshot Chunks

Periodic screen state captures:

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Interval | 3s idle OR 5s forced | Balance freshness vs write load |
| Trigger: idle | No OUTPUT received for 3s → request snapshot | Capture stable state |
| Trigger: forced | Every 5s regardless | Guarantee recent snapshot |
| Trigger: detach | On client detach → request snapshot | Best state for reconnect |
| Kind | `snapshot` | Distinct from output chunks |

**Snapshot chunk data:**
```json
{
  "serialized": "<xterm serialize() output>",
  "cols": 120,
  "rows": 40,
  "cursor_x": 5,
  "cursor_y": 38
}
```

Stored as JSON in data_blob (kind=snapshot). Codec=raw for MVP.

### 5.3 Resize Chunks

```json
{
  "cols": 120,
  "rows": 40,
  "previous_cols": 80,
  "previous_rows": 24
}
```

Kind=resize. Stored for replay accuracy.

## 6. Cache Index

The `cache_index` table (meta.db) tracks the latest cache state per channel:

```
channel_id → {
  last_snapshot_chunk_id: points to latest snapshot in spool.db
  last_seq: highest output seq number cached
  last_seen_at: when hub last received data for this channel
}
```

**Used for:**
- Fast ATTACH: read snapshot + tail (chunks where seq > snapshot's seq)
- Offline view: when agent unreachable, serve from cache
- GC decisions: channels not seen recently = candidates for cleanup

## 7. Garbage Collection

### 7.1 Policy

| Parameter | Default | Config key |
|-----------|---------|-----------|
| Max age per channel | 7 days | `spool.gc_max_age_hours = 168` |
| Max size total | 500 MB | `spool.gc_max_size_mb = 500` |
| Keep last snapshot | Always | (not configurable — always keep) |
| GC interval | 10 minutes | `spool.gc_interval_minutes = 10` |

### 7.2 Algorithm

```
Every gc_interval_minutes:

1. Delete output chunks older than gc_max_age_hours
   EXCEPT: keep the last snapshot chunk per channel (regardless of age)

2. If total spool size > gc_max_size_mb:
   a. Find channels sorted by last_seen_at ASC (least recently active)
   b. Delete oldest output chunks (ORDER BY ts ASC) from least-active channels (ORDER BY last_seen_at ASC)
   c. Repeat until under limit (cross-DB: read cache_index from meta.db to find least-active)
   d. NEVER delete the last snapshot per channel

3. Delete chunks for channels with status = 'dead' and
   last_seen_at older than gc_max_age_hours

4. Run PRAGMA incremental_vacuum on spool.db (free pages to OS)
```

### 7.3 GC Safety

- Always keep at least the last snapshot per channel (reconnect needs it)
- Never delete chunks for LIVE or ORPHAN channels (active use)
- DEAD channels: keep for gc_max_age_hours, then GC
- Run incremental_vacuum (not full VACUUM) to avoid blocking writes

## 8. Data Access Patterns

### 8.1 Write Patterns

| Operation | Frequency | Database | Table |
|-----------|-----------|----------|-------|
| OUTPUT chunk write | Continuous (10s–100s/sec) | spool.db | chunks |
| Snapshot write | Every 3-5s per active channel | spool.db | chunks |
| Cache index update | Every chunk write | meta.db | cache_index |
| Session/channel status | On state change | meta.db | sessions, channels |
| Host CRUD | Rare (user action) | meta.db | hosts |
| Workspace save | On layout change | meta.db | workspaces |

### 8.2 Read Patterns

| Operation | Pattern | Database |
|-----------|---------|----------|
| ATTACH (snapshot) | Read last snapshot chunk + tail | spool.db |
| Host list | Read all hosts | meta.db |
| Channel list | Read channels for host | meta.db |
| Scrollback | Sequential read of output chunks by seq | spool.db |
| Config resolve | Read host.profile_json + channel.profile_json | meta.db |

### 8.3 Transaction Strategy

- **meta.db writes:** Wrap multi-table updates in transactions (e.g., create session + channel)
- **spool.db writes:** Single INSERT per chunk, no transaction wrapping needed (WAL handles)
- **Cross-DB:** No cross-DB transactions. Use cache_index updates as eventual consistency marker.
- **Reads:** No explicit transactions for reads (WAL provides snapshot isolation)

## 9. Migration Strategy

### 9.1 Version Tracking

Each DB has a `schema_version` table. On startup:

```
1. Open DB
2. Read schema_version.version
3. If version < CURRENT_VERSION:
   a. Run migration scripts in order (v1→v2, v2→v3, ...)
   b. Update schema_version
4. If version > CURRENT_VERSION:
   a. Log error "Database is newer than this software"
   b. Refuse to start (don't corrupt newer schema)
```

### 9.2 Migration Files

```
packages/hub/src/storage/migrations/
├── meta/
│   ├── 001-initial.sql
│   ├── 002-add-xxx.sql
│   └── ...
└── spool/
    ├── 001-initial.sql
    └── ...
```

Each migration is a **SQL file**, run inside a transaction. Files are discovered by numeric prefix (`001-`, `002-`) sorted lexicographically. The runner reads `schema_version.version`, then applies all files with number > current version in order. Each file name format: `NNN-description.sql` where NNN is zero-padded 3-digit integer.

## 10. Backup & Restore

### 10.1 Backup

```bash
# Full backup (both DBs) — paths shown for Linux, see SPEC.md § 7 for Windows
cp ~/.local/share/lasterm/meta.db backup/meta.db
cp ~/.local/share/lasterm/spool.db backup/spool.db

# Config-only backup (tiny, recommended for sync)
cp ~/.local/share/lasterm/meta.db backup/meta.db
cp ~/.config/lasterm/config.toml backup/config.toml
# Spool is regeneratable — no need to backup
```

**Online backup (while hub running):**
```sql
-- Using SQLite backup API (via better-sqlite3)
db.backup('backup/meta.db');
```

### 10.2 Workspace Export/Import

```bash
lasterm workspace export my-workspace -o workspace.json
lasterm workspace import workspace.json
```

Export format:
```json
{
  "version": 1,
  "workspace": { "name": "...", "layout_json": "..." },
  "hosts": [{ "label": "...", "type": "ssh", ... }],
  "channel_groups": [{ "name": "...", "host_label": "..." }]
}
```

Note: export does NOT include spool data (output/snapshots). Only structure.

## 11. Data Lifecycle

```
Channel created (BORN)
  │
  ├─ Output flowing → chunks accumulate in spool.db
  ├─ Snapshots taken periodically → snapshot chunks in spool.db
  ├─ cache_index updated with every chunk
  │
  Channel LIVE → ORPHAN → LIVE (reconnect cycle)
  │
  Channel DEAD (PTY exited)
  │
  ├─ Data retained for gc_max_age_hours
  ├─ Scrollback still readable from spool.db
  │
  GC runs
  │
  ├─ Output chunks deleted (age-based)
  ├─ Last snapshot kept (for review)
  │
  Final GC (channel too old)
  │
  └─ All chunks deleted, cache_index cleaned
```
