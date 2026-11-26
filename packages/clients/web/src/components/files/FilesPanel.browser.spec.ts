/**
 * The files panel's cards in every bundled theme (#836, #936): whatever asks or warns reads at
 * 4.5:1 or better on its ground, as the exit card does. happy-dom computes no colour-mix(), which
 * the theme's text levels are made of, so this runs in a browser: the panel mounted with its own
 * rules and base.css, its listing failed and an option's change asking its scope.
 */
import { BUNDLED_THEMES, DEFAULT_LAYOUT_CONFIG, DEFAULT_PROFILE, type Host } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick } from "vue";

const mocks = vi.hoisted(() => ({ listHostFiles: vi.fn(), hubFetch: vi.fn() }));

vi.mock("../../utils/host-files.js", () => ({
	listHostFiles: mocks.listHostFiles,
	createHostFolder: vi.fn(),
	HUB_UNREACHABLE: "HUB_UNREACHABLE",
}));
vi.mock("../../utils/hub-fetch.js", () => ({ hubFetch: mocks.hubFetch }));

import "../../styles/base.css";
import { useChannelsStore } from "../../stores/channels.js";
import { useConfigStore } from "../../stores/config.js";
import { useFilesPanelStore } from "../../stores/files-panel.js";
import { useHostsStore } from "../../stores/hosts.js";
import { contrastRatio, TEXT_CONTRAST_AA, useThemeStore } from "../../stores/theme.js";
import type { FileEntryView } from "../../utils/files-panel.js";
import FilesBrowser from "./FilesBrowser.vue";
import FilesPanel from "./FilesPanel.vue";

const NAS = "01ARZ3NDEKTSV4RRFFQ69G5FN1";
const ON_NAS = "01ARZ3NDEKTSV4RRFFQ69G5FC1";

let app: App | null = null;

/** Every request answered and every render done: a response's body is read in a later task. */
async function settle(): Promise<void> {
	for (let i = 0; i < 8; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await nextTick();
	}
}

