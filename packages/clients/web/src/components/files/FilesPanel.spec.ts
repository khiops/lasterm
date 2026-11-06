/**
 * The files panel (#836): a landmark named for its host, its Files part in that host's colours
 * and its Transfers part the window's, neutral; a retarget to another host that shows and is
 * said once; the pin; the split between the parts; its forms; and its cards on an opaque ground
 * in every bundled theme, whatever the panel's own opacity.
 */
import { BUNDLED_THEMES, type Host } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick, reactive } from "vue";

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

import { useChannelsStore } from "../../stores/channels.js";
import { useConfigStore } from "../../stores/config.js";
import { useFilesPanelStore } from "../../stores/files-panel.js";
import { useHostsStore } from "../../stores/hosts.js";
import { contrastRatio, hexToRgb, TEXT_CONTRAST_AA, useThemeStore } from "../../stores/theme.js";
import type { FilesPanelForm } from "../../utils/files-panel.js";
import BROWSER from "./FilesBrowser.vue?raw";
import OPTIONS from "./FilesOptions.vue?raw";
import FilesPanel from "./FilesPanel.vue";
import PANEL from "./FilesPanel.vue?raw";

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
}>({
	form: "docked",
	side: "right",
	width: 300,
	attachedOnScreen: true,
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
	Object.assign(props, { form: "docked", side: "right", width: 300, attachedOnScreen: true });
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
});

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

	it("draws no ring under reduced motion", () => {
		expect(PANEL).toMatch(
			/@media \(prefers-reduced-motion: reduce\) \{\s*\.files-part--retarget \.files-header \{\s*animation: none;/,
		);
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
});

// ─── Colours ─────────────────────────────────────────────────────────────────
//
// The panel's ground is the terminal list's, at its opacity; whatever asks or warns sits on the
// exit card's opaque ground, so it reads over a wallpaper, Mica, Acrylic or a see-through window.
// Checked in every bundled theme, light and dark, against WCAG AA for text (4.5:1), as
// TerminalPane.spec.ts checks the exit card.

describe("the panel's grounds and cards", () => {
	function styleOf(source: string): string {
		return source.slice(source.indexOf("<style")).replace(/\r\n/g, "\n");
	}

	function declarations(source: string, selector: string): Map<string, string> {
		const escaped = selector.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
		const rule = new RegExp(`\\n${escaped}\\s*\\{([^}]*)\\}`).exec(styleOf(source));
		if (!rule?.[1]) throw new Error(`no rule for ${selector}`);
		const out = new Map<string, string>();
		for (const line of rule[1].split(";")) {
			const [prop, ...value] = line.split(":");
			if (prop && value.length > 0) out.set(prop.trim(), value.join(":").trim());
		}
		return out;
	}

	function resolve(expr: string): [number, number, number] {
		const style = document.documentElement.style;
		const v = /^var\((--nt-[\w-]+)\)$/.exec(expr);
		if (v?.[1]) {
			const hex = style.getPropertyValue(v[1]).trim();
			if (!/^#[0-9a-fA-F]{6}$/.test(hex)) throw new Error(`${v[1]} is ${hex}, not a solid colour`);
			return hexToRgb(hex).split(", ").map(Number) as [number, number, number];
		}
		const triple = /^rgb\(var\((--nt-[\w-]+-rgb)\)\)$/.exec(expr);
		if (triple?.[1]) {
			return style.getPropertyValue(triple[1]).split(",").map(Number) as [number, number, number];
		}
		throw new Error(`cannot check the contrast of ${expr}`);
	}

	/** Text and ground, from the rules styling it from the card down: the last named wins. */
	function pair(source: string, rules: string[]): { text: string; ground: string } {
		const decls = rules.map((rule) => declarations(source, rule));
		const text = decls
			.map((d) => d.get("color"))
			.filter((c) => c !== undefined && c !== "inherit")
			.at(-1);
		const ground = decls
			.map((d) => d.get("background"))
			.filter((b) => b !== undefined && b !== "transparent")
			.at(-1);
		if (text === undefined || ground === undefined) throw new Error(`${rules.join(" ")}: no pair`);
		return { text, ground };
	}

	const TEXTS: [string, string, string[]][] = [
		["error card", BROWSER, [".files-card"]],
		["error card's text", BROWSER, [".files-card", ".files-card__text"]],
		["error card's button", BROWSER, [".files-card", ".files-btn"]],
		["error card's Connect", BROWSER, [".files-card", ".files-btn", ".files-btn--primary"]],
		["scope question", OPTIONS, [".files-card", ".files-scope__ask"]],
		["scope question's drops", OPTIONS, [".files-card", ".files-scope__drops"]],
		["scope choice", OPTIONS, [".files-card", ".files-btn"]],
		["scope choice, the host", OPTIONS, [".files-card", ".files-btn", ".files-btn--primary"]],
	];

	it("takes the terminal list's ground and opacity, and an opaque one when floating", () => {
		expect(declarations(PANEL, ".files-panel").get("background")).toBe(
			"rgba(var(--nt-sidebar-rgb), var(--nt-sidebar-alpha))",
		);
		expect(declarations(PANEL, ".files-panel--overlay").get("background")).toBe(
			"rgb(var(--nt-bg-rgb))",
		);
		expect(declarations(PANEL, ".files-panel--sheet").get("background")).toBe(
			"rgb(var(--nt-bg-rgb))",
		);
	});

	it("draws its cards on the exit card's opaque ground, under a shadow", () => {
		for (const source of [BROWSER, OPTIONS]) {
			const card = declarations(source, ".files-card");
			expect(card.get("background")).toBe("rgb(var(--nt-bg-rgb))");
			expect(card.get("color")).toBe("var(--nt-text-strong)");
			expect(card.get("border")).toBe("1px solid var(--nt-border)");
			expect(card.get("box-shadow")).toBe("var(--nt-shadow)");
		}
	});

	for (const [name, theme] of Object.entries(BUNDLED_THEMES)) {
		it(`reads at 4.5:1 or better on its cards in ${name}`, () => {
			setActivePinia(createPinia());
			useThemeStore().applyTheme(theme);
			for (const [what, source, rules] of TEXTS) {
				const { text, ground } = pair(source, rules);
				const ratio = contrastRatio(resolve(text), resolve(ground));
				expect(ratio, `${what} (${text} on ${ground}): ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(
					TEXT_CONTRAST_AA,
				);
			}
		});
	}
});
