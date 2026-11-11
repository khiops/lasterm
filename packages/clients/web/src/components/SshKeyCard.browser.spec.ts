/**
 * A key's algorithm badge, its ground and its border: the algorithm's theme
 * colour mixed into transparency, which happy-dom does not compute
 * (SshKeyCard.spec.ts checks its text). The card is drawn with its own rules,
 * over theme variables set to colours of the test's own.
 */
import { afterEach, describe, expect, it } from "vitest";
import { type App, createApp, h } from "vue";
import SshKeyCard from "./SshKeyCard.vue";

const VARIABLES: Record<string, string> = {
	"--nt-badge-info": "rgb(0, 0, 255)",
	"--nt-badge-success": "rgb(0, 255, 0)",
	"--nt-badge-warning": "rgb(255, 255, 0)",
	"--nt-badge-danger": "rgb(255, 0, 0)",
	"--nt-fg-muted": "rgb(255, 255, 255)",
};

let app: App | null = null;

afterEach(() => {
	app?.unmount();
	app = null;
	document.body.replaceChildren();
	document.documentElement.removeAttribute("style");
});

function badge(algorithm: string): CSSStyleDeclaration {
	for (const [name, value] of Object.entries(VARIABLES)) {
		document.documentElement.style.setProperty(name, value);
	}
	const root = document.createElement("div");
	document.body.appendChild(root);
	app = createApp({
		render: () =>
			h(SshKeyCard, { entry: { name: "id_test", type: "key", algorithm }, selected: false }),
	});
	app.mount(root);
	const found = [...root.querySelectorAll(".key-card-badge")].find(
		(el) => el.textContent === algorithm,
	);
	if (found === undefined) throw new Error(`no badge for ${algorithm}`);
	return getComputedStyle(found);
}

describe("SshKeyCard's algorithm badge", () => {
	// Its colour at 13 % for the ground and 30 % for the border, over nothing.
	it.each([
		["ED25519", "0 0 1"],
		["ECDSA", "0 1 0"],
		["RSA", "1 1 0"],
		["DSA", "1 0 0"],
		["SK-SSH-ED448", "1 1 1"],
	])("grounds and borders %s in its theme colour", (algorithm, rgb) => {
		const style = badge(algorithm);
		expect(style.backgroundColor).toBe(`color(srgb ${rgb} / 0.13)`);
		expect(style.borderTopColor).toBe(`color(srgb ${rgb} / 0.3)`);
	});
});
