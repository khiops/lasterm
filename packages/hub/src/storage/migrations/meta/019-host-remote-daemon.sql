-- Migration 019: whether this host may keep an agent of its own running (#79).
--
-- A remote agent reached through its socket outlives the SSH connection, which
-- is what lets a terminal survive a dropped link and a hub restart. It also
-- means a process left running on someone else's machine, and that is not the
-- same decision for a Raspberry Pi at home and for a customer's server.
--
-- NULL means "whatever [ssh] remote_daemon says", which is how a host that was
-- added before this column behaves, and how most hosts should stay. 1 and 0 are
-- an answer given for this host, and they win over the global one.

ALTER TABLE hosts ADD COLUMN ssh_remote_daemon INTEGER;

INSERT INTO schema_version VALUES (19, datetime('now'));
