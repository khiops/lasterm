import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseManager } from "./db.js";
import { openTestDatabases } from "./db.js";
import { SpoolDAL } from "./spool.js";

// Helpers
function makeChunkInput(
	channelId: string,
	seq: number,
	kind: "output" | "snapshot" | "resize" = "output",
) {
	return {
		channelId,
		seq,
		kind,
		dataBlob: Buffer.from(`data-${seq}`),
		uncompressedLen: 10,
	};
}

describe("SpoolDAL", () => {
	let dbs: DatabaseManager;
	let dal: SpoolDAL;

	afterEach(() => {
		dbs?.close();
	});

	function setup() {
		dbs = openTestDatabases();
		dal = new SpoolDAL(dbs.spool);
	}

	// -------------------------------------------------------------------------
	// insertChunk
	// -------------------------------------------------------------------------

	it("insertChunk with kind=output returns a ULID string", () => {
		setup();
		const id = dal.insertChunk(makeChunkInput("ch-01", 1, "output"));
		expect(typeof id).toBe("string");
		expect(id.length).toBeGreaterThan(0);
	});

	it("insertChunk with kind=snapshot returns a ULID string", () => {
		setup();
		const id = dal.insertChunk(makeChunkInput("ch-01", 1, "snapshot"));
		expect(typeof id).toBe("string");
		expect(id.length).toBeGreaterThan(0);
	});

	it("insertChunk with kind=resize returns a ULID string", () => {
		setup();
		const id = dal.insertChunk(makeChunkInput("ch-01", 1, "resize"));
		expect(typeof id).toBe("string");
		expect(id.length).toBeGreaterThan(0);
	});

	// -------------------------------------------------------------------------
	// getChunk
	// -------------------------------------------------------------------------

	it("getChunk returns the chunk when found", () => {
		setup();
		const id = dal.insertChunk(makeChunkInput("ch-02", 1, "output"));
		const chunk = dal.getChunk(id);
		expect(chunk).toBeDefined();
		expect(chunk?.id).toBe(id);
		expect(chunk?.channelId).toBe("ch-02");
		expect(chunk?.seq).toBe(1);
		expect(chunk?.kind).toBe("output");
	});

	it("getChunk returns undefined when not found", () => {
		setup();
		const chunk = dal.getChunk("non-existent-id");
		expect(chunk).toBeUndefined();
	});

	// -------------------------------------------------------------------------
	// getChunksByChannel
	// -------------------------------------------------------------------------

	it("getChunksByChannel without filters returns all chunks for that channel", () => {
		setup();
		dal.insertChunk(makeChunkInput("ch-03", 1, "output"));
		dal.insertChunk(makeChunkInput("ch-03", 2, "output"));
		dal.insertChunk(makeChunkInput("ch-03", 3, "snapshot"));
		// Different channel — should not be returned
		dal.insertChunk(makeChunkInput("ch-other", 1, "output"));

		const chunks = dal.getChunksByChannel("ch-03");
		expect(chunks).toHaveLength(3);
		expect(chunks.map((c) => c.seq)).toEqual([1, 2, 3]);
	});

	it("getChunksByChannel with kind filter returns only matching kind", () => {
		setup();
		dal.insertChunk(makeChunkInput("ch-04", 1, "output"));
		dal.insertChunk(makeChunkInput("ch-04", 2, "snapshot"));
		dal.insertChunk(makeChunkInput("ch-04", 3, "output"));

		const chunks = dal.getChunksByChannel("ch-04", { kind: "output" });
		expect(chunks).toHaveLength(2);
		expect(chunks.every((c) => c.kind === "output")).toBe(true);
	});

	it("getChunksByChannel with afterSeq filter returns only chunks after that seq", () => {
		setup();
		dal.insertChunk(makeChunkInput("ch-05", 1, "output"));
		dal.insertChunk(makeChunkInput("ch-05", 2, "output"));
		dal.insertChunk(makeChunkInput("ch-05", 3, "output"));

		const chunks = dal.getChunksByChannel("ch-05", { afterSeq: 1 });
		expect(chunks).toHaveLength(2);
		expect(chunks.map((c) => c.seq)).toEqual([2, 3]);
	});

	it("getChunksByChannel with limit returns at most N chunks", () => {
		setup();
		dal.insertChunk(makeChunkInput("ch-06", 1, "output"));
		dal.insertChunk(makeChunkInput("ch-06", 2, "output"));
		dal.insertChunk(makeChunkInput("ch-06", 3, "output"));

		const chunks = dal.getChunksByChannel("ch-06", { limit: 2 });
		expect(chunks).toHaveLength(2);
		expect(chunks.map((c) => c.seq)).toEqual([1, 2]);
	});

	// -------------------------------------------------------------------------
	// getLatestSnapshot
	// -------------------------------------------------------------------------

	it("getLatestSnapshot returns the most recent snapshot chunk", () => {
		setup();
		dal.insertChunk(makeChunkInput("ch-07", 1, "output"));
		dal.insertChunk(makeChunkInput("ch-07", 2, "snapshot"));
		dal.insertChunk(makeChunkInput("ch-07", 3, "output"));
		dal.insertChunk(makeChunkInput("ch-07", 4, "snapshot"));

		const snap = dal.getLatestSnapshot("ch-07");
		expect(snap).toBeDefined();
		expect(snap?.seq).toBe(4);
		expect(snap?.kind).toBe("snapshot");
	});

	it("getLatestSnapshot returns undefined when no snapshots exist", () => {
		setup();
		dal.insertChunk(makeChunkInput("ch-08", 1, "output"));
		dal.insertChunk(makeChunkInput("ch-08", 2, "output"));

		const snap = dal.getLatestSnapshot("ch-08");
		expect(snap).toBeUndefined();
	});

	// -------------------------------------------------------------------------
	// insertSnapshot / getLatestSnapshotSize (#726)
	// -------------------------------------------------------------------------

	it("insertSnapshot replaces the channel's previous snapshot and keeps its output", () => {
		setup();
		dal.insertChunk(makeChunkInput("ch-snap", 1, "output"));
		dal.insertSnapshot({
			channelId: "ch-snap",
			seq: 2,
			dataBlob: Buffer.from("a"),
			uncompressedLen: 1,
		});
		dal.insertChunk(makeChunkInput("ch-snap", 3, "output"));
		const id = dal.insertSnapshot({
			channelId: "ch-snap",
			seq: 4,
			dataBlob: Buffer.from("b"),
			uncompressedLen: 1,
		});
		dal.insertSnapshot({
			channelId: "ch-other",
			seq: 1,
			dataBlob: Buffer.from("c"),
			uncompressedLen: 1,
		});

		expect(dal.getChunksByChannel("ch-snap").map((c) => [c.seq, c.kind])).toEqual([
			[1, "output"],
			[3, "output"],
			[4, "snapshot"],
		]);
		expect(dal.getLatestSnapshot("ch-snap")?.id).toBe(id);
		expect(dal.getLatestSnapshotSize("ch-snap")).toEqual({ seq: 4, bytes: 1 });
		expect(dal.getLatestSnapshotSize("ch-other")).toEqual({ seq: 1, bytes: 1 });
		expect(dal.getLatestSnapshotSize("ch-none")).toBeUndefined();
	});

	it("insertSnapshot deletes only the previous snapshot, leaving an older backlog to the GC", () => {
		setup();
		for (let seq = 1; seq <= 5; seq++)
			dal.insertChunk(makeChunkInput("ch-backlog", seq, "snapshot"));

		dal.insertSnapshot({
			channelId: "ch-backlog",
			seq: 6,
			dataBlob: Buffer.from("x"),
			uncompressedLen: 1,
		});

		expect(dal.getChunksByChannel("ch-backlog").map((c) => c.seq)).toEqual([1, 2, 3, 4, 6]);
	});

	// -------------------------------------------------------------------------
	// getChannelChunkCount
	// -------------------------------------------------------------------------

	it("getChannelChunkCount returns correct count", () => {
		setup();
		dal.insertChunk(makeChunkInput("ch-11", 1, "output"));
		dal.insertChunk(makeChunkInput("ch-11", 2, "snapshot"));
		dal.insertChunk(makeChunkInput("ch-11", 3, "resize"));

		expect(dal.getChannelChunkCount("ch-11")).toBe(3);
	});

	it("getChannelChunkCount returns 0 for unknown channel", () => {
		setup();
		expect(dal.getChannelChunkCount("ch-unknown")).toBe(0);
	});

	// -------------------------------------------------------------------------
	// UNIQUE(channel_id, seq) constraint
	// -------------------------------------------------------------------------

	it("UNIQUE(channel_id, seq) constraint violation throws", () => {
		setup();
		dal.insertChunk(makeChunkInput("ch-12", 1, "output"));
		// Inserting same channel + seq again must throw
		expect(() => dal.insertChunk(makeChunkInput("ch-12", 1, "output"))).toThrow();
	});

	// -------------------------------------------------------------------------
	// Cross-DB: channel_id has no FK to meta.db (spool is standalone)
	// -------------------------------------------------------------------------

	it("can insert chunks with arbitrary channel_id (no cross-DB FK)", () => {
		setup();
		// This channel_id does not exist in meta.db — no error expected
		const id = dal.insertChunk(makeChunkInput("arbitrary-channel-id-xyz", 1, "output"));
		expect(typeof id).toBe("string");
		const chunk = dal.getChunk(id);
		expect(chunk?.channelId).toBe("arbitrary-channel-id-xyz");
	});

	// -------------------------------------------------------------------------
	// getChannelSize
	// -------------------------------------------------------------------------

	it("getChannelSize returns total data_blob size for a channel", () => {
		setup();
		dal.insertChunk(makeChunkInput("ch-sz", 1, "output")); // "data-1" → 6 bytes
		dal.insertChunk(makeChunkInput("ch-sz", 2, "output")); // "data-2" → 6 bytes
		dal.insertChunk(makeChunkInput("ch-sz", 3, "snapshot")); // "data-3" → 6 bytes

		expect(dal.getChannelSize("ch-sz")).toBe(18);
	});

	it("getChannelSize returns 0 for unknown channel", () => {
		setup();
		expect(dal.getChannelSize("ch-nope")).toBe(0);
	});

	// -------------------------------------------------------------------------
	// nextChannelId
	// -------------------------------------------------------------------------

	it("nextChannelId walks the channels with chunks in id order", () => {
		setup();
		dal.insertChunk(makeChunkInput("ch-b", 1, "output"));
		dal.insertChunk(makeChunkInput("ch-a", 1, "output"));
		dal.insertChunk(makeChunkInput("ch-a", 2, "output"));

		expect(dal.nextChannelId("")).toBe("ch-a");
		expect(dal.nextChannelId("ch-a")).toBe("ch-b");
		expect(dal.nextChannelId("ch-b")).toBeUndefined();
	});

	// -------------------------------------------------------------------------
	// listChunkSizesBefore
	// -------------------------------------------------------------------------

	it("listChunkSizesBefore lists chunks below a seq, newest first, with their size", () => {
		setup();
		dal.insertChunk(makeChunkInput("ch-w", 1, "output")); // "data-1": 6 bytes
		dal.insertChunk(makeChunkInput("ch-w", 2, "snapshot"));
		dal.insertChunk({ ...makeChunkInput("ch-w", 3, "output"), dataBlob: Buffer.alloc(100) });
		dal.insertChunk(makeChunkInput("ch-x", 1, "output"));

		const rows = dal.listChunkSizesBefore("ch-w", Number.MAX_SAFE_INTEGER, 2);
		expect(rows.map((r) => [r.seq, r.kind, r.bytes])).toEqual([
			[3, "output", 100],
			[2, "snapshot", 6],
		]);
		expect(typeof rows[0]?.ts).toBe("string");
		expect(dal.listChunkSizesBefore("ch-w", 2, 10).map((r) => r.seq)).toEqual([1]);
	});

	// -------------------------------------------------------------------------
	// deleteChunkBatch
	// -------------------------------------------------------------------------

	function seqs(channelId: string): number[] {
		return dal.getChunksByChannel(channelId).map((c) => c.seq);
	}

	it("deleteChunkBatch deletes oldest first within its range, up to maxRows", () => {
		setup();
		for (let seq = 1; seq <= 6; seq++) dal.insertChunk(makeChunkInput("ch-d", seq, "output"));
		dal.insertChunk(makeChunkInput("ch-other", 1, "output"));
		const range = { afterSeq: Number.MIN_SAFE_INTEGER, throughSeq: 5, kinds: "all" } as const;

		const first = dal.deleteChunkBatch("ch-d", range, { maxRows: 2, maxBytes: 1 << 20 });
		expect(first).toEqual({ deleted: 2, bytes: 12, lastSeq: 2 });
		expect(seqs("ch-d")).toEqual([3, 4, 5, 6]);

		const second = dal.deleteChunkBatch(
			"ch-d",
			{ ...range, afterSeq: 2 },
			{ maxRows: 10, maxBytes: 1 << 20 },
		);
		expect(second).toEqual({ deleted: 3, bytes: 18, lastSeq: 5 });
		expect(seqs("ch-d")).toEqual([6]);

		expect(
			dal.deleteChunkBatch("ch-d", { ...range, afterSeq: 5 }, { maxRows: 10, maxBytes: 1 << 20 }),
		).toEqual({ deleted: 0, bytes: 0, lastSeq: undefined });
		expect(seqs("ch-other")).toEqual([1]);
	});

	it("deleteChunkBatch stops at the row that reaches maxBytes", () => {
		setup();
		for (let seq = 1; seq <= 4; seq++) dal.insertChunk(makeChunkInput("ch-d", seq, "output"));

		const batch = dal.deleteChunkBatch(
			"ch-d",
			{ afterSeq: Number.MIN_SAFE_INTEGER, throughSeq: Number.MAX_SAFE_INTEGER, kinds: "all" },
			{ maxRows: 10, maxBytes: 7 },
		);

		expect(batch).toEqual({ deleted: 2, bytes: 12, lastSeq: 2 });
		expect(seqs("ch-d")).toEqual([3, 4]);
	});

	it("deleteChunkBatch deletes only snapshots, or only the rest, when asked", () => {
		setup();
		dal.insertChunk(makeChunkInput("ch-k", 1, "output"));
		dal.insertChunk(makeChunkInput("ch-k", 2, "snapshot"));
		dal.insertChunk(makeChunkInput("ch-k", 3, "resize"));
		dal.insertChunk(makeChunkInput("ch-k", 4, "snapshot"));
		const all = { afterSeq: Number.MIN_SAFE_INTEGER, throughSeq: Number.MAX_SAFE_INTEGER };
		const limits = { maxRows: 10, maxBytes: 1 << 20 };

		expect(
			dal.deleteChunkBatch("ch-k", { ...all, throughSeq: 3, kinds: "snapshots" }, limits),
		).toEqual({
			deleted: 1,
			bytes: 6,
			lastSeq: 2,
		});
		expect(seqs("ch-k")).toEqual([1, 3, 4]);

		expect(dal.deleteChunkBatch("ch-k", { ...all, kinds: "others" }, limits).deleted).toBe(2);
		expect(seqs("ch-k")).toEqual([4]);
	});

	// -------------------------------------------------------------------------
	// incrementalVacuum
	// -------------------------------------------------------------------------

	it("incrementalVacuum frees a bounded number of pages and says how many are left", () => {
		setup();
		const blob = Buffer.alloc(64 * 1024);
		for (let seq = 1; seq <= 16; seq++) {
			dal.insertChunk({ ...makeChunkInput("ch-v", seq, "output"), dataBlob: blob });
		}
		dbs.spool.prepare("DELETE FROM chunks WHERE channel_id = ?").run("ch-v");
		const free = dbs.spool.pragma("freelist_count", { simple: true }) as number;
		expect(free).toBeGreaterThan(20);

		expect(dal.incrementalVacuum(10)).toBe(free - 10);
		let left = free - 10;
		while (left > 0) left = dal.incrementalVacuum(10);
		expect(dbs.spool.pragma("freelist_count", { simple: true })).toBe(0);
	});
});
