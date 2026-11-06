import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import type { IWsClient } from "../services/ws-client.js";
import {
	attachedChannel,
	type CwdSource,
	clampTransfersShare,
	type LiveCwd,
	type PanelShowing,
	panelShowing,
	type ReaderChoice,
	readerChoiceAfter,
	TRANSFERS_SHARE_DEFAULT,
	writerStatements,
} from "../utils/files-panel.js";
import { useAuthStore } from "./auth.js";
import { useConfigStore } from "./config.js";
import { useWriteLockStore } from "./writelock.js";

/**
 * The files panel beside the panes (#836): one per window, attached to the terminal whose pane
 * has the focus, or to the one it is pinned to, and what it remembers in this browser.
 *
 * Kept per browser (`localStorage`), as how one person works at one screen: whether its own panel
 * is open, its pin, per terminal whether it follows the terminal's directory and the folder
 * browsed when not, a reader's choice, Options expanded or collapsed, the split between Files and
 * Transfers, and Transfers collapsed.
 *
 * The writer's panel is shared (#838). On a terminal this window writes, or with none attached,
 * the panel is the window's own, and it tells the hub whether it is open there (FILES_PANEL); the
 * hub keeps it per terminal and tells every client attached. On a terminal it reads, the panel
 * shows as the reader chose there: following the writer's (floating), closed, or its own (docked).
 *
 * The terminals' live directories (#834) arrive here too: CWD_CHANGE, and the last one in
 * ATTACH_OK and STATE_SYNC. Without a hub that relays them, none arrives, and the panel opens
 * where the hub opens it (the host's fallback folder, else the home).
 */

const STORAGE = {
	open: "lasterm:files:open",
	pin: "lasterm:files:pin",
	terminals: "lasterm:files:terminals",
	readers: "lasterm:files:reader-choices",
	options: "lasterm:files:options",
	split: "lasterm:files:split",
	transfersCollapsed: "lasterm:files:transfers-collapsed",
} as const;

/** How many terminals' follow state and folder are remembered; the oldest go first. */
export const REMEMBERED_TERMINALS = 100;

/** What the panel remembers of a terminal: whether it follows its directory, and where it browsed. */
export interface TerminalFiles {
	readonly following: boolean;
	/** The folder browsed while not following; null for where the panel opens. */
	readonly path: string | null;
}

function read(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function write(key: string, value: string | null): void {
	try {
		if (value === null) localStorage.removeItem(key);
		else localStorage.setItem(key, value);
	} catch {
		// A browser that keeps nothing: the panel still works, it forgets on reload.
	}
}

function readTerminals(): Record<string, TerminalFiles> {
	try {
		const parsed: unknown = JSON.parse(read(STORAGE.terminals) ?? "{}");
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const out: Record<string, TerminalFiles> = {};
		for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
			const { following, path } = (value ?? {}) as { following?: unknown; path?: unknown };
			if (typeof following !== "boolean") continue;
			out[id] = { following, path: typeof path === "string" ? path : null };
		}
		return out;
	} catch {
		return {};
	}
}

/** A reader's choice per terminal, as this browser kept it; `none` is kept as nothing. */
function readReaderChoices(): Record<string, Exclude<ReaderChoice, "none">> {
	try {
		const parsed: unknown = JSON.parse(read(STORAGE.readers) ?? "{}");
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const out: Record<string, Exclude<ReaderChoice, "none">> = {};
		for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (value === "open" || value === "closed") out[id] = value;
		}
		return out;
	} catch {
		return {};
	}
}

/** The oldest entries go first, past the last REMEMBERED_TERMINALS. */
function keepLatest<T>(record: Record<string, T>): Record<string, T> {
	const ids = Object.keys(record);
	for (const id of ids.slice(0, Math.max(0, ids.length - REMEMBERED_TERMINALS))) delete record[id];
	return record;
}

const SOURCES: readonly CwdSource[] = ["shell", "process", "start"];

/**
 * A live directory from the fields a hub message carries (camelCased by the codec): CWD_CHANGE's
 * own, or `cwd`, `cwdSource` and `foreground` in ATTACH_OK and STATE_SYNC. Null when they say
 * nothing: a hub that does not relay it, or an agent that has not said it yet.
 */
