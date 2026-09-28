/**
 * The host rail as a grid of badges (#623): rows filled left to right, then
 * down; a ring in a grid where one column has its pill; centred group headers;
 * a drop that lands where the rail is read; the footer in the same rows.
 *
 * The rail is mounted with its real stores, fed hosts directly. Only the
 * calls that would reach the hub are stood in for.
 */
import type { Host, HostGroup, HostRailBadgeSize } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick, ref } from "vue";
import { useHostsStore } from "../stores/hosts.js";
import { shortcutLabel } from "../utils/app-shortcuts.js";
import HostRail from "./HostRail.vue";
import SOURCE from "./HostRail.vue?raw";

const STAMP = "2026-09-28T00:00:00.000Z";

function host(id: string, fields: Partial<Host> = {}): Host {
	return {
		id,
		type: "ssh",
		label: id,
		iconType: "auto",
		trustRemoteHints: "ask",
		sortOrder: 0,
		os: null,
		arch: null,
		createdAt: STAMP,
		updatedAt: STAMP,
		...fields,
	};
}

function group(id: string, name: string, sortOrder: number): HostGroup {
	return { id, name, sortOrder, createdAt: STAMP, updatedAt: STAMP };
}

/** local; Prod: a b c d e; Ungrouped: u1 u2. */
const HOSTS: Host[] = [
	host("local", { type: "local" }),
	...["a", "b", "c", "d", "e"].map((id, i) => host(id, { hostGroupId: "prod", sortOrder: i })),
	host("u1", { sortOrder: 0 }),
	host("u2", { sortOrder: 1 }),
];

// ─── Mounting ────────────────────────────────────────────────────────────────

let app: App | null = null;
let root: HTMLElement;
const columns = ref(1);
const badgeSize = ref<HostRailBadgeSize>("medium");

