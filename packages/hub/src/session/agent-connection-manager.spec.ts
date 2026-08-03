import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_AGENT_CONFIG, encodeFrame, PROTOCOL_VERSION } from "@termora/shared";
import type { SFTPWrapper, Client as SshClient } from "ssh2";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HUB_VERSION } from "../build-version.js";
import type { MetaDAL } from "../storage/meta.js";
import type { SpoolDAL } from "../storage/spool.js";
import { AgentConnectionManager, AgentVersionMismatchError } from "./agent-connection-manager.js";
import { deployAgentIfNeeded } from "./agent-deployer.js";
import type { ChannelLifecycleManager } from "./channel-lifecycle-manager.js";
import type { OutputChunker } from "./output-chunker.js";
import type {
	CommitProtectedMap,
	SessionMetaDAL,
	SharedSessionContext,
} from "./session-context.js";
import type { SessionManager } from "./session-manager.js";
import type { SnapshotScheduler } from "./snapshot-scheduler.js";
import { SshConnectionManager } from "./ssh-connection-manager.js";
import type { StateBroadcaster } from "./state-broadcaster.js";
import { TermoraAgent } from "./termora-agent.js";

const HOST_ID = "host-1";
const SESSION_ID = "session-1";

type HasProperty<Type, Property extends PropertyKey> = Property extends keyof Type ? true : false;
type AssertFalse<Value extends false> = Value;
type ForEachMap = Parameters<CommitProtectedMap<string, number>["forEach"]>[0] extends (
	value: number,
	key: string,
	map: infer MapType,
) => unknown
	? MapType
	: never;
type CommitProtectedMapDoesNotExposeSet = AssertFalse<
	HasProperty<CommitProtectedMap<string, number>, "set">
>;
type ForEachMapDoesNotExposeSet = AssertFalse<HasProperty<ForEachMap, "set">>;
type SessionMetaDalDoesNotExposeCreate = AssertFalse<HasProperty<SessionMetaDAL, "createSession">>;
type NestedSessionsDalDoesNotExposeCreate = AssertFalse<
	HasProperty<SessionMetaDAL["sessions"], "createSession">
>;
type SessionManagerAccessorDoesNotExposeCreate = AssertFalse<
	HasProperty<ReturnType<SessionManager["getMetaDal"]>, "createSession">
>;

interface ExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

class MockSshStream extends EventEmitter {
	readonly stderr = new EventEmitter();
}

type SshExecCallback = (err: Error | undefined, stream: MockSshStream) => void;

function closeServer(server: net.Server): Promise<void> {
	return new Promise((resolve) => {
		server.close(() => resolve());
	});
}

function createHelloDaemon(
	socketPath: string,
	agentVersion: string,
): Promise<{ server: net.Server; connections: net.Socket[] }> {
	return new Promise((resolve) => {
		const connections: net.Socket[] = [];
		const server = net.createServer((socket) => {
			connections.push(socket);
			socket.on("error", () => {});

			socket.write(
				Buffer.from(
					encodeFrame({
						type: "HELLO",
						version: PROTOCOL_VERSION,
						agentVersion,
						capabilities: ["multiplex", "resize", "snapshot"],
					}),
				),
			);
			socket.write(Buffer.from(encodeFrame({ type: "CHANNEL_STATE_END" })));
		});
		server.listen(socketPath, () => resolve({ server, connections }));
	});
}

function makeMockSftp(): SFTPWrapper {
	return {
		mkdir: vi.fn((_path: string, cb: (err: Error | undefined) => void) => {
			cb(undefined);
		}),
		fastPut: vi.fn((_local: string, _remote: string, cb: (err: Error | undefined) => void) => {
			cb(undefined);
		}),
		chmod: vi.fn((_path: string, _mode: number, cb: (err: Error | undefined) => void) => {
			cb(undefined);
		}),
		end: vi.fn(),
	} as unknown as SFTPWrapper;
}

