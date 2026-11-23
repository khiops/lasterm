import {
	type Channel,
	type ChannelCreatedMessage,
	type ChannelEndReason,
	type ChannelGroup,
	ErrorCode,
	generateId,
	type SessionStatus,
} from "@lasterm/shared";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { hubFetch } from "../utils/hub-fetch.js";
import { hubBaseUrl } from "../utils/hub-url.js";
import type { AskedSecret } from "../utils/pane-cover.js";
import { useAuthStore } from "./auth.js";
import { useConfigStore } from "./config.js";
import { useHostsStore } from "./hosts.js";
import { listedRecordings, useRecordingsStore } from "./recordings.js";
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
		cols: row.cols as number,
		rows: row.rows as number,
		status: row.status as Channel["status"],
		createdAt: row.created_at as string,
		updatedAt: row.updated_at as string,
	};
	// None for a terminal with no shell of its own: its agent's default (#583).
	if (row.shell != null) ch.shell = row.shell as string;
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
	// A dead terminal the hub ended itself: no pane brings back one killed (#592).
	const endReason = endReasonOfRow(row);
	if (endReason !== undefined) ch.endReason = endReason;
	return ch;
}

/** Why a listed terminal ended, when the hub says it ended it itself (#592). */
function endReasonOfRow(row: Record<string, unknown>): ChannelEndReason | undefined {
	return row.end_reason === "killed" || row.end_reason === "stopped" ? row.end_reason : undefined;
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
/**
 * How long a spawn waits for the hub, when the hub has only itself to consult.
 *
 * Longer than the ten seconds the hub gives its agent, so that the hub's own
 * answer to a SPAWN its agent left unanswered arrives first, and says why:
 * that the host went away meanwhile, which a pane waits out, rather than a
 * timeout of its own that says nothing (#605).
 */
const SPAWN_DEADLINE_MS = 15_000;

/**
 * How long it waits once a prompt is on screen.
 *
 * Long enough to compare a fingerprint against another source, or to go and
 * fetch a passphrase, and short enough that a hub which has genuinely stopped
 * answering does not leave a spawn pending for ever.
 */
const SPAWN_PROMPTED_DEADLINE_MS = 300_000;

/**
 * How long it waits once the hub says it is connecting the host (#1034).
 *
 * Each wait of a connection has its own bound on the hub, up to 120 s when the
 * host sets one, and a connection may dial more than once (a host key or a
 * password asked again): the hub answers when it is done. This is only for a
 * hub that stopped answering with its socket still open; a socket that closes
 * ends the wait at once.
 */
const SPAWN_CONNECTING_DEADLINE_MS = 1_800_000;

/**
 * A spawn's rejection, as a sentence for the pane. The hub's messages are
 * written for people; the code in front of them (`SSH_CONNECT_FAILED: …`) is
 * for logs.
 */
function restartFailureReason(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	return message.replace(/^[A-Z][A-Z0-9_]+: /, "");
}

/** The terminal a new terminal's spawn started, and the size its PTY was spawned at. */
export interface SpawnedTerminal {
	channelId: string;
	cols: number;
	rows: number;
	/** What its SPAWN_OK said of the agent's input (#1012); false from an older hub. */
	adaptsInput: boolean;
	/** What that SPAWN_OK said of pastes (#1014). */
	streamsPaste: boolean;
}

/** The one spawn a pending id has sent: in flight, or what came of it. */
export interface PendingSpawnRun {
	state: "running" | "succeeded" | "failed";
	readonly outcome: Promise<SpawnedTerminal>;
}

/** A spawn owed for a pending id: its host, the panes showing it, its run. */
interface PendingSpawn {
	readonly hostId: string;
	holders: number;
	run: PendingSpawnRun | null;
	/**
	 * Left by the page before this one (#992). Nothing starts it by itself: not
	 * the load, not the connection coming back, not a pane remounted over it.
	 * Only a click on the pane does.
	 */
	readonly restored: boolean;
	/** A run of it was started, so its SPAWN may have gone out. */
	sent: boolean;
}

/**
 * The code of the failure a restored spawn shows: the page that owed it went
 * away before its terminal was known to have started (#992). No hub sends it.
 */
export const SPAWN_INTERRUPTED = "SPAWN_INTERRUPTED";

/** What a restored spawn's pane is told: whether its SPAWN can have gone out. */
export interface InterruptedSpawnError extends Error {
	code: typeof SPAWN_INTERRUPTED;
	/** No SPAWN went out: nothing can have started, so starting it duplicates nothing. */
	neverSent: boolean;
}

/**
 * The spawns new terminals owe, kept for the next page (#992): the layout is
 * saved with their pending ids, and a page that finds one in it with no record
 * took it for a terminal and said it was gone.
 */
const PENDING_SPAWNS_KEY = "lasterm:pending-spawns";

interface StoredSpawn {
	hostId: string;
	sent: boolean;
}

/** The spawns the page before this one owed. Anything unreadable is left out. */
function loadStoredSpawns(): Map<string, StoredSpawn> {
	const stored = new Map<string, StoredSpawn>();
	let parsed: unknown;
	try {
		const raw = localStorage.getItem(PENDING_SPAWNS_KEY);
		if (raw === null) return stored;
		parsed = JSON.parse(raw);
	} catch {
		return stored;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return stored;
	for (const [tempId, entry] of Object.entries(parsed)) {
		if (typeof entry !== "object" || entry === null) continue;
		const { hostId, sent } = entry as { hostId?: unknown; sent?: unknown };
		if (typeof hostId !== "string" || hostId === "") continue;
		// Anything but a plain false may have sent its SPAWN: it is read as the
		// one that claims less.
		stored.set(tempId, { hostId, sent: sent !== false });
	}
	return stored;
}

/** Write the spawns still owed. Throws what `localStorage` throws. */
function writeStoredSpawns(spawns: ReadonlyMap<string, StoredSpawn>): void {
	localStorage.setItem(PENDING_SPAWNS_KEY, JSON.stringify(Object.fromEntries(spawns)));
}

/** A restored spawn's run: failed, with the reason its pane shows. */
function interruptedRun(neverSent: boolean): PendingSpawnRun {
	const error = Object.assign(
		new Error(
			neverSent
				? "This terminal was never started."
				: "The window reloaded before this terminal's start was confirmed.",
		),
		{ code: SPAWN_INTERRUPTED, neverSent },
	) as InterruptedSpawnError;
	const outcome = Promise.reject<SpawnedTerminal>(error);
	// No pane may ever show it: one the layout no longer holds is pruned.
	outcome.catch(() => {});
	return { state: "failed", outcome };
}

/** Why the last attempt to bring a terminal back failed. */
export interface RestartFailure {
	/** Said for the pane, without the hub's code. */
	reason: string;
	/**
	 * The host the hub said it could not reach (`HOST_UNREACHABLE`, #605): the
	 * terminal did not fail, its host is away. Absent for every other failure.
	 */
	hostAway?: { hostId: string };
}

/**
 * A spawn's rejection, as the failure the pane shows or waits out. Null when
 * nothing failed: the person cancelled the password or passphrase the host
 * asked for (`AUTH_CANCELLED`), and the pane stays as it was (#812).
 */
export function restartFailureOf(err: unknown, hostIdHint: string): RestartFailure | null {
	const refusal = err as { code?: unknown; hostId?: unknown } | null;
	if (refusal?.code === ErrorCode.AUTH_CANCELLED) return null;
	const reason = restartFailureReason(err);
	if (refusal?.code !== ErrorCode.HOST_UNREACHABLE) return { reason };
	return {
		reason,
		hostAway: { hostId: typeof refusal.hostId === "string" ? refusal.hostId : hostIdHint },
	};
}

/**
 * What the hub last said about a channel: its status and, once it has ended,
 * its exit code and whether the hub ended it itself (#580).
 */
export interface ChannelReport {
	status: Channel["status"];
	exitCode?: number;
	endReason?: ChannelEndReason;
	/** The id the hub gave that end, once it has ended (#932). */
	endId?: string;
}

/**
 * A status heard for a channel no list in view holds yet. `replacesEnd`: it
 * reports another end than the one the list may still show, or a terminal
 * running again, so the fetched row's exit code, reason and end id give way
 * to its own, absent ones included (#932).
 */
interface PendingStatus extends Heard {
	status: Channel["status"];
}

/** The titles a channel can be given while a list fetch is in flight (#1122). */
type HeardTitles = Partial<Pick<Channel, "displayTitle" | "dynamicTitle" | "processTitle">>;

/**
 * What was heard for a channel during a fetch. `status` is absent while only
 * a title was heard.
 */
interface Heard {
	status?: Channel["status"];
	exitCode?: number;
	endReason?: ChannelEndReason;
	endId?: string;
	replacesEnd?: true;
	/** A terminal created again: its own session, size, title and time win over a fetched row's (#1109). */
	row?: Pick<Channel, "sessionId" | "cols" | "rows" | "updatedAt"> &
		Partial<Pick<Channel, "displayTitle">>;
	/** Titles heard since the creation, if any: the newest word over the row's (#1122). */
	titles?: HeardTitles;
}

/**
 * The status to hold pending for a channel, over the one held already. The
 * same end told again keeps what was heard of it and, until a fetch takes it,
 * that it replaces the fetched row's end (#932); so does an end heard after a
 * run (#1091).
 */
function bufferedStatus(held: Heard | undefined, heard: PendingStatus): PendingStatus {
	// A creation tells the display title anew: the titles heard before it go.
	const { titles: _before, ...buffered } = bufferedEnd(held, heard);
	// What a creation told of the terminal outlives the statuses heard after it.
	const row = heard.row ?? held?.row;
	const titles = heard.row === undefined ? held?.titles : undefined;
	return {
		...buffered,
		...(row !== undefined && { row }),
		...(titles !== undefined && { titles }),
	};
}

function bufferedEnd(held: Heard | undefined, heard: PendingStatus): PendingStatus {
	const sameEnd =
		held !== undefined &&
		heard.replacesEnd !== true &&
		heard.status === "dead" &&
		held.status === "dead" &&
		(heard.endId === undefined || heard.endId === held.endId);
	// After a run, any end is a new one: the row's earlier end stays gone even
	// when that end names no id (#1091).
	if (!sameEnd) {
		return held?.replacesEnd === true && held.status !== "dead"
			? { ...heard, replacesEnd: true }
			: heard;
	}
	return { ...held, ...heard, ...(held.replacesEnd === true && { replacesEnd: true as const }) };
}

/** A channel with a status heard for it over what it held (#932). */
function withHeard(channel: Channel, heard: Heard): Channel {
	return {
		...(heard.replacesEnd === true ? withoutEnd(channel) : channel),
		...(heard.status !== undefined && { status: heard.status }),
		...(heard.exitCode !== undefined && { exitCode: heard.exitCode }),
		...(heard.endReason !== undefined && { endReason: heard.endReason }),
		...(heard.endId !== undefined && { endId: heard.endId }),
		...heard.row,
		...heard.titles,
	};
}

/** A channel without what an end says of it: its exit code, reason and end id (#932). */
function withoutEnd(channel: Channel): Channel {
	const { exitCode: _code, endReason: _reason, endId: _id, ...rest } = channel;
	return rest;
}

/** What the index keeps of a channel whichever host is in view. */
export interface ChannelIndexEntry {
	hostId: string;
	displayTitle: string;
	directProcess?: true;
	/** It ended, and the hub ended it itself: killed, or stopped with its agent or hub (#592). */
	endReason?: ChannelEndReason;
	/**
	 * It had ended when the listing was read: what `statusOf` says of a
	 * terminal no list in view carries and no report has spoken of (#594).
	 */
	ended?: true;
}

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
	const pendingStatuses = ref<Map<string, PendingStatus>>(new Map());

	/**
	 * What the hub last said about each channel, whichever host is in view.
	 *
	 * `channels` holds the host in view, and a CHANNEL_STATE for any other went
	 * to `pendingStatuses`, which only a fetch of that host's list ever reads.
	 * Tabs are global, though, so a pane can front a terminal on a host nobody
	 * is looking at: when a Reconnect brought that host back with the terminal
	 * gone, the pane never heard it and kept saying "Not connected" (#556).
	 *
	 * Each report is a new object, so a pane can react to the hub saying a
	 * terminal is live even when it already was.
	 */
	const reports = ref<Map<string, ChannelReport>>(new Map());

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
	 * Statuses heard for listed channels DURING each in-flight fetch, keyed by
	 * fetch generation. Statuses heard since a fetch began override its rows
	 * when it commits, as `pendingStatuses` does for channels not listed: the
	 * hub may have read those rows before them (#1091).
	 */
	const statusesDuringFetch = new Map<number, Map<string, Heard | "deleted">>();

	/**
	 * Display titles set here DURING each in-flight index fetch, whether or not a
	 * list holds the channel. The index is rebuilt from the response, which the
	 * hub may have read before the title: a title heard since goes over its row
	 * (#1128). Independent of `statusesDuringFetch`: the index fetch is not tied to a
	 * host list or its generations.
	 *
	 * `listed` is what a host list published into the index while the fetch was in
	 * flight: those entries stay over the response's rows, which the hub may have
	 * read before the list did (#1148). Titles heard still go over them. Only a list
	 * whose request started after the index fetch's publishes there (`startedAt`,
	 * from `requestSeq`): by the order the calls were made here, which is what this
	 * window can know of the hub's reads, a list started earlier is the older read.
	 */
	interface IndexHeard {
		startedAt: number;
		titles: Map<string, string>;
		listed: Map<string, ChannelIndexEntry>;
	}
	/** Orders the starts of list and index requests as this window made them. */
	let requestSeq = 0;
	const indexTitlesDuringFetch = new Set<IndexHeard>();

	/**
	 * The latest index fetch started, and the latest whose response was taken.
	 * Fetches are ordered by when they started here: the hub may answer them in
	 * any order, and an older request's response must not replace a newer one's
	 * (#1133), or a channel listed by the newer one drops out. An older response
	 * still applies while no newer one has, so a newer fetch the hub refused does
	 * not leave the index stale. Separate from `fetchGeneration`, which belongs
	 * to a host's list.
	 */
	let indexGeneration = 0;
	let indexCommittedGeneration = 0;

	/**
	 * A run heard for a channel since the last STATE_SYNC says the hub has it:
	 * the next fetch must not mark it dead for being absent from that sync
	 * (#1091). An end heard leaves that check in place.
	 */
	function knownToHub(channelId: string): void {
		if (lastSyncIds.value === null || lastSyncIds.value.has(channelId)) return;
		lastSyncIds.value = new Set(lastSyncIds.value).add(channelId);
	}

	/** Record a status heard for a listed channel for every fetch in flight (#1091). */
	function heardDuringFetch(channelId: string, heard: PendingStatus): void {
		for (const heardHere of statusesDuringFetch.values()) {
			const held = heardHere.get(channelId);
			// Heard for a channel in the list, so it was created again since a
			// deletion recorded here: the deletion no longer stands.
			heardHere.set(channelId, bufferedStatus(held === "deleted" ? undefined : held, heard));
		}
	}

	/**
	 * Record a title set here for every fetch in flight: the hub may have read
	 * the row before it, and the title must not go back (#1122).
	 */
	function titleHeardDuringFetch(channelId: string, titles: HeardTitles): void {
		for (const heardHere of statusesDuringFetch.values()) {
			const held = heardHere.get(channelId);
			if (held === "deleted") continue;
			heardHere.set(channelId, { ...held, titles: { ...held?.titles, ...titles } });
		}
	}

	/**
	 * Record channels deleted here for every fetch in flight: the hub may have
	 * listed them before the deletion, and they must not come back (#1104).
	 */
	function deletedDuringFetch(channelIds: Iterable<string>): void {
		for (const heardHere of statusesDuringFetch.values()) {
			for (const id of channelIds) heardHere.set(id, "deleted");
		}
		// What a list published for an index fetch in flight goes with the channel (#1148);
		// a row of that fetch's own response is not filtered, as before.
		for (const heardHere of indexTitlesDuringFetch) {
			for (const id of channelIds) heardHere.listed.delete(id);
		}
	}

	/**
	 * Persistent channelId → hostId mapping.
	 * Populated by fetchChannels and registerChannelHost.
	 * NOT cleared on host switch — accumulates across all visited hosts
	 * so that bell/activity aggregation works for non-active hosts.
	 */
	const channelHostMap = ref<Map<string, string>>(new Map());

	/**
	 * Every channel this hub knows — the host it is on and the title it carries
	 * — whichever host is being looked at.
	 *
	 * `channels` holds one host at a time, which is right for the sidebar and
	 * wrong for the tab bar: tabs are global, so a tab can front a terminal on a
	 * host nobody is looking at. Without this, such a tab has no name to show
	 * and no host to mark, which is what a restart used to look like — a row of
	 * tabs all called "Terminal".
	 *
	 * It is a fallback, not a source of truth: `channels` wins for the active
	 * host, where the live status lives.
	 */
	const channelIndex = ref<Map<string, ChannelIndexEntry>>(new Map());
	/**
	 * Why the last attempt to bring a terminal back failed, by channel.
	 *
	 * Restart is started from the pane and from the sidebar, and it can fail far
	 * from either — an SSH connection, a remote daemon that would not start. The
	 * reason used to be caught and dropped: the button did nothing, visibly, and
	 * the hub's explanation went nowhere. Kept here, the pane over that terminal
	 * shows it, whichever gesture asked.
	 */
	const restartFailures = ref<Map<string, RestartFailure>>(new Map());

	function setRestartFailure(channelId: string, failure: RestartFailure | null): void {
		const next = new Map(restartFailures.value);
		if (failure === null) next.delete(channelId);
		else next.set(channelId, failure);
		restartFailures.value = next;
	}

	/**
	 * The host whose list is loaded: the one the rail has selected.
	 *
	 * `fetchChannels` sets it, and only a change of host in the rail calls it
	 * with another host than this one: the rail and the sidebar must say the
	 * same host (#594). A refresh after a spawn elsewhere goes to the index
	 * instead (`refreshAfterSpawn`).
	 */
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

	/**
	 * Load the cross-host index: one unfiltered listing, every channel's host
	 * and title.
	 *
	 * It never touches `channels`, `loading` or `error` — it is not what the
	 * sidebar is waiting for, and a hub that refuses it leaves the app exactly
	 * as it was, with tabs named the way they were before.
	 */
	async function fetchChannelIndex(): Promise<void> {
		if (authStore.token === null) return;
		const myIndexGeneration = ++indexGeneration;
		const myHeard: IndexHeard = { startedAt: ++requestSeq, titles: new Map(), listed: new Map() };
		const recordingsAt = useRecordingsStore().listFetchStarted();
		indexTitlesDuringFetch.add(myHeard);
		try {
			const res = await hubFetch(`${hubBaseUrl()}/api/channels`, {
				headers: { Authorization: `Bearer ${authStore.token}` },
			});
			if (!res.ok) return;
			const rows = (await res.json()) as Array<Record<string, unknown>>;
			if (!Array.isArray(rows)) return;
			// After the last await: the response of a fetch started later has been
			// taken, and this older one does not replace it (#1133).
			if (myIndexGeneration < indexCommittedGeneration) return;

			const nextIndex = new Map<string, ChannelIndexEntry>();
			const nextHostMap = new Map(channelHostMap.value);
			for (const row of rows) {
				const id = row.id;
				const rowHostId = row.host_id;
				if (typeof id !== "string" || typeof rowHostId !== "string") continue;
				// Prefer the last title set during this request over the row's (#1128).
				const title =
					myHeard.titles.get(id) ??
					(typeof row.display_title === "string" ? row.display_title : "");
				// Whether it runs a command, for a pane over it while another host
				// is in view: its overlay offers Configure, and it is not restarted
				// on its own (#574).
				const directProcess = row.direct_process === 1 || row.direct_process === true;
				// And, for one that ended, whether the hub ended it itself: a kill,
				// found by a pane, keeps asking (#592).
				const endReason = row.status === "dead" ? endReasonOfRow(row) : undefined;
				nextIndex.set(id, {
					hostId: rowHostId,
					displayTitle: title,
					...(directProcess && { directProcess: true as const }),
					...(endReason !== undefined && { endReason }),
					...(row.status === "dead" && { ended: true as const }),
				});
				nextHostMap.set(id, rowHostId);
			}
			// What a host list requested after this fetch published meanwhile is newer than these rows (#1148);
			// a title heard since goes over it.
			for (const [id, listed] of myHeard.listed) {
				const title = myHeard.titles.get(id);
				nextIndex.set(id, title === undefined ? listed : { ...listed, displayTitle: title });
			}
			indexCommittedGeneration = myIndexGeneration;
			channelIndex.value = nextIndex;
			channelHostMap.value = nextHostMap;
			// Which terminals record, every host's, by the newer-news rule (#80).
			useRecordingsStore().mergeListed(recordingsAt, listedRecordings(rows));
		} catch {
			// An index that could not be read is an index that says nothing; the
			// tab bar falls back to what it showed before.
		} finally {
			indexTitlesDuringFetch.delete(myHeard);
		}
	}

	async function fetchChannels(hostId: string): Promise<void> {
		if (authStore.token === null) return;

		// ── 1. Capture generation FIRST — before any state mutation ──────────
		// Generation is incremented before loading/error are touched so the
		// per-generation lifecycle (loading start → loading end) is fully
		// bracketed by the same generation value.
		const myGeneration = ++fetchGeneration.value;
		const myStart = ++requestSeq;

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
		// Older generations can no longer commit: stop recording for them.
		statusesDuringFetch.clear();
		const myHeard = new Map<string, Heard | "deleted">();
		statusesDuringFetch.set(myGeneration, myHeard);
		const recordingsAt = useRecordingsStore().listFetchStarted();

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

			// Which of this host's terminals record, by the newer-news rule (#80).
			useRecordingsStore().mergeListed(recordingsAt, listedRecordings(rows));

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
			// A channel deleted here is gone from `channels.value`, so only the rows
			// the hub listed can bring one back.
			let merged = [...data.filter((c) => myHeard.get(c.id) !== "deleted"), ...wsChannelsToKeep];

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
						return withHeard(ch, p);
					}
					return ch;
				});
				if (statusUpdated) {
					merged = reconciled;
				}
			}

			// Statuses heard for listed channels since this fetch began override
			// its rows: an end heard meanwhile must not read live again (#1091).
			if (myHeard.size > 0) {
				merged = merged.map((ch) => {
					const heard = myHeard.get(ch.id);
					return heard === undefined || heard === "deleted" ? ch : withHeard(ch, heard);
				});
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

			// Populate persistent channelId → hostId map (survives host switch),
			// and the index that names this host's channels once another host is
			// being looked at.
			const nextHostMap = new Map(channelHostMap.value);
			const nextIndex = new Map(channelIndex.value);
			for (const ch of merged) {
				nextHostMap.set(ch.id, hostId);
				const entry: ChannelIndexEntry = {
					hostId,
					displayTitle: ch.displayTitle ?? "",
					...(ch.directProcess === true && { directProcess: true as const }),
					...(ch.status === "dead" && ch.endReason !== undefined && { endReason: ch.endReason }),
					...(ch.status === "dead" && { ended: true as const }),
				};
				nextIndex.set(ch.id, entry);
				// An index fetch in flight reads rows the hub may have listed before
				// this list: what this list publishes stays over them (#1148).
				for (const heardHere of indexTitlesDuringFetch) {
					if (heardHere.startedAt < myStart) heardHere.listed.set(ch.id, entry);
				}
			}
			// This list is the whole host: what an earlier list of it published for
			// a channel it no longer holds goes (#1148).
			const mergedIds = new Set(merged.map((c) => c.id));
			for (const heardHere of indexTitlesDuringFetch) {
				for (const [id, listed] of heardHere.listed) {
					if (listed.hostId === hostId && !mergedIds.has(id)) heardHere.listed.delete(id);
				}
			}
			channelHostMap.value = nextHostMap;
			channelIndex.value = nextIndex;

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
			statusesDuringFetch.delete(myGeneration);
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

	/** The end id this window last heard for a channel, wherever it keeps it (#932). */
	function recordedEndId(channelId: string): string | undefined {
		return (
			reports.value.get(channelId)?.endId ??
			channels.value.find((c) => c.id === channelId)?.endId ??
			pendingStatuses.value.get(channelId)?.endId
		);
	}

	/**
	 * What the hub says of a channel's status. A report of another end than
	 * the one this window recorded, and a report of the terminal running again,
	 * remove what the previous end said from the listed entry, its exit code
	 * and reason gone when the report has none (#932). The report itself is
	 * each time what the hub said last, as before; told again, the same end
	 * keeps its id there.
	 */
	function updateChannelStatus(
		channelId: string,
		status: Channel["status"],
		exitCode?: number,
		endReason?: ChannelEndReason,
		endId?: string,
	): void {
		if (status !== "dead") knownToHub(channelId);
		const previousEnd = recordedEndId(channelId);
		const replacesEnd = status !== "dead" || (endId !== undefined && endId !== previousEnd);
		const keptEnd = status === "dead" ? (endId ?? previousEnd) : undefined;
		reports.value = new Map(reports.value).set(channelId, {
			status,
			...(exitCode !== undefined && { exitCode }),
			...(endReason !== undefined && { endReason }),
			...(keptEnd !== undefined && { endId: keptEnd }),
		});
		const idx = channels.value.findIndex((c) => c.id === channelId);
		if (idx === -1) {
			// Channel not loaded yet — buffer for later application
			const next = new Map(pendingStatuses.value);
			next.set(
				channelId,
				bufferedStatus(next.get(channelId), {
					status,
					...(exitCode !== undefined && { exitCode }),
					...(endReason !== undefined && { endReason }),
					...(keptEnd !== undefined && { endId: keptEnd }),
					...(replacesEnd && { replacesEnd: true as const }),
				}),
			);
			pendingStatuses.value = next;
			return;
		}
		const existing = channels.value[idx];
		if (existing === undefined) return;
		heardDuringFetch(channelId, {
			status,
			...(exitCode !== undefined && { exitCode }),
			...(status === "dead" && endReason !== undefined && { endReason }),
			...(keptEnd !== undefined && { endId: keptEnd }),
			...(replacesEnd && { replacesEnd: true as const }),
		});
		// Why it ended goes with this end only: a terminal running again, or one
		// that ended by itself, has none (#592). A newer end, or a run, takes
		// the previous end's exit code and id with it (#932).
		const { endReason: _before, ...kept } = replacesEnd ? withoutEnd(existing) : existing;
		const updated: Channel = { ...kept, status };
		if (exitCode !== undefined) updated.exitCode = exitCode;
		if (keptEnd !== undefined) updated.endId = keptEnd;
		const next = [...channels.value];
		next[idx] = status === "dead" && endReason !== undefined ? { ...updated, endReason } : updated;
		channels.value = next;
	}

	/**
	 * The end a CHANNEL_DEAD names, answering an attach (#932). When this
	 * window recorded another end for that channel, or none, the answer's end
	 * replaces it wherever a card reads it, its exit code and reason gone when
	 * the answer has none. An answer naming no end changes nothing.
	 */
	function takeEndedAnswer(
		channelId: string,
		end: { endId?: string; exitCode?: number; endReason?: ChannelEndReason },
	): void {
		if (end.endId === undefined || end.endId === recordedEndId(channelId)) return;
		updateChannelStatus(channelId, "dead", end.exitCode, end.endReason, end.endId);
	}

	/** The hub's last report on a channel, whichever host it is on. */
	function reportOf(channelId: string | null): ChannelReport | undefined {
		return channelId === null ? undefined : reports.value.get(channelId);
	}

	/**
	 * Whether the hub ended this terminal itself (#580), as far as this window
	 * has heard: `killed`, `stopped`, or nothing for a terminal that ended by
	 * itself or has not ended.
	 *
	 * A pane that finds its terminal ended reads it here, rather than on a
	 * report it may never have heard (#592). The hub's last report wins: every
	 * socket starts with a STATE_SYNC that names the terminals killed, and one
	 * that runs again or ends again is reported. Without one, the list of the
	 * host in view says, then the index, whichever host it is on.
	 */
	function endReasonOf(channelId: string | null): ChannelEndReason | undefined {
		if (channelId === null) return undefined;
		const report = reports.value.get(channelId);
		if (report !== undefined) return report.status === "dead" ? report.endReason : undefined;
		const listed = channels.value.find((c) => c.id === channelId);
		if (listed !== undefined) return listed.status === "dead" ? listed.endReason : undefined;
		return channelIndex.value.get(channelId)?.endReason;
	}

	/**
	 * A channel's status as this client knows it: the list of the host in view
	 * where it is listed, what the hub last reported otherwise, and else that
	 * it had ended when the index was read, whichever host it is on.
	 *
	 * Tabs are global: a pane can front an ended terminal of a host whose list
	 * is not the one in view, with no report of it this session. Without the
	 * index, such a pane had nothing to say its terminal had ended (#594).
	 * The index says nothing of one that runs: a report does, and a report of
	 * it running wins over the index saying it had ended.
	 */
	function statusOf(channelId: string | null): Channel["status"] | undefined {
		if (channelId === null) return undefined;
		const listed = channels.value.find((c) => c.id === channelId);
		return (
			listed?.status ??
			reports.value.get(channelId)?.status ??
			(channelIndex.value.get(channelId)?.ended === true ? "dead" : undefined)
		);
	}

	/**
	 * Update the dynamic title for a channel (from TITLE_CHANGE WS message or ATTACH_OK).
	 * Silently ignored if the channel is not loaded yet.
	 */
	function setDynamicTitle(channelId: string, title: string): void {
		// Recorded even for a channel no list holds yet: a fetch in flight may list it.
		titleHeardDuringFetch(channelId, { dynamicTitle: title });
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
	 * A channel no list holds is still recorded for index fetches in flight; the index
	 * itself changes only for a channel it already holds.
	 */
	function setDisplayTitle(channelId: string, displayTitle: string): void {
		titleHeardDuringFetch(channelId, { displayTitle });
		for (const heardHere of indexTitlesDuringFetch) heardHere.titles.set(channelId, displayTitle);
		// The index keeps up even for a channel this host does not list, so the
		// tab still carries the last title it was given after a host switch.
		const indexed = channelIndex.value.get(channelId);
		if (indexed !== undefined && indexed.displayTitle !== displayTitle) {
			channelIndex.value = new Map(channelIndex.value).set(channelId, {
				...indexed,
				displayTitle,
			});
		}

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
		titleHeardDuringFetch(channelId, { processTitle: title });
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
			endReason?: ChannelEndReason;
		}>,
	): void {
		// Remember which channels the hub knows about — used after fetchChannels
		// to mark unknown channels as dead.
		lastSyncIds.value = new Set(syncChannels.map((s) => s.channelId));

		// What the hub says now about every channel it lists, whichever host is
		// in view. A STATE_SYNC follows every new socket, and a report kept from
		// before it can be out of date: a terminal brought back from another
		// window while this one was away stayed "dead" here, and a pane over
		// another host's terminal kept the exit overlay over a live shell
		// (#559). A status the report already has is left as it is: a new report
		// is news to a pane, and this is not.
		//
		// It also names the terminals killed, dead: a pane that finds one of them
		// ended reads why here, having heard no report of it (#592). That is news
		// too when the report had it dead for no reason.
		let nextReports: Map<string, ChannelReport> | null = null;
		for (const sc of syncChannels) {
			const known = reports.value.get(sc.channelId);
			if (known?.status === sc.status && known.endReason === sc.endReason) continue;
			nextReports ??= new Map(reports.value);
			nextReports.set(sc.channelId, {
				status: sc.status,
				...(sc.exitCode !== undefined && { exitCode: sc.exitCode }),
				...(sc.status === "dead" && sc.endReason !== undefined && { endReason: sc.endReason }),
			});
		}
		if (nextReports !== null) reports.value = nextReports;

		if (channels.value.length === 0) {
			// Channels not loaded yet — buffer all
			const next = new Map(pendingStatuses.value);
			for (const sc of syncChannels) {
				next.set(
					sc.channelId,
					bufferedStatus(next.get(sc.channelId), {
						status: sc.status,
						...(sc.exitCode !== undefined && { exitCode: sc.exitCode }),
						...(sc.status !== "dead" && { replacesEnd: true as const }),
					}),
				);
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
			if (sc) {
				heardDuringFetch(sc.channelId, {
					status: sc.status,
					...(sc.exitCode !== undefined && { exitCode: sc.exitCode }),
					...(sc.status === "dead" && sc.endReason !== undefined && { endReason: sc.endReason }),
					...(sc.status !== "dead" && { replacesEnd: true as const }),
				});
			}
			if (sc && (ch.status !== sc.status || ch.endReason !== sc.endReason)) {
				changed = true;
				const { endReason: _before, ...rest } = ch;
				return {
					...rest,
					status: sc.status,
					...(sc.exitCode !== undefined && { exitCode: sc.exitCode }),
					...(sc.status === "dead" && sc.endReason !== undefined && { endReason: sc.endReason }),
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
				next.set(
					sc.channelId,
					bufferedStatus(next.get(sc.channelId), {
						status: sc.status,
						...(sc.exitCode !== undefined && { exitCode: sc.exitCode }),
						...(sc.status !== "dead" && { replacesEnd: true as const }),
					}),
				);
			}
		}
		if (next.size > 0) {
			pendingStatuses.value = next;
		}
	}

	/**
	 * Kill a channel on the hub (its PTY and everything started in it). It stays
	 * listed as dead, as the hub keeps it, like a terminal whose shell exited:
	 * removing it only here made it come back as dead at the next launch.
	 * "Delete" on the dead channel purges it.
	 */
	async function killChannel(channelId: string): Promise<void> {
		try {
			await hubFetch(`${hubBaseUrl()}/api/channels/${channelId}`, {
				method: "DELETE",
				headers: { Authorization: `Bearer ${authStore.token}` },
			});
		} catch {
			// Best-effort: the hub may be unreachable, or the channel already dead.
		}
		const idx = channels.value.findIndex((c) => c.id === channelId);
		const existing = channels.value[idx];
		if (existing && existing.status !== "dead") {
			const next = [...channels.value];
			next[idx] = { ...existing, status: "dead" as const };
			channels.value = next;
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
		// A terminal that starts has no end, whichever host it is on: the end
		// this window heard for it goes from its report (#932).
		reports.value = new Map(reports.value).set(msg.channelId, { status: msg.status });

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

		// A creation tells the display title anew, on any host: the titles heard
		// before it, for an index fetch in flight, go (#1128).
		for (const heardHere of indexTitlesDuringFetch) {
			if (msg.displayTitle === undefined) heardHere.titles.delete(msg.channelId);
			else heardHere.titles.set(msg.channelId, msg.displayTitle);
		}

		// Ignore channels for other hosts — this client may be viewing a
		// different host and should not accumulate foreign channels.
		if (activeHostId.value !== msg.hostId) return;

		// A channel this client already knows is either one it just fetched after
		// its own SPAWN_OK, or a dead terminal that has just been brought back
		// under its own id. Both are the hub's truth about it, so take it: the
		// one that was dead is live again, on a new session, and skipping this
		// left it greyed out in the sidebar with its terminal running behind it.
		// A fetch in flight may list it with an older row, ended (#1091).
		heardDuringFetch(msg.channelId, {
			status: msg.status,
			replacesEnd: true,
			row: {
				sessionId: msg.sessionId,
				cols: msg.cols,
				rows: msg.rows,
				updatedAt: msg.updatedAt,
				...(msg.displayTitle !== undefined && { displayTitle: msg.displayTitle }),
			},
		});
		knownToHub(msg.channelId);

		const knownIndex = channels.value.findIndex((c) => c.id === msg.channelId);
		if (knownIndex !== -1) {
			const known = channels.value[knownIndex];
			if (known !== undefined) {
				// Its end, why it came and its exit code are over (#592, #932).
				const rest = withoutEnd(known);
				const revived: Channel = {
					...rest,
					sessionId: msg.sessionId,
					status: msg.status,
					cols: msg.cols,
					rows: msg.rows,
					updatedAt: msg.updatedAt,
					...(msg.displayTitle !== undefined && { displayTitle: msg.displayTitle }),
				};
				const next = [...channels.value];
				next[knownIndex] = revived;
				channels.value = next;
			}
			return;
		}

		const channel: Channel = {
			id: msg.channelId,
			sessionId: msg.sessionId,
			...(msg.shell !== undefined && { shell: msg.shell }),
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

	/**
	 * The spawns new terminals owe, by the pending id their layout leaf holds.
	 *
	 * A record belongs to the pending id, not to a pane: a split or a move mounts
	 * another pane over the same id, and that pane takes up the spawn where the
	 * one before it left it (#980). It goes once no pane holds it and no spawn of
	 * it is in flight. The panes count themselves in and out, so it is no
	 * reactive state.
	 */
	const pendingSpawns = new Map<string, PendingSpawn>(
		[...loadStoredSpawns()].map(([tempId, { hostId, sent }]) => [
			tempId,
			{ hostId, holders: 0, run: interruptedRun(!sent), restored: true, sent },
		]),
	);

	/** The records as the next page is to find them. */
	function storedSpawns(except?: string): Map<string, StoredSpawn> {
		const spawns = new Map<string, StoredSpawn>();
		for (const [tempId, { hostId, sent }] of pendingSpawns) {
			if (tempId !== except) spawns.set(tempId, { hostId, sent });
		}
		return spawns;
	}

	/**
	 * Keep the records for the next page. A storage that refuses is ignored, as
	 * the layout's is: no pane of this page depends on it, and the next page finds
	 * what was last accepted.
	 */
	function storePendingSpawns(): void {
		try {
			writeStoredSpawns(storedSpawns());
		} catch {
			// Nothing to do: the next page finds what was last written.
		}
	}

	/**
	 * The next page must never offer to start a terminal whose SPAWN went out:
	 * the hub may have made it. If the write saying so is refused, a refused
	 * write keeps the value before it, which says no SPAWN went out, so the
	 * record is taken out of storage instead, whole key if need be, and that page
	 * knows nothing of it, as before #992. A storage that refuses even the removal
	 * keeps what it last accepted.
	 */
	function storeSent(tempId: string): void {
		try {
			writeStoredSpawns(storedSpawns());
			return;
		} catch {
			// Below.
		}
		try {
			writeStoredSpawns(storedSpawns(tempId));
			return;
		} catch {
			// Below.
		}
		try {
			localStorage.removeItem(PENDING_SPAWNS_KEY);
		} catch {
			// Refused too: what it last accepted stays, which nothing here can change.
		}
	}

	function registerPendingSpawn(tempId: string, hostId: string): void {
		pendingSpawns.set(tempId, { hostId, holders: 0, run: null, restored: false, sent: false });
		storePendingSpawns();
	}

	/** Whether `tempId`'s record was left by the page before this one (#992). */
	function pendingSpawnRestored(tempId: string): boolean {
		return pendingSpawns.get(tempId)?.restored === true;
	}

	/**
	 * A load forgets the records of ids its saved layout no longer holds: no pane
	 * will show them (#992).
	 */
	function forgetPendingSpawnsNotIn(heldIds: ReadonlySet<string>): void {
		let forgot = false;
		for (const tempId of [...pendingSpawns.keys()]) {
			if (heldIds.has(tempId)) continue;
			pendingSpawns.delete(tempId);
			forgot = true;
		}
		if (forgot) storePendingSpawns();
	}

	/**
	 * A Retry on a restored record that ended before its SPAWN was asked for,
	 * its connection refused: the record shows that failure again, so a pane
	 * remounted over the id waits for a click too, instead of spawning (#992).
	 */
	function failRestoredSpawnBeforeSend(tempId: string, err: unknown): void {
		const record = pendingSpawns.get(tempId);
		if (record === undefined || !record.restored || record.run !== null) return;
		const outcome = Promise.reject<SpawnedTerminal>(err);
		outcome.catch(() => {});
		record.run = { state: "failed", outcome };
	}

	/**
	 * A pane showing `tempId` counts itself in. Returns the host its spawn is
	 * for, or null when no spawn is owed for that id.
	 */
	function holdPendingSpawn(tempId: string): string | null {
		const record = pendingSpawns.get(tempId);
		if (record === undefined) return null;
		record.holders += 1;
		return record.hostId;
	}

	/** A pane that held `tempId` no longer shows it. */
	function releasePendingSpawn(tempId: string): void {
		const record = pendingSpawns.get(tempId);
		if (record === undefined) return;
		record.holders -= 1;
		forgetIfUnheld(tempId, record);
	}

	function forgetIfUnheld(tempId: string, record: PendingSpawn): void {
		if (record.holders > 0 || record.run?.state === "running") return;
		if (pendingSpawns.get(tempId) !== record) return;
		pendingSpawns.delete(tempId);
		storePendingSpawns();
	}

	/**
	 * The spawn `tempId` owes: the one in flight, or its outcome, or one started
	 * now at `cols` × `rows` when none was. Null when no spawn is owed for it.
	 *
	 * Every pane over the id gets the same run: the terminal it started and the
	 * size its PTY was spawned at, or the same error, with its `code` and
	 * `asked`. A failed run stays until a Retry clears it.
	 */
	function runPendingSpawn(tempId: string, cols: number, rows: number): PendingSpawnRun | null {
		const record = pendingSpawns.get(tempId);
		if (record === undefined) return null;
		if (record.run !== null) return record.run;
		// Its SPAWN may go out from here: a page that loads it after this must not
		// offer to start a second terminal (#992). Written for every run: one that
		// a refused write took out of storage comes back once storage accepts.
		record.sent = true;
		storeSent(tempId);
		// What its SPAWN_OK said of the agent's input (#1012).
		let adaptsInput = false;
		let streamsPaste = false;
		const run: PendingSpawnRun = {
			state: "running",
			outcome: spawnChannel(record.hostId, {
				cols,
				rows,
				select: false,
				onAdaptsInput: (adapts, streams) => {
					adaptsInput = adapts;
					streamsPaste = streams;
				},
			}).then(
				(channelId) => {
					run.state = "succeeded";
					forgetIfUnheld(tempId, record);
					return { channelId, cols, rows, adaptsInput, streamsPaste };
				},
				(err: unknown) => {
					run.state = "failed";
					forgetIfUnheld(tempId, record);
					throw err;
				},
			),
		};
		// Nobody may be waiting for it any more: every pane over it closed.
		run.outcome.catch(() => {});
		record.run = run;
		return run;
	}

	/** The run `tempId`'s spawn has had, if any, without starting one. */
	function pendingSpawnRun(tempId: string): PendingSpawnRun | null {
		return pendingSpawns.get(tempId)?.run ?? null;
	}

	/** Retry or Connect: a failed spawn is sent again, by the next pane to ask. */
	function clearFailedPendingSpawn(tempId: string): void {
		const record = pendingSpawns.get(tempId);
		if (record?.run?.state === "failed") record.run = null;
	}

	// -------------------------------------------------------------------------
	// WS: spawn a new channel on a host
	// -------------------------------------------------------------------------

	/**
	 * Learn what a spawn on `hostId` changed, without changing the host in view.
	 *
	 * The list is the host in view's, and only the rail chooses that host. A
	 * spawn can be on another one: a pane of a global tab bringing its terminal
	 * back, by its Restart or by the setting (#592), or a spawn answered after
	 * the rail moved. Fetching that host's list made it the host in view behind
	 * the rail's back, and the sidebar showed its terminals under a rail still
	 * on the other host, whose click then did nothing (#594). There, the index
	 * is what learns the terminal: its title, its host, that it runs.
	 */
	function refreshAfterSpawn(hostId: string): void {
		if (activeHostId.value === hostId) void fetchChannels(hostId);
		else void fetchChannelIndex();
	}

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
			/** Bring this dead terminal back rather than open a new one beside it. */
			reuseChannelId?: string;
			/**
			 * Nobody asked for it: the setting, or a host's return. A host its user
			 * disconnected is not connected again by it (#648).
			 */
			automatic?: boolean;
			/** Told what the SPAWN_OK said of the agent's input (#1012), before it resolves. */
			onAdaptsInput?: (adaptsInput: boolean, streamsPaste: boolean) => void;
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
			let unsubPrompts: Array<() => void> = [];
			let unsubConnecting: () => void = () => {};
			let unsubDisconnect: () => void = () => {};

			const stopWaiting = (): void => {
				unsubOk();
				unsubErr();
				for (const unsub of unsubPrompts) unsub();
				unsubConnecting();
				unsubDisconnect();
			};

			let deadline = Date.now() + SPAWN_DEADLINE_MS;
			let timer = setTimeout(() => {
				stopWaiting();
				reject(new Error(`SPAWN timeout — no SPAWN_OK after ${SPAWN_DEADLINE_MS / 1000}s`));
			}, SPAWN_DEADLINE_MS);
			// Waits longer, for `why`: never shorter than a hold already given, so
			// that a prompt shown while the hub connects keeps the connection's
			// wait, and a late one gets its own in full (#1034).
			const holdFor = (ms: number, why: string): void => {
				const until = Date.now() + ms;
				if (until <= deadline) return;
				deadline = until;
				clearTimeout(timer);
				timer = setTimeout(() => {
					stopWaiting();
					reject(new Error(why));
				}, ms);
			};
			/** The hub said it is connecting the host for this SPAWN (#1034). */
			let connecting = false;

			// The password or passphrase its host last asked for, if any: a refusal
			// because none was given says which (#875).
			let asked: AskedSecret | undefined;

			// A prompt this spawn caused is a question for a person — a fingerprint
			// to compare, a passphrase to fetch — and ten seconds is not that. The
			// clock stops while one is on screen, leaving the long backstop for a
			// hub that has genuinely stopped answering; what comes back is
			// SPAWN_OK, or the ERROR the hub sends when the answer was no.
			type Prompt = { type: string; hostId?: string; promptType?: string };
			const holdForAnAnswer = (msg: Prompt): void => {
				// While the hub connects the host, a prompt for the jump the
				// connection goes through names the jump, not this host (#1034).
				if (!connecting && msg.hostId !== undefined && msg.hostId !== hostId) return;
				if (
					(msg.hostId === undefined || msg.hostId === hostId) &&
					(msg.promptType === "password" || msg.promptType === "passphrase")
				) {
					asked = msg.promptType;
				}
				holdFor(SPAWN_PROMPTED_DEADLINE_MS, "The hub stopped answering while a prompt was open.");
			};
			unsubPrompts = (["HOST_VERIFY", "AUTH_PROMPT", "AGENT_BINARY_VERIFY"] as const).map((type) =>
				sessionStore.wsClient.on(type, (msg) => {
					holdForAnAnswer(msg as unknown as Prompt);
				}),
			);

			// The socket carries every ERROR the hub has for this window: another
			// pane's ATTACH refused, a write lock denied. Most name no host, and
			// this SPAWN took the first of them for its own failure (#777). So it
			// names itself, and a hub whose AUTH_OK says it echoes the name puts it
			// on everything that answers this SPAWN: from that hub, an answer
			// without it, or with another, is not this one's.
			const requestId = generateId();
			const hubEchoes = sessionStore.hubEchoesSpawnRequestId;
			// A hub older than that names no answer. A terminal brought back is
			// answered under its own id, and every answer names its host: one for
			// another spawn is not this one's. Several panes bring their terminals
			// back at once when their host returns (#605), and each took the first
			// answer to come for its own.
			const notOurs = (msg: { hostId?: string; channelId?: string; requestId?: string }): boolean =>
				((hubEchoes || msg.requestId !== undefined) && msg.requestId !== requestId) ||
				(msg.hostId !== undefined && msg.hostId !== hostId) ||
				(opts?.reuseChannelId !== undefined &&
					msg.channelId !== undefined &&
					msg.channelId !== opts.reuseChannelId);

			unsubOk = sessionStore.wsClient.on("SPAWN_OK", (msg) => {
				if (msg.type === "SPAWN_OK") {
					if (notOurs(msg)) return;
					clearTimeout(timer);
					stopWaiting();
					// Its host is known now, before any listing says so: a pane over it
					// on another host than the one in view reads its profile and its
					// theme from this, and would take the host in view's meanwhile.
					registerChannelHost(msg.channelId, hostId);
					opts?.onAdaptsInput?.(
						"adaptsInput" in msg && msg.adaptsInput === true,
						"streamsPaste" in msg && msg.streamsPaste === true,
					);
					refreshAfterSpawn(hostId);
					if (opts?.select !== false) {
						selectChannel(msg.channelId);
					}
					resolve(msg.channelId);
				}
			});

			// Cancel the spawn wait immediately on any ERROR — the hub sends ERROR
			// (e.g. SSH_CONNECT_FAILED, SPAWN_FAILED) instead of SPAWN_OK when the
			// session cannot be established. Without this the caller would silently
			// wait out SPAWN_DEADLINE_MS before seeing the timeout message.
			unsubErr = sessionStore.wsClient.on("ERROR", (msg) => {
				if (msg.type === "ERROR") {
					if (notOurs(msg)) return;
					clearTimeout(timer);
					stopWaiting();
					// The host is away: what the hub says of it now is the freshest word
					// this window has, and a pane waits on it (#605).
					if (
						msg.code === ErrorCode.HOST_UNREACHABLE &&
						msg.hostId !== undefined &&
						msg.hostStatus !== undefined
					) {
						useHostsStore().updateSessionStatus(msg.hostId, msg.hostStatus);
					}
					// The code travels with it, and the host: what a pane does about it is
					// not a decision to make by reading a sentence.
					reject(
						Object.assign(new Error(`${msg.code}: ${msg.message}`), {
							code: msg.code,
							...(msg.hostId !== undefined && { hostId: msg.hostId }),
							...(msg.code === ErrorCode.AUTH_CANCELLED && asked !== undefined && { asked }),
						}),
					);
				}
			});

			// The hub connects the host before it answers, each wait under its own
			// bound: the pane waits for that answer rather than its 15 s, and gives
			// up at once if the socket it would come on closes (#1034).
			unsubConnecting = sessionStore.wsClient.on("HOST_CONNECTING", (msg) => {
				if (msg.type !== "HOST_CONNECTING" || notOurs(msg) || connecting) return;
				connecting = true;
				holdFor(
					SPAWN_CONNECTING_DEADLINE_MS,
					"The hub stopped answering while it connected the host.",
				);
				unsubDisconnect = sessionStore.wsClient.onDisconnect(() => {
					clearTimeout(timer);
					stopWaiting();
					reject(new Error("The connection to the hub was lost while it connected the host."));
				});
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
				requestId,
				...(autoGroupId !== undefined ? { groupId: autoGroupId } : {}),
				...(opts?.cols !== undefined && opts?.rows !== undefined
					? { cols: opts.cols, rows: opts.rows }
					: {}),
				...(opts?.launchProfileId !== undefined ? { launchProfileId: opts.launchProfileId } : {}),
				...(opts?.shell !== undefined ? { shell: opts.shell } : {}),
				...(opts?.args !== undefined && opts.args.length > 0 ? { args: opts.args } : {}),
				...(opts?.directProcess ? { directProcess: true } : {}),
				...(opts?.reuseChannelId !== undefined ? { reuseChannelId: opts.reuseChannelId } : {}),
				...(opts?.automatic === true ? { automatic: true } : {}),
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

	/**
	 * The restart route's refusal, as the failure the pane shows or waits out:
	 * its host away, with the status the hub gave it (#605), or the status code.
	 */
	async function restFailureOf(res: Response): Promise<RestartFailure> {
		const generic: RestartFailure = { reason: `The hub could not restart it (${res.status}).` };
		let body: {
			error?: { code?: unknown; message?: unknown; host_id?: unknown; host_status?: unknown };
		};
		try {
			body = (await res.json()) as typeof body;
		} catch {
			return generic;
		}
		const error = body?.error;
		if (error?.code !== ErrorCode.HOST_UNREACHABLE || typeof error.host_id !== "string") {
			return generic;
		}
		if (typeof error.host_status === "string") {
			useHostsStore().updateSessionStatus(error.host_id, error.host_status as SessionStatus);
		}
		return {
			reason: typeof error.message === "string" ? error.message : generic.reason,
			hostAway: { hostId: error.host_id },
		};
	}

	/**
	 * Bring a terminal back. `automatic` when nobody asked for it — the "When a
	 * terminal ends" setting, or its host's return — which the hub refuses on
	 * a host its user disconnected, and the pane then waits for it (#648).
	 */
	async function restartChannel(
		channelId: string,
		hostIdHint?: string,
		/** `cols`/`rows`: the size the pane draws the terminal at, which it starts at (#930). */
		opts?: { automatic?: boolean; cols?: number; rows?: number },
	): Promise<boolean> {
		if (authStore.token === null) return false;
		setRestartFailure(channelId, null);

		// A dead terminal has no session and no agent left — the hub it belonged
		// to may be gone — so there is nothing for the hub to restart. Bringing it
		// back is a spawn under its own id, which is the path that knows how to
		// start a session and an agent from nothing.
		// A terminal this list does not carry is one from before a restart: the
		// list holds the current session's, the hub still knows the rest. Either
		// way it is not running, and bringing it back is the same gesture.
		const channel = channels.value.find((entry) => entry.id === channelId);
		if (channel === undefined || channel.status === "dead") {
			const hostId = hostIdHint ?? activeHostId.value;
			if (hostId === null || hostId === undefined) return false;
			try {
				await spawnChannel(hostId, {
					reuseChannelId: channelId,
					...(channel?.shell !== undefined ? { shell: channel.shell } : {}),
					...(channel?.args !== undefined && channel.args.length > 0 ? { args: channel.args } : {}),
					...(opts?.automatic === true ? { automatic: true } : {}),
					...(opts?.cols !== undefined && opts?.rows !== undefined
						? { cols: opts.cols, rows: opts.rows }
						: {}),
				});
				return true;
			} catch (err) {
				// A cancelled prompt leaves none: nothing failed (#812).
				setRestartFailure(channelId, restartFailureOf(err, hostId));
				return false;
			}
		}

		let res: Response;
		try {
			res = await hubFetch(`${hubBaseUrl()}/api/channels/${channelId}/restart`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${authStore.token}`,
				},
			});
		} catch (err) {
			// The hub was not reached: a failure to restart like any other, said
			// on the terminal's card rather than thrown at a pane (#942).
			setRestartFailure(channelId, { reason: restartFailureReason(err) });
			return false;
		}
		if (!res.ok) {
			setRestartFailure(channelId, await restFailureOf(res));
			return false;
		}

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
		deletedDuringFetch([channelId]);
		channels.value = channels.value.filter((c) => c.id !== channelId);
		const nextMap = new Map(channelHostMap.value);
		nextMap.delete(channelId);
		channelHostMap.value = nextMap;
		return true;
	}

	/**
	 * Bulk purge all dead channels for the active host.
	 * Removes exactly the ids the hub says it purged: it picks the dead channels
	 * when it handles the request, which can differ from this window's list by
	 * then (#1108). Returns those ids: none when the hub refused or named none,
	 * and a window closes only what they cover (#1117).
	 */
	async function purgeDeadChannels(): Promise<string[]> {
		if (authStore.token === null || activeHostId.value === null) return [];
		// The host is read before the request: the list in view may be another
		// host's by the time the hub answers (#1104).
		const hostId = activeHostId.value;
		const res = await hubFetch(`${hubBaseUrl()}/api/channels/dead`, {
			method: "DELETE",
			headers: {
				Authorization: `Bearer ${authStore.token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ host_id: hostId }),
		});
		if (!res.ok) return [];
		// The purge is done on the hub; an unreadable answer names nothing to remove here.
		let ids: string[];
		try {
			ids = ((await res.json()) as { purged_ids?: string[] }).purged_ids ?? [];
		} catch {
			return [];
		}
		const purged = new Set(ids);
		deletedDuringFetch(purged);
		channels.value = channels.value.filter((c) => !purged.has(c.id));
		const nextMap = new Map(channelHostMap.value);
		for (const id of purged) nextMap.delete(id);
		channelHostMap.value = nextMap;
		return [...purged];
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
		channelIndex,
		welcomeChannel,
		fetchGroups,
		fetchChannels,
		fetchChannelIndex,
		selectChannel,
		markUnread,
		updateChannelStatus,
		takeEndedAnswer,
		reportOf,
		endReasonOf,
		statusOf,
		setDynamicTitle,
		setDisplayTitle,
		updateProcessTitle,
		applyStateSync,
		killChannel,
		handleChannelCreated,
		spawnChannel,
		registerPendingSpawn,
		holdPendingSpawn,
		releasePendingSpawn,
		runPendingSpawn,
		pendingSpawnRun,
		clearFailedPendingSpawn,
		pendingSpawnRestored,
		forgetPendingSpawnsNotIn,
		failRestoredSpawnBeforeSend,
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
		restartFailures,
		deleteChannel,
		purgeDeadChannels,
	};
});
