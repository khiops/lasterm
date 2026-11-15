-- Migration 027: give a sign-in method to each SSH host stored without one (#917).
--
-- An SSH host created through the API or the CLI without `ssh_auth`, or imported
-- from `~/.ssh/config` while no SSH agent answered, was stored with none. The hub
-- then read it two ways: as key auth when connecting to it, and as the agent when
-- going through it to reach another host.
--
-- From now on POST /api/hosts, the import, and a PUT that turns a local host with
-- no method into an SSH one store a method when none is sent: `key` when the key
-- path is not blank, otherwise `agent`, as an import reads an entry with or
-- without an `IdentityFile`. The readers no longer pick one: they refuse an SSH
-- host without a method.
--
-- An SSH host already here without a method is given one by the same rule. A key
-- path made only of ASCII whitespace (tab, LF, VT, FF, CR, space) is blank, as
-- the hub's own test says (`isBlankKeyPath`). `updated_at` is left as it is:
-- the host's user changed nothing. A local host is not touched. A hub before
-- #917, run again on the database, reads each method as stored.

UPDATE hosts
SET ssh_auth = CASE
  WHEN trim(coalesce(ssh_key_path, ''), char(9, 10, 11, 12, 13, 32)) <> '' THEN 'key'
  ELSE 'agent'
END
WHERE type = 'ssh' AND ssh_auth IS NULL;

INSERT INTO schema_version VALUES (27, datetime('now'));
