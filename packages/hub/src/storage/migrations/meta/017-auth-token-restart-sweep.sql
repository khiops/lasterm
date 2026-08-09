-- Migration 017: distinguish restart invalidation from operator revocation.
-- Pairing-issued tokens are marked swept on each hub startup; revoked_at
-- remains reserved for an explicit operator revocation.

ALTER TABLE auth_tokens ADD COLUMN swept_at TEXT;

INSERT INTO schema_version VALUES (17, datetime('now'));
