/**
 * The host menu's connection items (#648): what it offers for each status a
 * host can have, and what choosing one sends. What the hub then does is in
 * the hub's specs; the question asked first, in utils/host-connection.spec.ts.
 *
 * The menu is mounted with its real stores, fed a host directly.
 */
import type { Host, SessionStatus } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import { useHostsStore } from "../stores/hosts.js";
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
