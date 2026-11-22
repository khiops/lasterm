import { MAX_NAME_BYTES, windowsNameProblem } from "./transfer-protocol.js";

/**
 * The names a download writes (#840): a host name a Windows system cannot hold,
 * renamed so it can (spec W6), the first rename D1 uses for the save dialog's
 * default name.
 */

const FORBIDDEN = /[<>:"/\\|?*\p{Cc}]/gu;
const RESERVED_STEM = /^(?:CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³]|CONIN\$|CONOUT\$)$/i;

const encoder = new TextEncoder();

/** `text` cut at a character boundary to at most `bytes` UTF-8 bytes. */
function cutToBytes(text: string, bytes: number): string {
	let kept = "";
	for (const character of text) {
		if (encoder.encode(kept + character).length > bytes) break;
		kept += character;
	}
	return kept;
}

/**
 * `name` as a Windows name: each forbidden character `_`, trailing dots and
 * spaces removed, an empty result `_`, a reserved device stem (the text before
 * the first dot) followed by `_`, and the whole cut to `MAX_NAME_BYTES`. A name
 * Windows already holds comes back unchanged.
 */
export function downloadRename(name: string): string {
	if (windowsNameProblem(name) === null && encoder.encode(name).length <= MAX_NAME_BYTES) {
		return name;
	}
	// Cut to leave a byte for the `_` a device name takes, then strip what a cut
	// may leave at the end, then look at the stem the cut name has.
	let renamed = cutToFit(name.replace(FORBIDDEN, "_"), MAX_NAME_BYTES - 1).replace(/[. ]+$/, "");
	if (renamed === "") renamed = "_";
	const dot = renamed.indexOf(".");
	const stem = dot === -1 ? renamed : renamed.slice(0, dot);
	if (RESERVED_STEM.test(stem)) renamed = `${stem}_${renamed.slice(stem.length)}`;
	return renamed;
}

/** `name` cut to `bytes` UTF-8 bytes, its extension kept when it fits. */
function cutToFit(name: string, bytes: number): string {
	if (encoder.encode(name).length <= bytes) return name;
	const dot = name.lastIndexOf(".");
	const extension = dot > 0 ? name.slice(dot) : "";
	const room = bytes - encoder.encode(extension).length;
	if (room <= 0) return cutToBytes(name, bytes);
	return `${cutToBytes(name.slice(0, dot > 0 ? dot : name.length), room)}${extension}`;
}

/**
 * `name` with `suffix` (` (2)`) before its extension, the stem cut so the whole
 * fits `MAX_NAME_BYTES`.
 */
export function withSuffix(name: string, suffix: string): string {
	const dot = name.lastIndexOf(".");
	const hasExtension = dot > 0;
	const stem = hasExtension ? name.slice(0, dot) : name;
	const extension = hasExtension ? name.slice(dot) : "";
	const room = MAX_NAME_BYTES - encoder.encode(suffix + extension).length;
	if (room <= 0) return cutToBytes(`${stem}${suffix}`, MAX_NAME_BYTES);
	return `${cutToBytes(stem, room)}${suffix}${extension}`;
}
