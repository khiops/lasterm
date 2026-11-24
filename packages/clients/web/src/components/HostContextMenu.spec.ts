/**
 * The host menu's connection items (#648): what it offers for each status a
 * host can have, and what choosing one sends. What the hub then does is in
 * the hub's specs; the question asked first, in utils/host-connection.spec.ts.
 *
 * The menu is mounted with its real stores, fed a host directly.
 */
import type { Host, SessionStatus } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import { useHostsStore } from "../stores/hosts.js";
import { useToastStore } from "../stores/toast.js";
import HostContextMenu from "./HostContextMenu.vue";

const STAMP = "2026-09-29T00:00:00.000Z";

function host(id: string, type: Host["type"]): Host {
	return {
		id,
		type,
		label: id,
		iconType: "auto",
		trustRemoteHints: "ask",
		sortOrder: 0,
		os: null,
		arch: null,
		createdAt: STAMP,
		updatedAt: STAMP,
	};
}

let pinia: ReturnType<typeof createPinia>;
let app: App | null = null;
let emitted: Array<[string, string]> = [];

beforeEach(() => {
	pinia = createPinia();
	setActivePinia(pinia);
	emitted = [];
	useHostsStore().hosts = [host("local", "local"), host("pi", "ssh")];
});

afterEach(() => {
	app?.unmount();
	app = null;
	document.body.innerHTML = "";
});

async function openMenu(
	hostId: string,
	at: { x: number; y: number } = { x: 0, y: 0 },
): Promise<void> {
	const root = document.createElement("div");
	document.body.appendChild(root);
	const record = (event: string) => (id: string) => emitted.push([event, id]);
	app = createApp({
		render: () =>
			h(HostContextMenu, {
				visible: true,
				hostId,
				x: at.x,
				y: at.y,
				onConnect: record("connect"),
				onReconnect: record("reconnect"),
				onDisconnect: record("disconnect"),
				onStopAgent: record("stop-agent"),
				onKeepAgent: record("keep-agent"),
				onReplaceAgent: record("replace-agent"),
				onClose: () => emitted.push(["close", hostId]),
			}),
	});
	app.use(pinia);
	app.mount(root);
	await nextTick();
}

/** The connection items offered, in order. */
function offered(): string[] {
	return [...document.body.querySelectorAll<HTMLElement>(".ctx-menu [data-action]")].map(
		(item) => item.dataset.action ?? "",
	);
}

function sessionIs(status: SessionStatus): void {
	useHostsStore().updateSessionStatus("pi", status);
}

describe("the host menu's connection items (#648)", () => {
	it("offers Connect to a host never connected", async () => {
		await openMenu("pi");
		expect(offered()).toEqual(["connect"]);
	});

	it("offers Connect to a host its user disconnected, whatever its session says", async () => {
		sessionIs("disconnected");
		useHostsStore().rememberDisconnectedByUser("pi", true);
		await openMenu("pi");
		expect(offered()).toEqual(["connect"]);
	});

	it("offers Reconnect and Disconnect to a live host", async () => {
		sessionIs("active");
		await openMenu("pi");
		expect(offered()).toEqual(["reconnect", "disconnect"]);
	});

	it("offers Reconnect to a host being reached, and to one the hub lost", async () => {
		sessionIs("starting");
		await openMenu("pi");
		expect(offered()).toEqual(["reconnect"]);
		app?.unmount();
		document.body.innerHTML = "";

		sessionIs("disconnected");
		await openMenu("pi");
		expect(offered()).toEqual(["reconnect"]);
	});

	it("offers none of them for the local host", async () => {
		await openMenu("local");
		expect(offered()).toEqual([]);
		expect(document.body.querySelector(".ctx-menu")?.textContent).not.toMatch(/connect/i);
	});

	it("sends what was chosen, for its host, and closes", async () => {
		sessionIs("active");
		await openMenu("pi");

		document.body.querySelector<HTMLElement>('[data-action="disconnect"]')?.click();

		expect(emitted).toEqual([
			["disconnect", "pi"],
			["close", "pi"],
		]);
	});

	it("sends Reconnect for its host", async () => {
		sessionIs("disconnected");
		await openMenu("pi");

		document.body.querySelector<HTMLElement>('[data-action="reconnect"]')?.click();

		expect(emitted[0]).toEqual(["reconnect", "pi"]);
	});
});

