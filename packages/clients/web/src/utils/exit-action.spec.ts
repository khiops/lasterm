import type { TerminalProfile } from "@lasterm/shared";
import { describe, expect, it, vi } from "vitest";
import {
	ALWAYS_SCOPES,
	AUTO_RESTART_MIN_RUN_MS,
	alwaysScopeOf,
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
		expect(endedPrefs({ maxPanes: 4 }, {})).toEqual({ whenEnded: "ask", keepEnded: false });
	});

	// "When a terminal ends" from the terminal's resolved profile, "Keep" from
	// the UI config.
	it("reads what Settings wrote, each from where it lives", () => {
		expect(endedPrefs({ keepEnded: true }, { whenEnded: "restart" })).toEqual({
			whenEnded: "restart",
			keepEnded: true,
		});
		expect(endedPrefs(undefined, { whenEnded: "close" }).whenEnded).toBe("close");
	});

	it("asks when the value is not one it knows", () => {
		expect(
			endedPrefs(undefined, { whenEnded: "delete" } as unknown as TerminalProfile).whenEnded,
		).toBe("ask");
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
			"stopped-not-restarted",
			"stopped-not-closed",
			"stopped",
		] as const) {
			expect(heldBackMessage(reason)).toMatch(/\S/);
		}
	});
});

// ─── Stopped from elsewhere (#580) ───────────────────────────────────────────

// A terminal killed from another window, or by the REST API, ended while a
// pane set to restart was watching it: the pane brought it back, with the id
// it had, and nothing on screen said it had ever gone.
describe("reactToEnd: a terminal the hub ended on purpose", () => {
	const destroyed: EndFacts = { ...liveEnd, endReason: "destroyed" };

	it("Restart leaves it ended, and says it was stopped from elsewhere", () => {
		expect(reactToEnd(restart, destroyed)).toEqual({
			kind: "overlay",
			heldBack: "stopped-not-restarted",
		});
		expect(heldBackMessage("stopped-not-restarted")).toBe(
			"It was stopped from elsewhere, so it wasn't restarted.",
		);
	});

	it("Close leaves its pane open over it, and says why", () => {
		for (const prefs of [closeAndDelete, closeAndKeep]) {
			expect(reactToEnd(prefs, destroyed)).toEqual({
				kind: "overlay",
				heldBack: "stopped-not-closed",
			});
		}
		expect(heldBackMessage("stopped-not-closed")).toBe(
			"It was stopped from elsewhere, so its pane wasn't closed.",
		);
	});

	it("Ask shows the overlay, saying it was stopped from elsewhere", () => {
		expect(reactToEnd(ask, destroyed)).toEqual({ kind: "overlay", heldBack: "stopped" });
		expect(heldBackMessage("stopped")).toBe("It was stopped from elsewhere.");
	});

	// Found or seen, however long it ran: it was meant to end.
	it("does nothing on its own whatever else is true of the end", () => {
		const ends: EndFacts[] = [
			destroyed,
			{ ...destroyed, seen: "found", watchedMs: null, fromStart: true },
			{ ...destroyed, watchedMs: 1_000 },
			{ ...destroyed, directProcess: true, writer: false },
		];
		for (const end of ends) {
			for (const prefs of [ask, restart, closeAndDelete, closeAndKeep]) {
				expect(reactToEnd(prefs, end).kind).toBe("overlay");
			}
		}
	});

	it("an end with no reason, a shell that exited, is still acted on", () => {
		expect(reactToEnd(restart, { ...liveEnd, endReason: undefined })).toEqual({ kind: "restart" });
		expect(reactToEnd(closeAndKeep, { ...liveEnd, endReason: undefined })).toEqual({
			kind: "close",
			keep: true,
		});
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
	// No second dialog: Close acts at once, and the "Keep" setting says
	// whether the terminal stays listed.
	it("Close acts at once, keeping the terminal as the setting says", () => {
		expect(overlayChoice("close", null, false)).toEqual({
			act: { kind: "close", keep: false },
			remember: null,
		});
		expect(overlayChoice("close", null, true).act).toEqual({ kind: "close", keep: true });
	});

	it("Restart restarts, whatever the keep setting", () => {
		expect(overlayChoice("restart", null, true)).toEqual({
			act: { kind: "restart" },
			remember: null,
		});
	});

	// One box, and where beside it: "this host" or "everywhere", never both.
	it('remembers nowhere until "Always do this" is checked', () => {
		expect(alwaysScopeOf(false, "host")).toBeNull();
		expect(alwaysScopeOf(false, "global")).toBeNull();
		expect(alwaysScopeOf(true, "host")).toBe("host");
		expect(alwaysScopeOf(true, "global")).toBe("global");
	});

	it("offers this host first, then everywhere", () => {
		expect(ALWAYS_SCOPES.map((s) => s.value)).toEqual(["host", "global"]);
	});

	it('"Always do this" writes the action clicked, for this host or globally', () => {
		expect(overlayChoice("restart", "host", false).remember).toEqual({
			scope: "host",
			whenEnded: "restart",
		});
		expect(overlayChoice("close", "global", true)).toEqual({
			act: { kind: "close", keep: true },
			remember: { scope: "global", whenEnded: "close" },
		});
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
