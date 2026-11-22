import { CAST_MAX_COLS, CAST_MAX_ROWS } from "@lasterm/shared";

/** One event the player plays: its delay from the previous kept event, in seconds. */
export interface CastEvent {
	d: number;
	c: "o" | "r" | "m" | "x";
	t: string;
}

export interface ParsedCast {
	cols: number;
	rows: number;
	title: string | null;
	events: CastEvent[];
}

export const NOT_A_CAST = "Not an asciicast v2 or v3 file";
export const EVENT_TOO_LARGE = "This file has an event too large to replay";
/**
 * The longest line read, in UTF-16 units: 2^27, about half the smaller of V8's string caps
 * (2^28 - 16 on 32-bit builds, 2^29 - 24 on 64-bit ones), leaving room for the
 * text decoding a line builds besides the line itself. The hub's own lines
 * are under 61 MiB.
 */
export const DEFAULT_MAX_LINE_UNITS = 134_217_728;

const SIZE = /^(\d+)x(\d+)$/;

function validSize(cols: unknown, rows: unknown): boolean {
	return (
		typeof cols === "number" &&
		typeof rows === "number" &&
		Number.isInteger(cols) &&
		Number.isInteger(rows) &&
		cols >= 1 &&
		rows >= 1 &&
		cols <= CAST_MAX_COLS &&
		rows <= CAST_MAX_ROWS
	);
}

class NotACast extends Error {}

/**
 * Reads an asciicast v3 or v2 file chunk by chunk (#80), so the file is never
 * held as one string; each line is, so a line over `maxLineUnits` UTF-16
 * units (its `\n` or `\r\n` aside) is refused with its own error, counted
 * while it is still in pieces and before anything is joined, and nothing is
 * read after it. A line still open is kept in pieces and joined only when it
 * ends, so a long line costs its length. The first refusal in the file is the
 * one given. Each event line is
 * `[time, code, data]`, exactly three elements, `data` a string. v3 delays are
 * never negative; v2's absolute times become delays (a time below the
 * previous one is a delay of 0, and the next delay counts from it). Positions
 * are kept before filtering: an `i` event or an unknown code is skipped and
 * its delay added to the next kept event. Blank lines and v3 `#` comments are
 * skipped. A header or a size outside 1–500 columns and rows, a malformed line
 * or a bad `r` value make the whole file unreadable, before any terminal is
 * built.
 */
export class CastParser {
	/** The open line's pieces, joined once it ends, and their length in UTF-16 units. */
	private rest: string[] = [];
	private restLength = 0;
	private readonly maxLineUnits: number;
	private header: { version: 2 | 3; cols: number; rows: number; title: string | null } | null =
		null;
	private readonly events: CastEvent[] = [];
	private carried = 0;
	private previousTime = 0;
	/** Why the cast cannot be read, once known: the first refusal in the file. */
	private failure: string | null = null;

	constructor(options: { maxLineUnits?: number } = {}) {
		this.maxLineUnits = options.maxLineUnits ?? DEFAULT_MAX_LINE_UNITS;
	}

	/** Whether the cast is already unreadable: nothing after can make it readable. */
	get hasFailed(): boolean {
		return this.failure !== null;
	}

	/** Feed the next chunk of text. */
	push(chunk: string): void {
		let start = 0;
		while (this.failure === null) {
			const end = chunk.indexOf("\n", start);
			const piece = end === -1 ? chunk.slice(start) : chunk.slice(start, end);
			if (end === -1) {
				if (piece !== "") {
					this.rest.push(piece);
					this.restLength += piece.length;
				}
				// A line still open: a last "\r" may yet be its line end, the rest counts.
				const open = this.restLength - (this.restEndsWithCR() ? 1 : 0);
				if (open > this.maxLineUnits) this.failure = EVENT_TOO_LARGE;
				return;
			}
			const endsWithCR = piece !== "" ? piece.endsWith("\r") : this.restEndsWithCR();
			const length = this.restLength + piece.length - (endsWithCR ? 1 : 0);
			if (length > this.maxLineUnits) {
				this.failure = EVENT_TOO_LARGE;
				return;
			}
			const whole = this.rest.length === 0 ? piece : this.rest.join("") + piece;
			this.rest = [];
			this.restLength = 0;
			this.read(endsWithCR ? whole.slice(0, -1) : whole);
			start = end + 1;
		}
	}

