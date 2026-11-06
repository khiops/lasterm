/**
 * Sending a file's bytes (#837, part of #721): chunk by chunk over REST,
 * `PUT /api/transfers/:id/items/:item?offset=` (PROTOCOL.md § 6, Transfers), each from where the
 * host's bytes end. A chunk is answered once the host acknowledged it, so the loop goes at the
 * host's pace, and it waits on those answers rather than on timers, which a hidden page has
 * throttled: a window hidden in the tray keeps uploading.
 *
 * - The offset is the hub's: an answer that says the host holds another amount
 *   (`OFFSET_MISMATCH`, with `acked`) moves the next chunk there; a file the hub no longer takes
 *   (`ITEM_NOT_SENDING`: cancelled, interrupted, failed) stops the loop without a word.
 * - A request that never reached the hub, or one written while another was (`ITEM_BUSY`), is sent
 *   again from the same offset a few times, then given up: the caller cancels the file at the
 *   hub, so that it holds no place, and a Retry sends it again.
 */
import { TRANSFER_CHUNK_BYTES } from "@lasterm/shared";
import { useAuthStore } from "../stores/auth.js";
import { hubUnreachable } from "./hub-answer.js";
import { hubFetch } from "./hub-fetch.js";
import { hubBaseUrl } from "./hub-url.js";

/** What one PUT answered. */
export type ChunkAnswer =
	| { readonly ok: true; readonly acked: number }
	| {
			readonly ok: false;
			/** The HTTP status; 0 for a request that never reached the hub. */
			readonly status: number;
			readonly code: string;
			readonly message: string;
			/** With `OFFSET_MISMATCH`: where the host's bytes end. */
			readonly acked?: number;
			/** With `ITEM_NOT_SENDING`: what the file is now. */
			readonly state?: string;
	  };

/** Send one chunk at `offset`. */
export type PutChunk = (offset: number, chunk: Blob) => Promise<ChunkAnswer>;

/** How a file's loop ended. */
export type SendOutcome =
	/** Every byte is on the host: the hub verifies and places it. */
	| { readonly kind: "sent"; readonly acked: number }
	/** The hub no longer takes its bytes, or the caller stopped it: nothing to say. */
	| { readonly kind: "stopped"; readonly state?: string }
	/** It could not be read here, or the hub could not be reached: the caller cancels it there. */
	| {
			readonly kind: "failed";
			readonly code: string;
			readonly message: string;
			readonly local: boolean;
	  };

export interface SendOptions {
	readonly file: Blob;
	/** Where the host's bytes end now: the start, or `acked` of a file that resumes. */
	readonly from: number;
	readonly put: PutChunk;
	readonly chunkBytes?: number;
	/** Told each time the host acknowledged more. */
	readonly onAcked?: (acked: number) => void;
	/** Checked before each chunk: the window cancelled it, or left. */
	readonly stopped?: () => boolean;
	/** How long to wait before sending a chunk again; the attempt is 1 for the first retry. */
	readonly backoff?: (attempt: number) => Promise<void>;
}

/** How many times a chunk that did not get through is sent again before the file is given up. */
export const CHUNK_RETRIES = 5;
/** How many times running the hub moves the offset before the file is given up: a loop. */
const MAX_OFFSET_MOVES = 8;

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 0.5 s, 1 s, 2 s, 4 s, 8 s. */
export function defaultBackoff(attempt: number): Promise<void> {
	return wait(500 * 2 ** Math.max(0, attempt - 1));
}

/** Whether an answer is worth sending the same chunk again for. */
function transient(answer: Exclude<ChunkAnswer, { ok: true }>): boolean {
	return answer.status === 0 || answer.code === "ITEM_BUSY" || answer.status === 503;
}

/**
 * Send `file` from `from` to its end, a chunk at a time, each at the offset the host holds.
 * Never throws.
 */