function makeDeployingSshClient(): SshClient {
	const responses: Record<string, ExecResult> = {
		"which termora-agent": { stdout: "", stderr: "", exitCode: 1 },
		"where termora-agent": { stdout: "", stderr: "", exitCode: 1 },
		'test -x "$HOME/.local/bin/termora-agent" && echo "$HOME/.local/bin/termora-agent"': {
			stdout: "",
			stderr: "",
			exitCode: 1,
		},
		'test -x "/usr/local/bin/termora-agent" && echo "/usr/local/bin/termora-agent"': {
			stdout: "",
			stderr: "",
			exitCode: 1,
		},
		'test -x "/usr/bin/termora-agent" && echo "/usr/bin/termora-agent"': {
			stdout: "",
			stderr: "",
			exitCode: 1,
		},
		'test -x "/opt/termora/termora-agent" && echo "/opt/termora/termora-agent"': {
			stdout: "",
			stderr: "",
			exitCode: 1,
		},
		"echo $HOME": { stdout: "/home/user\n", stderr: "", exitCode: 0 },
	};
	const sftp = makeMockSftp();

	return {
		exec: vi.fn((command: string, cb: SshExecCallback) => {
			const result = responses[command] ?? { stdout: "", stderr: "", exitCode: 1 };
			const stream = new MockSshStream();
			cb(undefined, stream);
			setImmediate(() => {
				if (result.stdout) stream.emit("data", Buffer.from(result.stdout));
				if (result.stderr) stream.stderr.emit("data", Buffer.from(result.stderr));
				stream.emit("close", result.exitCode);
			});
		}),
		sftp: vi.fn((cb: (err: Error | undefined, sftp: SFTPWrapper) => void) => {
			cb(undefined, sftp);
		}),
	} as unknown as SshClient;
}

function makeHarness(): {
	ctx: SharedSessionContext;
	broadcaster: StateBroadcaster;
	lifecycle: ChannelLifecycleManager;
	manager: AgentConnectionManager;
} {
	const metaDal = {
		updateHostDiscoveredShells: vi.fn(),
		getHost: vi.fn(() => ({ id: HOST_ID, os: "linux" })),
		listHostProfiles: vi.fn(() => []),
		getLaunchProfileByName: vi.fn(() => null),
		createLaunchProfile: vi.fn(() => ({ id: "profile-1" })),
		upsertHostProfileOverride: vi.fn(),
		updateSessionStatus: vi.fn(),
		updateChannelStatus: vi.fn(),
	} as unknown as MetaDAL;
	const ctx = {
		agents: new Map(),
		sessions: new Map([[HOST_ID, { id: SESSION_ID, hostId: HOST_ID, status: "starting" }]]),
		channels: new Map(),
		clients: new Map(),
		reconnectTimers: new Map(),
		reconnectAbortControllers: new Map(),
		restartTracking: new Map(),
		pendingRequests: new Map(),
		trustedOnceFingerprints: new Map(),
		trustedAgentSha256: new Map(),
		bellTimestamps: new Map(),
		notificationTimestamps: new Map(),
		elevationCache: new Map(),
		passphraseCache: new Map(),
		agentCapabilities: new Map(),
		titleDebounceTimers: new Map(),
		processTitleDebounceTimers: new Map(),
		getWriteLockHolder: null,
		metaDal,
		spoolDal: {} as SpoolDAL,
		scheduler: {
			onOutput: vi.fn(),
			onSnapshotResponse: vi.fn(),
			trackChannel: vi.fn(),
			untrackChannel: vi.fn(),
			onDetach: vi.fn(),
		} as unknown as SnapshotScheduler,
		chunker: {
			onOutput: vi.fn(),
			trackChannel: vi.fn(),
			untrackChannel: vi.fn(),
		} as unknown as OutputChunker,
		agentConfig: DEFAULT_AGENT_CONFIG,
		configResolver: null,
		loggerRegistry: null,
		hubLogger: null,
		primaryToken: null,
		acquisitions: new Map(),
		pendingPrompts: new Map(),
		promptContexts: new Map(),
		promptIndex: new Map(),
	} as SharedSessionContext;
	const broadcaster = {
		broadcastToAllClients: vi.fn(),
		broadcastToChannel: vi.fn(),
		updateSessionStatus: vi.fn(),
		updateChannelStatus: vi.fn(),
		handleTitleChange: vi.fn(),
		handleProcessTitle: vi.fn(),
		rateLimitCheck: vi.fn(() => true),
		clearTitleDebounce: vi.fn(),
		clearProcessTitleDebounce: vi.fn(),
	} as unknown as StateBroadcaster;
	const lifecycle = {
		closeSession: vi.fn(),
		storeSnapshot: vi.fn(),
		reconcileChannelState: vi.fn(),
		spawnChannelsForHost: vi.fn(),
		reAttachChannels: vi.fn(),
	} as unknown as ChannelLifecycleManager;
	return {
		ctx,
		broadcaster,
		lifecycle,
		manager: new AgentConnectionManager(ctx, broadcaster, lifecycle),
	};
}

