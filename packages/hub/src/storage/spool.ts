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

	deleteChunksOlderThan(before: string): number {
		const result = this.db
			.prepare(
				`DELETE FROM chunks WHERE ts < ?
  AND id NOT IN (
    SELECT c2.id FROM chunks c2
    WHERE c2.kind = 'snapshot'
    AND c2.seq = (
      SELECT MAX(c3.seq) FROM chunks c3
      WHERE c3.channel_id = c2.channel_id AND c3.kind = 'snapshot'
    )
  )`,
			)
			.run(before);
		return result.changes;
	}

	getChannelChunkCount(channelId: string): number {
		const row = this.db
			.prepare("SELECT COUNT(*) as count FROM chunks WHERE channel_id = ?")
			.get(channelId) as { count: number };
		return row.count;
	}

	/** Sum of data_blob sizes for a channel. */
	getChannelSize(channelId: string): number {
		const row = this.db
			.prepare(
				"SELECT COALESCE(SUM(LENGTH(data_blob)), 0) AS total FROM chunks WHERE channel_id = ?",
			)
			.get(channelId) as { total: number };
		return row.total;
	}

	/** Delete all chunks for a channel. Returns deleted count. */
	deleteChunksForChannel(channelId: string): number {
		return this.db.prepare("DELETE FROM chunks WHERE channel_id = ?").run(channelId).changes;
	}

	/** List distinct channel_ids that have chunks. */
	listChannelIds(): string[] {
		return this.db
			.prepare("SELECT DISTINCT channel_id FROM chunks")
			.all()
			.map((r) => (r as { channel_id: string }).channel_id);
	}

	/** Delete oldest output chunks for channel until size <= target.
	 *  Preserves snapshots (kind != 'output'). Returns deleted count. */
	evictOldestChunks(channelId: string, targetSize: number): number {
		let deleted = 0;
		while (this.getChannelSize(channelId) > targetSize) {
			const oldest = this.db
				.prepare(
					"SELECT id FROM chunks WHERE channel_id = ? AND kind = 'output' ORDER BY seq ASC LIMIT 1",
				)
				.get(channelId) as { id: string } | undefined;
			if (!oldest) break; // only snapshots left
			this.db.prepare("DELETE FROM chunks WHERE id = ?").run(oldest.id);
			deleted++;
		}
		return deleted;
	}

	incrementalVacuum(pages?: number): void {
		this.db.pragma(`incremental_vacuum(${pages ?? 0})`);
	}
}
