/**
 * An agent older than the hub is replaced once it holds none of this hub's
 * terminals (#805).
 *
 * The local daemon here is a stand-in for whatever answers on the pipe:
 * `connectOrLaunch` connects to it, and launches the binary beside the hub
 * when nothing answers, as the real one does. A remote daemon is the same
 * idea behind a fake SSH connection, which starts the current agent when the
 * host has none running.
 */
import type { ProtocolMessage } from "@lasterm/shared";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSessionRoutes } from "../api/sessions.js";
import { HUB_VERSION } from "../build-version.js";
import { type DatabaseManager, openTestDatabases } from "../storage/db.js";
import { MetaDAL } from "../storage/meta.js";
import { isOlderVersion } from "./agent-retirement.js";
import type { SharedSessionContext } from "./session-context.js";
import { SessionManager, type WsClient } from "./session-manager.js";

/** A daemon: what it runs, what it holds, and how it answers a STOP. */
interface FakeDaemon {
	readonly version: string;
	/** This hub's terminals on it. */
	readonly channels: Set<string>;
	/** Other hubs' terminals on it. */
	othersHold: number;
	/**
	 * `obey`: refuse while others hold terminals, else stop. `hold`: stop once
	 * `release` is called. `silent`: never answer. `throw`: the STOP cannot be
	 * written. `displaced`: answer that another connection took this one's place.
	 */
	stopMode: "obey" | "hold" | "silent" | "throw" | "displaced";
	/** Report the end of a terminal it is told to destroy, as a real daemon may, before what follows. */
	exitOnDestroy: boolean;
	release?: () => void;
	readonly agents: FakeAgent[];
}

interface FakeAgent {
	readonly daemon: FakeDaemon;
	readonly sent: ProtocolMessage[];
	connected: boolean;
	closedByHub: boolean;
	emit(event: string, ...args: unknown[]): boolean;
	/** The daemon reports this hub's terminal ended. */
	exit(channelId: string): void;
}

const pipe = vi.hoisted(() => ({
	/** Whatever answers on the local pipe now. */
	running: null as FakeDaemon | null,
	/** The version of the binary beside the hub. */
	binaryVersion: "",
	/** Every daemon the hub launched. */
	launched: [] as FakeDaemon[],
}));

const remote = vi.hoisted(() => ({
	/** The daemon running on the remote host, if any. */
	running: null as FakeDaemon | null,
	/** The version a new connection deploys and starts there. */
	binaryVersion: "",
	/** Every daemon a connection started there. */
	started: [] as FakeDaemon[],
	/** An agent on stdio, of this version, instead of a daemon. */
	stdioVersion: null as string | null,
	agents: [] as FakeAgent[],
}));

const daemons = vi.hoisted(() => ({
	make(version: string): FakeDaemon {
		return {
			version,
			channels: new Set(),
			othersHold: 0,
			stopMode: "obey",
			exitOnDestroy: false,
			agents: [],
		};
	},
}));

/** What every fake agent does with what the hub sends it. */
const behaviour = vi.hoisted(() => ({
	nextChannel: 0,
	answer(
		agent: FakeAgent,
		msg: ProtocolMessage,
		gone: () => void,
		emit: (event: string, ...args: unknown[]) => void,
	): void {
		agent.sent.push(msg);
		const daemon = agent.daemon;
		if (msg.type === "SPAWN") {
			const named = (msg as { channelId?: string }).channelId;
			const channelId = named ?? `ch-${++behaviour.nextChannel}`;
			daemon.channels.add(channelId);
			setImmediate(() =>
				emit("message", { type: "SPAWN_OK", requestId: msg.requestId, channelId }),
			);
			return;
		}
		if (msg.type === "DESTROY") {
			daemon.channels.delete(msg.channelId);
			if (daemon.exitOnDestroy) {
				const { channelId } = msg;
				setImmediate(() => emit("message", { type: "CHANNEL_EXIT", channelId, exitCode: 1 }));
			}
			return;
		}
		if (msg.type !== "STOP") return;
		const stop = (): void => {
			gone();
			for (const other of daemon.agents) {
				if (!other.connected) continue;
				other.connected = false;
				other.emit("close");
			}
		};
		switch (daemon.stopMode) {
			case "throw":
				throw new Error("not connected");
			case "silent":
				return;
			case "displaced":
				setImmediate(() =>
					emit("message", { type: "ERROR", code: "DISPLACED", message: "another connection" }),
				);
				return;
			case "hold":
				daemon.release = () => setImmediate(stop);
				return;
			case "obey":
				if (!msg.force && daemon.othersHold > 0) {
					setImmediate(() =>
						emit("message", {
							type: "ERROR",
							code: "OTHER_HUBS_HOLD_CHANNELS",
							message: `${daemon.othersHold} terminals on this agent belong to other hubs`,
							otherOwnerChannels: daemon.othersHold,
						}),
					);
					return;
				}
				setImmediate(stop);
		}
	},
}));

