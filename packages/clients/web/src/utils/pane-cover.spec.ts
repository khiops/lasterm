import { describe, expect, it } from "vitest";
import { type PaneFacts, paneCover } from "./pane-cover.js";

const plain: PaneFacts = { status: "live", ended: false, gone: false, detached: false };

describe("paneCover", () => {
	it("lays nothing over a terminal the pane is attached to", () => {
		expect(paneCover(plain)).toBeNull();
	});

	it("says Not connected over a terminal answered from memory", () => {
		expect(paneCover({ ...plain, detached: true })).toBe("not-connected");
		// The status is often unknown there: the host is not the one in view.
		expect(paneCover({ ...plain, status: undefined, detached: true })).toBe("not-connected");
	});

	// A terminal that has ended is not waiting for a connection (#556).
	it("puts the exit overlay over the banner once the terminal is known to have ended", () => {
		expect(paneCover({ ...plain, status: "dead", detached: true })).toBe("exited");
		expect(paneCover({ ...plain, status: undefined, ended: true, detached: true })).toBe("exited");
	});

	it("says the terminal is gone over anything else", () => {
		expect(paneCover({ ...plain, status: "dead", ended: true, gone: true, detached: true })).toBe(
			"gone",
		);
	});
});
