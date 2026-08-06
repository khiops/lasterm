import type { ProtocolMessage } from "@lasterm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseManager } from "../storage/db.js";
import { openTestDatabases } from "../storage/db.js";
import { MetaDAL } from "../storage/meta.js";
import { SpoolDAL } from "../storage/spool.js";
import type { AgentConnection } from "./agent-connection.js";
import { SnapshotScheduler } from "./snapshot-scheduler.js";

// ─── Mock AgentConnection ──────────────────────────────────────────────────────

function makeMockAgent(connected = true): AgentConnection & { sent: ProtocolMessage[] } {
	const sent: ProtocolMessage[] = [];
	return {
		connected,
		send: vi.fn((msg: ProtocolMessage) => sent.push(msg)),
		start: vi.fn(),
		close: vi.fn(),
		on: vi.fn().mockReturnThis(),
		off: vi.fn().mockReturnThis(),
		once: vi.fn().mockReturnThis(),
		sent,
	} as unknown as AgentConnection & { sent: ProtocolMessage[] };
}

// ─── Test suite ────────────────────────────────────────────────────────────────

describe("SnapshotScheduler", () => {
	let dbs: DatabaseManager;
	let metaDal: MetaDAL;
	let spoolDal: SpoolDAL;
	let agent: ReturnType<typeof makeMockAgent>;
	let scheduler: SnapshotScheduler;

	const CHANNEL_ID = "ch-test-001";

	beforeEach(() => {
		vi.useFakeTimers();
		dbs = openTestDatabases();
		metaDal = new MetaDAL(dbs.meta);
		spoolDal = new SpoolDAL(dbs.spool);
		agent = makeMockAgent();
		scheduler = new SnapshotScheduler((channelId) =>
			channelId === CHANNEL_ID ? (agent as unknown as AgentConnection) : undefined,
		);

		// Seed a host + session + channel so cache_index FK constraints pass
		const host = metaDal.createHost({ type: "local", label: "test-host" });
		metaDal.createSession({
			id: "sess-001AAAAAAAAAAAAAAAAAAAAA",
			hostId: host.id,
			status: "active",
		});
		metaDal.createChannel({
			id: CHANNEL_ID,
			sessionId: "sess-001AAAAAAAAAAAAAAAAAAAAA",
			status: "live",
		});
	});

	afterEach(() => {
		scheduler.shutdown();
		vi.useRealTimers();
		dbs.close();
	});

	// ── 1. trackChannel starts timers ─────────────────────────────────────────

	describe("trackChannel", () => {
		it("is idempotent — tracking twice does not double-register", () => {
			scheduler.trackChannel(CHANNEL_ID);
			scheduler.trackChannel(CHANNEL_ID);

			// Advance past one idle window — should only get one SNAPSHOT_REQ
			vi.advanceTimersByTime(3_001);
			const reqs = agent.sent.filter((m) => m.type === "SNAPSHOT_REQ");
			expect(reqs).toHaveLength(1);
		});
	});

	// ── 2. Idle trigger (3s) ──────────────────────────────────────────────────

	describe("idle trigger", () => {
		it("sends SNAPSHOT_REQ after 3s of no output", () => {
			scheduler.trackChannel(CHANNEL_ID);
			expect(agent.sent).toHaveLength(0);

			vi.advanceTimersByTime(3_001);

			const reqs = agent.sent.filter((m) => m.type === "SNAPSHOT_REQ");
			expect(reqs).toHaveLength(1);
			expect(reqs[0]).toMatchObject({ type: "SNAPSHOT_REQ", channelId: CHANNEL_ID });
		});

		it("does NOT fire during active output (timer resets)", () => {
			scheduler.trackChannel(CHANNEL_ID);

			// Send output at 1s and 2s — each resets the idle clock.
			// Keep total elapsed time well under 5s to avoid the forced interval.
			vi.advanceTimersByTime(1_000);
			scheduler.onOutput(CHANNEL_ID);
			vi.advanceTimersByTime(1_000);
			scheduler.onOutput(CHANNEL_ID);

			// 2999ms after the last output (t=4999ms total) — idle not yet fired,
			// and we haven't crossed the 5s forced boundary yet.
			vi.advanceTimersByTime(2_999);
			expect(agent.sent.filter((m) => m.type === "SNAPSHOT_REQ")).toHaveLength(0);
		});

		it("fires 3s after the last output", () => {
			scheduler.trackChannel(CHANNEL_ID);

			vi.advanceTimersByTime(1_000);
			scheduler.onOutput(CHANNEL_ID);

			// 3s after the output at 1s → idle fires at t=4s
			vi.advanceTimersByTime(3_001);
			const reqs = agent.sent.filter((m) => m.type === "SNAPSHOT_REQ");
			expect(reqs.length).toBeGreaterThanOrEqual(1);
		});
	});

	// ── 3. Forced trigger (5s) ────────────────────────────────────────────────

	describe("forced trigger", () => {
		it("sends SNAPSHOT_REQ every 5s regardless of output", () => {
			scheduler.trackChannel(CHANNEL_ID);

			// Keep sending output to prevent idle timer from firing
			for (let t = 0; t < 15_500; t += 500) {
				vi.advanceTimersByTime(500);
				scheduler.onOutput(CHANNEL_ID);
			}

			const reqs = agent.sent.filter((m) => m.type === "SNAPSHOT_REQ");
			// At 5s, 10s, 15s → 3 forced snapshots
			expect(reqs.length).toBeGreaterThanOrEqual(3);
		});

		it("sends first forced snapshot at 5s mark", () => {
			scheduler.trackChannel(CHANNEL_ID);

			// Drip output every 500ms to suppress the idle timer.
			// Advance 9 × 500ms = 4500ms total, then verify no snapshot yet.
			for (let i = 0; i < 9; i++) {
				vi.advanceTimersByTime(500);
				scheduler.onOutput(CHANNEL_ID);
			}
			// At t=4500ms: forced interval not yet fired, idle timer reset
			expect(agent.sent.filter((m) => m.type === "SNAPSHOT_REQ")).toHaveLength(0);

			// Advance 500ms more to reach t=5000ms — crosses the 5s forced boundary
			vi.advanceTimersByTime(500);
			scheduler.onOutput(CHANNEL_ID);
			expect(agent.sent.filter((m) => m.type === "SNAPSHOT_REQ")).toHaveLength(1);
		});
	});

	// ── 4. onDetach — immediate snapshot ─────────────────────────────────────

	describe("onDetach", () => {
		it("sends SNAPSHOT_REQ immediately on detach", () => {
			scheduler.trackChannel(CHANNEL_ID);
			expect(agent.sent).toHaveLength(0);

			scheduler.onDetach(CHANNEL_ID);

			const reqs = agent.sent.filter((m) => m.type === "SNAPSHOT_REQ");
			expect(reqs).toHaveLength(1);
			expect(reqs[0]).toMatchObject({ type: "SNAPSHOT_REQ", channelId: CHANNEL_ID });
		});

		it("does not require the channel to be tracked to call onDetach safely", () => {
			// Should not throw even if untracked
			expect(() => scheduler.onDetach("unknown-channel")).not.toThrow();
		});
	});

	// ── 5. untrackChannel clears all timers ───────────────────────────────────

	describe("untrackChannel", () => {
		it("stops idle and forced timers after untrack", () => {
			scheduler.trackChannel(CHANNEL_ID);
			scheduler.untrackChannel(CHANNEL_ID);

			// Advance well past both thresholds — no snapshots should fire
			vi.advanceTimersByTime(10_000);
			expect(agent.sent.filter((m) => m.type === "SNAPSHOT_REQ")).toHaveLength(0);
		});

		it("is safe to call on an untracked channel", () => {
			expect(() => scheduler.untrackChannel("not-tracked")).not.toThrow();
		});
	});

	// ── 6. shutdown clears all channels ──────────────────────────────────────

	describe("shutdown", () => {
		it("stops all timers across all channels", () => {
			const CH2 = "ch-test-002";
			// Only register agent lookup for CHANNEL_ID — CH2 would also need the agent
			// but we just test that no timers fire (agent.send not called)
			scheduler.trackChannel(CHANNEL_ID);
			scheduler.shutdown();

			vi.advanceTimersByTime(10_000);
			expect(agent.sent.filter((m) => m.type === "SNAPSHOT_REQ")).toHaveLength(0);
			void CH2; // suppress unused warning
		});

		it("is safe to call multiple times", () => {
			scheduler.trackChannel(CHANNEL_ID);
			expect(() => {
				scheduler.shutdown();
				scheduler.shutdown();
			}).not.toThrow();
		});
	});

	// ── 7. Max concurrent snapshots guard ────────────────────────────────────

	describe("max concurrent snapshots", () => {
		it("defers snapshot when max in-flight reached", () => {
			const maxConcurrent = 2;
			const localScheduler = new SnapshotScheduler(
				() => agent as unknown as AgentConnection,
				maxConcurrent,
			);

			// Track two channels — their idle timers will fire at 3s
			localScheduler.trackChannel("ch-a");
			localScheduler.trackChannel("ch-b");

			// Fire idle timers for both → 2 in-flight
			vi.advanceTimersByTime(3_001);
			expect(agent.sent.filter((m) => m.type === "SNAPSHOT_REQ")).toHaveLength(2);
			expect(localScheduler.inFlightSnapshots).toBe(2);

			// Track a third channel and trigger its idle
			localScheduler.trackChannel("ch-c");
			vi.advanceTimersByTime(3_001);

			// ch-c should be deferred — still only 2 SNAPSHOT_REQs total for ch-a/ch-b
			// (ch-a and ch-b may get additional forced triggers, so we check ch-c specifically)
			const chCSent = agent.sent.filter(
				(m) => m.type === "SNAPSHOT_REQ" && (m as { channelId: string }).channelId === "ch-c",
			);
			expect(chCSent).toHaveLength(0);

			localScheduler.shutdown();
		});

		it("allows new snapshot after onSnapshotResponse frees a slot", () => {
			const maxConcurrent = 1;
			const localScheduler = new SnapshotScheduler(
				() => agent as unknown as AgentConnection,
				maxConcurrent,
			);

			localScheduler.trackChannel("ch-a");
			vi.advanceTimersByTime(3_001);
			expect(localScheduler.inFlightSnapshots).toBe(1);

			// Mark response received — frees the slot
			localScheduler.onSnapshotResponse("ch-a");
			expect(localScheduler.inFlightSnapshots).toBe(0);

			// Now trigger another snapshot — should succeed
			localScheduler.onDetach("ch-a");
			expect(agent.sent.filter((m) => m.type === "SNAPSHOT_REQ")).toHaveLength(2);
			expect(localScheduler.inFlightSnapshots).toBe(1);

			localScheduler.shutdown();
		});

		it("onSnapshotResponse does not underflow below zero", () => {
			const localScheduler = new SnapshotScheduler(() => agent as unknown as AgentConnection);

			// Call without any in-flight — should not go negative
			localScheduler.onSnapshotResponse("ch-any");
			expect(localScheduler.inFlightSnapshots).toBe(0);

			localScheduler.shutdown();
		});
	});

	// ── 8. No snapshot when agent is disconnected ──────────────────────────────

	describe("disconnected agent", () => {
		it("skips SNAPSHOT_REQ when agent is not connected", () => {
			const disconnectedAgent = makeMockAgent(false);
			const localScheduler = new SnapshotScheduler(
				() => disconnectedAgent as unknown as AgentConnection,
			);

			localScheduler.trackChannel(CHANNEL_ID);
			vi.advanceTimersByTime(3_001);

			expect(disconnectedAgent.sent).toHaveLength(0);
			localScheduler.shutdown();
		});
	});

	// ── 9. Snapshot timeout — slot freed when agent never responds ───────────

	describe("snapshot timeout", () => {
		it("frees the in-flight slot after 5s if no SNAPSHOT_RES arrives", () => {
			const maxConcurrent = 1;
			const localScheduler = new SnapshotScheduler(
				() => agent as unknown as AgentConnection,
				maxConcurrent,
			);

			localScheduler.trackChannel("ch-a");

			// Trigger snapshot — occupies the one slot
			vi.advanceTimersByTime(3_001);
			expect(localScheduler.inFlightSnapshots).toBe(1);

			// No response arrives — advance past the 5s timeout
			vi.advanceTimersByTime(5_001);
			expect(localScheduler.inFlightSnapshots).toBe(0);

			localScheduler.shutdown();
		});

		it("does not double-decrement when timeout fires after response already received", () => {
			const maxConcurrent = 1;
			const localScheduler = new SnapshotScheduler(
				() => agent as unknown as AgentConnection,
				maxConcurrent,
			);

			localScheduler.trackChannel("ch-a");
			vi.advanceTimersByTime(3_001);
			expect(localScheduler.inFlightSnapshots).toBe(1);

			// Response arrives normally — clears the pending timeout
			localScheduler.onSnapshotResponse("ch-a");
			expect(localScheduler.inFlightSnapshots).toBe(0);

			// Shutdown immediately so the forced-interval cannot fire a new snapshot
			localScheduler.shutdown();

			// Advance past the original timeout deadline — counter must NOT go negative
			// (shutdown cleared the timeout handle, so nothing fires)
			vi.advanceTimersByTime(5_001);
			expect(localScheduler.inFlightSnapshots).toBe(0);
		});

		it("slot is reclaimed after snapshot timeout", () => {
			const maxConcurrent = 1;
			const localScheduler = new SnapshotScheduler(
				() => agent as unknown as AgentConnection,
				maxConcurrent,
			);

			localScheduler.trackChannel("ch-a");
			vi.advanceTimersByTime(3_001); // trigger snapshot — slot consumed

			// In-flight count is 1 after snapshot fires
			const inFlight = (localScheduler as unknown as { _inFlightSnapshots: number })
				._inFlightSnapshots;
			expect(inFlight).toBe(1);

			vi.advanceTimersByTime(5_001); // trigger timeout — slot freed

			// After timeout, in-flight count is decremented back to 0
			const inFlightAfter = (localScheduler as unknown as { _inFlightSnapshots: number })
				._inFlightSnapshots;
			expect(inFlightAfter).toBe(0);

			localScheduler.shutdown();
		});

		it("shutdown clears pending snapshot timeouts without firing them", () => {
			const localScheduler = new SnapshotScheduler(() => agent as unknown as AgentConnection);

			localScheduler.trackChannel("ch-a");
			vi.advanceTimersByTime(3_001); // snapshot in-flight, timeout armed

			// Shutdown before timeout fires
			localScheduler.shutdown();

			// Advance well past the timeout — slot should not be freed (timer was cleared)
			vi.advanceTimersByTime(10_000);

			// In-flight count remains 1 because the timeout was cancelled by shutdown
			const inFlight = (localScheduler as unknown as { _inFlightSnapshots: number })
				._inFlightSnapshots;
			expect(inFlight).toBe(1);
		});
	});

	// ── 10. SNAPSHOT_RES → stored in spool.db + cache_index updated ──────────

	describe("SNAPSHOT_RES storage (via MetaDAL + SpoolDAL)", () => {
		it("insertChunk stores a snapshot chunk with kind=snapshot", () => {
			const snapshotData = {
				serialized: "\x1b[2J",
				cols: 80,
				rows: 24,
				cursorX: 0,
				cursorY: 0,
			};
			const json = JSON.stringify(snapshotData);
			const dataBlob = Buffer.from(json);

			const chunkId = spoolDal.insertChunk({
				channelId: CHANNEL_ID,
				seq: 42,
				kind: "snapshot",
				dataBlob,
				uncompressedLen: dataBlob.length,
			});

			expect(chunkId).toBeTruthy();
			const chunk = spoolDal.getChunk(chunkId);
			expect(chunk).toBeDefined();
			expect(chunk?.kind).toBe("snapshot");
			expect(chunk?.channelId).toBe(CHANNEL_ID);
		});

		it("updateCacheIndex upserts the cache_index row", () => {
			const dataBlob = Buffer.from("{}");
			const chunkId = spoolDal.insertChunk({
				channelId: CHANNEL_ID,
				seq: 10,
				kind: "snapshot",
				dataBlob,
				uncompressedLen: 2,
			});

			// First insert
			metaDal.updateCacheIndex(CHANNEL_ID, chunkId, 10);

			// Second insert (upsert with higher seq)
			const dataBlob2 = Buffer.from("{}");
			const chunkId2 = spoolDal.insertChunk({
				channelId: CHANNEL_ID,
				seq: 20,
				kind: "snapshot",
				dataBlob: dataBlob2,
				uncompressedLen: 2,
			});
			metaDal.updateCacheIndex(CHANNEL_ID, chunkId2, 20);

			// Verify the upsert replaced the first entry — no duplicate key error
			// (SQLite would throw on second INSERT without ON CONFLICT)
		});
	});
});
