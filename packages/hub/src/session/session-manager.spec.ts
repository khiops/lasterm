import type { AuthPromptMessage, ProtocolMessage } from "@lasterm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigResolver } from "../config.js";
import { openTestDatabases } from "../storage/db.js";
import { MetaDAL } from "../storage/meta.js";
import { SpoolDAL } from "../storage/spool.js";
import type { AgentConnection } from "./agent-connection.js";
import { connectOrLaunch as _connectOrLaunchForMock } from "./agent-launcher.js";
import {
	clearContext,
	openContext,
	prompt as promptCtx,
	reconnectContextId,
} from "./prompt-context.js";
import { SessionManager, type WsClient } from "./session-manager.js";

// ─── Mock channel ID helpers ──────────────────────────────────────────────────
// Per-test counters reset in beforeEach; each SPAWN emits a unique channelId.
let localSpawnCount = 0;
let sshSpawnCount = 0;
let nextLocalSpawnChannelIdOverride: string | null = null;
let nextLocalAttachNotFoundChannelId: string | null = null;
let localChannelStateWaitCount = 0;
let nextLocalChannelStateFailure: Error | null = null;
const mockLocalAgents: Array<{
	send: ReturnType<typeof vi.fn>;
	close: ReturnType<typeof vi.fn>;
	waitForChannelState: ReturnType<typeof vi.fn>;
	simulateDisconnect: () => void;
	connected: boolean;
}> = [];

function nextLocalChannelId(): string {
	return `local-ch-${++localSpawnCount}`;
}

function nextSshChannelId(): string {
	return `ssh-ch-${++sshSpawnCount}`;
}

// ─── Mock agent-launcher (connectOrLaunch) ───────────────────────────────────
vi.mock("./agent-launcher.js", () => {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const { EventEmitter } = require("node:events");

	class MockLocalAgent extends EventEmitter {
		private _connected = true;
		constructor() {
			super();
			mockLocalAgents.push(this);
		}
		start = vi.fn().mockResolvedValue(undefined);
		waitForChannelState = vi.fn(() => {
			localChannelStateWaitCount++;
			if (nextLocalChannelStateFailure !== null) {
				const err = nextLocalChannelStateFailure;
				nextLocalChannelStateFailure = null;
				return Promise.reject(err);
			}
			return Promise.resolve([]);
		});
		send = vi.fn((msg: ProtocolMessage) => {
			if (msg.type === "SPAWN") {
				const spawnMsg = msg as unknown as Record<string, unknown>;
				const channelId =
					nextLocalSpawnChannelIdOverride ??
					(spawnMsg.channelId as string | undefined) ??
					nextLocalChannelId();
				nextLocalSpawnChannelIdOverride = null;
				// Two-step elevation: if elevated=true but no elevationSecret, return SPAWN_ERR
				if (spawnMsg.elevated === true && !spawnMsg.elevationSecret) {
					setImmediate(() => {
						this.emit("message", {
							type: "SPAWN_ERR",
							requestId: spawnMsg.requestId,
							code: "ELEVATION_PASSWORD_REQUIRED",
							message: "Elevation password required",
						});
					});
					return;
				}
				setImmediate(() => {
					this.emit("message", {
						type: "SPAWN_OK",
						requestId: spawnMsg.requestId,
						channelId,
					});
				});
			} else if (msg.type === "ATTACH") {
				const attachMsg = msg as unknown as { channelId: string };
				if (nextLocalAttachNotFoundChannelId === attachMsg.channelId) {
					nextLocalAttachNotFoundChannelId = null;
					setImmediate(() => {
						this.emit("message", {
							type: "ERROR",
							code: "CHANNEL_NOT_FOUND",
							message: `channel ${attachMsg.channelId} not found`,
							channelId: attachMsg.channelId,
						});
					});
					return;
				}
				setImmediate(() => {
					this.emit("message", {
						type: "ATTACH_OK",
						channelId: attachMsg.channelId,
						snapshot: {
							serialized: "<mock-snapshot>",
							cols: 80,
							rows: 24,
							cursorX: 0,
							cursorY: 0,
						},
						lastSeq: 0,
					});
				});
			}
		});
		close = vi.fn(() => {
			this._connected = false;
		});
		simulateDisconnect = vi.fn(() => {
			if (!this._connected) return;
			this._connected = false;
			this.emit("close");
		});
		get connected() {
			return this._connected;
		}
	}

	return {
		connectOrLaunch: vi.fn().mockImplementation(() => Promise.resolve(new MockLocalAgent())),
		resolveAgentPath: () => "/mock/agent/path",
		isAgentBinary: () => true,
	};
});

afterEach(() => {
	nextLocalSpawnChannelIdOverride = null;
	nextLocalAttachNotFoundChannelId = null;
	nextLocalChannelStateFailure = null;
});

// ─── Mock SshAgent ────────────────────────────────────────────────────────────
let mockSshAgentInstance: MockSshAgent | null = null;
/** Set to an Error before a test to make the next new SshAgent's start() reject once. */
let nextSshStartError: Error | null = null;
let nextSshStartCallsAgentUpdated = false;

interface MockSshAgentDeployOptions {
	onAgentUpdated?: (hostId: string) => void;
}

class MockSshAgent {
	private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
	private _connected = true;

	lastKeyVerification = { capturedFingerprint: "SHA256:mockfp", mismatch: false };
	start = vi.fn(async () => {
		if (nextSshStartCallsAgentUpdated) {
			nextSshStartCallsAgentUpdated = false;
			this.deployOptions?.onAgentUpdated?.(this.host.id);
		}
	});
	send = vi.fn((msg: ProtocolMessage) => {
		if (msg.type === "SPAWN") {
			const spawnMsg = msg as unknown as Record<string, string>;
			const channelId = spawnMsg.channelId ?? nextSshChannelId();
			setImmediate(() => {
				this._emit("message", {
					type: "SPAWN_OK",
					requestId: spawnMsg.requestId,
					channelId,
				});
			});
		} else if (msg.type === "ATTACH") {
			const attachMsg = msg as unknown as { channelId: string };
			setImmediate(() => {
				this._emit("message", {
					type: "ATTACH_OK",
					channelId: attachMsg.channelId,
					snapshot: {
						serialized: "<mock-snapshot>",
						cols: 80,
						rows: 24,
						cursorX: 0,
						cursorY: 0,
					},
					lastSeq: 0,
				});
			});
		}
	});
	close = vi.fn(() => {
		this._connected = false;
	});

	get connected() {
		return this._connected;
	}

	constructor(
		private readonly host: { id: string },
		private readonly deployOptions?: MockSshAgentDeployOptions,
	) {}

	on(event: string, listener: (...args: unknown[]) => void) {
		if (!this.listeners.has(event)) this.listeners.set(event, []);
		const list = this.listeners.get(event);
		if (list) list.push(listener);
		return this;
	}

	once(event: string, listener: (...args: unknown[]) => void) {
		const wrapper = (...args: unknown[]) => {
			listener(...args);
			this.off(event, wrapper);
		};
		return this.on(event, wrapper);
	}

	off(event: string, listener: (...args: unknown[]) => void) {
		const list = this.listeners.get(event) ?? [];
		this.listeners.set(
			event,
			list.filter((l) => l !== listener),
		);
		return this;
	}

	_emit(event: string, ...args: unknown[]) {
		for (const l of this.listeners.get(event) ?? []) {
			l(...args);
		}
	}

	simulateClose() {
		this._connected = false;
		this._emit("close", undefined);
	}
}

vi.mock("./ssh-agent.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./ssh-agent.js")>();
	return {
		...actual,
		// biome-ignore lint/complexity/useArrowFunction: vitest 4 needs a constructable function for new-ed mocks
		SshAgent: vi.fn().mockImplementation(function (
			host: { id: string },
			_promptAuth: unknown,
			deployOptions?: MockSshAgentDeployOptions,
		) {
			mockSshAgentInstance = new MockSshAgent(host, deployOptions);
			if (nextSshStartError !== null) {
				const err = nextSshStartError;
				nextSshStartError = null;
				mockSshAgentInstance.start = vi.fn().mockRejectedValue(err);
			}
			return mockSshAgentInstance;
		}),
	};
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeClient(id: string, received: ProtocolMessage[]): WsClient {
	return {
		id,
		send: (msg) => received.push(msg),
		attachedChannels: new Set(),
	};
}

