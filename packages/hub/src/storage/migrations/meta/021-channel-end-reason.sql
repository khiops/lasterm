-- Migration 021: why a terminal ended, when the hub ended it on purpose (#592).
--
-- 'destroyed': someone killed it, closed its session, replaced its agent or
-- quit the hub (#580). A pane that finds such a terminal ended, at a reload or
-- the next launch, keeps asking rather than follow "When a terminal ends": a
-- deliberate stop is never undone by a setting. It used to travel only on the
-- live CHANNEL_STATE report, so an end found afterwards could not be told apart
-- from a shell that exited.
--
-- NULL for every other terminal: one running, and one that ended by itself or
-- that the hub found gone. Set with the dead status, cleared when it runs again.
--
-- The rows already dead keep NULL: why they ended was never recorded.

ALTER TABLE channels ADD COLUMN end_reason TEXT;

INSERT INTO schema_version VALUES (21, datetime('now'));
