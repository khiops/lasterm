import { DEFAULT_CHANNEL_NAME } from "@lasterm/shared";
import { computed, onScopeDispose, type Ref, ref, watch } from "vue";
import { restartFailureOf, useChannelsStore } from "../stores/channels.js";
import { useHostsStore } from "../stores/hosts.js";
import { pickableChannels } from "./displayedChannels.js";
import {
	buildPickerList,
	escapeAction,
	type HostRowView,
	hostRowView,
	moveHighlight,
	type PickerOption,
} from "./hostPicker.js";
import { useHostRows } from "./useHostRows.js";
import { useWaitForHost } from "./useWaitForHost.js";

/** What the empty pane tells its picker. */
export interface HostPickerSources {
	/** This tab's host: the one in view, or null. */
	hostId: Readonly<Ref<string | null>>;
	/** Channels a pane shows already, in any tab. */
	displayed: Readonly<Ref<ReadonlySet<string>>>;
}

/** What the picker asks of the pane it is in. */
export interface HostPickerActions {
	/** Open a new terminal on this host in the pane, spawned at the pane's size. */
	newTerminal(hostId: string): void;
	/** Put this terminal, which exists already, in the pane. */
	fill(channelId: string): void;
	/** Open the add-host form. */
	addHost(): void;
}

/** A terminal on its way to this pane, from a host that was not connected. */
export interface PickerOpening {
	hostId: string;
	/** Its SPAWN is out, connecting the host; or the hub is reaching for it, and the pane waits (#605). */
	phase: "connecting" | "waiting";
}

/** The key presses the picker answers. */
export interface PickerKey {
	key: string;
	isComposing?: boolean;
	altKey?: boolean;
	ctrlKey?: boolean;
	metaKey?: boolean;
	preventDefault(): void;
}

/**
 * The empty pane's host picker (#625).
 *
 * Opening a host that is live hands the pane a spawn, which it makes at its
 * own size, as "New terminal" always did. A host that is not connected is
 * connected by its first SPAWN, so the picker sends it and says "Connecting…"
 * until it is answered. When the hub is already reaching for that host, it
 * refuses at once (`HOST_UNREACHABLE`) and the picker waits for the host as a
 * pane waits to restart its terminal (#605), with the same wait: once the host
 * is back, the pane gets its terminal. Esc cancels either.
 *
 * A SPAWN already sent cannot be called back: cancelled, or with the pane
 * gone, the terminal it makes still opens, and stays detached — listed under
 * its host, and offered here when that host is this tab's.
 */
