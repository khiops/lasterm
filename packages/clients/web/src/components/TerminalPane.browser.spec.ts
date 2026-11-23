/**
 * TerminalPane drawn by a browser (#936): what happy-dom does not compute, a
 * pointer over a button and a click reaching whatever lies under the point it
 * lands on. The pane is mounted whole, as TerminalPane.fixture.ts sets it up,
 * with base.css and a bundled theme, in a box of a real size.
 */
import { BUNDLED_THEMES } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { ref } from "vue";
import "../styles/base.css";
import { useChannelsStore } from "../stores/channels.js";
import { useHostsStore } from "../stores/hosts.js";
import { useRecordingsStore } from "../stores/recordings.js";
import { contrastRatio, TEXT_CONTRAST_AA, useThemeStore } from "../stores/theme.js";
import {
	attaches,
	button,
	freshWindow,
	HOST,
	hear,
	host,
	lastOutput,
	mount,
	mountPane,
	refuse,
	root,
	settle,
	spawnRefused,
	spawns,
	T,
} from "./TerminalPane.fixture.js";

// The theme sets its tokens on the document, whichever window's stores do it.
// The pointer rests at the page's centre, wherever an earlier test left it,
// such as on a button this one reads before hovering it (#948).
beforeEach(async () => {
	setActivePinia(createPinia());
	useThemeStore().applyTheme(BUNDLED_THEMES["one-half-dark"]!);
	await userEvent.unhover(document.body);
});

/** The pane's box: a pane's size, inside the page the browser shows. */
function sized(): void {
	root.style.width = "400px";
	root.style.height = "500px";
}

/** What a click at (x, y) lands on: a point off the page lands on nothing, which fails. */
function clickAt(x: number, y: number): Element {
	const hit = document.elementFromPoint(x, y);
	if (hit === null) throw new Error(`a click at ${x},${y} lands on nothing: off the page`);
	return hit;
}

/** What a click at the middle of `el` lands on. */
function clickAtMiddleOf(el: Element): Element {
	const box = el.getBoundingClientRect();
	return clickAt(box.left + box.width / 2, box.top + box.height / 2);
}

/** What a click near the bottom-left corner of the pane lands on: well away from any card. */
function clickNearCorner(): Element {
	const box = root.querySelector(".terminal-pane")!.getBoundingClientRect();
	return clickAt(box.left + 12, box.bottom - 12);
}

/** The one element `selector` names in the pane. */
function one(selector: string): Element {
	const found = root.querySelector(selector);
	if (found === null) throw new Error(`no ${selector} in the pane`);
	return found;
}

const card = () => root.querySelector(".exit-card");

/** A pane over T, which has ended. */
async function openEnded(): Promise<void> {
	mountPane(ref(T), "dead", { setUp: () => useHostsStore().hosts.push(host(HOST, "pi")) });
	sized();
	await vi.waitFor(() => expect(attaches()).toHaveLength(1));
	refuse(T, lastOutput());
	await vi.waitFor(() => expect(card()).not.toBeNull());
}

describe("TerminalPane failure, drawn", () => {
	// The error's own ground and buttons, above the terminal's opaque ground,
	// which once hid every message a pane had to give; and its buttons take the
	// click the overlay around them lets through.
	it("paints a failure above the terminal, and takes clicks on its buttons", async () => {
		freshWindow();
		useChannelsStore().registerPendingSpawn("pending-1", HOST);
		mount({ channel: ref<string | null>("pending-1") });
		sized();
		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
		spawnRefused("SPAWN_FAILED", "the shell could not start");
		await vi.waitFor(() => expect(button("Retry")).toBeDefined());

		const message = root.querySelector(".terminal-error__box span")!;
		expect(clickAtMiddleOf(message).closest(".terminal-error__box")).toBe(
			one(".terminal-error__box"),
		);
		expect(clickAtMiddleOf(button("Retry")!)).toBe(button("Retry"));
		expect(clickAtMiddleOf(button("Close")!)).toBe(button("Close"));
	});
});

describe("TerminalPane exit card, drawn (#927)", () => {
	// What the terminal last printed can be scrolled and selected around the
	// card: the overlay lets the pointer through everywhere but on the card.
	it("lets the pointer through to an ended terminal's output around its card", async () => {
		await openEnded();

		expect(clickNearCorner().closest(".terminal-container")).toBe(one(".terminal-container"));
		expect(clickAtMiddleOf(one(".exit-card")).closest(".exit-card")).toBe(one(".exit-card"));
		expect(clickAtMiddleOf(button("Restart")!)).toBe(button("Restart"));
	});

	// Over a terminal the hub has no record of, the screen is not that
	// terminal's: the scrim keeps the pointer.
	it("keeps the pointer on the gone card's scrim around it", async () => {
		mountPane(ref(T), "live");
		sized();
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		hear({ type: "ERROR", code: "CHANNEL_NOT_FOUND", message: "No such terminal.", channelId: T });
		await vi.waitFor(() => expect(card()).not.toBeNull());

		expect(clickNearCorner().closest(".exit-overlay")).toBe(one(".exit-overlay"));
		expect(clickAtMiddleOf(button("Close")!)).toBe(button("Close"));
	});

	// The quiet line in place of the card (#595) has nothing to click; its
	// Cancel, while it waits for its host (#605), takes the click.
	it("lets the pointer through the quiet line, and onto its Cancel", async () => {
		await openEnded();
		button("Restart")?.click();
		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
		spawnRefused("HOST_UNREACHABLE", "pi cannot be reached", {
			hostId: HOST,
			hostStatus: "disconnected",
		});
		await vi.waitFor(() => expect(button("Cancel")).toBeDefined());

		const line = root.querySelector(".exit-status__text")!;
		expect(line.textContent).toBe("Waiting for pi…");
		expect(clickAtMiddleOf(line).closest(".terminal-container")).toBe(one(".terminal-container"));
		expect(clickAtMiddleOf(button("Cancel")!)).toBe(button("Cancel"));
	});
});

