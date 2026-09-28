import { computed, ref } from "vue";
import { useAuthStore } from "../stores/auth.js";
import { useChannelsStore } from "../stores/channels.js";
import { useHostsStore } from "../stores/hosts.js";
import { useProfilesStore } from "../stores/profiles.js";
import { useWriteLockStore } from "../stores/writelock.js";
import { formatConnectionString } from "../utils/host-display.js";
import { useHostRows } from "./useHostRows.js";
import { useLayout } from "./useLayout.js";
import { useRecentPaletteItems } from "./useRecentPaletteItems.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type PaletteItemType = "host" | "channel" | "action" | "profile";

export interface PaletteItem {
	id: string;
	label: string;
	description?: string | undefined; // connection info, action description (SC-20)
	type: PaletteItemType;
	icon: string;
	/** URL for image-type host icons (overrides icon text when set) */
	iconUrl?: string | undefined;
	shortcut?: string;
	/** Opaque payload used by execute() */
	payload?: unknown;
	/** A host's heading in the rail — "Local", its group, "Ungrouped" — which the list shows it under (#625). */
	section?: string;
}

/** How a chosen item is acted on: Shift+Enter on a host only switches to it (#625). */
export interface ExecuteOptions {
	switchOnly?: boolean;
}

/**
 * The results in the order they are shown, which ↑ and ↓ follow: each type
 * together, the types in the order of their best match, and the hosts in the
 * rail's order under its headings (#625). Within the other types, the best
 * match first.
 */
export function arrangeForDisplay(
	items: readonly PaletteItem[],
	hostOrder: ReadonlyMap<string, number>,
): PaletteItem[] {
	const blocks = new Map<PaletteItemType, PaletteItem[]>();
	for (const item of items) {
		const block = blocks.get(item.type);
		if (block === undefined) blocks.set(item.type, [item]);
		else block.push(item);
	}
	const rank = (item: PaletteItem): number =>
		hostOrder.get(item.payload as string) ?? Number.MAX_SAFE_INTEGER;
	blocks.get("host")?.sort((a, b) => rank(a) - rank(b));
	return [...blocks.values()].flat();
}

/** A line of the palette's list: a heading, or a result with its index in `results`. */
export type PaletteRow =
	| { kind: "heading"; key: string; label: string; sub: boolean }
	| { kind: "item"; key: string; item: PaletteItem; index: number };

/** What a block of results is headed by. */
export function paletteGroupLabel(group: PaletteItemType | "recent"): string {
	switch (group) {
		case "recent":
			return "Recent";
		case "host":
			return "Hosts";
		case "channel":
			return "Channels";
		case "action":
			return "Actions";
		case "profile":
			return "Profiles";
	}
}

/**
 * The palette's list as shown: the recent items first under "Recent", then
 * each type under its heading, and the hosts under their rail headings too
 * (#625). `results` is already in this order (`arrangeForDisplay`), so a row's
 * index is its place for ↑ and ↓.
 */
export function paletteRows(results: readonly PaletteItem[], recentCount: number): PaletteRow[] {
	const rows: PaletteRow[] = [];
	let group: PaletteItemType | "recent" | null = null;
	let section: string | null = null;
	results.forEach((item, index) => {
		const inRecent = index < recentCount;
		const itemGroup = inRecent ? "recent" : item.type;
		if (itemGroup !== group) {
			rows.push({
				kind: "heading",
				key: `group:${itemGroup}`,
				label: paletteGroupLabel(itemGroup),
				sub: false,
			});
			group = itemGroup;
			section = null;
		}
		if (
			!inRecent &&
			item.type === "host" &&
			item.section !== undefined &&
			item.section !== section
		) {
			rows.push({ kind: "heading", key: `section:${index}`, label: item.section, sub: true });
			section = item.section;
		}
		rows.push({ kind: "item", key: item.id, item, index });
	});
	return rows;
}

// ─── Fuzzy Scoring Constants (INV-08) ─────────────────────────────────────────

const EXACT_MATCH_SCORE = 1000;
const PREFIX_MATCH_SCORE = 500;
const SUBSTRING_MATCH_SCORE = 200;
const FUZZY_MATCH_BASE = 10;
const WORD_BOUNDARY_BONUS = 20;

/**
 * Character-by-character fuzzy match. No regex on user input (INV-08).
 * Returns 0 for no match, higher scores for better matches (SC-15).
 * Scores are deterministic for the same (query, text) pair (INV-04).
 */
