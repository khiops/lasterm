import { describe, expect, it } from "vitest";
import { WriteLockManager } from "./write-lock.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeManager() {
	const sent: Array<{ to: string; msg: unknown }> = [];
	const broadcast: Array<{ channelId: string; msg: unknown }> = [];

	const mgr = new WriteLockManager({
		sendToClient: (clientId, msg) => sent.push({ to: clientId, msg }),
		broadcastToChannel: (channelId, msg) => broadcast.push({ channelId, msg }),
	});

	const sentTo = (clientId: string) => sent.filter((e) => e.to === clientId).map((e) => e.msg);
	const broadcastOn = (channelId: string) =>
		broadcast.filter((e) => e.channelId === channelId).map((e) => e.msg);
	const lastBroadcast = (channelId: string) => {
		const items = broadcastOn(channelId);
		return items[items.length - 1] ?? null;
	};

	return { mgr, sent, broadcast, sentTo, broadcastOn, lastBroadcast };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("WriteLockManager — attach / first-writer", () => {
	it("first client to attach becomes writer automatically", () => {
		const { mgr, lastBroadcast } = makeManager();
		mgr.attach("ch1", "client-A");

		expect(mgr.isHolder("ch1", "client-A")).toBe(true);
		expect(lastBroadcast("ch1")).toMatchObject({
			type: "WRITE_LOCK",
			channelId: "ch1",
			holder: "client-A",
		});
	});

	it("second client to attach does NOT get write lock", () => {
		const { mgr } = makeManager();
		mgr.attach("ch1", "client-A");
		mgr.attach("ch1", "client-B");

		expect(mgr.isHolder("ch1", "client-A")).toBe(true);
		expect(mgr.isHolder("ch1", "client-B")).toBe(false);
	});

	it("second client to attach receives WRITE_LOCK with current holder via sendToClient", () => {
		const { mgr, sentTo } = makeManager();
		mgr.attach("ch1", "client-A");
		mgr.attach("ch1", "client-B");

		const msgs = sentTo("client-B");
		expect(msgs).toHaveLength(1);
		expect(msgs[0]).toMatchObject({
			type: "WRITE_LOCK",
			channelId: "ch1",
			holder: "client-A",
		});
	});

	it("getHolder returns null when no one is attached", () => {
		const { mgr } = makeManager();
		expect(mgr.getHolder("ch1")).toBeNull();
	});

	it("getHolder returns the current holder", () => {
		const { mgr } = makeManager();
		mgr.attach("ch1", "client-A");
		expect(mgr.getHolder("ch1")).toBe("client-A");
	});
});

describe("WriteLockManager — isHolder", () => {
	it("isHolder returns true for the holder", () => {
		const { mgr } = makeManager();
		mgr.attach("ch1", "client-A");
		expect(mgr.isHolder("ch1", "client-A")).toBe(true);
	});

	it("isHolder returns false for non-holders", () => {
		const { mgr } = makeManager();
		mgr.attach("ch1", "client-A");
		mgr.attach("ch1", "client-B");
		expect(mgr.isHolder("ch1", "client-B")).toBe(false);
	});

	it("isHolder returns false when channel has no holder", () => {
		const { mgr } = makeManager();
		expect(mgr.isHolder("ch1", "client-A")).toBe(false);
	});
});

describe("WriteLockManager — isWriteLockHolder", () => {
	it("returns true when no lock holder exists (open channel)", () => {
		const { mgr } = makeManager();
		// No attach — no holder. Any client may write.
		expect(mgr.isWriteLockHolder("ch1", "client-A")).toBe(true);
	});

	it("returns true when the client is the holder", () => {
		const { mgr } = makeManager();
		mgr.attach("ch1", "client-A");
		expect(mgr.isWriteLockHolder("ch1", "client-A")).toBe(true);
	});

	it("returns false when another client holds the lock", () => {
		const { mgr } = makeManager();
		mgr.attach("ch1", "client-A");
		// client-B does not hold the lock
		expect(mgr.isWriteLockHolder("ch1", "client-B")).toBe(false);
	});

	it("returns true again after lock is released", () => {
		const { mgr } = makeManager();
		mgr.attach("ch1", "client-A");
		mgr.release("ch1", "client-A");
		// Lock released — open again, any client may write
		expect(mgr.isWriteLockHolder("ch1", "client-B")).toBe(true);
	});
});

