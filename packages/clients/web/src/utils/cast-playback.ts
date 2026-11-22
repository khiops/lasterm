import type { CastEvent, ParsedCast } from "./cast-parse.js";

/** The part of an xterm the player drives. */
export interface PlaybackTerminal {
	write(data: string, callback: () => void): void;
	resize(cols: number, rows: number): void;
	dispose(): void;
}

/** A delay over this many seconds plays as this many with Skip idle on. */
export const IDLE_CAP_S = 2;
/**
 * The most UTF-16 units written to xterm at once: at most 3 UTF-8 bytes each,
 * so a piece is at most 1 MiB once encoded. The next waits for its callback.
 */
export const WRITE_PIECE_UNITS = Math.floor((1024 * 1024) / 3);

export interface PlaybackOptions {
	/** A fresh terminal of this size: the player's first, and one per seek. */
	createTerminal(cols: number, rows: number): PlaybackTerminal;
	onTime?(seconds: number): void;
	onEnd?(): void;
	onTerminal?(terminal: PlaybackTerminal, cols: number, rows: number): void;
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
	/** Monotonic milliseconds. */
	now?: () => number;
}

/** Where a piece boundary falls: never between the two halves of a surrogate pair. */
function pieceEnd(text: string, start: number): number {
	let end = Math.min(text.length, start + WRITE_PIECE_UNITS);
	if (end < text.length) {
		const code = text.charCodeAt(end - 1);
		if (code >= 0xd800 && code <= 0xdbff) end--;
	}
	return end;
}

/**
 * Plays a parsed cast into xterm (#80). One consumer at a time: an event is
 * written in pieces, each after the previous one's callback, a size change
 * only after the write before it was parsed, and no control starts a second
 * consumer while one writes. Time is continuous: a seek lands on its target
 * even between two events, and pause or a speed change keep what was already
 * waited. A seek drops what was under way (a generation counter), builds a
 * fresh terminal at the header's size and replays up to the target.
 */
export class CastPlayback {
	private terminal: PlaybackTerminal;
	private generation = 0;
	/** The next event to apply. */
	private index = 0;
	/** Played seconds at the last event applied. */
	private position = 0;
	/** Played seconds waited since then (paused, or at the last reschedule). */
	private offset = 0;
	/** An event whose pieces were cut by a pause: where to go on. */
	private partial: { index: number; start: number } | null = null;
	private playing = false;
	/** A seek or a step is writing: no second consumer may start. */
	private busy = false;
	private timer: unknown = null;
	private waitStartedAt = 0;
	private speedValue = 1;
	private skipIdleValue = true;
	private readonly setTimer: (fn: () => void, ms: number) => unknown;
	private readonly clearTimer: (handle: unknown) => void;
	private readonly now: () => number;

	constructor(
		private readonly cast: ParsedCast,
		private readonly options: PlaybackOptions,
	) {
		this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
		this.clearTimer =
			options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
		this.now = options.now ?? (() => performance.now());
		this.terminal = this.freshTerminal();
	}

	get isPlaying(): boolean {
		return this.playing;
	}

	get speed(): number {
		return this.speedValue;
	}

	get skipIdle(): boolean {
		return this.skipIdleValue;
	}

	/** Where playback is, in played seconds, between events included. */
	get currentTime(): number {
		return this.position + this.waited();
	}

	/** The played length: with Skip idle on, long pauses count as 2 s. */
	get totalTime(): number {
		return this.cast.events.reduce((sum, e) => sum + this.played(e), 0);
	}

	/** Where each marker falls, in played seconds, and its label. */
	markers(): Array<{ time: number; label: string }> {
		const out: Array<{ time: number; label: string }> = [];
		let t = 0;
		for (const e of this.cast.events) {
			t += this.played(e);
			if (e.c === "m") out.push({ time: t, label: e.t });
		}
		return out;
	}

	play(): void {
		if (this.playing) return;
		this.playing = true;
		// At the end, it starts over: the seek schedules what follows.
		if (this.index >= this.cast.events.length && this.partial === null) {
			void this.seek(0);
			return;
		}
		this.scheduleNext(this.generation);
	}

	pause(): void {
		if (!this.playing) return;
		this.offset = this.waited();
		this.playing = false;
		this.cancelTimer();
	}

	setSpeed(speed: number): void {
		this.offset = this.waited();
		this.speedValue = speed;
		if (this.playing) this.reschedule();
	}

