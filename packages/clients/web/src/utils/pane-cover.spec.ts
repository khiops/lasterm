import { describe, expect, it } from "vitest";
import { factsFromAttachOk, factsFromRefusal, type PaneFacts, paneCover } from "./pane-cover.js";

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

// What each answer to an ATTACH leaves the pane knowing. A pane attaches again
// when its socket comes back, and the answer it gets then has to replace what
// the one before it said, whichever way it went (#559).
describe("what an answer to an ATTACH says", () => {
	const covered = (status: PaneFacts["status"], answer: ReturnType<typeof factsFromAttachOk>) =>
		paneCover({ status, ...answer });

	it("an answer from the terminal clears the banner and the overlay", () => {
		expect(factsFromAttachOk(false)).toEqual({ ended: false, gone: false, detached: false });
		expect(covered("live", factsFromAttachOk(false))).toBeNull();
	});

	it("an answer from memory is the banner, and says nothing ended", () => {
		expect(factsFromAttachOk(true)).toEqual({ ended: false, gone: false, detached: true });
		expect(covered("orphan", factsFromAttachOk(true))).toBe("not-connected");
	});

	it("a refusal says the terminal ended, or that the hub has no record of it", () => {
		const ended = factsFromRefusal("CHANNEL_DEAD");
		const gone = factsFromRefusal("CHANNEL_NOT_FOUND");
		expect(ended).toEqual({ ended: true, gone: false, detached: false });
		expect(gone).toEqual({ ended: false, gone: true, detached: false });
		// Whatever the pane last heard of it: a terminal that ended while its
		// socket was away was still "live" here.
		if (ended === null || gone === null) throw new Error("expected answers");
		expect(covered("live", ended)).toBe("exited");
		expect(covered("live", gone)).toBe("gone");
	});

	// A timeout or a lost socket is not the hub speaking about the terminal.
	it("any other failure is no answer, and changes nothing", () => {
		expect(factsFromRefusal(undefined)).toBeNull();
		expect(factsFromRefusal("AGENT_ERROR")).toBeNull();
	});
});
