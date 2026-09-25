import type { PanesConfig } from "@lasterm/shared";
import { describe, expect, it, vi } from "vitest";
import {
	AUTO_RESTART_MIN_RUN_MS,
	createEndWatch,
	type EndedPrefs,
	type EndFacts,
	endedPrefs,
	endedToDelete,
	heldBackMessage,
	LEGACY_DEAD_TAB_KEY,
	migrateLegacyDeadTabChoice,
	overlayChoice,
	reactToEnd,
} from "./exit-action.js";

const ask: EndedPrefs = { whenEnded: "ask", keepEnded: false };
const restart: EndedPrefs = { whenEnded: "restart", keepEnded: false };
const closeAndDelete: EndedPrefs = { whenEnded: "close", keepEnded: false };
const closeAndKeep: EndedPrefs = { whenEnded: "close", keepEnded: true };

/** A shell that ran a minute under this pane's eyes, in the window holding it. */
const liveEnd: EndFacts = {
	seen: "live",
	watchedMs: 60_000,
	fromStart: true,
	directProcess: false,
	writer: true,
};

describe("endedPrefs", () => {
	it("asks, and deletes on close, when nothing is set", () => {
		expect(endedPrefs(undefined)).toEqual({ whenEnded: "ask", keepEnded: false });
		expect(endedPrefs({ maxPanes: 4 })).toEqual({ whenEnded: "ask", keepEnded: false });
	});

	it("reads what Settings wrote", () => {
		expect(endedPrefs({ whenEnded: "restart", keepEnded: true })).toEqual({
			whenEnded: "restart",
			keepEnded: true,
		});
		expect(endedPrefs({ whenEnded: "close" }).whenEnded).toBe("close");
	});

	it("asks when the value is not one it knows", () => {
		expect(endedPrefs({ whenEnded: "delete" } as unknown as PanesConfig).whenEnded).toBe("ask");
	});
});

// ─── The setting's effect ────────────────────────────────────────────────────

describe("reactToEnd: what the setting does with an end seen live", () => {
	it("Ask shows the overlay", () => {
		expect(reactToEnd(ask, liveEnd)).toEqual({ kind: "overlay" });
	});

	it("Restart restarts a terminal that ran 5 seconds or more", () => {
		expect(reactToEnd(restart, liveEnd)).toEqual({ kind: "restart" });
		expect(reactToEnd(restart, { ...liveEnd, watchedMs: AUTO_RESTART_MIN_RUN_MS })).toEqual({
			kind: "restart",
		});
		expect(AUTO_RESTART_MIN_RUN_MS).toBe(5_000);
	});

	// A shell that fails at launch would otherwise be restarted for ever.
	it("Restart does not restart one that ended within 5 seconds of starting, and says why", () => {
		expect(reactToEnd(restart, { ...liveEnd, watchedMs: AUTO_RESTART_MIN_RUN_MS - 1 })).toEqual({
			kind: "overlay",
			heldBack: "just-started",
		});
		expect(reactToEnd(restart, { ...liveEnd, watchedMs: 0 })).toEqual({
			kind: "overlay",
			heldBack: "just-started",
		});
		expect(heldBackMessage("just-started")).toBe(
			"It ended right after starting, so it wasn't restarted automatically.",
		);
	});

	// Its start was not seen: the pane only vouches for what it watched.
	it("Restart does not restart one this pane reached less than 5 seconds before it ended", () => {
		expect(reactToEnd(restart, { ...liveEnd, fromStart: false, watchedMs: 1_000 })).toEqual({
			kind: "overlay",
			heldBack: "just-attached",
		});
		expect(reactToEnd(restart, { ...liveEnd, fromStart: false })).toEqual({ kind: "restart" });
	});

	// A command that finishes would run again every time it did.
	it("Restart leaves a terminal that runs a command to the overlay", () => {
		expect(reactToEnd(restart, { ...liveEnd, directProcess: true })).toEqual({
			kind: "overlay",
			heldBack: "runs-a-command",
		});
	});

	// Every window over it would restart it, and the restarts race at the hub.
	it("Restart is left to the window holding the write lock", () => {
		expect(reactToEnd(restart, { ...liveEnd, writer: false })).toEqual({
			kind: "overlay",
			heldBack: "not-writer",
		});
	});

	it("Close closes, deleting it or keeping it as the keep setting says", () => {
		expect(reactToEnd(closeAndDelete, liveEnd)).toEqual({ kind: "close", keep: false });
		expect(reactToEnd(closeAndKeep, liveEnd)).toEqual({ kind: "close", keep: true });
		// A command's pane closes too: only restarting it again is refused.
		expect(reactToEnd(closeAndKeep, { ...liveEnd, directProcess: true, writer: false })).toEqual({
			kind: "close",
			keep: true,
		});
	});

	it("says why for every restart it holds back", () => {
		for (const reason of [
			"just-started",
			"just-attached",
			"runs-a-command",
			"not-writer",
		] as const) {
			expect(heldBackMessage(reason)).toMatch(/\S/);
		}
	});
});

