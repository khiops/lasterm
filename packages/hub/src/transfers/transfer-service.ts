import { createHash, type Hash } from "node:crypto";
import {
	generateId,
	isValidUlid,
	TRANSFER_CONFLICT_ACTIONS,
	TRANSFER_EXPIRY_MS,
	TRANSFER_ITEM_STATES,
	TRANSFER_MAX_FILES,
	TRANSFER_MAX_IDS,
	TRANSFER_ON_CONFLICT_VALUES,
	TRANSFER_RESUME_SKIPS,
	type TransferAcceptedItem,
	type TransferCancelMessage,
	type TransferConflictAction,
	type TransferConflictItem,
	type TransferDiscardMessage,
	type TransferErrorMessage,
	type TransferExisting,
	type TransferFolderConflicts,
	type TransferFolderProgress,
	type TransferItemProgress,
	type TransferItemState,
	type TransferNotResumedReason,
	type TransferOnConflict,
	type TransferOutcome,
	type TransferResolveMessage,
	type TransferResumeFile,
	type TransferResumeMessage,
	type TransferResumeSkip,
	type TransferRetryMessage,
	type TransferScope,
	type TransferStartMessage,
	type TransferStateMessage,
	type TransferSyncEntry,
	type TransferTotals,
	type TransferUploadState,
	type TransferVerification,
} from "@lasterm/shared";
import { FileAccessError, type FileEntry, mapLimited } from "../files/host-files.js";
import { ChannelNotFound } from "../files/host-files-service.js";
import { joinHostPath, normaliseHostPath, type PathStyle } from "../files/host-paths.js";
import {
	isFolderLike,
	isInterruption,
	keepBothName,
	TargetExists,
	tempPathFor,
	type UploadBackend,
	type UploadSink,
	VerifyFailed,
} from "../files/upload-backend.js";
import type { TransferItemRecord, TransferRecord, TransfersDAL } from "../storage/transfers-dal.js";
import { buildUploadTree, isWholeNumber, type TreeItem } from "./upload-tree.js";

/**
 * How long the changes of an upload gather before they are said in one
 * TRANSFER_PROGRESS, unless a file started sending (`settle`).
 */
const PROGRESS_FLUSH_MS = 100;

/**
 * How many more bytes of a file its host may acknowledge before they are
 * written to meta.db (#860); `ACKED_PERSIST_MS` writes what is left of them.
 */
export const ACKED_PERSIST_BYTES = 8 * 1024 * 1024;

/** How long a file's acknowledged bytes may wait to be written to meta.db, at most. */
export const ACKED_PERSIST_MS = 2_000;

/** How often the uploads nobody resumes are looked at for their expiry. */
const EXPIRY_CHECK_MS = 60 * 60_000;

/**
 * How old a temporary that no record knows must be before the sweep removes
 * it: one younger may be another hub's, still being written.
 */
export const SWEEP_MIN_AGE_MS = 60 * 60_000;

/** A temporary of this hub's naming, as `tempPathFor` names one: `.name.<16 hex>.partial`. */
const TEMP_NAME = /^\..+\.[0-9a-f]{16}\.partial$/;

/** How many requests at once the hub makes of a host for work of its own: stats, truncations, removals. */
const HOST_WORK_CONCURRENCY = 8;

/** How long an upload whose every file was placed or skipped is remembered, for a client that asks. */
const FINISHED_KEPT_MS = 10 * 60_000;

/** How many folders are listed at once to find what an upload's names already hold. */
const LISTING_CONCURRENCY = 8;

/** How many folders one request creates. */
const FOLDER_BATCH = 500;

/** The most copies Keep both looks for a free name among. */
const KEEP_BOTH_TRIES = 10_000;

/** States in which a file is not settled: something is still to be sent, answered or placed. */
const UNSETTLED: ReadonlySet<TransferItemState> = new Set([
	"queued",
	"sending",
	"verifying",
	"conflict",
	"interrupted",
]);

/** A refusal of a transfer request, for its route or its socket to say. */
export class TransferRequestError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly details: Record<string, unknown> = {},
	) {
		super(message);
		this.name = "TransferRequestError";
	}
}

/** What came of reaching a host for an upload: connected, or why not. */
export type TransferConnectOutcome =
	| { readonly connected: true }
	| { readonly connected: false; readonly reason: TransferNotResumedReason };

/** What the transfer service needs of the rest of the hub. */
export interface TransferDeps {
	readonly files: {
		channelHost(channelId: string): { hostId: string; hostType: string };
		uploadBackend(hostId: string, hostType: string): Promise<UploadBackend>;
	};
	/** Whether a window may type into this terminal: it holds its write lock, or nobody does. */
	mayWrite(channelId: string, clientId: string): boolean;
	/** Whether the terminal has ended, or is gone: an upload from it is then the device's that started it. */
	channelEnded(channelId: string): boolean;
	/** The clients attached to a terminal, readers included. */
	clientsOf(channelId: string): readonly string[];
	send(clientId: string, message: unknown): void;
	/** Whether the host's agent is connected to this hub, for a remote host. */
	isConnected(hostId: string, hostType: string): boolean;
	/**
	 * Connect a remote host, asking `clientId` what it must (a passphrase, a
	 * host key), as a Connect does; connected, or why not.
	 */
	connect(hostId: string, clientId: string): Promise<TransferConnectOutcome>;
	/** Whether uploads to this host are checked by SHA-256 over SSH commands (`transfer_verify`). */
	verifyFor(hostId: string, channelId: string): boolean;
	/** How many files one window sends at once (`[transfer] max_concurrent`). */
	maxConcurrent(): number;
	/** A host's last running upload ended: what waited for it (a retirement, #805) may go on. */
	onHostIdle(hostId: string): void;
	/** meta.db's uploads (#860): without it they live in memory only, and a restart forgets them. */
	readonly store?: TransfersDAL | null;
	/** The type of a host the hub knows (`local`, `ssh`); null for one it no longer does. */
	hostType?(hostId: string): string | null;
	/**
	 * `[experimental] file_transfer`, read each time: what the service does of
	 * itself on a host (removing what Discard and the expiry left, resuming
	 * after a dropped link) waits behind it, as every request does. On by default.
	 */
	enabled?(): boolean;
	/** The time, in milliseconds since the epoch; `Date.now` by default. */
	now?(): number;
	/**
	 * A paired device's name, as the hub's credentials list it (`auth_tokens.label`), for the
	 * windows of another device to say where an upload can be resumed from (#837).
	 */
	deviceLabel?(tokenId: string): string | null;
}

/** An upload dropped whose temporaries wait for their host to be reached, by their recorded paths. */
interface PendingRemoval {
	readonly id: string;
	readonly hostId: string;
	readonly hostType: string;
	readonly dir: string;
	readonly style: PathStyle;
	readonly temps: readonly string[];
}

/** Who asks: a window, by its client id and the token it authenticated with. */
export interface TransferRequester {
	readonly clientId: string;
	readonly tokenId: string | null;
}

interface Item extends TreeItem {
	state: TransferItemState;
	/** What had its name at the destination, when it was found. */
	existing: FileEntry | null;
	typeClash: boolean;
	late: boolean;
	resolution: TransferConflictAction | null;
	/** The name it is placed under, when Keep both gave it another. */
	finalName: string | null;
	/** Where it is on the host once placed: a folder's is where what is in it goes. */
	path: string | null;
	outcome: TransferOutcome | null;
	verification: TransferVerification | null;
	acked: number;
	/** Its temporary on the host, while it is not placed. */
	temp: string | null;
	/** Every byte is in the temporary, checked: only placing it is left. */
	tempWhole: boolean;
	/** Written under its own name directly (a server whose rename replaces). */
	direct: boolean;
	hash: Hash | null;
	sink: UploadSink | null;
	opening: Promise<void> | null;
	writing: boolean;
	reason: string | null;
	code: string | null;
	/**
	 * Its temporary holds bytes an earlier run of the hub sent (#860): no
	 * running hash covers them, and it is cut to `acked` before it resumes.
	 */
	carried: boolean;
	/** The `acked` meta.db holds for it. */
	persistedAcked: number;
}

interface Totals {
	files: number;
	bytes: number;
	acked: number;
	states: Map<TransferItemState, number>;
}

interface Upload {
	readonly id: string;
	readonly channelId: string;
	readonly hostId: string;
	readonly hostType: string;
	readonly dir: string;
	readonly style: PathStyle;
	readonly onConflict: TransferOnConflict;
	readonly verify: boolean;
	/** The device that started it: an ended terminal's upload is its alone. */
	readonly tokenId: string | null;
	readonly signature: string;
	readonly items: Item[];
	readonly order: number[];
	/** Per folder (by id), and for the whole upload: its files' counts and bytes. */
	readonly folderTotals: Map<number, Totals>;
	readonly totals: Totals;
	/** The folders by state, as `totals` counts the files: what is left is read from both. */
	readonly folderStates: Map<TransferItemState, number>;
	/** The window that holds the bytes; null once it has left. */
	source: string | null;
	backend: UploadBackend | null;
	/** Files queued, in the order they go; settled ones are skipped when reached. */
	queue: number[];
	/** Folders to create, their folder being in place. */
	folderQueue: number[];
	creatingFolders: boolean;
	/** Files and folders waiting for their folder to be in place, by its id. */
	waiting: Map<number, number[]>;
	dirtyItems: Set<number>;
	dirtyFolders: Set<number>;
	conflicts: TransferConflictItem[];
	flushTimer: ReturnType<typeof setTimeout> | null;
	/** A flush once the work at hand is done: a file started sending (#873). */
	flushSoon: ReturnType<typeof setImmediate> | null;
	doneSaid: boolean;
	forgetTimer: ReturnType<typeof setTimeout> | null;
	/** Placements and other host work under way that no state shows. */
	busy: number;
	/** When it started, ISO 8601. */
	readonly createdAt: string;
	/** When its own state or reason last changed, in ms: its expiry counts from there. */
	changedAt: number;
	/** Why the last resume did not reach its host; null once one did (#860). */
	reason: TransferNotResumedReason | null;
	/** Its link to the host dropped while a window sent it: the hub's reconnect resumes it. */
	linkDropped: boolean;
	/** Brought back from meta.db and not yet resumed: its queues are built when it is (#860). */
	stale: boolean;
	/** Whether meta.db has its rows. */
	stored: boolean;
	/** Its state and reason as meta.db last had them. */
	recorded: { state: TransferUploadState; reason: string | null } | null;
	/** Its state and reason as TRANSFER_STATE last said them. */
	said: { state: TransferUploadState; reason: string | null } | null;
}

function emptyTotals(): Totals {
	return { files: 0, bytes: 0, acked: 0, states: new Map() };
}

function totalsOnWire(totals: Totals): TransferTotals {
	return {
		files: totals.files,
		bytes: totals.bytes,
		acked: totals.acked,
		states: Object.fromEntries(totals.states),
	};
}

