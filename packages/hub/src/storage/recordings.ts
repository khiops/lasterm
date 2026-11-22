import type { Database, Statement } from "./sqlite.js";

/** Why a recording ended (STORAGE.md § 4.3). */
export type RecordingEndReason =
	| "stopped"
	| "exited"
	| "killed"
	| "restarted"
	| "gone"
	| "cap"
	| "interrupted"
	| "crashed";

export interface RecordingRow {
	id: string;
	channelId: string;
	hostLabel: string;
	title: string;
	startedAt: string;
	endedAt: string | null;
	endReason: RecordingEndReason | null;
	cols: number;
	rows: number;
	durationMs: number;
	bytes: number;
	unmarkedLostBytes: number;
	deleting: boolean;
}

interface RawRow {
	id: string;
	channel_id: string;
	host_label: string;
	title: string;
	started_at: string;
	ended_at: string | null;
	end_reason: RecordingEndReason | null;
	cols: number;
	rows: number;
	duration_ms: number;
	bytes: number;
	unmarked_lost_bytes: number;
	deleting: number;
}

export interface OpenRecordingInput {
	id: string;
	channelId: string;
	hostLabel: string;
	title: string;
	startedAt: string;
	cols: number;
	rows: number;
}

export interface WriteBlockInput {
	recordingId: string;
	seq: number;
	/** asciicast v3 event lines, each ending with `\n`. */
	lines: Buffer;
	durationMs: number;
	/** The block opens with the lost-bytes marker: the lost count goes back to 0. */
	resetLost: boolean;
	/** A size learnt since the last block (a manual start's screen), written with it. */
	size?: { cols: number; rows: number };
}

/** One stored block as an export reads it. */
export interface RecordingBlock {
	seq: number;
	lines: Buffer;
}

/** The most one delete batch takes (the spool GC's limits, `spool-gc.ts`). */
export interface RecordingBatchLimits {
	maxRows: number;
	maxBytes: number;
}

function toRow(raw: RawRow): RecordingRow {
	return {
		id: raw.id,
		channelId: raw.channel_id,
		hostLabel: raw.host_label,
		title: raw.title,
		startedAt: raw.started_at,
		endedAt: raw.ended_at,
		endReason: raw.end_reason,
		cols: raw.cols,
		rows: raw.rows,
		durationMs: raw.duration_ms,
		bytes: raw.bytes,
		unmarkedLostBytes: raw.unmarked_lost_bytes,
		deleting: raw.deleting === 1,
	};
}

/**
 * The recordings in spool.db (#80): a row per recording and its blocks of
 * event lines. A recording outlives its terminal; only a save or a discard
 * deletes it, never the spool GC's age or size rules.
 */
export class RecordingsDAL {
	private readonly statements = new Map<string, Statement>();

	constructor(private readonly db: Database) {}

