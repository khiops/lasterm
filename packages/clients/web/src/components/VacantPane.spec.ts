import { BUNDLED_THEMES, type Channel, type Host, type HostGroup } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import { useCommandPalette } from "../composables/useCommandPalette.js";
import type { PaneNode } from "../composables/usePaneTree.js";
import { useChannelsStore } from "../stores/channels.js";
import { useHostsStore } from "../stores/hosts.js";
import { useThemeStore } from "../stores/theme.js";
import CommandPalette from "./CommandPalette.vue";
import PaneLayout from "./PaneLayout.vue";
import VacantPane from "./VacantPane.vue";

// The empty pane's picker (#625), mounted: what `useHostPicker` and `hostPicker`
// decide is tested there; this holds what no store test reaches: the markup a
// screen reader and a keyboard rely on, and the road from a chosen host up
// through PaneLayout (App.spec.ts takes it from there), and the command
// palette's host rows. That its styles name no colour of their own is a lint
// rule, `packages/clients/web/lint/no-literal-colour.grit`, in biome.json.

vi.mock("../stores/session.js", () => ({
	useSessionStore: () => ({
		connected: true,
		wsClient: { send: vi.fn(), on: vi.fn(() => vi.fn()) },
	}),
}));

const STAMP = "2026-01-01T00:00:00Z";

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
		createdAt: STAMP,
		updatedAt: STAMP,
		...overrides,
	};
}

function group(id: string, name: string, sortOrder: number): HostGroup {
	return { id, name, sortOrder, createdAt: STAMP, updatedAt: STAMP };
}

function channel(id: string, displayTitle: string): Channel {
	return {
		id,
		sessionId: `s-${id}`,
		cols: 80,
		rows: 24,
		status: "live",
		displayTitle,
		createdAt: STAMP,
		updatedAt: STAMP,
	};
}

let app: App | null = null;
let root: HTMLElement;

beforeEach(() => {
	setActivePinia(createPinia());
	localStorage.clear();
	const hostsStore = useHostsStore();
	hostsStore.hosts = [
		host("local", { type: "local", sshUser: null }),
		host("web-1", { hostGroupId: "prod" }),
		host("web-2", { hostGroupId: "prod", sortOrder: 1 }),
		host("pi", { hostGroupId: "home" }),
	];
	hostsStore.hostGroups = [group("home", "Home", 0), group("prod", "Prod", 1)];
	hostsStore.updateSessionStatus("web-1", "active");
	hostsStore.updateSessionStatus("web-2", "active");
	const channelsStore = useChannelsStore();
	channelsStore.activeHostId = "web-1";
	// A terminal on this tab's host that no pane shows: the picker offers it.
	channelsStore.channels = [channel("ch-mig", "migrations")];
	channelsStore.registerChannelHost("ch-mig", "web-1");
});

afterEach(() => {
	app?.unmount();
	app = null;
	root?.remove();
	document.body.replaceChildren();
	document.documentElement.removeAttribute("style");
});

/** An empty pane of a tab on web-1, with what it emitted. */
async function mountPane() {
	const emitted: unknown[][] = [];
	root = document.createElement("div");
	document.body.appendChild(root);
	app = createApp({
		render: () =>
			h(VacantPane, {
				vacantId: "v1",
				hostId: "web-1",
				onNewTerminal: (...args: unknown[]) => emitted.push(["new-terminal", ...args]),
				onSelectChannel: (...args: unknown[]) => emitted.push(["select-channel", ...args]),
				onRearrange: (...args: unknown[]) => emitted.push(["rearrange", ...args]),
				onAddHost: () => emitted.push(["add-host"]),
			}),
	});
	app.mount(root);
	await nextTick();
	await nextTick();
	return emitted;
}

const search = (): HTMLInputElement => root.querySelector(".picker-input") as HTMLInputElement;

/** The option a keydown would act on, as assistive tech is told of it. */
const lit = (): HTMLElement | null =>
	document.getElementById(search().getAttribute("aria-activedescendant") ?? "");

function keydown(el: Element, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
	const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
	el.dispatchEvent(event);
	return event;
}

