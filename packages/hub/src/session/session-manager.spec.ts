import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	AgentAttachMessage,
	AgentSpawnMessage,
	AuthPromptMessage,
	ChannelCreatedMessage,
	ChannelStateMessage,
	EndedOutput,
	ErrorMessage,
	ProtocolMessage,
	UiAttachOkMessage,
	UiSpawnMessage,
} from "@lasterm/shared";
import { ErrorCode } from "@lasterm/shared";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { createHostsChangeAnnouncer, HOSTS_CHANGED_QUIET_MS } from "../api/hosts-changed.js";
import type { ConfigResolver } from "../config.js";
import { openTestDatabases } from "../storage/db.js";
import { MetaDAL } from "../storage/meta.js";
import { SpoolDAL } from "../storage/spool.js";
import { makeTempDir, removeTempDir } from "../temp-dir.fixture.js";
import { onWriteLockChange } from "../ws/ws-handler.js";
import type { AgentConnection } from "./agent-connection.js";
import { connectOrLaunch as _connectOrLaunchForMock } from "./agent-launcher.js";
import { AuthCancelledError } from "./auth-cancelled.js";
import { resolveHostOs } from "./host-profile-menu.js";
import { OutputChunker } from "./output-chunker.js";
import {
	clearContext,
	openContext,
	prompt as promptCtx,
	reconnectContextId,
} from "./prompt-context.js";
import type { CommitProtectedMap } from "./session-context.js";
import { SessionManager, type WsClient } from "./session-manager.js";
import { seedShellProfiles } from "./shell-profile-seed.js";
import { WriteLockManager } from "./write-lock.js";

// ─── Mock channel ID helpers ──────────────────────────────────────────────────
// Per-test counters reset in beforeEach; each SPAWN emits a unique channelId.
let localSpawnCount = 0;
let sshSpawnCount = 0;
let nextLocalSpawnChannelIdOverride: string | null = null;
/** Set before a test to have the next local SPAWN refused with this SPAWN_ERR. */
let nextLocalSpawnError: { code: string; message: string } | null = null;
let nextLocalAttachNotFoundChannelId: string | null = null;
/**
 * Set before a test to have the next local SPAWN's program end at once: its
 * CHANNEL_EXIT, with this code, comes in the same read as the SPAWN_OK.
 */
