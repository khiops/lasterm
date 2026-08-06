import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { encodeFrame, PROTOCOL_VERSION, type ProtocolMessage } from "@lasterm/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LastermAgent } from "./lasterm-agent.js";
import { getTestSocketPath } from "./test-socket-path.js";

const TEST_TIMEOUT = 10_000;

// ─── Mock daemon helpers ─────────────────────────────────────────────────────

interface MockDaemon {
	server: net.Server;
	connections: net.Socket[];
}

/**
 * Create a mock agent daemon on UDS that speaks the lasterm protocol.
 * On each connection: sends HELLO, optional AGENT_CHANNEL_STATE messages,
 * then CHANNEL_STATE_END.
 *
 * Returns the server + list of connected sockets.
 * All sockets get an error handler to suppress ECONNRESET during cleanup.
 */
function createMockDaemon(
	socketPath: string,
	channels: Array<{ channelId: string; title: string; pid: number; alive: boolean }> = [],
): Promise<MockDaemon> {
	return new Promise((resolve) => {
		const connections: net.Socket[] = [];

		const server = net.createServer((socket) => {
			connections.push(socket);
			socket.on("error", () => {}); // suppress ECONNRESET

			const hello = encodeFrame({
				type: "HELLO",
				version: PROTOCOL_VERSION,
				agentVersion: "0.1.0",
				capabilities: ["multiplex", "resize", "snapshot"],
			});
			socket.write(Buffer.from(hello));

			for (const ch of channels) {
				const stateMsg = encodeFrame({
					type: "AGENT_CHANNEL_STATE",
					channelId: ch.channelId,
					title: ch.title,
					pid: ch.pid,
					alive: ch.alive,
				});
				socket.write(Buffer.from(stateMsg));
			}

			const end = encodeFrame({ type: "CHANNEL_STATE_END" });
			socket.write(Buffer.from(end));
		});

		server.listen(socketPath, () => resolve({ server, connections }));
	});
}

