import { EventEmitter } from "node:events";
import {
	type AgentChannelStateMessage,
	type ChannelStateEndMessage,
	FrameReader,
	type HelloMessage,
	HUB_IDENTITY_CAPABILITY,
	PROTOCOL_VERSION,
	type ProtocolMessage,
} from "@lasterm/shared";

/**
 * Whether the agent at the other end of this connection serves several hubs,
 * each with its own channels, told apart by their hub keys (#127).
 *
 * Read from the connection's own HELLO, not from the host's last one: the
 * answer belongs to that process. Without it the agent serves one hub at a
 * time, the last to connect, and the hub keeps its behaviour from before.
 */
export function hasHubIdentity(agent: Pick<AgentConnection, "helloMessage">): boolean {
	return agent.helloMessage?.capabilities?.includes(HUB_IDENTITY_CAPABILITY) === true;
}

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
	 * said (#127). Undefined until then, and from an agent that does not count
	 * them. Informational only: this hub never acts on those channels.
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