describe("quit-protected revival capabilities", () => {
	it("does not expose the three unfenced commit escapes", () => {
		// The aliases above are compile-level assertions. Keep this test colocated
		// with the manager so Vitest reports the regression alongside its source.
		const compileAssertions: [
			CommitProtectedMapDoesNotExposeSet,
			ForEachMapDoesNotExposeSet,
			SessionMetaDalDoesNotExposeCreate,
			NestedSessionsDalDoesNotExposeCreate,
			SessionManagerAccessorDoesNotExposeCreate,
		] = [false, false, false, false, false];
		expect(compileAssertions).toEqual([false, false, false, false, false]);
	});
});

describe("AgentConnectionManager quit refusal", () => {
	it("keeps an SSH close listener synchronous and non-throwing after the quit latch", () => {
		const { ctx, broadcaster, lifecycle, manager } = makeHarness();
		ctx.quitState = "QUITTING";
		ctx.quitEpoch = 1;
		(ctx.metaDal as unknown as { getHost: (hostId: string) => unknown }).getHost = vi.fn(() => ({
			type: "ssh",
		}));
		manager.sshMgr = new SshConnectionManager(ctx, broadcaster, lifecycle, manager);

		const agent = Object.assign(new EventEmitter(), { close: vi.fn() });
		(ctx.agents as Map<string, unknown>).set(HOST_ID, agent);
		manager.wireAgentEvents(HOST_ID, SESSION_ID, agent as never);
		let runtimeRemoved = false;
		agent.on("close", () => {
			runtimeRemoved = true;
		});

		// Regression: captureQuitFence used to throw through this EventEmitter listener,
		// aborting process shutdown before its runtime record could be removed.
		expect(() => agent.emit("close")).not.toThrow();
		expect(broadcaster.updateSessionStatus).toHaveBeenCalledWith(
			HOST_ID,
			SESSION_ID,
			"disconnected",
		);
		expect(runtimeRemoved).toBe(true);
	});
});

