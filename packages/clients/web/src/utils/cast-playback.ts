import type { CastEvent, ParsedCast } from "./cast-parse.js";

/** The part of an xterm the player drives. */
export interface PlaybackTerminal {
	write(data: string, callback: () => void): void;
	resize(cols: number, rows: number): void;
	dispose(): void;
}

/** A delay over this many seconds plays as this many with Skip idle on. */
export const IDLE_CAP_S = 2;
/** The longest single timer: a longer wait is taken in steps (timers count in 32 bits). */
export const MAX_TIMER_MS = 24 * 60 * 60 * 1000;
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
 * consumer while one writes. Time is one played clock: it stands still while
 * paused and runs at the speed of each moment. Each event is due at its own
 * played time, the sum of the played delays up to it; after a write or a
 * timer the player waits only for what remains until the next event is due,
 * and plays one already due at once, so neither parse time nor a late timer
 * adds up over events. A seek drops what was under way (a generation
 * counter), builds a fresh terminal at the header's size, replays up to the
 * target and sets the clock there.
 */
export class CastPlayback {
	private terminal: PlaybackTerminal;
	private generation = 0;
	/** The next event to apply. */
	private index = 0;
	/** Played seconds at the last event applied: the next event is due its played delay later. */
	private position = 0;
	/** An event whose pieces were cut by a pause: where to go on. */
	private partial: { index: number; start: number } | null = null;
	private playing = false;
	/** A seek or a step is writing: no second consumer may start. */
	private busy = false;
	private timer: unknown = null;
	/** The played clock: `clockBase` played seconds at `clockAt`, running only while playing. */
	private clockBase = 0;
	private clockAt = 0;
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

	/** Where playback is, in played seconds, between events included; never past the next event. */
	get currentTime(): number {
		return Math.min(this.playedClock(), this.due());
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
		this.rebaseClock();
		this.playing = true;
		// At the end, it starts over: the seek schedules what follows.
		if (this.index >= this.cast.events.length && this.partial === null) {
			void this.seek(0);
			return;
		}
		this.pump(this.generation);
	}

	pause(): void {
		if (!this.playing) return;
		this.rebaseClock();
		this.playing = false;
		this.cancelTimer();
	}

	setSpeed(speed: number): void {
		this.rebaseClock();
		this.speedValue = speed;
		if (this.playing) this.reschedule();
	}

	/**
	 * Changing Skip idle changes the played times: the place is kept by event.
	 * A wait under way keeps what was waited, up to the new delay; an event
	 * already due (being written, or late) stays due, and keeps how late it is.
	 */
	setSkipIdle(on: boolean): void {
		const clock = this.playedClock();
		const due = this.due();
		const sinceLast = clock - this.position;
		this.skipIdleValue = on;
		this.position = this.cast.events.slice(0, this.index).reduce((s, e) => s + this.played(e), 0);
		const next = this.cast.events[this.index];
		if (next === undefined) this.setClock(this.position);
		else if (clock >= due) this.setClock(this.due() + (clock - due));
		else this.setClock(this.position + Math.min(sinceLast, this.played(next)));
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
			// The clock starts from the target, whatever time the replay took.
			this.setClock(Math.min(Math.max(seconds, this.position), this.due()));
		} finally {
			if (gen === this.generation) this.busy = false;
		}
		this.options.onTime?.(this.currentTime);
		if (this.playing) this.pump(gen);
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

	/** When the next event is due, in played seconds; at the end, the last event's time. */
	private due(): number {
		const next = this.cast.events[this.index];
		return next === undefined ? this.position : this.position + this.played(next);
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
		this.pump(this.generation);
	}

	/**
	 * The one queue: play the next event if it is due on the played clock,
	 * otherwise wait for what remains, then look again. A timer that fires late
	 * or a write that took long leaves the clock further on, so the next wait
	 * is shorter, or none: lateness is never added to the following delays.
	 */
	private pump(gen: number): void {
		if (!this.playing || gen !== this.generation || this.busy) return;
		this.cancelTimer();
		if (this.partial !== null) {
			void this.step(gen);
			return;
		}
		if (this.cast.events[this.index] === undefined) {
			this.setClock(this.position);
			this.playing = false;
			this.options.onEnd?.();
			return;
		}
		const left = this.due() - this.playedClock();
		if (left <= 0) {
			void this.step(gen);
			return;
		}
		// Rounded up: a timer never fires before the event is due (a browser
		// drops a delay's fraction), and always lets time move on, so the check
		// above is never repeated at the same instant. A long wait is taken in
		// several timers.
		const ms = Math.min(Math.ceil((left / this.speedValue) * 1000), MAX_TIMER_MS);
		this.timer = this.setTimer(() => {
			this.timer = null;
			this.pump(gen);
		}, ms);
	}

	/** The played clock: it stands still while paused, and follows each speed change. */
	private playedClock(): number {
		if (!this.playing) return this.clockBase;
		return this.clockBase + ((this.now() - this.clockAt) / 1000) * this.speedValue;
	}

	private setClock(seconds: number): void {
		this.clockBase = seconds;
		this.clockAt = this.now();
	}

	/** Before a change of play state or speed: what was played so far keeps its speed. */
	private rebaseClock(): void {
		this.setClock(this.playedClock());
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
		this.index++;
		this.options.onTime?.(this.currentTime);
		this.pump(gen);
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
