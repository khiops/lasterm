/**
 * The terminal list from the keyboard (#637): one terminal takes Tab, ↑ and ↓ move along the
 * list, over the group headers, and Enter opens the terminal.
 *
 * The sidebar is mounted with its real stores, fed channels directly.
 */
import type { Channel, ChannelGroup } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import { useChannelsStore } from "../stores/channels.js";
import ITEM_SOURCE from "./ChannelItem.vue?raw";
import ChannelSidebar from "./ChannelSidebar.vue";

const STAMP = "2026-09-28T00:00:00.000Z";

function channel(id: string, groupId?: string): Channel {
	return {
		id,
		sessionId: "s1",
		...(groupId !== undefined && { groupId }),
		cols: 80,
		rows: 24,
		status: "live",
		displayTitle: id,
		createdAt: STAMP,
		updatedAt: STAMP,
	};
}

function group(id: string, collapsed = false): ChannelGroup {
	return { id, hostId: "h1", name: id, sortOrder: 0, collapsed, createdAt: STAMP };
}

let app: App | null = null;
let root: HTMLElement;

/** Ops: o1 o2; General: g1 g2. */
function mountSidebar(options: { opsCollapsed?: boolean } = {}) {
	const channelsStore = useChannelsStore();
	channelsStore.activeHostId = "h1";
	channelsStore.groups = [group("ops", options.opsCollapsed ?? false)];
	channelsStore.channels = [
		channel("o1", "ops"),
		channel("o2", "ops"),
		channel("g1"),
		channel("g2"),
	];
	const openChannel = vi.fn();
	const selectChannel = vi.fn();
	root = document.createElement("div");
	document.body.appendChild(root);
	app = createApp({
		render: () => h(ChannelSidebar, { onOpenChannel: openChannel, onSelectChannel: selectChannel }),
	});
	app.use(pinia);
	app.mount(root);
	return { channelsStore, openChannel, selectChannel };
}

let pinia: ReturnType<typeof createPinia>;

beforeEach(() => {
	localStorage.clear();
	pinia = createPinia();
	setActivePinia(pinia);
});

afterEach(() => {
	app?.unmount();
	app = null;
	root?.remove();
	vi.restoreAllMocks();
});

function item(id: string): HTMLElement {
	const el = root.querySelector(`[data-channel-id="${id}"]`);
	if (!el) throw new Error(`no item ${id}`);
	return el as HTMLElement;
}

function tabStops(): string[] {
	return [...root.querySelectorAll('[data-channel-id][tabindex="0"]')].map(
		(el) => el.getAttribute("data-channel-id") ?? "",
	);
}

function focused(): string | null {
	return document.activeElement?.getAttribute("data-channel-id") ?? null;
}

async function press(key: string): Promise<void> {
	const target = document.activeElement ?? root;
	target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
	await nextTick();
	await nextTick();
}

describe("ChannelSidebar keyboard", () => {
	it("is one zone, whose terminals are its items", () => {
		mountSidebar();
		expect(root.querySelector(".channel-sidebar")?.getAttribute("data-focus-zone")).toBe("sidebar");
		expect(item("o1").hasAttribute("data-zone-item")).toBe(true);
	});

	it("gives Tab to the selected terminal only, or else to the first", async () => {
		const { channelsStore } = mountSidebar();
		expect(tabStops()).toEqual(["o1"]);
		channelsStore.selectedChannelId = "g1";
		await nextTick();
		expect(tabStops()).toEqual(["g1"]);
	});

	it("moves down and up the list, over the group headers, and stops at its ends", async () => {
		const { selectChannel } = mountSidebar();
		item("o1").focus();
		await press("ArrowDown");
		expect(focused()).toBe("o2");
		// Over the "General" header.
		await press("ArrowDown");
		expect(focused()).toBe("g1");
		await press("End");
		expect(focused()).toBe("g2");
		await press("ArrowDown");
		expect(focused()).toBe("g2");
		await press("Home");
		expect(focused()).toBe("o1");
		await press("ArrowUp");
		expect(focused()).toBe("o1");
		expect(selectChannel).not.toHaveBeenCalled();
	});

	it("passes over a folded group's terminals", async () => {
		mountSidebar({ opsCollapsed: true });
		expect(tabStops()).toEqual(["g1"]);
		item("g1").focus();
		await press("ArrowUp");
		expect(focused()).toBe("g1");
	});

	it("opens the terminal on Enter", async () => {
		const { openChannel } = mountSidebar();
		item("o1").focus();
		await press("ArrowDown");
		await press("Enter");
		expect(openChannel).toHaveBeenCalledExactlyOnceWith("o2");
	});

	it("draws the keyboard's ring from the theme", () => {
		const ring = /\.channel-item:focus-visible\s*\{[^}]*\}/.exec(ITEM_SOURCE)?.[0] ?? "";
		expect(ring).toMatch(/outline:\s*2px solid var\(--nt-accent\)/);
		expect(ring).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
	});
});
