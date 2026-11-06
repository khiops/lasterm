import { defineStore } from "pinia";
import { computed, ref } from "vue";
import {
	attachedChannel,
	type CwdSource,
	clampTransfersShare,
	type LiveCwd,
	TRANSFERS_SHARE_DEFAULT,
} from "../utils/files-panel.js";

/**
 * The files panel beside the panes (#836): one per window, attached to the terminal whose pane
 * has the focus, or to the one it is pinned to, and what it remembers in this browser.
 *
 * Kept per browser (`localStorage`), as how one person works at one screen: whether it is open,
 * its pin, per terminal whether it follows the terminal's directory and the folder browsed when
 * not, Options expanded or collapsed, the split between Files and Transfers, and Transfers
 * collapsed. Each window owns its open state; the writer's reaching the readers is #838.
 *
 * The terminals' live directories (#834) arrive here too: CWD_CHANGE, and the last one in
 * ATTACH_OK and STATE_SYNC. Without a hub that relays them, none arrives, and the panel opens
 * where the hub opens it (the host's fallback folder, else the home).
 */

const STORAGE = {
	open: "lasterm:files:open",
	pin: "lasterm:files:pin",
	terminals: "lasterm:files:terminals",
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
	// ─── Open, attached, pinned ──────────────────────────────────────────

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

	/**
	 * Open the panel on `channelId` (the focused terminal when null), with the keyboard in it when
	 * asked. A pin moves to the terminal named; without one, its pane takes the focus.
	 */
	function openFor(channelId: string | null, opts: { keyboard?: boolean } = {}): void {
		if (channelId !== null && channelId !== attachedChannelId.value) {
			if (pinnedChannelId.value !== null) setPin(channelId);
			else paneRequest.value = { channelId, at: (paneRequest.value?.at ?? 0) + 1 };
		}
		setOpen(true);
		if (opts.keyboard === true) keyboardRequests.value++;
	}

	function close(): void {
		setOpen(false);
	}

	/** A pane's folder button: open on its terminal, or close when the panel already shows it. */
	function toggleFor(channelId: string): void {
		if (open.value && attachedChannelId.value === channelId) close();
		else openFor(channelId);
	}

	/** Whether the panel is open on `channelId`: its pane's folder button shows pressed. */
	function isOpenOn(channelId: string | null): boolean {
		return open.value && channelId !== null && attachedChannelId.value === channelId;
	}

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
		openFor,
		close,
		toggleFor,
		isOpenOn,
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
