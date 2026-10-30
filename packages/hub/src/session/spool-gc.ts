import type { GcConfig } from "../config.js";
import { DEFAULT_GC_CONFIG } from "../config.js";
import type { HubLogger } from "../logging/hub-logger.js";
import type { MetaDAL } from "../storage/meta.js";
import type { ChunkBatchLimits, ChunkKinds, SpoolDAL } from "../storage/spool.js";

const GC_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const GC_MAX_AGE_HOURS = 168; // 7 days

/**
 * The longest a pass holds the event loop before it yields (#726). better-sqlite3
 * is synchronous, so whatever the GC does in one go, every terminal and request
 * of the hub waits for.
 */
const SLICE_BUDGET_MS = 25;
/** One delete: at most this many rows, and about this many bytes, in one transaction. */
const DELETE_BATCH: ChunkBatchLimits = { maxRows: 256, maxBytes: 1024 * 1024 };
/** Chunks read per step of the walk that finds where a channel stops fitting. */
const WALK_ROWS = 512;
/** Pages given back per `incremental_vacuum` step: half a MiB. */
const VACUUM_PAGES = 128;

const FIRST_SEQ = Number.MIN_SAFE_INTEGER;
const LAST_SEQ = Number.MAX_SAFE_INTEGER;

/** Let the event loop turn once: timers, sockets, every terminal. */
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

export interface SpoolGcOptions {
	/** Overrides SLICE_BUDGET_MS; tests use 0 to yield before every step. */
	sliceBudgetMs?: number;
	/** Overrides the 10-minute interval. */
	intervalMs?: number;
	logger?: Pick<HubLogger, "log"> | null;
}

/** What one pass, or one purge, did. */
export interface GcPassStats {
	/** False when the pass was stopped, or failed, before its end. */
	completed: boolean;
	deletedChunks: number;
	deletedBytes: number;
	/** Channels emptied because meta.db no longer has them (#786). */
	orphans: number;
	/** Pages left on the free list at the end. */
	freePages: number;
	/** How many times the pass ran without yielding, and the longest of them. */
	slices: number;
	longestSliceMs: number;
}

type Job = (slicer: Slicer, stats: GcPassStats) => Promise<void>;

class PassStopped extends Error {}

/**
 * Runs a pass as a series of short steps, yielding to the event loop between
 * slices. A slice takes steps until the next could take it past its budget,
 * judged by the longest step so far, then yields; a pass that `stop()` ended
 * stops before its next step, so nothing touches a database closed meanwhile.
 */
class Slicer {
	private sliceStart = performance.now();
	private longestStep = 0;
	slices = 1;
	longestSliceMs = 0;

	constructor(
		private readonly budgetMs: number,
		private readonly stopped: () => boolean,
	) {}

	async step<T>(work: () => T): Promise<T> {
		if (performance.now() - this.sliceStart + this.longestStep > this.budgetMs) {
			await nextTurn();
			this.sliceStart = performance.now();
			this.slices++;
		}
		if (this.stopped()) throw new PassStopped();
		const start = performance.now();
		const result = work();
		const end = performance.now();
		this.longestStep = Math.max(this.longestStep, end - start);
		this.longestSliceMs = Math.max(this.longestSliceMs, end - this.sliceStart);
		return result;
	}
}

/**
 * Keeps spool.db bounded (STORAGE.md § 7). Every 10 minutes a pass:
 *
 * 1. empties each channel dead longer than its retention;
 * 2. for every channel in the spool, empties it if meta.db no longer has it
 *    (#786); otherwise deletes the snapshots older than its newest, then
 *    whatever is past the age limit or the size cap, the newest snapshot
 *    counted in the size and never deleted;
 * 3. gives the freed pages back to the file system.
 *
 * A purge (`purge`) empties channels just deleted from meta.db the same way,
 * without waiting for the next pass.
 *
 * Every step is bounded, and a pass or a purge yields between slices, so a
 * spool of any size is cleaned without freezing the hub (#726). They run one
 * at a time, in the order asked: two side by side would each take a slice in
 * the same turn of the event loop. A pass still running when the next is due
 * is left to finish; no second one starts.
 */
export class SpoolGarbageCollector {
	private timer: ReturnType<typeof setInterval> | null = null;
	private pass: Promise<GcPassStats> | null = null;
	/** The pass or purge asked for last, and how many are running or waiting. */
	private lane: Promise<GcPassStats> | null = null;
	private queued = 0;
	private stopped = false;
	private readonly deadRetentionMs: number;
	private readonly maxSizePerChannel: number;
	private readonly sliceBudgetMs: number;
	private readonly intervalMs: number;
	private readonly logger: Pick<HubLogger, "log"> | null;