/** What a pointer resting on a button would change in how it reads. */
function reading(el: Element): Record<string, string> {
	const style = getComputedStyle(el);
	return { color: style.color, background: style.backgroundColor, opacity: style.opacity };
}

// A hover that tinted a button's ground would take its text below the
// contrast TerminalPane.spec.ts checks the card for.
describe("TerminalPane buttons under the pointer", () => {
	it("keeps the card's buttons at their colours", async () => {
		await openEnded();
		const strong = getComputedStyle(card()!).color;

		for (const label of ["Restart", "Close"]) {
			const el = button(label)!;
			expect(el.matches(":hover"), label).toBe(false);
			const before = reading(el);
			await userEvent.hover(el);

			expect(el.matches(":hover"), label).toBe(true);
			// What hover does draw, once its transition is over: its edge, in the
			// card's text colour.
			await vi.waitFor(() => expect(getComputedStyle(el).borderTopColor, label).toBe(strong));
			expect(reading(el), label).toEqual(before);
		}
	});

	it("keeps the quiet line's Cancel at its colours", async () => {
		await openEnded();
		button("Restart")?.click();
		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
		spawnRefused("HOST_UNREACHABLE", "pi cannot be reached", {
			hostId: HOST,
			hostStatus: "disconnected",
		});
		await vi.waitFor(() => expect(button("Cancel")).toBeDefined());
		await settle();
		const cancel = button("Cancel")!;
		expect(cancel.matches(":hover")).toBe(false);
		const before = reading(cancel);
		const strong = getComputedStyle(root.querySelector(".exit-status__text")!).color;

		await userEvent.hover(cancel);

		expect(cancel.matches(":hover")).toBe(true);
		await vi.waitFor(() => expect(getComputedStyle(cancel).borderTopColor).toBe(strong));
		expect(reading(cancel)).toEqual(before);
	});
});

/** A computed colour's channels and alpha. */
function rgba(css: string): [number, number, number, number] {
	const m = /^rgba?\(([\d.]+), ([\d.]+), ([\d.]+)(?:, ([\d.]+))?\)$/.exec(css);
	if (m === null) throw new Error(`cannot read the colour ${css}`);
	return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 1)];
}

/** What `el` is drawn on: its own background over each ancestor's, down to the first opaque one. */
function groundOf(el: Element): [number, number, number] {
	const layers: Array<[number, number, number, number]> = [];
	for (let at: Element | null = el; at !== null; at = at.parentElement) {
		const layer = rgba(getComputedStyle(at).backgroundColor);
		if (layer[3] > 0) layers.push(layer);
		if (layer[3] === 1) break;
	}
	const base = layers.pop();
	if (base === undefined || base[3] !== 1) throw new Error("no opaque ground under the element");
	let ground: [number, number, number] = [base[0], base[1], base[2]];
	for (const [r, g, b, a] of layers.reverse()) {
		ground = [
			r * a + ground[0] * (1 - a),
			g * a + ground[1] * (1 - a),
			b * a + ground[2] * (1 - a),
		];
	}
	return ground;
}

describe("TerminalPane REC mark, drawn (#80)", () => {
	for (const [name, theme] of Object.entries(BUNDLED_THEMES)) {
		// Mutation caught: the theme's red on a darkened ground (2.2:1 in one-half-light).
		it(`reads the REC mark in ${name}`, async () => {
			useThemeStore().applyTheme(theme);
			mountPane(ref(T), "live");
			sized();
			await vi.waitFor(() => expect(attaches()).toHaveLength(1));
			const recordings = useRecordingsStore();
			vi.spyOn(recordings, "refresh").mockResolvedValue();
			recordings.onState({
				type: "RECORDING_STATE",
				channelId: T,
				recordingId: "01K80REC000000000000000000",
				title: "build",
			});
			await settle();
			const mark = one(".pane-rec");
			const color = rgba(getComputedStyle(mark).color);
			expect(color[3], "the REC text is see-through").toBe(1);
			const ratio = contrastRatio([color[0], color[1], color[2]], groundOf(mark));
			expect(ratio, `REC: ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(TEXT_CONTRAST_AA);
		});
	}
});
