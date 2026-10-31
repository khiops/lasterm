/**
 * A file dropped on a terminal pane (#822): the pane accepts every drag, for the
 * panes moved onto it, and ignored the file, so the browser opened it in a new
 * tab. On the desktop that request made the IPC fetches in flight fail, and
 * Tauri then fell back to postMessage for good. The guard prevents what nobody
 * took, after the elements' own handlers have run.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFileDropGuard } from "./file-drop-guard.js";

type FakeTransfer = { types: string[]; dropEffect: string };

function dragEvent(
	type: "dragover" | "drop",
	types: string[],
): DragEvent & { dataTransfer: FakeTransfer } {
	const event = new Event(type, { bubbles: true, cancelable: true });
	Object.defineProperty(event, "dataTransfer", { value: { types, dropEffect: "copy" } });
	return event as DragEvent & { dataTransfer: FakeTransfer };
}

describe("installFileDropGuard", () => {
	let removeGuard: () => void = () => {};
	let zone: HTMLDivElement;

	beforeEach(() => {
		zone = document.createElement("div");
		document.body.appendChild(zone);
		removeGuard = installFileDropGuard(window);
	});

	afterEach(() => {
		removeGuard();
		zone.remove();
	});

	it("keeps a file dropped on a terminal pane from being opened", () => {
		// What PaneLayout does: accept every drag, act only on a moved pane.
		zone.addEventListener("dragover", (event) => event.preventDefault());
		zone.addEventListener("drop", () => {});

		const drop = dragEvent("drop", ["Files"]);
		zone.dispatchEvent(drop);

		expect(drop.defaultPrevented).toBe(true);
	});

	it("refuses a file dragged where nothing takes it, and prevents its drop", () => {
		const over = dragEvent("dragover", ["Files"]);
		zone.dispatchEvent(over);
		const drop = dragEvent("drop", ["Files"]);
		zone.dispatchEvent(drop);

		expect(over.defaultPrevented).toBe(true);
		expect(over.dataTransfer.dropEffect).toBe("none");
		expect(drop.defaultPrevented).toBe(true);
	});

	it("leaves a zone that takes files to show that it does", () => {
		zone.addEventListener("dragover", (event) => event.preventDefault());

		const over = dragEvent("dragover", ["Files"]);
		zone.dispatchEvent(over);

		expect(over.dataTransfer.dropEffect).toBe("copy");
	});

	it("does not touch the page's own pane and tab drags", () => {
		const over = dragEvent("dragover", ["text/x-lasterm-pane"]);
		zone.dispatchEvent(over);
		const drop = dragEvent("drop", ["text/x-lasterm-pane"]);
		zone.dispatchEvent(drop);

		expect(over.defaultPrevented).toBe(false);
		expect(drop.defaultPrevented).toBe(false);
	});

	it("keeps a dropped link from being opened, but leaves it to a text field", () => {
		const onZone = dragEvent("drop", ["text/uri-list", "text/plain"]);
		zone.dispatchEvent(onZone);
		const field = document.createElement("input");
		zone.appendChild(field);
		const onField = dragEvent("drop", ["text/uri-list", "text/plain"]);
		field.dispatchEvent(onField);

		expect(onZone.defaultPrevented).toBe(true);
		expect(onField.defaultPrevented).toBe(false);
	});

	it("stops guarding once removed", () => {
		removeGuard();
		const drop = dragEvent("drop", ["Files"]);
		zone.dispatchEvent(drop);

		expect(drop.defaultPrevented).toBe(false);
	});
});