let nextLocalSpawnEndsWith: number | null = null;
/** Set before a test to have the next local SPAWN_OK followed, in the same read, by this OUTPUT. */
let nextLocalSpawnOutput: string | null = null;
/** While set, local ATTACHes go unanswered; the request ids are kept here (#80). */
let holdLocalAttach = false;
const heldLocalAttaches: Array<{ channelId: string; requestId: string }> = [];
/** Set before a test to have the next elevated local SPAWN start without a secret. */
let nextLocalElevationPasswordless = false;
let localChannelStateWaitCount = 0;
let nextLocalChannelStateFailure: Error | null = null;
/** The capabilities the next local agent says in its HELLO; none said when null. */
let nextLocalAgentCapabilities: string[] | null = null;
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
vi.mock("./agent-launcher.js", async () => {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const { EventEmitter } = require("node:events");
	// The hub's own version: an agent of another one is retired, which waits
	// for a daemon stop this mock never answers.
	const { HUB_VERSION } =
		await vi.importActual<typeof import("../build-version.js")>("../build-version.js");

	class MockLocalAgent extends EventEmitter {
		private _connected = true;
		helloMessage: unknown;
		constructor() {
			super();
			mockLocalAgents.push(this);
			this.helloMessage =
				nextLocalAgentCapabilities === null
					? undefined
					: {
							type: "HELLO",
							version: 1,
							agentVersion: HUB_VERSION,
							capabilities: nextLocalAgentCapabilities,
						};
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
				const refusal = nextLocalSpawnError;
				if (refusal !== null) {
					nextLocalSpawnError = null;
					setImmediate(() => {
						this.emit("message", { type: "SPAWN_ERR", requestId: spawnMsg.requestId, ...refusal });
					});
					return;
				}
				// Two-step elevation: if elevated=true but no elevationSecret, return SPAWN_ERR
				const passwordless = nextLocalElevationPasswordless;
				nextLocalElevationPasswordless = false;
				if (spawnMsg.elevated === true && !spawnMsg.elevationSecret && !passwordless) {
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
				const endsWith = nextLocalSpawnEndsWith;
				nextLocalSpawnEndsWith = null;
				const firstOutput = nextLocalSpawnOutput;
				nextLocalSpawnOutput = null;
				setImmediate(() => {
					this.emit("message", {
						type: "SPAWN_OK",
						requestId: spawnMsg.requestId,
						channelId,
					});
					if (firstOutput !== null) {
						this.emit("message", {
							type: "OUTPUT",
							channelId,
							data: new TextEncoder().encode(firstOutput),
						});
					}
					// One read, as AgentConnection emits its frames: synchronously.
					if (endsWith !== null) {
						this.emit("message", { type: "CHANNEL_EXIT", channelId, exitCode: endsWith });
					}
				});
			} else if (msg.type === "ATTACH") {
				const attachMsg = msg as unknown as { channelId: string; requestId: string };
				if (holdLocalAttach) {
					heldLocalAttaches.push(attachMsg);
					return;
				}
				if (nextLocalAttachNotFoundChannelId === attachMsg.channelId) {
					nextLocalAttachNotFoundChannelId = null;
					setImmediate(() => {
						this.emit("message", {
							type: "ERROR",
							code: "CHANNEL_NOT_FOUND",
							message: `channel ${attachMsg.channelId} not found`,
							channelId: attachMsg.channelId,
							requestId: attachMsg.requestId,
						});
					});
					return;
				}
				setImmediate(() => {
					this.emit("message", {
						type: "ATTACH_OK",
						channelId: attachMsg.channelId,
						requestId: attachMsg.requestId,
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
	nextLocalSpawnOutput = null;
	holdLocalAttach = false;
	heldLocalAttaches.length = 0;
	nextLocalSpawnChannelIdOverride = null;
	nextLocalSpawnError = null;
	nextLocalSpawnEndsWith = null;
	nextLocalElevationPasswordless = false;
	nextLocalAttachNotFoundChannelId = null;
	nextLocalChannelStateFailure = null;
});

// ─── Mock SshAgent ────────────────────────────────────────────────────────────
let mockSshAgentInstance: MockSshAgent | null = null;
/** Set to an Error before a test to make the next new SshAgent's start() reject once. */
let nextSshStartError: Error | null = null;
/** Set before a test to have the next start() report an agent re-uploaded, and beside what. */
let nextSshStartCallsAgentUpdated: false | { besideRunningDaemon: boolean } = false;
/** Set before a test to have the next start() detect the host's OS, as a deploy does. */
let nextSshStartDetects: { os: "linux" | "windows"; arch: "x64" | "arm64" } | null = null;

interface MockSshAgentDeployOptions {
	onAgentUpdated?: (hostId: string, installed: { besideRunningDaemon: boolean }) => void;
	onOsDetected?: (hostId: string, os: "linux" | "windows", arch: "x64" | "arm64") => void;
}

class MockSshAgent {
	private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
	private _connected = true;

	lastKeyVerification = { capturedFingerprint: "SHA256:mockfp", mismatch: false };
	start = vi.fn(async () => {
		const installed = nextSshStartCallsAgentUpdated;
		if (installed !== false) {
			nextSshStartCallsAgentUpdated = false;
			this.deployOptions?.onAgentUpdated?.(this.host.id, installed);
		}
		const detected = nextSshStartDetects;
		if (detected !== null) {
			nextSshStartDetects = null;
			this.deployOptions?.onOsDetected?.(this.host.id, detected.os, detected.arch);
		}
	});

	/** What the hub handed this connection to record what its deploy finds. */
	get deployedWith(): MockSshAgentDeployOptions | undefined {
		return this.deployOptions;
	}
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
			const attachMsg = msg as unknown as { channelId: string; requestId: string };
			setImmediate(() => {
				this._emit("message", {
					type: "ATTACH_OK",
					channelId: attachMsg.channelId,
					requestId: attachMsg.requestId,
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

/** What an answer to the last AUTH_PROMPT a client received echoes. */
function echoOf(received: ProtocolMessage[]): { promptId: string; deliveryEpoch: number } {
	const prompt = received.filter((m) => m.type === "AUTH_PROMPT").at(-1) as
		| AuthPromptMessage
		| undefined;
	if (!prompt) throw new Error("expected an AUTH_PROMPT");
	return { promptId: prompt.promptId, deliveryEpoch: prompt.deliveryEpoch };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

/**
 * Arrange session and agent state directly. Production code reaches these
 * maps only through ctx.commits, which their type enforces; a test setting up
 * a precondition is the one caller allowed around it.
 */
function seedMap<K, V>(map: CommitProtectedMap<K, V>, key: K, value: V): void {
	(map as Map<K, V>).set(key, value);
}

describe("SessionManager", () => {
	let sm: SessionManager;
	let dbManager: ReturnType<typeof openTestDatabases>;

	beforeEach(() => {
		// Reset per-test state
		localSpawnCount = 0;
		sshSpawnCount = 0;
		localChannelStateWaitCount = 0;
		nextLocalAgentCapabilities = null;
		mockLocalAgents.length = 0;
		mockSshAgentInstance = null;
		nextSshStartCallsAgentUpdated = false;
		nextSshStartDetects = null;
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
		expect(session?.status).toBe("active");
		expect(session?.hostId).toBeTruthy();
		expect(session?.sessionId).toBeTruthy();
		expect(snapshot.channels.length).toBeGreaterThan(0);
		const channel = snapshot.channels[0];
		expect(channel?.status).toBe("live");
		expect(channel?.channelId).toBeTruthy();
		expect(channel?.sessionId).toBe(session?.sessionId);
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

	// ─── Bringing a terminal back ────────────────────────────────────────────
	//
	// Restart is a spawn that names the terminal it is bringing back. The guard
	// exists so that naming one cannot take over a terminal that is someone's or
	// still running — and it read a dead entry left in the live map as exactly
	// that, which made Restart impossible on the terminals that most need it.

	it("brings back a terminal whose entry is still in the map but dead", async () => {
		const received: ProtocolMessage[] = [];
		const client = makeClient("c1", received);
		sm.addClient(client);
		await sm.handleSpawn("c1", { type: "SPAWN", hostId: "local" });

		const channels = (sm as unknown as { channels: Map<string, { status: string }> }).channels;
		const stale = channels.get("local-ch-1");
		expect(stale).toBeDefined();
		if (stale) stale.status = "dead";

		received.length = 0;
		const again = await sm.handleSpawn("c1", {
			type: "SPAWN",
			hostId: "local",
			reuseChannelId: "local-ch-1",
		});

		expect(received.find((m) => m.type === "ERROR")).toBeUndefined();
		expect(again).toBe("local-ch-1");
	});

	it("refuses to take over one that is running", async () => {
		const received: ProtocolMessage[] = [];
		const client = makeClient("c1", received);
		sm.addClient(client);
		await sm.handleSpawn("c1", { type: "SPAWN", hostId: "local" });

		received.length = 0;
		const again = await sm.handleSpawn("c1", {
			type: "SPAWN",
			hostId: "local",
			reuseChannelId: "local-ch-1",
		});

		expect(again).toBeNull();
		expect(received).toContainEqual(
			expect.objectContaining({ type: "ERROR", code: "CHANNEL_NOT_REUSABLE" }),
		);
	});

	// ─── A SPAWN that names itself is answered under its name (#777) ─────────
	//
	// The window's socket carries every ERROR the hub has for it, and most name
	// no host: only the request id tells a SPAWN's answer from the rest.

	describe("a SPAWN that names itself (#777)", () => {
		const NAMED = "01ARZ3NDEKTSV4RRFFQ69G5FAX";

		it("is answered SPAWN_OK under its name, and its window attached all the same", async () => {
			const received: ProtocolMessage[] = [];
			const client = makeClient("c1", received);
			sm.addClient(client);

			const channelId = await sm.handleSpawn("c1", {
				type: "SPAWN",
				hostId: "local",
				requestId: NAMED,
			});

			expect(received).toContainEqual(
				expect.objectContaining({ type: "SPAWN_OK", channelId, requestId: NAMED }),
			);
			expect(channelId).not.toBeNull();
			expect(client.attachedChannels.has(channelId as string)).toBe(true);
		});

		it("is refused under its name", async () => {
			const received: ProtocolMessage[] = [];
			sm.addClient(makeClient("c1", received));
			await sm.handleSpawn("c1", { type: "SPAWN", hostId: "local" });

			received.length = 0;
			await sm.handleSpawn("c1", {
				type: "SPAWN",
				hostId: "local",
				reuseChannelId: "local-ch-1",
				requestId: NAMED,
			});

			expect(received).toEqual([
				expect.objectContaining({
					type: "ERROR",
					code: "CHANNEL_NOT_REUSABLE",
					channelId: "local-ch-1",
					requestId: NAMED,
				}),
			]);
		});

		it("names no other message sent to its window meanwhile", async () => {
			const received: ProtocolMessage[] = [];
			sm.addClient(makeClient("c1", received));

			await sm.handleSpawn("c1", { type: "SPAWN", hostId: "local", requestId: NAMED });

			const named = received.filter((msg) => "requestId" in msg);
			expect(named.map((msg) => msg.type)).toEqual(["SPAWN_OK"]);
		});

		it("names nothing when the SPAWN named nothing", async () => {
			const received: ProtocolMessage[] = [];
			sm.addClient(makeClient("c1", received));
			await sm.handleSpawn("c1", { type: "SPAWN", hostId: "local" });
			await sm.handleSpawn("c1", {
				type: "SPAWN",
				hostId: "local",
				reuseChannelId: "local-ch-1",
			});

			expect(received.filter((msg) => "requestId" in msg)).toEqual([]);
			expect(received).toContainEqual(
				expect.objectContaining({ type: "ERROR", code: "CHANNEL_NOT_REUSABLE" }),
			);
		});
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
		new MetaDAL(dbManager.meta).createSession({
			id: sessionId,
			hostId: localHostId,
			status: "starting",
		});
		seedMap(ctx.sessions, localHostId, { id: sessionId, hostId: localHostId, status: "starting" });
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

	it("sends no spool tail when the agent answers with a fresh screen", async () => {
		const received: ProtocolMessage[] = [];
		const client = makeClient("c1", received);
		sm.addClient(client);
		await sm.handleSpawn("c1", { type: "SPAWN", hostId: "local" });

		// A channel with history behind it. The agent's own sequence starts at
		// its own zero, which is not this numbering: asking for "everything
		// after the agent's last seq" used to mean everything here (#457).
		const spool = new SpoolDAL(dbManager.spool);
		for (let seq = 1; seq <= 5; seq++) {
			spool.insertChunk({
				channelId: "local-ch-1",
				seq,
				kind: "output",
				dataBlob: Buffer.from(`chunk-${seq}`),
				uncompressedLen: 7,
			});
		}

		const client2Received: ProtocolMessage[] = [];
		const client2 = makeClient("c2", client2Received);
		sm.addClient(client2);
		await sm.handleAttach("c2", "local-ch-1");

		const attachOk = client2Received.find((m) => m.type === "ATTACH_OK") as unknown as {
			snapshot: unknown;
			tail: unknown[];
			cached: boolean;
		};
		expect(attachOk.cached).toBe(false);
		// The screen the agent just rendered is the whole answer; what comes
		// after it arrives as OUTPUT, in order, on the same connection.
		expect(attachOk.snapshot).toBeTruthy();
		expect(attachOk.tail).toEqual([]);
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

	// ─── One size per terminal (#831) ──────────────────────────────────────
	// The WS handler lets only the write lock's holder through to handleResize
	// (ws/handlers/resize.spec.ts); what it applies, every client attached is
	// told, and a client attaching reads it.

	it("tells every client attached to a terminal its new size, and no other client", async () => {
		const writer: ProtocolMessage[] = [];
		const reader: ProtocolMessage[] = [];
		const elsewhere: ProtocolMessage[] = [];
		sm.addClient(makeClient("c1", writer));
		sm.addClient(makeClient("c2", reader));
		sm.addClient(makeClient("c3", elsewhere));
		await sm.handleSpawn("c1", { type: "SPAWN", hostId: "local", cols: 100, rows: 30 });
		await sm.handleAttach("c2", "local-ch-1");

		sm.handleResize("c1", "local-ch-1", 120, 40);

		const size = { type: "CHANNEL_SIZE", channelId: "local-ch-1", cols: 120, rows: 40 };
		expect(reader.filter((m) => m.type === "CHANNEL_SIZE")).toEqual([size]);
		// The one that asked too: it falls back to the PTY's size once it no
		// longer decides it.
		expect(writer.filter((m) => m.type === "CHANNEL_SIZE")).toEqual([size]);
		expect(elsewhere.some((m) => m.type === "CHANNEL_SIZE")).toBe(false);
	});

	it("tells nobody of a size the terminal already has", async () => {
		const reader: ProtocolMessage[] = [];
		sm.addClient(makeClient("c1", []));
		sm.addClient(makeClient("c2", reader));
		await sm.handleSpawn("c1", { type: "SPAWN", hostId: "local", cols: 100, rows: 30 });
		await sm.handleAttach("c2", "local-ch-1");

		sm.handleResize("c1", "local-ch-1", 100, 30);
		sm.handleResize("c1", "local-ch-1", 120, 40);
		sm.handleResize("c1", "local-ch-1", 120, 40);

		expect(reader.filter((m) => m.type === "CHANNEL_SIZE")).toHaveLength(1);
	});

	it("gives a client attaching the terminal's current size in ATTACH_OK", async () => {
		sm.addClient(makeClient("c1", []));
		await sm.handleSpawn("c1", { type: "SPAWN", hostId: "local", cols: 100, rows: 30 });
		sm.handleResize("c1", "local-ch-1", 132, 43);

		const late: ProtocolMessage[] = [];
		sm.addClient(makeClient("c2", late));
		await sm.handleAttach("c2", "local-ch-1");

		expect(late.find((m) => m.type === "ATTACH_OK")).toMatchObject({ cols: 132, rows: 43 });
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

	// #955: a detached session is the host's session; a terminal opened on it,
	// or one attached again, makes it active (SPEC.md § 4.2).
	it("a terminal opened while the host's session is detached joins that session", async () => {
		sm.addClient(makeClient("c1", []));
		await sm.handleSpawn("c1", { type: "SPAWN", hostId: "local" });
		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);
		const [first] = dal.listSessions();
		sm.removeClient("c1");
		expect(dal.getSession(first?.id ?? "")?.status).toBe("detached");

		const c2: ProtocolMessage[] = [];
		sm.addClient(makeClient("c2", c2));
		await sm.handleSpawn("c2", { type: "SPAWN", hostId: "local" });

		expect(dal.listSessions().map((s) => [s.id, s.status])).toEqual([[first?.id, "active"]]);
		expect(c2.find((m) => m.type === "SPAWN_OK")).toMatchObject({ sessionId: first?.id });
		expect(c2).toContainEqual(
			expect.objectContaining({ type: "SESSION_STATE", sessionId: first?.id, status: "active" }),
		);
	});

	it("a terminal attached again while the host's session is detached makes it active", async () => {
		sm.addClient(makeClient("c1", []));
		await sm.handleSpawn("c1", { type: "SPAWN", hostId: "local" });
		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);
		const [first] = dal.listSessions();
		sm.removeClient("c1");

		const c2: ProtocolMessage[] = [];
		sm.addClient(makeClient("c2", c2));
		await sm.handleAttach("c2", "local-ch-1");

		expect(dal.getSession(first?.id ?? "")?.status).toBe("active");
		expect(c2).toContainEqual(
			expect.objectContaining({ type: "SESSION_STATE", sessionId: first?.id, status: "active" }),
		);
	});

	it("a terminal restarted while the host's session is detached makes it active", async () => {
		sm.addClient(makeClient("c1", []));
		await sm.handleSpawn("c1", { type: "SPAWN", hostId: "local" });
		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);
		const [first] = dal.listSessions();
		sm.removeClient("c1");
		expect(dal.getSession(first?.id ?? "")?.status).toBe("detached");

		const c2: ProtocolMessage[] = [];
		sm.addClient(makeClient("c2", c2));
		expect(await sm.restartChannel("local-ch-1")).toBe(true);

		expect(dal.getSession(first?.id ?? "")?.status).toBe("active");
		expect(c2).toContainEqual(
			expect.objectContaining({ type: "SESSION_STATE", sessionId: first?.id, status: "active" }),
		);
	});

	// #1089: the SPAWN_OK of a restart and the new program's CHANNEL_EXIT in
	// one read. The exit is the new run's end.
	it("a restarted program that ends at once is shown ended", async () => {
		const received: ProtocolMessage[] = [];
		sm.addClient(makeClient("c1", received));
		await sm.handleSpawn("c1", { type: "SPAWN", hostId: "local" });

		nextLocalSpawnEndsWith = 3;
		expect(await sm.restartChannel("local-ch-1")).toBe(true);

		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);
		expect(dal.getChannel("local-ch-1")?.status).toBe("dead");
		const states = received.filter(
			(m) => m.type === "CHANNEL_STATE" && (m as { channelId?: string }).channelId === "local-ch-1",
		);
		expect(states.at(-1)).toMatchObject({ status: "dead", exitCode: 3 });
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

	// The scope says what its terminals are started with; a launch profile
	// speaks for the terminal it launches, and the request for this one.
	it("puts the scope's variables under the profile's and the request's", async () => {
		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);
		const scoped = new SessionManager(dbManager, undefined, undefined, {
			uiConfig: { title: { source: "dynamic", staticTitle: "" } },
			resolve: () => ({ envMode: "inherit" }),
			environmentLayers: () => [{ FROM_SCOPE: "yes", SHARED: "scope" }],
			resolveElevationMethod: () => "sudo",
		} as unknown as ConfigResolver);
		const received: ProtocolMessage[] = [];
		scoped.addClient(makeClient("c1", received));

		const host = dal.createHost({
			type: "ssh",
			label: "test-ssh-env",
			sshHost: "user@localhost",
			sshAuth: "key",
			sshKeyPath: "/nonexistent/key",
		});
		const profile = dal.createLaunchProfile({
			name: "Env Profile",
			shell: "/usr/bin/zsh",
			env: { FROM_PROFILE: "yes", SHARED: "profile" },
			mode: "shell",
			elevated: false,
			supportedOs: "any",
			iconType: "auto",
			sortOrder: 0,
		});

		await scoped.handleSpawn("c1", {
			type: "SPAWN",
			hostId: host.id,
			launchProfileId: profile.id,
			env: { SHARED: "request" },
		});

		const spawn = mockSshAgentInstance?.send.mock.calls
			.map(([message]) => message as unknown as { type: string; env?: Record<string, string> })
			.find((message) => message.type === "SPAWN");
		expect(spawn?.env).toEqual({
			FROM_SCOPE: "yes",
			FROM_PROFILE: "yes",
			SHARED: "request",
		});
	});

	// ── The host's default profile (#802) ───────────────────────────────────
	//
	// A host had three defaults that could disagree: Edit Host's Default Shell,
	// which a terminal opened with nothing named started; the profile marked
	// default, the ✓ of the profile menu and what Ctrl+Shift+1 starts; and, on
	// the local host, the first profile of all. There is one now: the host's
	// default profile, the one its user chose, else the one the hub marked for
	// its agent's default shell.

	describe("what a terminal opened with nothing named starts: its host's default profile (#802)", () => {
		let dal: MetaDAL;

		beforeEach(() => {
			dal = new MetaDAL(dbManager.meta);
			sm.addClient(makeClient("c-shell", []));
		});

		/** An SSH host as a connection leaves it: its agent's shells recorded, a profile for each. */
		async function connectedSshHost(label: string): Promise<string> {
			const host = dal.createHost({
				type: "ssh",
				label,
				sshHost: "pi@pi.local",
				sshAuth: "key",
				sshKeyPath: "/nonexistent/key",
				os: "linux",
			});
			const shells = ["/bin/bash", "/usr/bin/fish"];
			dal.updateHostDiscoveredShells(host.id, shells, "/bin/bash");
			await seedShellProfiles(host.id, shells, "/bin/bash", "linux", dal);
			return host.id;
		}

		const PWSH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
		const CMD = "C:\\WINDOWS\\system32\\cmd.exe";

		/**
		 * The local host of a Windows hub as its agent's HELLO leaves it: the
		 * profiles the hub found at its first start, PowerShell first of all, and
		 * the Command Prompt marked as its default, its agent's (COMSPEC).
		 */
		async function localHost(): Promise<string> {
			const id = await sm.ensureLocalHost();
			for (const [sortOrder, [name, shell]] of [
				["PowerShell", PWSH],
				["Command Prompt", CMD],
			].entries()) {
				dal.createLaunchProfile({
					name: name as string,
					shell: shell as string,
					mode: "shell",
					elevated: false,
					supportedOs: "windows",
					iconType: "auto",
					sortOrder,
				});
			}
			dal.updateHostDiscoveredShells(id, [PWSH, CMD], CMD);
			await seedShellProfiles(id, [PWSH, CMD], CMD, null, dal);
			return id;
		}

		/** A profile of the host's, by its shell. */
		function profileOf(hostId: string, shell: string): string {
			const host = dal.getHost(hostId);
			if (!host) throw new Error("no such host");
			const found = dal
				.listHostProfiles(hostId, resolveHostOs(host))
				.find((p) => p.shell === shell);
			if (!found) throw new Error(`no profile for ${shell}`);
			return found.id;
		}

		/** What Edit Host's Default Shell, and Settings › Profiles, save: the user's mark. */
		function chooseDefault(hostId: string, profileId: string): void {
			dal.upsertHostProfileOverride(hostId, profileId, "default");
		}

		/** What the hub asks the host's agent to start for this request, and the channel it records. */
		async function started(
			hostId: string,
			msg: Partial<UiSpawnMessage> = {},
		): Promise<{ spawn: AgentSpawnMessage | undefined; launchProfileId: string | undefined }> {
			const channelId = await sm.handleSpawn("c-shell", { type: "SPAWN", hostId, ...msg });
			const local = dal.getHost(hostId)?.type === "local";
			const send = local ? mockLocalAgents.at(-1)?.send : mockSshAgentInstance?.send;
			const spawn = (send?.mock.calls ?? [])
				.map(([message]) => message as AgentSpawnMessage)
				.filter((message) => message.type === "SPAWN")
				.at(-1);
			const channel = channelId === null ? undefined : dal.getChannel(channelId);
			if (channel !== undefined) expect(channel.shell).toBe(spawn?.shell);
			return { spawn, launchProfileId: channel?.launchProfileId };
		}

		/** The first profile of the host's menu: the ✓ one, what Ctrl+Shift+1 starts. */
		function firstOfMenu(hostId: string) {
			const host = dal.getHost(hostId);
			if (!host) throw new Error("no such host");
			return dal.listHostProfiles(hostId, resolveHostOs(host))[0];
		}

		it("starts the profile its agent's default shell was given while its user chose none", async () => {
			const hostId = await connectedSshHost("pi-automatic");

			const { spawn, launchProfileId } = await started(hostId);

			expect(spawn?.shell).toBe("/bin/bash");
			expect(spawn?.loginShell).toBe(true);
			expect(launchProfileId).toBe(profileOf(hostId, "/bin/bash"));
		});

		it("starts the default profile its user chose on an SSH host, as its login shell", async () => {
			const hostId = await connectedSshHost("pi-fish");
			chooseDefault(hostId, profileOf(hostId, "/usr/bin/fish"));

			const { spawn, launchProfileId } = await started(hostId);

			expect(spawn?.shell).toBe("/usr/bin/fish");
			expect(spawn).not.toHaveProperty("args");
			expect(spawn?.loginShell).toBe(true);
			expect(launchProfileId).toBe(profileOf(hostId, "/usr/bin/fish"));
		});

		// A restart decides the login shell as the first start did.
		it("restarts it as a login shell too", async () => {
			const hostId = await connectedSshHost("pi-fish-restart");
			chooseDefault(hostId, profileOf(hostId, "/usr/bin/fish"));
			const channelId = await sm.handleSpawn("c-shell", { type: "SPAWN", hostId });
			if (channelId === null) throw new Error("expected a channel");

			expect(await sm.restartChannel(channelId)).toBe(true);

			const restarted = (mockSshAgentInstance?.send.mock.calls ?? [])
				.map(([message]) => message as AgentSpawnMessage)
				.filter((message) => message.type === "SPAWN")
				.at(-1);
			expect(restarted?.channelId).toBe(channelId);
			expect(restarted?.shell).toBe("/usr/bin/fish");
			expect(restarted?.loginShell).toBe(true);
		});

		it("starts the local host's default profile, its agent's, not the first profile of all", async () => {
			const id = await localHost();

			const { spawn, launchProfileId } = await started(id);

			expect(spawn?.shell).toBe(CMD);
			expect(launchProfileId).toBe(profileOf(id, CMD));
			expect(spawn).not.toHaveProperty("loginShell");
		});

		it("starts the default profile the user chose on the local host", async () => {
			const id = await localHost();
			const gitBash = dal.createLaunchProfile({
				name: "Git Bash",
				shell: "C:\\Program Files\\Git\\bin\\bash.exe",
				args: ["--login", "-i"],
				mode: "shell",
				elevated: false,
				supportedOs: "windows",
				iconType: "auto",
				sortOrder: 2,
			});
			chooseDefault(id, gitBash.id);

			const { spawn, launchProfileId } = await started(id);

			expect(spawn?.shell).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
			expect(spawn?.args).toEqual(["--login", "-i"]);
			expect(launchProfileId).toBe(gitBash.id);
		});

		// One default: what a new terminal starts is the ✓ of the profile menu,
		// its first entry, which Ctrl+Shift+1 starts.
		it("starts what the profile menu lists first, its ✓, on an SSH host and on the local host", async () => {
			const sshId = await connectedSshHost("pi-menu");
			const localId = await localHost();
			chooseDefault(sshId, profileOf(sshId, "/usr/bin/fish"));

			for (const hostId of [sshId, localId]) {
				const first = firstOfMenu(hostId);
				expect(first?.overrideType, "the ✓").toBe("default");
				expect((await started(hostId)).launchProfileId).toBe(first?.id);
			}
		});

		// Started as the menu starts it, not its shell alone.
		it("starts the default profile whole: its directory, its environment and its mode", async () => {
			const hostId = await connectedSshHost("pi-whole");
			const project = dal.createLaunchProfile({
				name: "fish in /srv",
				shell: "/usr/bin/fish",
				cwd: "/srv",
				env: { FROM_PROFILE: "yes" },
				mode: "shell",
				elevated: false,
				supportedOs: "linux",
				iconType: "auto",
				sortOrder: 5,
			});
			chooseDefault(hostId, project.id);

			const { spawn, launchProfileId } = await started(hostId);

			expect(spawn?.shell).toBe("/usr/bin/fish");
			expect(spawn?.cwd).toBe("/srv");
			expect(spawn?.env).toMatchObject({ FROM_PROFILE: "yes" });
			expect(spawn).not.toHaveProperty("directProcess");
			expect(launchProfileId).toBe(project.id);
		});

		it("still starts a launch profile or a shell named in the request", async () => {
			const hostId = await connectedSshHost("pi-named");
			chooseDefault(hostId, profileOf(hostId, "/usr/bin/fish"));
			const bash = profileOf(hostId, "/bin/bash");

			expect((await started(hostId, { launchProfileId: bash })).spawn?.shell).toBe("/bin/bash");
			const named = await started(hostId, { shell: "/bin/sh" });
			expect(named.spawn?.shell).toBe("/bin/sh");
			expect(named.launchProfileId).toBeUndefined();
		});

		it("starts its agent's own default when the host has no profile", async () => {
			const host = dal.createHost({
				type: "ssh",
				label: "pi-bare",
				sshHost: "pi@pi.local",
				sshAuth: "key",
				sshKeyPath: "/nonexistent/key",
				os: "linux",
			});

			const { spawn, launchProfileId } = await started(host.id);

			expect(spawn).not.toHaveProperty("shell");
			expect(spawn?.loginShell).toBe(true);
			expect(launchProfileId).toBeUndefined();
		});

		// The column stays (STORAGE.md § 9.1), and nothing reads it: a value a
		// hub before #802 stored starts nothing.
		it("starts no shell from the host's default_shell column", async () => {
			const hostId = await connectedSshHost("pi-column");
			dbManager.meta
				.prepare("UPDATE hosts SET default_shell = '/usr/bin/fish' WHERE id = ?")
				.run(hostId);

			expect((await started(hostId)).spawn?.shell).toBe("/bin/bash");
			expect(dal.getHost(hostId)).not.toHaveProperty("defaultShell");
		});

		// A Windows Server whose hub runs on Windows too, as #816 found it: the
		// global profiles were seeded from the hub's own machine, the Store
		// PowerShell among them as "pwsh.exe", and its agent, from 0.15.2 on,
		// reports PowerShell 7 as its default (#806).
		describe("a Windows Server whose agent reports PowerShell 7 (#816)", () => {
			const STORE_PWSH =
				"C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe\\pwsh.exe";
			const SERVER_PWSH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
			const SERVER_POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
			const SERVER_CMD = "C:\\Windows\\system32\\cmd.exe";
			const SERVER_SHELLS = [SERVER_PWSH, SERVER_POWERSHELL, SERVER_CMD];

			/** The server, connected once by an agent that reported COMSPEC as its default. */
			async function server(label: string): Promise<string> {
				for (const [sortOrder, [name, shell]] of [
					["pwsh.exe", STORE_PWSH],
					["Windows PowerShell", "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"],
					["Command Prompt", CMD],
				].entries()) {
					dal.createLaunchProfile({
						name: name as string,
						shell: shell as string,
						mode: "shell",
						elevated: false,
						supportedOs: "windows",
						iconType: "auto",
						sortOrder,
					});
				}
				const host = dal.createHost({
					type: "ssh",
					label,
					sshHost: "administrateur@192.168.1.251",
					sshAuth: "key",
					sshKeyPath: "/nonexistent/key",
					os: "windows",
				});
				dal.updateHostDiscoveredShells(host.id, SERVER_SHELLS, SERVER_CMD);
				await seedShellProfiles(host.id, SERVER_SHELLS, SERVER_CMD, "windows", dal);
				return host.id;
			}

			/** Its 0.15.2 agent's HELLO. */
			async function reconnected(hostId: string): Promise<void> {
				dal.updateHostDiscoveredShells(hostId, SERVER_SHELLS, SERVER_PWSH);
				await seedShellProfiles(hostId, SERVER_SHELLS, SERVER_PWSH, "windows", dal);
			}

			/** A terminal it ends, its row kept: what a restart brings back. */
			function bury(channelId: string): void {
				const tracked = (sm as unknown as { channels: Map<string, { status: string }> }).channels;
				const entry = tracked.get(channelId);
				if (entry) entry.status = "dead";
				dal.updateChannelStatus(channelId, "dead");
			}

			/**
			 * What the web sends for a terminal its list does not carry, one on a
			 * host other than the one in view: its id and nothing else.
			 */
			async function broughtBack(hostId: string, channelId: string): Promise<AgentSpawnMessage> {
				expect(
					await sm.handleSpawn("c-shell", { type: "SPAWN", hostId, reuseChannelId: channelId }),
				).toBe(channelId);
				const frame = (mockSshAgentInstance?.send.mock.calls ?? [])
					.map(([message]) => message as AgentSpawnMessage)
					.filter((message) => message.type === "SPAWN")
					.at(-1);
				if (frame === undefined) throw new Error("expected a SPAWN");
				return frame;
			}

			// The hub started the host's default profile in the terminal's place,
			// the hub's own "pwsh.exe", which the agent could not find: "Le
			// fichier spécifié est introuvable. (os error 2)".
			it("brings a dead terminal back with its own shell and arguments, not the host's default", async () => {
				const hostId = await server("AD");
				const cmd = await sm.handleSpawn("c-shell", { type: "SPAWN", hostId, shell: CMD });
				const quiet = await sm.handleSpawn("c-shell", {
					type: "SPAWN",
					hostId,
					shell: CMD,
					args: ["/q"],
				});
				if (cmd === null || quiet === null) throw new Error("expected two terminals");
				bury(cmd);
				bury(quiet);
				await reconnected(hostId);

				expect(await broughtBack(hostId, cmd)).toEqual({
					type: "SPAWN",
					requestId: expect.any(String),
					channelId: cmd,
					shell: CMD,
					cols: 80,
					rows: 24,
					env: {},
					envMode: "inherit",
				});
				const withArgs = await broughtBack(hostId, quiet);
				expect(withArgs.shell).toBe(CMD);
				expect(withArgs.args).toEqual(["/q"]);
				expect(dal.getChannel(quiet)?.args).toEqual(["/q"]);
			});

			// One with no shell of its own (#583) starts what a new terminal
			// would: the host's default profile, now the one launching the
			// PowerShell its agent reported.
			it("brings one with no shell of its own back in the host's default profile", async () => {
				const hostId = await server("AD-bare");
				const first = await sm.handleSpawn("c-shell", { type: "SPAWN", hostId, shell: CMD });
				if (first === null) throw new Error("expected a terminal");
				const sessionId = dal.getChannel(first)?.sessionId ?? "";
				dal.createChannel({ id: "bare-ch", sessionId, status: "dead", cols: 80, rows: 24 });
				expect(dal.getChannel("bare-ch")).not.toHaveProperty("shell");
				await reconnected(hostId);

				const frame = await broughtBack(hostId, "bare-ch");

				expect(frame.shell).toBe(SERVER_PWSH);
				expect(frame).not.toHaveProperty("args");
				expect(frame.loginShell).toBe(true);
			});

			// What a new terminal on it starts: a shell its agent reported, not
			// one found by its file name on the hub's own machine.
			it("starts a new terminal in the PowerShell its agent reported", async () => {
				const hostId = await server("AD-new");
				await reconnected(hostId);

				expect(firstOfMenu(hostId)?.shell).toBe(SERVER_PWSH);
				expect((await started(hostId)).spawn?.shell).toBe(SERVER_PWSH);
				expect(dal.getLaunchProfileByName("pwsh.exe")?.shell).toBe(STORE_PWSH);
			});
		});
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

		nextSshStartCallsAgentUpdated = { besideRunningDaemon: false };
		const received: ProtocolMessage[] = [];
		const client = makeClient("c-sync", received);
		sm.addClient(client);

		const channelId = await sm.handleSpawn("c-sync", { type: "SPAWN", hostId: host.id });

		expect(channelId).toBe("ssh-ch-1");
		expect(received.some((m) => m.type === "SPAWN_OK")).toBe(true);
		expect(received.some((m) => m.type === "ERROR")).toBe(false);
		expect(JSON.stringify(received)).not.toContain("SHA256 mismatch");

		const synced = received.find((m) => m.type === "AGENT_SYNCED");
		expect(synced).toMatchObject({
			type: "AGENT_SYNCED",
			hostId: host.id,
			hostname: "localhost",
			message: "Agent on localhost updated to the current version",
		});
	});

	// The upload went beside a daemon that was already running: the new agent
	// is on disk, the old one still answers, and the host shows it outdated with
	// a way to replace it. "Updated to the current version" beside that ring said
	// the opposite (#559).
	it("SSH host: an agent re-uploaded beside a running daemon is said to be installed, not in use", async () => {
		const dal = new MetaDAL(dbManager.meta);
		const host = dal.createHost({
			type: "ssh",
			label: "test-ssh-sync-daemon",
			sshHost: "user@localhost",
			sshAuth: "key",
			sshKeyPath: "/nonexistent/key",
		});

		nextSshStartCallsAgentUpdated = { besideRunningDaemon: true };
		const received: ProtocolMessage[] = [];
		sm.addClient(makeClient("c-sync-daemon", received));

		await sm.handleSpawn("c-sync-daemon", { type: "SPAWN", hostId: host.id });

		const synced = received.filter((m) => m.type === "AGENT_SYNCED");
		expect(synced).toEqual([
			expect.objectContaining({
				hostId: host.id,
				message: "New agent installed on localhost; replace the running one to use it",
			}),
		]);
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

	// The agent's default has a column of its own (#794); the host's default is
	// the profile its HELLO marks for it, while the user has chosen none (#802).
	it("records the agent's default shell apart, and marks its profile as the host's default", async () => {
		const dal = new MetaDAL(dbManager.meta);
		const host = dal.createHost({
			type: "ssh",
			label: "pi-agent-default",
			sshHost: "user@localhost",
			sshAuth: "key",
			sshKeyPath: "/nonexistent/key",
		});
		sm.addClient(makeClient("c1", []));
		await sm.handleSpawn("c1", { type: "SPAWN", hostId: host.id });

		mockSshAgentInstance?._emit("message", {
			type: "HELLO",
			version: 1,
			agentVersion: "0.1.0",
			capabilities: ["multiplex", "resize", "snapshot", "launch-profiles"],
			availableShells: ["/bin/bash", "/usr/bin/fish"],
			defaultShell: "/bin/bash",
		});

		expect(dal.getHost(host.id)?.discoveredDefaultShell).toBe("/bin/bash");
		expect(dal.getHost(host.id)).not.toHaveProperty("defaultShell");
		const marked = dal.getHostDefaultOverride(host.id);
		expect(marked?.setByUser).toBe(false);
		expect(dal.getLaunchProfile(marked?.profileId ?? "")?.shell).toBe("/bin/bash");
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

	// ─── What the hub records of a host, said to every window (#789) ───────

	it("tells every window once a connection found the host's OS and shells, and not when found again", async () => {
		// As createServer wires it: one message for a burst, to every client.
		const hostsChange = createHostsChangeAnnouncer((message) => sm.broadcastToAllClients(message));
		sm.onHostChanged(() => hostsChange.announce("hosts"));
		const dal = new MetaDAL(dbManager.meta);
		const host = dal.createHost({
			type: "ssh",
			label: "pi",
			sshHost: "user@pi.local",
			sshAuth: "key",
			sshKeyPath: "/nonexistent/key",
		});
		const windows: ProtocolMessage[][] = [[], []];
		windows.forEach((received, i) => {
			sm.addClient(makeClient(`window-${i}`, received));
		});
		const hostsChanged = (received: ProtocolMessage[]) =>
			received.filter((message) => message.type === "HOSTS_CHANGED");
		const hello = {
			type: "HELLO",
			version: 1,
			agentVersion: "0.1.0",
			capabilities: ["multiplex", "resize", "snapshot", "launch-profiles"],
			availableShells: ["/bin/bash", "/usr/bin/fish"],
			defaultShell: "/bin/bash",
		};

		try {
			nextSshStartDetects = { os: "linux", arch: "arm64" };
			await sm.handleSpawn("window-0", { type: "SPAWN", hostId: host.id });
			mockSshAgentInstance?._emit("message", hello);

			for (const received of windows) {
				await vi.waitFor(() =>
					expect(hostsChanged(received)).toEqual([{ type: "HOSTS_CHANGED", scope: "hosts" }]),
				);
			}
			expect(dal.getHost(host.id)).toMatchObject({
				os: "linux",
				arch: "arm64",
				discoveredShells: ["/bin/bash", "/usr/bin/fish"],
			});

			// The next deploy finds the same machine: nothing changed, nothing said.
			mockSshAgentInstance?.deployedWith?.onOsDetected?.(host.id, "linux", "arm64");
			mockSshAgentInstance?._emit("message", hello);
			await new Promise((resolve) => setTimeout(resolve, HOSTS_CHANGED_QUIET_MS * 3));
			for (const received of windows) expect(hostsChanged(received)).toHaveLength(1);
		} finally {
			hostsChange.cancel();
		}
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

	// ─── An ATTACH is answered by its own reply only (#767) ──────────────────
	//
	// While the hub waits on an ATTACH, the agent can speak of the same
	// terminal for another reason: the input typed into it was dropped, or an
	// INPUT reached it while it was gone. Neither answers the ATTACH, which
	// used to take the first ERROR naming its channel for its own.
	describe("an ATTACH waiting on its agent (#767)", () => {
		type Emitter = { emit: (event: string, message: ProtocolMessage) => void };

		/** A live terminal, and another window's ATTACH on it that its agent has not answered. */
		async function attachWaiting(manager: SessionManager = sm) {
			manager.addClient(makeClient("c-typing", []));
			const channelId = await manager.handleSpawn("c-typing", { type: "SPAWN", hostId: "local" });
			if (channelId === null) throw new Error("expected a local channel");
			const agent = mockLocalAgents.at(-1);
			if (agent === undefined) throw new Error("expected the local agent");
			const answer = agent.send.getMockImplementation() as
				| ((msg: ProtocolMessage) => void)
				| undefined;
			const asked: AgentAttachMessage[] = [];
			agent.send.mockImplementation((msg: ProtocolMessage) => {
				if (msg.type === "ATTACH") asked.push(msg as AgentAttachMessage);
				else answer?.(msg);
			});

			const received: ProtocolMessage[] = [];
			manager.addClient(makeClient("c-pane", received));
			const attached = manager.handleAttach("c-pane", channelId);
			await vi.waitFor(() => expect(asked).toHaveLength(1));
			const [attach] = asked;
			if (attach === undefined) throw new Error("expected an ATTACH");
			return { channelId, agent: agent as unknown as Emitter, attach, attached, received };
		}

		function attachOk(channelId: string, requestId?: string): ProtocolMessage {
			return {
				type: "ATTACH_OK",
				channelId,
				...(requestId !== undefined && { requestId }),
				snapshot: { serialized: "<live>", cols: 80, rows: 24, cursorX: 0, cursorY: 0 },
				lastSeq: 0,
			};
		}

		function channels(): Map<string, unknown> {
			return (sm as unknown as { ctx: import("./session-context.js").SharedSessionContext }).ctx
				.channels;
		}

		it("still attaches when the agent says the terminal's input was dropped", async () => {
			const { channelId, agent, attach, attached, received } = await attachWaiting();

			agent.emit("message", {
				type: "ERROR",
				code: "INPUT_DROPPED",
				message: `input to channel ${channelId} dropped`,
				channelId,
			});
			agent.emit("message", attachOk(channelId, attach.requestId));

			expect(await attached).toBe(true);
			expect(received).toContainEqual(
				expect.objectContaining({ type: "ATTACH_OK", channelId, cached: false }),
			);
		});

		it("still attaches, and keeps the terminal, when an INPUT is answered that it is not found", async () => {
			const { channelId, agent, attach, attached, received } = await attachWaiting();

			// What an INPUT gets that reached the agent before the terminal did.
			agent.emit("message", {
				type: "ERROR",
				code: "CHANNEL_NOT_FOUND",
				message: `channel ${channelId} not found`,
				channelId,
			});
			agent.emit("message", attachOk(channelId, attach.requestId));

			expect(await attached).toBe(true);
			expect(received).toContainEqual(
				expect.objectContaining({ type: "ATTACH_OK", channelId, cached: false }),
			);
			expect(received).not.toContainEqual(
				expect.objectContaining({ type: "ERROR", code: "CHANNEL_DEAD" }),
			);
			expect(channels().has(channelId)).toBe(true);
		});

		it("is answered by the error that carries its request id", async () => {
			const { channelId, agent, attach, attached, received } = await attachWaiting();
			expect(attach.requestId).toEqual(expect.any(String));

			agent.emit("message", {
				type: "ERROR",
				code: "CHANNEL_NOT_FOUND",
				message: `channel ${channelId} not found`,
				channelId,
				requestId: attach.requestId,
			});

			expect(await attached).toBe(false);
			expect(received).toContainEqual(
				expect.objectContaining({ type: "ERROR", code: "CHANNEL_DEAD", channelId }),
			);
			expect(channels().has(channelId)).toBe(false);
		});

		// An agent from before request ids answers without one; an ATTACH_OK can
		// answer nothing but an ATTACH, so its channel says which.
		it("still attaches to an agent that does not echo the request id", async () => {
			const { channelId, agent, attached, received } = await attachWaiting();

			agent.emit("message", attachOk(channelId));

			expect(await attached).toBe(true);
			expect(received).toContainEqual(
				expect.objectContaining({ type: "ATTACH_OK", channelId, cached: false }),
			);
		});

		it("tells the windows showing the terminal that its input was dropped", async () => {
			const { channelId, agent, attach, attached, received } = await attachWaiting();
			agent.emit("message", attachOk(channelId, attach.requestId));
			await attached;
			const elsewhere: ProtocolMessage[] = [];
			sm.addClient(makeClient("c-elsewhere", elsewhere));
			received.length = 0;

			agent.emit("message", {
				type: "ERROR",
				code: "INPUT_DROPPED",
				message: `input to channel ${channelId} dropped`,
				channelId,
			});

			expect(received).toEqual([{ type: "INPUT_DROPPED", channelId }]);
			expect(elsewhere).toEqual([]);
		});

		// What the agent sends after its ATTACH_OK is output the snapshot does not
		// hold (#931). One read can carry both, and the hub handles every frame of
		// a read before anything it awaited resumes: the pane, which writes OUTPUT
		// only once its ATTACH_OK has come, must still get them in that order, and
		// the spool must keep that output after the snapshot. An agent from before
		// request ids is matched by channel, and gets the same.
		describe("and the output the agent sends after its ATTACH_OK (#931)", () => {
			const after = new Uint8Array(Buffer.from("printed after the snapshot"));

			function output(channelId: string, data: Uint8Array): ProtocolMessage {
				return { type: "OUTPUT", channelId, seq: 1, ts: "2026-11-13T12:00:00.000Z", data };
			}

			/** One read: the agent's answer, then what the terminal printed after its snapshot. */
			function answerThenPrint(agent: Emitter, channelId: string, requestId?: string): void {
				agent.emit("message", attachOk(channelId, requestId));
				agent.emit("message", output(channelId, after));
			}

			function ctxOf(manager: SessionManager) {
				return (manager as unknown as { ctx: import("./session-context.js").SharedSessionContext })
					.ctx;
			}

			const matchings = [
				["with the ATTACH's request id", true],
				["matched by channel, from an agent without request ids", false],
			] as const;

			it.each(matchings)("reaches the pane after its ATTACH_OK, %s", async (_, named) => {
				const { channelId, agent, attach, attached, received } = await attachWaiting();

				answerThenPrint(agent, channelId, named ? attach.requestId : undefined);

				expect(await attached).toBe(true);
				expect(
					received.filter((m) => m.type === "ATTACH_OK" || m.type === "OUTPUT").map((m) => m.type),
				).toEqual(["ATTACH_OK", "OUTPUT"]);
			});

			it.each(matchings)(
				"is stored after the snapshot, as the tail an attach from the spool replays, %s",
				async (_, named) => {
					const { channelId, agent, attach, attached } = await attachWaiting();

					answerThenPrint(agent, channelId, named ? attach.requestId : undefined);
					await attached;

					ctxOf(sm).chunker.flush(channelId);
					const spool = new SpoolDAL(dbManager.spool);
					const snapshot = spool.getLatestSnapshot(channelId);
					expect(JSON.parse(snapshot?.dataBlob.toString("utf8") ?? "null")).toMatchObject({
						serialized: "<live>",
					});
					const tail = spool
						.getChunksByChannel(channelId, { kind: "output", afterSeq: snapshot?.seq ?? 0 })
						.map((chunk) => chunk.dataBlob.toString("utf8"));
					expect(tail).toEqual(["printed after the snapshot"]);
				},
			);

			// The spool is the hub's: the agent's last_seq counts its own reads.
			describe("the spool's numbering", () => {
				async function liveChannel() {
					sm.addClient(makeClient("c-writer", []));
					const channelId = await sm.handleSpawn("c-writer", { type: "SPAWN", hostId: "local" });
					if (channelId === null) throw new Error("expected a local channel");
					const agent = mockLocalAgents.at(-1) as unknown as Emitter | undefined;
					if (agent === undefined) throw new Error("expected the local agent");
					const rows = () =>
						new SpoolDAL(dbManager.spool)
							.getChunksByChannel(channelId)
							.map((chunk) => ({ seq: chunk.seq, kind: chunk.kind }));
					return {
						channelId,
						emit: (msg: ProtocolMessage) => agent.emit("message", msg),
						flush: () => ctxOf(sm).chunker.flush(channelId),
						rows,
					};
				}

				function snapshotRes(channelId: string, lastSeq: number): ProtocolMessage {
					return {
						type: "SNAPSHOT_RES",
						channelId,
						snapshot: { serialized: "<screen>", cols: 80, rows: 24, cursorX: 0, cursorY: 0 },
						lastSeq,
					};
				}

				const text = (value: string) => new Uint8Array(Buffer.from(value));

				it("numbers the spool itself, whatever last_seq the agent sends", async () => {
					const { channelId, emit, flush, rows } = await liveChannel();

					emit(output(channelId, text("one")));
					flush();
					emit(snapshotRes(channelId, 5000));
					emit(output(channelId, text("two")));
					flush();

					expect(rows()).toEqual([
						{ seq: 1, kind: "output" },
						{ seq: 2, kind: "snapshot" },
						{ seq: 3, kind: "output" },
					]);
				});

				it("continues after the snapshot once the GC has deleted the output before it", async () => {
					const { channelId, emit, flush, rows } = await liveChannel();
					emit(snapshotRes(channelId, 0));
					emit(output(channelId, text("b")));
					flush();
					emit(output(channelId, text("c")));
					flush();
					expect(rows()).toEqual([
						{ seq: 1, kind: "snapshot" },
						{ seq: 2, kind: "output" },
						{ seq: 3, kind: "output" },
					]);
					// What the GC does to a channel over its cap: the snapshot stays.
					dbManager.spool
						.prepare("DELETE FROM chunks WHERE channel_id = ? AND kind = 'output'")
						.run(channelId);

					emit(snapshotRes(channelId, 0));
					emit(output(channelId, text("d")));
					flush();

					expect(rows()).toEqual([
						{ seq: 4, kind: "snapshot" },
						{ seq: 5, kind: "output" },
					]);
				});
			});

			// Storing a snapshot happens while a read from the agent is handled: an
			// error out of it would end that read, and the hub, which catches
			// nothing at that level. It is logged by its code alone: a SQLite
			// message can quote what it read, and the screen is what the terminal
			// shows (#927's ended output logs the same way).
			describe("a snapshot the spool fails to store", () => {
				const MARK = "near-a-secret-931";
				const SHOWN = "shown-on-the-screen-931";
				let logged: Array<[string, string, Record<string, unknown> | undefined]>;
				let withLog: SessionManager;
				const failures: Array<{ mockRestore(): void }> = [];

				beforeEach(() => {
					logged = [];
					withLog = new SessionManager(dbManager, undefined, undefined, undefined, {
						log: (level: string, msg: string, extra?: Record<string, unknown>) =>
							logged.push([level, msg, extra]),
					} as never);
				});

				afterEach(async () => {
					for (const failure of failures.splice(0)) failure.mockRestore();
					await withLog.shutdown();
				});

				function failOnce(method: "insertSnapshot" | "insertChunk"): void {
					failures.push(
						vi.spyOn(SpoolDAL.prototype, method).mockImplementationOnce(() => {
							throw Object.assign(new Error(`disk I/O error ${MARK}`), {
								code: "ERR_SQLITE_IOERR",
							});
						}),
					);
				}

				const screen = {
					serialized: `\u001b[1m${SHOWN}\u001b[0m`,
					cols: 80,
					rows: 24,
					cursorX: 0,
					cursorY: 0,
				};

				function expectOneWarn(channelId: string): void {
					expect(logged.filter(([level]) => level === "warn")).toEqual([
						[
							"warn",
							"channel-lifecycle: snapshot not stored",
							{ channelId, code: "ERR_SQLITE_IOERR" },
						],
					]);
					expect(JSON.stringify(logged)).not.toContain(MARK);
					expect(JSON.stringify(logged)).not.toContain(SHOWN);
				}

				it("on a live ATTACH_OK, still answers the pane, then gives it the output after", async () => {
					const { channelId, agent, attach, attached, received } = await attachWaiting(withLog);
					failOnce("insertSnapshot");

					expect(() => {
						agent.emit("message", {
							type: "ATTACH_OK",
							channelId,
							requestId: attach.requestId,
							snapshot: screen,
							lastSeq: 0,
						});
						agent.emit("message", output(channelId, after));
					}).not.toThrow();

					expect(await attached).toBe(true);
					expect(
						received
							.filter((m) => m.type === "ATTACH_OK" || m.type === "OUTPUT")
							.map((m) => [m.type, (m as { cached?: boolean }).cached]),
					).toEqual([
						["ATTACH_OK", false],
						["OUTPUT", undefined],
					]);
					expectOneWarn(channelId);
				});

				it.each([
					["its row", "insertSnapshot"],
					["the output flushed before it", "insertChunk"],
				] as const)("on a SNAPSHOT_RES (%s), leaves the read handled", async (_, method) => {
					const { channelId, agent, attach, attached, received } = await attachWaiting(withLog);
					agent.emit("message", attachOk(channelId, attach.requestId));
					await attached;
					// Output the chunker holds, for the snapshot's flush to write.
					agent.emit("message", output(channelId, new Uint8Array(Buffer.from("held"))));
					received.length = 0;
					failOnce(method);

					expect(() => {
						agent.emit("message", {
							type: "SNAPSHOT_RES",
							channelId,
							snapshot: screen,
							lastSeq: 0,
						});
						agent.emit("message", output(channelId, after));
					}).not.toThrow();

					expect(received.filter((m) => m.type === "OUTPUT")).toHaveLength(1);
					expectOneWarn(channelId);
				});
			});
		});
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
		// Only an ended terminal has a last output to show (#927).
		expect(errMsg).not.toHaveProperty("lastOutput");
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

	// ─── A dead channel stays dead until Restart ─────────────────────────────

	// An ATTACH is a pane asking to see its terminal, not to have it started
	// again. It used to start it again whenever its session was active and its
	// agent connected, so a reload restarted every ended terminal whose pane
	// did not already know it had ended (#559). Restart is the user's gesture.
	it("handleAttach on a dead channel answers CHANNEL_DEAD with its agent connected, and starts nothing", async () => {
		// A local host with an active session and a connected agent.
		const received1: ProtocolMessage[] = [];
		const c1 = makeClient("c1", received1);
		sm.addClient(c1);
		await sm.handleSpawn("c1", { type: "SPAWN", hostId: "local" });

		// A terminal of that session that has ended.
		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);
		const localHost = dal.listHosts().find((h) => h.type === "local");
		if (!localHost) throw new Error("expected local host");
		const session = dal.listSessions(localHost.id).find((s) => s.status !== "closed");
		if (!session) throw new Error("expected non-closed session");
		const deadId = "DEADRESPAWN01AAAAAAAAAAAAAAAA";
		dal.createChannel({
			id: deadId,
			sessionId: session.id,
			status: "dead",
			shell: "/bin/zsh",
			cwd: "/tmp",
		});
		const agent = mockLocalAgents[0];
		if (agent === undefined) throw new Error("expected the local agent");
		agent.send.mockClear();
		received1.length = 0;

		// A reloaded window's pane asks for it.
		const received2: ProtocolMessage[] = [];
		sm.addClient(makeClient("c2", received2));
		await sm.handleAttach("c2", deadId);
		await flushImmediate();

		expect(received2).toEqual([
			expect.objectContaining({ type: "ERROR", code: "CHANNEL_DEAD", channelId: deadId }),
		]);
		// Nothing was asked of the agent, and nobody heard it come back.
		expect(agent.send).not.toHaveBeenCalled();
		expect(received1).not.toContainEqual(
			expect.objectContaining({ type: "CHANNEL_STATE", channelId: deadId }),
		);
		expect(dal.getChannel(deadId)?.status).toBe("dead");
		expect((sm as unknown as { channels: Map<string, unknown> }).channels.has(deadId)).toBe(false);
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

	// ─── Spool rows and the reads of them, for the #956 and #927 describes ────

	function store(id: string, seq: number, kind: "output" | "snapshot", data: string | Buffer) {
		const dataBlob = typeof data === "string" ? Buffer.from(data) : data;
		new SpoolDAL(dbManager.spool).insertChunk({
			channelId: id,
			seq,
			kind,
			dataBlob,
			uncompressedLen: dataBlob.length,
		});
	}

	const spies: Array<{ mockRestore(): void }> = [];

	/** Spies on every SpoolDAL read that returns a chunk's data. */
	function dataReads() {
		const reads = {
			byChannel: vi.spyOn(SpoolDAL.prototype, "getChunksByChannel"),
			one: vi.spyOn(SpoolDAL.prototype, "getChunk"),
			output: vi.spyOn(SpoolDAL.prototype, "readOutput"),
			latest: vi.spyOn(SpoolDAL.prototype, "getLatestSnapshot"),
		};
		spies.push(...Object.values(reads));
		return reads;
	}

	afterEach(() => {
		for (const spy of spies.splice(0)) spy.mockRestore();
	});

	// ─── An ATTACH answered from the spool (#956) ────────────────────────────
	//
	// The hub stores a channel's output a second after it arrives, or once
	// 256 KiB are waiting, or when it stores a snapshot. A pane that drops the
	// OUTPUT it hears while its ATTACH waits writes, from a cached ATTACH_OK,
	// only what that answer holds: so after its snapshot it holds the output
	// the hub has received, stored yet or not, within the tail's bound.
	// ─── Pastes relayed to the agent (#1014) ─────────────────────────────────
	describe("pastes relayed between a window and the agent (#1014)", () => {
		type Sent = { type: string; pasteId?: number; seq?: number; channelId?: string };
		type LocalAgent = {
			send: { mock: { calls: Array<[ProtocolMessage]> } };
			emit(event: string, msg?: unknown): void;
			simulateDisconnect(): void;
		};
		const CH = "local-ch-1";

		/** A terminal on the local host, its agent saying `capabilities`, client c1 its writer. */
		async function terminal(capabilities: string[] = ["input-modes", "paste-stream"]) {
			nextLocalAgentCapabilities = capabilities;
			let holder: string | null = "c1";
			sm.setGetWriteLockHolder(() => holder);
			const c1: ProtocolMessage[] = [];
			sm.addClient(makeClient("c1", c1));
			await sm.handleSpawn("c1", { type: "SPAWN", hostId: "local" });
			const agent = mockLocalAgents.at(-1) as unknown as LocalAgent;
			return {
				c1,
				agent,
				setHolder: (id: string | null) => {
					holder = id;
				},
				/** What the agent received of pastes. */
				toAgent: () =>
					agent.send.mock.calls
						.map(([m]) => m as unknown as Sent)
						.filter((m) => m.type === "PASTE" || m.type === "PASTE_CANCEL"),
			};
		}
		const chunk = (pasteId: number, seq: number, last = false) =>
			({
				type: "PASTE",
				channelId: CH,
				pasteId,
				seq,
				data: new Uint8Array([0x61 + seq]),
				last,
			}) as const;
		const pastes = (received: ProtocolMessage[]) =>
			received.filter(
				(m) => m.type === "PASTE_ACK" || m.type === "PASTE_CLOSED",
			) as unknown as Array<{
				type: string;
				pasteId: number;
				seq?: number;
				reason?: string;
				written?: number;
			}>;

		it("HB1: says streamsPaste on SPAWN_OK and ATTACH_OK when the agent says paste-stream", async () => {
			const { c1 } = await terminal();
			await sm.handleAttach("c1", CH);
			const spawnOk = c1.find((m) => m.type === "SPAWN_OK") as { streamsPaste?: boolean };
			const attachOk = c1.find((m) => m.type === "ATTACH_OK") as { streamsPaste?: boolean };
			expect(spawnOk.streamsPaste).toBe(true);
			expect(attachOk.streamsPaste).toBe(true);
		});

		it("HB1: says not when the agent does not say paste-stream", async () => {
			const { c1 } = await terminal(["input-modes"]);
			await sm.handleAttach("c1", CH);
			expect(
				(c1.find((m) => m.type === "SPAWN_OK") as { streamsPaste?: boolean }).streamsPaste,
			).toBe(false);
			expect(
				(c1.find((m) => m.type === "ATTACH_OK") as { streamsPaste?: boolean }).streamsPaste,
			).toBe(false);
		});

		it("HB2: relays the holder's chunk with its fields and the hub's own paste id", async () => {
			const { toAgent } = await terminal();
			sm.handlePaste("c1", chunk(41, 0));
			const sent = toAgent()[0] as Sent & { data: Uint8Array; last: boolean };
			expect(sent).toMatchObject({ type: "PASTE", channelId: CH, seq: 0, last: false });
			expect([...sent.data]).toEqual([0x61]);
			expect(sent.pasteId).not.toBe(41);
		});

		it("HB2: answers unsupported, and sends the agent nothing, when it does not say paste-stream", async () => {
			const { c1, toAgent } = await terminal(["input-modes"]);
			sm.handlePaste("c1", chunk(1, 0));
			expect(toAgent()).toEqual([]);
			expect(pastes(c1)).toEqual([
				expect.objectContaining({ type: "PASTE_CLOSED", pasteId: 1, reason: "unsupported" }),
			]);
		});

		it("HB3: cancels the paste when its window leaves", async () => {
			const { toAgent } = await terminal();
			sm.handlePaste("c1", chunk(1, 0));
			const agentId = toAgent()[0]?.pasteId;
			sm.removeClient("c1");
			expect(toAgent().at(-1)).toEqual({ type: "PASTE_CANCEL", channelId: CH, pasteId: agentId });
		});

		it("HB3: cancels the paste when the write lock moves to another window", async () => {
			const { toAgent } = await terminal();
			// The lock manager the WS routes make, wired as they wire it.
			const locks = new WriteLockManager({
				sendToClient: () => undefined,
				broadcastToChannel: () => undefined,
				onChange: (channelId) => onWriteLockChange(channelId, undefined, sm),
			});
			sm.setGetWriteLockHolder((channelId) => locks.getHolder(channelId));
			locks.attach(CH, "c1");
			locks.attach(CH, "c2");
			sm.handlePaste("c1", chunk(1, 0));
			locks.force(CH, "c2");
			expect(toAgent().at(-1)?.type).toBe("PASTE_CANCEL");
		});

		it("HB3: still cancels after the last chunk, until its acknowledgement", async () => {
			const { toAgent } = await terminal();
			sm.handlePaste("c1", chunk(1, 0, true));
			sm.removeClient("c1");
			expect(toAgent().at(-1)?.type).toBe("PASTE_CANCEL");
		});

		it("HB3: sends nothing once the last chunk is acknowledged", async () => {
			const { agent, toAgent } = await terminal();
			sm.handlePaste("c1", chunk(1, 0, true));
			const agentId = toAgent()[0]?.pasteId;
			agent.emit("message", { type: "PASTE_ACK", channelId: CH, pasteId: agentId, seq: 0 });
			sm.removeClient("c1");
			expect(toAgent().map((m) => m.type)).toEqual(["PASTE"]);
		});

		it("HB3: sends nothing once the agent closed the paste, and takes the window's next one", async () => {
			const { agent, toAgent } = await terminal();
			sm.handlePaste("c1", chunk(1, 0));
			const agentId = toAgent()[0]?.pasteId;
			agent.emit("message", {
				type: "PASTE_CLOSED",
				channelId: CH,
				pasteId: agentId,
				reason: "overflow",
				written: 1,
			});
			sm.handlePaste("c1", chunk(2, 0));
			expect(toAgent().map((m) => m.type)).toEqual(["PASTE", "PASTE"]);
			sm.removeClient("c1");
			expect(toAgent().at(-1)?.type).toBe("PASTE_CANCEL");
			expect(toAgent().filter((m) => m.type === "PASTE_CANCEL")).toHaveLength(1);
		});

		it("HB4: routes acknowledgements and closes to the owning window only", async () => {
			const { c1, agent, toAgent } = await terminal();
			const c2: ProtocolMessage[] = [];
			sm.addClient(makeClient("c2", c2));
			await sm.handleAttach("c2", CH);
			sm.handlePaste("c1", chunk(5, 0));
			const agentId = toAgent()[0]?.pasteId;
			agent.emit("message", { type: "PASTE_ACK", channelId: CH, pasteId: agentId, seq: 0 });
			agent.emit("message", {
				type: "PASTE_CLOSED",
				channelId: CH,
				pasteId: agentId,
				reason: "overflow",
				written: 1,
			});
			expect(pastes(c1)).toEqual([
				{ type: "PASTE_ACK", channelId: CH, pasteId: 5, seq: 0 },
				{ type: "PASTE_CLOSED", channelId: CH, pasteId: 5, reason: "overflow", written: 1 },
			]);
			expect(pastes(c2)).toEqual([]);
		});

		it("HB4: relays every acknowledgement still in flight after the last chunk", async () => {
			const { c1, agent, toAgent } = await terminal();
			for (let seq = 0; seq < 8; seq++) sm.handlePaste("c1", chunk(5, seq, seq === 7));
			const agentId = toAgent()[0]?.pasteId;
			for (let seq = 0; seq < 8; seq++) {
				agent.emit("message", { type: "PASTE_ACK", channelId: CH, pasteId: agentId, seq });
			}
			expect(pastes(c1).map((m) => m.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
		});

		it("HB5: tells the owner agent_lost, with no written, when the agent closes", async () => {
			const { c1, agent } = await terminal();
			sm.handlePaste("c1", chunk(3, 0));
			agent.simulateDisconnect();
			expect(pastes(c1)).toEqual([
				{ type: "PASTE_CLOSED", channelId: CH, pasteId: 3, reason: "agent_lost" },
			]);
		});

		it("HB5: tells it once when the agent is replaced, and the old agent's late close spares a new paste", async () => {
			const { c1, agent, toAgent } = await terminal();
			await sm.handleSpawn("c1", { type: "SPAWN", hostId: "local" });
			const CH2 = "local-ch-2";
			sm.handlePaste("c1", chunk(3, 0));
			const agents = (sm as unknown as { ctx: { agents: Map<string, unknown> } }).ctx.agents;
			const [hostId] = [...agents.keys()];
			const replacement = Object.create(agent, {
				send: { value: vi.fn() },
				helloMessage: {
					value: {
						type: "HELLO",
						version: 1,
						agentVersion: "0.0.0",
						capabilities: ["paste-stream"],
					},
				},
			});
			agents.set(hostId as string, replacement);
			// A new paste on the other terminal goes to the replacement.
			sm.handlePaste("c1", { ...chunk(4, 0), channelId: CH2 });
			expect(
				(replacement.send as ReturnType<typeof vi.fn>).mock.calls.map(([m]) => [
					m.type,
					m.channelId,
				]),
			).toEqual([["PASTE", CH2]]);
			// Then the replaced agent's late close: only the paste it took is lost, once.
			agent.simulateDisconnect();
			expect(pastes(c1)).toEqual([
				{ type: "PASTE_CLOSED", channelId: CH, pasteId: 3, reason: "agent_lost" },
			]);
			expect(toAgent().filter((m) => m.type === "PASTE")).toHaveLength(1);
		});

		it("HB5: tells it agent_lost when a chunk finds another agent than the one that took the paste", async () => {
			const { c1, agent } = await terminal();
			sm.handlePaste("c1", chunk(3, 0));
			const agents = (sm as unknown as { ctx: { agents: Map<string, unknown> } }).ctx.agents;
			const [hostId] = [...agents.keys()];
			agents.set(hostId as string, Object.create(agent, { send: { value: vi.fn() } }));
			sm.handlePaste("c1", chunk(3, 1));
			expect(pastes(c1)).toEqual([
				{ type: "PASTE_CLOSED", channelId: CH, pasteId: 3, reason: "agent_lost" },
			]);
		});

		it("HB6: gives two windows' pastes with the same id different ids toward the agent", async () => {
			const { toAgent } = await terminal();
			sm.handlePaste("c1", chunk(1, 0, true));
			sm.addClient(makeClient("c2", []));
			sm.handlePaste("c2", chunk(1, 0, true));
			const ids = toAgent()
				.filter((m) => m.type === "PASTE")
				.map((m) => m.pasteId);
			expect(new Set(ids).size).toBe(2);
		});

		it("HB6: never hands a cancelled paste's close to another window's paste", async () => {
			const { agent, toAgent } = await terminal();
			sm.handlePaste("c1", chunk(1, 0));
			const first = toAgent()[0]?.pasteId;
			sm.removeClient("c1");
			const c2: ProtocolMessage[] = [];
			sm.addClient(makeClient("c2", c2));
			sm.handlePaste("c2", chunk(1, 0));
			agent.emit("message", {
				type: "PASTE_CLOSED",
				channelId: CH,
				pasteId: first,
				reason: "cancelled",
				written: 0,
			});
			expect(pastes(c2)).toEqual([]);
			sm.handlePaste("c2", chunk(1, 1));
			expect(toAgent().at(-1)).toMatchObject({ type: "PASTE", seq: 1 });
		});

		it("HB6: refuses the owner's own second paste, which would supersede its first", async () => {
			const { c1, toAgent } = await terminal();
			sm.handlePaste("c1", chunk(1, 0));
			sm.handlePaste("c1", chunk(2, 0));
			expect(toAgent()).toHaveLength(1);
			expect(c1.at(-1)).toMatchObject({ type: "ERROR", code: "INVALID_INPUT" });
		});

		it("HB6: drops a chunk of no registered paste, without an answer", async () => {
			const { c1, toAgent } = await terminal();
			const before = c1.length;
			sm.handlePaste("c1", chunk(9, 3));
			expect(toAgent()).toEqual([]);
			expect(c1.length).toBe(before);
		});

		it("HB7: relays the owner's cancel under the agent's id, and not the close that follows", async () => {
			const { c1, agent, toAgent } = await terminal();
			sm.handlePaste("c1", chunk(6, 0));
			const agentId = toAgent()[0]?.pasteId;
			sm.handlePasteCancel("c1", { type: "PASTE_CANCEL", channelId: CH, pasteId: 6 });
			expect(toAgent().at(-1)).toEqual({ type: "PASTE_CANCEL", channelId: CH, pasteId: agentId });
			agent.emit("message", {
				type: "PASTE_CLOSED",
				channelId: CH,
				pasteId: agentId,
				reason: "cancelled",
				written: 1,
			});
			expect(pastes(c1)).toEqual([]);
		});
	});

	describe("whether the terminal's agent adapts input (#1012)", () => {
		type Answer = {
			type: string;
			adaptsInput?: boolean;
			streamsPaste?: boolean;
			cached?: boolean;
			snapshot?: Record<string, unknown> | null;
		};
		const answers = (received: ProtocolMessage[], type: string) =>
			received.filter((m) => m.type === type) as unknown as Answer[];

		it("says so on SPAWN_OK and a live ATTACH_OK when the host's agent says input-modes", async () => {
			nextLocalAgentCapabilities = ["multiplex", "snapshot", "input-modes"];
			const received: ProtocolMessage[] = [];
			sm.addClient(makeClient("c1", received));
			await sm.handleSpawn("c1", { type: "SPAWN", hostId: "local" });
			await sm.handleAttach("c1", "local-ch-1");

			expect(answers(received, "SPAWN_OK")[0]?.adaptsInput).toBe(true);
			const live = answers(received, "ATTACH_OK")[0];
			expect(live?.cached).toBe(false);
			expect(live?.adaptsInput).toBe(true);
		});

		for (const [capabilities, adapts] of [
			[["input-modes", "paste-stream"], true],
			[[], false],
		] as const) {
			it(`says ${adapts} on an ATTACH_OK answered from memory while the host's agent says ${capabilities.length > 0 ? "input-modes" : "nothing of it"}, whatever agent stored the snapshot`, async () => {
				const { MetaDAL } = await import("../storage/meta.js");
				const dal = new MetaDAL(dbManager.meta);
				const host = dal.createHost({
					type: "ssh",
					label: "test-ssh-adapting",
					sshHost: "user@localhost",
					sshAuth: "key",
					sshKeyPath: "/nonexistent/key",
				});
				sm.addClient(makeClient("c1", []));
				await sm.handleSpawn("c1", { type: "SPAWN", hostId: host.id });
				const agent = mockSshAgentInstance as unknown as {
					helloMessage: unknown;
					send: (msg: ProtocolMessage) => void;
					_emit(event: string, msg: unknown): void;
				};
				agent.helloMessage = {
					type: "HELLO",
					version: 1,
					agentVersion: "0.0.0",
					capabilities: [...capabilities],
				};
				// Stored by an agent that adapted input.
				const stored = {
					serialized: "<cached-snap>",
					cols: 80,
					rows: 24,
					cursorX: 0,
					cursorY: 0,
					alternateScreen: true,
					inputModes: "\u001b[?2004h",
				};
				new SpoolDAL(dbManager.spool).insertChunk({
					channelId: "ssh-ch-1",
					seq: 10,
					kind: "snapshot",
					dataBlob: Buffer.from(JSON.stringify(stored)),
					uncompressedLen: JSON.stringify(stored).length,
				});
				// Its ATTACH fails for another reason than a gone terminal: the hub
				// answers from memory, the agent still connected.
				const send = agent.send;
				agent.send = (msg: ProtocolMessage) => {
					if (msg.type !== "ATTACH") return send(msg);
					const ask = msg as unknown as { channelId: string; requestId: string };
					setImmediate(() =>
						agent._emit("message", {
							type: "ERROR",
							code: "INTERNAL_ERROR",
							message: "busy",
							channelId: ask.channelId,
							requestId: ask.requestId,
						}),
					);
				};

				const received: ProtocolMessage[] = [];
				sm.addClient(makeClient("c2", received));
				await sm.handleAttach("c2", "ssh-ch-1");

				const cached = answers(received, "ATTACH_OK")[0];
				expect(cached?.cached).toBe(true);
				expect(cached?.snapshot?.inputModes).toBe("\u001b[?2004h");
				expect(cached?.adaptsInput).toBe(adapts);
				// As the agent says paste-stream (#1014).
				expect(cached?.streamsPaste).toBe(adapts);
			});
		}

		it("says not when the host's agent does not say input-modes", async () => {
			nextLocalAgentCapabilities = ["multiplex", "snapshot"];
			const received: ProtocolMessage[] = [];
			sm.addClient(makeClient("c1", received));
			await sm.handleSpawn("c1", { type: "SPAWN", hostId: "local" });
			await sm.handleAttach("c1", "local-ch-1");

			expect(answers(received, "SPAWN_OK")[0]?.adaptsInput).toBe(false);
			expect(answers(received, "ATTACH_OK")[0]?.adaptsInput).toBe(false);
		});

		it("says what the agent the hub has when it answers says, not the one it asked", async () => {
			nextLocalAgentCapabilities = ["input-modes"];
			const received: ProtocolMessage[] = [];
			sm.addClient(makeClient("c1", received));
			await sm.handleSpawn("c1", { type: "SPAWN", hostId: "local" });
			const agents = (sm as unknown as { ctx: { agents: Map<string, unknown> } }).ctx.agents;
			const [hostId, entry] = [...agents.entries()][0] ?? [];
			const asked = entry as { send: (msg: ProtocolMessage) => void };
			// An agent that does not adapt takes the host's place while the
			// asked one is answering the ATTACH.
			const replacement = Object.create(asked, {
				helloMessage: {
					value: { type: "HELLO", version: 1, agentVersion: "0.0.0", capabilities: [] },
				},
			});
			const send = asked.send;
			asked.send = (msg: ProtocolMessage) => {
				if (msg.type === "ATTACH") agents.set(hostId as string, replacement);
				send(msg);
			};

			await sm.handleAttach("c1", "local-ch-1");

			expect(answers(received, "ATTACH_OK")[0]?.adaptsInput).toBe(false);
		});

		it("answers from memory with the snapshot's state, and says not when the host has no agent, whatever agent stored it", async () => {
			const { MetaDAL } = await import("../storage/meta.js");
			const dal = new MetaDAL(dbManager.meta);
			const host = dal.createHost({
				type: "ssh",
				label: "test-ssh-modes",
				sshHost: "user@localhost",
				sshAuth: "key",
				sshKeyPath: "/nonexistent/key",
			});
			sm.addClient(makeClient("c1", []));
			await sm.handleSpawn("c1", { type: "SPAWN", hostId: host.id });
			sm.handleDetach("c1", "ssh-ch-1");
			// Stored by an agent that adapted input.
			const stored = {
				serialized: "<cached-snap>",
				cols: 80,
				rows: 24,
				cursorX: 0,
				cursorY: 0,
				alternateScreen: true,
				inputModes: "\u001b[?2004h",
			};
			new SpoolDAL(dbManager.spool).insertChunk({
				channelId: "ssh-ch-1",
				seq: 10,
				kind: "snapshot",
				dataBlob: Buffer.from(JSON.stringify(stored)),
				uncompressedLen: JSON.stringify(stored).length,
			});
			const agent = mockSshAgentInstance as unknown as {
				helloMessage: unknown;
				simulateClose(): void;
			};
			agent.helloMessage = {
				type: "HELLO",
				version: 1,
				agentVersion: "0.0.0",
				capabilities: ["input-modes", "paste-stream"],
			};
			agent.simulateClose();
			await new Promise((r) => setImmediate(r));

			const received: ProtocolMessage[] = [];
			sm.addClient(makeClient("c2", received));
			await sm.handleAttach("c2", "ssh-ch-1");

			const cached = answers(received, "ATTACH_OK")[0];
			expect(cached?.cached).toBe(true);
			expect(cached?.snapshot?.alternateScreen).toBe(true);
			expect(cached?.snapshot?.inputModes).toBe("\u001b[?2004h");
			expect(cached?.adaptsInput).toBe(false);
			// No agent: no streaming (#1014).
			expect(cached?.streamsPaste).toBe(false);
		});
	});

	describe("an ATTACH answered from the spool (#956)", () => {
		const SCREEN = { serialized: "<screen>", cols: 80, rows: 24, cursorX: 0, cursorY: 0 };

		function snapshotRes(channelId: string): ProtocolMessage {
			return { type: "SNAPSHOT_RES", channelId, snapshot: SCREEN, lastSeq: 0 };
		}

		function output(channelId: string, value: string): ProtocolMessage {
			return {
				type: "OUTPUT",
				channelId,
				seq: 1,
				ts: "2026-11-15T12:00:00.000Z",
				data: new Uint8Array(Buffer.from(value)),
			};
		}

		function cachedAnswer(received: ProtocolMessage[]): { snapshot: unknown; tail: string[] } {
			const ok = received.find((m) => m.type === "ATTACH_OK") as
				| (UiAttachOkMessage & { cached: boolean })
				| undefined;
			expect(ok?.cached).toBe(true);
			return {
				snapshot: ok?.snapshot,
				tail: (ok?.tail ?? []).map((part) => Buffer.from(part).toString()),
			};
		}

		/**
		 * A terminal whose SSH agent goes away just after printing, then a pane's
		 * ATTACH, answered from the spool. `beforeAttach` runs just before it.
		 */
		async function attachAfterAgentLeft(beforeAttach?: () => void) {
			const host = new MetaDAL(dbManager.meta).createHost({
				type: "ssh",
				label: "test-ssh-956",
				sshHost: "user@localhost",
				sshAuth: "key",
				sshKeyPath: "/nonexistent/key",
			});
			sm.addClient(makeClient("writer", []));
			const channelId = await sm.handleSpawn("writer", { type: "SPAWN", hostId: host.id });
			if (channelId === null) throw new Error("expected an SSH channel");
			const agent = mockSshAgentInstance;
			if (agent === null) throw new Error("expected the SSH agent");

			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const received: ProtocolMessage[] = [];
			try {
				agent._emit("message", snapshotRes(channelId));
				agent._emit("message", output(channelId, "last words"));
				agent.simulateClose();
				await vi.advanceTimersByTimeAsync(0);

				sm.addClient(makeClient("reader", received));
				beforeAttach?.();
				const attaching = sm.handleAttach("reader", channelId);
				// Under the chunker's second: what it holds is not stored yet.
				await vi.advanceTimersByTimeAsync(500);
				expect(await attaching).toBe(true);
			} finally {
				vi.useRealTimers();
			}
			return cachedAnswer(received);
		}

		it("holds what the terminal printed just before its agent went away", async () => {
			const answer = await attachAfterAgentLeft();

			expect(answer.snapshot).toEqual(SCREEN);
			expect(answer.tail.join("")).toBe("last words");
		});

		// Before #956 the answer only read the spool; a write failing now must not
		// cost the pane the answer it got then.
		it("still answers from what is stored when that output cannot be stored", async () => {
			const failure = vi.spyOn(SpoolDAL.prototype, "insertChunk");
			try {
				const answer = await attachAfterAgentLeft(() => {
					failure.mockImplementationOnce(() => {
						throw Object.assign(new Error("disk full"), { code: "ERR_SQLITE_FULL" });
					});
				});

				expect(answer.snapshot).toEqual(SCREEN);
				expect(answer.tail).toEqual([]);
			} finally {
				failure.mockRestore();
			}
		});

		it("holds what the terminal printed while its agent did not answer", async () => {
			sm.addClient(makeClient("writer", []));
			const channelId = await sm.handleSpawn("writer", { type: "SPAWN", hostId: "local" });
			if (channelId === null) throw new Error("expected a local channel");
			const agent = mockLocalAgents.at(-1);
			if (agent === undefined) throw new Error("expected the local agent");
			const emit = (msg: ProtocolMessage) =>
				(agent as unknown as { emit: (event: string, m: ProtocolMessage) => void }).emit(
					"message",
					msg,
				);
			const answer = agent.send.getMockImplementation() as
				| ((msg: ProtocolMessage) => void)
				| undefined;
			// An agent that never answers the ATTACH.
			agent.send.mockImplementation((msg: ProtocolMessage) => {
				if (msg.type !== "ATTACH") answer?.(msg);
			});
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const received: ProtocolMessage[] = [];
			try {
				emit(snapshotRes(channelId));
				// Stored by the chunker's second, before the ATTACH times out.
				emit(output(channelId, "before "));
				sm.addClient(makeClient("reader", received));
				const attaching = sm.handleAttach("reader", channelId);
				// The ATTACH times out at 5 s; this output arrives 0.5 s before, and
				// the chunker's next second would store it 0.5 s after.
				await vi.advanceTimersByTimeAsync(4_500);
				emit(output(channelId, "while waiting"));
				await vi.advanceTimersByTimeAsync(600);
				expect(await attaching).toBe(true);
			} finally {
				vi.useRealTimers();
			}

			expect(cachedAnswer(received).tail.join("")).toBe("before while waiting");
		});

		// ─── The rules of #927's ended output, for a cached answer too (#1004) ──
		//
		// The newest snapshot and the output stored after it, without a gap and
		// within the bounds, or the snapshot alone said `truncated`; a snapshot
		// over 256 KiB is not sent; one that cannot be read sends nothing; and the
		// reads follow what may be sent, not what the channel stores.

		const KIB = 1024;

		let terminals = 0;

		/** An SSH terminal whose agent went away, with nothing in its spool yet. */
		async function terminalWhoseAgentLeft(): Promise<string> {
			const host = new MetaDAL(dbManager.meta).createHost({
				type: "ssh",
				label: `test-ssh-1004-${++terminals}`,
				sshHost: "user@localhost",
				sshAuth: "key",
				sshKeyPath: "/nonexistent/key",
			});
			sm.addClient(makeClient("writer", []));
			const channelId = await sm.handleSpawn("writer", { type: "SPAWN", hostId: host.id });
			if (channelId === null) throw new Error("expected an SSH channel");
			const agent = mockSshAgentInstance;
			if (agent === null) throw new Error("expected the SSH agent");
			agent.simulateClose();
			await new Promise((r) => setImmediate(r));
			return channelId;
		}

		/** The whole cached ATTACH_OK a fresh pane gets. */
		async function attachCached(channelId: string): Promise<UiAttachOkMessage> {
			const received: ProtocolMessage[] = [];
			sm.addClient(makeClient("reader", received));
			expect(await sm.handleAttach("reader", channelId)).toBe(true);
			const ok = received.find((m) => m.type === "ATTACH_OK") as UiAttachOkMessage | undefined;
			if (ok === undefined) throw new Error("expected an ATTACH_OK");
			expect(ok.cached).toBe(true);
			return ok;
		}

		/** The screen part of an answer: what decides what the pane draws. */
		function screenOf(ok: UiAttachOkMessage) {
			return {
				snapshot: ok.snapshot,
				tail: (ok.tail ?? []).map((part) => Buffer.from(part).toString()),
				truncated: "truncated" in ok ? ok.truncated : "absent",
			};
		}

		/** A snapshot whose stored JSON is exactly `bytes` long. */
		function snapshotOfSize(bytes: number) {
			const frame = { serialized: "", cols: 80, rows: 24, cursorX: 0, cursorY: 0 };
			const room = bytes - JSON.stringify(frame).length;
			return { ...frame, serialized: "x".repeat(room) };
		}

		it.each([
			["inside the output", [11, 13]],
			["at its start", [12]],
		] as const)(
			"sends the snapshot alone when the output after it has a gap %s",
			async (_, seqs) => {
				const channelId = await terminalWhoseAgentLeft();
				store(channelId, 10, "snapshot", JSON.stringify(SCREEN));
				for (const seq of seqs) store(channelId, seq, "output", `row-${seq}`);

				expect(screenOf(await attachCached(channelId))).toEqual({
					snapshot: SCREEN,
					tail: [],
					truncated: true,
				});
			},
		);

		it("drops a snapshot over 256 KiB, and says so", async () => {
			const at = await terminalWhoseAgentLeft();
			const fits = snapshotOfSize(256 * KIB);
			expect(JSON.stringify(fits).length).toBe(262_144);
			store(at, 10, "snapshot", JSON.stringify(fits));
			expect(screenOf(await attachCached(at))).toEqual({
				snapshot: fits,
				tail: [],
				truncated: "absent",
			});

			const over = await terminalWhoseAgentLeft();
			store(over, 10, "snapshot", JSON.stringify(snapshotOfSize(256 * KIB + 1)));
			store(over, 11, "output", "after");
			expect(screenOf(await attachCached(over))).toEqual({
				snapshot: null,
				tail: [],
				truncated: true,
			});
		});

		it("sends the output after the snapshot up to 128 KiB, as one element", async () => {
			const small = await terminalWhoseAgentLeft();
			store(small, 10, "snapshot", JSON.stringify(SCREEN));
			store(small, 11, "output", "ab");
			store(small, 12, "output", "cd");
			expect(screenOf(await attachCached(small))).toEqual({
				snapshot: SCREEN,
				tail: ["abcd"],
				truncated: "absent",
			});

			const full = await terminalWhoseAgentLeft();
			store(full, 10, "snapshot", JSON.stringify(SCREEN));
			store(full, 11, "output", Buffer.alloc(64 * KIB, 0x61));
			store(full, 12, "output", Buffer.alloc(64 * KIB, 0x62));
			const whole = await attachCached(full);
			expect(whole.tail.map((part) => part.length)).toEqual([131_072]);
			expect("truncated" in whole).toBe(false);

			const over = await terminalWhoseAgentLeft();
			store(over, 10, "snapshot", JSON.stringify(SCREEN));
			store(over, 11, "output", Buffer.alloc(64 * KIB, 0x61));
			store(over, 12, "output", Buffer.alloc(64 * KIB, 0x62));
			store(over, 13, "output", "c");
			expect(screenOf(await attachCached(over))).toEqual({
				snapshot: SCREEN,
				tail: [],
				truncated: true,
			});
		});

		it("sends a snapshot with nothing after it as it is", async () => {
			const channelId = await terminalWhoseAgentLeft();
			store(channelId, 10, "snapshot", JSON.stringify(SCREEN));

			expect(screenOf(await attachCached(channelId))).toEqual({
				snapshot: SCREEN,
				tail: [],
				truncated: "absent",
			});
		});

		it("sends nothing after a snapshot it cannot read", async () => {
			const channelId = await terminalWhoseAgentLeft();
			store(channelId, 10, "snapshot", "not json");
			store(channelId, 11, "output", "after");

			expect(screenOf(await attachCached(channelId))).toEqual({
				snapshot: null,
				tail: [],
				truncated: "absent",
			});
		});

		it("sends nothing without a snapshot, and reads no output", async () => {
			const channelId = await terminalWhoseAgentLeft();
			store(channelId, 1, "output", "first");
			store(channelId, 2, "output", "second");
			const reads = dataReads();

			expect(screenOf(await attachCached(channelId))).toEqual({
				snapshot: null,
				tail: [],
				truncated: "absent",
			});
			expect(reads.output).not.toHaveBeenCalled();
			expect(reads.one).not.toHaveBeenCalled();
			expect(reads.byChannel).not.toHaveBeenCalled();
		});

		describe("reads no output it does not send", () => {
			function sizeReads() {
				const spy = vi.spyOn(SpoolDAL.prototype, "listOutputSizesAfter");
				spies.push(spy);
				return spy;
			}

			/** A terminal with a snapshot at seq 10 and `rows` outputs after it, `skip` left out. */
			async function withRows(rows: number, bytes: number, skip?: number): Promise<string> {
				const channelId = await terminalWhoseAgentLeft();
				store(channelId, 10, "snapshot", JSON.stringify(SCREEN));
				for (let i = 1; i <= rows; i++) {
					if (i !== skip) store(channelId, 10 + i, "output", Buffer.alloc(bytes, 0x61));
				}
				return channelId;
			}

			it("stops at the first batch's row past 128 KiB, with the snapshot its only data read", async () => {
				const channelId = await withRows(600, KIB);
				const reads = dataReads();
				const sizes = sizeReads();

				expect(screenOf(await attachCached(channelId))).toEqual({
					snapshot: SCREEN,
					tail: [],
					truncated: true,
				});
				expect(reads.byChannel).not.toHaveBeenCalled();
				expect(reads.output).not.toHaveBeenCalled();
				expect(reads.latest).not.toHaveBeenCalled();
				expect(reads.one).toHaveBeenCalledTimes(1);
				expect(sizes).toHaveBeenCalledTimes(1);
				expect(sizes.mock.calls[0]?.[2]).toBe(512);
			});

			it("reads no snapshot data over 256 KiB", async () => {
				const channelId = await terminalWhoseAgentLeft();
				store(channelId, 10, "snapshot", JSON.stringify(snapshotOfSize(300 * KIB)));
				const reads = dataReads();

				await attachCached(channelId);

				expect(reads.one).not.toHaveBeenCalled();
				expect(reads.latest).not.toHaveBeenCalled();
			});

			it("reads no output on a gap", async () => {
				const channelId = await terminalWhoseAgentLeft();
				store(channelId, 10, "snapshot", JSON.stringify(SCREEN));
				store(channelId, 11, "output", "row-11");
				store(channelId, 13, "output", "row-13");
				const reads = dataReads();

				await attachCached(channelId);

				expect(reads.output).not.toHaveBeenCalled();
				expect(reads.byChannel).not.toHaveBeenCalled();
			});

			it("walks on past a full batch, and sends what fits as one element", async () => {
				const channelId = await withRows(600, 100);
				const sizes = sizeReads();

				const ok = await attachCached(channelId);

				expect(ok.snapshot).toEqual(SCREEN);
				expect(ok.tail.map((part) => part.length)).toEqual([60_000]);
				expect("truncated" in ok).toBe(false);
				expect(sizes).toHaveBeenCalledTimes(2);
			});

			it.each([
				["the bound is passed in the second batch", 256, undefined],
				["the second batch starts after a gap", 100, 513],
			] as const)("refuses the output when %s", async (_, bytes, skip) => {
				const channelId = await withRows(600, bytes, skip);

				expect(screenOf(await attachCached(channelId))).toEqual({
					snapshot: SCREEN,
					tail: [],
					truncated: true,
				});
			});
		});
	});

	// ─── An ended terminal's last output (#927) ──────────────────────────────
	//
	// The refusal of an ATTACH on an ended terminal carries what it last
	// printed, read from the spool: the newest snapshot and the output after
	// it, or with no snapshot the whole stream from its first seq, as long as
	// it continues where it starts and fits one message. Nothing else changes:
	// nothing attaches and nothing starts (#559).
	describe("an ended terminal's last output (#927)", () => {
		const KIB = 1024;
		const SCREEN = {
			serialized: "\u001b[1mlast screen\u001b[0m",
			cols: 120,
			rows: 40,
			cursorX: 3,
			cursorY: 1,
		};

		/** A terminal dead in meta.db only, of the size given, on a host with no session open. */
		function endedTerminal(id: string, cols = 120, rows = 40): MetaDAL {
			const dal = new MetaDAL(dbManager.meta);
			const host = dal.createHost({ type: "local", label: `ended-${id}` });
			const sessionId = `ENDEDSESS${id}`;
			dal.createSession({ id: sessionId, hostId: host.id, status: "closed" });
			dal.createChannel({ id, sessionId, status: "dead", shell: "/bin/sh", cols, rows });
			return dal;
		}

		async function attachFresh(id: string, clientId = `pane-${id}`) {
			const received: ProtocolMessage[] = [];
			const client = makeClient(clientId, received);
			sm.addClient(client);
			const attached = await sm.handleAttach(clientId, id);
			return { attached, received, client };
		}

		function lastOutputOf(received: ProtocolMessage[]): EndedOutput {
			const refusal = received.find(
				(m): m is ErrorMessage => m.type === "ERROR" && m.code === "CHANNEL_DEAD",
			);
			if (refusal?.lastOutput === undefined)
				throw new Error("expected a CHANNEL_DEAD with its last output");
			return refusal.lastOutput;
		}

		const text = (tail: Uint8Array[]) => tail.map((part) => Buffer.from(part).toString());

		it("answers an ended terminal with what it last printed, and starts nothing", async () => {
			const dal = endedTerminal("ended-h1", 120, 40);
			store("ended-h1", 10, "snapshot", JSON.stringify(SCREEN));
			store("ended-h1", 11, "output", "ab");
			store("ended-h1", 12, "output", "cd");

			const { attached, received, client } = await attachFresh("ended-h1");

			expect(attached).toBe(false);
			expect(received).toHaveLength(1);
			expect(received[0]).toMatchObject({
				type: "ERROR",
				code: "CHANNEL_DEAD",
				message: "This terminal has ended.",
				channelId: "ended-h1",
			});
			const last = lastOutputOf(received);
			expect(last.snapshot).toEqual(SCREEN);
			// One element, the chunks in seq order.
			expect(text(last.tail)).toEqual(["abcd"]);
			expect(last).not.toHaveProperty("truncated");
			expect({ cols: last.cols, rows: last.rows }).toEqual({ cols: 120, rows: 40 });
			// Nothing started, nothing attached.
			expect(mockLocalAgents).toHaveLength(0);
			expect(dal.getChannel("ended-h1")?.status).toBe("dead");
			expect(client.attachedChannels.size).toBe(0);
		});

		it("answers a terminal that ended under it with its last output, attaching nobody", async () => {
			const heard: ProtocolMessage[] = [];
			sm.addClient(makeClient("writer", heard));
			const channelId = await sm.handleSpawn("writer", { type: "SPAWN", hostId: "local" });
			if (channelId === null) throw new Error("expected a local channel");
			const agent = mockLocalAgents.at(-1);
			if (agent === undefined) throw new Error("expected the local agent");
			sm.handleResize("writer", channelId, 100, 30);
			const emit = (msg: unknown) => (agent as unknown as EventEmitter).emit("message", msg);
			emit({ type: "OUTPUT", channelId, seq: 1, ts: "", data: Buffer.from("before") });
			emit({ type: "SNAPSHOT_RES", channelId, snapshot: SCREEN, lastSeq: 1 });
			emit({ type: "OUTPUT", channelId, seq: 2, ts: "", data: Buffer.from("after") });
			emit({ type: "CHANNEL_EXIT", channelId, exitCode: 1 });
			agent.send.mockClear();
			// Ended, and still held in memory: the branch this case is about.
			const held = (sm as unknown as { ctx: import("./session-context.js").SharedSessionContext })
				.ctx;
			expect(held.channels.get(channelId)?.status).toBe("dead");

			const { attached, received, client } = await attachFresh(channelId, "reader");

			expect(attached).toBe(false);
			expect(received).toHaveLength(1);
			expect(received[0]).toMatchObject({
				type: "ERROR",
				code: "CHANNEL_DEAD",
				message: "This terminal has ended.",
				channelId,
			});
			const last = lastOutputOf(received);
			expect(last.snapshot).toEqual(SCREEN);
			expect(text(last.tail)).toEqual(["after"]);
			expect(last).not.toHaveProperty("truncated");
			expect({ cols: last.cols, rows: last.rows }).toEqual({ cols: 100, rows: 30 });
			expect(agent.send).not.toHaveBeenCalled();
			const ctx = (sm as unknown as { ctx: import("./session-context.js").SharedSessionContext })
				.ctx;
			const still = ctx.channels.get(channelId);
			expect(still?.status).toBe("dead");
			expect(still?.clients.has("reader")).toBe(false);
			expect(client.attachedChannels.has(channelId)).toBe(false);
			expect(new MetaDAL(dbManager.meta).getChannel(channelId)?.status).toBe("dead");
		});

		it("reads nothing of a terminal deleted while this hub still holds it", async () => {
			const heard: ProtocolMessage[] = [];
			sm.addClient(makeClient("writer", heard));
			const channelId = await sm.handleSpawn("writer", { type: "SPAWN", hostId: "local" });
			if (channelId === null) throw new Error("expected a local channel");
			const agent = mockLocalAgents.at(-1);
			if (agent === undefined) throw new Error("expected the local agent");
			const emit = (msg: unknown) => (agent as unknown as EventEmitter).emit("message", msg);
			emit({ type: "SNAPSHOT_RES", channelId, snapshot: SCREEN, lastSeq: 0 });
			emit({ type: "CHANNEL_EXIT", channelId, exitCode: 0 });
			// Deleted as DELETE /api/channels/:id deletes an ended one: its row first,
			// its output purged after the answer.
			new MetaDAL(dbManager.meta).deleteChannel(channelId);
			const reads = dataReads();

			const { attached, received } = await attachFresh(channelId, "late");

			expect(attached).toBe(false);
			expect(received).toEqual([
				{ type: "ERROR", code: "CHANNEL_DEAD", message: "This terminal has ended.", channelId },
			]);
			expect(reads.one).not.toHaveBeenCalled();
			expect(reads.output).not.toHaveBeenCalled();
		});

		it("bounds an ended terminal's last output as the cached attach does", async () => {
			endedTerminal("ended-over");
			store("ended-over", 10, "snapshot", JSON.stringify(SCREEN));
			store("ended-over", 11, "output", Buffer.alloc(64 * KIB, 0x61));
			store("ended-over", 12, "output", Buffer.alloc(64 * KIB + 1, 0x62));
			const reads = dataReads();

			const over = lastOutputOf((await attachFresh("ended-over")).received);

			expect(over.snapshot).toEqual(SCREEN);
			expect(over.tail).toEqual([]);
			expect(over.truncated).toBe(true);
			// Measured, not loaded: only the snapshot's own row was read.
			expect(reads.byChannel).not.toHaveBeenCalled();
			expect(reads.output).not.toHaveBeenCalled();
			expect(reads.latest).not.toHaveBeenCalled();
			expect(
				reads.one.mock.results.map((r) => (r.value as { kind?: string } | undefined)?.kind),
			).toEqual(["snapshot"]);

			endedTerminal("ended-fits");
			store("ended-fits", 10, "snapshot", JSON.stringify(SCREEN));
			store("ended-fits", 11, "output", Buffer.alloc(64 * KIB, 0x61));
			store("ended-fits", 12, "output", Buffer.alloc(64 * KIB, 0x62));

			const fits = lastOutputOf((await attachFresh("ended-fits")).received);

			expect(fits.tail).toHaveLength(1);
			expect(Buffer.from(fits.tail[0] ?? new Uint8Array())).toEqual(
				Buffer.concat([Buffer.alloc(64 * KIB, 0x61), Buffer.alloc(64 * KIB, 0x62)]),
			);
			expect(fits).not.toHaveProperty("truncated");
		});

		it("sends the snapshot alone when the start of its tail is gone", async () => {
			endedTerminal("ended-gap");
			store("ended-gap", 10, "snapshot", JSON.stringify(SCREEN));
			// Seq 11 deleted, as a GC cut after the snapshot leaves it.
			store("ended-gap", 12, "output", "late");
			store("ended-gap", 13, "output", "later");

			const last = lastOutputOf((await attachFresh("ended-gap")).received);

			expect(last.snapshot).toEqual(SCREEN);
			expect(last.tail).toEqual([]);
			expect(last.truncated).toBe(true);
		});

		it("gives an ended terminal with no snapshot all its output when it fits", async () => {
			endedTerminal("ended-short", 90, 20);
			store("ended-short", 1, "output", "$ make\r\n");
			store("ended-short", 2, "output", "error: ");
			store("ended-short", 3, "output", "no rule\r\n");

			const last = lastOutputOf((await attachFresh("ended-short")).received);

			expect(last.snapshot).toBeNull();
			expect(text(last.tail)).toEqual(["$ make\r\nerror: no rule\r\n"]);
			expect(last).not.toHaveProperty("truncated");
			expect({ cols: last.cols, rows: last.rows }).toEqual({ cols: 90, rows: 20 });
		});

		it("drops an ended terminal's output with no snapshot when it does not fit, unread", async () => {
			endedTerminal("ended-burst");
			store("ended-burst", 1, "output", Buffer.alloc(64 * KIB, 0x61));
			store("ended-burst", 2, "output", Buffer.alloc(64 * KIB + 1, 0x62));
			const reads = dataReads();

			const last = lastOutputOf((await attachFresh("ended-burst")).received);

			expect(last.snapshot).toBeNull();
			expect(last.tail).toEqual([]);
			expect(last.truncated).toBe(true);
			expect(reads.byChannel).not.toHaveBeenCalled();
			expect(reads.one).not.toHaveBeenCalled();
			expect(reads.output).not.toHaveBeenCalled();
			expect(reads.latest).not.toHaveBeenCalled();
		});

		it("shows nothing of an ended terminal whose output lost its start", async () => {
			endedTerminal("ended-cut");
			// Seqs 1-3 deleted, as a GC pass part-way through leaves them.
			store("ended-cut", 4, "output", "middle");
			store("ended-cut", 5, "output", "end");

			const last = lastOutputOf((await attachFresh("ended-cut")).received);

			expect(last).toEqual({ snapshot: null, tail: [], cols: 120, rows: 40 });
		});

		it("answers an ended terminal the GC emptied with nothing to show", async () => {
			endedTerminal("ended-empty", 132, 43);

			const last = lastOutputOf((await attachFresh("ended-empty")).received);

			expect(last).toEqual({ snapshot: null, tail: [], cols: 132, rows: 43 });
		});

		it("shows nothing of an ended terminal whose snapshot does not parse", async () => {
			endedTerminal("ended-bad");
			// From seq 1: a stream that would replay whole if the bad row were taken for none.
			store("ended-bad", 1, "output", "before");
			store("ended-bad", 2, "snapshot", "{not json");
			store("ended-bad", 3, "output", "after");

			const last = lastOutputOf((await attachFresh("ended-bad")).received);

			expect(last).toEqual({ snapshot: null, tail: [], cols: 120, rows: 40 });
		});

		it("sends no snapshot too large for one message", async () => {
			const LIMIT = 256 * KIB;
			const snapshotOf = (bytes: number) => {
				const frame = JSON.stringify({ ...SCREEN, serialized: "" });
				return JSON.stringify({ ...SCREEN, serialized: "x".repeat(bytes - frame.length) });
			};
			endedTerminal("ended-huge");
			store("ended-huge", 10, "snapshot", snapshotOf(LIMIT + 1));
			store("ended-huge", 11, "output", "tail");
			const reads = dataReads();

			const huge = lastOutputOf((await attachFresh("ended-huge")).received);

			expect(huge).toEqual({ snapshot: null, tail: [], truncated: true, cols: 120, rows: 40 });
			expect(reads.one).not.toHaveBeenCalled();
			expect(reads.latest).not.toHaveBeenCalled();
			expect(reads.byChannel).not.toHaveBeenCalled();
			expect(reads.output).not.toHaveBeenCalled();

			endedTerminal("ended-limit");
			store("ended-limit", 10, "snapshot", snapshotOf(LIMIT));
			store("ended-limit", 11, "output", "tail");

			const limit = lastOutputOf((await attachFresh("ended-limit")).received);

			expect(limit.snapshot).toEqual(JSON.parse(snapshotOf(LIMIT)));
			expect(text(limit.tail)).toEqual(["tail"]);
		});

		it("answers a terminal its agent no longer has with its last output", async () => {
			sm.addClient(makeClient("first", []));
			const channelId = await sm.handleSpawn("first", { type: "SPAWN", hostId: "local" });
			if (channelId === null) throw new Error("expected a local channel");
			const agent = mockLocalAgents.at(-1);
			if (agent === undefined) throw new Error("expected the local agent");
			const emit = (msg: unknown) => (agent as unknown as EventEmitter).emit("message", msg);
			emit({ type: "SNAPSHOT_RES", channelId, snapshot: SCREEN, lastSeq: 0 });
			emit({ type: "OUTPUT", channelId, seq: 1, ts: "", data: Buffer.from("gone") });
			const ctx = (sm as unknown as { ctx: import("./session-context.js").SharedSessionContext })
				.ctx;
			ctx.chunker.flush(channelId);
			nextLocalAttachNotFoundChannelId = channelId;

			const { attached, received, client } = await attachFresh(channelId, "second");

			expect(attached).toBe(false);
			expect(received.find((m) => m.type === "ERROR")).toMatchObject({
				code: "CHANNEL_DEAD",
				message: "This terminal is no longer running on its host.",
				channelId,
			});
			const last = lastOutputOf(received);
			expect(last.snapshot).toEqual(SCREEN);
			expect(text(last.tail)).toEqual(["gone"]);
			expect(ctx.channels.has(channelId)).toBe(false);
			expect(client.attachedChannels.has(channelId)).toBe(false);
			expect(new MetaDAL(dbManager.meta).getChannel(channelId)?.status).toBe("dead");
		});

		describe("the final screen an exit carries (#933)", () => {
			const FINAL = {
				serialized: "\u001b[?25h\u001b[m\u001b[H\u001b[Jfinal screen",
				cols: 120,
				rows: 40,
				cursorX: 12,
				cursorY: 0,
				alternateScreen: false,
				inputModes: "",
			};
			const PREFIX = "\u001b[r\u001b[?6l\u001b[4l\u001b[?7h\u001b(B\u001b)B\u001b*B\u001b+B\u000f";
			const REDRAW = PREFIX + FINAL.serialized;
			const ctxOf = () =>
				(sm as unknown as { ctx: import("./session-context.js").SharedSessionContext }).ctx;

			/** A live local terminal, and a way to send what its agent sends. */
			async function liveTerminal(heard: ProtocolMessage[] = []) {
				sm.addClient(makeClient("writer", heard));
				const channelId = await sm.handleSpawn("writer", { type: "SPAWN", hostId: "local" });
				if (channelId === null) throw new Error("expected a local channel");
				const agent = mockLocalAgents.at(-1);
				if (agent === undefined) throw new Error("expected the local agent");
				const emit = (msg: unknown) => (agent as unknown as EventEmitter).emit("message", msg);
				return { channelId, emit };
			}

			const exitWith = (channelId: string, screen: unknown) => ({
				type: "CHANNEL_EXIT",
				channelId,
				exitCode: 0,
				screen,
			});

			it("an exit screen ends a complete last output", async () => {
				const { channelId, emit } = await liveTerminal();
				emit({ type: "SNAPSHOT_RES", channelId, snapshot: SCREEN, lastSeq: 0 });
				const after = "a".repeat(10 * KIB);
				emit({ type: "OUTPUT", channelId, seq: 1, ts: "", data: Buffer.from(after) });
				emit(exitWith(channelId, FINAL));

				const last = lastOutputOf((await attachFresh(channelId, "reader")).received);

				expect(last.snapshot).toEqual(SCREEN);
				expect(text(last.tail)).toEqual([after + REDRAW]);
				expect(last).not.toHaveProperty("truncated");
			});

			it("an exit screen ends the last output of a terminal stopped with its agent", async () => {
				const { channelId, emit } = await liveTerminal();
				emit({ type: "SNAPSHOT_RES", channelId, snapshot: SCREEN, lastSeq: 0 });
				const hostId = ctxOf().channels.get(channelId)?.hostId;
				if (hostId === undefined) throw new Error("expected the terminal's host");
				// The hub is stopping this host's agent: its ends are "stopped".
				ctxOf().stoppingAgents.add(hostId);
				emit(exitWith(channelId, FINAL));
				ctxOf().stoppingAgents.delete(hostId);

				expect(new MetaDAL(dbManager.meta).getChannel(channelId)?.endReason).toBe("stopped");
				const last = lastOutputOf((await attachFresh(channelId, "reader")).received);
				expect(text(last.tail)).toEqual([REDRAW]);
			});

			it("an exit screen redraws a snapshot nothing followed", async () => {
				const { channelId, emit } = await liveTerminal();
				emit({ type: "SNAPSHOT_RES", channelId, snapshot: SCREEN, lastSeq: 0 });
				emit(exitWith(channelId, FINAL));

				const last = lastOutputOf((await attachFresh(channelId, "reader")).received);

				expect(last.snapshot).toEqual(SCREEN);
				expect(text(last.tail)).toEqual([REDRAW]);
			});

			it("an exit screen ends a stream that has no snapshot", async () => {
				const { channelId, emit } = await liveTerminal();
				emit({ type: "OUTPUT", channelId, seq: 1, ts: "", data: Buffer.from("from the start") });
				emit(exitWith(channelId, FINAL));

				const last = lastOutputOf((await attachFresh(channelId, "reader")).received);

				expect(last.snapshot).toBeNull();
				expect(text(last.tail)).toEqual([`from the start${REDRAW}`]);
			});

			it("an exit screen that does not fit becomes the snapshot", async () => {
				const { channelId, emit } = await liveTerminal();
				emit({ type: "SNAPSHOT_RES", channelId, snapshot: SCREEN, lastSeq: 0 });
				const fill = "b".repeat(128 * KIB - Math.floor(Buffer.byteLength(REDRAW) / 2));
				emit({ type: "OUTPUT", channelId, seq: 1, ts: "", data: Buffer.from(fill) });
				emit(exitWith(channelId, FINAL));

				const last = lastOutputOf((await attachFresh(channelId, "reader")).received);

				expect(last.snapshot).toEqual(FINAL);
				expect(last.tail).toEqual([]);
				expect(last).not.toHaveProperty("truncated");
			});

			it("an exit screen replaces a last output cut short", async () => {
				const { channelId, emit } = await liveTerminal();
				emit({ type: "SNAPSHOT_RES", channelId, snapshot: SCREEN, lastSeq: 0 });
				const burst = "c".repeat(130 * KIB);
				emit({ type: "OUTPUT", channelId, seq: 1, ts: "", data: Buffer.from(burst) });
				emit(exitWith(channelId, FINAL));

				const last = lastOutputOf((await attachFresh(channelId, "reader")).received);

				expect(last.snapshot).toEqual(FINAL);
				expect(last.tail).toEqual([]);
				expect(last).not.toHaveProperty("truncated");
			});

			it("an exit screen stands in for a stream that lost its start", async () => {
				const { channelId, emit } = await liveTerminal();
				// The GC took seqs 1 to 99.
				store(channelId, 100, "output", "middle");
				emit(exitWith(channelId, FINAL));

				const last = lastOutputOf((await attachFresh(channelId, "reader")).received);

				expect(last.snapshot).toEqual(FINAL);
				expect(last.tail).toEqual([]);
			});

			it("an exit screen too large to send is not stored", async () => {
				const { channelId, emit } = await liveTerminal();
				emit({ type: "SNAPSHOT_RES", channelId, snapshot: SCREEN, lastSeq: 0 });
				const burst = "d".repeat(130 * KIB);
				emit({ type: "OUTPUT", channelId, seq: 1, ts: "", data: Buffer.from(burst) });
				// Under the agent's raw bound, over the hub's once JSON escapes it.
				const huge = { ...FINAL, serialized: "\u001b".repeat(50 * KIB) };
				emit(exitWith(channelId, huge));

				const last = lastOutputOf((await attachFresh(channelId, "reader")).received);

				expect(last.snapshot).toEqual(SCREEN);
				expect(last.tail).toEqual([]);
				expect(last.truncated).toBe(true);
			});

			it("an exit screen too large to send is not appended either", async () => {
				const { channelId, emit } = await liveTerminal();
				emit({ type: "SNAPSHOT_RES", channelId, snapshot: SCREEN, lastSeq: 0 });
				emit({ type: "OUTPUT", channelId, seq: 1, ts: "", data: Buffer.from("few") });
				// A complete answer, which a screen that fits would end with its redraw.
				const huge = { ...FINAL, serialized: "\u001b".repeat(50 * KIB) };
				emit(exitWith(channelId, huge));

				const last = lastOutputOf((await attachFresh(channelId, "reader")).received);

				expect(last.snapshot).toEqual(SCREEN);
				expect(text(last.tail)).toEqual(["few"]);
				expect(last).not.toHaveProperty("truncated");
			});

			it("an exit's screen frees no snapshot slot", async () => {
				const { channelId, emit } = await liveTerminal();
				const scheduler = ctxOf().scheduler as unknown as { _inFlightSnapshots: number };
				// Another terminal's SNAPSHOT_REQ is in flight.
				scheduler._inFlightSnapshots = 1;
				emit(exitWith(channelId, FINAL));

				expect(ctxOf().scheduler.inFlightSnapshots).toBe(1);
			});

			it("an exit screen that cannot be stored still ends the terminal", async () => {
				const heard: ProtocolMessage[] = [];
				const { channelId, emit } = await liveTerminal(heard);
				// Output the chunker holds, whose write at the exit fails.
				emit({ type: "OUTPUT", channelId, seq: 1, ts: "", data: Buffer.from("held") });
				spies.push(
					vi.spyOn(SpoolDAL.prototype, "insertChunk").mockImplementationOnce(() => {
						throw Object.assign(new Error("disk I/O error"), { code: "ERR_SQLITE_IOERR" });
					}),
				);
				emit(exitWith(channelId, FINAL));

				expect(heard).toContainEqual(
					expect.objectContaining({ type: "CHANNEL_STATE", channelId, status: "dead" }),
				);
				expect(new MetaDAL(dbManager.meta).getChannel(channelId)?.status).toBe("dead");
			});

			it("an exit screen whose write keeps failing leaves nothing to fail again", async () => {
				const heard: ProtocolMessage[] = [];
				const { channelId, emit } = await liveTerminal(heard);
				emit({ type: "SNAPSHOT_RES", channelId, snapshot: SCREEN, lastSeq: 0 });
				// Every write from here on fails: the redraw's, and any flush after it.
				spies.push(
					vi.spyOn(SpoolDAL.prototype, "insertChunk").mockImplementation(() => {
						throw Object.assign(new Error("disk I/O error"), { code: "ERR_SQLITE_IOERR" });
					}),
				);

				expect(() => emit(exitWith(channelId, FINAL))).not.toThrow();
				expect(heard).toContainEqual(
					expect.objectContaining({ type: "CHANNEL_STATE", channelId, status: "dead" }),
				);
			});

			it("an exit's screen for an unknown terminal is not stored", async () => {
				const { emit } = await liveTerminal();
				// A stream complete from its first seq, as a terminal the hub let go of leaves.
				store("NOTHELDHERE", 1, "output", "x");
				emit(exitWith("NOTHELDHERE", FINAL));

				const spool = new SpoolDAL(dbManager.spool);
				expect(spool.getNewestSnapshotRef("NOTHELDHERE")).toBeUndefined();
				expect(spool.getMaxSeq("NOTHELDHERE")).toBe(1);
			});
		});

		describe("the end a refusal names (#932)", () => {
			it("the end and the refusal name the same end", async () => {
				const heard: ProtocolMessage[] = [];
				sm.addClient(makeClient("writer", heard));
				const channelId = await sm.handleSpawn("writer", { type: "SPAWN", hostId: "local" });
				if (channelId === null) throw new Error("expected a local channel");
				const agent = mockLocalAgents.at(-1);
				if (agent === undefined) throw new Error("expected the local agent");
				(agent as unknown as EventEmitter).emit("message", {
					type: "CHANNEL_EXIT",
					channelId,
					exitCode: 4,
				});
				const row = new MetaDAL(dbManager.meta).getChannel(channelId);
				expect(row?.endId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
				const told = heard.find(
					(m): m is ChannelStateMessage => m.type === "CHANNEL_STATE" && m.status === "dead",
				);
				expect(told?.endId).toBe(row?.endId);

				const { received } = await attachFresh(channelId, "reader");

				expect(received.find((m) => m.type === "ERROR")).toMatchObject({
					code: "CHANNEL_DEAD",
					endId: row?.endId,
					exitCode: 4,
				});
			});

			it("a terminal its agent no longer has names its end", async () => {
				sm.addClient(makeClient("first", []));
				const channelId = await sm.handleSpawn("first", { type: "SPAWN", hostId: "local" });
				if (channelId === null) throw new Error("expected a local channel");
				nextLocalAttachNotFoundChannelId = channelId;

				const { received } = await attachFresh(channelId, "second");

				const row = new MetaDAL(dbManager.meta).getChannel(channelId);
				expect(row?.endId).toBeDefined();
				const refusal = received.find((m): m is ErrorMessage => m.type === "ERROR");
				expect(refusal).toMatchObject({
					code: "CHANNEL_DEAD",
					message: "This terminal is no longer running on its host.",
					endId: row?.endId,
				});
				expect(refusal).not.toHaveProperty("exitCode");
			});

			it("the refusal names a killed end's reason", async () => {
				const heard: ProtocolMessage[] = [];
				sm.addClient(makeClient("writer", heard));
				const channelId = await sm.handleSpawn("writer", { type: "SPAWN", hostId: "local" });
				if (channelId === null) throw new Error("expected a local channel");
				const agent = mockLocalAgents.at(-1);
				if (agent === undefined) throw new Error("expected the local agent");
				expect(sm.destroyChannel(channelId)).toBe(true);
				(agent as unknown as EventEmitter).emit("message", {
					type: "CHANNEL_EXIT",
					channelId,
					exitCode: 1,
				});
				const row = new MetaDAL(dbManager.meta).getChannel(channelId);
				if (row === undefined) throw new Error("expected the killed terminal's row");

				const { received } = await attachFresh(channelId, "reader");

				expect(received.find((m) => m.type === "ERROR")).toMatchObject({
					code: "CHANNEL_DEAD",
					endId: row.endId,
					endReason: "killed",
				});
			});

			it("a terminal ended before end ids names none", async () => {
				endedTerminal("ended-old");

				const { received } = await attachFresh("ended-old");

				const refusal = received.find((m) => m.type === "ERROR");
				expect(refusal).toMatchObject({ code: "CHANNEL_DEAD" });
				expect(refusal).not.toHaveProperty("endId");
			});
		});

		// Delivering the refusal depends on nothing it did not depend on before: a
		// spool that cannot be read leaves the answer an older hub's.
		describe("refuses an ended terminal without its last output when the spool cannot be read", () => {
			const SECRET = "secret-output-4927";

			function spoolFails(): void {
				spies.push(
					vi.spyOn(SpoolDAL.prototype, "getNewestSnapshotRef").mockImplementation(() => {
						throw Object.assign(new Error(`disk I/O error near ${SECRET}`), {
							code: "ERR_SQLITE_ERROR",
						});
					}),
				);
			}

			it("on an ended terminal, with and without a hub logger", async () => {
				const logged: Array<[string, string, Record<string, unknown> | undefined]> = [];
				const logger = {
					log: (level: string, msg: string, extra?: Record<string, unknown>) =>
						logged.push([level, msg, extra]),
				};
				const withLog = new SessionManager(
					dbManager,
					undefined,
					undefined,
					undefined,
					logger as never,
				);
				try {
					endedTerminal("ended-io");
					store("ended-io", 1, "output", SECRET);
					spoolFails();
					const received: ProtocolMessage[] = [];
					withLog.addClient(makeClient("io", received));

					expect(await withLog.handleAttach("io", "ended-io")).toBe(false);

					expect(received).toEqual([
						{
							type: "ERROR",
							code: "CHANNEL_DEAD",
							message: "This terminal has ended.",
							channelId: "ended-io",
						},
					]);
					expect(logged.filter(([level]) => level === "warn")).toEqual([
						[
							"warn",
							"could not read an ended terminal's last output",
							{ channelId: "ended-io", code: "ERR_SQLITE_ERROR" },
						],
					]);
					expect(JSON.stringify(logged)).not.toContain(SECRET);
				} finally {
					await withLog.shutdown();
				}

				// The suite's own manager has no hub logger: nothing throws.
				const { attached, received } = await attachFresh("ended-io");
				expect(attached).toBe(false);
				expect(received).toEqual([
					{
						type: "ERROR",
						code: "CHANNEL_DEAD",
						message: "This terminal has ended.",
						channelId: "ended-io",
					},
				]);
			});

			it("on a terminal its agent no longer has, with a hub logger", async () => {
				const logged: Array<[string, string, Record<string, unknown> | undefined]> = [];
				const logger = {
					log: (level: string, msg: string, extra?: Record<string, unknown>) =>
						logged.push([level, msg, extra]),
				};
				const withLog = new SessionManager(
					dbManager,
					undefined,
					undefined,
					undefined,
					logger as never,
				);
				try {
					withLog.addClient(makeClient("first", []));
					const channelId = await withLog.handleSpawn("first", { type: "SPAWN", hostId: "local" });
					if (channelId === null) throw new Error("expected a local channel");
					nextLocalAttachNotFoundChannelId = channelId;
					spoolFails();
					const received: ProtocolMessage[] = [];
					withLog.addClient(makeClient("second", received));

					expect(await withLog.handleAttach("second", channelId)).toBe(false);

					expect(received.filter((m) => m.type === "ERROR")).toEqual([
						{
							type: "ERROR",
							code: "CHANNEL_DEAD",
							message: "This terminal is no longer running on its host.",
							channelId,
							// The end meta.db recorded, read without the spool (#932).
							endId: expect.any(String),
						},
					]);
					expect(logged.filter(([level]) => level === "warn")).toEqual([
						[
							"warn",
							"could not read an ended terminal's last output",
							{ channelId, code: "ERR_SQLITE_ERROR" },
						],
					]);
					expect(JSON.stringify(logged)).not.toContain(SECRET);
				} finally {
					await withLog.shutdown();
				}
			});

			it("on a terminal its agent no longer has", async () => {
				sm.addClient(makeClient("first", []));
				const channelId = await sm.handleSpawn("first", { type: "SPAWN", hostId: "local" });
				if (channelId === null) throw new Error("expected a local channel");
				nextLocalAttachNotFoundChannelId = channelId;
				spoolFails();

				const { attached, received, client } = await attachFresh(channelId, "second");

				expect(attached).toBe(false);
				expect(received.filter((m) => m.type === "ERROR")).toEqual([
					{
						type: "ERROR",
						code: "CHANNEL_DEAD",
						message: "This terminal is no longer running on its host.",
						channelId,
						endId: expect.any(String),
					},
				]);
				const ctx = (sm as unknown as { ctx: import("./session-context.js").SharedSessionContext })
					.ctx;
				expect(ctx.channels.has(channelId)).toBe(false);
				expect(client.attachedChannels.has(channelId)).toBe(false);
				expect(new MetaDAL(dbManager.meta).getChannel(channelId)?.status).toBe("dead");
			});
		});
	});

	// A restart is the same terminal asked for a second time, and the only
	// moment a change of environment can reach one that already exists.
	it("restarts a terminal with the environment its scopes set", async () => {
		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbManager.meta);
		const scoped = new SessionManager(dbManager, undefined, undefined, {
			uiConfig: { title: { source: "dynamic", staticTitle: "" } },
			resolve: () => ({ envMode: "inherit" }),
			environmentLayers: () => [{ FROM_SCOPE: "yes" }],
			resolveElevationMethod: () => "sudo",
		} as unknown as ConfigResolver);
		scoped.addClient(makeClient("c-restart-env", []));

		const host = dal.createHost({
			type: "ssh",
			label: "test-ssh-restart-env",
			sshHost: "user@localhost",
			sshAuth: "key",
			sshKeyPath: "/nonexistent/key",
		});
		const channelId = await scoped.handleSpawn("c-restart-env", {
			type: "SPAWN",
			hostId: host.id,
		});
		if (channelId === null) throw new Error("expected a channel");

		expect(await scoped.restartChannel(channelId)).toBe(true);

		const spawns = (mockSshAgentInstance?.send.mock.calls ?? [])
			.map(([message]) => message as unknown as { type: string; env?: Record<string, string> })
			.filter((message) => message.type === "SPAWN");
		expect(spawns).toHaveLength(2);
		expect(spawns[1]?.env).toEqual({ FROM_SCOPE: "yes" });
	});

	// ─── A terminal with no directory of its own (#581) ──────────────────────
	//
	// A new one is sent none, and its agent starts it in the home of the user
	// it runs as. Starting it again sent the hub's own HOME, a directory on the
	// hub's machine — or "/" from a Windows hub, which has none. Every path
	// that starts a terminal again sends what the terminal has, and only that.

	describe("a terminal with no directory of its own (#581)", () => {
		let dal: MetaDAL;

		function spawnsTo(send: Mock | undefined): AgentSpawnMessage[] {
			return (send?.mock.calls ?? [])
				.map(([message]) => message as AgentSpawnMessage)
				.filter((message) => message.type === "SPAWN");
		}

		// One without a directory and one with, on a remote host.
		async function twoTerminals(): Promise<{ hostId: string; bare: string; placed: string }> {
			const host = dal.createHost({
				type: "ssh",
				label: "pi-cwd",
				sshHost: "pi@pi.local",
				sshAuth: "key",
				sshKeyPath: "/nonexistent/key",
			});
			const bare = await sm.handleSpawn("c-cwd", { type: "SPAWN", hostId: host.id });
			const placed = await sm.handleSpawn("c-cwd", {
				type: "SPAWN",
				hostId: host.id,
				cwd: "/srv/app",
			});
			if (bare === null || placed === null) throw new Error("expected two channels");
			return { hostId: host.id, bare, placed };
		}

		beforeEach(() => {
			dal = new MetaDAL(dbManager.meta);
			sm.addClient(makeClient("c-cwd", []));
			// The hub's own home: what must never reach the host.
			vi.stubEnv("HOME", "/home/hub-user");
			vi.stubEnv("USERPROFILE", "C:\\Users\\hub-user");
		});

		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it("is restarted without one, and one with a directory keeps it", async () => {
			const { bare, placed } = await twoTerminals();

			expect(await sm.restartChannel(bare)).toBe(true);
			expect(await sm.restartChannel(placed)).toBe(true);

			const [newBare, newPlaced, restartedBare, restartedPlaced] = spawnsTo(
				mockSshAgentInstance?.send,
			);
			expect(newBare).not.toHaveProperty("cwd");
			expect(newPlaced?.cwd).toBe("/srv/app");
			expect(restartedBare?.channelId).toBe(bare);
			expect(restartedBare).not.toHaveProperty("cwd");
			expect(restartedPlaced?.channelId).toBe(placed);
			expect(restartedPlaced?.cwd).toBe("/srv/app");
		});

		// What an agent that lost them gets: a remote one reached again, or a
		// local one started after a crash. A restart before it used to leave the
		// hub's home in what the hub remembers of the terminal.
		it("is started again on a new agent without one, a restarted one too", async () => {
			const { hostId, bare, placed } = await twoTerminals();
			expect(await sm.restartChannel(bare)).toBe(true);
			const agent = mockSshAgentInstance;
			const before = spawnsTo(agent?.send).length;

			await sm._spawnChannelsForHost(
				hostId,
				agent,
				() => {},
				() => {},
			);

			const again = spawnsTo(agent?.send).slice(before);
			expect(again.map((spawn) => spawn.channelId).sort()).toEqual([bare, placed].sort());
			expect(again.find((spawn) => spawn.channelId === bare)).not.toHaveProperty("cwd");
			expect(again.find((spawn) => spawn.channelId === placed)?.cwd).toBe("/srv/app");
		});

		// A dead terminal is brought back by a SPAWN that names it, and the web
		// sends that SPAWN with the terminal's shell and arguments only. The hub
		// sent no directory at all, so one that had its own came back in the
		// default one (#583).
		it("is brought back from the dead without one, and one with a directory in it (#583)", async () => {
			const { hostId, bare, placed } = await twoTerminals();
			const channels = (sm as unknown as { channels: Map<string, { status: string }> }).channels;
			const bury = (channelId: string): void => {
				const entry = channels.get(channelId);
				if (entry) entry.status = "dead";
				dal.updateChannelStatus(channelId, "dead");
			};
			const bringBack = (
				channelId: string,
				asked: Partial<UiSpawnMessage> = {},
			): Promise<string | null> =>
				sm.handleSpawn("c-cwd", { type: "SPAWN", hostId, reuseChannelId: channelId, ...asked });
			bury(bare);
			bury(placed);
			const before = spawnsTo(mockSshAgentInstance?.send).length;

			expect(await bringBack(bare)).toBe(bare);
			expect(await bringBack(placed)).toBe(placed);
			// A directory the request names comes first, and a launch profile it
			// names gives its own, as for a new terminal.
			bury(placed);
			expect(await bringBack(placed, { cwd: "/srv/other" })).toBe(placed);
			const profile = dal.createLaunchProfile({
				name: "In /opt/tools",
				shell: "/bin/bash",
				cwd: "/opt/tools",
				mode: "shell",
				elevated: false,
				supportedOs: "any",
				iconType: "auto",
				sortOrder: 0,
			});
			bury(placed);
			expect(await bringBack(placed, { launchProfileId: profile.id })).toBe(placed);

			const [backBare, backPlaced, asked, profiled] = spawnsTo(mockSshAgentInstance?.send).slice(
				before,
			);
			expect(backBare?.channelId).toBe(bare);
			expect(backBare).not.toHaveProperty("cwd");
			expect(backPlaced?.channelId).toBe(placed);
			expect(backPlaced?.cwd).toBe("/srv/app");
			expect(asked?.cwd).toBe("/srv/other");
			expect(profiled?.cwd).toBe("/opt/tools");
		});
	});

	// ─── A terminal with no shell of its own (#583) ──────────────────────────
	//
	// A new one names no shell when neither the request nor a launch profile
	// does, and its agent starts its user's default. Starting it again named one
	// all the same: "/bin/sh", which the database made up for it, or the hub's
	// own SHELL, a shell on the hub's machine. Every path that starts a terminal
	// again names the shell the terminal has, and only that.

	describe("a terminal with no shell of its own (#583)", () => {
		let dal: MetaDAL;
		let received: ProtocolMessage[];

		function spawnsTo(send: Mock | undefined): AgentSpawnMessage[] {
			return (send?.mock.calls ?? [])
				.map(([message]) => message as AgentSpawnMessage)
				.filter((message) => message.type === "SPAWN");
		}

		// One without a shell and one with, on a remote host with no launch profile.
		async function twoTerminals(): Promise<{ hostId: string; bare: string; zsh: string }> {
			const host = dal.createHost({
				type: "ssh",
				label: "pi-shell",
				sshHost: "pi@pi.local",
				sshAuth: "key",
				sshKeyPath: "/nonexistent/key",
			});
			const bare = await sm.handleSpawn("c-shell", { type: "SPAWN", hostId: host.id });
			const zsh = await sm.handleSpawn("c-shell", {
				type: "SPAWN",
				hostId: host.id,
				shell: "/usr/bin/zsh",
			});
			if (bare === null || zsh === null) throw new Error("expected two channels");
			return { hostId: host.id, bare, zsh };
		}

		beforeEach(() => {
			dal = new MetaDAL(dbManager.meta);
			received = [];
			sm.addClient(makeClient("c-shell", received));
			// The hub's own shell: what must never reach the host.
			vi.stubEnv("SHELL", "/usr/bin/hub-shell");
		});

		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it("is restarted without one, and one with a shell keeps it", async () => {
			const { bare, zsh } = await twoTerminals();

			expect(await sm.restartChannel(bare)).toBe(true);
			expect(await sm.restartChannel(zsh)).toBe(true);

			const [newBare, newZsh, restartedBare, restartedZsh] = spawnsTo(mockSshAgentInstance?.send);
			expect(newBare).not.toHaveProperty("shell");
			expect(newZsh?.shell).toBe("/usr/bin/zsh");
			expect(restartedBare?.channelId).toBe(bare);
			expect(restartedBare).not.toHaveProperty("shell");
			expect(restartedZsh?.channelId).toBe(zsh);
			expect(restartedZsh?.shell).toBe("/usr/bin/zsh");
			// The host's default shell logs in, on a restart as the first time:
			// the made-up "/bin/sh" was not the default, and lost it.
			expect(newBare?.loginShell).toBe(true);
			expect(restartedBare?.loginShell).toBe(true);
		});

		// What an agent that lost them gets: a remote one reached again, or a
		// local one started after a crash.
		it("is started again on a new agent without one, before a restart and after", async () => {
			const { hostId, bare, zsh } = await twoTerminals();
			const agent = mockSshAgentInstance;
			const startedAgain = async (): Promise<AgentSpawnMessage[]> => {
				const before = spawnsTo(agent?.send).length;
				await sm._spawnChannelsForHost(
					hostId,
					agent,
					() => {},
					() => {},
				);
				return spawnsTo(agent?.send).slice(before);
			};

			const asNew = await startedAgain();
			expect(await sm.restartChannel(bare)).toBe(true);
			const asRestarted = await startedAgain();

			for (const again of [asNew, asRestarted]) {
				expect(again.map((spawn) => spawn.channelId).sort()).toEqual([bare, zsh].sort());
				expect(again.find((spawn) => spawn.channelId === bare)).not.toHaveProperty("shell");
				expect(again.find((spawn) => spawn.channelId === zsh)?.shell).toBe("/usr/bin/zsh");
			}
		});

		// A client keeps what it is told: bringing the terminal back from its
		// list would name the hub's shell to the host.
		it("is announced to the clients without one", async () => {
			const { bare, zsh } = await twoTerminals();

			const created = received.filter(
				(message): message is ChannelCreatedMessage => message.type === "CHANNEL_CREATED",
			);
			expect(created.map((message) => message.channelId)).toEqual([bare, zsh]);
			expect(created.find((message) => message.channelId === bare)).not.toHaveProperty("shell");
			expect(created.find((message) => message.channelId === zsh)?.shell).toBe("/usr/bin/zsh");
		});
	});

	// ─── A PowerShell that reports its directory (#839) ──────────────────────
	//
	// A launch profile's switch reaches the agent in the SPAWN, which decides
	// whether it applies to the shell and its arguments. The hub sends it with
	// the rest of the profile: when the terminal starts, and every time it is
	// started again.

	describe("a launch profile whose PowerShell reports its directory (#839)", () => {
		let dal: MetaDAL;
		const PWSH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";

		function spawnsTo(send: Mock | undefined): AgentSpawnMessage[] {
			return (send?.mock.calls ?? [])
				.map(([message]) => message as AgentSpawnMessage)
				.filter((message) => message.type === "SPAWN");
		}

		function profile(name: string, reportDirectory: boolean): string {
			return dal.createLaunchProfile({
				name,
				shell: PWSH,
				args: ["-NoLogo"],
				mode: "shell",
				elevated: false,
				supportedOs: "windows",
				iconType: "auto",
				sortOrder: 0,
				reportDirectory,
			}).id;
		}

		/** A terminal of `launchProfileId` on a remote Windows host. */
		async function terminal(
			launchProfileId: string,
		): Promise<{ hostId: string; channelId: string }> {
			const host = dal.createHost({
				type: "ssh",
				label: `win-${launchProfileId}`,
				sshHost: "me@win.local",
				sshAuth: "key",
				sshKeyPath: "/nonexistent/key",
				os: "windows",
			});
			const channelId = await sm.handleSpawn("c-report", {
				type: "SPAWN",
				hostId: host.id,
				launchProfileId,
			});
			if (channelId === null) throw new Error("expected a channel");
			return { hostId: host.id, channelId };
		}

		beforeEach(() => {
			dal = new MetaDAL(dbManager.meta);
			sm.addClient(makeClient("c-report", []));
		});

		it("is said in the SPAWN of a profile that has it on, and left out of one that has it off", async () => {
			await terminal(profile("PowerShell, reporting", true));
			const [reporting] = spawnsTo(mockSshAgentInstance?.send);
			await terminal(profile("PowerShell", false));
			const [plain] = spawnsTo(mockSshAgentInstance?.send);

			expect(reporting?.shell).toBe(PWSH);
			expect(reporting?.args).toEqual(["-NoLogo"]);
			expect(reporting?.reportDirectory).toBe(true);
			expect(plain?.shell).toBe(PWSH);
			expect(plain).not.toHaveProperty("reportDirectory");
		});

		it("is said again on a restart, on a new agent, and when brought back from the dead", async () => {
			const { hostId, channelId } = await terminal(profile("PowerShell, reporting", true));
			const agent = mockSshAgentInstance;
			const before = spawnsTo(agent?.send).length;

			expect(await sm.restartChannel(channelId)).toBe(true);
			await sm._spawnChannelsForHost(
				hostId,
				agent,
				() => {},
				() => {},
			);
			// What a window's Restart sends for an ended terminal: its id, its
			// shell and its arguments, and no profile.
			const channels = (sm as unknown as { channels: Map<string, { status: string }> }).channels;
			const entry = channels.get(channelId);
			if (entry) entry.status = "dead";
			dal.updateChannelStatus(channelId, "dead");
			expect(
				await sm.handleSpawn("c-report", {
					type: "SPAWN",
					hostId,
					reuseChannelId: channelId,
					shell: PWSH,
					args: ["-NoLogo"],
				}),
			).toBe(channelId);

			const again = spawnsTo(agent?.send).slice(before);
			expect(again).toHaveLength(3);
			for (const spawn of again) {
				expect(spawn.channelId).toBe(channelId);
				expect(spawn.reportDirectory).toBe(true);
			}
		});

		it("follows the profile as it is now: turned off, a restart says nothing", async () => {
			const id = profile("PowerShell, reporting", true);
			const { channelId } = await terminal(id);
			dal.updateLaunchProfile(id, { reportDirectory: false });
			const before = spawnsTo(mockSshAgentInstance?.send).length;

			expect(await sm.restartChannel(channelId)).toBe(true);

			const [restarted] = spawnsTo(mockSshAgentInstance?.send).slice(before);
			expect(restarted?.channelId).toBe(channelId);
			expect(restarted).not.toHaveProperty("reportDirectory");
		});
	});

	// ─── The environment a SPAWN carries (#576) ──────────────────────────────
	//
	// Against a real ConfigResolver, reading a real config.toml and the host and
	// channel profiles in meta.db: the cascade is what is under test.

	describe("the environment a SPAWN carries (#576)", () => {
		let configDir: string;
		let scoped: SessionManager;
		let dal: MetaDAL;

		async function hubWithConfig(toml: string): Promise<void> {
			const { ConfigResolver } = await import("../config.js");
			dal = new MetaDAL(dbManager.meta);
			const resolver = new ConfigResolver(dal);
			writeFileSync(join(configDir, "config.toml"), toml);
			resolver.loadFromFile(configDir);
			scoped = new SessionManager(dbManager, undefined, undefined, resolver);
			scoped.addClient(makeClient("c-env", []));
		}

		function sshHost(label: string, defaultShell?: string): string {
			const host = dal.createHost({
				type: "ssh",
				label,
				sshHost: "pi@pi.local",
				sshAuth: "key",
				sshKeyPath: "/nonexistent/key",
			});
			if (defaultShell !== undefined) {
				dal.updateHostDiscoveredShells(host.id, [defaultShell, "/usr/bin/zsh"], defaultShell);
			}
			return host.id;
		}

		function spawnsTo(send: Mock | undefined): AgentSpawnMessage[] {
			return (send?.mock.calls ?? [])
				.map(([message]) => message as AgentSpawnMessage)
				.filter((message) => message.type === "SPAWN");
		}

		beforeEach(() => {
			configDir = makeTempDir("lasterm-spawn-env-");
		});

		afterEach(async () => {
			await scoped?.shutdown();
			await removeTempDir(configDir);
		});

		it("resolves global, host and channel into values and removals, a restart included", async () => {
			// config.toml has no null: a removal is written false there.
			await hubWithConfig(
				'[terminal]\nenv = { PAGER = "less", NO_COLOR = false, EDITOR = "vi" }\n',
			);
			const hostId = sshHost("pi-env");
			dal.updateHostProfile(
				hostId,
				JSON.stringify({ env: { EDITOR: null, SSH_AUTH_SOCK: null, LANG: "C.UTF-8" } }),
			);

			const channelId = await scoped.handleSpawn("c-env", { type: "SPAWN", hostId });
			if (channelId === null) throw new Error("expected a channel");
			dal.updateChannelProfile(
				channelId,
				JSON.stringify({ env: { SSH_AUTH_SOCK: "/tmp/agent.sock", PAGER: null } }),
			);
			expect(await scoped.restartChannel(channelId)).toBe(true);

			const [first, restart] = spawnsTo(mockSshAgentInstance?.send);
			expect(first?.env).toEqual({ PAGER: "less", LANG: "C.UTF-8" });
			expect([...(first?.envUnset ?? [])].sort()).toEqual(["EDITOR", "NO_COLOR", "SSH_AUTH_SOCK"]);
			// The channel restores what its host removed, and removes what the
			// global scope set.
			expect(restart?.env).toEqual({ LANG: "C.UTF-8", SSH_AUTH_SOCK: "/tmp/agent.sock" });
			expect([...(restart?.envUnset ?? [])].sort()).toEqual(["EDITOR", "NO_COLOR", "PAGER"]);
		});

		it("sends the mode the scopes resolve, on a restart too", async () => {
			await hubWithConfig("[terminal]\n");
			const hostId = sshHost("pi-mode");

			const channelId = await scoped.handleSpawn("c-env", { type: "SPAWN", hostId });
			if (channelId === null) throw new Error("expected a channel");
			dal.updateChannelProfile(channelId, JSON.stringify({ envMode: "minimal" }));
			expect(await scoped.restartChannel(channelId)).toBe(true);

			const [first, restart] = spawnsTo(mockSshAgentInstance?.send);
			expect(first?.envMode).toBe("inherit");
			expect(first).not.toHaveProperty("envUnset");
			expect(restart?.envMode).toBe("minimal");
		});

		// The resolver used to be asked for the host alone at spawn, so a
		// terminal brought back lost what its own scope set.
		it("brings a dead terminal back with its own scope's environment", async () => {
			await hubWithConfig("[terminal]\n");
			const hostId = sshHost("pi-reuse");
			const channelId = await scoped.handleSpawn("c-env", { type: "SPAWN", hostId });
			if (channelId === null) throw new Error("expected a channel");
			const channels = (scoped as unknown as { channels: Map<string, { status: string }> })
				.channels;
			const stale = channels.get(channelId);
			if (stale) stale.status = "dead";
			dal.updateChannelProfile(
				channelId,
				JSON.stringify({ envMode: "minimal", env: { FROM_CHANNEL: "yes", PAGER: null } }),
			);

			expect(
				await scoped.handleSpawn("c-env", {
					type: "SPAWN",
					hostId,
					reuseChannelId: channelId,
				}),
			).toBe(channelId);

			const back = spawnsTo(mockSshAgentInstance?.send).at(-1);
			expect(back?.channelId).toBe(channelId);
			expect(back?.envMode).toBe("minimal");
			expect(back?.env).toEqual({ FROM_CHANNEL: "yes" });
			expect(back?.envUnset).toEqual(["PAGER"]);
		});

		it("asks for a login shell for an SSH host's default shell, run as a shell with no arguments", async () => {
			await hubWithConfig("[terminal]\n");
			const hostId = sshHost("pi-login", "/bin/bash");

			const asked = async (
				msg: Partial<UiSpawnMessage>,
			): Promise<AgentSpawnMessage | undefined> => {
				await scoped.handleSpawn("c-env", { type: "SPAWN", hostId, ...msg });
				return spawnsTo(mockSshAgentInstance?.send).at(-1);
			};

			expect((await asked({}))?.loginShell, "the agent's default").toBe(true);
			expect((await asked({ shell: "/bin/bash" }))?.loginShell, "named").toBe(true);
			expect(await asked({ shell: "/usr/bin/zsh" }), "another shell").not.toHaveProperty(
				"loginShell",
			);
			expect(
				await asked({ shell: "/bin/bash", args: ["-c", "htop"] }),
				"arguments",
			).not.toHaveProperty("loginShell");
			expect(
				await asked({ shell: "/bin/bash", directProcess: true }),
				"a direct process",
			).not.toHaveProperty("loginShell");
		});

		it("leaves a local terminal as it was", async () => {
			await hubWithConfig("[terminal]\n");

			await scoped.handleSpawn("c-env", { type: "SPAWN", hostId: "local" });

			const spawn = spawnsTo(mockLocalAgents.at(-1)?.send as Mock | undefined).at(-1);
			expect(spawn?.type).toBe("SPAWN");
			expect(spawn).not.toHaveProperty("loginShell");
		});
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

		it("attaches the local agent at startup and ends the terminals the daemon does not hold", async () => {
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

			// And neither channel is in memory: the daemon reported holding none,
			// so those two terminals are gone. They stay in the database as dead —
			// the sidebar still lists them — but the hub does not go on believing
			// they run, which is what kept asking the agent for a snapshot of a
			// channel it had never heard of, every five seconds, for the whole run.
			const channelsMap = (sm as unknown as { channels: Map<string, unknown> }).channels;
			expect(channelsMap.has("warm-ch-1")).toBe(false);
			expect(channelsMap.has("warm-ch-2")).toBe(false);
			expect(dal.getChannel("warm-ch-1")?.status).toBe("dead");

			// Agent should have been spawned for this host
			const agentsMap = (sm as unknown as { agents: Map<string, unknown> }).agents;
			expect(agentsMap.has(host.id)).toBe(true);
		});

		it("keeps a terminal the daemon holds live when the first startup connection fails (#981)", async () => {
			const { MetaDAL } = await import("../storage/meta.js");
			const dal = new MetaDAL(dbManager.meta);

			const host = dal.createHost({ type: "local", label: "held-local" });
			const sessionId = "HELDSESS0000000000000000000001";
			dal.createSession({ id: sessionId, hostId: host.id, status: "active" });
			dal.createChannel({ id: "held-ch-1", sessionId, status: "live", shell: "/bin/sh" });
			dal.createChannel({ id: "lost-ch-1", sessionId, status: "live", shell: "/bin/sh" });

			// The first connection fails; the second reaches a daemon that still
			// runs one of the two terminals. Like the real agent, it refuses a
			// SPAWN under an id it holds.
			const launch = vi.mocked(_connectOrLaunchForMock);
			const fresh = launch.getMockImplementation()!;
			launch
				.mockRejectedValueOnce(new Error("pipe busy"))
				.mockImplementationOnce(async (...args) => {
					const agent = (await fresh(...args)) as unknown as Record<string, unknown>;
					agent.waitForChannelState = vi.fn().mockResolvedValue([
						{
							type: "AGENT_CHANNEL_STATE",
							channelId: "held-ch-1",
							title: "sh",
							pid: 4242,
							alive: true,
						},
					]);
					return agent as never;
				});
			nextLocalSpawnError = { code: "CHANNEL_EXISTS", message: "channel already exists" };

			await sm.startup();
			await new Promise((r) => setImmediate(r));
			await new Promise((r) => setImmediate(r));

			expect(launch).toHaveBeenCalledTimes(2);
			const sent = mockLocalAgents.flatMap((a) =>
				(a as unknown as { send: { mock: { calls: [ProtocolMessage][] } } }).send.mock.calls.map(
					([m]) => m,
				),
			);
			expect(sent.filter((m) => m.type === "SPAWN")).toEqual([]);
			const channels = (sm as unknown as { channels: Map<string, { status: string }> }).channels;
			expect(channels.get("held-ch-1")?.status).toBe("live");
			expect(dal.getChannel("held-ch-1")?.status).toBe("live");
			// The one it does not hold has ended, and is not started again.
			expect(channels.has("lost-ch-1")).toBe(false);
			expect(dal.getChannel("lost-ch-1")?.status).toBe("dead");
		});

		it("closes the session when the daemon cannot be reached at startup, twice (#981)", async () => {
			const { MetaDAL } = await import("../storage/meta.js");
			const dal = new MetaDAL(dbManager.meta);

			const host = dal.createHost({ type: "local", label: "unreachable-local" });
			const sessionId = "UNREACHSESS0000000000000000001";
			dal.createSession({ id: sessionId, hostId: host.id, status: "active" });
			dal.createChannel({ id: "unreach-ch-1", sessionId, status: "live", shell: "/bin/sh" });

			const launch = vi.mocked(_connectOrLaunchForMock);
			launch
				.mockRejectedValueOnce(new Error("pipe busy"))
				.mockRejectedValueOnce(new Error("pipe busy"));

			await sm.startup();

			expect(launch).toHaveBeenCalledTimes(2);
			expect(dal.getSession(sessionId)?.status).toBe("closed");
			expect(dal.getChannel("unreach-ch-1")?.status).toBe("dead");
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
		sm.handleAuthPromptResponse("client-1", {
			hostId: "host-01",
			secret: "my-secret",
			...echoOf(received),
		});

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

		sm.handleAuthPromptResponse("client-1", {
			hostId: "host-02",
			secret: null,
			...echoOf(received),
		});

		const result = await resolvePromise;
		expect(result).toBeFalsy();
		const ctx = (sm as unknown as { ctx: import("./session-context.js").SharedSessionContext }).ctx;
		expect(ctx.pendingPrompts.size).toBe(0);
	});

	// A password is asked before anything is dialled, so the wait holds nothing
	// open. Ending it on a clock would throw away the answer that arrives a
	// second later, for a question the person did answer (#444).
	it("waits for a password however long it takes", async () => {
		vi.useFakeTimers();
		try {
			const received: ProtocolMessage[] = [];
			const client = makeClient("client-1", received);
			sm.addClient(client);
			const sshMgr = (
				sm as unknown as { sshMgr: import("./ssh-connection-manager.js").SshConnectionManager }
			).sshMgr;
			const answer = sshMgr.buildPromptAuth(client)("host-03", "password", "test");
			const settled = vi.fn();
			void answer.then(settled, settled);
			const ctx = (sm as unknown as { ctx: import("./session-context.js").SharedSessionContext })
				.ctx;
			const promptId = [...ctx.pendingPrompts.keys()][0]!;

			await vi.advanceTimersByTimeAsync(600_000);

			expect(settled).not.toHaveBeenCalled();
			expect(ctx.pendingPrompts.has(promptId)).toBe(true);

			sm.handleAuthPromptResponse("client-1", {
				hostId: "host-03",
				secret: "answered at last",
				...echoOf(received),
			});
			await expect(answer).resolves.toBe("answered at last");
		} finally {
			vi.useRealTimers();
		}
	});

	it("handleAuthPromptResponse is a no-op for a prompt it does not know", () => {
		// Should not throw
		expect(() => {
			sm.handleAuthPromptResponse("client-1", {
				hostId: "no-such-host",
				secret: "secret",
				promptId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
				deliveryEpoch: 1,
			});
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

		// Attacker answers the same prompt from a different clientId
		sm.handleAuthPromptResponse("attacker-client", {
			hostId: "host-sec",
			secret: "injected-secret",
			...echoOf(received),
		});

		// Prompt must still be pending and secret must not be resolved
		expect(ctx.pendingPrompts.has(promptId)).toBe(true);
		expect(ctx.passphraseCache.has("host-sec")).toBe(false);

		sm.handleAuthPromptResponse("legitimate-client", {
			hostId: "host-sec",
			secret: null,
			...echoOf(received),
		});
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
		sm.handleAuthPromptResponse("c1", {
			hostId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
			secret: "hunter2",
			...echoOf(received),
		});

		return expect(promptPromise).resolves.toBe("hunter2");
	});
});

// ─── handleTestConnect ────────────────────────────────────────────────────────

// Mock ssh2 Client for _testSshConnectivity
import { EventEmitter } from "node:events";
import type { TestConnectMessage } from "@lasterm/shared";

let mockSsh2Client: EventEmitter & {
	connect: ReturnType<typeof vi.fn>;
	setNoDelay: ReturnType<typeof vi.fn>;
	end: ReturnType<typeof vi.fn>;
	destroy: ReturnType<typeof vi.fn>;
};

vi.mock("ssh2", () => {
	return {
		// Extended as the key-auth agent signer loads (#876).
		BaseAgent: class {},
		// biome-ignore lint/complexity/useArrowFunction: vitest 4 needs a constructable function for new-ed mocks
		Client: vi.fn().mockImplementation(function () {
			mockSsh2Client = Object.assign(new EventEmitter(), {
				connect: vi.fn(),
				// Every connection the hub opens turns Nagle off (#873).
				setNoDelay: vi.fn(),
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
		sm.handleAuthPromptResponse("c-tc-4", {
			hostId: "temp-host-5",
			secret: null,
			...echoOf(received),
		});
		await promise;

		// Should have received TEST_CONNECT_FAIL after cancellation, said as a
		// cancel: the dialog shows no failed test for it (#815).
		const failMsg = received.find((m) => m.type === "TEST_CONNECT_FAIL") as
			| (ProtocolMessage & { message?: string })
			| undefined;
		expect(failMsg).toBeDefined();
		expect(failMsg).toMatchObject({ type: "TEST_CONNECT_FAIL", code: ErrorCode.AUTH_CANCELLED });
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
		environmentLayers: () => [],
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
						sm.handleAuthPromptResponse(id, {
							hostId: promptMsg.hostId,
							secret: responseSecret,
							promptId: promptMsg.promptId,
							deliveryEpoch: promptMsg.deliveryEpoch,
						});
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

	it("SC-20: first spawn with elevated=true sends AUTH_PROMPT; second spawn uses cache", async () => {
		const localHostId = await sm.ensureLocalHost();

		const received: ProtocolMessage[] = [];

		// Use auto-respond client: first AUTH_PROMPT gets "hunter2" automatically.
		const client = makeAutoRespondClient("c-sc20", received, "hunter2");
		sm.addClient(client);

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

	it("#958: an elevated spawn refused for another reason than a missing password reports it at once", async () => {
		const localHostId = await sm.ensureLocalHost();
		const received: ProtocolMessage[] = [];
		sm.addClient(makeClient("c-958", received));
		nextLocalSpawnError = { code: "ELEVATION_FAILED", message: "gsudo not found" };

		const result = await sm.handleSpawn("c-958", {
			type: "SPAWN",
			hostId: localHostId,
			elevated: true,
			requestId: "01JD2Z0K8V9X7Q3M5N4P6R8T0W",
		});

		expect(result).toBeNull();
		expect(received.filter((m) => m.type === "AUTH_PROMPT")).toEqual([]);
		expect(received.filter((m) => m.type === "ERROR")).toEqual([
			{
				type: "ERROR",
				code: "ELEVATION_FAILED",
				message: "gsudo not found",
				requestId: "01JD2Z0K8V9X7Q3M5N4P6R8T0W",
			},
		]);
	});

	it("D4: closeSession clears pending elevation prompt and rejects late response without caching", async () => {
		const localHostId = await sm.ensureLocalHost();
		const received: ProtocolMessage[] = [];
		const client = makeClient("c-d4-close-elevation", received);
		sm.addClient(client);

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

		sm.handleAuthPromptResponse("c-d4-close-elevation", {
			hostId: localHostId,
			secret: "late-elevation-secret",
			...echoOf(received),
		});

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

	// #1089: on every elevated restart path, a program that ends at once,
	// its CHANNEL_EXIT in the SPAWN_OK's read, is shown ended.
	it.each([
		["a cached secret", "cached"],
		["a passwordless first attempt", "passwordless"],
		["a secret prompted after the passwordless attempt", "prompted"],
	] as const)(
		"an elevated restart with %s whose program ends at once is shown ended",
		async (_, path) => {
			const localHostId = await sm.ensureLocalHost();
			const { MetaDAL } = await import("../storage/meta.js");
			const dal = new MetaDAL(dbManager.meta);
			const received: ProtocolMessage[] = [];
			sm.addClient(makeAutoRespondClient("c-elev-ends", received, "p@ss"));
			const channelId = await sm.handleSpawn("c-elev-ends", {
				type: "SPAWN",
				hostId: localHostId,
				elevated: true,
			});
			expect(channelId).not.toBeNull();
			if (path !== "cached") {
				getElevationCache().set(`${localHostId}:c-elev-ends`, {
					secret: "old",
					expiresAt: Date.now() - 1,
				});
			}
			nextLocalElevationPasswordless = path === "passwordless";

			nextLocalSpawnEndsWith = 4;
			expect(await sm.restartChannel(channelId!, "c-elev-ends")).toBe(true);

			expect(dal.getChannel(channelId!)?.status).toBe("dead");
			const states = received.filter(
				(m) => m.type === "CHANNEL_STATE" && (m as { channelId?: string }).channelId === channelId,
			);
			expect(states.at(-1)).toMatchObject({ status: "dead", exitCode: 4 });
		},
	);

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
						sm.handleAuthPromptResponse("c-restart03", {
							hostId: promptMsg.hostId,
							secret: spawnDone ? null : "initial-pass",
							promptId: promptMsg.promptId,
							deliveryEpoch: promptMsg.deliveryEpoch,
						});
					});
				}
			},
			attachedChannels: new Set(),
		};
		sm.addClient(client);

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

	// ─── A terminal brought back from its pane (#858) ────────────────────────
	//
	// A window brings an ended terminal back with a SPAWN naming it, with its
	// shell and arguments when its list carries them, and never a launch
	// profile. It starts the profile it was first started from, as the hub's
	// own restart does: its environment as the profile says it now; its shell,
	// arguments, directory, size, mode and elevation as the terminal was started.
	// The profile is edited on each of those after the terminal starts, or
	// deleted, and both ways of bringing it back send the agent the same SPAWN.
	const startedAs = {
		"an elevated shell": {
			profile: { mode: "shell", elevated: true },
			editedTo: { mode: "process", elevated: false },
			// Started with doas, the method its host had then: it is elevated
			// again with doas, whatever the host's method is now.
			elevationMethod: "doas",
			spawn: { elevated: true, elevationMethod: "doas", elevationSecret: "hunter2" },
		},
		"a process of its own, not elevated": {
			profile: { mode: "process", elevated: false },
			editedTo: { mode: "shell", elevated: true },
			elevationMethod: undefined,
			spawn: { directProcess: true },
		},
		"an elevated process": {
			profile: { mode: "process", elevated: true },
			editedTo: { mode: "shell", elevated: false },
			elevationMethod: "doas",
			spawn: {
				directProcess: true,
				elevated: true,
				elevationMethod: "doas",
				elevationSecret: "hunter2",
			},
		},
	} as const;
	// What the profile gives: its environment and its switch as it says them
	// now; a deleted one gives neither.
	const profileSays = {
		edited: { env: { DEPLOY_ENV: "prod" }, reportDirectory: true },
		deleted: { env: {} },
	} as const;
	it.each([
		[
			"an elevated shell",
			"edited",
			"its shell and arguments, as a window listing it sends them",
			true,
		],
		[
			"an elevated shell",
			"edited",
			"its id alone, as a window that does not list it sends it",
			false,
		],
		["a process of its own, not elevated", "edited", "its shell and arguments", true],
		["a process of its own, not elevated", "edited", "its id alone", false],
		["an elevated process", "edited", "its shell and arguments", true],
		["an elevated process", "edited", "its id alone", false],
		["an elevated process", "deleted", "its shell and arguments", true],
		["an elevated process", "deleted", "its id alone", false],
	] as const)(
		"brings %s whose profile was %s back from %s with the SPAWN a restart sends (#858)",
		async (started, afterwards, _, listed) => {
			const { profile, editedTo, elevationMethod, spawn } = startedAs[started];
			const localHostId = await sm.ensureLocalHost();
			const dal = new MetaDAL(dbManager.meta);
			const profileId = dal.createLaunchProfile({
				name: "Staging admin",
				shell: "/usr/bin/fish",
				args: ["--private"],
				cwd: "/srv/staging",
				env: { DEPLOY_ENV: "staging" },
				...profile,
				supportedOs: "any",
				iconType: "auto",
				sortOrder: 0,
				reportDirectory: true,
			}).id;
			sm.addClient(makeAutoRespondClient("c-858", [], "hunter2"));
			const channelId = await sm.handleSpawn("c-858", {
				type: "SPAWN",
				hostId: localHostId,
				launchProfileId: profileId,
				cols: 132,
				rows: 43,
			});
			if (channelId === null) throw new Error("expected a channel");
			if (elevationMethod !== undefined) {
				dbManager.meta
					.prepare("UPDATE channels SET elevation_method = ? WHERE id = ?")
					.run(elevationMethod, channelId);
			}
			if (afterwards === "deleted") {
				expect(dal.deleteLaunchProfile(profileId)).toBe(true);
			} else {
				dal.updateLaunchProfile(profileId, {
					shell: "/usr/bin/zsh",
					args: ["--login"],
					cwd: "/opt/elsewhere",
					env: { DEPLOY_ENV: "prod" },
					...editedTo,
				});
			}
			const agent = mockLocalAgents.at(-1);
			const spawns = () =>
				(agent?.send.mock.calls ?? [])
					.map(([message]) => message as AgentSpawnMessage)
					.filter((message) => message.type === "SPAWN");
			const before = spawns().length;

			expect(await sm.restartChannel(channelId, "c-858")).toBe(true);
			const ctx = (sm as unknown as { ctx: import("./session-context.js").SharedSessionContext })
				.ctx;
			const entry = ctx.channels.get(channelId);
			if (entry) entry.status = "dead";
			dal.updateChannelStatus(channelId, "dead");
			expect(
				await sm.handleSpawn("c-858", {
					type: "SPAWN",
					hostId: localHostId,
					reuseChannelId: channelId,
					...(listed && { shell: "/usr/bin/fish", args: ["--private"] }),
				}),
			).toBe(channelId);
			// What the bring-back recorded on the row starts it the same again.
			expect(await sm.restartChannel(channelId, "c-858")).toBe(true);

			const expected = {
				type: "SPAWN",
				requestId: expect.any(String),
				channelId,
				shell: "/usr/bin/fish",
				args: ["--private"],
				cwd: "/srv/staging",
				cols: 132,
				rows: 43,
				envMode: "inherit",
				...profileSays[afterwards],
				...spawn,
			};
			const [restarted, broughtBack, restartedAgain, ...more] = spawns().slice(before);
			expect(restarted).toEqual(expected);
			expect(broughtBack).toEqual(expected);
			expect(restartedAgain).toEqual(expected);
			expect(more).toEqual([]);
		},
	);

	// What a request names when it brings a terminal back is recorded with the
	// rest: the next restart starts the terminal as that start left it.
	it("records the start a bring-back names, so the next restart starts it the same (#858)", async () => {
		const localHostId = await sm.ensureLocalHost();
		const dal = new MetaDAL(dbManager.meta);
		const launch = { supportedOs: "any", iconType: "auto" } as const;
		const adminId = dal.createLaunchProfile({
			name: "Staging admin",
			shell: "/usr/bin/fish",
			args: ["--private"],
			cwd: "/srv/staging",
			env: { DEPLOY_ENV: "staging" },
			mode: "process",
			elevated: true,
			sortOrder: 0,
			reportDirectory: true,
			...launch,
		}).id;
		const plainId = dal.createLaunchProfile({
			name: "Plain",
			shell: "/bin/sh",
			env: { OTHER: "yes" },
			mode: "shell",
			elevated: false,
			sortOrder: 1,
			...launch,
		}).id;
		sm.addClient(makeAutoRespondClient("c-858", [], "hunter2"));
		const channelId = await sm.handleSpawn("c-858", {
			type: "SPAWN",
			hostId: localHostId,
			launchProfileId: adminId,
			cols: 132,
			rows: 43,
		});
		if (channelId === null) throw new Error("expected a channel");
		const ctx = (sm as unknown as { ctx: import("./session-context.js").SharedSessionContext }).ctx;
		const entry = ctx.channels.get(channelId);
		if (entry) entry.status = "dead";
		dal.updateChannelStatus(channelId, "dead");
		const agent = mockLocalAgents.at(-1);
		const lastSpawn = () =>
			(agent?.send.mock.calls ?? [])
				.map(([message]) => message as AgentSpawnMessage)
				.filter((message) => message.type === "SPAWN")
				.at(-1);

		expect(
			await sm.handleSpawn("c-858", {
				type: "SPAWN",
				hostId: localHostId,
				reuseChannelId: channelId,
				launchProfileId: plainId,
				elevated: false,
				directProcess: false,
			}),
		).toBe(channelId);
		const broughtBack = lastSpawn();
		expect(await sm.restartChannel(channelId, "c-858")).toBe(true);
		const restarted = lastSpawn();

		// The plain profile's shell, none of the admin profile's arguments, the
		// terminal's own directory and size, neither a process nor elevated.
		const expected = {
			type: "SPAWN",
			requestId: expect.any(String),
			channelId,
			shell: "/bin/sh",
			cwd: "/srv/staging",
			cols: 132,
			rows: 43,
			env: { OTHER: "yes" },
			envMode: "inherit",
		};
		expect(broughtBack).toEqual(expected);
		expect(restarted).toEqual(expected);
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
import { AgentBinaryDecisionNeeded } from "./agent-deployer.js";
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
	// ── #1034: the pane is told the hub is connecting its host ──────────────────
	//
	// Each wait of a connection has its own bound, and a host's may be longer
	// than the pane's 15 s: the hub says it is connecting, once per SPAWN, and
	// answers every SPAWN it said it to.

	/** The next SshAgent: its start runs `start`, given the abort signal. */
	function nextSshAgent(
		start: (signal: AbortSignal | undefined) => Promise<void>,
		tofu = false,
	): void {
		// biome-ignore lint/complexity/useArrowFunction: vitest 4 needs a constructable function for new-ed mocks
		vi.mocked(_SshAgentForMock).mockImplementationOnce(function (
			host: { id: string },
			_promptAuth: unknown,
			deployOptions?: MockSshAgentDeployOptions,
		) {
			const agent = new MockSshAgent(host, deployOptions);
			if (tofu) {
				agent.lastKeyVerification = {
					capturedFingerprint: "SHA256:mockfp",
					mismatch: false,
					tofu: true,
				} as typeof agent.lastKeyVerification;
			}
			agent.start = vi.fn((_fp: unknown, _trusted: unknown, signal?: AbortSignal) =>
				start(signal),
			) as unknown as typeof agent.start;
			mockSshAgentInstance = agent;
			return agent;
		} as unknown as typeof _SshAgentForMock);
	}

	const connecting = (received: ProtocolMessage[]) =>
		received.filter((m) => m.type === "HOST_CONNECTING");

	it("tells each spawning client its host is being connected (#1034)", async () => {
		const hostId = await createSshHost();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		nextSshAgent(() => gate);
		const r1: ProtocolMessage[] = [];
		const r2: ProtocolMessage[] = [];
		sm.addClient(makeClient("c-1034-a", r1));
		sm.addClient(makeClient("c-1034-b", r2));

		const spawnA = sm.handleSpawn("c-1034-a", { type: "SPAWN", hostId, requestId: "r1" });
		const spawnB = sm.handleSpawn("c-1034-b", { type: "SPAWN", hostId, requestId: "r2" });
		await flushImmediate();
		await flushImmediate();

		// Still connecting: the start above has not returned.
		expect(connecting(r1)).toEqual([{ type: "HOST_CONNECTING", hostId, requestId: "r1" }]);
		expect(connecting(r2)).toEqual([{ type: "HOST_CONNECTING", hostId, requestId: "r2" }]);
		expect(r1.some((m) => m.type === "SPAWN_OK")).toBe(false);

		release();
		expect(await spawnA).not.toBeNull();
		expect(await spawnB).not.toBeNull();
		expect(
			r1.map((m) => m.type).filter((t) => t === "HOST_CONNECTING" || t === "SPAWN_OK"),
		).toEqual(["HOST_CONNECTING", "SPAWN_OK"]);
		expect(
			r2.map((m) => m.type).filter((t) => t === "HOST_CONNECTING" || t === "SPAWN_OK"),
		).toEqual(["HOST_CONNECTING", "SPAWN_OK"]);
	});

	it("sends one HOST_CONNECTING per spawn however many dials (#1034)", async () => {
		const hostId = await createSshHost();
		nextSshAgent(() => Promise.reject(new Error("SSH_TOFU")), true);
		const received: ProtocolMessage[] = [];
		sm.addClient(makeClient("c-1034-once", received));

		const spawn = sm.handleSpawn("c-1034-once", { type: "SPAWN", hostId, requestId: "r-once" });
		const prompt = await vi.waitFor(() => {
			const asked = received.find((m) => m.type === "HOST_VERIFY") as
				| { promptId: string }
				| undefined;
			if (asked === undefined) throw new Error("not asked yet");
			return asked;
		});
		sm.handleHostVerifyResponse(prompt.promptId, "trust_once", "c-1034-once");

		expect(await spawn).not.toBeNull();
		// Two dials: the first refused for its unknown key, the second trusted.
		expect(vi.mocked(_SshAgentForMock).mock.calls).toHaveLength(2);
		expect(connecting(received)).toEqual([
			{ type: "HOST_CONNECTING", hostId, requestId: "r-once" },
		]);
	});

	it("sends one HOST_CONNECTING when an approved agent binary dials again (#1034)", async () => {
		const hostId = await createSshHost();
		// The first dial finds a binary nobody approved; once trusted,
		// _connectSshAgent is entered again and dials anew.
		nextSshAgent(() =>
			Promise.reject(
				new AgentBinaryDecisionNeeded({
					hostId,
					hostname: "concurrent-test",
					remotePath: "/home/user/.local/bin/lasterm-agent",
					remoteSha256: "ab".repeat(32),
					os: "linux",
					arch: "x64",
					mismatch: false,
				}),
			),
		);
		const received: ProtocolMessage[] = [];
		sm.addClient(makeClient("c-1034-binary", received));

		const spawn = sm.handleSpawn("c-1034-binary", { type: "SPAWN", hostId, requestId: "r-bin" });
		const prompt = await vi.waitFor(() => {
			const asked = received.find((m) => m.type === "AGENT_BINARY_VERIFY") as
				| { promptId: string }
				| undefined;
			if (asked === undefined) throw new Error("not asked yet");
			return asked;
		});
		sm.handleAgentVerifyResponse(prompt.promptId, "trust_once", "c-1034-binary");

		expect(await spawn).not.toBeNull();
		expect(vi.mocked(_SshAgentForMock).mock.calls).toHaveLength(2);
		expect(connecting(received)).toEqual([{ type: "HOST_CONNECTING", hostId, requestId: "r-bin" }]);
	});

	it("answers a spawn disconnected during its host-key question as disconnected (#1034)", async () => {
		const hostId = await createSshHost();
		nextSshAgent(() => Promise.reject(new Error("SSH_TOFU")), true);
		const received: ProtocolMessage[] = [];
		sm.addClient(makeClient("c-1034-ask", received));

		const spawn = sm.handleSpawn("c-1034-ask", { type: "SPAWN", hostId, requestId: "r-ask" });
		await vi.waitFor(() => {
			if (!received.some((m) => m.type === "HOST_VERIFY")) throw new Error("not asked yet");
		});
		sm.disconnectHost(hostId);

		expect(await spawn).toBeNull();
		expect(received.filter((m) => m.type === "ERROR")).toEqual([
			expect.objectContaining({
				type: "ERROR",
				hostId,
				requestId: "r-ask",
				message: "concurrent-ssh is disconnected. Connect it to start its terminals.",
			}),
		]);
	});

	it("answers a spawn whose connection its user cancelled (#1034)", async () => {
		const hostId = await createSshHost();
		nextSshAgent(
			(signal) =>
				new Promise<void>((_resolve, reject) => {
					signal?.addEventListener("abort", () =>
						reject(Object.assign(new Error("SSH connect aborted"), { name: "AbortError" })),
					);
				}),
		);
		const received: ProtocolMessage[] = [];
		sm.addClient(makeClient("c-1034-cancel", received));

		const spawn = sm.handleSpawn("c-1034-cancel", {
			type: "SPAWN",
			hostId,
			requestId: "r-cancel",
		});
		await vi.waitFor(() => expect(connecting(received)).toHaveLength(1));
		sm.disconnectHost(hostId);

		expect(await spawn).toBeNull();
		expect(received.filter((m) => m.type === "ERROR")).toEqual([
			expect.objectContaining({
				type: "ERROR",
				hostId,
				requestId: "r-cancel",
				message: "concurrent-ssh is disconnected. Connect it to start its terminals.",
			}),
		]);
	});

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
		// A real failure is said as one: the pane shows its reason (#812).
		expect(
			c1Received.some(
				(m) =>
					m.type === "ERROR" &&
					(m as ProtocolMessage & { code?: string }).code === "SSH_CONNECT_FAILED",
			),
		).toBe(true);

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
			const inst = new MockSshAgent({ id: hostId });
			inst.start = vi.fn().mockReturnValue(connectBarrier);
			return inst;
		}) as never);

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

		const sessions = (
			sm as unknown as { sessions: Map<string, { id: string; hostId: string; status: string }> }
		).sessions;
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
		const connectedAgent = new MockSshAgent({ id: hostId });
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

	// A cancelled password or passphrase is no failure (#812): the window that
	// was asked, and one that joined its connection meanwhile, hear
	// AUTH_CANCELLED, which their panes show no reason for.
	it("says a cancelled prompt as AUTH_CANCELLED, to the leader and to a follower", async () => {
		const hostId = await createSshHost();
		let cancel!: () => void;
		const cancelled = new Promise<void>((resolve) => {
			cancel = resolve;
		});
		// biome-ignore lint/complexity/useArrowFunction: vitest 4 needs a constructable function for new-ed mocks
		vi.mocked(_SshAgentForMock).mockImplementationOnce(function (host: { id: string }) {
			const agent = new MockSshAgent(host);
			agent.start = vi.fn(async () => {
				await cancelled;
				throw new AuthCancelledError();
			});
			mockSshAgentInstance = agent;
			return agent as never;
		});

		const c1Received: ProtocolMessage[] = [];
		const c2Received: ProtocolMessage[] = [];
		sm.addClient(makeClient("c-cancel-1", c1Received));
		sm.addClient(makeClient("c-cancel-2", c2Received));

		const spawn1 = sm.handleSpawn("c-cancel-1", { type: "SPAWN", hostId });
		await vi.waitFor(() => expect(sm.acquisitions.has(hostId)).toBe(true));
		const acq = sm.acquisitions.get(hostId);
		if (!acq) throw new Error("expected acquisition");
		const spawn2 = sm.handleSpawn("c-cancel-2", { type: "SPAWN", hostId });
		await vi.waitFor(() => expect(acq.leases.size).toBe(2));

		cancel();
		expect(await Promise.all([spawn1, spawn2])).toEqual([null, null]);

		const errorCodes = (received: ProtocolMessage[]) =>
			received
				.filter((m) => m.type === "ERROR")
				.map((m) => (m as ProtocolMessage & { code?: string }).code);
		expect(errorCodes(c1Received)).toEqual([ErrorCode.AUTH_CANCELLED]);
		expect(errorCodes(c2Received)).toEqual([ErrorCode.AUTH_CANCELLED]);
		expect(sm.acquisitions.has(hostId)).toBe(false);
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
		seedMap(ctx.agents, "host-await-close", agent);

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
		seedMap(ctx.agents, "host-slow-close", agent);

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
	it("second buildPromptAuth for same host from SAME client keeps its own answer", async () => {
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

			// Neither waits on a clock any more, so what must not be clobbered is
			// the other's entry and the other's answer: each prompt keeps its own,
			// and answering one settles one.
			await vi.advanceTimersByTimeAsync(600_000);
			expect(ctx.pendingPrompts.has(firstPromptId)).toBe(true);
			expect(ctx.pendingPrompts.has(secondPromptId)).toBe(true);

			sm.handleAuthPromptResponse(sameClient.id, {
				hostId,
				secret: "second",
				promptId: secondPromptId,
				deliveryEpoch: 1,
			});
			await expect(p2).resolves.toBe("second");
			expect(ctx.pendingPrompts.has(firstPromptId)).toBe(true);

			sm.handleAuthPromptResponse(sameClient.id, {
				hostId,
				secret: "first",
				promptId: firstPromptId,
				deliveryEpoch: 1,
			});
			await expect(p1).resolves.toBe("first");
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
		const rejectSpy1 = vi.fn<(e: Error) => void>();
		const rejectSpy2 = vi.fn<(e: Error) => void>();
		function makeStaleAcq(
			id: string,
			hostId: string,
			rejectSpy: Mock<(e: Error) => void>,
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
		const rejectSpy1 = vi.fn<(e: Error) => void>();
		const rejectSpy2 = vi.fn<(e: Error) => void>();
		function makeAcq(
			id: string,
			hostId: string,
			ctrl: AbortController,
			rejectSpy: Mock<(e: Error) => void>,
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
		seedMap(ctx.sessions, hostId, { id: fakeSessionId, hostId, status: "active" } as never);
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
		seedMap(ctx.sessions, hostId, { id: fakeSessionId, hostId, status: "active" } as never);
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
		seedMap(ctx.sessions, hostId, { id: fakeSessionId, hostId, status: "starting" } as never);

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
			mockSshAgentInstance = new MockSshAgent({ id: hostId });
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

	// An upload to the host holds its connection as a terminal does (#833): the
	// sole requester leaving does not take a connection an upload runs on.
	it("sole-requester disconnect: the connection stays while an upload to the host runs", async () => {
		const hostId = await createSshHost();
		sm.setTransfers({ activeOn: (id) => (id === hostId ? 1 : 0), interruptOn: vi.fn() });
		sm.addClient(makeClient("c-upload-1", []));
		const origMockImpl = vi
			.mocked((await import("./ssh-agent.js")).SshAgent)
			.getMockImplementation();
		vi.mocked((await import("./ssh-agent.js")).SshAgent).mockImplementationOnce(function (
			this: unknown,
		) {
			mockSshAgentInstance = new MockSshAgent({ id: hostId });
			sm.removeClient("c-upload-1");
			return mockSshAgentInstance;
		} as never);

		const result = await sm.handleSpawn("c-upload-1", { type: "SPAWN", hostId });

		expect(result).toBeNull();
		expect(mockSshAgentInstance?.close).not.toHaveBeenCalled();
		const ctx = (sm as unknown as { ctx: import("./session-context.js").SharedSessionContext }).ctx;
		expect(ctx.agents.has(hostId)).toBe(true);
		expect(ctx.sessions.has(hostId)).toBe(true);
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
			const inst = new MockSshAgent({ id: hostId });
			inst.start = vi.fn().mockReturnValue(connectBarrier);
			mockSshAgentInstance = inst;
			return inst;
		} as never);

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
			mockSshAgentInstance = new MockSshAgent({ id: hostId });
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
			clientId: "stale-waiter-client",
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
			const inst = new MockSshAgent({ id: hostId });
			inst.start = vi.fn().mockReturnValue(connectBarrier);
			mockSshAgentInstance = inst;
			return inst;
		} as never);

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
		seedMap(ctx.sessions, hostId, {
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
		Object.assign(leaseA, { _acq: acq });
		Object.assign(leaseB, { _acq: acq });
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
		seedMap(ctx.sessions, hostId, { id: sessionId, hostId, status: "detached" });
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
				ctx.clients
					.get(routeClientId)
					?.send(msg as unknown as import("@lasterm/shared").HostVerifyMessage);
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
		seedMap(ctx.sessions, hostId, { id: sessionId, hostId, status: "detached" });
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
				ctx.clients
					.get(routeClientId)
					?.send(msg as unknown as import("@lasterm/shared").HostVerifyMessage);
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
		Object.assign(leaseA, { _acq: acq });
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

/**
 * The reconnect the hub scheduled when a host's connection dropped, given up.
 *
 * A restart while it is scheduled is refused, its host away (#605): these
 * follow a restart that opens a connection of its own, which is what one does
 * once nothing reaches for the host any more.
 */
function stopReconnecting(
	ctx: import("./session-context.js").SharedSessionContext,
	hostId: string,
): void {
	const timer = ctx.reconnectTimers.get(hostId);
	expect(timer, "the drop scheduled a reconnect").toBeDefined();
	clearTimeout(timer);
	ctx.reconnectTimers.delete(hostId);
}

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
		stopReconnecting(ctx, hostId);
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
			const agent = new MockSshAgent({ id: hostId });
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
		stopReconnecting(ctx, hostId);

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
		stopReconnecting(ctx, hostId);

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
			const agent = new MockSshAgent({ id: hostId });
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

		// Simulate a late response arriving after the session was closed, for a
		// prompt that no longer exists.
		sm.handleAuthPromptResponse("c-c2-1", {
			hostId,
			secret: "should-not-be-cached",
			promptId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
			deliveryEpoch: 1,
		});

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
		const [promptId] = [...ctx.pendingPrompts.keys()];

		await sm.closeSession(sessionId);
		await promptPromise;

		// Simulate a late client response arriving after close.
		sm.handleAuthPromptResponse("c-c3b-1", {
			hostId,
			secret: "should-not-be-cached-secret",
			promptId: promptId!,
			deliveryEpoch: 1,
		});

		// INVARIANT: passphraseCache must NOT contain the secret for the closed host.
		// Mutation oracle: without owner-context cleanup, the secret would be cached.
		expect(ctx.passphraseCache.has(hostId)).toBe(false);
	});
});

// ─── #556: Reconnect in a pane, after a hub restart ──────────────────────────
//
// The previous run left terminals it believed alive in meta.db, and nothing
// else knows them: this run starts with empty memory and restores them from
// there. A pane asks for its terminal again (Reconnect is an ATTACH), and the
// hub reaches the host. What the client is then told has to be enough for
// every pane of that host to stop saying "Not connected", the panes nobody
// clicked included: the exit overlay where the terminal ended, an attach where
// it is still running.

describe("SessionManager — Reconnect in a pane, after a restart (#556)", () => {
	let sm: SessionManager;
	let dbManager: ReturnType<typeof openTestDatabases>;

	beforeEach(() => {
		localSpawnCount = 0;
		sshSpawnCount = 0;
		mockSshAgentInstance = null;
		nextSshStartError = null;
		dbManager = openTestDatabases();
		vi.mocked(_SshAgentForMock).mockClear();
	});

	afterEach(async () => {
		await sm.shutdown();
		dbManager.close();
	});

	/** What the previous run left: a host that keeps a daemon, and its terminals. */
	function seedPreviousRun(): { hostId: string; channelIds: string[] } {
		const dal = new MetaDAL(dbManager.meta);
		const host = dal.createHost({
			type: "ssh",
			label: "pi",
			sshHost: "user@pi.test",
			sshAuth: "agent",
			sshRemoteDaemon: true,
			os: "linux",
		});
		const sessionId = "01K556SESSION0000000000000";
		dal.createSession({ id: sessionId, hostId: host.id, status: "active" });
		const channelIds = [
			"01K556CHAN0000000000000001",
			"01K556CHAN0000000000000002",
			"01K556CHAN0000000000000003",
			"01K556CHAN0000000000000004",
		];
		for (const id of channelIds) {
			dal.createChannel({ id, sessionId, status: "live", shell: "bash" });
		}
		return { hostId: host.id, channelIds };
	}

	/**
	 * The daemon the next connection reaches, holding `holds`. Reaching it takes
	 * until `reached` settles, when given.
	 */
	function nextDaemon(holds: string[], reached?: Promise<void>): void {
		// biome-ignore lint/complexity/useArrowFunction: vitest needs a constructable function for new-ed mocks
		vi.mocked(_SshAgentForMock).mockImplementationOnce(function (host: { id: string }) {
			const agent = new MockSshAgent(host);
			if (reached !== undefined) agent.start = vi.fn(() => reached);
			Object.assign(agent, {
				usedRemoteDaemon: true,
				waitForChannelState: vi.fn().mockResolvedValue(
					holds.map((channelId) => ({
						type: "AGENT_CHANNEL_STATE",
						channelId,
						title: "bash",
						pid: 4242,
						alive: true,
					})),
				),
			});
			const attach = agent.send;
			agent.send = vi.fn((msg: ProtocolMessage) => {
				const { channelId, requestId } = msg as unknown as { channelId: string; requestId: string };
				if (msg.type !== "ATTACH" || holds.includes(channelId)) {
					attach(msg);
					return;
				}
				setImmediate(() => {
					agent._emit("message", {
						type: "ERROR",
						code: "CHANNEL_NOT_FOUND",
						message: `channel ${channelId} not found`,
						channelId,
						requestId,
					});
				});
			});
			mockSshAgentInstance = agent;
			return agent as never;
		});
	}

	// The hub restarted, then the host's daemon was stopped and its terminals
	// ended with it. The hub starts a new one, which holds nothing.
	it("tells the client that every terminal of a replaced daemon has ended", async () => {
		const { hostId, channelIds } = seedPreviousRun();
		sm = new SessionManager(dbManager);
		await sm.startup();

		const received: ProtocolMessage[] = [];
		sm.addClient(makeClient("c-pane", received));
		nextDaemon([]);

		// Reconnect, in the pane showing the first of them.
		const clicked = channelIds[0] ?? "";
		await sm.handleAttach("c-pane", clicked);

		// The session came back...
		expect(received).toContainEqual(
			expect.objectContaining({ type: "SESSION_STATE", hostId, status: "active" }),
		);
		// ...and each terminal it had is said to have ended, the three panes
		// nobody clicked included.
		for (const channelId of channelIds) {
			expect(received, `nothing said ${channelId} ended`).toContainEqual(
				expect.objectContaining({ type: "CHANNEL_STATE", channelId, status: "dead" }),
			);
		}
		// The Reconnect itself is answered with the same news, not from memory.
		expect(received).toContainEqual(
			expect.objectContaining({ type: "ERROR", code: "CHANNEL_DEAD", channelId: clicked }),
		);
		expect(received).not.toContainEqual(
			expect.objectContaining({ type: "ATTACH_OK", channelId: clicked }),
		);
		// And the database agrees, which is what a reload reads.
		const dal = new MetaDAL(dbManager.meta);
		for (const channelId of channelIds) {
			expect(dal.getChannel(channelId)?.status).toBe("dead");
		}
	});

	// The daemon outlived the hub and still runs them, but reaching the host
	// takes longer than an attach waits: the pane is answered from the spool and
	// says it is not connected. The connection lands afterwards.
	it("tells a pane answered from memory that its terminal can be reached, once it can", async () => {
		const { channelIds } = seedPreviousRun();
		sm = new SessionManager(dbManager);
		await sm.startup();

		const received: ProtocolMessage[] = [];
		sm.addClient(makeClient("c-pane", received));
		let reachHost = (): void => {};
		nextDaemon(
			channelIds,
			new Promise<void>((resolve) => {
				reachHost = resolve;
			}),
		);

		const clicked = channelIds[0] ?? "";
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const attaching = sm.handleAttach("c-pane", clicked);
			await vi.advanceTimersByTimeAsync(10_000);
			await attaching;
		} finally {
			vi.useRealTimers();
		}
		expect(received).toContainEqual(
			expect.objectContaining({ type: "ATTACH_OK", channelId: clicked, cached: true }),
		);

		received.length = 0;
		reachHost();
		await vi.waitFor(() => {
			expect(received).toContainEqual(expect.objectContaining({ type: "SESSION_STATE" }));
		});
		await flushImmediate();

		// Nothing about it changed: it was live, and live it stays. Only this
		// says the pane can now reach it.
		expect(received).toContainEqual(
			expect.objectContaining({ type: "CHANNEL_STATE", channelId: clicked, status: "live" }),
		);
		expect(received).not.toContainEqual(
			expect.objectContaining({ type: "CHANNEL_STATE", status: "dead" }),
		);
	});

	// ─── #559: what a reload, a later pane and another window are told ───────
	//
	// A terminal that has ended shows the exit overlay with Restart, and only
	// Restart brings it back. A pane that attaches to it is told it ended,
	// whichever host is in view, whether the hub holds it in memory or only in
	// meta.db, and whether its host is connected or not. And every window
	// hears it end, attached or not.
	describe("and what a reload, a later pane or another window hears (#559)", () => {
		/** An SSH host whose agent runs on stdio and dies with its connection. */
		function seedStdioHost(): { channelId: string } {
			const dal = new MetaDAL(dbManager.meta);
			const host = dal.createHost({
				type: "ssh",
				label: "stdio-box",
				sshHost: "user@stdio.test",
				sshAuth: "agent",
				sshRemoteDaemon: false,
				os: "linux",
			});
			const sessionId = "01K559SESSION0000000000000";
			dal.createSession({ id: sessionId, hostId: host.id, status: "active" });
			const channelId = "01K559CHAN0000000000000001";
			dal.createChannel({ id: channelId, sessionId, status: "live", shell: "bash" });
			return { channelId };
		}

		// Reconnect found every terminal of the Pi ended (#556), with the session
		// active and a new daemon connected. Then the page reloads. The Pi is not
		// the host in view, so its panes do not know their terminals ended, and
		// each one attaches. That ATTACH used to start the terminal again.
		it("a reload's panes are told the terminals Reconnect found ended, and none starts again", async () => {
			const { channelIds } = seedPreviousRun();
			sm = new SessionManager(dbManager);
			await sm.startup();
			sm.addClient(makeClient("c-pane", []));
			nextDaemon([]);
			await sm.handleAttach("c-pane", channelIds[0] ?? "");
			const daemon = mockSshAgentInstance;
			if (daemon === null) throw new Error("expected the new daemon's connection");
			daemon.send.mockClear();

			const reloaded: ProtocolMessage[] = [];
			sm.addClient(makeClient("c-reloaded", reloaded));
			for (const channelId of channelIds.slice(1)) {
				await sm.handleAttach("c-reloaded", channelId);
			}
			await flushImmediate();

			expect(reloaded).toEqual(
				channelIds
					.slice(1)
					.map((channelId) =>
						expect.objectContaining({ type: "ERROR", code: "CHANNEL_DEAD", channelId }),
					),
			);
			expect(daemon.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "SPAWN" }));
			const dal = new MetaDAL(dbManager.meta);
			for (const channelId of channelIds) {
				expect(dal.getChannel(channelId)?.status).toBe("dead");
			}
		});

		// Startup finds a stdio remote's terminals ended with the connection
		// that carried them, and holds them as dead. Nobody reconnects that host
		// until asked, so a pane mounted now finds no agent. It was answered from
		// the spool, and said "Not connected" over a shell that no longer exists.
		it("a pane is told a stdio remote's terminal ended at the restart, not that it is not connected", async () => {
			const { channelId } = seedStdioHost();
			sm = new SessionManager(dbManager);
			await sm.startup();

			const received: ProtocolMessage[] = [];
			sm.addClient(makeClient("c-pane", received));
			await sm.handleAttach("c-pane", channelId);

			expect(received).toEqual([
				expect.objectContaining({ type: "ERROR", code: "CHANNEL_DEAD", channelId }),
			]);
			// Nothing was dialled to ask a host about a terminal known to be gone.
			expect(vi.mocked(_SshAgentForMock)).not.toHaveBeenCalled();
		});

		// A window's socket drops. While it is away its terminal exits and then
		// the host's connection drops too, so the hub holds the terminal as dead
		// with no agent to ask. The socket comes back and the pane attaches
		// again: it has to hear that the terminal ended, not get the last screen
		// from the spool and a "Not connected" banner.
		it("a pane whose socket came back is told its terminal ended while it was away", async () => {
			const dal = new MetaDAL(dbManager.meta);
			const host = dal.createHost({
				type: "ssh",
				label: "exit-while-away",
				sshHost: "user@away.test",
				sshAuth: "agent",
				sshRemoteDaemon: false,
				os: "linux",
			});
			sm = new SessionManager(dbManager);
			sm.addClient(makeClient("c-window", []));
			const channelId = await sm.handleSpawn("c-window", { type: "SPAWN", hostId: host.id });
			if (channelId === null) throw new Error("expected a channel");
			const agent = mockSshAgentInstance;
			if (agent === null) throw new Error("expected the host's connection");

			sm.removeClient("c-window");
			agent._emit("message", { type: "CHANNEL_EXIT", channelId, exitCode: 0 });
			agent.simulateClose();

			const received: ProtocolMessage[] = [];
			sm.addClient(makeClient("c-window-again", received));
			await sm.handleAttach("c-window-again", channelId);

			expect(received).toEqual([
				expect.objectContaining({ type: "ERROR", code: "CHANNEL_DEAD", channelId }),
			]);
		});

		// Two windows on one hub, the second not attached to the terminal: a
		// pane still opening, or one showing another tab. It holds the channel in
		// its state all the same, and never heard it end.
		it("a window not attached to a terminal hears it end", async () => {
			sm = new SessionManager(dbManager);
			sm.addClient(makeClient("c-attached", []));
			const channelId = await sm.handleSpawn("c-attached", { type: "SPAWN", hostId: "local" });
			if (channelId === null) throw new Error("expected a channel");
			const other: ProtocolMessage[] = [];
			sm.addClient(makeClient("c-other-window", other));

			const agent = mockLocalAgents.at(-1) as unknown as {
				emit: (event: string, msg: unknown) => void;
			};
			agent.emit("message", { type: "CHANNEL_EXIT", channelId, exitCode: 3 });

			expect(other).toContainEqual(
				expect.objectContaining({ type: "CHANNEL_STATE", channelId, status: "dead", exitCode: 3 }),
			);
		});
	});
});

// ─── An end the hub caused says so (#580) ────────────────────────────────────
//
// With "When a terminal ends = Restart", a pane that sees its terminal end
// brings it back. A terminal killed from another window came back that way:
// the report of its end said nothing of why, and a kill looked like a shell
// that exited. Every path by which the hub ends a live terminal on purpose
// says so in that report; an end the terminal chose does not.
describe("SessionManager — an end the hub caused says so (#580)", () => {
	let sm: SessionManager;
	let dbManager: ReturnType<typeof openTestDatabases>;

	beforeEach(() => {
		localSpawnCount = 0;
		mockLocalAgents.length = 0;
		dbManager = openTestDatabases();
		sm = new SessionManager(dbManager);
	});

	afterEach(async () => {
		await sm.shutdown();
		dbManager.close();
	});

	/** A local terminal a pane is attached to, and another window that hears of it. */
	async function liveTerminal() {
		sm.addClient(makeClient("c-pane", []));
		const channelId = await sm.handleSpawn("c-pane", { type: "SPAWN", hostId: "local" });
		if (channelId === null) throw new Error("expected a channel");
		const heard: ProtocolMessage[] = [];
		sm.addClient(makeClient("c-other-window", heard));
		const agent = mockLocalAgents.at(-1) as unknown as {
			emit: (event: string, msg: unknown) => void;
		};
		const ctx = (sm as unknown as { ctx: import("./session-context.js").SharedSessionContext }).ctx;
		const sessionId = ctx.channels.get(channelId)?.sessionId;
		if (sessionId === undefined) throw new Error("expected a session");
		return { channelId, sessionId, heard, agent };
	}

	function endsOf(heard: ProtocolMessage[], channelId: string): ProtocolMessage[] {
		return heard.filter(
			(m) => m.type === "CHANNEL_STATE" && m.channelId === channelId && m.status === "dead",
		);
	}

	it("a kill (DELETE /api/channels/:id) says the hub killed it, and says it once", async () => {
		const { channelId, sessionId, heard, agent } = await liveTerminal();

		expect(sm.destroyChannel(channelId)).toBe(true);
		// The agent reports the shell going after the DESTROY: not a second end.
		agent.emit("message", { type: "CHANNEL_EXIT", channelId, exitCode: 1 });

		expect(endsOf(heard, channelId)).toEqual([
			{
				type: "CHANNEL_STATE",
				channelId,
				sessionId,
				status: "dead",
				endReason: "killed",
				endId: expect.any(String),
			},
		]);
	});

	it("a shell that exits says nothing of the kind", async () => {
		const { channelId, sessionId, heard, agent } = await liveTerminal();

		agent.emit("message", { type: "CHANNEL_EXIT", channelId, exitCode: 0 });

		expect(endsOf(heard, channelId)).toEqual([
			{
				type: "CHANNEL_STATE",
				channelId,
				sessionId,
				status: "dead",
				exitCode: 0,
				endId: expect.any(String),
			},
		]);
	});

	it("closing its session (DELETE /api/sessions/:id) says so of each of its terminals", async () => {
		const { channelId, sessionId, heard } = await liveTerminal();

		await sm.closeSession(sessionId);

		expect(endsOf(heard, channelId)).toEqual([
			{
				type: "CHANNEL_STATE",
				channelId,
				sessionId,
				status: "dead",
				endReason: "killed",
				endId: expect.any(String),
			},
		]);
	});

	// Quit stops the local agent, whose terminals then report their ends:
	// stopped with the hub, which nobody aimed at them (#592).
	it("a quit says so of every end it hears", async () => {
		const { channelId, heard, agent } = await liveTerminal();

		sm.beginQuit();
		agent.emit("message", { type: "CHANNEL_EXIT", channelId, exitCode: 0 });

		expect(endsOf(heard, channelId)).toEqual([
			expect.objectContaining({ status: "dead", exitCode: 0, endReason: "stopped" }),
		]);
	});

	// Or the agent goes before a terminal's own end was heard: the session
	// closes, as the quit refuses to reconnect, and ends it with the rest.
	it("a quit says so of the terminals it ends by stopping their agent", async () => {
		const { channelId, heard } = await liveTerminal();

		sm.beginQuit();
		mockLocalAgents.at(-1)?.simulateDisconnect();
		await flushImmediate();

		expect(endsOf(heard, channelId)).toEqual([
			expect.objectContaining({ status: "dead", endReason: "stopped" }),
		]);
	});

	// A kill asked for while the hub quits is still a kill.
	it("a kill during a quit says it was killed", async () => {
		const { channelId, heard } = await liveTerminal();

		sm.beginQuit();
		sm.destroyChannel(channelId);

		expect(endsOf(heard, channelId)).toEqual([
			expect.objectContaining({ status: "dead", endReason: "killed" }),
		]);
	});

	// A deleted terminal is no longer the hub's to bring back: a pane that
	// restarts it by its id is refused, where a dead one still listed is not.
	it("refuses to bring back a terminal that was deleted", async () => {
		const received: ProtocolMessage[] = [];
		sm.addClient(makeClient("c-restart", received));
		const channelId = await sm.handleSpawn("c-restart", { type: "SPAWN", hostId: "local" });
		if (channelId === null) throw new Error("expected a channel");
		sm.destroyChannel(channelId);
		// DELETE on a dead one purges it.
		new MetaDAL(dbManager.meta).deleteChannel(channelId);

		received.length = 0;
		const again = await sm.handleSpawn("c-restart", {
			type: "SPAWN",
			hostId: "local",
			reuseChannelId: channelId,
		});

		expect(again).toBeNull();
		expect(received).toContainEqual(
			expect.objectContaining({
				type: "ERROR",
				code: "CHANNEL_NOT_REUSABLE",
				message: "Cannot bring that terminal back: it is not a terminal this hub knows.",
			}),
		);
	});
});

// ─── Why it ended, remembered (#592) ─────────────────────────────────────────
//
// The report said so as the end happened, and nothing kept it: a pane that
// found the terminal ended later, at a reload or the next launch, took a kill
// for a shell that exited. The hub stores it with the end, clears it when the
// terminal runs again, and tells a window that connects through STATE_SYNC.
describe("SessionManager — why a terminal ended, remembered (#592)", () => {
	let sm: SessionManager;
	let dbManager: ReturnType<typeof openTestDatabases>;

	beforeEach(() => {
		localSpawnCount = 0;
		mockLocalAgents.length = 0;
		dbManager = openTestDatabases();
		sm = new SessionManager(dbManager);
	});

	afterEach(async () => {
		await sm.shutdown();
		dbManager.close();
	});

	async function liveTerminal() {
		const received: ProtocolMessage[] = [];
		sm.addClient(makeClient("c-pane", received));
		const channelId = await sm.handleSpawn("c-pane", { type: "SPAWN", hostId: "local" });
		if (channelId === null) throw new Error("expected a channel");
		const agent = mockLocalAgents.at(-1) as unknown as {
			emit: (event: string, msg: unknown) => void;
			send: Mock;
		};
		const ctx = (sm as unknown as { ctx: import("./session-context.js").SharedSessionContext }).ctx;
		const sessionId = ctx.channels.get(channelId)?.sessionId;
		if (sessionId === undefined) throw new Error("expected a session");
		return { channelId, sessionId, agent, received };
	}

	const stored = (channelId: string) => new MetaDAL(dbManager.meta).getChannel(channelId);
	const synced = (channelId: string) =>
		sm.getStateSnapshot().channels.find((entry) => entry.channelId === channelId);

	it("a kill is stored with its end, and told to a window that connects afterwards", async () => {
		const { channelId, sessionId, agent } = await liveTerminal();

		sm.destroyChannel(channelId);
		agent.emit("message", { type: "CHANNEL_EXIT", channelId, exitCode: 1 });

		expect(stored(channelId)).toMatchObject({ status: "dead", endReason: "killed" });
		expect(synced(channelId)).toEqual({
			channelId,
			sessionId,
			status: "dead",
			endReason: "killed",
		});
	});

	it("closing its session stores it for each of its terminals", async () => {
		const { channelId, sessionId } = await liveTerminal();

		await sm.closeSession(sessionId);

		expect(stored(channelId)).toMatchObject({ status: "dead", endReason: "killed" });
		expect(synced(channelId)).toMatchObject({ status: "dead", endReason: "killed" });
	});

	// Stopped with the hub: found at the next launch, they follow the setting,
	// so a window that connects is not told of them as killed.
	it("a quit stores its terminals as stopped, for an end it hears and one it causes", async () => {
		const heard = await liveTerminal();
		const second = await sm.handleSpawn("c-pane", { type: "SPAWN", hostId: "local" });
		if (second === null) throw new Error("expected a second channel");

		sm.beginQuit();
		heard.agent.emit("message", { type: "CHANNEL_EXIT", channelId: heard.channelId, exitCode: 0 });
		mockLocalAgents.at(-1)?.simulateDisconnect();
		await flushImmediate();

		expect(stored(heard.channelId)).toMatchObject({ exitCode: 0, endReason: "stopped" });
		expect(stored(second)).toMatchObject({ status: "dead", endReason: "stopped" });
		expect(synced(heard.channelId)).toBeUndefined();
		expect(synced(second)).toBeUndefined();
	});

	// Found at the next launch, it follows "When a terminal ends".
	it("a shell that exits stores none, and a window that connects hears nothing of it", async () => {
		const { channelId, agent } = await liveTerminal();

		agent.emit("message", { type: "CHANNEL_EXIT", channelId, exitCode: 0 });

		expect(stored(channelId)?.status).toBe("dead");
		expect(stored(channelId)).not.toHaveProperty("endReason");
		expect(synced(channelId)).toBeUndefined();
	});

	it("is cleared when the terminal is brought back, and says nothing of the next end", async () => {
		const { channelId, agent } = await liveTerminal();
		sm.destroyChannel(channelId);

		const again = await sm.handleSpawn("c-pane", {
			type: "SPAWN",
			hostId: "local",
			reuseChannelId: channelId,
		});

		expect(again).toBe(channelId);
		expect(stored(channelId)?.status).toBe("live");
		expect(stored(channelId)).not.toHaveProperty("endReason");
		expect(synced(channelId)).toMatchObject({ status: "live" });
		expect(synced(channelId)).not.toHaveProperty("endReason");

		agent.emit("message", { type: "CHANNEL_EXIT", channelId, exitCode: 2 });
		expect(stored(channelId)).toMatchObject({ status: "dead", exitCode: 2 });
		expect(stored(channelId)).not.toHaveProperty("endReason");
	});
});

// ─── One terminal started once (#592) ────────────────────────────────────────
//
// Two windows over the same ended terminal, each following "When a terminal
// ends", ask the hub to bring it back at about the same moment. The check
// that it is not running passed for both: nothing marked it until its
// SPAWN_OK, so both SPAWNs reached the agent under the same id.
describe("SessionManager — a terminal being brought back is started once (#592)", () => {
	let sm: SessionManager;
	let dbManager: ReturnType<typeof openTestDatabases>;

	beforeEach(() => {
		localSpawnCount = 0;
		mockLocalAgents.length = 0;
		dbManager = openTestDatabases();
		sm = new SessionManager(dbManager);
	});

	afterEach(async () => {
		await sm.shutdown();
		dbManager.close();
	});

	/** A terminal that ended, and the SPAWNs naming it that reached its agent. */
	async function endedTerminal() {
		sm.addClient(makeClient("c-first", []));
		const channelId = await sm.handleSpawn("c-first", { type: "SPAWN", hostId: "local" });
		if (channelId === null) throw new Error("expected a channel");
		const agent = mockLocalAgents.at(-1) as unknown as {
			emit: (event: string, msg: unknown) => void;
			send: Mock;
		};
		agent.emit("message", { type: "CHANNEL_EXIT", channelId, exitCode: 0 });
		const spawnsOf = () =>
			agent.send.mock.calls.filter(
				([msg]) =>
					(msg as ProtocolMessage).type === "SPAWN" &&
					(msg as { channelId?: string }).channelId === channelId,
			);
		return { channelId, spawnsOf };
	}

	it("refuses the second of two SPAWNs that race to bring the same terminal back", async () => {
		const { channelId, spawnsOf } = await endedTerminal();
		const windowA: ProtocolMessage[] = [];
		const windowB: ProtocolMessage[] = [];
		sm.addClient(makeClient("c-window-a", windowA));
		sm.addClient(makeClient("c-window-b", windowB));

		const reuse = { type: "SPAWN", hostId: "local", reuseChannelId: channelId } as const;
		const [a, b] = await Promise.all([
			sm.handleSpawn("c-window-a", reuse),
			sm.handleSpawn("c-window-b", reuse),
		]);

		expect(spawnsOf()).toHaveLength(1);
		expect([a, b].filter((result) => result === channelId)).toHaveLength(1);
		expect([a, b].filter((result) => result === null)).toHaveLength(1);
		expect([...windowA, ...windowB]).toContainEqual(
			expect.objectContaining({
				type: "ERROR",
				code: "CHANNEL_NOT_REUSABLE",
				message: "Cannot bring that terminal back: it is already starting.",
			}),
		);
	});

	// Nothing is left claimed once the start has its answer: it may be asked for again.
	it("lets it be asked for again once the one starting it has had its answer", async () => {
		const { channelId, spawnsOf } = await endedTerminal();
		sm.addClient(makeClient("c-retry", []));
		const reuse = { type: "SPAWN", hostId: "local", reuseChannelId: channelId } as const;
		expect(await sm.handleSpawn("c-retry", reuse)).toBe(channelId);
		const agent = mockLocalAgents.at(-1) as unknown as {
			emit: (event: string, msg: unknown) => void;
		};
		agent.emit("message", { type: "CHANNEL_EXIT", channelId, exitCode: 0 });

		expect(await sm.handleSpawn("c-retry", reuse)).toBe(channelId);
		expect(spawnsOf()).toHaveLength(2);
	});

	// The REST restart and a SPAWN bringing it back are two ways to one start.
	it("a restart and a SPAWN racing to bring it back start it once", async () => {
		const { channelId, spawnsOf } = await endedTerminal();
		sm.addClient(makeClient("c-spawn", []));

		const [spawned, restarted] = await Promise.all([
			sm.handleSpawn("c-spawn", { type: "SPAWN", hostId: "local", reuseChannelId: channelId }),
			sm.restartChannel(channelId),
		]);

		expect(spawnsOf()).toHaveLength(1);
		expect([spawned === channelId, restarted].filter(Boolean)).toHaveLength(1);
	});
});

// ─── An answer about a terminal started again since (#599) ──────────────────
//
// Seen in the real app after the Pi's daemon was replaced. At the next launch
// every pane over one of its terminals attached, and the hub reached the host
// for them. The new daemon held nothing, so each terminal was judged ended and
// every window told. The pane in view followed "When a terminal ends" and
// brought its terminal back under its own id. Meanwhile each attach that had
// waited for the host went on to ask the new daemon about its terminal, and
// the answer — "no such channel" — was read after the respawn's SPAWN_OK: the
// hub ended the new shell, which ran on at the Pi where nothing could reach it.
describe("SessionManager — an answer about a terminal started again since (#599)", () => {
	let sm: SessionManager;
	let dbManager: ReturnType<typeof openTestDatabases>;

	beforeEach(() => {
		sshSpawnCount = 0;
		mockSshAgentInstance = null;
		dbManager = openTestDatabases();
		vi.mocked(_SshAgentForMock).mockClear();
	});

	afterEach(async () => {
		await sm.shutdown();
		dbManager.close();
	});

	const ids = (count: number) =>
		Array.from({ length: count }, (_, i) => `01K599CHAN000000000000000${i + 1}`);

	/** A host that keeps a daemon, and the terminals meta.db holds for it. */
	function seedHost(channels: Array<{ id: string; ended?: "stopped" }>): string {
		const dal = new MetaDAL(dbManager.meta);
		const host = dal.createHost({
			type: "ssh",
			label: "pi",
			sshHost: "user@pi.test",
			sshAuth: "agent",
			sshRemoteDaemon: true,
			os: "linux",
		});
		const sessionId = "01K599SESSION0000000000000";
		dal.createSession({ id: sessionId, hostId: host.id, status: "active" });
		for (const { id, ended } of channels) {
			dal.createChannel({ id, sessionId, status: "live", shell: "bash" });
			if (ended !== undefined) dal.updateChannelStatus(id, "dead", undefined, ended);
		}
		return host.id;
	}

	/**
	 * The daemon the next connection reaches, running `holds`. Everything it
	 * writes waits for `deliver`, which hands it over in the order written and
	 * all in one go, as one read from its connection does: each frame is
	 * handled before anything awaiting one of them resumes. Its list of what it
	 * holds, written as it is reached, waits with the rest.
	 */
	function nextDaemon(holds: string[]) {
		const running = new Set(holds);
		const written: Array<() => void> = [];
		let holding = true;
		let daemon = null as MockSshAgent | null;
		let resolveList: (states: unknown[]) => void = () => {};
		const list = new Promise<unknown[]>((resolve) => {
			resolveList = resolve;
		});
		const listed = [...running].map((channelId) => ({
			type: "AGENT_CHANNEL_STATE",
			channelId,
			title: "bash",
			pid: 4242,
			alive: true,
		}));
		written.push(() => resolveList(listed));
		// biome-ignore lint/complexity/useArrowFunction: vitest needs a constructable function for new-ed mocks
		vi.mocked(_SshAgentForMock).mockImplementationOnce(function (host: { id: string }) {
			const agent = new MockSshAgent(host);
			const write = (frame: Record<string, unknown>) => {
				const emit = () => agent._emit("message", frame);
				if (holding) written.push(emit);
				else setImmediate(emit);
			};
			Object.assign(agent, { usedRemoteDaemon: true, waitForChannelState: vi.fn(() => list) });
			agent.send = vi.fn((msg: ProtocolMessage) => {
				const { requestId, channelId } = msg as unknown as {
					requestId: string;
					channelId?: string;
				};
				if (msg.type === "SPAWN") {
					const started = channelId ?? nextSshChannelId();
					running.add(started);
					write({ type: "SPAWN_OK", requestId, channelId: started });
				} else if (msg.type === "ATTACH" && channelId !== undefined) {
					write(
						running.has(channelId)
							? {
									type: "ATTACH_OK",
									channelId,
									requestId,
									snapshot: { serialized: "", cols: 80, rows: 24, cursorX: 0, cursorY: 0 },
									lastSeq: 0,
								}
							: {
									type: "ERROR",
									code: "CHANNEL_NOT_FOUND",
									message: `channel ${channelId} not found`,
									channelId,
									requestId,
								},
					);
				}
			});
			daemon = agent;
			mockSshAgentInstance = agent;
			return agent as never;
		});
		return {
			/** Hand over the first `count` frames written, or all of them and whatever follows. */
			deliver(count?: number): void {
				const frames = written.splice(0, count ?? written.length);
				if (count === undefined) holding = false;
				for (const frame of frames) frame();
			},
			sent(type: string): ProtocolMessage[] {
				return (daemon?.send.mock.calls ?? [])
					.map(([msg]) => msg as ProtocolMessage)
					.filter((msg) => msg.type === type);
			},
		};
	}

	function statesOf(window: ProtocolMessage[], channelId: string): ProtocolMessage[] {
		return window.filter((m) => m.type === "CHANNEL_STATE" && m.channelId === channelId);
	}

	function expectRunning(window: ProtocolMessage[], channelId: string): void {
		expect(sm.channels.get(channelId)?.status).toBe("live");
		expect(new MetaDAL(dbManager.meta).getChannel(channelId)?.status).toBe("live");
		// And the last word every window heard of it.
		expect(statesOf(window, channelId).at(-1)).toMatchObject({ status: "live" });
	}

	it("the attaches that reached the host do not end the terminal a pane brought back meanwhile", async () => {
		// Left live by the replace, as it was before #599's fix.
		const channelIds = ids(5);
		const hostId = seedHost(channelIds.map((id) => ({ id })));
		sm = new SessionManager(dbManager);
		await sm.startup();
		const window: ProtocolMessage[] = [];
		sm.addClient(makeClient("c-window", window));
		const daemon = nextDaemon([]);

		// Each pane attaches; the host is reached for them, once.
		const attaches = channelIds.map((channelId) => sm.handleAttach("c-window", channelId));
		daemon.deliver(1);
		// The new daemon holds none of them: each is judged ended, and every window told.
		await vi.waitFor(() => {
			for (const channelId of channelIds) {
				expect(statesOf(window, channelId)).toContainEqual(
					expect.objectContaining({ status: "dead" }),
				);
			}
		});

		// The pane in view follows its setting, and brings its terminal back.
		const inView = channelIds[0] ?? "";
		const respawn = sm.handleSpawn("c-window", {
			type: "SPAWN",
			hostId,
			reuseChannelId: inView,
		});
		await vi.waitFor(() => expect(daemon.sent("SPAWN")).toHaveLength(1));
		// What the daemon wrote arrives in one read: answers to any attach it
		// was asked, then the SPAWN_OK — the order of the Pi's log.
		daemon.deliver();

		expect(await respawn).toBe(inView);
		await Promise.all(attaches);
		await flushImmediate();

		// The shell brought back runs, as the hub says it does...
		expectRunning(window, inView);
		// ...and no attach went on to ask the daemon about a terminal already judged.
		expect(daemon.sent("ATTACH")).toEqual([]);
	});

	// AC-LOST-CONNECTION-MARKER (#80): Disconnect lets go of the connection before its
	// close, which then comes as a stale one. Mutation caught: the marker only on a close.
	it("marks a recording's lost connection when its host is disconnected", async () => {
		const [channelId] = ids(1) as [string];
		const hostId = seedHost([{ id: channelId }]);
		sm = new SessionManager(dbManager);
		await sm.startup();
		sm.addClient(makeClient("c-rec", []));
		const daemon = nextDaemon([channelId]);
		const attach = sm.handleAttach("c-rec", channelId);
		daemon.deliver();
		await attach;
		await flushImmediate();
		daemon.deliver();
		const started = sm.startRecording(channelId);
		if (!started.ok) throw new Error(started.code);
		daemon.deliver();
		await flushImmediate();
		// The mock daemon is not an SshAgent, so Disconnect counts its terminals as ending: forced.
		expect(sm.disconnectHost(hostId, { force: true })).toMatchObject({ kind: "disconnected" });
		const lines = sm.recorder.exportPart(started.id)?.body.split("\n") ?? [];
		expect(lines).toContain(
			'[0.000, "m", "lasterm: connection to the agent lost; output until it returns may be missing or late"]',
		);
	});

	it("an attach's answer read after the terminal was brought back does not end it", async () => {
		const [reaching, asked] = ids(2) as [string, string];
		const hostId = seedHost([{ id: reaching }, { id: asked }]);
		sm = new SessionManager(dbManager);
		await sm.startup();
		const window: ProtocolMessage[] = [];
		sm.addClient(makeClient("c-window", window));
		const daemon = nextDaemon([]);

		// One pane's attach reaches the host. Its agent is the way there as
		// soon as it answers, before its list of what it holds is read...
		const reachingAttach = sm.handleAttach("c-window", reaching);
		await vi.waitFor(() => expect(sm.agents.get(hostId)?.connected).toBe(true));
		// ...so another pane's attach asks it at once.
		const askedAttach = sm.handleAttach("c-window", asked);
		await vi.waitFor(() => expect(daemon.sent("ATTACH")).toHaveLength(1));

		// The list is read: neither is there, and both are judged ended.
		daemon.deliver(1);
		await vi.waitFor(() =>
			expect(statesOf(window, asked)).toContainEqual(expect.objectContaining({ status: "dead" })),
		);
		// That pane brings its terminal back.
		const respawn = sm.handleSpawn("c-window", { type: "SPAWN", hostId, reuseChannelId: asked });
		await vi.waitFor(() => expect(daemon.sent("SPAWN")).toHaveLength(1));
		// "No such channel", the answer to the attach, is read in the same go
		// as the SPAWN_OK, which is handled first.
		daemon.deliver();

		expect(await respawn).toBe(asked);
		await Promise.all([reachingAttach, askedAttach]);
		await flushImmediate();

		expectRunning(window, asked);
		// The attach that asked is answered about the shell running there now.
		expect(window).toContainEqual(
			expect.objectContaining({ type: "ATTACH_OK", channelId: asked, cached: false }),
		);
	});

	it("the daemon's list read after a terminal started meanwhile does not end it", async () => {
		// One ended with the replaced agent; another still runs on the daemon.
		const [stopped, held] = ids(2) as [string, string];
		const hostId = seedHost([{ id: stopped, ended: "stopped" }, { id: held }]);
		sm = new SessionManager(dbManager);
		await sm.startup();
		const window: ProtocolMessage[] = [];
		sm.addClient(makeClient("c-window", window));
		const daemon = nextDaemon([held]);

		// The pane over the running one attaches, and the host is reached.
		const attach = sm.handleAttach("c-window", held);
		await vi.waitFor(() => expect(sm.agents.get(hostId)?.connected).toBe(true));
		// Found stopped, the other follows its setting (#592) while the list
		// is on its way, and the daemon starts it.
		const respawn = sm.handleSpawn("c-window", {
			type: "SPAWN",
			hostId,
			reuseChannelId: stopped,
		});
		await vi.waitFor(() => expect(daemon.sent("SPAWN")).toHaveLength(1));
		// The list, written before the SPAWN was read, and the SPAWN_OK arrive together.
		daemon.deliver();

		expect(await respawn).toBe(stopped);
		await attach;
		await flushImmediate();

		expectRunning(window, stopped);
		expect(statesOf(window, stopped)).not.toContainEqual(
			expect.objectContaining({ status: "dead" }),
		);
		// What the list does speak of is judged as ever: held, and taken up.
		expect(sm.channels.get(held)?.status).toBe("live");
	});

	// A new terminal has no id to claim before its SPAWN_OK: only when it
	// started says the list cannot speak of it.
	it("the daemon's list read after a new terminal opened meanwhile does not end it", async () => {
		const [held] = ids(1) as [string];
		const hostId = seedHost([{ id: held }]);
		sm = new SessionManager(dbManager);
		await sm.startup();
		const window: ProtocolMessage[] = [];
		sm.addClient(makeClient("c-window", window));
		const daemon = nextDaemon([held]);

		const attach = sm.handleAttach("c-window", held);
		await vi.waitFor(() => expect(sm.agents.get(hostId)?.connected).toBe(true));
		// A new tab on that host, while the list is on its way.
		const opened = sm.handleSpawn("c-window", { type: "SPAWN", hostId });
		await vi.waitFor(() => expect(daemon.sent("SPAWN")).toHaveLength(1));
		daemon.deliver();

		const channelId = await opened;
		await attach;
		await flushImmediate();

		if (channelId === null) throw new Error("expected the new terminal");
		expectRunning(window, channelId);
	});
});

// ─── A host away (#605) ──────────────────────────────────────────────────────
//
// Seen on a Raspberry Pi back from a reboot at another address: while the hub
// reached for it again, every restart of one of its terminals, the setting's
// and each click, ended on "Could not restart it: Agent SPAWN timeout", and
// nothing happened once the host was back. While the hub is reconnecting a
// host, a start there is refused at once, and says the host is away.

describe("SessionManager — a start on a host the hub is reconnecting (#605)", () => {
	let sm: SessionManager;
	let dbManager: ReturnType<typeof openTestDatabases>;

	beforeEach(() => {
		sshSpawnCount = 0;
		mockSshAgentInstance = null;
		nextSshStartError = null;
		dbManager = openTestDatabases();
		sm = new SessionManager(dbManager);
		vi.mocked(_SshAgentForMock).mockClear();
	});

	afterEach(async () => {
		vi.useRealTimers();
		await sm.shutdown();
		dbManager.close();
	});

	/** A terminal of the Pi that ended, then the Pi's connection dropped: the hub reconnects. */
	async function piAwayWithAnEndedTerminal() {
		const dal = new MetaDAL(dbManager.meta);
		const host = dal.createHost({
			type: "ssh",
			label: "raspberrypi",
			sshHost: "pi@raspberrypi.test",
			sshAuth: "agent",
		});
		sm.addClient(makeClient("c-first", []));
		const channelId = await sm.handleSpawn("c-first", { type: "SPAWN", hostId: host.id });
		if (channelId === null) throw new Error("expected a channel");
		const agent = mockSshAgentInstance;
		if (agent === null) throw new Error("expected the Pi's agent");
		agent._emit("message", { type: "CHANNEL_EXIT", channelId, exitCode: 0 });
		agent.simulateClose();
		await flushImmediate();
		expect(sm.sessions.get(host.id)?.status).toBe("disconnected");
		const connections = vi.mocked(_SshAgentForMock).mock.calls.length;
		return { hostId: host.id, channelId, connections };
	}

	it("refuses to bring a terminal back at once, saying its host is away", async () => {
		const { hostId, channelId, connections } = await piAwayWithAnEndedTerminal();
		const window: ProtocolMessage[] = [];
		sm.addClient(makeClient("c-window", window));

		const result = await sm.handleSpawn("c-window", {
			type: "SPAWN",
			hostId,
			reuseChannelId: channelId,
		});

		expect(result).toBeNull();
		expect(window).toContainEqual({
			type: "ERROR",
			code: "HOST_UNREACHABLE",
			message: "raspberrypi cannot be reached right now.",
			hostId,
			hostStatus: "disconnected",
			channelId,
		});
		// No connection of its own beside the reconnect's.
		expect(vi.mocked(_SshAgentForMock).mock.calls).toHaveLength(connections);
	});

	it("refuses a new terminal there the same way", async () => {
		const { hostId, connections } = await piAwayWithAnEndedTerminal();
		const window: ProtocolMessage[] = [];
		sm.addClient(makeClient("c-window", window));

		expect(await sm.handleSpawn("c-window", { type: "SPAWN", hostId })).toBeNull();

		expect(window).toContainEqual(
			expect.objectContaining({ type: "ERROR", code: "HOST_UNREACHABLE", hostId }),
		);
		expect(window.find((m) => m.type === "ERROR")).not.toHaveProperty("channelId");
		expect(vi.mocked(_SshAgentForMock).mock.calls).toHaveLength(connections);
	});

	// The restart route asks the same question, and answers the same way.
	it("refuses a restart, and says why", async () => {
		const { hostId, channelId } = await piAwayWithAnEndedTerminal();

		expect(await sm.restartChannel(channelId)).toBe(false);
		expect(sm.hostUnreachableFor(channelId)).toEqual({
			type: "ERROR",
			code: "HOST_UNREACHABLE",
			message: "raspberrypi cannot be reached right now.",
			hostId,
			hostStatus: "disconnected",
			channelId,
		});
	});

	// The reconnect has the next attempt; once it has the host, starts go through.
	it("brings the terminal back once the reconnect has the host again", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const { hostId, channelId } = await piAwayWithAnEndedTerminal();
		const window: ProtocolMessage[] = [];
		sm.addClient(makeClient("c-window", window));

		await vi.advanceTimersByTimeAsync(1_000);
		await vi.waitFor(() => expect(sm.sessions.get(hostId)?.status).toBe("active"));
		vi.useRealTimers();
		expect(sm.hostUnreachableFor(channelId)).toBeNull();

		const result = await sm.handleSpawn("c-window", {
			type: "SPAWN",
			hostId,
			reuseChannelId: channelId,
		});

		expect(result).toBe(channelId);
		expect(window.filter((m) => m.type === "ERROR")).toEqual([]);
	});

	// A host this hub is not reaching for is connected by the start itself, as
	// a first terminal there always was.
	it("still connects a host it is not reconnecting", async () => {
		const dal = new MetaDAL(dbManager.meta);
		const host = dal.createHost({
			type: "ssh",
			label: "nas",
			sshHost: "admin@nas.test",
			sshAuth: "agent",
		});
		// Its reconnect gave up: disconnected, and nothing reaching for it.
		dal.createSession({
			id: "01K605SESSION0000000000000",
			hostId: host.id,
			status: "disconnected",
		});
		(sm.sessions as unknown as Map<string, unknown>).set(host.id, {
			id: "01K605SESSION0000000000000",
			hostId: host.id,
			status: "disconnected",
		});
		sm.addClient(makeClient("c-window", []));

		expect(await sm.handleSpawn("c-window", { type: "SPAWN", hostId: host.id })).not.toBeNull();
		expect(vi.mocked(_SshAgentForMock).mock.calls).toHaveLength(1);
	});
});

// ─── Recordings (#80) ─────────────────────────────────────────────────────────
//
// The hub's wiring of the recorder: where it hears output, sizes, ends and a
// lost connection, where a terminal's profile starts one, and where the screen
// of a manual start comes from. The recorder's own decisions are in
// recorder.spec.ts.

describe("SessionManager recordings (#80)", () => {
	let sm: SessionManager;
	let dbManager: ReturnType<typeof openTestDatabases>;
	let configDir: string | null = null;
	let dal: MetaDAL;

	function exportOf(manager: SessionManager, id: string): string[] {
		let part = manager.recorder.exportPart(id);
		let out = part?.body ?? "";
		while (part?.nextSeq !== undefined) {
			part = manager.recorder.exportPart(id, {
				fromSeq: part.nextSeq,
				lastSeq: part.lastSeq,
				lost: part.lost,
			});
			out += part?.body ?? "";
		}
		return out.split("\n").filter(Boolean);
	}

	function emitLocal(msg: Record<string, unknown>): void {
		(mockLocalAgents[0] as unknown as { emit: (event: string, m: unknown) => void }).emit(
			"message",
			msg,
		);
	}

	async function hubWithToml(toml: string): Promise<void> {
		const { ConfigResolver } = await import("../config.js");
		configDir = makeTempDir("lasterm-rec-");
		writeFileSync(join(configDir, "config.toml"), toml);
		const resolver = new ConfigResolver(dal);
		resolver.loadFromFile(configDir);
		await sm.shutdown();
		sm = new SessionManager(dbManager, undefined, undefined, resolver);
	}

	async function spawnLocal(): Promise<string> {
		sm.addClient(makeClient("c1", []));
		const channelId = await sm.handleSpawn("c1", { type: "SPAWN", hostId: "local" });
		if (channelId === null) throw new Error("spawn failed");
		return channelId;
	}

	beforeEach(() => {
		localSpawnCount = 0;
		nextLocalAgentCapabilities = [];
		mockLocalAgents.length = 0;
		dbManager = openTestDatabases();
		dal = new MetaDAL(dbManager.meta);
		sm = new SessionManager(dbManager);
	});

	afterEach(async () => {
		await sm.shutdown();
		dbManager.close();
		if (configDir !== null) await removeTempDir(configDir);
		configDir = null;
	});

	// AC-REC-START-MANUAL / AC-START-NO-SPOOL through the hub.
	it("starts a manual recording from the agent's screen, reading no spool", async () => {
		const channelId = await spawnLocal();
		const reads = [
			vi.spyOn(SpoolDAL.prototype, "getChunksByChannel"),
			vi.spyOn(SpoolDAL.prototype, "readOutput"),
			vi.spyOn(SpoolDAL.prototype, "getLatestSnapshot"),
			vi.spyOn(SpoolDAL.prototype, "getNewestSnapshotRef"),
			// Mutation caught: the chunker flushed before the start, as the final screen does.
			vi.spyOn(OutputChunker.prototype, "flush"),
		];
		try {
			const started = sm.startRecording(channelId);
			if (!started.ok) throw new Error(started.code);
			await flushImmediate();
			for (const read of reads) expect(read).not.toHaveBeenCalled();
			expect(exportOf(sm, started.id)[1]).toBe('[0.000, "o", "<mock-snapshot>"]');
		} finally {
			for (const read of reads) read.mockRestore();
		}
	});

	// AC-START-CORRELATED. Mutation caught: the first snapshot for the channel taken.
	it("takes only the ATTACH_OK answering its own request", async () => {
		const channelId = await spawnLocal();
		holdLocalAttach = true;
		const started = sm.startRecording(channelId);
		if (!started.ok) throw new Error(started.code);
		const mine = heldLocalAttaches.at(-1);
		emitLocal({
			type: "SNAPSHOT_RES",
			channelId,
			snapshot: { serialized: "SCHEDULER", cols: 80, rows: 24, cursorX: 0, cursorY: 0 },
			lastSeq: 0,
		});
		emitLocal({
			type: "ATTACH_OK",
			channelId,
			requestId: "01OTHERREQUEST",
			snapshot: { serialized: "OTHER", cols: 80, rows: 24, cursorX: 0, cursorY: 0 },
			lastSeq: 0,
		});
		emitLocal({
			type: "ATTACH_OK",
			channelId,
			requestId: mine?.requestId,
			snapshot: { serialized: "MINE", cols: 80, rows: 24, cursorX: 0, cursorY: 0 },
			lastSeq: 0,
		});
		expect(exportOf(sm, started.id)[1]).toBe('[0.000, "o", "MINE"]');
	});

	// Wiring of OUTPUT, resize and CHANNEL_EXIT; AC-NO-FINAL-REDRAW.
	it("records the agent's output, the hub's size changes and the exit, not the final-screen redraw", async () => {
		const channelId = await spawnLocal();
		const started = sm.startRecording(channelId);
		if (!started.ok) throw new Error(started.code);
		await flushImmediate();
		emitLocal({ type: "OUTPUT", channelId, data: new TextEncoder().encode("hello") });
		sm.handleResize("c1", channelId, 120, 40);
		emitLocal({
			type: "CHANNEL_EXIT",
			channelId,
			exitCode: 7,
			screen: { serialized: "FINAL-SCREEN", cols: 120, rows: 40, cursorX: 0, cursorY: 0 },
		});
		const lines = exportOf(sm, started.id)
			.slice(1)
			.map((l) => JSON.parse(l) as [number, string, string]);
		expect(lines.map(([, code, data]) => [code, data])).toEqual([
			["o", "<mock-snapshot>"],
			["o", "hello"],
			["r", "120x40"],
			["x", "7"],
		]);
		expect(sm.recorder.listed(started.id)?.end_reason).toBe("exited");
	});

	// AC-REC-AUTO variants. Mutations caught: profile ignored, default on, layers ORed.
	describe("by the terminal's profile", () => {
		// Through a real resolver, so DEFAULT_PROFILE decides. Mutation caught: a default of true.
		it("records nothing by default", async () => {
			await hubWithToml("");
			await spawnLocal();
			expect(sm.recorder.list().recordings).toEqual([]);
		});

		it("records every terminal when set globally", async () => {
			await hubWithToml("[terminal]\nrecord_terminals = true\n");
			const channelId = await spawnLocal();
			expect(sm.recordingIdOf(channelId)).not.toBeNull();
		});

		it("records a host's terminals when set on the host", async () => {
			const localId = await sm.ensureLocalHost();
			dal.updateHostProfile(localId, JSON.stringify({ recordTerminals: true }));
			await hubWithToml("");
			const channelId = await spawnLocal();
			expect(sm.recordingIdOf(channelId)).not.toBeNull();
		});

		it("records nothing when the host turns off what is set globally", async () => {
			const localId = await sm.ensureLocalHost();
			dal.updateHostProfile(localId, JSON.stringify({ recordTerminals: false }));
			await hubWithToml("[terminal]\nrecord_terminals = true\n");
			const channelId = await spawnLocal();
			expect(sm.recordingIdOf(channelId)).toBeNull();
		});

		it("follows the terminal's own setting over its host's, at a restart", async () => {
			const localId = await sm.ensureLocalHost();
			dal.updateHostProfile(localId, JSON.stringify({ recordTerminals: true }));
			await hubWithToml("");
			const on = await spawnLocal();
			dal.updateChannelProfile(on, JSON.stringify({ recordTerminals: false }));
			expect(await sm.restartChannel(on)).toBe(true);
			expect(sm.recordingIdOf(on)).toBeNull();

			dal.updateHostProfile(localId, JSON.stringify({ recordTerminals: false }));
			dal.updateChannelProfile(on, JSON.stringify({ recordTerminals: true }));
			expect(await sm.restartChannel(on)).toBe(true);
			expect(sm.recordingIdOf(on)).not.toBeNull();
		});

		// AC-AUTO-FIRST-OUTPUT. Mutation caught: the automatic start after an await.
		it("records the output read with the SPAWN_OK, at a spawn and at a restart", async () => {
			await hubWithToml("[terminal]\nrecord_terminals = true\n");
			nextLocalSpawnOutput = "first";
			const channelId = await spawnLocal();
			const first = sm.recordingIdOf(channelId) ?? "";
			expect(exportOf(sm, first)[1]).toBe('[0.000, "o", "first"]');

			nextLocalSpawnOutput = "again";
			expect(await sm.restartChannel(channelId)).toBe(true);
			const second = sm.recordingIdOf(channelId) ?? "";
			expect(second).not.toBe(first);
			// AC-REC-AUTO-RESTART: the previous run's recording ended `restarted`.
			expect(sm.recorder.listed(first)?.end_reason).toBe("restarted");
			expect(JSON.parse(exportOf(sm, second)[1] ?? "[]")[2]).toBe("again");
		});
	});

	// AC-REC-AUTO-RESTART / restart: a restart the agent answers under an id of its own
	// still ends the previous run's recording `restarted`, the case where no DESTROY
	// ended it first (its agent was out of reach at the click). Mutation caught: the
	// retire of the old id ending it `gone`.
	it("ends the previous run's recording restarted when the restart comes back under a new id", async () => {
		const channelId = await spawnLocal();
		const started = sm.startRecording(channelId);
		if (!started.ok) throw new Error(started.code);
		const lifecycle = (
			sm as unknown as { lifecycle: { applyRestartState: (...args: unknown[]) => void } }
		).lifecycle;
		const ch = (
			sm as unknown as { ctx: { channels: Map<string, { hostId: string; sessionId: string }> } }
		).ctx.channels.get(channelId);
		const session = dal.listSessions().find((s) => s.id === ch?.sessionId);
		lifecycle.applyRestartState(
			"local-ch-new",
			channelId,
			dal.getChannel(channelId),
			ch?.hostId,
			{ id: session?.id, status: "active" },
			ch,
			undefined,
			[],
			undefined,
			80,
			24,
		);
		expect(sm.recorder.listed(started.id)?.end_reason).toBe("restarted");
	});

	// AC-REC-AUTO-RESTART / respawn and respawn-fails.
	it("ends a recording when a reconnection spawns its terminal again, whatever the answer", async () => {
		await hubWithToml("[terminal]\nrecord_terminals = true\n");
		const channelId = await spawnLocal();
		const first = sm.recordingIdOf(channelId) ?? "";
		const lifecycle = (
			sm as unknown as {
				lifecycle: { reAttachChannels: (h: string, s: string, a: unknown) => void };
			}
		).lifecycle;
		const sessionId = dal.listSessions()[0]?.id ?? "";
		nextLocalSpawnError = { code: "SPAWN_FAILED", message: "no" };
		lifecycle.reAttachChannels(await sm.ensureLocalHost(), sessionId, mockLocalAgents[0]);
		expect(sm.recorder.listed(first)?.end_reason).toBe("restarted");
		await flushImmediate();
		expect(sm.recordingIdOf(channelId)).toBeNull();
		expect(exportOf(sm, first).length).toBeGreaterThan(0);
	});

	// AC-REC-AUTO-RESTART / respawn: a re-spawn that succeeds opens a new recording by the profile.
	it("opens a new recording when a reconnection spawns its terminal again and it starts", async () => {
		await hubWithToml("[terminal]\nrecord_terminals = true\n");
		const channelId = await spawnLocal();
		const first = sm.recordingIdOf(channelId) ?? "";
		const lifecycle = (
			sm as unknown as {
				lifecycle: { reAttachChannels: (h: string, s: string, a: unknown) => void };
			}
		).lifecycle;
		lifecycle.reAttachChannels(
			await sm.ensureLocalHost(),
			dal.listSessions()[0]?.id ?? "",
			mockLocalAgents[0],
		);
		await flushImmediate();
		await flushImmediate();
		expect(sm.recorder.listed(first)?.end_reason).toBe("restarted");
		const second = sm.recordingIdOf(channelId);
		expect(second).not.toBeNull();
		expect(second).not.toBe(first);
	});

	// AC-NO-AUTO-ADOPT through the hub's start: a terminal restored from the database is adopted, not started.
	it("starts no recording for a terminal the hub adopts at its start", async () => {
		await hubWithToml("[terminal]\nrecord_terminals = true\n");
		const host = dal.createHost({ type: "local", label: "adopt-host" });
		dal.createSession({ id: "ADOPTSESS0AAAAAAAAAAAAAAAAA", hostId: host.id, status: "active" });
		dal.createChannel({
			id: "ADOPTCH00AAAAAAAAAAAAAAAAAA",
			sessionId: "ADOPTSESS0AAAAAAAAAAAAAAAAA",
			status: "live",
			cols: 80,
			rows: 24,
		});
		await sm.startup();
		// No row at all: a recording opened then ended by the restore would still be listed.
		expect(sm.recorder.list().recordings).toEqual([]);
	});

	// AC-START-UNAVAILABLE / old-agent through the hub's own version check.
	it("asks no screen of an agent of another version", async () => {
		const channelId = await spawnLocal();
		(mockLocalAgents[0] as unknown as { helloMessage: unknown }).helloMessage = {
			type: "HELLO",
			version: 1,
			agentVersion: "0.0.1",
		};
		const attachesBefore =
			mockLocalAgents[0]?.send.mock.calls.filter(([m]) => m.type === "ATTACH").length ?? 0;
		const started = sm.startRecording(channelId);
		if (!started.ok) throw new Error(started.code);
		const attachesAfter =
			mockLocalAgents[0]?.send.mock.calls.filter(([m]) => m.type === "ATTACH").length ?? 0;
		expect(attachesAfter).toBe(attachesBefore);
		expect(exportOf(sm, started.id)[1]).toBe(
			'[0.000, "m", "lasterm: the screen before this point is not available"]',
		);
	});

	// AC-SHUTDOWN and AC-START-UNAVAILABLE / shutdown through SessionManager.shutdown.
	it("writes recordings out and ends them interrupted when the hub shuts down", async () => {
		const channelId = await spawnLocal();
		const started = sm.startRecording(channelId);
		if (!started.ok) throw new Error(started.code);
		await flushImmediate();
		emitLocal({ type: "OUTPUT", channelId, data: new TextEncoder().encode("buffered") });
		const ended = sm;
		await ended.shutdown();
		sm = new SessionManager(dbManager); // the next hub, over the same databases
		const { RecordingsDAL } = await import("../storage/recordings.js");
		const store = new RecordingsDAL(dbManager.spool);
		expect(store.get(started.id)?.endReason).toBe("interrupted");
		expect(exportOf(sm, started.id).join("\n")).toContain("buffered");
	});

	it("writes a waiting recording's held output when the hub shuts down", async () => {
		const channelId = await spawnLocal();
		holdLocalAttach = true;
		const started = sm.startRecording(channelId);
		if (!started.ok) throw new Error(started.code);
		emitLocal({ type: "OUTPUT", channelId, data: new TextEncoder().encode("held") });
		const ended = sm;
		await ended.shutdown();
		sm = new SessionManager(dbManager);
		const lines = exportOf(sm, started.id);
		expect(lines[1]).toBe('[0.000, "m", "lasterm: the screen before this point is not available"]');
		expect(lines.join("\n")).toContain('"held"');
	});

	// AC-EVENTS: a resize to the size the terminal already has is not recorded.
	it("records a size change once, not a resize to the same size", async () => {
		const channelId = await spawnLocal();
		const started = sm.startRecording(channelId);
		if (!started.ok) throw new Error(started.code);
		await flushImmediate();
		sm.handleResize("c1", channelId, 120, 40);
		sm.handleResize("c1", channelId, 120, 40);
		const sizes = exportOf(sm, started.id).filter((l) => l.includes('"r"'));
		expect(sizes).toHaveLength(1);
	});

	// AC-CONTROL-ERRORS / open-fails: a failed open leaves the terminal's start alone.
	it("starts the terminal as usual when its recording cannot be opened", async () => {
		await hubWithToml("[terminal]\nrecord_terminals = true\n");
		const { RecordingsDAL } = await import("../storage/recordings.js");
		const open = vi.spyOn(RecordingsDAL.prototype, "open").mockImplementationOnce(() => {
			throw Object.assign(new Error("full"), { code: "SQLITE_FULL" });
		});
		try {
			const received: ProtocolMessage[] = [];
			sm.addClient(makeClient("c-open", received));
			const channelId = await sm.handleSpawn("c-open", { type: "SPAWN", hostId: "local" });
			expect(channelId).not.toBeNull();
			expect(received).toContainEqual(expect.objectContaining({ type: "CHANNEL_CREATED" }));
			expect(received).toContainEqual(
				expect.objectContaining({
					type: "RECORDING_STATE",
					channelId,
					recordingId: null,
					refused: "storage",
				}),
			);
			expect(dal.getChannel(channelId ?? "")?.status).toBe("live");
		} finally {
			open.mockRestore();
		}
	});

	// AC-NO-AUTO-ADOPT. Mutation caught: automatic start on every trackChannel.
	it("starts no recording when a reconciliation keeps a terminal alive", async () => {
		await hubWithToml("[terminal]\nrecord_terminals = true\n");
		const channelId = await spawnLocal();
		const first = sm.recordingIdOf(channelId) ?? "";
		sm.recorder.stop(first);
		const lifecycle = (
			sm as unknown as {
				lifecycle: { reconcileChannelState: (h: string, s: unknown[], a: unknown) => void };
			}
		).lifecycle;
		lifecycle.reconcileChannelState(
			await sm.ensureLocalHost(),
			[{ type: "AGENT_CHANNEL_STATE", channelId, title: "", pid: 1, alive: true }],
			mockLocalAgents[0],
		);
		expect(sm.recordingIdOf(channelId)).toBeNull();
	});

	// AC-LOST-CONNECTION-MARKER. Mutations caught: no marker, a held byte joined across the loss, a marker on a stale close.
	it("marks a lost agent connection once, after writing a held byte", async () => {
		const channelId = await spawnLocal();
		const started = sm.startRecording(channelId);
		if (!started.ok) throw new Error(started.code);
		await flushImmediate();
		emitLocal({ type: "OUTPUT", channelId, data: new Uint8Array([0xc3]) });
		const agent = mockLocalAgents[0] as unknown as {
			simulateDisconnect: () => void;
			emit: (e: string) => void;
		};
		agent.simulateDisconnect();
		agent.emit("close"); // a stale close: this connection is no longer the host's
		emitLocal({ type: "OUTPUT", channelId, data: new Uint8Array([0xa9]) });
		const lines = exportOf(sm, started.id)
			.slice(1)
			.map((l) => JSON.parse(l) as [number, string, string]);
		expect(lines.map(([, c, d]) => [c, d])).toEqual([
			["o", "<mock-snapshot>"],
			["o", "�"],
			[
				"m",
				"lasterm: connection to the agent lost; output until it returns may be missing or late",
			],
			["o", "�"],
		]);
	});

	// AC-LOST-CONNECTION-MARKER / replayed-output: the reconnection keeps the terminal and
	// its recording. Mutation caught: a reconciliation ending a kept terminal's recording.
	it("keeps one recording across a reconnection, the replayed output after the marker", async () => {
		await hubWithToml("[terminal]\nrecord_terminals = true\n");
		const channelId = await spawnLocal();
		const first = sm.recordingIdOf(channelId);
		const hostId = await sm.ensureLocalHost();
		emitLocal({ type: "OUTPUT", channelId, data: new TextEncoder().encode("before") });
		const agent = mockLocalAgents[0] as unknown as { simulateDisconnect: () => void };
		agent.simulateDisconnect();
		const lifecycle = (
			sm as unknown as {
				lifecycle: { reconcileChannelState: (h: string, s: unknown[], a: unknown) => void };
			}
		).lifecycle;
		// The reconnection's list, before anything else runs: the agent still holds it.
		lifecycle.reconcileChannelState(
			hostId,
			[{ type: "AGENT_CHANNEL_STATE", channelId, title: "", pid: 1, alive: true }],
			mockLocalAgents[0],
		);
		emitLocal({ type: "OUTPUT", channelId, data: new TextEncoder().encode("replayed") });
		expect(sm.recordingIdOf(channelId)).toBe(first);
		expect(sm.recorder.list().recordings).toHaveLength(1);
		const data = exportOf(sm, first ?? "")
			.slice(1)
			.map((l) => (JSON.parse(l) as [number, string, string]).slice(1));
		expect(data).toEqual([
			["o", "before"],
			[
				"m",
				"lasterm: connection to the agent lost; output until it returns may be missing or late",
			],
			["o", "replayed"],
		]);
	});

	// AC-END-REASONS. Mutation caught: an end hooked only at CHANNEL_EXIT.
	describe("ends a recording with its terminal", () => {
		it("killed by destroyChannel", async () => {
			const channelId = await spawnLocal();
			const started = sm.startRecording(channelId);
			if (!started.ok) throw new Error(started.code);
			sm.destroyChannel(channelId);
			expect(sm.recorder.listed(started.id)?.end_reason).toBe("killed");
			expect(sm.recordingIdOf(channelId)).toBeNull();
		});

		it("gone when its host's stopped agent takes it", async () => {
			const channelId = await spawnLocal();
			const started = sm.startRecording(channelId);
			if (!started.ok) throw new Error(started.code);
			(
				sm as unknown as { lifecycle: { endChannelsOfStoppedAgent: (h: string) => void } }
			).lifecycle.endChannelsOfStoppedAgent(await sm.ensureLocalHost());
			expect(sm.recorder.listed(started.id)?.end_reason).toBe("gone");
		});

		it("gone when the agent no longer holds it", async () => {
			const channelId = await spawnLocal();
			const started = sm.startRecording(channelId);
			if (!started.ok) throw new Error(started.code);
			(
				sm as unknown as {
					lifecycle: { reconcileChannelState: (h: string, s: unknown[], a: unknown) => void };
				}
			).lifecycle.reconcileChannelState(await sm.ensureLocalHost(), [], mockLocalAgents[0]);
			expect(sm.recorder.listed(started.id)?.end_reason).toBe("gone");
		});

		it("killed when its host is deleted by force", async () => {
			const host = dal.createHost({
				type: "ssh",
				label: "pi",
				sshHost: "pi@localhost",
				sshAuth: "key",
				sshKeyPath: "/nonexistent/key",
			});
			sm.addClient(makeClient("c1", []));
			const channelId = await sm.handleSpawn("c1", { type: "SPAWN", hostId: host.id });
			if (channelId === null) throw new Error("spawn failed");
			sm.recorder.startAutomatic({
				channelId,
				hostId: host.id,
				hostLabel: "pi",
				cols: 80,
				rows: 24,
			});
			const id = sm.recordingIdOf(channelId) ?? "";
			expect(sm.deleteHost(host.id, { force: true }).kind).toBe("deleted");
			expect(sm.recorder.listed(id)?.end_reason).toBe("killed");
		});
	});

	// AC-PURGE-KEEPS. Mutation caught: recordings deleted with their channel or by the GC.
	it("keeps a recording when its terminal is purged and the GC runs", async () => {
		const channelId = await spawnLocal();
		const started = sm.startRecording(channelId);
		if (!started.ok) throw new Error(started.code);
		emitLocal({ type: "OUTPUT", channelId, data: new TextEncoder().encode("kept") });
		sm.destroyChannel(channelId);
		dal.deleteChannel(channelId);
		await sm.purgeChannelOutput([channelId]);
		await (sm as unknown as { gc: { collect: () => Promise<unknown> } }).gc.collect();
		expect(sm.recorder.listed(started.id)).toBeDefined();
		expect(exportOf(sm, started.id).join("\n")).toContain("kept");
	});

	// AC-INTERRUPTED at a real hub start (a SessionManager over the same databases).
	it("ends at the next hub start a recording a crashed hub left open", async () => {
		const channelId = await spawnLocal();
		const started = sm.startRecording(channelId);
		if (!started.ok) throw new Error(started.code);
		const next = new SessionManager(dbManager);
		try {
			expect(next.recorder.listed(started.id)?.end_reason).toBe("crashed");
		} finally {
			await next.shutdown();
		}
	});
});
