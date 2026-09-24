/**
 * The hub side of #127 on the local daemon path, end to end: a real
 * SessionManager restores its terminals at startup and connects to a daemon
 * that speaks the protocol over a real socket, and the daemon records every
 * frame the hub sends it.
 */
import { readFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import {
	type AgentChannelStateMessage,
	encodeFrame,
	FrameReader,
	PROTOCOL_VERSION,
	type ProtocolMessage,
} from "@lasterm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HubLogger } from "../logging/hub-logger.js";
import { createServer } from "../server.fixture.js";
import { type DatabaseManager, openTestDatabases } from "../storage/db.js";
import { MetaDAL } from "../storage/meta.js";
import { makeTempDir, removeTempDir } from "../temp-dir.fixture.js";
import { getTestTls } from "../test-tls.fixture.js";
import { SessionManager } from "./session-manager.js";
import { getTestSocketPath } from "./test-socket-path.js";

const daemonSocket = vi.hoisted(() => ({ path: "", gone: false }));

// The hub launches the local daemon from a binary; here the daemon is the fake
// below, already listening, and connecting is all that is left to do.
vi.mock("./agent-launcher.js", () => ({
	connectOrLaunch: async (
		_socketPath: string,
		_config: unknown,
		_binary: unknown,
		log: unknown,
	) => {
		// A hub whose connection closes dials again; once a test is over there
		// is nothing to reach.
		if (daemonSocket.gone) throw new Error("the fake daemon is gone");
		const { LastermAgent } = await import("./lasterm-agent.js");
		return LastermAgent.connectLocal(daemonSocket.path, log as never);
	},
	stopLocalAgent: async () => ({ stopped: true, diagnostic: "", stdout: "", stderr: "" }),
	resolveAgentPath: () => "/mock/agent/path",
	isAgentBinary: () => true,
}));

const HUB_KEY = "3c".repeat(32);
const PRIMARY_TOKEN = "9d".repeat(32);
const KNOWN_CHANNEL = "01K5ZC0000000000000000KN0W";
const ORPHAN_CHANNEL = "01K5ZC0000000000000000ORPH";

interface FakeDaemon {
	readonly server: net.Server;
	readonly sockets: net.Socket[];
	/** Every frame the hub sent, in order, across connections. */
	readonly received: ProtocolMessage[];
}

/**
 * A daemon that answers HELLO, waits for the first frame — the AUTH, which it
 * records — and then says what it holds, as the agent does once it knows who
 * is asking.
 */
function startFakeDaemon(options: {
	readonly capabilities: string[];
	readonly holds: Array<Pick<AgentChannelStateMessage, "channelId" | "alive">>;
	readonly otherOwnerChannels?: number;
}): Promise<FakeDaemon> {
	const received: ProtocolMessage[] = [];
	const sockets: net.Socket[] = [];
	const server = net.createServer((socket) => {
		sockets.push(socket);
		socket.on("error", () => {});
		const reader = new FrameReader();
		let answered = false;
		socket.on("data", (data: Buffer) => {
			for (const msg of reader.push(data)) {
				received.push(msg);
				if (answered) continue;
				answered = true;
				for (const held of options.holds) {
					socket.write(
						encodeFrame({
							type: "AGENT_CHANNEL_STATE",
							channelId: held.channelId,
							title: "bash",
							pid: held.alive ? 4242 : 0,
							alive: held.alive,
						}),
					);
				}
				socket.write(
					encodeFrame({
						type: "CHANNEL_STATE_END",
						...(options.otherOwnerChannels !== undefined && {
							otherOwnerChannels: options.otherOwnerChannels,
						}),
					}),
				);
			}
		});
		socket.write(
			encodeFrame({
				type: "HELLO",
				version: PROTOCOL_VERSION,
				agentVersion: "0.1.0",
				capabilities: options.capabilities,
			}),
		);
	});
	return new Promise((resolve) => {
		server.listen(daemonSocket.path, () => resolve({ server, sockets, received }));
	});
}

async function stopFakeDaemon(daemon: FakeDaemon): Promise<void> {
	for (const socket of daemon.sockets) socket.destroy();
	await new Promise<void>((resolve) => daemon.server.close(() => resolve()));
}

/** Wait until the daemon has received a frame that matches. */
async function waitForFrame(
	daemon: FakeDaemon,
	matches: (msg: ProtocolMessage) => boolean,
): Promise<void> {
	await vi.waitFor(() => expect(daemon.received.some(matches)).toBe(true), { timeout: 5_000 });
}

describe("the hub's identity on the local daemon (#127)", () => {
	let dbs: DatabaseManager;
	let logsDir: string;
	let sm: SessionManager;
	let daemon: FakeDaemon | null = null;
	let hostId: string;

	beforeEach(() => {
		daemonSocket.path = getTestSocketPath();
		daemonSocket.gone = false;
		dbs = openTestDatabases();
		logsDir = makeTempDir("lasterm-hub-identity-");
		// Everything the hub writes, down to trace: a key that reached any line
		// would be found here.
		const hubLogger = new HubLogger(logsDir, {
			level: "trace",
			format: "jsonl",
			output: "file",
			maxAgeDays: 30,
			maxSizeMb: 50,
		});
		sm = new SessionManager(dbs, undefined, undefined, undefined, hubLogger);
		sm.setPrimaryToken(PRIMARY_TOKEN);
		sm.setHubKey(HUB_KEY);

		// A terminal the previous run left alive, which startup restores.
		const meta = new MetaDAL(dbs.meta);
		hostId = meta.createHost({ type: "local", label: "local" }).id;
		const sessionId = "01K5ZC00000000000000SESS10";
		meta.createSession({ id: sessionId, hostId, status: "active" });
		meta.createChannel({ id: KNOWN_CHANNEL, sessionId, status: "live", shell: "bash" });
	});

	afterEach(async () => {
		// Latched first, as a quitting hub does: otherwise closing the connection
		// reads as a daemon lost, and the hub dials it again.
		sm.beginQuit();
		await sm.shutdown();
		if (daemon !== null) await stopFakeDaemon(daemon);
		daemon = null;
		dbs.close();
		await removeTempDir(logsDir);
		vi.restoreAllMocks();
	});

	function hubLog(): string {
		try {
			return readFileSync(join(logsDir, "hub.jsonl"), "utf8");
		} catch {
			return "";
		}
	}

	/** Anything sent after this reached the daemon once it has seen this. */
	async function drain(): Promise<void> {
		const ts = new Date().toISOString();
		sm.agents.get(hostId)?.send({ type: "HEARTBEAT", ts });
		if (daemon !== null) {
			await waitForFrame(daemon, (m) => m.type === "HEARTBEAT" && m.ts === ts);
		}
	}

	it("authenticates with the hub key, and never writes the key to a log", async () => {
		const consoleLines: unknown[][] = [];
		for (const method of ["log", "info", "warn", "error", "debug"] as const) {
			vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
				consoleLines.push(args);
			});
		}
		daemon = await startFakeDaemon({
			capabilities: ["multiplex", "resize", "snapshot", "hub-identity"],
			holds: [{ channelId: KNOWN_CHANNEL, alive: true }],
		});

		await sm.startup();
		await drain();

		// The first frame is the AUTH, and it names this hub.
		expect(daemon.received[0]).toEqual({ type: "AUTH", token: PRIMARY_TOKEN, hubKey: HUB_KEY });
		expect(sm.channels.get(KNOWN_CHANNEL)?.status).toBe("live");

		// The log was written at trace through the whole handshake, and holds
		// neither secret; nor does anything the hub printed.
		expect(hubLog()).toContain("agent active");
		expect(hubLog()).not.toContain(HUB_KEY);
		expect(hubLog()).not.toContain(PRIMARY_TOKEN);
		expect(JSON.stringify(consoleLines)).not.toContain(HUB_KEY);
	});

	it("destroys a terminal of its own it does not know, and says so once", async () => {
		daemon = await startFakeDaemon({
			capabilities: ["multiplex", "resize", "snapshot", "hub-identity"],
			// A SPAWN whose answer never came back: the daemon holds it for this
			// hub, and this hub has no record of it.
			holds: [
				{ channelId: KNOWN_CHANNEL, alive: true },
				{ channelId: ORPHAN_CHANNEL, alive: true },
			],
		});

		await sm.startup();
		await drain();

		const destroyed = daemon.received.filter((m) => m.type === "DESTROY");
		expect(destroyed).toEqual([{ type: "DESTROY", channelId: ORPHAN_CHANNEL }]);
		expect(sm.channels.get(KNOWN_CHANNEL)?.status).toBe("live");

		const infoLines = hubLog()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>)
			.filter((entry) => entry.msg === "channel-lifecycle: destroyed orphan terminals");
		expect(infoLines).toEqual([expect.objectContaining({ lvl: "info", hostId, count: 1 })]);
	});

	it("leaves an unknown terminal alone on an agent without hub-identity: it may be another hub's", async () => {
		daemon = await startFakeDaemon({
			capabilities: ["multiplex", "resize", "snapshot"],
			holds: [
				{ channelId: KNOWN_CHANNEL, alive: true },
				{ channelId: ORPHAN_CHANNEL, alive: true },
			],
		});

		await sm.startup();
		await drain();

		expect(daemon.received.filter((m) => m.type === "DESTROY")).toEqual([]);
		expect(hubLog()).not.toContain("destroyed orphan terminals");
	});

	it("reports how many terminals other hubs hold there, with the session", async () => {
		daemon = await startFakeDaemon({
			capabilities: ["multiplex", "resize", "snapshot", "hub-identity"],
			holds: [{ channelId: KNOWN_CHANNEL, alive: true }],
			otherOwnerChannels: 2,
		});

		await sm.startup();

		const session = sm.getStateSnapshot().sessions.find((s) => s.hostId === hostId);
		expect(session?.otherOwnerChannels).toBe(2);
		// Theirs: none of them was touched.
		await drain();
		expect(daemon.received.filter((m) => m.type === "DESTROY")).toEqual([]);
	});
});

