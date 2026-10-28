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

async function openMenu(hostId: string): Promise<void> {
	const root = document.createElement("div");
	document.body.appendChild(root);
	const record = (event: string) => (id: string) => emitted.push([event, id]);
	app = createApp({
		render: () =>
			h(HostContextMenu, {
				visible: true,
				hostId,
				x: 0,
				y: 0,
				onConnect: record("connect"),
				onReconnect: record("reconnect"),
				onDisconnect: record("disconnect"),
				onStopAgent: record("stop-agent"),
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
