import { generateId } from "@lasterm/shared";
import type Database from "better-sqlite3";

export interface InsertChunkInput {
	channelId: string;
	seq: number;
	kind: "output" | "snapshot" | "resize";
	codec?: "raw" | "zstd";
	dataBlob: Buffer;
	uncompressedLen: number;
}

export interface Chunk {
	id: string;
	channelId: string;
	seq: number;
	ts: string;
	kind: string;
	codec: string;
	dataBlob: Buffer;
	uncompressedLen: number;
}

interface ChunkRow {
	id: string;
	channel_id: string;
	seq: number;
	ts: string;
	kind: string;
	codec: string;
	data_blob: Buffer;
	uncompressed_len: number;
}

/** Which chunks a batch deletes: snapshots, everything else, or both. */
export type ChunkKinds = "snapshots" | "others" | "all";

/** The most one delete batch takes, in rows and in stored bytes (#726). */
export interface ChunkBatchLimits {
	maxRows: number;
	/** The batch stops at the row that reaches it, so it holds at least one row. */
	maxBytes: number;
}

export interface ChunkBatchResult {
	deleted: number;
	bytes: number;
	/** The highest seq deleted: where the next batch starts. Undefined when nothing was left. */
	lastSeq: number | undefined;
}

/** A chunk as the GC weighs it: no data, only what it stores. */
export interface ChunkSize {
	seq: number;
	kind: string;
	ts: string;
	bytes: number;
}

function rowToChunk(row: ChunkRow): Chunk {
	return {
		id: row.id,
		channelId: row.channel_id,
		seq: row.seq,
		ts: row.ts,
		kind: row.kind,
		codec: row.codec,
		dataBlob: row.data_blob,
		uncompressedLen: row.uncompressed_len,
	};
}

export class SpoolDAL {
	/** The statements the GC runs in a loop, prepared once. */
	private readonly statements = new Map<string, Database.Statement>();

	constructor(private db: Database.Database) {}

