// Uploads to a terminal's host (#833, part of #721): the WebSocket messages
// that start, answer and follow them, what each file and folder of an upload
// can be, and the rules a whole tree's names are checked by before any byte
// moves. Shared because the hub enforces them and a client can check a drop
// against the same rules before it asks.
//
// The bytes do not travel here: they go over REST, one chunk at a time
// (`PUT /api/transfers/:id/items/:item?offset=`, PROTOCOL.md § 6), so that a
// terminal's output is never queued behind them on the window's socket.

import type { TransferOnConflict } from "./file-transfer.js";

// ─── Limits ──────────────────────────────────────────────────────────────────

/** The most files one upload holds; a client is asked to send an archive instead. */
export const TRANSFER_MAX_FILES = 100_000;

/** The most items, files and folders together, one upload holds. */
export const TRANSFER_MAX_ITEMS = 200_000;

/** The largest chunk one PUT carries, in bytes. */
export const TRANSFER_CHUNK_MAX_BYTES = 4 * 1024 * 1024;

/** The chunk size a client should send, every chunk but a file's last. */
export const TRANSFER_CHUNK_BYTES = 1024 * 1024;

/** The longest relative path an item may have, in characters. */
export const TRANSFER_MAX_REL_PATH_LENGTH = 4096;

/** The longest name a Windows host takes in one path, the terminating NUL left out (MAX_PATH). */
export const WINDOWS_MAX_PATH_LENGTH = 259;

/** The most bytes of one name, as POSIX file systems allow it (NAME_MAX). */
export const MAX_NAME_BYTES = 255;

// ─── Items ───────────────────────────────────────────────────────────────────

export type TransferItemKind = "file" | "dir";

/** One file or folder of an upload, as TRANSFER_START names it. */
export interface TransferStartItem {
	/** Its path under the destination, `/`-separated: `photos/2026/a.jpg`. */
	relPath: string;
	kind: TransferItemKind;
	/** Bytes; required for a file. */
	size?: number;
	/** Last modified, in milliseconds since the epoch, kept at the destination when given. */
	mtime?: number;
}

/**
 * What a file or a folder of an upload is at:
 * - `queued`: waiting its turn, or for its folder;
 * - `sending`: the hub takes its bytes, from `acked` on;
 * - `verifying`: every byte is there; the hub checks its size (and its
 *   SHA-256 over SSH commands) and places it;
 * - `placed`: under its name (`outcome` says how);
 * - `failed`: with its `reason`; Retry sends it again;
 * - `skipped`: left out, as a conflict's answer or `on_conflict` said;
 * - `conflict`: something has its name at the destination; it waits for an answer;
 * - `cancelled`: stopped, its temporary removed; Retry sends it again;
 * - `interrupted`: stopped by a window that left or a connection that ended,
 *   its temporary kept; Retry resumes it.
 */
export type TransferItemState =
	| "queued"
	| "sending"
	| "verifying"
	| "placed"
	| "failed"
	| "skipped"
	| "conflict"
	| "cancelled"
	| "interrupted";

export const TRANSFER_ITEM_STATES: readonly TransferItemState[] = [
	"queued",
	"sending",
	"verifying",
	"placed",
	"failed",
	"skipped",
	"conflict",
	"cancelled",
	"interrupted",
];

/** How a placed or skipped item ended up, so that a saved policy never acts unseen. */
export type TransferOutcome =
	| "placed"
	| "replaced"
	| "kept_both"
	| "skipped"
	/** A folder that was not there. */
	| "created"
	/** A folder that was there already, which the upload went into. */
	| "merged";

/**
 * How a placed file was checked: its size; its size and SHA-256 (over SSH
 * commands with `transfer_verify` on); its size alone where the host had no
 * tool to hash it with; or, over SSH commands with `transfer_verify` on, its
 * size alone because it resumed after a hub restart (#860): the hash the hub
 * kept of the bytes it had sent ended with that hub.
 */