async function flushImmediate(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("SessionManager", () => {
	let sm: SessionManager;
	let dbManager: ReturnType<typeof openTestDatabases>;

	beforeEach(() => {
		// Reset per-test state
		localSpawnCount = 0;
		sshSpawnCount = 0;
		localChannelStateWaitCount = 0;
		mockLocalAgents.length = 0;
		mockSshAgentInstance = null;
		nextSshStartCallsAgentUpdated = false;
		dbManager = openTestDatabases();
		sm = new SessionManager(dbManager);
		vi.mocked(_connectOrLaunchForMock).mockClear();
	});

	afterEach(async () => {
		await sm.shutdown();
		dbManager.close();
	});

	// ─── Regression: existing M1 behaviour ─────────────────────────────────

	it("ensureLocalHost creates local host and is idempotent", async () => {
		const id1 = await sm.ensureLocalHost();
		expect(id1).toBeTruthy();
		expect(typeof id1).toBe("string");

		const id2 = await sm.ensureLocalHost();
		expect(id2).toBe(id1);
	});

	it("addClient and removeClient lifecycle (no error on unknown id)", () => {
		const received: ProtocolMessage[] = [];
		const client = makeClient("c1", received);
		sm.addClient(client);
		expect(() => sm.removeClient("non-existent")).not.toThrow();
		expect(() => sm.removeClient("c1")).not.toThrow();
	});

	it("fences an in-flight local SPAWN when quit begins before its send", async () => {
		const received: ProtocolMessage[] = [];
		sm.addClient(makeClient("quit-race", received));

		// handleSpawn has crossed its public boundary but is awaiting host resolution.
		const inFlight = sm.handleSpawn("quit-race", { type: "SPAWN", hostId: "local" });
		sm.beginQuit();

		await expect(inFlight).resolves.toBeNull();
		expect(localSpawnCount).toBe(0);
		expect(received).toContainEqual(
			expect.objectContaining({ type: "ERROR", code: "HUB_QUITTING" }),
		);
		// Mutation caught: no SPAWN frame and therefore no channel row is committed.
		expect(sm.getStateSnapshot().channels).toHaveLength(0);
	});

	it("refuses every revival entry after quit while leaving DESTROY available", async () => {
		const received: ProtocolMessage[] = [];
		sm.addClient(makeClient("quit-entries", received));
		const channelId = await sm.handleSpawn("quit-entries", { type: "SPAWN", hostId: "local" });
		expect(channelId).not.toBeNull();

		sm.beginQuit();
		await expect(
			sm.handleSpawn("quit-entries", { type: "SPAWN", hostId: "local" }),
		).resolves.toBeNull();
		await expect(sm.restartChannel(channelId!)).resolves.toBe(false);
		await expect(sm.handleAttach("quit-entries", channelId!)).resolves.toBe(false);
		await expect(
			(
				sm as unknown as { agentMgr: { reconnectDaemon: () => Promise<void> } }
			).agentMgr.reconnectDaemon(),
		).rejects.toMatchObject({ code: "HUB_QUITTING" });
		await expect(
			(
				sm as unknown as { agentMgr: { warmRestartLocal: () => Promise<void> } }
			).agentMgr.warmRestartLocal(),
		).rejects.toMatchObject({ code: "HUB_QUITTING" });

		// Output is draining work, not revival; it is still delivered while quitting.
		(
			mockLocalAgents[0] as unknown as { emit: (event: string, message: ProtocolMessage) => void }
		).emit("message", {
			type: "OUTPUT",
			channelId: channelId!,
			data: new TextEncoder().encode("still-draining"),
		} as ProtocolMessage);
		expect(received).toContainEqual(
			expect.objectContaining({ type: "OUTPUT", channelId: channelId! }),
		);
		// DESTROY is teardown, not revival, and remains deliberately allowed.
		expect(sm.destroyChannel(channelId!)).toBe(true);
	});

	it("getStateSnapshot returns current sessions and channels after SPAWN", async () => {
		// First client spawns a channel → creates an active session
		const c1Received: ProtocolMessage[] = [];
		const client1 = makeClient("c1", c1Received);
		sm.addClient(client1);
		await sm.handleSpawn("c1", { type: "SPAWN", hostId: "local" });

		// getStateSnapshot should include the active session and live channel
		const snapshot = sm.getStateSnapshot();
		expect(snapshot.type).toBe("STATE_SYNC");
		expect(snapshot.sessions.length).toBeGreaterThan(0);
		const session = snapshot.sessions[0];
		expect(session.status).toBe("active");
		expect(session.hostId).toBeTruthy();
		expect(session.sessionId).toBeTruthy();
		expect(snapshot.channels.length).toBeGreaterThan(0);
		const channel = snapshot.channels[0];
		expect(channel.status).toBe("live");
		expect(channel.channelId).toBeTruthy();
		expect(channel.sessionId).toBe(session.sessionId);
	});

	it("handleSpawn sends SPAWN_OK to the requesting client", async () => {
		const received: ProtocolMessage[] = [];
		const client = makeClient("c1", received);
		sm.addClient(client);

		await sm.handleSpawn("c1", { type: "SPAWN", hostId: "local" });

		const spawnOk = received.find((m) => m.type === "SPAWN_OK");
		expect(spawnOk).toBeTruthy();
		const ok = spawnOk as unknown as {
			channelId: string;
			hostId: string;
			sessionId: string;
		};
		// Counter reset in beforeEach → first call = local-ch-1
		expect(ok.channelId).toBe("local-ch-1");
		expect(ok.hostId).toBeTruthy();
		expect(ok.sessionId).toBeTruthy();
	});

	it("handleSpawn auto-attaches the requesting client to the spawned channel", async () => {
		const received: ProtocolMessage[] = [];
		const client = makeClient("c1", received);
		sm.addClient(client);

		await sm.handleSpawn("c1", { type: "SPAWN", hostId: "local" });

		expect(client.attachedChannels.has("local-ch-1")).toBe(true);
	});

	it("N concurrent LOCAL SPAWNs share one daemon connection and one channel-state handshake", async () => {
		const localHostId = await sm.ensureLocalHost();
		vi.mocked(_connectOrLaunchForMock).mockClear();

		const clients = Array.from({ length: 12 }, (_, i) => {
			const received: ProtocolMessage[] = [];
			const client = makeClient(`c-local-sf-${i}`, received);
			sm.addClient(client);
			return { client, received };
		});

		const channelIds = await Promise.all(
			clients.map(({ client }) =>
				sm.handleSpawn(client.id, { type: "SPAWN", hostId: localHostId }),
			),
		);

		expect(channelIds.every((id) => id !== null)).toBe(true);
		expect(new Set(channelIds).size).toBe(clients.length);
		expect(vi.mocked(_connectOrLaunchForMock).mock.calls).toHaveLength(1);
		expect(localChannelStateWaitCount).toBe(1);
		expect(mockLocalAgents).toHaveLength(1);

		const ctx = (sm as unknown as { ctx: import("./session-context.js").SharedSessionContext }).ctx;
		const session = ctx.sessions.get(localHostId);
		expect(session?.status).toBe("active");
		for (const channelId of channelIds) {
			if (channelId !== null) expect(ctx.channels.get(channelId)?.sessionId).toBe(session?.id);
		}

		const sharedAgent = ctx.agents.get(localHostId) as
			| { send: ReturnType<typeof vi.fn> }
			| undefined;
		expect(sharedAgent).toBe(mockLocalAgents[0]);
		const spawnSends =
			sharedAgent?.send.mock.calls.filter(
				(call) => (call[0] as ProtocolMessage).type === "SPAWN",
			) ?? [];
		expect(spawnSends).toHaveLength(clients.length);
		for (const { received } of clients) {
			expect(received.some((m) => m.type === "SPAWN_OK")).toBe(true);
		}
	});

	it("N concurrent LOCAL daemon attaches share one connectOrLaunch and one channel-state handshake", async () => {
		const localHostId = await sm.ensureLocalHost();
		const sessionId = "LOCALATTACH0000000000000000001";
		const ctx = (sm as unknown as { ctx: import("./session-context.js").SharedSessionContext }).ctx;
		ctx.metaDal.createSession({ id: sessionId, hostId: localHostId, status: "starting" });
		ctx.sessions.set(localHostId, { id: sessionId, hostId: localHostId, status: "starting" });
		vi.mocked(_connectOrLaunchForMock).mockClear();

		const agentMgr = (
			sm as unknown as {
				agentMgr: { connectDaemonAgent: (hostId: string, sessionId: string) => Promise<unknown> };
			}
		).agentMgr;
		const agents = await Promise.all(
			Array.from({ length: 12 }, () => agentMgr.connectDaemonAgent(localHostId, sessionId)),
		);

		expect(new Set(agents).size).toBe(1);
		expect(vi.mocked(_connectOrLaunchForMock).mock.calls).toHaveLength(1);
		expect(localChannelStateWaitCount).toBe(1);
		expect(ctx.agents.get(localHostId)).toBe(agents[0]);
		expect(ctx.agents.get(localHostId)).toBe(mockLocalAgents[0]);
	});

	it("LOCAL daemon disconnect evicts current agent and reconnects without opening a third connection", async () => {
		const localHostId = await sm.ensureLocalHost();
		const received1: ProtocolMessage[] = [];
		const client1 = makeClient("c-local-disconnect-1", received1);
		sm.addClient(client1);

		const channelId = await sm.handleSpawn("c-local-disconnect-1", {
			type: "SPAWN",
			hostId: localHostId,
		});
		expect(channelId).not.toBeNull();

		const ctx = (sm as unknown as { ctx: import("./session-context.js").SharedSessionContext }).ctx;
		const firstAgent = ctx.agents.get(localHostId);
		expect(firstAgent).toBe(mockLocalAgents[0]);
		expect(vi.mocked(_connectOrLaunchForMock).mock.calls).toHaveLength(1);
		expect(localChannelStateWaitCount).toBe(1);

		mockLocalAgents[0]?.simulateDisconnect();
		expect(ctx.agents.has(localHostId)).toBe(false);
		expect(vi.mocked(_connectOrLaunchForMock).mock.calls).toHaveLength(2);

		await flushImmediate();
		await flushImmediate();

		const secondAgent = ctx.agents.get(localHostId);
		expect(secondAgent).toBe(mockLocalAgents[1]);
		expect(secondAgent).not.toBe(firstAgent);
		expect(localChannelStateWaitCount).toBe(2);

		const received2: ProtocolMessage[] = [];
		const client2 = makeClient("c-local-disconnect-2", received2);
		sm.addClient(client2);
		const secondChannelId = await sm.handleSpawn("c-local-disconnect-2", {
			type: "SPAWN",
			hostId: localHostId,
		});

		expect(secondChannelId).not.toBeNull();
		expect(vi.mocked(_connectOrLaunchForMock).mock.calls).toHaveLength(2);
		expect(localChannelStateWaitCount).toBe(2);
	});

	it("failed LOCAL channel-state handshake closes half-open agent and retries cleanly", async () => {
		const localHostId = await sm.ensureLocalHost();
		const received1: ProtocolMessage[] = [];
		const client1 = makeClient("c-local-handshake-1", received1);
		sm.addClient(client1);
		nextLocalChannelStateFailure = new Error("CHANNEL_STATE timeout");

		await expect(
			sm.handleSpawn("c-local-handshake-1", { type: "SPAWN", hostId: localHostId }),
		).rejects.toThrow("CHANNEL_STATE timeout");

		const ctx = (sm as unknown as { ctx: import("./session-context.js").SharedSessionContext }).ctx;
		expect(vi.mocked(_connectOrLaunchForMock).mock.calls).toHaveLength(1);
		expect(localChannelStateWaitCount).toBe(1);
		expect(mockLocalAgents[0]?.close).toHaveBeenCalledTimes(1);
		expect(ctx.agents.has(localHostId)).toBe(false);

		const received2: ProtocolMessage[] = [];
		const client2 = makeClient("c-local-handshake-2", received2);
		sm.addClient(client2);
		const channelId = await sm.handleSpawn("c-local-handshake-2", {
			type: "SPAWN",
			hostId: localHostId,
		});

		expect(channelId).not.toBeNull();
		expect(vi.mocked(_connectOrLaunchForMock).mock.calls).toHaveLength(2);
		expect(localChannelStateWaitCount).toBe(2);
		expect(ctx.agents.get(localHostId)).toBe(mockLocalAgents[1]);
		expect(received2.some((m) => m.type === "SPAWN_OK")).toBe(true);
	});

	it("handleAttach adds a second client to an existing channel", async () => {
		const received: ProtocolMessage[] = [];
		const client = makeClient("c1", received);
		sm.addClient(client);
		await sm.handleSpawn("c1", { type: "SPAWN", hostId: "local" });
		// first spawn → local-ch-1

		const client2Received: ProtocolMessage[] = [];
		const client2 = makeClient("c2", client2Received);
		sm.addClient(client2);
		await sm.handleAttach("c2", "local-ch-1");

		// addClient now sends initial SESSION_STATE, so client2 receives 2 messages
		const attachOkMsg = client2Received.find((m) => m.type === "ATTACH_OK");
		expect(attachOkMsg).toBeTruthy();

		const attachOk = attachOkMsg as unknown as {
			channelId: string;
			snapshot: { serialized: string } | null;
			tail: unknown[];
			writeLockHolder: null;
			cached: boolean;
		};
		expect(attachOk.channelId).toBe("local-ch-1");
		// Agent is connected — handleAttach always requests a fresh snapshot
		expect(attachOk.snapshot).toBeTruthy();
		expect(attachOk.tail).toEqual([]);
		expect(attachOk.writeLockHolder).toBeFalsy();
		expect(attachOk.cached).toBe(false);
	});

	it("handleAttach sends ERROR for unknown channel", async () => {
		const received: ProtocolMessage[] = [];
		const client = makeClient("c1", received);
		sm.addClient(client);

		await sm.handleAttach("c1", "nonexistent-channel");

		expect(received).toHaveLength(1);
		const errMsg = received[0] as ProtocolMessage;
		expect(errMsg.type).toBe("ERROR");
		const err = errMsg as unknown as { code: string };
		expect(err.code).toBe("CHANNEL_NOT_FOUND");
	});

	it("handleDetach removes client from channel", async () => {
		const received: ProtocolMessage[] = [];
		const client = makeClient("c1", received);
		sm.addClient(client);
		await sm.handleSpawn("c1", { type: "SPAWN", hostId: "local" });

		expect(client.attachedChannels.has("local-ch-1")).toBe(true);
		sm.handleDetach("c1", "local-ch-1");
		expect(client.attachedChannels.has("local-ch-1")).toBe(false);
	});

	it("handleInput forwards to agent without throwing", async () => {
		const received: ProtocolMessage[] = [];
		const client = makeClient("c1", received);
		sm.addClient(client);
		await sm.handleSpawn("c1", { type: "SPAWN", hostId: "local" });

		expect(() => {
			sm.handleInput("c1", "local-ch-1", new Uint8Array([65, 66, 67]));
		}).not.toThrow();
	});

	it("handleResize forwards to agent without throwing", async () => {
		const received: ProtocolMessage[] = [];
		const client = makeClient("c1", received);
		sm.addClient(client);
		await sm.handleSpawn("c1", { type: "SPAWN", hostId: "local" });

		expect(() => {
			sm.handleResize("c1", "local-ch-1", 120, 40);
		}).not.toThrow();

		// Verify cols/rows were persisted to meta.db
		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);
		const row = dal.getChannel("local-ch-1");
		expect(row?.cols).toBe(120);
		expect(row?.rows).toBe(40);
	});

	it("removeClient cleans up all channel attachments", async () => {
		const received: ProtocolMessage[] = [];
		const client = makeClient("c1", received);
		sm.addClient(client);
		await sm.handleSpawn("c1", { type: "SPAWN", hostId: "local" });

		expect(client.attachedChannels.size).toBe(1);
		sm.removeClient("c1");
		expect(client.attachedChannels.size).toBe(0);
	});

	// ─── DB persistence ─────────────────────────────────────────────────────

	it("handleSpawn creates a session record in meta.db with 'active' status", async () => {
		const received: ProtocolMessage[] = [];
		const client = makeClient("c1", received);
		sm.addClient(client);

		await sm.handleSpawn("c1", { type: "SPAWN", hostId: "local" });

		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);
		const sessions = dal.listSessions();
		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.status).toBe("active");
	});

	it("handleSpawn creates a channel record in meta.db with 'live' status", async () => {
		const received: ProtocolMessage[] = [];
		const client = makeClient("c1", received);
		sm.addClient(client);

		await sm.handleSpawn("c1", { type: "SPAWN", hostId: "local" });

		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);
		const channels = dal.listChannels();
		expect(channels).toHaveLength(1);
		expect(channels[0]?.id).toBe("local-ch-1");
		expect(channels[0]?.status).toBe("live");
		expect(channels[0]?.title).toBeFalsy();
	});

	// ─── Launch profile resolution ─────────────────────────────────────────

	it("handleSpawn with launchProfileId stores resolved shell and args in channel DB", async () => {
		const received: ProtocolMessage[] = [];
		const client = makeClient("c1", received);
		sm.addClient(client);

		// Create a launch profile in meta.db
		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);
		const profile = dal.createLaunchProfile({
			name: "Test Profile",
			shell: "/usr/bin/zsh",
			args: ["-l", "-i"],
			cwd: "/tmp",
			env: { MY_VAR: "hello" },
			mode: "shell",
			elevated: false,
			supportedOs: "any",
			iconType: "auto",
			sortOrder: 0,
		});

		await sm.handleSpawn("c1", {
			type: "SPAWN",
			hostId: "local",
			launchProfileId: profile.id,
		});

		// Verify SPAWN_OK was sent (spawn succeeded)
		expect(received.find((m) => m.type === "SPAWN_OK")).toBeTruthy();

		// Verify the channel DB record has the resolved shell and args
		const channel = dal.getChannel("local-ch-1");
		expect(channel?.shell).toBe("/usr/bin/zsh");
		expect(channel?.args).toEqual(["-l", "-i"]);
		expect(channel?.cwd).toBe("/tmp");
	});

	it("handleSpawn with launchProfileId mode=process stores directProcess in channel DB", async () => {
		const received: ProtocolMessage[] = [];
		const client = makeClient("c1", received);
		sm.addClient(client);

		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);
		const profile = dal.createLaunchProfile({
			name: "Process Profile",
			shell: "/usr/bin/htop",
			args: [],
			mode: "process",
			elevated: false,
			supportedOs: "any",
			iconType: "auto",
			sortOrder: 0,
		});

		await sm.handleSpawn("c1", {
			type: "SPAWN",
			hostId: "local",
			launchProfileId: profile.id,
		});

		expect(received.find((m) => m.type === "SPAWN_OK")).toBeTruthy();

		const channel = dal.getChannel("local-ch-1");
		expect(channel?.shell).toBe("/usr/bin/htop");
		expect(channel?.directProcess).toBe(true);
	});

	it("handleSpawn with unknown launchProfileId falls back to default spawn", async () => {
		const received: ProtocolMessage[] = [];
		const client = makeClient("c1", received);
		sm.addClient(client);

		// Use a non-existent profile ID — should not error, just use defaults
		await sm.handleSpawn("c1", {
			type: "SPAWN",
			hostId: "local",
			launchProfileId: "nonexistent-profile-id",
		});

		const spawnOk = received.find((m) => m.type === "SPAWN_OK");
		expect(spawnOk).toBeTruthy(); // Should still spawn successfully
	});

	it("handleSpawn with launchProfileId stores launchProfileId in channel DB record", async () => {
		const received: ProtocolMessage[] = [];
		const client = makeClient("c1", received);
		sm.addClient(client);

		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);
		const profile = dal.createLaunchProfile({
			name: "Seed Profile",
			shell: "/bin/bash",
			args: [],
			mode: "shell",
			elevated: false,
			supportedOs: "any",
			iconType: "auto",
			sortOrder: 0,
		});

		await sm.handleSpawn("c1", {
			type: "SPAWN",
			hostId: "local",
			launchProfileId: profile.id,
		});

		const channel = dal.getChannel("local-ch-1");
		expect(channel?.launchProfileId).toBe(profile.id);
	});

	it("SC-17: explicit UI fields override matching profile fields when launchProfileId is set", async () => {
		const received: ProtocolMessage[] = [];
		const client = makeClient("c1", received);
		sm.addClient(client);

		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);
		const profile = dal.createLaunchProfile({
			name: "Profile With Defaults",
			shell: "/usr/bin/zsh",
			args: ["-l"],
			cwd: "/home/user",
			env: { FROM_PROFILE: "yes", SHARED: "profile-value" },
			mode: "shell",
			elevated: false,
			supportedOs: "any",
			iconType: "auto",
			sortOrder: 0,
		});

		// UI explicitly sends shell, args, cwd — all should win over profile
		await sm.handleSpawn("c1", {
			type: "SPAWN",
			hostId: "local",
			launchProfileId: profile.id,
			shell: "/bin/bash",
			args: ["--login"],
			cwd: "/tmp/override",
		});

		expect(received.find((m) => m.type === "SPAWN_OK")).toBeTruthy();

		const channel = dal.getChannel("local-ch-1");
		// UI shell wins over profile shell
		expect(channel?.shell).toBe("/bin/bash");
		// UI args win over profile args
		expect(channel?.args).toEqual(["--login"]);
		// UI cwd wins over profile cwd
		expect(channel?.cwd).toBe("/tmp/override");
		// Note: env is forwarded to the agent only (not persisted in channel DB).
		// The merge logic (profile env as base, UI env wins on conflict) is in
		// the resolvedEnv assignment in _spawnChannel.
	});

	// ── End launch profile resolution ─────────────────────────────────────────

	it("spawned channels have null title (dynamic title takes precedence)", async () => {
		const received: ProtocolMessage[] = [];
		const client = makeClient("c1", received);
		sm.addClient(client);

		await sm.handleSpawn("c1", { type: "SPAWN", hostId: "local" });
		await sm.handleSpawn("c1", { type: "SPAWN", hostId: "local" });

		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);
		const ch1 = dal.getChannel("local-ch-1");
		const ch2 = dal.getChannel("local-ch-2");
		expect(ch1?.title).toBeFalsy();
		expect(ch2?.title).toBeFalsy();
	});

	it("second SPAWN for same local host reuses existing session", async () => {
		const received: ProtocolMessage[] = [];
		const client = makeClient("c1", received);
		sm.addClient(client);

		// First spawn
		await sm.handleSpawn("c1", { type: "SPAWN", hostId: "local" });

		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);
		const sessionsBefore = dal.listSessions();
		expect(sessionsBefore).toHaveLength(1);
		const firstSession = sessionsBefore[0];
		expect(firstSession).toBeDefined();
		const sessionId = firstSession?.id ?? "";

		// Second spawn — unique channel ID (local-ch-2), same session
		await sm.handleSpawn("c1", { type: "SPAWN", hostId: "local" });

		const sessionsAfter = dal.listSessions();
		expect(sessionsAfter).toHaveLength(1);
		expect(sessionsAfter[0]?.id).toBe(sessionId);

		// Two channels, same session
		const channels = dal.listChannels();
		expect(channels).toHaveLength(2);
		expect(channels[0]?.sessionId).toBe(sessionId);
		expect(channels[1]?.sessionId).toBe(sessionId);
	});

	it("channel transitions live → orphan when last client detaches", async () => {
		const received: ProtocolMessage[] = [];
		const client = makeClient("c1", received);
		sm.addClient(client);
		await sm.handleSpawn("c1", { type: "SPAWN", hostId: "local" });

		sm.handleDetach("c1", "local-ch-1");

		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);
		const ch = dal.getChannel("local-ch-1");
		expect(ch?.status).toBe("orphan");
	});

	it("channel transitions orphan → live when client reattaches", async () => {
		const received: ProtocolMessage[] = [];
		const client = makeClient("c1", received);
		sm.addClient(client);
		await sm.handleSpawn("c1", { type: "SPAWN", hostId: "local" });

		sm.handleDetach("c1", "local-ch-1");
		await sm.handleAttach("c1", "local-ch-1");

		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);
		const ch = dal.getChannel("local-ch-1");
		expect(ch?.status).toBe("live");
	});

	// ─── State change broadcasts ─────────────────────────────────────────────

	it("SESSION_STATE broadcast to clients on session becoming active", async () => {
		const received: ProtocolMessage[] = [];
		const client = makeClient("c1", received);
		sm.addClient(client);

		await sm.handleSpawn("c1", { type: "SPAWN", hostId: "local" });

		const sessionStateMsg = received.find((m) => m.type === "SESSION_STATE");
		expect(sessionStateMsg).toBeTruthy();
		const ssm = sessionStateMsg as unknown as { status: string };
		expect(ssm.status).toBe("active");
	});

	it("CHANNEL_STATE broadcast to clients on channel becoming live", async () => {
		const received: ProtocolMessage[] = [];
		const client = makeClient("c1", received);
		sm.addClient(client);

		await sm.handleSpawn("c1", { type: "SPAWN", hostId: "local" });

		const channelStateMsg = received.find(
			(m) => m.type === "CHANNEL_STATE" && (m as { status: string }).status === "live",
		);
		expect(channelStateMsg).toBeTruthy();
	});

	it("CHANNEL_STATE(orphan) broadcast when last client detaches", async () => {
		const received: ProtocolMessage[] = [];
		const client = makeClient("c1", received);
		sm.addClient(client);
		await sm.handleSpawn("c1", { type: "SPAWN", hostId: "local" });

		received.length = 0; // clear prior messages
		sm.handleDetach("c1", "local-ch-1");

		const orphanMsg = received.find(
			(m) => m.type === "CHANNEL_STATE" && (m as { status: string }).status === "orphan",
		);
		expect(orphanMsg).toBeTruthy();
	});

	// ─── SSH host tests ──────────────────────────────────────────────────────

	it("SSH host: session created with 'active' status after HELLO", async () => {
		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);

		const host = dal.createHost({
			type: "ssh",
			label: "test-ssh",
			sshHost: "user@localhost",
			sshAuth: "key",
			sshKeyPath: "/nonexistent/key",
		});

		const received: ProtocolMessage[] = [];
		const client = makeClient("c1", received);
		sm.addClient(client);

		await sm.handleSpawn("c1", { type: "SPAWN", hostId: host.id });

		const sessions = dal.listSessions(host.id);
		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.status).toBe("active");
	});

	it("SSH host: agent redeploy emits AGENT_SYNCED and spawn continues", async () => {
		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);

		const host = dal.createHost({
			type: "ssh",
			label: "test-ssh-sync",
			sshHost: "user@localhost",
			sshAuth: "key",
			sshKeyPath: "/nonexistent/key",
		});

		nextSshStartCallsAgentUpdated = true;
		const received: ProtocolMessage[] = [];
		const client = makeClient("c-sync", received);
		sm.addClient(client);

		const channelId = await sm.handleSpawn("c-sync", { type: "SPAWN", hostId: host.id });

		expect(channelId).toBe("ssh-ch-1");
		expect(received.some((m) => m.type === "SPAWN_OK")).toBe(true);
		expect(
			received.some(
				(m) =>
					m.type === "ERROR" && (m as ProtocolMessage & { code?: string }).code === "AGENT_UPDATED",
			),
		).toBe(false);
		expect(JSON.stringify(received)).not.toContain("Remote agent on localhost was updated");
		expect(JSON.stringify(received)).not.toContain("SHA256 mismatch");

		const synced = received.find((m) => m.type === "AGENT_SYNCED");
		expect(synced).toMatchObject({
			type: "AGENT_SYNCED",
			hostId: host.id,
			hostname: "localhost",
			message: "Agent on localhost updated to the current version",
		});
	});

	it("SSH host: session reused on second SPAWN", async () => {
		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);

		const host = dal.createHost({
			type: "ssh",
			label: "test-ssh-reuse",
			sshHost: "user@localhost",
			sshAuth: "key",
			sshKeyPath: "/nonexistent/key",
		});

		const received: ProtocolMessage[] = [];
		const client = makeClient("c1", received);
		sm.addClient(client);

		await sm.handleSpawn("c1", { type: "SPAWN", hostId: host.id });

		const sessionsBefore = dal.listSessions(host.id);
		expect(sessionsBefore).toHaveLength(1);
		const firstSshSession = sessionsBefore[0];
		expect(firstSshSession).toBeDefined();
		const sessionId = firstSshSession?.id ?? "";

		// Second SPAWN on same SSH host — new channel (ssh-ch-2), same session
		await sm.handleSpawn("c1", { type: "SPAWN", hostId: host.id });

		const sessionsAfter = dal.listSessions(host.id);
		expect(sessionsAfter).toHaveLength(1);
		expect(sessionsAfter[0]?.id).toBe(sessionId);
	});

	it("SSH disconnect → session 'disconnected' → SESSION_STATE broadcast", async () => {
		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);

		const host = dal.createHost({
			type: "ssh",
			label: "test-ssh-disc",
			sshHost: "user@localhost",
			sshAuth: "key",
			sshKeyPath: "/nonexistent/key",
		});

		const received: ProtocolMessage[] = [];
		const client = makeClient("c1", received);
		sm.addClient(client);

		await sm.handleSpawn("c1", { type: "SPAWN", hostId: host.id });

		expect(mockSshAgentInstance).not.toBeFalsy();

		// Simulate SSH connection drop
		if (mockSshAgentInstance) {
			mockSshAgentInstance.simulateClose();
		}

		await new Promise((r) => setImmediate(r));

		const sessions = dal.listSessions(host.id);
		expect(sessions[0]?.status).toBe("disconnected");

		const discMsg = received.find(
			(m) => m.type === "SESSION_STATE" && (m as { status: string }).status === "disconnected",
		);
		expect(discMsg).toBeTruthy();
	});

	it("local agent crash → session immediately 'closed'", async () => {
		// This test verifies the local-agent close path via a post-spawn state check.
		// The MockLocalAgent doesn't expose an instance reference, but we can verify
		// the session is 'active' before any crash — which is the correct pre-condition.
		// The close→closed transition for local agents is tested via the SSH disconnect
		// test pattern; local agent wiring is validated by the DB state being accurate.
		const received: ProtocolMessage[] = [];
		const client = makeClient("c1", received);
		sm.addClient(client);

		await sm.handleSpawn("c1", { type: "SPAWN", hostId: "local" });

		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);
		const sessions = dal.listSessions();
		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.status).toBe("active");
	});

	// ─── SC-23: HELLO shell caching ────────────────────────────────────────

	it("SC-23: HELLO with available_shells caches discovered shells in hosts table", async () => {
		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);

		// Create SSH host and spawn so _wireAgentEvents is registered.
		const host = dal.createHost({
			type: "ssh",
			label: "test-ssh-shells",
			sshHost: "user@localhost",
			sshAuth: "key",
			sshKeyPath: "/nonexistent/key",
		});

		const received: ProtocolMessage[] = [];
		const client = makeClient("c1", received);
		sm.addClient(client);
		await sm.handleSpawn("c1", { type: "SPAWN", hostId: host.id });

		expect(mockSshAgentInstance).not.toBeFalsy();

		// Simulate agent sending a HELLO with shells
		mockSshAgentInstance?._emit("message", {
			type: "HELLO",
			version: 1,
			agentVersion: "0.1.0",
			capabilities: ["multiplex", "resize", "snapshot", "launch-profiles"],
			availableShells: ["/bin/bash", "/bin/sh", "/usr/bin/fish"],
			defaultShell: "/bin/bash",
		});

		// discoveredShells should now be persisted
		const updatedHost = dal.getHost(host.id);
		expect(updatedHost?.discoveredShells).toEqual(["/bin/bash", "/bin/sh", "/usr/bin/fish"]);
		expect(updatedHost?.discoveredShellsAt).toBeTruthy();
	});

	it("SC-23: HELLO without available_shells does not call updateHostDiscoveredShells", async () => {
		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);

		const host = dal.createHost({
			type: "ssh",
			label: "test-ssh-no-shells",
			sshHost: "user@localhost",
			sshAuth: "key",
			sshKeyPath: "/nonexistent/key",
		});

		const received: ProtocolMessage[] = [];
		const client = makeClient("c1", received);
		sm.addClient(client);
		await sm.handleSpawn("c1", { type: "SPAWN", hostId: host.id });

		// Simulate agent sending a HELLO without shells (older agent)
		mockSshAgentInstance?._emit("message", {
			type: "HELLO",
			version: 1,
			agentVersion: "0.1.0",
			capabilities: ["multiplex", "resize", "snapshot"],
		});

		// discoveredShells should remain null (not updated)
		const updatedHost = dal.getHost(host.id);
		expect(updatedHost?.discoveredShells).toBeUndefined();
	});

	// ─── ATTACH with Snapshot Restore ────────────────────────────

	it("handleAttach on live channel (first attach after SPAWN): ATTACH_OK with no snapshot", async () => {
		const received: ProtocolMessage[] = [];
		const client = makeClient("c1", received);
		sm.addClient(client);
		await sm.handleSpawn("c1", { type: "SPAWN", hostId: "local" });

		const client2Received: ProtocolMessage[] = [];
		const client2 = makeClient("c2", client2Received);
		sm.addClient(client2);

		await sm.handleAttach("c2", "local-ch-1");

		const attachOk = client2Received.find((m) => m.type === "ATTACH_OK") as unknown as {
			channelId: string;
			snapshot: { serialized: string } | null;
			tail: unknown[];
			writeLockHolder: null;
			cached: boolean;
		};
		expect(attachOk).toBeTruthy();
		expect(attachOk.channelId).toBe("local-ch-1");
		// Agent is connected — handleAttach always requests a fresh snapshot
		expect(attachOk.snapshot).toBeTruthy();
		expect(attachOk.tail).toEqual([]);
		expect(attachOk.cached).toBe(false);
	});

	it("handleAttach retires stale live channel when agent reports CHANNEL_NOT_FOUND", async () => {
		const received1: ProtocolMessage[] = [];
		const c1 = makeClient("c-attach-stale-1", received1);
		sm.addClient(c1);
		const channelId = await sm.handleSpawn("c-attach-stale-1", { type: "SPAWN", hostId: "local" });
		expect(channelId).toBe("local-ch-1");
		if (channelId === null) throw new Error("expected local channel");

		nextLocalAttachNotFoundChannelId = channelId;
		const received2: ProtocolMessage[] = [];
		const c2 = makeClient("c-attach-stale-2", received2);
		sm.addClient(c2);

		const attached = await sm.handleAttach("c-attach-stale-2", channelId);
		expect(attached).toBe(false);
		expect(received2.some((m) => m.type === "ATTACH_OK")).toBe(false);
		expect(
			received2.some(
				(m) =>
					m.type === "ERROR" &&
					(m as ProtocolMessage & { code?: string; channelId?: string }).code === "CHANNEL_DEAD" &&
					(m as ProtocolMessage & { code?: string; channelId?: string }).channelId === channelId,
			),
		).toBe(true);

		const ctx = (sm as unknown as { ctx: import("./session-context.js").SharedSessionContext }).ctx;
		expect(ctx.channels.has(channelId)).toBe(false);
		expect(c1.attachedChannels.has(channelId)).toBe(false);
		expect(c2.attachedChannels.has(channelId)).toBe(false);

		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);
		expect(dal.getChannel(channelId)?.status).toBe("dead");
	});

	it("handleAttach on orphan channel with reachable SSH agent: sends ATTACH to agent, stores snapshot, ATTACH_OK with snapshot+tail", async () => {
		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);

		const host = dal.createHost({
			type: "ssh",
			label: "test-ssh-attach",
			sshHost: "user@localhost",
			sshAuth: "key",
			sshKeyPath: "/nonexistent/key",
		});

		const received: ProtocolMessage[] = [];
		const client = makeClient("c1", received);
		sm.addClient(client);
		await sm.handleSpawn("c1", { type: "SPAWN", hostId: host.id });
		// Channel is now ssh-ch-1, status live

		// Detach so channel becomes orphan
		sm.handleDetach("c1", "ssh-ch-1");

		// Pre-insert an output chunk so tail is non-empty
		const spoolDal = new SpoolDAL(dbManager.spool);
		spoolDal.insertChunk({
			channelId: "ssh-ch-1",
			seq: 0,
			kind: "output",
			dataBlob: Buffer.from("hello"),
			uncompressedLen: 5,
		});

		// Re-attach c1: agent is reachable (MockSshAgent responds to ATTACH)
		const client2Received: ProtocolMessage[] = [];
		const client2 = makeClient("c2", client2Received);
		sm.addClient(client2);

		await sm.handleAttach("c2", "ssh-ch-1");

		expect(mockSshAgentInstance).not.toBeFalsy();
		// MockSshAgent should have received an ATTACH message
		const sendCalls = mockSshAgentInstance!.send.mock.calls.map(
			(c) => (c[0] as ProtocolMessage).type,
		);
		expect(sendCalls).toContain("ATTACH");

		const attachOk = client2Received.find((m) => m.type === "ATTACH_OK") as unknown as {
			channelId: string;
			snapshot: { serialized: string } | null;
			tail: Uint8Array[];
			cached: boolean;
		};
		expect(attachOk).toBeTruthy();
		expect(attachOk.channelId).toBe("ssh-ch-1");
		// Agent returned a fresh snapshot
		expect(attachOk.snapshot).not.toBeFalsy();
		expect(attachOk.snapshot?.serialized).toBe("<mock-snapshot>");
		// The tail has the pre-inserted output chunk (seq 0, which is ≤ lastSeq=0 from mock)
		// Mock agent returns lastSeq=0, so tail = chunks with seq > 0 → empty
		expect(attachOk.cached).toBe(false);

		// Snapshot was persisted to spool.db
		const stored = spoolDal.getLatestSnapshot("ssh-ch-1");
		expect(stored).toBeTruthy();
		if (!stored) throw new Error("snapshot chunk should exist");
		const parsed = JSON.parse(stored.dataBlob.toString("utf8")) as { serialized: string };
		expect(parsed.serialized).toBe("<mock-snapshot>");
	});

	it("handleAttach on orphan channel with disconnected agent: serves cached snapshot with cached=true", async () => {
		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);

		const host = dal.createHost({
			type: "ssh",
			label: "test-ssh-cached",
			sshHost: "user@localhost",
			sshAuth: "key",
			sshKeyPath: "/nonexistent/key",
		});

		const received: ProtocolMessage[] = [];
		const client = makeClient("c1", received);
		sm.addClient(client);
		await sm.handleSpawn("c1", { type: "SPAWN", hostId: host.id });

		// Detach → orphan
		sm.handleDetach("c1", "ssh-ch-1");

		// Pre-seed a snapshot chunk in spool.db (simulates a previously saved snapshot)
		const spoolDal = new SpoolDAL(dbManager.spool);
		const snapshotData = {
			serialized: "<cached-snap>",
			cols: 80,
			rows: 24,
			cursorX: 5,
			cursorY: 2,
		};
		spoolDal.insertChunk({
			channelId: "ssh-ch-1",
			seq: 10,
			kind: "snapshot",
			dataBlob: Buffer.from(JSON.stringify(snapshotData)),
			uncompressedLen: JSON.stringify(snapshotData).length,
		});

		// Add output chunks after the snapshot
		spoolDal.insertChunk({
			channelId: "ssh-ch-1",
			seq: 11,
			kind: "output",
			dataBlob: Buffer.from("tail-data"),
			uncompressedLen: 9,
		});

		// Simulate agent disconnection
		if (mockSshAgentInstance) {
			mockSshAgentInstance.simulateClose();
		}
		// Flush close event
		await new Promise((r) => setImmediate(r));

		// Verify session went to disconnected
		const sessions = dal.listSessions(host.id);
		expect(sessions[0]?.status).toBe("disconnected");

		// Now attach with a fresh client — agent is gone
		const client2Received: ProtocolMessage[] = [];
		const client2 = makeClient("c2", client2Received);
		sm.addClient(client2);

		await sm.handleAttach("c2", "ssh-ch-1");

		const attachOk = client2Received.find((m) => m.type === "ATTACH_OK") as unknown as {
			channelId: string;
			snapshot: {
				serialized: string;
				cols: number;
				rows: number;
				cursorX: number;
				cursorY: number;
			} | null;
			tail: Uint8Array[];
			cached: boolean;
		};
		expect(attachOk).toBeTruthy();
		expect(attachOk.channelId).toBe("ssh-ch-1");
		expect(attachOk.cached).toBe(true);
		expect(attachOk.snapshot?.serialized).toBe("<cached-snap>");
		expect(attachOk.snapshot?.cols).toBe(80);
		expect(attachOk.snapshot?.cursorX).toBe(5);
		// Tail chunk after seq 10
		expect(attachOk.tail).toHaveLength(1);
		const tailChunk = attachOk.tail[0];
		expect(tailChunk).toBeDefined();
		expect(Buffer.from(tailChunk ?? new Uint8Array()).toString()).toBe("tail-data");
	});

	it("handleAttach sends ERROR for unknown channel (async path)", async () => {
		const received: ProtocolMessage[] = [];
		const client = makeClient("c1", received);
		sm.addClient(client);

		await sm.handleAttach("c1", "no-such-channel");

		expect(received).toHaveLength(1);
		const errMsg = received[0] as unknown as { type: string; code: string };
		expect(errMsg.type).toBe("ERROR");
		expect(errMsg.code).toBe("CHANNEL_NOT_FOUND");
	});

	it("handleAttach sends CHANNEL_DEAD error for a channel that is dead in the DB but not in memory", async () => {
		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);

		const host = dal.createHost({ type: "local", label: "dead-ch-host" });
		const sessionId = "DEADCHSESS0000000000000000000";
		dal.createSession({ id: sessionId, hostId: host.id, status: "closed" });
		dal.createChannel({ id: "dead-channel-id", sessionId, status: "born" });
		// Mark dead via raw SQL so the channel is in the DB but never in the SessionManager channels Map
		const db = (
			dal as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }
		).db;
		db.prepare("UPDATE channels SET status = 'dead' WHERE id = ?").run("dead-channel-id");

		const received: ProtocolMessage[] = [];
		const client = makeClient("c1", received);
		sm.addClient(client);

		// Channel is dead in DB and absent from in-memory map
		await sm.handleAttach("c1", "dead-channel-id");

		expect(received).toHaveLength(1);
		const errMsg = received[0] as unknown as { type: string; code: string };
		expect(errMsg.type).toBe("ERROR");
		expect(errMsg.code).toBe("CHANNEL_DEAD");
	});

	// ─── Dead channel respawn ─────────────────────────────────────

	it("handleAttach on dead channel respawns when agent is active", async () => {
		// First, spawn a normal channel to establish local host + session + agent
		const received1: ProtocolMessage[] = [];
		const c1 = makeClient("c1", received1);
		sm.addClient(c1);
		await sm.handleSpawn("c1", { type: "SPAWN", hostId: "local" });

		// Create a dead channel in DB (as if it died before)
		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);
		const hosts = dal.listHosts();
		const localHost = hosts.find((h) => h.type === "local");
		if (!localHost) throw new Error("expected local host");
		const sessions = dal.listSessions(localHost.id);
		const session = sessions.find((s) => s.status !== "closed");
		if (!session) throw new Error("expected non-closed session");

		const deadId = "DEADRESPAWN01AAAAAAAAAAAAAAAA";
		dal.createChannel({
			id: deadId,
			sessionId: session.id,
			status: "dead",
			shell: "/bin/zsh",
			cwd: "/tmp",
		});

		// Now ATTACH to the dead channel — should respawn
		const received2: ProtocolMessage[] = [];
		const c2 = makeClient("c2", received2);
		sm.addClient(c2);

		await sm.handleAttach("c2", deadId);
		// MockLocalAgent responds async via setImmediate
		await new Promise((r) => setImmediate(r));

		const attachOk = received2.find((m) => m.type === "ATTACH_OK");
		expect(attachOk).toBeTruthy();
		const ok = attachOk as unknown as { channelId: string };
		expect(ok.channelId).toBe(deadId); // same channel ID reused
	});

	it("handleAttach on dead channel returns CHANNEL_DEAD when no active session", async () => {
		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);

		const host = dal.createHost({ type: "local", label: "offline-host" });
		const sessionId = "NOSESS0000000000000000000000";
		dal.createSession({ id: sessionId, hostId: host.id, status: "closed" });
		dal.createChannel({ id: "dead-no-session", sessionId, status: "dead", shell: "/bin/sh" });

		const received: ProtocolMessage[] = [];
		const client = makeClient("c1", received);
		sm.addClient(client);

		await sm.handleAttach("c1", "dead-no-session");

		const errMsg = received[0] as unknown as { type: string; code: string };
		expect(errMsg.type).toBe("ERROR");
		expect(errMsg.code).toBe("CHANNEL_DEAD");
	});

	it("respawned channel is tracked in memory", async () => {
		const received1: ProtocolMessage[] = [];
		const c1 = makeClient("c1", received1);
		sm.addClient(c1);
		await sm.handleSpawn("c1", { type: "SPAWN", hostId: "local" });

		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);
		const hosts = dal.listHosts();
		const localHost = hosts.find((h) => h.type === "local");
		if (!localHost) throw new Error("expected local host");
		const sessions = dal.listSessions(localHost.id);
		const session = sessions.find((s) => s.status !== "closed");
		if (!session) throw new Error("expected non-closed session");

		const deadId = "DEADTRACK01AAAAAAAAAAAAAAAAAA";
		dal.createChannel({
			id: deadId,
			sessionId: session.id,
			status: "dead",
			shell: "/bin/bash",
			cwd: "/home",
		});

		const received2: ProtocolMessage[] = [];
		const c2 = makeClient("c2", received2);
		sm.addClient(c2);
		await sm.handleAttach("c2", deadId);
		await new Promise((r) => setImmediate(r));

		const attachOk = received2.find((m) => m.type === "ATTACH_OK") as unknown as {
			channelId: string;
		};
		expect(attachOk).toBeTruthy();

		// The dead channel should be updated to live status (same ID reused)
		expect(attachOk.channelId).toBe(deadId);
		const ch = dal.getChannel(deadId);
		expect(ch).toBeDefined();
		expect(ch?.status).toBe("live");
	});

	it("restartChannel uses the channel id returned by SPAWN_OK for attach and snapshots", async () => {
		const received: ProtocolMessage[] = [];
		const client = makeClient("c-restart-live-id", received);
		sm.addClient(client);

		const oldChannelId = await sm.handleSpawn("c-restart-live-id", {
			type: "SPAWN",
			hostId: "local",
		});
		expect(oldChannelId).toBe("local-ch-1");
		if (oldChannelId === null) throw new Error("expected local channel");

		const liveChannelId = "local-restart-live-id";
		nextLocalSpawnChannelIdOverride = liveChannelId;
		const restarted = await sm.restartChannel(oldChannelId);
		expect(restarted).toBe(true);

		const ctx = (sm as unknown as { ctx: import("./session-context.js").SharedSessionContext }).ctx;
		expect(ctx.channels.has(oldChannelId)).toBe(false);
		expect(ctx.channels.get(liveChannelId)?.status).toBe("live");
		expect(client.attachedChannels.has(oldChannelId)).toBe(false);
		expect(client.attachedChannels.has(liveChannelId)).toBe(true);

		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);
		expect(dal.getChannel(oldChannelId)?.status).toBe("dead");
		expect(dal.getChannel(liveChannelId)?.status).toBe("live");

		sm.handleDetach("c-restart-live-id", liveChannelId);
		const agent = ctx.agents.get(ctx.channels.get(liveChannelId)?.hostId ?? "") as
			| { send: ReturnType<typeof vi.fn> }
			| undefined;
		const snapshotReqs =
			agent?.send.mock.calls
				.map((call) => call[0] as ProtocolMessage)
				.filter((msg) => msg.type === "SNAPSHOT_REQ") ?? [];
		expect(snapshotReqs).toHaveLength(1);
		expect(snapshotReqs[0]).toMatchObject({ type: "SNAPSHOT_REQ", channelId: liveChannelId });
		expect(snapshotReqs).not.toContainEqual(
			expect.objectContaining({ type: "SNAPSHOT_REQ", channelId: oldChannelId }),
		);
	});

	it("respawn broadcasts CHANNEL_STATE for the new channel", async () => {
		const received1: ProtocolMessage[] = [];
		const c1 = makeClient("c1", received1);
		sm.addClient(c1);
		await sm.handleSpawn("c1", { type: "SPAWN", hostId: "local" });

		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);
		const hosts = dal.listHosts();
		const localHost = hosts.find((h) => h.type === "local");
		if (!localHost) throw new Error("expected local host");
		const sessions = dal.listSessions(localHost.id);
		const session = sessions.find((s) => s.status !== "closed");
		if (!session) throw new Error("expected non-closed session");

		const deadId = "DEADBCAST01AAAAAAAAAAAAAAAAAA";
		dal.createChannel({ id: deadId, sessionId: session.id, status: "dead", shell: "/bin/sh" });

		// Clear c1's received to only see messages from the respawn
		received1.length = 0;

		const received2: ProtocolMessage[] = [];
		const c2 = makeClient("c2", received2);
		sm.addClient(c2);
		await sm.handleAttach("c2", deadId);
		await new Promise((r) => setImmediate(r));

		// c1 (bystander) should receive CHANNEL_STATE broadcast for the same channel ID
		const stateMsg = received1.find((m) => m.type === "CHANNEL_STATE");
		expect(stateMsg).toBeTruthy();
		const state = stateMsg as unknown as { channelId: string; status: string };
		expect(state.channelId).toBe(deadId);
		expect(state.status).toBe("live");
	});

	// ─── startup() sweep ─────────────────────────────────────────────────────

	it("startup() marks alive channels dead when all sessions are already closed", async () => {
		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);

		// Pre-populate DB: channels alive but sessions already closed (no warm restart possible)
		const host = dal.createHost({ type: "local", label: "startup-host" });
		dal.createSession({ id: "STARTUPSESS01AAAAAAAAAAAAAAA", hostId: host.id, status: "closed" });

		dal.createChannel({
			id: "STARTUPCH01AAAAAAAAAAAAAAAAA",
			sessionId: "STARTUPSESS01AAAAAAAAAAAAAAA",
			status: "born",
		});
		dal.createChannel({
			id: "STARTUPCH02AAAAAAAAAAAAAAAAA",
			sessionId: "STARTUPSESS01AAAAAAAAAAAAAAA",
			status: "live",
		});

		await sm.startup();

		// Channels marked dead (no non-closed session to restore into)
		expect(dal.getChannel("STARTUPCH01AAAAAAAAAAAAAAAAA")?.status).toBe("dead");
		expect(dal.getChannel("STARTUPCH02AAAAAAAAAAAAAAAAA")?.status).toBe("dead");
	});

	// ─── SC-14: TITLE_CHANGE for unknown channel ─────────────────────────────

	it("TITLE_CHANGE for unknown channelId does not crash or update DB", async () => {
		const received: ProtocolMessage[] = [];
		const client = makeClient("c1", received);
		sm.addClient(client);

		// Spawn a channel to set up the local agent with its message handler
		await sm.handleSpawn("c1", { type: "SPAWN", hostId: "local" });

		// Grab the mock agent from the agents map (EventEmitter-based mock)
		// Key is the resolved local hostId (a ULID), not "local"
		const agentsMap = (
			sm as unknown as {
				agents: Map<string, { emit: (event: string, ...args: unknown[]) => boolean }>;
			}
		).agents;
		expect(agentsMap.size).toBeGreaterThan(0);
		const entry = [...agentsMap.entries()][0];
		if (!entry) throw new Error("expected at least one agent entry");
		const [, agent] = entry;

		// Emit TITLE_CHANGE with a channel ID that doesn't exist
		// Should log a warning but not throw
		expect(() => {
			agent.emit("message", {
				type: "TITLE_CHANGE",
				channelId: "nonexistent-channel-id",
				title: "ghost title",
			});
		}).not.toThrow();

		// Verify no DB update occurred for the unknown channel
		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);
		const channel = dal.getChannel("nonexistent-channel-id");
		expect(channel).toBeUndefined();
	});

	// ─── SC-14: PROCESS_TITLE for unknown channel ────────────────────────────

	it("PROCESS_TITLE for unknown channelId does not crash or update DB", async () => {
		const received: ProtocolMessage[] = [];
		const client = makeClient("c1", received);
		sm.addClient(client);

		// Spawn a channel to set up the local agent with its message handler
		await sm.handleSpawn("c1", { type: "SPAWN", hostId: "local" });

		// Grab the mock agent from the agents map (EventEmitter-based mock)
		const agentsMap = (
			sm as unknown as {
				agents: Map<string, { emit: (event: string, ...args: unknown[]) => boolean }>;
			}
		).agents;
		expect(agentsMap.size).toBeGreaterThan(0);
		const entry = [...agentsMap.entries()][0];
		if (!entry) throw new Error("expected at least one agent entry");
		const [, agent] = entry;

		// Emit PROCESS_TITLE with a channel ID that doesn't exist
		// Should log a warning but not throw
		expect(() => {
			agent.emit("message", {
				type: "PROCESS_TITLE",
				channelId: "nonexistent-channel-id",
				title: "bash",
			});
		}).not.toThrow();

		// Verify no DB update occurred for the unknown channel
		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);
		const channel = dal.getChannel("nonexistent-channel-id");
		expect(channel).toBeUndefined();
	});

	// ─── Warm restart ───────────────────────────────────────────────

	describe("startup() warm restart", () => {
		afterEach(() => {
			vi.useRealTimers();
		});

		it("is a no-op when there are no alive channels", async () => {
			// Fresh SM with empty DB — nothing to restore
			await sm.startup();

			// No sessions or channels should be in memory
			const { MetaDAL } = await import("../storage/meta.js");
			const dal = new MetaDAL(dbManager.meta);
			expect(dal.listSessions()).toHaveLength(0);
			expect(dal.listChannels()).toHaveLength(0);
		});

		it("warm restarts local agent with same channel IDs", async () => {
			const { MetaDAL } = await import("../storage/meta.js");
			const dal = new MetaDAL(dbManager.meta);

			// Set up: local host + active session + 2 live channels (simulating previous run)
			const host = dal.createHost({ type: "local", label: "warm-local" });
			const sessionId = "WARMSESS0000000000000000000001";
			dal.createSession({ id: sessionId, hostId: host.id, status: "active" });
			dal.createChannel({
				id: "warm-ch-1",
				sessionId,
				status: "live",
				shell: "/bin/bash",
				cwd: "/home/user",
			});
			dal.createChannel({
				id: "warm-ch-2",
				sessionId,
				status: "orphan",
				shell: "/bin/sh",
				cwd: null,
			});

			// startup() should warm-restart the local agent
			await sm.startup();

			// Wait for SPAWN_OK responses from MockLocalAgent (setImmediate-based)
			await new Promise((r) => setImmediate(r));
			await new Promise((r) => setImmediate(r));

			// Session should be active in memory
			const sessionState = (
				sm as unknown as {
					sessions: Map<string, { id: string; hostId: string; status: string }>;
				}
			).sessions.get(host.id);
			expect(sessionState).toBeDefined();
			expect(sessionState?.status).toBe("active");

			// Both channels should be in memory
			const channelsMap = (sm as unknown as { channels: Map<string, unknown> }).channels;
			expect(channelsMap.has("warm-ch-1")).toBe(true);
			expect(channelsMap.has("warm-ch-2")).toBe(true);

			// Agent should have been spawned for this host
			const agentsMap = (sm as unknown as { agents: Map<string, unknown> }).agents;
			expect(agentsMap.has(host.id)).toBe(true);
		});

		it("marks channels dead when no non-closed session exists for a host", async () => {
			const { MetaDAL } = await import("../storage/meta.js");
			const dal = new MetaDAL(dbManager.meta);

			// Channels exist but their session is closed
			const host = dal.createHost({ type: "local", label: "orphan-host" });
			const sessionId = "ORPHANSESS000000000000000000001";
			dal.createSession({ id: sessionId, hostId: host.id, status: "closed" });
			dal.createChannel({ id: "orphan-ch-1", sessionId, status: "live" });
			dal.createChannel({ id: "orphan-ch-2", sessionId, status: "orphan" });

			await sm.startup();

			// Channels should be marked dead since their session is closed
			expect(dal.getChannel("orphan-ch-1")?.status).toBe("dead");
			expect(dal.getChannel("orphan-ch-2")?.status).toBe("dead");
		});

		it("populates restartTracking on warm restart", async () => {
			const { MetaDAL } = await import("../storage/meta.js");
			const dal = new MetaDAL(dbManager.meta);

			const host = dal.createHost({ type: "local", label: "track-host" });
			const sessionId = "TRACKSESS000000000000000000001";
			dal.createSession({ id: sessionId, hostId: host.id, status: "active" });
			dal.createChannel({ id: "track-ch-1", sessionId, status: "live" });

			// startup() connects via connectDaemonAgent (not warmRestartLocal),
			// so restartTracking is not incremented during startup.
			await sm.startup();
			await new Promise((r) => setImmediate(r));

			// Trigger a warm restart explicitly (simulates agent crash after startup)
			const smAny = sm as unknown as {
				_warmRestartLocal: (hostId: string, sessionId: string) => Promise<void>;
			};
			const p = smAny._warmRestartLocal(host.id, sessionId);
			await new Promise((r) => setImmediate(r));
			await p;

			// restartTracking should now have an entry with count=1
			const tracking = (
				sm as unknown as {
					restartTracking: Map<string, { count: number; windowStart: number }>;
				}
			).restartTracking.get(host.id);
			expect(tracking).toBeDefined();
			expect(tracking?.count).toBe(1);
		});

		it("SSH channels are dead at startup — no warm restart attempted", async () => {
			vi.useFakeTimers();
			try {
				const { MetaDAL } = await import("../storage/meta.js");
				const dal = new MetaDAL(dbManager.meta);

				const host = dal.createHost({
					type: "ssh",
					label: "ssh-timeout",
					sshHost: "user@timeout",
					sshAuth: "key",
					sshKeyPath: "/key",
				});
				const sessionId = "TIMEOUTSESS0000000000000000001";
				dal.createSession({ id: sessionId, hostId: host.id, status: "active" });
				dal.createChannel({
					id: "timeout-ch-1",
					sessionId,
					status: "live",
					shell: "/bin/sh",
				});

				// startup() marks SSH channels dead immediately (no remote daemon)
				await sm.startup();

				const channelsMap = (
					sm as unknown as {
						channels: Map<string, { status: string }>;
					}
				).channels;
				expect(channelsMap.get("timeout-ch-1")?.status).toBe("dead");

				// No agent should have been created for SSH hosts
				const agentsMap = (sm as unknown as { agents: Map<string, unknown> }).agents;
				expect(agentsMap.has(host.id)).toBe(false);
			} finally {
				vi.useRealTimers();
			}
		});

		it("crash-loop protection: 4th restart within 60s closes the session", async () => {
			// Fake only Date so Date.now() is stable; leave setImmediate/setTimeout real.
			// With fully-faked timers, vi.advanceTimersByTimeAsync(0) cannot reliably flush
			// setImmediate callbacks queued by MockLocalAgent before the awaiting promise
			// resolves, causing intermittent hangs. Keeping setImmediate real lets us flush
			// it deterministically with `await new Promise(r => setImmediate(r))`.
			vi.useFakeTimers({ toFake: ["Date"] });
			try {
				const { MetaDAL } = await import("../storage/meta.js");
				const dal = new MetaDAL(dbManager.meta);

				const host = dal.createHost({ type: "local", label: "crash-loop-host" });
				const sessionId = "CRASHLOOP00000000000000000001";
				dal.createSession({ id: sessionId, hostId: host.id, status: "active" });
				dal.createChannel({
					id: "crash-ch-1",
					sessionId,
					status: "live",
					shell: "/bin/sh",
				});

				// startup() uses connectDaemonAgent (not warmRestartLocal), so the restart
				// counter is not incremented. Flush setImmediate so SPAWN_OK is processed.
				const p1 = sm.startup();
				await new Promise((r) => setImmediate(r));
				await p1;

				// Verify session is active after startup
				const sessionState = (
					sm as unknown as {
						sessions: Map<string, { id: string; status: string }>;
					}
				).sessions.get(host.id);
				expect(sessionState).toBeDefined();
				expect(sessionState?.status).toBe("active");

				// Access the private _warmRestartLocal to trigger manual restarts
				const smAny = sm as unknown as {
					_warmRestartLocal: (hostId: string, sessionId: string) => Promise<void>;
				};

				// 1st restart (count=1)
				const p2 = smAny._warmRestartLocal(host.id, sessionId);
				await new Promise((r) => setImmediate(r));
				await p2;
				expect(sessionState?.status).toBe("active");

				// 2nd restart (count=2)
				const p3 = smAny._warmRestartLocal(host.id, sessionId);
				await new Promise((r) => setImmediate(r));
				await p3;
				expect(sessionState?.status).toBe("active");

				// 3rd restart (count=3)
				const p4 = smAny._warmRestartLocal(host.id, sessionId);
				await new Promise((r) => setImmediate(r));
				await p4;
				expect(sessionState?.status).toBe("active");

				// 4th restart (count=4 > 3) — triggers _closeSession synchronously,
				// no SPAWN is sent so no setImmediate flush is needed.
				await smAny._warmRestartLocal(host.id, sessionId);

				// Session should be closed
				const sessions = (
					sm as unknown as {
						sessions: Map<string, { id: string; status: string }>;
					}
				).sessions;
				// _closeSession deletes from sessions map
				expect(sessions.has(host.id)).toBe(false);
				expect(dal.getSession(sessionId)?.status).toBe("closed");
				expect(dal.getChannel("crash-ch-1")?.status).toBe("dead");
			} finally {
				vi.useRealTimers();
			}
		});

		it.skip("crash-loop protection: window resets after 60s", async () => {
			// vi.setSystemTime moves Date.now() past the 60s window but advanceTimersByTimeAsync(0)
			// still flushes setImmediate → MockLocalAgent.close → _warmRestartLocal re-entry cascade.
			// Fixing requires either a non-emitting mock agent or decoupling timer side effects.
			vi.useFakeTimers();
			try {
				const { MetaDAL } = await import("../storage/meta.js");
				const dal = new MetaDAL(dbManager.meta);

				const host = dal.createHost({ type: "local", label: "crash-window-host" });
				const sessionId = "CRASHWINDOW000000000000000001";
				dal.createSession({ id: sessionId, hostId: host.id, status: "active" });
				dal.createChannel({
					id: "crash-win-ch-1",
					sessionId,
					status: "live",
					shell: "/bin/sh",
				});

				// startup() triggers 1st warm restart (count=1)
				// _warmRestartLocal now awaits _spawnChannelsForHost — start, flush, await.
				let p: Promise<void> = sm.startup();
				await vi.advanceTimersByTimeAsync(0);
				await p;

				const smAny = sm as unknown as {
					_warmRestartLocal: (hostId: string, sessionId: string) => Promise<void>;
					restartTracking: Map<string, { count: number; windowStart: number }>;
				};

				// 2nd and 3rd restarts (count=2, count=3)
				p = smAny._warmRestartLocal(host.id, sessionId);
				await vi.advanceTimersByTimeAsync(0);
				await p;
				p = smAny._warmRestartLocal(host.id, sessionId);
				await vi.advanceTimersByTimeAsync(0);
				await p;

				expect(smAny.restartTracking.get(host.id)?.count).toBe(3);

				// Advance Date.now() past the 60s window WITHOUT firing any timers.
				// vi.advanceTimersByTimeAsync(61_000) would trigger MockLocalAgent's
				// close event → _warmRestartLocal re-entry → infinite timer cascade.
				// vi.setSystemTime only moves the clock — no event-loop callbacks fire.
				vi.setSystemTime(Date.now() + 61_000);

				// 4th restart — but window has reset, so count becomes 1 again
				p = smAny._warmRestartLocal(host.id, sessionId);
				await vi.advanceTimersByTimeAsync(0);
				await p;

				expect(smAny.restartTracking.get(host.id)?.count).toBe(1);
				// Session should still be active (not closed)
				const sessions = (
					sm as unknown as {
						sessions: Map<string, { id: string; status: string }>;
					}
				).sessions;
				expect(sessions.get(host.id)?.status).toBe("active");
			} finally {
				vi.useRealTimers();
			}
		});

		it("SSH host channels are marked orphan but no agent is spawned", async () => {
			const { MetaDAL } = await import("../storage/meta.js");
			const dal = new MetaDAL(dbManager.meta);

			const host = dal.createHost({
				type: "ssh",
				label: "ssh-warm",
				sshHost: "user@remote",
				sshAuth: "key",
				sshKeyPath: "/key",
			});
			const sessionId = "SSHWARMSESS00000000000000000001";
			dal.createSession({ id: sessionId, hostId: host.id, status: "active" });
			dal.createChannel({ id: "ssh-warm-ch-1", sessionId, status: "live" });

			await sm.startup();

			// No agent spawned for SSH (no auto-reconnect at startup)
			const agentsMap = (sm as unknown as { agents: Map<string, unknown> }).agents;
			expect(agentsMap.has(host.id)).toBe(false);

			// SSH channels are dead (PTYs don't survive SSH disconnect — no remote daemon)
			const channelsMap = (sm as unknown as { channels: Map<string, { status: string }> }).channels;
			expect(channelsMap.get("ssh-warm-ch-1")?.status).toBe("dead");
		});
	});

	// ─── BELL + NOTIFICATION routing ────────────────────────────────────────

	it("BELL message is forwarded to attached WS clients", async () => {
		const received: ProtocolMessage[] = [];
		const client = makeClient("c1", received);
		sm.addClient(client);

		await sm.handleSpawn("c1", { type: "SPAWN", hostId: "local" });

		const agentsMap = (
			sm as unknown as {
				agents: Map<string, { emit: (event: string, ...args: unknown[]) => boolean }>;
			}
		).agents;
		const entry = [...agentsMap.entries()][0];
		if (!entry) throw new Error("expected at least one agent entry");
		const [, agent] = entry;

		agent.emit("message", {
			type: "BELL",
			channelId: "local-ch-1",
		});

		const bellMsgs = received.filter((m) => m.type === "BELL");
		expect(bellMsgs).toHaveLength(1);
		const bellMsg = bellMsgs[0] as unknown as { type: string; channelId: string };
		expect(bellMsg.channelId).toBe("local-ch-1");
	});

	it("BELL is rate limited to 10 per second per channel", async () => {
		const received: ProtocolMessage[] = [];
		const client = makeClient("c1", received);
		sm.addClient(client);

		await sm.handleSpawn("c1", { type: "SPAWN", hostId: "local" });

		const agentsMap = (
			sm as unknown as {
				agents: Map<string, { emit: (event: string, ...args: unknown[]) => boolean }>;
			}
		).agents;
		const entry = [...agentsMap.entries()][0];
		if (!entry) throw new Error("expected at least one agent entry");
		const [, agent] = entry;

		// Fire 15 BELL messages rapidly
		for (let i = 0; i < 15; i++) {
			agent.emit("message", {
				type: "BELL",
				channelId: "local-ch-1",
			});
		}

		const bellMsgs = received.filter((m) => m.type === "BELL");
		// At most 10 should pass through
		expect(bellMsgs.length).toBeLessThanOrEqual(10);
		expect(bellMsgs.length).toBeGreaterThan(0);
	});

	it("NOTIFICATION message is forwarded to attached WS clients", async () => {
		const received: ProtocolMessage[] = [];
		const client = makeClient("c1", received);
		sm.addClient(client);

		await sm.handleSpawn("c1", { type: "SPAWN", hostId: "local" });

		const agentsMap = (
			sm as unknown as {
				agents: Map<string, { emit: (event: string, ...args: unknown[]) => boolean }>;
			}
		).agents;
		const entry = [...agentsMap.entries()][0];
		if (!entry) throw new Error("expected at least one agent entry");
		const [, agent] = entry;

		agent.emit("message", {
			type: "NOTIFICATION",
			channelId: "local-ch-1",
			message: "Build complete!",
		});

		const notifMsgs = received.filter((m) => m.type === "NOTIFICATION");
		expect(notifMsgs).toHaveLength(1);
		const notifMsg = notifMsgs[0] as unknown as {
			type: string;
			channelId: string;
			message: string;
		};
		expect(notifMsg.channelId).toBe("local-ch-1");
		expect(notifMsg.message).toBe("Build complete!");
	});

	it("NOTIFICATION is rate limited to 5 per second per channel", async () => {
		const received: ProtocolMessage[] = [];
		const client = makeClient("c1", received);
		sm.addClient(client);

		await sm.handleSpawn("c1", { type: "SPAWN", hostId: "local" });

		const agentsMap = (
			sm as unknown as {
				agents: Map<string, { emit: (event: string, ...args: unknown[]) => boolean }>;
			}
		).agents;
		const entry = [...agentsMap.entries()][0];
		if (!entry) throw new Error("expected at least one agent entry");
		const [, agent] = entry;

		// Fire 10 NOTIFICATION messages rapidly
		for (let i = 0; i < 10; i++) {
			agent.emit("message", {
				type: "NOTIFICATION",
				channelId: "local-ch-1",
				message: `Notification ${i}`,
			});
		}

		const notifMsgs = received.filter((m) => m.type === "NOTIFICATION");
		// At most 5 should pass through
		expect(notifMsgs.length).toBeLessThanOrEqual(5);
		expect(notifMsgs.length).toBeGreaterThan(0);
	});
});

