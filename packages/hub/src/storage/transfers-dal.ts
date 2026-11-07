import type { Database, Statement } from "./sqlite.js";

/**
 * Uploads as meta.db keeps them (#860, STORAGE.md § 3.9): one `transfers` row
 * per upload, one `transfer_items` row per file or folder of it. The transfer
 * service decides what goes in and when; this only reads and writes rows.
 *
 * Paths and names are stored as a terminal's directory and title are, and
 * never logged.
 */

/** An upload's row. */
export interface TransferRecord {
	readonly id: string;
	readonly hostId: string;
	readonly channelId: string;
	readonly tokenId: string | null;
	readonly destDir: string;
	readonly pathStyle: string;
	readonly direction: string;
	readonly state: string;
	readonly onConflict: string;
	readonly verify: boolean;
	readonly signature: string;
	readonly reason: string | null;
	readonly createdAt: string;
	readonly updatedAt: string;
}

/** A file's or a folder's row. */
export interface TransferItemRecord {
	readonly id: number;
	readonly parentId: number | null;
	readonly relPath: string;
	readonly kind: string;
	readonly size: number;
	readonly mtime: number | null;
	readonly state: string;
	readonly ackedOffset: number;
	readonly tempPath: string | null;
	readonly tempWhole: boolean;
	readonly direct: boolean;
	readonly finalName: string | null;
	readonly resolution: string | null;
	readonly outcome: string | null;
	readonly verification: string | null;
	/** JSON: what had its name at the destination, for a conflict. */
	readonly existingJson: string | null;
	readonly typeClash: boolean;
	readonly late: boolean;
	readonly errorCode: string | null;
	readonly reason: string | null;
	readonly updatedAt: string;
}

interface TransferRow {
	id: string;
	host_id: string;
	channel_id: string;
	token_id: string | null;
	dest_dir: string;
	path_style: string;
	direction: string;
	state: string;
	on_conflict: string;
	verify: number;
	signature: string;
	reason: string | null;
	created_at: string;
	updated_at: string;
}

interface ItemRow {
	id: number;
	parent_id: number | null;
	rel_path: string;
	kind: string;
	size: number;
	mtime: number | null;
	state: string;
	acked_offset: number;
	temp_path: string | null;
	temp_whole: number;
	direct: number;
	final_name: string | null;
	resolution: string | null;
	outcome: string | null;
	verification: string | null;
	existing_json: string | null;
	type_clash: number;
	late: number;
	error_code: string | null;
	reason: string | null;
	updated_at: string;
}