export type TransferVerification = "size" | "sha256" | "no_hash_tool" | "size_resumed";

/**
 * What an upload as a whole is at (#860): `running` while a window sends it;
 * `interrupted` once that window left, its connection was closed or the hub
 * restarted, until it is resumed; `done` once nothing is left to send, answer
 * or place; `discarded` once Discard or the 7-day expiry dropped it, its
 * temporaries removed at once or at the next connection to its host.
 */
export type TransferUploadState = "running" | "interrupted" | "done" | "discarded";

/** Why an upload was not resumed: what reaching its host needed, and did not get. */
export type TransferNotResumedReason =
	/** A key's passphrase was asked for, and not given. */
	| "needs_passphrase"
	/** The account's password was asked for, and not given. */
	| "needs_password"
	/** The host's key was asked about, and not accepted. */
	| "host_key_not_accepted"
	/** The host could not be reached, for any other reason. */
	| "host_unreachable";

/** How long an interrupted upload nobody resumes is kept before it is discarded (#860). */
export const TRANSFER_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/** The most uploads one TRANSFER_RESUME or TRANSFER_DISCARD names. */
export const TRANSFER_MAX_IDS = 1000;

/** How a conflict is answered. A folder where a file goes, or the reverse, takes only `keep_both` or `skip`. */
export type TransferConflictAction = Exclude<TransferOnConflict, "ask">;

export const TRANSFER_CONFLICT_ACTIONS: readonly TransferConflictAction[] = [
	"replace",
	"keep_both",
	"skip",
];

/** What an answer applies to: one item (a folder: everything under it), or the whole upload. */
export type TransferScope = "upload" | number;

/** What is at an item's name at the destination. */
export interface TransferExisting {
	kind: "file" | "directory" | "symlink" | "other";
	size: number | null;
	/** ISO 8601, or null when the host does not say. */
	mtime: string | null;
}

// ─── UI → Hub ────────────────────────────────────────────────────────────────

/**
 * Start an upload of `items` into the folder `dir` of the host the terminal
 * `channelId` runs on. Refused with WRITE_LOCK_DENIED unless the window may
 * type into that terminal (it holds its write lock, or nobody does).
 */
export interface TransferStartMessage {
	type: "TRANSFER_START";
	/** The client's own id for this request, echoed by TRANSFER_ACCEPTED or TRANSFER_ERROR. */
	requestId: string;
	channelId: string;
	/** An absolute path on the host, as the files routes take it (PROTOCOL.md § 6, Host Files). */
	dir: string;
	/** Every folder an item is in is an item too; folders and files in any order. */
	items: TransferStartItem[];
	onConflict: TransferOnConflict;
}

/** Answer the conflicts under `scope`. */
export interface TransferResolveMessage {
	type: "TRANSFER_RESOLVE";
	transferId: string;
	scope: TransferScope;
	action: TransferConflictAction;
}

/** Send again the failed, cancelled and interrupted files under `scope`; a placed file never. */
export interface TransferRetryMessage {
	type: "TRANSFER_RETRY";
	transferId: string;
	scope: TransferScope;
}

/** Stop what is not placed under `scope`, and remove its temporaries. */
export interface TransferCancelMessage {
	type: "TRANSFER_CANCEL";
	transferId: string;
	scope: TransferScope;
}

/**
 * Resume interrupted uploads (#860), one or several ("Resume all"). The hub
 * reaches their hosts one at a time, asking this window what a connection
 * needs (a passphrase, a host key), and each file goes on from the bytes its
 * host acknowledged; a placed file is never sent again. This window sends
 * the bytes from then on.
 */
export interface TransferResumeMessage {
	type: "TRANSFER_RESUME";
	transferIds: string[];
	/**
	 * Files of those uploads the window found changed or gone since it sent their first bytes
	 * (#837): each left out, or sent again from its first byte as it is now. A file not named
	 * goes on from what its host acknowledged.
	 */
	files?: TransferResumeFile[];
}