describe("WriteLockManager — claim (Tier 1)", () => {
	it("claim on free lock grants immediately and broadcasts WRITE_LOCK", () => {
		const { mgr, lastBroadcast } = makeManager();
		mgr.claim("ch1", "client-A");

		expect(mgr.isHolder("ch1", "client-A")).toBe(true);
		expect(lastBroadcast("ch1")).toMatchObject({
			type: "WRITE_LOCK",
			channelId: "ch1",
			holder: "client-A",
		});
	});

	it("claim on held lock sends WRITE_REQUEST to the holder", () => {
		const { mgr, sentTo } = makeManager();
		mgr.attach("ch1", "client-A"); // A is auto-holder
		mgr.claim("ch1", "client-B");

		// B does NOT become holder
		expect(mgr.isHolder("ch1", "client-A")).toBe(true);
		expect(mgr.isHolder("ch1", "client-B")).toBe(false);

		// A receives a WRITE_REQUEST from B
		const msgs = sentTo("client-A");
		expect(msgs).toHaveLength(1);
		expect(msgs[0]).toMatchObject({
			type: "WRITE_REQUEST",
			channelId: "ch1",
			fromClientId: "client-B",
		});
	});

	it("claim by current holder is a no-op", () => {
		const { mgr, broadcast } = makeManager();
		mgr.attach("ch1", "client-A"); // broadcast[0]: WRITE_LOCK holder=A
		const countBefore = broadcast.length;
		mgr.claim("ch1", "client-A");
		expect(broadcast.length).toBe(countBefore); // no additional broadcast
	});
});

describe("WriteLockManager — grant (Tier 2)", () => {
	it("grant transfers lock and broadcasts WRITE_LOCK", () => {
		const { mgr, lastBroadcast } = makeManager();
		mgr.attach("ch1", "client-A");
		mgr.claim("ch1", "client-B"); // sends WRITE_REQUEST to A
		mgr.grant("ch1", "client-A", "client-B");

		expect(mgr.isHolder("ch1", "client-B")).toBe(true);
		expect(mgr.isHolder("ch1", "client-A")).toBe(false);
		expect(lastBroadcast("ch1")).toMatchObject({
			type: "WRITE_LOCK",
			channelId: "ch1",
			holder: "client-B",
		});
	});

	it("grant from non-holder is a no-op", () => {
		const { mgr, broadcast } = makeManager();
		mgr.attach("ch1", "client-A");
		const countBefore = broadcast.length;
		// client-B is not the holder — should be ignored
		mgr.grant("ch1", "client-B", "client-C");
		expect(broadcast.length).toBe(countBefore);
		expect(mgr.isHolder("ch1", "client-A")).toBe(true);
	});
});

describe("WriteLockManager — deny (Tier 2)", () => {
	it("deny sends WRITE_DENY to the requester", () => {
		const { mgr, sentTo } = makeManager();
		mgr.attach("ch1", "client-A");
		mgr.claim("ch1", "client-B");
		mgr.deny("ch1", "client-A", "client-B");

		const msgs = sentTo("client-B");
		expect(msgs).toHaveLength(1);
		expect(msgs[0]).toMatchObject({
			type: "WRITE_DENY",
			channelId: "ch1",
			toClientId: "client-B",
		});
		// Lock stays with A
		expect(mgr.isHolder("ch1", "client-A")).toBe(true);
	});

	it("deny from non-holder is a no-op", () => {
		const { mgr, sent } = makeManager();
		mgr.attach("ch1", "client-A");
		mgr.deny("ch1", "client-B", "client-C"); // B is not holder
		expect(sent).toHaveLength(0);
	});
});

