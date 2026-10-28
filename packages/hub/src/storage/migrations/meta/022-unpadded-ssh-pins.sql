-- Migration 022: SSH host-key pins spelled as OpenSSH prints them (#717).
--
-- A hub before #717, 0.14.3 included, pinned a host key as `SHA256:` and the
-- base64 of its SHA-256 with the padding: 44 characters, the last one `=`. From
-- #717 on, the hub spells a key without it and compares pins as they are, so a
-- pin kept from then would read as another key, and every pinned host would
-- report a changed key it never had.
--
-- Both pins are rewritten: a host's own key, and the key of the jump given as a
-- spec, pinned on the host that jumps through it. A jump that is a host of its
-- own keeps its pin in its own row. Only that exact form loses its `=`: any
-- other value, and every other column (agent_sha256 is hex), is left as it is.

UPDATE hosts
SET ssh_fingerprint = substr(ssh_fingerprint, 1, 50)
WHERE length(ssh_fingerprint) = 51
  AND ssh_fingerprint GLOB 'SHA256:*='
  AND substr(ssh_fingerprint, 8, 43) NOT GLOB '*[^A-Za-z0-9+/]*';

UPDATE hosts
SET ssh_proxy_fingerprint = substr(ssh_proxy_fingerprint, 1, 50)
WHERE length(ssh_proxy_fingerprint) = 51
  AND ssh_proxy_fingerprint GLOB 'SHA256:*='
  AND substr(ssh_proxy_fingerprint, 8, 43) NOT GLOB '*[^A-Za-z0-9+/]*';

INSERT INTO schema_version VALUES (22, datetime('now'));
