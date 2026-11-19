-- Migration 029: the user and port a linked jump is reached with (#1047).
--
-- A `ProxyJump` that names a saved host and writes its own user or port
-- (`relay@gw:2200`) is reached as `ssh -l relay -p 2200 gw`: the saved host's
-- address and sign-in apply, the jump's user and port win. `ssh_proxy_user`
-- and `ssh_proxy_port` hold them beside `ssh_proxy_host_id`; NULL, which every
-- host already here gets, follows the saved host. A hub before #1047 reads the
-- hosts table with SELECT * and maps named fields, so it ignores the columns.

ALTER TABLE hosts ADD COLUMN ssh_proxy_user TEXT;
ALTER TABLE hosts ADD COLUMN ssh_proxy_port INTEGER;

INSERT INTO schema_version VALUES (29, datetime('now'));
