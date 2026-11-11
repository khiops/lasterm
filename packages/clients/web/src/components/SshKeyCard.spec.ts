/**
 * A key's algorithm badge, in the theme's colour for that algorithm. The card is
 * drawn with its own rules, over theme variables the test sets to colours of its
 * own, so the colour read back says which variable the badge took.
 */
import { afterEach, describe, expect, it } from "vitest";
import { type App, createApp, h } from "vue";
import SshKeyCard from "./SshKeyCard.vue";

const VARIABLES: Record<string, string> = {
	"--nt-badge-info": "rgb(1, 2, 3)",
	"--nt-badge-success": "rgb(4, 5, 6)",
	"--nt-badge-warning": "rgb(7, 8, 9)",
	"--nt-badge-danger": "rgb(10, 11, 12)",
	"--nt-fg-muted": "rgb(13, 14, 15)",
};

let app: App | null = null;

afterEach(() => {
	app?.unmount();
	app = null;
	document.body.replaceChildren();
	document.documentElement.removeAttribute("style");
});

function badgeColour(algorithm: string): string {
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
	const badge = [...root.querySelectorAll(".key-card-badge")].find(
		(el) => el.textContent === algorithm,
	);
	if (badge === undefined) throw new Error(`no badge for ${algorithm}`);
	return getComputedStyle(badge).color;
}

describe("SshKeyCard's algorithm badge", () => {
	// The names the hub gives (mapAlgorithm, api/ssh-keys.ts), and one it passes through.
	it.each([
		["ED25519", "rgb(1, 2, 3)"],
		["ECDSA", "rgb(4, 5, 6)"],
		["RSA", "rgb(7, 8, 9)"],
		["DSA", "rgb(10, 11, 12)"],
		["SK-SSH-ED448", "rgb(13, 14, 15)"],
	])("draws %s in its theme colour", (algorithm, colour) => {
		expect(badgeColour(algorithm)).toBe(colour);
	});
});
