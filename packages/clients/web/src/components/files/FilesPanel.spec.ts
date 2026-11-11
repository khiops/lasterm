/**
 * The files panel (#836): a landmark named for its host, its Files part in that host's colours
 * and its Transfers part the window's, neutral; a retarget to another host that shows and is
 * said once; the pin; the split between the parts; its forms; and its cards on an opaque ground,
 * whatever the panel's own opacity. Their contrast in every bundled theme is checked in a browser
 * (FilesPanel.browser.spec.ts), which computes the colour-mix() text levels happy-dom does not.
 */
import { BUNDLED_THEMES, DEFAULT_PROFILE, type Host } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick, reactive } from "vue";
import "../../styles/base.css";

const mocks = vi.hoisted(() => ({
	listHostFiles: vi.fn(),
	hubFetch: vi.fn(),
}));

vi.mock("../../utils/host-files.js", () => ({
	listHostFiles: mocks.listHostFiles,
	createHostFolder: vi.fn(),
	HUB_UNREACHABLE: "HUB_UNREACHABLE",
}));
vi.mock("../../utils/hub-fetch.js", () => ({ hubFetch: mocks.hubFetch }));

import type { PaneBox } from "../../composables/usePaneBox.js";
import { useChannelsStore } from "../../stores/channels.js";
import { useConfigStore } from "../../stores/config.js";
import { useFilesPanelStore } from "../../stores/files-panel.js";
import { useHostsStore } from "../../stores/hosts.js";
import { useThemeStore } from "../../stores/theme.js";
import type { FilesPanelForm } from "../../utils/files-panel.js";
import FilesPanel from "./FilesPanel.vue";

const RPI = "01ARZ3NDEKTSV4RRFFQ69G5FR1";
const AD = "01ARZ3NDEKTSV4RRFFQ69G5FA1";
const ON_RPI = "01ARZ3NDEKTSV4RRFFQ69G5FC1";
const ON_AD = "01ARZ3NDEKTSV4RRFFQ69G5FC2";

/** The caution preset: a banner, a subtle border and a tint. */
const CAUTION = {
	visualProfile: {
		preset: "caution",
		banner: { enabled: true, text: "STAGING - {host}", bgColor: "#e5c07b", textColor: "#1e1e1e" },
		border: { style: "subtle", color: "#e5c07b" },
		tint: { enabled: true, color: "#e5c07b", opacity: 3 },
	},
};

function host(id: string, label: string, profile?: unknown): Host {
	return {
		id,
		type: "ssh",
		label,
		iconType: "auto",
		color: "#fab387",
		trustRemoteHints: "ignore",
		sortOrder: 0,
		os: "linux",
		arch: null,
		...(profile !== undefined ? { profileJson: JSON.stringify(profile) } : {}),
	} as Host;
}

let app: App | null = null;
let root: HTMLElement;
let closed: number;
let shown: number;
const props = reactive<{
	form: FilesPanelForm;
	side: "left" | "right";
	width: number;
	attachedOnScreen: boolean;
	over: PaneBox | null;
}>({
	form: "docked",
	side: "right",
	width: 300,
	attachedOnScreen: true,
	over: null,
});

async function settle(): Promise<void> {
	for (let i = 0; i < 6; i++) {
		await Promise.resolve();
		await nextTick();
	}
}

async function mountPanel(): Promise<void> {
	root = document.createElement("div");
	document.body.appendChild(root);
	app = createApp({
		render: () =>
			h(FilesPanel, {
				...props,
				onClose: () => closed++,
				onShowTerminal: () => shown++,
			}),
	});
	app.mount(root);
	await settle();
}

const aside = (): HTMLElement => root.querySelector("aside") as HTMLElement;
const filesPart = (): HTMLElement => root.querySelector('[data-files-part="files"]') as HTMLElement;
const transfersPart = (): HTMLElement =>
	root.querySelector('[data-files-part="transfers"]') as HTMLElement;
const separator = (): HTMLElement | null => root.querySelector('[role="separator"]');

