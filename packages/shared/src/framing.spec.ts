import { describe, expect, it } from "vitest";
import { encodeFrame, FrameReader, FrameTooLargeError } from "./framing.js";
import type { OutputMessage, ProtocolMessage } from "./protocol.js";

function makeOutput(channelId: string, seq: number): OutputMessage {
	return {
		type: "OUTPUT",
		channelId,
		seq,
		ts: "2026-03-03T00:00:00.000Z",
		data: new Uint8Array([65, 66, 67]), // "ABC"
	};
}

function asOutput(msg: ProtocolMessage): OutputMessage {
	if (msg.type !== "OUTPUT") throw new Error(`Expected OUTPUT, got ${msg.type}`);
	return msg;
}

// ---------------------------------------------------------------------------
// encodeFrame
// ---------------------------------------------------------------------------

describe("encodeFrame", () => {
	it("produces a frame with a 4-byte LE length prefix", () => {
		const msg = makeOutput("chan-1", 1);
		const frame = encodeFrame(msg);

		const view = new DataView(frame.buffer, frame.byteOffset);
		const payloadLength = view.getUint32(0, /* littleEndian= */ true);

		expect(frame.byteLength).toBe(4 + payloadLength);
		expect(payloadLength).toBeGreaterThan(0);
	});

	it("throws when payload exceeds MAX_FRAME_SIZE", () => {
		// Craft a message with a data field large enough to exceed 10 MB after encoding.
		const hugeData = new Uint8Array(10 * 1024 * 1024 + 1);
		const msg: OutputMessage = {
			type: "OUTPUT",
			channelId: "chan-x",
			seq: 0,
			ts: "2026-03-03T00:00:00.000Z",
			data: hugeData,
		};
		expect(() => encodeFrame(msg)).toThrow(RangeError);
	});
});

// ---------------------------------------------------------------------------
// FrameReader — single message
// ---------------------------------------------------------------------------

describe("FrameReader — single message", () => {
	it("decodes a single frame pushed all at once", () => {
		const msg = makeOutput("chan-1", 1);
		const frame = Buffer.from(encodeFrame(msg));

		const reader = new FrameReader();
		const results = reader.push(frame);

		expect(results).toHaveLength(1);
		const decoded = asOutput(results[0] as ProtocolMessage);
		expect(decoded.type).toBe("OUTPUT");
		expect(decoded.channelId).toBe("chan-1");
		expect(decoded.seq).toBe(1);
		expect(Array.from(decoded.data)).toEqual([65, 66, 67]);
	});

	it("buffers partial reads and emits message when complete", () => {
		const msg = makeOutput("chan-2", 2);
		const frame = Buffer.from(encodeFrame(msg));

		const reader = new FrameReader();

		// Split frame at byte 3 (still inside the 4-byte header)
		const part1 = frame.subarray(0, 3);
		const part2 = frame.subarray(3);

		const r1 = reader.push(part1);
		expect(r1).toHaveLength(0); // incomplete

		const r2 = reader.push(part2);
		expect(r2).toHaveLength(1);
		expect(asOutput(r2[0] as ProtocolMessage).seq).toBe(2);
	});

	it("buffers when payload is incomplete", () => {
		const msg = makeOutput("chan-3", 3);
		const frame = Buffer.from(encodeFrame(msg));

		const reader = new FrameReader();

		// Send header + first byte of payload only
		const part1 = frame.subarray(0, 5);
		const part2 = frame.subarray(5);

		expect(reader.push(part1)).toHaveLength(0);
		const results = reader.push(part2);
		expect(results).toHaveLength(1);
		expect(asOutput(results[0] as ProtocolMessage).channelId).toBe("chan-3");
	});
});

// ---------------------------------------------------------------------------
// FrameReader — multiple messages
// ---------------------------------------------------------------------------

describe("FrameReader — multiple messages", () => {
	it("decodes multiple messages pushed as one buffer", () => {
		const msgs = [makeOutput("chan-a", 10), makeOutput("chan-b", 20), makeOutput("chan-c", 30)];
		const combined = Buffer.concat(msgs.map((m) => Buffer.from(encodeFrame(m))));

		const reader = new FrameReader();
		const results = reader.push(combined);

		expect(results).toHaveLength(3);
		expect(asOutput(results[0] as ProtocolMessage).seq).toBe(10);
		expect(asOutput(results[1] as ProtocolMessage).seq).toBe(20);
		expect(asOutput(results[2] as ProtocolMessage).seq).toBe(30);
	});

	it("handles messages split across many small chunks", () => {
		const msgs = [makeOutput("chan-a", 1), makeOutput("chan-b", 2)];
		const combined = Buffer.concat(msgs.map((m) => Buffer.from(encodeFrame(m))));

		const reader = new FrameReader();
		const allResults: ProtocolMessage[] = [];

		// Push byte-by-byte
		for (let i = 0; i < combined.length; i++) {
			const chunk = combined.subarray(i, i + 1);
			allResults.push(...reader.push(chunk));
		}

		expect(allResults).toHaveLength(2);
		expect(asOutput(allResults[0] as ProtocolMessage).channelId).toBe("chan-a");
		expect(asOutput(allResults[1] as ProtocolMessage).channelId).toBe("chan-b");
	});

	it("reports zero bufferedBytes after all messages are consumed", () => {
		const msg = makeOutput("chan-x", 99);
		const frame = Buffer.from(encodeFrame(msg));

		const reader = new FrameReader();
		reader.push(frame);

		expect(reader.bufferedBytes).toBe(0);
	});

	it("reports non-zero bufferedBytes when a frame is incomplete", () => {
		const msg = makeOutput("chan-y", 1);
		const frame = Buffer.from(encodeFrame(msg));

		const reader = new FrameReader();
		reader.push(frame.subarray(0, 4)); // only the header

		expect(reader.bufferedBytes).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// FrameReader — error handling
// ---------------------------------------------------------------------------

describe("FrameReader — frame size limit", () => {
	it("throws RangeError when frame length header exceeds MAX_FRAME_SIZE", () => {
		// Manually craft a frame with a length field of 10 MB + 1
		const oversizeLength = 10 * 1024 * 1024 + 1;
		const fakeHeader = Buffer.alloc(4);
		fakeHeader.writeUInt32LE(oversizeLength, 0);

		const reader = new FrameReader();
		expect(() => reader.push(fakeHeader)).toThrow(RangeError);
	});

	it("says which length it refused, as a FrameTooLargeError (#763)", () => {
		const reader = new FrameReader();
		const error = (() => {
			try {
				reader.push(Buffer.from([0xff, 0xff, 0xff, 0xff]));
			} catch (thrown) {
				return thrown;
			}
			return undefined;
		})();
		expect(error).toBeInstanceOf(FrameTooLargeError);
		expect((error as FrameTooLargeError).payloadLength).toBe(0xffff_ffff);
	});
});
