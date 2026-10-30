import type Database from "better-sqlite3";

export type ChunkKind = "output" | "snapshot" | "resize";

/** A chunk to seed: its kind, its stored size, and how long ago it was written. */
export interface ChunkSeed {
	kind: ChunkKind;
	bytes: number;
	ageMs?: number;
}

/** Write chunks for a channel in one transaction, with consecutive seqs from `firstSeq`. */
export function seedChunks(
	spool: Database.Database,
	channelId: string,
	chunks: ChunkSeed[],
	firstSeq = 1,
): void {
	const insert = spool.prepare(
		`INSERT INTO chunks (id, channel_id, seq, ts, kind, codec, data_blob, uncompressed_len)
		 VALUES (?, ?, ?, ?, ?, 'raw', ?, ?)`,
	);
	const now = Date.now();
	spool.transaction(() => {
		chunks.forEach((chunk, i) => {
			const seq = firstSeq + i;
			const blob = Buffer.alloc(chunk.bytes, seq % 251);
			const ts = new Date(now - (chunk.ageMs ?? 0)).toISOString();
			insert.run(`${channelId}-${seq}`, channelId, seq, ts, chunk.kind, blob, blob.length);
		});
	})();
}

/** How many chunks a channel holds in the spool. */
export function countChunks(spool: Database.Database, channelId: string): number {
	return (
		spool.prepare("SELECT COUNT(*) AS n FROM chunks WHERE channel_id = ?").get(channelId) as {
			n: number;
		}
	).n;
}

/**
 * Watch the event loop: the longest stretch between two turns, and the most
 * rows SQLite changed in the spool within one stretch.
 */
export function watchEventLoop(spool: Database.Database) {
	const changes = () => (spool.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
	let last = performance.now();
	let lastChanges = changes();
	let longestMs = 0;
	let mostRows = 0;
	let turns = 0;
	let watching = true;
	const sample = () => {
		const now = performance.now();
		const c = changes();
		longestMs = Math.max(longestMs, now - last);
		mostRows = Math.max(mostRows, c - lastChanges);
		last = now;
		lastChanges = c;
	};
	const turn = () => {
		if (!watching) return;
		sample();
		turns++;
		setImmediate(turn);
	};
	setImmediate(turn);
	return {
		stop() {
			watching = false;
			sample();
			return { longestMs, mostRows, turns };
		},
	};
}