beforeEach(() => {
	localStorage.clear();
	setActivePinia(createPinia());
	Object.assign(props, {
		form: "docked",
		side: "right",
		width: 300,
		attachedOnScreen: true,
		over: null,
	});
	closed = 0;
	shown = 0;
	mocks.listHostFiles.mockReset();
	mocks.listHostFiles.mockResolvedValue({
		ok: true,
		value: {
			path: "/home/pi",
			entries: [{ name: "src", kind: "directory", size: null, mtime: null }],
			truncated: 0,
			start: "home",
		},
	});
	mocks.hubFetch.mockReset();
	mocks.hubFetch.mockResolvedValue(new Response("{}", { status: 503 }));
	useConfigStore().uiConfig = { onChannelDead: "readonly", experimental: { fileTransfer: true } };
	useHostsStore().hosts = [host(RPI, "raspberrypi", CAUTION), host(AD, "AD")];
	const channels = useChannelsStore();
	channels.registerChannelHost(ON_RPI, RPI);
	channels.registerChannelHost(ON_AD, AD);
	const panel = useFilesPanelStore();
	panel.setChannelsInTabs(new Set([ON_RPI, ON_AD]));
	panel.setFocused(ON_RPI);
	panel.openFor(null);
});

afterEach(() => {
	app?.unmount();
	app = null;
	root?.remove();
	vi.useRealTimers();
	document.documentElement.removeAttribute("style");
	device().prefersReducedMotion = "no-preference";
});

/** What happy-dom's window says of the device: whether its user asks for reduced motion. */
function device(): { prefersReducedMotion: string } {
	return (
		window as unknown as { happyDOM: { settings: { device: { prefersReducedMotion: string } } } }
	).happyDOM.settings.device;
}

describe("the panel's two parts", () => {
	it("is a landmark named for its host, an F6 zone, with a Files and a Transfers region", async () => {
		await mountPanel();
		expect(aside().id).toBe("files-panel");
		expect(aside().getAttribute("aria-label")).toBe("Files on raspberrypi");
		expect(aside().getAttribute("data-focus-zone")).toBe("files");
		expect(filesPart().getAttribute("role")).toBe("region");
		expect(filesPart().getAttribute("aria-label")).toBe("Files");
		expect(transfersPart().getAttribute("aria-label")).toBe("Transfers, all hosts");
	});

	it("wears the host's badge, name, banner, border and tint on Files, and none of it on Transfers", async () => {
		await mountPanel();
		expect(filesPart().querySelector(".files-header__host")?.textContent).toBe("raspberrypi");
		expect(filesPart().querySelector(".host-badge")).not.toBeNull();
		expect(filesPart().querySelector(".environment-banner")?.textContent?.trim()).toBe(
			"STAGING - raspberrypi",
		);
		expect(filesPart().style.borderLeft).toContain("2px solid");
		expect(filesPart().querySelector<HTMLElement>(".files-tint")?.style.backgroundColor).toMatch(
			/^rgba\(229, 192, 123, 0\.03\)$/,
		);
		// Transfers is the window's: neutral, and says so.
		expect(transfersPart().querySelector(".environment-banner")).toBeNull();
		expect(transfersPart().querySelector(".files-tint")).toBeNull();
		expect(transfersPart().getAttribute("style") ?? "").not.toContain("border");
		expect(
			transfersPart().querySelector(".transfers__toggle")?.textContent?.replace(/\s+/g, " ").trim(),
		).toBe("Transfers · all hosts · none");
		expect(transfersPart().textContent).toContain("No uploads.");
	});

	it("says there is no terminal when the focused pane is empty", async () => {
		useFilesPanelStore().setFocused(null);
		await mountPanel();
		expect(filesPart().textContent).toContain("No terminal. Select one to see its files.");
		expect(mocks.listHostFiles).not.toHaveBeenCalled();
	});
});