/** Why a resume leaves a file out: what the window found of it. */
export type TransferResumeSkip =
	/** It is no longer where it was. */
	| "gone"
	/** It changed since its first bytes were sent, and its user chose to leave it out. */
	| "changed"
	/** It could not be read. */
	| "unreadable";

export const TRANSFER_RESUME_SKIPS: readonly TransferResumeSkip[] = [
	"gone",
	"changed",
	"unreadable",
];

/** One file a resume leaves out (`skip`), or sends again from its first byte (`restart`). */
export type TransferResumeFile =
	| { transferId: string; itemId: number; action: "skip"; why: TransferResumeSkip }
	| {
			transferId: string;
			itemId: number;
			action: "restart";
			/** Its size now, in bytes. */
			size: number;
			/** Its last modification now, in milliseconds since the epoch. */
			mtime?: number;
	  };

/**
 * Drop uploads (#860): their temporaries removed, at once or at the next
 * connection to their host, and their records deleted. Placed files stay.
 */
export interface TransferDiscardMessage {
	type: "TRANSFER_DISCARD";
	transferIds: string[];
}

// ─── Hub → UI ────────────────────────────────────────────────────────────────

/** One item as TRANSFER_ACCEPTED lists it, in the order TRANSFER_START gave. */
export interface TransferAcceptedItem {
	itemId: number;
	state: TransferItemState;
	/** What has its name at the destination, for an item in `conflict`. */
	existing?: TransferExisting;
	/** A folder where a file goes, or the reverse: only `keep_both` or `skip` answer it. */
	typeClash?: true;
}

/** How many files under a folder would conflict, of how many: "7 of 120". */
export interface TransferFolderConflicts {
	itemId: number;
	conflicting: number;
	total: number;
}

/** Hub → the window that asked: the upload is under way. */
export interface TransferAcceptedMessage {
	type: "TRANSFER_ACCEPTED";
	requestId: string;
	transferId: string;
	channelId: string;
	hostId: string;
	/** The destination, normalised for the host. */
	dir: string;
	/** True when the start joined an upload of the same tree a window left (§ 4.19). */
	joined: boolean;
	items: TransferAcceptedItem[];
	folderConflicts: TransferFolderConflicts[];
}

/** One item that changed, in TRANSFER_PROGRESS. */
export interface TransferItemProgress {
	itemId: number;
	state: TransferItemState;
	/** Bytes of a file the host acknowledged: the contiguous prefix it holds. */
	acked?: number;
	outcome?: TransferOutcome;
	/** The name it was placed under, when `kept_both` gave it another. */
	finalName?: string;
	verification?: TransferVerification;
	/** Why it failed or was interrupted, for the client to show. */
	reason?: string;
	/** The code of that failure, when it has one. */
	code?: string;
}

/** Counts by state, and bytes, of the files under a folder or of a whole upload. */
export interface TransferTotals {
	files: number;
	bytes: number;
	acked: number;
	states: Partial<Record<TransferItemState, number>>;
}

/** A folder whose files' totals changed. */
export interface TransferFolderProgress extends TransferTotals {
	itemId: number;
}

/** Hub → every client attached to the terminal, readers included: what changed. */
export interface TransferProgressMessage {
	type: "TRANSFER_PROGRESS";
	transferId: string;
	channelId: string;
	items: TransferItemProgress[];
	folders: TransferFolderProgress[];
	totals: TransferTotals;
}

/** One item that found something under its name. */
export interface TransferConflictItem {
	itemId: number;
	existing: TransferExisting | null;
	typeClash?: true;
	/** Found at placement, after the start had looked: the file appeared meanwhile. */
	late?: true;
}

/** Hub → every client attached: items now waiting for an answer. */
export interface TransferConflictMessage {
	type: "TRANSFER_CONFLICT";
	transferId: string;
	channelId: string;
	items: TransferConflictItem[];
}

