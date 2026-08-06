import type {
	HostLaunchProfileOverride,
	LaunchProfile,
	LaunchProfileMode,
	SupportedOs,
} from "@lasterm/shared";
import { generateId } from "@lasterm/shared";
import type Database from "better-sqlite3";

// ─── Row types ───────────────────────────────────────────────────────────────

// ─── Launch Profile row types ────────────────────────────────────────────────
interface LaunchProfileRow {
	id: string;
	name: string;
	shell: string;
	args_json: string | null;
	cwd: string | null;
	env_json: string | null;
	mode: string;
	elevated: number;
	supported_os: string;
	icon_type: string;
	icon_value: string | null;
	color: string | null;
	profile_overrides_json: string | null;
	sort_order: number;
	created_at: string;
	updated_at: string;
}

interface HostLaunchProfileRow {
	host_id: string;
	profile_id: string;
	override_type: string;
	sort_order: number | null;
}

// ─── Row mapper ──────────────────────────────────────────────────────────────

function rowToLaunchProfile(row: LaunchProfileRow): LaunchProfile {
	const profile: LaunchProfile = {
		id: row.id,
		name: row.name,
		shell: row.shell,
		mode: row.mode as LaunchProfileMode,
		elevated: row.elevated !== 0,
		supportedOs: row.supported_os as SupportedOs,
		iconType: row.icon_type as LaunchProfile["iconType"],
		sortOrder: row.sort_order,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
	if (row.args_json != null) {
		try {
			const parsed = JSON.parse(row.args_json) as string[];
			if (parsed.length > 0) profile.args = parsed;
		} catch {
			// ignore malformed JSON
		}
	}
	if (row.cwd != null) profile.cwd = row.cwd;
	if (row.env_json != null) {
		try {
			profile.env = JSON.parse(row.env_json) as Record<string, string>;
		} catch {
			// ignore malformed JSON
		}
	}
	if (row.icon_value != null) profile.iconValue = row.icon_value;
	if (row.color != null) profile.color = row.color;
	if (row.profile_overrides_json != null) {
		try {
			// Cast via unknown to avoid exactOptionalPropertyTypes constraint on `| undefined`
			profile.profileOverrides = JSON.parse(row.profile_overrides_json) as NonNullable<
				LaunchProfile["profileOverrides"]
			>;
		} catch {
			// ignore malformed JSON
		}
	}
	return profile;
}

// ─── LaunchProfilesDAL ───────────────────────────────────────────────────────

export class LaunchProfilesDAL {
	constructor(private db: Database.Database) {}

	// ─── Launch Profiles ─────────────────────────────────────────────────────

	createLaunchProfile(input: Omit<LaunchProfile, "id" | "createdAt" | "updatedAt">): LaunchProfile {
		const now = new Date().toISOString();
		const id = generateId();

		this.db
			.prepare(
				`INSERT INTO launch_profiles (
				id, name, shell, args_json, cwd, env_json, mode, elevated,
				supported_os, icon_type, icon_value, color, profile_overrides_json,
				sort_order, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				input.name,
				input.shell,
				input.args && input.args.length > 0 ? JSON.stringify(input.args) : null,
				input.cwd ?? null,
				input.env ? JSON.stringify(input.env) : null,
				input.mode,
				input.elevated ? 1 : 0,
				input.supportedOs,
				input.iconType,
				input.iconValue ?? null,
				input.color ?? null,
				input.profileOverrides ? JSON.stringify(input.profileOverrides) : null,
				input.sortOrder,
				now,
				now,
			);

		return this.getLaunchProfile(id) as LaunchProfile;
	}

	getLaunchProfile(id: string): LaunchProfile | undefined {
		const row = this.db.prepare("SELECT * FROM launch_profiles WHERE id = ?").get(id) as
			| LaunchProfileRow
			| undefined;
		return row ? rowToLaunchProfile(row) : undefined;
	}

	getLaunchProfileByName(name: string): LaunchProfile | undefined {
		const row = this.db
			.prepare("SELECT * FROM launch_profiles WHERE name = ? COLLATE NOCASE")
			.get(name) as LaunchProfileRow | undefined;
		return row ? rowToLaunchProfile(row) : undefined;
	}

	listLaunchProfiles(limit?: number, offset?: number): LaunchProfile[] {
		const rows = (
			limit !== undefined
				? this.db
						.prepare(
							"SELECT * FROM launch_profiles ORDER BY sort_order ASC, name ASC LIMIT ? OFFSET ?",
						)
						.all(limit, offset ?? 0)
				: this.db.prepare("SELECT * FROM launch_profiles ORDER BY sort_order ASC, name ASC").all()
		) as LaunchProfileRow[];
		return rows.map(rowToLaunchProfile);
	}

	countLaunchProfiles(): number {
		const row = this.db.prepare("SELECT COUNT(*) AS n FROM launch_profiles").get() as { n: number };
		return row.n;
	}

	updateLaunchProfile(id: string, updates: Partial<LaunchProfile>): LaunchProfile | undefined {
		const existing = this.getLaunchProfile(id);
		if (!existing) return undefined;

		const now = new Date().toISOString();

		const fieldMap: Record<string, string> = {
			name: "name",
			shell: "shell",
			cwd: "cwd",
			mode: "mode",
			elevated: "elevated",
			supportedOs: "supported_os",
			iconType: "icon_type",
			iconValue: "icon_value",
			color: "color",
			sortOrder: "sort_order",
		};

		const setClauses: string[] = ["updated_at = ?"];
		const values: unknown[] = [now];

		for (const [camel, snake] of Object.entries(fieldMap)) {
			if (camel in updates) {
				setClauses.push(`${snake} = ?`);
				const val = updates[camel as keyof LaunchProfile];
				if (camel === "elevated") {
					values.push(val ? 1 : 0);
				} else {
					values.push(val !== undefined ? val : null);
				}
			}
		}

		if ("args" in updates) {
			setClauses.push("args_json = ?");
			values.push(updates.args && updates.args.length > 0 ? JSON.stringify(updates.args) : null);
		}
		if ("env" in updates) {
			setClauses.push("env_json = ?");
			values.push(updates.env ? JSON.stringify(updates.env) : null);
		}
		if ("profileOverrides" in updates) {
			setClauses.push("profile_overrides_json = ?");
			values.push(updates.profileOverrides ? JSON.stringify(updates.profileOverrides) : null);
		}

		values.push(id);
		this.db
			.prepare(`UPDATE launch_profiles SET ${setClauses.join(", ")} WHERE id = ?`)
			.run(...values);

		return this.getLaunchProfile(id);
	}

	deleteLaunchProfile(id: string): boolean {
		const result = this.db.prepare("DELETE FROM launch_profiles WHERE id = ?").run(id);
		return result.changes > 0;
	}

	reorderLaunchProfiles(ids: string[]): void {
		const now = new Date().toISOString();
		const txn = this.db.transaction(() => {
			for (let i = 0; i < ids.length; i++) {
				this.db
					.prepare("UPDATE launch_profiles SET sort_order = ?, updated_at = ? WHERE id = ?")
					.run(i, now, ids[i]);
			}
		});
		txn();
	}

	listHostProfiles(
		hostId: string,
		hostOs: string,
	): Array<LaunchProfile & { overrideType?: string; effectiveSort: number }> {
		const rows = this.db
			.prepare(
				`SELECT p.*, hlp.override_type,
				        COALESCE(hlp.sort_order, p.sort_order) AS effective_sort
				 FROM launch_profiles p
				 LEFT JOIN host_launch_profiles hlp
				     ON p.id = hlp.profile_id AND hlp.host_id = ?
				 WHERE
				     hlp.override_type = 'pin'
				     OR hlp.override_type = 'default'
				     OR (
				         p.supported_os IN ('any', ?)
				         AND (hlp.override_type IS NULL OR hlp.override_type != 'hide')
				     )
				 ORDER BY
				     CASE WHEN hlp.override_type = 'default' THEN 0 ELSE 1 END,
				     effective_sort,
				     p.name`,
			)
			.all(hostId, hostOs) as Array<
			LaunchProfileRow & { override_type: string | null; effective_sort: number }
		>;

		return rows.map((row) => {
			const profile = rowToLaunchProfile(row);
			const result: LaunchProfile & { overrideType?: string; effectiveSort: number } = {
				...profile,
				effectiveSort: row.effective_sort,
			};
			if (row.override_type != null) result.overrideType = row.override_type;
			return result;
		});
	}

	upsertHostProfileOverride(
		hostId: string,
		profileId: string,
		overrideType: string,
		sortOrder?: number,
	): void {
		const txn = this.db.transaction(() => {
			if (overrideType === "default") {
				// Enforce one-default-per-host invariant: remove any existing default for this host
				this.db
					.prepare(
						"DELETE FROM host_launch_profiles WHERE host_id = ? AND override_type = 'default'",
					)
					.run(hostId);
			}
			this.db
				.prepare(
					`INSERT INTO host_launch_profiles (host_id, profile_id, override_type, sort_order)
					 VALUES (?, ?, ?, ?)
					 ON CONFLICT(host_id, profile_id) DO UPDATE SET
					     override_type = excluded.override_type,
					     sort_order = excluded.sort_order`,
				)
				.run(hostId, profileId, overrideType, sortOrder ?? null);
		});
		txn();
	}

	deleteHostProfileOverride(hostId: string, profileId: string): boolean {
		const result = this.db
			.prepare("DELETE FROM host_launch_profiles WHERE host_id = ? AND profile_id = ?")
			.run(hostId, profileId);
		return result.changes > 0;
	}

	getHostLaunchProfileOverride(
		hostId: string,
		profileId: string,
	): HostLaunchProfileOverride | undefined {
		const row = this.db
			.prepare("SELECT * FROM host_launch_profiles WHERE host_id = ? AND profile_id = ?")
			.get(hostId, profileId) as HostLaunchProfileRow | undefined;
		if (!row) return undefined;
		const result: HostLaunchProfileOverride = {
			hostId: row.host_id,
			profileId: row.profile_id,
			overrideType: row.override_type as HostLaunchProfileOverride["overrideType"],
		};
		if (row.sort_order != null) result.sortOrder = row.sort_order;
		return result;
	}
}
