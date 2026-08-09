import type { Channel, ChannelCreatedMessage, ChannelGroup } from "@lasterm/shared";
import { defineStore } from "pinia";
import { computed, nextTick, ref } from "vue";
import { hubFetch } from "../utils/hub-fetch.js";
import { hubBaseUrl } from "../utils/hub-url.js";
import { useAuthStore } from "./auth.js";
import { useConfigStore } from "./config.js";
import { useSessionStore } from "./session.js";

const COLLAPSED_KEY = "lasterm:collapsed-groups";

function loadCollapsedMap(): Record<string, boolean> {
	try {
		const raw = localStorage.getItem(COLLAPSED_KEY);
		if (raw === null) return {};
		return JSON.parse(raw) as Record<string, boolean>;
	} catch {
		return {};
	}
}

function saveCollapsedMap(map: Record<string, boolean>): void {
	localStorage.setItem(COLLAPSED_KEY, JSON.stringify(map));
}

/** Convert a snake_case channel row from the API to a camelCase Channel. */
function apiRowToChannel(row: Record<string, unknown>): Channel {
	const ch: Channel = {
		id: row.id as string,
		sessionId: row.session_id as string,
		shell: row.shell as string,
		cols: row.cols as number,
		rows: row.rows as number,
		status: row.status as Channel["status"],
		createdAt: row.created_at as string,
		updatedAt: row.updated_at as string,
	};
	if (row.group_id != null) ch.groupId = row.group_id as string;
	if (row.title != null) ch.title = row.title as string;
	if (row.cwd != null) ch.cwd = row.cwd as string;
	if (row.env_json != null) ch.envJson = row.env_json as string;
	if (row.exit_code != null) ch.exitCode = row.exit_code as number;
	if (row.profile_json != null) ch.profileJson = row.profile_json as string;
	if (row.is_welcome === 1 || row.is_welcome === true) ch.isWelcome = true;
	if (row.icon != null) ch.icon = row.icon as string;
	if (row.direct_process === 1 || row.direct_process === true) ch.directProcess = true;
	if (Array.isArray(row.args) && (row.args as string[]).length > 0) {
		ch.args = row.args as string[];
	}
	if (row.dynamic_title != null) ch.dynamicTitle = row.dynamic_title as string;
	if (row.process_title != null) ch.processTitle = row.process_title as string;
	if (row.display_title != null) ch.displayTitle = row.display_title as string;
	return ch;
}

/** Convert a snake_case group row from the API to a camelCase ChannelGroup. */
function apiGroupToChannelGroup(
	row: Record<string, unknown>,
	collapsedMap: Record<string, boolean>,
): ChannelGroup {
	return {
		id: row.id as string,
		hostId: row.host_id as string,
		name: row.name as string,
		sortOrder: row.sort_order as number,
		collapsed: collapsedMap[row.id as string] ?? false,
		createdAt: row.created_at as string,
	};
}

/**
 * Channel store — manages channel list, groups, selection, and unread state.
 *
 * Groups are fetched from / persisted via the REST API (GET/POST/PATCH/DELETE
 * /api/groups). The `collapsed` state is UI-only and stored in localStorage.
 * Channels are fetched from GET /api/channels.
 *
 * CHANNEL_STATE WebSocket messages update channel status in real time.
 */
