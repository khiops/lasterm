// AC-PLAYER-SEEK, AC-PLAYER-SEEK-IDLE, AC-PLAYER-CONTROLS (#80).
// New file: the playback engine is new; no existing spec drives a cast into xterm.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ParsedCast, parseCast } from "./cast-parse.js";
import { CastPlayback, type PlaybackTerminal, WRITE_PIECE } from "./cast-playback.js";

/** A terminal that keeps what was written to it, answers writes later, and logs calls. */
class FakeTerminal implements PlaybackTerminal {
	text = "";
	cols: number;
	rows: number;
	disposed = false;
	pending: Array<() => void> = [];
	calls: string[] = [];
	constructor(
		cols: number,
		rows: number,
		private readonly autoParse: boolean,
	) {
		this.cols = cols;
		this.rows = rows;
	}
	write(data: string, done: () => void): void {
		this.calls.push(`write:${data.length}:${this.pending.length}`);
		const parse = () => {
			if (!this.disposed) this.text += data;
			done();
		};
		if (this.autoParse) queueMicrotask(parse);
		else this.pending.push(parse);
	}
	resize(cols: number, rows: number): void {
		this.calls.push(`resize:${cols}x${rows}:${this.pending.length}`);
		this.cols = cols;
		this.rows = rows;
	}
	dispose(): void {
		this.disposed = true;
	}
	flush(): void {
		const all = this.pending;
		this.pending = [];
		for (const parse of all) parse();
	}
}

const LITERAL = [
	'{"version":3,"term":{"cols":80,"rows":24}}',
	'[0.000, "o", "hello"]',
	'[0.500, "r", "100x30"]',
	'[0.250, "m", "mark"]',
	'[1.000, "o", "\\r\\nbye"]',
].join("\n");

function cast(text: string): ParsedCast {
	const parsed = parseCast(text);
	if ("error" in parsed) throw new Error(parsed.error);
	return parsed;
}

function player(text: string, autoParse = true) {
	const terminals: FakeTerminal[] = [];
	const playback = new CastPlayback(cast(text), {
		createTerminal: (cols, rows) => {
			const t = new FakeTerminal(cols, rows, autoParse);
			terminals.push(t);
			return t;
		},
	});
	const last = () => terminals.at(-1) as FakeTerminal;
	return { playback, terminals, last };
}

describe("CastPlayback", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	// (a) Mutation caught: the seek ignoring sizes or writing the wrong events.
	it("seeks to the literal screen and size", async () => {
		const { playback, last } = player(LITERAL);
		await playback.seek(1.0);
		expect(last().text).toBe("hello");
		expect([last().cols, last().rows]).toEqual([100, 30]);
		const straight = player(LITERAL);
		straight.playback.play();
		await vi.advanceTimersByTimeAsync(1000);
		straight.playback.pause();
		expect(straight.last().text).toBe(last().text);
	});

	// (b) Mutation caught: reset() reuse without a generation (an old write lands, the later size stays).
	it("seeks backwards over pending writes to the header's size", async () => {
		const { playback, terminals, last } = player(LITERAL, false);
		const forward = playback.seek(5);
		terminals[1]?.flush(); // "hello" parsed
		await Promise.resolve();
		const back = playback.seek(0.1);
		terminals[1]?.flush(); // the old generation's pending write
		last().flush();
		await Promise.all([forward, back]);
		expect(last().text).toBe("hello");
		expect([last().cols, last().rows]).toEqual([80, 24]);
		expect(terminals[1]?.disposed).toBe(true);
	});

	// (c) Mutation caught: one write of everything, or writes not awaited.
	it("writes a large output in pieces, each after the previous one is parsed", async () => {
		const big = `${"x".repeat(3 * WRITE_PIECE - 3)}END`;
		const text = ['{"version":3,"term":{"cols":80,"rows":24}}', JSON.stringify([0, "o", big])].join(
			"\n",
		);
		const { playback, last } = player(text);
		await playback.seek(1);
		const writes = last().calls.filter((c) => c.startsWith("write"));
		expect(writes).toEqual([
			`write:${WRITE_PIECE}:0`,
			`write:${WRITE_PIECE}:0`,
			`write:${WRITE_PIECE}:0`,
		]);
		expect(last().text.endsWith("END")).toBe(true);
	});

	// (d) Mutation caught: a resize applied before the write before it is parsed.
	it("applies a size change only after the output before it is parsed", async () => {
		const text = [
			'{"version":3,"term":{"cols":80,"rows":24}}',
			'[0, "o", "a"]',
			'[0, "r", "90x20"]',
			'[0, "o", "b"]',
		].join("\n");
		const { playback, last } = player(text, false);
		const done = playback.seek(1);
		expect(last().calls).toEqual(["write:1:0"]);
		last().flush();
		await Promise.resolve();
		await Promise.resolve();
		expect(last().calls.slice(0, 2)).toEqual(["write:1:0", "resize:90x20:0"]);
		for (let i = 0; i < 10 && last().text !== "ab"; i++) {
			last().flush();
			await Promise.resolve();
		}
		await done;
		expect(last().text).toBe("ab");
	});

	// AC-PLAYER-SEEK-IDLE. Mutation caught: the seek target taken in raw time.
	it("uses played time for the total and the seek target with Skip idle on", async () => {
		const text = [
			'{"version":3,"term":{"cols":80,"rows":24}}',
			'[0, "o", "a"]',
			'[10, "o", "b"]',
		].join("\n");
		const { playback, last } = player(text);
		expect(playback.totalTime).toBe(2);
		await playback.seek(2);
		expect(last().text).toBe("ab");
	});

	describe("controls", () => {
		const TWO = [
			'{"version":3,"term":{"cols":80,"rows":24}}',
			'[0, "o", "a"]',
			'[1, "o", "b"]',
		].join("\n");

		it("plays twice as fast at speed 2", async () => {
			const { playback, last } = player(TWO);
			playback.setSpeed(2);
			playback.play();
			await vi.advanceTimersByTimeAsync(10);
			expect(last().text).toBe("a");
			await vi.advanceTimersByTimeAsync(495);
			expect(last().text).toBe("ab");
		});

		it("writes nothing while paused, and goes on at play", async () => {
			const { playback, last } = player(TWO);
			playback.play();
			await vi.advanceTimersByTimeAsync(10);
			playback.pause();
			await vi.advanceTimersByTimeAsync(5000);
			expect(last().text).toBe("a");
			playback.play();
			await vi.advanceTimersByTimeAsync(1000);
			expect(last().text).toBe("ab");
		});

		// Mutation caught: idle always compressed.
		it("caps a long pause at 2 s with Skip idle on, and plays it whole when off", async () => {
			const text = [
				'{"version":3,"term":{"cols":80,"rows":24}}',
				'[0, "o", "a"]',
				'[10, "o", "b"]',
			].join("\n");
			const on = player(text);
			on.playback.play();
			await vi.advanceTimersByTimeAsync(2010);
			expect(on.last().text).toBe("ab");

			const off = player(text);
			off.playback.setSkipIdle(false);
			expect(off.playback.totalTime).toBe(10);
			off.playback.play();
			await vi.advanceTimersByTimeAsync(2010);
			expect(off.last().text).toBe("a");
			await vi.advanceTimersByTimeAsync(8000);
			expect(off.last().text).toBe("ab");
		});
	});

	it("places markers in played time", () => {
		const { playback } = player(LITERAL);
		expect(playback.markers()).toEqual([{ time: 0.75, label: "mark" }]);
	});
});
