import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { encodeFrame, PROTOCOL_VERSION, type ProtocolMessage } from "@lasterm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LastermAgent } from "./lasterm-agent.js";
import { getTestSocketPath } from "./test-socket-path.js";

const TEST_TIMEOUT = 10_000;

/**
 * Create a mock agent daemon that speaks the lasterm protocol.
 * On each connection it sends HELLO + CHANNEL_STATE_END immediately.
 * Returns the server and a list of connected sockets for assertions.
 */
function createMockDaemon(socketPath: string): Promise<{
	server: net.Server;
	connections: net.Socket[];
}> {
	return new Promise((resolve) => {
		const connections: net.Socket[] = [];

		const server = net.createServer((socket) => {
			connections.push(socket);

			const hello = encodeFrame({
				type: "HELLO",
				version: PROTOCOL_VERSION,
				agentVersion: "0.1.0",
				capabilities: ["multiplex", "resize", "snapshot"],
			});
			socket.write(Buffer.from(hello));

			const end = encodeFrame({ type: "CHANNEL_STATE_END" });
			socket.write(Buffer.from(end));
		});

		server.listen(socketPath, () => resolve({ server, connections }));
	});
}

/**
 * Create a mock agent daemon that sends AGENT_CHANNEL_STATE messages
 * for each provided channel before CHANNEL_STATE_END.
 */