describe("moving the focus to a pane on another host", () => {
	it("changes the Files part's host and colours, highlights it, says it once, and leaves Transfers", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		await mountPanel();
		const transfersBefore = transfersPart().innerHTML;
		useFilesPanelStore().setFocused(ON_AD);
		await settle();
		expect(aside().getAttribute("aria-label")).toBe("Files on AD");
		expect(filesPart().querySelector(".files-header__host")?.textContent).toBe("AD");
		// AD has no banner, border nor tint.
		expect(filesPart().querySelector(".environment-banner")).toBeNull();
		expect(filesPart().style.borderLeft).toBe("");
		expect(filesPart().querySelector(".files-tint")).toBeNull();
		expect(filesPart().classList).toContain("files-part--retarget");
		expect(root.querySelector('[role="status"].files-announce')?.textContent).toBe("Files on AD");
		expect(transfersPart().innerHTML).toBe(transfersBefore);
		// The ring fades out in about 600 ms.
		vi.advanceTimersByTime(600);
		await settle();
		expect(filesPart().classList).not.toContain("files-part--retarget");
		// The panel lists the new terminal's host.
		expect(mocks.listHostFiles.mock.calls.at(-1)?.[0]).toBe(ON_AD);
	});

	it.each([
		["no-preference", true],
		["reduce", false],
	])("draws the ring as it fades, unless motion is reduced: %s", async (motion, rings) => {
		device().prefersReducedMotion = motion;
		await mountPanel();
		const header = (): Element => filesPart().querySelector(".files-header") as Element;
		expect(getComputedStyle(header()).animation).toBe("");
		useFilesPanelStore().setFocused(ON_AD);
		await settle();
		expect(filesPart().classList).toContain("files-part--retarget");
		const animation = getComputedStyle(header()).animation;
		if (rings) expect(animation).toMatch(/^files-retarget\S* 600ms ease-out$/);
		else expect(animation).toBe("none");
	});

	it("stays on the pinned terminal, and offers to show it once its tab is not shown", async () => {
		await mountPanel();
		const pin = root.querySelector<HTMLButtonElement>(
			'button[aria-label="Pin to this terminal"]',
		) as HTMLButtonElement;
		pin.click();
		await settle();
		expect(pin.getAttribute("aria-pressed")).toBe("true");
		useFilesPanelStore().setFocused(ON_AD);
		await settle();
		expect(aside().getAttribute("aria-label")).toBe("Files on raspberrypi");
		props.attachedOnScreen = false;
		await settle();
		const showTerminal = [...root.querySelectorAll<HTMLButtonElement>(".files-header button")].find(
			(b) => b.textContent?.trim() === "Show terminal",
		);
		showTerminal?.click();
		expect(shown).toBe(1);
	});

	it("closes on its close button", async () => {
		await mountPanel();
		root.querySelector<HTMLButtonElement>('button[aria-label="Close the files panel"]')?.click();
		expect(closed).toBe(1);
	});
});

describe("the split between Files and Transfers", () => {
	it("moves with the arrows when focused, never past 70 %, and comes back on a double click", async () => {
		await mountPanel();
		const split = separator() as HTMLElement;
		expect(split.getAttribute("aria-orientation")).toBe("horizontal");
		expect(split.tabIndex).toBe(0);
		expect(split.getAttribute("aria-valuenow")).toBe("30");
		split.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
		await settle();
		expect(split.getAttribute("aria-valuenow")).toBe("35");
		split.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
		await settle();
		expect(split.getAttribute("aria-valuenow")).toBe("70");
		split.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
		await settle();
		expect(split.getAttribute("aria-valuenow")).toBe("70");
		expect(transfersPart().style.flexBasis).toBe("70%");
		split.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
		await settle();
		expect(split.getAttribute("aria-valuenow")).toBe("30");
	});

	it("folds Transfers to its counting header, without the split, and remembers it", async () => {
		await mountPanel();
		const toggle = transfersPart().querySelector<HTMLButtonElement>(
			".transfers__toggle",
		) as HTMLButtonElement;
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		toggle.click();
		await settle();
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(separator()).toBeNull();
		expect(transfersPart().querySelector(".transfers__body")).toBeNull();
		expect(useFilesPanelStore().transfersCollapsed).toBe(true);
	});
});

describe("the panel's forms", () => {
	it.each([
		["docked", "300px"],
		["overlay", "300px"],
		["sheet", ""],
	] as const)("is drawn %s", async (form, width) => {
		props.form = form;
		await mountPanel();
		expect(aside().classList).toContain(`files-panel--${form}`);
		expect(aside().style.width).toBe(width);
	});

	it("floats over the pane it is given, below its header, no wider than the pane", async () => {
		props.form = "overlay";
		props.over = { top: 70, left: 0, right: 500, bottom: 0, width: 260 };
		await mountPanel();
		expect(aside().style.top).toBe("70px");
		expect(aside().style.right).toBe("500px");
		expect(aside().style.bottom).toBe("0px");
		expect(aside().style.width).toBe("260px");
		props.side = "left";
		await settle();
		expect(aside().style.left).toBe("0px");
		expect(aside().style.right).toBe("");
	});
});

// ─── The writer's panel, in a reader's window (#838) ─────────────────────────

