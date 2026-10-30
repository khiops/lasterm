import {
	type Host,
	type HostConnectionResponse,
	type HostGroup,
	type HostsChangedMessage,
	type SessionStatus,
	type StopKeepingAgentResponse,
	toCamelCase,
} from "@lasterm/shared";
import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import {
	type HubAnswer,
	type HubRefusal,
	hubRefusal,
	hubUnreachable,
	toastRefusal,
} from "../utils/hub-answer.js";
import { type HubFetchInit, hubFetch } from "../utils/hub-fetch.js";
import { hubBaseUrl } from "../utils/hub-url.js";
import { useAuthStore } from "./auth.js";
import { useSessionStore } from "./session.js";

/**
 * Derived per-host connectivity status rendered in the rail status dot.
 *
 * `disconnected` is a host its user disconnected (#648): offline, like one
 * never connected, but on purpose, and the hub does not reach for it again
 * until someone acts on it. `error` is one the hub lost.
 */
export type HostStatus = "live" | "offline" | "error" | "reconnecting" | "disconnected";

/** What the hub answered a Connect, Reconnect or Disconnect, reduced to what a caller reads (#648). */
export interface HostConnectionAnswer {
	readonly ok: boolean;
	readonly status: number;
	readonly body: Partial<HostConnectionResponse> & {
		readonly error?: {
			readonly code?: string;
			readonly message?: string;
			readonly terminals?: number;
		};
	};
}

/** What the hub answered a host's create, update or duplicate: the host it stored, or its refusal. */
export type HostSaveAnswer = { readonly ok: true; readonly host: Host } | HubRefusal;

/** What the hub answered a new host group: the group it stored, or its refusal. */
export type HostGroupCreateAnswer = { readonly ok: true; readonly group: HostGroup } | HubRefusal;

export interface StopKeepingAgentBody {
	end_terminals?: boolean;
	force?: boolean;
}

export interface StopKeepingAgentAnswer {
	readonly ok: boolean;
	readonly status: number;
	readonly body: Partial<StopKeepingAgentResponse> & {
		readonly error?: {
			code?: string;
			message?: string;
			terminals?: number;
			other_owner_channels?: number;
		};
	};
}

/**
 * Map a raw SessionStatus value (or absence thereof) to the four visual states
 * shown in the host rail badge dot.
 */
function sessionStatusToHostStatus(status: SessionStatus | undefined): HostStatus {
	if (status === undefined) return "offline";
	switch (status) {
		case "active":
			return "live";
		case "detached":
			return "live";
		case "starting":
			return "reconnecting";
		case "disconnected":
			return "error";
		case "closed":
			return "offline";
	}
}

/**
 * This tab's selected host, kept for the tab alone (#561). Since #560 a hidden
 * tab reloads by itself after a hub upgrade, and without this it came back on
 * the first host rather than the one it was showing. It is per tab, so a new tab
 * still opens on the first host.
 */
export const SELECTED_HOST_KEY = "lasterm:selected-host";

/**
 * How long news that the hosts or their groups changed waits before this
 * window reads them again (#783). Every piece of news arriving meanwhile is
 * read with it: a burst is one read.
 */
export const HOSTS_CHANGED_READ_DELAY_MS = 150;

function readSelectedHost(): string | null {
	try {
		return window.sessionStorage.getItem(SELECTED_HOST_KEY);
	} catch {
		return null;
	}
}

function writeSelectedHost(hostId: string | null): void {
	try {
		if (hostId === null) window.sessionStorage.removeItem(SELECTED_HOST_KEY);
		else window.sessionStorage.setItem(SELECTED_HOST_KEY, hostId);
	} catch {
		// Storage refused: a reload lands on the first host, as it always did.
	}
}