describe("WriteLockManager — force (Tier 3)", () => {
	it("force takes lock, sends WRITE_REVOKED to old holder, and broadcasts WRITE_LOCK", () => {
		const { mgr, sentTo, lastBroadcast } = makeManager();
		mgr.attach("ch1", "client-A");
		mgr.force("ch1", "client-B");

		// Old holder receives WRITE_REVOKED
		const aMessages = sentTo("client-A");
		expect(aMessages).toHaveLength(1);
		expect(aMessages[0]).toMatchObject({
			type: "WRITE_REVOKED",
			channelId: "ch1",
		});

		// New holder is B
		expect(mgr.isHolder("ch1", "client-B")).toBe(true);
		expect(lastBroadcast("ch1")).toMatchObject({
			type: "WRITE_LOCK",
			channelId: "ch1",
			holder: "client-B",
		});
	});

	it("force on channel with no holder just grants the lock", () => {
		const { mgr, sent, lastBroadcast } = makeManager();
		mgr.force("ch1", "client-A");

		expect(sent).toHaveLength(0); // no WRITE_REVOKED sent
		expect(mgr.isHolder("ch1", "client-A")).toBe(true);
		expect(lastBroadcast("ch1")).toMatchObject({
			type: "WRITE_LOCK",
			channelId: "ch1",
			holder: "client-A",
		});
	});

	it("force by current holder does not send WRITE_REVOKED to self", () => {
		const { mgr, sent, broadcast } = makeManager();
		mgr.attach("ch1", "client-A"); // broadcast[0]
		const countBefore = broadcast.length;
		mgr.force("ch1", "client-A"); // should not revoke self

		// No WRITE_REVOKED sent
		expect(sent).toHaveLength(0);
		// But still broadcasts WRITE_LOCK (holder re-asserted)
		expect(broadcast.length).toBe(countBefore + 1);
		expect(mgr.isHolder("ch1", "client-A")).toBe(true);
	});
});

// A force is a security event only when it takes the lock from someone: that
// is the client who lost the keyboard, and the person asking afterwards who did.
describe("WriteLockManager — force is reported", () => {
	function makeReportingManager() {
		const forces: Array<{ channelId: string; byClientId: string; fromClientId: string }> = [];
		const mgr = new WriteLockManager({
			sendToClient: () => undefined,
			broadcastToChannel: () => undefined,
			onForce: (force) => forces.push(force),
		});
		return { mgr, forces };
	}

	it("names the channel, the client that forced and the client that held the lock", () => {
		const { mgr, forces } = makeReportingManager();
		mgr.attach("ch1", "client-A");
		mgr.force("ch1", "client-B");

		expect(forces).toEqual([
			{ channelId: "ch1", byClientId: "client-B", fromClientId: "client-A" },
		]);
	});

	it("says nothing when the lock was free or already the forcing client's", () => {
		const { mgr, forces } = makeReportingManager();
		mgr.force("ch1", "client-A");
		mgr.force("ch1", "client-A");

		expect(forces).toEqual([]);
	});
});

describe("WriteLockManager — release", () => {
	it("release clears lock and broadcasts WRITE_LOCK holder=null", () => {
		const { mgr, lastBroadcast } = makeManager();
		mgr.attach("ch1", "client-A");
		mgr.release("ch1", "client-A");

		expect(mgr.isHolder("ch1", "client-A")).toBe(false);
		expect(mgr.getHolder("ch1")).toBeNull();
		expect(lastBroadcast("ch1")).toMatchObject({
			type: "WRITE_LOCK",
			channelId: "ch1",
			holder: null,
		});
	});

	it("release by non-holder is a no-op", () => {
		const { mgr, broadcast } = makeManager();
		mgr.attach("ch1", "client-A");
		const countBefore = broadcast.length;
		mgr.release("ch1", "client-B"); // B is not the holder
		expect(broadcast.length).toBe(countBefore);
		expect(mgr.isHolder("ch1", "client-A")).toBe(true);
	});
});