/** Close a net.Server and wait for "close". */
function closeServer(server: net.Server): Promise<void> {
	return new Promise((resolve) => {
		server.close(() => resolve());
	});
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Daemon integration", () => {
	let tmpDir: string;
	let socketPath: string;
	let daemon: MockDaemon | null = null;
	let agent: LastermAgent | null = null;

	beforeEach(async () => {
		tmpDir = await mkdtemp(path.join(os.tmpdir(), "lasterm-daemon-int-"));
		socketPath = getTestSocketPath();
	});

	afterEach(async () => {
		agent?.close();
		agent = null;
		if (daemon) {
			for (const conn of daemon.connections) {
				conn.destroy();
			}
			await closeServer(daemon.server);
			daemon = null;
		}
		await rm(tmpDir, { recursive: true, force: true });
	});

	// ── Basic connection ─────────────────────────────────────────────────────

	describe("Given a daemon agent listening on UDS", () => {
		it(
			"LastermAgent connects and receives HELLO",
			async () => {
				daemon = await createMockDaemon(socketPath);

				agent = await LastermAgent.connectLocal(socketPath);

				expect(agent).toBeInstanceOf(LastermAgent);
				expect(agent.connected).toBe(true);
			},
			TEST_TIMEOUT,
		);

		it(
			"waitForChannelState returns empty array for new daemon",
			async () => {
				daemon = await createMockDaemon(socketPath);

				agent = await LastermAgent.connectLocal(socketPath);
				const states = await agent.waitForChannelState();

				expect(states).toEqual([]);
			},
			TEST_TIMEOUT,
		);
	});

	// ── Daemon with existing channels ────────────────────────────────────────

	describe("Given a daemon with existing channels", () => {
		it(
			"waitForChannelState returns channel state list",
			async () => {
				const channels = [
					{ channelId: "ch-aaa", title: "Terminal 1", pid: 1001, alive: true },
					{ channelId: "ch-bbb", title: "Build", pid: 2002, alive: true },
					{ channelId: "ch-ccc", title: "Exited", pid: 3003, alive: false },
				];

				daemon = await createMockDaemon(socketPath, channels);

				agent = await LastermAgent.connectLocal(socketPath);
				const states = await agent.waitForChannelState();

				expect(states).toHaveLength(3);
				expect(states[0]).toMatchObject({
					type: "AGENT_CHANNEL_STATE",
					channelId: "ch-aaa",
					alive: true,
				});
				expect(states[1]).toMatchObject({
					type: "AGENT_CHANNEL_STATE",
					channelId: "ch-bbb",
					alive: true,
				});
				expect(states[2]).toMatchObject({
					type: "AGENT_CHANNEL_STATE",
					channelId: "ch-ccc",
					alive: false,
				});
			},
			TEST_TIMEOUT,
		);
	});

	// ── Disconnect and reconnect ─────────────────────────────────────────────

	describe("Given hub disconnects and reconnects", () => {
		it(
			"second connection receives new HELLO + channel state",
			async () => {
				const channels = [{ channelId: "ch-111", title: "Shell", pid: 4001, alive: true }];

				daemon = await createMockDaemon(socketPath, channels);

				// First connection
				const agent1 = await LastermAgent.connectLocal(socketPath);
				const states1 = await agent1.waitForChannelState();
				expect(states1).toHaveLength(1);

				// Disconnect first client
				const closePromise = new Promise<void>((resolve) => {
					agent1.once("close", () => resolve());
				});
				agent1.close();
				await closePromise;

				// Second connection — daemon still running
				agent = await LastermAgent.connectLocal(socketPath);
				expect(agent.connected).toBe(true);

				const states2 = await agent.waitForChannelState();
				expect(states2).toHaveLength(1);
				expect(states2[0]).toMatchObject({
					type: "AGENT_CHANNEL_STATE",
					channelId: "ch-111",
					alive: true,
				});
			},
			TEST_TIMEOUT,
		);

		it(
			"buffered output is flushed after reconnect",
			async () => {
				// Custom daemon that sends OUTPUT after CHANNEL_STATE_END on 2nd connection
				const connections: net.Socket[] = [];
				let connectionCount = 0;
				const bufferedData = Buffer.from("buffered output data");

				const server = net.createServer((socket) => {
					connections.push(socket);
					socket.on("error", () => {});
					connectionCount++;

					// Always send HELLO + CHANNEL_STATE_END
					socket.write(
						Buffer.from(
							encodeFrame({
								type: "HELLO",
								version: PROTOCOL_VERSION,
								agentVersion: "0.1.0",
								capabilities: ["multiplex", "resize", "snapshot"],
							}),
						),
					);

					socket.write(
						Buffer.from(
							encodeFrame({
								type: "AGENT_CHANNEL_STATE",
								channelId: "ch-buf",
								title: "Buffered",
								pid: 5001,
								alive: true,
							}),
						),
					);

					socket.write(Buffer.from(encodeFrame({ type: "CHANNEL_STATE_END" })));

					// On second connection, send buffered OUTPUT after a small delay
					// (simulates real agent flushing buffer after handshake completes)
					if (connectionCount >= 2) {
						setTimeout(() => {
							socket.write(
								Buffer.from(
									encodeFrame({
										type: "OUTPUT",
										channelId: "ch-buf",
										seq: 1,
										ts: new Date().toISOString(),
										data: new Uint8Array(bufferedData),
									}),
								),
							);
						}, 50);
					}
				});

				await new Promise<void>((resolve) => {
					server.listen(socketPath, () => resolve());
				});

				daemon = { server, connections };

				// First connection — no OUTPUT expected beyond handshake
				const agent1 = await LastermAgent.connectLocal(socketPath);
				await agent1.waitForChannelState();

				// Disconnect
				const closePromise = new Promise<void>((resolve) => {
					agent1.once("close", () => resolve());
				});
				agent1.close();
				await closePromise;

				// Second connection — should receive buffered OUTPUT
				agent = await LastermAgent.connectLocal(socketPath);
				await agent.waitForChannelState();

				const outputMsg = await new Promise<ProtocolMessage>((resolve) => {
					agent?.on("message", (msg: ProtocolMessage) => {
						if (msg.type === "OUTPUT") {
							resolve(msg);
						}
					});
				});

				expect(outputMsg.type).toBe("OUTPUT");
				if (outputMsg.type === "OUTPUT") {
					expect(outputMsg.channelId).toBe("ch-buf");
					// Verify the data is present (exact comparison depends on codec round-trip)
					expect(outputMsg.data).toBeDefined();
					expect(outputMsg.data.length).toBe(bufferedData.length);
				}
			},
			TEST_TIMEOUT,
		);
	});

	// ── Daemon dies ──────────────────────────────────────────────────────────

	describe("Given a daemon that dies", () => {
		it(
			"LastermAgent emits close event",
			async () => {
				daemon = await createMockDaemon(socketPath);

				agent = await LastermAgent.connectLocal(socketPath);
				expect(agent.connected).toBe(true);

				const closePromise = new Promise<void>((resolve) => {
					agent?.once("close", () => resolve());
				});

				// Kill the daemon server + destroy all connections (simulates daemon death)
				for (const conn of daemon.connections) {
					conn.destroy();
				}
				await closeServer(daemon.server);
				daemon = null; // Prevent afterEach double-close

				await closePromise;

				expect(agent.connected).toBe(false);
			},
			TEST_TIMEOUT,
		);
	});
});
