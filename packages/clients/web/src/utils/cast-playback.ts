import type { CastEvent, ParsedCast } from "./cast-parse.js";

/** The part of an xterm the player drives. */
export interface PlaybackTerminal {
	write(data: string, callback: () => void): void;
	resize(cols: number, rows: number): void;
	dispose(): void;
}

/** A delay over this many seconds plays as this many with Skip idle on. */
export const IDLE_CAP_S = 2;
/** The most written to xterm at once; the next piece waits for its callback. */
export const WRITE_PIECE = 1024 * 1024;

export interface PlaybackOptions {
	/** A fresh terminal of this size: the player's first, and one per seek. */
	createTerminal(cols: number, rows: number): PlaybackTerminal;
	onTime?(seconds: number): void;
	onEnd?(): void;
	onTerminal?(terminal: PlaybackTerminal, cols: number, rows: number): void;
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
}

/**
 * Plays a parsed cast into xterm (#80). One ordered queue: output goes in
 * pieces of at most 1 MiB, each after the previous one's callback, and a size
 * change only after the write before it was parsed. A seek drops the queue (a
 * generation counter: work of an older one does nothing), builds a fresh
 * terminal at the header's size and replays up to the target, so a seek
 * backwards never keeps a later size or a write still pending.
 */
export class CastPlayback {
	private terminal: PlaybackTerminal;
	private generation = 0;
	private index = 0;
	/** Played seconds at the last event applied. */
	private position = 0;
	private playing = false;
	private timer: unknown = null;
	private speedValue = 1;
	private skipIdleValue = true;
	private readonly setTimer: (fn: () => void, ms: number) => unknown;
	private readonly clearTimer: (handle: unknown) => void;

	constructor(
		private readonly cast: ParsedCast,
		private readonly options: PlaybackOptions,
	) {
		this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
		this.clearTimer =
			options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
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

	get currentTime(): number {
		return this.position;
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
		if (this.index >= this.cast.events.length) void this.seek(0);
		else this.scheduleNext(this.generation);
	}

	pause(): void {
		this.playing = false;
		if (this.timer !== null) this.clearTimer(this.timer);
		this.timer = null;
	}

	setSpeed(speed: number): void {
		this.speedValue = speed;
		if (this.playing) this.reschedule();
	}

	/** Changing Skip idle changes the played times: the place is kept by event. */
	setSkipIdle(on: boolean): void {
		this.skipIdleValue = on;
		this.position = this.cast.events.slice(0, this.index).reduce((s, e) => s + this.played(e), 0);
		if (this.playing) this.reschedule();
	}

	/** Go to `seconds` of played time; resolves once the terminal shows it. */
	async seek(seconds: number): Promise<void> {
		const gen = ++this.generation;
		if (this.timer !== null) this.clearTimer(this.timer);
		this.timer = null;
		this.terminal.dispose();
		this.terminal = this.freshTerminal();
		this.index = 0;
		this.position = 0;
		while (this.index < this.cast.events.length) {
			const event = this.cast.events[this.index] as CastEvent;
			const at = this.position + this.played(event);
			if (at > seconds) break;
			await this.apply(event, gen);
			if (gen !== this.generation) return;
			this.position = at;
			this.index++;
		}
		this.options.onTime?.(this.position);
		if (this.playing) this.scheduleNext(gen);
	}

	dispose(): void {
		this.generation++;
		this.pause();
		this.terminal.dispose();
	}

	private played(event: CastEvent): number {
		return this.skipIdleValue ? Math.min(event.d, IDLE_CAP_S) : event.d;
	}

	private freshTerminal(): PlaybackTerminal {
		const terminal = this.options.createTerminal(this.cast.cols, this.cast.rows);
		this.options.onTerminal?.(terminal, this.cast.cols, this.cast.rows);
		return terminal;
	}

	private reschedule(): void {
		if (this.timer !== null) this.clearTimer(this.timer);
		this.timer = null;
		this.scheduleNext(this.generation);
	}

	private scheduleNext(gen: number): void {
		if (!this.playing || gen !== this.generation) return;
		const event = this.cast.events[this.index];
		if (event === undefined) {
			this.playing = false;
			this.options.onEnd?.();
			return;
		}
		const wait = (this.played(event) / this.speedValue) * 1000;
		this.timer = this.setTimer(() => {
			this.timer = null;
			void this.step(gen);
		}, wait);
	}

	private async step(gen: number): Promise<void> {
		const event = this.cast.events[this.index];
		if (event === undefined || gen !== this.generation) return;
		await this.apply(event, gen);
		if (gen !== this.generation) return;
		this.position += this.played(event);
		this.index++;
		this.options.onTime?.(this.position);
		this.scheduleNext(gen);
	}

	/** Apply one event, waiting for xterm to parse what it writes. */
	private async apply(event: CastEvent, gen: number): Promise<void> {
		if (event.c === "o") {
			for (let start = 0; start < event.t.length; start += WRITE_PIECE) {
				if (gen !== this.generation) return;
				const piece = event.t.slice(start, start + WRITE_PIECE);
				const terminal = this.terminal;
				await new Promise<void>((resolve) => terminal.write(piece, resolve));
			}
		} else if (event.c === "r") {
			const [cols, rows] = event.t.split("x").map(Number) as [number, number];
			this.terminal.resize(cols, rows);
			this.options.onTerminal?.(this.terminal, cols, rows);
		}
	}
}
