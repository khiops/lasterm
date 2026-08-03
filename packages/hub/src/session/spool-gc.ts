import type { GcConfig } from "../config.js";
import { DEFAULT_GC_CONFIG } from "../config.js";
import type { MetaDAL } from "../storage/meta.js";
import type { SpoolDAL } from "../storage/spool.js";

const GC_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const GC_MAX_AGE_HOURS = 168; // 7 days

export class SpoolGarbageCollector {
	private timer: ReturnType<typeof setInterval> | null = null;
	private readonly deadRetentionMs: number;
	private readonly maxSizePerChannel: number;

	constructor(
		private spoolDal: SpoolDAL,
		private metaDal: Pick<MetaDAL, "listStaleDeadChannelIds">,
		gcConfig?: GcConfig,
	) {
		const config = gcConfig ?? DEFAULT_GC_CONFIG;
		this.deadRetentionMs = config.deadRetentionHours * 60 * 60 * 1000;
		this.maxSizePerChannel = config.maxSizePerChannelMb * 1024 * 1024;
	}

	start(): void {
		if (this.timer !== null) return;
		this.timer = setInterval(() => this.collect(), GC_INTERVAL_MS);
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	collect(): void {
		// Phase 1: delete chunks older than GC_MAX_AGE_HOURS
		const ageCutoff = new Date(Date.now() - GC_MAX_AGE_HOURS * 3600 * 1000).toISOString();
		this.spoolDal.deleteChunksOlderThan(ageCutoff);

		// Phase 2: per-channel size cap — evict oldest output chunks if over limit
		const channelIds = this.spoolDal.listChannelIds();
		for (const channelId of channelIds) {
			if (this.spoolDal.getChannelSize(channelId) > this.maxSizePerChannel) {
				this.spoolDal.evictOldestChunks(channelId, this.maxSizePerChannel);
			}
		}

		// Phase 3: dead channel cleanup — delete spool data for channels dead longer than retention
		const deadCutoff = new Date(Date.now() - this.deadRetentionMs).toISOString();
		const staleDeadIds = this.metaDal.listStaleDeadChannelIds(deadCutoff);
		for (const channelId of staleDeadIds) {
			this.spoolDal.deleteChunksForChannel(channelId);
		}

		// Reclaim freed pages
		this.spoolDal.incrementalVacuum();
	}
}
