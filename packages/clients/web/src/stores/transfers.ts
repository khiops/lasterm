import {
	DEFAULT_PROFILE,
	DEFAULT_TRANSFER_CONFIG,
	generateId,
	type HostOs,
	type ProtocolMessage,
	planProfileWrite,
	type TransferAcceptedMessage,
	type TransferConflictAction,
	type TransferConflictMessage,
	type TransferDoneMessage,
	type TransferDrop,
	type TransferErrorMessage,
	type TransferExisting,
	type TransferItemState,
	type TransferOnConflict,
	type TransferProgressMessage,
	type TransferScope,
	type TransferTotals,
} from "@lasterm/shared";
import { defineStore } from "pinia";
import { computed, ref, shallowRef, watch } from "vue";
import type { IWsClient } from "../services/ws-client.js";
import {
	type DesktopBridge,
	type DesktopUploads,
	type QuitPending,
	reportUploadsToDesktop,
} from "../utils/desktop-uploads.js";
import { listHostFiles } from "../utils/host-files.js";
import { hubFetch } from "../utils/hub-fetch.js";
import { hubBaseUrl } from "../utils/hub-url.js";
import { isTauriRuntime } from "../utils/tauri-runtime.js";
import {
	type ConflictScope,
	conflictScopePlan,
	isActive,
	type UploadCounts,
	type UploadItemView,
	type UploadsReport,
	type UploadView,
	uploadsReportOf,
} from "../utils/transfers-view.js";
import {
	countItems as countWalked,
	type DropDecision,
	type DropRefusal,
	type NameProblem,
	startItems,
	walkSummary,
	windowsNameProblems,
	withoutPaths,
} from "../utils/upload-drop.js";
import { defaultHandleStore, type HandleStore, keptRecords } from "../utils/upload-handles.js";
import { pickFiles, pickFolder } from "../utils/upload-pick.js";
import { type ChunkAnswer, putChunk, sendFileBytes } from "../utils/upload-send.js";
import { createUnloadGuard, type UnloadGuard } from "../utils/upload-unload.js";
import {
	type FileSource,
	limitsOf,
	type UploadRoot,
	type WalkCounts,
	type WalkLimits,
	type WalkResult,
	walkRoots,
} from "../utils/upload-walk.js";
import { useAuthStore } from "./auth.js";
import { useChannelsStore } from "./channels.js";
import { useConfigStore } from "./config.js";
import { useFilesPanelStore } from "./files-panel.js";
import { useHostsStore } from "./hosts.js";
import { useToastStore } from "./toast.js";

/**
 * The window's uploads (#837, part of #721): every upload of every terminal this window shows,
 * the ones it sends and the ones it only follows (a reader's, the writer's broadcast; one started
 * before a reload), with the files and handles of those it sends. They belong to the window, not
 * to a pane: closing a pane or a tab, or the terminal ending, stops none of them, and their
 * Retry, Cancel and conflict answers still concern the host and folder they started for.
 *
 * - **Starting**: a drop or a pick is walked and counted (`walkRoots`), confirmed when
 *   `transfer_confirm_drop` says to or when it is large, then TRANSFER_START; its handles go to
 *   IndexedDB (`upload-handles.ts`) for the resume to come.
 * - **Sending**: each file the hub puts in `sending` is sent chunk by chunk from where the host's
 *   bytes end (`upload-send.ts`), at most `[transfer] max_concurrent` at once.
 * - **Following**: TRANSFER_PROGRESS, _CONFLICT and _DONE, to every window attached; a window
 *   that hears of an upload it does not know reads it (`GET /api/transfers/:id`), and one that
 *   comes to show a terminal reads its uploads (`GET /api/transfers?channel_id=`).
 * - **Leaving**: a browser asks before leaving while this window sends (`upload-unload.ts`); the
 *   desktop shell is told what it sends (`desktop-uploads.ts`), asks natively, and may hold a
 *   quit until they end, which Transfers then says.
 */

// ─── What the drop targets need of a terminal ────────────────────────────────

/** A terminal's file-transfer settings, as its pane resolved them, and whether it ended. */
export interface TerminalUploadSettings {
	readonly drop: TransferDrop;
	readonly confirmDrop: boolean;
	readonly onConflict: TransferOnConflict;
	readonly ended: boolean;
}

const DEFAULT_SETTINGS: TerminalUploadSettings = {
	drop: DEFAULT_PROFILE.transferDrop ?? "upload",
	confirmDrop: DEFAULT_PROFILE.transferConfirmDrop ?? true,
	onConflict: DEFAULT_PROFILE.transferOnConflict ?? "ask",
	ended: false,
};

/** Where an upload goes, fixed once shown: the host, the folder, and what that folder is. */
export interface UploadTarget {
	readonly channelId: string;
	readonly hostId: string;
	readonly dir: string;
	/** The terminal's directory, the folder for unknown directories, the panel's, a folder row. */
	readonly origin: "terminal" | "start" | "panel" | "folder";
	/** Where its confirmation shows: over the pane, or in the panel. */
	readonly place: "pane" | "panel";
	readonly paneId: string | null;
	readonly onConflict: TransferOnConflict;
	/** `transfer_confirm_drop`. */
	readonly confirm: boolean;
}

