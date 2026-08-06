import type {
	ElevationMethod,
	Host,
	HostArch,
	HostGroup,
	HostOs,
	SshAuthMethod,
} from "@lasterm/shared";
import { generateId } from "@lasterm/shared";
import type Database from "better-sqlite3";

import type { CreateHostInput } from "./meta-types.js";

// ─── Row types ───────────────────────────────────────────────────────────────

interface HostRow {
	id: string;
	type: string;
	label: string;
	ssh_host: string | null;
	ssh_port: number | null;
	ssh_auth: string | null;
	ssh_key_path: string | null;
	icon_type: string;
	icon_value: string | null;
	color: string | null;
	profile_json: string | null;
	trust_remote_hints: string;
	default_shell: string | null;
	default_cwd: string | null;
	host_group: string | null;
	host_group_id: string | null;
	sort_order: number;
	ssh_config_host: string | null;
	ssh_user: string | null;
	keep_alive_seconds: number;
	history_retention_days: number;
	discovered_shells: string | null;
	discovered_shells_at: string | null;
	elevation_method: string | null;
	custom_command: string | null;
	os: string | null;
	arch: string | null;
	agent_sha256: string | null;
	ssh_fingerprint: string | null;
	created_at: string;
	updated_at: string;
}

interface HostGroupRow {
	id: string;
	name: string;
	sort_order: number;
	color: string | null;
	created_at: string;
	updated_at: string;
}

// ─── Row mappers ─────────────────────────────────────────────────────────────