describe("WriteLockManager — detach / disconnect", () => {
	it("holder detach releases lock and broadcasts WRITE_LOCK holder=null", () => {
		const { mgr, lastBroadcast } = makeManager();
		mgr.attach("ch1", "client-A");
		mgr.detach("ch1", "client-A");

		expect(mgr.getHolder("ch1")).toBeNull();
		expect(lastBroadcast("ch1")).toMatchObject({
			type: "WRITE_LOCK",
			channelId: "ch1",
			holder: null,
		});
	});

	it("non-holder detach does not affect the lock", () => {
		const { mgr, broadcast } = makeManager();
		mgr.attach("ch1", "client-A");
		mgr.attach("ch1", "client-B");
		const countBefore = broadcast.length;
		mgr.detach("ch1", "client-B"); // B is not the holder

		expect(broadcast.length).toBe(countBefore); // no extra broadcast
		expect(mgr.isHolder("ch1", "client-A")).toBe(true);
	});

	it("onClientDisconnect releases all locks held by that client", () => {
		const { mgr, lastBroadcast } = makeManager();
		mgr.attach("ch1", "client-A");
		mgr.attach("ch2", "client-A"); // A holds both
		mgr.onClientDisconnect("client-A");

		expect(mgr.getHolder("ch1")).toBeNull();
		expect(mgr.getHolder("ch2")).toBeNull();
		expect(lastBroadcast("ch1")).toMatchObject({ type: "WRITE_LOCK", holder: null });
		expect(lastBroadcast("ch2")).toMatchObject({ type: "WRITE_LOCK", holder: null });
	});

	it("onClientDisconnect of non-holder does not release any lock", () => {
		const { mgr, broadcast } = makeManager();
		mgr.attach("ch1", "client-A");
		const countBefore = broadcast.length;
		mgr.onClientDisconnect("client-B"); // B never held any lock
		expect(broadcast.length).toBe(countBefore);
		expect(mgr.isHolder("ch1", "client-A")).toBe(true);
	});
});

describe("WriteLockManager — removeChannel", () => {
	it("removeChannel cleans up all state for the channel", () => {
		const { mgr } = makeManager();
		mgr.attach("ch1", "client-A");
		mgr.removeChannel("ch1");

		expect(mgr.getHolder("ch1")).toBeNull();
		expect(mgr.isHolder("ch1", "client-A")).toBe(false);
	});
});

describe("WriteLockManager — shutdown", () => {
	it("shutdown clears all state", () => {
		const { mgr } = makeManager();
		mgr.attach("ch1", "client-A");
		mgr.attach("ch2", "client-B");
		mgr.shutdown();

		expect(mgr.getHolder("ch1")).toBeNull();
		expect(mgr.getHolder("ch2")).toBeNull();
	});
});

// ─── A freed lock finds the client that is still there ──────────────────────
//
// A lock arbitrates between people. With one client attached there is nobody
// to arbitrate with, and leaving it free means a terminal that refuses what is
// typed into it until someone finds the button (#465).

describe("WriteLockManager — a lock nobody holds", () => {
	it("goes to the one client left when the holder disconnects", () => {
		const { mgr, lastBroadcast } = makeManager();
		mgr.attach("ch1", "ghost");
		mgr.attach("ch1", "on-screen");

		mgr.onClientDisconnect("ghost");

		expect(mgr.getHolder("ch1")).toBe("on-screen");
		expect(lastBroadcast("ch1")).toEqual({
			type: "WRITE_LOCK",
			channelId: "ch1",
			holder: "on-screen",
		});
	});

	it("goes to the one client left when the holder detaches", () => {
		const { mgr } = makeManager();
		mgr.attach("ch1", "ghost");
		mgr.attach("ch1", "on-screen");

		mgr.detach("ch1", "ghost");

		expect(mgr.getHolder("ch1")).toBe("on-screen");
	});

	it("stays free when several clients are left, rather than choosing for them", () => {
		const { mgr } = makeManager();
		mgr.attach("ch1", "holder");
		mgr.attach("ch1", "watcher-1");
		mgr.attach("ch1", "watcher-2");

		mgr.onClientDisconnect("holder");

		expect(mgr.getHolder("ch1")).toBeNull();
	});

	it("leaves a channel nobody is attached to alone", () => {
		const { mgr } = makeManager();
		mgr.attach("ch1", "only");

		mgr.onClientDisconnect("only");

		expect(mgr.getHolder("ch1")).toBeNull();
	});
});