function existingOnWire(entry: FileEntry | null): TransferExisting | null {
	if (entry === null) return null;
	return { kind: entry.kind, size: entry.size, mtime: entry.mtime };
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function codeOf(error: unknown): string {
	if (error instanceof FileAccessError || error instanceof VerifyFailed) return error.code;
	if (isInterruption(error)) return "INTERRUPTED";
	return "TRANSFER_FAILED";
}

/** Whether two states with their reasons are the same. */
function sameState(
	a: { state: TransferUploadState; reason: string | null } | null,
	b: { state: TransferUploadState; reason: string | null },
): boolean {
	return a !== null && a.state === b.state && a.reason === b.reason;
}

const NOT_RESUMED_REASONS: ReadonlySet<string> = new Set<TransferNotResumedReason>([
	"needs_passphrase",
	"needs_password",
	"host_key_not_accepted",
	"host_unreachable",
]);

/** What a file a resume leaves out says of itself, by what its window found of it (#837). */
const SKIPPED_REASONS: Readonly<Record<TransferResumeSkip, string>> = {
	gone: "no longer on the device that sent it",
	changed: "changed since it was sent",
	unreadable: "could not be read on the device that sent it",
};

/**
 * The files a TRANSFER_RESUME names to leave out or to send again from their
 * first byte, by upload; none when it names none, and null when they are not
 * as PROTOCOL.md § 4.19 says.
 */
function resumeFilesOf(value: unknown): Map<string, TransferResumeFile[]> | null {
	const byUpload = new Map<string, TransferResumeFile[]>();
	if (value === undefined || value === null) return byUpload;
	if (!Array.isArray(value) || value.length > TRANSFER_MAX_FILES) return null;
	for (const raw of value) {
		if (typeof raw !== "object" || raw === null) return null;
		const entry = raw as Record<string, unknown>;
		const { transferId, itemId } = entry;
		if (typeof transferId !== "string" || !isWholeNumber(itemId)) return null;
		let file: TransferResumeFile;
		if (entry.action === "skip") {
			const why = entry.why;
			if (!(TRANSFER_RESUME_SKIPS as readonly unknown[]).includes(why)) return null;
			file = { transferId, itemId, action: "skip", why: why as TransferResumeSkip };
		} else if (entry.action === "restart") {
			const { size, mtime } = entry;
			if (!isWholeNumber(size)) return null;
			if (mtime !== undefined && mtime !== null && !isWholeNumber(mtime)) return null;
			file = {
				transferId,
				itemId,
				action: "restart",
				size,
				...(isWholeNumber(mtime) ? { mtime } : {}),
			};
		} else {
			return null;
		}
		const list = byUpload.get(transferId) ?? [];
		list.push(file);
		byUpload.set(transferId, list);
	}
	return byUpload;
}

/** What a file of an upload brought back from meta.db is at: one that was moving is interrupted. */
function revivedState(state: string): TransferItemState {
	if (state === "sending" || state === "verifying") return "interrupted";
	return (TRANSFER_ITEM_STATES as readonly string[]).includes(state)
		? (state as TransferItemState)
		: "interrupted";
}

/** What had an item's name, as meta.db keeps it. */
function existingOf(json: string | null, name: string): FileEntry | null {
	if (json === null) return null;
	try {
		const parsed = JSON.parse(json) as Partial<FileEntry>;
		return {
			name,
			kind: parsed.kind ?? "other",
			size: typeof parsed.size === "number" ? parsed.size : null,
			mtime: typeof parsed.mtime === "string" ? parsed.mtime : null,
			...(parsed.linkKind !== undefined ? { linkKind: parsed.linkKind } : {}),
		};
	} catch {
		return null;
	}
}

/**
 * Uploads to the host a terminal runs on (#833): what they hold, what each of
 * their files and folders is at, and the work that moves them on. Bound to a
 * host and a folder from their start, they outlive the terminal they started
 * from.
 *
 * The bytes come over REST, chunk by chunk (`receive`), from the window that
 * started the upload; everything else over its WebSocket. A file's chunk is
 * written to the host before it is answered, so the client goes at the
 * host's pace, and at most `max_concurrent` files of a window are sent at
 * once. Every change is said to every client attached to the terminal,
 * readers included.
 *
 * Kept in meta.db when the hub gives it one (#860): a state change is written
 * at once, a file's acknowledged bytes at most every `ACKED_PERSIST_MS` or
 * `ACKED_PERSIST_BYTES`, and everything when the hub stops. After a restart
 * (`restore`) every upload that was moving is `interrupted`, and only a
 * window's TRANSFER_RESUME takes it up again: nothing reaches a remote host
 * by itself. Discard and the 7-day expiry remove what an upload left on its
 * host, at once or at the host's next connection; the start of an upload
 * sweeps the folders it lists of temporaries no record knows, older than an
 * hour.
 *
 * Nothing here logs: a path or a name is the user's.
 */
export class TransferService {
	private readonly uploads = new Map<string, Upload>();
	/** Starts being prepared, by host: they hold its connection as uploads do. */
	private readonly starting = new Map<string, number>();
	/** Remote hosts with an upload running or queued, as last seen: told once when that ends. */
	private readonly activeHosts = new Set<string>();
	private pumpScheduled = false;
	private stopped = false;
	/** Uploads with changes to write to meta.db at once: their ids, and the items that changed. */
	private readonly unsaved = new Map<string, Set<number>>();
	/** Files whose acknowledged bytes wait for the next timed write, by upload. */
	private readonly unsavedAcks = new Map<string, Set<number>>();
	private saveScheduled = false;
	private ackTimer: ReturnType<typeof setTimeout> | null = null;
	private expiryTimer: ReturnType<typeof setInterval> | null = null;
	/** Uploads dropped whose temporaries wait for their host, by id (#860). */
	private readonly pendingRemoval = new Map<string, PendingRemoval>();
	/** The work under way on a host for its connection, by host: one at a time. */
	private readonly hostWork = new Map<string, Promise<void>>();

	constructor(private readonly deps: TransferDeps) {}

	private get store(): TransfersDAL | null {
		return this.deps.store ?? null;
	}

	private now(): number {
		return this.deps.now?.() ?? Date.now();
	}

	private isEnabled(): boolean {
		return this.deps.enabled?.() ?? true;
	}

	// ─── Holding a host's connection ────────────────────────────────────────

	/**
	 * How many uploads to this host are running or queued, a start being
	 * prepared included: what a gesture closing its connection would stop, and
	 * what an agent's retirement waits for.
	 */
	activeOn(hostId: string): number {
		let active = this.starting.get(hostId) ?? 0;
		for (const upload of this.uploads.values()) {
			if (upload.hostId === hostId && this.isActive(upload)) active++;
		}
		return active;
	}

	/** Deletion also waits for running uploads whose only remaining work is a conflict (#910). */
	blockingHostDeletionOn(hostId: string): number {
		let blocking = this.starting.get(hostId) ?? 0;
		for (const upload of this.uploads.values()) {
			if (
				upload.hostId === hostId &&
				(this.isActive(upload) || this.uploadState(upload) === "running")
			) {
				blocking++;
			}
		}
		return blocking;
	}

	/**
	 * The connection to this host is being closed on purpose, forced past the
	 * question (`transfers-would-stop`): its uploads stop, interrupted, their
	 * temporaries kept for a retry to resume.
	 */
	interruptOn(hostId: string): void {
		for (const upload of this.uploads.values()) {
			if (upload.hostId !== hostId) continue;
			for (const item of upload.items) {
				if (item.state === "queued" || item.state === "sending" || item.state === "verifying") {
					this.interrupt(upload, item, "The connection to the host was closed");
				}
			}
			this.releaseBackend(upload);
			this.settle(upload);
		}
	}

	// ─── From the window ─────────────────────────────────────────────────────

	/** TRANSFER_START: check the tree, look at the destination, and begin. Never rejects. */
	async start(requester: TransferRequester, msg: TransferStartMessage): Promise<void> {
		const requestId = typeof msg.requestId === "string" ? msg.requestId.slice(0, 128) : "";
		const refuse = (code: string, message: string, extra: Partial<TransferErrorMessage> = {}) => {
			this.deps.send(requester.clientId, {
				type: "TRANSFER_ERROR",
				requestId,
				code,
				message,
				...extra,
			} satisfies TransferErrorMessage);
		};
		if (!isValidUlid(msg.channelId)) return refuse("INVALID_INPUT", "Invalid channelId");
		if (typeof msg.dir !== "string" || msg.dir === "" || msg.dir.length > 4096) {
			return refuse("INVALID_INPUT", "dir must be an absolute path of at most 4096 characters");
		}
		if (!(TRANSFER_ON_CONFLICT_VALUES as readonly unknown[]).includes(msg.onConflict)) {
			return refuse("INVALID_INPUT", 'on_conflict must be "ask", "replace", "keep_both" or "skip"');
		}
		if (!this.deps.mayWrite(msg.channelId, requester.clientId)) {
			return refuse(
				"WRITE_LOCK_DENIED",
				"This window does not hold the write lock for this terminal",
			);
		}
		let channel: { hostId: string; hostType: string };
		try {
			channel = this.deps.files.channelHost(msg.channelId);
		} catch (error) {
			if (error instanceof ChannelNotFound) return refuse("CHANNEL_NOT_FOUND", "Channel not found");
			throw error;
		}
		const { hostId, hostType } = channel;
		this.starting.set(hostId, (this.starting.get(hostId) ?? 0) + 1);
		let backend: UploadBackend | null = null;
		let adopted = false;
		try {
			if (!this.deps.isConnected(hostId, hostType)) {
				const reached = await this.deps.connect(hostId, requester.clientId);
				if (!reached.connected) {
					return refuse("HOST_NOT_CONNECTED", "This terminal's host could not be connected");
				}
			}
			backend = await this.deps.files.uploadBackend(hostId, hostType);
			const normalised = normaliseHostPath(msg.dir, backend.style);
			if (!normalised.ok) return refuse("UNSUPPORTED_PATH", normalised.reason);
			const dir = normalised.path;
			const target = await backend.stat(dir);
			if (!isFolderLike(target))
				return refuse("NOT_A_DIRECTORY", "The destination is not a folder");

			const tree = buildUploadTree(msg.items, backend.style, dir);
			if (!tree.ok) {
				return refuse(tree.code, tree.message, tree.names ? { names: tree.names } : {});
			}

			const kept = this.joinable(hostId, dir, tree.signature);
			if (kept !== null) {
				backend.release();
				backend = null;
				this.join(kept, requester, msg, requestId);
				return;
			}

			const space = await backend.freeSpace(dir).catch(() => null);
			if (space?.available != null && space.available < tree.bytes) {
				return refuse(
					"INSUFFICIENT_SPACE",
					`The upload is ${tree.bytes} bytes and the host has ${space.available} free there`,
				);
			}

			const upload = this.create(requester, msg, hostId, hostType, dir, backend, tree);
			const listed = await this.lookAtDestination(upload);
			// What a hub that died before writing its record left there (#860).
			for (const folder of listed) await this.sweep(backend, folder.path, folder.entries);
			this.applyPolicy(upload);
			this.uploads.set(upload.id, upload);
			this.record(upload);
			adopted = true;
			this.deps.send(requester.clientId, this.accepted(upload, requestId, false, null));
			this.markAll(upload);
			this.enqueueReady(upload, null);
			this.settle(upload);
			this.schedulePump();
		} catch (error) {
			if (error instanceof FileAccessError) return refuse(error.code, error.message);
			refuse("TRANSFER_FAILED", `The upload could not start: ${messageOf(error)}`);
		} finally {
			if (!adopted) backend?.release();
			const left = (this.starting.get(hostId) ?? 1) - 1;
			if (left > 0) this.starting.set(hostId, left);
			else this.starting.delete(hostId);
			this.noteHost(hostId, hostType);
		}
	}

	/** TRANSFER_RESOLVE: answer the conflicts under a scope. */
	resolve(requester: TransferRequester, msg: TransferResolveMessage): void {
		const upload = this.controlled(requester, msg);
		if (upload === null) return;
		if (!(TRANSFER_CONFLICT_ACTIONS as readonly unknown[]).includes(msg.action)) {
			this.refuseControl(
				requester,
				msg.transferId,
				"INVALID_INPUT",
				"action must be replace, keep_both or skip",
			);
			return;
		}
		const scoped = this.scoped(upload, msg.scope);
		if (scoped === null) {
			this.refuseControl(requester, msg.transferId, "ITEM_NOT_FOUND", "No item has that id");
			return;
		}
		if (msg.action === "replace" && typeof msg.scope === "number") {
			const item = upload.items[msg.scope];
			if (item?.state === "conflict" && item.typeClash) {
				this.refuseControl(
					requester,
					msg.transferId,
					"INVALID_ACTION",
					"A folder where a file goes, or a file where a folder goes, is only kept both or skipped",
				);
				return;
			}
		}
		for (const item of scoped) {
			if (item.state !== "conflict") continue;
			// Replace does not apply to a type clash: it keeps waiting.
			if (msg.action === "replace" && item.typeClash) continue;
			if (msg.action === "skip") {
				this.skip(upload, item);
				continue;
			}
			item.resolution = msg.action;
			if (item.kind === "file" && item.tempWhole) {
				void this.place(upload, item);
			} else {
				this.setState(upload, item, "queued");
				this.enqueue(upload, item);
			}
		}
		this.settle(upload);
		this.schedulePump();
	}

	/** TRANSFER_RETRY: send again what failed, was cancelled or interrupted under a scope. */
	async retry(requester: TransferRequester, msg: TransferRetryMessage): Promise<void> {
		const upload = this.controlled(requester, msg);
		if (upload === null) return;
		const scoped = this.scoped(upload, msg.scope);
		if (scoped === null)
			return this.refuseControl(requester, msg.transferId, "ITEM_NOT_FOUND", "No item has that id");
		const again = scoped.filter(
			(item) =>
				item.state === "failed" || item.state === "cancelled" || item.state === "interrupted",
		);
		if (again.length === 0) return;
		if (!this.deps.isConnected(upload.hostId, upload.hostType)) {
			const reached = await this.deps.connect(upload.hostId, requester.clientId);
			if (!reached.connected) {
				return this.refuseControl(
					requester,
					msg.transferId,
					"HOST_NOT_CONNECTED",
					"This upload's host could not be connected",
				);
			}
		}
		this.requeueAll(upload, again);
		this.settle(upload);
		this.schedulePump();
	}

	/**
	 * Queue again what failed, was cancelled or interrupted among `again`, and
	 * first the folders they are in that need it: a file goes into a folder in
	 * place. An upload brought back from meta.db gets its queues here.
	 */
	private requeueAll(upload: Upload, again: readonly Item[]): void {
		const requeued = new Set<number>();
		for (const item of again) {
			for (
				let parent = item.parent;
				parent !== null;
				parent = upload.items[parent]?.parent ?? null
			) {
				const folder = upload.items[parent];
				if (folder === undefined || requeued.has(parent)) break;
				if (
					folder.state === "failed" ||
					folder.state === "cancelled" ||
					folder.state === "interrupted"
				) {
					requeued.add(parent);
					this.requeue(upload, folder);
				}
			}
			if (!requeued.has(item.id)) {
				requeued.add(item.id);
				this.requeue(upload, item);
			}
		}
		if (upload.stale) {
			// Nothing of it was queued: everything queued is, now, in its order.
			upload.stale = false;
			upload.queue = [];
			upload.folderQueue = [];
			upload.waiting.clear();
			this.enqueueReady(upload, null);
		}
		upload.doneSaid = false;
		this.clearForget(upload);
	}

	/** TRANSFER_CANCEL: stop what is not placed under a scope, and remove its temporaries. */
	cancel(requester: TransferRequester, msg: TransferCancelMessage): void {
		const upload = this.controlled(requester, msg);
		if (upload === null) return;
		const scoped = this.scoped(upload, msg.scope);
		if (scoped === null) {
			this.refuseControl(requester, msg.transferId, "ITEM_NOT_FOUND", "No item has that id");
			return;
		}
		for (const item of scoped) {
			if (
				item.state === "queued" ||
				item.state === "sending" ||
				item.state === "conflict" ||
				item.state === "interrupted"
			) {
				this.stopItem(upload, item, "cancelled");
			}
		}
		this.settle(upload);
		this.schedulePump();
	}

	/** A window left: what it was sending stops, interrupted, and nothing more of it is sent. */
	clientGone(clientId: string): void {
		for (const upload of this.uploads.values()) {
			if (upload.source !== clientId) continue;
			upload.source = null;
			for (const item of upload.items) {
				if (item.state === "sending") this.interrupt(upload, item, "The window sending it left");
			}
			this.settle(upload);
		}
		this.schedulePump();
	}

	/** A terminal's write lock changed hands: queued files may go, or wait. */
	lockChanged(channelId: string): void {
		for (const upload of this.uploads.values()) {
			if (upload.channelId === channelId) {
				this.schedulePump();
				return;
			}
		}
	}

	// ─── Resuming and discarding (#860) ──────────────────────────────────────

	/**
	 * TRANSFER_RESUME: take up the uploads named, this window sending their
	 * bytes. Their hosts are reached one at a time, in the order named, each
	 * through the interactive Connect, so that the window is asked one
	 * question at a time; a host whose question is cancelled, or that cannot
	 * be reached, leaves its uploads interrupted with the reason, and the next
	 * host goes on. The files the window found gone or changed (`files`) are
	 * left out, or sent again from their first byte as they are now. Never
	 * rejects.
	 */
	async resume(requester: TransferRequester, msg: TransferResumeMessage): Promise<void> {
		const files = resumeFilesOf(msg.files);
		if (files === null) {
			this.refuseControl(
				requester,
				"",
				"INVALID_INPUT",
				`files must list at most ${TRANSFER_MAX_FILES} files, each to skip with why, or to restart with its size`,
			);
			return;
		}
		const uploads = this.named(requester, msg.transferIds, true);
		for (const [hostId, group] of this.byHost(uploads)) {
			const hostType = (group[0] as Upload).hostType;
			this.hold(hostId);
			try {
				if (!this.deps.isConnected(hostId, hostType)) {
					const reached = await this.deps.connect(hostId, requester.clientId);
					if (!reached.connected) {
						for (const upload of group) this.notResumed(upload, reached.reason, requester);
						continue;
					}
				}
				await this.atConnection(hostId, hostType);
				for (const upload of group) {
					if (this.uploads.get(upload.id) === upload) {
						await this.takeUp(upload, requester, files.get(upload.id) ?? []);
					}
				}
			} finally {
				this.letGo(hostId, hostType);
			}
		}
	}

	/**
	 * TRANSFER_DISCARD: drop the uploads named. What they were doing stops,
	 * their records go, and their temporaries are removed by their recorded
	 * paths: at once, the host being reached as for a resume, or, for a host
	 * that cannot be, at its next connection. Placed files stay. Never rejects.
	 */
	async discard(requester: TransferRequester, msg: TransferDiscardMessage): Promise<void> {
		const uploads = this.named(requester, msg.transferIds, false);
		for (const [hostId, group] of this.byHost(uploads)) {
			const hostType = (group[0] as Upload).hostType;
			for (const upload of group) this.drop(upload, requester.clientId);
			if (!this.deps.isConnected(hostId, hostType)) {
				const reached = await this.deps.connect(hostId, requester.clientId);
				// Its temporaries wait for the host's next connection.
				if (!reached.connected) continue;
			}
			await this.atConnection(hostId, hostType);
		}
	}

	/**
	 * A remote host's agent connected to the hub, whoever connected it: what
	 * Discard and the expiry left there is removed, and the uploads whose link
	 * merely dropped while their window sent them go on by themselves. One the
	 * hub restarted from never does: it waits for a window's resume.
	 */
	hostConnected(hostId: string): void {
		if (this.stopped || !this.isEnabled()) return;
		const hostType = this.deps.hostType?.(hostId) ?? "ssh";
		void this.atConnection(hostId, hostType).then(() => this.resumeDropped(hostId));
	}

	/**
	 * The interrupted uploads, as STATE_SYNC lists them to a window of
	 * `viewerTokenId`; none while the switch is off.
	 */
	interruptedUploads(viewerTokenId: string | null = null): TransferSyncEntry[] {
		if (!this.isEnabled()) return [];
		const entries: TransferSyncEntry[] = [];
		for (const upload of this.uploads.values()) {
			if (this.uploadState(upload) !== "interrupted") continue;
			const device = this.deviceOf(upload, viewerTokenId);
			entries.push({
				transferId: upload.id,
				channelId: upload.channelId,
				hostId: upload.hostId,
				dir: upload.dir,
				state: "interrupted",
				...(upload.reason !== null ? { reason: upload.reason } : {}),
				totals: totalsOnWire(upload.totals),
				updatedAt: new Date(upload.changedAt).toISOString(),
				fromThisDevice: device.fromThisDevice,
				...(device.label !== null ? { deviceLabel: device.label } : {}),
			});
		}
		return entries;
	}

	/**
	 * Whether a window of `viewerTokenId` is of the device that started the
	 * upload, which alone holds its files (#837), and otherwise that device's
	 * name, when it has one. Compared as a resume's check does: without
	 * credentials, every window is of the same device.
	 */
	private deviceOf(
		upload: Upload,
		viewerTokenId: string | null,
	): { fromThisDevice: boolean; label: string | null } {
		if (upload.tokenId === viewerTokenId) return { fromThisDevice: true, label: null };
		let label: string | null = null;
		if (upload.tokenId !== null) {
			try {
				label = this.deps.deviceLabel?.(upload.tokenId) ?? null;
			} catch {
				label = null;
			}
		}
		return { fromThisDevice: false, label: label === "" ? null : label };
	}

	/**
	 * Bring back the uploads meta.db holds, as the hub starts: every one that
	 * was moving is `interrupted`, each file that was being sent or placed
	 * too, its temporary and its acknowledged bytes kept. Nothing is asked of
	 * a remote host: a resume does that. A record whose upload was done goes;
	 * one discarded, or interrupted for longer than `TRANSFER_EXPIRY_MS`, waits
	 * for its host's next connection to remove its temporaries. Then the
	 * expiry is looked at every hour.
	 */
	restore(): void {
		const store = this.store;
		if (store !== null) {
			let records: TransferRecord[] = [];
			try {
				records = store.list();
			} catch {
				records = [];
			}
			for (const record of records) {
				if (this.uploads.has(record.id) || this.pendingRemoval.has(record.id)) continue;
				try {
					this.bringBack(store, record);
				} catch {
					// A record this hub cannot read is left as it is.
				}
			}
			this.saveNow();
			const local = new Set(
				[...this.pendingRemoval.values()]
					.filter((pending) => pending.hostType === "local")
					.map((pending) => pending.hostId),
			);
			// The local host is always there: what it has to remove goes now.
			if (this.isEnabled()) for (const hostId of local) void this.atConnection(hostId, "local");
		}
		if (this.expiryTimer === null && !this.stopped) {
			this.expiryTimer = setInterval(() => this.expire(), EXPIRY_CHECK_MS);
			this.expiryTimer.unref?.();
		}
	}

	/**
	 * Discard the uploads nobody resumed in `TRANSFER_EXPIRY_MS`, and forget a
	 * finished one kept for its failures as long: their temporaries are
	 * removed now when their host is reached, at its next connection otherwise.
	 */
	expire(): void {
		const now = this.now();
		const reach = new Map<string, string>();
		for (const upload of [...this.uploads.values()]) {
			if (upload.source !== null || this.isActive(upload)) continue;
			if (now - upload.changedAt < TRANSFER_EXPIRY_MS) continue;
			this.drop(upload, null);
			if (this.deps.isConnected(upload.hostId, upload.hostType)) {
				reach.set(upload.hostId, upload.hostType);
			}
		}
		if (!this.isEnabled()) return;
		for (const [hostId, hostType] of reach) void this.atConnection(hostId, hostType);
	}

	/** Write to meta.db now whatever waits, the acknowledged bytes included: the hub is quitting. */
	saveNow(): void {
		this.save(true);
	}

	// ─── The bytes (REST) ────────────────────────────────────────────────────

	/**
	 * Write one chunk of a file, at `offset`, from the window that holds its
	 * bytes; resolve with the bytes the host now holds once it acknowledged
	 * them. Throws `TransferRequestError`.
	 */
	async receive(
		requester: TransferRequester,
		transferId: string,
		itemId: number,
		offset: number,
		data: Buffer,
	): Promise<{ acked: number }> {
		const upload = this.uploads.get(transferId);
		if (upload === undefined)
			throw new TransferRequestError(404, "TRANSFER_NOT_FOUND", "No upload has that id");
		const item = upload.items[itemId];
		if (item === undefined || item.kind !== "file") {
			throw new TransferRequestError(404, "ITEM_NOT_FOUND", "No file of this upload has that id");
		}
		if (upload.source !== requester.clientId || upload.tokenId !== requester.tokenId) {
			throw new TransferRequestError(
				403,
				"NOT_THE_SENDER",
				"Only the window that started this upload sends its bytes",
			);
		}
		if (item.state !== "sending") {
			throw new TransferRequestError(409, "ITEM_NOT_SENDING", `This file is ${item.state}`, {
				state: item.state,
			});
		}
		await item.opening;
		if (item.state !== "sending" || item.sink === null) {
			throw new TransferRequestError(409, "ITEM_NOT_SENDING", `This file is ${item.state}`, {
				state: item.state,
			});
		}
		if (item.writing)
			throw new TransferRequestError(409, "ITEM_BUSY", "A chunk of this file is being written");
		if (offset !== item.acked) {
			throw new TransferRequestError(
				409,
				"OFFSET_MISMATCH",
				`The host holds ${item.acked} bytes of it: send from there`,
				{
					acked: item.acked,
				},
			);
		}
		if (data.length === 0 || offset + data.length > item.size) {
			throw new TransferRequestError(
				400,
				"PAST_END",
				"The chunk is empty or goes past the file's size",
			);
		}
		const sink = item.sink;
		item.writing = true;
		try {
			await sink.write(data, offset);
		} catch (error) {
			if (item.state === "sending") this.fileFailed(upload, item, error);
			throw new TransferRequestError(
				isInterruption(error) ? 409 : 502,
				codeOf(error),
				messageOf(error),
			);
		} finally {
			item.writing = false;
		}
		if (item.state !== "sending") {
			// Cancelled or interrupted while it was written.
			await this.afterStop(upload, item, sink);
			throw new TransferRequestError(409, "ITEM_NOT_SENDING", `This file is ${item.state}`, {
				state: item.state,
			});
		}
		item.hash?.update(data);
		this.addAcked(upload, item, data.length);
		if (item.acked === item.size) void this.finishFile(upload, item);
		this.settle(upload);
		return { acked: item.acked };
	}

	// ─── Reading them (REST) ─────────────────────────────────────────────────

	/**
	 * The uploads from a terminal, as a client that attached late reads them;
	 * every one without. `viewerTokenId`: the credential of the window that
	 * reads them, which says whether each is from its device (#837).
	 */
	listFor(channelId?: string, viewerTokenId: string | null = null): Record<string, unknown>[] {
		return [...this.uploads.values()]
			.filter((upload) => channelId === undefined || upload.channelId === channelId)
			.map((upload) => this.summary(upload, viewerTokenId));
	}

	/** One upload, every item with it. */
	describe(
		transferId: string,
		viewerTokenId: string | null = null,
	): Record<string, unknown> | null {
		const upload = this.uploads.get(transferId);
		if (upload === undefined) return null;
		return {
			...this.summary(upload, viewerTokenId),
			items: upload.items.map((item) => ({
				item_id: item.id,
				rel_path: item.relPath,
				kind: item.kind,
				size: item.kind === "file" ? item.size : null,
				state: item.state,
				...(item.kind === "file" ? { acked: item.acked } : {}),
				...(item.outcome !== null ? { outcome: item.outcome } : {}),
				...(item.finalName !== null ? { final_name: item.finalName } : {}),
				...(item.verification !== null ? { verification: item.verification } : {}),
				...(item.reason !== null ? { reason: item.reason, code: item.code } : {}),
				...(item.state === "conflict"
					? {
							existing: existingOnWire(item.existing),
							...(item.typeClash ? { type_clash: true } : {}),
							...(item.late ? { late: true } : {}),
						}
					: {}),
			})),
		};
	}

	/**
	 * The hub is stopping: what meta.db is to hold is written, then what is
	 * being written on the hosts stops where it is.
	 */
	shutdown(): void {
		if (!this.stopped) this.saveNow();
		this.stopped = true;
		if (this.ackTimer !== null) clearTimeout(this.ackTimer);
		this.ackTimer = null;
		if (this.expiryTimer !== null) clearInterval(this.expiryTimer);
		this.expiryTimer = null;
		this.unsaved.clear();
		this.unsavedAcks.clear();
		for (const upload of this.uploads.values()) {
			for (const item of upload.items) {
				const sink = item.sink;
				item.sink = null;
				if (sink !== null) void sink.abort();
			}
			if (upload.flushTimer !== null) clearTimeout(upload.flushTimer);
			if (upload.flushSoon !== null) clearImmediate(upload.flushSoon);
			this.clearForget(upload);
			this.releaseBackend(upload);
		}
		this.uploads.clear();
	}

	// ─── Starting ────────────────────────────────────────────────────────────

	private create(
		requester: TransferRequester,
		msg: TransferStartMessage,
		hostId: string,
		hostType: string,
		dir: string,
		backend: UploadBackend,
		tree: Extract<ReturnType<typeof buildUploadTree>, { ok: true }>,
	): Upload {
		const items: Item[] = tree.items.map((item) => ({
			...item,
			state: "queued",
			existing: null,
			typeClash: false,
			late: false,
			resolution: null,
			finalName: null,
			path: null,
			outcome: null,
			verification: null,
			acked: 0,
			temp: null,
			tempWhole: false,
			direct: false,
			hash: null,
			sink: null,
			opening: null,
			writing: false,
			reason: null,
			code: null,
			carried: false,
			persistedAcked: 0,
		}));
		return this.assemble(
			{
				id: generateId(),
				channelId: msg.channelId,
				hostId,
				hostType,
				dir,
				style: backend.style,
				onConflict: msg.onConflict,
				verify: backend.transport === "exec" && this.deps.verifyFor(hostId, msg.channelId),
				tokenId: requester.tokenId,
				signature: tree.signature,
				order: tree.order,
				createdAt: new Date(this.now()).toISOString(),
			},
			items,
			requester.clientId,
			backend,
		);
	}

	/** An upload of these items, its totals counted from what each is at. */
	private assemble(
		fields: Pick<
			Upload,
			| "id"
			| "channelId"
			| "hostId"
			| "hostType"
			| "dir"
			| "style"
			| "onConflict"
			| "verify"
			| "tokenId"
			| "signature"
			| "order"
			| "createdAt"
		>,
		items: Item[],
		source: string | null,
		backend: UploadBackend | null,
	): Upload {
		const upload: Upload = {
			...fields,
			items,
			folderTotals: new Map(),
			totals: emptyTotals(),
			folderStates: new Map(),
			source,
			backend,
			queue: [],
			folderQueue: [],
			creatingFolders: false,
			waiting: new Map(),
			dirtyItems: new Set(),
			dirtyFolders: new Set(),
			conflicts: [],
			flushTimer: null,
			flushSoon: null,
			doneSaid: false,
			forgetTimer: null,
			busy: 0,
			changedAt: this.now(),
			reason: null,
			linkDropped: false,
			stale: false,
			stored: false,
			recorded: null,
			said: null,
		};
		for (const item of items) {
			if (item.kind !== "dir") continue;
			upload.folderTotals.set(item.id, emptyTotals());
			upload.folderStates.set(item.state, (upload.folderStates.get(item.state) ?? 0) + 1);
		}
		for (const item of items) {
			if (item.kind !== "file") continue;
			for (const totals of this.totalsAbove(upload, item)) {
				totals.files++;
				totals.bytes += item.size;
				totals.acked += item.acked;
				totals.states.set(item.state, (totals.states.get(item.state) ?? 0) + 1);
			}
		}
		return upload;
	}

	/**
	 * Find what already has each item's name: each folder of the destination
	 * the upload goes into is listed once, links not followed. On a Windows
	 * host names are matched whatever their case, as NTFS does. Says what
	 * each folder listed holds.
	 */
	private async lookAtDestination(
		upload: Upload,
	): Promise<{ path: string; entries: FileEntry[] }[]> {
		const backend = upload.backend as UploadBackend;
		const key = (name: string) => (upload.style === "windows" ? name.toUpperCase() : name);
		const seen: { path: string; entries: FileEntry[] }[] = [];
		// Folders of the destination to list, with the items whose names go in them.
		let level: { path: string; items: Item[] }[] = [
			{ path: upload.dir, items: upload.items.filter((item) => item.parent === null) },
		];
		while (level.length > 0) {
			const listed = await mapLimited(level, LISTING_CONCURRENCY, async ({ path, items }) => {
				const entries = await backend.list(path).catch((error: unknown) => {
					if (error instanceof FileAccessError && error.code === "NOT_FOUND") return [];
					throw error;
				});
				seen.push({ path, entries });
				const byName = new Map(entries.map((entry) => [key(entry.name), entry]));
				const next: { path: string; items: Item[] }[] = [];
				for (const item of items) {
					const entry = byName.get(key(item.name)) ?? null;
					if (entry === null) continue;
					item.existing = entry;
					if (item.kind === "dir" && isFolderLike(entry)) {
						// Merged into: what is in it is looked at in turn.
						item.existing = null;
						const children = item.children
							.map((id) => upload.items[id])
							.filter((child) => child !== undefined);
						if (children.length > 0) {
							next.push({ path: joinHostPath(path, entry.name, upload.style), items: children });
						}
					} else {
						item.typeClash = item.kind === "dir" || isFolderLike(entry);
					}
				}
				return next;
			});
			level = listed.flat();
		}
		return seen;
	}

	/** What `on_conflict` does with each conflict the start found. */
	private applyPolicy(upload: Upload): void {
		for (const id of upload.order) {
			const item = upload.items[id] as Item;
			if (item.existing === null || item.state !== "queued") continue;
			const policy = upload.onConflict;
			if (policy === "skip") this.skip(upload, item);
			else if (policy === "keep_both") item.resolution = "keep_both";
			else if (policy === "replace" && !item.typeClash) item.resolution = "replace";
			else this.setState(upload, item, "conflict");
		}
	}

	private accepted(
		upload: Upload,
		requestId: string,
		joined: boolean,
		order: readonly number[] | null,
	): Record<string, unknown> {
		const ids = order ?? upload.items.map((item) => item.id);
		const items: TransferAcceptedItem[] = ids.map((id) => {
			const item = upload.items[id] as Item;
			const existing = item.state === "conflict" ? existingOnWire(item.existing) : null;
			return {
				itemId: item.id,
				state: item.state,
				...(existing !== null ? { existing } : {}),
				...(item.state === "conflict" && item.typeClash ? { typeClash: true as const } : {}),
			};
		});
		const folderConflicts: TransferFolderConflicts[] = [];
		const conflicting = new Map<number, number>();
		for (const item of upload.items) {
			if (item.kind !== "file" || item.existing === null) continue;
			for (
				let parent = item.parent;
				parent !== null;
				parent = upload.items[parent]?.parent ?? null
			) {
				conflicting.set(parent, (conflicting.get(parent) ?? 0) + 1);
			}
		}
		for (const [itemId, count] of conflicting) {
			folderConflicts.push({
				itemId,
				conflicting: count,
				total: upload.folderTotals.get(itemId)?.files ?? 0,
			});
		}
		return {
			type: "TRANSFER_ACCEPTED",
			requestId,
			transferId: upload.id,
			channelId: upload.channelId,
			hostId: upload.hostId,
			dir: upload.dir,
			joined,
			items,
			folderConflicts,
		};
	}

	/** An upload of the same tree to the same folder that no window sends any more. */
	private joinable(hostId: string, dir: string, signature: string): Upload | null {
		for (const upload of this.uploads.values()) {
			if (
				upload.source === null &&
				upload.hostId === hostId &&
				upload.dir === dir &&
				upload.signature === signature &&
				upload.items.some(
					(item) => item.kind === "file" && item.state !== "placed" && item.state !== "skipped",
				)
			) {
				return upload;
			}
		}
		return null;
	}

	/**
	 * A window dropped again the tree of an upload it left (a reload loses a
	 * window's files): it sends that upload's bytes now. Placed files are not
	 * sent again; interrupted ones resume; the rest is sent.
	 */
	private join(
		upload: Upload,
		requester: TransferRequester,
		msg: TransferStartMessage,
		requestId: string,
	): void {
		upload.source = requester.clientId;
		upload.reason = null;
		upload.linkDropped = false;
		const byPath = new Map(upload.items.map((item) => [item.relPath, item.id]));
		const order = (msg.items as { relPath: string }[]).map((item) => byPath.get(item.relPath) ?? 0);
		this.requeueAll(
			upload,
			upload.order
				.map((id) => upload.items[id] as Item)
				.filter(
					(item) =>
						item.state === "failed" || item.state === "cancelled" || item.state === "interrupted",
				),
		);
		this.deps.send(requester.clientId, this.accepted(upload, requestId, true, order));
		this.settle(upload);
		this.schedulePump();
	}

	// ─── Moving on ───────────────────────────────────────────────────────────

	private schedulePump(): void {
		if (this.pumpScheduled || this.stopped) return;
		this.pumpScheduled = true;
		setImmediate(() => {
			this.pumpScheduled = false;
			this.pump();
		});
	}

	/** Create the folders that can be, and start the files there is room for. */
	private pump(): void {
		if (this.stopped) return;
		const sending = new Map<string, number>();
		for (const upload of this.uploads.values()) {
			if (upload.source === null) continue;
			const files = upload.totals.states.get("sending") ?? 0;
			if (files > 0) sending.set(upload.source, (sending.get(upload.source) ?? 0) + files);
		}
		const limit = Math.max(1, this.deps.maxConcurrent());
		for (const upload of this.uploads.values()) {
			if (upload.folderQueue.length > 0 && !upload.creatingFolders) void this.createFolders(upload);
			const source = upload.source;
			if (source === null || !this.sourceMayWrite(upload)) continue;
			while ((sending.get(source) ?? 0) < limit && upload.queue.length > 0) {
				const id = upload.queue.shift() as number;
				const item = upload.items[id];
				if (item === undefined || item.state !== "queued") continue;
				if (item.tempWhole) {
					void this.place(upload, item);
					continue;
				}
				sending.set(source, (sending.get(source) ?? 0) + 1);
				this.admit(upload, item);
			}
		}
	}

	/** Whether the window sending an upload may go on starting its files: it may type into the terminal, or the terminal ended. */
	private sourceMayWrite(upload: Upload): boolean {
		if (upload.source === null) return false;
		return (
			this.deps.channelEnded(upload.channelId) ||
			this.deps.mayWrite(upload.channelId, upload.source)
		);
	}

	private async backendOf(upload: Upload): Promise<UploadBackend> {
		if (upload.backend !== null && !upload.backend.lost) return upload.backend;
		this.releaseBackend(upload);
		const backend = await this.deps.files.uploadBackend(upload.hostId, upload.hostType);
		if (upload.backend !== null) {
			backend.release();
			return upload.backend;
		}
		upload.backend = backend;
		return backend;
	}

	private releaseBackend(upload: Upload): void {
		upload.backend?.release();
		upload.backend = null;
	}

	/** The folder an item goes in, on the host. */
	private parentPath(upload: Upload, item: Item): string {
		if (item.parent === null) return upload.dir;
		return (upload.items[item.parent] as Item).path ?? upload.dir;
	}

	/** Whether what an item is in is in place. */
	private parentReady(upload: Upload, item: Item): boolean {
		return item.parent === null || upload.items[item.parent]?.state === "placed";
	}

	private enqueue(upload: Upload, item: Item): void {
		if (!this.parentReady(upload, item)) {
			const parent = item.parent as number;
			const waiting = upload.waiting.get(parent) ?? [];
			waiting.push(item.id);
			upload.waiting.set(parent, waiting);
			return;
		}
		if (item.kind === "dir") upload.folderQueue.push(item.id);
		else upload.queue.push(item.id);
	}

	/** Queue what is queued in a folder now in place, or in the destination with null. */
	private enqueueReady(upload: Upload, folder: number | null): void {
		if (folder === null) {
			for (const id of upload.order) {
				const item = upload.items[id] as Item;
				if (item.state === "queued") this.enqueue(upload, item);
			}
			return;
		}
		const waiting = upload.waiting.get(folder) ?? [];
		upload.waiting.delete(folder);
		for (const id of waiting) {
			const item = upload.items[id] as Item;
			if (item.state === "queued") this.enqueue(upload, item);
		}
	}

	private async createFolders(upload: Upload): Promise<void> {
		upload.creatingFolders = true;
		upload.busy++;
		try {
			while (upload.folderQueue.length > 0 && !this.stopped) {
				const batch = upload.folderQueue
					.splice(0, FOLDER_BATCH)
					.map((id) => upload.items[id] as Item)
					.filter((item) => item.state === "queued");
				const plain = batch.filter((item) => item.resolution !== "keep_both");
				const backend = await this.backendOf(upload);
				const paths = plain.map((item) =>
					joinHostPath(this.parentPath(upload, item), item.name, upload.style),
				);
				const results = await backend.mkdirs(paths);
				plain.forEach((item, index) => {
					const result = results[index];
					const path = paths[index] as string;
					if (item.state !== "queued" || result === undefined) return;
					if (result.kind === "created" || result.kind === "merged") {
						this.folderPlaced(upload, item, path, result.kind);
					} else if (result.kind === "clash") {
						this.folderClash(upload, item, result.existing);
					} else {
						this.failSubtree(upload, item, result.error.code, result.error.message);
					}
				});
				for (const item of batch.filter((each) => each.resolution === "keep_both")) {
					if (item.state === "queued") await this.keepBothFolder(upload, backend, item);
				}
			}
		} catch (error) {
			for (const id of upload.folderQueue.splice(0)) {
				const item = upload.items[id] as Item;
				if (item.state !== "queued") continue;
				if (isInterruption(error)) this.interrupt(upload, item, messageOf(error));
				else this.failSubtree(upload, item, codeOf(error), messageOf(error));
			}
			if (isInterruption(error)) this.interruptAll(upload, messageOf(error));
		} finally {
			upload.creatingFolders = false;
			upload.busy--;
			this.settle(upload);
			this.schedulePump();
		}
	}

	private async keepBothFolder(upload: Upload, backend: UploadBackend, item: Item): Promise<void> {
		for (let n = 1; n <= KEEP_BOTH_TRIES; n++) {
			const name = keepBothName(item.name, n, "dir");
			const path = joinHostPath(this.parentPath(upload, item), name, upload.style);
			const [result] = await backend.mkdirs([path]);
			if (result?.kind === "created") {
				item.finalName = name;
				this.folderPlaced(upload, item, path, "created", "kept_both");
				return;
			}
			if (result?.kind === "failed") {
				this.failSubtree(upload, item, result.error.code, result.error.message);
				return;
			}
		}
		this.failSubtree(upload, item, "NO_FREE_NAME", "No free name was found for it");
	}

	private folderPlaced(
		upload: Upload,
		item: Item,
		path: string,
		how: "created" | "merged",
		outcome: TransferOutcome = how,
	): void {
		item.path = path;
		item.outcome = outcome;
		this.setState(upload, item, "placed");
		this.enqueueReady(upload, item.id);
	}

	/** Something not a folder has a folder's name: Keep both or Skip, as the policy or an answer says. */
	private folderClash(upload: Upload, item: Item, existing: FileEntry | null): void {
		item.existing = existing;
		item.typeClash = true;
		item.late = true;
		if (upload.onConflict === "skip") {
			this.skip(upload, item);
			return;
		}
		if (upload.onConflict === "keep_both") {
			item.resolution = "keep_both";
			upload.folderQueue.push(item.id);
			return;
		}
		this.setState(upload, item, "conflict");
		upload.conflicts.push({
			itemId: item.id,
			existing: existingOnWire(existing),
			typeClash: true,
			late: true,
		});
	}

	/** Start sending a file: its temporary opened, or the one it has resumed. */
	private admit(upload: Upload, item: Item): void {
		this.setState(upload, item, "sending");
		item.reason = null;
		item.code = null;
		item.opening = this.open(upload, item).then(
			() => {
				if (item.state === "sending" && item.acked === item.size)
					void this.finishFile(upload, item);
			},
			(error: unknown) => {
				if (item.state === "sending") this.fileFailed(upload, item, error);
			},
		);
		// The window sends its bytes once told: told now, not with the next batch.
		this.settle(upload, true);
	}

	private async open(upload: Upload, item: Item): Promise<void> {
		const backend = await this.backendOf(upload);
		const parent = this.parentPath(upload, item);
		const target = joinHostPath(parent, item.finalName ?? item.name, upload.style);
		// A temporary kept from before: it resumes where the host's bytes end.
		if (item.temp !== null && item.acked > 0) {
			const there = await backend.stat(item.temp).catch(() => null);
			const size = there?.kind === "file" ? (there.size ?? -1) : -1;
			let resumable =
				backend.transport === "exec" && !item.carried
					? // Appended to: what it holds must be all the hub sent, and hashed.
						size === item.acked
					: size >= item.acked;
			if (resumable && size > item.acked) {
				// Only the prefix the host acknowledged is known to be whole (#860).
				resumable = await backend.truncate(item.temp, item.acked).then(
					() => true,
					(error: unknown) => {
						if (isInterruption(error)) throw error;
						return false;
					},
				);
			}
			if (!resumable) {
				await backend.remove(item.temp);
				this.restartFile(upload, item);
			}
		} else if (item.temp !== null) {
			await backend.remove(item.temp);
			this.restartFile(upload, item);
		}
		if (item.temp === null) {
			const direct =
				item.resolution !== "replace" && (await backend.placement(parent)) === "direct";
			item.direct = direct;
			if (upload.verify) item.hash = createHash("sha256");
			if (direct) {
				await this.openDirect(upload, backend, item, parent);
				this.persist(upload, item);
				return;
			}
			item.temp = tempPathFor(target, upload.style);
		}
		// Known before it exists: a sweep never takes it for a stranger's.
		this.persist(upload, item);
		const options = {
			resumeAt: item.acked,
			size: item.size,
			mtime: item.mtime,
			hash: upload.verify,
		};
		try {
			item.sink = await backend.open(item.temp, options);
		} catch (error) {
			if (!(error instanceof TargetExists) || item.acked > 0) throw error;
			// A name nobody should have: another one.
			item.temp = tempPathFor(target, upload.style);
			this.persist(upload, item);
			item.sink = await backend.open(item.temp, options);
		}
		if (item.state !== "sending") {
			const sink = item.sink;
			item.sink = null;
			await this.afterStop(upload, item, sink);
		}
	}

	/**
	 * Open a file under its own name, created exclusively, on a server whose
	 * rename would replace: a name taken is a conflict before any byte moves.
	 */
	private async openDirect(
		upload: Upload,
		backend: UploadBackend,
		item: Item,
		parent: string,
	): Promise<void> {
		const options = { resumeAt: 0, size: item.size, mtime: item.mtime, hash: false };
		const keepBoth = item.resolution === "keep_both";
		for (let n = keepBoth ? 1 : 0; n <= KEEP_BOTH_TRIES; n++) {
			const name = n === 0 ? (item.finalName ?? item.name) : keepBothName(item.name, n, "file");
			const path = joinHostPath(parent, name, upload.style);
			try {
				item.sink = await backend.open(path, options);
				item.temp = path;
				if (n > 0) item.finalName = name;
				return;
			} catch (error) {
				if (!(error instanceof TargetExists)) throw error;
				if (keepBoth) continue;
				this.conflictFound(upload, item, error.existing);
				return;
			}
		}
		throw new FileAccessError("FILE_ACCESS_FAILED", "No free name was found for it");
	}

	/** Every byte is on the host: check it, then place it. */
	private async finishFile(upload: Upload, item: Item): Promise<void> {
		const sink = item.sink;
		if (sink === null || item.state !== "sending") return;
		item.sink = null;
		this.setState(upload, item, "verifying");
		this.settle(upload);
		this.schedulePump();
		const sha256 = item.hash !== null ? item.hash.copy().digest("hex") : null;
		upload.busy++;
		try {
			item.verification = await sink.finish(sha256);
		} catch (error) {
			upload.busy--;
			this.fileFailed(upload, item, error);
			return;
		}
		upload.busy--;
		// Over SSH commands, bytes an earlier hub sent are hashed by nobody: the size stands (#860).
		if (
			item.carried &&
			upload.verify &&
			upload.backend?.transport === "exec" &&
			item.verification === "size"
		) {
			item.verification = "size_resumed";
		}
		item.tempWhole = true;
		item.hash = null;
		this.persist(upload, item);
		if (item.direct) {
			this.filePlaced(
				upload,
				item,
				item.temp as string,
				item.finalName !== null ? "kept_both" : "placed",
			);
			return;
		}
		await this.place(upload, item);
	}

	/** Put a whole temporary under its name, as its resolution, or the policy, says. */
	private async place(upload: Upload, item: Item): Promise<void> {
		if (item.temp === null) return;
		this.setState(upload, item, "verifying");
		this.settle(upload);
		upload.busy++;
		try {
			const backend = await this.backendOf(upload);
			const parent = this.parentPath(upload, item);
			const temp = item.temp;
			if (item.resolution === "replace") {
				const target = joinHostPath(parent, item.name, upload.style);
				await backend.place(temp, target, true);
				return this.filePlaced(
					upload,
					item,
					target,
					item.existing !== null || item.late ? "replaced" : "placed",
				);
			}
			if (item.resolution === "keep_both") {
				for (let n = 1; n <= KEEP_BOTH_TRIES; n++) {
					const name = keepBothName(item.name, n, "file");
					const target = joinHostPath(parent, name, upload.style);
					const result = await backend.place(temp, target, false);
					if (result.kind === "placed") {
						item.finalName = name;
						return this.filePlaced(upload, item, target, "kept_both");
					}
				}
				throw new FileAccessError("FILE_ACCESS_FAILED", "No free name was found for it");
			}
			const target = joinHostPath(parent, item.name, upload.style);
			const result = await backend.place(temp, target, false);
			if (result.kind === "placed") return this.filePlaced(upload, item, target, "placed");
			// It appeared after the start looked: nothing is replaced unasked.
			this.conflictFound(upload, item, result.existing);
		} catch (error) {
			this.fileFailed(upload, item, error);
		} finally {
			upload.busy--;
			this.settle(upload);
			this.schedulePump();
		}
	}

	/** Something has a file's name, found once its bytes were sent or as it opened. */
	private conflictFound(upload: Upload, item: Item, existing: FileEntry | null): void {
		item.existing = existing;
		item.typeClash = existing !== null && isFolderLike(existing);
		item.late = true;
		const policy = upload.onConflict;
		if (policy === "skip") {
			this.skip(upload, item);
			return;
		}
		if (policy === "keep_both" || (policy === "replace" && !item.typeClash)) {
			item.resolution = policy;
			if (item.tempWhole) void this.place(upload, item);
			else {
				this.setState(upload, item, "queued");
				this.enqueue(upload, item);
			}
			return;
		}
		if (!item.tempWhole) {
			// Opened under its own name: nothing was written, nothing is kept.
			item.sink = null;
			item.temp = null;
		}
		this.setState(upload, item, "conflict");
		upload.conflicts.push({
			itemId: item.id,
			existing: existingOnWire(existing),
			...(item.typeClash ? { typeClash: true as const } : {}),
			late: true,
		});
	}

	private filePlaced(upload: Upload, item: Item, path: string, outcome: TransferOutcome): void {
		item.path = path;
		item.outcome = outcome;
		item.temp = null;
		item.tempWhole = false;
		this.setState(upload, item, "placed");
	}

	/** A file stopped short of its name: failed, its temporary removed, or interrupted, it kept. */
	private fileFailed(upload: Upload, item: Item, error: unknown): void {
		const sink = item.sink;
		item.sink = null;
		if (isInterruption(error)) {
			if (sink !== null) void sink.abort();
			this.setState(upload, item, "interrupted");
			item.reason = messageOf(error);
			item.code = codeOf(error);
			this.interruptAll(upload, messageOf(error));
			return;
		}
		item.reason = messageOf(error);
		item.code = codeOf(error);
		this.setState(upload, item, "failed");
		const temp = item.temp;
		this.restartFile(upload, item);
		void (async () => {
			await sink?.abort();
			if (temp !== null && !item.direct) await upload.backend?.remove(temp);
		})();
	}

	/** Forget what a file had on the host: it starts again from its first byte. */
	private restartFile(upload: Upload, item: Item): void {
		this.addAcked(upload, item, -item.acked);
		item.temp = null;
		item.tempWhole = false;
		item.hash = null;
		item.carried = false;
		this.persist(upload, item);
	}

	/** The connection went: everything of this upload under way stops, resumable. */
	private interruptAll(upload: Upload, reason: string): void {
		if (upload.backend !== null && !upload.backend.lost) return;
		for (const item of upload.items) {
			if (item.state === "sending" || item.state === "queued") this.interrupt(upload, item, reason);
		}
		// Its window is still there: the hub's reconnect takes it up again (#860).
		if (upload.source !== null) upload.linkDropped = true;
		this.releaseBackend(upload);
	}

	private interrupt(upload: Upload, item: Item, reason: string): void {
		const sink = item.sink;
		item.sink = null;
		item.reason = reason;
		item.code = "INTERRUPTED";
		this.setState(upload, item, "interrupted");
		// Its bytes so far are kept: a write still under way ends before the temporary is read.
		if (sink !== null && !item.writing) void sink.abort();
	}

	/** A file or folder cancelled: its temporary goes, and what is in a folder with it. */
	private stopItem(upload: Upload, item: Item, state: "cancelled"): void {
		const sink = item.sink;
		item.sink = null;
		this.setState(upload, item, state);
		item.reason = null;
		if (item.kind === "dir") {
			for (const id of item.children) {
				const child = upload.items[id] as Item;
				if (
					child.state === "queued" ||
					child.state === "conflict" ||
					child.state === "interrupted" ||
					child.state === "sending"
				) {
					this.stopItem(upload, child, state);
				}
			}
			return;
		}
		if (!item.writing) void this.afterStop(upload, item, sink);
	}

	/** What a stopped file leaves: its open write closed, and a cancelled one's temporary removed. */
	private async afterStop(upload: Upload, item: Item, sink: UploadSink | null): Promise<void> {
		await sink?.abort();
		if (item.state !== "cancelled") return;
		const temp = item.temp;
		this.restartFile(upload, item);
		if (temp !== null && upload.backend !== null && !upload.backend.lost) {
			await upload.backend.remove(temp);
		}
	}

	private skip(upload: Upload, item: Item): void {
		const temp = item.temp;
		item.outcome = "skipped";
		this.setState(upload, item, "skipped");
		if (item.kind === "file") {
			this.restartFile(upload, item);
			if (temp !== null && upload.backend !== null) void upload.backend.remove(temp);
			return;
		}
		for (const id of item.children) {
			const child = upload.items[id] as Item;
			if (child.state !== "placed" && child.state !== "skipped") this.skip(upload, child);
		}
	}

	/** A folder that could not be created: it, and everything in it, failed. */
	private failSubtree(upload: Upload, item: Item, code: string, reason: string): void {
		item.code = code;
		item.reason = reason;
		this.setState(upload, item, "failed");
		for (const id of item.children) {
			const child = upload.items[id] as Item;
			if (child.state === "queued" || child.state === "conflict") {
				this.failSubtree(upload, child, code, "The folder it is in could not be created");
			}
		}
	}

	private requeue(upload: Upload, item: Item): void {
		item.reason = null;
		item.code = null;
		if (item.kind === "file" && item.tempWhole) {
			// Its bytes are all on the host: only placing it is left, which needs no window.
			void this.place(upload, item);
			return;
		}
		this.setState(upload, item, "queued");
		this.enqueue(upload, item);
	}

	// ─── Control ─────────────────────────────────────────────────────────────

	/**
	 * The upload a control message names, when the window may act on it: as
	 * INPUT may, or, for an ended terminal, from the device that started it.
	 * Refused otherwise, to that window, and null.
	 */
	private controlled(
		requester: TransferRequester,
		msg: { transferId: string; scope: TransferScope },
	): Upload | null {
		return this.controlledById(requester, msg.transferId, false);
	}

	/**
	 * As `controlled`, by id. `sends`: the window is to send the upload's
	 * bytes, which only a window of the device that started it holds.
	 */
	private controlledById(requester: TransferRequester, id: unknown, sends: boolean): Upload | null {
		const upload = typeof id === "string" ? this.uploads.get(id) : undefined;
		if (upload === undefined) {
			this.refuseControl(requester, String(id), "TRANSFER_NOT_FOUND", "No upload has that id");
			return null;
		}
		const allowed = this.deps.channelEnded(upload.channelId)
			? requester.tokenId === upload.tokenId
			: this.deps.mayWrite(upload.channelId, requester.clientId);
		if (!allowed) {
			this.refuseControl(
				requester,
				upload.id,
				"WRITE_LOCK_DENIED",
				"This window does not hold the write lock for this upload's terminal",
			);
			return null;
		}
		if (sends && requester.tokenId !== upload.tokenId) {
			this.refuseControl(
				requester,
				upload.id,
				"NOT_THE_SENDER",
				"Only a window of the device that started this upload holds its files",
			);
			return null;
		}
		return upload;
	}

	/** The uploads a RESUME or a DISCARD names that this window may act on; the others refused. */
	private named(requester: TransferRequester, ids: unknown, sends: boolean): Upload[] {
		if (!Array.isArray(ids) || ids.length === 0 || ids.length > TRANSFER_MAX_IDS) {
			this.refuseControl(
				requester,
				"",
				"INVALID_INPUT",
				`transfer_ids must name from 1 to ${TRANSFER_MAX_IDS} uploads`,
			);
			return [];
		}
		const uploads: Upload[] = [];
		for (const id of new Set(ids)) {
			const upload = this.controlledById(requester, id, sends);
			if (upload !== null) uploads.push(upload);
		}
		return uploads;
	}

	/** Uploads by host, in the order the first of each was named. */
	private byHost(uploads: readonly Upload[]): Map<string, Upload[]> {
		const hosts = new Map<string, Upload[]>();
		for (const upload of uploads) {
			const group = hosts.get(upload.hostId) ?? [];
			group.push(upload);
			hosts.set(upload.hostId, group);
		}
		return hosts;
	}

	private refuseControl(
		requester: TransferRequester,
		transferId: string,
		code: string,
		message: string,
	): void {
		this.deps.send(requester.clientId, {
			type: "TRANSFER_ERROR",
			transferId,
			code,
			message,
		} satisfies TransferErrorMessage);
	}

	/** The items a scope covers: one, everything under a folder with it, or all. Null for no such item. */
	private scoped(upload: Upload, scope: TransferScope): Item[] | null {
		if (scope === "upload") return upload.items;
		if (typeof scope !== "number" || !Number.isInteger(scope)) return null;
		const root = upload.items[scope];
		if (root === undefined) return null;
		const items: Item[] = [];
		const walk = (item: Item): void => {
			items.push(item);
			for (const id of item.children) walk(upload.items[id] as Item);
		};
		walk(root);
		return items;
	}

	// ─── Saying it ───────────────────────────────────────────────────────────

	/** The totals an item's state and bytes count in: every folder it is in, and the upload's. */
	private totalsAbove(upload: Upload, item: Item | TreeItem): Totals[] {
		const totals = [upload.totals];
		for (let parent = item.parent; parent !== null; parent = upload.items[parent]?.parent ?? null) {
			const folder = upload.folderTotals.get(parent);
			if (folder !== undefined) totals.push(folder);
		}
		return totals;
	}

	private setState(upload: Upload, item: Item, state: TransferItemState): void {
		const before = item.state;
		item.state = state;
		upload.dirtyItems.add(item.id);
		// With what else changed of it: its reason, its outcome, its temporary.
		this.persist(upload, item);
		if (before === state) return;
		if (item.kind !== "file") {
			const left = (upload.folderStates.get(before) ?? 1) - 1;
			if (left > 0) upload.folderStates.set(before, left);
			else upload.folderStates.delete(before);
			upload.folderStates.set(state, (upload.folderStates.get(state) ?? 0) + 1);
			return;
		}
		for (const totals of this.totalsAbove(upload, item)) {
			const left = (totals.states.get(before) ?? 1) - 1;
			if (left > 0) totals.states.set(before, left);
			else totals.states.delete(before);
			totals.states.set(state, (totals.states.get(state) ?? 0) + 1);
		}
		this.markFolders(upload, item);
	}

	private addAcked(upload: Upload, item: Item, delta: number): void {
		if (delta === 0) return;
		item.acked += delta;
		upload.dirtyItems.add(item.id);
		for (const totals of this.totalsAbove(upload, item)) totals.acked += delta;
		this.markFolders(upload, item);
		this.persistAcked(upload, item);
	}

	// ─── Keeping it (#860) ───────────────────────────────────────────────────

	/** Write an upload's change to meta.db at once, with whatever else changed meanwhile. */
	private persist(upload: Upload, item?: Item): void {
		if (this.store === null || this.stopped || !upload.stored) return;
		let ids = this.unsaved.get(upload.id);
		if (ids === undefined) {
			ids = new Set();
			this.unsaved.set(upload.id, ids);
		}
		if (item !== undefined) ids.add(item.id);
		if (this.saveScheduled) return;
		this.saveScheduled = true;
		setImmediate(() => {
			this.saveScheduled = false;
			this.save(false);
		});
	}

	/**
	 * A file's acknowledged bytes grew: written once `ACKED_PERSIST_BYTES` more
	 * are there, else within `ACKED_PERSIST_MS`. A restarted file's go at once.
	 */
	private persistAcked(upload: Upload, item: Item): void {
		if (this.store === null || this.stopped || !upload.stored) return;
		if (
			item.acked < item.persistedAcked ||
			item.acked - item.persistedAcked >= ACKED_PERSIST_BYTES
		) {
			this.persist(upload, item);
			return;
		}
		let ids = this.unsavedAcks.get(upload.id);
		if (ids === undefined) {
			ids = new Set();
			this.unsavedAcks.set(upload.id, ids);
		}
		ids.add(item.id);
		if (this.ackTimer !== null) return;
		this.ackTimer = setTimeout(() => {
			this.ackTimer = null;
			this.save(true);
		}, ACKED_PERSIST_MS);
		this.ackTimer.unref?.();
	}

	/** Write what changed; with `acks`, the acknowledged bytes that waited too. */
	private save(acks: boolean): void {
		const store = this.store;
		if (store === null) return;
		const at = this.now();
		const iso = new Date(at).toISOString();
		const pending = [...this.unsaved];
		this.unsaved.clear();
		if (acks) {
			for (const [id, ids] of this.unsavedAcks) {
				const merged = pending.find(([each]) => each === id)?.[1];
				if (merged !== undefined) for (const itemId of ids) merged.add(itemId);
				else pending.push([id, ids]);
			}
			this.unsavedAcks.clear();
		}
		if (pending.length === 0) return;
		try {
			store.transaction(() => {
				for (const [id, ids] of pending) {
					const upload = this.uploads.get(id);
					if (upload === undefined || !upload.stored) continue;
					for (const itemId of ids) {
						const item = upload.items[itemId];
						if (item === undefined) continue;
						store.writeItem(upload.id, this.itemRecord(item, iso));
						item.persistedAcked = item.acked;
						this.unsavedAcks.get(upload.id)?.delete(itemId);
					}
					const now = { state: this.uploadState(upload), reason: upload.reason };
					if (!sameState(upload.recorded, now)) {
						store.setState(upload.id, now.state, now.reason, iso);
						upload.recorded = now;
						upload.changedAt = at;
					}
				}
			});
		} catch {
			// meta.db refused the write: the uploads go on in memory, as before #860.
		}
	}

	/** Its rows, once it has been accepted. */
	private record(upload: Upload): void {
		upload.said = { state: this.uploadState(upload), reason: null };
		const store = this.store;
		if (store === null) return;
		const iso = new Date(this.now()).toISOString();
		const state = this.uploadState(upload);
		try {
			store.insert(
				{
					id: upload.id,
					hostId: upload.hostId,
					channelId: upload.channelId,
					tokenId: upload.tokenId,
					destDir: upload.dir,
					pathStyle: upload.style,
					direction: "upload",
					state,
					onConflict: upload.onConflict,
					verify: upload.verify,
					signature: upload.signature,
					reason: null,
					createdAt: upload.createdAt,
					updatedAt: iso,
				},
				upload.items.map((item) => this.itemRecord(item, iso)),
			);
		} catch {
			return;
		}
		upload.stored = true;
		upload.recorded = { state, reason: null };
		for (const item of upload.items) item.persistedAcked = item.acked;
	}

	private itemRecord(item: Item, updatedAt: string): TransferItemRecord {
		return {
			id: item.id,
			parentId: item.parent,
			relPath: item.relPath,
			kind: item.kind,
			size: item.size,
			mtime: item.mtime,
			state: item.state,
			ackedOffset: item.acked,
			tempPath: item.temp,
			tempWhole: item.tempWhole,
			direct: item.direct,
			finalName: item.finalName,
			resolution: item.resolution,
			outcome: item.outcome,
			verification: item.verification,
			existingJson:
				item.existing === null
					? null
					: JSON.stringify({
							kind: item.existing.kind,
							size: item.existing.size,
							mtime: item.existing.mtime,
							...(item.existing.linkKind !== undefined ? { linkKind: item.existing.linkKind } : {}),
						}),
			typeClash: item.typeClash,
			late: item.late,
			errorCode: item.code,
			reason: item.reason,
			updatedAt,
		};
	}

	/**
	 * An upload from its rows, as `restore` brings it back: no window sends
	 * it, nothing of it is queued until a resume says so.
	 */
	private bringBack(store: TransfersDAL, record: TransferRecord): void {
		const hostType = this.deps.hostType?.(record.hostId) ?? null;
		if (hostType === null || record.direction !== "upload") {
			store.delete(record.id);
			return;
		}
		if (record.state === "done") {
			store.delete(record.id);
			return;
		}
		const style: PathStyle = record.pathStyle === "windows" ? "windows" : "posix";
		const rows = store.items(record.id);
		if (record.state === "discarded") {
			this.pendingRemoval.set(record.id, {
				id: record.id,
				hostId: record.hostId,
				hostType,
				dir: record.destDir,
				style,
				temps: rows.flatMap((row) =>
					row.tempPath !== null && row.state !== "placed" ? [row.tempPath] : [],
				),
			});
			return;
		}
		// Their ids are their places: a record with one missing is not this hub's to read.
		if (rows.some((row, index) => row.id !== index)) return;
		const items: Item[] = rows.map((row) => {
			const cut = row.relPath.lastIndexOf("/");
			const name = row.relPath.slice(cut + 1);
			const state = revivedState(row.state);
			const moving = state !== row.state;
			return {
				id: row.id,
				relPath: row.relPath,
				name,
				kind: row.kind === "dir" ? "dir" : "file",
				size: row.size,
				mtime: row.mtime,
				parent: row.parentId,
				children: [],
				state,
				existing: existingOf(row.existingJson, name),
				typeClash: row.typeClash,
				late: row.late,
				resolution: (TRANSFER_CONFLICT_ACTIONS as readonly string[]).includes(row.resolution ?? "")
					? (row.resolution as TransferConflictAction)
					: null,
				finalName: row.finalName,
				path: null,
				outcome: row.outcome as TransferOutcome | null,
				verification: row.verification as TransferVerification | null,
				acked: row.kind === "dir" ? 0 : row.ackedOffset,
				temp: row.tempPath,
				tempWhole: row.tempWhole,
				direct: row.direct,
				hash: null,
				sink: null,
				opening: null,
				writing: false,
				reason: moving ? "The hub stopped while it was being sent" : row.reason,
				code: moving ? "INTERRUPTED" : row.errorCode,
				carried: row.tempPath !== null && row.ackedOffset > 0,
				persistedAcked: row.ackedOffset,
			};
		});
		for (const item of items) {
			if (item.parent !== null) items[item.parent]?.children.push(item.id);
		}
		const depth = (item: Item) => item.relPath.split("/").length;
		const order = [...items]
			.sort((a, b) => depth(a) - depth(b) || a.id - b.id)
			.map((item) => item.id);
		// Where each folder that was put in place is: what is in it goes there.
		for (const id of order) {
			const item = items[id] as Item;
			if (item.kind !== "dir" || item.outcome === null || item.outcome === "skipped") continue;
			const parent = item.parent === null ? record.destDir : items[item.parent]?.path;
			if (parent === null || parent === undefined) continue;
			item.path = joinHostPath(parent, item.finalName ?? item.name, style);
		}
		const upload = this.assemble(
			{
				id: record.id,
				channelId: record.channelId,
				hostId: record.hostId,
				hostType,
				dir: record.destDir,
				style,
				onConflict: (TRANSFER_ON_CONFLICT_VALUES as readonly string[]).includes(record.onConflict)
					? (record.onConflict as TransferOnConflict)
					: "ask",
				verify: record.verify,
				tokenId: record.tokenId,
				signature: record.signature,
				order,
				createdAt: record.createdAt,
			},
			items,
			null,
			null,
		);
		upload.stale = true;
		upload.stored = true;
		upload.changedAt = Date.parse(record.updatedAt) || this.now();
		upload.reason = NOT_RESUMED_REASONS.has(record.reason ?? "")
			? (record.reason as TransferNotResumedReason)
			: null;
		upload.recorded = {
			state: record.state as TransferUploadState,
			reason: record.reason,
		};
		upload.said = { state: "interrupted", reason: upload.reason };
		if (this.isSettled(upload)) {
			// Nothing of it is left to send, answer or place: there is nothing to resume.
			store.delete(record.id);
			return;
		}
		this.uploads.set(upload.id, upload);
		const expired =
			record.state === "interrupted" && this.now() - upload.changedAt >= TRANSFER_EXPIRY_MS;
		if (expired) {
			this.drop(upload, null);
			return;
		}
		// What was moving is written as it is now: interrupted.
		for (const item of items) if (item.state !== rows[item.id]?.state) this.persist(upload, item);
		this.persist(upload);
	}

	/** What an upload as a whole is at, as meta.db and TRANSFER_STATE say it. */
	private uploadState(upload: Upload): TransferUploadState {
		if (this.isSettled(upload)) return "done";
		return upload.source === null ? "interrupted" : "running";
	}

	// ─── Resuming, discarding, and a host's connection (#860) ────────────────

	/** A resume or a discard is reaching this host: it holds its connection as a start does. */
	private hold(hostId: string): void {
		this.starting.set(hostId, (this.starting.get(hostId) ?? 0) + 1);
	}

	private letGo(hostId: string, hostType: string): void {
		const left = (this.starting.get(hostId) ?? 1) - 1;
		if (left > 0) this.starting.set(hostId, left);
		else this.starting.delete(hostId);
		this.noteHost(hostId, hostType);
	}

	/**
	 * Take up an upload, this window sending it: each temporary is looked at
	 * first. One at least as long as what its host acknowledged is cut to
	 * that and goes on from there; one missing or short, and the file starts
	 * again under a new one. A whole one is only placed; a placed file is
	 * never sent again. Then what failed, was cancelled or interrupted is
	 * queued, as a retry would. The files `files` names are seen to first:
	 * left out, or started again as they are now (`changedFile`).
	 */
	private async takeUp(
		upload: Upload,
		requester: TransferRequester,
		files: readonly TransferResumeFile[] = [],
	): Promise<void> {
		upload.reason = null;
		upload.linkDropped = false;
		upload.busy++;
		try {
			const backend = await this.backendOf(upload);
			for (const file of files) this.changedFile(upload, backend, file);
			const kept = upload.items.filter(
				(item) =>
					item.kind === "file" &&
					item.temp !== null &&
					(item.state === "interrupted" ||
						item.state === "queued" ||
						item.state === "conflict" ||
						item.state === "failed" ||
						item.state === "cancelled"),
			);
			await mapLimited(kept, HOST_WORK_CONCURRENCY, (item) =>
				this.lookAtTemp(upload, backend, item),
			);
		} catch (error) {
			upload.busy--;
			if (isInterruption(error)) this.interruptAll(upload, messageOf(error));
			this.notResumed(upload, "host_unreachable", requester);
			return;
		}
		upload.busy--;
		// Discarded meanwhile: nothing of it goes on.
		if (this.uploads.get(upload.id) !== upload) return;
		// Its bytes come from this window from now on.
		upload.source = requester.clientId;
		this.requeueAll(
			upload,
			upload.order
				.map((id) => upload.items[id] as Item)
				.filter(
					(item) =>
						item.state === "failed" || item.state === "cancelled" || item.state === "interrupted",
				),
		);
		this.persist(upload);
		this.settle(upload);
		this.schedulePump();
	}

	/**
	 * A file its window found gone or changed as it resumes (#837): left out,
	 * saying why, or sent again from its first byte with its size and time now,
	 * its temporary removed either way. A placed or skipped file stays as it is.
	 */
	private changedFile(upload: Upload, backend: UploadBackend, file: TransferResumeFile): void {
		const item = upload.items[file.itemId];
		if (item === undefined || item.kind !== "file") return;
		// Placed or skipped, it stays so; one another window is sending is that window's.
		if (!["interrupted", "queued", "conflict", "failed", "cancelled"].includes(item.state)) return;
		if (file.action === "skip") {
			// `skip` removes its temporary, through the backend just taken.
			this.skip(upload, item);
			item.reason = SKIPPED_REASONS[file.why];
			item.code = null;
			this.persist(upload, item);
			return;
		}
		const temp = item.temp;
		this.restartFile(upload, item);
		// Its own bytes only, whatever their name: a direct write is a file that was not there.
		if (temp !== null) void backend.remove(temp).catch(() => {});
		const grown = file.size - item.size;
		const changing = item as { size: number; mtime: number | null };
		changing.size = file.size;
		changing.mtime = file.mtime ?? null;
		if (grown !== 0) {
			for (const totals of this.totalsAbove(upload, item)) totals.bytes += grown;
		}
		item.verification = null;
		upload.dirtyItems.add(item.id);
		this.markFolders(upload, item);
		this.persist(upload, item);
	}

	/** What a resume finds of one temporary, and what it does about it (see `takeUp`). */
	private async lookAtTemp(upload: Upload, backend: UploadBackend, item: Item): Promise<void> {
		const temp = item.temp;
		if (temp === null) return;
		const there = await backend.stat(temp).catch((error: unknown) => {
			if (isInterruption(error)) throw error;
			return null;
		});
		const size = there?.kind === "file" ? (there.size ?? -1) : -1;
		if (item.tempWhole) {
			if (size === item.size) return;
		} else if (item.acked > 0 && size >= item.acked) {
			if (size === item.acked) return;
			const cut = await backend.truncate(temp, item.acked).then(
				() => true,
				(error: unknown) => {
					if (isInterruption(error)) throw error;
					return false;
				},
			);
			if (cut) return;
		}
		// Missing, short, or not what it was: its file starts again. Only a file is removed.
		if (there?.kind === "file") await backend.remove(temp);
		this.restartFile(upload, item);
	}

	/** A resume could not reach the upload's host: it stays interrupted, saying why. */
	private notResumed(
		upload: Upload,
		reason: TransferNotResumedReason,
		requester: TransferRequester,
	): void {
		if (this.uploads.get(upload.id) !== upload) return;
		upload.reason = reason;
		this.persist(upload);
		this.sayState(upload, requester.clientId);
	}

	/**
	 * Drop an upload: what it was doing stops, it is forgotten, its record
	 * marked discarded until its temporaries are removed (`atConnection`).
	 */
	private drop(upload: Upload, requesterId: string | null): void {
		const temps: string[] = [];
		for (const item of upload.items) {
			if (item.kind === "file" && item.temp !== null && item.state !== "placed") {
				temps.push(item.temp);
			}
			const sink = item.sink;
			item.sink = null;
			if (sink !== null && !item.writing) void sink.abort();
			// A write or a placement under way finds it so, and stops there.
			if (UNSETTLED.has(item.state)) item.state = "cancelled";
		}
		upload.queue = [];
		upload.folderQueue = [];
		upload.waiting.clear();
		if (upload.flushTimer !== null) clearTimeout(upload.flushTimer);
		upload.flushTimer = null;
		if (upload.flushSoon !== null) clearImmediate(upload.flushSoon);
		upload.flushSoon = null;
		this.clearForget(upload);
		this.uploads.delete(upload.id);
		this.unsaved.delete(upload.id);
		this.unsavedAcks.delete(upload.id);
		this.releaseBackend(upload);
		this.pendingRemoval.set(upload.id, {
			id: upload.id,
			hostId: upload.hostId,
			hostType: upload.hostType,
			dir: upload.dir,
			style: upload.style,
			temps,
		});
		if (upload.stored) {
			try {
				this.store?.setState(upload.id, "discarded", null, new Date(this.now()).toISOString());
			} catch {
				// Removed from memory all the same; meta.db keeps what it had.
			}
		}
		const message: TransferStateMessage = {
			type: "TRANSFER_STATE",
			transferId: upload.id,
			channelId: upload.channelId,
			hostId: upload.hostId,
			state: "discarded",
		};
		for (const clientId of this.audienceOf(upload, requesterId)) this.deps.send(clientId, message);
		this.noteHost(upload.hostId, upload.hostType);
	}

	/**
	 * What the hub does on a host once it reaches it, one at a time per host:
	 * the temporaries of the uploads dropped there are removed by their
	 * recorded paths, then their records deleted. A connection lost meanwhile
	 * leaves the rest for the next.
	 */
	private atConnection(hostId: string, hostType: string): Promise<void> {
		const before = this.hostWork.get(hostId) ?? Promise.resolve();
		const work = before.then(() => this.removeDropped(hostId, hostType));
		const settled = work.catch(() => {});
		this.hostWork.set(hostId, settled);
		void settled.then(() => {
			if (this.hostWork.get(hostId) === settled) this.hostWork.delete(hostId);
		});
		return settled;
	}

	private async removeDropped(hostId: string, hostType: string): Promise<void> {
		if (this.stopped) return;
		const pending = [...this.pendingRemoval.values()].filter((each) => each.hostId === hostId);
		if (pending.length === 0) return;
		const backend = await this.deps.files.uploadBackend(hostId, hostType);
		try {
			for (const dropped of pending) {
				await mapLimited(dropped.temps, HOST_WORK_CONCURRENCY, (temp) => backend.remove(temp));
				if (backend.lost || this.stopped) return;
				this.pendingRemoval.delete(dropped.id);
				try {
					this.store?.delete(dropped.id);
				} catch {
					// Kept as discarded: the next start removes nothing that is not there.
				}
			}
		} finally {
			backend.release();
		}
	}

	/** Uploads to this host whose link dropped while their window sent them go on. */
	private resumeDropped(hostId: string): void {
		for (const upload of this.uploads.values()) {
			if (upload.hostId !== hostId || upload.source === null) continue;
			if (upload.backend?.lost === true)
				this.interruptAll(upload, "The connection to the host was lost");
			if (!upload.linkDropped) continue;
			void this.takeUp(upload, { clientId: upload.source, tokenId: upload.tokenId });
		}
	}

	/**
	 * Remove from `dir` the temporaries of this hub's naming that no record
	 * knows, and that are older than `SWEEP_MIN_AGE_MS`: what a hub that died
	 * before writing its record left. Only files are removed; a folder or a
	 * link of that name, a name of another shape, or a time the host does not
	 * say is left alone.
	 */
	private async sweep(
		backend: UploadBackend,
		dir: string,
		entries: readonly FileEntry[],
	): Promise<void> {
		const key = (path: string) => (backend.style === "windows" ? path.toUpperCase() : path);
		const known = new Set<string>();
		for (const upload of this.uploads.values()) {
			for (const item of upload.items) if (item.temp !== null) known.add(key(item.temp));
		}
		for (const dropped of this.pendingRemoval.values()) {
			for (const temp of dropped.temps) known.add(key(temp));
		}
		const before = this.now() - SWEEP_MIN_AGE_MS;
		const stale = entries
			.filter((entry) => {
				if (entry.kind !== "file" || !TEMP_NAME.test(entry.name) || entry.mtime === null) {
					return false;
				}
				const mtime = Date.parse(entry.mtime);
				return Number.isFinite(mtime) && mtime < before;
			})
			.map((entry) => joinHostPath(dir, entry.name, backend.style))
			.filter((path) => !known.has(key(path)));
		await mapLimited(stale, HOST_WORK_CONCURRENCY, (path) => backend.remove(path));
	}

	/** Who hears of an upload: every client attached to its terminal, its window, and one more. */
	private audienceOf(upload: Upload, extra: string | null = null): Set<string> {
		const audience = new Set(this.deps.clientsOf(upload.channelId));
		if (upload.source !== null) audience.add(upload.source);
		if (extra !== null) audience.add(extra);
		return audience;
	}

	/** Say the upload's own state, when it is not what was said last. */
	private sayState(upload: Upload, extra: string | null = null): void {
		const now = { state: this.uploadState(upload), reason: upload.reason };
		if (sameState(upload.said, now)) return;
		upload.said = now;
		const message: TransferStateMessage = {
			type: "TRANSFER_STATE",
			transferId: upload.id,
			channelId: upload.channelId,
			hostId: upload.hostId,
			state: now.state,
			...(now.reason !== null ? { reason: now.reason } : {}),
		};
		for (const clientId of this.audienceOf(upload, extra)) this.deps.send(clientId, message);
	}

	private markFolders(upload: Upload, item: Item): void {
		for (let parent = item.parent; parent !== null; parent = upload.items[parent]?.parent ?? null) {
			upload.dirtyFolders.add(parent);
		}
	}

	private markAll(upload: Upload): void {
		upload.dirtyItems.clear();
		upload.dirtyFolders.clear();
	}

	/** How many files and folders of the upload are in any of `states`. */
	private counted(upload: Upload, states: Iterable<TransferItemState>): number {
		let count = 0;
		for (const state of states) {
			count += (upload.totals.states.get(state) ?? 0) + (upload.folderStates.get(state) ?? 0);
		}
		return count;
	}

	/** Whether nothing of the upload is left to send, answer or place. */
	private isSettled(upload: Upload): boolean {
		return upload.busy === 0 && this.counted(upload, UNSETTLED) === 0;
	}

	private isActive(upload: Upload): boolean {
		if (upload.busy > 0 || upload.creatingFolders) return true;
		if (upload.source === null) return false;
		return this.counted(upload, ["queued", "sending", "verifying"]) > 0;
	}

	/**
	 * Say what changed soon, and whether the upload is done; let go of what an
	 * idle one holds. Changes gather for `PROGRESS_FLUSH_MS`, but with `now`,
	 * for a file that started sending, they are said once the work at hand is
	 * done: the window sends a file's bytes only once told, and waiting for the
	 * batch cost every file up to 100 ms, most of a small file's time (#873).
	 */
	private settle(upload: Upload, now = false): void {
		// Its own state is written as it changes: a window that left, its end.
		this.persist(upload);
		if (this.stopped) return;
		if (now) {
			if (upload.flushSoon === null) {
				upload.flushSoon = setImmediate(() => {
					upload.flushSoon = null;
					if (upload.flushTimer !== null) clearTimeout(upload.flushTimer);
					upload.flushTimer = null;
					this.flush(upload);
				});
				upload.flushSoon.unref?.();
			}
			return;
		}
		if (upload.flushTimer === null && upload.flushSoon === null) {
			upload.flushTimer = setTimeout(() => {
				upload.flushTimer = null;
				this.flush(upload);
			}, PROGRESS_FLUSH_MS);
			upload.flushTimer.unref?.();
		}
	}

	private flush(upload: Upload): void {
		if (!this.uploads.has(upload.id)) return;
		const audience = this.audienceOf(upload);
		const say = (message: unknown) => {
			for (const clientId of audience) this.deps.send(clientId, message);
		};
		if (upload.dirtyItems.size > 0 || upload.dirtyFolders.size > 0) {
			const items: TransferItemProgress[] = [...upload.dirtyItems].map((id) =>
				this.progressOf(upload.items[id] as Item),
			);
			const folders: TransferFolderProgress[] = [...upload.dirtyFolders].map((itemId) => ({
				itemId,
				...totalsOnWire(upload.folderTotals.get(itemId) ?? emptyTotals()),
			}));
			upload.dirtyItems.clear();
			upload.dirtyFolders.clear();
			say({
				type: "TRANSFER_PROGRESS",
				transferId: upload.id,
				channelId: upload.channelId,
				items,
				folders,
				totals: totalsOnWire(upload.totals),
			});
		}
		if (upload.conflicts.length > 0) {
			const conflicts = upload.conflicts.splice(0);
			say({
				type: "TRANSFER_CONFLICT",
				transferId: upload.id,
				channelId: upload.channelId,
				items: conflicts,
			});
		}
		const settled = this.isSettled(upload);
		if (settled && !upload.doneSaid) {
			upload.doneSaid = true;
			say({
				type: "TRANSFER_DONE",
				transferId: upload.id,
				channelId: upload.channelId,
				totals: totalsOnWire(upload.totals),
			});
			this.releaseBackend(upload);
			const nothingLeft = upload.items.every(
				(item) => item.state === "placed" || item.state === "skipped",
			);
			if (nothingLeft) this.forgetLater(upload);
		}
		this.sayState(upload);
		if (!this.isActive(upload) && upload.source === null) this.releaseBackend(upload);
		this.noteHost(upload.hostId, upload.hostType);
	}

	/**
	 * Whether a remote host still has an upload running or queued: when the
	 * last one ends, what waited for it is told, once. The local host is not
	 * told: its uploads go through the hub's own file system, which no agent's
	 * retirement touches.
	 */
	private noteHost(hostId: string, hostType: string): void {
		if (hostType === "local") return;
		if (this.activeOn(hostId) > 0) {
			this.activeHosts.add(hostId);
		} else if (this.activeHosts.delete(hostId)) {
			this.deps.onHostIdle(hostId);
		}
	}

	private progressOf(item: Item): TransferItemProgress {
		return {
			itemId: item.id,
			state: item.state,
			...(item.kind === "file" ? { acked: item.acked } : {}),
			...(item.outcome !== null && (item.state === "placed" || item.state === "skipped")
				? { outcome: item.outcome }
				: {}),
			...(item.finalName !== null && item.state === "placed" ? { finalName: item.finalName } : {}),
			...(item.verification !== null && item.state === "placed"
				? { verification: item.verification }
				: {}),
			...(item.reason !== null ? { reason: item.reason } : {}),
			...(item.code !== null ? { code: item.code } : {}),
		};
	}

	private summary(upload: Upload, viewerTokenId: string | null): Record<string, unknown> {
		const device = this.deviceOf(upload, viewerTokenId);
		return {
			transfer_id: upload.id,
			channel_id: upload.channelId,
			host_id: upload.hostId,
			dir: upload.dir,
			on_conflict: upload.onConflict,
			direction: "upload",
			state: this.uploadState(upload),
			...(upload.reason !== null ? { reason: upload.reason } : {}),
			totals: totalsOnWire(upload.totals),
			updated_at: new Date(upload.changedAt).toISOString(),
			from_this_device: device.fromThisDevice,
			...(device.label !== null ? { device_label: device.label } : {}),
		};
	}

	private forgetLater(upload: Upload): void {
		this.clearForget(upload);
		upload.forgetTimer = setTimeout(() => {
			if (this.uploads.get(upload.id) !== upload) return;
			this.uploads.delete(upload.id);
			this.unsaved.delete(upload.id);
			this.unsavedAcks.delete(upload.id);
			if (!upload.stored) return;
			try {
				this.store?.delete(upload.id);
			} catch {
				// The next start deletes it, as done.
			}
		}, FINISHED_KEPT_MS);
		upload.forgetTimer.unref?.();
	}

	private clearForget(upload: Upload): void {
		if (upload.forgetTimer !== null) clearTimeout(upload.forgetTimer);
		upload.forgetTimer = null;
	}
}