	/** The cast, or why it cannot be read. */
	finish(): ParsedCast | { error: string } {
		if (this.failure === null && this.restLength > 0) {
			if (this.restLength > this.maxLineUnits) this.failure = EVENT_TOO_LARGE;
			else this.read(this.rest.join(""));
		}
		this.rest = [];
		this.restLength = 0;
		if (this.failure !== null) return { error: this.failure };
		if (this.header === null) return { error: NOT_A_CAST };
		return {
			cols: this.header.cols,
			rows: this.header.rows,
			title: this.header.title,
			events: this.events,
		};
	}

	private restEndsWithCR(): boolean {
		return this.rest.at(-1)?.endsWith("\r") ?? false;
	}

	/** One whole line: a refusal of it is the cast's. */
	private read(line: string): void {
		try {
			this.line(line);
		} catch (err) {
			if (!(err instanceof NotACast)) throw err;
			this.failure = NOT_A_CAST;
		}
	}

	private line(line: string): void {
		if (this.header === null) {
			this.readHeader(line);
			return;
		}
		if (line.trim() === "") return;
		if (this.header.version === 3 && line.startsWith("#")) return;
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			throw new NotACast();
		}
		if (
			!Array.isArray(event) ||
			event.length !== 3 ||
			typeof event[0] !== "number" ||
			!Number.isFinite(event[0]) ||
			typeof event[1] !== "string" ||
			typeof event[2] !== "string"
		) {
			throw new NotACast();
		}
		const [time, code, data] = event as [number, string, string];
		let delay: number;
		if (this.header.version === 3) {
			if (time < 0) throw new NotACast();
			delay = time;
		} else {
			delay = Math.max(0, time - this.previousTime);
			this.previousTime = time;
		}
		if (code !== "o" && code !== "r" && code !== "m" && code !== "x") {
			this.carried += delay;
			return;
		}
		if (code === "r") {
			const match = SIZE.exec(data);
			if (!match || !validSize(Number(match[1]), Number(match[2]))) throw new NotACast();
		}
		this.events.push({ d: this.carried + delay, c: code, t: data });
		this.carried = 0;
	}

	private readHeader(line: string): void {
		let header: unknown;
		try {
			header = JSON.parse(line);
		} catch {
			throw new NotACast();
		}
		if (header === null || typeof header !== "object") throw new NotACast();
		const h = header as Record<string, unknown>;
		let cols: unknown;
		let rows: unknown;
		if (h.version === 3) {
			const term = h.term as Record<string, unknown> | undefined;
			cols = term?.cols;
			rows = term?.rows;
		} else if (h.version === 2) {
			cols = h.width;
			rows = h.height;
		} else {
			throw new NotACast();
		}
		if (!validSize(cols, rows)) throw new NotACast();
		this.header = {
			version: h.version as 2 | 3,
			cols: cols as number,
			rows: rows as number,
			title: typeof h.title === "string" ? h.title : null,
		};
	}
}

/** Read a whole cast held as one string (small casts, tests). */
export function parseCast(text: string): ParsedCast | { error: string } {
	const parser = new CastParser();
	parser.push(text);
	return parser.finish();
}

/** Read a cast from chunks as they arrive: parts from the hub, or a file's stream. */
/**
 * Parse every chunk, or stop reading once `cancelled` says so (the player
 * closed): leaving the loop ends the source, so no further part is fetched.
 */
export async function parseCastChunks(
	chunks: AsyncIterable<string>,
	cancelled: () => boolean = () => false,
	options: { maxLineUnits?: number } = {},
): Promise<ParsedCast | { error: string } | null> {
	const parser = new CastParser(options);
	for await (const chunk of chunks) {
		if (cancelled()) return null;
		parser.push(chunk);
		// Unreadable already: leaving the loop ends the source, nothing more is read.
		if (parser.hasFailed) break;
	}
	return cancelled() ? null : parser.finish();
}

/** A file's text, chunk by chunk, never whole. */
export async function* fileChunks(file: Blob): AsyncGenerator<string> {
	const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			yield value;
		}
	} finally {
		reader.releaseLock();
	}
}