/** A computed colour as red, green and blue. */
function rgb(css: string): string {
	const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(css);
	if (hex !== null)
		return hex
			.slice(1)
			.map((c) => Number.parseInt(c, 16))
			.join(", ");
	return /^rgba?\((\d+), (\d+), (\d+)/.exec(css)?.slice(1).join(", ") ?? css;
}

describe("VacantPane picker", () => {
	it("is a search box driving a list of options, the lit one named to assistive tech", async () => {
		await mountPane();
		const input = search();
		expect(root.querySelector(`label[for="${input.id}"]`)?.textContent).toBe(
			"Search hosts and terminals",
		);
		expect(input.getAttribute("role")).toBe("combobox");
		const list = document.getElementById(input.getAttribute("aria-controls") ?? "");
		expect(list?.getAttribute("role")).toBe("listbox");
		const options = [...(list?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
		// web-1 and its detached terminal, then local, pi, web-2, and the add-host row.
		expect(options).toHaveLength(6);
		expect(lit()).toBe(options[0]);
		expect(options[0]?.getAttribute("aria-selected")).toBe("true");

		keydown(input, "ArrowDown");
		await nextTick();
		expect(lit()).toBe(options[1]);
		expect(options[1]?.getAttribute("aria-selected")).toBe("true");
		expect(options[0]?.getAttribute("aria-selected")).toBe("false");
	});

	it("takes the focus when it appears", async () => {
		await mountPane();
		expect(document.activeElement).toBe(search());
	});

	it("keeps the focus in the search when a row is clicked, so Esc still reaches it", async () => {
		await mountPane();
		const options = [...root.querySelectorAll<HTMLElement>('[role="option"]')];
		// A host, a terminal and the add-host row.
		expect(options.map((o) => o.querySelector(".host-pick-row") !== null)).toContain(true);
		expect(options.some((o) => o.textContent?.includes("Reattach"))).toBe(true);
		expect(options.some((o) => o.classList.contains("picker-row--add"))).toBe(true);
		for (const option of options) {
			const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
			option.dispatchEvent(press);
			expect(press.defaultPrevented, option.id).toBe(true);
		}
		expect(document.activeElement).toBe(search());
	});

	it("closes the pane with a quiet button, not a red one", async () => {
		useThemeStore().applyTheme(BUNDLED_THEMES["one-half-dark"]!);
		const emitted = await mountPane();
		const close = root.querySelector<HTMLButtonElement>("button.picker-close");
		expect(close?.textContent?.trim()).toBe("Close pane");
		// The theme's danger colour, which this button is not drawn in.
		const danger = "243, 139, 168";
		const style = getComputedStyle(close as Element);
		for (const [part, colour] of [
			["text", style.color],
			["ground", style.backgroundColor],
			["border", style.borderTopColor],
		]) {
			expect(rgb(colour as string), part).not.toBe(danger);
		}
		close?.click();
		expect(emitted).toEqual([["rearrange", "v1"]]);
	});

	it("draws host rows with the shared row", async () => {
		await mountPane();
		const hosts = [...root.querySelectorAll('[role="option"] .host-pick-row')];
		expect(hosts.map((row) => row.querySelector(".host-pick-row__label")?.textContent)).toEqual([
			"web-1",
			"local",
			"pi",
			"web-2",
		]);
	});
});

describe("PaneLayout's empty panes (#625)", () => {
	/** A tab on web-1 split into two empty panes, with what the layout emitted. */
	function mountLayout() {
		const emitted: unknown[][] = [];
		const node: PaneNode = {
			type: "split",
			direction: "vertical",
			ratio: 0.5,
			first: { type: "vacant", id: "v-left" },
			second: { type: "vacant", id: "v-right" },
		};
		root = document.createElement("div");
		document.body.appendChild(root);
		app = createApp({
			render: () =>
				h(PaneLayout, {
					node,
					hostId: "web-1",
					tabId: "tab-1",
					onNewTerminalVacant: (...args: unknown[]) =>
						emitted.push(["new-terminal-vacant", ...args]),
					onAddHost: () => emitted.push(["add-host"]),
				}),
		});
		app.mount(root);
		return emitted;
	}

	const pane = (id: string): HTMLElement =>
		root.querySelector(`[data-pane-id="${id}"]`) as HTMLElement;

	function choose(paneId: string, option: (row: HTMLElement) => boolean): void {
		const row = [...pane(paneId).querySelectorAll<HTMLElement>('[role="option"]')].find(option);
		if (row === undefined) throw new Error(`no such row in ${paneId}`);
		row.click();
	}

	it("hands the chosen host up with the pane, and the add-host form, from either side", async () => {
		const emitted = mountLayout();
		await nextTick();
		const host = (label: string) => (row: HTMLElement) =>
			row.querySelector(".host-pick-row__label")?.textContent === label;
		const add = (row: HTMLElement) => row.classList.contains("picker-row--add");
		choose("v-left", host("web-2"));
		choose("v-right", host("web-1"));
		choose("v-left", add);
		choose("v-right", add);
		expect(emitted).toEqual([
			["new-terminal-vacant", "v-left", "web-2"],
			["new-terminal-vacant", "v-right", "web-1"],
			["add-host"],
			["add-host"],
		]);
	});
});

describe("CommandPalette host rows (#625)", () => {
	const openOnHost = vi.fn();

	beforeEach(() => {
		openOnHost.mockReset();
		root = document.createElement("div");
		document.body.appendChild(root);
		app = createApp({ render: () => h(CommandPalette) });
		app.mount(root);
		useCommandPalette().onOpenHost.value = openOnHost;
	});

	afterEach(() => {
		useCommandPalette().close();
		useCommandPalette().onOpenHost.value = null;
	});

	/** The palette opened on web-2's row, with local the host in view. */
	async function openOnWeb2(): Promise<HTMLInputElement> {
		useHostsStore().selectHost("local");
		useCommandPalette().open();
		await nextTick();
		const input = document.querySelector(".palette-input") as HTMLInputElement;
		input.value = "@web-2";
		input.dispatchEvent(new Event("input"));
		await nextTick();
		return input;
	}

	const row = (): HTMLElement => document.querySelector(".palette-item") as HTMLElement;

	it("draws a host with the empty pane's row", async () => {
		await openOnWeb2();
		expect(row().querySelector(".host-pick-row .host-pick-row__label")?.textContent).toBe("web-2");
	});

	it("opens a terminal on Enter, and only switches to the host on Shift+Enter", async () => {
		keydown(await openOnWeb2(), "Enter", { shiftKey: true });
		expect(useHostsStore().selectedHostId).toBe("web-2");
		expect(openOnHost).not.toHaveBeenCalled();

		keydown(await openOnWeb2(), "Enter");
		expect(openOnHost).toHaveBeenCalledExactlyOnceWith("web-2");
		expect(useHostsStore().selectedHostId).toBe("local");
	});

	it("opens a terminal on a click, and only switches to the host on Shift+click", async () => {
		await openOnWeb2();
		row().dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
		expect(useHostsStore().selectedHostId).toBe("web-2");
		expect(openOnHost).not.toHaveBeenCalled();

		await openOnWeb2();
		row().dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(openOnHost).toHaveBeenCalledExactlyOnceWith("web-2");
		expect(useHostsStore().selectedHostId).toBe("local");
	});
});
