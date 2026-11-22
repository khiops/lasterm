const MAX_RAW_LENGTH = 256;

/** Matches C0 (U+0000–U+001F), DEL (U+007F), and C1 (U+0080–U+009F) control characters. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — stripping terminal control chars
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]/g;

const ELLIPSIS = "\u2026";

/**
 * Sanitize a terminal title received from OSC 0/2 escape sequences.
 *
 * 1. Strip HTML tags (XSS prevention)
 * 2. Strip control characters U+0000–U+001F and U+007F–U+009F (keep printable + Unicode)
 * 3. Trim surrounding whitespace
 * 4. Truncate to maxRawLength UTF-16 units, never splitting a surrogate pair
 */
export function sanitizeTitle(raw: string, maxRawLength = MAX_RAW_LENGTH): string {
	const cleaned = raw
		.replace(/<[^>]*>/g, "")
		.replace(CONTROL_CHARS_RE, "")
		.trim();
	return sliceHead(cleaned, maxRawLength);
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

/** First `count` UTF-16 units of `text`, one fewer when the cut would split a surrogate pair. */
function sliceHead(text: string, count: number): string {
	const end =
		count > 0 && count < text.length && isHighSurrogate(text.charCodeAt(count - 1))
			? count - 1
			: count;
	return text.slice(0, end);
}

/** Last `count` UTF-16 units of `text`, one fewer when the cut would split a surrogate pair. */
function sliceTail(text: string, count: number): string {
	if (count <= 0) return "";
	let start = text.length - count;
	if (start > 0 && isLowSurrogate(text.charCodeAt(start))) start += 1;
	return text.slice(start);
}

export type TruncationPosition = "end" | "middle" | "start";

/**
 * Truncate a title for display in tabs/panes, inserting a single ellipsis
 * character (U+2026) at the configured position.
 *
 * @param title     - The title to truncate
 * @param maxLength - Maximum length in UTF-16 units; a cut inside a surrogate pair moves inward, so the result may be one unit shorter
 * @param position  - Where to place the ellipsis: 'end', 'middle', or 'start'
 */
export function truncateTitle(
	title: string,
	maxLength: number,
	position: TruncationPosition = "end",
): string {
	if (title.length <= maxLength) return title;
	if (maxLength < 1) return "";
	if (maxLength === 1) return ELLIPSIS;

	switch (position) {
		case "end":
			return sliceHead(title, maxLength - 1) + ELLIPSIS;

		case "start":
			return ELLIPSIS + sliceTail(title, maxLength - 1);

		case "middle": {
			const left = Math.ceil((maxLength - 1) / 2);
			const right = Math.floor((maxLength - 1) / 2);
			return sliceHead(title, left) + ELLIPSIS + sliceTail(title, right);
		}
	}
}