vi.mock("./agent-launcher.js", async () => {
	const { EventEmitter } = await import("node:events");
	class FakeLocalAgent extends EventEmitter implements FakeAgent {
		readonly sent: ProtocolMessage[] = [];
		connected = true;
		closedByHub = false;
		deployedThisSession = false;
		remoteMatchesHubVersionCache = false;
		reachedRunningDaemon = false;
		otherOwnerChannels: number | undefined;
		readonly helloMessage;
		constructor(readonly daemon: FakeDaemon) {
			super();
			this.helloMessage = {
				type: "HELLO",
				version: 1,
				agentVersion: daemon.version,
				capabilities: ["multiplex", "hub-identity"],
			};
			daemon.agents.push(this);
		}
		send = vi.fn((msg: ProtocolMessage) =>
			behaviour.answer(
				this,
				msg,
				() => {
					if (pipe.running === this.daemon) pipe.running = null;
				},
				(event, ...args) => this.emit(event, ...args),
			),
		);
		waitForChannelState = vi.fn(async () =>
			[...this.daemon.channels].map((channelId) => ({
				type: "AGENT_CHANNEL_STATE",
				channelId,
				title: "",
				pid: 1,
				alive: true,
			})),
		);
		close = vi.fn(async () => {
			if (!this.connected) return;
			this.closedByHub = true;
			this.connected = false;
			queueMicrotask(() => this.emit("close"));
		});
		exit(channelId: string): void {
			this.daemon.channels.delete(channelId);
			this.emit("message", { type: "CHANNEL_EXIT", channelId, exitCode: 0 });
		}
	}
	return {
		connectOrLaunch: vi.fn(async () => {
			if (pipe.running === null) {
				const launched = daemons.make(pipe.binaryVersion);
				pipe.running = launched;
				pipe.launched.push(launched);
			}
			return new FakeLocalAgent(pipe.running);
		}),
		resolveAgentPath: () => "/beside/the/hub/lasterm-agent",
		isAgentBinary: () => true,
		stopLocalAgent: vi.fn(),
	};
});

