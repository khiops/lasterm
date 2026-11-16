-- Migration 028: a connection timeout per host (#1034).
--
-- `connect_timeout_seconds` is how long each wait of a connection to the host
-- may last: the jump, the SSH server, reaching the agent, its HELLO. The API
-- stores a whole number of seconds from 20 to 120, or NULL. NULL, which every
-- host already here gets, takes `ConnectTimeout` from ~/.ssh/config when it is
-- 20 s or more, otherwise the hub's own limits, as before. A hub before #1034
-- reads the hosts table with SELECT * and maps named fields, so it ignores the
-- column.

ALTER TABLE hosts ADD COLUMN connect_timeout_seconds INTEGER;

INSERT INTO schema_version VALUES (28, datetime('now'));
