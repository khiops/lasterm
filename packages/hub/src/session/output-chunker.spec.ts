import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpoolDAL } from "../storage/spool.js";
import { OutputChunker } from "./output-chunker.js";

function makeSpoolDal(): SpoolDAL {
	return {
		insertChunk: vi.fn().mockReturnValue("chunk-id-1"),
		getMaxSeq: vi.fn().mockReturnValue(0),
	} as unknown as SpoolDAL;
}

/** Helper: assert that the mock was called at least N times and return call args at index. */
function getMockCall(
	mock: ReturnType<typeof vi.fn>,
	index: number,
): Parameters<SpoolDAL["insertChunk"]>[0] {
	const call = mock.mock.calls[index] as Parameters<SpoolDAL["insertChunk"]> | undefined;
	if (!call) throw new Error(`Expected mock call at index ${index}, but found none`);
	const result = call[0];
	if (!result) throw new Error(`Expected arguments at call index ${index}`);
	return result;
}

describe("OutputChunker", () => {
	let dal: SpoolDAL;
	let chunker: OutputChunker;

	beforeEach(() => {
		vi.useFakeTimers();
		dal = makeSpoolDal();
		chunker = new OutputChunker(dal);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("trackChannel initialises buffer", () => {
		chunker.trackChannel("ch1");
		expect(chunker.getNextSeq("ch1")).toBe(1);
	});

	it("trackChannel is idempotent — second call is a no-op", () => {
		chunker.trackChannel("ch1");
		chunker.onOutput("ch1", new Uint8Array([1, 2, 3]));
		chunker.trackChannel("ch1"); // should not reset state
		expect(chunker.getNextSeq("ch1")).toBe(1); // still seq 1 (no flush yet)
	});

	it("onOutput accumulates data without flushing immediately", () => {
		chunker.trackChannel("ch1");
		chunker.onOutput("ch1", new Uint8Array([1, 2, 3]));
		expect(dal.insertChunk).not.toHaveBeenCalled();
	});

	it("timer-triggered flush after 1 second", () => {
		chunker.trackChannel("ch1");
		chunker.onOutput("ch1", new Uint8Array([10, 20, 30]));
		expect(dal.insertChunk).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1_000);

		expect(dal.insertChunk).toHaveBeenCalledTimes(1);
		const call = getMockCall(vi.mocked(dal.insertChunk), 0);
		expect(call.channelId).toBe("ch1");
		expect(call.seq).toBe(1);
		expect(call.kind).toBe("output");
		expect(Buffer.from([10, 20, 30]).equals(call.dataBlob)).toBe(true);
	});

	it("size-triggered flush at 256 KB", () => {
		chunker.trackChannel("ch1");
		const bigChunk = new Uint8Array(256 * 1024); // exactly 256 KB
		chunker.onOutput("ch1", bigChunk);

		expect(dal.insertChunk).toHaveBeenCalledTimes(1);
		const call = getMockCall(vi.mocked(dal.insertChunk), 0);
		expect(call.kind).toBe("output");
		expect(call.dataBlob.byteLength).toBe(256 * 1024);
	});

	it("flush writes to spool.db with correct kind=output", () => {
		chunker.trackChannel("ch1");
		chunker.onOutput("ch1", new Uint8Array([1]));
		chunker.flush("ch1");

		expect(dal.insertChunk).toHaveBeenCalledTimes(1);
		expect(getMockCall(vi.mocked(dal.insertChunk), 0).kind).toBe("output");
	});

	it("flush is no-op when buffer is empty", () => {
		chunker.trackChannel("ch1");
		chunker.flush("ch1");
		expect(dal.insertChunk).not.toHaveBeenCalled();
	});

	it("flush is no-op for untracked channel", () => {
		chunker.flush("unknown");
		expect(dal.insertChunk).not.toHaveBeenCalled();
	});

	it("untrackChannel flushes remaining data and removes the channel", () => {
		chunker.trackChannel("ch1");
		chunker.onOutput("ch1", new Uint8Array([5, 6, 7]));
		chunker.untrackChannel("ch1");

		expect(dal.insertChunk).toHaveBeenCalledTimes(1);
		// After untrack, getNextSeq returns default 1 (channel gone)
		expect(chunker.getNextSeq("ch1")).toBe(1);
	});

	it("untrackChannel clears pending timer", () => {
		chunker.trackChannel("ch1");
		chunker.onOutput("ch1", new Uint8Array([1]));
		chunker.untrackChannel("ch1");

		// Advance time — no additional flush should happen
		vi.advanceTimersByTime(2_000);
		expect(dal.insertChunk).toHaveBeenCalledTimes(1); // only the untrack flush
	});

	it("shutdown flushes all channels", () => {
		chunker.trackChannel("ch1");
		chunker.trackChannel("ch2");
		chunker.onOutput("ch1", new Uint8Array([1]));
		chunker.onOutput("ch2", new Uint8Array([2]));
		chunker.shutdown();

		expect(dal.insertChunk).toHaveBeenCalledTimes(2);
	});

	it("getNextSeq returns correct sequence for tracked channel", () => {
		chunker.trackChannel("ch1");
		expect(chunker.getNextSeq("ch1")).toBe(1);
	});

	it("getNextSeq returns 1 for untracked channel", () => {
		expect(chunker.getNextSeq("unknown")).toBe(1);
	});

	it("multiple flushes increment seq monotonically", () => {
		chunker.trackChannel("ch1");

		chunker.onOutput("ch1", new Uint8Array([1]));
		chunker.flush("ch1");
		expect(chunker.getNextSeq("ch1")).toBe(2);

		chunker.onOutput("ch1", new Uint8Array([2]));
		chunker.flush("ch1");
		expect(chunker.getNextSeq("ch1")).toBe(3);

		expect(dal.insertChunk).toHaveBeenCalledTimes(2);
		expect(getMockCall(vi.mocked(dal.insertChunk), 0).seq).toBe(1);
		expect(getMockCall(vi.mocked(dal.insertChunk), 1).seq).toBe(2);
	});

	it("startSeq parameter sets the initial sequence", () => {
		chunker.trackChannel("ch1", 5);
		expect(chunker.getNextSeq("ch1")).toBe(5);

		chunker.onOutput("ch1", new Uint8Array([1]));
		chunker.flush("ch1");

		expect(getMockCall(vi.mocked(dal.insertChunk), 0).seq).toBe(5);
		expect(chunker.getNextSeq("ch1")).toBe(6);
	});

	it("seq values written to spool.db are strictly monotonically increasing starting at 1", () => {
		chunker.trackChannel("ch1");

		// Feed 5 separate chunks, flushing each time
		for (let i = 0; i < 5; i++) {
			chunker.onOutput("ch1", new Uint8Array([i]));
			chunker.flush("ch1");
		}

		expect(dal.insertChunk).toHaveBeenCalledTimes(5);

		const seqs: number[] = [];
		for (let i = 0; i < 5; i++) {
			seqs.push(getMockCall(vi.mocked(dal.insertChunk), i).seq);
		}

		// Starts at 1
		expect(seqs[0]).toBe(1);

		// Strictly monotonically increasing
		for (let i = 1; i < seqs.length; i++) {
			expect(seqs[i]).toBeGreaterThan(seqs[i - 1] as number);
		}

		// Consecutive (no gaps)
		expect(seqs).toEqual([1, 2, 3, 4, 5]);
	});

	it("seq monotonicity holds across timer-triggered and manual flushes", () => {
		chunker.trackChannel("ch1");

		// Timer-triggered flush
		chunker.onOutput("ch1", new Uint8Array([1]));
		vi.advanceTimersByTime(1_000);

		// Manual flush
		chunker.onOutput("ch1", new Uint8Array([2]));
		chunker.flush("ch1");

		// Size-triggered flush (256 KB)
		chunker.onOutput("ch1", new Uint8Array(256 * 1024));

		expect(dal.insertChunk).toHaveBeenCalledTimes(3);
		const seqs = [
			getMockCall(vi.mocked(dal.insertChunk), 0).seq,
			getMockCall(vi.mocked(dal.insertChunk), 1).seq,
			getMockCall(vi.mocked(dal.insertChunk), 2).seq,
		];

		for (let i = 1; i < seqs.length; i++) {
			expect(seqs[i]).toBeGreaterThan(seqs[i - 1] as number);
		}
	});

	it("bumpSeq preserves monotonicity after external snapshot insertion", () => {
		chunker.trackChannel("ch1");

		// Normal output: seq 1
		chunker.onOutput("ch1", new Uint8Array([1]));
		chunker.flush("ch1");

		// Simulate external snapshot insertion at seq 10
		chunker.bumpSeq("ch1", 11);

		// Next output must be at seq >= 11
		chunker.onOutput("ch1", new Uint8Array([2]));
		chunker.flush("ch1");

		expect(dal.insertChunk).toHaveBeenCalledTimes(2);
		const seq1 = getMockCall(vi.mocked(dal.insertChunk), 0).seq;
		const seq2 = getMockCall(vi.mocked(dal.insertChunk), 1).seq;
		expect(seq1).toBe(1);
		expect(seq2).toBe(11);
		expect(seq2).toBeGreaterThan(seq1);
	});

	it("concatenates multiple output chunks into a single blob on flush", () => {
		chunker.trackChannel("ch1");
		chunker.onOutput("ch1", new Uint8Array([1, 2]));
		chunker.onOutput("ch1", new Uint8Array([3, 4]));
		chunker.flush("ch1");

		const blob = getMockCall(vi.mocked(dal.insertChunk), 0).dataBlob;
		expect(Array.from(blob)).toEqual([1, 2, 3, 4]);
	});
	it("drops the bytes a failed write could not store, and writes only newer output afterwards (#1098)", () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			(dal.insertChunk as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
				throw Object.assign(new Error("disk full"), { code: "SQLITE_FULL" });
			});
			chunker.trackChannel("ch1");
			chunker.onOutput("ch1", new Uint8Array([1, 2, 3]));
			expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();

			chunker.onOutput("ch1", new Uint8Array([4, 5]));
			vi.advanceTimersByTime(1_000);

			expect(dal.insertChunk).toHaveBeenCalledTimes(2);
			const retry = getMockCall(dal.insertChunk as ReturnType<typeof vi.fn>, 1);
			expect([...(retry.dataBlob as Uint8Array)]).toEqual([4, 5]);
			// The dropped batch keeps its seq unused: a reader sees the gap.
			expect(retry.seq).toBe(2);
		} finally {
			error.mockRestore();
		}
	});
	it("drops the bytes of a failed size-triggered flush, and clears its timer (#1098)", () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			(dal.insertChunk as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
				throw Object.assign(new Error("disk full"), { code: "SQLITE_FULL" });
			});
			chunker.trackChannel("ch1");
			expect(() => chunker.onOutput("ch1", new Uint8Array(256 * 1024))).not.toThrow();
			chunker.onOutput("ch1", new Uint8Array([4, 5]));
			vi.advanceTimersByTime(1_000);

			expect(dal.insertChunk).toHaveBeenCalledTimes(2);
			const second = getMockCall(dal.insertChunk as ReturnType<typeof vi.fn>, 1);
			expect([...(second.dataBlob as Uint8Array)]).toEqual([4, 5]);
			expect(second.seq).toBe(2);
			// Told by its code, with the channel and what was dropped.
			const logged = error.mock.calls.flat().join(" ");
			expect(logged).toContain("SQLITE_FULL");
			expect(logged).toContain("ch1");
			expect(logged).toContain(String(256 * 1024));
		} finally {
			error.mockRestore();
		}
	});

	it("tells an error without a code as such (#1098)", () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			(dal.insertChunk as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
				throw new Error("boom");
			});
			chunker.trackChannel("ch1");
			chunker.onOutput("ch1", new Uint8Array([1]));
			chunker.untrackChannel("ch1");
			expect(error.mock.calls.flat().join(" ")).toContain("no code");
		} finally {
			error.mockRestore();
		}
	});

	it("shutdown goes on to the other channels when one write fails (#1098)", () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			(dal.insertChunk as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
				throw new Error("boom");
			});
			chunker.trackChannel("ch1");
			chunker.trackChannel("ch2");
			chunker.onOutput("ch1", new Uint8Array([1]));
			chunker.onOutput("ch2", new Uint8Array([2]));
			expect(() => chunker.shutdown()).not.toThrow();
			expect(dal.insertChunk).toHaveBeenCalledTimes(2);
			expect(getMockCall(dal.insertChunk as ReturnType<typeof vi.fn>, 1).channelId).toBe("ch2");
		} finally {
			error.mockRestore();
		}
	});

	it("flush itself still throws and keeps the bytes, for the callers that log it (#1098)", () => {
		(dal.insertChunk as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
			throw new Error("boom");
		});
		chunker.trackChannel("ch1");
		chunker.onOutput("ch1", new Uint8Array([1, 2]));
		expect(() => chunker.flush("ch1")).toThrow("boom");

		chunker.flush("ch1");
		const retry = getMockCall(dal.insertChunk as ReturnType<typeof vi.fn>, 1);
		expect([...(retry.dataBlob as Uint8Array)]).toEqual([1, 2]);
	});
});