/** A drop or a pick being counted, or waiting for its confirmation. */
export interface PendingUpload {
	readonly id: number;
	target: UploadTarget;
	readonly roots: readonly UploadRoot[];
	phase: "counting" | "ready" | "starting";
	counts: WalkCounts;
	walk: WalkResult | null;
	limits: WalkLimits;
	/** Names a Windows host cannot hold, for the whole tree. */
	problems: NameProblem[];
	summary: string;
	/** What the hub refused the start with, said in the card. */
	error: string | null;
	/** The count takes long enough to show. */
	slow: boolean;
	/** The interrupted upload of the same tree it finishes, by its name; null for a new one. */
	joins: string | null;
}

/** What the window holds of an upload: the view, and how it is kept up. */
interface UploadRecord extends UploadView {
	hostId: string;
	channelId: string;
	dir: string;
	label: string;
	items: UploadItemView[];
	sender: boolean;
	notResumable: boolean;
	seq: number;
	folderConflicts: UploadView["folderConflicts"];
	rate: number;
	totals: UploadCounts;
	/** DONE was said. */
	done: boolean;
	/** item id → index in `items`. */
	index: Map<number, number>;
	samples: { at: number; acked: number }[];
}

function totalsOf(wire: TransferTotals): UploadCounts {
	return { files: wire.files, bytes: wire.bytes, acked: wire.acked, states: { ...wire.states } };
}

function hostLabelOf(hostId: string): string {
	return useHostsStore().hosts.find((host) => host.id === hostId)?.label ?? "its host";
}