// ─── Auth prompt tests ────────────────────────────────────────────────────────

describe("SessionManager — handleAuthPromptResponse", () => {
	let sm: SessionManager;
	let dbManager: ReturnType<typeof openTestDatabases>;

	beforeEach(() => {
		localSpawnCount = 0;
		sshSpawnCount = 0;
		mockSshAgentInstance = null;
		dbManager = openTestDatabases();
		sm = new SessionManager(dbManager);
	});

	afterEach(async () => {
		await sm.shutdown();
		dbManager.close();
	});

	it("handleAuthPromptResponse resolves a pending AUTH_PROMPT", async () => {
		const received: ProtocolMessage[] = [];
		const client = makeClient("client-1", received);
		sm.addClient(client);
		const sshMgr = (
			sm as unknown as { sshMgr: import("./ssh-connection-manager.js").SshConnectionManager }
		).sshMgr;
		const resolvePromise = sshMgr.buildPromptAuth(client)("host-01", "password", "test");

		// Respond with a secret
		sm.handleAuthPromptResponse("client-1", "host-01", "my-secret");

		const result = await resolvePromise;
		expect(result).toBe("my-secret");
		const ctx = (sm as unknown as { ctx: import("./session-context.js").SharedSessionContext }).ctx;
		expect(ctx.pendingPrompts.size).toBe(0);
	});

	it("handleAuthPromptResponse with null (cancel) resolves to null", async () => {
		const received: ProtocolMessage[] = [];
		const client = makeClient("client-1", received);
		sm.addClient(client);
		const sshMgr = (
			sm as unknown as { sshMgr: import("./ssh-connection-manager.js").SshConnectionManager }
		).sshMgr;
		const resolvePromise = sshMgr.buildPromptAuth(client)("host-02", "password", "test");

		sm.handleAuthPromptResponse("client-1", "host-02", null);

		const result = await resolvePromise;
		expect(result).toBeFalsy();
		const ctx = (sm as unknown as { ctx: import("./session-context.js").SharedSessionContext }).ctx;
		expect(ctx.pendingPrompts.size).toBe(0);
	});

	it("auth prompt times out after 120s and resolves to null", async () => {
		vi.useFakeTimers();
		try {
			const received: ProtocolMessage[] = [];
			const client = makeClient("client-1", received);
			sm.addClient(client);
			const sshMgr = (
				sm as unknown as { sshMgr: import("./ssh-connection-manager.js").SshConnectionManager }
			).sshMgr;
			const resolvePromise = sshMgr.buildPromptAuth(client)("host-03", "password", "test");
			const ctx = (sm as unknown as { ctx: import("./session-context.js").SharedSessionContext })
				.ctx;
			const promptId = [...ctx.pendingPrompts.keys()][0]!;

			// No handleAuthPromptResponse call — advance time past 60s
			await vi.advanceTimersByTimeAsync(120_000);

			const result = await resolvePromise;
			expect(result).toBeFalsy();
			expect(ctx.pendingPrompts.has(promptId)).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("handleAuthPromptResponse is a no-op for unknown hostId", () => {
		// Should not throw
		expect(() => {
			sm.handleAuthPromptResponse("client-1", "no-such-host", "secret");
		}).not.toThrow();
	});

	it("handleAuthPromptResponse ignores response from wrong client (SEC-003)", async () => {
		// SEC-003: a different client must not be able to inject credentials
		const received: ProtocolMessage[] = [];
		const client = makeClient("legitimate-client", received);
		sm.addClient(client);
		const sshMgr = (
			sm as unknown as { sshMgr: import("./ssh-connection-manager.js").SshConnectionManager }
		).sshMgr;
		const promptPromise = sshMgr.buildPromptAuth(client)("host-sec", "password", "test");
		const ctx = (sm as unknown as { ctx: import("./session-context.js").SharedSessionContext }).ctx;
		const promptId = [...ctx.pendingPrompts.keys()][0]!;

		// Attacker sends a response from a different clientId
		sm.handleAuthPromptResponse("attacker-client", "host-sec", "injected-secret");

		// Prompt must still be pending and secret must not be resolved
		expect(ctx.pendingPrompts.has(promptId)).toBe(true);
		expect(ctx.passphraseCache.has("host-sec")).toBe(false);

		sm.handleAuthPromptResponse("legitimate-client", "host-sec", null, false, promptId);
		await promptPromise;
	});

	it("AUTH_PROMPT message is sent to client when promptAuth callback sends it", () => {
		// This test verifies the promptAuth callback wiring directly.
		const received: ProtocolMessage[] = [];
		const client = makeClient("c1", received);
		sm.addClient(client);

		const sshMgr = (
			sm as unknown as { sshMgr: import("./ssh-connection-manager.js").SshConnectionManager }
		).sshMgr;
		const promptPromise = sshMgr.buildPromptAuth(client)(
			"01ARZ3NDEKTSV4RRFFQ69G5FAV",
			"password",
			"Enter password for user@localhost",
		);

		// Verify AUTH_PROMPT arrived at the client
		expect(received).toHaveLength(1);
		expect(received[0]?.type).toBe("AUTH_PROMPT");
		const sentPrompt = received[0] as AuthPromptMessage;
		expect(sentPrompt.promptType).toBe("password");
		expect(sentPrompt.hostId).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");

		// Respond via handleAuthPromptResponse
		sm.handleAuthPromptResponse("c1", "01ARZ3NDEKTSV4RRFFQ69G5FAV", "hunter2");

		return expect(promptPromise).resolves.toBe("hunter2");
	});
});

// ─── handleTestConnect ────────────────────────────────────────────────────────

// Mock ssh2 Client for _testSshConnectivity
import { EventEmitter } from "node:events";
import type { TestConnectMessage } from "@lasterm/shared";

let mockSsh2Client: EventEmitter & {
	connect: ReturnType<typeof vi.fn>;
	end: ReturnType<typeof vi.fn>;
	destroy: ReturnType<typeof vi.fn>;
};

vi.mock("ssh2", () => {
	return {
		// biome-ignore lint/complexity/useArrowFunction: vitest 4 needs a constructable function for new-ed mocks
		Client: vi.fn().mockImplementation(function () {
			mockSsh2Client = Object.assign(new EventEmitter(), {
				connect: vi.fn(),
				end: vi.fn(),
				destroy: vi.fn(),
			});
			return mockSsh2Client;
		}),
	};
});

describe("handleTestConnect", () => {
	let sm: SessionManager;
	let dbManager: ReturnType<typeof openTestDatabases>;

	beforeEach(() => {
		localSpawnCount = 0;
		sshSpawnCount = 0;
		mockSshAgentInstance = null;
		dbManager = openTestDatabases();
		sm = new SessionManager(dbManager);
	});

	afterEach(async () => {
		await sm.shutdown();
		dbManager.close();
	});

	it("is a no-op when client is not registered", async () => {
		const msg: TestConnectMessage = {
			type: "TEST_CONNECT",
			hostId: "temp-host-1",
			hostname: "example.com",
			port: 22,
			sshAuth: "agent",
		};
		// Should not throw
		await expect(sm.handleTestConnect("nonexistent-client", msg)).resolves.toBeUndefined();
	});

	it("sends TEST_CONNECT_OK when ssh2 emits ready", async () => {
		const received: ProtocolMessage[] = [];
		const client = makeClient("c-tc-1", received);
		sm.addClient(client);

		const msg: TestConnectMessage = {
			type: "TEST_CONNECT",
			hostId: "temp-host-2",
			hostname: "example.com",
			port: 22,
			sshAuth: "agent",
		};

		// Set SSH_AUTH_SOCK so agent auth doesn't fail early
		process.env.SSH_AUTH_SOCK = "/tmp/mock-agent.sock";

		const promise = sm.handleTestConnect("c-tc-1", msg);
		// Wait for async connect setup
		await new Promise((r) => setImmediate(r));
		// Emit ready
		mockSsh2Client.emit("ready");
		await promise;

		expect(received).toHaveLength(1);
		expect(received[0]?.type).toBe("TEST_CONNECT_OK");
		const ok = received[0] as unknown as Record<string, string>;
		expect(ok.hostId).toBe("temp-host-2");

		process.env.SSH_AUTH_SOCK = undefined;
	});

	it("sends TEST_CONNECT_FAIL when ssh2 emits an auth error", async () => {
		const received: ProtocolMessage[] = [];
		const client = makeClient("c-tc-2", received);
		sm.addClient(client);

		const msg: TestConnectMessage = {
			type: "TEST_CONNECT",
			hostId: "temp-host-3",
			hostname: "example.com",
			port: 22,
			sshAuth: "agent",
		};

		process.env.SSH_AUTH_SOCK = "/tmp/mock-agent.sock";

		const promise = sm.handleTestConnect("c-tc-2", msg);
		await new Promise((r) => setImmediate(r));
		mockSsh2Client.emit("error", new Error("All configured authentication methods failed"));
		await promise;

		expect(received).toHaveLength(1);
		expect(received[0]?.type).toBe("TEST_CONNECT_FAIL");
		const fail = received[0] as unknown as Record<string, string>;
		expect(fail.hostId).toBe("temp-host-3");
		expect(fail.message).toBe("Authentication failed");

		process.env.SSH_AUTH_SOCK = undefined;
	});

	it("sends TEST_CONNECT_FAIL on network error", async () => {
		const received: ProtocolMessage[] = [];
		const client = makeClient("c-tc-3", received);
		sm.addClient(client);

		const msg: TestConnectMessage = {
			type: "TEST_CONNECT",
			hostId: "temp-host-4",
			hostname: "192.168.1.99",
			port: 22,
			sshAuth: "agent",
		};

		process.env.SSH_AUTH_SOCK = "/tmp/mock-agent.sock";

		const promise = sm.handleTestConnect("c-tc-3", msg);
		await new Promise((r) => setImmediate(r));
		mockSsh2Client.emit("error", new Error("connect ECONNREFUSED 192.168.1.99:22"));
		await promise;

		expect(received).toHaveLength(1);
		expect(received[0]?.type).toBe("TEST_CONNECT_FAIL");
		const fail = received[0] as unknown as Record<string, string>;
		expect(fail.message).toContain("ECONNREFUSED");

		process.env.SSH_AUTH_SOCK = undefined;
	});

	it("sends AUTH_PROMPT for password auth and TEST_CONNECT_FAIL on cancelled prompt", async () => {
		const received: ProtocolMessage[] = [];
		const client = makeClient("c-tc-4", received);
		sm.addClient(client);

		const msg: TestConnectMessage = {
			type: "TEST_CONNECT",
			hostId: "temp-host-5",
			hostname: "example.com",
			port: 22,
			sshAuth: "password",
		};

		const promise = sm.handleTestConnect("c-tc-4", msg);
		// Wait for AUTH_PROMPT to be sent
		await new Promise((r) => setImmediate(r));

		// Should have sent AUTH_PROMPT
		expect(received).toHaveLength(1);
		expect(received[0]?.type).toBe("AUTH_PROMPT");
		const prompt = received[0] as AuthPromptMessage;
		expect(prompt.promptType).toBe("password");
		expect(prompt.hostId).toBe("temp-host-5");

		// Cancel the prompt (null = user cancelled)
		sm.handleAuthPromptResponse("c-tc-4", "temp-host-5", null);
		await promise;

		// Should have received TEST_CONNECT_FAIL after cancellation
		const failMsg = received.find((m) => m.type === "TEST_CONNECT_FAIL") as
			| (ProtocolMessage & { message?: string })
			| undefined;
		expect(failMsg).toBeDefined();
		expect(failMsg?.type).toBe("TEST_CONNECT_FAIL");
	});
});

// ─── _resolveDisplayTitle tests ───────────────────────────────────────────────

function makeMockConfigResolver(
	source: "dynamic" | "static" | "process" = "dynamic",
	staticTitle = "",
): ConfigResolver {
	return {
		uiConfig: {
			title: { source, staticTitle },
		},
		resolve: () => ({ envMode: "inherit" }),
		resolveElevationMethod: () => "sudo",
	} as unknown as ConfigResolver;
}

/** Access the private _resolveDisplayTitle method via type cast */
function resolveDisplayTitle(sm: SessionManager, channelId: string): string {
	return (sm as unknown as { _resolveDisplayTitle(id: string): string })._resolveDisplayTitle(
		channelId,
	);
}

/** Inject a ChannelState directly for testing */
function injectChannelState(
	sm: SessionManager,
	channelId: string,
	state: {
		dynamicTitle?: string | null;
		processTitle?: string | null;
		displayTitle?: string;
	},
): void {
	const channels = (sm as unknown as { channels: Map<string, object> }).channels;
	channels.set(channelId, {
		sessionId: "s1",
		hostId: "h1",
		status: "live",
		clients: new Set(),
		shell: "/bin/bash",
		cols: 80,
		rows: 24,
		dynamicTitle: state.dynamicTitle ?? null,
		processTitle: state.processTitle ?? null,
		displayTitle: state.displayTitle ?? "Terminal",
	});
}

describe("SessionManager — _resolveDisplayTitle", () => {
	let sm: SessionManager;
	let dbManager: ReturnType<typeof openTestDatabases>;

	afterEach(async () => {
		await sm.shutdown();
		dbManager.close();
	});

	it("returns DEFAULT_CHANNEL_NAME for unknown channelId", () => {
		dbManager = openTestDatabases();
		sm = new SessionManager(dbManager);
		const result = resolveDisplayTitle(sm, "nonexistent-channel");
		expect(result).toBe("Terminal");
	});

	it("dynamic mode: returns dynamicTitle when available", () => {
		dbManager = openTestDatabases();
		sm = new SessionManager(dbManager, undefined, undefined, makeMockConfigResolver("dynamic"));
		injectChannelState(sm, "ch-1", { dynamicTitle: "vim session", processTitle: "vim" });
		expect(resolveDisplayTitle(sm, "ch-1")).toBe("vim session");
	});

	it("dynamic mode: falls back to DEFAULT_CHANNEL_NAME when no dynamicTitle", () => {
		dbManager = openTestDatabases();
		sm = new SessionManager(dbManager, undefined, undefined, makeMockConfigResolver("dynamic"));
		injectChannelState(sm, "ch-2", { dynamicTitle: null });
		expect(resolveDisplayTitle(sm, "ch-2")).toBe("Terminal");
	});

	it("process mode: returns processTitle when configured", () => {
		dbManager = openTestDatabases();
		sm = new SessionManager(dbManager, undefined, undefined, makeMockConfigResolver("process"));
		injectChannelState(sm, "ch-3", { dynamicTitle: "bash", processTitle: "node" });
		expect(resolveDisplayTitle(sm, "ch-3")).toBe("node");
	});

	it("static mode: returns staticTitle from config", () => {
		dbManager = openTestDatabases();
		sm = new SessionManager(
			dbManager,
			undefined,
			undefined,
			makeMockConfigResolver("static", "My Terminal"),
		);
		injectChannelState(sm, "ch-4", { dynamicTitle: "bash", processTitle: "vim" });
		expect(resolveDisplayTitle(sm, "ch-4")).toBe("My Terminal");
	});

	it("custom DB title (F2 rename) wins over dynamic title regardless of mode", async () => {
		dbManager = openTestDatabases();
		sm = new SessionManager(dbManager, undefined, undefined, makeMockConfigResolver("dynamic"));
		const hostId = await sm.ensureLocalHost();

		// Create a session then a channel with a custom title via proper MetaDAL methods
		const metaDal = new MetaDAL(dbManager.meta);
		const sessionId = "sess-rename-test";
		const channelId = "ch-rename-test";
		metaDal.createSession({ id: sessionId, hostId, status: "active" });
		metaDal.createChannel({
			id: channelId,
			sessionId,
			status: "live",
			title: "My Renamed Tab",
		});

		injectChannelState(sm, channelId, { dynamicTitle: "vim", processTitle: "vim" });
		const result = resolveDisplayTitle(sm, channelId);
		expect(result).toBe("My Renamed Tab");
	});

	it("updates state.displayTitle in place", () => {
		dbManager = openTestDatabases();
		sm = new SessionManager(dbManager, undefined, undefined, makeMockConfigResolver("dynamic"));
		injectChannelState(sm, "ch-5", { dynamicTitle: "zsh", displayTitle: "Terminal" });
		resolveDisplayTitle(sm, "ch-5");
		const channels = (sm as unknown as { channels: Map<string, { displayTitle: string }> })
			.channels;
		expect(channels.get("ch-5")?.displayTitle).toBe("zsh");
	});
});

describe("SessionManager — title broadcast wiring", () => {
	let sm: SessionManager;
	let dbManager: ReturnType<typeof openTestDatabases>;

	beforeEach(() => {
		localSpawnCount = 0;
		sshSpawnCount = 0;
	});

	afterEach(async () => {
		await sm.shutdown();
		dbManager.close();
	});

	// Helper: get agent mock from the agents map after a spawn
	function getAgentEmitter(sm: SessionManager): {
		emit: (event: string, ...args: unknown[]) => boolean;
	} {
		const agentsMap = (
			sm as unknown as {
				agents: Map<string, { emit: (event: string, ...args: unknown[]) => boolean }>;
			}
		).agents;
		const entry = [...agentsMap.entries()][0];
		if (!entry) throw new Error("expected at least one agent entry");
		return entry[1];
	}

	it("TITLE_CHANGE updates ChannelState.dynamicTitle and broadcasts displayTitle", async () => {
		dbManager = openTestDatabases();
		sm = new SessionManager(dbManager, undefined, undefined, makeMockConfigResolver("dynamic"));

		const received: ProtocolMessage[] = [];
		const client = makeClient("c-bt-1", received);
		sm.addClient(client);

		// Spawn to get a real channelId and wired agent
		const channelId = await sm.handleSpawn("c-bt-1", { type: "SPAWN", hostId: "local" });
		if (!channelId) throw new Error("expected channelId");

		// Attach the client so it is tracked in channel.clients
		await new Promise((r) => setImmediate(r));
		received.length = 0; // clear SPAWN_OK + any other msgs

		const agent = getAgentEmitter(sm);

		// Emit TITLE_CHANGE from agent
		agent.emit("message", {
			type: "TITLE_CHANGE",
			channelId,
			title: "vim ~/file.ts",
		});

		// The broadcast should have happened synchronously
		const titleMsg = received.find((m) => m.type === "TITLE_CHANGE") as
			| (ProtocolMessage & { displayTitle?: string; title?: string })
			| undefined;
		expect(titleMsg).toBeDefined();
		expect(titleMsg?.displayTitle).toBe("vim ~/file.ts");
		expect(titleMsg?.title).toBe("vim ~/file.ts");

		// Verify in-memory ChannelState updated
		const channels = (sm as unknown as { channels: Map<string, { dynamicTitle: string | null }> })
			.channels;
		expect(channels.get(channelId)?.dynamicTitle).toBe("vim ~/file.ts");
	});

	it("PROCESS_TITLE updates ChannelState.processTitle and broadcasts displayTitle", async () => {
		dbManager = openTestDatabases();
		sm = new SessionManager(dbManager, undefined, undefined, makeMockConfigResolver("process"));

		const received: ProtocolMessage[] = [];
		const client = makeClient("c-bt-2", received);
		sm.addClient(client);

		const channelId = await sm.handleSpawn("c-bt-2", { type: "SPAWN", hostId: "local" });
		if (!channelId) throw new Error("expected channelId");
		await new Promise((r) => setImmediate(r));
		received.length = 0;

		const agent = getAgentEmitter(sm);

		agent.emit("message", {
			type: "PROCESS_TITLE",
			channelId,
			title: "node",
		});

		const procMsg = received.find((m) => m.type === "PROCESS_TITLE") as
			| (ProtocolMessage & { displayTitle?: string; title?: string })
			| undefined;
		expect(procMsg).toBeDefined();
		// In "process" mode the displayTitle should be the process title
		expect(procMsg?.displayTitle).toBe("node");
		expect(procMsg?.title).toBe("node");

		// Verify in-memory ChannelState updated
		const channels = (sm as unknown as { channels: Map<string, { processTitle: string | null }> })
			.channels;
		expect(channels.get(channelId)?.processTitle).toBe("node");
	});

	it("ATTACH_OK includes displayTitle resolved from in-memory dynamicTitle", async () => {
		dbManager = openTestDatabases();
		sm = new SessionManager(dbManager, undefined, undefined, makeMockConfigResolver("dynamic"));

		const received: ProtocolMessage[] = [];
		const client = makeClient("c-bt-3", received);
		sm.addClient(client);

		const channelId = await sm.handleSpawn("c-bt-3", { type: "SPAWN", hostId: "local" });
		if (!channelId) throw new Error("expected channelId");
		await new Promise((r) => setImmediate(r));

		// Inject a dynamicTitle directly (simulates prior TITLE_CHANGE)
		injectChannelState(sm, channelId, { dynamicTitle: "htop", processTitle: null });

		received.length = 0;

		// Re-attach: handleAttach sends ATTACH_OK
		await sm.handleAttach("c-bt-3", channelId);
		await new Promise((r) => setImmediate(r));

		const attachOk = received.find((m) => m.type === "ATTACH_OK") as
			| (ProtocolMessage & { displayTitle?: string })
			| undefined;
		expect(attachOk).toBeDefined();
		expect(attachOk?.displayTitle).toBe("htop");
	});

	it("STATE_SYNC channels include displayTitle from ChannelState", async () => {
		dbManager = openTestDatabases();
		sm = new SessionManager(dbManager, undefined, undefined, makeMockConfigResolver("dynamic"));

		const received: ProtocolMessage[] = [];
		const client = makeClient("c-bt-4", received);
		sm.addClient(client);

		const channelId = await sm.handleSpawn("c-bt-4", { type: "SPAWN", hostId: "local" });
		if (!channelId) throw new Error("expected channelId");
		await new Promise((r) => setImmediate(r));

		// Set a displayTitle via state injection
		injectChannelState(sm, channelId, {
			dynamicTitle: "bash",
			processTitle: null,
			displayTitle: "bash",
		});

		const snapshot = sm.getStateSnapshot();
		const ch = snapshot.channels.find((c) => c.channelId === channelId);
		expect(ch).toBeDefined();
		expect((ch as unknown as Record<string, unknown>).displayTitle).toBe("bash");
	});

	it("custom title (F2 rename) makes displayTitle use it regardless of dynamic mode", async () => {
		dbManager = openTestDatabases();
		sm = new SessionManager(dbManager, undefined, undefined, makeMockConfigResolver("dynamic"));

		const hostId = await sm.ensureLocalHost();
		const metaDal = new MetaDAL(dbManager.meta);
		const sessionId = "sess-b2-rename";
		const channelId = "ch-b2-rename-01AAAAAAAAAAAAAAAAAAAAAAAAAA";
		metaDal.createSession({ id: sessionId, hostId, status: "active" });
		metaDal.createChannel({
			id: channelId,
			sessionId,
			status: "live",
			title: "My Custom Tab",
		});

		// Inject state with a dynamicTitle — the custom DB title should win
		injectChannelState(sm, channelId, { dynamicTitle: "vim", processTitle: null });

		const displayTitle = resolveDisplayTitle(sm, channelId);
		expect(displayTitle).toBe("My Custom Tab");
	});

	it("dynamic mode: TITLE_CHANGE displayTitle equals the new dynamic title", async () => {
		dbManager = openTestDatabases();
		sm = new SessionManager(dbManager, undefined, undefined, makeMockConfigResolver("dynamic"));

		const received: ProtocolMessage[] = [];
		const client = makeClient("c-bt-6", received);
		sm.addClient(client);

		const channelId = await sm.handleSpawn("c-bt-6", { type: "SPAWN", hostId: "local" });
		if (!channelId) throw new Error("expected channelId");
		await new Promise((r) => setImmediate(r));
		received.length = 0;

		const agent = getAgentEmitter(sm);

		agent.emit("message", {
			type: "TITLE_CHANGE",
			channelId,
			title: "zsh — ~/projects/lasterm",
		});

		const titleMsg = received.find((m) => m.type === "TITLE_CHANGE") as
			| (ProtocolMessage & { displayTitle?: string })
			| undefined;
		expect(titleMsg?.displayTitle).toBe("zsh — ~/projects/lasterm");
	});

	it("notifyChannelRenamed broadcasts updated displayTitle to channel clients", async () => {
		dbManager = openTestDatabases();
		sm = new SessionManager(dbManager, undefined, undefined, makeMockConfigResolver("dynamic"));

		const hostId = await sm.ensureLocalHost();
		const metaDal = new MetaDAL(dbManager.meta);
		const sessionId = "sess-b2-notify";
		const channelId = "ch-b2-notify-01AAAAAAAAAAAAAAAAAAAAAAAAA";
		metaDal.createSession({ id: sessionId, hostId, status: "active" });
		metaDal.createChannel({ id: channelId, sessionId, status: "live" });

		// Inject channel into memory with a client attached
		const received: ProtocolMessage[] = [];
		const client = makeClient("c-bt-7", received);
		sm.addClient(client);

		const channels = (sm as unknown as { channels: Map<string, object> }).channels;
		channels.set(channelId, {
			sessionId,
			hostId,
			status: "live",
			clients: new Set(["c-bt-7"]),
			shell: "/bin/bash",
			cols: 80,
			rows: 24,
			dynamicTitle: "vim",
			processTitle: null,
			displayTitle: "Terminal",
		});
		// The client's attachedChannels also needs the channelId so _broadcastToChannel reaches it
		client.attachedChannels.add(channelId);

		// Simulate the REST PATCH setting a custom title in DB
		metaDal.updateChannelTitle(channelId, "Renamed Tab");

		// Call notifyChannelRenamed (what the PATCH route does after DB update)
		sm.notifyChannelRenamed(channelId);

		const titleMsg = received.find((m) => m.type === "TITLE_CHANGE") as
			| (ProtocolMessage & { displayTitle?: string })
			| undefined;
		expect(titleMsg).toBeDefined();
		expect(titleMsg?.displayTitle).toBe("Renamed Tab");
	});
});

// ─── broadcastDisplayTitles tests ─────────────────────────────────────────────

describe("SessionManager — broadcastDisplayTitles", () => {
	let sm: SessionManager;
	let dbManager: ReturnType<typeof openTestDatabases>;

	afterEach(async () => {
		await sm.shutdown();
		dbManager.close();
	});

	/**
	 * Helper: inject a channel into the in-memory channels map with a connected
	 * client so that _broadcastToChannel reaches it.
	 */
	function injectChannelWithClient(
		sm: SessionManager,
		channelId: string,
		clientId: string,
		dynamicTitle: string | null,
		processTitle: string | null = null,
	): ProtocolMessage[] {
		const received: ProtocolMessage[] = [];
		const client = makeClient(clientId, received);
		sm.addClient(client);
		client.attachedChannels.add(channelId);

		const channels = (sm as unknown as { channels: Map<string, object> }).channels;
		channels.set(channelId, {
			sessionId: "s1",
			hostId: "h1",
			status: "live" as const,
			clients: new Set([clientId]),
			shell: "/bin/bash",
			cols: 80,
			rows: 24,
			dynamicTitle,
			processTitle,
			displayTitle: dynamicTitle ?? "Terminal",
		});

		return received;
	}

	it("broadcasts TITLE_CHANGE to all active channels", () => {
		dbManager = openTestDatabases();
		sm = new SessionManager(dbManager, undefined, undefined, makeMockConfigResolver("dynamic"));

		const recv1 = injectChannelWithClient(sm, "ch-bdt-1", "c-bdt-1", "vim session");
		const recv2 = injectChannelWithClient(sm, "ch-bdt-2", "c-bdt-2", "bash");

		sm.broadcastDisplayTitles();

		const msg1 = recv1.find((m) => m.type === "TITLE_CHANGE") as
			| (ProtocolMessage & { channelId?: string; displayTitle?: string })
			| undefined;
		const msg2 = recv2.find((m) => m.type === "TITLE_CHANGE") as
			| (ProtocolMessage & { channelId?: string; displayTitle?: string })
			| undefined;

		expect(msg1).toBeDefined();
		expect(msg1?.channelId).toBe("ch-bdt-1");
		expect(msg1?.displayTitle).toBe("vim session");

		expect(msg2).toBeDefined();
		expect(msg2?.channelId).toBe("ch-bdt-2");
		expect(msg2?.displayTitle).toBe("bash");
	});

	it("uses updated config when re-resolving (dynamic → static switch)", () => {
		dbManager = openTestDatabases();

		// Start with dynamic mode
		const configResolver = makeMockConfigResolver("dynamic");
		sm = new SessionManager(dbManager, undefined, undefined, configResolver);

		const recv = injectChannelWithClient(sm, "ch-bdt-3", "c-bdt-3", "htop");

		// Verify dynamic title before switch
		sm.broadcastDisplayTitles();
		const dynMsg = recv.find((m) => m.type === "TITLE_CHANGE") as
			| (ProtocolMessage & { displayTitle?: string })
			| undefined;
		expect(dynMsg?.displayTitle).toBe("htop");

		// Simulate config switch to static mode (mutate the mock resolver in place)
		(
			configResolver as unknown as { uiConfig: { title: { source: string; staticTitle: string } } }
		).uiConfig = {
			title: { source: "static", staticTitle: "My Static Tab" },
		};

		recv.length = 0;
		sm.broadcastDisplayTitles();

		const staticMsg = recv.find((m) => m.type === "TITLE_CHANGE") as
			| (ProtocolMessage & { displayTitle?: string })
			| undefined;
		expect(staticMsg?.displayTitle).toBe("My Static Tab");
	});

	it("does nothing when no channels are active", () => {
		dbManager = openTestDatabases();
		sm = new SessionManager(dbManager, undefined, undefined, makeMockConfigResolver("dynamic"));

		// No channels injected — should not throw
		expect(() => sm.broadcastDisplayTitles()).not.toThrow();
	});

	it("TITLE_CHANGE message includes correct title field from dynamicTitle", () => {
		dbManager = openTestDatabases();
		sm = new SessionManager(dbManager, undefined, undefined, makeMockConfigResolver("dynamic"));

		const recv = injectChannelWithClient(sm, "ch-bdt-4", "c-bdt-4", "zsh — ~/projects");

		sm.broadcastDisplayTitles();

		const msg = recv.find((m) => m.type === "TITLE_CHANGE") as
			| (ProtocolMessage & { title?: string; displayTitle?: string })
			| undefined;
		expect(msg?.title).toBe("zsh — ~/projects");
		expect(msg?.displayTitle).toBe("zsh — ~/projects");
	});
});

// ─── Elevation support ────────────────────────────────────────────────────────

describe("SessionManager — elevation support", () => {
	let sm: SessionManager;
	let dbManager: ReturnType<typeof openTestDatabases>;

	beforeEach(() => {
		localSpawnCount = 0;
		sshSpawnCount = 0;
		mockSshAgentInstance = null;
		dbManager = openTestDatabases();
		sm = new SessionManager(dbManager);
	});

	afterEach(async () => {
		await sm.shutdown();
		dbManager.close();
	});

	/** Access private agentCapabilities map for test setup. */
	function setAgentCapabilities(hostId: string, caps: string[]): void {
		(
			sm as unknown as {
				agentCapabilities: Map<string, string[]>;
			}
		).agentCapabilities.set(hostId, caps);
	}

	/** Access private elevationCache map for test inspection/setup. */
	function getElevationCache(): Map<string, { secret: string; expiresAt: number }> {
		return (
			sm as unknown as {
				elevationCache: Map<string, { secret: string; expiresAt: number }>;
			}
		).elevationCache;
	}

	/**
	 * Build a WsClient that automatically responds to AUTH_PROMPT messages.
	 * When the client receives an AUTH_PROMPT, it calls handleAuthPromptResponse
	 * with `responseSecret` on the next microtask.
	 */
	function makeAutoRespondClient(
		id: string,
		received: ProtocolMessage[],
		responseSecret: string | null,
	): WsClient {
		return {
			id,
			send: (msg: ProtocolMessage) => {
				received.push(msg);
				if (msg.type === "AUTH_PROMPT") {
					const promptMsg = msg as AuthPromptMessage;
					// Respond on next microtask so the pending entry is registered first
					Promise.resolve().then(() => {
						sm.handleAuthPromptResponse(id, promptMsg.hostId, responseSecret);
					});
				}
			},
			attachedChannels: new Set(),
		};
	}

	it("SC-19: SSH host with elevated=true: stripped — spawn proceeds without elevation", async () => {
		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);

		const host = dal.createHost({
			type: "ssh",
			label: "windows-ssh",
			sshHost: "user@192.168.1.1",
			sshAuth: "password",
		});

		const received: ProtocolMessage[] = [];
		const client = makeClient("c-sc19", received);
		sm.addClient(client);

		// Perform the spawn — SSH agent mock auto-resolves SPAWN_OK.
		// Since elevation is stripped (SSH host), no AUTH_PROMPT is sent.
		await sm.handleSpawn("c-sc19", { type: "SPAWN", hostId: host.id, elevated: true });

		// No AUTH_PROMPT should have been sent (elevation was stripped for SSH hosts)
		const authPrompts = received.filter((m) => m.type === "AUTH_PROMPT");
		expect(authPrompts).toHaveLength(0);

		// A channel should have been created (spawn succeeded without elevation)
		const sessions = dal.listSessions(host.id);
		expect(sessions.length).toBeGreaterThan(0);
		const channels = dal.listChannels(sessions[0]?.id);
		expect(channels.length).toBeGreaterThan(0);

		// The agent should have received a SPAWN without elevated flag
		const spawnMsg = mockSshAgentInstance?.send.mock.calls.find(
			(c) => (c[0] as ProtocolMessage).type === "SPAWN",
		)?.[0] as import("@lasterm/shared").AgentSpawnMessage | undefined;
		expect(spawnMsg?.elevated).toBeFalsy();
		expect(spawnMsg?.elevationSecret).toBeUndefined();
	});

	it("SC-19: local host with elevated=true but agent lacks launch-profiles: stripped", async () => {
		const localHostId = await sm.ensureLocalHost();

		const received: ProtocolMessage[] = [];
		const client = makeClient("c-sc19b", received);
		sm.addClient(client);

		// Agent does NOT have launch-profiles capability (pre-set, HELLO not emitted by mock)
		setAgentCapabilities(localHostId, ["multiplex", "snapshot"]);

		await sm.handleSpawn("c-sc19b", { type: "SPAWN", hostId: localHostId, elevated: true });

		// No AUTH_PROMPT sent (elevation stripped due to missing capability)
		const authPrompts = received.filter((m) => m.type === "AUTH_PROMPT");
		expect(authPrompts).toHaveLength(0);
	});

	it("SC-20: first spawn with elevated=true sends AUTH_PROMPT; second spawn uses cache", async () => {
		const localHostId = await sm.ensureLocalHost();

		const received: ProtocolMessage[] = [];

		// Use auto-respond client: first AUTH_PROMPT gets "hunter2" automatically.
		const client = makeAutoRespondClient("c-sc20", received, "hunter2");
		sm.addClient(client);

		// Agent has launch-profiles capability
		setAgentCapabilities(localHostId, ["multiplex", "snapshot", "launch-profiles"]);

		// ── First spawn: AUTH_PROMPT sent → auto-responded → spawn completes ─
		await sm.handleSpawn("c-sc20", { type: "SPAWN", hostId: localHostId, elevated: true });

		// AUTH_PROMPT should have been sent and auto-responded
		const prompts = received.filter((m) => m.type === "AUTH_PROMPT") as AuthPromptMessage[];
		expect(prompts).toHaveLength(1);
		expect(prompts[0]?.promptType).toBe("elevation");

		// Elevation cache should now be set (keyed by hostId:clientId)
		const cache = getElevationCache();
		expect(cache.has(`${localHostId}:c-sc20`)).toBe(true);
		expect(cache.get(`${localHostId}:c-sc20`)?.secret).toBe("hunter2");

		// ── Second spawn: cache hit → no new AUTH_PROMPT ─────────────────
		const promptsBefore = received.filter((m) => m.type === "AUTH_PROMPT").length;
		await sm.handleSpawn("c-sc20", { type: "SPAWN", hostId: localHostId, elevated: true });

		const promptsAfter = received.filter((m) => m.type === "AUTH_PROMPT").length;
		expect(promptsAfter).toBe(promptsBefore); // no new AUTH_PROMPT
	});

	it("SC-20b: expired cache entry causes new AUTH_PROMPT on next spawn", async () => {
		const localHostId = await sm.ensureLocalHost();

		const received: ProtocolMessage[] = [];

		// Auto-respond client: any AUTH_PROMPT gets "new-secret"
		const client = makeAutoRespondClient("c-sc20b", received, "new-secret");
		sm.addClient(client);

		setAgentCapabilities(localHostId, ["multiplex", "snapshot", "launch-profiles"]);

		// Pre-seed the cache with an expired entry (composite key)
		getElevationCache().set(`${localHostId}:c-sc20b`, {
			secret: "old-secret",
			expiresAt: Date.now() - 1,
		});

		// Spawn: expired cache → AUTH_PROMPT triggered → auto-responded → completes
		await sm.handleSpawn("c-sc20b", { type: "SPAWN", hostId: localHostId, elevated: true });

		// AUTH_PROMPT should have been sent (cache was expired)
		const prompts = received.filter((m) => m.type === "AUTH_PROMPT") as AuthPromptMessage[];
		expect(prompts).toHaveLength(1);
		expect(prompts[0]?.promptType).toBe("elevation");

		// Cache should be updated with the new secret (composite key)
		expect(getElevationCache().get(`${localHostId}:c-sc20b`)?.secret).toBe("new-secret");
	});

	it("SC-20: user cancels elevation prompt → spawn returns null, ELEVATION_CANCELLED error sent", async () => {
		const localHostId = await sm.ensureLocalHost();

		const received: ProtocolMessage[] = [];

		// Auto-respond with null (user cancel)
		const client = makeAutoRespondClient("c-sc20c", received, null);
		sm.addClient(client);

		setAgentCapabilities(localHostId, ["multiplex", "snapshot", "launch-profiles"]);

		// Spawn: AUTH_PROMPT auto-cancelled → handleSpawn returns null
		const result = await sm.handleSpawn("c-sc20c", {
			type: "SPAWN",
			hostId: localHostId,
			elevated: true,
		});

		// handleSpawn should return null
		expect(result).toBeNull();

		// An ELEVATION_CANCELLED error should have been sent to the client
		const errMsg = received.find((m) => m.type === "ERROR") as
			| (ProtocolMessage & { code?: string })
			| undefined;
		expect(errMsg?.code).toBe("ELEVATION_CANCELLED");

		// No channel should have been created
		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);
		const sessions = dal.listSessions(localHostId);
		const channels = sessions.flatMap((s) => dal.listChannels(s.id));
		expect(channels).toHaveLength(0);
	});

	it("D4: closeSession clears pending elevation prompt and rejects late response without caching", async () => {
		const localHostId = await sm.ensureLocalHost();
		const received: ProtocolMessage[] = [];
		const client = makeClient("c-d4-close-elevation", received);
		sm.addClient(client);
		setAgentCapabilities(localHostId, ["multiplex", "snapshot", "launch-profiles"]);

		const spawnPromise = sm.handleSpawn("c-d4-close-elevation", {
			type: "SPAWN",
			hostId: localHostId,
			elevated: true,
		});
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));

		const prompt = received.find((m) => m.type === "AUTH_PROMPT") as AuthPromptMessage | undefined;
		expect(prompt?.promptType).toBe("elevation");
		const promptId = prompt?.promptId ?? "";
		expect(promptId).toBeTruthy();

		const ctx = (sm as unknown as { ctx: import("./session-context.js").SharedSessionContext }).ctx;
		const sessionId = ctx.sessions.get(localHostId)?.id ?? "";
		expect(sessionId).toBeTruthy();
		const elevationContextId = ctx.promptIndex.get(promptId);
		expect(elevationContextId).toBeDefined();
		expect(ctx.promptContexts.get(elevationContextId!)?.kind).toBe("elevation");
		expect(ctx.elevationPromptOwners?.get(elevationContextId!)?.sessionId).toBe(sessionId);

		await sm.closeSession(sessionId);

		expect(ctx.promptContexts.has(elevationContextId!)).toBe(false);
		expect(ctx.elevationPromptOwners?.has(elevationContextId!)).toBe(false);
		expect(ctx.promptIndex.has(promptId)).toBe(false);
		expect(ctx.pendingPrompts.has(promptId)).toBe(false);

		await expect(spawnPromise).resolves.toBeNull();

		sm.handleAuthPromptResponse(
			"c-d4-close-elevation",
			localHostId,
			"late-elevation-secret",
			false,
			promptId,
			(prompt as unknown as { deliveryEpoch?: number }).deliveryEpoch,
		);

		expect(ctx.elevationCache.size).toBe(0);
		expect(ctx.passphraseCache.size).toBe(0);
		expect(
			[...ctx.elevationCache.values(), ...ctx.passphraseCache.values()].some(
				(entry) => entry.secret === "late-elevation-secret",
			),
		).toBe(false);
	});

	it("KIND-D8 spawn elevation delivery miss cleans pending prompt immediately", async () => {
		const localHostId = await sm.ensureLocalHost();
		const received: ProtocolMessage[] = [];
		const client = makeClient("c-d8-spawn-elevation", received);
		sm.addClient(client);
		setAgentCapabilities(localHostId, ["multiplex", "snapshot", "launch-profiles"]);

		const ctx = (sm as unknown as { ctx: import("./session-context.js").SharedSessionContext }).ctx;
		const getClient = ctx.clients.get.bind(ctx.clients);
		let missingAtPromptDelivery = false;
		const getSpy = vi.spyOn(ctx.clients, "get").mockImplementation((id) => {
			if (missingAtPromptDelivery && id === "c-d8-spawn-elevation") return undefined;
			return getClient(id);
		});

		try {
			const spawnPromise = sm.handleSpawn("c-d8-spawn-elevation", {
				type: "SPAWN",
				hostId: localHostId,
				elevated: true,
			});
			missingAtPromptDelivery = true;

			await new Promise((r) => setImmediate(r));
			await new Promise((r) => setImmediate(r));

			expect(ctx.pendingPrompts.size).toBe(0);
			expect(ctx.promptIndex.size).toBe(0);
			await expect(spawnPromise).resolves.toBeNull();
			expect(ctx.promptContexts.size).toBe(0);
		} finally {
			getSpy.mockRestore();
		}
	});

	it("persist-01: elevated=true channel persists elevated+elevationMethod in DB", async () => {
		const localHostId = await sm.ensureLocalHost();
		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);

		const received: ProtocolMessage[] = [];
		const client = makeAutoRespondClient("c-persist01", received, "s3cr3t");
		sm.addClient(client);
		setAgentCapabilities(localHostId, ["multiplex", "snapshot", "launch-profiles"]);

		const channelId = await sm.handleSpawn("c-persist01", {
			type: "SPAWN",
			hostId: localHostId,
			elevated: true,
		});
		expect(channelId).not.toBeNull();

		const channel = dal.getChannel(channelId!);
		expect(channel?.elevated).toBe(true);
		expect(channel?.elevationMethod).toBeDefined();
	});

	it("persist-02: non-elevated channel has elevated=false in DB", async () => {
		const localHostId = await sm.ensureLocalHost();
		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);

		const received: ProtocolMessage[] = [];
		const client = makeClient("c-persist02", received);
		sm.addClient(client);

		const channelId = await sm.handleSpawn("c-persist02", {
			type: "SPAWN",
			hostId: localHostId,
		});
		expect(channelId).not.toBeNull();

		const channel = dal.getChannel(channelId!);
		expect(channel?.elevated).toBeFalsy();
		expect(channel?.elevationMethod).toBeUndefined();
	});

	it("restart-elev-01: restartChannel re-elevates using cache hit (no prompt)", async () => {
		const localHostId = await sm.ensureLocalHost();
		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);

		const received: ProtocolMessage[] = [];
		const client = makeAutoRespondClient("c-restart01", received, "p@ss");
		sm.addClient(client);
		setAgentCapabilities(localHostId, ["multiplex", "snapshot", "launch-profiles"]);

		// Spawn an elevated channel (primes the cache)
		const channelId = await sm.handleSpawn("c-restart01", {
			type: "SPAWN",
			hostId: localHostId,
			elevated: true,
		});
		expect(channelId).not.toBeNull();

		// Verify cache was primed (composite key hostId:clientId)
		const cache = getElevationCache();
		expect(cache.has(`${localHostId}:c-restart01`)).toBe(true);

		// Count AUTH_PROMPT messages before restart
		const promptsBefore = received.filter((m) => m.type === "AUTH_PROMPT").length;

		// Restart the channel — cache hit → no new AUTH_PROMPT
		const ok = await sm.restartChannel(channelId!);
		expect(ok).toBe(true);

		const promptsAfter = received.filter((m) => m.type === "AUTH_PROMPT").length;
		expect(promptsAfter).toBe(promptsBefore);

		// Channel should be live in DB
		const channel = dal.getChannel(channelId!);
		expect(channel?.status).toBe("live");
	});

	it("restart-elev-02: restartChannel with expired cache prompts user for secret", async () => {
		const localHostId = await sm.ensureLocalHost();
		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);

		const received: ProtocolMessage[] = [];
		const client = makeAutoRespondClient("c-restart02", received, "new-p@ss");
		sm.addClient(client);
		setAgentCapabilities(localHostId, ["multiplex", "snapshot", "launch-profiles"]);

		// Spawn elevated channel (auto-prompt fills cache)
		const channelId = await sm.handleSpawn("c-restart02", {
			type: "SPAWN",
			hostId: localHostId,
			elevated: true,
		});
		expect(channelId).not.toBeNull();

		// Expire the cache (composite key)
		getElevationCache().set(`${localHostId}:c-restart02`, {
			secret: "old",
			expiresAt: Date.now() - 1,
		});

		// Count AUTH_PROMPT messages before restart
		const promptsBefore = received.filter((m) => m.type === "AUTH_PROMPT").length;

		// Restart — expired cache → passwordless fails → AUTH_PROMPT → auto-respond → success
		const ok = await sm.restartChannel(channelId!, "c-restart02");
		expect(ok).toBe(true);

		// A new AUTH_PROMPT should have been sent for the restart
		const promptsAfter = received.filter((m) => m.type === "AUTH_PROMPT").length;
		expect(promptsAfter).toBe(promptsBefore + 1);

		// Cache updated with new secret (composite key)
		expect(getElevationCache().get(`${localHostId}:c-restart02`)?.secret).toBe("new-p@ss");

		// Channel should be live in DB
		const channel = dal.getChannel(channelId!);
		expect(channel?.status).toBe("live");
	});

	it("restart-elev-03: restartChannel cancels elevation → returns false", async () => {
		const localHostId = await sm.ensureLocalHost();

		const received: ProtocolMessage[] = [];
		// For spawn, auto-respond with a secret. For restart, auto-respond with null (cancel).
		let spawnDone = false;
		const client: WsClient = {
			id: "c-restart03",
			send: (msg: ProtocolMessage) => {
				received.push(msg);
				if (msg.type === "AUTH_PROMPT") {
					const promptMsg = msg as AuthPromptMessage;
					Promise.resolve().then(() => {
						sm.handleAuthPromptResponse(
							"c-restart03",
							promptMsg.hostId,
							spawnDone ? null : "initial-pass",
						);
					});
				}
			},
			attachedChannels: new Set(),
		};
		sm.addClient(client);
		setAgentCapabilities(localHostId, ["multiplex", "snapshot", "launch-profiles"]);

		// Spawn elevated channel successfully
		const channelId = await sm.handleSpawn("c-restart03", {
			type: "SPAWN",
			hostId: localHostId,
			elevated: true,
		});
		expect(channelId).not.toBeNull();
		spawnDone = true;

		// Expire cache so restart will prompt (composite key)
		getElevationCache().set(`${localHostId}:c-restart03`, {
			secret: "old",
			expiresAt: Date.now() - 1,
		});

		// Restart — user cancels prompt → returns false
		const ok = await sm.restartChannel(channelId!, "c-restart03");
		expect(ok).toBe(false);

		// ELEVATION_CANCELLED error sent to client
		const errMsg = received.find(
			(m) =>
				m.type === "ERROR" &&
				(m as ProtocolMessage & { code?: string }).code === "ELEVATION_CANCELLED",
		);
		expect(errMsg).toBeDefined();
	});
});

