import { EventEmitter } from "node:events";
import {
	FrameReader,
	type HelloMessage,
	PROTOCOL_VERSION,
	type ProtocolMessage,
} from "@lasterm/shared";

/**
 * Abstract base class for communicating with a lasterm agent (local or remote SSH).
 *
 * Events:
 *   "ready"   — emitted once when the HELLO handshake completes
 *   "message" — emitted for every decoded ProtocolMessage
 *   "close"   — emitted when the transport closes (exit code or undefined)
 *   "error"   — emitted on transport / decode errors
 */
export abstract class AgentConnection extends EventEmitter {
	protected reader = new FrameReader();
	protected ready = false;

	/** The HELLO message received during handshake (available after "ready"). */
	helloMessage: HelloMessage | undefined;

	/** True only when this specific connection attempt uploaded an agent binary. */
	deployedThisSession = false;

	/** True when this connection used an existing remote binary that matched the hub-version cache. */
	remoteMatchesHubVersionCache = false;

	/** Send a protocol message to the agent. */
	abstract send(msg: ProtocolMessage): void;

	/** Close the agent connection. */
	abstract close(): Promise<void>;

	/** Whether the underlying transport is still active. */
	abstract get connected(): boolean;

	/** Feed raw bytes from the agent into the frame decoder. */
	protected handleData(data: Buffer): void {
		const messages = this.reader.push(data);
		for (const msg of messages) {
			if (msg.type === "HELLO" && !this.ready) {
				if (msg.version !== PROTOCOL_VERSION) {
					this.emit(
						"error",
						new Error(
							`Protocol version mismatch: expected ${PROTOCOL_VERSION}, got ${msg.version}`,
						),
					);
					this.close();
					return;
				}
				this.ready = true;
				this.helloMessage = msg as HelloMessage;
				this.emit("ready", msg);
			}
			this.emit("message", msg);
		}
	}
}