export function fuzzyMatch(query: string, text: string): number {
	if (!query) return 0;
	const q = query.toLowerCase();
	const t = text.toLowerCase();

	// Exact match
	if (t === q) return EXACT_MATCH_SCORE;

	// Prefix match
	if (t.startsWith(q)) return PREFIX_MATCH_SCORE + q.length;

	// Substring match
	const subIdx = t.indexOf(q);
	if (subIdx !== -1) return SUBSTRING_MATCH_SCORE + (100 - subIdx);

	// Fuzzy: character-by-character
	let score = 0;
	let qi = 0;
	for (let ti = 0; ti < t.length && qi < q.length; ti++) {
		if (t[ti] === q[qi]) {
			score += FUZZY_MATCH_BASE + (100 - ti);
			// Word boundary bonus (SC-19b)
			if (ti === 0 || t[ti - 1] === "-" || t[ti - 1] === "_" || t[ti - 1] === ".") {
				score += WORD_BOUNDARY_BONUS;
			}
			qi++;
		}
	}

	// All query chars must be found
	return qi === q.length ? score : 0;
}

// ─── Prefix parsing (INV-06) ──────────────────────────────────────────────────

interface PrefixResult {
	prefix: PaletteItemType | null;
	searchQuery: string;
}

function parsePrefix(raw: string): PrefixResult {
	if (raw.startsWith(">")) return { prefix: "action", searchQuery: raw.slice(1).trim() };
	if (raw.startsWith("@")) return { prefix: "host", searchQuery: raw.slice(1).trim() };
	if (raw.startsWith("#")) return { prefix: "channel", searchQuery: raw.slice(1).trim() };
	if (raw.startsWith("~")) return { prefix: "profile", searchQuery: raw.slice(1).trim() };
	return { prefix: null, searchQuery: raw.trim() };
}

// ─── Internal scored item ─────────────────────────────────────────────────────

interface ScoredItem {
	item: PaletteItem;
	score: number;
}

// ─── Module-level singleton state (one palette across the whole app) ──────────

const isOpen = ref(false);
const query = ref("");
const selectedIndex = ref(0);

// Module-level callback for external actions (add-host, settings, etc.)
const onExternalAction = ref<((actionId: string) => void) | null>(null);

// Module-level callback that opens a new tab with a terminal on a host (#625):
// the layout that holds the tabs is App.vue's.
const onOpenHost = ref<((hostId: string) => void) | null>(null);

// ─── Composable ───────────────────────────────────────────────────────────────