function mountRail(options: { columns?: number; badgeSize?: HostRailBadgeSize } = {}) {
	columns.value = options.columns ?? 1;
	badgeSize.value = options.badgeSize ?? "medium";
	const hostsStore = useHostsStore();
	hostsStore.hosts = HOSTS.map((h) => ({ ...h }));
	hostsStore.hostGroups = [group("prod", "Prod", 0)];
	vi.spyOn(hostsStore, "fetchHosts").mockResolvedValue();
	const reorderHosts = vi.spyOn(hostsStore, "reorderHosts").mockResolvedValue();
	const moveHostToGroup = vi.spyOn(hostsStore, "moveHostToGroup").mockResolvedValue();

	root = document.createElement("div");
	document.body.appendChild(root);
	app = createApp({
		render: () => h(HostRail, { columns: columns.value, badgeSize: badgeSize.value }),
	});
	app.use(pinia);
	app.mount(root);
	return { hostsStore, reorderHosts, moveHostToGroup };
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

// ─── Reading the rail ────────────────────────────────────────────────────────

const rail = (): HTMLElement => root.querySelector(".host-rail") as HTMLElement;

/** The hosts of each row of badges, top to bottom. */
function hostRows(): string[][] {
	return [...root.querySelectorAll(".rail-hosts > .rail-row")].map((row) =>
		[...row.querySelectorAll(".badge-wrapper")].map((el) => el.getAttribute("data-host-id") ?? ""),
	);
}

function badge(id: string): HTMLElement {
	const el = root.querySelector(`.badge-wrapper[data-host-id="${id}"]`);
	if (!el) throw new Error(`no badge for ${id}`);
	return el as HTMLElement;
}

function header(name: string): HTMLElement {
	const el = [...root.querySelectorAll(".group-header")].find((h) =>
		h.querySelector(".group-label")?.textContent?.includes(name),
	);
	if (!el) throw new Error(`no header for ${name}`);
	return el as HTMLElement;
}

// ─── Dragging ────────────────────────────────────────────────────────────────

/** What a drag carries, as far as the rail reads it. */
function transfer() {
	const data = new Map<string, string>();
	return {
		effectAllowed: "",
		dropEffect: "",
		get types() {
			return [...data.keys()];
		},
		setData(type: string, value: string) {
			data.set(type, value);
		},
		getData(type: string) {
			return data.get(type) ?? "";
		},
	};
}

function fire(el: Element, type: string, dataTransfer: ReturnType<typeof transfer>): void {
	const event = new Event(type, { bubbles: true, cancelable: true });
	Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
	el.dispatchEvent(event);
}

/** Drag one badge over another, and hold it there. */
async function dragOver(from: string, to: Element): Promise<ReturnType<typeof transfer>> {
	const data = transfer();
	fire(badge(from), "dragstart", data);
	fire(to, "dragenter", data);
	fire(to, "dragover", data);
	await nextTick();
	return data;
}

// ─── Specs ───────────────────────────────────────────────────────────────────

describe("HostRail rows", () => {
	it("in one column, stacks every badge on its own row", () => {
		mountRail({ columns: 1 });
		expect(hostRows()).toEqual([["local"], ["a"], ["b"], ["c"], ["d"], ["e"], ["u1"], ["u2"]]);
		expect(rail().classList.contains("host-rail--grid")).toBe(false);
	});

	it("in three columns, fills each section's rows left to right, the local host alone first", () => {
		mountRail({ columns: 3 });
		expect(hostRows()).toEqual([["local"], ["a", "b", "c"], ["d", "e"], ["u1", "u2"]]);
		expect(rail().classList.contains("host-rail--grid")).toBe(true);
	});

	it("reads the same hosts in the same order, whatever the columns", async () => {
		mountRail({ columns: 1 });
		const oneColumn = hostRows().flat();
		columns.value = 3;
		await nextTick();
		expect(hostRows().flat()).toEqual(oneColumn);
	});

	it("puts the separator after the local host's row", () => {
		mountRail({ columns: 3 });
		const first = root.querySelector(".rail-hosts")?.children;
		expect(first?.[0]?.classList.contains("rail-row")).toBe(true);
		expect(first?.[1]?.classList.contains("rail-separator")).toBe(true);
	});

	it("sizes its badges from the badge size", async () => {
		mountRail({ columns: 3, badgeSize: "small" });
		expect(rail().style.getPropertyValue("--rail-badge")).toBe("28px");
		expect(rail().style.getPropertyValue("--rail-initials")).toBe("11px");
		badgeSize.value = "large";
		await nextTick();
		expect(rail().style.getPropertyValue("--rail-badge")).toBe("44px");
		expect(rail().style.getPropertyValue("--rail-squircle")).toBe("14px");
	});
});

describe("HostRail selection", () => {
	it("points the pill at the selected badge in one column", async () => {
		const { hostsStore } = mountRail({ columns: 1 });
		hostsStore.selectHost("b");
		await nextTick();
		expect(badge("b").querySelector(".selection-pill")).not.toBeNull();
		expect(root.querySelectorAll(".selection-pill")).toHaveLength(1);
		expect(root.querySelector(".badge--ring")).toBeNull();
	});

	it("rings the selected badge in a grid, with no pill", async () => {
		const { hostsStore } = mountRail({ columns: 3 });
		hostsStore.selectHost("b");
		await nextTick();
		expect(badge("b").querySelector(".badge")?.classList.contains("badge--ring")).toBe(true);
		expect(root.querySelectorAll(".badge--ring")).toHaveLength(1);
		expect(root.querySelector(".selection-pill")).toBeNull();
	});

	it("draws the ring from the rail's colour and the foreground", () => {
		const ring = /\.badge\.badge--ring\s*\{[^}]*\}/.exec(SOURCE)?.[0] ?? "";
		expect(ring).toMatch(/0 0 0 2px var\(--nt-host-rail\),\s*0 0 0 4px var\(--nt-fg\)/);
	});
});

describe("HostRail group headers", () => {
	it("are centred", () => {
		const rule = /\n\.group-header\s*\{[^}]*\}/.exec(SOURCE)?.[0] ?? "";
		expect(rule).toMatch(/justify-content:\s*center/);
	});

	it("in a grid, have a hairline on each side and the host count", () => {
		mountRail({ columns: 3 });
		const prod = header("Prod");
		expect(prod.querySelectorAll(".group-hairline")).toHaveLength(2);
		expect(prod.firstElementChild?.classList.contains("group-hairline")).toBe(true);
		expect(prod.lastElementChild?.classList.contains("group-hairline")).toBe(true);
		expect(prod.querySelector(".group-count")?.textContent).toBe("5");

		const ungrouped = header("Ungrouped");
		expect(ungrouped.classList.contains("ungrouped-header")).toBe(true);
		expect(ungrouped.querySelectorAll(".group-hairline")).toHaveLength(2);
		expect(ungrouped.querySelector(".group-count")?.textContent).toBe("2");
	});

	it("in one column, have no hairline, and a count only when folded", async () => {
		mountRail({ columns: 1 });
		const prod = header("Prod");
		expect(prod.querySelector(".group-hairline")).toBeNull();
		expect(prod.querySelector(".group-count")).toBeNull();
		expect(header("Ungrouped").querySelector(".group-count")).toBeNull();

		prod.click();
		await nextTick();
		expect(header("Prod").querySelector(".group-count")?.textContent).toBe("5");
		expect(hostRows()).toEqual([["local"], ["u1"], ["u2"]]);
	});
});

