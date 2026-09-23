-- Migration 020: a pairing code is stored as a keyed hash, never as the code (#521).
--
-- code_hash is an HMAC-SHA-256 of the 8-digit code, under a key the hub draws
-- when it starts and holds only in memory (SECURITY.md § 2.3). An unkeyed hash
-- of 10^8 possible codes would be as good as the code to anyone who read it.
--
-- The rows stored before this held the code in plain text, so they are dropped
-- rather than carried over. A code lives 60 seconds and is used once: those
-- still live are invalidated, and the rest were worth nothing. What a pairing
-- did is recorded in the security log (pairing.verified), not here.
--
-- The UNIQUE constraint indexes code_hash, which is what verification looks up.

DROP TABLE IF EXISTS pairing_codes;

CREATE TABLE pairing_codes (
  id         TEXT PRIMARY KEY,
  code_hash  TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0,
  used_at    TEXT,
  used_by_ip TEXT
);

INSERT INTO schema_version VALUES (20, datetime('now'));
