import type { PanesConfig, TerminalProfile } from "@lasterm/shared";

/**
 * What happens when a terminal ends (#574): the choice Settings › Terminal
 * offers, what a pane does with it, and what closing an ended terminal does.
 *
 * The pane only feeds this what it saw; every decision is made here, where a
 * test can reach it.
 */

/** "When a terminal ends", as Settings offers it. */
export type WhenEnded = "ask" | "restart" | "close";

export interface EndedPrefs {
	whenEnded: WhenEnded;
	/** Closing an ended terminal leaves it listed in the sidebar instead of deleting it. */
	keepEnded: boolean;
}

/**
 * How long a terminal has to have run for its end to be restarted without
 * asking. One that ends sooner is most likely failing at launch, and
 * restarting it would start a loop.
 */
export const AUTO_RESTART_MIN_RUN_MS = 5_000;

/**
 * The choice as a terminal reads it, with its defaults: ask, and delete on
 * close.
 *
 * "When a terminal ends" is a terminal setting, cascaded like its font: set
 * globally, for a host, or for the terminal itself, and the nearest wins. It
 * comes from the terminal's resolved profile. "Keep" is global, in the UI
 * config. Without a profile, as where only closing matters, it reads "ask".
 */
export function endedPrefs(
	panes: PanesConfig | undefined,
	profile?: Pick<TerminalProfile, "whenEnded">,
): EndedPrefs {
	const whenEnded = profile?.whenEnded;
	return {
		whenEnded: whenEnded === "restart" || whenEnded === "close" ? whenEnded : "ask",
		keepEnded: panes?.keepEnded === true,
	};
}

// ─── How a pane learnt that its terminal ended ───────────────────────────────

/**
 * What a pane knows about an end.
 *
 * `live`: the hub reported it while the pane was attached to the terminal
 * running, over a socket that stayed up since that attach. Anything else is
 * `found`: the list said so when the page loaded, an attach was refused because
 * it had ended, or the report came after the socket was replaced. An end that
 * was found is shown, never acted on: nobody saw it happen, and #559's "nothing
 * restarts on its own" holds there.
 */
export interface EndSeen {
	seen: "live" | "found";
	/** How long the pane watched it running before it ended; null when it never did. */
	watchedMs: number | null;
	/** That watch began when the terminal started, which the pane saw or caused. */
	fromStart: boolean;
}

/**
 * Follows one pane's view of its terminal, so that an end can be told apart:
 * seen as it happened, or found afterwards.
 *
 * The pane tells it what it does and hears; it answers, when the terminal
 * ends, how that end was learnt.
 */
export interface EndWatch {
	/** A start of this terminal is under way from here, or was just seen: the next attach counts from it. */
	starting(channelId: string): void;
	/** An attach reached this terminal running. */
	attached(channelId: string): void;
	/** Nothing heard from now on is live: the socket went, or an attach was answered otherwise. */
	lost(): void;
	/** The terminal ended: how this pane learnt it. */
	ended(channelId: string): EndSeen;
}

export function createEndWatch(now: () => number): EndWatch {
	/** The terminal watched running, since when, and whether from its start. */
	let watching: { channelId: string; since: number; fromStart: boolean } | null = null;
	/** A start from here, not yet attached to. */
	let startingId: string | null = null;

	return {
		starting(channelId) {
			watching = null;
			startingId = channelId;
		},
		attached(channelId) {
			watching = { channelId, since: now(), fromStart: startingId === channelId };
			startingId = null;
		},
		lost() {
			watching = null;
			startingId = null;
		},
		ended(channelId) {
			const watched = watching?.channelId === channelId ? watching : null;
			const justStarted = startingId === channelId;
			watching = null;
			startingId = null;
			if (watched === null) return { seen: "found", watchedMs: null, fromStart: justStarted };
			return { seen: "live", watchedMs: now() - watched.since, fromStart: watched.fromStart };
		},
	};
}

// ─── What the pane does about it ─────────────────────────────────────────────

/** Why a pane set to restart showed its overlay instead. */
export type HeldBack = "just-started" | "just-attached" | "runs-a-command" | "not-writer";

export type EndReaction =
	| { kind: "overlay"; heldBack?: HeldBack }
	| { kind: "restart" }
	| { kind: "close"; keep: boolean };

export interface EndFacts extends EndSeen {
	/** It runs a command rather than a shell (a direct process). */
	directProcess: boolean;
	/** This window holds its write lock. */
	writer: boolean;
}

/**
 * What a pane does when its terminal ends.
 *
 * Only an end seen live is acted on. Restart holds back, with the overlay and
 * the reason, from:
 * - a terminal that ended within `AUTO_RESTART_MIN_RUN_MS` of starting, or of
 *   the pane reaching it when its start was not seen: a shell that fails at
 *   launch would otherwise restart for ever;
 * - one that runs a command: a command that finishes would run again each
 *   time it did;
 * - one whose write lock another window holds, or nobody does: each window
 *   over it would restart it, and two restarts of one terminal race at the hub.
 */
