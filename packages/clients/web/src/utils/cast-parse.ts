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

function validSize(cols: unknown, rows: unknown): cols is number {
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

/**
 * Read an asciicast v3 or v2 file (#80). v2's absolute times become delays
 * (a time below the previous one is a delay of 0). Positions are kept before
 * filtering: an `i` event or an unknown code is skipped and its delay added to
 * the next kept event. Blank lines and v3 `#` comments are skipped. A header
 * or a size outside 1–500 columns and rows, a malformed line or a bad `r`
 * value make the whole file unreadable, before any terminal is built.
 */
export function parseCast(text: string): ParsedCast | { error: string } {
	const lines = text.split(/\r?\n/);
	let header: Record<string, unknown>;
	try {
		header = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
	} catch {
		return { error: NOT_A_CAST };
	}
	if (header === null || typeof header !== "object") return { error: NOT_A_CAST };
	const version = header.version;
	let cols: unknown;
	let rows: unknown;
	if (version === 3) {
		const term = header.term as Record<string, unknown> | undefined;
		cols = term?.cols;
		rows = term?.rows;
	} else if (version === 2) {
		cols = header.width;
		rows = header.height;
	} else {
		return { error: NOT_A_CAST };
	}
	if (!validSize(cols, rows)) return { error: NOT_A_CAST };

	const events: CastEvent[] = [];
	let carried = 0;
	let previousTime = 0;
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i] as string;
		if (line.trim() === "") continue;
		if (version === 3 && line.startsWith("#")) continue;
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			return { error: NOT_A_CAST };
		}
		if (
			!Array.isArray(event) ||
			event.length < 3 ||
			typeof event[0] !== "number" ||
			typeof event[1] !== "string"
		) {
			return { error: NOT_A_CAST };
		}
		const [time, code, data] = event as [number, string, unknown];
		if (!Number.isFinite(time)) return { error: NOT_A_CAST };
		let delay: number;
		if (version === 3) {
			delay = Math.max(0, time);
		} else {
			delay = Math.max(0, time - previousTime);
			previousTime = Math.max(previousTime, time);
		}
		if (code !== "o" && code !== "r" && code !== "m" && code !== "x") {
			carried += delay;
			continue;
		}
		const value = typeof data === "number" ? String(data) : data;
		if (typeof value !== "string") return { error: NOT_A_CAST };
		if (code === "r") {
			const match = SIZE.exec(value);
			if (!match || !validSize(Number(match[1]), Number(match[2]))) return { error: NOT_A_CAST };
		}
		events.push({ d: carried + delay, c: code, t: value });
		carried = 0;
	}
	return {
		cols: cols as number,
		rows: rows as number,
		title: typeof header.title === "string" ? header.title : null,
		events,
	};
}
