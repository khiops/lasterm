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
import { sshAddress, targetRoute } from "../ssh-route.js";

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
	default_cwd: string | null;
	host_group_id: string | null;
	sort_order: number;
	ssh_config_host: string | null;
	ssh_user: string | null;
	discovered_shells: string | null;
	discovered_shells_at: string | null;
	discovered_default_shell: string | null;
	elevation_method: string | null;
	custom_command: string | null;
	os: string | null;
	arch: string | null;
	agent_sha256: string | null;
	ssh_fingerprint: string | null;
	ssh_proxy_host_id: string | null;
	ssh_proxy_spec: string | null;
	ssh_remote_daemon: number | null;
	ssh_proxy_fingerprint: string | null;
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
	if (row.default_cwd != null) host.defaultCwd = row.default_cwd;
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
	if (row.discovered_default_shell != null) {
		host.discoveredDefaultShell = row.discovered_default_shell;
	}
	if (row.elevation_method != null) host.elevationMethod = row.elevation_method as ElevationMethod;
	if (row.custom_command != null) host.customCommand = row.custom_command;
	if (row.agent_sha256 != null) host.agentSha256 = row.agent_sha256;
	// ssh_fingerprint is always set (null = not yet seen)
	host.sshFingerprint = row.ssh_fingerprint;
	if (row.ssh_proxy_host_id != null) host.sshProxyHostId = row.ssh_proxy_host_id;
	if (row.ssh_proxy_spec != null) host.sshProxySpec = row.ssh_proxy_spec;
	if (row.ssh_proxy_fingerprint != null) host.sshProxyFingerprint = row.ssh_proxy_fingerprint;
	if (row.ssh_remote_daemon != null) host.sshRemoteDaemon = row.ssh_remote_daemon === 1;
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

/** A host as a client's list shows it, its last write's time aside. */
function asShown(host: Host): string {
	return JSON.stringify({ ...host, updatedAt: null });
}

export class HostsDAL {
	/** Told once a write here changed a host: nobody, unless `onHostChanged` named someone. */
	private hostChanged: () => void = () => {};

	constructor(private db: Database.Database) {}

	/**
	 * Name who is told once a write here changed a host: created, edited, or
	 * given what the hub learned of it — its OS, its shells, a key or an agent
	 * hash it pinned (#789). A write that found the same again tells nobody. The
	 * session manager's DAL tells every client, which then reads the hosts again;
	 * the routes' DAL tells nobody, as the routes say their writes themselves.
	 */
	onHostChanged(listener: () => void): void {
		this.hostChanged = listener;
	}

	// ─── Hosts ──────────────────────────────────────────────────────────────