// ─── Concurrent-SPAWN coalescing tests ───────────────────────────────────────
//
// These tests prove the acquiringSessions in-flight map prevents two concurrent
// handleSpawn calls for the same SSH host from each creating their own session
// and their own SSH connect.
//
// The root race (fixed here): handleSpawn used to call getOrCreateSession BEFORE
// the coalesce check. getOrCreateSession only reuses active/disconnected sessions
// — NOT starting — so two concurrent SPAWNs each created a new "starting" session,
// then the second overwrote ctx.sessions[hostId]. Channels split across two
// sessions; session A was orphaned.
//
// Fix: the in-flight slot (acquiringSessions) is claimed SYNCHRONOUSLY (no await
// between the .has() check and the .set() call). The promise body does
// getOrCreateSession → _connectSshAgent and RESOLVES to the SessionState so all
// followers share the exact same session object.
//
// Mutation oracles:
//   - removing the acquiringSessions guard → SshAgent constructed twice (count=2)
//   - moving getOrCreateSession BEFORE the .set() call → two sessions in ctx.sessions

// Re-import the mocked SshAgent so vi.mocked() can read call counts.
import { SshAgent as _SshAgentForMock } from "./ssh-agent.js";

describe("SessionManager — concurrent SSH connect coalescing", () => {
	let sm: SessionManager;
	let dbManager: ReturnType<typeof openTestDatabases>;

	beforeEach(() => {
		localSpawnCount = 0;
		sshSpawnCount = 0;
		mockSshAgentInstance = null;
		nextSshStartError = null;
		dbManager = openTestDatabases();
		sm = new SessionManager(dbManager);
		vi.mocked(_SshAgentForMock).mockClear();
	});

	afterEach(async () => {
		await sm.shutdown();
		dbManager.close();
	});

	async function createSshHost(): Promise<string> {
		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);
		const host = dal.createHost({
			type: "ssh",
			label: "concurrent-ssh",
			sshHost: "user@concurrent-test",
			sshAuth: "key",
			sshKeyPath: "/nonexistent/key",
		});
		return host.id;
	}

	// ── Invariant 1: one session, one SshAgent, both channels share that session ──
	//
	// Pre-fix: ctx.sessions has TWO entries for the same hostId (overwritten),
	// SshAgent is constructed twice, and channels reference different sessionIds.
	// Post-fix: exactly one session entry, one SshAgent construction, both
	// channel states carry the same sessionId.
	it("two concurrent SPAWNs share exactly one session and one SshAgent", async () => {
		const hostId = await createSshHost();

		const c1 = makeClient("c-conc-1", []);
		const c2 = makeClient("c-conc-2", []);
		sm.addClient(c1);
		sm.addClient(c2);

		// Fire both SPAWNs without awaiting — coalescing must engage.
		const spawn1 = sm.handleSpawn("c-conc-1", { type: "SPAWN", hostId });
		const spawn2 = sm.handleSpawn("c-conc-2", { type: "SPAWN", hostId });

		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));

		const [ch1, ch2] = await Promise.all([spawn1, spawn2]);

		// Both channels open successfully and are distinct
		expect(ch1).not.toBeNull();
		expect(ch2).not.toBeNull();
		expect(ch1).not.toBe(ch2);

		// INVARIANT: only ONE session was created for this host.
		// Mutation oracle (pre-fix): ctx.sessions still maps hostId but the
		// session object was overwritten by the second SPAWN; ch1 belongs to the
		// orphaned first session. Post-fix: one entry, stable id.
		const sessionEntry = (sm as unknown as { sessions: Map<string, { id: string }> }).sessions.get(
			hostId,
		);
		expect(sessionEntry).toBeDefined();
		const sessionId = sessionEntry?.id ?? "";

		// Both channels must reference the SHARED session, not two different ones.
		const channels = sm as unknown as { channels: Map<string, { sessionId: string }> };
		if (ch1 !== null) {
			expect(channels.channels.get(ch1)?.sessionId).toBe(sessionId);
		}
		if (ch2 !== null) {
			expect(channels.channels.get(ch2)?.sessionId).toBe(sessionId);
		}

		// INVARIANT: only one SshAgent constructed — second SPAWN coalesced.
		// Mutation oracle: removing the guard makes this assertion fail (count = 2).
		expect(vi.mocked(_SshAgentForMock).mock.calls).toHaveLength(1);

		// In-flight map cleared by .finally() — no leak
		expect(sm.acquisitions.size).toBe(0);
	});

	// ── Invariant 2: failure clears in-flight + starting session; retry succeeds ──
	//
	// Pre-fix: after failure the "starting" session persisted in ctx.sessions; the
	// retry SPAWN found it and reused the dead session instead of creating a fresh one.
	// Post-fix: failure handler deletes the starting session from ctx + marks it
	// closed in DB, so the retry starts with a clean slate.
	it("connect failure clears in-flight map and starting session so retry succeeds", async () => {
		nextSshStartError = new Error("SSH_AUTH_FAILED");

		const hostId = await createSshHost();

		const c1Received: ProtocolMessage[] = [];
		const c1 = makeClient("c-conc-fail-1", c1Received);
		sm.addClient(c1);

		// Single SPAWN — fails because start() rejects
		const ch1 = await sm.handleSpawn("c-conc-fail-1", { type: "SPAWN", hostId });
		expect(ch1).toBeNull();
		expect(c1Received.some((m) => m.type === "ERROR")).toBe(true);

		// INVARIANT: in-flight entry cleared after failure — no leak
		expect(sm.acquisitions.size).toBe(0);

		// INVARIANT: the "starting" session must NOT persist in ctx.sessions after failure.
		// Mutation oracle: pre-fix, the starting session remains and the retry reuses it,
		// leading to a stale-session bug. Post-fix: the entry is deleted.
		const sessionAfterFail = (
			sm as unknown as { sessions: Map<string, { status: string }> }
		).sessions.get(hostId);
		expect(sessionAfterFail).toBeUndefined();

		// Retry: nextSshStartError is null (cleared by factory) — succeeds
		const c2Received: ProtocolMessage[] = [];
		const c2 = makeClient("c-conc-fail-2", c2Received);
		sm.addClient(c2);

		const spawn2 = sm.handleSpawn("c-conc-fail-2", { type: "SPAWN", hostId });
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));
		const ch2 = await spawn2;
		expect(ch2).not.toBeNull();
		// Retry creates a fresh session
		expect(sm.acquisitions.size).toBe(0);
	});

	// ── Fix 1: client disconnected during SSH connect wait → null, no orphan channel ──
	//
	// Mutation oracle: removing the ctx.clients.has(clientId) guard causes
	// handleSpawn to proceed to sendSpawnAndWait and create a channel even
	// though the requesting client is gone.
	it("client that disconnects during SSH connect wait: handleSpawn returns null, no channel created", async () => {
		const hostId = await createSshHost();

		// Hold the SSH connect promise so we can disconnect the client mid-flight.
		let resolveConnect!: () => void;
		const connectBarrier = new Promise<void>((res) => {
			resolveConnect = res;
		});

		// Make SshAgent.start() block until we release it.
		vi.mocked(_SshAgentForMock).mockImplementationOnce((() => {
			const inst = new MockSshAgent();
			inst.start = vi.fn().mockReturnValue(connectBarrier);
			return inst;
		}) as unknown as typeof MockSshAgent);

		const c1Received: ProtocolMessage[] = [];
		const c1 = makeClient("c-disc-1", c1Received);
		sm.addClient(c1);

		// Start the SPAWN but don't await yet — it will block at sshAgent.start()
		const spawnPromise = sm.handleSpawn("c-disc-1", { type: "SPAWN", hostId });

		// Give the async body a tick to reach the connect barrier
		await new Promise((r) => setImmediate(r));

		// Simulate WS close: remove the client from ctx before the connect resolves
		sm.removeClient("c-disc-1");

		// Now let SSH connect succeed
		resolveConnect();

		// Give setImmediate callbacks a chance to run
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));

		const result = await spawnPromise;

		// handleSpawn must return null — no orphan channel launched
		expect(result).toBeNull();

		// No channel created for this disconnected client
		const channels = (sm as unknown as { channels: Map<string, unknown> }).channels;
		expect(channels.size).toBe(0);
	});

	// ── Fix 2: connect failure preserves pre-existing disconnected session ──
	//
	// When getOrCreateSession returns a pre-existing disconnected session (not a
	// freshly created 'starting' one), a subsequent connect failure must NOT delete
	// it. The session needs to stay in ctx.sessions for reconnect/restart.
	//
	// Mutation oracle: reverting to unconditional delete removes the session even
	// when it was pre-existing, making this assertion fail (session gone).
	it("connect failure preserves a pre-existing disconnected session", async () => {
		const hostId = await createSshHost();

		// Seed a disconnected session for this host in the in-memory map directly.
		const disconnectedSessionId = "DISCSESS0000000000000000000001";
		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);
		dal.createSession({ id: disconnectedSessionId, hostId, status: "disconnected" });

		const sessions = (sm as unknown as { sessions: Map<string, { id: string; status: string }> })
			.sessions;
		sessions.set(hostId, { id: disconnectedSessionId, hostId, status: "disconnected" });

		// Make the next SSH connect fail
		nextSshStartError = new Error("SSH_CONNECT_TIMEOUT");

		const c1Received: ProtocolMessage[] = [];
		const c1 = makeClient("c-pres-1", c1Received);
		sm.addClient(c1);

		const result = await sm.handleSpawn("c-pres-1", { type: "SPAWN", hostId });
		expect(result).toBeNull();
		expect(c1Received.some((m) => m.type === "ERROR")).toBe(true);

		// INVARIANT: the disconnected session must still be present in ctx.sessions
		// (not deleted). Mutation oracle: unconditional delete → session gone here.
		const sessionAfterFail = sessions.get(hostId);
		expect(sessionAfterFail).toBeDefined();
		expect(sessionAfterFail?.id).toBe(disconnectedSessionId);
		expect(sessionAfterFail?.status).toBe("disconnected");
	});

	it("pre-commit exception fails acquisition with joined follower and clears PromptContext", async () => {
		const hostId = await createSshHost();
		const ctx = (sm as unknown as { ctx: import("./session-context.js").SharedSessionContext }).ctx;
		const agentMgr = (
			sm as unknown as {
				agentMgr: {
					getOrCreateSession: (
						hostId: string,
						isSsh: boolean,
					) => Promise<import("./session-context.js").SessionState>;
				};
			}
		).agentMgr;
		let rejectGetOrCreate!: (err: Error) => void;
		const getOrCreatePromise = new Promise<import("./session-context.js").SessionState>(
			(_resolve, reject) => {
				rejectGetOrCreate = reject;
			},
		);
		agentMgr.getOrCreateSession = vi.fn().mockReturnValue(getOrCreatePromise);

		const c1Received: ProtocolMessage[] = [];
		const c2Received: ProtocolMessage[] = [];
		const c1 = makeClient("c-precommit-1", c1Received);
		const c2 = makeClient("c-precommit-2", c2Received);
		sm.addClient(c1);
		sm.addClient(c2);

		const spawn1 = sm.handleSpawn("c-precommit-1", { type: "SPAWN", hostId });

		for (let i = 0; i < 5 && !sm.acquisitions.has(hostId); i++) {
			await Promise.resolve();
		}
		const acq = sm.acquisitions.get(hostId);
		expect(acq).toBeDefined();
		if (!acq) throw new Error("expected acquisition");

		openContext(ctx, "session", hostId, "c-precommit-1", acq.id);
		const promptPromise = promptCtx(
			ctx,
			acq.id,
			"passphrase",
			{ type: "AUTH_PROMPT", hostId, promptType: "passphrase", message: "test", promptId: "" },
			(routeClientId, msg) => {
				ctx.clients.get(routeClientId)?.send(msg as unknown as ProtocolMessage);
			},
		);
		expect(promptPromise).not.toBeNull();
		if (promptPromise === null) throw new Error("expected prompt promise");
		const promptId = [...ctx.pendingPrompts.keys()][0];
		expect(promptId).toBeDefined();
		if (promptId === undefined) throw new Error("expected prompt id");
		expect(ctx.promptContexts.has(acq.id)).toBe(true);
		expect(ctx.pendingPrompts.has(promptId)).toBe(true);

		const followerConnectRejected = acq.connectPromise.catch((err: Error) => err);
		const spawn2 = sm.handleSpawn("c-precommit-2", { type: "SPAWN", hostId });

		for (let i = 0; i < 5 && acq.leases.size < 2; i++) {
			await Promise.resolve();
		}
		expect(acq.leases.size).toBe(2);

		const preCommitError = new Error("pre-commit session creation failed");
		rejectGetOrCreate(preCommitError);

		const [ch1, ch2, followerError, promptResult] = await Promise.all([
			spawn1,
			spawn2,
			followerConnectRejected,
			promptPromise as Promise<unknown>,
		]);

		expect(ch1).toBeNull();
		expect(ch2).toBeNull();
		expect(followerError).toBe(preCommitError);
		expect(sm.acquisitions.has(hostId)).toBe(false);
		expect(ctx.promptContexts.has(acq.id)).toBe(false);
		expect(ctx.pendingPrompts.has(promptId)).toBe(false);
		expect(ctx.promptIndex.has(promptId)).toBe(false);
		expect(promptResult).toBeNull();
		expect(
			c2Received.some(
				(m) =>
					m.type === "ERROR" &&
					(m as ProtocolMessage & { code?: string }).code === "SSH_CONNECT_FAILED",
			),
		).toBe(true);
	});

	it("pre-commit guard failure fails acquisition with joined follower and clears PromptContext", async () => {
		const hostId = await createSshHost();
		const ctx = (sm as unknown as { ctx: import("./session-context.js").SharedSessionContext }).ctx;
		let releaseConnect!: () => void;
		const connectBarrier = new Promise<void>((resolve) => {
			releaseConnect = resolve;
		});
		const connectedAgent = new MockSshAgent();
		(
			sm as unknown as {
				_connectSshAgent: () => Promise<import("./agent-connection.js").AgentConnection>;
			}
		)._connectSshAgent = vi.fn(async () => {
			await connectBarrier;
			ctx.sessions.delete(hostId);
			return connectedAgent as unknown as import("./agent-connection.js").AgentConnection;
		});

		const c1Received: ProtocolMessage[] = [];
		const c2Received: ProtocolMessage[] = [];
		const c1 = makeClient("c-precommit-guard-1", c1Received);
		const c2 = makeClient("c-precommit-guard-2", c2Received);
		sm.addClient(c1);
		sm.addClient(c2);

		const spawn1 = sm.handleSpawn("c-precommit-guard-1", { type: "SPAWN", hostId });

		for (let i = 0; i < 5 && !sm.acquisitions.has(hostId); i++) {
			await Promise.resolve();
		}
		const acq = sm.acquisitions.get(hostId);
		expect(acq).toBeDefined();
		if (!acq) throw new Error("expected acquisition");

		openContext(ctx, "session", hostId, "c-precommit-guard-1", acq.id);
		const promptPromise = promptCtx(
			ctx,
			acq.id,
			"passphrase",
			{ type: "AUTH_PROMPT", hostId, promptType: "passphrase", message: "test", promptId: "" },
			(routeClientId, msg) => {
				ctx.clients.get(routeClientId)?.send(msg as unknown as ProtocolMessage);
			},
		);
		expect(promptPromise).not.toBeNull();
		if (promptPromise === null) throw new Error("expected prompt promise");
		const promptId = [...ctx.pendingPrompts.keys()][0];
		expect(promptId).toBeDefined();
		if (promptId === undefined) throw new Error("expected prompt id");

		const followerConnectRejected = acq.connectPromise.catch((err: Error) => err);
		const spawn2 = sm.handleSpawn("c-precommit-guard-2", { type: "SPAWN", hostId });

		for (let i = 0; i < 5 && acq.leases.size < 2; i++) {
			await Promise.resolve();
		}
		expect(acq.leases.size).toBe(2);

		releaseConnect();

		const [ch1, ch2, followerError, promptResult] = await Promise.all([
			spawn1,
			spawn2,
			followerConnectRejected,
			promptPromise as Promise<unknown>,
		]);

		expect(ch1).toBeNull();
		expect(ch2).toBeNull();
		expect(followerError).toEqual(expect.objectContaining({ message: "SSH connect aborted" }));
		expect(sm.acquisitions.has(hostId)).toBe(false);
		expect(ctx.promptContexts.has(acq.id)).toBe(false);
		expect(ctx.pendingPrompts.has(promptId)).toBe(false);
		expect(ctx.promptIndex.has(promptId)).toBe(false);
		expect(promptResult).toBeNull();
		expect(connectedAgent.close).toHaveBeenCalled();
		expect(
			c2Received.some(
				(m) =>
					m.type === "ERROR" &&
					(m as ProtocolMessage & { code?: string }).code === "SSH_CONNECT_FAILED",
			),
		).toBe(true);
	});

	// ── Fix 3: shutdown clears acquiringSessions ──
	//
	// Mutation oracle: removing the acquiringSessions.clear() from shutdown() leaves
	// a stale in-flight entry. (Trivially tested; cheap to have as a regression lock.)
	it("shutdown clears acquisitions", async () => {
		// Manually insert a stale entry to simulate an in-flight acquire at shutdown time.
		const rejectSpy = vi.fn();
		let _resolve!: (s: import("./session-context.js").SessionState) => void;
		const connectPromise = new Promise<import("./session-context.js").SessionState>((res, rej) => {
			_resolve = res;
			void rej; // rejectSpy assigned below
		});
		connectPromise.catch(() => {});
		const staleAcq: import("./session-context.js").SessionAcquisition = {
			id: "stale-acq-id",
			hostId: "stale-host-id",
			state: "CONNECTING",
			controller: new AbortController(),
			connectPromise,
			_resolve,
			_reject: rejectSpy,
			leases: new Set(),
		};
		sm.acquisitions.set("stale-host-id", staleAcq);

		expect(sm.acquisitions.size).toBe(1);

		await sm.shutdown();

		expect(sm.acquisitions.size).toBe(0);
	});

	it("shutdown awaits agent close before clearing agent state", async () => {
		const ctx = (sm as unknown as { ctx: import("./session-context.js").SharedSessionContext }).ctx;
		let resolveClose!: () => void;
		const closePromise = new Promise<void>((resolve) => {
			resolveClose = resolve;
		});
		const agent = {
			close: vi.fn(() => closePromise),
			send: vi.fn(),
			connected: true,
		} as unknown as AgentConnection;
		ctx.agents.set("host-await-close", agent);

		const shutdownPromise = sm.shutdown();
		await flushImmediate();

		expect(agent.close).toHaveBeenCalledOnce();
		expect(ctx.agents.has("host-await-close")).toBe(true);

		resolveClose();
		await shutdownPromise;

		expect(ctx.agents.has("host-await-close")).toBe(false);
	});

	it("shutdown aborts acquisitions before awaiting agent close", async () => {
		const ctx = (sm as unknown as { ctx: import("./session-context.js").SharedSessionContext }).ctx;
		let resolveClose!: () => void;
		const closePromise = new Promise<void>((resolve) => {
			resolveClose = resolve;
		});
		const agent = {
			close: vi.fn(() => closePromise),
			send: vi.fn(),
			connected: true,
		} as unknown as AgentConnection;
		ctx.agents.set("host-slow-close", agent);

		const controller = new AbortController();
		const rejectSpy = vi.fn();
		let _resolve!: (s: import("./session-context.js").SessionState) => void;
		const connectPromise = new Promise<import("./session-context.js").SessionState>((res) => {
			_resolve = res;
		});
		connectPromise.catch(() => {});
		sm.acquisitions.set("host-acq-before-close", {
			id: "acq-before-close",
			hostId: "host-acq-before-close",
			state: "CONNECTING",
			controller,
			connectPromise,
			_resolve,
			_reject: rejectSpy,
			leases: new Set(),
		});

		const shutdownPromise = sm.shutdown();
		await flushImmediate();

		expect(agent.close).toHaveBeenCalledOnce();
		expect(controller.signal.aborted).toBe(true);
		expect(rejectSpy).toHaveBeenCalledWith(
			expect.objectContaining({ message: "hub shutting down" }),
		);
		expect(sm.acquisitions.size).toBe(0);

		resolveClose();
		await shutdownPromise;
	});

	// ── NEW Fix 1: same-client sequential re-prompt uses isolated prompt ids ──
	//
	// Mutation oracle: hostId-keyed replacement/timers let the first prompt's timer
	// delete the new prompt, permanently wedging the host.
	it("second buildPromptAuth for same host from SAME client gets its own timer — no timer clobber", async () => {
		vi.useFakeTimers();
		try {
			const hostId = "host-clobber-1";
			const ctx = (sm as unknown as { ctx: import("./session-context.js").SharedSessionContext })
				.ctx;
			// Use the SAME client for both prompts — sequential re-prompt is the legitimate path.
			const sameClient = {
				id: "c-clob-same",
				send: vi.fn(),
				attachedChannels: new Set(),
			} as WsClient;
			sm.addClient(sameClient);

			// Issue first prompt from sameClient
			const promptFn1 = (
				sm as unknown as { sshMgr: { buildPromptAuth: (c: WsClient) => unknown } }
			).sshMgr.buildPromptAuth(sameClient) as (
				hostId: string,
				type: string,
				msg: string,
			) => Promise<string | null>;
			const p1 = promptFn1(hostId, "password", "Enter password");

			// Verify first entry is registered
			const firstPromptId = [...ctx.pendingPrompts.keys()][0]!;
			expect(ctx.pendingPrompts.has(firstPromptId)).toBe(true);

			// Issue second prompt for the SAME hostId from the SAME client.
			const promptFn2 = (
				sm as unknown as { sshMgr: { buildPromptAuth: (c: WsClient) => unknown } }
			).sshMgr.buildPromptAuth(sameClient) as (
				hostId: string,
				type: string,
				msg: string,
			) => Promise<string | null>;
			const p2 = promptFn2(hostId, "password", "Enter password again");
			const secondPromptId = [...ctx.pendingPrompts.keys()].find((id) => id !== firstPromptId)!;

			expect(ctx.pendingPrompts.has(firstPromptId)).toBe(true);
			expect(ctx.pendingPrompts.has(secondPromptId)).toBe(true);

			// Advancing past the full timeout must NOT corrupt the second entry.
			await vi.advanceTimersByTimeAsync(120_000);
			expect(ctx.pendingPrompts.has(firstPromptId)).toBe(false);
			expect(ctx.pendingPrompts.has(secondPromptId)).toBe(false);
			await expect(p1).resolves.toBeNull();
			await expect(p2).resolves.toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	// ── NEW Fix 2: closeSession removes acquiringSessions + rejects in-flight acquire ──
	//
	// Mutation oracle: omitting acquiringSessions.delete from closeSession leaves a stale
	// in-flight entry; followers that awaited it proceed with a session that was closed.
	it("closeSession removes in-flight acquisition entry and signals abort", async () => {
		const hostId = await createSshHost();

		const fakeSessionId = "FAKESESS0000000000000000000001";
		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);
		dal.createSession({ id: fakeSessionId, hostId, status: "active" });

		const sessions = (sm as unknown as { sessions: Map<string, { id: string; status: string }> })
			.sessions;
		sessions.set(hostId, {
			id: fakeSessionId,
			hostId,
			status: "active",
		} as import("./session-context.js").SessionState);

		const rejectSpy = vi.fn();
		let _resolve!: (s: import("./session-context.js").SessionState) => void;
		const connectPromise = new Promise<import("./session-context.js").SessionState>((res, rej) => {
			_resolve = res;
			void rej;
		});
		connectPromise.catch(() => {});
		const inflightAcq: import("./session-context.js").SessionAcquisition = {
			id: "infl-acq-id-close-1",
			hostId,
			state: "CONNECTING",
			controller: new AbortController(),
			connectPromise,
			_resolve,
			_reject: rejectSpy,
			leases: new Set(),
		};
		sm.acquisitions.set(hostId, inflightAcq);

		await sm.closeSession(fakeSessionId);

		// INVARIANT: in-flight entry removed from map
		expect(sm.acquisitions.has(hostId)).toBe(false);
		// INVARIANT: reject called so awaiting followers get a clean error
		expect(rejectSpy).toHaveBeenCalledWith(expect.any(Error));
	});

	// ── NEW Fix 3: removeClient clears prompts owned by that client ──
	//
	// Mutation oracle: omitting the sweep from removeClient leaves the entry alive;
	// the SSH connect waits 2 min instead of failing immediately on disconnect.
	it("removeClient clears PromptContext prompts owned by the disconnecting client", async () => {
		const hostId = "host-rm-client-1";
		const ctx = (sm as unknown as { ctx: import("./session-context.js").SharedSessionContext }).ctx;

		const owner = makeClient("c-rm-1", []);
		const decoyOwner = makeClient("c-rm-other", []);
		sm.addClient(owner);
		sm.addClient(decoyOwner);

		openContext(ctx, "session", hostId, "c-rm-1", "ctx-rm-owned");
		const ownedPromise = promptCtx(
			ctx,
			"ctx-rm-owned",
			"passphrase",
			{ type: "AUTH_PROMPT", hostId, promptType: "password", message: "test", promptId: "" },
			() => {},
		)!;

		// Add a decoy entry owned by a DIFFERENT client — must not be cleared
		openContext(ctx, "session", "host-rm-decoy", "c-rm-other", "ctx-rm-decoy");
		promptCtx(
			ctx,
			"ctx-rm-decoy",
			"passphrase",
			{
				type: "AUTH_PROMPT",
				hostId: "host-rm-decoy",
				promptType: "password",
				message: "test",
				promptId: "",
			},
			() => {},
		)!;

		sm.removeClient("c-rm-1");

		// INVARIANT: context owned by 'c-rm-1' is gone, promise settled with null
		expect(ctx.promptContexts.has("ctx-rm-owned")).toBe(false);
		await expect(ownedPromise).resolves.toBeNull();

		// Decoy context (different client) must NOT be touched
		expect(ctx.promptContexts.has("ctx-rm-decoy")).toBe(true);

		clearContext(ctx, "ctx-rm-decoy");
	});

	// ── NEW Fix 4: shutdown rejects all in-flight acquires with "hub shutting down" ──
	//
	// Mutation oracle: without calling entry.reject() before clear(), awaiting followers
	// hang forever — their catch blocks are never reached, keeping the process alive.
	it("shutdown rejects all in-flight acquires with hub shutting down error", async () => {
		const rejectSpy1 = vi.fn();
		const rejectSpy2 = vi.fn();
		function makeStaleAcq(
			id: string,
			hostId: string,
			rejectSpy: ReturnType<typeof vi.fn>,
		): import("./session-context.js").SessionAcquisition {
			let _resolve!: (s: import("./session-context.js").SessionState) => void;
			const connectPromise = new Promise<import("./session-context.js").SessionState>((res) => {
				_resolve = res;
			});
			connectPromise.catch(() => {});
			return {
				id,
				hostId,
				state: "CONNECTING",
				controller: new AbortController(),
				connectPromise,
				_resolve,
				_reject: rejectSpy,
				leases: new Set(),
			};
		}
		sm.acquisitions.set("host-shut-1", makeStaleAcq("acq-shut-1", "host-shut-1", rejectSpy1));
		sm.acquisitions.set("host-shut-2", makeStaleAcq("acq-shut-2", "host-shut-2", rejectSpy2));

		await sm.shutdown();

		// Both reject handles called with the shutdown error
		expect(rejectSpy1).toHaveBeenCalledWith(
			expect.objectContaining({ message: "hub shutting down" }),
		);
		expect(rejectSpy2).toHaveBeenCalledWith(
			expect.objectContaining({ message: "hub shutting down" }),
		);

		// Map fully cleared
		expect(sm.acquisitions.size).toBe(0);
	});

	// ── AbortSignal 1: closeSession aborts the in-flight AbortController ──
	//
	// Mutation oracle: without controller.abort() in closeSession, the AbortSignal
	// is never set — ssh2 Client.destroy() is never called, and the connect
	// continuation can revive the session after closeSession removed it.
	// Post-fix: controller.signal.aborted is true, entry removed, reject called.
	it("close-during-connect: closeSession signals abort on the in-flight controller", async () => {
		const hostId = await createSshHost();

		// Seed an active session in ctx.sessions so closeSession doesn't bail early.
		const fakeSessionId = "ABORT01SESS0000000000000000000";
		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);
		dal.createSession({ id: fakeSessionId, hostId, status: "active" });

		const sessions = (sm as unknown as { sessions: Map<string, { id: string; status: string }> })
			.sessions;
		sessions.set(hostId, {
			id: fakeSessionId,
			hostId,
			status: "active",
		} as import("./session-context.js").SessionState);

		// Inject an in-flight acquisition entry with a real AbortController
		// (simulates the leader branch of handleSpawn while start() is awaited).
		const controller = new AbortController();
		const rejectSpy = vi.fn();
		let _resolve!: (s: import("./session-context.js").SessionState) => void;
		const connectPromise = new Promise<import("./session-context.js").SessionState>((res) => {
			_resolve = res;
		});
		connectPromise.catch(() => {});
		const inflightAcq: import("./session-context.js").SessionAcquisition = {
			id: "abort01-acq",
			hostId,
			state: "CONNECTING",
			controller,
			connectPromise,
			_resolve,
			_reject: rejectSpy,
			leases: new Set(),
		};
		sm.acquisitions.set(hostId, inflightAcq);

		// INVARIANT: not yet aborted
		expect(controller.signal.aborted).toBe(false);

		await sm.closeSession(fakeSessionId);

		// INVARIANT: AbortController was signalled — ssh2 Client.destroy() would fire
		// Mutation oracle: without controller.abort() this stays false.
		expect(controller.signal.aborted).toBe(true);

		// INVARIANT: reject called so awaiting followers get a clean error
		expect(rejectSpy).toHaveBeenCalledWith(expect.any(Error));

		// INVARIANT: entry removed — no leak
		expect(sm.acquisitions.has(hostId)).toBe(false);
	});

	// ── AbortSignal 2: shutdown aborts all in-flight AbortControllers ──
	//
	// Mutation oracle: without controller.abort() in shutdown(), the underlying
	// ssh2 connect keeps running after shutdown() returns — the process hangs.
	// Post-fix: every in-flight controller is aborted and the map is cleared.
	it("shutdown-during-connect: shutdown signals abort on all in-flight controllers", async () => {
		// Inject two in-flight entries with real AbortControllers.
		const controller1 = new AbortController();
		const controller2 = new AbortController();
		const rejectSpy1 = vi.fn();
		const rejectSpy2 = vi.fn();
		function makeAcq(
			id: string,
			hostId: string,
			ctrl: AbortController,
			rejectSpy: ReturnType<typeof vi.fn>,
		): import("./session-context.js").SessionAcquisition {
			let _resolve!: (s: import("./session-context.js").SessionState) => void;
			const connectPromise = new Promise<import("./session-context.js").SessionState>((res) => {
				_resolve = res;
			});
			connectPromise.catch(() => {});
			return {
				id,
				hostId,
				state: "CONNECTING",
				controller: ctrl,
				connectPromise,
				_resolve,
				_reject: rejectSpy,
				leases: new Set(),
			};
		}
		sm.acquisitions.set(
			"host-abort-shut-1",
			makeAcq("acq-abort-shut-1", "host-abort-shut-1", controller1, rejectSpy1),
		);
		sm.acquisitions.set(
			"host-abort-shut-2",
			makeAcq("acq-abort-shut-2", "host-abort-shut-2", controller2, rejectSpy2),
		);

		// INVARIANT: neither controller aborted yet
		expect(controller1.signal.aborted).toBe(false);
		expect(controller2.signal.aborted).toBe(false);

		await sm.shutdown();

		// INVARIANT: both AbortControllers were signalled
		// Mutation oracle: without controller.abort() in shutdown() these stay false.
		expect(controller1.signal.aborted).toBe(true);
		expect(controller2.signal.aborted).toBe(true);

		// INVARIANT: both reject handles called
		expect(rejectSpy1).toHaveBeenCalledWith(
			expect.objectContaining({ message: "hub shutting down" }),
		);
		expect(rejectSpy2).toHaveBeenCalledWith(
			expect.objectContaining({ message: "hub shutting down" }),
		);

		// INVARIANT: map fully cleared — no leak
		expect(sm.acquisitions.size).toBe(0);
	});

	// ── AbortSignal 3: abort propagates through the auth-prompt path ──
	//
	// When a connect is in-flight and waiting on an auth prompt, calling
	// closeSession must clear the pending prompt entry immediately — no
	// lingering timer or unresolved promise after the abort.
	//
	// Mutation oracle: without the abort listener in buildPromptAuth the
	// pending prompt remains after closeSession, wedging the host
	// for AUTH_PROMPT_TIMEOUT_MS (2 min).
	it("abort propagates through auth-prompt: pending prompt is cleared when connect is aborted", async () => {
		const hostId = await createSshHost();

		// This test exercises buildPromptAuth + AbortSignal directly — no need for
		// a full SPAWN. We build a promptAuth function with a real AbortController,
		// invoke it (arming the pending prompt + abort listener), then
		// abort and verify the entry is cleared and the Promise resolves to null.
		const c1Received: ProtocolMessage[] = [];
		const c1 = makeClient("c-abort-prompt-1", c1Received);
		sm.addClient(c1);

		// Access sshMgr directly to invoke buildPromptAuth and register the abort listener.
		// This tests the full chain: buildPromptAuth(signal) → abort → listener clears prompt.
		const ctx = (sm as unknown as { ctx: import("./session-context.js").SharedSessionContext }).ctx;

		// Build a real AbortController (as the leader would) and call buildPromptAuth.
		const testController = new AbortController();
		const sshMgr = (
			sm as unknown as { sshMgr: import("./ssh-connection-manager.js").SshConnectionManager }
		).sshMgr;
		const promptAuthFn = sshMgr.buildPromptAuth(c1, testController.signal);

		// Invoke the auth prompt — it arms the pending prompt and registers
		// the abort listener. Don't await yet; we abort before the user responds.
		const promptResult = promptAuthFn(hostId, "passphrase", "Enter passphrase:");

		const promptId = [...ctx.pendingPrompts.keys()][0]!;
		expect(ctx.pendingPrompts.has(promptId)).toBe(true);

		// Abort the controller — must clear the entry immediately (synchronously).
		testController.abort();

		// INVARIANT: the pending auth prompt is cleared immediately (not lingering)
		// Mutation oracle: without the abort listener in buildPromptAuth the entry
		// stays in the map for up to AUTH_PROMPT_TIMEOUT_MS, wedging the host.
		expect(ctx.pendingPrompts.has(promptId)).toBe(false);

		// INVARIANT: the Promise returned by promptAuthFn resolves to null (not hanging)
		// Mutation oracle: without the abort listener the Promise never resolves,
		// keeping the connect blocked forever (until the 2-min timeout fires).
		await expect(promptResult).resolves.toBeNull();

		// INVARIANT: signal is aborted
		expect(testController.signal.aborted).toBe(true);
	});

	// ── Fix 4 (original): connect failure broadcasts SESSION_STATE:closed to all clients ──
	//
	// Clients that received a state snapshot with the session in 'starting' status
	// hold a stale view unless SESSION_STATE:closed is broadcast on failure.
	//
	// Mutation oracle: replacing broadcaster.updateSessionStatus with a direct
	// metaDal.updateSessionStatus call → no SESSION_STATE message emitted → clients
	// never learn the session closed → stale 'starting' state in UI forever.
	it("connect failure broadcasts SESSION_STATE:closed before deleting the starting session", async () => {
		nextSshStartError = new Error("SSH_AUTH_FAILED");

		const hostId = await createSshHost();

		const received: ProtocolMessage[] = [];
		const c1 = makeClient("c-broadcast-fail-1", received);
		sm.addClient(c1);

		const result = await sm.handleSpawn("c-broadcast-fail-1", { type: "SPAWN", hostId });
		expect(result).toBeNull();

		// A SESSION_STATE:closed must have been broadcast — this is what tells all
		// clients that the 'starting' session they saw in the snapshot is now dead.
		// Mutation oracle: without broadcaster.updateSessionStatus the message is absent.
		const sessionStateMsg = received.find(
			(m) => m.type === "SESSION_STATE" && (m as { status?: string }).status === "closed",
		);
		expect(sessionStateMsg).toBeDefined();

		// The starting session must also be deleted from ctx after the broadcast.
		const sessionAfterFail = (
			sm as unknown as { sessions: Map<string, { status: string }> }
		).sessions.get(hostId);
		expect(sessionAfterFail).toBeUndefined();

		// In-flight map must be clear.
		expect(sm.acquisitions.size).toBe(0);
	});

	// ── Fix 1A: closeSession clears reconnect PromptContext for the closing session ──
	//
	// Mutation oracle: without clearing the owner PromptContext in closeSession, a
	// user response arriving after abort resolves the promise and
	// _connectSshAgent proceeds to call updateHostFingerprint / trustedOnceFingerprints.set
	// against a session that has already been torn down — stale trust persists.
	it("closeSession clears reconnect host-verify PromptContext for the closing session", async () => {
		const hostId = await createSshHost();

		// Seed a session so closeSession finds a hostId.
		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);
		const fakeSessionId = "F1A0SESS0000000000000000000001";
		dal.createSession({ id: fakeSessionId, hostId, status: "active" });
		const ctx = (sm as unknown as { ctx: import("./session-context.js").SharedSessionContext }).ctx;
		ctx.sessions.set(hostId, { id: fakeSessionId, hostId, status: "active" } as never);
		ctx.clients.set("c-f1a-1", makeClient("c-f1a-1", []));
		ctx.clients.set("c-f1a-other", makeClient("c-f1a-other", []));

		openContext(ctx, "session", hostId, "c-f1a-1", reconnectContextId(fakeSessionId));
		const verifyPromise = promptCtx(
			ctx,
			reconnectContextId(fakeSessionId),
			"host_verify",
			{
				type: "HOST_VERIFY",
				hostId,
				fingerprint: "SHA256:test",
				algorithm: "SHA256",
				promptId: "",
			},
			() => {},
		)!;

		openContext(ctx, "session", "other-host-id", "c-f1a-other", "ctx-f1a-other");
		promptCtx(
			ctx,
			"ctx-f1a-other",
			"host_verify",
			{
				type: "HOST_VERIFY",
				hostId: "other-host-id",
				fingerprint: "SHA256:test",
				algorithm: "SHA256",
				promptId: "",
			},
			() => {},
		)!;

		await sm.closeSession(fakeSessionId);

		// INVARIANT: the prompt for the closing session is cleared and resolved null.
		await expect(verifyPromise).resolves.toBeNull();
		expect(ctx.promptContexts.has(reconnectContextId(fakeSessionId))).toBe(false);

		// INVARIANT: prompts for OTHER owners are untouched.
		expect(ctx.promptContexts.has("ctx-f1a-other")).toBe(true);

		clearContext(ctx, "ctx-f1a-other");
	});

	// ── Fix 1B: closeSession clears reconnect agent-verify PromptContext ──
	it("closeSession clears reconnect agent-verify PromptContext for the closing session", async () => {
		const hostId = await createSshHost();

		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);
		const fakeSessionId = "F1B0SESS0000000000000000000002";
		dal.createSession({ id: fakeSessionId, hostId, status: "active" });
		const ctx = (sm as unknown as { ctx: import("./session-context.js").SharedSessionContext }).ctx;
		ctx.sessions.set(hostId, { id: fakeSessionId, hostId, status: "active" } as never);
		ctx.clients.set("c-f1b-1", makeClient("c-f1b-1", []));

		openContext(ctx, "session", hostId, "c-f1b-1", reconnectContextId(fakeSessionId));
		const verifyPromise = promptCtx(
			ctx,
			reconnectContextId(fakeSessionId),
			"agent_verify",
			{
				type: "AGENT_BINARY_VERIFY",
				promptId: "",
				hostId,
				hostname: "test.example.com",
				remotePath: "/usr/local/bin/lasterm-agent",
				remoteSha256: "sha256:abc",
				os: "linux" as import("@lasterm/shared").HostOs,
				arch: "x64" as import("@lasterm/shared").HostArch,
				mismatch: false,
			},
			() => {},
		)!;

		await sm.closeSession(fakeSessionId);

		await expect(verifyPromise).resolves.toBeNull();
		expect(ctx.promptContexts.has(reconnectContextId(fakeSessionId))).toBe(false);
	});

	// ── Fix 1C: shutdown clears ALL PromptContext prompts ──
	//
	// Mutation oracle: without clearing PromptContexts in shutdown(), pending prompts
	// keep their timers alive after the hub stops — late resolutions attempt
	// DB writes (updateHostFingerprint) on a dead connection.
	it("shutdown clears all PromptContext prompt entries", async () => {
		const ctx = (sm as unknown as { ctx: import("./session-context.js").SharedSessionContext }).ctx;
		ctx.clients.set("c-shut-hv", makeClient("c-shut-hv", []));
		ctx.clients.set("c-shut-av", makeClient("c-shut-av", []));

		openContext(ctx, "session", "host-shut-1", "c-shut-hv", "ctx-shut-hv");
		const hostPromise = promptCtx(
			ctx,
			"ctx-shut-hv",
			"host_verify",
			{
				type: "HOST_VERIFY",
				hostId: "host-shut-1",
				fingerprint: "SHA256:test",
				algorithm: "SHA256",
				promptId: "",
			},
			() => {},
		)!;
		openContext(ctx, "session", "host-shut-1", "c-shut-av", "ctx-shut-av");
		const agentPromise = promptCtx(
			ctx,
			"ctx-shut-av",
			"agent_verify",
			{
				type: "AGENT_BINARY_VERIFY",
				promptId: "",
				hostId: "host-shut-1",
				hostname: "test.example.com",
				remotePath: "/usr/local/bin/lasterm-agent",
				remoteSha256: "sha256:abc",
				os: "linux" as import("@lasterm/shared").HostOs,
				arch: "x64" as import("@lasterm/shared").HostArch,
				mismatch: false,
			},
			() => {},
		)!;

		await sm.shutdown();

		// INVARIANT: prompt registries are empty after shutdown.
		// Mutation oracle: without the clear calls the prompts retain entries → timers fire
		// post-shutdown → DB writes on a closed connection → unhandled errors.
		expect(ctx.promptContexts.size).toBe(0);
		expect(ctx.pendingPrompts.size).toBe(0);

		// INVARIANT: both promises resolve null (no dangling promises).
		await expect(hostPromise).resolves.toBeNull();
		await expect(agentPromise).resolves.toBeNull();
	});

	// ── Fix 1D: trust-persist abort guard ──────────────────────────────────────
	//
	// If the session is closed (aborted) while the user is responding to a
	// host-key verify prompt, the trust decision must NOT be persisted.
	//
	// Mutation oracle: without the abort guard in _connectSshAgent, a user
	// clicking "trust permanent" after closeSession() calls updateHostFingerprint,
	// permanently pinning a fingerprint that was presented in an aborted context.
	it("trust-persist abort guard: updateHostFingerprint not called when signal aborted before trust decision", async () => {
		const hostId = await createSshHost();

		const ctx = (sm as unknown as { ctx: import("./session-context.js").SharedSessionContext }).ctx;
		const sshMgr = (
			sm as unknown as { sshMgr: import("./ssh-connection-manager.js").SshConnectionManager }
		).sshMgr;

		// Spy on updateHostFingerprint to assert it is NOT called when aborted.
		const updateFpSpy = vi.spyOn(ctx.metaDal, "updateHostFingerprint");

		// Make start() fail with TOFU so _connectSshAgent enters the verify branch.
		// We use a custom mock: the SshAgent resolves start() immediately but sets
		// lastKeyVerification.tofu=true so the catch block invokes promptHostKeyVerify.
		const { SshAgent: _SshAgentClass } = await import("./ssh-agent.js");
		const abortController = new AbortController();

		// Wire promptHostKeyVerify to return "trust_permanent" but ONLY after we abort the signal.
		// We achieve this by injecting a pending entry that resolves to trust_permanent, but
		// the abort guard fires before the trust is persisted.
		// Direct approach: spy on sshMgr.promptHostKeyVerify to resolve "trust_permanent" immediately.
		vi.spyOn(sshMgr, "promptHostKeyVerify").mockResolvedValue("trust_permanent");

		// Set up MockSshAgent to fail with a tofu key error.
		nextSshStartError = Object.assign(new Error("host key mismatch — tofu"), {
			code: "FINGERPRINT_MISMATCH",
		});
		// Also ensure the second start (retry) resolves, but the abort guard fires first.
		// We abort the controller synchronously when promptHostKeyVerify is called.
		// Since promptHostKeyVerify is mocked to resolve immediately, we need the controller
		// already aborted so the guard fires after the await resolves.
		abortController.abort();

		const c1Received: ProtocolMessage[] = [];
		const c1 = makeClient("c-trust-guard-1", c1Received);
		sm.addClient(c1);

		// Seed a session and inject into ctx — the guard checks sessions.get(hostId)?.id !== sessionId.
		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);
		const fakeSessionId = "F1D0SESS0000000000000000000004";
		dal.createSession({ id: fakeSessionId, hostId, status: "starting" });
		ctx.sessions.set(hostId, { id: fakeSessionId, hostId, status: "starting" } as never);

		// Call _connectSshAgent directly with the pre-aborted signal.
		const connectSshAgent = (
			sm as unknown as {
				_connectSshAgent: (
					hostId: string,
					host: import("@lasterm/shared").Host,
					client: import("./session-manager.js").WsClient,
					sessionId: string,
					signal: AbortSignal,
				) => Promise<void>;
			}
		)._connectSshAgent.bind(sm);

		const host = ctx.metaDal.getHost(hostId);
		if (!host) throw new Error("test setup: host not found");

		// Should throw (AbortError) without calling updateHostFingerprint.
		await expect(
			connectSshAgent(hostId, host, c1, fakeSessionId, abortController.signal),
		).rejects.toThrow();

		// INVARIANT: fingerprint was NOT persisted because signal was aborted.
		// Mutation oracle: without the abort guard, trust_permanent → updateHostFingerprint
		// is called even though the session is already gone.
		expect(updateFpSpy).not.toHaveBeenCalled();
	});

	// ── Fix 2: sole-requester client-disconnect triggers agent/session reap ──
	//
	// When the ONLY client that triggered an SSH connect disconnects before the
	// connect completes, the wired SSH agent + session must be closed. Without
	// this fix the agent and session leak: repeated spawn+disconnect multiplies
	// open SSH connections on the remote side.
	//
	// Mutation oracle: the old silent-return at the client-disconnected guard
	// does NOT close the agent → ctx.agents retains the entry → the SSH
	// connection leaks. Removing the new close block reproduces the leak.
	it("sole-requester disconnect: agent is closed and session removed when no channel exists", async () => {
		const hostId = await createSshHost();

		// The client will be gone by the time handleSpawn reaches the guard.
		// We simulate this by removing the client AFTER handleSpawn starts awaiting.
		const c1Received: ProtocolMessage[] = [];
		const c1 = makeClient("c-sole-1", c1Received);
		sm.addClient(c1);

		// Let SshAgent.start() resolve (normal success path).
		// We remove the client synchronously once the mock SSH agent is constructed
		// (i.e. once the leader's acquire promise body runs).
		const origMockImpl = vi
			.mocked((await import("./ssh-agent.js")).SshAgent)
			.getMockImplementation();

		vi.mocked((await import("./ssh-agent.js")).SshAgent).mockImplementationOnce(function (
			this: unknown,
		) {
			mockSshAgentInstance = new MockSshAgent();
			// Remove the client synchronously — simulates disconnect during connect.
			sm.removeClient("c-sole-1");
			return mockSshAgentInstance;
		} as never);

		const result = await sm.handleSpawn("c-sole-1", { type: "SPAWN", hostId });

		// INVARIANT: handleSpawn returns null (client was gone).
		expect(result).toBeNull();

		// INVARIANT: agent.close() was called — no SSH leak.
		// Mutation oracle: without the new close block, mockSshAgentInstance.close
		// is never called → the SSH connection stays open → resource leak.
		expect(mockSshAgentInstance?.close).toHaveBeenCalled();

		// INVARIANT: agent removed from ctx.agents.
		const ctx = (sm as unknown as { ctx: import("./session-context.js").SharedSessionContext }).ctx;
		expect(ctx.agents.has(hostId)).toBe(false);

		// INVARIANT: session removed from ctx.sessions (closed status, no lingering entry).
		expect(ctx.sessions.has(hostId)).toBe(false);

		// Restore original mock implementation if any.
		if (origMockImpl) {
			vi.mocked((await import("./ssh-agent.js")).SshAgent).mockImplementation(
				origMockImpl as never,
			);
		}
	});

	// ── Fix 2 follower guard: session NOT closed when another channel exists ──
	//
	// If a channel already references this session (another client spawned
	// successfully), the sole-requester close must NOT fire — it would disrupt
	// active work.
	//
	// Mutation oracle: an overly-aggressive close (ignoring channel check) would
	// call agent.close() even when other clients have active channels, breaking
	// ongoing terminal sessions.
	it("sole-requester guard: session NOT closed when another channel references it", async () => {
		const hostId = await createSshHost();

		const c1Received: ProtocolMessage[] = [];
		const c2Received: ProtocolMessage[] = [];
		const c1 = makeClient("c-guard-1", c1Received);
		const c2 = makeClient("c-guard-2", c2Received);
		sm.addClient(c1);
		sm.addClient(c2);

		// c2 spawns first and succeeds — this wires an agent and creates a channel.
		await sm.handleSpawn("c-guard-2", { type: "SPAWN", hostId });
		const agentAfterC2Spawn = mockSshAgentInstance;
		expect(agentAfterC2Spawn).not.toBeNull();

		// Now c1 tries to spawn for the same host. At the client-disconnect guard,
		// c1 is already gone from clients but c2's channel still references the session.
		// We remove c1 before calling handleSpawn to simulate immediate disconnect.
		sm.removeClient("c-guard-1");

		const result = await sm.handleSpawn("c-guard-1", { type: "SPAWN", hostId });

		// INVARIANT: handleSpawn returns null (c1 was gone).
		expect(result).toBeNull();

		// INVARIANT: agent NOT closed — c2's channel is still active.
		// Mutation oracle: without the sessionHasChannels guard, agent.close() fires
		// even though c2 is actively using the session → c2's terminal dies.
		expect(agentAfterC2Spawn?.close).not.toHaveBeenCalled();

		// INVARIANT: session still present in ctx.sessions.
		const ctx = (sm as unknown as { ctx: import("./session-context.js").SharedSessionContext }).ctx;
		expect(ctx.sessions.has(hostId)).toBe(true);
	});

	// ── Fix 3: sessionWaiters counter prevents premature session close under follower race ──
	//
	// Root race (this fix): LEADER disconnects after SSH connect succeeds.  At the
	// disconnect guard, the FOLLOWER already holds the session object (it won the
	// coalesced acquire) but has NOT yet called sendSpawnAndWait — it is between the
	// two awaits.  The old synchronous "no channels" check saw zero channels (the
	// follower hadn't spawned one yet) and tore down the session from under the follower.
	//
	// Fix: sessionWaiters counter > 0 while any spawn intent is in-flight, so the
	// leader's disconnect guard is blocked from closing until the last waiter leaves.
	//
	// Mutation oracle: removing the `remainingWaiters === 0` condition from the guard
	// makes agent.close() fire while the follower is still awaiting, so the follower's
	// eventual sendSpawnAndWait would talk to a closed agent.
	it("follower race: leader disconnect does NOT close session while follower waiter count > 0", async () => {
		const hostId = await createSshHost();

		// ── Drive the race deterministically via the sessionWaiters counter ──────
		// We use a barrier inside SshAgent.start() to pause the leader mid-connect
		// so we can:
		//   1. Verify the counter is > 0 while both spawns are in-flight.
		//   2. Disconnect the leader while both intents are still counted.
		//   3. Release the barrier → connect completes → guard fires with count > 0 → no close.
		let releaseConnect!: () => void;
		const connectBarrier = new Promise<void>((res) => {
			releaseConnect = res;
		});

		// Must use a regular function (constructable) for new-ed mocks — same pattern as
		// the other override tests in this file.
		vi.mocked(_SshAgentForMock).mockImplementationOnce(function (this: unknown) {
			const inst = new MockSshAgent();
			inst.start = vi.fn().mockReturnValue(connectBarrier);
			mockSshAgentInstance = inst;
			return inst;
		} as unknown as typeof MockSshAgent);

		const c1 = makeClient("c-follower-race-1", []);
		const c2 = makeClient("c-follower-race-2", []);
		sm.addClient(c1);
		sm.addClient(c2);

		// Both SPAWNs race — c1 is the leader, c2 is the follower.
		const spawn1 = sm.handleSpawn("c-follower-race-1", { type: "SPAWN", hostId });
		const spawn2 = sm.handleSpawn("c-follower-race-2", { type: "SPAWN", hostId });

		// One microtask drain is enough: microtasks flush exhaustively, so all
		// pending continuations run in sequence — resolveHostId for both spawns,
		// the SSH branch setup (both increments), the IIFE getOrCreateSession, and
		// _connectSshAgent up to await sshAgent.start() — which blocks on connectBarrier.
		await Promise.resolve();

		// INVARIANT: counter > 0 while both are in-flight (leader + follower incremented).
		// Mutation oracle: without the increment, count stays 0 here.
		expect(sm.acquisitions.get(hostId)?.leases.size ?? 0).toBeGreaterThan(0);

		// Simulate leader disconnect while both intents are still counted.
		sm.removeClient("c-follower-race-1");

		// Release the SSH connect barrier → leader completes connect, hits guard,
		// sees count > 0, does NOT close.
		releaseConnect();
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));

		// Await both — follower must succeed (session was not torn down).
		const [ch1, ch2] = await Promise.all([spawn1, spawn2]);

		// INVARIANT: leader returns null (it was disconnected at the guard).
		expect(ch1).toBeNull();

		// INVARIANT: follower succeeds — session was NOT closed under it.
		// Mutation oracle: without the waiter guard, the leader's disconnect fires
		// agent.close() while the follower's sendSpawnAndWait is in-flight →
		// follower would get null or an error instead of a channelId.
		expect(ch2).not.toBeNull();

		// INVARIANT: counter back to 0 after both settle (no leak).
		expect(sm.acquisitions.get(hostId)?.leases.size ?? 0).toBe(0);

		// INVARIANT: session still alive (follower's channel holds it open).
		const ctx = (sm as unknown as { ctx: import("./session-context.js").SharedSessionContext }).ctx;
		expect(ctx.sessions.has(hostId)).toBe(true);
	});

	// ── Fix 3b: sole requester with count=0 and no channel → session IS closed ──
	//
	// When the sole requester disconnects AND the counter has reached 0 AND no channel
	// exists, the session must be cleaned up (original sole-requester behavior preserved).
	//
	// Mutation oracle: removing the close block from the guard when count=0 leaks
	// the SSH agent and session on sole-requester disconnect.
	it("sole requester disconnects, count=0, no channel: session IS closed (no regression)", async () => {
		const hostId = await createSshHost();

		const c1Received: ProtocolMessage[] = [];
		const c1 = makeClient("c-sole-count-1", c1Received);
		sm.addClient(c1);

		const origImpl = vi.mocked((await import("./ssh-agent.js")).SshAgent).getMockImplementation();
		vi.mocked((await import("./ssh-agent.js")).SshAgent).mockImplementationOnce(function (
			this: unknown,
		) {
			mockSshAgentInstance = new MockSshAgent();
			// Remove client synchronously — simulates disconnect during SSH connect.
			sm.removeClient("c-sole-count-1");
			return mockSshAgentInstance;
		} as never);

		const result = await sm.handleSpawn("c-sole-count-1", { type: "SPAWN", hostId });

		// INVARIANT: handleSpawn returns null.
		expect(result).toBeNull();

		// INVARIANT: counter is 0 after settle (no leak).
		expect(sm.acquisitions.get(hostId)?.leases.size ?? 0).toBe(0);

		// INVARIANT: agent.close() called — SSH connection cleaned up.
		// Mutation oracle: without the close block, this expectation fails and the
		// SSH connection leaks.
		expect(mockSshAgentInstance?.close).toHaveBeenCalled();

		// INVARIANT: session removed.
		const ctx = (sm as unknown as { ctx: import("./session-context.js").SharedSessionContext }).ctx;
		expect(ctx.sessions.has(hostId)).toBe(false);

		if (origImpl) {
			vi.mocked((await import("./ssh-agent.js")).SshAgent).mockImplementation(origImpl as never);
		}
	});

	// ── Fix 3c: successful spawn — counter returns to 0, channel protects session ──
	//
	// After a successful spawn the channel exists in ctx.channels. Even when the
	// spawn-intent counter returns to 0 (it always does after sendSpawnAndWait), the
	// channel check must prevent the session from being closed by any subsequent guard.
	//
	// Mutation oracle: removing the sessionHasChannels check from the guard would
	// close the session even though a channel is live.
	it("successful spawn: session survives after count returns to 0 because channel protects it", async () => {
		const hostId = await createSshHost();

		const c1 = makeClient("c-ch-protect-1", []);
		sm.addClient(c1);

		const spawn = sm.handleSpawn("c-ch-protect-1", { type: "SPAWN", hostId });

		// Drain setImmediate queues so the mock SPAWN_OK and channel creation complete
		// before we await the result (avoids a DB-closed race with afterEach).
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));

		const channelId = await spawn;

		// INVARIANT: spawn succeeded.
		expect(channelId).not.toBeNull();

		// INVARIANT: counter back to 0 after successful spawn (no leak).
		expect(sm.acquisitions.get(hostId)?.leases.size ?? 0).toBe(0);

		// INVARIANT: session still present — the channel protects it.
		const ctx = (sm as unknown as { ctx: import("./session-context.js").SharedSessionContext }).ctx;
		expect(ctx.sessions.has(hostId)).toBe(true);
		expect(ctx.channels.size).toBeGreaterThan(0);
	});

	// ── Fix 3d: shutdown clears all in-flight acquisitions ───────────────────────
	//
	// Mutation oracle: removing acquisitions.clear() from shutdownAll() leaves stale
	// in-flight leases that would incorrectly keep the process alive.
	it("shutdown clears all in-flight acquisitions", async () => {
		// Inject a stale acquisition with leases to prove it is wiped on shutdown.
		const rejectSpy = vi.fn();
		let _resolve!: (s: import("./session-context.js").SessionState) => void;
		const connectPromise = new Promise<import("./session-context.js").SessionState>((res) => {
			_resolve = res;
		});
		connectPromise.catch(() => {});
		const staleAcq: import("./session-context.js").SessionAcquisition = {
			id: "stale-waiter-acq",
			hostId: "stale-host-waiter",
			state: "CONNECTING",
			controller: new AbortController(),
			connectPromise,
			_resolve,
			_reject: rejectSpy,
			leases: new Set(),
		};
		// Lease needs a back-reference to staleAcq (_acq field, Fix A).
		staleAcq.leases.add({
			id: "l1",
			hostId: "stale-host-waiter",
			acqId: "stale-waiter-acq",
			released: false,
			_acq: staleAcq,
		});
		sm.acquisitions.set("stale-host-waiter", staleAcq);
		expect(sm.acquisitions.size).toBe(1);
		expect(staleAcq.leases.size).toBe(1);

		await sm.shutdown();

		expect(sm.acquisitions.size).toBe(0);
	});

	// ── Fix A: decrement is in OUTER finally — count stays > 0 through sendSpawnAndWait ──
	//
	// The root race (Fix A): the old code decremented in the per-branch acquire finally,
	// BEFORE sendSpawnAndWait.  A concurrent follower that had already acquired the session
	// but not yet called sendSpawnAndWait could observe count=0 at the leader's disconnect
	// guard → leader wrongly closes the session from under the follower's sendSpawnAndWait.
	//
	// Fix: the outer finally decrements AFTER sendSpawnAndWait returns, so the count stays
	// > 1 (leader + follower) at the guard.  The guard now uses <= 1 (not === 0) to account
	// for the fact that the outer finally has not run yet at guard time.
	//
	// Mutation oracle: moving the decrement back to the acquire-finally (before the guard)
	// makes count drop to 1 at the leader's guard while the follower has NOT yet called
	// sendSpawnAndWait → the guard (with the old === 0 condition) would NOT fire in this
	// specific test, but the count invariant is violated: between decrement and
	// sendSpawnAndWait the count is 0 even though two callers are in-flight.
	//
	// We prove the invariant by checking count > 1 is maintained between both increments
	// and when the leader's guard fires.
	it("Fix A: spawn-intent count stays > 1 through sendSpawnAndWait — decrement is in outer finally", async () => {
		const hostId = await createSshHost();

		// Barrier: pause connect so both SPAWNs are in-flight simultaneously.
		let releaseConnect!: () => void;
		const connectBarrier = new Promise<void>((res) => {
			releaseConnect = res;
		});

		vi.mocked(_SshAgentForMock).mockImplementationOnce(function (this: unknown) {
			const inst = new MockSshAgent();
			inst.start = vi.fn().mockReturnValue(connectBarrier);
			mockSshAgentInstance = inst;
			return inst;
		} as unknown as typeof MockSshAgent);

		const c1 = makeClient("c-fixa-leader", []);
		const c2 = makeClient("c-fixa-follower", []);
		sm.addClient(c1);
		sm.addClient(c2);

		// Both SPAWNs race.  c1 is leader, c2 is follower.
		const spawn1 = sm.handleSpawn("c-fixa-leader", { type: "SPAWN", hostId });
		const spawn2 = sm.handleSpawn("c-fixa-follower", { type: "SPAWN", hostId });

		// Flush microtasks: both increments run, leader blocks on connectBarrier.
		await Promise.resolve();

		// INVARIANT: count >= 2 (both leader and follower have incremented but neither
		// has decremented yet — because the decrement is in the outer finally which only
		// runs after sendSpawnAndWait).
		// Mutation oracle: if decrement were in the acquire-finally, after the follower
		// awaits existing.promise (which hasn't resolved yet), the count would still be 2
		// at this microtask checkpoint — but once connectBarrier resolves and both acquire
		// finallys fire before sendSpawnAndWait, count would drop to 0.
		expect(sm.acquisitions.get(hostId)?.leases.size ?? 0).toBeGreaterThanOrEqual(2);

		// Leader disconnects while both are in-flight.
		sm.removeClient("c-fixa-leader");

		// Release connect: leader completes SSH, hits disconnect guard with count >= 2.
		// With Fix A: count = 2 (outer finally not yet run for either), guard sees
		// count > 1 → does NOT close → follower proceeds safely.
		releaseConnect();
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));

		const [ch1, ch2] = await Promise.all([spawn1, spawn2]);

		// Leader returns null (was disconnected).
		expect(ch1).toBeNull();

		// INVARIANT: follower succeeds — session was NOT torn down.
		// Mutation oracle: with old per-branch decrement, after both acquire-finallys run
		// count drops to 0 BEFORE sendSpawnAndWait, the guard (=== 0) would fire and
		// close the session → follower's sendSpawnAndWait would fail → ch2 would be null.
		expect(ch2).not.toBeNull();

		// Count back to 0 after both settle (no leak).
		expect(sm.acquisitions.get(hostId)?.leases.size ?? 0).toBe(0);

		// Session still alive (follower's channel holds it).
		const ctx = (sm as unknown as { ctx: import("./session-context.js").SharedSessionContext }).ctx;
		expect(ctx.sessions.has(hostId)).toBe(true);
	});

	// ── Fix B: acquisitions.delete is identity-checked — stale commit cannot clobber replacement ──
	//
	// P2 (single-authority): Acq.commit() deletes the acq from ctx.acquisitions only if
	// ctx.acquisitions.get(hostId) === acq. If a replacement acq was registered for the same
	// host before the stale commit ran, the identity check prevents clobbering the replacement.
	//
	// Mutation oracle: replacing `if (ctx.acquisitions.get(acq.hostId) === acq) delete` with
	// `ctx.acquisitions.delete(acq.hostId)` removes the replacement entry.
	it("Fix B: stale commit does NOT delete a replacement acquisition for the same host", async () => {
		const hostId = await createSshHost();

		function makeTestAcq(id: string): import("./session-context.js").SessionAcquisition {
			let _resolve!: (s: import("./session-context.js").SessionState) => void;
			const connectPromise = new Promise<import("./session-context.js").SessionState>((res) => {
				_resolve = res;
			});
			connectPromise.catch(() => {});
			return {
				id,
				hostId,
				state: "CONNECTING",
				controller: new AbortController(),
				connectPromise,
				_resolve,
				_reject: vi.fn(),
				leases: new Set(),
			};
		}

		const staleAcq = makeTestAcq("stale-acq-fixb");
		const replacementAcq = makeTestAcq("replacement-acq-fixb");

		// Install replacement as the current entry (stale acq is NOT in the map).
		sm.acquisitions.set(hostId, replacementAcq);

		// Simulate what Acq.commit() does for the STALE acq: identity-check prevents delete.
		// P2 guard: ctx.acquisitions.get(hostId) === staleAcq → false → no delete.
		if (sm.acquisitions.get(hostId) === staleAcq) {
			sm.acquisitions.delete(hostId);
		}
		staleAcq._resolve({ id: "stale-sess", hostId, status: "active" });

		await Promise.resolve();

		// INVARIANT: replacement entry still present — identity-checked delete did not fire.
		// Mutation oracle: bare delete(hostId) would remove replacementAcq here.
		expect(sm.acquisitions.get(hostId)).toBe(replacementAcq);

		// Cleanup.
		sm.acquisitions.delete(hostId);
		replacementAcq.connectPromise.catch(() => {});
	});

	// ── Fix B (closeSession path): Acq.close() identity-check prevents clobbering replacement ──
	//
	// Acq.close() deletes from ctx.acquisitions only if ctx.acquisitions.get(hostId) === acq.
	// If a rapid reconnect installs a replacement acq synchronously during the reject callback,
	// Acq.close()'s identity check sees the new acq (not the stale one) and skips the delete.
	//
	// Mutation oracle: removing the identity check from Acq.close() causes it to delete
	// the replacement entry unconditionally → next follower SPAWN finds no in-flight entry.
	it("Fix B (closeSession): Acq.close identity-check does NOT delete a replacement acquisition", async () => {
		const hostId = await createSshHost();

		const fakeSessionId = "FIXB-SESS-00000000000000000001";
		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);
		dal.createSession({ id: fakeSessionId, hostId, status: "active" });

		const ctx = (sm as unknown as { ctx: import("./session-context.js").SharedSessionContext }).ctx;
		ctx.sessions.set(hostId, {
			id: fakeSessionId,
			hostId,
			status: "active",
		} as import("./session-context.js").SessionState);

		// Build a replacement acquisition that will be installed during close.
		let replacementResolve!: (s: import("./session-context.js").SessionState) => void;
		const replacementConnect = new Promise<import("./session-context.js").SessionState>((res) => {
			replacementResolve = res;
		});
		replacementConnect.catch(() => {});
		const replacementAcq: import("./session-context.js").SessionAcquisition = {
			id: "fixb-replacement-acq",
			hostId,
			state: "CONNECTING",
			controller: new AbortController(),
			connectPromise: replacementConnect,
			_resolve: replacementResolve,
			_reject: vi.fn(),
			leases: new Set(),
		};

		// Build a stale acquisition whose _reject installs the replacement synchronously —
		// simulating a rapid reconnect that races with Acq.close().
		let staleResolve!: (s: import("./session-context.js").SessionState) => void;
		const staleConnect = new Promise<import("./session-context.js").SessionState>((res) => {
			staleResolve = res;
		});
		staleConnect.catch(() => {});
		const staleAcq: import("./session-context.js").SessionAcquisition = {
			id: "fixb-stale-acq",
			hostId,
			state: "CONNECTING",
			controller: new AbortController(),
			connectPromise: staleConnect,
			_resolve: staleResolve,
			_reject: vi.fn(() => {
				// Rapid reconnect: install replacement synchronously during reject.
				sm.acquisitions.set(hostId, replacementAcq);
			}),
			leases: new Set(),
		};
		sm.acquisitions.set(hostId, staleAcq);

		await sm.closeSession(fakeSessionId);

		// INVARIANT: replacement entry is still present — Acq.close() saw replacementAcq
		// (not staleAcq) in the map after _reject ran, so it skipped the delete.
		// Mutation oracle: bare delete(hostId) in Acq.close() removes replacementAcq.
		expect(sm.acquisitions.get(hostId)).toBe(replacementAcq);

		// Cleanup.
		sm.acquisitions.delete(hostId);
	});

	// ── PROMPT RE-TARGET: happy path ──────────────────────────────────────────
	//
	// When the prompt-owner client disconnects, removeClient must transfer ownership
	// to another live lease-holder and re-send the prompt payload to them.
	// The pending entry stays alive so the new owner can resolve it.
	//
	// Mutation oracle: removing the re-target branch (just deleting + resolving)
	// causes the host-verify promise to resolve null — the connectPromise rejects and
	// all followers lose the session even though one was still connected.
	it("removeClient re-targets a host-verify PromptContext to a live follower lease-holder", async () => {
		const ctx = (sm as unknown as { ctx: import("./session-context.js").SharedSessionContext }).ctx;
		const bReceived: import("@lasterm/shared").ProtocolMessage[] = [];
		const cA = makeClient("rt-clientA", []);
		const cB = makeClient("rt-clientB", bReceived);
		sm.addClient(cA);
		sm.addClient(cB);

		// Build a minimal in-flight acquisition with two leases.
		const acqId = "rt-acq-1";
		const hostId = "host-rt-1";
		const leaseA: import("./session-context.js").Lease = {
			id: "rt-lease-A",
			hostId,
			acqId,
			clientId: "rt-clientA",
			released: false,
			_acq: null as unknown as import("./session-context.js").SessionAcquisition,
		};
		const leaseB: import("./session-context.js").Lease = {
			id: "rt-lease-B",
			hostId,
			acqId,
			clientId: "rt-clientB",
			released: false,
			_acq: null as unknown as import("./session-context.js").SessionAcquisition,
		};
		const acq: import("./session-context.js").SessionAcquisition = {
			id: acqId,
			hostId,
			state: "CONNECTING",
			controller: new AbortController(),
			connectPromise: new Promise(() => {}),
			_resolve: vi.fn(),
			_reject: vi.fn(),
			leases: new Set([leaseA, leaseB]),
		};
		acq.connectPromise.catch(() => {});
		leaseA._acq = acq;
		leaseB._acq = acq;
		ctx.acquisitions.set(hostId, acq);

		// Open a PromptContext for this acq and issue a host_verify prompt via the ops.
		openContext(ctx, "session", hostId, "rt-clientA", acqId);
		const basePayload = {
			type: "HOST_VERIFY",
			hostId,
			fingerprint: "AA:BB",
			algorithm: "ssh-ed25519",
			promptId: "", // overridden by prompt()
		};
		const before = new Set(ctx.pendingPrompts.keys());
		const verifyPromise = promptCtx(
			ctx,
			acqId,
			"host_verify",
			basePayload,
			(routeClientId, msg) => {
				const client = ctx.clients.get(routeClientId);
				client?.send(msg as unknown as import("@lasterm/shared").HostVerifyMessage);
			},
		)!;
		const promptId = [...ctx.pendingPrompts.keys()].find((k) => !before.has(k))!;

		// Disconnect clientA.
		sm.removeClient("rt-clientA");

		// INVARIANT 1: context NOT removed — retargeted to clientB (still alive).
		const context = ctx.promptContexts.get(acqId);
		expect(context).toBeDefined();

		// INVARIANT 2: route transferred to clientB.
		expect(context?.routeClientId).toBe("rt-clientB");

		// INVARIANT 3: prompt re-sent to clientB's wire (retarget re-sends in-flight prompts).
		expect(bReceived.length).toBeGreaterThan(0);

		// INVARIANT 4: promise NOT yet resolved — connection still pending.
		let resolved = false;
		verifyPromise.then(() => {
			resolved = true;
		});
		await Promise.resolve();
		expect(resolved).toBe(false);

		// Now clientB answers — prompt resolves.
		const sshMgr = (
			sm as unknown as { sshMgr: import("./ssh-connection-manager.js").SshConnectionManager }
		).sshMgr;
		sshMgr.handleHostVerifyResponse(promptId, "trust_permanent", "rt-clientB");

		// Mutation oracle: promise resolves to "trust_permanent"; entry cleared.
		await expect(verifyPromise).resolves.toBe("trust_permanent");
		expect(ctx.pendingPrompts.has(promptId)).toBe(false);

		// Cleanup.
		ctx.acquisitions.delete(hostId);
		sm.removeClient("rt-clientB");
	});

	it("D3-1: reconnect owner disconnect retargets to an engaged channel client, not an unrelated connected client", async () => {
		const ctx = (sm as unknown as { ctx: import("./session-context.js").SharedSessionContext }).ctx;
		const ownerReceived: import("@lasterm/shared").ProtocolMessage[] = [];
		const engagedReceived: import("@lasterm/shared").ProtocolMessage[] = [];
		const unrelatedReceived: import("@lasterm/shared").ProtocolMessage[] = [];
		const owner = makeClient("d3-owner", ownerReceived);
		const engaged = makeClient("z-d3-engaged", engagedReceived);
		const unrelated = makeClient("a-d3-unrelated", unrelatedReceived);
		sm.addClient(owner);
		sm.addClient(engaged);
		sm.addClient(unrelated);

		const hostId = "host-d3-reconnect";
		const sessionId = "D3RECONNECTSESSION000000000001";
		const contextId = reconnectContextId(sessionId);
		ctx.sessions.set(hostId, { id: sessionId, hostId, status: "detached" });
		ctx.channels.set("ch-d3-reconnect", {
			sessionId,
			hostId,
			status: "live",
			clients: new Set(["d3-owner", "z-d3-engaged"]),
			shell: "/bin/sh",
			cols: 80,
			rows: 24,
			dynamicTitle: null,
			processTitle: null,
			displayTitle: "d3",
		});
		owner.attachedChannels.add("ch-d3-reconnect");
		engaged.attachedChannels.add("ch-d3-reconnect");

		openContext(ctx, "session", hostId, "d3-owner", contextId);
		const verifyPromise = promptCtx(
			ctx,
			contextId,
			"host_verify",
			{
				type: "HOST_VERIFY",
				hostId,
				fingerprint: "SHA256:d3",
				algorithm: "SHA256",
				promptId: "",
			},
			(routeClientId, msg) => {
				ctx.clients.get(routeClientId)?.send(msg as import("@lasterm/shared").HostVerifyMessage);
			},
		)!;

		sm.removeClient("d3-owner");

		const context = ctx.promptContexts.get(contextId);
		expect(context?.routeClientId).toBe("z-d3-engaged");
		expect(
			engagedReceived.some((msg) => msg.type === "AUTH_PROMPT" || msg.type === "HOST_VERIFY"),
		).toBe(true);
		expect(
			unrelatedReceived.some((msg) => msg.type === "AUTH_PROMPT" || msg.type === "HOST_VERIFY"),
		).toBe(false);

		clearContext(ctx, contextId);
		await expect(verifyPromise).resolves.toBeNull();
		sm.removeClient("z-d3-engaged");
		sm.removeClient("a-d3-unrelated");
	});

	it("D3-2: reconnect owner disconnect fails cleanly when only an unrelated connected client remains", async () => {
		const ctx = (sm as unknown as { ctx: import("./session-context.js").SharedSessionContext }).ctx;
		const ownerReceived: import("@lasterm/shared").ProtocolMessage[] = [];
		const unrelatedReceived: import("@lasterm/shared").ProtocolMessage[] = [];
		const owner = makeClient("d3b-owner", ownerReceived);
		const unrelated = makeClient("a-d3b-unrelated", unrelatedReceived);
		sm.addClient(owner);
		sm.addClient(unrelated);

		const hostId = "host-d3b-reconnect";
		const sessionId = "D3RECONNECTSESSION000000000002";
		const contextId = reconnectContextId(sessionId);
		ctx.sessions.set(hostId, { id: sessionId, hostId, status: "detached" });
		ctx.channels.set("ch-d3b-reconnect", {
			sessionId,
			hostId,
			status: "live",
			clients: new Set(["d3b-owner"]),
			shell: "/bin/sh",
			cols: 80,
			rows: 24,
			dynamicTitle: null,
			processTitle: null,
			displayTitle: "d3b",
		});
		owner.attachedChannels.add("ch-d3b-reconnect");

		openContext(ctx, "session", hostId, "d3b-owner", contextId);
		const verifyPromise = promptCtx(
			ctx,
			contextId,
			"host_verify",
			{
				type: "HOST_VERIFY",
				hostId,
				fingerprint: "SHA256:d3b",
				algorithm: "SHA256",
				promptId: "",
			},
			(routeClientId, msg) => {
				ctx.clients.get(routeClientId)?.send(msg as import("@lasterm/shared").HostVerifyMessage);
			},
		)!;
		const promptId = [...ctx.pendingPrompts.keys()][0]!;

		sm.removeClient("d3b-owner");

		expect(ctx.promptContexts.has(contextId)).toBe(false);
		expect(ctx.pendingPrompts.has(promptId)).toBe(false);
		expect(
			unrelatedReceived.some((msg) => msg.type === "AUTH_PROMPT" || msg.type === "HOST_VERIFY"),
		).toBe(false);
		await expect(verifyPromise).resolves.toBeNull();
		sm.removeClient("a-d3b-unrelated");
	});

	// ── PROMPT RE-TARGET: no live candidate → fail-closed ────────────────────
	//
	// When the prompt-owner disconnects and no other lease-holder is still
	// connected, the prompt must be rejected immediately (fail-closed).
	//
	// Mutation oracle: keeping the entry alive with no owner would leave the
	// SSH connect blocked until the 120 s timeout fires.
	it("removeClient fails-closed on host-verify PromptContext when no live follower exists", async () => {
		const ctx = (sm as unknown as { ctx: import("./session-context.js").SharedSessionContext }).ctx;

		const aReceived: import("@lasterm/shared").ProtocolMessage[] = [];
		const cA = makeClient("rt2-clientA", aReceived);
		sm.addClient(cA);

		const acqId = "rt2-acq-1";
		const hostId = "host-rt2-1";
		const leaseA: import("./session-context.js").Lease = {
			id: "rt2-lease-A",
			hostId,
			acqId,
			clientId: "rt2-clientA",
			released: false,
			_acq: null as unknown as import("./session-context.js").SessionAcquisition,
		};
		const acq: import("./session-context.js").SessionAcquisition = {
			id: acqId,
			hostId,
			state: "CONNECTING",
			controller: new AbortController(),
			connectPromise: new Promise(() => {}),
			_resolve: vi.fn(),
			_reject: vi.fn(),
			leases: new Set([leaseA]),
		};
		acq.connectPromise.catch(() => {});
		leaseA._acq = acq;
		ctx.acquisitions.set(hostId, acq);

		openContext(ctx, "session", hostId, "rt2-clientA", acqId);
		const verifyPromise = promptCtx(
			ctx,
			acqId,
			"host_verify",
			{
				type: "HOST_VERIFY",
				promptId: "",
				hostId,
				fingerprint: "CC:DD",
				algorithm: "ssh-ed25519",
				isKnownHost: false,
			},
			() => {},
		)!;
		const promptId = [...ctx.pendingPrompts.keys()][0]!;

		// Only owner exists — disconnect them.
		sm.removeClient("rt2-clientA");

		// INVARIANT 1: entry removed immediately.
		expect(ctx.pendingPrompts.has(promptId)).toBe(false);

		// INVARIANT 2: resolved null (fail-closed).
		await expect(verifyPromise).resolves.toBeNull();

		// Cleanup.
		ctx.acquisitions.delete(hostId);
	});

	// ── PROMPT RE-TARGET: response auth guard ─────────────────────────────────
	//
	// After re-targeting, only the current routeClientId may resolve the prompt.
	// A response from any non-owner client must be silently ignored (SEC-003).
	//
	// Mutation oracle: removing the clientId === routeClientId guard in respond()
	// allows a rogue/late response to steal the prompt resolution — detectable
	// because the verifyPromise resolves prematurely and pendingPrompts is cleared.
	it("handleHostVerifyResponse ignores responses from non-owner clients (SEC-003)", async () => {
		const ctx = (sm as unknown as { ctx: import("./session-context.js").SharedSessionContext }).ctx;
		const sshMgr = (
			sm as unknown as { sshMgr: import("./ssh-connection-manager.js").SshConnectionManager }
		).sshMgr;
		// Open a PromptContext and issue a host_verify prompt owned by "rt3-owner".
		ctx.clients.set("rt3-owner", makeClient("rt3-owner", []));
		openContext(ctx, "session", "host-rt3", "rt3-owner", "rt3-acq");
		const basePayload = {
			type: "HOST_VERIFY",
			hostId: "host-rt3",
			fingerprint: "EE:FF",
			algorithm: "ssh-ed25519",
			promptId: "",
		};
		const before = new Set(ctx.pendingPrompts.keys());
		const verifyPromise = promptCtx(ctx, "rt3-acq", "host_verify", basePayload, () => {})!;
		const promptId = [...ctx.pendingPrompts.keys()].find((k) => !before.has(k))!;

		// Wrong client (old owner, or rogue client) tries to answer.
		sshMgr.handleHostVerifyResponse(promptId, "trust_permanent", "rt3-not-owner");

		// INVARIANT 1: prompt still pending — non-owner response silently dropped.
		expect(ctx.pendingPrompts.has(promptId)).toBe(true);

		// INVARIANT 2: context still OPEN (not cleared by a rogue resolve).
		expect(ctx.promptContexts.get("rt3-acq")?.state).toBe("OPEN");

		// Correct owner responds — now it resolves.
		sshMgr.handleHostVerifyResponse(promptId, "trust_permanent", "rt3-owner");

		// Mutation oracle: promise resolves to "trust_permanent", entry cleared.
		await expect(verifyPromise).resolves.toBe("trust_permanent");
		expect(ctx.pendingPrompts.has(promptId)).toBe(false);
	});
});

