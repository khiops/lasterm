/**
 * Composable for deterministic host badge visuals.
 * Derives initials and a stable background color from a host label,
 * so each host always renders the same badge without any server-side data.
 */

/** Hue values (degrees) for the badge palette — chosen for good contrast on dark backgrounds. */
const HUE_PALETTE = [210, 145, 20, 280, 0, 170, 330, 60, 240, 100] as const;

/**
 * Produce a simple djb2-style hash of a string, returning a non-negative integer.
 */
function hashString(s: string): number {
	let h = 5381;
	for (let i = 0; i < s.length; i++) {
		h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; // keep 32-bit unsigned
	}
	return h;
}

/**
 * Return the first letter of `label` uppercased.
 * Falls back to "?" when the label is empty.
 */
/**
 * Return initials from `label`:
 * - Multi-word (split on `-`, `_`, space, `.`): first letter of each of first 2 words, uppercased.
 * - Single word: first 2 chars uppercased.
 * - Empty / whitespace-only: "?".
 */
export function getInitials(label: string): string {
	const trimmed = label.trim();
	if (!trimmed) return "?";
	const words = trimmed.split(/[-_\s.]+/).filter(Boolean);
	if (words.length >= 2) {
		return ((words[0]?.[0] ?? "") + (words[1]?.[0] ?? "")).toUpperCase();
	}
	return trimmed.slice(0, 2).toUpperCase();
}

/**
 * Convert an HSL color (H in degrees, S and L as 0–1 fractions) to a `#rrggbb` hex string.
 */
function hslToHex(h: number, s: number, l: number): string {
	const a = s * Math.min(l, 1 - l);
	const f = (n: number): string => {
		const k = (n + h / 30) % 12;
		const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
		return Math.round(255 * color)
			.toString(16)
			.padStart(2, "0");
	};
	return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * Return a deterministic hex CSS color string derived from `label`.
 * Saturation is fixed at 65 %, lightness at 52 % — readable on a dark background
 * without being garish. Returns hex so it is compatible with `<input type="color">`.
 */
export function getColorFromLabel(label: string): string {
	const hue = HUE_PALETTE[hashString(label) % HUE_PALETTE.length] ?? 210;
	return hslToHex(hue, 0.65, 0.52);
}

/**
 * The colour a host shows: the one it was given, else the one its label gives, as
 * its badge draws it (#659). A visual profile's border with no colour of its own
 * takes this one, and the profile's settings show it (#663).
 */
export function getHostColor(host: { color?: string | null | undefined; label: string }): string {
	return host.color || getColorFromLabel(host.label);
}