vi.mock("./ssh-agent.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./ssh-agent.js")>();
	const { EventEmitter } = await import("node:events");
	class FakeSshAgent extends EventEmitter implements FakeAgent {
		readonly sent: ProtocolMessage[] = [];
		connected = false;
		closedByHub = false;
		usedRemoteDaemon = false;
		deployedThisSession = false;
		remoteMatchesHubVersionCache = false;
		reachedRunningDaemon = false;
		remoteAgentPath = "/home/pi/.local/bin/lasterm-agent";
		otherOwnerChannels: number | undefined;
		lastKeyVerification = { capturedFingerprint: null, mismatch: false, tofu: false };
		helloMessage:
			| { type: "HELLO"; version: 1; agentVersion: string; capabilities: string[] }
			| undefined;
		daemon: FakeDaemon = daemons.make("");
		constructor() {
			super();
			remote.agents.push(this);
		}
		start = vi.fn(async () => {
			if (remote.stdioVersion !== null) {
				this.daemon = daemons.make(remote.stdioVersion);
			} else {
				if (remote.running === null) {
					const started = daemons.make(remote.binaryVersion);
					remote.running = started;
					remote.started.push(started);
				}
				this.daemon = remote.running;
				this.usedRemoteDaemon = true;
			}
			this.daemon.agents.push(this);
			this.helloMessage = {
				type: "HELLO",
				version: 1,
				agentVersion: this.daemon.version,
				capabilities: ["multiplex", "hub-identity"],
			};
			this.connected = true;
		});
		send = vi.fn((msg: ProtocolMessage) =>
			behaviour.answer(
				this,
				msg,
				() => {
					if (remote.running === this.daemon) remote.running = null;
				},
				(event, ...args) => this.emit(event, ...args),
			),
		);
		waitForChannelState = vi.fn(async () =>
			[...this.daemon.channels].map((channelId) => ({
				type: "AGENT_CHANNEL_STATE",
				channelId,
				title: "",
				pid: 1,
				alive: true,
			})),
		);
		execOnHost = vi.fn(async () => ({ stdout: "", exitCode: 1 }));
		close = vi.fn(async () => {
			if (!this.connected) return;
			this.closedByHub = true;
			this.connected = false;
			queueMicrotask(() => this.emit("close"));
		});
		exit(channelId: string): void {
			this.daemon.channels.delete(channelId);
			this.emit("message", { type: "CHANNEL_EXIT", channelId, exitCode: 0 });
		}
	}
	return { ...actual, SshAgent: FakeSshAgent };
});

/** Older than any hub this runs under. */
const OLD = "0.0.1";
const NEWER = "999.0.0";

let dbs: DatabaseManager;
let metaDal: MetaDAL;
let sm: SessionManager;
let heard: ProtocolMessage[];

function ctxOf(manager: SessionManager): SharedSessionContext {
	return (manager as unknown as { ctx: SharedSessionContext }).ctx;
}

function addWindow(id = "c-window"): WsClient {
	const client: WsClient = { id, send: (msg) => heard.push(msg), attachedChannels: new Set() };
	sm.addClient(client);
	return client;
}

/** Every STOP sent to any agent of this daemon. */
function stopsTo(daemon: FakeDaemon): ProtocolMessage[] {
	return daemon.agents.flatMap((agent) => agent.sent.filter((msg) => msg.type === "STOP"));
}

/** Every SPAWN sent to any agent of this daemon. */
function spawnsTo(daemon: FakeDaemon): ProtocolMessage[] {
	return daemon.agents.flatMap((agent) => agent.sent.filter((msg) => msg.type === "SPAWN"));
}

function outdatedAgentOn(hostId: string): unknown {
	return sm.getStateSnapshot().sessions.find((s) => s.hostId === hostId)?.outdatedAgent;
}