	insertChunk(input: InsertChunkInput): string {
		const id = generateId();
		const ts = new Date().toISOString();

		this.db
			.prepare(
				`INSERT INTO chunks (id, channel_id, seq, ts, kind, codec, data_blob, uncompressed_len)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				input.channelId,
				input.seq,
				ts,
				input.kind,
				input.codec ?? "raw",
				input.dataBlob,
				input.uncompressedLen,
			);

		return id;
	}

	getChunk(id: string): Chunk | undefined {
		const row = this.db.prepare("SELECT * FROM chunks WHERE id = ?").get(id) as
			| ChunkRow
			| undefined;
		return row ? rowToChunk(row) : undefined;
	}

	getChunksByChannel(
		channelId: string,
		opts?: { kind?: string; afterSeq?: number; limit?: number },
	): Chunk[] {
		const conditions: string[] = ["channel_id = ?"];
		const params: unknown[] = [channelId];

		if (opts?.kind !== undefined) {
			conditions.push("kind = ?");
			params.push(opts.kind);
		}
		if (opts?.afterSeq !== undefined) {
			conditions.push("seq > ?");
			params.push(opts.afterSeq);
		}

		let sql = `SELECT * FROM chunks WHERE ${conditions.join(" AND ")} ORDER BY seq ASC`;
		if (opts?.limit !== undefined) {
			sql += " LIMIT ?";
			params.push(opts.limit);
		}

		const rows = this.db.prepare(sql).all(...params) as ChunkRow[];
		return rows.map(rowToChunk);
	}

	getMaxSeq(channelId: string): number {
		const row = this.db
			.prepare("SELECT MAX(seq) as max_seq FROM chunks WHERE channel_id = ?")
			.get(channelId) as { max_seq: number | null } | undefined;
		return row?.max_seq ?? 0;
	}

	getLatestSnapshot(channelId: string): Chunk | undefined {
		const row = this.db
			.prepare(
				`SELECT * FROM chunks
				WHERE channel_id = ? AND kind = 'snapshot'
				ORDER BY seq DESC LIMIT 1`,
			)
			.get(channelId) as ChunkRow | undefined;
		return row ? rowToChunk(row) : undefined;
	}

	/**
	 * Store a snapshot and delete the one it replaces, in one transaction.
	 *
	 * An ATTACH replays the newest snapshot and the output after it, and nothing
	 * reads an older snapshot (STORAGE.md § 7.3), so each one is garbage the
	 * moment the next is stored. Only the previous one goes here, whatever its
	 * age: a backlog an earlier version left is the GC's to clear, in bounded
	 * batches (#726).
	 */
	insertSnapshot(input: Omit<InsertChunkInput, "kind">): string {
		return this.db.transaction(() => {
			const previous = this.statement(
				`SELECT rowid AS rowid, seq FROM chunks INDEXED BY idx_chunks_channel_seq
				 WHERE channel_id = ? AND kind = 'snapshot' ORDER BY seq DESC LIMIT 1`,
			).get(input.channelId) as { rowid: number; seq: number } | undefined;
			const id = this.insertChunk({ ...input, kind: "snapshot" });
			if (previous !== undefined && previous.seq < input.seq) {
				this.statement("DELETE FROM chunks WHERE rowid = ?").run(previous.rowid);
			}
			return id;
		})();
	}

	/** A channel's newest snapshot: its seq and the size it stores, without its data. */
	getLatestSnapshotSize(channelId: string): { seq: number; bytes: number } | undefined {
		return this.statement(
			`SELECT seq, LENGTH(data_blob) AS bytes FROM chunks INDEXED BY idx_chunks_channel_seq
			 WHERE channel_id = ? AND kind = 'snapshot' ORDER BY seq DESC LIMIT 1`,
		).get(channelId) as { seq: number; bytes: number } | undefined;
	}

	/** The first channel with chunks whose id sorts after `after`; one index seek. */
	nextChannelId(after: string): string | undefined {
		const row = this.statement(
			`SELECT channel_id FROM chunks INDEXED BY idx_chunks_channel_seq
			 WHERE channel_id > ? ORDER BY channel_id LIMIT 1`,
		).get(after) as { channel_id: string } | undefined;
		return row?.channel_id;
	}

	/**
	 * Up to `limit` chunks of a channel below `beforeSeq`, newest first, with
	 * the size of what each stores. SQLite reads a blob's length from the row's
	 * header, so this never loads the data.
	 */
	listChunkSizesBefore(channelId: string, beforeSeq: number, limit: number): ChunkSize[] {
		return this.statement(
			`SELECT seq, kind, ts, LENGTH(data_blob) AS bytes FROM chunks INDEXED BY idx_chunks_channel_seq
			 WHERE channel_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?`,
		).all(channelId, beforeSeq, limit) as ChunkSize[];
	}

	/**
	 * Delete, oldest first, the chunks of a channel with a seq in
	 * (`afterSeq`, `throughSeq`] and of the given kinds, no more than `limits`
	 * allows, in one short transaction. The range is walked on
	 * `idx_chunks_channel_seq`, so a batch costs what it deletes, not what the
	 * channel holds. Pass `lastSeq` back as `afterSeq` for the next batch.
	 */
	deleteChunkBatch(
		channelId: string,
		range: { afterSeq: number; throughSeq: number; kinds: ChunkKinds },
		limits: ChunkBatchLimits,
	): ChunkBatchResult {
		// `kinds`: 'all', 'snapshots' (kind = 'snapshot') or 'others' (kind != 'snapshot').
		const pick = this.statement(
			`SELECT seq, LENGTH(data_blob) AS bytes FROM chunks INDEXED BY idx_chunks_channel_seq
			 WHERE channel_id = @channelId AND seq > @afterSeq AND seq <= @throughSeq
			   AND (@kinds = 'all' OR (kind = 'snapshot') = (@kinds = 'snapshots'))
			 ORDER BY seq LIMIT @maxRows`,
		);
		const remove = this.statement(
			`DELETE FROM chunks INDEXED BY idx_chunks_channel_seq
			 WHERE channel_id = @channelId AND seq > @afterSeq AND seq <= @throughSeq
			   AND (@kinds = 'all' OR (kind = 'snapshot') = (@kinds = 'snapshots'))`,
		);
		const params = { channelId, afterSeq: range.afterSeq, kinds: range.kinds };
		return this.db.transaction((): ChunkBatchResult => {
			const rows = pick.all({
				...params,
				throughSeq: range.throughSeq,
				maxRows: limits.maxRows,
			}) as Array<{ seq: number; bytes: number }>;
			let bytes = 0;
			let lastSeq: number | undefined;
			for (const row of rows) {
				bytes += row.bytes;
				lastSeq = row.seq;
				if (bytes >= limits.maxBytes) break;
			}
			if (lastSeq === undefined) return { deleted: 0, bytes: 0, lastSeq };
			const deleted = remove.run({ ...params, throughSeq: lastSeq }).changes;
			return { deleted, bytes, lastSeq };
		})();
	}

	getChannelChunkCount(channelId: string): number {
		const row = this.db
			.prepare("SELECT COUNT(*) as count FROM chunks WHERE channel_id = ?")
			.get(channelId) as { count: number };
		return row.count;
	}

	/** Sum of data_blob sizes for a channel: one scan of all its chunks, so not for the GC. */
	getChannelSize(channelId: string): number {
		const row = this.db
			.prepare(
				"SELECT COALESCE(SUM(LENGTH(data_blob)), 0) AS total FROM chunks WHERE channel_id = ?",
			)
			.get(channelId) as { total: number };
		return row.total;
	}

	/**
	 * Give up to `pages` free pages back to the file system, and say how many
	 * are still free. A bounded step: `incremental_vacuum(0)` would free them
	 * all at once, a gigabyte after a large cleanup (#726).
	 */
	incrementalVacuum(pages: number): number {
		const count = Math.max(1, Math.floor(pages));
		this.db.pragma(`incremental_vacuum(${count})`);
		return this.db.pragma("freelist_count", { simple: true }) as number;
	}

	private statement(sql: string): Database.Statement {
		let statement = this.statements.get(sql);
		if (statement === undefined) {
			statement = this.db.prepare(sql);
			this.statements.set(sql, statement);
		}
		return statement;
	}
}