/** Hub → every client attached: nothing of the upload is left to send or answer. */
export interface TransferDoneMessage {
	type: "TRANSFER_DONE";
	transferId: string;
	channelId: string;
	totals: TransferTotals;
}

/**
 * Hub → every client attached, the window sending it and the window that
 * asked: an upload's own state changed (#860).
 */
export interface TransferStateMessage {
	type: "TRANSFER_STATE";
	transferId: string;
	channelId: string;
	hostId: string;
	state: TransferUploadState;
	/** While `interrupted`, after a resume that could not reach the host: why. */
	reason?: TransferNotResumedReason;
}

/** An interrupted upload, as STATE_SYNC lists it to every window (#860). */
export interface TransferSyncEntry {
	transferId: string;
	channelId: string;
	hostId: string;
	/** The destination, normalised for the host. */
	dir: string;
	state: "interrupted";
	reason?: TransferNotResumedReason;
	totals: TransferTotals;
	/** ISO 8601: when it last changed. It is discarded `TRANSFER_EXPIRY_MS` after. */
	updatedAt: string;
	/**
	 * The window it is listed to is of the device that started it (#837): only such a window
	 * holds its files, and may resume it.
	 */
	fromThisDevice: boolean;
	/** Otherwise, that device's name as the hub's credentials list it, when it has one. */
	deviceLabel?: string;
}

/** One name a Windows host would refuse, or a tree that cannot be sent as given. */
export interface TransferNameProblem {
	relPath: string;
	reason: string;
}

/**
 * Hub → the window that asked: a start, an answer or a retry refused, with
 * `requestId` or `transferId` to say which. Nothing it refused has moved.
 */
export interface TransferErrorMessage {
	type: "TRANSFER_ERROR";
	requestId?: string;
	transferId?: string;
	code: string;
	message: string;
	/** For `INVALID_NAMES` and `INVALID_ITEMS`: every path refused, and why. */
	names?: TransferNameProblem[];
}

// ─── Names ───────────────────────────────────────────────────────────────────

/** `CON`, `NUL.txt`, `com1.tar.gz`: a device whatever follows its first dot. */
const WINDOWS_RESERVED = /^(?:CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³]|CONIN\$|CONOUT\$)(?:\..*)?$/i;

/** What no Windows name holds: these, `/` and `\`, and the control characters. */
const WINDOWS_FORBIDDEN_CHARACTERS = /[<>:"/\\|?*\p{Cc}]/u;

/** Why a Windows host would refuse `name` as a file or folder name, or null. */
export function windowsNameProblem(name: string): string | null {
	if (WINDOWS_FORBIDDEN_CHARACTERS.test(name)) {
		return 'a Windows name holds none of < > : " / \\ | ? * nor a control character';
	}
	if (/[. ]$/.test(name)) return "a Windows name does not end with a dot or a space";
	if (WINDOWS_RESERVED.test(name)) {
		return "the name is a device's on Windows (CON, PRN, AUX, NUL, COM1–9, LPT1–9), whatever its extension";
	}
	return null;
}

/** Why `relPath` cannot name an item at all, on any host, or null. */
export function relPathProblem(relPath: string): string | null {
	if (relPath === "") return "the path is empty";
	if (relPath.length > TRANSFER_MAX_REL_PATH_LENGTH) {
		return `the path is over ${TRANSFER_MAX_REL_PATH_LENGTH} characters`;
	}
	if (relPath.includes("\0")) return "the path holds a NUL character";
	if (relPath.startsWith("/")) return "the path is not relative";
	const segments = relPath.split("/");
	if (segments.some((segment) => segment === "")) return "the path has an empty name in it";
	if (segments.some((segment) => segment === "." || segment === "..")) {
		return "the path has a . or .. in it";
	}
	if (segments.some((segment) => new TextEncoder().encode(segment).length > MAX_NAME_BYTES)) {
		return `a name in the path is over ${MAX_NAME_BYTES} bytes`;
	}
	return null;
}
