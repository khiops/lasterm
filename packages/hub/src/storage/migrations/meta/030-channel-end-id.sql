-- Migration 030: each end of a terminal gets an id (#932).
--
-- `channels.end_id` names the end a dead channel's row records: the hub gives a
-- new ULID each time it writes `dead` over a row that was not dead, keeps it
-- when the end is told again, and clears it when the terminal runs again. The
-- hub sends it with the end (CHANNEL_STATE) and with the refusal of an attach
-- on the ended terminal (CHANNEL_DEAD), so a window can tell an end it showed
-- from a newer one. Every row already here gets NULL: an end recorded before
-- end ids has none. A hub before #932 reads the channels table with SELECT *
-- and maps named fields, so it ignores the column.

ALTER TABLE channels ADD COLUMN end_id TEXT;

INSERT INTO schema_version VALUES (30, datetime('now'));