function toRecord(row: TransferRow): TransferRecord {
	return {
		id: row.id,
		hostId: row.host_id,
		channelId: row.channel_id,
		tokenId: row.token_id,
		destDir: row.dest_dir,
		pathStyle: row.path_style,
		direction: row.direction,
		state: row.state,
		onConflict: row.on_conflict,
		verify: row.verify !== 0,
		signature: row.signature,
		reason: row.reason,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function toItem(row: ItemRow): TransferItemRecord {
	return {
		id: row.id,
		parentId: row.parent_id,
		relPath: row.rel_path,
		kind: row.kind,
		size: row.size,
		mtime: row.mtime,
		state: row.state,
		ackedOffset: row.acked_offset,
		tempPath: row.temp_path,
		tempWhole: row.temp_whole !== 0,
		direct: row.direct !== 0,
		finalName: row.final_name,
		resolution: row.resolution,
		outcome: row.outcome,
		verification: row.verification,
		existingJson: row.existing_json,
		typeClash: row.type_clash !== 0,
		late: row.late !== 0,
		errorCode: row.error_code,
		reason: row.reason,
		updatedAt: row.updated_at,
	};
}

/** An item's row as the statements bind it. */
function itemParams(transferId: string, item: TransferItemRecord): Record<string, unknown> {
	return {
		transfer_id: transferId,
		id: item.id,
		parent_id: item.parentId,
		rel_path: item.relPath,
		kind: item.kind,
		size: item.size,
		mtime: item.mtime,
		state: item.state,
		acked_offset: item.ackedOffset,
		temp_path: item.tempPath,
		temp_whole: item.tempWhole ? 1 : 0,
		direct: item.direct ? 1 : 0,
		final_name: item.finalName,
		resolution: item.resolution,
		outcome: item.outcome,
		verification: item.verification,
		existing_json: item.existingJson,
		type_clash: item.typeClash ? 1 : 0,
		late: item.late ? 1 : 0,
		error_code: item.errorCode,
		reason: item.reason,
		updated_at: item.updatedAt,
	};
}

const ITEM_COLUMNS = [
	"transfer_id",
	"id",
	"parent_id",
	"rel_path",
	"kind",
	"size",
	"mtime",
	"state",
	"acked_offset",
	"temp_path",
	"temp_whole",
	"direct",
	"final_name",
	"resolution",
	"outcome",
	"verification",
	"existing_json",
	"type_clash",
	"late",
	"error_code",
	"reason",
	"updated_at",
] as const;

/**
 * What changes of an item once it is written: everything but where it is in its tree. A file's
 * size and time too: a resume sends a file that changed since again, as it is now (#837).
 */
const ITEM_CHANGING = ITEM_COLUMNS.filter(
	(column) => !["transfer_id", "id", "parent_id", "rel_path", "kind"].includes(column),
);

export class TransfersDAL {
	private readonly insertTransfer: Statement;
	private readonly insertItem: Statement;
	private readonly updateItem: Statement;
	private readonly updateTransfer: Statement;

	constructor(private readonly db: Database) {
		this.insertTransfer = db.prepare(
			`INSERT INTO transfers (id, host_id, channel_id, token_id, dest_dir, path_style, direction,
				state, on_conflict, verify, signature, reason, created_at, updated_at)
			VALUES (@id, @host_id, @channel_id, @token_id, @dest_dir, @path_style, @direction,
				@state, @on_conflict, @verify, @signature, @reason, @created_at, @updated_at)`,
		);
		this.insertItem = db.prepare(
			`INSERT INTO transfer_items (${ITEM_COLUMNS.join(", ")})
			VALUES (${ITEM_COLUMNS.map((column) => `@${column}`).join(", ")})`,
		);
		this.updateItem = db.prepare(
			`UPDATE transfer_items SET ${ITEM_CHANGING.map((column) => `${column} = @${column}`).join(", ")}
			WHERE transfer_id = @transfer_id AND id = @id`,
		);
		this.updateTransfer = db.prepare(
			"UPDATE transfers SET state = ?, reason = ?, updated_at = ? WHERE id = ?",
		);
	}

	/** Several writes as one: they all land, or none. */
	transaction(write: () => void): void {
		this.db.transaction(write)();
	}

	/** A new upload and every item of it. */
	insert(transfer: TransferRecord, items: readonly TransferItemRecord[]): void {
		this.transaction(() => {
			this.insertTransfer.run({
				id: transfer.id,
				host_id: transfer.hostId,
				channel_id: transfer.channelId,
				token_id: transfer.tokenId,
				dest_dir: transfer.destDir,
				path_style: transfer.pathStyle,
				direction: transfer.direction,
				state: transfer.state,
				on_conflict: transfer.onConflict,
				verify: transfer.verify ? 1 : 0,
				signature: transfer.signature,
				reason: transfer.reason,
				created_at: transfer.createdAt,
				updated_at: transfer.updatedAt,
			});
			for (const item of items) this.insertItem.run(itemParams(transfer.id, item));
		});
	}

	/** What an upload is at, and why it did not resume when it did not. */
	setState(id: string, state: string, reason: string | null, updatedAt: string): void {
		this.updateTransfer.run(state, reason, updatedAt, id);
	}

	/** Write what changed of an item: every field but its place in the tree. */
	writeItem(transferId: string, item: TransferItemRecord): void {
		this.updateItem.run(itemParams(transferId, item));
	}

	/** Delete an upload, and its items with it. */
	delete(id: string): void {
		this.db.prepare("DELETE FROM transfers WHERE id = ?").run(id);
	}

	/** Every upload, oldest first. */
	list(): TransferRecord[] {
		return (
			this.db.prepare("SELECT * FROM transfers ORDER BY created_at, id").all() as TransferRow[]
		).map(toRecord);
	}

	/** The items of an upload, by id. */
	items(transferId: string): TransferItemRecord[] {
		return (
			this.db
				.prepare("SELECT * FROM transfer_items WHERE transfer_id = ? ORDER BY id")
				.all(transferId) as ItemRow[]
		).map(toItem);
	}
}