	/**
	 * Open a recording. A row still open for the same terminal — one whose end
	 * could not be written — is ended first, in the same transaction, so the
	 * one-open-per-terminal index never refuses the new one.
	 */
	open(input: OpenRecordingInput, leftOpen: { reason: RecordingEndReason; endedAt: string }): void {
		this.db.transaction(() => {
			this.statement(
				`UPDATE recordings SET ended_at = ?, end_reason = ? WHERE channel_id = ? AND ended_at IS NULL`,
			).run(leftOpen.endedAt, leftOpen.reason, input.channelId);
			this.statement(
				`INSERT INTO recordings (id, channel_id, host_label, title, started_at, cols, rows)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			).run(
				input.id,
				input.channelId,
				input.hostLabel,
				input.title,
				input.startedAt,
				input.cols,
				input.rows,
			);
		})();
	}

	/** Write one block and its row's counters in one transaction. */
	writeBlock(input: WriteBlockInput): void {
		this.db.transaction(() => {
			this.statement(
				"INSERT INTO recording_blocks (recording_id, seq, data_blob) VALUES (?, ?, ?)",
			).run(input.recordingId, input.seq, input.lines);
			this.statement(
				`UPDATE recordings SET bytes = bytes + ?, duration_ms = ?,
				   unmarked_lost_bytes = CASE WHEN ? = 1 THEN 0 ELSE unmarked_lost_bytes END,
				   cols = COALESCE(?, cols), rows = COALESCE(?, rows)
				 WHERE id = ?`,
			).run(
				input.lines.byteLength,
				input.durationMs,
				input.resetLost ? 1 : 0,
				input.size?.cols ?? null,
				input.size?.rows ?? null,
				input.recordingId,
			);
		})();
	}

	/** Persist a lost-bytes count kept in memory. */
	setUnmarkedLost(recordingId: string, bytes: number): void {
		this.statement("UPDATE recordings SET unmarked_lost_bytes = ? WHERE id = ?").run(
			bytes,
			recordingId,
		);
	}

	end(recordingId: string, reason: RecordingEndReason, endedAt: string, title: string): void {
		this.statement(
			"UPDATE recordings SET ended_at = ?, end_reason = ?, title = ? WHERE id = ? AND ended_at IS NULL",
		).run(endedAt, reason, title, recordingId);
	}

	/** End every row left open; returns how many. */
	endAllOpen(reason: RecordingEndReason, endedAt: string): number {
		return this.statement(
			"UPDATE recordings SET ended_at = ?, end_reason = ? WHERE ended_at IS NULL",
		).run(endedAt, reason).changes;
	}

	get(recordingId: string): RecordingRow | undefined {
		const raw = this.statement("SELECT * FROM recordings WHERE id = ?").get(recordingId) as
			| RawRow
			| undefined;
		return raw ? toRow(raw) : undefined;
	}

	/** Every recording not being deleted, newest first. */
	list(): RecordingRow[] {
		const rows = this.statement(
			"SELECT * FROM recordings WHERE deleting = 0 ORDER BY started_at DESC, id DESC",
		).all() as RawRow[];
		return rows.map(toRow);
	}

	/** Sum of `bytes` over every row, those being deleted included. */
	usedBytes(): number {
		const row = this.statement("SELECT COALESCE(SUM(bytes), 0) AS total FROM recordings").get() as {
			total: number;
		};
		return row.total;
	}

	/** The highest block seq of a recording, 0 when it has none. */
	lastSeq(recordingId: string): number {
		const row = this.statement(
			"SELECT seq FROM recording_blocks WHERE recording_id = ? ORDER BY seq DESC LIMIT 1",
		).get(recordingId) as { seq: number } | undefined;
		return row?.seq ?? 0;
	}

	/**
	 * Blocks of a recording from `fromSeq` to at most `lastSeq`, by the primary
	 * key, until `maxBytes` is reached (a first block larger than that comes
	 * alone). Returns `null` when a block in that range is missing: a deletion
	 * has started, and an export must not end early.
	 */
	readBlocks(
		recordingId: string,
		fromSeq: number,
		lastSeq: number,
		maxBytes: number,
	): { blocks: RecordingBlock[]; nextSeq: number | undefined } | null {
		const blocks: RecordingBlock[] = [];
		const select = this.statement(
			"SELECT seq, data_blob FROM recording_blocks WHERE recording_id = ? AND seq = ?",
		);
		let bytes = 0;
		let seq = fromSeq;
		while (seq <= lastSeq) {
			const raw = select.get(recordingId, seq) as
				| { seq: number; data_blob: Uint8Array }
				| undefined;
			if (raw === undefined) return null;
			const lines = Buffer.from(raw.data_blob);
			if (blocks.length > 0 && bytes + lines.byteLength > maxBytes) break;
			blocks.push({ seq, lines });
			bytes += lines.byteLength;
			seq++;
		}
		return { blocks, nextSeq: seq <= lastSeq ? seq : undefined };
	}

	markDeleting(recordingId: string): void {
		this.statement("UPDATE recordings SET deleting = 1 WHERE id = ?").run(recordingId);
	}

	deletingIds(): string[] {
		const rows = this.statement("SELECT id FROM recordings WHERE deleting = 1").all() as Array<{
			id: string;
		}>;
		return rows.map((row) => row.id);
	}

	/**
	 * Delete, lowest seq first, at most `limits` of a recording's blocks in one
	 * transaction; the row goes in the transaction that deletes the last block,
	 * or at once when it has none. Only a row marked `deleting` is touched.
	 */
	deleteBatch(
		recordingId: string,
		limits: RecordingBatchLimits,
	): { deleted: number; bytes: number; done: boolean } {
		return this.db.transaction(() => {
			const marked = this.statement(
				"SELECT 1 AS one FROM recordings WHERE id = ? AND deleting = 1",
			).get(recordingId);
			if (marked === undefined) return { deleted: 0, bytes: 0, done: true };
			const rows = this.statement(
				`SELECT seq, LENGTH(data_blob) AS bytes FROM recording_blocks
				 WHERE recording_id = ? ORDER BY seq LIMIT ?`,
			).all(recordingId, limits.maxRows) as Array<{ seq: number; bytes: number }>;
			let bytes = 0;
			let throughSeq: number | undefined;
			let count = 0;
			for (const row of rows) {
				if (count > 0 && bytes + row.bytes > limits.maxBytes) break;
				bytes += row.bytes;
				throughSeq = row.seq;
				count++;
			}
			let deleted = 0;
			if (throughSeq !== undefined) {
				deleted = this.statement(
					"DELETE FROM recording_blocks WHERE recording_id = ? AND seq <= ?",
				).run(recordingId, throughSeq).changes;
			}
			const left = this.statement(
				"SELECT 1 AS one FROM recording_blocks WHERE recording_id = ? LIMIT 1",
			).get(recordingId);
			if (left === undefined) {
				this.statement("DELETE FROM recordings WHERE id = ?").run(recordingId);
				return { deleted, bytes, done: true };
			}
			return { deleted, bytes, done: false };
		})();
	}

	private statement(sql: string): Statement {
		let statement = this.statements.get(sql);
		if (statement === undefined) {
			statement = this.db.prepare(sql);
			this.statements.set(sql, statement);
		}
		return statement;
	}
}
