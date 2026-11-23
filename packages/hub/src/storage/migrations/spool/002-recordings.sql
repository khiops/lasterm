-- Session recordings (#80): a terminal's output, size changes and exit, kept
-- only until the user saves or discards them. Blocks hold asciicast v3 event
-- lines; the header is built at export from the row.
CREATE TABLE recordings (
  id                   TEXT PRIMARY KEY,
  channel_id           TEXT NOT NULL,
  host_label           TEXT NOT NULL,
  title                TEXT NOT NULL,
  started_at           TEXT NOT NULL,
  ended_at             TEXT,
  end_reason           TEXT
                       CHECK(end_reason IN ('stopped', 'exited', 'killed', 'restarted', 'gone', 'cap', 'interrupted', 'crashed')),
  cols                 INTEGER NOT NULL,
  rows                 INTEGER NOT NULL,
  duration_ms          INTEGER NOT NULL DEFAULT 0,
  bytes                INTEGER NOT NULL DEFAULT 0,
  unmarked_lost_bytes  INTEGER NOT NULL DEFAULT 0,
  deleting             INTEGER NOT NULL DEFAULT 0 CHECK(deleting IN (0, 1))
);

-- At most one open recording per terminal.
CREATE UNIQUE INDEX idx_recordings_open_channel ON recordings(channel_id) WHERE ended_at IS NULL;
-- The list (newest first, without the ones being deleted) and the deletions left to do.
CREATE INDEX idx_recordings_deleting_started ON recordings(deleting, started_at DESC, id DESC);

CREATE TABLE recording_blocks (
  recording_id  TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  data_blob     BLOB NOT NULL,
  PRIMARY KEY (recording_id, seq)
) WITHOUT ROWID;

INSERT INTO schema_version VALUES (2, datetime('now'));
