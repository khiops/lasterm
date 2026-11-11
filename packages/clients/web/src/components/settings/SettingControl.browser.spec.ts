/**
 * The switch's box (#637, #936). Its checkbox had no box, so the keyboard's place on it could not
 * be seen and a click on the track reached nothing of it. This takes layout and hit-testing,
 * which happy-dom does not do, so it runs in a browser: the row mounted with its own rules.
 */
import { afterEach, expect, it } from "vitest";
import { type App, createApp, h } from "vue";
import "../../styles/base.css";
import SettingControl from "./SettingControl.vue";
import SettingRow from "./SettingRow.vue";

let app: App | null = null;

afterEach(() => {
	app?.unmount();
	app = null;
	document.body.replaceChildren();
});

it("has a box: the checkbox covers the track, invisible, and takes a click on it", () => {
	const root = document.createElement("div");
	document.body.appendChild(root);
	app = createApp({
		render: () =>
			h(SettingRow, { label: "Close Button", scope: "global", isOverridden: true }, () =>
				h(SettingControl, { type: "toggle", modelValue: false }),
			),
	});
	app.mount(root);
	const input = root.querySelector('input[role="switch"]') as HTMLInputElement;
	const track = root.querySelector(".toggle-track") as HTMLElement;

	const box = input.getBoundingClientRect();
	const shown = track.getBoundingClientRect();
	expect(shown.width).toBeGreaterThan(0);
	expect([box.left, box.top, box.width, box.height]).toEqual([
		shown.left,
		shown.top,
		shown.width,
		shown.height,
	]);
	// Over the track, but not drawn: the track is what shows.
	expect(getComputedStyle(input).opacity).toBe("0");
	const centre = document.elementFromPoint(
		shown.left + shown.width / 2,
		shown.top + shown.height / 2,
	);
	expect(centre).toBe(input);
});
