/**
 * A window's id (#846): what the hub recognises a write lock's holder by when
 * its window comes back from a reload or a drop, the client id of every new
 * socket being new.
 *
 * Each "page" below is the module started afresh over the window's
 * sessionStorage, which a reload keeps and a new window starts without.
 */
import { isValidUlid } from "@lasterm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetWindowIdForTests, WINDOW_ID_KEY, windowId } from "./window-id.js";

/** A pagehide or pageshow, `persisted` set: happy-dom's PageTransitionEvent is a bare Event. */
function pageTransition(type: "pagehide" | "pageshow", persisted: boolean): Event {
	const event = new Event(type);
	Object.defineProperty(event, "persisted", { value: persisted });
	return event;
}

/** The page goes, as a reload or a closing tab makes it go. */
function leavePage(): void {
	window.dispatchEvent(pageTransition("pagehide", false));
	resetWindowIdForTests();
}

/** Everything in this window's sessionStorage, as a browser copies it into a duplicated tab. */
function storageCopy(): Array<[string, string]> {
	const entries: Array<[string, string]> = [];
	for (let i = 0; i < window.sessionStorage.length; i++) {
		const key = window.sessionStorage.key(i);
		if (key !== null) entries.push([key, window.sessionStorage.getItem(key) ?? ""]);
	}
	return entries;
}

describe("windowId", () => {
	beforeEach(() => {
		window.sessionStorage.clear();
		resetWindowIdForTests();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetWindowIdForTests();
		window.sessionStorage.clear();
	});

	it("is a ULID, the same for every connection the page opens", () => {
		const id = windowId();

		expect(isValidUlid(id)).toBe(true);
		expect(windowId()).toBe(id);
	});

	it("is the same after the page reloads", () => {
		const before = windowId();

		leavePage();

		expect(windowId()).toBe(before);
	});

	it("is another in a new window", () => {
		const first = windowId();

		// A new window starts with a sessionStorage of its own, empty.
		resetWindowIdForTests();
		window.sessionStorage.clear();

		expect(windowId()).not.toBe(first);
	});

	it("is another in a tab duplicated from this one", () => {
		const original = windowId();

		// Duplicating a tab copies its sessionStorage into the new one.
		const copied = storageCopy();
		resetWindowIdForTests();
		window.sessionStorage.clear();
		for (const [key, value] of copied) window.sessionStorage.setItem(key, value);

		expect(windowId()).not.toBe(original);
	});

	it("is taken out of storage again when the page comes back from the back-forward cache", () => {
		const id = windowId();
		window.dispatchEvent(pageTransition("pagehide", true));
		expect(window.sessionStorage.getItem(WINDOW_ID_KEY)).toBe(id);

		window.dispatchEvent(pageTransition("pageshow", true));

		expect(window.sessionStorage.getItem(WINDOW_ID_KEY)).toBeNull();
		expect(windowId()).toBe(id);
	});

	it("still has an id when storage is refused", () => {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new DOMException("denied", "SecurityError");
		});

		expect(isValidUlid(windowId())).toBe(true);
	});
});