function rowToHost(row: HostRow): Host {
	const host: Host = {
		id: row.id,
		type: row.type as Host["type"],
		label: row.label,
		iconType: row.icon_type as Host["iconType"],
		trustRemoteHints: row.trust_remote_hints as Host["trustRemoteHints"],
		sortOrder: row.sort_order,
		keepAliveSeconds: row.keep_alive_seconds,
		historyRetentionDays: row.history_retention_days,
		os: row.os as HostOs | null,
		arch: row.arch as HostArch | null,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
	if (row.ssh_host != null) host.sshHost = row.ssh_host;
	if (row.ssh_port != null) host.sshPort = row.ssh_port;
	if (row.ssh_auth != null) host.sshAuth = row.ssh_auth as SshAuthMethod;
	if (row.ssh_key_path != null) host.sshKeyPath = row.ssh_key_path;
	if (row.icon_value != null) host.iconValue = row.icon_value;
	if (row.color != null) host.color = row.color;
	if (row.profile_json != null) host.profileJson = row.profile_json;
	if (row.default_shell != null) host.defaultShell = row.default_shell;
	if (row.default_cwd != null) host.defaultCwd = row.default_cwd;
	if (row.host_group != null) host.hostGroup = row.host_group;
	if (row.host_group_id != null) host.hostGroupId = row.host_group_id;
	if (row.ssh_config_host != null) host.sshConfigHost = row.ssh_config_host;
	if (row.ssh_user != null) host.sshUser = row.ssh_user;
	if (row.discovered_shells != null) {
		try {
			host.discoveredShells = JSON.parse(row.discovered_shells) as string[];
		} catch {
			// ignore malformed JSON
		}
	}
	if (row.discovered_shells_at != null) host.discoveredShellsAt = row.discovered_shells_at;
	if (row.elevation_method != null) host.elevationMethod = row.elevation_method as ElevationMethod;
	if (row.custom_command != null) host.customCommand = row.custom_command;
	if (row.agent_sha256 != null) host.agentSha256 = row.agent_sha256;
	// ssh_fingerprint is always set (null = not yet seen)
	host.sshFingerprint = row.ssh_fingerprint;
	return host;
}

function rowToHostGroup(row: HostGroupRow): HostGroup {
	return {
		id: row.id,
		name: row.name,
		sortOrder: row.sort_order,
		color: row.color,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

// ─── HostsDAL ────────────────────────────────────────────────────────────────

export class HostsDAL {
	constructor(private db: Database.Database) {}

	// ─── Hosts ──────────────────────────────────────────────────────────────

	createHost(input: CreateHostInput): Host {
		const now = new Date().toISOString();
		const id = generateId();

		this.db
			.prepare(
				`INSERT INTO hosts (
				id, type, label, ssh_host, ssh_port, ssh_auth, ssh_key_path,
				icon_type, icon_value, color, profile_json, trust_remote_hints,
				default_shell, default_cwd,
				host_group, host_group_id, sort_order, ssh_config_host, ssh_user,
				keep_alive_seconds, history_retention_days,
				elevation_method, custom_command,
				os, arch,
				created_at, updated_at
			) VALUES (
				?, ?, ?, ?, ?, ?, ?,
				?, ?, ?, ?, ?,
				?, ?,
				?, ?, ?, ?, ?,
				?, ?,
				?, ?,
				?, ?,
				?, ?
			)`,
			)
			.run(
				id,
				input.type,
				input.label,
				input.sshHost ?? null,
				input.sshPort ?? null,
				input.sshAuth ?? null,
				input.sshKeyPath ?? null,
				input.iconType ?? "auto",
				input.iconValue ?? null,
				input.color ?? null,
				input.profileJson ?? null,
				input.trustRemoteHints ?? "apply",
				input.defaultShell ?? null,
				input.defaultCwd ?? null,
				input.hostGroup ?? null,
				input.hostGroupId ?? null,
				input.sortOrder ?? 0,
				input.sshConfigHost ?? null,
				input.sshUser ?? null,
				input.keepAliveSeconds ?? 60,
				input.historyRetentionDays ?? 30,
				input.elevationMethod ?? null,
				input.customCommand ?? null,
				input.os ?? null,
				input.arch ?? null,
				now,
				now,
			);

		return this.getHost(id) as Host;
	}

	getHost(id: string): Host | undefined {
		const row = this.db.prepare("SELECT * FROM hosts WHERE id = ?").get(id) as HostRow | undefined;
		return row ? rowToHost(row) : undefined;
	}

	getHostByLabel(label: string): Host | undefined {
		const row = this.db.prepare("SELECT * FROM hosts WHERE label = ?").get(label) as
			| HostRow
			| undefined;
		return row ? rowToHost(row) : undefined;
	}

	listHosts(limit?: number, offset?: number): Host[] {
		const sql =
			limit !== undefined
				? `SELECT * FROM hosts ORDER BY
				CASE WHEN type = 'local' THEN 0 ELSE 1 END,
				COALESCE(host_group, '~') ASC,
				sort_order ASC LIMIT ? OFFSET ?`
				: `SELECT * FROM hosts ORDER BY
				CASE WHEN type = 'local' THEN 0 ELSE 1 END,
				COALESCE(host_group, '~') ASC, -- '~' sorts after all alphanumeric chars in ASCII, placing ungrouped hosts last
				sort_order ASC`;
		const rows = (
			limit !== undefined
				? this.db.prepare(sql).all(limit, offset ?? 0)
				: this.db.prepare(sql).all()
		) as HostRow[];
		return rows.map(rowToHost);
	}

	countHosts(): number {
		const row = this.db.prepare("SELECT COUNT(*) AS n FROM hosts").get() as { n: number };
		return row.n;
	}

	updateHost(id: string, input: Partial<CreateHostInput>): Host {
		const now = new Date().toISOString();

		const fieldMap: Record<string, string> = {
			type: "type",
			label: "label",
			sshHost: "ssh_host",
			sshPort: "ssh_port",
			sshAuth: "ssh_auth",
			sshKeyPath: "ssh_key_path",
			iconType: "icon_type",
			iconValue: "icon_value",
			color: "color",
			profileJson: "profile_json",
			trustRemoteHints: "trust_remote_hints",
			defaultShell: "default_shell",
			defaultCwd: "default_cwd",
			hostGroup: "host_group",
			hostGroupId: "host_group_id",
			sortOrder: "sort_order",
			sshConfigHost: "ssh_config_host",
			sshUser: "ssh_user",
			keepAliveSeconds: "keep_alive_seconds",
			historyRetentionDays: "history_retention_days",
			elevationMethod: "elevation_method",
			customCommand: "custom_command",
			os: "os",
			arch: "arch",
		};

		const setClauses: string[] = ["updated_at = ?"];
		const values: unknown[] = [now];

		for (const [camel, snake] of Object.entries(fieldMap)) {
			if (camel in input) {
				setClauses.push(`${snake} = ?`);
				const val = input[camel as keyof CreateHostInput];
				values.push(val !== undefined ? val : null);
			}
		}

		values.push(id);

		this.db.prepare(`UPDATE hosts SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);

		const updated = this.getHost(id);
		if (!updated) {
			throw new Error(`Host not found after update: ${id}`);
		}
		return updated;
	}

	updateHostOsArch(id: string, os: HostOs, arch: HostArch): void {
		const now = new Date().toISOString();
		this.db
			.prepare("UPDATE hosts SET os = ?, arch = ?, updated_at = ? WHERE id = ?")
			.run(os, arch, now, id);
	}

	updateHostAgentSha256(id: string, sha256: string | null): void {
		const now = new Date().toISOString();
		this.db
			.prepare("UPDATE hosts SET agent_sha256 = ?, updated_at = ? WHERE id = ?")
			.run(sha256, now, id);
	}

	getHostAgentSha256(id: string): string | null {
		const row = this.db.prepare("SELECT agent_sha256 FROM hosts WHERE id = ?").get(id) as
			| { agent_sha256: string | null }
			| undefined;
		return row?.agent_sha256 ?? null;
	}

	/** Return the stored SSH host key fingerprint for a host, or null if never seen. */
	getHostFingerprint(hostId: string): string | null {
		const row = this.db.prepare("SELECT ssh_fingerprint FROM hosts WHERE id = ?").get(hostId) as
			| { ssh_fingerprint: string | null }
			| undefined;
		return row?.ssh_fingerprint ?? null;
	}

	/** Persist a trusted SSH host key fingerprint (SHA256:<base64>) for a host. */
	updateHostFingerprint(hostId: string, fingerprint: string): void {
		const now = new Date().toISOString();
		this.db
			.prepare("UPDATE hosts SET ssh_fingerprint = ?, updated_at = ? WHERE id = ?")
			.run(fingerprint, now, hostId);
	}

	deleteHost(id: string): boolean {
		const result = this.db.prepare("DELETE FROM hosts WHERE id = ?").run(id);
		return result.changes > 0;
	}

	importHosts(inputs: CreateHostInput[]): Host[] {
		const txn = this.db.transaction(() => {
			return inputs.map((input) => this.createHost(input));
		});
		return txn();
	}

	reorderHosts(groupId: string | null, hostIds: string[]): void {
		const txn = this.db.transaction(() => {
			for (let i = 0; i < hostIds.length; i++) {
				this.db
					.prepare(
						"UPDATE hosts SET sort_order = ?, host_group_id = ?, updated_at = ? WHERE id = ?",
					)
					.run(i, groupId, new Date().toISOString(), hostIds[i]);
			}
		});
		txn();
	}

	duplicateHost(id: string): Host | null {
		const original = this.getHost(id);
		if (!original) return null;
		if (original.type === "local") return null; // cannot duplicate local host

		// Find unique label: "label-copy", "label-copy-2", etc.
		let suffix = "-copy";
		let attempt = 1;
		while (this.getHostByLabel(original.label + suffix)) {
			attempt++;
			suffix = `-copy-${attempt}`;
		}

		return this.createHost({
			type: original.type,
			label: original.label + suffix,
			...(original.sshHost !== undefined && { sshHost: original.sshHost }),
			...(original.sshPort !== undefined && { sshPort: original.sshPort }),
			...(original.sshAuth !== undefined && { sshAuth: original.sshAuth }),
			...(original.sshKeyPath !== undefined && { sshKeyPath: original.sshKeyPath }),
			...(original.iconType !== undefined && { iconType: original.iconType }),
			...(original.iconValue !== undefined && { iconValue: original.iconValue }),
			...(original.color !== undefined && { color: original.color }),
			...(original.profileJson !== undefined && { profileJson: original.profileJson }),
			...(original.trustRemoteHints !== undefined && {
				trustRemoteHints: original.trustRemoteHints,
			}),
			...(original.defaultShell !== undefined && { defaultShell: original.defaultShell }),
			...(original.defaultCwd !== undefined && { defaultCwd: original.defaultCwd }),
			...(original.hostGroup != null && { hostGroup: original.hostGroup }),
			...(original.sshConfigHost != null && { sshConfigHost: original.sshConfigHost }),
			...(original.sshUser != null && { sshUser: original.sshUser }),
			keepAliveSeconds: original.keepAliveSeconds,
			historyRetentionDays: original.historyRetentionDays,
		});
	}

	// ─── Host Groups (first-class) ───────────────────────────────────────────

	listHostGroupEntities(limit?: number, offset?: number): HostGroup[] {
		const rows = (
			limit !== undefined
				? this.db
						.prepare("SELECT * FROM host_groups ORDER BY sort_order ASC, name ASC LIMIT ? OFFSET ?")
						.all(limit, offset ?? 0)
				: this.db.prepare("SELECT * FROM host_groups ORDER BY sort_order ASC, name ASC").all()
		) as HostGroupRow[];
		return rows.map(rowToHostGroup);
	}

	countHostGroupEntities(): number {
		const row = this.db.prepare("SELECT COUNT(*) AS n FROM host_groups").get() as { n: number };
		return row.n;
	}

	createHostGroup(name: string, color?: string | null): HostGroup {
		const now = new Date().toISOString();
		const id = generateId();

		const maxRow = this.db
			.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort FROM host_groups")
			.get() as { next_sort: number };
		const sortOrder = maxRow.next_sort;

		this.db
			.prepare(
				`INSERT INTO host_groups (id, name, sort_order, color, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.run(id, name, sortOrder, color ?? null, now, now);

		return rowToHostGroup(
			this.db.prepare("SELECT * FROM host_groups WHERE id = ?").get(id) as HostGroupRow,
		);
	}

	getHostGroupEntity(id: string): HostGroup | null {
		const row = this.db.prepare("SELECT * FROM host_groups WHERE id = ?").get(id) as
			| HostGroupRow
			| undefined;
		return row ? rowToHostGroup(row) : null;
	}

	updateHostGroup(id: string, fields: { name?: string; color?: string | null }): HostGroup | null {
		const now = new Date().toISOString();
		const setClauses: string[] = ["updated_at = ?"];
		const values: unknown[] = [now];

		if (fields.name !== undefined) {
			setClauses.push("name = ?");
			values.push(fields.name);
		}
		if ("color" in fields) {
			setClauses.push("color = ?");
			values.push(fields.color ?? null);
		}

		values.push(id);
		const result = this.db
			.prepare(`UPDATE host_groups SET ${setClauses.join(", ")} WHERE id = ?`)
			.run(...values);

		if (result.changes === 0) return null;
		return rowToHostGroup(
			this.db.prepare("SELECT * FROM host_groups WHERE id = ?").get(id) as HostGroupRow,
		);
	}

	deleteHostGroupEntity(id: string): boolean {
		// ON DELETE SET NULL handles hosts.host_group_id automatically
		const result = this.db.prepare("DELETE FROM host_groups WHERE id = ?").run(id);
		return result.changes > 0;
	}

	reorderHostGroups(groupIds: string[]): void {
		const now = new Date().toISOString();
		const txn = this.db.transaction(() => {
			for (let i = 0; i < groupIds.length; i++) {
				this.db
					.prepare("UPDATE host_groups SET sort_order = ?, updated_at = ? WHERE id = ?")
					.run(i, now, groupIds[i]);
			}
		});
		txn();
	}

	migrateHostGroupData(): void {
		const txn = this.db.transaction(() => {
			// Find distinct legacy host_group strings
			const distinctGroups = this.db
				.prepare(
					"SELECT DISTINCT host_group FROM hosts WHERE host_group IS NOT NULL AND host_group != ''",
				)
				.all() as Array<{ host_group: string }>;

			const now = new Date().toISOString();
			for (const { host_group } of distinctGroups) {
				// Check if an entity already exists for this name
				const existing = this.db
					.prepare("SELECT id FROM host_groups WHERE name = ?")
					.get(host_group) as { id: string } | undefined;
				if (!existing) {
					const newId = generateId();
					const maxRow = this.db
						.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort FROM host_groups")
						.get() as { next_sort: number };
					this.db
						.prepare(
							`INSERT INTO host_groups (id, name, sort_order, color, created_at, updated_at)
							VALUES (?, ?, ?, NULL, ?, ?)`,
						)
						.run(newId, host_group, maxRow.next_sort, now, now);
				}
			}

			// Update host_group_id for all hosts that have a legacy host_group
			this.db
				.prepare(
					`UPDATE hosts
					SET host_group_id = (SELECT id FROM host_groups WHERE name = hosts.host_group)
					WHERE host_group IS NOT NULL AND host_group != '' AND host_group_id IS NULL`,
				)
				.run();
		});
		txn();
	}

	// ─── Profile JSON helpers ─────────────────────────────────────────────────

	getHostProfile(id: string): string | null {
		const row = this.db.prepare("SELECT profile_json FROM hosts WHERE id = ?").get(id) as
			| { profile_json: string | null }
			| undefined;
		return row?.profile_json ?? null;
	}

	updateHostProfile(id: string, profileJson: string | null): boolean {
		const now = new Date().toISOString();
		const result = this.db
			.prepare("UPDATE hosts SET profile_json = ?, updated_at = ? WHERE id = ?")
			.run(profileJson, now, id);
		return result.changes > 0;
	}

	updateHostDiscoveredShells(hostId: string, shells: string[], defaultShell?: string): void {
		const now = new Date().toISOString();
		this.db
			.prepare(
				`UPDATE hosts
				 SET discovered_shells = ?, discovered_shells_at = ?, updated_at = ?
				 WHERE id = ?`,
			)
			.run(JSON.stringify(shells), now, now, hostId);
		if (defaultShell !== undefined) {
			this.db
				.prepare("UPDATE hosts SET default_shell = ?, updated_at = ? WHERE id = ?")
				.run(defaultShell, now, hostId);
		}
	}
}
