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
