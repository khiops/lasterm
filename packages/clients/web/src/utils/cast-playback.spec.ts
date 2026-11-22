// AC-PLAYER-SEEK, AC-PLAYER-SEEK-IDLE, AC-PLAYER-CONTROLS (#80).
// New file: the playback engine is new; no existing spec drives a cast into xterm.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ParsedCast, parseCast } from "./cast-parse.js";
import { CastPlayback, type PlaybackOptions, type PlaybackTerminal } from "./cast-playback.js";

/** 1 MiB of UTF-8 at most: 349,525 UTF-16 units of at most 3 bytes each. */
const PIECE = 349_525;

/**
 * When a write's callback runs: `true` at once (a microtask), `false` at
 * `flush()`, a function after that many milliseconds of (fake) timers.
 */
type Parse = boolean | ((data: string) => number);

/** A terminal that keeps what was written to it, answers writes later, and logs calls. */
class FakeTerminal implements PlaybackTerminal {
	text = "";
	cols: number;
	rows: number;
	disposed = false;
	pending: Array<() => void> = [];
	calls: string[] = [];
	/** Each write: when it was made (`Date.now()`) and what it wrote. */
	writes: Array<[number, string]> = [];
	constructor(
		cols: number,
		rows: number,
		private readonly autoParse: Parse,
	) {
		this.cols = cols;
		this.rows = rows;
	}
	write(data: string, done: () => void): void {
		this.calls.push(`write:${data.length}:${this.pending.length}`);
		this.writes.push([Date.now(), data]);
		const parse = () => {
			if (!this.disposed) this.text += data;
			done();
		};
		if (typeof this.autoParse === "function") setTimeout(parse, this.autoParse(data));
		else if (this.autoParse) queueMicrotask(parse);
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

function player(text: string, autoParse: Parse = true, extra: Partial<PlaybackOptions> = {}) {
	const terminals: FakeTerminal[] = [];
	const playback = new CastPlayback(cast(text), {
		now: () => Date.now(),
		...extra,
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

	const TWO = ['{"version":3,"term":{"cols":80,"rows":24}}', '[0, "o", "A"]', '[2, "o", "B"]'].join(
		"\n",
	);

	// Mutation caught: the parse time counted from the clock, a pause during it included.
	it("counts no paused time in the wait after a write", async () => {
		const { playback, last } = player(TWO, false);
		playback.play();
		await vi.advanceTimersByTimeAsync(500);
		playback.pause();
		await vi.advanceTimersByTimeAsync(500);
		last().flush(); // A parsed while paused: 0.5 s of it played
		playback.play();
		await vi.advanceTimersByTimeAsync(1400);
		last().flush();
		expect(last().text).toBe("A"); // B is due 1.5 s after the play
		await vi.advanceTimersByTimeAsync(110);
		last().flush();
		expect(last().text).toBe("AB");
	});

	// Mutation caught: the whole parse time counted at the speed set during it.
	it("counts a speed change during a write at each speed", async () => {
		const { playback, last } = player(TWO, false);
		playback.play();
		await vi.advanceTimersByTimeAsync(500);
		playback.setSpeed(2);
		await vi.advanceTimersByTimeAsync(500);
		last().flush(); // 0.5 s at 1x and 1 s at 2x: 1.5 s played
		await vi.advanceTimersByTimeAsync(200);
		last().flush();
		expect(last().text).toBe("A"); // the last 0.5 s takes 250 ms at 2x
		await vi.advanceTimersByTimeAsync(60);
		last().flush();
		expect(last().text).toBe("AB");
	});

	// Mutation caught: a wait past a timer's 32 bits asked at once (it fires at once).
	it("takes a wait of 30 days in steps a timer can hold", async () => {
		const asked: number[] = [];
		let term: FakeTerminal | null = null;
		const playback = new CastPlayback(
			cast(
				['{"version":3,"term":{"cols":80,"rows":24}}', '[0, "o", "A"]', '[2592000, "o", "B"]'].join(
					"\n",
				),
			),
			{
				now: () => Date.now(),
				createTerminal: (cols, rows) => {
					term = new FakeTerminal(cols, rows, true);
					return term;
				},
				setTimer: (fn, ms) => {
					asked.push(ms);
					return setTimeout(fn, ms);
				},
			},
		);
		playback.setSkipIdle(false);
		playback.play();
		await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
		expect((term as FakeTerminal | null)?.text).toBe("A");
		expect(Math.max(...asked)).toBeLessThanOrEqual(2 ** 31 - 1);
		await vi.advanceTimersByTimeAsync(30 * 24 * 60 * 60 * 1000);
		expect((term as FakeTerminal | null)?.text).toBe("AB");
	});

	// Mutation caught: Skip idle changed under a seek, which then replays on the
	// old played times and leaves a position that does not match its screen.
	it("applies a Skip idle change made during a seek once the seek ends", async () => {
		const text = [
			'{"version":3,"term":{"cols":80,"rows":24}}',
			'[10, "o", "A"]',
			'[1, "o", "B"]',
		].join("\n");
		const { playback, last } = player(text, false);
		const seeking = playback.seek(3); // Skip idle on: A at 2 s, B at 3 s
		playback.setSkipIdle(false); // while A's write waits
		for (let i = 0; i < 5; i++) {
			last().flush();
			await Promise.resolve();
		}
		await seeking;
		// The seek replayed A and B; with Skip idle now off they end at 11 s.
		expect(last().text).toBe("AB");
		expect(playback.skipIdle).toBe(false);
		expect(playback.currentTime).toBe(11);
	});

	// Mutation caught: a strict comparison with the target, which float noise in
	// summed delays (100 × 0.01 s = 1.0000000000000007) puts past it.
	it("applies an event that falls on a seek's target despite float noise", async () => {
		const lines = ['{"version":3,"term":{"cols":80,"rows":24}}'];
		for (let i = 0; i < 99; i++) lines.push('[0.01, "o", "."]');
		lines.push('[0.01, "o", "END"]');
		const { playback, last } = player(lines.join("\n"));
		await playback.seek(1);
		expect(last().text.endsWith("END")).toBe(true);
	});

	// The total and the markers are read after every event: computed once.
	it("hands back the same markers until Skip idle changes", () => {
		const { playback } = player(LITERAL);
		const first = playback.markers();
		expect(playback.markers()).toBe(first);
		playback.setSkipIdle(false);
		expect(playback.markers()).not.toBe(first);
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

	// Each event is due at its own played time: the sum of the played delays up to
	// it. Times are fake milliseconds from the start (the system clock set to 0).
	describe("due times", () => {
		beforeEach(() => {
			vi.setSystemTime(0);
		});

		const rec = (...events: string[]) =>
			['{"version":3,"term":{"cols":80,"rows":24}}', ...events].join("\n");

		// Mutation caught: the next delay counted from the end of xterm's parse
		// (writes at 0, 1100, 2200 ms).
		it("plays events 1 s apart at 1 s intervals when each takes 100 ms to parse", async () => {
			const { playback, last } = player(
				rec('[0, "o", "A"]', '[1, "o", "B"]', '[1, "o", "C"]'),
				() => 100,
			);
			playback.play();
			await vi.advanceTimersByTimeAsync(3000);
			expect(last().writes).toEqual([
				[0, "A"],
				[1000, "B"],
				[2000, "C"],
			]);
		});

		// Mutation caught: paused time counted as played (B at 2000 ms).
		it("counts no paused time, a pause during a write included", async () => {
			const { playback, last } = player(rec('[0, "o", "A"]', '[2, "o", "B"]'), (d) =>
				d === "A" ? 1000 : 0,
			);
			playback.play();
			await vi.advanceTimersByTimeAsync(500);
			playback.pause();
			await vi.advanceTimersByTimeAsync(300);
			playback.play(); // A's callback comes at 1000 ms: 0.7 s played by then
			await vi.advanceTimersByTimeAsync(3000);
			expect(last().writes).toEqual([
				[0, "A"],
				[2300, "B"],
			]);
		});

		// Mutation caught: a speed change applied to the time before it (B at 1000 ms).
		it("counts the time before a speed change at the old speed, a write under way included", async () => {
			const { playback, last } = player(rec('[0, "o", "A"]', '[2, "o", "B"]'), (d) =>
				d === "A" ? 1000 : 0,
			);
			playback.play();
			await vi.advanceTimersByTimeAsync(500);
			playback.setSpeed(2); // by A's callback at 1000 ms: 0.5 s at 1x, 1 s at 2x
			await vi.advanceTimersByTimeAsync(3000);
			expect(last().writes).toEqual([
				[0, "A"],
				[1250, "B"],
			]);
		});

		// Mutation caught: the time a write took counted toward the next delay only,
		// up to that delay (B at 2500 ms, 1 s after the size change).
		it("plays an event already due right after the one before it", async () => {
			const { playback, last } = player(
				rec('[0, "o", "A"]', '[0, "r", "90x20"]', '[1, "o", "B"]'),
				(d) => (d === "A" ? 1500 : 0),
			);
			playback.play();
			await vi.advanceTimersByTimeAsync(3000);
			expect(last().writes).toEqual([
				[0, "A"],
				[1500, "B"],
			]);
			expect(last().calls).toEqual(["write:1:0", "resize:90x20:0", "write:1:0"]);
		});

		// Mutation caught: lateness carried to the next event only (C at 3500, D at
		// 4500, E at 5500 ms). Behind, each write is still awaited (C after B's
		// 100 ms), and no event plays before it is due (D at 3000, not 2700).
		it("catches up event by event after a long write, then keeps each due time", async () => {
			const { playback, last } = player(
				rec('[0, "o", "A"]', '[1, "o", "B"]', '[1, "o", "C"]', '[1, "o", "D"]', '[1, "o", "E"]'),
				(d) => (d === "A" ? 2500 : 100),
			);
			playback.play();
			await vi.advanceTimersByTimeAsync(5000);
			expect(last().writes).toEqual([
				[0, "A"],
				[2500, "B"],
				[2600, "C"],
				[3000, "D"],
				[4000, "E"],
			]);
		});

		// Mutation caught: a timer taken as firing on time, so its lateness adds to
		// every later event.
		it("takes a late timer's lateness once, never adding it up", async () => {
			const { playback, last } = player(
				rec('[0, "o", "A"]', '[1, "o", "B"]', '[1, "o", "C"]', '[1, "o", "D"]'),
				true,
				{ setTimer: (fn, ms) => setTimeout(fn, ms + 100) },
			);
			playback.play();
			await vi.advanceTimersByTimeAsync(4000);
			expect(last().writes).toEqual([
				[0, "A"],
				[1100, "B"],
				[2100, "C"],
				[3100, "D"],
			]);
		});

		// Mutations caught: the event played when its timer fires, without looking at
		// the clock (B at 0 ms: a timer drops a delay's fraction); a fractional delay
		// asked as is (a timer of 0.5 ms, which may fire at once).
		it("never plays an event before it is due, under a millisecond away included", async () => {
			const asked: number[] = [];
			const { playback, last } = player(rec('[0, "o", "A"]', '[0.0005, "o", "B"]'), true, {
				setTimer: (fn, ms) => {
					asked.push(ms);
					return setTimeout(fn, ms);
				},
			});
			playback.play();
			await vi.advanceTimersByTimeAsync(0);
			expect(last().text).toBe("A");
			await vi.advanceTimersByTimeAsync(1);
			expect(last().writes).toEqual([
				[0, "A"],
				[1, "B"],
			]);
			expect(asked).toEqual([1]);
		});

		// Mutation caught: the event being written given its whole new delay to wait
		// again (C at 11000 ms).
		it("keeps an event under way due when Skip idle is turned off", async () => {
			const { playback, last } = player(
				rec('[0, "o", "A"]', '[10, "o", "B"]', '[1, "o", "C"]'),
				(d) => (d === "B" ? 1500 : 0),
			);
			playback.play(); // Skip idle on: B is due at 2 s
			await vi.advanceTimersByTimeAsync(2500);
			playback.setSkipIdle(false); // B is being written: its 10 s count as played
			expect(playback.currentTime).toBe(10);
			await vi.advanceTimersByTimeAsync(10000);
			expect(last().writes).toEqual([
				[0, "A"],
				[2000, "B"],
				[3500, "C"],
			]);
		});

		// Mutation caught: the time waited kept past the new, shorter delay (C at
		// 5000 ms, with B).
		it("plays the next event at once when Skip idle shortens a longer wait, then keeps the next delay", async () => {
			const { playback, last } = player(rec('[0, "o", "A"]', '[10, "o", "B"]', '[1, "o", "C"]'));
			playback.setSkipIdle(false);
			playback.play();
			await vi.advanceTimersByTimeAsync(5000);
			playback.setSkipIdle(true); // 5 s waited, the delay now 2 s: B is due
			await vi.advanceTimersByTimeAsync(5000);
			expect(last().writes).toEqual([
				[0, "A"],
				[5000, "B"],
				[6000, "C"],
			]);
		});
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

		// Bounded on both sides. Mutations caught: the speed ignored (b at 1000 ms),
		// the speed counted twice (b at 250 ms).
		it("plays an event due at 1 s of played time between 490 and 510 ms at speed 2", async () => {
			const { playback, last } = player(TWO);
			playback.setSpeed(2);
			playback.play();
			await vi.advanceTimersByTimeAsync(490);
			expect(last().text).toBe("a");
			await vi.advanceTimersByTimeAsync(20);
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
