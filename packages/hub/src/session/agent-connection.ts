import { EventEmitter } from "node:events";
import {
	type AgentChannelStateMessage,
	type ChannelStateEndMessage,
	FrameReader,
	FrameTooLargeError,
	type HelloMessage,
	MAX_FRAME_SIZE,
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
 *   "error"   — emitted on transport errors, and on a frame that does not
 *               decode, which closes the connection (#763)
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

	/**
	 * True when the agent answering is a remote daemon that was already running
	 * when this connection reached it. It was started earlier, from whatever
	 * binary was on disk then: what this connection deployed or checked is
	 * what the next daemon runs, not this one (#555).
	 */
	reachedRunningDaemon = false;

	/**
	 * What the agent said it already holds, collected as it arrives.
	 *
	 * A stdio agent is always new and reports nothing; a daemon — local, or
	 * remote since #79 — reports the channels it kept while nobody was
	 * connected. Collection starts in the constructor so that nothing said
	 * between HELLO and the caller's await is lost.
	 */
	protected channelStatePromise: Promise<AgentChannelStateMessage[]>;

	/**
	 * How many channels other hubs hold on this daemon, as its CHANNEL_STATE_END
	 * said (#127). Undefined until then. Informational only: this hub never
	 * acts on those channels.
	 */
	otherOwnerChannels: number | undefined;

	constructor() {
		super();
		this.channelStatePromise = new Promise<AgentChannelStateMessage[]>((resolve, reject) => {
			const states: AgentChannelStateMessage[] = [];
			let settled = false;

			const cleanup = (): void => {
				this.off("message", onMessage);
				this.off("close", onClose);
				this.off("error", onError);
			};

			const settle = (fn: () => void): void => {
				if (settled) return;
				settled = true;
				cleanup();
				fn();
			};

			const onMessage = (msg: ProtocolMessage): void => {
				if (msg.type === "AGENT_CHANNEL_STATE") {
					states.push(msg as AgentChannelStateMessage);
				} else if (msg.type === "CHANNEL_STATE_END") {
					const others = (msg as ChannelStateEndMessage).otherOwnerChannels;
					if (typeof others === "number" && Number.isSafeInteger(others) && others >= 0) {
						this.otherOwnerChannels = others;
					}
					settle(() => resolve(states));
				}
			};

			const onClose = (): void => {
				settle(() => reject(new Error("CHANNEL_STATE connection closed before CHANNEL_STATE_END")));
			};

			const onError = (err: Error): void => {
				settle(() => reject(err));
			};

			this.on("message", onMessage);
			this.once("close", onClose);
			this.once("error", onError);
		});
		this.channelStatePromise.catch(() => {});
	}

	/**
	 * Wait for the agent to send channel state enumeration.
	 *
	 * After connecting, the daemon sends zero or more AGENT_CHANNEL_STATE
	 * messages followed by a single CHANNEL_STATE_END sentinel. This method
	 * returns the collected list.
	 *
	 * Safe to call after `connectLocal` resolves — messages that arrived
	 * between HELLO and this call are buffered internally.
	 *
	 * @param timeoutMs - Maximum time to wait (default 5 000 ms).
	 * @returns Array of channel state messages (empty when no channels exist).
	 */
	waitForChannelState(timeoutMs = 5_000): Promise<AgentChannelStateMessage[]> {
		let timer: ReturnType<typeof setTimeout>;
		const timeout = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
				reject(new Error("CHANNEL_STATE timeout"));
			}, timeoutMs);
		});

		return Promise.race([this.channelStatePromise, timeout]).finally(() => {
			clearTimeout(timer);
		});
	}

	/** Send a protocol message to the agent. */
	abstract send(msg: ProtocolMessage): void;

	/** Close the agent connection. */
	abstract close(): Promise<void>;

	/** Whether the underlying transport is still active. */
	abstract get connected(): boolean;

	/**
	 * The error that closed this connection when the agent sent what is not a
	 * frame of the protocol (#763); null until it does. Nothing it sends after
	 * is read.
	 */
	malformedFrame: Error | null = null;

	/** The agent, as an error names it: "The agent on pi", "The local agent". */
	protected abstract describeAgent(): string;

	/** Say at WARN why this connection ends. */
	protected logWarning(message: string): void {
		console.warn(message);
	}

	/**
	 * Feed raw bytes from the agent into the frame decoder.
	 *
	 * Never throws: it runs in a stream's "data" listener, and a throw from
	 * there reaches no handler of the hub's and can end it, with every
	 * terminal it holds, for one agent's bad output (#763). A frame that does
	 * not decode closes this connection instead, and only it.
	 */
	protected handleData(data: Buffer): void {
		if (this.malformedFrame !== null) return;
		let messages: ProtocolMessage[];
		try {
			messages = this.reader.push(data);
		} catch (err) {
			this.closeOnMalformedFrame(err);
			return;
		}
		for (const msg of messages) {
			if (!isMessage(msg)) {
				this.closeOnMalformedFrame(msg);
				return;
			}
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

	/**
	 * Close this connection on what the agent sent that is not a frame of the
	 * protocol: `cause` is what the frame reader threw, or what a frame decoded
	 * to. The error and the log line say which, by its length or its kind, and
	 * never hold a byte of it: the bytes may be a terminal's.
	 */
	private closeOnMalformedFrame(cause: unknown): void {
		const what =
			cause instanceof FrameTooLargeError
				? `a length prefix of ${cause.payloadLength} bytes, past the ${MAX_FRAME_SIZE}-byte limit`
				: "a payload that is not a protocol message";
		const error = new Error(`${this.describeAgent()} sent a malformed frame: ${what}`);
		this.malformedFrame = error;
		this.logWarning(`${error.message}; closing the connection`);
		// Whoever drives this connection hears it. Emitted with no listener, an
		// "error" would throw, the very thing this is here to prevent.
		if (this.listenerCount("error") > 0) this.emit("error", error);
		void this.close();
	}
}

/** Whether a decoded payload is a message: an object with a type, as every message is. */
function isMessage(value: unknown): value is ProtocolMessage {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { type?: unknown }).type === "string"
	);
}