export const useChannelsStore = defineStore("channels", () => {
	const authStore = useAuthStore();

	const channels = ref<Channel[]>([]);
	const groups = ref<ChannelGroup[]>([]);
	const selectedChannelId = ref<string | null>(null);
	const loading = ref(false);
	const error = ref<string | null>(null);

	/**
	 * Set of channel IDs that have received new output since the user last
	 * viewed them. Used to render the unread indicator dot.
	 */
	const unreadChannels = ref<Set<string>>(new Set());

	/** Channel IDs from the last STATE_SYNC — used to mark absent channels as dead after fetchChannels. */
	const lastSyncIds = ref<Set<string> | null>(null);
	/** Buffered channel status updates from WS that arrived before fetchChannels populated the list. */
	const pendingStatuses = ref<Map<string, { status: Channel["status"]; exitCode?: number }>>(
		new Map(),
	);

	/**
	 * Monotonically increasing fetch generation counter.
	 * Incremented at the START of each fetchChannels call so that
	 * a stale fetch resolving late can detect it has been superseded.
	 */
	const fetchGeneration = ref<number>(0);

	/**
	 * Channels added by handleChannelCreated DURING the current in-flight fetch.
	 * Keyed by fetch generation so concurrent/overlapping fetches don't mix.
	 * Cleared when the owning fetch resolves.
	 */
	const wsAddedDuringFetch = ref<Map<number, Set<string>>>(new Map());

	/**
	 * Persistent channelId → hostId mapping.
	 * Populated by fetchChannels and registerChannelHost.
	 * NOT cleared on host switch — accumulates across all visited hosts
	 * so that bell/activity aggregation works for non-active hosts.
	 */
	const channelHostMap = ref<Map<string, string>>(new Map());

	/** Channels that belong to the currently loaded host. */
	const activeHostId = ref<string | null>(null);

	/**
	 * Collapsed state for the synthetic "General" pseudo-group (ungrouped channels).
	 * Persisted to localStorage under the "__general__" key in COLLAPSED_KEY.
	 */
	const generalCollapsed = ref<boolean>(false);

	/** Channels grouped by groupId, with an implicit "General" bucket for ungrouped ones. */
	const channelsByGroup = computed(() => {
		const result = new Map<string | null, Channel[]>();
		result.set(null, []); // null = ungrouped (rendered as "General")

		// Pre-populate group buckets in sort order
		for (const g of groups.value) {
			result.set(g.id, []);
		}

		for (const ch of channels.value) {
			const gid = ch.groupId ?? null;
			if (!result.has(gid)) {
				// Group was deleted — fall back to ungrouped
				result.get(null)?.push(ch);
			} else {
				result.get(gid)?.push(ch);
			}
		}

		return result;
	});

	// -------------------------------------------------------------------------
	// REST: fetch groups for a host
	// -------------------------------------------------------------------------

	/**
	 * Fetch and parse groups for a host WITHOUT committing to store state.
	 * Returns the parsed group list and generalCollapsed flag so the caller
	 * can commit them after any required guards (e.g. generation check).
	 */
	async function _fetchGroupsRaw(hostId: string): Promise<{
		groups: ChannelGroup[];
		generalCollapsed: boolean;
	}> {
		if (authStore.token === null) return { groups: [], generalCollapsed: false };
		const res = await hubFetch(`${hubBaseUrl()}/api/groups?host_id=${encodeURIComponent(hostId)}`, {
			headers: { Authorization: `Bearer ${authStore.token}` },
		});
		if (!res.ok) {
			throw new Error(`GET /api/groups failed: ${res.status}`);
		}
		const rows = (await res.json()) as Record<string, unknown>[];
		const collapsedMap = loadCollapsedMap();
		return {
			groups: rows.map((r) => apiGroupToChannelGroup(r, collapsedMap)),
			generalCollapsed: collapsedMap.__general__ ?? false,
		};
	}

	/**
	 * Public committing wrapper: fetch groups for a host and commit to store
	 * state immediately. Use this for standalone group refreshes (e.g. after
	 * addGroup/removeGroup). For fetchChannels, use _fetchGroupsRaw so groups
	 * are committed only after the generation guard.
	 */
	async function fetchGroups(hostId: string): Promise<void> {
		const result = await _fetchGroupsRaw(hostId);
		groups.value = result.groups;
		generalCollapsed.value = result.generalCollapsed;
	}

	// -------------------------------------------------------------------------
	// REST: fetch channels for a host
	// -------------------------------------------------------------------------

	async function fetchChannels(hostId: string): Promise<void> {
		if (authStore.token === null) return;

		// ── 1. Capture generation FIRST — before any state mutation ──────────
		// Generation is incremented before loading/error are touched so the
		// per-generation lifecycle (loading start → loading end) is fully
		// bracketed by the same generation value.
		const myGeneration = ++fetchGeneration.value;

		loading.value = true;
		error.value = null;

		// Clear stale channel state only when switching hosts (or on first
		// load).  When refreshing the same host (e.g. after SPAWN), keep
		// existing channels so tabs stay open.
		const hostChanged = activeHostId.value !== hostId || channels.value.length === 0;
		activeHostId.value = hostId;
		if (hostChanged) {
			channels.value = [];
			pendingStatuses.value = new Map();
			lastSyncIds.value = null;
		}

		// Register a tracking set for WS-added channels during this fetch.
		const myWsAdded = new Set<string>();
		wsAddedDuringFetch.value = new Map(wsAddedDuringFetch.value).set(myGeneration, myWsAdded);

		try {
			// ── 2. ALL I/O — no state commits in this section ────────────────
			const [channelsRes, fetchedGroups] = await Promise.all([
				hubFetch(`${hubBaseUrl()}/api/channels?host_id=${encodeURIComponent(hostId)}`, {
					headers: { Authorization: `Bearer ${authStore.token}` },
				}),
				_fetchGroupsRaw(hostId),
			]);

			if (!channelsRes.ok) {
				throw new Error(`GET /api/channels failed: ${channelsRes.status}`);
			}
			// Parse JSON — still inside the I/O section, no commits yet.
			const rows = (await channelsRes.json()) as Record<string, unknown>[];

			// ── 3. SINGLE generation guard — dominates ALL commits ────────────
			// Must appear AFTER every await so no stale fetch can slip through
			// between two awaits.  All assignments below are conditional on this.
			if (fetchGeneration.value !== myGeneration) return;

			// ── 4. Commit block — all state mutations happen here ─────────────

			// Commit group state for the winning generation.
			groups.value = fetchedGroups.groups;
			generalCollapsed.value = fetchedGroups.generalCollapsed;

			// Build merged channel list entirely in locals before writing refs.
			const data = rows.map(apiRowToChannel);

			// M2: union in any channels added by handleChannelCreated DURING this
			// fetch.  These channels exist on the server but are absent from `data`
			// (REST snapshot was taken before they were created).  We preserve them
			// only when they were added SINCE this fetch started (myWsAdded), so we
			// never resurrect channels the server legitimately dropped.
			const dataIds = new Set(data.map((c) => c.id));
			const wsChannelsToKeep = [...channels.value].filter(
				(c) => myWsAdded.has(c.id) && !dataIds.has(c.id),
			);
			let merged = [...data, ...wsChannelsToKeep];

			// Apply any WS status updates that arrived before the fetch completed.
			// pendingStatuses accumulates CHANNEL_STATE and STATE_SYNC entries
			// that were buffered while channels.value was empty.
			if (pendingStatuses.value.size > 0) {
				const pending = pendingStatuses.value;
				pendingStatuses.value = new Map();
				let statusUpdated = false;
				const reconciled = merged.map((ch) => {
					const p = pending.get(ch.id);
					if (p) {
						statusUpdated = true;
						return {
							...ch,
							status: p.status,
							...(p.exitCode !== undefined && { exitCode: p.exitCode }),
						};
					}
					return ch;
				});
				if (statusUpdated) {
					merged = reconciled;
				}
			}

			// Mark channels absent from last STATE_SYNC as dead (hub restarted, lost track).
			// lastSyncIds is set by applyStateSync when it buffers (channels were empty
			// during the WS message — the common case after our clear above).
			if (lastSyncIds.value !== null) {
				const syncIds = lastSyncIds.value;
				merged = merged.map((ch) => {
					if (ch.status !== "dead" && !syncIds.has(ch.id)) {
						return { ...ch, status: "dead" as const };
					}
					return ch;
				});
				lastSyncIds.value = null; // Always clear — one-shot reconciliation
			}

			// Write channels ref once with the fully-reconciled list.
			channels.value = merged;

			// Populate persistent channelId → hostId map (survives host switch).
			const nextHostMap = new Map(channelHostMap.value);
			for (const ch of merged) {
				nextHostMap.set(ch.id, hostId);
			}
			channelHostMap.value = nextHostMap;

			// Clear selection if the previously selected channel is no longer
			// present (e.g. host switched).
			if (selectedChannelId.value !== null) {
				const still = channels.value.find((c) => c.id === selectedChannelId.value);
				if (!still) selectedChannelId.value = null;
			}
		} catch (err) {
			// ── 5. Guarded catch — a stale failed fetch must not clobber a newer
			// generation's (cleared or set) error state.
			if (fetchGeneration.value === myGeneration) {
				error.value = err instanceof Error ? err.message : String(err);
			}
		} finally {
			// Clean up the WS-added tracking set for this generation.
			const next = new Map(wsAddedDuringFetch.value);
			next.delete(myGeneration);
			wsAddedDuringFetch.value = next;
			// ── 6. Guarded finally — because generation is captured before loading
			// is set, the loading lifecycle is fully consistent per-generation.
			if (fetchGeneration.value === myGeneration) {
				loading.value = false;
			}
		}
	}

	// -------------------------------------------------------------------------
	// Selection
	// -------------------------------------------------------------------------

	function selectChannel(channelId: string): void {
		selectedChannelId.value = channelId;
		// Clear unread on selection
		if (unreadChannels.value.has(channelId)) {
			const next = new Set(unreadChannels.value);
			next.delete(channelId);
			unreadChannels.value = next;
		}
	}

	// -------------------------------------------------------------------------
	// Unread tracking
	// -------------------------------------------------------------------------

	function markUnread(channelId: string): void {
		// Don't mark unread the channel currently being viewed
		if (channelId === selectedChannelId.value) return;
		const next = new Set(unreadChannels.value);
		next.add(channelId);
		unreadChannels.value = next;
	}

	// -------------------------------------------------------------------------
	// Real-time channel state updates from CHANNEL_STATE WS messages
	// -------------------------------------------------------------------------

	function updateChannelStatus(
		channelId: string,
		status: Channel["status"],
		exitCode?: number,
	): void {
		const idx = channels.value.findIndex((c) => c.id === channelId);
		if (idx === -1) {
			// Channel not loaded yet — buffer for later application
			const next = new Map(pendingStatuses.value);
			next.set(channelId, { status, ...(exitCode !== undefined && { exitCode }) });
			pendingStatuses.value = next;
			return;
		}
		const existing = channels.value[idx];
		if (existing === undefined) return;
		const updated = { ...existing };
		updated.status = status;
		if (exitCode !== undefined) updated.exitCode = exitCode;
		const next = [...channels.value];
		next[idx] = updated;
		channels.value = next;
	}

	/**
	 * Update the dynamic title for a channel (from TITLE_CHANGE WS message or ATTACH_OK).
	 * Silently ignored if the channel is not loaded yet.
	 */
	function setDynamicTitle(channelId: string, title: string): void {
		const idx = channels.value.findIndex((c) => c.id === channelId);
		if (idx === -1) return;
		const existing = channels.value[idx];
		if (existing === undefined) return;
		// Avoid unnecessary reactivity triggers if title hasn't changed
		if (existing.dynamicTitle === title) return;
		const next = [...channels.value];
		next[idx] = { ...existing, dynamicTitle: title };
		channels.value = next;
	}

	/**
	 * Update the hub-resolved display title for a channel.
	 * Called on TITLE_CHANGE, PROCESS_TITLE, ATTACH_OK, and STATE_SYNC.
	 * Silently ignored if the channel is not loaded yet.
	 */
	function setDisplayTitle(channelId: string, displayTitle: string): void {
		const idx = channels.value.findIndex((c) => c.id === channelId);
		if (idx === -1) return;
		const existing = channels.value[idx];
		if (existing === undefined) return;
		if (existing.displayTitle === displayTitle) return;
		const next = [...channels.value];
		next[idx] = { ...existing, displayTitle };
		channels.value = next;
	}

	/**
	 * Update the process title for a channel (from PROCESS_TITLE WS message or ATTACH_OK).
	 * Silently ignored if the channel is not loaded yet.
	 */
	function updateProcessTitle(channelId: string, title: string): void {
		const idx = channels.value.findIndex((c) => c.id === channelId);
		if (idx === -1) return;
		const existing = channels.value[idx];
		if (existing === undefined) return;
		// Avoid unnecessary reactivity triggers if title hasn't changed
		if (existing.processTitle === title) return;
		const next = [...channels.value];
		next[idx] = { ...existing, processTitle: title };
		channels.value = next;
	}

	/**
	 * Apply a batch of channel statuses from a STATE_SYNC message.
	 * If channels are loaded, updates them directly. Otherwise buffers for later.
	 */
	function applyStateSync(
		syncChannels: Array<{
			channelId: string;
			sessionId: string;
			status: Channel["status"];
			exitCode?: number;
		}>,
	): void {
		// Remember which channels the hub knows about — used after fetchChannels
		// to mark unknown channels as dead.
		lastSyncIds.value = new Set(syncChannels.map((s) => s.channelId));

		if (channels.value.length === 0) {
			// Channels not loaded yet — buffer all
			const next = new Map(pendingStatuses.value);
			for (const sc of syncChannels) {
				next.set(sc.channelId, {
					status: sc.status,
					...(sc.exitCode !== undefined && { exitCode: sc.exitCode }),
				});
			}
			pendingStatuses.value = next;
			return;
		}
		// Channels loaded — apply directly.
		// Channels present in store but ABSENT from STATE_SYNC are dead
		// (hub restarted, lost track of them).
		const _syncIds = new Set(syncChannels.map((s) => s.channelId));
		let changed = false;
		const updated = channels.value.map((ch) => {
			const sc = syncChannels.find((s) => s.channelId === ch.id);
			if (sc && ch.status !== sc.status) {
				changed = true;
				return {
					...ch,
					status: sc.status,
					...(sc.exitCode !== undefined && { exitCode: sc.exitCode }),
				};
			}
			if (!sc && ch.status !== "dead") {
				// Channel not in STATE_SYNC — hub doesn't know about it anymore
				changed = true;
				return { ...ch, status: "dead" as const };
			}
			return ch;
		});
		if (changed) {
			channels.value = updated;
		}
		// Buffer statuses for channels not yet loaded
		const loadedIds = new Set(channels.value.map((c) => c.id));
		const next = new Map(pendingStatuses.value);
		for (const sc of syncChannels) {
			if (!loadedIds.has(sc.channelId)) {
				next.set(sc.channelId, {
					status: sc.status,
					...(sc.exitCode !== undefined && { exitCode: sc.exitCode }),
				});
			}
		}
		if (next.size > 0) {
			pendingStatuses.value = next;
		}
	}

	/**
	 * Destroy a channel on the hub (kills its PTY) and remove it from the
	 * local sidebar. Best-effort: if the DELETE request fails the channel is
	 * still removed from the local list.
	 */
	async function removeChannel(channelId: string): Promise<void> {
		try {
			await hubFetch(`${hubBaseUrl()}/api/channels/${channelId}`, {
				method: "DELETE",
				headers: { Authorization: `Bearer ${authStore.token}` },
			});
		} catch {
			// Best-effort: even if DELETE fails (channel already dead, hub
			// unreachable), still remove from local sidebar below.
		}
		// Mark dead so the App.vue dead-channel watcher can close the tab
		const idx = channels.value.findIndex((c) => c.id === channelId);
		if (idx !== -1) {
			const existing = channels.value[idx];
			if (existing && existing.status !== "dead") {
				const next = [...channels.value];
				next[idx] = { ...existing, status: "dead" as const };
				channels.value = next;
			}
		}
		// Wait for watchers to process the status change (closes tab)
		await nextTick();
		// Then remove from sidebar list
		channels.value = channels.value.filter((c) => c.id !== channelId);
		if (selectedChannelId.value === channelId) {
			const fallback = channels.value.find((c) => c.status !== "dead");
			if (fallback) {
				selectChannel(fallback.id);
			} else {
				selectedChannelId.value = null;
			}
		}
	}

	/**
	 * Handle a CHANNEL_CREATED WebSocket message broadcast by the hub.
	 *
	 * This message is sent to ALL connected clients when any client spawns a
	 * new channel, so that observer clients (those not involved in the spawn)
	 * learn about the new channel without having to call fetchChannels.
	 *
	 * Host-scoped: ignored when the message is for a host the client is not
	 * currently viewing (activeHostId mismatch).
	 * Deduplicated: no-op if the channel is already in the list (handles the
	 * spawning client that already obtained the channel via fetchChannels after
	 * SPAWN_OK).
	 */
	function handleChannelCreated(msg: ChannelCreatedMessage): void {
		// Ignore channels for other hosts — this client may be viewing a
		// different host and should not accumulate foreign channels.
		if (activeHostId.value !== msg.hostId) return;

		// M1: purge any buffered pendingStatuses entry for this channel —
		// the channel is about to be materialized with its correct status from
		// the message itself.  Leaving a stale entry would allow a later
		// same-host fetchChannels (hostChanged===false) to overwrite server-truth
		// with the buffered value.  Do this on BOTH paths (add and dedupe-skip)
		// because a buffered status for an already-present channel is equally stale.
		if (pendingStatuses.value.has(msg.channelId)) {
			const next = new Map(pendingStatuses.value);
			next.delete(msg.channelId);
			pendingStatuses.value = next;
		}

		// Deduplicate: spawning client already has the channel via fetchChannels.
		if (channels.value.some((c) => c.id === msg.channelId)) return;

		const channel: Channel = {
			id: msg.channelId,
			sessionId: msg.sessionId,
			shell: msg.shell,
			cols: msg.cols,
			rows: msg.rows,
			status: msg.status,
			displayTitle: msg.displayTitle,
			createdAt: msg.createdAt,
			updatedAt: msg.updatedAt,
			...(msg.args !== undefined && msg.args.length > 0 && { args: msg.args }),
			...(msg.cwd !== undefined && { cwd: msg.cwd }),
		};
		channels.value = [...channels.value, channel];

		// M2: register this channel as WS-added during any in-flight fetch so
		// fetchChannels can union it in when the REST snapshot resolves.
		for (const wsAdded of wsAddedDuringFetch.value.values()) {
			wsAdded.add(msg.channelId);
		}

		// Track channelId → hostId for bell/activity aggregation
		const next = new Map(channelHostMap.value);
		next.set(msg.channelId, msg.hostId);
		channelHostMap.value = next;
	}

	// -------------------------------------------------------------------------
	// Pending spawns: map tempId → hostId for deferred spawn flow
	// -------------------------------------------------------------------------

	/**
	 * Register a channelId → hostId mapping from external sources
	 * (e.g. STATE_SYNC that provides sessionId → hostId).
	 */
	function registerChannelHost(channelId: string, hostId: string): void {
		if (channelHostMap.value.get(channelId) === hostId) return; // already correct
		const next = new Map(channelHostMap.value);
		next.set(channelId, hostId);
		channelHostMap.value = next;
	}

	const pendingSpawns = ref<Map<string, string>>(new Map());

	function registerPendingSpawn(tempId: string, hostId: string): void {
		const next = new Map(pendingSpawns.value);
		next.set(tempId, hostId);
		pendingSpawns.value = next;
	}

	function consumePendingSpawn(tempId: string): string | null {
		const hostId = pendingSpawns.value.get(tempId) ?? null;
		if (hostId !== null) {
			const next = new Map(pendingSpawns.value);
			next.delete(tempId);
			pendingSpawns.value = next;
		}
		return hostId;
	}

	// -------------------------------------------------------------------------
	// WS: spawn a new channel on a host
	// -------------------------------------------------------------------------

	function spawnChannel(
		hostId: string,
		opts?: {
			cols?: number;
			rows?: number;
			select?: boolean;
			launchProfileId?: string;
			shell?: string;
			args?: string[];
			directProcess?: boolean;
		},
	): Promise<string> {
		const sessionStore = useSessionStore();
		const configStore = useConfigStore();
		return new Promise<string>((resolve, reject) => {
			// Use `let` so the timeout/error callbacks can reference both unsub
			// functions even though they are declared after the timer is set.
			// Both are assigned synchronously before any async event fires.
			let unsubOk: () => void;
			let unsubErr: () => void;

			const timer = setTimeout(() => {
				unsubOk();
				unsubErr();
				reject(new Error("SPAWN timeout — no SPAWN_OK after 10s"));
			}, 10_000);

			unsubOk = sessionStore.wsClient.on("SPAWN_OK", (msg) => {
				if (msg.type === "SPAWN_OK") {
					clearTimeout(timer);
					unsubOk();
					unsubErr();
					void fetchChannels(hostId);
					if (opts?.select !== false) {
						selectChannel(msg.channelId);
					}
					resolve(msg.channelId);
				}
			});

			// Cancel the spawn wait immediately on any ERROR — the hub sends ERROR
			// (e.g. SSH_CONNECT_FAILED, SPAWN_FAILED) instead of SPAWN_OK when the
			// session cannot be established. Without this the caller would silently
			// wait 10 s before seeing the timeout message.
			unsubErr = sessionStore.wsClient.on("ERROR", (msg) => {
				if (msg.type === "ERROR") {
					if (msg.code === "AGENT_UPDATED") {
						// Legacy informational frame; modern hubs send AGENT_SYNCED instead.
						return;
					}
					clearTimeout(timer);
					unsubOk();
					unsubErr();
					reject(new Error(`${msg.code}: ${msg.message}`));
				}
			});

			// Auto-assign to first group when configured
			let autoGroupId: string | undefined;
			if (configStore.uiConfig.channels?.autoGroup === "first") {
				const sorted = [...groups.value].sort((a, b) => a.sortOrder - b.sortOrder);
				if (sorted.length > 0 && sorted[0] !== undefined) {
					autoGroupId = sorted[0].id;
				}
			}

			sessionStore.wsClient.send({
				type: "SPAWN",
				hostId,
				...(autoGroupId !== undefined ? { groupId: autoGroupId } : {}),
				...(opts?.cols !== undefined && opts?.rows !== undefined
					? { cols: opts.cols, rows: opts.rows }
					: {}),
				...(opts?.launchProfileId !== undefined ? { launchProfileId: opts.launchProfileId } : {}),
				...(opts?.shell !== undefined ? { shell: opts.shell } : {}),
				...(opts?.args !== undefined && opts.args.length > 0 ? { args: opts.args } : {}),
				...(opts?.directProcess ? { directProcess: true } : {}),
			});
		});
	}

	// -------------------------------------------------------------------------
	// Group management (REST API + localStorage for collapsed state)
	// -------------------------------------------------------------------------

	async function addGroup(name: string): Promise<ChannelGroup> {
		if (authStore.token === null) throw new Error("Not authenticated");
		const hostId = activeHostId.value;
		if (hostId === null) throw new Error("No active host");

		const res = await hubFetch(`${hubBaseUrl()}/api/groups`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${authStore.token}`,
			},
			body: JSON.stringify({ host_id: hostId, name }),
		});
		if (!res.ok) throw new Error(`POST /api/groups failed: ${res.status}`);

		const row = (await res.json()) as Record<string, unknown>;
		const collapsedMap = loadCollapsedMap();
		const group = apiGroupToChannelGroup(row, collapsedMap);
		groups.value = [...groups.value, group];
		return group;
	}

	async function removeGroup(groupId: string): Promise<void> {
		if (authStore.token === null) return;

		await hubFetch(`${hubBaseUrl()}/api/groups/${groupId}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${authStore.token}` },
		});

		// Update local channels — clear groupId for channels in the deleted group
		channels.value = channels.value.map((ch) => {
			if (ch.groupId !== groupId) return ch;
			// eslint-disable-next-line @typescript-eslint/no-unused-vars
			const { groupId: _removed, ...rest } = ch;
			return rest as Channel;
		});

		// Remove group locally and clean up collapsed state
		groups.value = groups.value.filter((g) => g.id !== groupId);
		const collapsedMap = loadCollapsedMap();
		delete collapsedMap[groupId];
		saveCollapsedMap(collapsedMap);
	}

	async function renameGroup(groupId: string, name: string): Promise<void> {
		if (authStore.token === null) return;

		// Optimistic update
		const oldGroups = groups.value;
		groups.value = groups.value.map((g) => (g.id === groupId ? { ...g, name } : g));

		try {
			const res = await hubFetch(`${hubBaseUrl()}/api/groups/${groupId}`, {
				method: "PATCH",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${authStore.token}`,
				},
				body: JSON.stringify({ name }),
			});
			if (!res.ok) throw new Error(`PATCH /api/groups/${groupId} failed: ${res.status}`);
		} catch {
			// Rollback
			groups.value = oldGroups;
		}
	}

	async function reorderGroups(hostId: string, groupIds: string[]): Promise<void> {
		if (authStore.token === null) return;

		// Optimistic update — reorder local groups array to match requested order
		const prevGroups = groups.value;
		const ordered = groupIds
			.map((id) => groups.value.find((g) => g.id === id))
			.filter((g): g is ChannelGroup => g !== undefined);
		// Append any groups not in groupIds (guards against partial lists)
		const reordered = [...ordered, ...groups.value.filter((g) => !groupIds.includes(g.id))];
		groups.value = reordered;

		try {
			const res = await hubFetch(`${hubBaseUrl()}/api/groups/order`, {
				method: "PUT",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${authStore.token}`,
				},
				body: JSON.stringify({ host_id: hostId, group_ids: groupIds }),
			});
			if (!res.ok) throw new Error(`PUT /api/groups/order failed: ${res.status}`);
		} catch {
			// Rollback on failure
			groups.value = prevGroups;
		}
	}

	function toggleGroupCollapsed(groupId: string): void {
		groups.value = groups.value.map((g) =>
			g.id === groupId ? { ...g, collapsed: !g.collapsed } : g,
		);
		// Persist collapsed state to localStorage
		const collapsedMap = loadCollapsedMap();
		const group = groups.value.find((g) => g.id === groupId);
		if (group) {
			collapsedMap[groupId] = group.collapsed;
		}
		saveCollapsedMap(collapsedMap);
	}

	/** Toggle collapsed state of the "General" pseudo-group and persist to localStorage. */
	function toggleGeneralCollapsed(): void {
		generalCollapsed.value = !generalCollapsed.value;
		const collapsedMap = loadCollapsedMap();
		collapsedMap.__general__ = generalCollapsed.value;
		saveCollapsedMap(collapsedMap);
	}

	/**
	 * Rename a channel (optimistic update with rollback on failure).
	 * Pass `null` to clear the custom title.
	 */
	async function renameChannel(channelId: string, title: string | null): Promise<void> {
		const idx = channels.value.findIndex((c) => c.id === channelId);
		if (idx === -1) return;
		const existing = channels.value[idx];
		if (existing === undefined) return;
		const oldChannel = existing;

		// Optimistic update — rebuild to satisfy exactOptionalPropertyTypes
		const { title: _removed, ...rest } = existing;
		const updated: Channel = title !== null ? { ...rest, title } : (rest as Channel);
		const next = [...channels.value];
		next[idx] = updated;
		channels.value = next;

		try {
			const res = await hubFetch(`${hubBaseUrl()}/api/channels/${channelId}`, {
				method: "PATCH",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${authStore.token}`,
				},
				body: JSON.stringify({ title }),
			});
			if (!res.ok) throw new Error("Failed to rename");
		} catch {
			// Rollback
			const rollbackIdx = channels.value.findIndex((c) => c.id === channelId);
			if (rollbackIdx !== -1) {
				const rollback = [...channels.value];
				rollback[rollbackIdx] = oldChannel;
				channels.value = rollback;
			}
			if (activeHostId.value !== null) {
				await fetchChannels(activeHostId.value);
			}
		}
	}

	/**
	 * Clear the custom title for a channel, reverting to dynamic title resolution.
	 * Calls PATCH /api/channels/:id with { title: null }.
	 */
	async function clearTitle(channelId: string): Promise<void> {
		await renameChannel(channelId, null);
	}

	async function moveChannelToGroup(channelId: string, groupId: string | null): Promise<void> {
		if (authStore.token === null) return;

		// Optimistic update
		const oldChannels = channels.value;
		channels.value = channels.value.map((ch) => {
			if (ch.id !== channelId) return ch;
			if (groupId === null) {
				// Remove groupId key entirely to satisfy exactOptionalPropertyTypes
				// eslint-disable-next-line @typescript-eslint/no-unused-vars
				const { groupId: _removed, ...rest } = ch;
				return rest as Channel;
			}
			return { ...ch, groupId };
		});

		try {
			const res = await hubFetch(`${hubBaseUrl()}/api/channels/${channelId}`, {
				method: "PATCH",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${authStore.token}`,
				},
				body: JSON.stringify({ group_id: groupId }),
			});
			if (!res.ok) throw new Error(`PATCH /api/channels/${channelId} failed: ${res.status}`);
		} catch {
			// Rollback
			channels.value = oldChannels;
		}
	}

	// -------------------------------------------------------------------------
	// Welcome channel
	// -------------------------------------------------------------------------

	/** The welcome channel for the currently loaded host (if any). */
	const welcomeChannel = computed(() => channels.value.find((c) => c.isWelcome === true) ?? null);

	/** Set a channel as welcome tab for a host. API call + local update. */
	async function setWelcomeChannel(hostId: string, channelId: string): Promise<void> {
		if (authStore.token === null) return;

		// Optimistic update: clear existing welcome, set new one
		const oldChannels = channels.value;
		channels.value = channels.value.map((ch) => {
			const { isWelcome: _removed, ...rest } = ch;
			if (ch.id === channelId) return { ...rest, isWelcome: true } as Channel;
			return rest as Channel;
		});

		try {
			const res = await hubFetch(`${hubBaseUrl()}/api/hosts/${hostId}/welcome`, {
				method: "PUT",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${authStore.token}`,
				},
				body: JSON.stringify({ channel_id: channelId }),
			});
			if (!res.ok) throw new Error(`PUT /api/hosts/${hostId}/welcome failed: ${res.status}`);
		} catch {
			// Rollback
			channels.value = oldChannels;
		}
	}

	/** Clear welcome status for a host. API call + local update. */
	async function clearWelcomeChannel(hostId: string): Promise<void> {
		if (authStore.token === null) return;

		// Optimistic update: clear isWelcome from all channels
		const oldChannels = channels.value;
		channels.value = channels.value.map((ch) => {
			const { isWelcome: _removed, ...rest } = ch;
			return rest as Channel;
		});

		try {
			const res = await hubFetch(`${hubBaseUrl()}/api/hosts/${hostId}/welcome`, {
				method: "DELETE",
				headers: { Authorization: `Bearer ${authStore.token}` },
			});
			if (!res.ok) throw new Error(`DELETE /api/hosts/${hostId}/welcome failed: ${res.status}`);
		} catch {
			// Rollback
			channels.value = oldChannels;
		}
	}

	// -------------------------------------------------------------------------
	// Channel config (icon, shell, args, cwd, directProcess)
	// -------------------------------------------------------------------------

	async function updateChannelConfig(
		channelId: string,
		config: {
			icon?: string | null;
			shell?: string | null;
			args?: string[];
			cwd?: string | null;
			direct_process?: boolean;
		},
	): Promise<boolean> {
		if (authStore.token === null) return false;

		const res = await hubFetch(`${hubBaseUrl()}/api/channels/${channelId}`, {
			method: "PATCH",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${authStore.token}`,
			},
			body: JSON.stringify(config),
		});
		if (!res.ok) return false;

		// Refresh local state
		if (activeHostId.value !== null) {
			await fetchChannels(activeHostId.value);
		}
		return true;
	}

	async function restartChannel(channelId: string): Promise<boolean> {
		if (authStore.token === null) return false;

		const res = await hubFetch(`${hubBaseUrl()}/api/channels/${channelId}/restart`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${authStore.token}`,
			},
		});
		if (!res.ok) return false;

		// No optimistic update — the hub broadcasts CHANNEL_STATE: live
		// via WS which arrives before or alongside the HTTP response.
		// Setting "born" here would overwrite the correct "live" status.

		return true;
	}

	/**
	 * Purge a dead channel: DELETE /api/channels/:id which now removes the record
	 * and all spool chunks. Removes from local state on success.
	 */
	async function deleteChannel(channelId: string): Promise<boolean> {
		if (authStore.token === null) return false;
		const res = await hubFetch(`${hubBaseUrl()}/api/channels/${channelId}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${authStore.token}` },
		});
		if (!res.ok) return false;
		channels.value = channels.value.filter((c) => c.id !== channelId);
		const nextMap = new Map(channelHostMap.value);
		nextMap.delete(channelId);
		channelHostMap.value = nextMap;
		return true;
	}

	/**
	 * Bulk purge all dead channels for the active host.
	 * Returns the number of channels purged.
	 */
	/**
	 * Bulk purge all dead channels for the active host.
	 * Returns the number of channels purged.
	 */
	async function purgeDeadChannels(): Promise<number> {
		if (authStore.token === null || activeHostId.value === null) return 0;
		const res = await hubFetch(`${hubBaseUrl()}/api/channels/dead`, {
			method: "DELETE",
			headers: {
				Authorization: `Bearer ${authStore.token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ host_id: activeHostId.value }),
		});
		if (!res.ok) return 0;
		const data = (await res.json()) as { purged: number };
		const deadIds = new Set(channels.value.filter((c) => c.status === "dead").map((c) => c.id));
		channels.value = channels.value.filter((c) => c.status !== "dead");
		const nextMap = new Map(channelHostMap.value);
		for (const id of deadIds) {
			nextMap.delete(id);
		}
		channelHostMap.value = nextMap;
		return data.purged;
	}

	return {
		channels,
		groups,
		selectedChannelId,
		loading,
		error,
		unreadChannels,
		activeHostId,
		channelsByGroup,
		channelHostMap,
		welcomeChannel,
		fetchGroups,
		fetchChannels,
		selectChannel,
		markUnread,
		updateChannelStatus,
		setDynamicTitle,
		setDisplayTitle,
		updateProcessTitle,
		applyStateSync,
		removeChannel,
		handleChannelCreated,
		spawnChannel,
		registerPendingSpawn,
		consumePendingSpawn,
		registerChannelHost,
		addGroup,
		removeGroup,
		renameGroup,
		reorderGroups,
		toggleGroupCollapsed,
		generalCollapsed,
		toggleGeneralCollapsed,
		renameChannel,
		clearTitle,
		moveChannelToGroup,
		setWelcomeChannel,
		clearWelcomeChannel,
		updateChannelConfig,
		restartChannel,
		deleteChannel,
		purgeDeadChannels,
	};
});
