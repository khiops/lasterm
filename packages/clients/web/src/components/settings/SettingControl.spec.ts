/**
 * A setting's control from the keyboard (#637). The switch's checkbox had no box — opacity 0 and
 * a size of 0 — so the keyboard's place on it could not be seen, and Enter from the Settings menu
 * passed it over. It now covers its track, is a switch, and shows the theme's ring on the track.
 * Every control is named by its row's label.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick, ref } from "vue";
import SettingControl from "./SettingControl.vue";
import SOURCE from "./SettingControl.vue?raw";
import SettingRow from "./SettingRow.vue";

let app: App | null = null;
let root: HTMLElement;

afterEach(() => {
	app?.unmount();
	app = null;
	root?.remove();
});

/** A row of Settings holding one control, as the categories draw them. */
function mountRow(type: "toggle" | "select" | "text", initial: unknown) {
	const value = ref(initial);
	const updates = vi.fn((next: unknown) => {
		value.value = next;
	});
	root = document.createElement("div");
	document.body.appendChild(root);
	app = createApp({
		render: () =>
			h(SettingRow, { label: "Close Button", scope: "global", isOverridden: true }, () =>
				h(SettingControl, {
					type,
					modelValue: value.value,
					options: [{ label: "End", value: "end" }],
					"onUpdate:modelValue": updates,
				}),
			),
	});
	app.mount(root);
	return { value, updates };
}

const switchInput = (): HTMLInputElement =>
	root.querySelector('input[type="checkbox"]') as HTMLInputElement;

/** The CSS rule for `selector`, from the component's own style block. */
function rule(selector: string): string {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`${escaped}\\s*\\{[^}]*\\}`).exec(SOURCE)?.[0] ?? "";
}

describe("the switch", () => {
	it("is a checkbox with the role of a switch, named by its row", () => {
		mountRow("toggle", false);
		const input = switchInput();
		expect(input.getAttribute("role")).toBe("switch");
		expect(input.checked).toBe(false);
		const label = document.getElementById(input.getAttribute("aria-labelledby") ?? "");
		expect(label?.textContent).toBe("Close Button");
	});

	it("takes the keyboard", () => {
		mountRow("toggle", true);
		const input = switchInput();
		input.focus();
		expect(document.activeElement).toBe(input);
		expect(input.tabIndex).toBe(0);
	});

	// Space is a checkbox's own key: the browser turns it, and nothing here stands in its way.
	it("turns with Space, which the page leaves to the browser, and on a click", async () => {
		const { updates } = mountRow("toggle", false);
		const input = switchInput();
		input.focus();
		const space = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
		input.dispatchEvent(space);
		expect(space.defaultPrevented).toBe(false);
		// What Space does to a checkbox: its activation, a click.
		input.click();
		await nextTick();
		expect(updates).toHaveBeenLastCalledWith(true);
		expect(switchInput().checked).toBe(true);
	});

	// A checkbox does not turn on Enter, and neither does this switch: Space only.
	it("does not turn on Enter", async () => {
		const { updates } = mountRow("toggle", false);
		const input = switchInput();
		input.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
		);
		await nextTick();
		expect(updates).not.toHaveBeenCalled();
	});

	it("has a box: the checkbox covers the track, invisible", () => {
		const input = rule(".control-toggle input");
		expect(input).toMatch(/inset:\s*0/);
		expect(input).toMatch(/width:\s*100%/);
		expect(input).toMatch(/height:\s*100%/);
		expect(input).toMatch(/opacity:\s*0/);
		expect(input).not.toMatch(/width:\s*0[;\s]/);
		expect(rule(".control-toggle")).toMatch(/position:\s*relative/);
	});

	it("shows the keyboard's place on its track, in the theme's accent", () => {
		const ring = rule(".control-toggle input:focus-visible + .toggle-track");
		expect(ring).toMatch(/outline:\s*2px solid var\(--nt-accent\)/);
	});
});

describe("the other controls", () => {
	it("are named by their row's label", () => {
		mountRow("select", "end");
		const select = root.querySelector("select") as HTMLSelectElement;
		expect(document.getElementById(select.getAttribute("aria-labelledby") ?? "")?.textContent).toBe(
			"Close Button",
		);
	});

	it("have no name to borrow outside a row", () => {
		root = document.createElement("div");
		document.body.appendChild(root);
		app = createApp({ render: () => h(SettingControl, { type: "text", modelValue: "x" }) });
		app.mount(root);
		expect(root.querySelector("input")?.hasAttribute("aria-labelledby")).toBe(false);
	});
});
