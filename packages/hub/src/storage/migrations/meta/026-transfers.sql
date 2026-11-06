-- Migration 026: uploads that survive a hub restart (#860, the second half of #833).
--
-- Until now an upload lived in the hub's memory only: a restart, a crash or an
-- update forgot it, and the hidden temporaries it was writing stayed on the
-- host. Two tables keep it from now on (STORAGE.md § 3.9): `transfers`, one row
-- per upload, and `transfer_items`, one row per file or folder of it. The hub
-- writes a state change at once, and a file's acknowledged bytes
-- (`acked_offset`, the contiguous prefix its host acknowledged) at most every
-- 2 s or 8 MiB, and when it quits. After a restart every upload still running
-- is `interrupted`, and a window may resume or discard it.
--
-- Nothing is removed or rewritten: only the two tables are added. A hub before
-- #860, run again on the database, never names them: it opens the database as
-- one ahead of its migrations, and keeps its uploads in memory as before. A
-- host it deletes takes its uploads' rows with it, through the cascades.
--
-- No column has a CHECK: the states and kinds are the hub's to read, and a later
-- one is added without rebuilding the table.

CREATE TABLE transfers (
  id          TEXT PRIMARY KEY,                                   -- ULID
  host_id     TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  -- The terminal it started from. No reference: an upload outlives its terminal.
  channel_id  TEXT NOT NULL,
  -- The paired device whose window started it, which holds the bytes. NULL on a hub without auth.
  token_id    TEXT,
  dest_dir    TEXT NOT NULL,                                      -- normalised for the host
  path_style  TEXT NOT NULL,                                      -- 'posix' | 'windows'
  direction   TEXT NOT NULL DEFAULT 'upload',                     -- 'upload'; 'download' later
  state       TEXT NOT NULL,                                      -- 'running' | 'interrupted' | 'done' | 'discarded'
  on_conflict TEXT NOT NULL,                                      -- 'ask' | 'replace' | 'keep_both' | 'skip'
  verify      INTEGER NOT NULL DEFAULT 0,                         -- SHA-256 over SSH commands
  signature   TEXT NOT NULL,                                      -- the tree's, for a drop that joins it
  reason      TEXT,                                               -- why the last resume did not go on
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX idx_transfers_host ON transfers(host_id, state);

CREATE TABLE transfer_items (
  transfer_id   TEXT NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
  id            INTEGER NOT NULL,                                 -- its index in TRANSFER_START's items
  parent_id     INTEGER,                                          -- the folder it is in; NULL at the top
  rel_path      TEXT NOT NULL,
  kind          TEXT NOT NULL,                                    -- 'file' | 'dir'
  size          INTEGER NOT NULL DEFAULT 0,
  mtime         INTEGER,                                          -- milliseconds since the epoch
  state         TEXT NOT NULL,
  acked_offset  INTEGER NOT NULL DEFAULT 0,
  temp_path     TEXT,                                             -- its temporary on the host, while unplaced
  temp_whole    INTEGER NOT NULL DEFAULT 0,                       -- every byte there and checked
  direct        INTEGER NOT NULL DEFAULT 0,                       -- written under its own name
  final_name    TEXT,                                             -- the name Keep both gave it
  resolution    TEXT,                                             -- a conflict's answer
  outcome       TEXT,
  verification  TEXT,
  existing_json TEXT,                                             -- what had its name, for a conflict
  type_clash    INTEGER NOT NULL DEFAULT 0,
  late          INTEGER NOT NULL DEFAULT 0,
  error_code    TEXT,
  reason        TEXT,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (transfer_id, id)
);

CREATE INDEX idx_transfer_items_state ON transfer_items(transfer_id, state);

INSERT INTO schema_version VALUES (26, datetime('now'));