export function liveCwdOf(fields: Readonly<Record<string, unknown>>): LiveCwd | null {
	const source = fields.source ?? fields.cwdSource;
	if (typeof source !== "string" || !(SOURCES as readonly string[]).includes(source)) return null;
	const cwd = fields.cwd;
	if (cwd !== null && typeof cwd !== "string") return null;
	return {
		cwd: typeof cwd === "string" && cwd !== "" ? cwd : null,
		source: source as CwdSource,
		...(typeof fields.atPrompt === "boolean" ? { atPrompt: fields.atPrompt } : {}),
		...(typeof fields.foreground === "string" ? { foreground: fields.foreground } : {}),
		...(typeof fields.otherHost === "string" ? { otherHost: fields.otherHost } : {}),
	};
}

export const useFilesPanelStore = defineStore("filesPanel", () => {
	const writeLock = useWriteLockStore();
	const auth = useAuthStore();
	const config = useConfigStore();

	/** Whether this window holds the write lock of `channelId`: its panel there is its own. */
	function writes(channelId: string): boolean {
		return writeLock.isWriter(channelId);
	}

	// ─── Open, attached, pinned ──────────────────────────────────────────

	/**
	 * The window's own panel: open or not, as its user left it. It is what shows on a terminal
	 * this window writes, or with none attached; on one it reads, the reader's choice there decides
	 * (`showing`).
	 */
	const open = ref(read(STORAGE.open) === "true");
	const pinnedChannelId = ref<string | null>(read(STORAGE.pin));
	/** The terminal whose pane has the focus in the tab shown; App.vue says it. */
	const focusedChannelId = ref<string | null>(null);
	/** The terminals some tab of the window shows; App.vue says them. */
	const channelsInTabs = ref<ReadonlySet<string>>(new Set());

	/** The terminal the panel shows: the pinned one while a tab shows it, else the focused one. */
	const attachedChannelId = computed(() =>
		attachedChannel(pinnedChannelId.value, focusedChannelId.value, (id) =>
			channelsInTabs.value.has(id),
		),
	);
	const pinned = computed(
		() => pinnedChannelId.value !== null && pinnedChannelId.value === attachedChannelId.value,
	);

	/** Each request for the panel to take the keyboard; the panel watches it. */
	const keyboardRequests = ref(0);
	/**
	 * A terminal an entry point named whose pane is not the focused one: App.vue focuses its
	 * pane, which attaches the panel to it.
	 */
	const paneRequest = ref<{ channelId: string; at: number } | null>(null);

	function setOpen(value: boolean): void {
		open.value = value;
		write(STORAGE.open, value ? "true" : null);
	}

	function setFocused(channelId: string | null): void {
		focusedChannelId.value = channelId;
	}

	function setChannelsInTabs(ids: ReadonlySet<string>): void {
		channelsInTabs.value = ids;
	}

	// ─── The writer's panel, as the hub keeps it (#838) ──────────────────

	/** Per terminal, whether its writer's panel is open on it: FILES_PANEL, ATTACH_OK, STATE_SYNC. */
	const writerPanels = ref<ReadonlyMap<string, boolean>>(new Map());

	function writerOpenOn(channelId: string | null): boolean {
		return channelId !== null && writerPanels.value.get(channelId) === true;
	}

	/** What the hub says of a terminal's writer panel. */
	function takeWriterPanel(channelId: string, writerOpen: boolean): void {
		if (writerPanels.value.get(channelId) === writerOpen) return;
		const next = new Map(writerPanels.value);
		next.set(channelId, writerOpen);
		writerPanels.value = next;
	}

	// ─── A reader's choice, per terminal, in this browser (#838) ─────────

	const readerChoices = ref<Record<string, Exclude<ReaderChoice, "none">>>(readReaderChoices());

	function readerChoice(channelId: string | null): ReaderChoice {
		return channelId === null ? "none" : (readerChoices.value[channelId] ?? "none");
	}

	/** Kept here only: a reader's choice never reaches the hub, nor anyone else. */
	function setReaderChoice(channelId: string, choice: ReaderChoice): void {
		const next = { ...readerChoices.value };
		// The latest last: the oldest are the first to go.
		delete next[channelId];
		if (choice !== "none") next[channelId] = choice;
		readerChoices.value = keepLatest(next);
		write(
			STORAGE.readers,
			Object.keys(readerChoices.value).length === 0 ? null : JSON.stringify(readerChoices.value),
		);
	}

	// ─── Whether it shows, and whose it is ───────────────────────────────

	/** How the panel would show attached to `channelId`. */
	function showingOn(channelId: string | null): PanelShowing {
		return panelShowing({
			writes: channelId === null ? null : writes(channelId),
			ownOpen: open.value,
			choice: readerChoice(channelId),
			writerOpen: writerOpenOn(channelId),
		});
	}

	/** How the panel shows: the window's own, the writer's followed by a reader, or not at all. */
	const showing = computed(() => showingOn(attachedChannelId.value));
	const shown = computed(() => showing.value !== "hidden");
	/** It shows only because it follows the writer's: it floats, and offers "Dock here". */
	const followsWriter = computed(() => showing.value === "follows");

	/**
	 * Open the panel on `channelId` (the focused terminal when null), with the keyboard in it when
	 * asked. A pin moves to the terminal named; without one, its pane takes the focus. On a terminal
	 * this window reads, opening a panel not shown there follows the writer's when that one is
	 * open, and is the reader's own otherwise (#838).
	 */
	function openFor(channelId: string | null, opts: { keyboard?: boolean } = {}): void {
		const target = channelId ?? attachedChannelId.value;
		if (channelId !== null && channelId !== attachedChannelId.value) {
			if (pinnedChannelId.value !== null) setPin(channelId);
			else paneRequest.value = { channelId, at: (paneRequest.value?.at ?? 0) + 1 };
		}
		if (target !== null && !writes(target) && showingOn(target) === "hidden") {
			setReaderChoice(target, readerChoiceAfter("open", writerOpenOn(target)));
		}
		setOpen(true);
		if (opts.keyboard === true) keyboardRequests.value++;
	}

	/** Close the panel; on a terminal this window reads, it stays closed whatever the writer does. */
	function close(): void {
		const target = attachedChannelId.value;
		if (target !== null && !writes(target)) {
			setReaderChoice(target, readerChoiceAfter("close", writerOpenOn(target)));
		}
		setOpen(false);
	}

	/** "Dock here", on the writer's panel a reader follows: it becomes the reader's own, docked. */
	function dockHere(): void {
		const target = attachedChannelId.value;
		if (target === null || writes(target)) return;
		setReaderChoice(target, readerChoiceAfter("dock", writerOpenOn(target)));
		setOpen(true);
	}

	/** A pane's folder button: open on its terminal, or close when the panel already shows it. */
	function toggleFor(channelId: string): void {
		if (isOpenOn(channelId)) close();
		else openFor(channelId);
	}

	/** Whether the panel shows on `channelId`: its pane's folder button shows pressed. */
	function isOpenOn(channelId: string | null): boolean {
		return channelId !== null && attachedChannelId.value === channelId && shown.value;
	}

	// ─── The writer's window tells the hub (#838) ────────────────────────

	let hub: IWsClient | null = null;

	/** The socket statements go over; the session store hands it over as it connects. */
	function setWsClient(client: IWsClient): void {
		hub = client;
	}

	/**
	 * For each terminal this window writes, whether its own panel is open on it, where the hub has
	 * it otherwise: a panel opened or closed, moved from one terminal to another, or a lock that
	 * came to this window. With file transfer off, the panel is open nowhere.
	 */
	const statements = computed(() =>
		writerStatements({
			written: [...writeLock.locks.keys()].filter(writes),
			attached: attachedChannelId.value,
			ownOpen: config.fileTransferEnabled && open.value,
			hubOpen: writerOpenOn,
		}),
	);

	watch(statements, (list) => {
		if (hub === null || !hub.isConnected) return;
		for (const { channelId, open: panelOpen } of list) {
			try {
				hub.send({ type: "FILES_PANEL", channelId, open: panelOpen });
			} catch {
				// The socket went meanwhile: the window says it again once it holds the lock again.
			}
		}
	});

	// The window's client ids, the current one and those before a reconnect: a lock last held
	// under one of them was this window's own.
	const ownClientIds = new Set<string>();
	watch(
		() => auth.clientId,
		(id) => {
			if (id !== null) ownClientIds.add(id);
		},
		{ immediate: true, flush: "sync" },
	);

	// A reader becoming the writer shares its panel as it is: shown, it stays shown and docks;
	// closed, it stays closed (#838). Not on a lock this window gets back after a reconnect, nor on
	// one it gets on attaching, before anyone else held it: its own panel is as its user left it.
	watch(
		() => {
			const id = attachedChannelId.value;
			return {
				id,
				writes: id !== null && writes(id),
				holder: id === null ? undefined : writeLock.locks.get(id)?.holder,
				shown: shown.value,
			};
		},
		(now, before) => {
			if (now.id === null || now.id !== before.id || !now.writes || before.writes) return;
			if (before.holder === undefined) return;
			if (before.holder !== null && ownClientIds.has(before.holder)) return;
			setOpen(before.shown);
		},
		{ flush: "sync" },
	);

	function setPin(channelId: string | null): void {
		pinnedChannelId.value = channelId;
		write(STORAGE.pin, channelId);
	}

	/** The pin: on the terminal shown now, or off, back to following the focus. */
	function togglePin(): void {
		setPin(pinned.value ? null : attachedChannelId.value);
	}

	// ─── Following, and the folder browsed, per terminal ─────────────────

	const terminals = ref<Record<string, TerminalFiles>>(readTerminals());

	function remember(channelId: string, state: TerminalFiles): void {
		const next = { ...terminals.value };
		// The latest last: the oldest are the first to go.
		delete next[channelId];
		next[channelId] = state;
		const ids = Object.keys(next);
		for (const id of ids.slice(0, Math.max(0, ids.length - REMEMBERED_TERMINALS))) delete next[id];
		terminals.value = next;
		write(STORAGE.terminals, JSON.stringify(next));
	}

	/**
	 * What the panel shows of a terminal: as it was left, or following its directory when the
	 * setting says to (`transfer_follow_cwd`), at the folder it opens at.
	 */
	function terminalFiles(channelId: string, followByDefault: boolean): TerminalFiles {
		return terminals.value[channelId] ?? { following: followByDefault, path: null };
	}

	/** Browse a folder: following pauses, the folder is remembered for the terminal. */
	function browse(channelId: string, path: string): void {
		remember(channelId, { following: false, path });
	}

	/** Follow the terminal's directory again: the toggle, or "Go there". */
	function follow(channelId: string): void {
		remember(channelId, { following: true, path: null });
	}

	// ─── The terminals' live directories (#834) ──────────────────────────

	const liveCwds = ref<ReadonlyMap<string, LiveCwd>>(new Map());

	function setLiveCwd(channelId: string, live: LiveCwd | null): void {
		const next = new Map(liveCwds.value);
		if (live === null) next.delete(channelId);
		else next.set(channelId, live);
		liveCwds.value = next;
	}

	function liveCwdFor(channelId: string | null): LiveCwd | undefined {
		return channelId === null ? undefined : liveCwds.value.get(channelId);
	}

	/** CWD_CHANGE, or ATTACH_OK and a STATE_SYNC entry carrying one: what they say of a terminal. */
	function takeCwd(fields: Readonly<Record<string, unknown>>): void {
		const channelId = fields.channelId;
		if (typeof channelId !== "string") return;
		const live = liveCwdOf(fields);
		if (live !== null) setLiveCwd(channelId, live);
	}

	/** A terminal that ended has no directory any more. */
	function forgetCwd(channelId: string): void {
		if (liveCwds.value.has(channelId)) setLiveCwd(channelId, null);
	}

	// ─── Options, and the split ──────────────────────────────────────────

	const optionsExpanded = ref(read(STORAGE.options) === "true");

	function setOptionsExpanded(value: boolean): void {
		optionsExpanded.value = value;
		write(STORAGE.options, value ? "true" : null);
	}

	const storedShare = read(STORAGE.split);
	const transfersShare = ref(
		storedShare === null ? TRANSFERS_SHARE_DEFAULT : clampTransfersShare(Number(storedShare)),
	);

	function setTransfersShare(share: number): void {
		transfersShare.value = clampTransfersShare(share);
		write(STORAGE.split, String(transfersShare.value));
	}

	function resetTransfersShare(): void {
		transfersShare.value = TRANSFERS_SHARE_DEFAULT;
		write(STORAGE.split, null);
	}

	const transfersCollapsed = ref(read(STORAGE.transfersCollapsed) === "true");

	function setTransfersCollapsed(value: boolean): void {
		transfersCollapsed.value = value;
		write(STORAGE.transfersCollapsed, value ? "true" : null);
	}

	return {
		open,
		pinnedChannelId,
		focusedChannelId,
		channelsInTabs,
		attachedChannelId,
		pinned,
		keyboardRequests,
		paneRequest,
		setOpen,
		setFocused,
		setChannelsInTabs,
		writerPanels,
		writerOpenOn,
		takeWriterPanel,
		readerChoices,
		readerChoice,
		showing,
		shown,
		followsWriter,
		openFor,
		close,
		dockHere,
		toggleFor,
		isOpenOn,
		setWsClient,
		setPin,
		togglePin,
		terminals,
		terminalFiles,
		browse,
		follow,
		liveCwds,
		setLiveCwd,
		liveCwdFor,
		takeCwd,
		forgetCwd,
		optionsExpanded,
		setOptionsExpanded,
		transfersShare,
		setTransfersShare,
		resetTransfersShare,
		transfersCollapsed,
		setTransfersCollapsed,
	};
});
