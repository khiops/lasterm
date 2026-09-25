import { type Host, type HostGroup, type SessionStatus, toCamelCase } from "@lasterm/shared";
import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { hubFetch } from "../utils/hub-fetch.js";
import { hubBaseUrl } from "../utils/hub-url.js";
import { useAuthStore } from "./auth.js";
import { useSessionStore } from "./session.js";

/** Derived per-host connectivity status rendered in the rail status dot. */
export type HostStatus = "live" | "offline" | "error" | "reconnecting";

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

	async function fetchHostGroups(): Promise<void> {
		if (authStore.token === null) return;
		const res = await hubFetch(`${hubBaseUrl()}/api/host-groups`, {
			headers: { Authorization: `Bearer ${authStore.token}` },
		});
		if (!res.ok) return;
		const raw = (await res.json()) as Array<{
			id: string;
			name: string;
			sort_order: number;
			color?: string | null;
			created_at: string;
			updated_at: string;
		}>;
		hostGroups.value = raw.map((g) => ({
			id: g.id,
			name: g.name,
			sortOrder: g.sort_order,
			color: g.color ?? null,
			createdAt: g.created_at,
			updatedAt: g.updated_at,
		}));
	}

	async function fetchHosts(): Promise<void> {
		if (authStore.token === null) return;
		loading.value = true;
		error.value = null;
		try {
			const res = await hubFetch(`${hubBaseUrl()}/api/hosts`, {
				headers: { Authorization: `Bearer ${authStore.token}` },
			});
			if (!res.ok) {
				throw new Error(`GET /api/hosts failed: ${res.status}`);
			}
			const data = toCamelCase(await res.json()) as Host[];
			hosts.value = data;
			// Nothing selected yet: the host this tab showed before it reloaded, if
			// the hub still has it, else the first one.
			if (selectedHostId.value === null && data.length > 0) {
				const remembered = readSelectedHost();
				selectedHostId.value = data.some((h) => h.id === remembered)
					? remembered
					: (data[0]?.id ?? null);
			}
			// Populate groups on first load
			if (hostGroups.value.length === 0) {
				await fetchHostGroups();
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

	function updateSessionStatus(hostId: string, status: SessionStatus): void {
		_sessionStatuses.value.set(hostId, status);
		// Trigger Vue reactivity on the Map by replacing the ref value
		_sessionStatuses.value = new Map(_sessionStatuses.value);
	}

	function getHostStatus(hostId: string): HostStatus {
		// Local host ≡ the hub itself — if the WS connection is up, it's live.
		const host = hosts.value.find((h) => h.id === hostId);
		if (host?.type === "local") {
			const sessionStore = useSessionStore();
			return sessionStore.connected ? "live" : "offline";
		}
		return sessionStatusToHostStatus(_sessionStatuses.value.get(hostId));
	}

	async function reorderHosts(groupId: string | null, hostIds: string[]): Promise<void> {
		await hubFetch(`${hubBaseUrl()}/api/hosts/order`, {
			method: "PUT",
			headers: {
				Authorization: `Bearer ${authStore.token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ group_id: groupId, host_ids: hostIds }),
		});
		// Update local state optimistically
		for (let i = 0; i < hostIds.length; i++) {
			const host = hosts.value.find((h) => h.id === hostIds[i]);
			if (host) {
				host.sortOrder = i;
				host.hostGroupId = groupId ?? null;
			}
		}
	}

	async function createHost(body: Record<string, unknown>): Promise<Host | null> {
		const res = await hubFetch(`${hubBaseUrl()}/api/hosts`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${authStore.token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		});
		if (!res.ok) return null;
		const host = toCamelCase(await res.json()) as Host;
		hosts.value = [...hosts.value, host];
		return host;
	}

	async function updateHost(id: string, body: Record<string, unknown>): Promise<Host | null> {
		const res = await hubFetch(`${hubBaseUrl()}/api/hosts/${id}`, {
			method: "PUT",
			headers: {
				Authorization: `Bearer ${authStore.token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		});
		if (!res.ok) return null;
		const updated = toCamelCase(await res.json()) as Host;
		const idx = hosts.value.findIndex((h) => h.id === id);
		if (idx >= 0) hosts.value[idx] = updated;
		return updated;
	}

	async function deleteHost(id: string): Promise<boolean> {
		const res = await hubFetch(`${hubBaseUrl()}/api/hosts/${id}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${authStore.token}` },
		});
		if (!res.ok) return false;
		hosts.value = hosts.value.filter((h) => h.id !== id);
		if (selectedHostId.value === id) {
			selectedHostId.value = hosts.value[0]?.id ?? null;
		}
		return true;
	}

	async function duplicateHost(id: string): Promise<Host | null> {
		const res = await hubFetch(`${hubBaseUrl()}/api/hosts/${id}/duplicate`, {
			method: "POST",
			headers: { Authorization: `Bearer ${authStore.token}` },
		});
		if (!res.ok) return null;
		const host = toCamelCase(await res.json()) as Host;
		hosts.value = [...hosts.value, host];
		return host;
	}

	/** Returns the DB-backed HostGroup entities sorted by sortOrder. */
	function getHostGroups(): HostGroup[] {
		return hostGroups.value;
	}

	async function createHostGroup(name: string): Promise<HostGroup | null> {
		if (authStore.token === null) return null;
		const res = await hubFetch(`${hubBaseUrl()}/api/host-groups`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${authStore.token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ name }),
		});
		if (!res.ok) return null;
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
		hostGroups.value = [...hostGroups.value, group];
		return group;
	}

	async function renameHostGroup(id: string, name: string): Promise<void> {
		if (authStore.token === null) return;
		const res = await hubFetch(`${hubBaseUrl()}/api/host-groups/${id}`, {
			method: "PUT",
			headers: {
				Authorization: `Bearer ${authStore.token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ name }),
		});
		if (!res.ok) return;
		const idx = hostGroups.value.findIndex((g) => g.id === id);
		if (idx >= 0) {
			const existing = hostGroups.value[idx];
			if (existing) hostGroups.value[idx] = { ...existing, name };
		}
	}

	async function deleteHostGroup(id: string): Promise<void> {
		if (authStore.token === null) return;
		const res = await hubFetch(`${hubBaseUrl()}/api/host-groups/${id}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${authStore.token}` },
		});
		if (!res.ok) return;
		hostGroups.value = hostGroups.value.filter((g) => g.id !== id);
		// Clear hostGroupId on any hosts that belonged to the deleted group
		for (const host of hosts.value) {
			if (host.hostGroupId === id) {
				host.hostGroupId = null;
			}
		}
	}

	async function reorderHostGroups(groupIds: string[]): Promise<void> {
		if (authStore.token === null) return;
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

		const res = await hubFetch(`${hubBaseUrl()}/api/host-groups/order`, {
			method: "PUT",
			headers: {
				Authorization: `Bearer ${authStore.token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ group_ids: groupIds }),
		});
		if (!res.ok) {
			// Rollback on failure
			hostGroups.value = original;
		}
	}

	async function moveHostToGroup(hostId: string, groupId: string | null): Promise<void> {
		if (authStore.token === null) return;
		const res = await hubFetch(`${hubBaseUrl()}/api/hosts/${hostId}`, {
			method: "PUT",
			headers: {
				Authorization: `Bearer ${authStore.token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ host_group_id: groupId }),
		});
		if (!res.ok) return;
		const host = hosts.value.find((h) => h.id === hostId);
		if (host) {
			host.hostGroupId = groupId;
		}
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
		selectHost,
		updateSessionStatus,
		getHostStatus,
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
		createHostGroup,
		renameHostGroup,
		deleteHostGroup,
		reorderHostGroups,
		moveHostToGroup,
	};
});