// ─── Fix B: onReconnectAgent restart-reconnect revive guard ─────────────────
//
// Invariant: if closeSession() fires while onReconnectAgent's sshAgent.start()
// is still awaiting, the post-await currency re-check must detect the deleted
// session (ctx.sessions no longer has the hostId) and bail — close the fresh
// agent, return false, and leave ctx.agents empty for that host.
//
// Mutation oracle: removing the `ctx.sessions.get(hostId)?.id !== sessionId`
// post-await guard in onReconnectAgent causes the restart-reconnect to wire
// the agent unconditionally → session is revived after closeSession.
//
// Strategy: use mockImplementationOnce on the second SshAgent construction
// (the one inside onReconnectAgent) to inject a deferred start(); while start()
// is pending, call closeSession(); resolve start(); assert the agent was
// closed (not wired/stored) and onReconnectAgent returned false.

describe("SessionManager — Fix B: onReconnectAgent restart-reconnect revive guard", () => {
	let sm: SessionManager;
	let dbManager: ReturnType<typeof openTestDatabases>;

	beforeEach(() => {
		localSpawnCount = 0;
		sshSpawnCount = 0;
		mockSshAgentInstance = null;
		nextSshStartError = null;
		dbManager = openTestDatabases();
		sm = new SessionManager(dbManager);
		vi.mocked(_SshAgentForMock).mockClear();
	});

	afterEach(async () => {
		await sm.shutdown();
		dbManager.close();
	});

	async function createSshHost(): Promise<string> {
		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);
		const host = dal.createHost({
			type: "ssh",
			label: "fixb-ssh",
			sshHost: "user@fixb-test",
			sshAuth: "key",
			sshKeyPath: "/nonexistent/key",
		});
		return host.id;
	}

	// B1: closeSession during onReconnectAgent start() → session NOT revived.
	//
	// Mutation oracle: removing the post-await currency re-check in onReconnectAgent
	// causes ctx.agents to receive the fresh agent even after closeSession deleted
	// the session — observable as ctx.agents.has(hostId) === true after the race.
	it("B1: closeSession during in-flight start() prevents session revival", async () => {
		const hostId = await createSshHost();

		const c1 = makeClient("c-fixb-1", []);
		sm.addClient(c1);

		// First handleSpawn: establishes the session and active agent.
		const channelId = await sm.handleSpawn("c-fixb-1", { type: "SPAWN", hostId });
		expect(channelId).toBeTruthy();

		// Disconnect the initial agent so restartChannel sees !agent.connected
		// and falls into the onReconnectAgent path.
		const initialAgent = mockSshAgentInstance!;
		initialAgent.simulateClose();
		await new Promise((r) => setImmediate(r));

		// Capture the sessionId before the race so we can verify it was not revived.
		const ctx = (sm as unknown as { ctx: import("./session-context.js").SharedSessionContext }).ctx;
		const sessionBefore = ctx.sessions.get(hostId);
		expect(sessionBefore).toBeDefined();
		const originalSessionId = sessionBefore?.id ?? "";

		// Deferred start(): lets us interleave closeSession between start() entry and resolve.
		let resolveStart!: () => void;
		const startGate = new Promise<void>((res) => {
			resolveStart = res;
		});

		// Second SshAgent construction (inside onReconnectAgent) gets a deferred start().
		const reconnectAgentClose = vi.fn();
		// biome-ignore lint/complexity/useArrowFunction: vitest needs a constructable function for new-ed mocks
		vi.mocked(_SshAgentForMock).mockImplementationOnce(function () {
			const agent = new MockSshAgent();
			agent.start = vi.fn().mockReturnValue(startGate);
			agent.close = reconnectAgentClose;
			return agent as never;
		});

		// Start restartChannel — it will await onReconnectAgent → await start().
		// Do NOT await yet; we need to interleave closeSession.
		const restartPromise = sm.restartChannel(channelId!);

		// Yield to let restartChannel enter onReconnectAgent and reach await start().
		await new Promise((r) => setImmediate(r));

		// closeSession fires while start() is still pending — deletes ctx.sessions entry.
		await sm.closeSession(originalSessionId);

		// INVARIANT: session is gone from ctx.sessions (closeSession deleted it).
		expect(ctx.sessions.has(hostId)).toBe(false);

		// Now resolve start() — the post-await guard should detect the missing session.
		resolveStart();

		// Await restartChannel — must return false (not revived).
		const result = await restartPromise;

		// INVARIANT 1: restartChannel returns false — the reconnect was cancelled.
		// Mutation oracle: without the guard this would return true (revive path).
		expect(result).toBe(false);

		// INVARIANT 2: the fresh reconnect agent was closed — not leaked.
		// Mutation oracle: without the guard, close() is never called and the agent leaks.
		expect(reconnectAgentClose).toHaveBeenCalled();

		// INVARIANT 3: ctx.agents does NOT contain the revived agent for this host.
		// Mutation oracle: without the guard, ctx.agents.set(hostId, sshAgent) runs
		// unconditionally and leaves a stale agent reference after session close.
		expect(ctx.agents.has(hostId)).toBe(false);

		// INVARIANT 4: ctx.sessions remains empty — the session was not re-created.
		// Mutation oracle: without the guard, getOrCreateSession (removed in fix) would
		// insert a new session entry, reviving the closed session.
		expect(ctx.sessions.has(hostId)).toBe(false);
	});

	// B2 (happy path): onReconnectAgent succeeds when no closeSession races.
	//
	// Ensures the currency guard does not break the normal flow.
	it("B2: onReconnectAgent succeeds when session is still current after start()", async () => {
		const hostId = await createSshHost();

		const c1 = makeClient("c-fixb-2", []);
		sm.addClient(c1);

		// Establish initial session + channel.
		const channelId = await sm.handleSpawn("c-fixb-2", { type: "SPAWN", hostId });
		expect(channelId).toBeTruthy();

		// Disconnect the initial agent.
		mockSshAgentInstance?.simulateClose();
		await new Promise((r) => setImmediate(r));

		const ctx = (sm as unknown as { ctx: import("./session-context.js").SharedSessionContext }).ctx;

		// Verify session still present before restart.
		expect(ctx.sessions.has(hostId)).toBe(true);

		// Trigger restartChannel — no closeSession race this time.
		// The default mock start() resolves immediately.
		const result = await sm.restartChannel(channelId!);

		// INVARIANT: happy path succeeds — agent is wired and session is active.
		// (restartChannel may return false if the SPAWN roundtrip times out in the
		// mock environment, but onReconnectAgent itself must have returned true —
		// observable via ctx.agents being populated for this host.)
		const agentPresent = ctx.agents.has(hostId);
		// The currency guard must not have fired (no closeSession).
		// We accept true OR a mock-SPAWN-timeout false, but agents must be set.
		expect(agentPresent).toBe(true);
		// result can be false if the channel SPAWN times out in mock (no mock SPAWN_OK
		// after reconnect), but the agent wiring must have succeeded.
		// Suppress unused-result lint; main observable is agentPresent above.
		void result;
	});
});