// startHub hands the key to createServer; this is the rest of the way, from
// the server's options to the first frame the daemon reads.
describe("the hub key, from the server's options to the daemon (#127)", () => {
	it("reaches the daemon in the AUTH of the connection the server opens at startup", async () => {
		daemonSocket.path = getTestSocketPath();
		daemonSocket.gone = false;
		const dbs = openTestDatabases();
		const meta = new MetaDAL(dbs.meta);
		const hostId = meta.createHost({ type: "local", label: "local" }).id;
		meta.createSession({ id: "01K5ZC00000000000000SESS20", hostId, status: "active" });
		meta.createChannel({
			id: KNOWN_CHANNEL,
			sessionId: "01K5ZC00000000000000SESS20",
			status: "live",
			shell: "bash",
		});
		const daemon = await startFakeDaemon({
			capabilities: ["multiplex", "hub-identity"],
			holds: [{ channelId: KNOWN_CHANNEL, alive: true }],
		});
		const server = await createServer({
			tls: getTestTls(),
			logger: false,
			dbManager: dbs,
			skipShellDiscovery: true,
			authToken: PRIMARY_TOKEN,
			hubKey: HUB_KEY,
		});
		try {
			await waitForFrame(daemon, (m) => m.type === "AUTH");
			expect(daemon.received[0]).toEqual({ type: "AUTH", token: PRIMARY_TOKEN, hubKey: HUB_KEY });
		} finally {
			// Closing the server closes its connection, which a hub not quitting
			// reads as a daemon lost: the redial it makes finds nothing, and the
			// session it then closes is written before the databases go.
			daemonSocket.gone = true;
			await server.close();
			await stopFakeDaemon(daemon);
			await vi.waitFor(() =>
				expect(meta.getSession("01K5ZC00000000000000SESS20")?.status).toBe("closed"),
			);
			dbs.close();
		}
	});
});
