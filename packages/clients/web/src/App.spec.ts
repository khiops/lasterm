import { describe, expect, it } from "vitest";
import SOURCE from "./App.vue?raw";
import { CONFIRMATIONS } from "./utils/confirmations.js";

/**
 * App.vue cannot be mounted here, so these read what it does with an ended
 * terminal. What that means — delete or keep, what the migration writes — is
 * tested in utils/exit-action.spec.ts.
 */

/** A function's body, from its declaration to its closing brace at column 0. */
function body(signature: RegExp): string {
	const text = SOURCE.replace(/\r\n/g, "\n");
	const found = new RegExp(`${signature.source}[\\s\\S]*?\\n}\\n`).exec(text)?.[0];
	if (found === undefined) throw new Error(`${signature.source} moved`);
	return found;
}

// "Delete this dead terminal?" is no longer asked: the overlay's options, and
// the setting, answer it (#574).
describe("closing an ended terminal asks nothing", () => {
	it("closes its pane at once, deleting it or keeping it as it was told", () => {
		const onClosePane = body(/function onClosePane\(/);
		expect(onClosePane).not.toContain("confirmDialog");
		expect(onClosePane).toContain("layout.closePane(channelId);");
		// The overlay says whether to keep it; elsewhere the setting does.
		expect(onClosePane).toContain(
			"const keep = ended?.keep ?? endedPrefs(configStore.uiConfig.panes).keepEnded;",
		);
		expect(onClosePane).toContain(
			"for (const id of endedToDelete([channelId], keep)) void channelsStore.deleteChannel(id);",
		);
		// A live terminal keeps running when its pane goes.
		expect(onClosePane).toMatch(/if \(!hasEnded\) return;/);
	});

	it("closes a tab over ended terminals as the keep setting says", () => {
		const onCloseTab = body(/function onCloseTab\(/);
		expect(onCloseTab).not.toContain("confirmDialog");
		expect(onCloseTab).toContain("layout.closeTab(index);");
		expect(onCloseTab).toContain("const keep = endedPrefs(configStore.uiConfig.panes).keepEnded;");
		expect(onCloseTab).toContain(
			"for (const id of endedToDelete(deadIds, keep)) void channelsStore.deleteChannel(id);",
		);
	});

	it("no longer knows the old question, nor lists it among the confirmations", () => {
		expect(SOURCE).not.toContain("ConfirmCloseDeadTab");
		expect(SOURCE).not.toContain("'Close and delete'");
		expect(CONFIRMATIONS.map((entry) => entry.key)).not.toContain("ConfirmCloseDeadTab");
	});
});

describe("the old answer becomes the setting", () => {
	// Once the UI config is read, whichever way the app started.
	it("is carried over after every load of the UI config at startup", () => {
		const text = SOURCE.replace(/\r\n/g, "\n");
		const loads = [
			...text.matchAll(/await configStore\.loadUiConfig\(\);\n\s*void migrateDeadTabChoice\(\);/g),
		];
		expect(loads).toHaveLength(2);
		expect(body(/async function migrateDeadTabChoice\(/)).toContain(
			"(values) => configStore.saveUiSettings('panes', values),",
		);
	});
});