describe("the writer's panel a reader follows", () => {
	/** This window reads ON_RPI and has chosen nothing there; its writer's panel is open on it. */
	function followTheWriter(): void {
		const panel = useFilesPanelStore();
		panel.close();
		panel.takeWriterPanel(ON_RPI, true);
		panel.openFor(null);
		expect(panel.followsWriter).toBe(true);
	}

	it("says it is the writer's, and offers Dock here, which makes it the reader's own", async () => {
		followTheWriter();
		props.form = "overlay";
		await mountPanel();
		expect(aside().classList).toContain("files-panel--follows");
		expect(root.querySelector(".files-header__owner")?.textContent).toBe("Writer's panel");
		const dock = [...root.querySelectorAll<HTMLButtonElement>(".files-header button")].find(
			(b) => b.textContent?.trim() === "Dock here",
		);
		expect(dock).toBeDefined();

		dock?.click();
		await settle();

		const panel = useFilesPanelStore();
		expect([panel.followsWriter, panel.readerChoice(ON_RPI)]).toEqual([false, "open"]);
		expect(root.querySelector(".files-header__owner")).toBeNull();
		expect(root.textContent).not.toContain("Dock here");
		// It stays when the writer closes theirs.
		panel.takeWriterPanel(ON_RPI, false);
		await settle();
		expect(panel.shown).toBe(true);
	});
});

// ─── Colours ─────────────────────────────────────────────────────────────────
//
// The panel's ground is the terminal list's, at its opacity; whatever asks or warns sits on the
// exit card's opaque ground, so it reads over a wallpaper, Mica, Acrylic or a see-through window.
// Checked here in a dark and a light theme, the panel at 80 % opacity; their contrast in every
// bundled theme, in FilesPanel.browser.spec.ts.

describe("the panel's grounds and cards", () => {
	interface Drawn {
		/** The terminal list's ground at 80 %. */
		docked: string;
		/** The exit card's: the theme's background, opaque. */
		opaque: string;
		text: string;
		border: string;
		shadow: string;
	}

	const DRAWN: [string, Drawn][] = [
		[
			"one-half-dark",
			{
				docked: "rgba(33, 37, 43, 0.8)",
				opaque: "rgb(40, 44, 52)",
				text: "#dcdfe4",
				border: "#3e4452",
				shadow: "0 4px 24px rgba(0, 0, 0, 0.6)",
			},
		],
		[
			"solarized-light",
			{
				docked: "rgba(238, 232, 213, 0.8)",
				opaque: "rgb(253, 246, 227)",
				text: "#5f747b",
				border: "#d6ceb0",
				shadow: "0 4px 24px rgba(0, 0, 0, 0.15)",
			},
		],
	];

	function applyTheme(name: string): void {
		const theme = useThemeStore();
		theme.applyTheme(BUNDLED_THEMES[name]!);
		theme.applyOpacity({ terminal: 100, sidebar: 80, hostRail: 100, tabBar: 100 });
	}

	it.each(DRAWN)(
		"takes the terminal list's ground and opacity, and an opaque one when floating: %s",
		async (theme, drawn) => {
			applyTheme(theme);
			for (const [form, ground] of [
				["docked", drawn.docked],
				["overlay", drawn.opaque],
				["sheet", drawn.opaque],
			] as const) {
				props.form = form;
				await mountPanel();
				expect(getComputedStyle(aside()).backgroundColor, form).toBe(ground);
				app?.unmount();
				root.remove();
			}
		},
	);

	it.each(DRAWN)(
		"draws its cards on the exit card's opaque ground, under a shadow: %s",
		async (theme, drawn) => {
			applyTheme(theme);
			await mountWithCards();
			const cards = [...root.querySelectorAll(".files-card")];
			// The listing's failure, and the question an option's change asks.
			expect(cards.map((card) => card.getAttribute("role"))).toEqual(["alert", "group"]);
			for (const card of cards) {
				const style = getComputedStyle(card);
				expect(style.backgroundColor).toBe(drawn.opaque);
				expect(style.color).toBe(drawn.text);
				expect([style.borderTopWidth, style.borderTopStyle, style.borderTopColor]).toEqual([
					"1px",
					"solid",
					drawn.border,
				]);
				expect(style.boxShadow).toBe(drawn.shadow);
			}
		},
	);
});

/**
 * The panel with both its cards up: the listing failed with the host not connected, and a change
 * to "Follow the terminal's directory", which this terminal also sets, asks its scope.
 */
async function mountWithCards(): Promise<void> {
	mocks.listHostFiles.mockResolvedValue({ ok: false, code: "HOST_NOT_CONNECTED", message: "x" });
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
	useFilesPanelStore().setOptionsExpanded(true);
	await mountPanel();
	// A response's body is read in a later task.
	for (let i = 0; i < 8; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await nextTick();
	}
	const follow = [...root.querySelectorAll<HTMLElement>(".files-option")]
		.find((row) => row.textContent?.includes("Follow the terminal's directory"))
		?.querySelector<HTMLInputElement>('input[role="switch"]');
	if (follow === undefined || follow === null) throw new Error("no Follow switch");
	follow.checked = !follow.checked;
	follow.dispatchEvent(new Event("change"));
	await settle();
}
