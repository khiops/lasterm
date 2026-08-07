import net from "node:net";
import { type AgentChannelStateMessage, encodeFrame, type ProtocolMessage } from "@lasterm/shared";
import type { HubLogger } from "../logging/hub-logger.js";
import { AgentConnection } from "./agent-connection.js";
import { SendQueue } from "./send-queue.js";

const HELLO_TIMEOUT_MS = 5_000;
const CLOSE_TIMEOUT_MS = 1_000;

/**
 * Hub-side agent connection for the daemon transport (UDS/named pipe).
 *
 * Connects to a running agent daemon via Unix domain socket or Windows named pipe.
 * The agent remains alive independently — close() disconnects without killing it.
 *
 * Factory method: LastermAgent.connectLocal(socketPath)
 */
export class LastermAgent extends AgentConnection {
	private socket: net.Socket;
	private sendQueue: SendQueue;
	private connId: number;
	private readonly hubLogger: HubLogger | undefined;
	private socketClosed = false;
	private closePromise: Promise<void> | null = null;
	private static _connSeq = 0;

	/**
	 * Promise that resolves with collected AGENT_CHANNEL_STATE messages
	 * once CHANNEL_STATE_END is received. Created eagerly in the constructor
	 * so messages are never lost, regardless of when the caller awaits.
	 */
	private channelStatePromise: Promise<AgentChannelStateMessage[]>;

	constructor(socket: net.Socket, hubLogger?: HubLogger) {
		super();
		this.socket = socket;
		this.hubLogger = hubLogger;
		this.connId = ++LastermAgent._connSeq;
		this.logDebug("lasterm-agent: connection created");
		this.sendQueue = new SendQueue("lasterm-agent");
		this.sendQueue.attach(socket);

		this.on("message", (m: ProtocolMessage) => {
			this.logDebug("lasterm-agent: received message", { messageType: m.type });
		});
		this.on("ready", () => {
			this.logDebug("lasterm-agent: ready", {
				agentVersion: this.helloMessage?.agentVersion,
				capabilities: this.helloMessage?.capabilities,
			});
		});

		socket.on("data", (data: Buffer) => {
			this.handleData(data);
		});

		socket.on("close", () => {
			this.socketClosed = true;
			this.logDebug("lasterm-agent: socket closed");
			this.sendQueue.clear();
			this.emit("close");
		});

		socket.on("error", (err) => {
			this.logDebug("lasterm-agent: socket error", { message: err.message });
			this.emit("error", err);
		});

		// Eagerly collect channel-state messages into a promise so that
		// callers of waitForChannelState() never miss messages that arrived
		// between HELLO and the await.
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
					states.push(msg);
				} else if (msg.type === "CHANNEL_STATE_END") {
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

	private logDebug(msg: string, extra?: Record<string, unknown>): void {
		this.hubLogger?.log("debug", msg, { connId: this.connId, ...extra });
	}

	/** Send a framed protocol message to the agent. */
	send(msg: ProtocolMessage): void {
		if (!this.connected) return;
		const frame = encodeFrame(msg);
		this.sendQueue.send(Buffer.from(frame));
	}

	/** Disconnect from the agent (agent keeps running). */
	close(): Promise<void> {
		if (this.socketClosed) return Promise.resolve();
		if (this.closePromise) return this.closePromise;

		this.closePromise = new Promise((resolve) => {
			const timer = setTimeout(() => {
				resolve();
			}, CLOSE_TIMEOUT_MS);

			this.once("close", () => {
				clearTimeout(timer);
				resolve();
			});

			this.sendQueue.clear();
			this.socket.destroy();
		});
		return this.closePromise;
	}

	/** True when the underlying socket is still open. */
	get connected(): boolean {
		return !this.socket.destroyed;
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

	/**
	 * Connect to a local agent daemon via Unix domain socket or named pipe.
	 * Resolves after HELLO is received (agent is ready).
	 * Rejects on connection error or HELLO timeout (5s).
	 */
	static connectLocal(socketPath: string, hubLogger?: HubLogger): Promise<LastermAgent> {
		return new Promise((resolve, reject) => {
			const socket = net.connect(socketPath);
			let settled = false;

			socket.once("connect", () => {
				const agent = new LastermAgent(socket, hubLogger);

				const timer = setTimeout(() => {
					if (!settled) {
						settled = true;
						agent.close();
						reject(new Error(`HELLO timeout after ${HELLO_TIMEOUT_MS}ms`));
					}
				}, HELLO_TIMEOUT_MS);

				agent.once("ready", () => {
					if (!settled) {
						settled = true;
						clearTimeout(timer);
						resolve(agent);
					}
				});

				agent.once("error", (err) => {
					if (!settled) {
						settled = true;
						clearTimeout(timer);
						reject(err);
					}
				});
			});

			socket.once("error", (err) => {
				if (!settled) {
					settled = true;
					reject(err);
				}
			});
		});
	}
}