function plural(n: number, one: string, many = `${one}s`): string {
	return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

const FILTER_KEY = "lasterm:files:transfers-filter";

function readFilter(): "all" | "terminal" {
	try {
		return localStorage.getItem(FILTER_KEY) === "terminal" ? "terminal" : "all";
	} catch {
		return "all";
	}
}

/** How long a count runs before its card shows, with Cancel. */
const SLOW_COUNT_MS = 400;

export const useTransfersStore = defineStore("transfers", () => {
	let ws: IWsClient | null = null;
	let handles: HandleStore | null = null;
	let put: (
		transferId: string,
		itemId: number,
		offset: number,
		chunk: Blob,
	) => Promise<ChunkAnswer> = putChunk;

	function setWsClient(client: IWsClient): void {
		ws = client;
	}

	function handleStore(): HandleStore {
		handles ??= defaultHandleStore();
		return handles;
	}

	/** For tests: where handles are kept, and how a chunk is sent. */
	function setSeamsForTests(seams: {
		handles?: HandleStore;
		put?: (transferId: string, itemId: number, offset: number, chunk: Blob) => Promise<ChunkAnswer>;
	}): void {
		if (seams.handles !== undefined) handles = seams.handles;
		if (seams.put !== undefined) put = seams.put;
	}

	function send(message: ProtocolMessage): boolean {
		if (ws === null || !ws.isConnected) return false;
		ws.send(message);
		return true;
	}

	// ─── The terminals' settings, as their panes resolve them ────────────

	const settings = ref<ReadonlyMap<string, TerminalUploadSettings>>(new Map());

	function setTerminalSettings(channelId: string, value: TerminalUploadSettings | null): void {
		const next = new Map(settings.value);
		if (value === null) next.delete(channelId);
		else next.set(channelId, value);
		settings.value = next;
	}

	function settingsFor(channelId: string): TerminalUploadSettings {
		return settings.value.get(channelId) ?? DEFAULT_SETTINGS;
	}

	// ─── The uploads ─────────────────────────────────────────────────────

	const records = ref<UploadRecord[]>([]);
	/** The files this window sends, by upload then item: never reactive. */
	const sources = new Map<string, Map<number, FileSource>>();
	const inFlight = new Set<string>();
	/**
	 * Files whose loop ended (all sent, or no longer taken) while the hub still says `sending`:
	 * not started again until its next word on them, or a hidden page would loop on them.
	 */
	const parked = new Set<string>();
	/** What each upload this window sends started as: to start it again, which joins it. */
	const plans = new Map<
		string,
		{ target: UploadTarget; roots: readonly UploadRoot[]; items: ReturnType<typeof withoutPaths> }
	>();
	/** Uploads to join again once the connection is back. */
	const rejoining = new Set<string>();
	let seq = 0;

	const uploads = computed<readonly UploadView[]>(() => records.value);

	function recordOf(transferId: string): UploadRecord | undefined {
		return records.value.find((record) => record.id === transferId);
	}

	function itemOf(record: UploadRecord, itemId: number): UploadItemView | undefined {
		const index = record.index.get(itemId);
		return index === undefined ? undefined : record.items[index];
	}

	function setItem(
		record: UploadRecord,
		itemId: number,
		patch: Partial<UploadItemView>,
	): UploadItemView | undefined {
		const index = record.index.get(itemId);
		if (index === undefined) return undefined;
		const before = record.items[index] as UploadItemView;
		const next = { ...before, ...patch };
		record.items[index] = next;
		return next;
	}

	function addRecord(
		record: Omit<UploadRecord, "index" | "samples" | "seq" | "rate">,
		keepSeq?: number,
	): UploadRecord {
		const full: UploadRecord = {
			...record,
			seq: keepSeq ?? ++seq,
			rate: 0,
			index: new Map(record.items.map((item, i) => [item.itemId, i])),
			samples: [],
		};
		records.value = [...records.value, full];
		return records.value.at(-1) as UploadRecord;
	}

	/** Forget an upload in this window: dismissed, once nothing of it is left to do. */
	function dismiss(transferId: string): void {
		records.value = records.value.filter((record) => record.id !== transferId);
		sources.delete(transferId);
		plans.delete(transferId);
		void handleStore()
			.remove(transferId)
			.catch(() => undefined);
	}

	/** Every upload that is over: placed, skipped, nothing failed or waiting. */
	function dismissFinished(): void {
		for (const record of [...records.value]) {
			if (
				!isActive(record.totals) &&
				(record.totals.states.failed ?? 0) + (record.totals.states.conflict ?? 0) === 0
			) {
				dismiss(record.id);
			}
		}
	}

	function noteRate(record: UploadRecord): void {
		const now = Date.now();
		record.samples.push({ at: now, acked: record.totals.acked });
		while (record.samples.length > 1 && now - (record.samples[0]?.at ?? now) > 5_000)
			record.samples.shift();
		const first = record.samples[0];
		const span = first === undefined ? 0 : (now - first.at) / 1000;
		record.rate =
			first === undefined || span < 0.5
				? 0
				: Math.max(0, (record.totals.acked - first.acked) / span);
	}

	// ─── The hub's messages ──────────────────────────────────────────────

	const answers = new Map<string, (msg: TransferAcceptedMessage | TransferErrorMessage) => void>();

	function onAccepted(msg: TransferAcceptedMessage): void {
		answers.get(msg.requestId)?.(msg);
	}

	function onError(msg: TransferErrorMessage): void {
		if (msg.requestId !== undefined && answers.has(msg.requestId)) {
			answers.get(msg.requestId)?.(msg);
			return;
		}
		if (msg.transferId !== undefined) {
			const record = recordOf(msg.transferId);
			const toast = useToastStore();
			toast.show(
				"error",
				record === undefined ? msg.message : `${record.label}: ${msg.message}`,
				10_000,
			);
		}
	}

	const failedSaid = new Set<string>();

	function onProgress(msg: TransferProgressMessage): void {
		const record = recordOf(msg.transferId);
		if (record === undefined) {
			void adopt(msg.transferId);
			return;
		}
		const failedNow: UploadItemView[] = [];
		for (const change of msg.items) {
			const before = itemOf(record, change.itemId);
			if (before === undefined) continue;
			if (before.state !== change.state) parked.delete(`${record.id}:${change.itemId}`);
			const after = setItem(record, change.itemId, {
				state: change.state,
				...(change.acked !== undefined ? { acked: change.acked } : {}),
				outcome: change.outcome,
				finalName: change.finalName,
				reason: change.reason,
				code: change.code,
				...(change.state !== "conflict" ? { existing: undefined, typeClash: undefined } : {}),
			});
			if (after?.state === "failed" && before.state !== "failed" && after.kind === "file")
				failedNow.push(after);
		}
		record.totals = totalsOf(msg.totals);
		record.done = false;
		noteRate(record);
		if (failedNow.length > 0) sayFailed(record, failedNow);
		pump();
	}

	function onConflict(msg: TransferConflictMessage): void {
		const record = recordOf(msg.transferId);
		if (record === undefined) {
			void adopt(msg.transferId);
			return;
		}
		for (const conflict of msg.items) {
			setItem(record, conflict.itemId, {
				state: "conflict",
				existing: conflict.existing,
				typeClash: conflict.typeClash === true,
			});
		}
	}

	function onDone(msg: TransferDoneMessage): void {
		const record = recordOf(msg.transferId);
		if (record === undefined) return;
		record.totals = totalsOf(msg.totals);
		record.done = true;
		record.rate = 0;
		const states = record.totals.states;
		const left = record.totals.files - (states.placed ?? 0) - (states.skipped ?? 0);
		if (left === 0) {
			void handleStore()
				.remove(record.id)
				.catch(() => undefined);
		}
		// Said when the panel is closed: open, the row says it.
		if (record.sender && left === 0 && !useFilesPanelStore().open) {
			useToastStore().show(
				"info",
				`Uploaded ${plural(states.placed ?? 0, "file")} to ${hostLabelOf(record.hostId)} › ${record.dir}`,
				6_000,
				{ label: "Show", run: () => showTransfers(record.channelId) },
			);
		}
	}

	/** A failure is always said, once per file, whether or not the panel shows it. */
	function sayFailed(record: UploadRecord, items: readonly UploadItemView[]): void {
		const fresh = items.filter((item) => !failedSaid.has(`${record.id}:${item.itemId}`));
		if (fresh.length === 0) return;
		for (const item of fresh) failedSaid.add(`${record.id}:${item.itemId}`);
		const first = fresh[0] as UploadItemView;
		const what =
			fresh.length === 1
				? `${first.relPath}${first.reason !== undefined ? `: ${first.reason}` : ""}`
				: `${plural(fresh.length, "file")} of ${record.label}`;
		useToastStore().show(
			"error",
			`Upload to ${hostLabelOf(record.hostId)} failed: ${what}`,
			10_000,
			{
				label: "Show",
				run: () => showTransfers(record.channelId),
			},
		);
	}

	/** The panel open on the terminal an upload came from, its Transfers part expanded. */
	const expandRequest = ref<{ channelId: string; at: number } | null>(null);

	function showTransfers(channelId: string | null): void {
		const panel = useFilesPanelStore();
		const inTabs = channelId !== null && panel.channelsInTabs.has(channelId);
		panel.openFor(inTabs ? channelId : null);
		panel.setTransfersCollapsed(false);
		if (channelId !== null)
			expandRequest.value = { channelId, at: (expandRequest.value?.at ?? 0) + 1 };
	}

	let registeredOn: IWsClient | null = null;

	function registerHandlers(client: IWsClient): void {
		setWsClient(client);
		if (registeredOn === client) return;
		registeredOn = client;
		client.on("TRANSFER_ACCEPTED", (msg) => {
			if (msg.type === "TRANSFER_ACCEPTED") onAccepted(msg);
		});
		client.on("TRANSFER_ERROR", (msg) => {
			if (msg.type === "TRANSFER_ERROR") onError(msg);
		});
		client.on("TRANSFER_PROGRESS", (msg) => {
			if (msg.type === "TRANSFER_PROGRESS") onProgress(msg);
		});
		client.on("TRANSFER_CONFLICT", (msg) => {
			if (msg.type === "TRANSFER_CONFLICT") onConflict(msg);
		});
		client.on("TRANSFER_DONE", (msg) => {
			if (msg.type === "TRANSFER_DONE") onDone(msg);
		});
		client.onDisconnect(() => {
			// A start waiting for its answer has none to come on this socket.
			for (const [requestId, answer] of [...answers]) {
				answer({
					type: "TRANSFER_ERROR",
					requestId,
					code: "HUB_UNREACHABLE",
					message: "The connection to the hub was lost before it answered",
				});
			}
			// What this window was sending is interrupted at the hub. It still holds the files:
			// once the connection is back, it starts the same tree again, which joins the upload.
			for (const record of records.value) {
				if (record.sender && isActive(record.totals)) rejoining.add(record.id);
				record.sender = false;
			}
			sources.clear();
		});
	}

	// ─── Uploads this window did not start ───────────────────────────────

	const adopting = new Set<string>();

	async function readJson(path: string): Promise<unknown> {
		const auth = useAuthStore();
		const response = await hubFetch(`${hubBaseUrl()}${path}`, {
			headers: { Authorization: `Bearer ${auth.token}` },
		});
		if (!response.ok) return null;
		return response.json();
	}

	/** An upload heard of for the first time: read it whole, as a reader follows it. */
	async function adopt(transferId: string): Promise<void> {
		if (adopting.has(transferId) || recordOf(transferId) !== undefined) return;
		adopting.add(transferId);
		try {
			const body = (await readJson(`/api/transfers/${encodeURIComponent(transferId)}`)) as Record<
				string,
				unknown
			> | null;
			if (body === null || recordOf(transferId) !== undefined) return;
			const items = Array.isArray(body.items) ? (body.items as Record<string, unknown>[]) : [];
			const views: UploadItemView[] = items.map((raw) => ({
				itemId: Number(raw.item_id),
				relPath: String(raw.rel_path ?? ""),
				kind: raw.kind === "dir" ? "dir" : "file",
				size: typeof raw.size === "number" ? raw.size : 0,
				state: String(raw.state) as TransferItemState,
				acked: typeof raw.acked === "number" ? raw.acked : 0,
				outcome:
					typeof raw.outcome === "string" ? (raw.outcome as UploadItemView["outcome"]) : undefined,
				finalName: typeof raw.final_name === "string" ? raw.final_name : undefined,
				reason: typeof raw.reason === "string" ? raw.reason : undefined,
				code: typeof raw.code === "string" ? raw.code : undefined,
				existing: (raw.existing as TransferExisting | null | undefined) ?? undefined,
				typeClash: raw.type_clash === true,
			}));
			const rootNames = views.filter((item) => !item.relPath.includes("/"));
			const totals = body.totals as TransferTotals | undefined;
			addRecord({
				id: transferId,
				hostId: String(body.host_id ?? ""),
				channelId: String(body.channel_id ?? ""),
				dir: String(body.dir ?? ""),
				label: labelOf(
					rootNames.map((item) => ({
						name: item.relPath,
						kind: item.kind === "dir" ? "directory" : "file",
					})),
				),
				items: views,
				sender: false,
				notResumable: false,
				folderConflicts: [],
				totals: totals === undefined ? countFrom(views) : totalsOf(totals),
				done: body.state === "done",
			});
		} catch {
			// Read again at the next message about it.
		} finally {
			adopting.delete(transferId);
		}
	}

	function countFrom(items: readonly UploadItemView[]): UploadCounts {
		const states: Partial<Record<TransferItemState, number>> = {};
		let files = 0;
		let bytes = 0;
		let acked = 0;
		for (const item of items) {
			if (item.kind !== "file") continue;
			files++;
			bytes += item.size;
			acked += item.state === "placed" ? item.size : item.acked;
			states[item.state] = (states[item.state] ?? 0) + 1;
		}
		return { files, bytes, acked, states };
	}

	/** The uploads from a terminal this window comes to show, as the hub holds them. */
	async function readChannel(channelId: string): Promise<void> {
		if (!useConfigStore().fileTransferEnabled) return;
		try {
			const body = (await readJson(
				`/api/transfers?channel_id=${encodeURIComponent(channelId)}`,
			)) as {
				transfers?: { transfer_id?: unknown }[];
			} | null;
			for (const transfer of body?.transfers ?? []) {
				if (typeof transfer.transfer_id === "string") await adopt(transfer.transfer_id);
			}
		} catch {
			// Nothing to show yet.
		}
	}

	// ─── Panes and tabs closing ──────────────────────────────────────────

	let inTabs: ReadonlySet<string> | null = null;

	/**
	 * The terminals some tab shows, after each change: uploads from those that left go on, and
	 * one toast per gesture says so ("2 uploads continue in Transfers · Show"); those that came
	 * have their uploads read.
	 */
	function noteChannelsInTabs(ids: ReadonlySet<string>): void {
		const before = inTabs;
		inTabs = new Set(ids);
		if (before === null) {
			for (const id of ids) void readChannel(id);
			return;
		}
		for (const id of ids) if (!before.has(id)) void readChannel(id);
		const gone = [...before].filter((id) => !ids.has(id));
		if (gone.length === 0) return;
		const running = records.value.filter(
			(record) => gone.includes(record.channelId) && isActive(record.totals),
		);
		if (running.length === 0) return;
		const channelId = running[0]?.channelId ?? null;
		useToastStore().show(
			"info",
			`${plural(running.length, "upload")} continue${running.length === 1 ? "s" : ""} in Transfers`,
			6_000,
			{
				label: "Show",
				run: () => showTransfers(channelId),
			},
		);
	}

	/** The uploads of every terminal some tab shows: once the hub can be asked. */
	function readShownChannels(): void {
		for (const id of inTabs ?? []) void readChannel(id);
	}

	/** Its group says so: its pane closed, or its terminal ended. */
	function originOf(
		upload: Pick<UploadView, "channelId">,
	): "shown" | "pane closed" | "terminal ended" {
		const status = useChannelsStore().statusOf(upload.channelId);
		if (status === "dead" || settings.value.get(upload.channelId)?.ended === true)
			return "terminal ended";
		if (inTabs !== null && !inTabs.has(upload.channelId)) return "pane closed";
		return "shown";
	}

	// ─── Sending ─────────────────────────────────────────────────────────

	function maxConcurrent(): number {
		const configured = useConfigStore().uiConfig.transfer?.maxConcurrent;
		return typeof configured === "number" && configured >= 1
			? configured
			: DEFAULT_TRANSFER_CONFIG.maxConcurrent;
	}

	/** Send every file the hub takes the bytes of now, up to `max_concurrent` at once. */
	function pump(): void {
		const limit = maxConcurrent();
		for (const record of records.value) {
			if (!record.sender) continue;
			const files = sources.get(record.id);
			if (files === undefined) continue;
			for (const item of record.items) {
				if (inFlight.size >= limit) return;
				// Every byte acknowledged (or none to send): the hub verifies and places it.
				if (item.kind !== "file" || item.state !== "sending" || item.acked >= item.size) continue;
				const key = `${record.id}:${item.itemId}`;
				const source = files.get(item.itemId);
				if (inFlight.has(key) || parked.has(key) || source === undefined) continue;
				inFlight.add(key);
				void sendItem(record, item.itemId, source.file).finally(() => {
					inFlight.delete(key);
					// Sent, or no longer taken: not again until the hub says it is sending anew.
					parked.add(key);
					pump();
				});
			}
		}
	}

	async function sendItem(record: UploadRecord, itemId: number, file: Blob): Promise<void> {
		const from = itemOf(record, itemId)?.acked ?? 0;
		const outcome = await sendFileBytes({
			file,
			from,
			put: (offset, chunk) => put(record.id, itemId, offset, chunk),
			onAcked: (acked) => {
				const item = itemOf(record, itemId);
				if (item !== undefined && item.state === "sending" && acked > item.acked)
					setItem(record, itemId, { acked });
			},
			stopped: () => !record.sender || itemOf(record, itemId)?.state !== "sending",
		});
		if (outcome.kind !== "failed") return;
		// It holds a place at the hub while it is `sending`: given up here, it is cancelled there,
		// and a Retry sends it again.
		const item = setItem(record, itemId, { reason: outcome.message });
		send({ type: "TRANSFER_CANCEL", transferId: record.id, scope: itemId });
		if (item !== undefined) sayFailed(record, [{ ...item, reason: outcome.message }]);
	}

	/**
	 * The connection is back, authenticated: the hub interrupted what this window was sending
	 * when it left. The same tree to the same folder joins each upload again (PROTOCOL.md § 4.19),
	 * placed files skipped and interrupted ones resumed.
	 */
	function rejoin(): void {
		for (const transferId of [...rejoining]) {
			rejoining.delete(transferId);
			const plan = plans.get(transferId);
			const record = recordOf(transferId);
			if (plan === undefined || record === undefined) continue;
			void start({ ...plan.target, dir: record.dir }, plan.roots, plan.items).then((refused) => {
				if (typeof refused !== "string")
					useToastStore().show("error", `${record.label}: ${refused.message}`, 10_000);
			});
		}
	}

	// ─── Retry, Cancel, the conflicts ────────────────────────────────────

	function retry(transferId: string, scope: TransferScope): void {
		for (const key of [...failedSaid]) if (key.startsWith(`${transferId}:`)) failedSaid.delete(key);
		send({ type: "TRANSFER_RETRY", transferId, scope });
	}

	function cancel(transferId: string, scope: TransferScope): void {
		send({ type: "TRANSFER_CANCEL", transferId, scope });
	}

	/**
	 * Answer the conflicts under `scope`. "Always do this" saves the answer first, for the
	 * upload's own host (the panel may show another by now) or everywhere, through the scoped
	 * write of #835; this time only, it saves nothing.
	 */
	async function resolve(
		transferId: string,
		scope: TransferScope,
		action: TransferConflictAction,
		always: ConflictScope = "once",
	): Promise<boolean> {
		const record = recordOf(transferId);
		if (record === undefined) return false;
		let saved = true;
		if (always !== "once") {
			const configStore = useConfigStore();
			const layers =
				(await configStore.readProfileLayers({
					hostId: record.hostId,
					channelId: record.channelId,
				})) ?? {};
			const plan = conflictScopePlan(action, always, record, layers);
			saved = plan === null ? false : await configStore.saveProfileWrite(plan);
			if (!saved)
				useToastStore().show(
					"error",
					"The answer could not be saved: it holds this time only",
					8_000,
				);
		}
		send({ type: "TRANSFER_RESOLVE", transferId, scope, action });
		return saved;
	}

	// ─── Starting: walk, confirm, start ──────────────────────────────────

	const pending = ref<PendingUpload | null>(null);
	let pendingSeq = 0;
	let pendingAbort: AbortController | null = null;

	/** The card shows: while a long count runs, and when there is something to ask or say. */
	const pendingShown = computed(() => {
		const p = pending.value;
		if (p === null) return false;
		if (p.phase === "counting") return p.slow || p.target.confirm;
		return (
			p.target.confirm ||
			p.limits.warn ||
			p.limits.refuse ||
			p.problems.length > 0 ||
			p.error !== null ||
			p.phase === "starting"
		);
	});

	function hostOsOf(hostId: string): HostOs | null {
		return useHostsStore().hosts.find((host) => host.id === hostId)?.os ?? null;
	}

	function labelOf(roots: readonly { name: string; kind: "file" | "directory" }[]): string {
		if (roots.length === 1 && roots[0] !== undefined)
			return `${roots[0].name}${roots[0].kind === "directory" ? "/" : ""}`;
		return plural(roots.length, "item");
	}

	/**
	 * An upload of this tree to this host that no window sends now, with files still to place: one
	 * this window lists after a reload, which a re-drop finishes. Compared by relative paths, kinds
	 * and sizes; the hub compares the times too.
	 */
	function interruptedLike(
		hostId: string,
		items: readonly { relPath: string; kind: "file" | "dir"; size?: number }[],
	): UploadRecord | undefined {
		const signature = (list: readonly { relPath: string; kind: string; size?: number }[]) =>
			list
				.map(
					(item) =>
						`${item.relPath}\u0000${item.kind}\u0000${item.kind === "dir" ? 0 : (item.size ?? 0)}`,
				)
				.sort()
				.join("\u0001");
		const wanted = signature(items);
		return records.value.find(
			(record) =>
				!record.sender &&
				record.hostId === hostId &&
				record.items.some(
					(item) => item.kind === "file" && item.state !== "placed" && item.state !== "skipped",
				) &&
				signature(record.items) === wanted,
		);
	}

	/**
	 * Upload what was dropped or picked to `target`: counted first, with Cancel; then confirmed,
	 * or started at once when nothing needs asking.
	 */
	async function begin(target: UploadTarget, roots: readonly UploadRoot[]): Promise<void> {
		if (roots.length === 0) return;
		pendingAbort?.abort();
		const abort = new AbortController();
		pendingAbort = abort;
		const id = ++pendingSeq;
		pending.value = {
			id,
			target,
			roots,
			phase: "counting",
			counts: { files: 0, folders: 0, emptyFolders: 0, hidden: 0, bytes: 0 },
			walk: null,
			limits: { refuse: false, warn: false },
			problems: [],
			summary: "",
			error: null,
			slow: false,
			joins: null,
		};
		const slowTimer = setTimeout(() => {
			if (pending.value?.id === id) pending.value.slow = true;
		}, SLOW_COUNT_MS);
		const walk = await walkRoots(roots, {
			signal: abort.signal,
			onProgress: (counts) => {
				if (pending.value?.id === id) pending.value.counts = counts;
			},
		});
		clearTimeout(slowTimer);
		const current = pending.value;
		if (current === null || current.id !== id || walk.cancelled) return;
		current.walk = walk;
		current.counts = { ...walk.counts };
		current.limits = limitsOf(walk);
		// The same tree as an upload no window sends any more (a reload lost its files): it goes to
		// that upload's folder, which the hub then joins (PROTOCOL.md § 4.19).
		const kept = interruptedLike(target.hostId, walk.items);
		if (kept !== undefined) {
			current.target = { ...current.target, dir: kept.dir, origin: "folder" };
			current.joins = kept.label;
		}
		current.problems =
			hostOsOf(target.hostId) === "windows"
				? windowsNameProblems(current.target.dir, walk.items)
				: [];
		current.summary = walkSummary(roots, walk.counts, walk.skipped);
		current.phase = "ready";
		if (!pendingShown.value) await confirmPending();
	}

	/** Cancel: the count stops, nothing is sent, and the card goes. */
	function cancelPending(): void {
		pendingAbort?.abort();
		pendingAbort = null;
		pending.value = null;
	}

	/** Change where it goes ("Choose folder…"), before it starts. */
	function retargetPending(dir: string): void {
		const p = pending.value;
		if (p === null || dir.trim() === "") return;
		p.target = { ...p.target, dir: dir.trim(), origin: "folder" };
		if (p.walk !== null && hostOsOf(p.target.hostId) === "windows")
			p.problems = windowsNameProblems(p.target.dir, p.walk.items);
		p.error = null;
	}

	/**
	 * Upload: what was counted, without the names a Windows host refuses ("Skip those"), and with
	 * "Don't ask again" saved for the host or everywhere first.
	 */
	async function confirmPending(
		options: { skipProblems?: boolean; dontAskAgain?: "host" | "global" | null } = {},
	): Promise<void> {
		const p = pending.value;
		if (p === null || p.walk === null || p.limits.refuse || p.phase === "starting") return;
		if (p.problems.length > 0 && options.skipProblems !== true) return;
		const items = withoutPaths(
			p.walk.items,
			p.problems.map((problem) => problem.relPath),
		);
		if (countWalked(items).files + countWalked(items).folders === 0) {
			cancelPending();
			return;
		}
		if (options.dontAskAgain === "host" || options.dontAskAgain === "global") {
			const target = { hostId: p.target.hostId, channelId: p.target.channelId };
			const configStore = useConfigStore();
			const layers = (await configStore.readProfileLayers(target)) ?? {};
			const plan = planProfileWrite(
				"transferConfirmDrop",
				false,
				options.dontAskAgain,
				target,
				layers,
			);
			if (plan !== null) void configStore.saveProfileWrite(plan);
		}
		p.phase = "starting";
		const answer = await start(p.target, p.roots, items);
		if (pending.value?.id !== p.id) {
			// Cancelled while the hub was starting it: what it started stops at once.
			if (typeof answer === "string") cancel(answer, "upload");
			return;
		}
		if (typeof answer === "string") {
			pending.value = null;
			return;
		}
		p.phase = "ready";
		p.error = answer.message;
		if (answer.names !== undefined && answer.names.length > 0) {
			p.problems = answer.names.map((name) => ({ relPath: name.relPath, reason: name.reason }));
		}
	}

	/** TRANSFER_START, and its answer: the upload's id once accepted, the refusal otherwise. */
	async function start(
		target: UploadTarget,
		roots: readonly UploadRoot[],
		items: ReturnType<typeof withoutPaths>,
	): Promise<string | TransferErrorMessage> {
		const requestId = generateId();
		const answered = new Promise<TransferAcceptedMessage | TransferErrorMessage>(
			(resolveAnswer) => {
				answers.set(requestId, resolveAnswer);
			},
		);
		const sent = send({
			type: "TRANSFER_START",
			requestId,
			channelId: target.channelId,
			dir: target.dir,
			items: startItems(items),
			onConflict: target.onConflict,
		});
		if (!sent) {
			answers.delete(requestId);
			return {
				type: "TRANSFER_ERROR",
				requestId,
				code: "HUB_UNREACHABLE",
				message: "Not connected to the hub",
			};
		}
		const answer = await answered;
		answers.delete(requestId);
		if (answer.type === "TRANSFER_ERROR") return answer;
		accepted(answer, target, roots, items);
		return answer.transferId;
	}

	function accepted(
		msg: TransferAcceptedMessage,
		target: UploadTarget,
		roots: readonly UploadRoot[],
		items: ReturnType<typeof withoutPaths>,
	): void {
		const views: UploadItemView[] = [];
		const files = new Map<number, FileSource>();
		const kept: Parameters<typeof keptRecords>[2][number][] = [];
		for (const [i, answer] of msg.items.entries()) {
			const item = items[i];
			if (item === undefined) continue;
			views.push({
				itemId: answer.itemId,
				relPath: item.relPath,
				kind: item.kind,
				size: item.size ?? 0,
				state: answer.state,
				acked: 0,
				existing: answer.existing,
				typeClash: answer.typeClash === true,
				mtime: item.mtime,
			});
			if (item.source !== undefined) {
				files.set(answer.itemId, item.source);
				kept.push({
					itemId: answer.itemId,
					relPath: item.relPath,
					root: item.source.root,
					pathInRoot: item.source.pathInRoot,
					size: item.source.file.size,
					lastModified: item.source.file.lastModified,
				});
			}
		}
		const existing = recordOf(msg.transferId);
		if (existing !== undefined) {
			// A re-drop, or this window again after its connection came back, joined an upload it
			// lists already: it sends it now, in the same place in the list.
			records.value = records.value.filter((record) => record.id !== msg.transferId);
		}
		const record = addRecord(
			{
				id: msg.transferId,
				hostId: msg.hostId,
				channelId: msg.channelId,
				dir: msg.dir,
				label: labelOf(roots),
				items: views,
				sender: true,
				notResumable: roots.some((root) => root.notResumable !== null),
				folderConflicts: msg.folderConflicts,
				totals: countFrom(views),
				done: false,
			},
			existing?.seq,
		);
		sources.set(record.id, files);
		for (const key of [...parked]) if (key.startsWith(`${record.id}:`)) parked.delete(key);
		const records_ = keptRecords(
			{
				transferId: record.id,
				hostId: record.hostId,
				channelId: record.channelId,
				dir: record.dir,
				savedAt: Date.now(),
			},
			roots.map((root) => ({ name: root.name, kind: root.kind, handle: root.handle })),
			kept,
		);
		if (records_ !== null) {
			void handleStore()
				.save(records_.upload, records_.items)
				.catch((error: unknown) =>
					console.warn("[transfers] could not keep the upload's handles:", error),
				);
		}
		plans.set(record.id, { target, roots, items });
		pump();
	}

	// ─── Drag and drop: what the overlays show ───────────────────────────

	/** A drag over a drop target now: what the overlay says. */
	const dropHover = ref<{
		readonly paneId: string | null;
		readonly channelId: string;
		readonly place: "pane" | "panel";
		readonly folder: string | null;
		readonly decision: DropDecision;
		readonly count: number | null;
		readonly dir: string | null;
		readonly origin: UploadTarget["origin"];
	} | null>(null);

	/** A refused drop let go over its target: "Request write" is offered there for a moment. */
	const refusal = ref<{
		paneId: string | null;
		channelId: string;
		reason: DropRefusal;
		at: number;
	} | null>(null);
	let refusalTimer: ReturnType<typeof setTimeout> | null = null;

	function setDropHover(value: typeof dropHover.value): void {
		dropHover.value = value;
	}

	function noteRefusal(paneId: string | null, channelId: string, reason: DropRefusal): void {
		refusal.value = { paneId, channelId, reason, at: Date.now() };
		if (refusalTimer !== null) clearTimeout(refusalTimer);
		refusalTimer = setTimeout(() => {
			refusal.value = null;
		}, 8_000);
	}

	function clearRefusal(): void {
		refusal.value = null;
	}

	/**
	 * Where a drop on a terminal goes: its directory as the hub last said it (#834), else the
	 * folder its panel opens at, the host's folder for unknown directories or its home. Read when
	 * the drag comes over it, and fixed once shown.
	 */
	async function terminalDestination(
		channelId: string,
	): Promise<{ dir: string; origin: "terminal" | "start" } | null> {
		const live = useFilesPanelStore().liveCwdFor(channelId);
		if (live?.cwd !== null && live?.cwd !== undefined) return { dir: live.cwd, origin: "terminal" };
		const listing = await listHostFiles(channelId, undefined, false);
		return listing.ok ? { dir: listing.value.path, origin: "start" } : null;
	}

	/**
	 * "Upload files…", "Upload folder…", the palette's and the pane's: the picker first, while
	 * the click's activation lasts, then the destination (the terminal's directory unless a folder
	 * is given), then as a drop.
	 */
	async function pickAndUpload(
		kind: "files" | "folder",
		where: {
			channelId: string;
			paneId: string | null;
			dir: string | null;
			place: "pane" | "panel";
		},
	): Promise<void> {
		let roots: UploadRoot[];
		try {
			roots = kind === "files" ? await pickFiles() : await pickFolder();
		} catch (error) {
			useToastStore().show(
				"error",
				`The picker failed: ${error instanceof Error ? error.message : String(error)}`,
				8_000,
			);
			return;
		}
		if (roots.length === 0) return;
		const hostId = useChannelsStore().channelHostMap.get(where.channelId);
		const found =
			where.dir !== null
				? { dir: where.dir, origin: "panel" as const }
				: await terminalDestination(where.channelId);
		if (found === null || hostId === undefined) {
			useToastStore().show(
				"error",
				"Nothing was uploaded: the folder to upload to could not be read on this terminal's host",
				8_000,
			);
			return;
		}
		const settings = settingsFor(where.channelId);
		await begin(
			{
				channelId: where.channelId,
				hostId,
				dir: found.dir,
				origin: found.origin,
				place: where.place,
				paneId: where.paneId,
				onConflict: settings.onConflict,
				confirm: settings.confirmDrop,
			},
			roots,
		);
	}

	// ─── The filter, and what the window tells the shell ─────────────────

	const filter = ref<"all" | "terminal">(readFilter());

	function setFilter(value: "all" | "terminal"): void {
		filter.value = value;
		try {
			if (value === "all") localStorage.removeItem(FILTER_KEY);
			else localStorage.setItem(FILTER_KEY, value);
		} catch {
			// Forgotten at the next reload.
		}
	}

	/** This window's uploads as the desktop shell counts them: only those it sends. */
	const report = computed<UploadsReport>(() => uploadsReportOf(records.value));

	/** This window sends uploads that are not over: leaving would stop them. */
	const sendingHere = computed(() => report.value.inProgress > 0);

	/** The quit, or restart, the desktop shell holds until these uploads end (#863). */
	const quitPending = ref<QuitPending>(null);

	let guard: UnloadGuard | null = null;
	let desktop: DesktopUploads | null = null;
	const guardStop = shallowRef<(() => void) | null>(null);

	/**
	 * Ask before leaving while this window sends (a browser), and tell the desktop shell what it
	 * sends (the desktop). Once per window; returns what stops both.
	 */
	function startWindowGuards(bridge?: Promise<DesktopBridge> | null): () => void {
		if (guardStop.value !== null) return guardStop.value;
		if (!isTauriRuntime() && bridge === undefined) guard = createUnloadGuard(window);
		const stopWatch = watch(sendingHere, (sending) => guard?.set(sending), { immediate: true });
		const read = () => report.value;
		const onPending = (pending: QuitPending) => {
			const before = quitPending.value;
			quitPending.value = pending;
			// The window went to the tray for it: once shown again, Transfers says it at once.
			if (pending !== null && before === null) showTransfers(null);
		};
		desktop =
			bridge === undefined
				? reportUploadsToDesktop(read, onPending)
				: reportUploadsToDesktop(read, onPending, bridge);
		const stop = () => {
			stopWatch();
			guard?.release();
			guard = null;
			desktop?.stop();
			desktop = null;
			guardStop.value = null;
		};
		guardStop.value = stop;
		return stop;
	}

	/** "Cancel" on "Lasterm will quit when these uploads end": the app stays. */
	async function cancelQuitWhenFinished(): Promise<boolean> {
		if (desktop === null) return false;
		return desktop.cancelQuit();
	}

	return {
		uploads,
		pending,
		pendingShown,
		dropHover,
		refusal,
		filter,
		report,
		sendingHere,
		quitPending,
		cancelQuitWhenFinished,
		expandRequest,
		setWsClient,
		registerHandlers,
		setSeamsForTests,
		setTerminalSettings,
		settingsFor,
		begin,
		cancelPending,
		confirmPending,
		retargetPending,
		retry,
		cancel,
		resolve,
		dismiss,
		dismissFinished,
		noteChannelsInTabs,
		readShownChannels,
		originOf,
		showTransfers,
		setDropHover,
		noteRefusal,
		clearRefusal,
		terminalDestination,
		pickAndUpload,
		setFilter,
		startWindowGuards,
		rejoin,
		pump,
	};
});