function createMockDaemonWithChannels(
	socketPath: string,
	channels: Array<{ channelId: string; title: string; pid: number; alive: boolean }>,
): Promise<{
	server: net.Server;
	connections: net.Socket[];
}> {
	return new Promise((resolve) => {
		const connections: net.Socket[] = [];

		const server = net.createServer((socket) => {
			connections.push(socket);

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

/** Close a net.Server and wait for the "close" event. */
function closeServer(server: net.Server): Promise<void> {
	return new Promise((resolve) => {
		server.close(() => resolve());
	});
}

describe("LastermAgent", () => {
	let tmpDir: string;
	let socketPath: string;
	let daemon: { server: net.Server; connections: net.Socket[] } | null = null;
	let agent: LastermAgent | null = null;

	beforeEach(async () => {
		tmpDir = await mkdtemp(path.join(os.tmpdir(), "lasterm-agent-test-"));
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

	describe("connectLocal", () => {
		describe("Given an agent daemon listening on UDS", () => {
			it(
				"connects and resolves after HELLO (emits ready)",
				async () => {
					daemon = await createMockDaemon(socketPath);

					const _readyMessages: ProtocolMessage[] = [];
					const connectPromise = LastermAgent.connectLocal(socketPath);

					agent = await connectPromise;

					// The ready event is emitted synchronously during connectLocal,
					// so we verify by checking that the agent resolved successfully
					expect(agent).toBeInstanceOf(LastermAgent);

					// Verify HELLO was received by collecting messages
					const _messages = await new Promise<ProtocolMessage[]>((resolve) => {
						const collected: ProtocolMessage[] = [];
						// Messages already emitted before we listen — check CHANNEL_STATE_END
						// arrives after HELLO (both sent by mock daemon on connect)
						agent?.on("message", (msg: ProtocolMessage) => {
							collected.push(msg);
							if (msg.type === "CHANNEL_STATE_END") {
								resolve(collected);
							}
						});

						// If CHANNEL_STATE_END already passed, resolve after a tick
						setTimeout(() => resolve(collected), 100);
					});

					// At minimum, the agent resolved which means HELLO was received
					expect(agent.connected).toBe(true);
				},
				TEST_TIMEOUT,
			);

			it(
				"exposes connected = true after connect",
				async () => {
					daemon = await createMockDaemon(socketPath);
					agent = await LastermAgent.connectLocal(socketPath);
					expect(agent.connected).toBe(true);
				},
				TEST_TIMEOUT,
			);
		});

		describe("Given no server listening", () => {
			it(
				"rejects with connection error",
				async () => {
					const nonexistentPath = path.join(tmpDir, "nonexistent.sock");
					await expect(LastermAgent.connectLocal(nonexistentPath)).rejects.toThrow();
				},
				TEST_TIMEOUT,
			);
		});
	});

	describe("send", () => {
		it(
			"sends framed messages to the agent",
			async () => {
				// Set up a daemon that captures received data
				const receivedData: Buffer[] = [];

				await new Promise<void>((resolve) => {
					const server = net.createServer((socket) => {
						// Send HELLO so the agent becomes ready
						const hello = encodeFrame({
							type: "HELLO",
							version: PROTOCOL_VERSION,
							agentVersion: "0.1.0",
							capabilities: ["multiplex", "resize", "snapshot"],
						});
						socket.write(Buffer.from(hello));

						socket.on("data", (data: Buffer) => {
							receivedData.push(data);
						});
					});
					daemon = { server, connections: [] };
					server.listen(socketPath, () => resolve());
				});

				agent = await LastermAgent.connectLocal(socketPath);

				agent.send({
					type: "HEARTBEAT",
					ts: "2026-01-01T00:00:00.000Z",
				});

				// Wait a tick for the data to arrive at the server
				await new Promise((r) => setTimeout(r, 50));

				expect(receivedData.length).toBeGreaterThan(0);

				// The received data should be a valid length-prefixed frame
				const combined = Buffer.concat(receivedData);
				// First 4 bytes are the LE length prefix
				expect(combined.length).toBeGreaterThan(4);
				const payloadLen = combined.readUInt32LE(0);
				expect(combined.length).toBe(4 + payloadLen);
			},
			TEST_TIMEOUT,
		);
	});

	describe("close", () => {
		it(
			"disconnects without killing agent server",
			async () => {
				daemon = await createMockDaemon(socketPath);
				agent = await LastermAgent.connectLocal(socketPath);

				const closePromise = new Promise<void>((resolve) => {
					agent?.once("close", () => resolve());
				});

				agent.close();
				await closePromise;

				// Agent server should still be listening
				expect(daemon.server.listening).toBe(true);

				// Prevent afterEach double-close
				agent = null;
			},
			TEST_TIMEOUT,
		);

		it(
			"sets connected to false",
			async () => {
				daemon = await createMockDaemon(socketPath);
				agent = await LastermAgent.connectLocal(socketPath);

				expect(agent.connected).toBe(true);

				const closePromise = new Promise<void>((resolve) => {
					agent?.once("close", () => resolve());
				});

				agent.close();
				await closePromise;

				expect(agent.connected).toBe(false);

				// Prevent afterEach double-close
				agent = null;
			},
			TEST_TIMEOUT,
		);
	});

	describe("message events", () => {
		it(
			"emits message events for received protocol messages",
			async () => {
				let serverSocket: net.Socket | null = null;

				await new Promise<void>((resolve) => {
					const server = net.createServer((socket) => {
						serverSocket = socket;
						// Send HELLO so the agent becomes ready
						const hello = encodeFrame({
							type: "HELLO",
							version: PROTOCOL_VERSION,
							agentVersion: "0.1.0",
							capabilities: ["multiplex", "resize", "snapshot"],
						});
						socket.write(Buffer.from(hello));
					});
					daemon = { server, connections: [] };
					server.listen(socketPath, () => resolve());
				});

				agent = await LastermAgent.connectLocal(socketPath);

				// Now send a HEARTBEAT_ACK from the "daemon"
				const messagePromise = new Promise<ProtocolMessage>((resolve) => {
					agent?.on("message", (msg: ProtocolMessage) => {
						if (msg.type === "HEARTBEAT_ACK") {
							resolve(msg);
						}
					});
				});

				const ackFrame = encodeFrame({
					type: "HEARTBEAT_ACK",
					ts: "2026-06-01T12:00:00.000Z",
				});
				serverSocket?.write(Buffer.from(ackFrame));

				const msg = await messagePromise;
				expect(msg.type).toBe("HEARTBEAT_ACK");
				if (msg.type === "HEARTBEAT_ACK") {
					expect(msg.ts).toBe("2026-06-01T12:00:00.000Z");
				}
			},
			TEST_TIMEOUT,
		);
	});

	describe("waitForChannelState", () => {
		describe("Given agent sends AGENT_CHANNEL_STATE + CHANNEL_STATE_END", () => {
			it(
				"resolves with the channel state list",
				async () => {
					const channels = [
						{ channelId: "ch-001", title: "Terminal", pid: 1234, alive: true },
						{ channelId: "ch-002", title: "Build", pid: 5678, alive: true },
						{ channelId: "ch-003", title: "Logs", pid: 9999, alive: false },
					];

					daemon = await createMockDaemonWithChannels(socketPath, channels);

					agent = await LastermAgent.connectLocal(socketPath);
					const states = await agent.waitForChannelState();

					expect(states).toHaveLength(3);

					expect(states[0]).toMatchObject({
						type: "AGENT_CHANNEL_STATE",
						channelId: "ch-001",
						title: "Terminal",
						pid: 1234,
						alive: true,
					});
					expect(states[1]).toMatchObject({
						type: "AGENT_CHANNEL_STATE",
						channelId: "ch-002",
						title: "Build",
						pid: 5678,
						alive: true,
					});
					expect(states[2]).toMatchObject({
						type: "AGENT_CHANNEL_STATE",
						channelId: "ch-003",
						title: "Logs",
						pid: 9999,
						alive: false,
					});
				},
				TEST_TIMEOUT,
			);
		});

		describe("Given no channels exist", () => {
			it(
				"resolves with empty array when only CHANNEL_STATE_END received",
				async () => {
					daemon = await createMockDaemon(socketPath);

					agent = await LastermAgent.connectLocal(socketPath);
					const states = await agent.waitForChannelState();

					expect(states).toEqual([]);
				},
				TEST_TIMEOUT,
			);
		});

		describe("Given CHANNEL_STATE_END never arrives", () => {
			it(
				"rejects when the connection closes before CHANNEL_STATE_END",
				async () => {
					await new Promise<void>((resolve) => {
						const server = net.createServer((socket) => {
							const hello = encodeFrame({
								type: "HELLO",
								version: PROTOCOL_VERSION,
								agentVersion: "0.1.0",
								capabilities: ["multiplex", "resize", "snapshot"],
							});
							socket.write(Buffer.from(hello), () => {
								socket.destroy();
							});
						});
						daemon = { server, connections: [] };
						server.listen(socketPath, () => resolve());
					});

					agent = await LastermAgent.connectLocal(socketPath);

					await expect(agent.waitForChannelState(1_000)).rejects.toThrow(
						"CHANNEL_STATE connection closed before CHANNEL_STATE_END",
					);
				},
				TEST_TIMEOUT,
			);

			it(
				"rejects with timeout error",
				async () => {
					// Daemon that sends HELLO but no CHANNEL_STATE_END
					await new Promise<void>((resolve) => {
						const server = net.createServer((socket) => {
							const hello = encodeFrame({
								type: "HELLO",
								version: PROTOCOL_VERSION,
								agentVersion: "0.1.0",
								capabilities: ["multiplex", "resize", "snapshot"],
							});
							socket.write(Buffer.from(hello));
							// Intentionally no CHANNEL_STATE_END
						});
						daemon = { server, connections: [] };
						server.listen(socketPath, () => resolve());
					});

					agent = await LastermAgent.connectLocal(socketPath);

					await expect(agent.waitForChannelState(200)).rejects.toThrow("CHANNEL_STATE timeout");
				},
				TEST_TIMEOUT,
			);

			it(
				"cleans up the timer on timeout (no dangling handles)",
				async () => {
					const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

					// Daemon that sends HELLO but no CHANNEL_STATE_END
					await new Promise<void>((resolve) => {
						const server = net.createServer((socket) => {
							const hello = encodeFrame({
								type: "HELLO",
								version: PROTOCOL_VERSION,
								agentVersion: "0.1.0",
								capabilities: ["multiplex", "resize", "snapshot"],
							});
							socket.write(Buffer.from(hello));
						});
						daemon = { server, connections: [] };
						server.listen(socketPath, () => resolve());
					});

					agent = await LastermAgent.connectLocal(socketPath);

					await expect(agent.waitForChannelState(100)).rejects.toThrow("CHANNEL_STATE timeout");

					// The .finally() handler should have called clearTimeout
					expect(clearTimeoutSpy).toHaveBeenCalled();

					clearTimeoutSpy.mockRestore();
				},
				TEST_TIMEOUT,
			);
		});
	});
});