describe("HostRail drag and drop", () => {
	it("in a grid, marks the drop with a vertical bar before the target", async () => {
		mountRail({ columns: 3 });
		await dragOver("e", badge("b"));
		expect(badge("b").querySelector(".drop-mark--vertical")).not.toBeNull();
		expect(root.querySelector(".drop-mark--horizontal")).toBeNull();
	});

	it("in one column, keeps the horizontal bar", async () => {
		mountRail({ columns: 1 });
		await dragOver("e", badge("b"));
		expect(badge("b").querySelector(".drop-mark--horizontal")).not.toBeNull();
		expect(root.querySelector(".drop-mark--vertical")).toBeNull();
	});

	it("reorders in reading order: e dropped on b lands between a and b", async () => {
		const { reorderHosts } = mountRail({ columns: 3 });
		const data = await dragOver("e", badge("b"));
		fire(badge("b"), "drop", data);
		expect(reorderHosts).toHaveBeenCalledExactlyOnceWith("prod", ["a", "e", "b", "c", "d"]);
		await nextTick();
		expect(root.querySelector(".drop-mark")).toBeNull();
	});

	it("reorders in reading order: a dropped on the first of the second row ends the first", async () => {
		const { reorderHosts } = mountRail({ columns: 3 });
		const data = await dragOver("a", badge("d"));
		fire(badge("d"), "drop", data);
		expect(reorderHosts).toHaveBeenCalledExactlyOnceWith("prod", ["b", "c", "a", "d", "e"]);
	});

	it("moves a badge from another section before the one it is dropped on", async () => {
		const { reorderHosts } = mountRail({ columns: 3 });
		const data = await dragOver("u1", badge("d"));
		fire(badge("d"), "drop", data);
		expect(reorderHosts).toHaveBeenCalledExactlyOnceWith("prod", ["a", "b", "c", "u1", "d", "e"]);
	});

	it("still moves a host into the group whose header it is dropped on", async () => {
		const { moveHostToGroup, reorderHosts } = mountRail({ columns: 3 });
		const data = await dragOver("u2", header("Prod"));
		fire(header("Prod"), "drop", data);
		expect(moveHostToGroup).toHaveBeenCalledExactlyOnceWith("u2", "prod");
		expect(reorderHosts).not.toHaveBeenCalled();
	});

	it("takes no drop on the local host, and does not let it move", async () => {
		const { reorderHosts } = mountRail({ columns: 3 });
		expect(badge("local").getAttribute("draggable")).toBe("false");
		expect(badge("a").getAttribute("draggable")).toBe("true");
		const data = await dragOver("a", badge("local"));
		expect(badge("local").querySelector(".drop-mark")).toBeNull();
		fire(badge("local"), "drop", data);
		expect(reorderHosts).not.toHaveBeenCalled();
	});
});

describe("HostRail footer", () => {
	/** The footer's buttons, row by row, by what they open. */
	function footerRows(): string[][] {
		return [...root.querySelectorAll(".rail-footer > .rail-row")].map((row) =>
			[...row.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? ""),
		);
	}

	// Read from the shortcut table the window runs them from (#631, #637).
	it("names the palette's and Settings' chords in its buttons' tooltips", () => {
		mountRail({ columns: 1 });
		const title = (label: string): string | null =>
			root.querySelector(`.rail-footer button[aria-label="${label}"]`)?.getAttribute("title") ??
			null;
		expect(title("Open command palette")).toBe(
			`Command palette (${shortcutLabel("palette.open")})`,
		);
		expect(title("Open settings panel")).toBe(`Settings (${shortcutLabel("settings.open")})`);
		expect(title("Open settings panel")).toBe("Settings (Ctrl+,)");
	});

	it("stacks its buttons in one column", () => {
		mountRail({ columns: 1 });
		expect(footerRows()).toEqual([
			["Open command palette"],
			["Open settings panel"],
			["Add new host"],
		]);
	});

	it("wraps its buttons in the same rows as the badges", async () => {
		mountRail({ columns: 3 });
		expect(footerRows()).toEqual([["Open command palette", "Open settings panel", "Add new host"]]);
		columns.value = 2;
		await nextTick();
		expect(footerRows()).toEqual([
			["Open command palette", "Open settings panel"],
			["Add new host"],
		]);
	});
});

