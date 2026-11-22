// The asciicast player (#80): what it builds, when, and what it shows.
// New file: the player had no spec of its own.
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick } from "vue";

const built = vi.hoisted(() => ({ count: 0 }));

vi.mock("@xterm/xterm", () => ({
	Terminal: class {
		element = document.createElement("div");
		unicode = { activeVersion: "6" };
		constructor() {
			built.count++;
		}
		loadAddon(): void {}
		open(): void {}
		write(_data: string, done?: () => void): void {
			done?.();
		}
		resize(): void {}
		dispose(): void {}
	},
}));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));

import CastPlayer from "./CastPlayer.vue";

let app: App | null = null;

const HEADER = '{"version":3,"term":{"cols":80,"rows":24}}';

function mount(chunks: () => AsyncIterable<string>): void {
	const pinia = createPinia();
	setActivePinia(pinia);
	const root = document.createElement("div");
	document.body.appendChild(root);
	app = createApp({ render: () => h(CastPlayer, { chunks, title: "build" }) });
	app.use(pinia);
	app.mount(root);
}

async function* parts(...texts: string[]): AsyncGenerator<string> {
	for (const text of texts) yield text;
}

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await Promise.resolve();
		await nextTick();
	}
}

const playButton = () => document.querySelector<HTMLButtonElement>(".player__btn");
const clockText = () => document.querySelector(".player__time")?.textContent?.trim();

describe("CastPlayer", () => {
	beforeEach(() => {
		built.count = 0;
	});

	afterEach(() => {
		app?.unmount();
		app = null;
		document.body.replaceChildren();
		vi.useRealTimers();
	});

	// AC-PLAYER-PARSE / dimensions. Mutation caught: a terminal built from the
	// header before the whole cast is read.
	it.each([
		[
			"a header over 500 columns",
			['{"version":3,"term":{"cols":501,"rows":24}}\n', '[0, "o", "A"]\n'],
		],
		[
			"a size change over 500 rows, in a later part",
			[`${HEADER}\n[0, "o", "A"]\n`, '[0, "r", "80x501"]\n'],
		],
	])("builds no terminal for %s, and says the file is not a cast", async (_label, texts) => {
		mount(() => parts(...texts));
		await settle();
		expect(built.count).toBe(0);
		expect(document.querySelector(".player__error")?.textContent).toBe(
			"Not an asciicast v2 or v3 file",
		);
	});

	it("builds the terminal once a valid cast is read", async () => {
		mount(() => parts(`${HEADER}\n`, '[0, "o", "A"]\n'));
		await settle();
		expect(built.count).toBe(1);
		expect(document.querySelector(".player__error")).toBeNull();
	});

	// Mutation caught: Pause shown for a cast with no event, which ended at once.
	it("shows Play for a recording with no event", async () => {
		mount(() => parts(`${HEADER}\n`));
		await settle();
		expect(playButton()?.getAttribute("aria-label")).toBe("Play");
	});

	// Mutation caught: the clock moving only at events.
	it("moves the clock between events, and keeps it at a pause", async () => {
		vi.useFakeTimers({
			toFake: [
				"setTimeout",
				"clearTimeout",
				"requestAnimationFrame",
				"cancelAnimationFrame",
				"performance",
			],
		});
		mount(() => parts(`${HEADER}\n`, '[0, "o", "A"]\n[1.9, "o", "B"]\n'));
		await settle();
		// 1.1 s into a 1.9 s wait: no event has come since 0 s.
		await vi.advanceTimersByTimeAsync(1100);
		await settle();
		expect(clockText()).toBe("0:01 / 0:01");
		playButton()?.click(); // Pause
		await settle();
		const paused = Number(document.querySelector<HTMLInputElement>(".player__seek")?.value);
		expect(paused).toBeGreaterThanOrEqual(1.1);
		await vi.advanceTimersByTimeAsync(500);
		await settle();
		expect(Number(document.querySelector<HTMLInputElement>(".player__seek")?.value)).toBe(paused);
	});

	// Mutation caught: a player closed during its load going on to build and fetch.
	it("stops reading and builds nothing once closed during its load", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let pulled = 0;
		async function* slow(): AsyncGenerator<string> {
			pulled++;
			yield `${HEADER}\n`;
			await gate;
			pulled++;
			yield '[0, "o", "A"]\n';
			pulled++;
			yield '[0, "o", "B"]\n';
		}
		mount(slow);
		await settle();
		app?.unmount();
		app = null;
		release();
		await settle();
		expect(built.count).toBe(0);
		expect(pulled).toBe(2);
	});
});
