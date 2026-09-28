import { type Channel, ErrorCode, type Host, type HostGroup } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, nextTick, ref } from "vue";
import { useChannelsStore } from "../stores/channels.js";
import { useHostsStore } from "../stores/hosts.js";
import type { PickerOption } from "./hostPicker.js";
import { useHostPicker } from "./useHostPicker.js";

// The empty pane's picker (#625): what it lists, the keys it answers, and
// what opening a host does — at once on a live host, through a SPAWN that
// connects an offline one, and through the #605 wait on a host the hub is
// reaching for already.

vi.mock("../stores/session.js", () => ({
	useSessionStore: () => ({
		connected: true,
		wsClient: { send: vi.fn(), on: vi.fn(() => vi.fn()) },
	}),
}));

function host(id: string, overrides: Partial<Host> = {}): Host {
	return {
		id,
		label: id,
		type: "ssh",
		sshHost: `${id}.lan`,
		sshPort: 22,
		sshUser: "deploy",
		iconType: "auto",
		trustRemoteHints: "apply",
		sortOrder: 0,
		os: null,
		arch: null,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

function group(id: string, name: string, sortOrder: number): HostGroup {
	return {
		id,
		name,
		sortOrder,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
	};
}

function channel(id: string, displayTitle: string, status: Channel["status"] = "live"): Channel {
	return {
		id,
		sessionId: `s-${id}`,
		cols: 80,
		rows: 24,
		status,
		displayTitle,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
	};
}

/** The hub's refusal of a SPAWN to a host it is reaching for already. */
function hostAway(hostId: string): Error {
	return Object.assign(new Error(`HOST_UNREACHABLE: ${hostId} cannot be reached right now.`), {
		code: ErrorCode.HOST_UNREACHABLE,
		hostId,
	});
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** An empty pane of a tab on `hostId`, with what it asked of App.vue. */
function mountPicker(hostId: string | null = "web-1", displayed: ReadonlySet<string> = new Set()) {
	const asked = { newTerminal: [] as string[], fill: [] as string[], addHost: 0 };
	let picker: ReturnType<typeof useHostPicker> | null = null;
	const app = createApp(
		defineComponent({
			setup() {
				picker = useHostPicker(
					{ hostId: ref(hostId), displayed: ref(displayed) },
					{
						newTerminal: (id) => asked.newTerminal.push(id),
						fill: (id) => asked.fill.push(id),
						addHost: () => {
							asked.addHost++;
						},
					},
				);
				return () => null;
			},
		}),
	);
	app.mount(document.createElement("div"));
	if (picker === null) throw new Error("not mounted");
	const p: ReturnType<typeof useHostPicker> = picker;
	return {
		picker: p,
		asked,
		press: (key: string) => p.onKeydown({ key, preventDefault: () => {} }),
		ids: () => p.list.value.options.map((o) => o.id),
		search: async (query: string) => {
			p.query.value = query;
			await nextTick();
		},
		hostRow: (hostId: string) => {
			const option = p.list.value.options.find(
				(o): o is Extract<PickerOption, { kind: "host" }> =>
					o.kind === "host" && o.host.id === hostId,
			);
			if (option === undefined) throw new Error(`no row for ${hostId}`);
			return p.hostView(option);
		},
		unmount: () => app.unmount(),
	};
}

describe("useHostPicker", () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		localStorage.clear();
		const hostsStore = useHostsStore();
		hostsStore.hosts = [
			host("local", { type: "local", sshUser: null }),
			host("web-1", { hostGroupId: "prod" }),
			host("web-2", { hostGroupId: "prod", sortOrder: 1 }),
			host("pi", { hostGroupId: "home" }),
			host("nas", { hostGroupId: "home", sortOrder: 1 }),
			host("vps"),
		];
		hostsStore.hostGroups = [group("home", "Home", 0), group("prod", "Prod", 1)];
		hostsStore.updateSessionStatus("web-1", "active");
		hostsStore.updateSessionStatus("web-2", "active");
		hostsStore.updateSessionStatus("pi", "active");
		// nas and vps: no session, offline.

		const channelsStore = useChannelsStore();
		channelsStore.activeHostId = "web-1";
		channelsStore.channels = [
			channel("ch-shown", "htop"),
			channel("ch-mig", "migrations"),
			channel("ch-dead", "old", "dead"),
		];
		for (const c of channelsStore.channels) channelsStore.registerChannelHost(c.id, "web-1");
	});

	it("offers this tab's host and the terminals no pane shows, then every host as the rail lists them", () => {
		const { picker, ids } = mountPicker("web-1", new Set(["ch-shown"]));
		expect(ids()).toEqual([
			"current:web-1",
			"terminal:ch-mig",
			"host:local",
			"host:pi",
			"host:nas",
			"host:web-2",
			"host:vps",
			"add",
		]);
		expect(picker.list.value.sections.map((s) => s.title)).toEqual([
			"This tab's host",
			"Local",
			"Home",
			"Prod",
			"Ungrouped",
		]);
		// web-1 has two terminals running; the dead one is not counted.
		expect(picker.count("web-1")).toBe(2);
	});

	it("reattaches a detached terminal in this pane", () => {
		const { picker, asked, press } = mountPicker("web-1", new Set(["ch-shown"]));
		press("ArrowDown");
		expect(picker.activeOption.value?.id).toBe("terminal:ch-mig");
		press("Enter");
		expect(asked.fill).toEqual(["ch-mig"]);
		expect(asked.newTerminal).toEqual([]);
	});

	it("moves with ↑ and ↓, starts a search from its first row, and clears it with Esc", async () => {
		const { picker, press, search, ids } = mountPicker();
		expect(picker.highlighted.value).toBe(0);
		press("ArrowUp");
		expect(picker.highlighted.value).toBe(0);
		press("ArrowDown");
		press("ArrowDown");
		expect(picker.highlighted.value).toBe(2);
		press("ArrowUp");
		expect(picker.highlighted.value).toBe(1);

		await search("home");
		expect(picker.highlighted.value).toBe(0);
		expect(ids()).toEqual(["host:pi", "host:nas", "add"]);

		press("Escape");
		expect(picker.query.value).toBe("");
	});

	it("opens a new terminal on a live host in this pane, spawned by the pane at its size", async () => {
		const channelsStore = useChannelsStore();
		const spawn = vi.spyOn(channelsStore, "spawnChannel");
		const { asked, press, search } = mountPicker();
		await search("web-2");
		press("Enter");
		expect(asked.newTerminal).toEqual(["web-2"]);
		expect(spawn).not.toHaveBeenCalled();
	});

	it("opens this tab's host with Enter on the first row", () => {
		const { asked, press } = mountPicker();
		press("Enter");
		expect(asked.newTerminal).toEqual(["web-1"]);
	});

	it("connects an offline host with its first terminal, which the pane then takes", async () => {
		const channelsStore = useChannelsStore();
		let answer: (id: string) => void = () => {};
		const spawn = vi
			.spyOn(channelsStore, "spawnChannel")
			.mockImplementation(() => new Promise<string>((resolve) => (answer = resolve)));
		const { picker, asked, press, search, hostRow } = mountPicker();
		await search("nas");
		expect(hostRow("nas").action.text).toBe("Connect");
		press("Enter");

		expect(spawn).toHaveBeenCalledWith("nas", { select: false });
		expect(picker.opening.value).toEqual({ hostId: "nas", phase: "connecting" });
		expect(hostRow("nas").action.text).toBe("Connecting…");
		expect(hostRow("nas").note).toBe("The terminal opens here once nas answers. Esc cancels.");

		answer("ch-nas");
		await flush();
		expect(asked.fill).toEqual(["ch-nas"]);
		expect(picker.opening.value).toBeNull();
	});

	it("waits for a host the hub is reaching for (#605), and opens its terminal once it is back", async () => {
		const hostsStore = useHostsStore();
		const channelsStore = useChannelsStore();
		hostsStore.updateSessionStatus("nas", "disconnected");
		const spawn = vi.spyOn(channelsStore, "spawnChannel").mockRejectedValue(hostAway("nas"));
		const { picker, asked, press, search, hostRow } = mountPicker();
		await search("nas");
		expect(hostRow("nas").action.text).toBe("Error · retry");
		press("Enter");
		await flush();

		expect(picker.opening.value).toEqual({ hostId: "nas", phase: "waiting" });
		expect(picker.waitingFor.value).toBe("nas");
		expect(hostRow("nas").action.text).toBe("Connecting…");

		// Another host coming back is not this one.
		hostsStore.updateSessionStatus("vps", "active");
		await nextTick();
		expect(asked.newTerminal).toEqual([]);

		hostsStore.updateSessionStatus("nas", "active");
		await nextTick();
		expect(asked.newTerminal).toEqual(["nas"]);
		expect(picker.opening.value).toBeNull();
		// The terminal is the pane's to spawn now, at its size: the picker sent one SPAWN only.
		expect(spawn).toHaveBeenCalledTimes(1);
	});

	it("cancels the wait with Esc: the host coming back then opens nothing", async () => {
		const hostsStore = useHostsStore();
		const channelsStore = useChannelsStore();
		hostsStore.updateSessionStatus("nas", "disconnected");
		vi.spyOn(channelsStore, "spawnChannel").mockRejectedValue(hostAway("nas"));
		const { picker, asked, press, search } = mountPicker();
		await search("nas");
		press("Enter");
		await flush();
		expect(picker.waitingFor.value).toBe("nas");

		// The first Esc clears the search; the wait goes on.
		press("Escape");
		expect(picker.query.value).toBe("");
		expect(picker.waitingFor.value).toBe("nas");

		press("Escape");
		expect(picker.opening.value).toBeNull();
		expect(picker.waitingFor.value).toBeNull();

		hostsStore.updateSessionStatus("nas", "active");
		await nextTick();
		expect(asked.newTerminal).toEqual([]);
	});

	it("leaves a terminal that answers after a cancel out of the pane", async () => {
		const channelsStore = useChannelsStore();
		let answer: (id: string) => void = () => {};
		vi.spyOn(channelsStore, "spawnChannel").mockImplementation(
			() => new Promise<string>((resolve) => (answer = resolve)),
		);
		const { picker, asked, press, search } = mountPicker();
		await search("nas");
		press("Enter");
		await search("");
		press("Escape");
		expect(picker.opening.value).toBeNull();

		answer("ch-late");
		await flush();
		expect(asked.fill).toEqual([]);
	});

	it("says why an attempt failed, and tries again when chosen again", async () => {
		const channelsStore = useChannelsStore();
		const spawn = vi
			.spyOn(channelsStore, "spawnChannel")
			.mockRejectedValue(new Error("SSH_CONNECT_FAILED: Permission denied (publickey)."));
		const { picker, press, search, hostRow } = mountPicker();
		await search("nas");
		press("Enter");
		await flush();

		expect(picker.opening.value).toBeNull();
		expect(hostRow("nas").action.text).toBe("Error · retry");
		expect(hostRow("nas").note).toBe("Permission denied (publickey).");

		press("Enter");
		expect(spawn).toHaveBeenCalledTimes(2);
	});

	it("offers to add the host that nothing matched", async () => {
		const { picker, asked, press, search, ids } = mountPicker();
		await search("stag");
		expect(picker.list.value.noMatch).toBe(true);
		expect(ids()).toEqual(["add"]);
		press("Enter");
		expect(asked.addHost).toBe(1);
	});
});