// ─── The keyboard (#637) ─────────────────────────────────────────────────────

describe("HostRail keyboard", () => {
	/** The badges that take Tab. */
	function tabStops(): string[] {
		return [...root.querySelectorAll('.badge-wrapper[tabindex="0"]')].map(
			(el) => el.getAttribute("data-host-id") ?? "",
		);
	}

	function focused(): string | null {
		return document.activeElement?.getAttribute("data-host-id") ?? null;
	}

	/** Press `key` on the badge that has the keyboard, and let the rail move it. */
	async function press(key: string): Promise<void> {
		const target = document.activeElement ?? root;
		target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
		await nextTick();
		await nextTick();
	}

	it("is one zone, whose badges are its items", () => {
		mountRail({ columns: 3 });
		expect(rail().getAttribute("data-focus-zone")).toBe("rail");
		for (const el of root.querySelectorAll(".badge-wrapper")) {
			expect(el.hasAttribute("data-zone-item")).toBe(true);
			expect(el.getAttribute("role")).toBe("button");
		}
	});

	it("gives Tab to the selected host's badge only, or else to the first", async () => {
		const { hostsStore } = mountRail({ columns: 3 });
		expect(tabStops()).toEqual(["local"]);
		hostsStore.selectHost("d");
		await nextTick();
		expect(tabStops()).toEqual(["d"]);
		expect(badge("d").getAttribute("aria-pressed")).toBe("true");
	});

	it("in three columns, moves along the rows and across the group headers", async () => {
		mountRail({ columns: 3 });
		badge("a").focus();
		await press("ArrowRight");
		expect(focused()).toBe("b");
		await press("ArrowDown");
		expect(focused()).toBe("e");
		// Over the "Ungrouped" header, to the same column.
		await press("ArrowDown");
		expect(focused()).toBe("u2");
		await press("ArrowLeft");
		expect(focused()).toBe("u1");
		await press("ArrowUp");
		expect(focused()).toBe("d");
		await press("ArrowUp");
		expect(focused()).toBe("a");
		// Over the "Prod" header, to the local host alone on its row.
		await press("ArrowUp");
		expect(focused()).toBe("local");
		expect(tabStops()).toEqual(["local"]);
	});

	it("in one column, moves up and down, and not sideways", async () => {
		mountRail({ columns: 1 });
		badge("local").focus();
		await press("ArrowDown");
		expect(focused()).toBe("a");
		await press("ArrowRight");
		expect(focused()).toBe("a");
		await press("ArrowDown");
		await press("ArrowDown");
		expect(focused()).toBe("c");
		await press("End");
		expect(focused()).toBe("u2");
		await press("Home");
		expect(focused()).toBe("local");
	});

	it("passes over a folded group's badges", async () => {
		mountRail({ columns: 3 });
		header("Prod").click();
		await nextTick();
		badge("local").focus();
		await press("ArrowDown");
		expect(focused()).toBe("u1");
	});

	it("moves the keyboard without selecting, and selects on Enter or Space", async () => {
		const { hostsStore } = mountRail({ columns: 3 });
		const selectHost = vi.spyOn(hostsStore, "selectHost");
		badge("a").focus();
		await press("ArrowRight");
		expect(selectHost).not.toHaveBeenCalled();
		expect(tabStops()).toEqual(["b"]);
		await press("Enter");
		expect(selectHost).toHaveBeenLastCalledWith("b");
		await press("ArrowRight");
		await press(" ");
		expect(selectHost).toHaveBeenLastCalledWith("c");
	});

	it("gives Tab back to the selected host once the keyboard leaves", async () => {
		const { hostsStore } = mountRail({ columns: 3 });
		hostsStore.selectHost("a");
		await nextTick();
		badge("a").focus();
		await press("ArrowRight");
		expect(tabStops()).toEqual(["b"]);
		const outside = document.createElement("button");
		document.body.appendChild(outside);
		badge("b").dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: outside }));
		await nextTick();
		expect(tabStops()).toEqual(["a"]);
		outside.remove();
	});

	it("draws the keyboard's ring from the theme", () => {
		const ring = /\.badge-wrapper:focus-visible\s*\{[^}]*\}/.exec(SOURCE)?.[0] ?? "";
		expect(ring).toMatch(/outline:\s*2px solid var\(--nt-accent\)/);
		expect(ring).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
	});
});