describe("stop-agent visibility", () => {
	it("offers and emits stop-agent for a live daemon", async () => {
		sessionIs("active");
		useHostsStore().rememberConnectedThroughRemoteDaemon("pi", true);
		await openMenu("pi");
		expect(offered()).toContain("stop-agent");
		document.body.querySelector<HTMLElement>('[data-action="stop-agent"]')?.click();
		expect(emitted).toEqual([
			["stop-agent", "pi"],
			["close", "pi"],
		]);
	});

	it.each(["active", "closed", "disconnected"] as const)(
		"omits stop-agent for stdio or unavailable %s",
		async (status) => {
			sessionIs(status);
			if (status !== "active") useHostsStore().rememberConnectedThroughRemoteDaemon("pi", true);
			await openMenu("pi");
			expect(offered()).not.toContain("stop-agent");
		},
	);

	it("omits stop-agent for a user-disconnected daemon", async () => {
		sessionIs("active");
		useHostsStore().rememberConnectedThroughRemoteDaemon("pi", true);
		useHostsStore().rememberDisconnectedByUser("pi", true);
		await openMenu("pi");
		expect(offered()).not.toContain("stop-agent");
	});

	it("omits stop-agent for local even with the flag", async () => {
		useHostsStore().rememberConnectedThroughRemoteDaemon("local", true);
		await openMenu("local");
		expect(offered()).not.toContain("stop-agent");
	});
});

