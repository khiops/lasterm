-- Migration 023: the default shell a host's agent reports gets a column of its own (#794).
--
-- Until #794 the hub wrote the default shell a host's agent reports in its
-- HELLO into `default_shell`, at every connection. From now on it goes to
-- `discovered_default_shell`, beside `discovered_shells`: the hub marks its
-- launch profile as the host's default while the user has chosen none, and
-- asks for a login shell when a terminal on an SSH host runs it.
--
-- `default_shell` is read and written by nothing from #802 on: a host's
-- default is a launch profile. No released hub ever started a terminal from
-- it either, so the column is left as it is: it stays, as every column does
-- once released (STORAGE.md § 9.1).
--
-- A host with `discovered_shells` has connected, and each connection wrote its
-- agent's default into `default_shell`: that value is copied to the new
-- column, so the hub knows the agent's default before the host's next
-- connection. A host that never connected has no agent's default to copy.
--
-- `updated_at` is left as it is: nobody edited these hosts. A hub before #794,
-- run again on the database, ignores the new column and writes the agent's
-- default into `default_shell` at the next connection, as it always did.

ALTER TABLE hosts ADD COLUMN discovered_default_shell TEXT;

UPDATE hosts
SET discovered_default_shell = default_shell
WHERE discovered_shells IS NOT NULL;

INSERT INTO schema_version VALUES (23, datetime('now'));
