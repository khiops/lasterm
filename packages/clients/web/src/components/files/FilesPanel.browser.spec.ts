/**
 * The files panel's cards in every bundled theme (#836, #936): whatever asks or warns reads at
 * 4.5:1 or better on its ground, as the exit card does. happy-dom computes no colour-mix(), which
 * the theme's text levels are made of, so this runs in a browser: the panel mounted with its own
 * rules and base.css, its listing failed and an option's change asking its scope.
 */
import { BUNDLED_THEMES, DEFAULT_PROFILE, type Host } from "@lasterm/shared";
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
