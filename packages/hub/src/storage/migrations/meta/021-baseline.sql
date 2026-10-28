-- Baseline: the schema migrations 001 to 021 built, as one file, before the first
-- public release (STORAGE.md § 9.3).
--
-- It keeps version 21, so a database those migrations brought to 21 is left as it
-- is, and the next migration is 022. Left out, as nothing reads them: the hosts'
-- host_group, keep_alive_seconds and history_retention_days, and the workspaces
-- table. Every other column is defined, and ordered, as the migrations left it.

CREATE TABLE host_groups (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  color      TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_host_groups_sort ON host_groups(sort_order);

CREATE TABLE hosts (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL CHECK(type IN ('local', 'ssh')),
  label       TEXT NOT NULL UNIQUE,
  ssh_host    TEXT,
  ssh_port    INTEGER DEFAULT 22,
  ssh_auth    TEXT CHECK(ssh_auth IN ('agent', 'key', 'password')),
  ssh_key_path TEXT,
  icon_type   TEXT NOT NULL DEFAULT 'auto'
              CHECK(icon_type IN ('auto', 'emoji', 'image')),
  icon_value  TEXT,
  color       TEXT,
  profile_json TEXT,
  trust_remote_hints TEXT NOT NULL DEFAULT 'apply'
              CHECK(trust_remote_hints IN ('apply', 'ask', 'ignore')),
  default_shell TEXT,
  default_cwd   TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  ssh_config_host TEXT DEFAULT NULL,
  ssh_user TEXT DEFAULT NULL,
  host_group_id TEXT REFERENCES host_groups(id) ON DELETE SET NULL,
  discovered_shells TEXT,
  discovered_shells_at TEXT,
  elevation_method TEXT
    CHECK(elevation_method IS NULL OR elevation_method IN ('sudo','doas','pkexec','gsudo','custom')),
  custom_command TEXT,
  os TEXT CHECK(os IS NULL OR os IN ('linux', 'darwin', 'windows')),
  arch TEXT CHECK(arch IS NULL OR arch IN ('x64', 'arm64')),
  ssh_fingerprint TEXT,
  agent_sha256 TEXT DEFAULT NULL,
  -- A jump is named in one of two ways, never both: `ssh_proxy_host_id`, a host
  -- this hub knows, with its own auth and pinned key; or `ssh_proxy_spec`, a
  -- `user@host:port` as ~/.ssh/config writes it, whose key `ssh_proxy_fingerprint`
  -- pins here, since it has no row of its own.
  ssh_proxy_host_id TEXT REFERENCES hosts(id) ON DELETE SET NULL,
  ssh_proxy_spec TEXT,
  ssh_proxy_fingerprint TEXT,
  -- Whether this host may keep an agent of its own running (#79). NULL follows
  -- [ssh] remote_daemon; 1 and 0 are an answer given for this host.
  ssh_remote_daemon INTEGER
);

CREATE TABLE channel_groups (
  id         TEXT PRIMARY KEY,
  host_id    TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  collapsed  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_groups_host ON channel_groups(host_id, sort_order);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  host_id    TEXT NOT NULL REFERENCES hosts(id),
  status     TEXT NOT NULL DEFAULT 'starting'
             CHECK(status IN ('starting', 'active', 'detached',
                              'disconnected', 'closed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_sessions_host   ON sessions(host_id);
CREATE INDEX idx_sessions_status ON sessions(status);

CREATE TABLE launch_profiles (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL UNIQUE COLLATE NOCASE,
	shell TEXT NOT NULL,
	args_json TEXT,
	cwd TEXT,
	env_json TEXT,
	mode TEXT NOT NULL DEFAULT 'shell' CHECK(mode IN ('shell', 'process')),
	elevated INTEGER NOT NULL DEFAULT 0,
	supported_os TEXT NOT NULL DEFAULT 'any'
		CHECK(supported_os IN ('linux', 'darwin', 'windows', 'any')),
	icon_type TEXT NOT NULL DEFAULT 'auto'
		CHECK(icon_type IN ('auto', 'emoji', 'image')),
	icon_value TEXT,
	color TEXT,
	profile_overrides_json TEXT,
	sort_order INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE INDEX idx_launch_profiles_sort ON launch_profiles(sort_order, name);

CREATE TABLE host_launch_profiles (
	host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
	profile_id TEXT NOT NULL REFERENCES launch_profiles(id) ON DELETE CASCADE,
	override_type TEXT NOT NULL CHECK(override_type IN ('pin', 'hide', 'default')),
	sort_order INTEGER,
	PRIMARY KEY (host_id, profile_id)
);

CREATE UNIQUE INDEX idx_hlp_one_default_per_host
	ON host_launch_profiles(host_id) WHERE override_type = 'default';

CREATE TABLE channels (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  group_id    TEXT REFERENCES channel_groups(id) ON DELETE SET NULL,
  title       TEXT,
  shell       TEXT NOT NULL,
  cwd         TEXT,
  env_json    TEXT,
  cols        INTEGER NOT NULL DEFAULT 80,
  rows        INTEGER NOT NULL DEFAULT 24,
  status      TEXT NOT NULL DEFAULT 'born'
              CHECK(status IN ('born', 'live', 'orphan', 'dead')),
  exit_code   INTEGER,
  profile_json TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  is_welcome INTEGER NOT NULL DEFAULT 0,
  icon TEXT DEFAULT NULL,
  args TEXT NOT NULL DEFAULT '[]',
  direct_process INTEGER NOT NULL DEFAULT 0,
  dynamic_title TEXT DEFAULT NULL,
  process_title TEXT DEFAULT NULL,
  launch_profile_id TEXT REFERENCES launch_profiles(id) ON DELETE SET NULL,
  elevated INTEGER NOT NULL DEFAULT 0,
  elevation_method TEXT,
  -- Why a terminal ended, when the hub ended it itself (#592): 'killed', stopped
  -- on purpose, or 'stopped', with its agent or the hub. NULL otherwise.
  end_reason TEXT
);

CREATE INDEX idx_channels_session ON channels(session_id);
CREATE INDEX idx_channels_status  ON channels(status);
CREATE INDEX idx_channels_group   ON channels(group_id);
CREATE INDEX idx_channels_welcome ON channels(is_welcome) WHERE is_welcome = 1;
CREATE INDEX idx_channels_launch_profile_id ON channels(launch_profile_id);

CREATE TABLE cache_index (
  channel_id             TEXT PRIMARY KEY REFERENCES channels(id),
  last_snapshot_chunk_id TEXT,
  last_seq               INTEGER NOT NULL DEFAULT 0,
  last_seen_at           TEXT NOT NULL
);

-- A pairing code is stored as a keyed hash, never as the code (#521, SECURITY.md § 2.3).
CREATE TABLE pairing_codes (
  id         TEXT PRIMARY KEY,
  code_hash  TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0,
  used_at    TEXT,
  used_by_ip TEXT
);

-- The primary token (auth.json) is the row 'primary'; the pairing flow adds the others.
-- revoked_at is an operator's revocation, swept_at the hub restart that invalidated it.
CREATE TABLE auth_tokens (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  label        TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  expires_at   TEXT,          -- NULL = never expires (the primary token)
  revoked_at   TEXT,          -- NULL = active
  last_used_at TEXT,
  swept_at     TEXT
);

CREATE INDEX idx_auth_tokens_hash ON auth_tokens(token_hash);

-- Per-IP pairing verification attempts, kept across restarts.
CREATE TABLE pair_rate_limits (
  ip           TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL,
  PRIMARY KEY (ip)
);

CREATE TABLE schema_version (
  version    INTEGER NOT NULL,
  applied_at TEXT NOT NULL
);

INSERT INTO schema_version VALUES (21, datetime('now'));
