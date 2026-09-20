-- Migration 018: reaching a host through another one (ProxyJump).
--
-- A jump is named in one of two ways, never both. `ssh_proxy_host_id` points at
-- a host this hub already knows, which brings its own auth and its own pinned
-- host key. `ssh_proxy_spec` holds a `user@host:port` for a bastion that is not
-- one — the form ~/.ssh/config uses — which authenticates through the SSH agent
-- and has no row of its own to pin a key on, so `ssh_proxy_fingerprint` pins it
-- here, on the host that jumps through it.

ALTER TABLE hosts ADD COLUMN ssh_proxy_host_id TEXT REFERENCES hosts(id) ON DELETE SET NULL;
ALTER TABLE hosts ADD COLUMN ssh_proxy_spec TEXT;
ALTER TABLE hosts ADD COLUMN ssh_proxy_fingerprint TEXT;

INSERT INTO schema_version VALUES (18, datetime('now'));