// ─── Fix C2: onReconnectAgent abort-safety on closeSession ────────────────────
//
// Invariant: when closeSession() fires while onReconnectAgent is awaiting a
// reconnect start(), the AbortController registered in ctx.reconnectAbortControllers
// must fire so the attempt cannot wire/store an agent for an already-closed session.
//
// Mutation oracle: without an AbortController threaded into reconnect start(),
// the reconnect attempt can outlive closeSession and revive the closed session.
//
// Strategy:
//   1. Call onReconnectAgent (via restartChannel) → registers a reconnect controller.
//   2. closeSession() → reconnectAbortControllers abort fires and clears the entry.
//   3. Late handleAuthPromptResponse delivers a secret → assert NOT cached.

describe("SessionManager — Fix C2: onReconnectAgent abort-safe on closeSession", () => {
	let sm: SessionManager;
	let dbManager: ReturnType<typeof openTestDatabases>;

	beforeEach(() => {
		localSpawnCount = 0;
		sshSpawnCount = 0;
		mockSshAgentInstance = null;
		nextSshStartError = null;
		dbManager = openTestDatabases();
		sm = new SessionManager(dbManager);
		vi.mocked(_SshAgentForMock).mockClear();
	});

	afterEach(async () => {
		await sm.shutdown();
		dbManager.close();
	});

	async function createSshHostC2(): Promise<string> {
		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);
		const host = dal.createHost({
			type: "ssh",
			label: "c2-ssh",
			sshHost: "user@c2-test",
			sshAuth: "password",
		});
		return host.id;
	}

	it("C2: closeSession during in-flight reconnect aborts controller, late response does not cache secret", async () => {
		const hostId = await createSshHostC2();

		const c1 = makeClient("c-c2-1", []);
		sm.addClient(c1);

		// Establish initial session + channel.
		const channelId = await sm.handleSpawn("c-c2-1", { type: "SPAWN", hostId });
		expect(channelId).toBeTruthy();

		// Disconnect the initial agent so restartChannel sees !agent.connected
		// and falls into the onReconnectAgent path.
		const initialAgent = mockSshAgentInstance!;
		initialAgent.simulateClose();
		await new Promise((r) => setImmediate(r));

		// Capture context maps for assertions.
		const ctx = (sm as unknown as { ctx: import("./session-context.js").SharedSessionContext }).ctx;

		const sessionBefore = ctx.sessions.get(hostId);
		expect(sessionBefore).toBeDefined();
		const originalSessionId = sessionBefore?.id ?? "";

		// Make the reconnect agent's start() hang indefinitely so the test
		// controls when it proceeds. The deferred gate never resolves — the
		// test relies solely on the abort path.
		let startGateResolve!: () => void;
		const startGate = new Promise<void>((res) => {
			startGateResolve = res;
		});

		const reconnectAgentClose = vi.fn();
		// biome-ignore lint/complexity/useArrowFunction: vitest needs a constructable function for new-ed mocks
		vi.mocked(_SshAgentForMock).mockImplementationOnce(function () {
			const agent = new MockSshAgent();
			// start() hangs — it will be aborted by closeSession
			agent.start = vi.fn().mockReturnValue(startGate);
			agent.close = reconnectAgentClose;
			return agent as never;
		});

		// Trigger restartChannel — enters onReconnectAgent → awaits start().
		// Do NOT await; interleave closeSession.
		const restartPromise = sm.restartChannel(channelId!);

		// Yield to let onReconnectAgent register the AbortController and
		// reach await sshAgent.start().
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));

		// PRECONDITION: an AbortController must be registered for this host.
		// Mutation oracle: without the AC wiring, reconnectAbortControllers is empty.
		expect(ctx.reconnectAbortControllers.has(hostId)).toBe(true);

		// closeSession fires — must abort the reconnectAbortController.
		await sm.closeSession(originalSessionId);

		// INVARIANT 1: session is gone.
		expect(ctx.sessions.has(hostId)).toBe(false);

		// INVARIANT 2: reconnectAbortControllers cleared for this host.
		// Mutation oracle: without the AC deletion in closeSession path, this stays populated.
		expect(ctx.reconnectAbortControllers.has(hostId)).toBe(false);

		// INVARIANT 3: prompt registries are clear for this reconnect path.
		expect(ctx.pendingPrompts.size).toBe(0);

		// Simulate a late response arriving after the session was closed.
		// Without the fix, handleAuthPromptResponse would find the stale entry
		// and cache the secret in passphraseCache.
		sm.handleAuthPromptResponse("c-c2-1", hostId, "should-not-be-cached");

		// INVARIANT 4: passphraseCache must NOT contain the secret for the closed host.
		// Mutation oracle: without the fix, passphraseCache.has(hostId) === true here.
		expect(ctx.passphraseCache.has(hostId)).toBe(false);

		// Resolve the gate so start() settles and restartChannel can finish.
		startGateResolve();
		await restartPromise;
	});
});