beforeEach(() => {
	localStorage.clear();
	setActivePinia(createPinia());
	// The listing fails: the host is not connected, so the card offers Connect and Retry.
	mocks.listHostFiles.mockResolvedValue({ ok: false, code: "HOST_NOT_CONNECTED", message: "x" });
	// This terminal and its host both set "Follow the terminal's directory".
	const layers = {
		global: {},
		host: { transferFollowCwd: true },
		channel: { transferFollowCwd: true },
	};
	mocks.hubFetch.mockImplementation(async (url: string) => {
		if (!String(url).startsWith("/api/config/cascade")) return new Response("{}", { status: 503 });
		const resolved = { ...DEFAULT_PROFILE, ...layers.global, ...layers.host, ...layers.channel };
		return new Response(
			JSON.stringify({ terminal: { defaults: DEFAULT_PROFILE, ...layers, resolved } }),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	});
	useConfigStore().uiConfig = { onChannelDead: "readonly", experimental: { fileTransfer: true } };
	useHostsStore().hosts = [
		{
			id: NAS,
			type: "ssh",
			label: "nas",
			iconType: "auto",
			trustRemoteHints: "ignore",
			sortOrder: 0,
			os: "linux",
			arch: null,
		} as Host,
	];
	useChannelsStore().registerChannelHost(ON_NAS, NAS);
	const panel = useFilesPanelStore();
	panel.setChannelsInTabs(new Set([ON_NAS]));
	panel.setFocused(ON_NAS);
	panel.openFor(null);
	panel.setOptionsExpanded(true);
});

afterEach(() => {
	app?.unmount();
	app = null;
	document.body.replaceChildren();
	document.documentElement.removeAttribute("style");
});

/** Two frames: a `ResizeObserver` reports a size before the frame that paints it. */
async function frames(): Promise<void> {
	for (let i = 0; i < 2; i++) await new Promise((resolve) => requestAnimationFrame(resolve));
	await settle();
}

/** The files browser alone in a box `width` px wide, listing `entries`. */
async function mountBrowserIn(width: number, entries: FileEntryView[]): Promise<HTMLElement> {
	mocks.listHostFiles.mockResolvedValue({
		ok: true,
		value: { path: "/srv/drop", entries, truncated: 0 },
	});
	useFilesPanelStore().browse(ON_NAS, "/srv/drop");
	const root = document.createElement("div");
	root.style.cssText = `display: flex; flex-direction: column; width: ${width}px; height: 400px`;
	document.body.appendChild(root);
	app = createApp({
		render: () =>
			h(FilesBrowser, {
				channelId: ON_NAS,
				hostId: NAS,
				hostLabel: "nas",
				hostOs: "linux",
				writer: true,
				followByDefault: false,
				showHidden: false,
				sftpUnavailable: false,
				agentUpdatable: false,
				shell: "bash",
				tint: null,
			}),
	});
	app.mount(root);
	await frames();
	return root;
}

/** The panel, drawn under `theme` at 80 % opacity, with both its cards up. */
async function mountWithCards(theme: (typeof BUNDLED_THEMES)[string]): Promise<HTMLElement> {
	const themeStore = useThemeStore();
	themeStore.applyTheme(theme);
	themeStore.applyOpacity({ terminal: 100, sidebar: 80, hostRail: 100, tabBar: 100 });
	const root = document.createElement("div");
	root.style.cssText = "position: relative; width: 320px; height: 640px";
	document.body.appendChild(root);
	app = createApp({
		render: () =>
			h(FilesPanel, {
				form: "docked",
				side: "right",
				width: 300,
				attachedOnScreen: true,
				over: null,
			}),
	});
	app.mount(root);
	await settle();
	const follow = [...root.querySelectorAll<HTMLElement>(".files-option")]
		.find((row) => row.textContent?.includes("Follow the terminal's directory"))
		?.querySelector<HTMLInputElement>('input[role="switch"]');
	if (follow === undefined || follow === null) throw new Error("no Follow switch");
	follow.click();
	await settle();
	return root;
}

/** A colour as the browser computes it: red, green and blue from 0 to 255, and its alpha. */
function channels(css: string): { rgb: [number, number, number]; alpha: number } {
	const rgb = /^rgba?\(([\d.]+), ([\d.]+), ([\d.]+)(?:, ([\d.]+))?\)$/.exec(css);
	if (rgb !== null) {
		return { rgb: [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])], alpha: Number(rgb[4] ?? 1) };
	}
	// colour-mix() comes back in this form.
	const srgb = /^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)$/.exec(css);
	if (srgb !== null) {
		const [r, g, b] = [srgb[1], srgb[2], srgb[3]].map((v) => Number(v) * 255);
		return { rgb: [r ?? 0, g ?? 0, b ?? 0], alpha: Number(srgb[4] ?? 1) };
	}
	throw new Error(`cannot read the colour ${css}`);
}

/** The text of `el` and the ground it is drawn on: the nearest that is drawn at all, which must
 * let nothing through. */
function pair(
	el: Element,
	what: string,
): { text: [number, number, number]; ground: [number, number, number] } {
	const text = channels(getComputedStyle(el).color);
	expect(text.alpha, `${what}'s text is see-through`).toBe(1);
	for (let at: Element | null = el; at !== null; at = at.parentElement) {
		const ground = channels(getComputedStyle(at).backgroundColor);
		if (ground.alpha === 0) continue;
		expect(ground.alpha, `${what}'s ground (${at.className}) is see-through`).toBe(1);
		return { text: text.rgb, ground: ground.rgb };
	}
	throw new Error(`${what} has no ground`);
}

