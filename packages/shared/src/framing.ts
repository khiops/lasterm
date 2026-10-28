// Length-prefixed frame encoder/decoder for stdio streams (Hub ↔ Agent).
//
// Frame format: [4 bytes LE uint32 length][payload bytes]
//
// WebSocket connections do NOT use framing — WS provides its own binary frames.
// This module is only for the stdio transport layer.

import { decodeMessage, encodeMessage } from "./codec.js";
import { MAX_FRAME_SIZE } from "./constants.js";
import type { ProtocolMessage } from "./protocol.js";

const LENGTH_PREFIX_BYTES = 4;

/**
 * Encode a protocol message to a length-prefixed frame.
 * Returns [uint32-LE length (4 bytes)][msgpack payload].
 */
export function encodeFrame(message: ProtocolMessage): Uint8Array {
	const payload = encodeMessage(message);

	if (payload.byteLength > MAX_FRAME_SIZE) {
		throw new RangeError(
			`Frame payload too large: ${payload.byteLength} bytes (max ${MAX_FRAME_SIZE})`,
		);
	}

	const frame = new Uint8Array(LENGTH_PREFIX_BYTES + payload.byteLength);
	const view = new DataView(frame.buffer);
	view.setUint32(0, payload.byteLength, /* littleEndian= */ true);
	frame.set(payload, LENGTH_PREFIX_BYTES);
	return frame;
}

/**
 * A length prefix past `MAX_FRAME_SIZE`: what follows is not a frame of this
 * protocol. Its message holds the length and the limit, and no byte of the
 * stream beyond the prefix (#763).
 */
export class FrameTooLargeError extends RangeError {
	readonly payloadLength: number;

	constructor(payloadLength: number) {
		super(`Incoming frame too large: ${payloadLength} bytes (max ${MAX_FRAME_SIZE})`);
		this.name = "FrameTooLargeError";
		this.payloadLength = payloadLength;
	}
}

/**
 * FrameReader accumulates bytes from a streaming source and yields complete
 * decoded messages. Handles partial reads and multiple messages per push.
 *
 * Usage:
 *   const reader = new FrameReader();
 *   socket.on("data", (chunk) => {
 *     for (const msg of reader.push(chunk)) { handle(msg); }
 *   });
 */
export class FrameReader {
	private buffer: Buffer = Buffer.alloc(0);

	/**
	 * Push incoming bytes. Returns all fully-decoded messages that could be
	 * assembled from the accumulated buffer.
	 *
	 * @throws FrameTooLargeError if a frame length header exceeds MAX_FRAME_SIZE,
	 *   and whatever `decodeMessage` throws on a payload that does not decode.
	 */
	push(data: Buffer): ProtocolMessage[] {
		this.buffer = Buffer.concat([this.buffer, data]);

		const messages: ProtocolMessage[] = [];

		// eslint-disable-next-line no-constant-condition
		while (true) {
			// Need at least the 4-byte length prefix
			if (this.buffer.length < LENGTH_PREFIX_BYTES) break;

			const payloadLength = this.buffer.readUInt32LE(0);

			if (payloadLength > MAX_FRAME_SIZE) throw new FrameTooLargeError(payloadLength);

			const totalLength = LENGTH_PREFIX_BYTES + payloadLength;

			// Wait for the full payload to arrive
			if (this.buffer.length < totalLength) break;

			const payload = this.buffer.subarray(LENGTH_PREFIX_BYTES, totalLength);
			messages.push(decodeMessage(new Uint8Array(payload)));

			// Consume the frame from the buffer
			this.buffer = this.buffer.subarray(totalLength);
		}

		return messages;
	}

	/** Return the number of buffered bytes not yet consumed into a complete frame. */
	get bufferedBytes(): number {
		return this.buffer.length;
	}
}
