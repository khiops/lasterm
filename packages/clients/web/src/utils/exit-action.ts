import type { ChannelEndReason, PanesConfig, TerminalProfile } from "@lasterm/shared";
import type { PaneCover } from "./pane-cover.js";

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
 * was found is shown at once, and acted on only once its pane is on screen in
 * the window that has the focus (`answerFoundEnd`, #592): nobody saw it happen,
 * and #559's "nothing restarts that nobody sees" holds there.
 */
export interface EndSeen {
	seen: "live" | "found";
	/** How long the pane watched it running before it ended; null when it never did. */
	watchedMs: number | null;
	/** That watch began when the terminal started, which the pane saw or caused. */
	fromStart: boolean;
	/**
	 * This end was told already, and nothing since said the terminal runs: a
	 * report repeating it, the attach after it, a STATE_SYNC naming it. Only
	 * the first word of an end is answered (#592).
	 */
	again?: true;
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
	/** The terminal whose end was told last, until something says it runs again. */
	let toldId: string | null = null;

	return {
		starting(channelId) {
			watching = null;
			startingId = channelId;
			toldId = null;
		},
		attached(channelId) {
			watching = { channelId, since: now(), fromStart: startingId === channelId };
			startingId = null;
			toldId = null;
		},
		lost() {
			watching = null;
			startingId = null;
		},
		ended(channelId) {
			const watched = watching?.channelId === channelId ? watching : null;
			const justStarted = startingId === channelId;
			// Nothing said it runs since: `starting` and `attached` forget it.
			const again = toldId === channelId;
			watching = null;
			startingId = null;
			toldId = channelId;
			if (watched === null) {
				return {
					seen: "found",
					watchedMs: null,
					fromStart: justStarted,
					...(again && { again: true as const }),
				};
			}
			return { seen: "live", watchedMs: now() - watched.since, fromStart: watched.fromStart };
		},
	};
}

// ─── What the pane does about it ─────────────────────────────────────────────

/**
 * Why a pane showed its overlay rather than do what its setting says: why one
 * set to restart did not, or, for a terminal stopped from elsewhere, that it
 * was, and so what was not done (#580).
 */
export type HeldBack =
	| "just-started"
	| "just-attached"
	| "runs-a-command"
	| "not-writer"
	| "stopped-not-restarted"
	| "stopped-not-closed"
	| "stopped";

export type EndReaction =
	| { kind: "overlay"; heldBack?: HeldBack }
	| { kind: "restart" }
	| { kind: "close"; keep: boolean };

export interface EndFacts extends EndSeen {
	/** It runs a command rather than a shell (a direct process). */
	directProcess: boolean;
	/** This window holds its write lock. */
	writer: boolean;
	/** Why the hub says it ended, when the hub ended it itself (#580). */
	endReason?: ChannelEndReason | undefined;
}

/**
 * What a pane does when its terminal ends.
 *
 * An end the hub caused (its report says why) is not acted on, whatever the
 * setting, and the overlay says it was stopped from elsewhere (#580):
 * - `killed`, it or its session stopped on purpose: never, live or found.
 *   Someone meant it, and restarting it would undo that, where closing the
 *   pane would hide it;
 * - `stopped`, with its agent replaced or the hub quitting: not as it happens,
 *   so as not to race the replacement or the quit. Found later, nobody aimed
 *   at that terminal, and it follows the setting as any end found (#592).
 *
 * An end that was found is shown here, with why a restart would hold back,
 * and left to `answerFoundEnd` once its pane is on screen (#592).
 *
 * Otherwise only an end seen live is acted on. Restart holds back, with the
 * overlay and the reason, from:
 * - a terminal that ended within `AUTO_RESTART_MIN_RUN_MS` of starting, or of
 *   the pane reaching it when its start was not seen: a shell that fails at
 *   launch would otherwise restart for ever;
 * - one that runs a command: a command that finishes would run again each
 *   time it did;
 * - one whose write lock another window holds, or nobody does: each window
 *   over it would restart it, and two restarts of one terminal race at the hub.
 */
export function reactToEnd(prefs: EndedPrefs, end: EndFacts): EndReaction {
	if (end.endReason === "killed" || (end.endReason === "stopped" && end.seen === "live")) {
		return { kind: "overlay", heldBack: stoppedElsewhere(prefs.whenEnded) };
	}
	if (end.seen === "found") {
		// A restart from here that ended before the pane could attach to it ended
		// right after starting: worth saying, when the setting would restart.
		if (prefs.whenEnded === "restart" && end.fromStart) {
			return { kind: "overlay", heldBack: "just-started" };
		}
		// Found ends follow the setting now, save this one (#592).
		if (prefs.whenEnded === "restart" && end.directProcess) {
			return { kind: "overlay", heldBack: "runs-a-command" };
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

/** What the overlay says of a terminal stopped from elsewhere: what the setting would have done. */
function stoppedElsewhere(whenEnded: WhenEnded): HeldBack {
	switch (whenEnded) {
		case "restart":
			return "stopped-not-restarted";
		case "close":
			return "stopped-not-closed";
		case "ask":
			return "stopped";
	}
}

/** The overlay's short explanation for why it shows. */
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
		case "stopped-not-restarted":
			return "It was stopped from elsewhere, so it wasn't restarted.";
		case "stopped-not-closed":
			return "It was stopped from elsewhere, so its pane wasn't closed.";
		case "stopped":
			return "It was stopped from elsewhere.";
	}
}

// ─── The overlay's buttons ───────────────────────────────────────────────────

/**
 * Where "Always do this" writes the action: for this host, or everywhere.
 * One or the other, never both.
 */
export type AlwaysScope = "host" | "global";

/**
 * The choice beside "Always do this", in the order shown: this host first,
 * the narrower one, which is also what it starts on.
 */
export const ALWAYS_SCOPES: readonly { value: AlwaysScope; label: string }[] = [
	{ value: "host", label: "this host" },
	{ value: "global", label: "everywhere" },
];

/** Where to remember the action, if anywhere: nowhere while the box is unchecked. */
export function alwaysScopeOf(on: boolean, where: AlwaysScope): AlwaysScope | null {
	return on ? where : null;
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

// ─── The overlays already waiting (#586) ─────────────────────────────────────

/**
 * "Always do this", clicked on one overlay, as the other panes of this window
 * hear it once it is written.
 *
 * Nothing of it is stored or sent: a reload, another window, or an overlay that
 * comes up afterwards never hears it.
 */
export interface AlwaysChoice {
	action: OverlayAction;
	scope: AlwaysScope;
	/** The host of the terminal it was clicked on. */
	hostId: string | null;
	/** The terminal it was clicked on, which answered for itself. */
	channelId: string | null;
	/** When it was clicked (`performance.now()`): of two choices, the later one holds. */
	at: number;
}

/**
 * What about an end keeps its overlay asking, whatever was chosen on another
 * one: the reasons the setting's restart holds back for, save the command,
 * which is the terminal's and not the end's (see `answerWaiting`).
 */
export type EndHold = Extract<HeldBack, "just-started" | "just-attached" | "not-writer">;

/**
 * What an end holds back from a choice made on another overlay.
 *
 * The same guards as the setting's restart (`reactToEnd`), read whatever the
 * setting was when it ended, since the choice is made afterwards:
 * - it ended within `AUTO_RESTART_MIN_RUN_MS` of starting, or of the pane
 *   reaching it: a shell failing at launch;
 * - another window holds its write lock, or nobody does.
 *
 * Nothing else is held back. An end found at a reload or an attach was never
 * watched, and one stopped from elsewhere (#580), killed or stopped, did not
 * fail: the choice was just made explicitly, so both follow it. A restart
 * from here that ended before the pane could reach it still ended right after
 * starting. Whether the setting follows a found end on its own is
 * `answerFoundEnd`'s to say, and it keeps asking over a kill (#592).
 */
export function endHold(end: EndFacts): EndHold | null {
	if (end.endReason !== undefined) return null;
	if (end.seen === "found") return end.fromStart ? "just-started" : null;
	if (end.watchedMs === null || end.watchedMs < AUTO_RESTART_MIN_RUN_MS) {
		return end.fromStart ? "just-started" : "just-attached";
	}
	return end.writer ? null : "not-writer";
}

/** An overlay showing, over a terminal that ended, when a choice reaches it. */
export interface WaitingOverlay {
	channelId: string | null;
	hostId: string | null;
	/** What its end holds back, from `endHold`. */
	hold: EndHold | null;
	/** Its terminal runs a command rather than a shell. */
	directProcess: boolean;
	/** "When a terminal ends", as its terminal's settings resolve it now. */
	whenEnded: WhenEnded;
	/** It is on screen: its tab is the one shown. */
	inView: boolean;
	/** It has been on screen since the choice reached it. */
	wasInView: boolean;
}

/** Do the action chosen, wait to, or leave the overlay asking. */
export type WaitingAnswer = "act" | "wait" | "ask";

/**
 * What an overlay already waiting does with "Always do this", clicked on
 * another one.
 *
 * It follows the choice when it is in its scope — its host, or every host —
 * and nothing holds it back: not its end (`endHold`), nor a terminal that runs
 * a command, which the choice would run again.
 *
 * It acts when it comes into view, never in the background, so that nothing
 * happens that nobody sees: at once when it is already on screen, as beside
 * the one clicked, or when its tab is shown. It acts only when its terminal's
 * setting now says the same, as the setting decides: an override of its own
 * that says otherwise keeps it asking. The setting is read again after the
 * write, so on screen it waits for that; once it has been on screen without
 * the setting agreeing, it keeps asking.
 */
export function answerWaiting(choice: AlwaysChoice, overlay: WaitingOverlay): WaitingAnswer {
	if (overlay.channelId === null || overlay.channelId === choice.channelId) return "ask";
	if (choice.scope === "host" && (overlay.hostId === null || overlay.hostId !== choice.hostId)) {
		return "ask";
	}
	if (overlay.directProcess || overlay.hold !== null) return "ask";
	if (!overlay.inView) return overlay.wasInView ? "ask" : "wait";
	return overlay.whenEnded === choice.action ? "act" : "wait";
}

// ─── An end found, and the setting (#592) ────────────────────────────────────

/**
 * Whether "When a terminal ends" has been read for this terminal, on the host
 * it runs on.
 *
 * Until its profile is read, a pane holds the default, which says "ask". And
 * until the pane knows its terminal's host, it reads the profile of the host
 * in view: a tab over another host's terminal, at launch, would follow that
 * host's setting, and bring the terminal back on a host it never ran on.
 * `resolved` is what the profile was last read for; `host`, the host the
 * client knows the terminal is on, if it knows.
 */
export function settingReadFor(
	resolved: { hostId: string | null; channelId: string | null } | null,
	channelId: string | null,
	host: string | undefined,
): boolean {
	if (resolved === null || channelId === null || host === undefined) return false;
	return resolved.channelId === channelId && resolved.hostId === host;
}

/** An overlay over an end its pane found, and what decides whether it follows the setting. */
export interface FoundEnd {
	/** What about its end holds it back (`endHold`): for an end found, a restart from here that ended at once. */
	hold: EndHold | null;
	/** Its terminal runs a command rather than a shell. */
	directProcess: boolean;
	/** Why the hub says it ended, when it ended it itself (#580). */
	endReason?: ChannelEndReason | undefined;
	/** "When a terminal ends", as its terminal's settings resolve it now. */
	whenEnded: WhenEnded;
	/** That setting was read for its terminal: until then it shows the default, "ask". */
	settingKnown: boolean;
	/** It is on screen: its tab is the one shown, beside the pane selected or not. */
	inView: boolean;
	/** Its window has the focus. */
	focused: boolean;
}

/**
 * What an overlay over an end its pane found does with "When a terminal ends"
 * (#592): an end that happened while the app was closed, or that a reload or
 * an attach learnt of.
 *
 * It follows it, Restart or Close, once, and never in the background: only
 * while it is on screen, in the window that has the focus, so that two windows
 * showing the same terminal do not both act on it. Until then it waits, and it
 * acts the moment it is seen: its tab shown, or its window focused.
 *
 * It keeps asking, whatever the setting says, over:
 * - a terminal killed, it or its session (#580): a deliberate stop is never
 *   undone by a setting. One `stopped` with its agent replaced or the hub
 *   quitting was aimed at nothing in particular, and follows the setting;
 * - a terminal that runs a command: Restart would run it again, and Close
 *   would take away what it printed before anyone read it;
 * - a restart from here that ended before its pane could reach it: it ended
 *   right after starting (`endHold`).
 *
 * "Ask" asks. The setting is waited for until it has been read for its
 * terminal: before that it reads "ask" for every one.
 *
 * A restart that ends again at once is an end seen live, within
 * `AUTO_RESTART_MIN_RUN_MS` of its start: `reactToEnd` holds that one back.
 */
export function answerFoundEnd(end: FoundEnd): WaitingAnswer {
	if (end.endReason === "killed" || end.directProcess || end.hold !== null) return "ask";
	if (!end.settingKnown) return "wait";
	if (end.whenEnded === "ask") return "ask";
	return end.inView && end.focused ? "act" : "wait";
}

// ─── A restart whose host is away (#605) ─────────────────────────────────────

/**
 * What a pane does once a restart of its terminal failed: show the card and
 * its reason, wait for the host, or try again at once.
 */
export type AfterRestartFailure = "card" | "wait" | "retry-now";

/** What decides it, as the pane knows it when the restart fails. */
export interface RestartFailureFacts {
	/**
	 * The hub said the terminal's host could not be reached (`HOST_UNREACHABLE`):
	 * the terminal did not fail, its host is away.
	 */
	hostAway: boolean;
	/** That host is connected now, as this window last heard, the refusal included. */
	hostConnected: boolean;
	/** The restart that failed was itself the one made on its own: the host's return, or a retry. */
	automatic: boolean;
}

/**
 * What a pane does once a restart of its terminal failed (#605), whether the
 * setting asked for it, or a click, or the host's return.
 *
 * A failure of the terminal, or of anything but reaching its host, shows the
 * card with its reason, as before.
 *
 * A host away is waited for: a quiet line says so, and the pane restarts its
 * terminal once, on its own, when that host is connected again, whatever the
 * view and the focus, since someone or the setting already asked. Only its
 * host's return sets it off, never a clock.
 *
 * A host that is back already, as the refusal crossed its return, is tried
 * again at once, once: a restart made on its own that meets a host away yet
 * connected shows the card rather than try again and again.
 *
 * Cancel on the line brings the card back, and stops waiting: that is the
 * pane's to do, not a failure's (`endedPaneShows`).
 */
export function afterRestartFailure(facts: RestartFailureFacts): AfterRestartFailure {
	if (!facts.hostAway) return "card";
	if (!facts.hostConnected) return "wait";
	return facts.automatic ? "card" : "retry-now";
}

/** The quiet line of a pane waiting for its host to restart its terminal. */
export function waitingForHostText(hostLabel: string | undefined): string {
	return `Waiting for ${hostLabel ?? "its host"}…`;
}

// ─── What a pane shows over its ended terminal (#595) ────────────────────────

/**
 * How long an end found waits for "When a terminal ends" to be read for its
 * terminal before its pane asks anyway.
 *
 * The read is one request, and takes a moment. One that fails, or a terminal
 * whose host the client never learns, would otherwise leave the pane saying
 * that its shell exited with nothing to click. If the setting is read after
 * all, it still answers the end as `answerFoundEnd` says.
 */
export const SETTING_READ_GRACE_MS = 3_000;

/** What a pane lays over its terminal once it has ended. */
export type EndedView =
	/** Nothing of its own: nothing ended, or the pane is still opening and says so. */
	| { kind: "none" }
	/** The card, which asks: Restart, Close, "Always do this". */
	| { kind: "card" }
	/**
	 * One line, which says what is being done, or waited for, and asks nothing.
	 * Waiting for its host, it offers to stop waiting (`cancel`, #605).
	 */
	| { kind: "quiet"; text: string; cancel?: true };

/** What a pane knows that decides what it shows over its ended terminal. */
export interface EndedPane {
	/** What covers its terminal (`paneCover`). */
	cover: PaneCover;
	/** It is still opening: it says "Connecting…", and has not taken in its terminal's end yet. */
	opening: boolean;
	/** A restart of its terminal is under way from this pane, whoever asked for it. */
	restarting: boolean;
	/**
	 * A restart failed because the terminal's host is away, and the pane waits
	 * for it (`afterRestartFailure`, #605): the host's label, or null. Cancel
	 * sets it back to null.
	 */
	waitingForHost: { label: string | undefined } | null;
	/** The end it found that the setting has still to answer (#592), or null. */
	found: FoundEnd | null;
	/** That end has waited `SETTING_READ_GRACE_MS` for its setting to be read. */
	settingOverdue: boolean;
	/** What the card says first: "Shell exited (code 0)". */
	exitMessage: string;
}

/**
 * The card over an ended terminal, or a quiet line in its place (#595).
 *
 * The card is a question, so it shows only when the pane is going to ask:
 * the setting says Ask, or something holds the end back (a restart that
 * ended at once, a command, another window's write lock, a kill), or a
 * restart failed, which it says. A terminal that the hub has no record of
 * (`gone`) has only Close to offer, and always asks.
 *
 * While the setting is going to act, nothing is asked, and one line says
 * what the pane does or waits for:
 * - "Restarting…" while a restart is under way, and at the moment the
 *   setting acts ("Closing…" for Close, which takes the pane away);
 * - "Restarts when this window has the focus." for an end found in a window
 *   without the focus ("Closes when…" for Close);
 * - "Restarts when this terminal is shown." for one whose tab is not the one
 *   shown, where the line is hidden with its pane anyway;
 * - the exit message alone ("Shell exited") while the setting is still being
 *   read for its terminal: until then nothing says whether it will ask, and
 *   the pane promises nothing. Past `SETTING_READ_GRACE_MS` it asks.
 *
 * A restart that failed because the host is away is waited out rather than
 * asked about (#605): "Waiting for <host>…", with Cancel, until the host is
 * back and the pane restarts it. Cancelled, the card comes back with the
 * reason. Any other failure shows the card, which says why.
 *
 * While the pane opens, "Connecting…" is all it says.
 */
export function endedPaneShows(pane: EndedPane): EndedView {
	if (pane.opening) return { kind: "none" };
	if (pane.cover === "gone") return { kind: "card" };
	if (pane.cover !== "exited") return { kind: "none" };
	if (pane.restarting) return { kind: "quiet", text: "Restarting…" };
	if (pane.waitingForHost !== null) {
		return { kind: "quiet", text: waitingForHostText(pane.waitingForHost.label), cancel: true };
	}
	const found = pane.found;
	if (found === null) return { kind: "card" };
	const closes = found.whenEnded === "close";
	switch (answerFoundEnd(found)) {
		case "ask":
			return { kind: "card" };
		case "act":
			return { kind: "quiet", text: closes ? "Closing…" : "Restarting…" };
		case "wait":
			if (!found.settingKnown) {
				return pane.settingOverdue ? { kind: "card" } : { kind: "quiet", text: pane.exitMessage };
			}
			if (!found.inView) {
				return {
					kind: "quiet",
					text: closes
						? "Closes when this terminal is shown."
						: "Restarts when this terminal is shown.",
				};
			}
			return {
				kind: "quiet",
				text: closes
					? "Closes when this window has the focus."
					: "Restarts when this window has the focus.",
			};
	}
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
