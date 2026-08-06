import type { Channel, ChannelStatus } from "@lasterm/shared";
import type Database from "better-sqlite3";

import type { CreateChannelInput } from "./meta-types.js";

// ─── Row types ───────────────────────────────────────────────────────────────

interface ChannelRow {
	id: string;
	session_id: string;
	group_id: string | null;
	title: string | null;
	shell: string;
	args: string;
	cwd: string | null;
	env_json: string | null;
	cols: number;
	rows: number;
	status: string;
	exit_code: number | null;
	profile_json: string | null;
	is_welcome: number;
	icon: string | null;
	direct_process: number;
	dynamic_title: string | null;
	process_title: string | null;
	launch_profile_id: string | null;
	elevated: number;
	elevation_method: string | null;
	created_at: string;
	updated_at: string;
}

// ─── Row mapper ──────────────────────────────────────────────────────────────

function rowToChannel(row: ChannelRow): Channel {
	const ch: Channel = {
		id: row.id,
		sessionId: row.session_id,
		shell: row.shell,
		cols: row.cols,
		rows: row.rows,
		status: row.status as ChannelStatus,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
	if (row.group_id != null) ch.groupId = row.group_id;
	if (row.title != null) ch.title = row.title;
	if (row.cwd != null) ch.cwd = row.cwd;
	if (row.env_json != null) ch.envJson = row.env_json;
	if (row.exit_code != null) ch.exitCode = row.exit_code;
	if (row.profile_json != null) ch.profileJson = row.profile_json;
	if (row.is_welcome === 1) ch.isWelcome = true;
	if (row.icon != null) ch.icon = row.icon;
	if (row.direct_process === 1) ch.directProcess = true;
	if (row.dynamic_title != null) ch.dynamicTitle = row.dynamic_title;
	if (row.process_title != null) ch.processTitle = row.process_title;
	if (row.launch_profile_id != null) ch.launchProfileId = row.launch_profile_id;
	if (row.elevated === 1) ch.elevated = true;
	if (row.elevation_method != null) ch.elevationMethod = row.elevation_method;
	if (row.args && row.args !== "[]") {
		try {
			const parsed = JSON.parse(row.args) as string[];
			if (parsed.length > 0) ch.args = parsed;
		} catch {
			// Ignore malformed JSON — treat as no args
		}
	}
	return ch;
}

// ─── ChannelsDAL ─────────────────────────────────────────────────────────────

export class ChannelsDAL {
	constructor(private db: Database.Database) {}

	// ─── Channels ───────────────────────────────────────────────────────────

	createChannel(input: CreateChannelInput): void {
		const now = new Date().toISOString();
		this.db
			.prepare(
				`INSERT INTO channels (
				id, session_id, shell, args, cwd, title, status, cols, rows,
				icon, direct_process, launch_profile_id, elevated, elevation_method,
				created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				input.id,
				input.sessionId,
				input.shell ?? "/bin/sh",
				input.args ? JSON.stringify(input.args) : "[]",
				input.cwd ?? null,
				input.title ?? null,
				input.status,
				input.cols ?? 80,
				input.rows ?? 24,
				input.icon ?? null,
				input.directProcess ? 1 : 0,
				input.launchProfileId ?? null,
				input.elevated ? 1 : 0,
				input.elevationMethod ?? null,
				now,
				now,
			);
	}

	getChannel(id: string): Channel | undefined {
		const row = this.db.prepare("SELECT * FROM channels WHERE id = ?").get(id) as
			| ChannelRow
			| undefined;
		return row ? rowToChannel(row) : undefined;
	}

	/** Look up a channel along with its host info (needed for respawn). */
	getChannelWithHost(
		channelId: string,
	): { channel: Channel; hostId: string; hostType: string } | null {
		const row = this.db
			.prepare(
				`SELECT c.*, s.host_id, h.type AS host_type
				 FROM channels c
				 JOIN sessions s ON c.session_id = s.id
				 JOIN hosts h ON s.host_id = h.id
				 WHERE c.id = ?`,
			)
			.get(channelId) as (ChannelRow & { host_id: string; host_type: string }) | undefined;
		if (!row) return null;
		return {
			channel: rowToChannel(row),
			hostId: row.host_id,
			hostType: row.host_type,
		};
	}

	listChannels(sessionId?: string): Channel[] {
		const rows = (
			sessionId
				? this.db
						.prepare("SELECT * FROM channels WHERE session_id = ? ORDER BY created_at ASC")
						.all(sessionId)
				: this.db.prepare("SELECT * FROM channels ORDER BY created_at ASC").all()
		) as ChannelRow[];
		return rows.map(rowToChannel);
	}

	updateChannelStatus(id: string, status: ChannelStatus, exitCode?: number): void {
		const now = new Date().toISOString();
		if (exitCode !== undefined) {
			this.db
				.prepare("UPDATE channels SET status = ?, exit_code = ?, updated_at = ? WHERE id = ?")
				.run(status, exitCode, now, id);
		} else {
			this.db
				.prepare("UPDATE channels SET status = ?, updated_at = ? WHERE id = ?")
				.run(status, now, id);
		}
	}

	updateChannelDimensions(id: string, cols: number, rows: number): boolean {
		const now = new Date().toISOString();
		const result = this.db
			.prepare("UPDATE channels SET cols = ?, rows = ?, updated_at = ? WHERE id = ?")
			.run(cols, rows, now, id);
		return result.changes > 0;
	}

	updateChannelTitle(id: string, title: string | null): boolean {
		const now = new Date().toISOString();
		const result = this.db
			.prepare("UPDATE channels SET title = ?, updated_at = ? WHERE id = ?")
			.run(title, now, id);
		return result.changes > 0;
	}

	updateDynamicTitle(channelId: string, title: string): void {
		const now = new Date().toISOString();
		this.db
			.prepare("UPDATE channels SET dynamic_title = ?, updated_at = ? WHERE id = ?")
			.run(title, now, channelId);
	}

	updateProcessTitle(channelId: string, title: string): void {
		const now = new Date().toISOString();
		this.db
			.prepare("UPDATE channels SET process_title = ?, updated_at = ? WHERE id = ?")
			.run(title, now, channelId);
	}

	updateChannelConfig(
		channelId: string,
		config: {
			icon?: string | null;
			shell?: string | null;
			args?: string[];
			cwd?: string | null;
			directProcess?: boolean;
		},
	): boolean {
		const sets: string[] = [];
		const params: Record<string, unknown> = { id: channelId };

		if (config.icon !== undefined) {
			sets.push("icon = @icon");
			params.icon = config.icon;
		}
		if (config.shell !== undefined) {
			sets.push("shell = @shell");
			params.shell = config.shell ?? "/bin/sh";
		}
		if (config.args !== undefined) {
			sets.push("args = @args");
			params.args = JSON.stringify(config.args);
		}
		if (config.cwd !== undefined) {
			sets.push("cwd = @cwd");
			params.cwd = config.cwd;
		}
		if (config.directProcess !== undefined) {
			sets.push("direct_process = @directProcess");
			params.directProcess = config.directProcess ? 1 : 0;
		}

		if (sets.length === 0) return false;

		const now = new Date().toISOString();
		sets.push("updated_at = @updatedAt");
		params.updatedAt = now;

		const result = this.db
			.prepare(`UPDATE channels SET ${sets.join(", ")} WHERE id = @id`)
			.run(params);
		return result.changes > 0;
	}

	deleteChannel(id: string): void {
		this.db.prepare("DELETE FROM cache_index WHERE channel_id = ?").run(id);
		this.db.prepare("DELETE FROM channels WHERE id = ?").run(id);
	}

	// ─── Profile JSON helpers ─────────────────────────────────────────────────

	getChannelProfile(id: string): string | null {
		const row = this.db.prepare("SELECT profile_json FROM channels WHERE id = ?").get(id) as
			| { profile_json: string | null }
			| undefined;
		return row?.profile_json ?? null;
	}

	updateChannelProfile(id: string, profileJson: string | null): boolean {
		const now = new Date().toISOString();
		const result = this.db
			.prepare("UPDATE channels SET profile_json = ?, updated_at = ? WHERE id = ?")
			.run(profileJson, now, id);
		return result.changes > 0;
	}

	/** Set a channel as welcome tab for its host. Clears any previous welcome on the same host. */
	setWelcomeChannel(channelId: string): boolean {
		const row = this.db
			.prepare(
				`SELECT s.host_id FROM channels c
				 JOIN sessions s ON c.session_id = s.id
				 WHERE c.id = ?`,
			)
			.get(channelId) as { host_id: string } | undefined;
		if (!row) return false;

		const now = new Date().toISOString();
		const txn = this.db.transaction(() => {
			// Clear existing welcome for this host
			this.db
				.prepare(
					`UPDATE channels SET is_welcome = 0, updated_at = ?
					 WHERE is_welcome = 1
					   AND session_id IN (SELECT id FROM sessions WHERE host_id = ?)`,
				)
				.run(now, row.host_id);
			// Set new welcome
			this.db
				.prepare("UPDATE channels SET is_welcome = 1, updated_at = ? WHERE id = ?")
				.run(now, channelId);
		});
		txn();
		return true;
	}

	/** Clear welcome status for a channel. */
	clearWelcomeChannel(channelId: string): boolean {
		const now = new Date().toISOString();
		const result = this.db
			.prepare("UPDATE channels SET is_welcome = 0, updated_at = ? WHERE id = ?")
			.run(now, channelId);
		return result.changes > 0;
	}

	/** Get the welcome channel for a host (if any). */
	getWelcomeChannel(hostId: string): Channel | undefined {
		const row = this.db
			.prepare(
				`SELECT c.* FROM channels c
				 JOIN sessions s ON c.session_id = s.id
				 WHERE s.host_id = ? AND c.is_welcome = 1
				 LIMIT 1`,
			)
			.get(hostId) as ChannelRow | undefined;
		return row ? rowToChannel(row) : undefined;
	}

	markAllChannelsDead(): number {
		const now = new Date().toISOString();
		const result = this.db
			.prepare("UPDATE channels SET status = 'dead', updated_at = ? WHERE status != 'dead'")
			.run(now);
		return result.changes;
	}

	/** Channels that were alive (not dead) when the hub last exited, with host info. */
	listAliveChannelsWithHost(): Array<{
		id: string;
		sessionId: string;
		shell: string;
		args: string[];
		cwd: string | null;
		cols: number;
		rows: number;
		status: string;
		hostId: string;
		hostType: string;
		directProcess: boolean;
	}> {
		const rows = this.db
			.prepare(
				`SELECT c.id, c.session_id, c.shell, c.args, c.cwd, c.cols, c.rows,
				        c.status, c.direct_process,
				        s.host_id, h.type AS host_type
				 FROM channels c
				 JOIN sessions s ON c.session_id = s.id
				 JOIN hosts h ON s.host_id = h.id
				 WHERE c.status != 'dead'`,
			)
			.all() as Array<{
			id: string;
			session_id: string;
			shell: string;
			args: string;
			cwd: string | null;
			cols: number;
			rows: number;
			status: string;
			direct_process: number;
			host_id: string;
			host_type: string;
		}>;
		return rows.map((r) => {
			let args: string[] = [];
			try {
				args = JSON.parse(r.args) as string[];
			} catch {
				// ignore
			}
			return {
				id: r.id,
				sessionId: r.session_id,
				shell: r.shell,
				args,
				cwd: r.cwd,
				cols: r.cols,
				rows: r.rows,
				status: r.status,
				hostId: r.host_id,
				hostType: r.host_type,
				directProcess: r.direct_process === 1,
			};
		});
	}

	/** Mark all non-dead channels for a host as orphan. */
	markHostChannelsOrphan(hostId: string): number {
		const now = new Date().toISOString();
		const result = this.db
			.prepare(
				`UPDATE channels SET status = 'orphan', updated_at = ?
				 WHERE status != 'dead'
				   AND session_id IN (SELECT id FROM sessions WHERE host_id = ?)`,
			)
			.run(now, hostId);
		return result.changes;
	}

	/** Dead channels whose updated_at is older than `before` (ISO 8601). */
	listStaleDeadChannelIds(before: string): string[] {
		return this.db
			.prepare("SELECT id FROM channels WHERE status = 'dead' AND updated_at < ?")
			.all(before)
			.map((r) => (r as { id: string }).id);
	}

	// ─── Cache Index ─────────────────────────────────────────────────────────

	updateCacheIndex(channelId: string, snapshotChunkId: string, lastSeq: number): void {
		const now = new Date().toISOString();
		this.db
			.prepare(
				`INSERT INTO cache_index (channel_id, last_snapshot_chunk_id, last_seq, last_seen_at)
				VALUES (?, ?, ?, ?)
				ON CONFLICT(channel_id) DO UPDATE SET
					last_snapshot_chunk_id = excluded.last_snapshot_chunk_id,
					last_seq = excluded.last_seq,
					last_seen_at = excluded.last_seen_at`,
			)
			.run(channelId, snapshotChunkId, lastSeq, now);
	}
}