	/** Changing Skip idle changes the played times: the place is kept by event. */
	setSkipIdle(on: boolean): void {
		const waited = this.waited();
		this.skipIdleValue = on;
		this.position = this.cast.events.slice(0, this.index).reduce((s, e) => s + this.played(e), 0);
		const next = this.cast.events[this.index];
		this.offset = next === undefined ? 0 : Math.min(waited, this.played(next));
		if (this.playing) this.reschedule();
	}

	/** Go to `seconds` of played time; resolves once the terminal shows it. */
	async seek(seconds: number): Promise<void> {
		const gen = ++this.generation;
		this.cancelTimer();
		this.terminal.dispose();
		this.terminal = this.freshTerminal();
		this.index = 0;
		this.position = 0;
		this.offset = 0;
		this.partial = null;
		this.busy = true;
		try {
			while (this.index < this.cast.events.length) {
				const event = this.cast.events[this.index] as CastEvent;
				const at = this.position + this.played(event);
				if (at > seconds) break;
				await this.apply(event, gen, 0, false);
				if (gen !== this.generation) return;
				this.position = at;
				this.index++;
			}
			const next = this.cast.events[this.index];
			this.offset =
				next === undefined ? 0 : Math.min(Math.max(0, seconds - this.position), this.played(next));
		} finally {
			if (gen === this.generation) this.busy = false;
		}
		this.options.onTime?.(this.currentTime);
		if (this.playing) this.scheduleNext(gen);
	}

	dispose(): void {
		this.generation++;
		this.playing = false;
		this.cancelTimer();
		this.terminal.dispose();
	}

	private played(event: CastEvent): number {
		return this.skipIdleValue ? Math.min(event.d, IDLE_CAP_S) : event.d;
	}

	/** Played seconds waited since the last event, the wait under way included. */
	private waited(): number {
		if (!this.playing || this.timer === null) return this.offset;
		const next = this.cast.events[this.index];
		const live = this.offset + ((this.now() - this.waitStartedAt) / 1000) * this.speedValue;
		return next === undefined ? live : Math.min(live, this.played(next));
	}

	private freshTerminal(): PlaybackTerminal {
		const terminal = this.options.createTerminal(this.cast.cols, this.cast.rows);
		this.options.onTerminal?.(terminal, this.cast.cols, this.cast.rows);
		return terminal;
	}

	private cancelTimer(): void {
		if (this.timer !== null) this.clearTimer(this.timer);
		this.timer = null;
	}

	private reschedule(): void {
		this.cancelTimer();
		this.scheduleNext(this.generation);
	}

	private scheduleNext(gen: number): void {
		if (!this.playing || gen !== this.generation || this.busy) return;
		if (this.partial !== null) {
			void this.step(gen);
			return;
		}
		const event = this.cast.events[this.index];
		if (event === undefined) {
			this.playing = false;
			this.offset = 0;
			this.options.onEnd?.();
			return;
		}
		const wait = (Math.max(0, this.played(event) - this.offset) / this.speedValue) * 1000;
		this.waitStartedAt = this.now();
		this.timer = this.setTimer(() => {
			this.timer = null;
			void this.step(gen);
		}, wait);
	}

	private async step(gen: number): Promise<void> {
		const event = this.cast.events[this.index];
		if (event === undefined || gen !== this.generation || this.busy) return;
		const start = this.partial?.index === this.index ? this.partial.start : 0;
		this.partial = null;
		this.busy = true;
		let done = false;
		try {
			done = await this.apply(event, gen, start, true);
		} finally {
			if (gen === this.generation) this.busy = false;
		}
		if (gen !== this.generation || !done) return;
		this.position += this.played(event);
		this.offset = 0;
		this.index++;
		this.options.onTime?.(this.currentTime);
		this.scheduleNext(gen);
	}

	/**
	 * Apply one event from unit `start`, waiting for xterm to parse each piece.
	 * With `pausable`, a pause between pieces stops it there (kept in
	 * `partial`); returns whether the event was applied whole.
	 */
	private async apply(
		event: CastEvent,
		gen: number,
		start: number,
		pausable: boolean,
	): Promise<boolean> {
		if (event.c === "o") {
			let at = start;
			while (at < event.t.length) {
				if (gen !== this.generation) return false;
				if (pausable && !this.playing) {
					this.partial = { index: this.index, start: at };
					return false;
				}
				const end = pieceEnd(event.t, at);
				const piece = event.t.slice(at, end);
				const terminal = this.terminal;
				await new Promise<void>((resolve) => terminal.write(piece, resolve));
				at = end;
			}
		} else if (event.c === "r") {
			const [cols, rows] = event.t.split("x").map(Number) as [number, number];
			this.terminal.resize(cols, rows);
			this.options.onTerminal?.(this.terminal, cols, rows);
		}
		return true;
	}
}