// A menu closes when an item is chosen, so a toast says why the hub refused it.
describe("the host menu's Duplicate and Move to Group, refused (#734)", () => {
	const refused = (message: string) =>
		({ ok: false, status: 409, code: "CONFLICT", message }) as const;

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const toasts = () => useToastStore().messages.map(({ level, text }) => ({ level, text }));

	function item(selector: string, text: string): HTMLElement {
		const found = [...document.body.querySelectorAll<HTMLElement>(selector)].find(
			(el) => el.textContent?.trim() === text,
		);
		if (!found) throw new Error(`no item ${text}`);
		return found;
	}

	/** Choose a group in the Move to Group submenu, and let its request settle. */
	async function moveTo(name: string): Promise<void> {
		document.body
			.querySelector(".ctx-menu .has-submenu")
			?.dispatchEvent(new MouseEvent("mouseenter"));
		await nextTick();
		item(".ctx-submenu .ctx-item", name).click();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	async function duplicate(): Promise<void> {
		item(".ctx-menu .ctx-item", "Duplicate").click();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	function spies() {
		const store = useHostsStore();
		store.hostGroups = [
			{ id: "g1", name: "Prod", sortOrder: 0, createdAt: STAMP, updatedAt: STAMP },
		];
		return {
			duplicateHost: vi.spyOn(store, "duplicateHost"),
			moveHostToGroup: vi.spyOn(store, "moveHostToGroup"),
			fetchHosts: vi.spyOn(store, "fetchHosts").mockResolvedValue(),
		};
	}

	it("says why a duplicate was refused, and closes", async () => {
		const { duplicateHost, fetchHosts } = spies();
		duplicateHost.mockResolvedValueOnce(refused("Host not found or cannot be duplicated"));
		await openMenu("pi");

		await duplicate();

		expect(duplicateHost).toHaveBeenCalledWith("pi");
		expect(toasts()).toEqual([{ level: "error", text: "Host not found or cannot be duplicated" }]);
		expect(fetchHosts).not.toHaveBeenCalled();
		expect(emitted).toContainEqual(["close", "pi"]);
	});

	it("says so when the hub does not answer a duplicate", async () => {
		const { duplicateHost } = spies();
		duplicateHost.mockRejectedValueOnce(new TypeError("Failed to fetch"));
		await openMenu("pi");

		await duplicate();

		expect(toasts()).toEqual([
			{ level: "error", text: "Could not reach the hub: Failed to fetch" },
		]);
		expect(emitted).toContainEqual(["close", "pi"]);
	});

	it("says nothing of a duplicate that went through, and reloads the hosts", async () => {
		const { duplicateHost, fetchHosts } = spies();
		duplicateHost.mockResolvedValueOnce({ ok: true, host: host("pi2", "ssh") });
		await openMenu("pi");

		await duplicate();

		expect(toasts()).toEqual([]);
		expect(fetchHosts).toHaveBeenCalledOnce();
	});

	it("says why a move was refused, or that the hub did not answer, and nothing once it went through", async () => {
		const { moveHostToGroup } = spies();
		moveHostToGroup
			.mockResolvedValueOnce(refused("Host not found"))
			.mockRejectedValueOnce(new TypeError("Failed to fetch"))
			.mockResolvedValueOnce({ ok: true });

		await openMenu("pi");
		await moveTo("Prod");
		expect(moveHostToGroup).toHaveBeenLastCalledWith("pi", "g1");
		expect(toasts().map((t) => t.text)).toEqual(["Host not found"]);
		expect(emitted).toContainEqual(["close", "pi"]);

		await moveTo("Ungrouped");
		expect(moveHostToGroup).toHaveBeenLastCalledWith("pi", null);
		expect(toasts().map((t) => t.text)).toEqual([
			"Host not found",
			"Could not reach the hub: Failed to fetch",
		]);

		await moveTo("Prod");
		expect(toasts()).toHaveLength(2);
	});
});

describe("Keep the agent left here and connect (#701)", () => {
	function hostIs(patch: Partial<Host>): void {
		const store = useHostsStore();
		store.hosts = store.hosts.map((h) => (h.id === "pi" ? { ...h, ...patch } : h));
	}

	it.each([
		{ os: "linux", sshRemoteDaemon: false },
		{ os: "darwin", sshRemoteDaemon: null },
		{ os: "linux" },
		// #755 AC-W4: reached through the relay.
		{ os: "windows", sshRemoteDaemon: false },
	] as const)(
		"offers it to an unconnected $os host not set to keep one ($sshRemoteDaemon)",
		async (patch) => {
			hostIs(patch);
			await openMenu("pi");
			expect(offered()).toContain("keep-agent");
			document.body.querySelector<HTMLElement>('[data-action="keep-agent"]')?.click();
			expect(emitted).toEqual([
				["keep-agent", "pi"],
				["close", "pi"],
			]);
		},
	);

	it.each([
		["an unknown system", { os: null, sshRemoteDaemon: false }],
		["a host set to keep one", { os: "linux", sshRemoteDaemon: true }],
	] as const)("does not offer it to %s", async (_, patch) => {
		hostIs(patch);
		await openMenu("pi");
		expect(offered()).not.toContain("keep-agent");
	});

	it("does not offer it to a connected host", async () => {
		hostIs({ os: "linux", sshRemoteDaemon: false });
		sessionIs("active");
		await openMenu("pi");
		expect(offered()).not.toContain("keep-agent");
	});
});

describe("Keep the agent left here and connect on a host the hub lost (#701)", () => {
	it.each(["disconnected", "starting"] as const)(
		"offers it while no agent is connected (session %s)",
		async (status) => {
			const store = useHostsStore();
			store.hosts = store.hosts.map((h) =>
				h.id === "pi" ? { ...h, os: "linux", sshRemoteDaemon: false } : h,
			);
			sessionIs(status);
			await openMenu("pi");
			expect(offered()).toContain("keep-agent");
		},
	);
});

describe("the host menu's Update agent entry (#1185)", () => {
	const OLDER = { running: "0.15.2", expected: "0.22.1" };

	it("offers it to an SSH host served by an older agent, after the connection items", async () => {
		sessionIs("active");
		useHostsStore().rememberOutdatedAgent("pi", OLDER);
		await openMenu("pi");
		expect(offered()).toEqual(["reconnect", "disconnect", "replace-agent"]);
		expect(document.body.querySelector('[data-action="replace-agent"]')?.textContent?.trim()).toBe(
			"Update agent…",
		);
	});

	it("offers it to none served by a current agent", async () => {
		sessionIs("active");
		await openMenu("pi");
		expect(offered()).toEqual(["reconnect", "disconnect"]);
	});

	it("does not offer it on the local host, where it would end nothing", async () => {
		useHostsStore().rememberOutdatedAgent("local", OLDER);
		await openMenu("local");
		expect(offered()).toEqual([]);
	});

	it("sends it for its host and closes", async () => {
		useHostsStore().rememberOutdatedAgent("pi", OLDER);
		await openMenu("pi");

		document.body.querySelector<HTMLElement>('[data-action="replace-agent"]')?.click();

		expect(emitted).toEqual([
			["replace-agent", "pi"],
			["close", "pi"],
		]);
	});
});

// The menu opens where it was asked, moved inside the window when it would overflow (#1190). The
// test window has no layout: the menu's size is what the spec says it measures, 200 x 300.
describe("where the host menu is drawn (#1190)", () => {
	function windowIs(width: number, height: number): void {
		window.innerWidth = width;
		window.innerHeight = height;
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
			width: 200,
			height: 300,
		} as DOMRect);
	}
	const menu = () => document.body.querySelector<HTMLElement>(".ctx-menu");
	const drawn = () => [menu()?.style.left, menu()?.style.top];

	afterEach(() => vi.restoreAllMocks());

	it("keeps where it was asked when it fits", async () => {
		windowIs(1000, 600);
		await openMenu("pi", { x: 100, y: 50 });
		expect(drawn()).toEqual(["100px", "50px"]);
		expect(menu()?.style.overflowY).toBe("");
	});

	it("moves up to end 4px above the bottom edge", async () => {
		windowIs(1000, 600);
		await openMenu("pi", { x: 100, y: 500 });
		expect(drawn()).toEqual(["100px", "296px"]);
	});

	it("moves left to end 4px before the right edge", async () => {
		windowIs(1000, 600);
		await openMenu("pi", { x: 950, y: 50 });
		expect(drawn()).toEqual(["796px", "50px"]);
	});

	it("limits its height and scrolls in a window shorter than itself", async () => {
		windowIs(1000, 200);
		await openMenu("pi", { x: 100, y: 150 });
		expect(drawn()).toEqual(["100px", "4px"]);
		expect(menu()?.style.maxHeight).toBe("192px");
		expect(menu()?.style.overflowY).toBe("auto");
	});
});