	constructor(
		private spoolDal: SpoolDAL,
		private metaDal: Pick<MetaDAL, "listStaleDeadChannelIds" | "hasChannel">,
		gcConfig?: GcConfig,
		options: SpoolGcOptions = {},
	) {
		const config = gcConfig ?? DEFAULT_GC_CONFIG;
		this.deadRetentionMs = config.deadRetentionHours * 60 * 60 * 1000;
		this.maxSizePerChannel = config.maxSizePerChannelMb * 1024 * 1024;
		this.sliceBudgetMs = options.sliceBudgetMs ?? SLICE_BUDGET_MS;
		this.intervalMs = options.intervalMs ?? GC_INTERVAL_MS;
		this.logger = options.logger ?? null;
	}

	start(): void {
		if (this.timer !== null) return;
		this.timer = setInterval(() => {
			void this.collect();
		}, this.intervalMs);
	}

	/** Stop the timer, and a running pass or purge before its next step. */
	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		this.stopped = true;
	}

	/** Run a pass, or join the one already running or waiting. Never rejects. */
	collect(): Promise<GcPassStats> {
		if (this.pass !== null) return this.pass;
		this.stopped = false;
		const pass = this.enqueue("pass", (slicer, stats) => this.runPass(slicer, stats)).finally(
			() => {
				if (this.pass === pass) this.pass = null;
			},
		);
		this.pass = pass;
		return pass;
	}

	/**
	 * Empty channels just deleted from meta.db, in a pass's bounded batches,
	 * then give the pages back: a purge must not delete a channel's whole
	 * history in one statement (#786). A channel meta.db still has is left
	 * alone, as a pass would leave it. It runs after the pass or purge already
	 * running, if any. Never rejects.
	 */
	purge(channelIds: readonly string[]): Promise<GcPassStats> {
		const ids = [...channelIds];
		return this.enqueue("purge", async (slicer, stats) => {
			for (const channelId of ids) await this.collectOrphan(slicer, stats, channelId);
			stats.freePages = await this.vacuum(slicer);
		});
	}

	/** Run `job`, with slices of its own, once the pass or purge before it has ended. */
	private enqueue(what: "pass" | "purge", job: Job): Promise<GcPassStats> {
		const before = this.queued > 0 ? this.lane : null;
		this.queued++;
		const run = async (): Promise<GcPassStats> => {
			try {
				// The one before may have ended part-way through its slice.
				if (before !== null) await nextTurn();
				return await this.runJob(what, job);
			} finally {
				this.queued--;
			}
		};
		const result = before === null ? run() : before.then(run);
		this.lane = result;
		return result;
	}

	private async runJob(what: "pass" | "purge", job: Job): Promise<GcPassStats> {
		const slicer = new Slicer(this.sliceBudgetMs, () => this.stopped);
		const stats: GcPassStats = {
			completed: false,
			deletedChunks: 0,
			deletedBytes: 0,
			orphans: 0,
			freePages: 0,
			slices: 0,
			longestSliceMs: 0,
		};
		try {
			await job(slicer, stats);
			stats.completed = true;
		} catch (error) {
			if (!(error instanceof PassStopped)) {
				this.logger?.log("warn", `spool GC ${what} failed`, {
					err: error instanceof Error ? error.message : String(error),
				});
			}
		}
		stats.slices = slicer.slices;
		stats.longestSliceMs = slicer.longestSliceMs;
		if (stats.completed) {
			this.logger?.log("debug", `spool GC ${what} done`, { ...stats });
		}
		return stats;
	}

	private async runPass(slicer: Slicer, stats: GcPassStats): Promise<void> {
		// 1. Channels dead past their retention: every chunk they held when judged.
		// A chunk written after that has a higher seq, and is not theirs to lose:
		// a channel can be brought back under its own id meanwhile.
		const deadCutoff = new Date(Date.now() - this.deadRetentionMs).toISOString();
		const staleDead = await slicer.step(() => this.metaDal.listStaleDeadChannelIds(deadCutoff));
		for (const channelId of staleDead) {
			const through = await slicer.step(() => this.spoolDal.getMaxSeq(channelId));
			await this.deleteRange(slicer, stats, channelId, "all", through);
		}

		// 2. Every channel in the spool, one index seek to the next: emptied if
		// meta.db no longer has it, kept within its bounds otherwise.
		const ageCutoff = new Date(Date.now() - GC_MAX_AGE_HOURS * 3600 * 1000).toISOString();
		let channelId = await slicer.step(() => this.spoolDal.nextChannelId(""));
		while (channelId !== undefined) {
			if (!(await this.collectOrphan(slicer, stats, channelId))) {
				await this.collectChannel(slicer, stats, channelId, ageCutoff);
			}
			const after = channelId;
			channelId = await slicer.step(() => this.spoolDal.nextChannelId(after));
		}

		// 3. Give the freed pages back.
		stats.freePages = await this.vacuum(slicer);
	}

	/**
	 * Empty a channel meta.db has no row for: one deleted, or whose host was
	 * (#786). Nothing ties the two databases (STORAGE.md § 4.1), so each
	 * channel is looked up in meta.db, in the same step that reads its highest
	 * seq, rather than against a list of known ids read beforehand, which a
	 * channel created during the pass would not be on. A channel has its row
	 * before it has a chunk, so one without a row when looked up was deleted.
	 * Every chunk it held then goes; one written after has a higher seq, and
	 * is not deleted. Says whether the channel was an orphan.
	 */
	private async collectOrphan(
		slicer: Slicer,
		stats: GcPassStats,
		channelId: string,
	): Promise<boolean> {
		const through = await slicer.step(() =>
			this.metaDal.hasChannel(channelId) ? undefined : this.spoolDal.getMaxSeq(channelId),
		);
		if (through === undefined) return false;
		await this.deleteRange(slicer, stats, channelId, "all", through);
		stats.orphans++;
		return true;
	}

	/**
	 * One channel. Only its newest snapshot is ever read: an ATTACH replays it
	 * and the output after it, and nothing else reads a snapshot. So the older
	 * ones go first. The newest is kept whatever its age or size, and counted
	 * first in the channel's size. Then, walking down from the newest chunk,
	 * the first chunk other than a snapshot that is older than the age limit,
	 * or that takes the channel past its size cap, is where it stops fitting:
	 * that chunk and every older one that is not a snapshot go.
	 */
	private async collectChannel(
		slicer: Slicer,
		stats: GcPassStats,
		channelId: string,
		ageCutoff: string,
	): Promise<void> {
		const newest = await slicer.step(() => this.spoolDal.getLatestSnapshotSize(channelId));
		if (newest !== undefined) {
			await this.deleteRange(slicer, stats, channelId, "snapshots", newest.seq - 1);
		}

		let total = newest?.bytes ?? 0;
		let before = LAST_SEQ;
		let cut: number | undefined;
		walk: for (;;) {
			const below = before;
			const chunks = await slicer.step(() =>
				this.spoolDal.listChunkSizesBefore(channelId, below, WALK_ROWS),
			);
			for (const chunk of chunks) {
				if (chunk.seq === newest?.seq) continue;
				total += chunk.bytes;
				// One stored since this pass looked is newer still, and kept as well.
				if (chunk.kind === "snapshot") continue;
				if (total > this.maxSizePerChannel || chunk.ts < ageCutoff) {
					cut = chunk.seq;
					break walk;
				}
			}
			const last = chunks[chunks.length - 1];
			if (last === undefined || chunks.length < WALK_ROWS) break;
			before = last.seq;
		}
		if (cut !== undefined) {
			await this.deleteRange(slicer, stats, channelId, "others", cut);
		}
	}

	/** Delete a channel's chunks of `kinds` up to `throughSeq`, a bounded batch per step. */
	private async deleteRange(
		slicer: Slicer,
		stats: GcPassStats,
		channelId: string,
		kinds: ChunkKinds,
		throughSeq: number,
	): Promise<void> {
		let afterSeq = FIRST_SEQ;
		for (;;) {
			const from = afterSeq;
			const batch = await slicer.step(() =>
				this.spoolDal.deleteChunkBatch(
					channelId,
					{ afterSeq: from, throughSeq, kinds },
					DELETE_BATCH,
				),
			);
			stats.deletedChunks += batch.deleted;
			stats.deletedBytes += batch.bytes;
			if (batch.lastSeq === undefined) return;
			afterSeq = batch.lastSeq;
		}
	}

	/**
	 * Give the freed pages back, a bounded step at a time, and say how many are
	 * still free. A database whose auto_vacuum is not incremental frees
	 * nothing: stop when nothing moves.
	 */
	private async vacuum(slicer: Slicer): Promise<number> {
		let free = Number.POSITIVE_INFINITY;
		for (;;) {
			const before = free;
			free = await slicer.step(() => this.spoolDal.incrementalVacuum(VACUUM_PAGES));
			if (free === 0 || free >= before) return free;
		}
	}
}
