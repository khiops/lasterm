-- Migration 021: why a terminal ended, when the hub ended it itself (#592).
--
-- 'killed': someone stopped that terminal, or its session, on purpose. A pane
-- that finds it ended, at a reload or the next launch, keeps asking rather than
-- follow "When a terminal ends": a deliberate stop is never undone by a setting.
--
-- 'stopped': it ended with its agent, replaced, or with the hub, quitting.
-- Nobody aimed at it: found later, it follows the setting as a shell that
-- exited does.
--
-- Both used to travel only on the live CHANNEL_STATE report (#580), so an end
-- found afterwards could not be told apart from a shell that exited.
--
-- NULL for every other terminal: one running, and one that ended by itself or
-- that the hub found gone. Set with the dead status, cleared when it runs again.
--
-- The rows already dead keep NULL: why they ended was never recorded.

ALTER TABLE channels ADD COLUMN end_reason TEXT;

INSERT INTO schema_version VALUES (21, datetime('now'));