	createHost(input: CreateHostInput): Host {
		const now = new Date().toISOString();
		const id = generateId();

		this.db
			.prepare(
				`INSERT INTO hosts (
				id, type, label, ssh_host, ssh_port, ssh_auth, ssh_key_path,
				icon_type, icon_value, color, profile_json, trust_remote_hints,
				default_cwd,
				host_group_id, sort_order, ssh_config_host, ssh_user,
				ssh_proxy_host_id, ssh_proxy_spec, ssh_remote_daemon,
				elevation_method, custom_command,
				os, arch,
				created_at, updated_at
			) VALUES (
				?, ?, ?, ?, ?, ?, ?,
				?, ?, ?, ?, ?,
				?,
				?, ?, ?, ?,
				?, ?, ?,
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
				input.defaultCwd ?? null,
				input.hostGroupId ?? null,
				input.sortOrder ?? 0,
				input.sshConfigHost ?? null,
				input.sshUser ?? null,
				input.sshProxyHostId ?? null,
				input.sshProxySpec ?? null,
				input.sshRemoteDaemon == null ? null : input.sshRemoteDaemon ? 1 : 0,
				input.elevationMethod ?? null,
				input.customCommand ?? null,
				input.os ?? null,
				input.arch ?? null,
				now,
				now,
			);

		this.hostChanged();
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

	/**
	 * The local hosts, oldest first. The hub knows its local host by its type,
	 * never by its label, which the user may change (#658). A profile can hold
	 * more than one: a hub that went by the label created a second after a
	 * rename. The first of this list is the one the hub uses. Two created in
	 * the same millisecond keep the order they were inserted in: ULIDs of one
	 * millisecond do not.
	 */
	listLocalHosts(): Host[] {
		const rows = this.db
			.prepare("SELECT * FROM hosts WHERE type = 'local' ORDER BY created_at ASC, rowid ASC")
			.all() as HostRow[];
		return rows.map(rowToHost);
	}

	listHosts(limit?: number, offset?: number): Host[] {
		// Local hosts first, and among several the oldest first (#658): a client
		// shows the first as the local host, which is the one the hub uses.
		// Then by sort_order, and among equal ones the order of creation: a
		// client groups them by host_group_id itself, keeping this order.
		const order = `ORDER BY
				CASE WHEN type = 'local' THEN 0 ELSE 1 END,
				CASE WHEN type = 'local' THEN created_at END ASC,
				CASE WHEN type = 'local' THEN rowid END ASC,
				sort_order ASC,
				rowid ASC`;
		const sql =
			limit !== undefined
				? `SELECT * FROM hosts ${order} LIMIT ? OFFSET ?`
				: `SELECT * FROM hosts ${order}`;
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
		const { before, after } = this.db.transaction(() => {
			const before = this.getHost(id);
			if (!before) throw new Error(`Host not found: ${id}`);
			const oldRoute = this.route(before);
			const oldJump = this.jumpRoute(before);
			const oldAddress = sshAddress(before);
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
				defaultCwd: "default_cwd",
				hostGroupId: "host_group_id",
				sortOrder: "sort_order",
				sshConfigHost: "ssh_config_host",
				sshUser: "ssh_user",
				sshProxyHostId: "ssh_proxy_host_id",
				sshProxySpec: "ssh_proxy_spec",
				sshProxyFingerprint: "ssh_proxy_fingerprint",
				sshRemoteDaemon: "ssh_remote_daemon",
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
					// SQLite binds no booleans: an answer about this host is 1 or 0,
					// and "no answer" stays null so the global setting still speaks.
					if (typeof val === "boolean") {
						values.push(val ? 1 : 0);
					} else {
						values.push(val !== undefined ? val : null);
					}
				}
			}

			values.push(id);

			this.db.prepare(`UPDATE hosts SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);

			const updated = this.getHost(id);
			if (!updated) {
				throw new Error(`Host not found after update: ${id}`);
			}
			const newRoute = this.route(updated);
			if (oldRoute !== newRoute)
				this.db.prepare("UPDATE hosts SET ssh_fingerprint = NULL WHERE id = ?").run(id);
			if (oldJump !== this.jumpRoute(updated))
				this.db.prepare("UPDATE hosts SET ssh_proxy_fingerprint = NULL WHERE id = ?").run(id);
			if (JSON.stringify(oldAddress) !== JSON.stringify(sshAddress(updated))) {
				this.db
					.prepare(
						"UPDATE hosts SET ssh_fingerprint = NULL, updated_at = ? WHERE ssh_proxy_host_id = ?",
					)
					.run(new Date().toISOString(), id);
			}
			return { before, after: this.getHost(id) as Host };
		})();
		// The hosts reached through this one lose their pin only when its address
		// changes, which this comparison sees.
		if (asShown(before) !== asShown(after)) this.hostChanged();
		return after;
	}

	/** Found at every deploy: written, and said, only when it differs from what is stored. */
	updateHostOsArch(id: string, os: HostOs, arch: HostArch): void {
		const now = new Date().toISOString();
		const { changes } = this.db
			.prepare(
				"UPDATE hosts SET os = ?, arch = ?, updated_at = ? WHERE id = ? AND (os IS NOT ? OR arch IS NOT ?)",
			)
			.run(os, arch, now, id, os, arch);
		if (changes > 0) this.hostChanged();
	}

	/** Written, and said, only when it differs from what is stored. */
	updateHostAgentSha256(id: string, sha256: string | null): void {
		const now = new Date().toISOString();
		const { changes } = this.db
			.prepare(
				"UPDATE hosts SET agent_sha256 = ?, updated_at = ? WHERE id = ? AND agent_sha256 IS NOT ?",
			)
			.run(sha256, now, id, sha256);
		if (changes > 0) this.hostChanged();
	}

	getHostAgentSha256(id: string): string | null {
		const row = this.db.prepare("SELECT agent_sha256 FROM hosts WHERE id = ?").get(id) as
			| { agent_sha256: string | null }
			| undefined;
		return row?.agent_sha256 ?? null;
	}

	private route(host: import("../ssh-route.js").RouteHost): string | null {
		return targetRoute(host, (id) => sshAddress(this.getHost(id)));
	}
	private jumpRoute(host: import("../ssh-route.js").RouteHost): string | null {
		// Compare the jump independently of whether the target has an address.
		return this.route({ ...host, type: "ssh", sshHost: "route-jump", sshPort: 22 });
	}

	getHostFingerprint(hostId: string, expectedRoute: string | null): string | null {
		const host = this.getHost(hostId);
		return host && expectedRoute !== null && this.route(host) === expectedRoute
			? (host.sshFingerprint ?? null)
			: null;
	}
	updateHostFingerprint(
		hostId: string,
		fingerprint: string,
		expectedRoute: string | null,
	): boolean {
		return this.writePin(hostId, fingerprint, expectedRoute, "ssh_fingerprint");
	}
	updateHostProxyFingerprint(
		hostId: string,
		fingerprint: string,
		expectedRoute: string | null,
	): boolean {
		return this.writePin(hostId, fingerprint, expectedRoute, "ssh_proxy_fingerprint");
	}
	/**
	 * True when the key is this host's: pinned now, or already. Only a key not
	 * pinned yet is written, and said.
	 */
	private writePin(
		hostId: string,
		fingerprint: string,
		expectedRoute: string | null,
		column: "ssh_fingerprint" | "ssh_proxy_fingerprint",
	): boolean {
		const outcome = this.db.transaction((): "refused" | "same" | "pinned" => {
			const host = this.getHost(hostId);
			if (!host || expectedRoute === null || this.route(host) !== expectedRoute) return "refused";
			const pinned = column === "ssh_fingerprint" ? host.sshFingerprint : host.sshProxyFingerprint;
			if (pinned === fingerprint) return "same";
			this.db
				.prepare(`UPDATE hosts SET ${column} = ?, updated_at = ? WHERE id = ?`)
				.run(fingerprint, new Date().toISOString(), hostId);
			return "pinned";
		})();
		if (outcome === "pinned") this.hostChanged();
		return outcome !== "refused";
	}
	deleteHost(id: string): boolean {
		return this.db.transaction(() => {
			this.db
				.prepare(
					"UPDATE hosts SET ssh_fingerprint = NULL, ssh_proxy_fingerprint = NULL, updated_at = ? WHERE ssh_proxy_host_id = ?",
				)
				.run(new Date().toISOString(), id);
			return this.db.prepare("DELETE FROM hosts WHERE id = ?").run(id).changes > 0;
		})();
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

	/**
	 * Copy a host's settings under a free label, into the original's group,
	 * right after it in that group's order (#746). What the hub learned and
	 * pinned on its own is not a setting: the copy trusts no host key, no jump
	 * key and no agent binary until it connects, and finds its shells again.
	 */
	duplicateHost(id: string): Host | null {
		return this.db.transaction(() => {
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

			// The group's hosts in the order the rail shows them, the order
			// PUT /api/hosts/order writes. Hosts that were never moved all sit at
			// 0, so the copy cannot just take the original's place plus one: the
			// whole group is renumbered as that endpoint leaves it.
			const groupId = original.hostGroupId ?? null;
			const group = this.db
				.prepare(
					`SELECT id, sort_order FROM hosts
					WHERE host_group_id IS ? AND type <> 'local'
					ORDER BY sort_order ASC, rowid ASC`,
				)
				.all(groupId) as Array<{ id: string; sort_order: number }>;
			const at = group.findIndex((host) => host.id === original.id) + 1;

			const copy = this.createHost({
				type: original.type,
				label: original.label + suffix,
				hostGroupId: groupId,
				sortOrder: at,
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
				...(original.defaultCwd !== undefined && { defaultCwd: original.defaultCwd }),
				...(original.sshConfigHost != null && { sshConfigHost: original.sshConfigHost }),
				...(original.sshUser != null && { sshUser: original.sshUser }),
				...(original.sshRemoteDaemon !== undefined && {
					sshRemoteDaemon: original.sshRemoteDaemon,
				}),
				// The jump is part of the route: without it the copy would dial the
				// same address directly, which can be another machine.
				...(original.sshProxyHostId != null && { sshProxyHostId: original.sshProxyHostId }),
				...(original.sshProxySpec != null && { sshProxySpec: original.sshProxySpec }),
				...(original.elevationMethod != null && { elevationMethod: original.elevationMethod }),
				...(original.customCommand != null && { customCommand: original.customCommand }),
				// The machine is the same one: null still means auto-detect.
				os: original.os,
				arch: original.arch,
			});

			// The default profile the user chose for it is a setting too (#802):
			// what the original's Default Shell starts, the copy's starts.
			this.db
				.prepare(
					`INSERT INTO host_launch_profiles (host_id, profile_id, override_type, sort_order, set_by_user)
					SELECT ?, profile_id, override_type, sort_order, set_by_user FROM host_launch_profiles
					WHERE host_id = ? AND override_type = 'default' AND set_by_user = 1`,
				)
				.run(copy.id, original.id);

			const now = new Date().toISOString();
			const move = this.db.prepare("UPDATE hosts SET sort_order = ?, updated_at = ? WHERE id = ?");
			group.forEach((host, i) => {
				const position = i < at ? i : i + 1;
				if (host.sort_order !== position) move.run(position, now, host.id);
			});
			return copy;
		})();
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

	/**
	 * Found at every connection, and stamped each time: the shells the host's
	 * agent reports, and the one it starts when told none, which goes to
	 * `discovered_default_shell` (#794). `default_shell` is read and written
	 * by nothing: the host's default is a launch profile (#802). Said only when
	 * the shells, or the agent's default, differ from what is stored.
	 */
	updateHostDiscoveredShells(hostId: string, shells: string[], reportedDefault?: string): void {
		const now = new Date().toISOString();
		const found = JSON.stringify(shells);
		const stored = this.db
			.prepare("SELECT discovered_shells, discovered_default_shell FROM hosts WHERE id = ?")
			.get(hostId) as
			| { discovered_shells: string | null; discovered_default_shell: string | null }
			| undefined;
		this.db
			.prepare(
				`UPDATE hosts
				 SET discovered_shells = ?, discovered_shells_at = ?, updated_at = ?
				 WHERE id = ?`,
			)
			.run(found, now, now, hostId);
		if (reportedDefault !== undefined) {
			this.db
				.prepare("UPDATE hosts SET discovered_default_shell = ? WHERE id = ?")
				.run(reportedDefault, hostId);
		}
		if (
			stored !== undefined &&
			(stored.discovered_shells !== found ||
				(reportedDefault !== undefined && stored.discovered_default_shell !== reportedDefault))
		) {
			this.hostChanged();
		}
	}
}
