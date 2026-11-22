// AC-PLAYER-SEEK, AC-PLAYER-SEEK-IDLE, AC-PLAYER-CONTROLS (#80).
// New file: the playback engine is new; no existing spec drives a cast into xterm.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ParsedCast, parseCast } from "./cast-parse.js";
import { CastPlayback, type PlaybackTerminal } from "./cast-playback.js";

/** 1 MiB of UTF-8 at most: 349,525 UTF-16 units of at most 3 bytes each. */
const PIECE = 349_525;

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
		now: () => Date.now(),
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
		const big = `${"x".repeat(3 * PIECE - 3)}END`;
		const text = ['{"version":3,"term":{"cols":80,"rows":24}}', JSON.stringify([0, "o", big])].join(
			"\n",
		);
		const { playback, last } = player(text, false);
		const done = playback.seek(1);
		for (let piece = 0; piece < 3; piece++) {
			for (let i = 0; i < 5; i++) await Promise.resolve();
			// One piece at a time: the next is written only once this one is parsed.
			expect(last().pending).toHaveLength(1);
			last().flush();
		}
		await done;
		expect(last().calls.filter((c) => c.startsWith("write"))).toEqual([
			`write:${PIECE}:0`,
			`write:${PIECE}:0`,
			`write:${PIECE}:0`,
		]);
		expect(last().text.endsWith("END")).toBe(true);
	});

	it("never cuts a surrogate pair between two pieces", async () => {
		const big = `${"x".repeat(PIECE - 1)}😀tail`;
		const text = ['{"version":3,"term":{"cols":80,"rows":24}}', JSON.stringify([0, "o", big])].join(
			"\n",
		);
		const { playback, last } = player(text);
		await playback.seek(1);
		const writes = last().calls.filter((c) => c.startsWith("write"));
		expect(writes[0]).toBe(`write:${PIECE - 1}:0`);
		expect(last().text).toBe(big);
	});

	// COR1: time is continuous. Mutation caught: the whole delay waited again after a seek or a pause.
	it("goes on from a seek between two events with only what remains", async () => {
		const text = [
			'{"version":3,"term":{"cols":80,"rows":24}}',
			'[0, "o", "A"]',
			'[10, "o", "B"]',
		].join("\n");
		const { playback, last } = player(text);
		playback.setSkipIdle(false);
		await playback.seek(5);
		expect(playback.currentTime).toBe(5);
		playback.play();
		await vi.advanceTimersByTimeAsync(4990);
		expect(last().text).toBe("A");
		await vi.advanceTimersByTimeAsync(20);
		expect(last().text).toBe("AB");
	});

	it("keeps what was waited across a pause and a speed change", async () => {
		const text = [
			'{"version":3,"term":{"cols":80,"rows":24}}',
			'[0, "o", "A"]',
			'[10, "o", "B"]',
		].join("\n");
		const { playback, last } = player(text);
		playback.setSkipIdle(false);
		playback.play();
		await vi.advanceTimersByTimeAsync(4000);
		playback.pause();
		expect(playback.currentTime).toBeCloseTo(4, 1);
		playback.play();
		await vi.advanceTimersByTimeAsync(2000); // 6 s waited
		playback.setSpeed(2); // 4 s left: 2 s at speed 2
		await vi.advanceTimersByTimeAsync(1990);
		expect(last().text).toBe("A");
		await vi.advanceTimersByTimeAsync(20);
		expect(last().text).toBe("AB");
	});

	// C2/CONC1: one consumer. Mutation caught: play during a seek starting a second loop.
	it("plays each event once when Play is pressed during a seek", async () => {
		const text = [
			'{"version":3,"term":{"cols":80,"rows":24}}',
			'[0, "o", "A"]',
			'[0.5, "o", "B"]',
			'[0.5, "o", "C"]',
		].join("\n");
		const { playback, last } = player(text, false);
		const seeking = playback.seek(0.6);
		playback.play();
		for (let i = 0; i < 20; i++) {
			last().flush();
			await vi.advanceTimersByTimeAsync(100);
		}
		await seeking;
		expect(last().text).toBe("ABC");
	});

	// Mutation caught: the next delay counted from the end of xterm's parse, so the
	// parse time adds up event after event.
	it("counts the time an event took to parse in the wait for the next", async () => {
		const text = [
			'{"version":3,"term":{"cols":80,"rows":24}}',
			'[0, "o", "A"]',
			'[1, "o", "B"]',
		].join("\n");
		const { playback, last } = player(text, false);
		playback.play();
		await vi.advanceTimersByTimeAsync(100);
		last().flush(); // A took 100 ms to parse
		await vi.advanceTimersByTimeAsync(910);
		last().flush();
		// 1.01 s from the start: B, due at 1 s, is out.
		expect(last().text).toBe("AB");
	});

	// A wait asked while the seek runs would be left behind and play a later event early.
	it("leaves no wait behind when Play is pressed during a seek", async () => {
		const text = [
			'{"version":3,"term":{"cols":80,"rows":24}}',
			'[1.5, "o", "A"]',
			'[0.1, "o", "B"]',
			'[1.9, "o", "C"]',
		].join("\n");
		const { playback, last } = player(text, false);
		const seeking = playback.seek(1.55);
		playback.play();
		for (let i = 0; i < 17; i++) {
			last().flush();
			await vi.advanceTimersByTimeAsync(100);
		}
		await seeking;
		// 1.7 s after the seek: B (due at 50 ms) is out, C (due at 1.95 s) is not.
		expect(last().text).toBe("AB");
		for (let i = 0; i < 5; i++) {
			last().flush();
			await vi.advanceTimersByTimeAsync(100);
		}
		expect(last().text).toBe("ABC");
	});

	it("stops between the pieces of a large event at a pause, and goes on from there", async () => {
		const big = `${"x".repeat(2 * PIECE)}`;
		const text = ['{"version":3,"term":{"cols":80,"rows":24}}', JSON.stringify([0, "o", big])].join(
			"\n",
		);
		const { playback, last } = player(text, false);
		playback.play();
		await vi.advanceTimersByTimeAsync(0);
		expect(last().pending).toHaveLength(1);
		playback.pause();
		last().flush();
		for (let i = 0; i < 5; i++) await Promise.resolve();
		expect(last().pending).toHaveLength(0);
		expect(last().text.length).toBe(PIECE);
		playback.play();
		for (let i = 0; i < 5; i++) await Promise.resolve();
		last().flush();
		for (let i = 0; i < 5; i++) await Promise.resolve();
		expect(last().text.length).toBe(2 * PIECE);
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
		for (let i = 0; i < 5; i++) await Promise.resolve();
		// Nothing parsed yet: the size change waits.
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
