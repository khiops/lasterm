import { describe, expect, it } from "vitest";
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
		const onRestart = /async function onRestart[\s\S]*?\n}\n/.exec(SOURCE)?.[0];
		expect(onRestart, "onRestart moved").toBeDefined();
		expect(onRestart).toMatch(/if \(ok\) \{[\s\S]*?hasEnded\.value = false;/);
		expect(SOURCE).toMatch(/status === 'live' \|\| status === 'born'\) hasEnded\.value = false/);
	});

	it("shows why a restart failed, and that one is under way", () => {
		expect(SOURCE).toContain("Could not restart it: {{ restartFailure }}");
		expect(SOURCE).toContain(':disabled="restarting"');
	});
});