export function reactToEnd(prefs: EndedPrefs, end: EndFacts): EndReaction {
	if (end.seen === "found") {
		// A restart from here that ended before the pane could attach to it ended
		// right after starting: worth saying, when the setting would restart.
		if (prefs.whenEnded === "restart" && end.fromStart) {
			return { kind: "overlay", heldBack: "just-started" };
		}
		return { kind: "overlay" };
	}
	switch (prefs.whenEnded) {
		case "ask":
			return { kind: "overlay" };
		case "close":
			return { kind: "close", keep: prefs.keepEnded };
		case "restart":
			if (end.directProcess) return { kind: "overlay", heldBack: "runs-a-command" };
			if (end.watchedMs === null || end.watchedMs < AUTO_RESTART_MIN_RUN_MS) {
				return { kind: "overlay", heldBack: end.fromStart ? "just-started" : "just-attached" };
			}
			if (!end.writer) return { kind: "overlay", heldBack: "not-writer" };
			return { kind: "restart" };
	}
}

/** The overlay's short explanation for a restart held back. */
export function heldBackMessage(reason: HeldBack): string {
	switch (reason) {
		case "just-started":
			return "It ended right after starting, so it wasn't restarted automatically.";
		case "just-attached":
			return "It ended moments after this window connected to it, so it wasn't restarted automatically.";
		case "runs-a-command":
			return "It runs a command rather than a shell, so it isn't restarted automatically.";
		case "not-writer":
			return "This window doesn't hold its write lock, so it wasn't restarted from here.";
	}
}

// ─── The overlay's buttons ───────────────────────────────────────────────────

/**
 * Where "Always do this" writes the action: "for this host", or "globally".
 * One or the other, never both.
 */
export type AlwaysScope = "host" | "global";

/**
 * The two "Always do this" boxes after one of them was clicked: checking one
 * clears the other, unchecking it leaves neither.
 */
export function toggleAlways(
	current: AlwaysScope | null,
	clicked: AlwaysScope,
	checked: boolean,
): AlwaysScope | null {
	if (checked) return clicked;
	return current === clicked ? null : current;
}

export type OverlayAction = "restart" | "close";

/** What "Always do this" writes, and where. */
export interface RememberedEnd {
	scope: AlwaysScope;
	whenEnded: Exclude<WhenEnded, "ask">;
}

/**
 * What a click on the overlay does, and what "Always do this" writes.
 *
 * Close acts at once: there is no second question. Whether it deletes the
 * terminal is the "Keep" setting's to say, not the overlay's. "Always do this"
 * remembers the action clicked, for this host or globally.
 */
export function overlayChoice(
	action: OverlayAction,
	always: AlwaysScope | null,
	keepEnded: boolean,
): { act: Exclude<EndReaction, { kind: "overlay" }>; remember: RememberedEnd | null } {
	const act: Exclude<EndReaction, { kind: "overlay" }> =
		action === "restart" ? { kind: "restart" } : { kind: "close", keep: keepEnded };
	return { act, remember: always === null ? null : { scope: always, whenEnded: action } };
}

// ─── Closing ended terminals ─────────────────────────────────────────────────

/**
 * The ended terminals that closing their pane or tab deletes: all of them, or
 * none when they are kept in the sidebar. Never a question.
 */
export function endedToDelete(endedIds: readonly string[], keep: boolean): string[] {
	return keep ? [] : [...endedIds];
}

// ─── The question this replaces ──────────────────────────────────────────────

/**
 * Where "Delete this dead terminal?" remembered "don't ask again", globally
 * and per host (`<key>:<hostId>`). It is no longer asked.
 */
export const LEGACY_DEAD_TAB_KEY = "lasterm:skipConfirmCloseDeadTab";

type LegacyStorage = Pick<Storage, "length" | "key" | "getItem" | "removeItem">;

/**
 * Carry the old answer over to the setting, once, then forget it.
 *
 * Not being asked any more meant "close and delete", which is keep = false. It
 * is written unless the setting already says to keep them: that was set since,
 * and it wins. The old keys go once nothing is left to write, so a write that
 * failed is tried again on the next start.
 *
 * Resolves with what was written, or null.
 */
export async function migrateLegacyDeadTabChoice(
	storage: LegacyStorage,
	prefs: EndedPrefs,
	save: (values: Partial<PanesConfig>) => Promise<boolean>,
): Promise<Partial<PanesConfig> | null> {
	let keys: string[];
	try {
		keys = [];
		for (let i = 0; i < storage.length; i++) {
			const key = storage.key(i);
			if (key === LEGACY_DEAD_TAB_KEY || key?.startsWith(`${LEGACY_DEAD_TAB_KEY}:`)) keys.push(key);
		}
	} catch {
		return null;
	}
	if (keys.length === 0) return null;

	const skipped = keys.some((key) => storage.getItem(key) === "true");
	const values: Partial<PanesConfig> | null =
		skipped && !prefs.keepEnded ? { keepEnded: false } : null;
	if (values !== null && !(await save(values))) return null;

	for (const key of keys) storage.removeItem(key);
	return values;
}
