import type { ChannelGroup } from "@lasterm/shared";
import { generateId } from "@lasterm/shared";
import type Database from "better-sqlite3";

// ─── Row types ───────────────────────────────────────────────────────────────

interface GroupRow {
	id: string;
	host_id: string;
	name: string;
	sort_order: number;
	collapsed: number;
	created_at: string;
}

// ─── Row mapper ──────────────────────────────────────────────────────────────

function rowToGroup(row: GroupRow): ChannelGroup {
	return {
		id: row.id,
		hostId: row.host_id,
		name: row.name,
		sortOrder: row.sort_order,
		collapsed: row.collapsed !== 0,
		createdAt: row.created_at,
	};
}

// ─── ChannelGroupsDAL ────────────────────────────────────────────────────────

export class ChannelGroupsDAL {
	constructor(private db: Database.Database) {}

	// ─── Groups ─────────────────────────────────────────────────────────────

	listGroups(hostId: string): ChannelGroup[] {
		const rows = this.db
			.prepare("SELECT * FROM channel_groups WHERE host_id = ? ORDER BY sort_order ASC")
			.all(hostId) as GroupRow[];
		return rows.map(rowToGroup);
	}

	createGroup(hostId: string, name: string): ChannelGroup {
		const now = new Date().toISOString();
		const id = generateId();

		const maxRow = this.db
			.prepare("SELECT MAX(sort_order) AS max_sort FROM channel_groups WHERE host_id = ?")
			.get(hostId) as { max_sort: number | null } | undefined;
		const sortOrder = (maxRow?.max_sort ?? -1) + 1;

		this.db
			.prepare(
				`INSERT INTO channel_groups (id, host_id, name, sort_order, collapsed, created_at)
				 VALUES (?, ?, ?, ?, 0, ?)`,
			)
			.run(id, hostId, name, sortOrder, now);

		const row = this.db.prepare("SELECT * FROM channel_groups WHERE id = ?").get(id) as GroupRow;
		return rowToGroup(row);
	}

	reorderGroups(hostId: string, groupIds: string[]): void {
		// Validate all groups belong to the given host before mutating
		const existing = this.db
			.prepare("SELECT id FROM channel_groups WHERE host_id = ?")
			.all(hostId) as { id: string }[];
		const ownedIds = new Set(existing.map((r) => r.id));
		for (const id of groupIds) {
			if (!ownedIds.has(id)) {
				throw new Error(`Group ${id} does not belong to host ${hostId}`);
			}
		}
		const txn = this.db.transaction(() => {
			for (let i = 0; i < groupIds.length; i++) {
				this.db
					.prepare("UPDATE channel_groups SET sort_order = ? WHERE id = ?")
					.run(i, groupIds[i]);
			}
		});
		txn();
	}

	renameGroup(id: string, name: string): boolean {
		const result = this.db.prepare("UPDATE channel_groups SET name = ? WHERE id = ?").run(name, id);
		return result.changes > 0;
	}

	deleteGroup(id: string): boolean {
		const now = new Date().toISOString();
		this.db
			.prepare("UPDATE channels SET group_id = NULL, updated_at = ? WHERE group_id = ?")
			.run(now, id);
		const result = this.db.prepare("DELETE FROM channel_groups WHERE id = ?").run(id);
		return result.changes > 0;
	}

	updateChannelGroupId(channelId: string, groupId: string | null): boolean {
		const now = new Date().toISOString();
		const result = this.db
			.prepare("UPDATE channels SET group_id = ?, updated_at = ? WHERE id = ?")
			.run(groupId, now, channelId);
		return result.changes > 0;
	}
}
