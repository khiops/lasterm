# lasterm — Storage Specification

> Version: 0.1.0 (MVP)
> Status: draft
> Last updated: 2026-10-30

## 1. Overview

Two SQLite databases, both in WAL mode:

| Database | Path | Purpose | Size profile |
|----------|------|---------|-------------|
| **meta.db** | `<state dir>/meta.db` | Config + relational data | Small (KB–MB) |
| **spool.db** | `<state dir>/spool.db` | Output chunks + snapshots | Large (MB–GB) |

Both live in the hub's state directory, the one it locks: on Linux `$XDG_STATE_HOME/lasterm/` (by default `~/.local/state/lasterm/`), on Windows `%LOCALAPPDATA%\lasterm\`.

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

**File permissions:** on Unix, `meta.db`, `spool.db` and their `-wal` and `-shm` files are 0600
(owner read/write only), held to that each time the hub opens them (#536):

- A database file that does not exist yet is created 0600 before SQLite opens it. Left to
  SQLite, it would get 0644 under the usual umask of 022.
- An existing database file is set to 0600, and so is a `-wal` or `-shm` file an earlier run
  left behind: a database an earlier version created, or one copied in, has whatever mode the
  umask gave it.
- The `-wal` and `-shm` files SQLite creates from then on take the database file's mode, which
  SQLite copies to them on Unix. A spec reads all six modes back after a first write.
- A database file another account owns, or one that is not a regular file, stops the hub,
  naming it.

The state directory holding them is 0700, checked at every start as soon as the hub holds its
lock, before a log or a database is opened in it: tightened when this account owns it, refused
when another account does (SECURITY.md § 2.2, item 3).

On Windows no mode is set or checked. The files, like the state directory, rely on the
profile's default ACL, as `auth.json` does (SECURITY.md § 2.1, #200).

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
  default_shell TEXT,                                    -- the user's Default Shell, never the agent's
  default_cwd   TEXT,
  created_at  TEXT NOT NULL,                             -- ISO 8601
  updated_at  TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,                          -- order within its group; ties by creation
  ssh_config_host TEXT DEFAULT NULL,                     -- the ~/.ssh/config alias it came from
  ssh_user TEXT DEFAULT NULL,
  host_group_id TEXT REFERENCES host_groups(id) ON DELETE SET NULL,
  discovered_shells TEXT,                                -- JSON: the shells its agent reported
  discovered_shells_at TEXT,
  elevation_method TEXT
    CHECK(elevation_method IS NULL OR elevation_method IN ('sudo','doas','pkexec','gsudo','custom')),
  custom_command TEXT,                                   -- with elevation_method = 'custom'
  os TEXT CHECK(os IS NULL OR os IN ('linux', 'darwin', 'windows')),
  arch TEXT CHECK(arch IS NULL OR arch IN ('x64', 'arm64')),
  ssh_fingerprint TEXT,                                  -- pinned host key, SHA256:<base64 unpadded>
  agent_sha256 TEXT DEFAULT NULL,                        -- pinned SHA-256 of its agent binary
  ssh_proxy_host_id TEXT REFERENCES hosts(id) ON DELETE SET NULL,  -- a jump this hub knows
  ssh_proxy_spec TEXT,                                   -- or a jump as user@host:port
  ssh_proxy_fingerprint TEXT,                            -- that spec jump's pinned key
  ssh_remote_daemon INTEGER,                             -- NULL follows [ssh] remote_daemon (#79)
  discovered_default_shell TEXT                          -- the default shell its agent reported (023)
);
```

The columns keep the order the migrations before the baseline added them in (§ 9.3), which is
why `created_at` is not last, and the ones after it add theirs at the end (§ 9.4).

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
  shell       TEXT NOT NULL,                             -- '' when none of its own: the agent's default (#583)
  cwd         TEXT,
  env_json    TEXT,                                      -- JSON: Record<string,string>, max 100 entries, nullable
  cols        INTEGER NOT NULL DEFAULT 80,
  rows        INTEGER NOT NULL DEFAULT 24,
  status      TEXT NOT NULL DEFAULT 'born'
              CHECK(status IN ('born', 'live', 'orphan', 'dead')),
  exit_code   INTEGER,                                   -- set when DEAD
  end_reason  TEXT,                                      -- 'killed' | 'stopped' when the hub ended it; NULL otherwise (#592)
  profile_json TEXT,                                     -- JSON: layer 4 overrides
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX idx_channels_session ON channels(session_id);
CREATE INDEX idx_channels_status  ON channels(status);
CREATE INDEX idx_channels_group   ON channels(group_id);
```

`end_reason` says why a dead terminal ended, when the hub ended it itself (#580):

- `'killed'`: that terminal, or its session, was stopped on purpose: a kill (`DELETE
  /api/channels/:id` on a live one) or its session closed (`DELETE /api/sessions/:id`). A pane
  that finds such a terminal ended, at a reload or the next launch, keeps asking rather than
  follow "When a terminal ends".
- `'stopped'`: it ended with its agent, replaced, or with the hub, quitting. Nobody aimed at
  it, and found later it follows the setting as a terminal that exited by itself does (#592).

It is written with the `dead` status by the one statement that records a channel's status, and
cleared there by any other status, and when a terminal is brought back under its own id: an end
has a reason only until the terminal runs again. A `dead` told again without one keeps the
reason already there; one given replaces it. It is NULL for a terminal that ended by itself or
that the hub found gone, and for every terminal that had ended before the column existed: why
those ended was never recorded. A value the hub does not know is read as none. The
channel list carries it as `end_reason`, and STATE_SYNC names every dead channel `'killed'`
(PROTOCOL.md § 4.6).

### 3.5 Tab layouts

No table holds them: a tab's layout is kept in the browser's `localStorage` (SPEC.md § 3.4).

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
  code_hash  TEXT NOT NULL UNIQUE,                       -- HMAC-SHA-256 (hex) of the 8-digit code
  created_at TEXT NOT NULL,                              -- ISO 8601
  expires_at TEXT NOT NULL,                              -- ISO 8601 (60s from creation)
  used       INTEGER NOT NULL DEFAULT 0,                 -- boolean
  used_at    TEXT,                                       -- ISO 8601, set when redeemed
  used_by_ip TEXT                                        -- IP of the client that redeemed
);
```

The code itself is never stored. `code_hash` is keyed with 32 random bytes the hub draws at each
start and holds only in memory (SECURITY.md § 2.3), and verification looks a code up by its hash
under the running hub's key, through the index `UNIQUE` gives the column. A code an earlier run
issued can never match again, so the hub deletes the unredeemed ones as it starts. The code was
stored in plain text until #521.

### 3.8 Schema version

```sql
CREATE TABLE schema_version (
  version    INTEGER NOT NULL,
  applied_at TEXT NOT NULL
);

-- The baseline's version (§ 9.3)
INSERT INTO schema_version VALUES (21, datetime('now'));
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

Periodic screen state captures (`SnapshotScheduler`):

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Interval | 3s idle OR 5s forced, only after a change | Balance freshness vs write load |
| Trigger: idle | No OUTPUT received for 3s → request snapshot | Capture stable state |
| Trigger: forced | Every 5s while the screen keeps changing | Guarantee recent snapshot |
| Trigger: detach | On client detach → request snapshot, changed or not | Best state for reconnect |
| Kind | `snapshot` | Distinct from output chunks |

A change is OUTPUT or a resize since the last snapshot was asked for; a channel the hub starts
tracking counts as changed, and so does one whose snapshot request timed out. The idle and forced
triggers ask for nothing on a screen that has not changed: they used to ask every 5 s regardless,
and one idle channel stored 64,509 snapshots of the same screen in five days (#726).

**One snapshot per channel.** Storing a snapshot deletes the channel's previous one, in the same
transaction (`SpoolDAL.insertSnapshot`): nothing reads any but the newest (§ 7.3). Only the
previous one goes there; a backlog an earlier version left is cleared by GC (§ 7).

**Snapshot chunk data:**
```json
{
  "serialized": "<the agent's vt100 screen, as the escape sequences that draw it>",
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
  last_seq: the seq just before that snapshot's
  last_seen_at: when that snapshot was stored
}
```

It is written each time a snapshot is stored (`storeSnapshot`), and deleted with its channel.
Nothing reads it: an ATTACH, cached or not, finds the latest snapshot in spool.db itself
(`getLatestSnapshot`) and reads the tail after it, and GC goes by chunk age, size, the
channel's status and whether meta.db still has the channel (§ 7), never by this table.

## 7. Garbage Collection

### 7.1 Policy

The bounds are global: no host or channel setting changes them
(`packages/hub/src/session/spool-gc.ts`).

| Parameter | Default | Config key |
|-----------|---------|-----------|
| Max age of a chunk | 7 days | none (`GC_MAX_AGE_HOURS = 168`) |
| Max size per channel, its snapshot included | 10 MB | `[gc] max_size_per_channel_mb` |
| Retention of a dead channel | 24 hours | `[gc] dead_retention_hours` (0 = next run) |
| GC interval | 10 minutes | none; the first run is 10 minutes after the hub starts |
| Longest the GC holds the event loop at once | 25 ms, give or take one step | none (`SLICE_BUDGET_MS`) |

### 7.2 Algorithm

```
Every 10 minutes, unless the previous pass is still running:

1. Delete every chunk of each channel whose status is 'dead' and whose
   updated_at (meta.db) is older than dead_retention_hours, up to the
   highest seq it had when the pass judged it

2. For each channel in spool.db:
   a. If meta.db has no row for it, an orphan: a channel purged or deleted,
      or one whose host was deleted. Delete every chunk it had when the pass
      looked it up, and go on to the next channel
   b. Delete every snapshot older than its newest
   c. Walk down from its newest chunk, counting sizes, the newest snapshot
      first. The first chunk that is not a snapshot and is older than 7 days,
      or takes the channel past max_size_per_channel_mb, is the cut: it and
      every older chunk that is not a snapshot go

3. Run PRAGMA incremental_vacuum on spool.db, a bounded number of pages at a
   time, until the free list is empty
```

**Bounded steps.** better-sqlite3 is synchronous: whatever SQLite does, the hub's event loop waits
for, every terminal and request with it. So every step of a pass is bounded, and the pass yields
(`setImmediate`) once the next step could take its slice past the budget:

| Step | Bound |
|------|-------|
| A delete | One transaction of at most 256 chunks and about 1 MiB, by seq range on `idx_chunks_channel_seq`, from where the last one stopped |
| Whether a channel is an orphan (2a) | One primary-key lookup in meta.db, and one seek for its highest seq |
| A step of the walk (2c) | 512 chunks, their size read from the row header without loading the data |
| The next channel | One seek on `idx_chunks_channel_seq` |
| `incremental_vacuum` | 128 pages |

Nothing scans a channel's chunks to compute its size, and nothing deletes one row per scan. The
version before #726 did both, recomputing `SUM(LENGTH(data_blob))` before each output chunk it
evicted and excluding snapshots from eviction: on a channel holding 65,000 snapshots that was
0.8 deletions a second, eight minutes of frozen hub out of every ten, and every pass deleted all of
the channel's output while its snapshots kept growing the spool.

**Purges.** Purging a dead channel (`DELETE /api/channels/:id`, `DELETE /api/channels/dead`) deletes
its row in meta.db, then answers as it always did. Its chunks follow, deleted as step 2a deletes an
orphan's and followed by step 3, without waiting for the next pass (`SpoolGarbageCollector.purge`).
Passes and purges run one at a time, in the order asked: two side by side would each take a slice in
the same turn of the event loop. So the answer comes before the output is gone. The channel is
listed nowhere, and nothing reads its output any more: an ATTACH to a channel that is dead or
unknown never reads the spool. The spool shrinks over the next seconds, or once the pass already
running has ended. If the hub stops first, the next pass finds what is left
orphaned (2a). A purge used to delete a channel's whole history in one statement, inside the
request: up to 1.5 GB for one channel on a spool grown before #785 (#786).

Deleting a host (`DELETE /api/hosts/:id`) deletes its sessions, channels and `cache_index` rows in
meta.db, and nothing in spool.db: its channels' chunks are orphans, which the next pass deletes.
Before #786 the size cap kept each one's newest snapshot for ever.

A step may still be slow when it commits past `wal_autocheckpoint`: SQLite then checkpoints the WAL
in that commit, two fsyncs included, whatever wrote it. Clearing a 1.5 GB backlog takes about
twenty of them.

### 7.3 GC Safety

- Only the newest snapshot of a channel is ever read: an ATTACH answered from the spool replays it
  and the output after it (`buildAttachPayload`). No code reads an older snapshot, nor
  `cache_index` (§ 6), so step 2b deletes every other one, and storing a snapshot deletes the
  previous one (§ 5.2)
- Step 2 never deletes the newest snapshot: not past the age limit, not alone over the cap. It
  counts in the channel's size, so output goes first
- Output is kept, newest first, as long as it fits the cap and the age limit, whether or not it
  comes after the newest snapshot
- Only steps 1 and 2a, and a purge, empty a channel: one dead past its retention, or one meta.db no
  longer has. A chunk written after the pass judged it, by a channel brought back under its own id,
  has a higher seq and is not deleted
- There is no foreign key from spool.db to meta.db (§ 4.1). A channel is an orphan only if meta.db
  has no row for it when looked up, in the same step that reads its highest seq; no list of known
  ids is read beforehand, since a channel created during the pass would not be on it. The hub stores
  a channel's row before it tracks its output (a spawn, a restart, a restore after a hub restart),
  so a channel created during a pass has its row before its first chunk, and is never taken for an
  orphan
- A pass in progress when the hub stops ends before its next step
- Run incremental_vacuum (not full VACUUM) to avoid blocking writes

## 8. Data Access Patterns

### 8.1 Write Patterns

| Operation | Frequency | Database | Table |
|-----------|-----------|----------|-------|
| OUTPUT chunk write | Continuous (10s–100s/sec) | spool.db | chunks |
| Snapshot write, replacing the previous | Every 3-5s per channel whose screen changes | spool.db | chunks |
| Cache index update | Every snapshot write | meta.db | cache_index |
| Session/channel status | On state change | meta.db | sessions, channels |
| Host CRUD | Rare (user action) | meta.db | hosts |

A tab layout is not written here: the browser keeps it in `localStorage` (§ 3.5).

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
  Deleting a channel or a host deletes rows in meta.db only; GC deletes the chunks left behind (§ 7.2).
- **Reads:** No explicit transactions for reads (WAL provides snapshot isolation)

## 9. Migration Strategy

### 9.1 Version Tracking

Each DB has a `schema_version` table. On startup:

```
1. Open DB
2. Read schema_version.version
3. If version is from 1 to the first migration's number less one (a baseline, § 9.3):
   a. Refuse to start, naming the file and its version
4. If version < CURRENT_VERSION:
   a. Run migration scripts in order (v1→v2, v2→v3, ...)
   b. Update schema_version
5. If version > CURRENT_VERSION:
   a. Log "[storage] DB schema version ahead of latest migration - skipping"
   b. Open it as it is
```

Nothing refuses a newer schema: a hub that was downgraded runs on the database a later one
migrated. So a migration must not remove anything an older hub still uses, a column it names
in a statement above all; an unused column is left in place instead. This is the rule from the
first public release on. The baseline (§ 9.3), made before it, is the one exception.

### 9.2 Migration Files

```
packages/hub/src/storage/migrations/
├── meta/
│   ├── 021-baseline.sql
│   ├── 022-unpadded-ssh-pins.sql
│   ├── 023-discovered-default-shell.sql
│   └── ...
└── spool/
    ├── 001-initial.sql
    └── ...
```

Each migration is a **SQL file**, run inside a transaction. Files are discovered by numeric prefix (`001-`, `002-`) sorted lexicographically. The runner reads `schema_version.version`, then applies all files with number > current version in order. Each file name format: `NNN-description.sql` where NNN is zero-padded 3-digit integer.

### 9.3 The meta.db baseline

Before the first public release, the 21 migrations of `meta.db` were squashed into one file,
`021-baseline.sql`, which builds the schema they built and records version 21. It keeps that
number so that the runner leaves a database they brought to 21 as it is, rather than take it
for one ahead of every migration and skip each one that follows (§ 9.1). A new database comes
out at 21 with the baseline's schema, and the next migration is `022`.

A database those migrations left at a version from 1 to 20 cannot be brought up to date: the
migrations it lacks are gone, and the baseline applied over it would stop on a table it already
has. The hub refuses it before it applies anything, and stops, naming the file and its version,
which predates the first public release: move it aside to start fresh (#747). `spool.db`, whose
first migration is `001`, is never refused this way.

The baseline left out what nothing read: the hosts' `host_group`, the free-text group that
host groups replaced, `keep_alive_seconds` and `history_retention_days`, two host settings
removed because nothing read them (the SSH keepalive is fixed, SPEC.md § 5.5, and spool GC has
bounds of its own, § 7), and the `workspaces` table, which nothing used. A database the
migrations built keeps them until someone drops them by hand; the hub neither reads nor writes
them. `spool.db` was not squashed: it still has its one migration.

### 9.4 meta.db migrations after the baseline

| Migration | What it does |
|-----------|--------------|
| `022-unpadded-ssh-pins.sql` | Takes the base64 padding off the SSH pins a hub before #717 wrote, 0.14.3 included: `hosts.ssh_fingerprint` and `hosts.ssh_proxy_fingerprint`, when one is `SHA256:` and 43 base64 characters followed by `=`. The hub spells a key as OpenSSH prints it and compares pins as they are, so without it every host pinned before would report a changed key. Any other value is left as it is. A hub before #717, run again on the database, would see each of these pins, and each one pinned since, as a changed key. |
| `023-discovered-default-shell.sql` | Adds `hosts.discovered_default_shell`, where the default shell a host's agent reports in its HELLO goes from now on (#794). A hub before it wrote that shell into `default_shell` at every connection, over the Default Shell the user chose. What `default_shell` holds cannot say whose it is, so a host that has connected (`discovered_shells` set) has its value moved to the new column and `default_shell` emptied: each connection had written the agent's there, and one the user typed since the last would have been overwritten at the next. A host that never connected keeps it: no agent could have written it. A hub before #794, run again on the database, ignores the new column and writes the agent's default into `default_shell` again at the next connection. |

## 10. Backup & Restore

### 10.1 Backup

```bash
# Full backup (both DBs) — paths shown for Linux, see SPEC.md § 7 for Windows.
# Stop the hub first: a copy taken while it runs can miss what is still in the -wal file.
cp ~/.local/state/lasterm/meta.db backup/meta.db
cp ~/.local/state/lasterm/spool.db backup/spool.db

# Config-only backup (tiny, recommended for sync)
cp ~/.local/state/lasterm/meta.db backup/meta.db
cp ~/.config/lasterm/config.toml backup/config.toml
# spool.db is not regenerated from anything: leaving it out loses the terminals' output
# history and snapshots, and nothing else
```

**Online backup (while hub running):**
```sql
-- Using SQLite backup API (via better-sqlite3)
db.backup('backup/meta.db');
```

### 10.2 Workspace Export/Import

Not built: there is no `lasterm workspace` command, and the hub keeps no layout (§ 3.5).
Hosts can be imported from `~/.ssh/config` (`POST /api/hosts/import`, PROTOCOL.md § 6).

## 11. Data Lifecycle

```
Channel created (BORN)
  │
  ├─ Output flowing → chunks accumulate in spool.db
  ├─ Snapshots taken while the screen changes → each replaces the last
  ├─ cache_index updated with every snapshot
  │
  Channel LIVE → ORPHAN → LIVE (reconnect cycle)
  │
  Channel DEAD (PTY exited)
  │
  ├─ Data retained for dead_retention_hours (24 h by default)
  ├─ Scrollback still readable from spool.db
  │
  GC runs (every 10 min, § 7)
  │
  ├─ Snapshots but the newest deleted
  ├─ Output older than 7 days, or past max_size_per_channel_mb, deleted;
  │  newest snapshot kept
  │
  Channel dead for longer than dead_retention_hours
  │
  ├─ All its chunks deleted; its channel row and cache_index entry stay
  │  until the channel is deleted
  │
  Channel purged, or its host deleted
  │
  └─ Its rows deleted from meta.db at once; its chunks right after a purge,
     at the next GC pass after a host is deleted, in GC's bounded batches
```

## 12. Logs

Besides the two databases, Lasterm keeps logs, in the state directory unless the table says
otherwise. None is encrypted. Each is bounded except `agent-daemon.log`, which receives almost
nothing. What goes into a log, and what never does, is in CLAUDE.md (Logging) and SECURITY.md § 7.

| File | Written by | Bound |
|------|-----------|-------|
| `logs/hub.jsonl` | The hub: its security events (SECURITY.md § 7.1), and its diagnostics when started through `main.ts` | Moves to `hub.jsonl.old` at 10 MB, replacing the one before |
| `hub-daemon.log` | What `lasterm start --daemon` printed | Copied to `hub-daemon.log.old` and emptied at 10 MB |
| `hub.log` (the desktop's application data directory) | What the desktop's hub printed | Moves to `hub.log.old` at 10 MB |
| `logs/channels/` | Nothing: a hub started through `main.ts` makes the directory, and no hub writes a channel log into it (SPEC.md § 7) | — |
| `logs/agent-daemon.YYYY-MM-DD.jsonl` | An agent daemon, one file per UTC day it logs something | The `[logging] agent_files_kept` most recent files are kept (7 by default, `0` keeps all); older ones are deleted (below) |
| `agent-daemon.log` | What an agent daemon printed outside its log: a refused start, a panic, `systemd-run`'s complaint on a remote host | Not bounded. Every launch appends to it |

On a remote host the agent daemon's files are under that host's state directory
(`$XDG_STATE_HOME/lasterm`, or `~/.local/state/lasterm`), which only that host's user reads.

### 12.1 The agent daemon's log (#646)

A daemon writes one file per day (UTC), named by `tracing-appender`'s daily rotation:
`logs/agent-daemon.2026-09-29.jsonl`. A day with nothing to log has no file, so what is kept is
the most recent *days with activity*, not calendar days. At INFO a daemon logs its lifecycle and
little else; the count caps files, not bytes, and a daemon left at `trace` fills its day's file as
fast as it runs.

- **Kept:** the `agent_files_kept` most recent files, by the date in their name. The hub passes
  the number to every daemon it starts, local or remote, as `--log-files-kept`. A change in
  Settings reaches a daemon when it next starts; one already running keeps the number it was given.
- **Deleted:** when the daemon starts, and when a new day's file starts. Only regular files named
  `agent-daemon.YYYY-MM-DD.jsonl` are deleted; nothing else in `logs/`. A file that cannot be deleted (on Windows, one another program holds without sharing
  deletion) is said in a warning in the log, and tried again on the next of those occasions.
- **Never renamed.** Nothing moves a file aside: a rename that is refused would leave the daemon
  appending to a full file, which is the growth this replaced.
