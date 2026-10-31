-- Migration 024: a host's launch profile override says whether its user set it (#800).
--
-- A host's default launch profile is a row of host_launch_profiles marked
-- `default`. Two hands write it: the user, through the hosts' profile routes
-- (Settings > Profiles > "Set as Default"), and the hub, which marks the profile
-- of the default shell the host's agent reports in its HELLO, at every
-- connection. Until #800 the hub's mark replaced the user's, so a default the
-- user set lasted only until the next connection.
--
-- From now on the hub marks one only where the host has none, or where the
-- one it has is its own mark from an earlier connection: that one follows the
-- agent when the agent's default shell changes, and one the user set never
-- does. `set_by_user` tells them apart: 1 for an override the user set, 0 for
-- one the hub made from what an agent reported.
--
-- Every row already here reads 0, the column's default, which is what each
-- default mark is: every connection marked the agent's, over any the user had
-- set. No row is rewritten. A hub before #800, run again on the database,
-- ignores the column and marks its agent's default at every connection, as it
-- did; a row it adds reads 0 too.

ALTER TABLE host_launch_profiles ADD COLUMN set_by_user INTEGER NOT NULL DEFAULT 0;

INSERT INTO schema_version VALUES (24, datetime('now'));