export async function sendFileBytes(options: SendOptions): Promise<SendOutcome> {
	const size = options.file.size;
	const chunkBytes = Math.max(1, options.chunkBytes ?? TRANSFER_CHUNK_BYTES);
	const backoff = options.backoff ?? defaultBackoff;
	let offset = Math.min(Math.max(0, options.from), size);
	let retries = 0;
	let moves = 0;
	while (offset < size) {
		if (options.stopped?.() === true) return { kind: "stopped" };
		const chunk = options.file.slice(offset, Math.min(size, offset + chunkBytes));
		let answer: ChunkAnswer;
		try {
			answer = await options.put(offset, chunk);
		} catch (error) {
			// Reading the file failed under the request: changed or gone since it was dropped.
			const name = error instanceof DOMException || error instanceof Error ? error.name : "";
			if (name === "NotReadableError" || name === "NotFoundError") {
				return {
					kind: "failed",
					code: name,
					message: "The file changed or was removed since it was dropped",
					local: true,
				};
			}
			answer = { ok: false, status: 0, code: "HUB_UNREACHABLE", message: String(error) };
		}
		if (answer.ok) {
			retries = 0;
			if (answer.acked <= offset) {
				// The host holds no more than before: never loop on the same bytes.
				if (++moves > MAX_OFFSET_MOVES) {
					return {
						kind: "failed",
						code: "NO_PROGRESS",
						message: "The host took none of it",
						local: false,
					};
				}
			}
			offset = answer.acked;
			options.onAcked?.(offset);
			continue;
		}
		if (answer.code === "ITEM_NOT_SENDING") {
			return answer.state !== undefined
				? { kind: "stopped", state: answer.state }
				: { kind: "stopped" };
		}
		if (answer.code === "OFFSET_MISMATCH" && typeof answer.acked === "number") {
			if (++moves > MAX_OFFSET_MOVES) {
				return { kind: "failed", code: answer.code, message: answer.message, local: false };
			}
			offset = answer.acked;
			options.onAcked?.(offset);
			continue;
		}
		if (transient(answer) && retries < CHUNK_RETRIES) {
			retries++;
			await backoff(retries);
			continue;
		}
		// The hub failed the file itself (a chunk the host refused: `failed` or `interrupted`, which
		// it says in TRANSFER_PROGRESS), or kept refusing: nothing more is sent.
		if (answer.status === 409 || answer.status === 502) return { kind: "stopped" };
		return { kind: "failed", code: answer.code, message: answer.message, local: false };
	}
	return { kind: "sent", acked: offset };
}

/** Read a refusal's code, message and details from its body. */
async function refusalOf(response: Response): Promise<Exclude<ChunkAnswer, { ok: true }>> {
	try {
		const body = (await response.json()) as {
			error?: { code?: unknown; message?: unknown; acked?: unknown; state?: unknown };
		};
		const error = body.error ?? {};
		return {
			ok: false,
			status: response.status,
			code: typeof error.code === "string" ? error.code : `HTTP_${response.status}`,
			message:
				typeof error.message === "string" ? error.message : `The hub answered ${response.status}`,
			...(typeof error.acked === "number" ? { acked: error.acked } : {}),
			...(typeof error.state === "string" ? { state: error.state } : {}),
		};
	} catch {
		return {
			ok: false,
			status: response.status,
			code: `HTTP_${response.status}`,
			message: `The hub answered ${response.status}`,
		};
	}
}

/**
 * One chunk of a file of an upload, at `offset`, from this window: named by its socket's id, as
 * the hub takes bytes only from the window that started the upload.
 */
export async function putChunk(
	transferId: string,
	itemId: number,
	offset: number,
	chunk: Blob,
): Promise<ChunkAnswer> {
	const auth = useAuthStore();
	const url = `${hubBaseUrl()}/api/transfers/${encodeURIComponent(transferId)}/items/${itemId}?offset=${offset}`;
	let response: Response;
	try {
		response = await hubFetch(url, {
			method: "PUT",
			headers: {
				Authorization: `Bearer ${auth.token}`,
				"Content-Type": "application/octet-stream",
				...(auth.clientId !== null ? { "X-Lasterm-Client-Id": auth.clientId } : {}),
			},
			body: chunk,
		});
	} catch (error) {
		// Reading the chunk is part of the request: a file that changed fails here.
		if (
			error instanceof DOMException &&
			(error.name === "NotReadableError" || error.name === "NotFoundError")
		) {
			throw error;
		}
		return { ok: false, status: 0, code: "HUB_UNREACHABLE", message: hubUnreachable(error) };
	}
	if (!response.ok) return refusalOf(response);
	try {
		const body = (await response.json()) as { acked?: unknown };
		if (typeof body.acked === "number") return { ok: true, acked: body.acked };
	} catch {
		// Below.
	}
	return {
		ok: false,
		status: response.status,
		code: "BAD_ANSWER",
		message: "The hub's answer had no acked",
	};
}