/** Let what the fakes answer, and what the hub does with it, run its course. */
async function settle(rounds = 10): Promise<void> {
	for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

beforeEach(() => {
	dbs = openTestDatabases();
	metaDal = new MetaDAL(dbs.meta);
	sm = new SessionManager(dbs);
	heard = [];
	behaviour.nextChannel = 0;
	pipe.running = null;
	pipe.binaryVersion = HUB_VERSION;
	pipe.launched = [];
	remote.running = null;
	remote.binaryVersion = HUB_VERSION;
	remote.started = [];
	remote.stdioVersion = null;
	remote.agents = [];
});

afterEach(async () => {
	vi.useRealTimers();
	for (const daemon of [pipe.running, remote.running]) daemon?.release?.();
	sm.beginQuit();
	await sm.shutdown();
	dbs.close();
});

describe("isOlderVersion", () => {
	it("orders versions as semver does", () => {
		expect(isOlderVersion("0.15.0", "0.15.1")).toBe(true);
		expect(isOlderVersion("0.9.9", "0.15.0")).toBe(true);
		expect(isOlderVersion("0.15.1", "1.0.0")).toBe(true);
		expect(isOlderVersion("0.15.1-rc.1", "0.15.1")).toBe(true);
		expect(isOlderVersion("0.15.1-alpha", "0.15.1-beta")).toBe(true);
		expect(isOlderVersion("0.15.1-rc.2", "0.15.1-rc.10")).toBe(true);
		expect(isOlderVersion("0.15.1-rc.1", "0.15.1-rc.1.1")).toBe(true);
	});

	it("never calls an equal or a newer version older", () => {
		expect(isOlderVersion("0.15.1", "0.15.1")).toBe(false);
		expect(isOlderVersion("0.15.1+build.7", "0.15.1")).toBe(false);
		expect(isOlderVersion("0.15.2", "0.15.1")).toBe(false);
		expect(isOlderVersion("0.15.1", "0.15.1-rc.1")).toBe(false);
		expect(isOlderVersion("1.0.0", "0.99.99")).toBe(false);
	});

	it("calls nothing older that it cannot read", () => {
		expect(isOlderVersion("", "0.15.1")).toBe(false);
		expect(isOlderVersion("dev", "0.15.1")).toBe(false);
		expect(isOlderVersion("0.15", "0.15.1")).toBe(false);
		expect(isOlderVersion("0.15.0", "dev")).toBe(false);
	});

	it("reads this hub's own version, which the tests below compare with", () => {
		expect(isOlderVersion(OLD, HUB_VERSION)).toBe(true);
		expect(isOlderVersion(NEWER, HUB_VERSION)).toBe(false);
	});
});

describe("the local agent, older than the hub (#805)", () => {
	/** The hub restarts and finds its terminal on a daemon an older hub left. */
	async function restartOnto(daemon: FakeDaemon, channelId = "ch-held"): Promise<string> {
		const hostId = await sm.ensureLocalHost();
		metaDal.createSession({ id: "01K805SESSION0000000000000", hostId, status: "active" });
		metaDal.createChannel({
			id: channelId,
			sessionId: "01K805SESSION0000000000000",
			status: "live",
			shell: "pwsh",
		});
		daemon.channels.add(channelId);
		pipe.running = daemon;
		await sm.startup();
		return hostId;
	}

	it("is stopped once adopted holding nothing, and the next terminal starts on the current one", async () => {
		const old = daemons.make(OLD);
		pipe.running = old;
		const hostId = await sm.ensureLocalHost();
		addWindow();

		const channelId = await sm.handleSpawn("c-window", { type: "SPAWN", hostId });

		expect(channelId).not.toBeNull();
		expect(stopsTo(old)).toEqual([{ type: "STOP", force: false }]);
		expect(spawnsTo(old)).toEqual([]);
		expect(pipe.launched.map((d) => d.version)).toEqual([HUB_VERSION]);
		const current = pipe.launched[0] as FakeDaemon;
		expect(spawnsTo(current)).toHaveLength(1);
		expect(sm.agents.get(hostId)?.helloMessage?.agentVersion).toBe(HUB_VERSION);
		expect(outdatedAgentOn(hostId)).toBeUndefined();
		expect(heard.filter((m) => m.type === "ERROR")).toEqual([]);
	});

	it("keeps one holding a terminal, and stops it once that terminal exits", async () => {
		const old = daemons.make(OLD);
		const hostId = await restartOnto(old);
		const [agent] = old.agents;
		await settle();

		expect(stopsTo(old)).toEqual([]);
		expect(sm.agents.get(hostId)).toBe(agent);
		expect(outdatedAgentOn(hostId)).toEqual({ running: OLD, expected: HUB_VERSION });

		agent?.exit("ch-held");
		await vi.waitFor(() =>
			expect(sm.agents.get(hostId)?.helloMessage?.agentVersion).toBe(HUB_VERSION),
		);

		expect(stopsTo(old)).toEqual([{ type: "STOP", force: false }]);
		// Started at once, beside the hub: no terminal had to ask for it.
		expect(pipe.launched.map((d) => d.version)).toEqual([HUB_VERSION]);
		expect(outdatedAgentOn(hostId)).toBeUndefined();
	});

	it("stops it once that terminal is killed", async () => {
		const old = daemons.make(OLD);
		const hostId = await restartOnto(old);
		await settle();
		expect(stopsTo(old)).toEqual([]);

		expect(sm.destroyChannel("ch-held")).toBe(true);
		await vi.waitFor(() =>
			expect(sm.agents.get(hostId)?.helloMessage?.agentVersion).toBe(HUB_VERSION),
		);

		const sentToOld = old.agents.flatMap((a) => a.sent.map((m) => m.type));
		expect(sentToOld.slice(-2)).toEqual(["DESTROY", "STOP"]);
	});

	it("keeps one other hubs hold terminals on, and does not ask again by itself", async () => {
		const old = daemons.make(OLD);
		old.othersHold = 2;
		const hostId = await restartOnto(old);
		const [agent] = old.agents;

		agent?.exit("ch-held");
		await settle(20);

		expect(stopsTo(old)).toEqual([{ type: "STOP", force: false }]);
		expect(sm.agents.get(hostId)).toBe(agent);
		expect(pipe.launched).toEqual([]);
		expect(outdatedAgentOn(hostId)).toEqual({ running: OLD, expected: HUB_VERSION });
		expect(sm.hostIsBeingStopped(hostId)).toBe(false);

		// A terminal opened then goes where it can: the agent there.
		addWindow();
		expect(await sm.handleSpawn("c-window", { type: "SPAWN", hostId })).not.toBeNull();
		expect(spawnsTo(old)).toHaveLength(1);
	});

	it.each([
		["as new as the hub", HUB_VERSION],
		["newer than the hub", NEWER],
	])("never stops an agent %s", async (_label, version) => {
		const daemon = daemons.make(version);
		const hostId = await restartOnto(daemon);
		daemon.agents[0]?.exit("ch-held");
		await settle(20);
		addWindow();
		expect(await sm.handleSpawn("c-window", { type: "SPAWN", hostId })).not.toBeNull();

		expect(stopsTo(daemon)).toEqual([]);
		expect(pipe.launched).toEqual([]);
		expect(spawnsTo(daemon)).toHaveLength(1);
	});

	it("lands a terminal asked for during the stop, and one brought back, on the agent that replaces it", async () => {
		const old = daemons.make(OLD);
		old.stopMode = "hold";
		const hostId = await restartOnto(old);
		addWindow();

		old.agents[0]?.exit("ch-held");
		await vi.waitFor(() => expect(stopsTo(old)).toHaveLength(1));
		expect(sm.hostIsBeingStopped(hostId)).toBe(true);

		const fresh = sm.handleSpawn("c-window", { type: "SPAWN", hostId });
		// "When a terminal ends" set to restart: the window brings it back.
		const restarted = sm.handleSpawn("c-window", {
			type: "SPAWN",
			hostId,
			reuseChannelId: "ch-held",
			automatic: true,
		});
		await settle();
		expect(spawnsTo(old)).toEqual([]);

		old.release?.();
		expect(await fresh).not.toBeNull();
		expect(await restarted).toBe("ch-held");

		const current = pipe.launched[0] as FakeDaemon;
		expect(current.version).toBe(HUB_VERSION);
		expect(spawnsTo(current)).toHaveLength(2);
		expect(spawnsTo(old)).toEqual([]);
		expect(heard.filter((m) => m.type === "ERROR")).toEqual([]);
		expect(sm.channels.get("ch-held")?.status).toBe("live");
	});

	it("lets nothing go between a restart's end of the old shell and the start of its new one", async () => {
		const old = daemons.make(OLD);
		old.exitOnDestroy = true;
		const hostId = await restartOnto(old);

		expect(await sm.restartChannel("ch-held")).toBe(true);
		await settle(20);

		expect(stopsTo(old)).toEqual([]);
		expect(sm.agents.get(hostId)).toBe(old.agents[0]);
		expect(sm.channels.get("ch-held")?.status).toBe("live");
		expect(old.channels.has("ch-held")).toBe(true);
	});

	it.each([
		["the STOP cannot be written", "throw"],
		["another connection took the hub's place", "displaced"],
	] as const)("marks nothing ended, starts nothing, and asks again later, when %s", async (_label, mode) => {
		const old = daemons.make(OLD);
		old.stopMode = mode;
		const hostId = await restartOnto(old);
		addWindow();

		old.agents[0]?.exit("ch-held");
		await settle(20);

		expect(stopsTo(old)).toHaveLength(1);
		expect(pipe.launched).toEqual([]);
		expect(sm.hostIsBeingStopped(hostId)).toBe(false);
		expect(
			heard.filter((m) => m.type === "CHANNEL_STATE" && (m as { endReason?: string }).endReason),
		).toEqual([]);
		if (mode === "throw") expect(sm.agents.get(hostId)).toBe(old.agents[0]);

		// Not taken for a stop: the next terminal asks again, and gets the current agent.
		old.stopMode = "obey";
		expect(await sm.handleSpawn("c-window", { type: "SPAWN", hostId })).not.toBeNull();
		expect(stopsTo(old)).toHaveLength(2);
		expect(pipe.launched.map((d) => d.version)).toEqual([HUB_VERSION]);
		expect(spawnsTo(old)).toEqual([]);
	});

	it("keeps the agent when it does not say it stopped in time", async () => {
		const old = daemons.make(OLD);
		old.stopMode = "silent";
		const hostId = await restartOnto(old);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

		old.agents[0]?.exit("ch-held");
		await settle();
		expect(stopsTo(old)).toHaveLength(1);
		expect(sm.hostIsBeingStopped(hostId)).toBe(true);
		await vi.advanceTimersByTimeAsync(14_999);
		expect(sm.hostIsBeingStopped(hostId)).toBe(true);
		await vi.advanceTimersByTimeAsync(1);
		vi.useRealTimers();
		await settle();

		expect(sm.hostIsBeingStopped(hostId)).toBe(false);
		expect(sm.agents.get(hostId)).toBe(old.agents[0]);
		expect(pipe.launched).toEqual([]);

		// Not taken for a stop: the next terminal asks again, and gets the current agent.
		old.stopMode = "obey";
		addWindow();
		expect(await sm.handleSpawn("c-window", { type: "SPAWN", hostId })).not.toBeNull();
		expect(stopsTo(old)).toHaveLength(2);
		expect(pipe.launched.map((d) => d.version)).toEqual([HUB_VERSION]);
	});

	it("never stops one while the hub quits", async () => {
		const old = daemons.make(OLD);
		const hostId = await restartOnto(old);
		sm.beginQuit();

		old.agents[0]?.exit("ch-held");
		await settle(20);

		expect(stopsTo(old)).toEqual([]);
		expect(sm.agents.get(hostId)).toBe(old.agents[0]);
	});

	it("starts nothing in its place when the hub begins quitting during the stop", async () => {
		const old = daemons.make(OLD);
		old.stopMode = "hold";
		await restartOnto(old);
		old.agents[0]?.exit("ch-held");
		await vi.waitFor(() => expect(stopsTo(old)).toHaveLength(1));

		sm.beginQuit();
		old.release?.();
		await settle(20);

		expect(pipe.launched).toEqual([]);
	});

	it("stops it once, when what replaced it is no newer", async () => {
		pipe.binaryVersion = OLD;
		const old = daemons.make(OLD);
		const hostId = await restartOnto(old);

		old.agents[0]?.exit("ch-held");
		await vi.waitFor(() => expect(pipe.launched).toHaveLength(1));
		const again = pipe.launched[0] as FakeDaemon;
		addWindow();
		expect(await sm.handleSpawn("c-window", { type: "SPAWN", hostId })).not.toBeNull();
		const [channelId] = again.channels;
		again.agents[0]?.exit(channelId ?? "");
		await settle(20);

		expect(stopsTo(old)).toHaveLength(1);
		expect(stopsTo(again)).toEqual([]);
		expect(pipe.launched).toHaveLength(1);
	});

	it("stops it with its session, killed on request, and the next terminal starts the current one", async () => {
		const old = daemons.make(OLD);
		const hostId = await restartOnto(old);
		const sessionId = ctxOf(sm).sessions.get(hostId)?.id ?? "";

		expect(await sm.closeSession(sessionId)).toBe("closed");
		await settle(20);

		expect(stopsTo(old)).toEqual([{ type: "STOP", force: false }]);
		// No session left for one to serve: the next terminal starts it.
		expect(pipe.launched).toEqual([]);
		addWindow();
		expect(await sm.handleSpawn("c-window", { type: "SPAWN", hostId })).not.toBeNull();
		expect(pipe.launched.map((d) => d.version)).toEqual([HUB_VERSION]);
		expect(spawnsTo(pipe.launched[0] as FakeDaemon)).toHaveLength(1);
	});

	it("only closes the connection to a current one with its session", async () => {
		const daemon = daemons.make(HUB_VERSION);
		const hostId = await restartOnto(daemon);
		const sessionId = ctxOf(sm).sessions.get(hostId)?.id ?? "";

		expect(await sm.closeSession(sessionId)).toBe("closed");
		await settle();

		expect(stopsTo(daemon)).toEqual([]);
		expect(daemon.agents[0]?.connected).toBe(false);
		expect(pipe.running).toBe(daemon);
	});
});

describe("POST /api/hosts/:id/agent/replace on the local host (#805)", () => {
	async function replaceLocal(hostId: string) {
		const server = Fastify({ logger: false });
		registerSessionRoutes(server, metaDal, sm);
		await server.ready();
		try {
			return await server.inject({ method: "POST", url: `/api/hosts/${hostId}/agent/replace` });
		} finally {
			await server.close();
		}
	}

	it("says the hub is not connected to it, not that there is no agent, before any terminal", async () => {
		const hostId = await sm.ensureLocalHost();

		const res = await replaceLocal(hostId);

		expect(res.statusCode).toBe(409);
		expect(res.json()).toEqual({
			error: {
				code: "AGENT_NOT_REPLACED",
				message:
					"This hub is not connected to this host's agent. The next terminal opened here replaces it if it is older than this Lasterm.",
			},
		});
	});

	it("ends nothing while it holds this hub's terminals, and says it goes once they end", async () => {
		const old = daemons.make(OLD);
		old.channels.add("ch-held");
		pipe.running = old;
		const hostId = await sm.ensureLocalHost();
		metaDal.createSession({ id: "01K805SESSION0000000000001", hostId, status: "active" });
		metaDal.createChannel({
			id: "ch-held",
			sessionId: "01K805SESSION0000000000001",
			status: "live",
		});
		await sm.startup();

		const res = await replaceLocal(hostId);

		expect(res.statusCode).toBe(409);
		expect(res.json().error.message).toBe(
			"This host's agent is replaced by itself as soon as none of this hub's terminals runs on it. 1 still does.",
		);
		expect(stopsTo(old)).toEqual([]);
	});

	it("says there is nothing to replace on a current one", async () => {
		pipe.running = daemons.make(HUB_VERSION);
		const hostId = await sm.ensureLocalHost();
		addWindow();
		await sm.handleSpawn("c-window", { type: "SPAWN", hostId });

		const res = await replaceLocal(hostId);

		expect(res.statusCode).toBe(409);
		expect(res.json().error.message).toBe(
			`This host's agent (${HUB_VERSION}) is not older than this Lasterm (${HUB_VERSION}): there is nothing to replace.`,
		);
	});

	it("asks again, without force, and says other hubs keep it", async () => {
		const old = daemons.make(OLD);
		old.othersHold = 3;
		pipe.running = old;
		const hostId = await sm.ensureLocalHost();
		addWindow();
		const channelId = await sm.handleSpawn("c-window", { type: "SPAWN", hostId });
		old.agents[0]?.exit(channelId ?? "");
		await settle(20);
		expect(stopsTo(old)).toHaveLength(2);

		const res = await replaceLocal(hostId);

		expect(res.statusCode).toBe(409);
		expect(res.json().error).toEqual({
			code: "AGENT_NOT_REPLACED",
			message:
				"Other Lasterm hubs hold 3 terminals on this agent, so it is kept until they have ended.",
		});
		expect(stopsTo(old)).toEqual([
			{ type: "STOP", force: false },
			{ type: "STOP", force: false },
			{ type: "STOP", force: false },
		]);
	});
});

describe("a remote daemon older than the hub (#805)", () => {
	let hostId: string;

	beforeEach(() => {
		hostId = metaDal.createHost({
			type: "ssh",
			label: "pi",
			sshHost: "pi@pi.local",
			sshRemoteDaemon: true,
		}).id;
	});

	/** Connect to the host, whose daemon holds this hub's terminal. */
	async function connectHolding(daemon: FakeDaemon): Promise<void> {
		metaDal.createSession({ id: "01K805SESSION0000000000002", hostId, status: "active" });
		metaDal.createChannel({
			id: "ch-remote",
			sessionId: "01K805SESSION0000000000002",
			status: "live",
		});
		daemon.channels.add("ch-remote");
		remote.running = daemon;
		await sm.startup();
		addWindow();
		const outcome = sm.connectHost(hostId, { clientId: "c-window" });
		expect(outcome.kind).toBe("connecting");
		if (outcome.kind === "connecting") expect(await outcome.done).toBe(true);
	}

	it("is stopped once its last terminal of this hub exits, and the next connection starts the current one", async () => {
		const old = daemons.make(OLD);
		await connectHolding(old);
		await settle();
		expect(stopsTo(old)).toEqual([]);
		expect(outdatedAgentOn(hostId)).toEqual({ running: OLD, expected: HUB_VERSION });

		old.agents[0]?.exit("ch-remote");
		await vi.waitFor(() => expect(sm.agents.has(hostId)).toBe(false));

		expect(stopsTo(old)).toEqual([{ type: "STOP", force: false }]);
		// Not reached again by itself: that could mean asking for a passphrase.
		expect(remote.started).toEqual([]);
		expect(outdatedAgentOn(hostId)).toBeUndefined();

		expect(await sm.handleSpawn("c-window", { type: "SPAWN", hostId })).not.toBeNull();
		expect(remote.started.map((d) => d.version)).toEqual([HUB_VERSION]);
		expect(spawnsTo(remote.started[0] as FakeDaemon)).toHaveLength(1);
		expect(spawnsTo(old)).toEqual([]);
	});

	it("is stopped before a terminal starts on it when the connection finds it idle, and the terminal lands on the current one", async () => {
		const old = daemons.make(OLD);
		remote.running = old;
		addWindow();

		const channelId = await sm.handleSpawn("c-window", { type: "SPAWN", hostId });

		expect(channelId).not.toBeNull();
		expect(stopsTo(old)).toEqual([{ type: "STOP", force: false }]);
		expect(spawnsTo(old)).toEqual([]);
		expect(remote.started.map((d) => d.version)).toEqual([HUB_VERSION]);
		expect(spawnsTo(remote.started[0] as FakeDaemon)).toHaveLength(1);
		expect(sm.agents.get(hostId)?.helloMessage?.agentVersion).toBe(HUB_VERSION);
		expect(heard.filter((m) => m.type === "ERROR")).toEqual([]);
	});

	it("is kept while other hubs hold terminals there", async () => {
		const old = daemons.make(OLD);
		old.othersHold = 1;
		await connectHolding(old);

		old.agents[0]?.exit("ch-remote");
		await settle(20);

		expect(stopsTo(old)).toEqual([{ type: "STOP", force: false }]);
		expect(sm.agents.get(hostId)).toBe(old.agents[0]);
		expect(outdatedAgentOn(hostId)).toEqual({ running: OLD, expected: HUB_VERSION });
	});

	it("never stops an agent on stdio, which every connection replaces", async () => {
		remote.stdioVersion = OLD;
		addWindow();
		const channelId = await sm.handleSpawn("c-window", { type: "SPAWN", hostId });
		const [agent] = remote.agents;

		agent?.exit(channelId ?? "");
		await settle(20);

		expect(agent?.sent.filter((m) => m.type === "STOP")).toEqual([]);
		expect(sm.agents.get(hostId)).toBe(agent);
	});
});