export function useHostPicker(sources: HostPickerSources, actions: HostPickerActions) {
	const hostsStore = useHostsStore();
	const channelsStore = useChannelsStore();
	const rows = useHostRows();

	const query = ref("");
	const highlighted = ref(0);
	const opening = ref<PickerOpening | null>(null);
	/** Why the last attempt from this pane failed, by host. */
	const failures = ref<ReadonlyMap<string, string>>(new Map());

	const currentHost = computed(() => {
		const hostId = sources.hostId.value;
		return hostId === null ? null : (rows.host(hostId) ?? null);
	});

	/** This tab's host's terminals that no pane shows (UX-01 EFF-03). */
	const detached = computed(() =>
		pickableChannels(
			channelsStore.channels,
			channelsStore.channelHostMap,
			sources.hostId.value,
			sources.displayed.value,
		).map((channel) => ({
			channelId: channel.id,
			title: channel.displayTitle || DEFAULT_CHANNEL_NAME,
		})),
	);

	const list = computed(() =>
		buildPickerList({
			query: query.value,
			currentHost: currentHost.value,
			detached: detached.value,
			rail: rows.rail.value,
			address: rows.address,
		}),
	);

	const activeOption = computed<PickerOption | null>(
		() => list.value.options[highlighted.value] ?? null,
	);

	// A new search starts from its first row; a shorter list keeps a row lit.
	watch(query, () => {
		highlighted.value = 0;
	});
	watch(
		() => list.value.options.length,
		(count) => {
			if (highlighted.value >= count) highlighted.value = Math.max(0, count - 1);
		},
	);

	/** Each attempt's number: an answer to one that was cancelled is not acted on. */
	let attempt = 0;

	function setFailure(hostId: string, reason: string | null): void {
		const next = new Map(failures.value);
		if (reason === null) next.delete(hostId);
		else next.set(hostId, reason);
		failures.value = next;
	}

	/** The host waited for is back: the pane takes a terminal spawned at its size. */
	function onHostBack(): void {
		const waited = opening.value;
		if (waited === null) return;
		attempt++;
		opening.value = null;
		actions.newTerminal(waited.hostId);
	}

	const hostWait = useWaitForHost({
		ended: computed(() => opening.value !== null),
		channelId: ref<string | null>(null),
		restart: onHostBack,
	});

	/** Stop waiting for the host, and forget the attempt under way. */
	function cancel(): void {
		attempt++;
		opening.value = null;
		hostWait.cancel();
	}

	async function connect(hostId: string): Promise<void> {
		const mine = ++attempt;
		opening.value = { hostId, phase: "connecting" };
		hostWait.restartStarting();
		let channelId: string;
		try {
			channelId = await channelsStore.spawnChannel(hostId, { select: false });
		} catch (err) {
			if (mine !== attempt) return;
			const failure = restartFailureOf(err, hostId);
			// Away: wait for it; back already: open now (onHostBack); anything else is the reason to show.
			hostWait.restartFailed(failure, false);
			if (opening.value === null) return;
			if (hostWait.waitingFor.value !== null) {
				opening.value = { hostId, phase: "waiting" };
				return;
			}
			opening.value = null;
			setFailure(hostId, failure.reason);
			return;
		}
		if (mine !== attempt) return;
		opening.value = null;
		actions.fill(channelId);
	}

	/** Open a new terminal on this host, in this pane. */
	function openHost(hostId: string): void {
		if (opening.value?.hostId === hostId) return;
		cancel();
		setFailure(hostId, null);
		if (hostsStore.getHostStatus(hostId) === "live") {
			actions.newTerminal(hostId);
			return;
		}
		void connect(hostId);
	}

	function choose(option: PickerOption): void {
		// A row clicked is the lit one, as if the keys had gone to it.
		const index = list.value.options.findIndex((candidate) => candidate.id === option.id);
		if (index !== -1) highlighted.value = index;
		switch (option.kind) {
			case "host":
				openHost(option.host.id);
				return;
			case "terminal":
				cancel();
				actions.fill(option.channelId);
				return;
			case "add":
				actions.addHost();
				return;
		}
	}

	function onKeydown(event: PickerKey): void {
		if (event.isComposing === true) return;
		// A key held with Alt, Ctrl or Meta is the window's: Alt+↑/↓ moves the focus to another
		// pane (#637), and must not move this list's highlight on the way.
		if (event.altKey === true || event.ctrlKey === true || event.metaKey === true) return;
		const count = list.value.options.length;
		switch (event.key) {
			case "ArrowDown":
				event.preventDefault();
				highlighted.value = moveHighlight(highlighted.value, 1, count);
				return;
			case "ArrowUp":
				event.preventDefault();
				highlighted.value = moveHighlight(highlighted.value, -1, count);
				return;
			case "Enter": {
				event.preventDefault();
				const option = activeOption.value;
				if (option !== null) choose(option);
				return;
			}
			case "Escape": {
				const action = escapeAction(query.value, opening.value !== null);
				if (action === "none") return;
				event.preventDefault();
				if (action === "clear") query.value = "";
				else cancel();
				return;
			}
		}
	}

	/** What a host's row says, with this pane's attempt on it. */
	function hostView(option: Extract<PickerOption, { kind: "host" }>): HostRowView {
		const hostId = option.host.id;
		const status = rows.status(hostId);
		return hostRowView({
			label: option.host.label,
			status,
			current: option.current,
			opening: opening.value?.hostId === hostId,
			// A host connected since, from here or elsewhere, has nothing left to report.
			failure: status === "live" ? null : (failures.value.get(hostId) ?? null),
		});
	}

	// The pane is gone: whatever answers now has no pane to go to.
	onScopeDispose(() => {
		attempt++;
	});

	return {
		query,
		highlighted,
		list,
		activeOption,
		opening,
		failures,
		waitingFor: hostWait.waitingFor,
		openHost,
		choose,
		cancel,
		onKeydown,
		hostView,
		status: rows.status,
		address: rows.address,
		count: rows.count,
	};
}