describe("AgentConnectionManager HELLO version check", () => {
	let tmpDir: string;
	let socketPath: string;
	let daemon: { server: net.Server; connections: net.Socket[] } | null = null;
	let agent: TermoraAgent | null = null;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "termora-agent-manager-test-"));
		socketPath = join(tmpDir, "agent.sock");
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
		vi.restoreAllMocks();
	});

	async function connectAgent(agentVersion: string): Promise<TermoraAgent> {
		daemon = await createHelloDaemon(socketPath, agentVersion);
		const connected = await TermoraAgent.connectLocal(socketPath);
		connected.on("error", () => {});
		agent = connected;
		return connected;
	}

	it("warns and proceeds when a pre-existing remote agent reports an old version", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const connected = await connectAgent("0.1.0");
		expect(connected.deployedThisSession).toBe(false);
		expect(connected.remoteMatchesHubVersionCache).toBe(false);
		const { ctx, broadcaster, lifecycle, manager } = makeHarness();

		expect(() => {
			manager.wireAgentEvents(HOST_ID, SESSION_ID, connected);
		}).not.toThrow();

		expect(warn).toHaveBeenCalledWith(expect.stringContaining("Agent version mismatch"));
		expect(lifecycle.closeSession).not.toHaveBeenCalled();
		expect(broadcaster.broadcastToAllClients).not.toHaveBeenCalled();
		expect(ctx.agentCapabilities.get(HOST_ID)).toEqual(["multiplex", "resize", "snapshot"]);
	});

	it("aborts with AGENT_VERSION_MISMATCH when the mismatch follows this session's deploy", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const connected = await connectAgent("0.1.0");
		connected.deployedThisSession = true;
		const { ctx, broadcaster, lifecycle, manager } = makeHarness();

		const error = (() => {
			try {
				manager.wireAgentEvents(HOST_ID, SESSION_ID, connected);
				return null;
			} catch (err) {
				return err;
			}
		})();

		expect(error).toBeInstanceOf(AgentVersionMismatchError);
		expect((error as AgentVersionMismatchError).code).toBe("AGENT_VERSION_MISMATCH");
		expect(lifecycle.closeSession).toHaveBeenCalledWith(HOST_ID, SESSION_ID);
		expect(broadcaster.broadcastToAllClients).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "ERROR",
				code: "AGENT_VERSION_MISMATCH",
				hostId: HOST_ID,
			}),
		);
		expect(warn).not.toHaveBeenCalled();
		expect(ctx.agentCapabilities.has(HOST_ID)).toBe(false);
		expect(connected.connected).toBe(false);
	});

	it("aborts with AGENT_VERSION_MISMATCH when a non-deployed remote agent matches the hub-version cache", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const connected = await connectAgent("0.1.0");
		connected.remoteMatchesHubVersionCache = true;
		const { ctx, broadcaster, lifecycle, manager } = makeHarness();

		const error = (() => {
			try {
				manager.wireAgentEvents(HOST_ID, SESSION_ID, connected);
				return null;
			} catch (err) {
				return err;
			}
		})();

		expect(connected.deployedThisSession).toBe(false);
		expect(error).toBeInstanceOf(AgentVersionMismatchError);
		expect((error as AgentVersionMismatchError).code).toBe("AGENT_VERSION_MISMATCH");
		expect(lifecycle.closeSession).toHaveBeenCalledWith(HOST_ID, SESSION_ID);
		expect(broadcaster.broadcastToAllClients).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "ERROR",
				code: "AGENT_VERSION_MISMATCH",
				hostId: HOST_ID,
			}),
		);
		expect(warn).not.toHaveBeenCalled();
		expect(ctx.agentCapabilities.has(HOST_ID)).toBe(false);
		expect(connected.connected).toBe(false);
	});

	it("does not inherit a stale deployed signal after an abandoned deploy attempt for the same host", async () => {
		const abandonedCacheDir = await mkdtemp(join(tmpdir(), "termora-abandoned-deploy-"));
		await writeFile(join(abandonedCacheDir, `termora-agent-linux-x64-${HUB_VERSION}`), "binary");
		try {
			const abandonedResult = await deployAgentIfNeeded(
				makeDeployingSshClient(),
				{ os: "linux", arch: "x64" },
				{
					binaryCache: abandonedCacheDir,
					hostname: "myhost.example.com",
					hostId: HOST_ID,
				},
			);
			expect(abandonedResult.deployed).toBe(true);
		} finally {
			await rm(abandonedCacheDir, { recursive: true, force: true });
		}

		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const connected = await connectAgent("0.1.0");
		const { ctx, broadcaster, lifecycle, manager } = makeHarness();

		// Mutation oracle: the old host-global deploy marker makes this second,
		// non-deploying connection consume stale HOST_ID=true and abort incorrectly.
		expect(connected.deployedThisSession).toBe(false);
		expect(() => {
			manager.wireAgentEvents(HOST_ID, SESSION_ID, connected);
		}).not.toThrow();

		expect(warn).toHaveBeenCalledWith(expect.stringContaining("Agent version mismatch"));
		expect(lifecycle.closeSession).not.toHaveBeenCalled();
		expect(broadcaster.broadcastToAllClients).not.toHaveBeenCalled();
		expect(ctx.agentCapabilities.get(HOST_ID)).toEqual(["multiplex", "resize", "snapshot"]);
	});
});
