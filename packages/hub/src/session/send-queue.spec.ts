import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mock @lasterm/shared ────────────────────────────────────────────────────
// encodeFrame is called inside StubAgent.send() — return a predictable buffer each time.

let encodeFrameCounter = 0;

vi.mock("@lasterm/shared", () => {
	class FakeFrameReader {
		push(_data: Buffer) {
			return [];
		}
	}

	return {
		encodeFrame: vi.fn(() => {
			const id = ++encodeFrameCounter;
			const buf = Buffer.alloc(8);
			buf.writeUInt32LE(id, 0);
			return new Uint8Array(buf);
		}),
		FrameReader: FakeFrameReader,
	};
});

// ─── Import after mocks ─────────────────────────────────────────────────────

import { encodeFrame } from "@lasterm/shared";
import { SendQueue } from "./send-queue.js";

// ─── Minimal stub that exercises SendQueue the same way LocalAgent did ────────

interface MockChildProcess extends EventEmitter {
	stdin: PassThrough & { writable: boolean };
	stdout: PassThrough;
	stderr: PassThrough;
	pid: number;
	killed: boolean;
	kill: ReturnType<typeof vi.fn>;
}

let mockChild: MockChildProcess;

/**
 * StubAgent is a minimal stand-in for LocalAgent.
 * It owns a SendQueue and exposes send()/close() with the same backpressure
 * semantics, without spawning a child process.
 */
class StubAgent {
	readonly sendQueue = new SendQueue("stub-agent");

	constructor(stream: PassThrough & { writable: boolean }) {
		this.sendQueue.attach(stream);
	}

	send(msg: { type: string }): void {
		if (!mockChild.stdin.writable) {
			throw new Error("Agent not connected");
		}
		this.sendQueue.send(Buffer.from(encodeFrame(msg as never)));
	}

