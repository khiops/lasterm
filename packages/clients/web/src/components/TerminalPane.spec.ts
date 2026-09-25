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

	it("shows why a restart failed, and that one is under way", () => {
		expect(SOURCE).toContain("Could not restart it: {{ restartFailure }}");
		expect(SOURCE).toContain(':disabled="restarting"');
	});
});

describe("TerminalPane after a Reconnect (#556)", () => {
	// One decision for the banner and the overlay, so the pane cannot say "Not
	// connected" over a terminal it knows has ended.
	it("covers its terminal with what paneCover decides", () => {
		expect(SOURCE).toMatch(/v-if="cover === 'not-connected'" class="detached-banner"/);
		expect(SOURCE).toMatch(/v-if="cover === 'exited' \|\| cover === 'gone'" class="exit-overlay"/);
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
		expect(reportWatcher).toContain("onTerminalEnded(endWatch.ended(chId))");

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
		expect(onEnded).toContain("reactToEnd(prefs.value,");
		expect(onEnded).toContain("directProcess: isDirectProcess.value");
		expect(onEnded).toContain("writer: isWriter.value");
		expect(onEnded).toContain("if (reaction.kind === 'restart') void onRestart();");
		expect(onEnded).toContain("else closeEnded(reaction.keep);");
		expect(SOURCE).toContain(
			"const prefs = computed(() => endedPrefs(configStore.uiConfig.panes));",
		);
		expect(SOURCE).toContain(
			'<p v-if="heldBack !== null && !isGone" class="exit-reason">{{ heldBackText }}</p>',
		);
	});
});

describe("TerminalPane overlay (#574)", () => {
	const overlay =
		/<div v-if="cover === 'exited' \|\| cover === 'gone'" class="exit-overlay">[\s\S]*?\n\t\t<\/div>\n/.exec(
			SOURCE.replace(/\r\n/g, "\n"),
		)?.[0] ?? "";

	// No second dialog: Close carries its options, and the pane says which.
	it("closes at once, with the keep option beside it", () => {
		expect(overlay, "the overlay moved").not.toBe("");
		expect(overlay).toContain(`@click="onOverlayAction('close')"`);
		expect(overlay).toContain(`@click="onOverlayAction('restart')"`);
		const onAction = body(/function onOverlayAction\(/);
		expect(onAction).toContain("keep: keepChoice.value");
		expect(onAction).toContain("else closeEnded(act.keep);");
		expect(body(/function closeEnded\(/)).toContain("emit('close-pane', chId, { keep });");
	});

	it('writes the setting when "Always do this" is ticked', () => {
		const onAction = body(/function onOverlayAction\(/);
		expect(onAction).toContain("overlayChoice(action,");
		expect(onAction).toContain("always: alwaysChoice.value");
		expect(onAction).toContain(
			"if (remember !== null) void configStore.saveUiSettings('panes', remember);",
		);
	});

	// Labels tied to their inputs, so a click on the words and a screen reader
	// both reach the checkbox.
	it("labels each checkbox", () => {
		for (const [suffix, words, model] of [
			["keep", "Keep in the sidebar", "keepChoice"],
			["always", "Always do this", "alwaysChoice"],
		] as const) {
			const label = new RegExp(
				`<label class="exit-option" :for="\`\\$\\{exitId\\}-${suffix}\`">\\s*<input :id="\`\\$\\{exitId\\}-${suffix}\`" v-model="${model}" type="checkbox" />\\s*${words}\\s*</label>`,
			);
			expect(overlay).toMatch(label);
		}
	});

	it("starts its options from the setting, and gives the keyboard to its card", () => {
		expect(SOURCE).toContain("keepChoice.value = prefs.value.keepEnded;");
		expect(SOURCE).toContain("alwaysChoice.value = false;");
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
		button: [".exit-card", ".exit-btn"],
		Restart: [".exit-card", ".exit-btn", ".exit-btn--primary"],
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