export function useCommandPalette() {
	const hostsStore = useHostsStore();
	const channelsStore = useChannelsStore();
	const writeLockStore = useWriteLockStore();
	const _authStore = useAuthStore();
	const profilesStore = useProfilesStore();
	const layout = useLayout();
	const hostRows = useHostRows();
	const { recentIds, pushRecent } = useRecentPaletteItems();

	// ── Result computation ────────────────────────────────────────────────────

	const results = computed<PaletteItem[]>(() => {
		const raw = query.value;
		const { prefix, searchQuery } = parsePrefix(raw);
		const q = searchQuery.toLowerCase();

		// Determine current write-lock state for the active channel.
		const activeChannelId = channelsStore.selectedChannelId;
		const holdsLock = activeChannelId !== null && writeLockStore.isWriter(activeChannelId);

		const scored: ScoredItem[] = [];

		// ── Hosts (SC-16, SC-19) ──────────────────────────────────────────────
		if (prefix === null || prefix === "host") {
			for (const h of hostsStore.sortedHosts) {
				// Search both label and sshHost (SC-19)
				const searchText = h.label + (h.sshHost ? ` ${h.sshHost}` : "");
				const score = q ? fuzzyMatch(q, searchText) : 1;
				if (score > 0) {
					// Build description (SC-20)
					const desc = h.type === "ssh" ? formatConnectionString(h) : "Local";
					const hostIcon = h.iconType === "emoji" && h.iconValue ? h.iconValue : "🖥";
					const hostIconUrl = h.iconType === "image" && h.iconValue ? h.iconValue : undefined;
					const section = hostRows.railSectionName.value.get(h.id);
					scored.push({
						item: {
							id: `host:${h.id}`,
							label: h.label,
							description: desc || undefined,
							type: "host",
							icon: hostIcon,
							...(hostIconUrl !== undefined && { iconUrl: hostIconUrl }),
							payload: h.id,
							...(section !== undefined && { section }),
						},
						score,
					});
				}
			}
		}

		// ── Channels (SC-18) ──────────────────────────────────────────────────
		if (prefix === null || prefix === "channel") {
			for (const c of channelsStore.channels) {
				// The name the tab and the sidebar show, which a rename sets; `title` is
				// only that rename, so without one every terminal read "Terminal <id>".
				const title = c.displayTitle ?? c.title ?? `Terminal ${c.id.slice(-8)}`;
				const score = q ? fuzzyMatch(q, title) : 1;
				if (score > 0) {
					scored.push({
						item: {
							id: `channel:${c.id}`,
							label: title,
							type: "channel",
							icon: "📟",
							payload: c.id,
						},
						score,
					});
				}
			}
		}

		// ── Actions (SC-17, SC-22, SC-23) ────────────────────────────────────
		if (prefix === null || prefix === "action") {
			const actions: PaletteItem[] = [
				{
					id: "action:new-channel",
					label: "New Channel",
					type: "action",
					icon: "⊕",
					shortcut: "Ctrl+T",
				},
				{
					id: "action:split-right",
					label: "Split Right",
					type: "action",
					icon: "⬌",
					shortcut: "Ctrl+\\",
				},
				{
					id: "action:split-down",
					label: "Split Down",
					type: "action",
					icon: "⬍",
					shortcut: "Ctrl+-",
				},
				{
					id: "action:close-tab",
					label: "Close Tab",
					type: "action",
					icon: "✕",
					shortcut: "Ctrl+W",
				},
				{
					id: "action:pairing-code",
					label: "Generate Pairing Code",
					type: "action",
					icon: "🔗",
				},
				{
					id: "action:toggle-writelock",
					label: holdsLock ? "Release Write Lock" : "Claim Write Lock",
					type: "action",
					icon: holdsLock ? "🔓" : "🔒",
				},
				// New actions (SC-22/23)
				{
					id: "action:add-host",
					label: "Add Host",
					type: "action",
					icon: "➕",
				},
				{
					id: "action:settings",
					label: "Settings",
					type: "action",
					icon: "⚙",
				},
				{
					id: "action:ssh-import",
					label: "Import SSH Config",
					type: "action",
					icon: "📥",
				},
				{
					id: "action:toggle-sidebar",
					label: "Toggle Sidebar",
					type: "action",
					icon: "◧",
				},
			];

			for (const a of actions) {
				const score = q ? fuzzyMatch(q, a.label) : 1;
				if (score > 0) {
					scored.push({ item: a, score });
				}
			}
		}

		// ── Profiles (SC-28) ──────────────────────────────────────────────────
		if (prefix === null || prefix === "profile") {
			// The active host's menu: a profile it cannot run is not offered.
			for (const p of profilesStore.hostProfiles) {
				const score = q ? fuzzyMatch(q, p.name) : 1;
				if (score > 0) {
					// Profiles in general search get lower priority (score halved)
					const adjustedScore = prefix === "profile" ? score : Math.floor(score / 2);
					scored.push({
						item: {
							id: `profile:${p.id}`,
							label: p.name,
							description: p.shell,
							type: "profile",
							icon: p.iconType === "emoji" && p.iconValue ? p.iconValue : "▶",
							payload: p.id,
						},
						score: adjustedScore,
					});
				}
			}
		}

		// Sort by score descending (INV-04: deterministic)
		scored.sort((a, b) => b.score - a.score);

		const allItems = arrangeForDisplay(
			scored.map((s) => s.item),
			hostRows.railOrder.value,
		);

		// When query is empty and no prefix, recent items float to the top (SC-21)
		if (!q && prefix === null && recentIds.value.length > 0) {
			const recentSet = new Set(recentIds.value);

			// Filter for items whose IDs are in recent list (SC-24b: deletes are filtered)
			const recentItems = recentIds.value
				.map((rid) => allItems.find((it) => it.id === rid))
				.filter((it): it is PaletteItem => it !== undefined);

			const remainingItems = allItems.filter((it) => !recentSet.has(it.id));

			return [...recentItems, ...remainingItems];
		}

		return allItems;
	});

	// ── Recent items section (exposed for component "Recent" heading) ──────────

	const recentResults = computed<PaletteItem[]>(() => {
		const raw = query.value;
		const { prefix, searchQuery } = parsePrefix(raw);
		const q = searchQuery.toLowerCase();

		// Only show recent section on empty query with no prefix
		if (q || prefix !== null) return [];

		const allIds = new Set(results.value.map((it) => it.id));
		return recentIds.value
			.filter((rid) => allIds.has(rid))
			.map((rid) => results.value.find((it) => it.id === rid))
			.filter((it): it is PaletteItem => it !== undefined);
	});

	// ── Navigation helpers ────────────────────────────────────────────────────

	function open(): void {
		isOpen.value = true;
		query.value = "";
		selectedIndex.value = 0;
		// Read the host's menu now: it changes with the host, and with a seeding
		// an agent triggers when it says hello.
		void profilesStore.loadHostProfiles();
	}

	function close(): void {
		isOpen.value = false;
		query.value = "";
		selectedIndex.value = 0;
	}

	function toggle(): void {
		if (isOpen.value) {
			close();
		} else {
			open();
		}
	}

	function search(q: string): void {
		query.value = q;
		selectedIndex.value = 0;
	}

	function moveUp(): void {
		if (results.value.length === 0) return;
		selectedIndex.value = (selectedIndex.value - 1 + results.value.length) % results.value.length;
	}

	function moveDown(): void {
		if (results.value.length === 0) return;
		selectedIndex.value = (selectedIndex.value + 1) % results.value.length;
	}

	// ── Execute ───────────────────────────────────────────────────────────────

	function execute(item: PaletteItem, options: ExecuteOptions = {}): void {
		// Track in recent items (INV-07)
		pushRecent(item.id);
		close();

		switch (item.type) {
			case "host": {
				const hostId = item.payload as string;
				// Enter opens a new terminal on it, as the empty pane does; Shift+Enter
				// only switches to it, which is what choosing a host used to do (#625).
				if (options.switchOnly === true) hostsStore.selectHost(hostId);
				else openOnHost(hostId);
				break;
			}

			case "channel": {
				const channelId = item.payload as string;
				channelsStore.selectChannel(channelId);
				break;
			}

			case "action": {
				_executeAction(item.id);
				break;
			}

			case "profile": {
				const profileId = item.payload as string;
				profilesStore.spawnFromProfile(profileId);
				break;
			}
		}
	}

	function executeSelected(options: ExecuteOptions = {}): void {
		const item = results.value[selectedIndex.value];
		if (item !== undefined) {
			execute(item, options);
		}
	}

	/**
	 * A new tab with a terminal on this host: App.vue's, which holds the tabs;
	 * without it, the store's spawn, whose selection opens the tab.
	 */
	function openOnHost(hostId: string): void {
		if (onOpenHost.value !== null) {
			onOpenHost.value(hostId);
			return;
		}
		void channelsStore.spawnChannel(hostId).catch((err: unknown) => {
			console.error("[CommandPalette] new terminal on host failed:", err);
		});
	}

	// ── Internal action dispatch ──────────────────────────────────────────────

	function _executeAction(actionId: string): void {
		const hostId = channelsStore.activeHostId;
		const activeChannelId = channelsStore.selectedChannelId;
		const activeTab = layout.activeTab.value;

		switch (actionId) {
			case "action:new-channel": {
				if (hostId === null) break;
				void channelsStore.spawnChannel(hostId).catch((err: unknown) => {
					console.error("[CommandPalette] new channel failed:", err);
				});
				break;
			}

			case "action:split-right": {
				if (activeChannelId === null) break;
				_spawnAndSplit(activeChannelId, "vertical");
				break;
			}

			case "action:split-down": {
				if (activeChannelId === null) break;
				_spawnAndSplit(activeChannelId, "horizontal");
				break;
			}

			case "action:close-tab": {
				if (activeTab === null) break;
				const idx = layout.tabs.value.findIndex((t) => t.id === activeTab.id);
				if (idx !== -1) layout.closeTab(idx);
				break;
			}

			case "action:toggle-writelock": {
				if (activeChannelId === null) break;
				const holdsLock = writeLockStore.isWriter(activeChannelId);
				if (holdsLock) {
					writeLockStore.release(activeChannelId);
				} else {
					writeLockStore.claim(activeChannelId);
				}
				break;
			}

			default:
				// Delegate to external handler (add-host, settings, ssh-import, toggle-sidebar)
				if (onExternalAction.value !== null) {
					onExternalAction.value(actionId);
				} else {
					console.warn("[CommandPalette] unknown action:", actionId);
				}
		}
	}

	function _spawnAndSplit(existingChannelId: string, direction: "horizontal" | "vertical"): void {
		layout.splitPane(existingChannelId, direction);
	}

	return {
		isOpen,
		query,
		results,
		recentResults,
		selectedIndex,
		onExternalAction,
		onOpenHost,
		open,
		close,
		toggle,
		search,
		moveUp,
		moveDown,
		execute,
		executeSelected,
	};
}