// ─── Seen live, or found afterwards ──────────────────────────────────────────

describe("createEndWatch: how a pane learnt its terminal ended", () => {
	function clock() {
		let t = 1_000;
		return {
			now: () => t,
			advance: (ms: number) => {
				t += ms;
			},
		};
	}

	it("an end reported while the pane watched it run was seen live, for as long as it watched", () => {
		const c = clock();
		const watch = createEndWatch(c.now);
		watch.attached("ch");
		c.advance(6_000);
		expect(watch.ended("ch")).toEqual({ seen: "live", watchedMs: 6_000, fromStart: false });
	});

	it("counts from the start when the pane started it, or saw it start", () => {
		const c = clock();
		const watch = createEndWatch(c.now);
		watch.starting("ch");
		watch.attached("ch");
		c.advance(2_000);
		expect(watch.ended("ch")).toEqual({ seen: "live", watchedMs: 2_000, fromStart: true });
	});

	it("a restart that ended before the pane reached it ended right after starting", () => {
		const watch = createEndWatch(clock().now);
		watch.starting("ch");
		expect(watch.ended("ch")).toEqual({ seen: "found", watchedMs: null, fromStart: true });
	});

	it("an end on a reload, which the pane never watched, was found", () => {
		const watch = createEndWatch(clock().now);
		expect(watch.ended("ch")).toEqual({ seen: "found", watchedMs: null, fromStart: false });
	});

	it("an end heard after the socket went was found, not seen", () => {
		const c = clock();
		const watch = createEndWatch(c.now);
		watch.attached("ch");
		c.advance(60_000);
		watch.lost();
		expect(watch.ended("ch").seen).toBe("found");
	});

	it("an end of another terminal than the one watched was found", () => {
		const watch = createEndWatch(clock().now);
		watch.attached("a");
		expect(watch.ended("b").seen).toBe("found");
	});

	it("an end is told once: a report repeating it was found", () => {
		const watch = createEndWatch(clock().now);
		watch.attached("ch");
		expect(watch.ended("ch").seen).toBe("live");
		expect(watch.ended("ch").seen).toBe("found");
	});
});

// #559: nothing restarts on its own on a reload or an attach. The setting acts
// on an end someone could have seen happen, and only on that.
describe("nothing restarts on its own on a reload or an attach", () => {
	/** An end reaching a pane set to restart, holding the lock, after a long run. */
	function react(steps: (watch: ReturnType<typeof createEndWatch>) => void) {
		let t = 0;
		const watch = createEndWatch(() => t);
		steps(watch);
		t += 10 * 60_000;
		const end = watch.ended("ch");
		return reactToEnd(restart, { ...end, directProcess: false, writer: true });
	}

	it("a terminal found ended when the page loads is shown, not restarted", () => {
		expect(react(() => {})).toEqual({ kind: "overlay" });
	});

	it("an attach refused because the terminal ended is shown, not restarted", () => {
		// The pane was watching it, the socket went, the attach after it was refused.
		expect(
			react((watch) => {
				watch.attached("ch");
				watch.lost();
			}),
		).toEqual({ kind: "overlay" });
	});

	it("an end reported live under the same conditions is restarted", () => {
		expect(react((watch) => watch.attached("ch"))).toEqual({ kind: "restart" });
	});

	it("whatever the setting, an end that was found is only shown", () => {
		const found: EndFacts = { ...liveEnd, seen: "found", watchedMs: null, fromStart: false };
		for (const prefs of [ask, restart, closeAndDelete, closeAndKeep]) {
			expect(reactToEnd(prefs, found)).toEqual({ kind: "overlay" });
		}
	});
});