describe("the panel's cards (#836)", () => {
	for (const [name, theme] of Object.entries(BUNDLED_THEMES)) {
		it(`read at 4.5:1 or better in ${name}`, async () => {
			const root = await mountWithCards(theme);
			const error = root.querySelector('.files-card[role="alert"]') as HTMLElement;
			const scope = root.querySelector('.files-card[role="group"]') as HTMLElement;
			const button = (card: HTMLElement, label: string): HTMLElement => {
				const found = [...card.querySelectorAll<HTMLElement>(".files-btn")].find(
					(b) => b.textContent?.trim() === label,
				);
				if (found === undefined) throw new Error(`no ${label} button`);
				return found;
			};
			const texts: [string, Element][] = [
				["error card", error],
				["error card's text", error.querySelector(".files-card__text") as Element],
				["error card's Retry", button(error, "Retry")],
				["error card's Connect", button(error, "Connect")],
				["scope question", scope.querySelector(".files-scope__ask") as Element],
				["scope question's drops", scope.querySelector(".files-scope__drops") as Element],
				["scope choice", button(scope, "Everywhere")],
				["scope choice, the host", button(scope, "nas")],
			];
			for (const [what, el] of texts) {
				const { text, ground } = pair(el, what);
				const ratio = contrastRatio(text, ground);
				expect(ratio, `${what}: ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(TEXT_CONTRAST_AA);
			}
		});
	}
});

describe("the permissions column, by the panel's width (#1195)", () => {
	const entry = (
		name: string,
		kind: FileEntryView["kind"],
		mode: number | null,
		more: Partial<FileEntryView> = {},
	): FileEntryView => ({
		name,
		kind,
		size: kind === "directory" ? null : 10,
		mtime: "2026-10-30T10:00:00Z",
		mode,
		attributes: null,
		owner: null,
		group: null,
		...more,
	});
	const row = (root: HTMLElement, name: string): HTMLElement =>
		[...root.querySelectorAll<HTMLElement>(".files-row")].find(
			(el) => el.querySelector(".files-row__name")?.textContent === name,
		) as HTMLElement;
	const shown = (el: Element | null): boolean =>
		el !== null && getComputedStyle(el).display !== "none";
	/** Enough rows of one owner for the list to scroll, so its scrollbar takes from the rows. */
	const fillers = Array.from({ length: 40 }, (_, index) =>
		entry(`z${String(index).padStart(2, "0")}.txt`, "file", 0o100644, { owner: "o", group: "g" }),
	);
	/** The box's width for the list's rows to get `width`, beside the list's scrollbar. */
	const boxFor = (root: HTMLElement, width: number): string => {
		const list = root.querySelector(".files-list") as HTMLElement;
		return `${width + list.offsetWidth - list.clientWidth}px`;
	};

	it("shows the column from 400 px on, and the permissions on hover below", async () => {
		const root = await mountBrowserIn(600, [
			entry("bin", "directory", 0o40755, { owner: "o", group: "g" }),
			entry("notes.md", "file", 0o100644, { owner: "o", group: "g" }),
			entry("boot.ini", "file", null, { attributes: 0x21, owner: "D\\o", group: "D\\g" }),
			entry("unknown", "file", null),
			...fillers,
		]);
		const list = root.querySelector(".files-list") as HTMLElement;
		expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
		const notes = row(root, "notes.md");

		// Below 400 px: no Mode or owner column; the row says them, and its group, on hover.
		root.style.width = boxFor(root, 399);
		await frames();
		expect(list.clientWidth).toBe(399);
		expect(shown(notes.querySelector(".files-row__mode"))).toBe(false);
		expect(shown(notes.querySelector(".files-row__owner"))).toBe(false);
		expect(shown(notes.querySelector(".files-row__modified"))).toBe(true);
		expect(notes.getAttribute("title")).toBe("Permissions -rw-r--r--\nOwner o\nGroup g");
		expect(row(root, "boot.ini").getAttribute("title")).toBe(
			"Attributes -ar---\nOwner D\\o\nGroup D\\g",
		);
		expect(row(root, "unknown").hasAttribute("title")).toBe(false);

		// From 400 to 479 px: the Mode column, the owner still on hover.
		for (const width of [400, 479]) {
			root.style.width = boxFor(root, width);
			await frames();
			expect(shown(notes.querySelector(".files-row__mode")), `${width}`).toBe(true);
			expect(notes.querySelector(".files-row__mode")?.textContent).toBe("-rw-r--r--");
			expect(shown(notes.querySelector(".files-row__owner")), `${width}`).toBe(false);
			expect(notes.getAttribute("title"), `${width}`).toBe("Owner o\nGroup g");
		}

		// From 480 px: the owner column too, its cell saying it whole on hover; the group on hover.
		root.style.width = boxFor(root, 480);
		await frames();
		expect(list.clientWidth).toBe(480);
		const owner = notes.querySelector(".files-row__owner") as HTMLElement;
		expect(shown(owner)).toBe(true);
		expect(owner.textContent).toBe("o");
		expect(owner.getAttribute("title")).toBe("Owner o");
		expect(owner.getBoundingClientRect().width).toBe(80);
		expect(
			(notes.querySelector(".files-row__name") as HTMLElement).getBoundingClientRect().width,
		).toBeGreaterThanOrEqual(140);
		expect(notes.getAttribute("title")).toBe("Group g");

		// Back to 479 px: the owner column goes and the row says the owner again.
		root.style.width = boxFor(root, 479);
		await frames();
		expect(shown(owner)).toBe(false);
		expect(notes.getAttribute("title")).toBe("Owner o\nGroup g");
	});

	it("keeps the column, with —, for a host that gives no permissions", async () => {
		const root = await mountBrowserIn(400, [
			entry("Users", "directory", null),
			entry("pagefile.sys", "file", null),
		]);
		for (const cell of root.querySelectorAll(".files-row__mode")) {
			expect(shown(cell)).toBe(true);
			expect(cell.textContent).toBe("—");
			expect(cell.getBoundingClientRect().width).toBeGreaterThanOrEqual(50);
		}
		expect(root.querySelectorAll(".files-row__mode")).toHaveLength(2);
		expect(root.querySelectorAll(".files-row[title]")).toHaveLength(0);
	});

	it("measures the list that comes after an empty folder", async () => {
		const listed = [entry("notes.md", "file", 0o100644, { owner: "o", group: "g" })];
		const root = await mountBrowserIn(480, listed);
		expect(shown(row(root, "notes.md").querySelector(".files-row__owner"))).toBe(true);
		mocks.listHostFiles.mockResolvedValue({
			ok: true,
			value: { path: "/srv/drop", entries: [], truncated: 0 },
		});
		(root.querySelector('button[aria-label="Refresh"]') as HTMLButtonElement).click();
		await frames();
		expect(root.querySelector(".files-list")).toBeNull();
		root.style.width = "399px";
		await frames();
		mocks.listHostFiles.mockResolvedValue({
			ok: true,
			value: { path: "/srv/drop", entries: listed, truncated: 0 },
		});
		(root.querySelector('button[aria-label="Refresh"]') as HTMLButtonElement).click();
		await frames();
		const notes = row(root, "notes.md");
		expect(shown(notes.querySelector(".files-row__mode"))).toBe(false);
		expect(shown(notes.querySelector(".files-row__owner"))).toBe(false);
		expect(notes.getAttribute("title")).toBe("Permissions -rw-r--r--\nOwner o\nGroup g");
		// The new list is the one measured: widening it brings both columns back.
		root.style.width = "480px";
		await frames();
		expect(shown(notes.querySelector(".files-row__mode"))).toBe(true);
		expect(shown(notes.querySelector(".files-row__owner"))).toBe(true);
	});
});

describe("the columns' widths and choice, in the real layout (#1209)", () => {
	const entry = (name: string, more: Partial<FileEntryView> = {}): FileEntryView => ({
		name,
		kind: "file",
		size: 10,
		mtime: "2026-10-30T10:00:00Z",
		mode: 0o100644,
		attributes: null,
		owner: "o",
		group: "g",
		...more,
	});
	const fillers = Array.from({ length: 40 }, (_, index) =>
		entry(`z${String(index).padStart(2, "0")}.txt`),
	);
	const row = (root: HTMLElement, name: string): HTMLElement =>
		[...root.querySelectorAll<HTMLElement>(".files-row")].find(
			(el) => el.querySelector(".files-row__name")?.textContent === name,
		) as HTMLElement;
	const rect = (el: Element | null): DOMRect => (el as Element).getBoundingClientRect();
	const shown = (el: Element | null): boolean =>
		el !== null && getComputedStyle(el).display !== "none";
	const pointer = (target: Element, type: string, clientX: number): void => {
		target.dispatchEvent(
			new PointerEvent(type, { bubbles: true, cancelable: true, clientX, clientY: 10, button: 0 }),
		);
	};

	it("lines the header's cells up with the rows' cells, a scrollbar or not", async () => {
		const root = await mountBrowserIn(600, [entry("notes.md"), ...fillers]);
		const list = root.querySelector(".files-list") as HTMLElement;
		expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
		const notes = row(root, "notes.md");
		for (const column of ["size", "modified", "mode", "owner"]) {
			const head = rect(root.querySelector(`.files-colhead--${column}`));
			const cell = rect(notes.querySelector(`.files-row__${column}`));
			expect(head.left, column).toBeCloseTo(cell.left, 0);
			expect(head.width, column).toBeCloseTo(cell.width, 0);
		}
		expect(rect(root.querySelector(".files-colhead--name")).left).toBeCloseTo(
			rect(notes.querySelector(".files-row__name")).left,
			0,
		);
	});

	it("widens a column by dragging its edge left, and narrows it dragging right", async () => {
		const root = await mountBrowserIn(600, [entry("notes.md")]);
		const notes = row(root, "notes.md");
		const edge = root.querySelector('[data-resize="size"]') as HTMLElement;
		expect(rect(notes.querySelector(".files-row__size")).width).toBe(52);
		const name = rect(notes.querySelector(".files-row__name")).width;
		pointer(edge, "pointerdown", 300);
		pointer(edge, "pointermove", 270);
		await frames();
		expect(rect(notes.querySelector(".files-row__size")).width).toBe(82);
		expect(rect(root.querySelector(".files-colhead--size")).width).toBe(82);
		// Name takes what the column gives up.
		expect(rect(notes.querySelector(".files-row__name")).width).toBe(name - 30);
		pointer(edge, "pointermove", 320);
		await frames();
		expect(rect(notes.querySelector(".files-row__size")).width).toBe(40);
		pointer(edge, "pointerup", 320);
		await frames();
		expect(edge.getAttribute("aria-valuenow")).toBe("40");
	});

	it("never lets a dragged column past 40 or 400 px", async () => {
		const root = await mountBrowserIn(900, [entry("notes.md")]);
		const edge = root.querySelector('[data-resize="owner"]') as HTMLElement;
		pointer(edge, "pointerdown", 500);
		pointer(edge, "pointermove", 0);
		await frames();
		expect(rect(row(root, "notes.md").querySelector(".files-row__owner")).width).toBe(400);
		pointer(edge, "pointermove", 2000);
		await frames();
		expect(rect(row(root, "notes.md").querySelector(".files-row__owner")).width).toBe(40);
		pointer(edge, "pointerup", 2000);
	});

	it("shows only the chosen columns, and a narrow list still drops some of them", async () => {
		useConfigStore().uiConfig = {
			onChannelDead: "readonly",
			layout: { ...DEFAULT_LAYOUT_CONFIG, filesColumns: "modified,owner" },
		};
		const root = await mountBrowserIn(600, [entry("notes.md")]);
		const notes = row(root, "notes.md");
		expect(shown(notes.querySelector(".files-row__size"))).toBe(false);
		expect(shown(notes.querySelector(".files-row__modified"))).toBe(true);
		expect(shown(notes.querySelector(".files-row__mode"))).toBe(false);
		expect(shown(notes.querySelector(".files-row__owner"))).toBe(true);
		// A column not chosen says itself on hover, as one the width drops does.
		expect(notes.getAttribute("title")).toBe("Permissions -rw-r--r--\nGroup g");
		root.style.width = "479px";
		await frames();
		expect(shown(notes.querySelector(".files-row__owner"))).toBe(false);
		expect(shown(notes.querySelector(".files-row__modified"))).toBe(true);
		expect(notes.getAttribute("title")).toBe("Permissions -rw-r--r--\nOwner o\nGroup g");
	});

	it("keeps Name at 96 px by dropping the columns dragged too wide, the owner first", async () => {
		useConfigStore().uiConfig = {
			onChannelDead: "readonly",
			layout: { ...DEFAULT_LAYOUT_CONFIG, filesOwnerWidth: 300, filesModeWidth: 100 },
		};
		const root = await mountBrowserIn(500, [entry("notes.md")]);
		const notes = row(root, "notes.md");
		expect(shown(notes.querySelector(".files-row__owner"))).toBe(false);
		expect(shown(notes.querySelector(".files-row__mode"))).toBe(true);
		expect(rect(notes.querySelector(".files-row__name")).width).toBeGreaterThanOrEqual(96);
	});

	it("sorts a long list from its headers without losing the rows' place", async () => {
		const root = await mountBrowserIn(600, [
			entry("a-small", { size: 1 }),
			entry("b-big", { size: 999 }),
			...fillers,
		]);
		(root.querySelector('[data-sort="size"]') as HTMLButtonElement).click();
		await frames();
		(root.querySelector('[data-sort="size"]') as HTMLButtonElement).click();
		await frames();
		const list = root.querySelector(".files-list") as HTMLElement;
		expect(list.scrollTop).toBe(0);
		const first = [...root.querySelectorAll(".files-row")]
			.sort((a, b) => rect(a).top - rect(b).top)
			.map((el) => el.querySelector(".files-row__name")?.textContent);
		expect(first[0]).toBe("b-big");
	});
});
