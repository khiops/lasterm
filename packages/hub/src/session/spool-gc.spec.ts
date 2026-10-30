import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseManager } from "../storage/db.js";
import { openTestDatabases } from "../storage/db.js";
import { MetaDAL } from "../storage/meta.js";
import {
	type ChunkKind as Kind,
	type ChunkSeed as Seed,
	seedChunks,
	watchEventLoop as watchSpoolLoop,
} from "../storage/spool.fixture.js";
import { SpoolDAL } from "../storage/spool.js";
import { ChannelLifecycleManager } from "./channel-lifecycle-manager.js";
import type { SharedSessionContext } from "./session-context.js";
import { SpoolGarbageCollector } from "./spool-gc.js";
import type { StateBroadcaster } from "./state-broadcaster.js";

const KiB = 1024;
const MiB = 1024 * KiB;
const DAY = 24 * 3600 * 1000;

describe("SpoolGarbageCollector (#726)", () => {
	let dbs: DatabaseManager;
	let spoolDal: SpoolDAL;
	let staleDead: string[];
	/** The channels meta.db has a row for: every one seeded, unless a case says otherwise. */
	let known: Set<string>;
	let metaDal: Pick<MetaDAL, "listStaleDeadChannelIds" | "hasChannel">;
	let gc: SpoolGarbageCollector | undefined;

	beforeEach(() => {
		dbs = openTestDatabases();
		spoolDal = new SpoolDAL(dbs.spool);
		staleDead = [];
		known = new Set();
		metaDal = {
			listStaleDeadChannelIds: vi.fn(() => staleDead),
			hasChannel: vi.fn((id: string) => known.has(id)),
		};
	});

	afterEach(() => {
		gc?.stop();
		gc = undefined;
		vi.useRealTimers();
		dbs.close();
	});

	function makeGc(
		config: { maxSizePerChannelMb?: number; deadRetentionHours?: number } = {},
		options: { sliceBudgetMs?: number; intervalMs?: number } = {},
	): SpoolGarbageCollector {
		gc = new SpoolGarbageCollector(
			spoolDal,
			metaDal,
			{ maxSizePerChannelMb: 10, deadRetentionHours: 24, ...config },
			options,
		);
		return gc;
	}

	/** Seed a channel meta.db has a row for. */
	function seed(channelId: string, chunks: Seed[], firstSeq = 1): void {
		known.add(channelId);
		seedChunks(dbs.spool, channelId, chunks, firstSeq);
	}

	function rows(channelId: string): Array<{ seq: number; kind: Kind }> {
		return dbs.spool
			.prepare("SELECT seq, kind FROM chunks WHERE channel_id = ? ORDER BY seq")
			.all(channelId) as Array<{ seq: number; kind: Kind }>;
	}

	function count(channelId: string, kind: Kind): number {
		return (
			dbs.spool
				.prepare("SELECT COUNT(*) AS n FROM chunks WHERE channel_id = ? AND kind = ?")
				.get(channelId, kind) as { n: number }
		).n;
	}

	/** What an ATTACH answered from the spool carries (`buildAttachPayload`). */
	function attachPayload(channelId: string) {
		const lifecycle = new ChannelLifecycleManager(
			{ spoolDal } as unknown as SharedSessionContext,
			{} as StateBroadcaster,
		);
		return lifecycle.buildAttachPayload(channelId);
	}

	/** Watch the event loop while a pass runs. */
	function watchEventLoop() {
		return watchSpoolLoop(dbs.spool);
	}

	// ── Snapshots ─────────────────────────────────────────────────────────────

	it("keeps only a channel's newest snapshot, and all of its output under the cap", async () => {
		const chunks: Seed[] = [];
		for (let i = 0; i < 50; i++) {
			chunks.push({ kind: "output", bytes: 100 }, { kind: "snapshot", bytes: 200 });
		}
		chunks.push({ kind: "output", bytes: 100 });
		seed("ch", chunks);

		await makeGc().collect();

		const left = rows("ch");
		expect(left.filter((r) => r.kind === "snapshot")).toEqual([{ seq: 100, kind: "snapshot" }]);
		expect(left.filter((r) => r.kind === "output")).toHaveLength(51);
	});

	it("leaves the snapshot an ATTACH replays, and the output after it, as they were", async () => {
		const chunks: Seed[] = [];
		for (let i = 0; i < 200; i++) {
			chunks.push({ kind: "snapshot", bytes: 300 }, { kind: "output", bytes: 50 });
		}
		seed("ch", chunks);
		const before = attachPayload("ch");
		expect(before.snapshot).toBeNull(); // the seeded blob is not JSON
		const latest = spoolDal.getLatestSnapshot("ch");

		await makeGc().collect();

		expect(spoolDal.getLatestSnapshot("ch")).toEqual(latest);
		expect(attachPayload("ch")).toEqual(before);
		expect(before.tail).toHaveLength(1);
	});

	// ── Size cap ──────────────────────────────────────────────────────────────

	it("counts the snapshot in the size cap and evicts the oldest output past it", async () => {
		// 10 × 100 KiB of output, then a 600 KiB snapshot: 1.6 MiB against 1 MiB.
		seed("ch", [
			...Array.from({ length: 10 }, (): Seed => ({ kind: "output", bytes: 100 * KiB })),
			{ kind: "snapshot", bytes: 600 * KiB },
		]);

		await makeGc({ maxSizePerChannelMb: 1 }).collect();

		// 600 KiB + the four newest outputs fit; a fifth would not.
		expect(rows("ch").map((r) => r.seq)).toEqual([7, 8, 9, 10, 11]);
		expect(spoolDal.getChannelSize("ch")).toBeLessThanOrEqual(MiB);
	});

	it("never evicts the newest snapshot, even alone over the cap", async () => {
		seed("ch", [
			{ kind: "output", bytes: 10 * KiB },
			{ kind: "snapshot", bytes: 2 * MiB },
			{ kind: "output", bytes: 10 * KiB },
		]);

		await makeGc({ maxSizePerChannelMb: 1 }).collect();

		expect(rows("ch")).toEqual([{ seq: 2, kind: "snapshot" }]);
	});

	it("evicts output past the cap even after the newest snapshot, and keeps that snapshot", async () => {
		seed("ch", [
			{ kind: "snapshot", bytes: 100 * KiB },
			...Array.from({ length: 12 }, (): Seed => ({ kind: "output", bytes: 100 * KiB })),
		]);

		await makeGc({ maxSizePerChannelMb: 1 }).collect();

		// The snapshot and the nine newest outputs: 1000 KiB.
		expect(rows("ch").map((r) => r.seq)).toEqual([1, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
	});

	// ── Age ───────────────────────────────────────────────────────────────────

	it("drops what is older than seven days, but keeps the newest snapshot however old", async () => {
		seed("idle", [
			{ kind: "output", bytes: 10, ageMs: 9 * DAY },
			{ kind: "snapshot", bytes: 10, ageMs: 9 * DAY },
			{ kind: "output", bytes: 10, ageMs: 8 * DAY },
			{ kind: "snapshot", bytes: 10, ageMs: 8 * DAY },
		]);
		seed("busy", [
			{ kind: "output", bytes: 10, ageMs: 8 * DAY },
			{ kind: "output", bytes: 10, ageMs: 6 * DAY },
			{ kind: "snapshot", bytes: 10, ageMs: 6 * DAY },
			{ kind: "output", bytes: 10 },
		]);

		await makeGc().collect();

		expect(rows("idle")).toEqual([{ seq: 4, kind: "snapshot" }]);
		expect(rows("busy").map((r) => r.seq)).toEqual([2, 3, 4]);
	});

	// ── Dead channels ─────────────────────────────────────────────────────────

	it("empties a channel dead past its retention, sparing what it wrote after the pass judged it", async () => {
		seed(
			"dead",
			Array.from({ length: 600 }, (): Seed => ({ kind: "output", bytes: 10 })),
		);
		seed("alive", [{ kind: "snapshot", bytes: 10 }]);
		staleDead = ["dead"];
		// The channel comes back under its own id while the pass is deleting it.
		const deleteBatch = spoolDal.deleteChunkBatch.bind(spoolDal);
		let batches = 0;
		vi.spyOn(spoolDal, "deleteChunkBatch").mockImplementation((...args) => {
			const result = deleteBatch(...args);
			if (args[0] === "dead" && ++batches === 1) {
				seed("dead", [{ kind: "snapshot", bytes: 10 }], 601);
			}
			return result;
		});

		await makeGc({}, { sliceBudgetMs: 0 }).collect();

		expect(batches).toBeGreaterThan(1);
		expect(rows("dead")).toEqual([{ seq: 601, kind: "snapshot" }]);
		expect(rows("alive")).toEqual([{ seq: 1, kind: "snapshot" }]);
	});

	// ── Channels meta.db no longer has (#786) ─────────────────────────────────

	it("removes the output of a deleted host's channels, and nothing of another host's", async () => {
		const meta = new MetaDAL(dbs.meta);
		const channelsOf = (label: string): string[] => {
			const host = meta.createHost({ type: "local", label });
			const sessionId = `${label}-session`;
			meta.createSession({ id: sessionId, hostId: host.id, status: "active" });
			return ["a", "b"].map((suffix) => {
				const id = `${label}-${suffix}`;
				meta.createChannel({ id, sessionId, status: "live", cols: 80, rows: 24 });
				seedChunks(dbs.spool, id, [
					...Array.from({ length: 300 }, (): Seed => ({ kind: "output", bytes: 100 })),
					{ kind: "snapshot", bytes: 100 },
				]);
				return id;
			});
		};
		const deleted = channelsOf("deleted");
		const kept = channelsOf("kept");
		// What DELETE /api/hosts/:id does: meta.db only, spool.db is another database.
		const host = meta.getHostByLabel("deleted");
		meta.deleteCascadeForHost(host?.id as string);
		meta.deleteHost(host?.id as string);

		gc = new SpoolGarbageCollector(spoolDal, meta, {
			maxSizePerChannelMb: 10,
			deadRetentionHours: 24,
		});
		const stats = await gc.collect();

		// Before #786 the size cap kept each one's newest snapshot, for ever.
		for (const id of deleted) expect(rows(id)).toEqual([]);
		for (const id of kept) expect(rows(id)).toHaveLength(301);
		expect(stats).toMatchObject({ completed: true, orphans: 2 });
	});

	it("never takes a channel meta.db has for an orphan, even one created during the pass", async () => {
		// An orphan big enough to take several batches, and a channel created
		// while the pass deletes it, whose id the walk reaches afterwards.
		seedChunks(
			dbs.spool,
			"a-orphan",
			Array.from({ length: 600 }, (): Seed => ({ kind: "output", bytes: 10 })),
		);
		seed("b-live", [
			{ kind: "output", bytes: 10 },
			{ kind: "snapshot", bytes: 10 },
		]);
		const deleteBatch = spoolDal.deleteChunkBatch.bind(spoolDal);
		let created = false;
		vi.spyOn(spoolDal, "deleteChunkBatch").mockImplementation((...args) => {
			const result = deleteBatch(...args);
			if (args[0] === "a-orphan" && !created) {
				created = true;
				// As the hub does it: the channel's row first, then its output.
				seed("c-new", [
					{ kind: "output", bytes: 10 },
					{ kind: "snapshot", bytes: 10 },
				]);
			}
			return result;
		});

		const stats = await makeGc({}, { sliceBudgetMs: 0 }).collect();

		expect(created).toBe(true);
		expect(rows("a-orphan")).toEqual([]);
		expect(rows("b-live")).toHaveLength(2);
		expect(rows("c-new")).toEqual([
			{ seq: 1, kind: "output" },
			{ seq: 2, kind: "snapshot" },
		]);
		expect(stats.orphans).toBe(1);
	});

	it("purges a deleted channel's output one bounded batch at a time", async () => {
		seed(
			"live",
			Array.from({ length: 3_000 }, (): Seed => ({ kind: "output", bytes: 10 })),
		);
		seedChunks(
			dbs.spool,
			"purged",
			Array.from(
				{ length: 5_000 },
				(_, i): Seed => ({
					kind: i % 2 ? "output" : "snapshot",
					bytes: 100,
				}),
			),
		);

		const watch = watchEventLoop();
		// A channel meta.db still has is not the purge's to delete.
		const stats = await makeGc({}, { sliceBudgetMs: 0 }).purge(["purged", "live"]);
		const loop = watch.stop();

		expect(rows("purged")).toEqual([]);
		expect(rows("live")).toHaveLength(3_000);
		expect(stats).toMatchObject({ completed: true, orphans: 1, deletedChunks: 5_000 });
		expect(loop.mostRows).toBeLessThanOrEqual(256);
		expect(dbs.spool.pragma("freelist_count", { simple: true })).toBe(0);
	});

	it("runs a purge after the pass already running, never beside it", async () => {
		seedOwnersProfile();
		const events: string[] = [];
		vi.mocked(metaDal.hasChannel).mockImplementation((id) => {
			if (id === "purged") events.push("purge");
			return known.has(id);
		});
		vi.spyOn(spoolDal, "incrementalVacuum").mockImplementation(() => {
			events.push("vacuum");
			return 0;
		});
		const collector = makeGc({}, { sliceBudgetMs: 0 });

		const pass = collector.collect();
		const purge = collector.purge(["purged"]);
		expect(collector.collect()).toBe(pass);
		const [passStats, purgeStats] = await Promise.all([pass, purge]);

		expect(passStats.completed).toBe(true);
		expect(purgeStats.completed).toBe(true);
		// The pass ends with its vacuum; only then does the purge take its first step.
		expect(events).toEqual(["vacuum", "purge", "vacuum"]);
	});

	it("touches nothing once stopped, a purge asked for afterwards included", async () => {
		const collector = makeGc();
		collector.stop();
		dbs.close();

		await expect(collector.purge(["gone"])).resolves.toMatchObject({ completed: false });
	});

	// ── The freeze ────────────────────────────────────────────────────────────

	/**
	 * The owner's profile in #726: one live channel with 64,509 snapshots, about
	 * one every 6 s for five days, beside 411 output chunks; here 256 bytes a
	 * snapshot instead of 23 KB. Before the fix the pass ran in one synchronous
	 * call, recomputed the channel's size before each output chunk it deleted,
	 * deleted all of the output and kept every snapshot.
	 */
	function seedOwnersProfile(): void {
		const snapshots = 64_509;
		const chunks: Seed[] = [];
		for (let i = 0; i < snapshots; i++) {
			// 400 outputs among the last 800 snapshots, 11 after the newest one.
			if (i >= snapshots - 800 && i % 2 === 0) chunks.push({ kind: "output", bytes: KiB });
			chunks.push({ kind: "snapshot", bytes: 256, ageMs: (snapshots - i) * 6_000 });
		}
		for (let i = 0; i < 11; i++) chunks.push({ kind: "output", bytes: KiB });
		seed("live", chunks);
		// And a week-old channel nobody looked at since: its output is past the age.
		seed("stale", [
			...Array.from(
				{ length: 2_000 },
				(): Seed => ({ kind: "output", bytes: 100, ageMs: 8 * DAY }),
			),
			{ kind: "snapshot", bytes: 100, ageMs: 8 * DAY },
		]);
	}

	it("cleans 65,000 snapshots without holding the event loop", async () => {
		seedOwnersProfile();
		const tail = attachPayload("live");
		expect(count("live", "snapshot")).toBe(64_509);

		const watch = watchEventLoop();
		const stats = await makeGc().collect();
		const loop = watch.stop();

		expect(count("live", "snapshot")).toBe(1);
		expect(count("live", "output")).toBe(411);
		expect(rows("stale")).toEqual([{ seq: 2_001, kind: "snapshot" }]);
		expect(attachPayload("live")).toEqual(tail);
		expect(stats.completed).toBe(true);
		// Before the fix the whole pass was one stretch of several seconds.
		expect(loop.turns).toBeGreaterThan(1);
		expect(loop.longestMs).toBeLessThan(1_000);
	});

	it("touches one bounded batch at a time when its budget is spent", async () => {
		seedOwnersProfile();

		const watch = watchEventLoop();
		await makeGc({}, { sliceBudgetMs: 0 }).collect();
		const loop = watch.stop();

		expect(count("live", "snapshot")).toBe(1);
		// One delete batch is at most 256 rows; before the fix one stretch
		// deleted every row the pass deleted.
		expect(loop.mostRows).toBeLessThanOrEqual(256);
	});

	it("gives the freed pages back a bounded step at a time", async () => {
		seedOwnersProfile();
		const vacuum = vi.spyOn(spoolDal, "incrementalVacuum");

		await makeGc().collect();

		expect(dbs.spool.pragma("freelist_count", { simple: true })).toBe(0);
		expect(vacuum.mock.calls.length).toBeGreaterThan(1);
		for (const [pages] of vacuum.mock.calls) expect(pages).toBeGreaterThan(0);
	});

	// ── Scheduling ────────────────────────────────────────────────────────────

	it("does not start a second pass while one is still running", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		seed(
			"ch",
			Array.from(
				{ length: 2_000 },
				(_, i): Seed => ({
					kind: i % 2 ? "output" : "snapshot",
					bytes: 10,
				}),
			),
		);
		const collector = makeGc({}, { sliceBudgetMs: 0, intervalMs: 1_000 });
		collector.start();

		vi.advanceTimersByTime(1_000); // the interval starts a pass, which yields at once
		const running = collector.collect();
		vi.advanceTimersByTime(1_000); // two more ticks while it runs
		vi.advanceTimersByTime(1_000);
		expect(collector.collect()).toBe(running);

		expect((await running).completed).toBe(true);
		expect(metaDal.listStaleDeadChannelIds).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(1_000); // once it has ended, the next tick starts another
		await new Promise((resolve) => setImmediate(resolve));
		expect(metaDal.listStaleDeadChannelIds).toHaveBeenCalledTimes(2);
		await collector.collect();
	});

	it("stop() ends a running pass before its next step", async () => {
		seedOwnersProfile();
		const collector = makeGc({}, { sliceBudgetMs: 0 });

		const pass = collector.collect();
		collector.stop();
		dbs.close();

		await expect(pass).resolves.toMatchObject({ completed: false });
	});

	it("measures the dead-channel cutoff from the configured retention", async () => {
		const before = Date.now();
		await makeGc({ deadRetentionHours: 48 }).collect();
		const after = Date.now();

		const cutoff = new Date(
			vi.mocked(metaDal.listStaleDeadChannelIds).mock.calls[0]?.[0] as string,
		).getTime();
		expect(cutoff).toBeGreaterThanOrEqual(before - 48 * 3600 * 1000);
		expect(cutoff).toBeLessThanOrEqual(after - 48 * 3600 * 1000);
	});
});