// ─── The overlay ─────────────────────────────────────────────────────────────

describe("overlayChoice: the overlay's buttons", () => {
	// No second dialog: Close carries its options and acts at once.
	it("Close acts at once with the keep option beside it", () => {
		expect(overlayChoice("close", { keep: false, always: false })).toEqual({
			act: { kind: "close", keep: false },
			remember: null,
		});
		expect(overlayChoice("close", { keep: true, always: false }).act).toEqual({
			kind: "close",
			keep: true,
		});
	});

	it('"Always do this" writes Close with the keep choice as the setting', () => {
		expect(overlayChoice("close", { keep: true, always: true }).remember).toEqual({
			whenEnded: "close",
			keepEnded: true,
		});
		expect(overlayChoice("close", { keep: false, always: true }).remember).toEqual({
			whenEnded: "close",
			keepEnded: false,
		});
	});

	it('"Always do this" writes Restart as the setting, leaving keep alone', () => {
		expect(overlayChoice("restart", { keep: true, always: true })).toEqual({
			act: { kind: "restart" },
			remember: { whenEnded: "restart" },
		});
	});

	it('writes nothing without "Always do this"', () => {
		expect(overlayChoice("restart", { keep: true, always: false }).remember).toBeNull();
	});
});

// ─── Closing ended terminals ─────────────────────────────────────────────────

describe("endedToDelete: closing a pane or a tab over ended terminals", () => {
	it("deletes them unless they are kept", () => {
		expect(endedToDelete(["a", "b"], false)).toEqual(["a", "b"]);
		expect(endedToDelete(["a", "b"], true)).toEqual([]);
	});
});

// ─── The question this replaces ──────────────────────────────────────────────

describe("migrateLegacyDeadTabChoice", () => {
	function storage(entries: Record<string, string>) {
		const map = new Map(Object.entries(entries));
		return {
			map,
			get length() {
				return map.size;
			},
			key: (i: number) => [...map.keys()][i] ?? null,
			getItem: (k: string) => map.get(k) ?? null,
			removeItem: (k: string) => void map.delete(k),
		};
	}

	// "Don't ask again" meant "close and delete".
	it("carries a silenced question over as keep = false, then forgets it", async () => {
		const store = storage({ [LEGACY_DEAD_TAB_KEY]: "true", "lasterm:skipConfirmKill": "true" });
		const save = vi.fn(async () => true);
		await expect(migrateLegacyDeadTabChoice(store, ask, save)).resolves.toEqual({
			keepEnded: false,
		});
		expect(save).toHaveBeenCalledWith({ keepEnded: false });
		expect(store.map.has(LEGACY_DEAD_TAB_KEY)).toBe(false);
		// The other questions keep their answers.
		expect(store.map.get("lasterm:skipConfirmKill")).toBe("true");
	});

	it("takes the per-host answer too, and forgets every one", async () => {
		const store = storage({
			[`${LEGACY_DEAD_TAB_KEY}:host-a`]: "true",
			[`${LEGACY_DEAD_TAB_KEY}:host-b`]: "true",
		});
		const save = vi.fn(async () => true);
		await migrateLegacyDeadTabChoice(store, ask, save);
		expect(save).toHaveBeenCalledWith({ keepEnded: false });
		expect(store.map.size).toBe(0);
	});

	it("leaves a keep set since in place", async () => {
		const store = storage({ [LEGACY_DEAD_TAB_KEY]: "true" });
		const save = vi.fn(async () => true);
		await expect(
			migrateLegacyDeadTabChoice(store, { whenEnded: "ask", keepEnded: true }, save),
		).resolves.toBeNull();
		expect(save).not.toHaveBeenCalled();
		expect(store.map.size).toBe(0);
	});

	it("writes nothing when nothing was silenced", async () => {
		const save = vi.fn(async () => true);
		await expect(migrateLegacyDeadTabChoice(storage({}), ask, save)).resolves.toBeNull();
		expect(save).not.toHaveBeenCalled();
	});

	it("keeps the old answer when the write fails, to try again on the next start", async () => {
		const store = storage({ [LEGACY_DEAD_TAB_KEY]: "true" });
		await expect(migrateLegacyDeadTabChoice(store, ask, async () => false)).resolves.toBeNull();
		expect(store.map.get(LEGACY_DEAD_TAB_KEY)).toBe("true");
	});
});
