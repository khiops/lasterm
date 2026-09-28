import { BUNDLED_THEMES } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { describe, expect, it } from "vitest";
import { contrastRatio, hexToRgb, TEXT_CONTRAST_AA, useThemeStore } from "../stores/theme.js";
import SOURCE from "./TerminalPane.vue?raw";

/** The z-index a rule declares, read from the component's own style block. */
function zIndexOf(selector: string): number {
	const rule = new RegExp(
		`(^|\\n)[^\\n]*\\${selector}[^{]*\\{[^}]*?z-index:\\s*(-?\\d+)`,
		"s",
	).exec(SOURCE);
	if (!rule?.[2]) throw new Error(`no z-index declared for ${selector}`);
	return Number(rule[2]);
}

// What the handler lets through is tested in utils/terminal-keys.spec.ts: the
// palette's chord never reaches the PTY, Ctrl+K does (#624).
describe("TerminalPane keys", () => {
	it("gives xterm terminalKeyHandler, and no handler of its own", () => {
		const calls = [...SOURCE.matchAll(/attachCustomKeyEventHandler\(/g)];
		expect(calls).toHaveLength(1);
		expect(SOURCE).toMatch(/attachCustomKeyEventHandler\(\s*terminalKeyHandler\(\{/);
	});
});

describe("TerminalPane layers", () => {
	// A pane that cannot spawn or attach says so in `.terminal-error`, and one
	// still connecting in `.terminal-loading`. Under the terminal's own opaque
	// background, both were painted out of sight: a failed spawn looked like an
	// empty terminal, offering the write lock of a channel that did not exist.
	it("shows what the pane has to say above the terminal", () => {
		const message = zIndexOf(".terminal-error");
		expect(message).toBe(zIndexOf(".terminal-loading"));
		expect(message).toBeGreaterThan(zIndexOf(".terminal-container"));
		expect(message).toBeGreaterThan(zIndexOf(".tint-overlay"));
	});

	// The overlay lets clicks through to the terminal below it, so its own
	// buttons take them back. Without that the error offered a way out that
	// could not be clicked.
	it("takes clicks on the actions the error offers", () => {
		// Every rule that styles the box, since more than one does.
		const box = [...SOURCE.matchAll(/\.terminal-error__box[^{]*\{[^}]*\}/gs)]
			.map((rule) => rule[0])
			.join("\n");
		expect(box, "no rule styles the error box").not.toBe("");
		expect(box).toMatch(/pointer-events:\s*auto/);
	});
});

describe("TerminalPane spawn size", () => {
	const spawnBlock =
		/const realId = await channelsStore\.spawnChannel[\s\S]*?syncChannelSize\(\);/.exec(
			SOURCE,
		)?.[0];

	// The fit that follows a font arriving late has no channel to tell while the
	// channel is still being created, and recording its size as though it had
	// been sent left the PTY a width the window never had: the shell then drew
	// its prompt wider than the window and the caret fell a line below.
	it("tells the channel the size the terminal has, once there is a channel", () => {
		expect(spawnBlock, "the spawn block moved").toBeDefined();
		expect(spawnBlock).toContain("suppressNextResize(cols, rows)");
		expect(spawnBlock?.indexOf("attachChannel(realId)")).toBeLessThan(
			spawnBlock?.indexOf("syncChannelSize()") ?? -1,
		);
	});
});

describe("TerminalPane recovery", () => {
	const errorBlock = /class="terminal-error"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/.exec(SOURCE)?.[0];

	// A pane that failed to spawn or attach had nothing to do but be closed: no
	// retry, and the reconnect watcher skipped it because it never became ready.
	it("offers a way out of a failure", () => {
		expect(errorBlock, "the error block moved").toBeDefined();
		expect(errorBlock).toContain('@click="onRetry"');
		expect(errorBlock).toContain('@click="onClosePaneFromOverlay"');
	});

	// The socket can be replaced while a pane is still opening, which is how one
	// of these panes ended up waiting out a ten-second timeout for nothing.
	it("sends a lost attach again, but never a lost spawn", () => {
		const followUp = /if \(reconnectedWhileOpening[\s\S]{0,200}?\}/.exec(SOURCE)?.[0] ?? "";
		expect(followUp, "the follow-up retry moved").toContain("onRetry()");
		// A spawn may have reached the hub with only its answer lost: sending it
		// again would leave a second terminal nobody asked for.
		expect(followUp).toContain("pendingHostId.value === null");
	});

	it("tries again on its own when the connection comes back", () => {
		const watcher = /sessionStore\.reconnectCount,[\s\S]*?\n\);/.exec(SOURCE)?.[0] ?? "";
		expect(watcher, "the reconnect watcher moved").toContain("reconnectCount");
		expect(watcher).toMatch(/if \(!ready\.value\) \{[\s\S]*?onRetry\(\)/);
	});
});

describe("TerminalPane host", () => {
	// Tabs are global: a pane whose terminal runs on another host stays on
	// screen while the rail shows a different one. Every pane was handed the
	// selected host, so it resolved the wrong host's profile, and Restart —
	// which is a spawn naming the terminal to bring back — named a host that
	// terminal had never run on, and the hub refused it.
	it("reads its host from the channel, not from the rail", () => {
		expect(SOURCE).toMatch(/channelsStore\.channelHostMap\.get\(channelId\)/);
	});

	it("leaves props.hostId to the pane that has no channel yet", () => {
		// One use: the fallback inside paneHostId, for a pane still owing its
		// spawn — there the host in view is the host to spawn on.
		const uses = [...SOURCE.matchAll(/props\.hostId/g)];
		expect(uses).toHaveLength(1);
	});

	it("restarts a terminal on the host it runs on", () => {
		expect(SOURCE).toMatch(/restartChannel\(chId,\s*paneHostId\.value\)/);
	});
});

describe("TerminalPane restart", () => {
	// A Pi terminal came back — prompt on screen, write lock held — under an
	// overlay still saying "Shell exited": the attach at page load had found it
	// dead, and nothing unsaid that when Restart brought it back.
	it("stops saying the terminal ended once it is brought back", () => {
		// A Windows checkout ends its lines with CRLF.
		const onRestart = /async function onRestart[\s\S]*?\r?\n}\r?\n/.exec(SOURCE)?.[0];
		expect(onRestart, "onRestart moved").toBeDefined();
		expect(onRestart).toMatch(/if \(ok\) \{[\s\S]*?hasEnded\.value = false;/);
		expect(SOURCE).toMatch(
			/status === 'live' \|\| status === 'born'\) \{\s*hasEnded\.value = false;/,
		);
	});

	// Under way, the card gives way to "Restarting…" (#595): nothing to press
	// again while it takes its time over SSH.
	it("shows why a restart failed, and that one is under way", () => {
		expect(SOURCE).toContain("Could not restart it: {{ restartFailure }}");
		expect(SOURCE).toContain("restarting: restarting.value,");
	});
});

describe("TerminalPane after a Reconnect (#556)", () => {
	// One decision for the banner and the overlay, so the pane cannot say "Not
	// connected" over a terminal it knows has ended.
	it("covers its terminal with what paneCover decides", () => {
		expect(SOURCE).toMatch(/v-if="cover === 'not-connected'" class="detached-banner"/);
		// The card, or the line in its place, from the cover (#595).
		expect(SOURCE).toMatch(/v-if="endedView\.kind === 'card'" class="exit-overlay"/);
		expect(SOURCE).toMatch(/endedPaneShows\(\{\s*cover: cover\.value,/);
		expect(SOURCE).toMatch(/status: channelsStore\.statusOf\(effectiveChannelId\.value\)/);
	});

	// The list holds the host in view; the hub's reports cover every other one.
	it("hears its terminal end whichever host is in view", () => {
		expect(SOURCE).toMatch(
			/const isDead = computed\(\(\) => channelsStore\.statusOf\(effectiveChannelId\.value\) === 'dead'\)/,
		);
	});

	it("takes the hub's answer to a Reconnect: ended, or gone", () => {
		// A Windows checkout ends its lines with CRLF.
		const onReconnect = /async function onReconnect[\s\S]*?\r?\n}\r?\n/.exec(SOURCE)?.[0];
		expect(onReconnect, "onReconnect moved").toBeDefined();
		expect(onReconnect).toContain("await attachAndCover(chId, { preserveContent: true })");
		// What a refusal means is factsFromRefusal's to say (pane-cover.spec.ts).
		expect(attachAndCover()).toMatch(
			/const facts = factsFromRefusal\([\s\S]*?\);\s*if \(facts === null\) throw err;\s*takeAnswer\(chId, facts\);/,
		);
	});

	// Over its banner (#556), and over a terminal that ended and was brought
	// back from the sidebar or another window, or that it never attached to
	// because it knew it had ended (#559).
	it("attaches again when the hub says a terminal it is not attached to is live", () => {
		const watcher =
			/channelsStore\.reportOf\(effectiveChannelId\.value\),[\s\S]*?\n\);/.exec(SOURCE)?.[0] ?? "";
		expect(watcher, "the live-report watcher moved").toContain(
			"report?.status !== 'live' || attachedLive",
		);
		expect(watcher).toMatch(/if \(report\?\.status === 'dead'\) \{\s*attachedLive = false;/);
		expect(watcher).toContain("onReconnect()");
	});
});

/** The one function every attach goes through. */
function attachAndCover(): string {
	// A Windows checkout ends its lines with CRLF.
	const body = /async function attachAndCover\([\s\S]*?\r?\n}\r?\n/.exec(SOURCE)?.[0];
	if (body === undefined) throw new Error("attachAndCover moved");
	return body;
}

describe("TerminalPane covers its terminal with what the hub answers now (#559)", () => {
	// Every attach reads the answer the same way. The one after the socket came
	// back read nothing, and the pane kept the banner, or dropped none, whatever
	// the hub had said.
	it("sends every attach through attachAndCover", () => {
		const calls = [...SOURCE.matchAll(/reattachChannel\(/g)];
		expect(calls, "an attach bypasses attachAndCover").toHaveLength(1);
		expect(attachAndCover()).toContain("result = await reattachChannel(chId, opts);");

		const reconnectWatcher = /sessionStore\.reconnectCount,[\s\S]*?\n\);/.exec(SOURCE)?.[0] ?? "";
		expect(reconnectWatcher).toContain("await attachAndCover(effectiveChannelId.value);");
		expect(SOURCE).toContain("await attachAndCover(props.channelId);");
		expect(SOURCE).toContain("await attachAndCover(newId);");
		expect(SOURCE).toMatch(/result = await attachAndCover\(chId, \{ preserveContent: true \}\);/);
	});

	// An answer replaces all the pane knew, not only the part it speaks of.
	it("takes each answer whole", () => {
		expect(attachAndCover()).toContain("takeAnswer(chId, factsFromAttachOk(result.cached));");
		const takeAnswer = /function takeAnswer\([\s\S]*?\r?\n}\r?\n/.exec(SOURCE)?.[0] ?? "";
		expect(takeAnswer, "takeAnswer moved").toContain("hasEnded.value = facts.ended;");
		expect(takeAnswer).toContain("isGone.value = facts.gone;");
		expect(takeAnswer).toContain("isDetached.value = facts.detached;");
	});
});

// A pane over an ended local terminal, in a global tab, showed an empty
// terminal with no overlay, no lock and no Restart once the sidebar had moved
// to the Raspberry Pi (#594). It had not attached, since the list said its
// terminal had ended, and it had kept nothing of that: its cover read the
// list of the host in view, which no longer carried it.
describe("TerminalPane over an ended terminal of the host not in view (#594)", () => {
	it("keeps the end it knew of when it did not attach, whatever list is in view", () => {
		const open = body(/async function openChannel\(/);
		const deadBranch = /if \(isDead\.value\) \{[\s\S]*?\} else \{/.exec(open)?.[0] ?? "";
		expect(deadBranch, "the branch moved").not.toBe("");
		// As the hub's CHANNEL_DEAD would have: hasEnded, which paneCover reads
		// whatever the status says (pane-cover.spec.ts).
		expect(deadBranch).toContain("takeAnswer(props.channelId, factsFromKnownEnd());");
		expect(body(/function takeAnswer\(/)).toContain("hasEnded.value = facts.ended;");
		expect(SOURCE).toMatch(/ended: hasEnded\.value,/);
	});
});

describe("TerminalPane lock indicator", () => {
	// A terminal on another host that has ended is in no list the pane can
	// read, so `isDead` stays false: the indicator offered "No lock" under an
	// overlay saying the shell had exited.
	it("is hidden for a terminal that has ended, whichever way the pane learnt it", () => {
		expect(SOURCE).toMatch(/:is-dead="isDead \|\| hasEnded \|\| isGone"/);
	});
});

// ─── When the terminal ends (#574) ───────────────────────────────────────────
//
// What the setting does is decided in exit-action.ts and tested there. These
// check that the pane tells it what it sees, and does what it answers.

/** A function's body, from its declaration to its closing brace at column 0. */
function body(signature: RegExp): string {
	const found = new RegExp(`${signature.source}[\\s\\S]*?\\r?\\n}\\r?\\n`).exec(SOURCE)?.[0];
	if (found === undefined) throw new Error(`${signature.source} moved`);
	return found;
}

describe("TerminalPane when its terminal ends (#574)", () => {
	// Only a report heard while attached to it running, on a socket that stayed
	// up, is an end seen live; every other way of learning it is found.
	it("tells the end watch what it sees", () => {
		const reportWatcher =
			/channelsStore\.reportOf\(effectiveChannelId\.value\),[\s\S]*?\n\);/.exec(SOURCE)?.[0] ?? "";
		// With what the report says of why it ended (#580).
		expect(reportWatcher).toContain("onTerminalEnded(endWatch.ended(chId), report.endReason);");

		const takeAnswer = body(/function takeAnswer\(/);
		expect(takeAnswer).toMatch(/if \(attachedLive\) \{\s*endWatch\.attached\(chId\);/);
		expect(takeAnswer).toMatch(
			/else if \(facts\.ended\) \{[\s\S]*?onTerminalEnded\(endWatch\.ended\(chId\)\);/,
		);
		expect(takeAnswer).toMatch(/else \{\s*endWatch\.lost\(\);/);

		// Before any report on the next socket can be read.
		expect(SOURCE).toMatch(
			/\(\) => sessionStore\.connected,\s*\(connected\) => \{\s*if \(!connected\) endWatch\.lost\(\);\s*\},\s*\{ flush: 'sync' \}/,
		);
	});

	it("counts from the start of a terminal it spawned or restarted", () => {
		expect(SOURCE).toMatch(
			/attachChannel\(realId\);[\s\S]{0,120}endWatch\.starting\(realId\);\s*endWatch\.attached\(realId\);/,
		);
		const onRestart = body(/async function onRestart\(/);
		expect(onRestart.indexOf("endWatch.starting(chId);")).toBeGreaterThan(-1);
		expect(onRestart.indexOf("endWatch.starting(chId);")).toBeLessThan(
			onRestart.indexOf("channelsStore.restartChannel("),
		);
	});

	it("does what the setting answers", () => {
		const onEnded = body(/function onTerminalEnded\(/);
		expect(onEnded).toContain("reactToEnd(prefs.value, facts)");
		expect(onEnded).toContain("directProcess: isDirectProcess.value");
		expect(onEnded).toContain("writer: isWriter.value");
		// A terminal stopped from elsewhere is never restarted or closed (#580).
		expect(onEnded).toMatch(
			/function onTerminalEnded\(end: EndSeen, endReason\?: ChannelEndReason\)/,
		);
		expect(onEnded).toMatch(/const facts: EndFacts = \{\s*\.\.\.end,/);
		// The report's reason, else what the hub said of it in the list or at
		// connect: an end found heard no report (#592).
		expect(onEnded).toMatch(
			/writer: isWriter\.value,\s*endReason: endReason \?\? channelsStore\.endReasonOf\(effectiveChannelId\.value\),\s*\};/,
		);
		expect(onEnded).toContain("if (reaction.kind === 'restart') void onRestart();");
		expect(onEnded).toContain("else closeEnded(reaction.keep);");
		expect(SOURCE).toContain(
			'<p v-if="heldBack !== null && !isGone" class="exit-reason">{{ heldBackText }}</p>',
		);
	});
});

describe("TerminalPane overlay (#574)", () => {
	const overlay =
		/<div v-if="endedView\.kind === 'card'" class="exit-overlay">[\s\S]*?\n\t\t<\/div>\n/.exec(
			SOURCE.replace(/\r\n/g, "\n"),
		)?.[0] ?? "";

	// No second dialog, and no keep option on it: Close acts at once, and the
	// "Keep" setting says whether the terminal stays listed.
	it("closes at once, as the keep setting says", () => {
		expect(overlay, "the overlay moved").not.toBe("");
		expect(overlay).toContain(`@click="onOverlayAction('close')"`);
		expect(overlay).toContain(`@click="onOverlayAction('restart')"`);
		expect(overlay).not.toContain("Keep");
		const onAction = body(/function onOverlayAction\(/);
		expect(onAction).toContain("alwaysScopeOf(alwaysOn.value, alwaysWhere.value),");
		expect(onAction).toContain("prefs.value.keepEnded,");
		expect(onAction).toContain("else closeEnded(act.keep);");
		expect(body(/function closeEnded\(/)).toContain("emit('close-pane', chId, { keep });");
	});

	// "When a terminal ends" is read where Settings cascades it: globally, for
	// the host, for the terminal.
	it("reads the setting from the terminal's resolved profile", () => {
		expect(SOURCE).toContain(
			"const prefs = computed(() => endedPrefs(configStore.uiConfig.panes, resolvedProfile.value));",
		);
	});

	it('writes the setting where "Always do this" says, for this terminal', () => {
		const onAction = body(/function onOverlayAction\(/);
		expect(onAction).toContain(".saveWhenEnded(remember.whenEnded, remember.scope, {");
		// A Windows checkout ends its lines with CRLF: each line on its own.
		expect(onAction).toContain("hostId: paneHostId.value ?? null,");
		expect(onAction).toContain("channelId: effectiveChannelId.value,");
	});

	// One checkbox, labelled by its words, so a click on them and a screen
	// reader both reach it.
	it('offers one "Always do this" box', () => {
		expect(overlay).toMatch(
			/<label class="exit-option" :for="`\$\{exitId\}-always`">\s*<input :id="`\$\{exitId\}-always`" v-model="alwaysOn" type="checkbox" \/>\s*Always do this\s*<\/label>/,
		);
		expect(overlay.match(/type="checkbox"/g)).toHaveLength(1);
	});

	// Where it applies is one choice among radios, grouped and named, so that
	// only one can be chosen and a screen reader says what they are for.
	// Picking one checks the box: it means nothing otherwise.
	it("offers where beside it, as one choice, and picking one checks the box", () => {
		expect(overlay).toMatch(/role="radiogroup"\s*aria-label="Where to always do this"/);
		expect(overlay).toMatch(
			/<input\s*v-model="alwaysWhere"\s*type="radio"\s*:name="`\$\{exitId\}-scope`"\s*:value="where\.value"\s*@change="alwaysOn = true"\s*\/>/,
		);
		expect(overlay).toContain('v-for="where in ALWAYS_SCOPES"');
		expect(overlay).toContain(":class=\"{ 'exit-scope--off': !alwaysOn }\"");
	});

	it('starts with "Always do this" unchecked, on this host, and gives the keyboard to its card', () => {
		expect(SOURCE).toContain("alwaysOn.value = false;");
		expect(SOURCE).toContain("alwaysWhere.value = 'host';");
		expect(SOURCE).toContain("void nextTick(focusOverlay);");
		expect(overlay).toMatch(/ref="exitCard"\s*class="exit-card"\s*role="group"\s*tabindex="-1"/);
		expect(SOURCE).toContain("exitCard.value?.focus();");
	});

	// The Enter typed after `exit`, or pressed twice, lands on whatever holds the
	// keyboard when the overlay comes up: a button there would restart the shell.
	it("gives no button the keyboard", () => {
		expect(overlay).not.toMatch(/<button[^>]*\bref=/);
		expect(SOURCE).not.toContain("exitPrimary");
	});
});

// ─── "Always do this" answers the overlays already waiting (#586) ────────────
//
// What a waiting overlay does is answerWaiting's to say (exit-action.spec.ts),
// and how it waits useWaitingAnswer's (useWaitingAnswer.spec.ts). These check
// that the pane feeds them what it knows, and acts as its buttons do.

describe("TerminalPane follows a choice made on another overlay (#586)", () => {
	it("keeps what about an end holds it back, whatever the setting was", () => {
		const onEnded = body(/function onTerminalEnded\(/);
		expect(onEnded).toContain("const held = endHold(facts);");
		// As the overlay's reason: an end found later keeps what the one seen said.
		expect(onEnded).toContain("if (held !== null || end.seen === 'live') hold.value = held;");
		// Before the setting may restart or close the pane.
		expect(onEnded.indexOf("endHold(facts)")).toBeLessThan(onEnded.indexOf("reactToEnd("));
	});

	it("forgets it with its overlay, or when handed another terminal", () => {
		expect(SOURCE).toMatch(
			/watch\(effectiveChannelId, \(\) => \{\s*heldBack\.value = null;\s*hold\.value = null;\s*\}\);/,
		);
		expect(SOURCE).toMatch(
			/watch\(cover, \(now\) => \{\s*if \(now !== 'exited'\) hold\.value = null;\s*\}\);/,
		);
	});

	// Every pane of the tab shown, not only the selected one.
	it("is on screen when its tab is the one shown", () => {
		expect(SOURCE).toContain("const channelsOnScreen = inject(CHANNELS_ON_SCREEN_KEY, null);");
		expect(SOURCE).toContain(
			"return channelsOnScreen === null ? isActiveTab.value : channelsOnScreen.value.has(chId);",
		);
	});

	it("tells useWaitingAnswer what it knows", () => {
		const call = /useWaitingAnswer\(\{[\s\S]*?\}\);/.exec(SOURCE)?.[0] ?? "";
		expect(call, "the call moved").not.toBe("");
		// Only an ended terminal's overlay, not one gone, nor one restarting.
		expect(call).toContain(
			"waiting: computed(() => cover.value === 'exited' && !restarting.value),",
		);
		expect(call).toContain("channelId: effectiveChannelId,");
		expect(call).toContain("hostId: paneHostId,");
		expect(call).toMatch(/\bhold,/);
		expect(call).toContain("directProcess: isDirectProcess,");
		// The setting as its terminal resolves it, read again after each write.
		expect(call).toContain("whenEnded: computed(() => prefs.value.whenEnded),");
		expect(call).toMatch(/\binView,/);
		expect(call).toContain("act: followChoice,");
	});

	// Restart as the overlay's Restart; Close as its Close, which the keep
	// setting says whether to delete. Nothing written: the other overlay did.
	it("acts as the overlay's buttons do", () => {
		const follow = body(/function followChoice\(/);
		expect(follow).toContain("overlayChoice(action, null, prefs.value.keepEnded);");
		expect(follow).toContain("if (act.kind === 'restart') void onRestart();");
		expect(follow).toContain("else closeEnded(act.keep);");
		expect(follow).not.toContain("saveWhenEnded");
	});
});

// ─── An end found follows the setting once seen (#592) ──────────────────────
//
// What it does is answerFoundEnd's to say (exit-action.spec.ts), and how it
// waits useWaitingAnswer's (useWaitingAnswer.spec.ts). These check that the
// pane hands it every end it finds, once, with what decides it.

describe("TerminalPane follows the setting over an end it found (#592)", () => {
	// Every way a pane finds its terminal ended goes through onTerminalEnded:
	// the report watcher and takeAnswer, checked above, and a terminal the list
	// already says has ended, which the pane does not ask for.
	it("hands the setting an end it found, only the first word of it", () => {
		const onEnded = body(/function onTerminalEnded\(/);
		expect(onEnded).toContain(
			"if (end.seen === 'found' && end.again !== true) waitingAnswer.endFound(facts.endReason);",
		);
		// Over the overlay only, which it shows first.
		const overlayBranch =
			/if \(reaction\.kind === 'overlay'\) \{[\s\S]*?return;/.exec(onEnded)?.[0] ?? "";
		expect(overlayBranch).toContain("waitingAnswer.endFound(facts.endReason);");

		// takeAnswer hands an end to onTerminalEnded (checked above).
		const open = body(/async function openChannel\(/);
		expect(open).toMatch(
			/if \(isDead\.value\) \{\s*ready\.value = true;\s*takeAnswer\(props\.channelId, factsFromKnownEnd\(\)\);\s*\} else \{[\s\S]*?await attachAndCover\(props\.channelId\);\s*\}/,
		);
	});

	// The restart the setting makes there runs under this pane: it takes the
	// profile and the bell a pane that attached takes, rather than return first.
	it("gives a pane over a terminal known to have ended its profile and its bell", () => {
		const open = body(/async function openChannel\(/);
		const deadBranch = /if \(isDead\.value\) \{[\s\S]*?\} else \{/.exec(open)?.[0] ?? "";
		expect(deadBranch, "the branch moved").not.toBe("");
		expect(deadBranch).not.toContain("return");
		const afterAttach = open.slice(open.indexOf("await attachAndCover(props.channelId);"));
		expect(afterAttach).toMatch(
			/applyProfile\(resolvedProfile\.value\);[\s\S]*?terminal\.value\?\.onBell\(/,
		);
	});

	it("tells it why the hub ended the terminal, whether its setting was read, and whether its window has the focus", () => {
		const call = /const waitingAnswer = useWaitingAnswer\(\{[\s\S]*?\}\);/.exec(SOURCE)?.[0] ?? "";
		expect(call, "the call moved").not.toBe("");
		expect(call).toContain(
			"endReason: computed(() => channelsStore.endReasonOf(effectiveChannelId.value)),",
		);
		// Read for this terminal, on the host the client knows it runs on.
		expect(call).toMatch(
			/settingKnown: computed\(\(\) =>\s*settingReadFor\(\s*resolvedFor\.value,\s*effectiveChannelId\.value,[\s\S]*?channelsStore\.channelHostMap\.get\(effectiveChannelId\.value\),\s*\),\s*\),/,
		);
		expect(call).toContain("focused: useWindowFocus(),");
		expect(call).toContain("act: followChoice,");
		expect(SOURCE).toMatch(
			/const \{ profile: resolvedProfile, resolvedFor \} = useResolvedProfile\(/,
		);
		expect(SOURCE).toContain("import { useWindowFocus } from '../composables/useWindowFocus.js';");
	});
});

// ─── The card only when the pane asks (#595) ─────────────────────────────────
//
// Which of the card and the quiet line shows, and what the line says, is
// endedPaneShows's to decide (exit-action.spec.ts). These check that the pane
// feeds it what it knows, and shows what it answers.

describe("TerminalPane shows the card only when it asks (#595)", () => {
	it("feeds endedPaneShows what it knows", () => {
		const view = /const endedView = computed\(\(\) =>[\s\S]*?\r?\n\);/.exec(SOURCE)?.[0] ?? "";
		expect(view, "endedView moved").not.toBe("");
		expect(view).toContain("cover: cover.value,");
		// Still opening, it says "Connecting…", and has not taken in the end yet.
		expect(view).toContain("opening: !ready.value,");
		expect(view).toContain("restarting: restarting.value,");
		// The end the setting has still to answer, from useWaitingAnswer.
		expect(view).toContain("found: waitingAnswer.found.value,");
		expect(view).toContain("settingOverdue: waitingAnswer.settingOverdue.value,");
		expect(view).toContain("exitMessage: exitMessage.value,");
	});

	it("shows the card when it says so, and the quiet line in its place otherwise", () => {
		expect(SOURCE).toMatch(/<div v-if="endedView\.kind === 'card'" class="exit-overlay">/);
		expect(SOURCE).toMatch(
			/<span v-if="endedView\.kind === 'quiet'" class="exit-status__text">\{\{ endedView\.text \}\}<\/span>/,
		);
		// A restart under way no longer shows on the card, which gives way to it.
		expect(SOURCE).not.toContain(':disabled="restarting"');
	});

	// Announced politely, and heard: a live region already in the page when
	// its text changes.
	it("tells a screen reader the quiet line, without taking the keyboard", () => {
		expect(SOURCE).toMatch(
			/<div class="exit-status">\s*<div class="exit-status__line" role="status">\s*<span v-if="endedView\.kind === 'quiet'"/,
		);
		const style = SOURCE.slice(SOURCE.indexOf("<style")).replace(/\r\n/g, "\n");
		const status = /\n\.exit-status \{([^}]*)\}/.exec(style)?.[1] ?? "";
		expect(status, "the .exit-status rule moved").toMatch(/pointer-events:\s*none/);
	});

	// When the setting turns out to ask, or a restart failed, the card comes up
	// after the line, and takes the keyboard as it did before.
	it("gives the keyboard to the card each time it comes up", () => {
		const watcher =
			/watch\(\s*\(\) => endedView\.value\.kind === 'card',[\s\S]*?\{ immediate: true \},\s*\);/.exec(
				SOURCE,
			)?.[0] ?? "";
		expect(watcher, "the card watcher moved").not.toBe("");
		expect(watcher).toContain("alwaysOn.value = false;");
		expect(watcher).toContain("void nextTick(focusOverlay);");
	});

	// An end seen live that the setting restarts: the dead report and the
	// restart are one step, so the card has no moment to show in.
	it("starts a live restart before anything is drawn", () => {
		expect(body(/function onTerminalEnded\(/)).toContain(
			"if (reaction.kind === 'restart') void onRestart();",
		);
		const onRestart = body(/async function onRestart\(/);
		expect(onRestart.indexOf("restarting.value = true;")).toBeGreaterThan(-1);
		expect(onRestart.indexOf("restarting.value = true;")).toBeLessThan(onRestart.indexOf("await "));
	});
});

// ─── A restart whose host is away waits for it (#605) ───────────────────────
//
// What a failure does is afterRestartFailure's to say (exit-action.spec.ts),
// and how the pane waits useWaitForHost's (useWaitForHost.spec.ts). These
// check that the pane hands it every restart's outcome, and shows its line.

describe("TerminalPane waits for the host of a restart that found it away (#605)", () => {
	// Every restart goes through onRestart: the card's, the setting's, a choice
	// made on another overlay, and the host's return.
	it("hands the wait every restart's outcome", () => {
		const onRestart = body(/async function onRestart\(/);
		expect(onRestart).toContain("async function onRestart(opts?: { automatic?: boolean })");
		// A new attempt decides afresh, from before anything is awaited.
		expect(onRestart.indexOf("hostWait.restartStarting();")).toBeGreaterThan(-1);
		expect(onRestart.indexOf("hostWait.restartStarting();")).toBeLessThan(
			onRestart.indexOf("await "),
		);
		expect(onRestart).toMatch(
			/if \(!ok\) \{\s*endWatch\.lost\(\);[\s\S]*?hostWait\.restartFailed\(channelsStore\.restartFailures\.get\(chId\), opts\?\.automatic === true\);\s*\}/,
		);
	});

	it("restarts on the host's return as one made on its own, over its terminal ended only", () => {
		const call = /const hostWait = useWaitForHost\(\{[\s\S]*?\}\);/.exec(SOURCE)?.[0] ?? "";
		expect(call, "the call moved").not.toBe("");
		expect(call).toContain("ended: computed(() => cover.value === 'exited'),");
		expect(call).toContain("channelId: effectiveChannelId,");
		expect(call).toContain("restart: () => void onRestart({ automatic: true }),");
		expect(SOURCE).toContain("import { useWaitForHost } from '../composables/useWaitForHost.js';");
	});

	it("says which host it waits for, and offers Cancel beside the line", () => {
		const view = /const endedView = computed\(\(\) =>[\s\S]*?\r?\n\);/.exec(SOURCE)?.[0] ?? "";
		expect(view).toContain("waitingForHost: waitingForHost.value,");
		expect(SOURCE).toMatch(
			/const hostId = hostWait\.waitingFor\.value;[\s\S]*?label: hostsStore\.hosts\.find\(\(h\) => h\.id === hostId\)\?\.label/,
		);

		// Outside the live region, so that a screen reader hears the line alone.
		const status = /<div class="exit-status">[\s\S]*?<\/button>/.exec(SOURCE)?.[0] ?? "";
		expect(status, "the status block moved").not.toBe("");
		const region = /role="status">[\s\S]*?<\/div>/.exec(status)?.[0] ?? "";
		expect(region).not.toContain("<button");
		expect(status).toMatch(
			/<button\s+v-if="endedView\.kind === 'quiet' && endedView\.cancel"[\s\S]*?@click="onCancelWaiting"[\s\S]*?>Cancel<\/button>/,
		);
		expect(body(/function onCancelWaiting\(/)).toContain("hostWait.cancel();");

		// The line lets clicks through; its Cancel takes them.
		const style = SOURCE.slice(SOURCE.indexOf("<style")).replace(/\r\n/g, "\n");
		const cancel = /\n\.exit-status__cancel \{([^}]*)\}/.exec(style)?.[1] ?? "";
		expect(cancel, "the .exit-status__cancel rule moved").toMatch(/pointer-events:\s*auto/);
	});

	// The card still says why, once the wait is cancelled or for any other failure.
	it("shows the reason a restart failed on the card", () => {
		expect(SOURCE).toContain("channelsStore.restartFailures.get(chId)?.reason;");
	});
});

// ─── The card reads on any background ────────────────────────────────────────
//
// The card is drawn in the theme's own tokens, so its contrast is the theme's
// to guarantee. Checked here for every bundled theme, light and dark, against
// WCAG AA for text (4.5:1), with the colours the component's own rules name.

describe("TerminalPane overlay card contrast (#574)", () => {
	const style = SOURCE.slice(SOURCE.indexOf("<style")).replace(/\r\n/g, "\n");

	/** The declarations of the rule for exactly `selector`. */
	function declarations(selector: string): Map<string, string> {
		const escaped = selector.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
		const rule = new RegExp(`\\n${escaped}\\s*\\{([^}]*)\\}`).exec(style);
		if (!rule?.[1]) throw new Error(`no rule for ${selector}`);
		const out = new Map<string, string>();
		for (const line of rule[1].split(";")) {
			const [prop, ...value] = line.split(":");
			if (prop && value.length > 0) out.set(prop.trim(), value.join(":").trim());
		}
		return out;
	}

	/** The colour an expression the rules use stands for, once a theme is applied. */
	function resolve(expr: string): [number, number, number] | null {
		const root = document.documentElement.style;
		if (expr === "transparent") return null;
		const v = /^var\((--nt-[\w-]+)\)$/.exec(expr);
		if (v?.[1]) {
			const hex = root.getPropertyValue(v[1]).trim();
			if (!/^#[0-9a-fA-F]{6}$/.test(hex)) throw new Error(`${v[1]} is ${hex}, not a solid colour`);
			return hexToRgb(hex).split(", ").map(Number) as [number, number, number];
		}
		const triple = /^rgb\(var\((--nt-[\w-]+-rgb)\)\)$/.exec(expr);
		if (triple?.[1]) {
			return root.getPropertyValue(triple[1]).split(",").map(Number) as [number, number, number];
		}
		throw new Error(`cannot check the contrast of ${expr}`);
	}

	/**
	 * Each piece of text on the card, as the rules that style it from the card
	 * down: the last colour named wins, and the nearest ground that is not
	 * transparent is what it is read on.
	 */
	const texts: Record<string, string[]> = {
		message: [".exit-card", ".exit-message"],
		reason: [".exit-card", ".exit-reason"],
		checkbox: [".exit-card", ".exit-option"],
		"where, not chosen": [".exit-card", ".exit-scope-option"],
		"where, chosen": [".exit-card", ".exit-scope-option", ".exit-scope-option--on"],
		button: [".exit-card", ".exit-btn"],
		Restart: [".exit-card", ".exit-btn", ".exit-btn--primary"],
		// In place of the card, while the setting acts (#595).
		"quiet line": [".exit-status__text"],
	};

	function pair(rules: string[]): { text: string; ground: string } {
		const decls = rules.map(declarations);
		const text = decls
			.map((d) => d.get("color"))
			.filter((c) => c !== undefined)
			.at(-1);
		const ground = decls
			.map((d) => d.get("background"))
			.filter((b) => b !== undefined && b !== "transparent")
			.at(-1);
		if (text === undefined || ground === undefined) throw new Error(`${rules.join(" ")}: no pair`);
		return { text, ground };
	}

	it("draws the card on an opaque ground of the theme's, under a shadow", () => {
		const card = declarations(".exit-card");
		expect(card.get("background")).toBe("rgb(var(--nt-bg-rgb))");
		expect(card.get("color")).toBe("var(--nt-text-strong)");
		expect(card.get("border")).toBe("1px solid var(--nt-border)");
		expect(card.get("box-shadow")).toBe("var(--nt-shadow)");
		// The scrim behind stays neutral.
		expect(declarations(".exit-overlay").get("background")).toBe("var(--nt-overlay)");
	});

	// A hover that tinted a button's ground would take its text below the
	// contrast checked here.
	it("keeps the colours when a button is hovered", () => {
		const hovers = [...style.matchAll(/\n(\.exit-[^{\n]*:hover[^{\n]*)\{([^}]*)\}/g)];
		expect(hovers.length).toBeGreaterThan(0);
		for (const [, selector, block] of hovers) {
			expect(block, selector).not.toMatch(/(^|[\s;])(color|background|opacity)\s*:/);
		}
	});

	for (const [name, theme] of Object.entries(BUNDLED_THEMES)) {
		it(`reads at 4.5:1 or better in ${name}`, () => {
			setActivePinia(createPinia());
			useThemeStore().applyTheme(theme);
			for (const [what, rules] of Object.entries(texts)) {
				const { text, ground } = pair(rules);
				const fg = resolve(text);
				const bg = resolve(ground);
				if (fg === null || bg === null) throw new Error(`${what}: transparent`);
				const ratio = contrastRatio(fg, bg);
				expect(ratio, `${what} (${text} on ${ground}): ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(
					TEXT_CONTRAST_AA,
				);
			}
		});
	}
});
