import net from "node:net";
import type { Duplex } from "node:stream";
import { encodeFrame, type ProtocolMessage } from "@lasterm/shared";
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
	/**
	 * Whatever carries the frames. A local daemon gives a `net.Socket`; a remote
	 * one gives an SSH channel to its socket. The protocol is the same on both,
	 * and this class only ever reads, writes, and destroys.
	 */
	private socket: Duplex;
	private sendQueue: SendQueue;
	private connId: number;
	private readonly hubLogger: HubLogger | undefined;
	private socketClosed = false;
	private closePromise: Promise<void> | null = null;
	private static _connSeq = 0;

	constructor(socket: Duplex, hubLogger?: HubLogger) {
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

		socket.on("error", (err: Error) => {
			this.logDebug("lasterm-agent: socket error", { message: err.message });
			this.emit("error", err);
		});
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
	 * Connect to a local agent daemon via Unix domain socket or named pipe.
	 * Resolves after HELLO is received (agent is ready).
	 * Rejects on connection error or HELLO timeout (5s).
	 */
	/**
	 * Drive an agent over a stream someone else opened — an SSH channel to a
	 * remote daemon's socket, today.
	 *
	 * Resolves once HELLO arrives, on the same deadline as a local connection:
	 * a daemon that has accepted the connection and says nothing is a daemon
	 * this hub cannot use, however it was reached.
	 */
	static overStream(stream: Duplex, hubLogger?: HubLogger): Promise<LastermAgent> {
		return new Promise((resolve, reject) => {
			const agent = new LastermAgent(stream, hubLogger);
			let settled = false;

			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				agent.close();
				reject(new Error(`HELLO timeout after ${HELLO_TIMEOUT_MS}ms`));
			}, HELLO_TIMEOUT_MS);

			agent.once("ready", () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(agent);
			});

			agent.once("error", (err) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				reject(err);
			});
		});
	}

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
