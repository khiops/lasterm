-- Migration 023: the default shell a host's agent reports gets a column of its own (#794).
--
-- `default_shell` is the Default Shell of Edit Host: the user's choice. Until
-- #794 the hub also wrote into it the default shell the host's agent reports in
-- its HELLO, at every connection, so what the user typed or cleared lasted only
-- until the next one. From now on the agent's goes to `discovered_default_shell`,
-- beside `discovered_shells`, and `default_shell` is the user's alone.
--
-- What `default_shell` holds today cannot say whose it is, so the host's history
-- decides:
--
-- - A host with `discovered_shells` has connected, and each connection wrote its
--   agent's default over `default_shell`. The value is the agent's: it moves to
--   the new column and leaves `default_shell` empty. One the user typed since the
--   last connection is moved too; the next connection of a hub before #794
--   would have overwritten it all the same.
-- - A host that never connected has no agent that could have written it: the
--   value can only be the user's, and stays.
--
-- `updated_at` is left as it is: nobody edited these hosts. A hub before #794,
-- run again on the database, ignores the new column and writes the agent's
-- default into `default_shell` again at the next connection.

ALTER TABLE hosts ADD COLUMN discovered_default_shell TEXT;

UPDATE hosts
SET discovered_default_shell = default_shell,
    default_shell = NULL
WHERE discovered_shells IS NOT NULL;

INSERT INTO schema_version VALUES (23, datetime('now'));
