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
 * Reads an asciicast v3 or v2 file chunk by chunk (#80), so a file of any
 * size the player accepts is never held as one string. Each event line is
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
	private rest = "";
	private header: { version: 2 | 3; cols: number; rows: number; title: string | null } | null =
		null;
	private readonly events: CastEvent[] = [];
	private carried = 0;
	private previousTime = 0;
	private failed = false;

	/** Feed the next chunk of text. */
	push(chunk: string): void {
		if (this.failed) return;
		const text = this.rest + chunk;
		const lines = text.split(/\r?\n/);
		this.rest = lines.pop() ?? "";
		try {
			for (const line of lines) this.line(line);
		} catch (err) {
			if (!(err instanceof NotACast)) throw err;
			this.failed = true;
		}
	}

	/** The cast, or why it cannot be read. */
	finish(): ParsedCast | { error: string } {
		if (!this.failed && this.rest !== "") {
			try {
				this.line(this.rest);
			} catch (err) {
				if (!(err instanceof NotACast)) throw err;
				this.failed = true;
			}
			this.rest = "";
		}
		if (this.failed || this.header === null) return { error: NOT_A_CAST };
		return {
			cols: this.header.cols,
			rows: this.header.rows,
			title: this.header.title,
			events: this.events,
		};
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
export async function parseCastChunks(
	chunks: AsyncIterable<string>,
): Promise<ParsedCast | { error: string }> {
	const parser = new CastParser();
	for await (const chunk of chunks) parser.push(chunk);
	return parser.finish();
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
