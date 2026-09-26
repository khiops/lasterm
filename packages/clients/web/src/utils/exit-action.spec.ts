import type { TerminalProfile } from "@lasterm/shared";
import { describe, expect, it, vi } from "vitest";
import {
	ALWAYS_SCOPES,
	type AlwaysChoice,
	AUTO_RESTART_MIN_RUN_MS,
	alwaysScopeOf,
	answerWaiting,
	createEndWatch,
	type EndedPrefs,
	type EndFacts,
	endedPrefs,
	endedToDelete,
	endHold,
	heldBackMessage,
	LEGACY_DEAD_TAB_KEY,
	migrateLegacyDeadTabChoice,
	overlayChoice,
	reactToEnd,
	type WaitingOverlay,
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

// ─── The overlays already waiting (#586) ─────────────────────────────────────

// "Always do this" on one overlay acted only on terminals that ended
// afterwards: when several ended at once, each had to be answered by hand.
describe("endHold: what an end holds back from a choice made elsewhere", () => {
	it("nothing, for a shell that ran long enough in the window holding it", () => {
		expect(endHold(liveEnd)).toBeNull();
	});

	// The loop guard: a shell failing at launch would restart for ever.
	it("one that ended within 5 seconds of starting, or of the pane reaching it", () => {
		expect(endHold({ ...liveEnd, watchedMs: AUTO_RESTART_MIN_RUN_MS - 1 })).toBe("just-started");
		expect(endHold({ ...liveEnd, watchedMs: null })).toBe("just-started");
		expect(endHold({ ...liveEnd, fromStart: false, watchedMs: 1_000 })).toBe("just-attached");
		expect(endHold({ ...liveEnd, watchedMs: AUTO_RESTART_MIN_RUN_MS })).toBeNull();
	});

	// Whatever the setting was when it ended: "ask" says nothing of it.
	it("one whose write lock this window does not hold", () => {
		expect(endHold({ ...liveEnd, writer: false })).toBe("not-writer");
	});

	// Never watched: the choice was just made, explicitly.
	it("nothing, for an end found at a reload or an attach", () => {
		expect(
			endHold({ ...liveEnd, seen: "found", watchedMs: null, fromStart: false, writer: false }),
		).toBeNull();
	});

	it("a restart from here that ended before the pane could reach it", () => {
		expect(endHold({ ...liveEnd, seen: "found", watchedMs: null, fromStart: true })).toBe(
			"just-started",
		);
	});

	// It did not fail: someone stopped it (#580).
	it("nothing, for a terminal stopped from elsewhere", () => {
		const destroyed: EndFacts = { ...liveEnd, endReason: "destroyed" };
		expect(endHold(destroyed)).toBeNull();
		expect(endHold({ ...destroyed, watchedMs: 1_000, writer: false })).toBeNull();
		expect(endHold({ ...destroyed, seen: "found", watchedMs: null })).toBeNull();
	});

	// The command is the terminal's, not the end's: answerWaiting reads it.
	it("leaves the command to answerWaiting", () => {
		expect(endHold({ ...liveEnd, directProcess: true })).toBeNull();
	});
});

describe("answerWaiting: an overlay already waiting, and a choice made on another", () => {
	const restartHere: AlwaysChoice = {
		action: "restart",
		scope: "host",
		hostId: "h1",
		channelId: "clicked",
		at: 1_000,
	};
	/** An overlay of the same host, on screen, whose setting now says restart. */
	const waiting: WaitingOverlay = {
		channelId: "other",
		hostId: "h1",
		hold: null,
		directProcess: false,
		whenEnded: "restart",
		inView: true,
		wasInView: false,
	};

	it("follows it on screen when its setting now says the same", () => {
		expect(answerWaiting(restartHere, waiting)).toBe("act");
		expect(
			answerWaiting({ ...restartHere, action: "close" }, { ...waiting, whenEnded: "close" }),
		).toBe("act");
	});

	// Never in the background: nothing happens that nobody sees.
	it("waits until it is on screen", () => {
		expect(answerWaiting(restartHere, { ...waiting, inView: false })).toBe("wait");
	});

	// The setting is read again after the write, which takes a moment.
	it("waits on screen while its setting does not say so yet", () => {
		expect(answerWaiting(restartHere, { ...waiting, whenEnded: "ask" })).toBe("wait");
		expect(answerWaiting(restartHere, { ...waiting, whenEnded: "close" })).toBe("wait");
	});

	// An override of its own that says otherwise: it had its turn on screen.
	it("keeps asking once it left the screen without its setting agreeing", () => {
		expect(
			answerWaiting(restartHere, { ...waiting, whenEnded: "ask", inView: false, wasInView: true }),
		).toBe("ask");
		// Back on screen, agreeing at last: it still acts, the moment it is seen.
		expect(answerWaiting(restartHere, { ...waiting, wasInView: true })).toBe("act");
	});

	it('"this host" reaches the overlays of that host only', () => {
		expect(answerWaiting(restartHere, { ...waiting, hostId: "h2" })).toBe("ask");
		expect(answerWaiting(restartHere, { ...waiting, hostId: null })).toBe("ask");
		expect(answerWaiting({ ...restartHere, hostId: null }, { ...waiting, hostId: null })).toBe(
			"ask",
		);
	});

	it('"everywhere" reaches the overlays of every host', () => {
		const everywhere: AlwaysChoice = { ...restartHere, scope: "global" };
		expect(answerWaiting(everywhere, { ...waiting, hostId: "h2" })).toBe("act");
		expect(answerWaiting(everywhere, { ...waiting, hostId: null })).toBe("act");
	});

	// The terminal clicked answered for itself.
	it("leaves the terminal it was clicked on alone", () => {
		expect(answerWaiting(restartHere, { ...waiting, channelId: "clicked" })).toBe("ask");
		expect(answerWaiting(restartHere, { ...waiting, channelId: null })).toBe("ask");
	});

	it("keeps asking over an end held back for a safety reason", () => {
		for (const hold of ["just-started", "just-attached", "not-writer"] as const) {
			expect(answerWaiting(restartHere, { ...waiting, hold }), hold).toBe("ask");
			expect(answerWaiting({ ...restartHere, action: "close" }, { ...waiting, hold }), hold).toBe(
				"ask",
			);
		}
	});

	// It would run the command again.
	it("keeps asking over a terminal that runs a command", () => {
		expect(answerWaiting(restartHere, { ...waiting, directProcess: true })).toBe("ask");
		expect(
			answerWaiting({ ...restartHere, scope: "global" }, { ...waiting, directProcess: true }),
		).toBe("ask");
	});

	// Found at a reload, or stopped from elsewhere (#580): nothing held back.
	it("follows it over an end nothing holds back, however it was learnt", () => {
		const found: EndFacts = { ...liveEnd, seen: "found", watchedMs: null, fromStart: false };
		const stopped: EndFacts = { ...liveEnd, endReason: "destroyed", writer: false };
		for (const end of [found, stopped]) {
			expect(answerWaiting(restartHere, { ...waiting, hold: endHold(end) })).toBe("act");
		}
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