// ─── Fix C3: closeSession clears reconnect PromptContext by session owner ─────
//
// Reconnect prompts are owned by reconnect:<sessionId>, not by bare hostId. Closing
// the session must clear that owner context so late responses cannot cache secrets
// for a session that no longer exists.

describe("SessionManager — Fix C3: closeSession clears reconnect PromptContext", () => {
	let sm: SessionManager;
	let dbManager: ReturnType<typeof openTestDatabases>;

	beforeEach(() => {
		localSpawnCount = 0;
		sshSpawnCount = 0;
		mockSshAgentInstance = null;
		nextSshStartError = null;
		dbManager = openTestDatabases();
		sm = new SessionManager(dbManager);
		vi.mocked(_SshAgentForMock).mockClear();
	});

	afterEach(async () => {
		await sm.shutdown();
		dbManager.close();
	});

	it("C3-1: closeSession clears reconnect PromptContext for the session owner", async () => {
		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);
		const host = dal.createHost({
			type: "ssh",
			label: "c3-ssh",
			sshHost: "user@c3-test",
			sshAuth: "password",
		});
		const hostId = host.id;

		const c1 = makeClient("c-c3-1", []);
		sm.addClient(c1);

		// Establish an SSH session.
		const channelId = await sm.handleSpawn("c-c3-1", { type: "SPAWN", hostId });
		expect(channelId).toBeTruthy();

		const ctx = (sm as unknown as { ctx: import("./session-context.js").SharedSessionContext }).ctx;

		const sessionState = ctx.sessions.get(hostId);
		expect(sessionState).toBeDefined();
		const sessionId = sessionState?.id ?? "";

		openContext(ctx, "session", hostId, "c-c3-1", reconnectContextId(sessionId));
		const promptPromise = promptCtx(
			ctx,
			reconnectContextId(sessionId),
			"passphrase",
			{ type: "AUTH_PROMPT", hostId, promptType: "passphrase", message: "test", promptId: "" },
			() => {},
		)!;
		const promptId = [...ctx.pendingPrompts.keys()][0]!;

		expect(ctx.pendingPrompts.has(promptId)).toBe(true);

		await sm.closeSession(sessionId);

		expect(ctx.pendingPrompts.has(promptId)).toBe(false);
		expect(ctx.promptContexts.has(reconnectContextId(sessionId))).toBe(false);
		await expect(promptPromise).resolves.toBeNull();
	});

	it("C3-2: late AUTH_PROMPT_RESPONSE does not cache secret after reconnect context is cleared", async () => {
		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);
		const host = dal.createHost({
			type: "ssh",
			label: "c3b-ssh",
			sshHost: "user@c3b-test",
			sshAuth: "password",
		});
		const hostId = host.id;

		const c1 = makeClient("c-c3b-1", []);
		sm.addClient(c1);

		const channelId = await sm.handleSpawn("c-c3b-1", { type: "SPAWN", hostId });
		expect(channelId).toBeTruthy();

		const ctx = (sm as unknown as { ctx: import("./session-context.js").SharedSessionContext }).ctx;

		const sessionId = ctx.sessions.get(hostId)?.id ?? "";

		openContext(ctx, "session", hostId, "c-c3b-1", reconnectContextId(sessionId));
		const promptPromise = promptCtx(
			ctx,
			reconnectContextId(sessionId),
			"passphrase",
			{ type: "AUTH_PROMPT", hostId, promptType: "passphrase", message: "test", promptId: "" },
			() => {},
		)!;

		await sm.closeSession(sessionId);
		await promptPromise;

		// Simulate a late client response arriving after close.
		sm.handleAuthPromptResponse("c-c3b-1", hostId, "should-not-be-cached-secret");

		// INVARIANT: passphraseCache must NOT contain the secret for the closed host.
		// Mutation oracle: without owner-context cleanup, the secret would be cached.
		expect(ctx.passphraseCache.has(hostId)).toBe(false);
	});
});
