import { createHash, type Hash } from "node:crypto";
import {
	generateId,
	isValidUlid,
	TRANSFER_CONFLICT_ACTIONS,
	TRANSFER_ON_CONFLICT_VALUES,
	type TransferAcceptedItem,
	type TransferCancelMessage,
	type TransferConflictAction,
	type TransferConflictItem,
	type TransferErrorMessage,
	type TransferExisting,
	type TransferFolderConflicts,
	type TransferFolderProgress,
	type TransferItemProgress,
	type TransferItemState,
	type TransferOnConflict,
	type TransferOutcome,
	type TransferResolveMessage,
	type TransferRetryMessage,
	type TransferScope,
	type TransferStartMessage,
	type TransferTotals,
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
import { buildUploadTree, type TreeItem } from "./upload-tree.js";

/** How long the changes of an upload gather before they are said in one TRANSFER_PROGRESS. */
const PROGRESS_FLUSH_MS = 100;

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
	 * host key), as a Connect does; true once it is connected.
	 */
	connect(hostId: string, clientId: string): Promise<boolean>;
	/** Whether uploads to this host are checked by SHA-256 over SSH commands (`transfer_verify`). */
	verifyFor(hostId: string, channelId: string): boolean;
	/** How many files one window sends at once (`[transfer] max_concurrent`). */
	maxConcurrent(): number;
	/** A host's last running upload ended: what waited for it (a retirement, #805) may go on. */
	onHostIdle(hostId: string): void;
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
	doneSaid: boolean;
	forgetTimer: ReturnType<typeof setTimeout> | null;
	/** Placements and other host work under way that no state shows. */
	busy: number;
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
 * In memory only, for now: a hub restart forgets them, their temporaries left
 * on the hosts (#833's second part keeps them in meta.db and resumes them).
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

	constructor(private readonly deps: TransferDeps) {}

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
				if (!reached) {
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
			await this.lookAtDestination(upload);
			this.applyPolicy(upload);
			this.uploads.set(upload.id, upload);
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
			if (!reached) {
				return this.refuseControl(
					requester,
					msg.transferId,
					"HOST_NOT_CONNECTED",
					"This upload's host could not be connected",
				);
			}
		}
		// What it is in comes back first: a file goes into a folder in place.
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
		upload.doneSaid = false;
		this.clearForget(upload);
		this.settle(upload);
		this.schedulePump();
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

	/** The uploads from a terminal, as a client that attached late reads them. */
	listFor(channelId: string): Record<string, unknown>[] {
		return [...this.uploads.values()]
			.filter((upload) => upload.channelId === channelId)
			.map((upload) => this.summary(upload));
	}

	/** One upload, every item with it. */
	describe(transferId: string): Record<string, unknown> | null {
		const upload = this.uploads.get(transferId);
		if (upload === undefined) return null;
		return {
			...this.summary(upload),
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

	/** The hub is stopping: what is being written stops where it is. */
	shutdown(): void {
		this.stopped = true;
		for (const upload of this.uploads.values()) {
			for (const item of upload.items) {
				const sink = item.sink;
				item.sink = null;
				if (sink !== null) void sink.abort();
			}
			if (upload.flushTimer !== null) clearTimeout(upload.flushTimer);
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
		}));
		const upload: Upload = {
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
			items,
			order: tree.order,
			folderTotals: new Map(),
			totals: emptyTotals(),
			folderStates: new Map(),
			source: requester.clientId,
			backend,
			queue: [],
			folderQueue: [],
			creatingFolders: false,
			waiting: new Map(),
			dirtyItems: new Set(),
			dirtyFolders: new Set(),
			conflicts: [],
			flushTimer: null,
			doneSaid: false,
			forgetTimer: null,
			busy: 0,
		};
		for (const item of items) {
			if (item.kind !== "dir") continue;
			upload.folderTotals.set(item.id, emptyTotals());
			upload.folderStates.set("queued", (upload.folderStates.get("queued") ?? 0) + 1);
		}
		for (const item of items) {
			if (item.kind !== "file") continue;
			for (const totals of this.totalsAbove(upload, item)) {
				totals.files++;
				totals.bytes += item.size;
				totals.states.set("queued", (totals.states.get("queued") ?? 0) + 1);
			}
		}
		return upload;
	}

	/**
	 * Find what already has each item's name: each folder of the destination
	 * the upload goes into is listed once, links not followed. On a Windows
	 * host names are matched whatever their case, as NTFS does.
	 */
	private async lookAtDestination(upload: Upload): Promise<void> {
		const backend = upload.backend as UploadBackend;
		const key = (name: string) => (upload.style === "windows" ? name.toUpperCase() : name);
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
		const byPath = new Map(upload.items.map((item) => [item.relPath, item.id]));
		const order = (msg.items as { relPath: string }[]).map((item) => byPath.get(item.relPath) ?? 0);
		for (const id of upload.order) {
			const item = upload.items[id] as Item;
			if (item.state === "failed" || item.state === "cancelled" || item.state === "interrupted") {
				this.requeue(upload, item);
			}
		}
		upload.doneSaid = false;
		this.clearForget(upload);
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
		this.settle(upload);
	}

	private async open(upload: Upload, item: Item): Promise<void> {
		const backend = await this.backendOf(upload);
		const parent = this.parentPath(upload, item);
		const target = joinHostPath(parent, item.finalName ?? item.name, upload.style);
		// A temporary kept from before: it resumes where the host's bytes end.
		if (item.temp !== null && item.acked > 0) {
			const there = await backend.stat(item.temp).catch(() => null);
			const size = there?.kind === "file" ? (there.size ?? -1) : -1;
			const resumable =
				backend.transport === "exec"
					? // Appended to: what it holds must be all the hub sent, and hashed.
						size === item.acked
					: size >= item.acked;
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
				return;
			}
			item.temp = tempPathFor(target, upload.style);
		}
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
		item.tempWhole = true;
		item.hash = null;
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
	}

	/** The connection went: everything of this upload under way stops, resumable. */
	private interruptAll(upload: Upload, reason: string): void {
		if (upload.backend !== null && !upload.backend.lost) return;
		for (const item of upload.items) {
			if (item.state === "sending" || item.state === "queued") this.interrupt(upload, item, reason);
		}
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
		const upload =
			typeof msg.transferId === "string" ? this.uploads.get(msg.transferId) : undefined;
		if (upload === undefined) {
			this.refuseControl(
				requester,
				String(msg.transferId),
				"TRANSFER_NOT_FOUND",
				"No upload has that id",
			);
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
		return upload;
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

	/** Say what changed soon, and whether the upload is done; let go of what an idle one holds. */
	private settle(upload: Upload): void {
		if (upload.flushTimer === null && !this.stopped) {
			upload.flushTimer = setTimeout(() => {
				upload.flushTimer = null;
				this.flush(upload);
			}, PROGRESS_FLUSH_MS);
			upload.flushTimer.unref?.();
		}
	}

	private flush(upload: Upload): void {
		if (!this.uploads.has(upload.id)) return;
		const audience = new Set(this.deps.clientsOf(upload.channelId));
		if (upload.source !== null) audience.add(upload.source);
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

	private summary(upload: Upload): Record<string, unknown> {
		const settled = this.isSettled(upload);
		return {
			transfer_id: upload.id,
			channel_id: upload.channelId,
			host_id: upload.hostId,
			dir: upload.dir,
			on_conflict: upload.onConflict,
			direction: "upload",
			state: settled ? "done" : upload.source === null ? "interrupted" : "running",
			totals: totalsOnWire(upload.totals),
		};
	}

	private forgetLater(upload: Upload): void {
		this.clearForget(upload);
		upload.forgetTimer = setTimeout(() => this.uploads.delete(upload.id), FINISHED_KEPT_MS);
		upload.forgetTimer.unref?.();
	}

	private clearForget(upload: Upload): void {
		if (upload.forgetTimer !== null) clearTimeout(upload.forgetTimer);
		upload.forgetTimer = null;
	}
}