	close(): void {
		this.sendQueue.clear();
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createMockChild(): MockChildProcess {
	const child = new EventEmitter() as MockChildProcess;
	const stdin = new PassThrough();
	Object.defineProperty(stdin, "writable", { value: true, writable: true });
	child.stdin = stdin as MockChildProcess["stdin"];
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.pid = 12345;
	child.killed = false;
	child.kill = vi.fn(() => {
		child.killed = true;
	});
	return child;
}

function startAgent(): StubAgent {
	return new StubAgent(mockChild.stdin);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("SendQueue backpressure", () => {
	beforeEach(() => {
		encodeFrameCounter = 0;
		mockChild = createMockChild();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("send() writes frame to stdin (happy path)", () => {
		const writeSpy = vi.spyOn(mockChild.stdin, "write");
		const agent = startAgent();

		agent.send({ type: "PING" });

		expect(writeSpy).toHaveBeenCalledTimes(1);
		const written = writeSpy.mock.calls[0]?.[0] as Buffer;
		expect(Buffer.isBuffer(written)).toBe(true);
	});

	it("send() queues frame when stdin.write returns false (backpressure)", () => {
		const writeSpy = vi.spyOn(mockChild.stdin, "write").mockReturnValue(false);
		const agent = startAgent();

		// First send: write returns false -> draining = true
		agent.send({ type: "MSG1" });
		expect(writeSpy).toHaveBeenCalledTimes(1);

		// Second send: draining is true -> goes to queue, not to write
		agent.send({ type: "MSG2" });
		expect(writeSpy).toHaveBeenCalledTimes(1);

		// Third send: also queued
		agent.send({ type: "MSG3" });
		expect(writeSpy).toHaveBeenCalledTimes(1);

		// Verify queue has the 2 messages (MSG2, MSG3)
		expect(agent.sendQueue.pending).toBe(2);
	});

	it("drain event flushes queued frames", () => {
		const writeSpy = vi.spyOn(mockChild.stdin, "write");

		// First call: returns false (backpressure), subsequent calls: returns true
		writeSpy.mockReturnValueOnce(false).mockReturnValue(true);

		const agent = startAgent();

		// First send triggers backpressure
		agent.send({ type: "MSG1" });
		expect(writeSpy).toHaveBeenCalledTimes(1);

		// These go to the queue
		agent.send({ type: "MSG2" });
		agent.send({ type: "MSG3" });
		expect(writeSpy).toHaveBeenCalledTimes(1);

		// Emit drain -> flushSendQueue runs
		mockChild.stdin.emit("drain");

		// Both queued frames should now be written (1 initial + 2 flushed)
		expect(writeSpy).toHaveBeenCalledTimes(3);

		// Queue should be empty
		expect(agent.sendQueue.pending).toBe(0);
	});

	it("queue drops oldest frame at 1000 cap", () => {
		const writeSpy = vi.spyOn(mockChild.stdin, "write").mockReturnValue(false);
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		const agent = startAgent();

		// First send triggers backpressure (goes to write, returns false)
		agent.send({ type: "FIRST" });
		expect(writeSpy).toHaveBeenCalledTimes(1);

		// Fill the queue to 1000 via enqueueSend (draining is already true)
		for (let i = 0; i < 1000; i++) {
			agent.send({ type: `MSG_${i}` });
		}

		expect(agent.sendQueue.pending).toBe(1000);

		// No warning yet: enqueueSend checks >= 1000 BEFORE pushing.
		// After 1000 enqueues, length is exactly 1000. The warning triggers on
		// the NEXT enqueue (when length is already 1000, i.e. >= 1000).
		expect(stderrSpy).not.toHaveBeenCalled();

		// Send one more -> triggers the stderr warning, shifts oldest, pushes new
		agent.send({ type: "OVERFLOW_1" });
		expect(agent.sendQueue.pending).toBe(1000);
		expect(stderrSpy).toHaveBeenCalledTimes(1);
		expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("send queue reached 1000"));

		// Send another -> drops oldest again, length stays 1000
		agent.send({ type: "OVERFLOW_2" });
		expect(agent.sendQueue.pending).toBe(1000);

		// Verify the dropped frames were the oldest: encodeFrame returns incrementing IDs.
		// ID 1 = initial write(). Queue starts at ID 2 (MSG_0).
		// After 2 overflows, IDs 2 and 3 (MSG_0, MSG_1) were shifted out.
		// First in queue should now be ID 4 (MSG_2).
		const firstInQueue = Buffer.from(agent.sendQueue.frames[0]!);
		expect(firstInQueue.readUInt32LE(0)).toBe(4);
	});

	it("flush stops writing when backpressure resumes mid-drain", () => {
		const writeSpy = vi.spyOn(mockChild.stdin, "write");

		// Initial send: backpressure
		writeSpy.mockReturnValueOnce(false);

		const agent = startAgent();

		// Trigger backpressure
		agent.send({ type: "MSG1" });

		// Queue 3 messages
		agent.send({ type: "MSG2" });
		agent.send({ type: "MSG3" });
		agent.send({ type: "MSG4" });

		// On drain: first flushed write OK, second triggers backpressure again
		writeSpy.mockReturnValueOnce(true).mockReturnValueOnce(false);

		mockChild.stdin.emit("drain");

		// 1 initial + 2 flushed (first OK, second triggers backpressure -> stops)
		expect(writeSpy).toHaveBeenCalledTimes(3);

		// 1 message should still be in queue (MSG4)
		expect(agent.sendQueue.pending).toBe(1);
	});

	it("double drain does not double-process the queue", () => {
		const writeSpy = vi.spyOn(mockChild.stdin, "write");

		// Initial write: backpressure
		writeSpy.mockReturnValueOnce(false);

		const agent = startAgent();

		// Trigger backpressure
		agent.send({ type: "MSG1" });

		// Queue 2 messages
		agent.send({ type: "MSG2" });
		agent.send({ type: "MSG3" });

		// All subsequent writes succeed
		writeSpy.mockReturnValue(true);

		// Emit drain twice rapidly
		mockChild.stdin.emit("drain");
		mockChild.stdin.emit("drain");

		// 1 initial + 2 flushed = 3 total (second drain finds empty queue)
		expect(writeSpy).toHaveBeenCalledTimes(3);

		// Queue is empty
		expect(agent.sendQueue.pending).toBe(0);
	});

	it("close() clears the send queue and resets draining state", () => {
		vi.spyOn(mockChild.stdin, "write").mockReturnValue(false);
		const agent = startAgent();

		// Trigger backpressure and queue messages
		agent.send({ type: "MSG1" });
		agent.send({ type: "MSG2" });
		agent.send({ type: "MSG3" });

		expect(agent.sendQueue.pending).toBeGreaterThan(0);

		agent.close();

		expect(agent.sendQueue.pending).toBe(0);
		expect(agent.sendQueue.isDraining).toBe(false);
	});

	it("process close event clears send queue and draining state", () => {
		vi.spyOn(mockChild.stdin, "write").mockReturnValue(false);
		const agent = startAgent();

		// Trigger backpressure and queue messages
		agent.send({ type: "MSG1" });
		agent.send({ type: "MSG2" });

		expect(agent.sendQueue.pending).toBeGreaterThan(0);

		// Simulate process exit by manually clearing (as LocalAgent did on 'close')
		agent.close();

		expect(agent.sendQueue.pending).toBe(0);
		expect(agent.sendQueue.isDraining).toBe(false);
	});
});
