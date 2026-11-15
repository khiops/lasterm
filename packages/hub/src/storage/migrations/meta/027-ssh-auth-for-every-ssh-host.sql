-- Migration 027: every SSH host is stored with the method it signs in with (#917).
--
-- A host created through the API or the CLI without `ssh_auth`, or imported from
-- `~/.ssh/config` while no SSH agent answered, was stored with none. The hub then
-- read it two ways: as key auth when connecting to it, and as the agent when
-- going through it to reach another host.
--
-- From now on the hub stores a method whenever an SSH host is written without
-- one: `key` when it has a key path, otherwise `agent`, as an import reads an
-- entry with or without an `IdentityFile`. The readers no longer pick one.
--
-- An SSH host already here without a method is given it by the same rule. A key
-- path made only of ASCII whitespace (tab, LF, VT, FF, CR, space) names no file,
-- as the hub's own test says (`isBlankKeyPath`). `updated_at` is left as it is:
-- the host's user changed nothing. A local host is not touched. A hub before
-- #917, run again on the database, reads each method as stored.

UPDATE hosts
SET ssh_auth = CASE
  WHEN trim(coalesce(ssh_key_path, ''), char(9, 10, 11, 12, 13, 32)) <> '' THEN 'key'
  ELSE 'agent'
END
WHERE type = 'ssh' AND ssh_auth IS NULL;

INSERT INTO schema_version VALUES (27, datetime('now'));