export const useHostsStore = defineStore("hosts", () => {
	const authStore = useAuthStore();

	const hosts = ref<Host[]>([]);
	const hostGroups = ref<HostGroup[]>([]);
	const selectedHostId = ref<string | null>(null);
	watch(selectedHostId, writeSelectedHost, { flush: "sync" });
	const loading = ref(false);
	const error = ref<string | null>(null);

	/**
	 * Per-host session statuses received via SESSION_STATE WebSocket messages.
	 * Key = hostId, value = most-recent SessionStatus for that host.
	 */
	const _sessionStatuses = ref<Map<string, SessionStatus>>(new Map());

	/**
	 * Sorted hosts — server already returns them in the correct order
	 * (local first, then by group/sort_order).
	 */
	const sortedHosts = computed(() => hosts.value);

	/** A list read that is worth showing whenever it arrives. */
	const always = (): boolean => true;

	/**
	 * Load the host groups. A refusal comes back with the hub's reason (#734):
	 * without its groups, the rail cannot show the hosts in them. A hub that
	 * does not answer throws.
	 */
	function fetchHostGroups(): Promise<HubAnswer> {
		return loadHostGroups(always);
	}

	/** Load the host groups, and show them if `current()` still says so once they arrive. */
	async function loadHostGroups(current: () => boolean): Promise<HubAnswer> {
		const res = await hubFetch(`${hubBaseUrl()}/api/host-groups`, {
			headers: { Authorization: `Bearer ${authStore.token}` },
		});
		if (!res.ok) return hubRefusal(res);
		const raw = (await res.json()) as Array<{
			id: string;
			name: string;
			sort_order: number;
			color?: string | null;
			created_at: string;
			updated_at: string;
		}>;
		if (!current()) return { ok: true };
		hostGroups.value = raw.map((g) => ({
			id: g.id,
			name: g.name,
			sortOrder: g.sort_order,
			color: g.color ?? null,
			createdAt: g.created_at,
			updatedAt: g.updated_at,
		}));
		return { ok: true };
	}

	/**
	 * Load the hosts. Why they did not load, as the hub said it or that it did
	 * not answer, goes in `error` for the rail to show with a retry (#758). It
	 * stays there until a load succeeds, so a retry under way still says it.
	 */
	function fetchHosts(): Promise<void> {
		return loadHosts(always);
	}

	/**
	 * Load the hosts, and show them if `current()` still says so once they
	 * arrive: a list read while this window was writing may predate its write,
	 * and would put back what it just changed (#783).
	 */
	async function loadHosts(current: () => boolean): Promise<void> {
		if (authStore.token === null) return;
		loading.value = true;
		try {
			let res: Response;
			try {
				res = await hubFetch(`${hubBaseUrl()}/api/hosts`, {
					headers: { Authorization: `Bearer ${authStore.token}` },
				});
			} catch (err) {
				error.value = hubUnreachable(err);
				return;
			}
			if (!res.ok) {
				error.value = (await hubRefusal(res)).message;
				return;
			}
			const data = toCamelCase(await res.json()) as Host[];
			if (!current()) return;
			hosts.value = data;
			error.value = null;
			// Nothing selected yet: the host this tab showed before it reloaded, if
			// the hub still has it, else the first one. The same when the host
			// selected is gone, deleted from another window (#783); one still
			// there stays selected.
			const selected = selectedHostId.value;
			if (selected === null || !data.some((h) => h.id === selected)) {
				const remembered = readSelectedHost();
				selectedHostId.value = data.some((h) => h.id === remembered)
					? remembered
					: (data[0]?.id ?? null);
			}
			// Populate groups on first load, and again while a host is in one this
			// window does not know: not loaded yet, or made elsewhere since (#758).
			// Nobody asked for them but the rail, so a toast says why they did not
			// come (#734).
			const known = new Set(hostGroups.value.map((g) => g.id));
			if (known.size === 0 || data.some((h) => h.hostGroupId && !known.has(h.hostGroupId))) {
				await toastRefusal(loadHostGroups(current));
			}
		} catch (err) {
			error.value = err instanceof Error ? err.message : String(err);
		} finally {
			loading.value = false;
		}
	}

	function selectHost(hostId: string): void {
		selectedHostId.value = hostId;
	}

	// ─── Changes made elsewhere (#783) ──────────────────────────────────────

	/**
	 * This window's own writes to the hosts and their groups: how many are
	 * under way, and how many ever started. A list read meanwhile may predate
	 * one, and showing it would undo, for a moment, what the write just did.
	 */
	let writesUnderWay = 0;
	let writesStarted = 0;

	/** Send one of this window's writes to the hosts or their groups, counted while under way. */
	async function hubWrite(url: string, init: HubFetchInit): Promise<Response> {
		writesUnderWay++;
		writesStarted++;
		try {
			return await hubFetch(url, init);
		} finally {
			writesUnderWay--;
		}
	}

	/** The lists the news received asks to read again, not read yet. */
	let hostsToRead = false;
	let groupsToRead = false;
	let readTimer: ReturnType<typeof setTimeout> | null = null;
	let reading = false;

	/**
	 * The hub said the hosts or their groups changed: another window, another
	 * device, the API, or this window's own write. They are read again once
	 * the news has stopped for a moment, so a burst is one read. What the user
	 * holds stays: the host selected, and an open host dialog, whose fields
	 * keep what was typed while its checks see the new list.
	 */
	function hubChanged(scope: HostsChangedMessage["scope"]): void {
		if (scope !== "groups") hostsToRead = true;
		if (scope !== "hosts") groupsToRead = true;
		scheduleRead();
	}

	function scheduleRead(): void {
		if (readTimer !== null || reading) return;
		readTimer = setTimeout(() => {
			readTimer = null;
			void readChanged();
		}, HOSTS_CHANGED_READ_DELAY_MS);
	}

	async function readChanged(): Promise<void> {
		// A write of this window under way: its own news follows it.
		if (writesUnderWay > 0) {
			scheduleRead();
			return;
		}
		const wantHosts = hostsToRead;
		const wantGroups = groupsToRead;
		hostsToRead = false;
		groupsToRead = false;
		const startedBefore = writesStarted;
		const current = (): boolean => writesStarted === startedBefore && writesUnderWay === 0;
		reading = true;
		try {
			// The groups first: the hosts then find theirs known. Neither throws:
			// a refusal is said as for a first load, in a toast and in the rail.
			if (wantGroups) await toastRefusal(loadHostGroups(current));
			if (wantHosts) await loadHosts(current);
		} finally {
			reading = false;
			// Overtaken by a write of this window: read again once it is done.
			if (!current()) {
				hostsToRead ||= wantHosts;
				groupsToRead ||= wantGroups;
			}
			if (hostsToRead || groupsToRead) scheduleRead();
		}
	}

	/** Keep a host this window stored, or replace it when a read of the list brought it first. */
	function keepStoredHost(host: Host): void {
		const idx = hosts.value.findIndex((h) => h.id === host.id);
		if (idx >= 0) hosts.value[idx] = host;
		else hosts.value = [...hosts.value, host];
	}

	/**
	 * Update the cached session status for a host.
	 * Called by the session store whenever a SESSION_STATE message arrives.
	 */
	/**
	 * Hosts served by an agent that is not the one this hub carries, as the hub
	 * reports it: present means a disagreement, absent means none (#456).
	 */
	const _outdatedAgents = ref<Map<string, { running: string; expected: string }>>(new Map());

	/** What disagrees on this host, or null when nothing does. */
	function getOutdatedAgent(hostId: string): { running: string; expected: string } | null {
		return _outdatedAgents.value.get(hostId) ?? null;
	}

	function rememberOutdatedAgent(
		hostId: string,
		outdated: { running: string; expected: string } | undefined,
	): void {
		const known = _outdatedAgents.value.get(hostId);
		if (outdated === undefined) {
			// The message says they agree now: an agent that was replaced.
			if (known === undefined) return;
			const next = new Map(_outdatedAgents.value);
			next.delete(hostId);
			_outdatedAgents.value = next;
			return;
		}
		if (known?.running === outdated.running && known.expected === outdated.expected) return;
		_outdatedAgents.value = new Map(_outdatedAgents.value).set(hostId, outdated);
	}

	/**
	 * Terminals other Lasterm hubs hold on the agent serving a host, as the hub
	 * reports it: present when there are some, absent when there are none (#127).
	 */
	const _otherOwnerChannels = ref<Map<string, number>>(new Map());

	/** How many terminals other hubs hold on this host's agent, or null when none. */
	function getOtherOwnerChannels(hostId: string): number | null {
		return _otherOwnerChannels.value.get(hostId) ?? null;
	}

	function rememberOtherOwnerChannels(hostId: string, count: number | undefined): void {
		const known = _otherOwnerChannels.value.get(hostId);
		if (count === known) return;
		const next = new Map(_otherOwnerChannels.value);
		if (count === undefined) next.delete(hostId);
		else next.set(hostId, count);
		_otherOwnerChannels.value = next;
	}

	const _connectedThroughRemoteDaemon = ref<Map<string, true>>(new Map());

	function isConnectedThroughRemoteDaemon(hostId: string): boolean {
		return _connectedThroughRemoteDaemon.value.has(hostId);
	}

	function rememberConnectedThroughRemoteDaemon(
		hostId: string,
		connected: boolean | undefined,
	): void {
		const next = new Map(_connectedThroughRemoteDaemon.value);
		if (connected === true) next.set(hostId, true);
		else next.delete(hostId);
		_connectedThroughRemoteDaemon.value = next;
	}

	function setConnectedThroughRemoteDaemon(hostIds: readonly string[]): void {
		_connectedThroughRemoteDaemon.value = new Map(hostIds.map((id) => [id, true]));
	}

	/**
	 * Hosts whose SSH server refused SFTP, as the hub reports it: present while
	 * it does (#722). Not an error: the hub sends its agent over the SSH command
	 * channel there, and the host only says so.
	 */
	const _sftpUnavailable = ref<Map<string, true>>(new Map());

	function isSftpUnavailable(hostId: string): boolean {
		return _sftpUnavailable.value.has(hostId);
	}

	function rememberSftpUnavailable(hostId: string, unavailable: boolean | undefined): void {
		if ((unavailable === true) === _sftpUnavailable.value.has(hostId)) return;
		const next = new Map(_sftpUnavailable.value);
		if (unavailable === true) next.set(hostId, true);
		else next.delete(hostId);
		_sftpUnavailable.value = next;
	}

	function setSftpUnavailable(hostIds: readonly string[]): void {
		_sftpUnavailable.value = new Map(hostIds.map((id) => [id, true]));
	}

	/**
	 * Hosts meant to keep an agent running whose SSH server refused the socket
	 * forwarding that reaches it, as the hub reports it (#765). The hub runs
	 * their agent over the connection instead, so their terminals end with it.
	 */
	const _socketForwardingRefused = ref<Map<string, true>>(new Map());

	function isSocketForwardingRefused(hostId: string): boolean {
		return _socketForwardingRefused.value.has(hostId);
	}

	function rememberSocketForwardingRefused(hostId: string, refused: boolean | undefined): void {
		if ((refused === true) === _socketForwardingRefused.value.has(hostId)) return;
		const next = new Map(_socketForwardingRefused.value);
		if (refused === true) next.set(hostId, true);
		else next.delete(hostId);
		_socketForwardingRefused.value = next;
	}

	function setSocketForwardingRefused(hostIds: readonly string[]): void {
		_socketForwardingRefused.value = new Map(hostIds.map((id) => [id, true]));
	}

	function stopKeepingAgent(
		hostId: string,
		body: StopKeepingAgentBody,
	): Promise<StopKeepingAgentAnswer> {
		return postHostConnection(hostId, "agent/stop-keeping", { ...body });
	}

	function replaceCachedHost(host: Host): void {
		const idx = hosts.value.findIndex((h) => h.id === host.id);
		if (idx >= 0) hosts.value[idx] = host;
	}

	/** Hosts their user disconnected, as the hub last said (#648). */
	const _disconnectedByUser = ref<ReadonlySet<string>>(new Set());

	/** Whether the host's user disconnected it, and the hub waits for someone to act on it. */
	function isDisconnectedByUser(hostId: string): boolean {
		return _disconnectedByUser.value.has(hostId);
	}

	/** What a SESSION_STATE said of it: each one says, the flag there or not. */
	function rememberDisconnectedByUser(hostId: string, disconnected: boolean): void {
		if (_disconnectedByUser.value.has(hostId) === disconnected) return;
		const next = new Set(_disconnectedByUser.value);
		if (disconnected) next.add(hostId);
		else next.delete(hostId);
		_disconnectedByUser.value = next;
	}

	/** What a STATE_SYNC listed: the whole of it. */
	function setDisconnectedByUser(hostIds: readonly string[]): void {
		_disconnectedByUser.value = new Set(hostIds);
	}

	/** POST one of the host connection routes, and say what came back. */
	async function postHostConnection(
		hostId: string,
		action: "connect" | "reconnect" | "disconnect" | "agent/stop-keeping",
		body: Record<string, unknown>,
	): Promise<HostConnectionAnswer & StopKeepingAgentAnswer> {
		const clientId = authStore.clientId;
		// Stop keeping an agent stores No on the host; the others change no host.
		const send = action === "agent/stop-keeping" ? hubWrite : hubFetch;
		const res = await send(`${hubBaseUrl()}/api/hosts/${hostId}/${action}`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${authStore.token}`,
				"Content-Type": "application/json",
			},
			// This window's id: the questions a connection asks come here.
			body: JSON.stringify({
				...body,
				...(action !== "agent/stop-keeping" && clientId !== null && { client_id: clientId }),
			}),
		});
		let parsed: HostConnectionAnswer["body"] & StopKeepingAgentAnswer["body"] = {};
		try {
			parsed = (await res.json()) as HostConnectionAnswer["body"] & StopKeepingAgentAnswer["body"];
		} catch {
			// No body: the status says it.
		}
		if (parsed.host) parsed.host = toCamelCase(parsed.host) as Host;
		return { ok: res.ok, status: res.status, body: parsed };
	}

	/** Connect the host, without opening a terminal (#648). */
	function connectHost(hostId: string): Promise<HostConnectionAnswer> {
		return postHostConnection(hostId, "connect", {});
	}

	/** Close the host's connection and open it again; `force` ends what that ends (#648). */
	function reconnectHost(hostId: string, force: boolean): Promise<HostConnectionAnswer> {
		return postHostConnection(hostId, "reconnect", { force });
	}

	/** Close the host's connection, and keep it closed; `force` ends what that ends (#648). */
	function disconnectHost(hostId: string, force: boolean): Promise<HostConnectionAnswer> {
		return postHostConnection(hostId, "disconnect", { force });
	}

	function updateSessionStatus(hostId: string, status: SessionStatus): void {
		_sessionStatuses.value.set(hostId, status);
		// Trigger Vue reactivity on the Map by replacing the ref value
		_sessionStatuses.value = new Map(_sessionStatuses.value);
	}

	/**
	 * This hub has an agent of the host connected, as its last word on the
	 * host's session said: `active`, or `detached` with nobody attached.
	 *
	 * What a pane waiting for its host watches (#605), local hosts included:
	 * a local agent restarting is `disconnected` until the hub has it back,
	 * which the rail's dot, going by this window's own socket, does not show.
	 */
	function isHostConnected(hostId: string): boolean {
		const status = _sessionStatuses.value.get(hostId);
		return status === "active" || status === "detached";
	}

	function getHostStatus(hostId: string): HostStatus {
		// Local host ≡ the hub itself — if the WS connection is up, it's live.
		const host = hosts.value.find((h) => h.id === hostId);
		if (host?.type === "local") {
			const sessionStore = useSessionStore();
			return sessionStore.connected ? "live" : "offline";
		}
		if (_disconnectedByUser.value.has(hostId)) return "disconnected";
		return sessionStatusToHostStatus(_sessionStatuses.value.get(hostId));
	}

	/**
	 * Put a group's hosts in this order, shown at once. An order the hub
	 * refuses, or does not answer, is taken back (#734): the hosts it moved get
	 * their place and group again. A refusal comes back with the hub's reason;
	 * a hub that does not answer throws.
	 */
	async function reorderHosts(groupId: string | null, hostIds: string[]): Promise<HubAnswer> {
		const position = new Map(hostIds.map((id, i) => [id, i]));
		const before = new Map(
			hosts.value
				.filter((h) => position.has(h.id))
				.map((h) => [h.id, { sortOrder: h.sortOrder, hostGroupId: h.hostGroupId ?? null }]),
		);
		hosts.value = hosts.value.map((h) => {
			const sortOrder = position.get(h.id);
			return sortOrder === undefined ? h : { ...h, sortOrder, hostGroupId: groupId };
		});
		// Only these hosts' place and group, so what changed meanwhile stays.
		const takeBack = (): void => {
			hosts.value = hosts.value.map((h) => {
				const was = before.get(h.id);
				return was === undefined ? h : { ...h, ...was };
			});
		};
		try {
			const res = await hubWrite(`${hubBaseUrl()}/api/hosts/order`, {
				method: "PUT",
				headers: {
					Authorization: `Bearer ${authStore.token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ group_id: groupId, host_ids: hostIds }),
			});
			if (res.ok) return { ok: true };
			takeBack();
			return hubRefusal(res);
		} catch (error) {
			takeBack();
			throw error;
		}
	}

	/**
	 * Add a host. A refusal comes back with the hub's reason rather than as
	 * nothing, for the dialog to show (#703); a hub that does not answer throws.
	 */
	async function createHost(body: Record<string, unknown>): Promise<HostSaveAnswer> {
		const res = await hubWrite(`${hubBaseUrl()}/api/hosts`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${authStore.token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		});
		if (!res.ok) return hubRefusal(res);
		const host = toCamelCase(await res.json()) as Host;
		keepStoredHost(host);
		return { ok: true, host };
	}

	/**
	 * Save a host's changes. A refusal comes back with the hub's reason, such as
	 * a label already taken or an OS a connected daemon rules out (#703); a hub
	 * that does not answer throws.
	 */
	async function updateHost(id: string, body: Record<string, unknown>): Promise<HostSaveAnswer> {
		const res = await hubWrite(`${hubBaseUrl()}/api/hosts/${id}`, {
			method: "PUT",
			headers: {
				Authorization: `Bearer ${authStore.token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		});
		if (!res.ok) return hubRefusal(res);
		const updated = toCamelCase(await res.json()) as Host;
		replaceCachedHost(updated);
		return { ok: true, host: updated };
	}

	/**
	 * Delete a host. A refusal comes back with the hub's reason, such as an
	 * agent being stopped there (#734); a hub that does not answer throws.
	 */
	async function deleteHost(id: string): Promise<HubAnswer> {
		const res = await hubWrite(`${hubBaseUrl()}/api/hosts/${id}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${authStore.token}` },
		});
		if (!res.ok) return hubRefusal(res);
		hosts.value = hosts.value.filter((h) => h.id !== id);
		if (selectedHostId.value === id) {
			selectedHostId.value = hosts.value[0]?.id ?? null;
		}
		return { ok: true };
	}

	/**
	 * Add a copy of a host. A refusal comes back with the hub's reason (#734);
	 * a hub that does not answer throws.
	 */
	async function duplicateHost(id: string): Promise<HostSaveAnswer> {
		const res = await hubWrite(`${hubBaseUrl()}/api/hosts/${id}/duplicate`, {
			method: "POST",
			headers: { Authorization: `Bearer ${authStore.token}` },
		});
		if (!res.ok) return hubRefusal(res);
		const host = toCamelCase(await res.json()) as Host;
		keepStoredHost(host);
		return { ok: true, host };
	}

	/** Returns the DB-backed HostGroup entities sorted by sortOrder. */
	function getHostGroups(): HostGroup[] {
		return hostGroups.value;
	}

	/**
	 * The name of the host group a host is in, found by its `hostGroupId`, or
	 * null when it is in none (#731).
	 */
	function getHostGroupName(host: Host): string | null {
		const id = host.hostGroupId;
		if (!id) return null;
		return hostGroups.value.find((g) => g.id === id)?.name ?? null;
	}

	/**
	 * Add a host group. A refusal comes back with the hub's reason, such as a
	 * name already taken (#703); a hub that does not answer throws.
	 */
	async function createHostGroup(name: string): Promise<HostGroupCreateAnswer> {
		const res = await hubWrite(`${hubBaseUrl()}/api/host-groups`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${authStore.token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ name }),
		});
		if (!res.ok) return hubRefusal(res);
		const raw = (await res.json()) as {
			id: string;
			name: string;
			sort_order: number;
			color?: string | null;
			created_at: string;
			updated_at: string;
		};
		const group: HostGroup = {
			id: raw.id,
			name: raw.name,
			sortOrder: raw.sort_order,
			color: raw.color ?? null,
			createdAt: raw.created_at,
			updatedAt: raw.updated_at,
		};
		// A read of the list may have brought it first (#783).
		hostGroups.value = [...hostGroups.value.filter((g) => g.id !== group.id), group];
		return { ok: true, group };
	}

	/**
	 * Rename a host group. A refusal comes back with the hub's reason, such as
	 * a name already taken (#734); a hub that does not answer throws.
	 */
	async function renameHostGroup(id: string, name: string): Promise<HubAnswer> {
		const res = await hubWrite(`${hubBaseUrl()}/api/host-groups/${id}`, {
			method: "PUT",
			headers: {
				Authorization: `Bearer ${authStore.token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ name }),
		});
		if (!res.ok) return hubRefusal(res);
		const idx = hostGroups.value.findIndex((g) => g.id === id);
		if (idx >= 0) {
			const existing = hostGroups.value[idx];
			if (existing) hostGroups.value[idx] = { ...existing, name };
		}
		return { ok: true };
	}

	/**
	 * Delete a host group; its hosts become ungrouped. A refusal comes back
	 * with the hub's reason (#734); a hub that does not answer throws.
	 */
	async function deleteHostGroup(id: string): Promise<HubAnswer> {
		const res = await hubWrite(`${hubBaseUrl()}/api/host-groups/${id}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${authStore.token}` },
		});
		if (!res.ok) return hubRefusal(res);
		hostGroups.value = hostGroups.value.filter((g) => g.id !== id);
		// Clear hostGroupId on any hosts that belonged to the deleted group
		for (const host of hosts.value) {
			if (host.hostGroupId === id) {
				host.hostGroupId = null;
			}
		}
		return { ok: true };
	}

	/**
	 * Put the host groups in this order, shown at once and taken back when the
	 * hub refuses it or does not answer. A refusal comes back with the hub's
	 * reason, for the rail to say why (#734); a hub that does not answer throws.
	 */
	async function reorderHostGroups(groupIds: string[]): Promise<HubAnswer> {
		// Optimistic update
		const original = [...hostGroups.value];
		const reordered: HostGroup[] = [];
		for (const id of groupIds) {
			const g = hostGroups.value.find((g) => g.id === id);
			if (g) reordered.push({ ...g });
		}
		// Include any groups not in the provided list (shouldn't happen, but safe)
		for (const g of hostGroups.value) {
			if (!groupIds.includes(g.id)) reordered.push(g);
		}
		hostGroups.value = reordered;

		try {
			const res = await hubWrite(`${hubBaseUrl()}/api/host-groups/order`, {
				method: "PUT",
				headers: {
					Authorization: `Bearer ${authStore.token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ group_ids: groupIds }),
			});
			if (res.ok) return { ok: true };
			// Rollback on failure
			hostGroups.value = original;
			return hubRefusal(res);
		} catch (error) {
			hostGroups.value = original;
			throw error;
		}
	}

	/**
	 * Move a host into a group, or out of any with null. A refusal comes back
	 * with the hub's reason, such as a host deleted meanwhile (#734); a hub
	 * that does not answer throws.
	 */
	async function moveHostToGroup(hostId: string, groupId: string | null): Promise<HubAnswer> {
		const res = await hubWrite(`${hubBaseUrl()}/api/hosts/${hostId}`, {
			method: "PUT",
			headers: {
				Authorization: `Bearer ${authStore.token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ host_group_id: groupId }),
		});
		if (!res.ok) return hubRefusal(res);
		const host = hosts.value.find((h) => h.id === hostId);
		if (host) {
			host.hostGroupId = groupId;
		}
		return { ok: true };
	}

	return {
		hosts,
		hostGroups,
		sortedHosts,
		selectedHostId,
		loading,
		error,
		fetchHosts,
		fetchHostGroups,
		hubChanged,
		selectHost,
		updateSessionStatus,
		isHostConnected,
		getHostStatus,
		isDisconnectedByUser,
		rememberDisconnectedByUser,
		setDisconnectedByUser,
		connectHost,
		reconnectHost,
		disconnectHost,
		stopKeepingAgent,
		replaceCachedHost,
		isConnectedThroughRemoteDaemon,
		rememberConnectedThroughRemoteDaemon,
		setConnectedThroughRemoteDaemon,
		isSftpUnavailable,
		rememberSftpUnavailable,
		setSftpUnavailable,
		isSocketForwardingRefused,
		rememberSocketForwardingRefused,
		setSocketForwardingRefused,
		getOutdatedAgent,
		rememberOutdatedAgent,
		getOtherOwnerChannels,
		rememberOtherOwnerChannels,
		reorderHosts,
		createHost,
		updateHost,
		deleteHost,
		duplicateHost,
		getHostGroups,
		getHostGroupName,
		createHostGroup,
		renameHostGroup,
		deleteHostGroup,
		reorderHostGroups,
		moveHostToGroup,
	};
});
