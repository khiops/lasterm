import type { SpoolDAL } from "../storage/spool.js";

const CHUNK_MAX_BYTES = 256 * 1024; // 256 KB
const CHUNK_FLUSH_MS = 1_000; // 1 second

interface ChannelBuffer {
	chunks: Uint8Array[];
	totalBytes: number;
	timer: ReturnType<typeof setTimeout> | null;
	nextSeq: number;
}

export class OutputChunker {
	private channels = new Map<string, ChannelBuffer>();

	constructor(private spoolDal: SpoolDAL) {}

	/** Start tracking a channel for output chunking */
	trackChannel(channelId: string, startSeq?: number): void {
		if (this.channels.has(channelId)) return;
		// Resume from the last seq in spool.db to avoid UNIQUE constraint
		// violations after hot-reload (tsx watch resets in-memory state but
		// spool.db retains old chunks).
		const resumeSeq = startSeq ?? this.spoolDal.getMaxSeq(channelId) + 1;
		this.channels.set(channelId, {
			chunks: [],
			totalBytes: 0,
			timer: null,
			nextSeq: resumeSeq,
		});
	}

	/** Accumulate OUTPUT data for a channel */
	onOutput(channelId: string, data: Uint8Array): void {
		const buf = this.channels.get(channelId);
		if (!buf) return;

		buf.chunks.push(data);
		buf.totalBytes += data.byteLength;

		// Size-triggered flush
		if (buf.totalBytes >= CHUNK_MAX_BYTES) {
			this.flushOrDrop(channelId);
			return;
		}

		// Start timer-triggered flush if not already running
		if (!buf.timer) {
			buf.timer = setTimeout(() => {
				buf.timer = null;
				this.flushOrDrop(channelId);
			}, CHUNK_FLUSH_MS);
		}
	}

	/**
	 * Force-flush buffered data to spool.db. A failed write throws and leaves
	 * the bytes buffered: the callers that ask for it log it themselves. They
	 * stay only until the timer, a size flush or the end of the channel
	 * drops them (`flushOrDrop`).
	 */
	flush(channelId: string): void {
		const buf = this.channels.get(channelId);
		if (!buf || buf.totalBytes === 0) return;

		// Concatenate all chunks into a single blob
		const blob = this._concatChunks(buf.chunks, buf.totalBytes);

		// Write to spool.db
		this.spoolDal.insertChunk({
			channelId,
			seq: buf.nextSeq,
			kind: "output",
			dataBlob: blob,
			uncompressedLen: blob.byteLength,
		});

		// Reset buffer
		buf.nextSeq++;
		buf.chunks = [];
		buf.totalBytes = 0;
		if (buf.timer) {
			clearTimeout(buf.timer);
			buf.timer = null;
		}
	}

	/**
	 * Flush from a path that has no handler: a size or timer flush, the end of
	 * a terminal, a shutdown. A failed write (disk full, I/O error) is logged
	 * by its code and its bytes are dropped, never rethrown (#1098). The spool
	 * is the attach tail and the screen snapshot covers what it misses; kept,
	 * the bytes would grow without bound while the disk stays full (a live
	 * terminal) or never be retried (an ended one). The failed write took no
	 * seq, so the spool's seq numbers have no gap; the bytes themselves are
	 * lost, and the screen may show it until the next snapshot.
	 */
	private flushOrDrop(channelId: string): void {
		try {
			this.flush(channelId);
		} catch (err) {
			const buf = this.channels.get(channelId);
			const droppedBytes = buf?.totalBytes ?? 0;
			if (buf) {
				buf.chunks = [];
				buf.totalBytes = 0;
				if (buf.timer) {
					clearTimeout(buf.timer);
					buf.timer = null;
				}
			}
			const code = (err as { code?: unknown } | null)?.code;
			console.error(
				`[lasterm-spool] write failed (${typeof code === "string" ? code : "no code"}), dropped ${droppedBytes} bytes of output for channel ${channelId}`,
			);
		}
	}

	/** Flush and stop tracking a channel */
	untrackChannel(channelId: string): void {
		this.flushOrDrop(channelId);
		const buf = this.channels.get(channelId);
		if (buf?.timer) clearTimeout(buf.timer);
		this.channels.delete(channelId);
	}

	/** Flush all channels and stop */
	shutdown(): void {
		for (const channelId of this.channels.keys()) {
			this.untrackChannel(channelId);
		}
	}

	/** Get the current next seq for a channel (useful for SNAPSHOT_RES handling) */
	getNextSeq(channelId: string): number {
		return this.channels.get(channelId)?.nextSeq ?? 1;
	}

	/** Ensure nextSeq is at least `minSeq` (used after external snapshot insertions) */
	bumpSeq(channelId: string, minSeq: number): void {
		const buf = this.channels.get(channelId);
		if (buf && buf.nextSeq < minSeq) {
			buf.nextSeq = minSeq;
		}
	}

	private _concatChunks(chunks: Uint8Array[], totalBytes: number): Buffer {
		const result = Buffer.alloc(totalBytes);
		let offset = 0;
		for (const chunk of chunks) {
			result.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return result;
	}
}
