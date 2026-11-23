// The asciicast player (#80): what it builds, when, and what it shows.
// New file: the player had no spec of its own.
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick } from "vue";

/**
 * What the player's terminals were asked: every write and resize, in order.
 * With `defer`, a write's callback waits until the test calls `release`, as
 * xterm's does until it has parsed the data.
 */
const built = vi.hoisted(() => ({
	count: 0,
	calls: [] as string[],
	defer: false,
	pending: [] as Array<() => void>,
}));

vi.mock("@xterm/xterm", () => ({
	Terminal: class {
		element = document.createElement("div");
		unicode = { activeVersion: "6" };
		constructor() {
			built.count++;
			built.calls.push("new");
		}
		loadAddon(): void {}
		open(): void {}
		write(data: string, done?: () => void): void {
			built.calls.push(`write:${data}`);
			if (built.defer) built.pending.push(() => done?.());
			else done?.();
		}
		resize(cols: number, rows: number): void {
			built.calls.push(`resize:${cols}x${rows}`);
		}
		dispose(): void {}
	},
}));

function release(): void {
	const all = built.pending;
	built.pending = [];
	for (const done of all) done();
}
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
		built.calls = [];
		built.defer = false;
		built.pending = [];
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

	// Mutation caught: the playback started at its defaults, past what the
	// controls were set to while the cast loaded.
	it("plays with the speed and Skip idle chosen while the cast loaded", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		async function* slow(): AsyncGenerator<string> {
			yield `${HEADER}\n`;
			await gate;
			yield '[0, "o", "A"]\n[10, "o", "B"]\n';
		}
		mount(slow);
		await settle();
		const skip = document.querySelector<HTMLInputElement>('.player__field input[type="checkbox"]');
		if (skip) {
			skip.checked = false;
			skip.dispatchEvent(new Event("change"));
		}
		release();
		await settle();
		// Skip idle off: the 10 s pause counts whole.
		expect(clockText()).toBe("0:00 / 0:10");
	});

	// The controls drive the playback the engine's own tests cover.
	// Mutation caught: the seek bar not seeking (AC-PLAYER-SEEK, -SEEK-IDLE).
	it("seeks from the Position bar: a fresh screen, the output and size up to it", async () => {
		mount(() => parts(`${HEADER}\n`, '[0, "o", "hello"]\n[0.5, "r", "100x30"]\n[1, "o", "bye"]\n'));
		await settle();
		const seek = document.querySelector<HTMLInputElement>(".player__seek");
		if (seek) {
			seek.value = "0.6";
			seek.dispatchEvent(new Event("input"));
		}
		await settle();
		const after = built.calls.slice(built.calls.lastIndexOf("new"));
		expect(after).toEqual(["new", "write:hello", "resize:100x30"]);
	});

	// Mutation caught: the Speed select not reaching the playback.
	it("plays at the speed chosen in the Speed list", async () => {
		vi.useFakeTimers({
			toFake: [
				"setTimeout",
				"clearTimeout",
				"requestAnimationFrame",
				"cancelAnimationFrame",
				"performance",
			],
		});
		mount(() => parts(`${HEADER}\n`, '[0, "o", "A"]\n[1, "o", "B"]\n'));
		await settle();
		const speed = document.querySelector<HTMLSelectElement>(
			'.player__field select[aria-label="Speed"]',
		);
		if (speed) {
			speed.value = "2";
			speed.dispatchEvent(new Event("change"));
		}
		await vi.advanceTimersByTimeAsync(490);
		expect(built.calls).not.toContain("write:B");
		await vi.advanceTimersByTimeAsync(20);
		expect(built.calls).toContain("write:B");
	});

	// Mutation caught: Skip idle off by default.
	it("counts a long pause as 2 s by default", async () => {
		mount(() => parts(`${HEADER}\n`, '[0, "o", "A"]\n[10, "o", "B"]\n'));
		await settle();
		expect(clockText()).toBe("0:00 / 0:02");
	});

	// Mutation caught: the terminal adapter calling back before xterm parsed the write.
	it("writes the next event only once xterm has parsed the one before", async () => {
		built.defer = true;
		mount(() => parts(`${HEADER}\n`, '[0, "o", "A"]\n[0, "o", "B"]\n'));
		await settle();
		expect(built.calls.filter((c) => c.startsWith("write:"))).toEqual(["write:A"]);
		release();
		await settle();
		expect(built.calls.filter((c) => c.startsWith("write:"))).toEqual(["write:A", "write:B"]);
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
