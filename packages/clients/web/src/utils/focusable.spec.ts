import { afterEach, describe, expect, it } from "vitest";
import { firstTabbable, isTabbable, tabbables, trapTab } from "./focusable.js";

afterEach(() => {
	document.body.replaceChildren();
});

/** A detail as a category draws it, into the page. */
function detail(html: string): HTMLElement {
	const root = document.createElement("div");
	root.innerHTML = html;
	document.body.appendChild(root);
	return root;
}

const ids = (elements: HTMLElement[]): string[] => elements.map((el) => el.id);

// Settings › Tabs began with a switch whose checkbox had no box, and Enter from the menu passed
// it over for the select after it (#637).
describe("what takes the keyboard", () => {
	it("counts a control whatever its size or its opacity", () => {
		const root = detail(`
			<label><input id="switch" type="checkbox" role="switch"
				style="position:absolute;opacity:0;width:0;height:0" /><span>track</span></label>
			<select id="position"><option>End</option></select>
		`);
		expect(ids(tabbables(root))).toEqual(["switch", "position"]);
		expect(firstTabbable(root)?.id).toBe("switch");
	});

	it("leaves out what the browser skips: display none, visibility hidden, disabled, inert, out of the Tab order", () => {
		const root = detail(`
			<button id="shown">Shown</button>
			<button id="none" style="display:none">None</button>
			<div style="display:none"><button id="in-none">In none</button></div>
			<button id="invisible" style="visibility:hidden">Invisible</button>
			<button id="disabled" disabled>Disabled</button>
			<fieldset disabled><input id="in-fieldset" /></fieldset>
			<div inert><button id="inert">Inert</button></div>
			<div hidden><button id="in-hidden">In hidden</button></div>
			<button id="roving" tabindex="-1">Roving</button>
			<input id="hidden-input" type="hidden" />
			<div id="div-in-order" tabindex="0">Div</div>
			<a id="link" href="#x">Link</a>
			<a id="no-href">Not a link</a>
		`);
		expect(ids(tabbables(root))).toEqual(["shown", "div-in-order", "link"]);
	});

	it("says so of one element", () => {
		const root = detail(`<input id="a" /><input id="b" disabled />`);
		expect(isTabbable(root.querySelector("#a") as HTMLElement)).toBe(true);
		expect(isTabbable(root.querySelector("#b") as HTMLElement)).toBe(false);
	});

	it("finds nothing in nothing", () => {
		expect(tabbables(null)).toEqual([]);
		expect(firstTabbable(detail("<p>text</p>"))).toBeNull();
	});
});

describe("trapTab", () => {
	function tab(target: HTMLElement, shiftKey = false): KeyboardEvent {
		const event = new KeyboardEvent("keydown", {
			key: "Tab",
			shiftKey,
			bubbles: true,
			cancelable: true,
		});
		Object.defineProperty(event, "target", { value: target });
		return event;
	}

	it("goes round inside a modal: from the last to the first, and back", () => {
		const root = detail(`<button id="a">A</button><input id="b" /><button id="c">C</button>`);
		const [a, , c] = tabbables(root) as [HTMLElement, HTMLElement, HTMLElement];
		c.focus();
		const forward = tab(c);
		expect(trapTab(forward, root)).toBe(true);
		expect(forward.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(a);
		const back = tab(a, true);
		expect(trapTab(back, root)).toBe(true);
		expect(document.activeElement).toBe(c);
	});

	it("leaves Tab between two controls to the browser", () => {
		const root = detail(
			`<button id="a">A</button><button id="b">B</button><button id="c">C</button>`,
		);
		const middle = root.querySelector("#b") as HTMLElement;
		const event = tab(middle);
		expect(trapTab(event, root)).toBe(false);
		expect(event.defaultPrevented).toBe(false);
	});
});
