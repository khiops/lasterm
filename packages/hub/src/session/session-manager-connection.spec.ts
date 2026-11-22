import { sshAddress, targetRoute } from "../ssh-route.js";
/**
 * A host's Connect, Reconnect and Disconnect, asked for from its menu (#648),
 * against a mock SSH server: the agent on stdio, or a daemon reached over its
 * socket that keeps its terminals across connections.
 *
 * Every connection the hub opens is counted by the server, so a reconnect the
 * hub was not asked for is seen.
 */

import { createHash, generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type net from "node:net";
import { join } from "node:path";
import {
	type AgentSpawnMessage,
	type AuthPromptMessage,
	encodeFrame,
	FrameReader,
	generateId,
	type HelloMessage,
	type Host,
	type HostVerifyMessage,
	PROTOCOL_VERSION,
	type ProtocolMessage,
} from "@lasterm/shared";
import ssh2, { Server } from "ssh2";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { HUB_VERSION } from "../build-version.js";
import { openTestDatabases } from "../storage/db.js";
import { makeTempDir, removeTempDir } from "../temp-dir.fixture.js";
import { deployAgentIfNeeded, getBinaryCacheDir } from "./agent-deployer.js";
import { socketForwardingRefusedOn } from "./remote-daemon.js";
import type { SessionState, SharedSessionContext } from "./session-context.js";
import { SessionManager, type WsClient } from "./session-manager.js";
import { SshAgent } from "./ssh-agent.js";
import type { SshConnectionManager } from "./ssh-connection-manager.js";

// The mock host already runs its agent: nothing to upload, nothing to check.
vi.mock("./agent-deployer.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./agent-deployer.js")>()),
	deployAgentIfNeeded: vi.fn().mockResolvedValue({
		deployed: false,
		remoteMatchesHubVersionCache: false,
		remotePath: "lasterm-agent",
		os: null,
		arch: null,
	}),
}));

function rsaPem(): string {
	return generateKeyPairSync("rsa", {
		modulusLength: 2048,
		publicKeyEncoding: { type: "pkcs1", format: "pem" },
		privateKeyEncoding: { type: "pkcs1", format: "pem" },
	}).privateKey;
}

const HOST_KEY = rsaPem();
const KEY_DIR = makeTempDir("lasterm-host-connection-");
const CLIENT_KEY_PATH = join(KEY_DIR, "client.pem");
writeFileSync(CLIENT_KEY_PATH, rsaPem(), { mode: 0o600 });
/** A key that needs its passphrase (#860). */
const ENCRYPTED_KEY_PATH = join(KEY_DIR, "encrypted.pem");
writeFileSync(
	ENCRYPTED_KEY_PATH,
	generateKeyPairSync("rsa", {
		modulusLength: 2048,
		publicKeyEncoding: { type: "pkcs1", format: "pem" },
		privateKeyEncoding: {
			type: "pkcs1",
			format: "pem",
			cipher: "aes-256-cbc",
			passphrase: "not-a-real-secret",
		},
	}).privateKey,
	{ mode: 0o600 },
);

const HOST_FINGERPRINT = (() => {
	const parsed = ssh2.utils.parseKey(HOST_KEY);
	if (parsed instanceof Error) throw parsed;
	const key = Array.isArray(parsed) ? parsed[0] : parsed;
	return `SHA256:${createHash("sha256").update(key.getPublicSSH()).digest("base64").replace(/=+$/, "")}`;
})();

afterAll(async () => {
	await removeTempDir(KEY_DIR);
});

// ─── The mock host ───────────────────────────────────────────────────────────

type Stream = NodeJS.ReadWriteStream & { exit?: (code: number) => void };

interface MockHost {
	port: number;
	/** SSH connections it accepted. */
	connections: number;
	/** Times its daemon's socket was reached. */
	socketOpens: number;
	/** The terminals its daemon holds, reported alive on every connection. */
	held: string[];
	stops: boolean[];
	/** Daemons launched, and stopped through `--stop`, where it refuses socket forwarding. */
	daemonLaunches: number;
	daemonStops: number;
	/** Relays the hub ran that reached the daemon (#755). */
	relays: number;
	/** The hash `sha256sum` reports for an agent `which` finds on PATH, or none. */
	installedAgentSha: string | null;
	/**
	 * What a Windows host's `--daemon --detach` says (#755): started, or its
	 * SSH session's job forbids breaking away.
	 */
	detach: "started" | "breakaway-refused";
	/** The arguments of every Windows launch the hub ran there, decoded (#755). */
	windowsArgs: string[];
	/** The installed agent predates `--attach`: clap's usage error, no marker. */
	relayPredates: boolean;
	/** Where that agent is: on PATH at /usr/local/bin, or off PATH under ~/.local/bin. */
	installedOffPath: boolean;
	/** `sha256sum` fails on the installed agent. */
	installedHashUnreadable: boolean;
	/** Every command run over SSH, in order, before anything answers it (#701). */
	execs: string[];
	/**
	 * A daemon host's socket, when no daemon answers on it: `silent`, nothing
	 * listens; `unknown`, the host cannot say; `refusing`, it listens and the
	 * channel still fails. `running` (the default) answers (#701).
	 */
	daemonSocket: "running" | "silent" | "unknown" | "refusing";
	/** Its daemon says `stop-accepted`, and answers a STOP with STOP_ACCEPTED (#700). */
	acknowledgesStop: boolean;
	/** With `acknowledgesStop`: the link drops after STOP, before any STOP_ACCEPTED. */
	dropsOnStop: boolean;
	/** Its daemon refuses this hub's AUTH (#701). */
	refusesAuth: boolean;
	/** Its daemon's list waits for `releaseList` (#701). */
	holdsList: boolean;
	releaseList: () => void;
	/** Its daemon never sends its list (#701). */
	neverLists: boolean;
	/** The daemon connection whose list is held, to say things before it. */
	listStream: Stream | null;
	/** The version its agent says in HELLO. */
	agentVersion: string;
	/** How many more socket channels fail before one opens (#701). */
	rejectsOpens: number;
	/** SPAWNs answered, and whether the next SPAWN_OK waits for `releaseSpawn`. */
	spawns: number;
	holdsSpawn: boolean;
	releaseSpawn: () => void;
	/** The channels its daemon was told to DESTROY. */
	destroys: string[];
	/** End every SSH connection it holds, leaving it listening. */
	dropLinks: () => void;
	close: () => Promise<void>;
}

/** What a Windows agent says when its SSH session's job forbids breaking away. */
const BREAKAWAY_REFUSED =
	"this SSH session's job does not allow a process to break away; the daemon would end with the connection";

const ENCODED_POWERSHELL = "powershell -NoProfile -NonInteractive -EncodedCommand ";

/** The arguments a Windows launch of the agent passes, decoded; null for any other command. */
function windowsLaunchArgs(command: string): string | null {
	if (!command.startsWith(ENCODED_POWERSHELL)) return null;
	const script = Buffer.from(command.slice(ENCODED_POWERSHELL.length), "base64").toString(
		"utf16le",
	);
	const encoded =
		/\$a=\[Text\.Encoding\]::UTF8\.GetString\(\[Convert\]::FromBase64String\('([^']*)'\)\)/.exec(
			script,
		)?.[1];
	return encoded === undefined ? null : Buffer.from(encoded, "base64").toString("utf8");
}

function hello(daemon = false, acknowledgesStop = false, agentVersion = HUB_VERSION): Buffer {
	return Buffer.from(
		encodeFrame({
			type: "HELLO",
			version: PROTOCOL_VERSION,
			agentVersion,
			capabilities: [
				"multiplex",
				"snapshot",
				"resize",
				...(daemon ? ["hub-identity"] : []),
				...(daemon && acknowledgesStop ? ["stop-accepted"] : []),
			],
		}),
	);
}

/** What a daemon lists after AUTH: its terminals, then the end. */
function listHeld(stream: Stream, remote: MockHost): void {
	for (const channelId of remote.held) {
		stream.write(
			Buffer.from(
				encodeFrame({
					type: "AGENT_CHANNEL_STATE",
					channelId,
					title: "bash",
					pid: 4242,
					alive: true,
				}),
			),
		);
	}
	stream.write(Buffer.from(encodeFrame({ type: "CHANNEL_STATE_END", otherOwnerChannels: 0 })));
}

/** An agent: HELLO, then a SPAWN_OK for every SPAWN, under the id asked for or a new one. */
function serveAgent(stream: Stream, remote?: MockHost): void {
	const reader = new FrameReader();
	stream.on("data", (data: Buffer) => {
		for (const msg of reader.push(data)) {
			if (msg.type === "AUTH" && remote) {
				if (remote.refusesAuth) {
					stream.write(
						Buffer.from(
							encodeFrame({ type: "ERROR", code: "AUTH_INVALID", message: "not this hub" }),
						),
					);
					stream.end();
					continue;
				}
				if (remote.neverLists) {
					remote.listStream = stream;
					continue;
				}
				if (remote.holdsList) {
					remote.listStream = stream;
					remote.releaseList = () => listHeld(stream, remote);
					continue;
				}
				listHeld(stream, remote);
				continue;
			}
			if (msg.type === "STOP" && remote) {
				remote.stops.push(msg.force === true);
				if (remote.acknowledgesStop && !remote.dropsOnStop) {
					stream.write(Buffer.from(encodeFrame({ type: "STOP_ACCEPTED" })));
				}
				stream.end();
				continue;
			}
			if (msg.type === "DESTROY" && remote) {
				remote.destroys.push((msg as { channelId: string }).channelId);
				continue;
			}
			if (msg.type !== "SPAWN") continue;
			const spawn = msg as AgentSpawnMessage;
			const answer = (): void => {
				stream.write(
					Buffer.from(
						encodeFrame({
							type: "SPAWN_OK",
							requestId: spawn.requestId,
							channelId: spawn.channelId ?? generateId(),
						}),
					),
				);
			};
			if (remote) remote.spawns++;
			if (remote?.holdsSpawn) {
				remote.releaseSpawn = answer;
				continue;
			}
			answer();
		}
	});
	stream.write(
		hello(remote !== undefined, remote?.acknowledgesStop === true, remote?.agentVersion),
	);
}

/**
 * An SSH server that lets anyone in. Its agent runs on stdio for any command,
 * or, `daemon`, is a daemon already running: its state directory is where the
 * hub looks, and its socket says what it holds.
 *
 * `refusesForwarding` is an sshd with `AllowStreamLocalForwarding no` (#765):
 * every socket channel fails as one to an empty socket does, while the
 * daemon a launch starts listens until its `--stop`, and `--stdio` runs.
 */
function mockHost(daemon: boolean, refusesForwarding = false): Promise<MockHost> {
	const ends: Array<() => void> = [];
	const result: MockHost = {
		port: 0,
		connections: 0,
		socketOpens: 0,
		held: [],
		stops: [],
		daemonLaunches: 0,
		daemonStops: 0,
		relays: 0,
		detach: "started",
		windowsArgs: [],
		installedAgentSha: null,
		relayPredates: false,
		installedOffPath: false,
		installedHashUnreadable: false,
		execs: [],
		daemonSocket: "running",
		acknowledgesStop: false,
		dropsOnStop: false,
		refusesAuth: false,
		holdsList: false,
		releaseList: () => {},
		neverLists: false,
		listStream: null,
		agentVersion: HUB_VERSION,
		rejectsOpens: 0,
		spawns: 0,
		holdsSpawn: false,
		releaseSpawn: () => {},
		destroys: [],
		dropLinks: () => {
			for (const end of ends.splice(0)) end();
		},
		close: async () => {},
	};
	let listening = false;
	/**
	 * The relay (#755): the daemon itself once it listens, else what the relay
	 * says on stderr, with the 1 a PowerShell shell would leave.
	 */
	const answerRelay = (stream: Stream, listens: boolean): void => {
		const relay = stream as Stream & { stderr: NodeJS.WritableStream };
		if (result.relayPredates) {
			relay.stderr.write("error: unexpected argument '--attach' found\n");
			stream.exit?.(2);
			stream.end();
			return;
		}
		relay.stderr.write("lasterm-attach: start\n");
		if (listens) {
			result.relays++;
			serveAgent(stream, result);
			return;
		}
		relay.stderr.write("lasterm-attach: nothing-listens\n");
		stream.exit?.(1);
		stream.end();
	};
	/**
	 * What a Windows host answers (#755): each command a PowerShell launch of
	 * the agent, with exit status 1 for every failure, as PowerShell leaves it.
	 */
	const answerWindows = (stream: Stream, args: string): void => {
		const relay = stream as Stream & { stderr: NodeJS.WritableStream };
		if (args === "--stdio") {
			serveAgent(stream);
			return;
		}
		if (args.startsWith("--attach")) {
			answerRelay(stream, result.daemonSocket === "running");
			return;
		}
		if (args.startsWith("--daemon --detach")) {
			result.daemonLaunches++;
			if (result.detach === "started") {
				result.daemonSocket = "running";
				relay.stderr.write("lasterm-detach: started\n");
				stream.exit?.(0);
			} else {
				relay.stderr.write(`lasterm-detach: breakaway-refused\n${BREAKAWAY_REFUSED}\n`);
				stream.exit?.(1);
			}
			stream.end();
			return;
		}
		if (args === "--stop") {
			result.daemonStops++;
			result.daemonSocket = "silent";
			stream.write("stopped\n");
			stream.exit?.(0);
			stream.end();
			return;
		}
		stream.exit?.(1);
		stream.end();
	};
	/** What a host that refuses the forwarding answers. */
	const answerRefusing = (stream: Stream, command: string): void => {
		if (command.includes("--stdio")) {
			serveAgent(stream);
			return;
		}
		if (command.includes("--attach")) {
			answerRelay(stream, listening);
			return;
		}
		if (command.includes("XDG_STATE_HOME")) {
			stream.write("/home/pi/.local/state/lasterm");
		} else if (command.includes("/proc/net/unix")) {
			stream.write(`lasterm-socket: ${listening ? "listening" : "silent"}\n`);
		} else if (command.includes("--daemon")) {
			result.daemonLaunches++;
			listening = true;
		} else if (command.includes("--stop")) {
			result.daemonStops++;
			listening = false;
			stream.write("stopped\n");
		}
		stream.exit?.(0);
		stream.end();
	};
	const server = new Server({ hostKeys: [HOST_KEY] }, (conn) => {
		result.connections++;
		ends.push(() => conn.end());
		conn.on("error", () => {});
		conn.on("authentication", (ctx) => ctx.accept());
		conn.on("ready", () => {
			conn.on("session", (accept) => {
				const session = accept();
				// An ordinary OpenSSH host: it offers the SFTP the hub asks about once connected (#722).
				session.on("sftp", (acceptSftp) => acceptSftp());
				session.on("exec", (acceptExec, _reject, info) => {
					const stream = acceptExec() as Stream;
					result.execs.push(info.command);
					const windows = windowsLaunchArgs(info.command);
					if (windows !== null) {
						result.windowsArgs.push(windows);
						answerWindows(stream, windows);
						return;
					}
					if (refusesForwarding) {
						answerRefusing(stream, info.command);
						return;
					}
					if (!daemon || info.command.includes("--stdio")) {
						serveAgent(stream);
						return;
					}
					const installed = result.installedOffPath
						? "/home/pi/.local/bin/lasterm-agent"
						: "/usr/local/bin/lasterm-agent";
					if (
						result.installedAgentSha &&
						!result.installedOffPath &&
						info.command.startsWith("which lasterm-agent")
					) {
						stream.write(`${installed}\n`);
					} else if (
						result.installedAgentSha &&
						result.installedOffPath &&
						info.command.startsWith('test -x "$HOME/.local/bin/lasterm-agent"')
					) {
						stream.write(`${installed}\n`);
					} else if (
						result.installedAgentSha &&
						info.command.startsWith(`sha256sum '${installed}'`)
					) {
						if (result.installedHashUnreadable) {
							stream.exit?.(1);
							stream.end();
							return;
						}
						stream.write(`${result.installedAgentSha}  ${installed}\n`);
					}
					if (info.command.includes("--attach")) {
						answerRelay(
							stream,
							result.daemonSocket === "running" || result.daemonSocket === "refusing",
						);
						return;
					}
					if (info.command.includes("XDG_STATE_HOME")) {
						stream.write("/home/pi/.local/state/lasterm");
					} else if (info.command.includes("/proc/net/unix")) {
						// The socket table: what a host that cannot read it prints is nothing.
						if (result.daemonSocket === "silent") stream.write("lasterm-socket: silent\n");
						if (result.daemonSocket === "refusing" || result.daemonSocket === "running")
							stream.write("lasterm-socket: listening\n");
					} else if (info.command.includes("--daemon")) {
						result.daemonLaunches++;
						result.daemonSocket = "running";
					}
					stream.exit?.(0);
					stream.end();
				});
			});
			(
				conn as unknown as {
					on: (
						event: "openssh.streamlocal",
						listener: (accept: () => Stream, reject: () => void) => void,
					) => void;
				}
			).on("openssh.streamlocal", (accept, reject) => {
				if (!daemon || refusesForwarding || result.daemonSocket !== "running") {
					reject();
					return;
				}
				if (result.rejectsOpens > 0) {
					result.rejectsOpens--;
					reject();
					return;
				}
				result.socketOpens++;
				// HELLO; what it holds once AUTH says who asks (#127).
				serveAgent(accept(), result);
			});
		});
	});
	server.on("error", () => {});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			result.port = (server.address() as net.AddressInfo).port;
			result.close = () => {
				for (const end of ends) end();
				return new Promise((done) => server.close(() => done()));
			};
			resolve(result);
		});
	});
}

/** Waits for `condition`, and fails saying what was awaited if it does not come. */
async function until(what: string, condition: () => boolean, withinMs = 8_000): Promise<void> {
	const deadline = Date.now() + withinMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`still waiting after ${withinMs} ms: ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

// ─── The hub ─────────────────────────────────────────────────────────────────

interface Harness {
	sm: SessionManager;
	ctx: SharedSessionContext;
	sshMgr: SshConnectionManager;
	host: Host;
	remote: MockHost;
	/** A window, and everything the hub sent it. */
	window: WsClient;
	heard: ProtocolMessage[];
}

const cleanups: Array<() => Promise<void> | void> = [];
/** Every SSH agent a test started, in order. */
const SshAgentsSeen = new Set<SshAgent>();

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function hubWith(
	options: {
		daemon: boolean;
		pinned?: boolean;
		windowId?: string;
		pin?: string;
		/** The pin as 0.14.3 wrote it, padded, then migration 022 as an upgrade runs it. */
		pinnedBy0143?: boolean;
		refusesForwarding?: boolean;
		/** The key the hub signs in with; one that needs no passphrase by default. */
		keyPath?: string;
		/** The host's stored daemon setting, when not `daemon` (#701). */
		stored?: boolean | null;
		/** The host's stored OS; unknown by default. */
		os?: "linux" | "darwin" | "windows" | null;
	} = {
		daemon: false,
	},
): Promise<Harness> {
	const remote = await mockHost(options.daemon, options.refusesForwarding);
	const dbManager = openTestDatabases();
	const sm = new SessionManager(dbManager);
	const internals = sm as unknown as { ctx: SharedSessionContext; sshMgr: SshConnectionManager };
	const { ctx } = internals;
	const host = ctx.metaDal.createHost({
		type: "ssh",
		label: options.daemon ? "pi" : "box",
		sshHost: "127.0.0.1",
		sshPort: remote.port,
		sshAuth: "key",
		sshKeyPath: options.keyPath ?? CLIENT_KEY_PATH,
		sshRemoteDaemon: options.stored === undefined ? options.daemon : options.stored,
		...(options.os !== undefined && { os: options.os }),
	});
	if (options.pinned !== false)
		ctx.metaDal.updateHostFingerprint(
			host.id,
			HOST_FINGERPRINT,
			targetRoute(host, (id) => sshAddress(ctx.metaDal.getHost(id))),
		);

	if (options.pin !== undefined)
		dbManager.meta
			.prepare("UPDATE hosts SET ssh_fingerprint = ? WHERE id = ?")
			.run(options.pin, host.id);
	if (options.pinnedBy0143) {
		dbManager.meta
			.prepare("UPDATE hosts SET ssh_fingerprint = ? WHERE id = ?")
			.run(`${HOST_FINGERPRINT}=`, host.id);
		const migration = readFileSync(
			new URL("../storage/migrations/meta/022-unpadded-ssh-pins.sql", import.meta.url),
			"utf-8",
		);
		dbManager.meta.exec(migration.replace(/INSERT INTO schema_version[^;]*;/, ""));
	}

	const heard: ProtocolMessage[] = [];
	const window: WsClient = {
		id: options.windowId ?? "c-window",
		send: (msg) => heard.push(msg),
		attachedChannels: new Set(),
	};
	sm.addClient(window);

	// Every connection a test starts is seen to end before the hub goes.
	const closed: Array<Promise<unknown>> = [];
	const start = SshAgent.prototype.start;
	const tracking = vi.spyOn(SshAgent.prototype, "start").mockImplementation(function (
		this: SshAgent,
		...args: Parameters<SshAgent["start"]>
	) {
		closed.push(once(this, "close"));
		SshAgentsSeen.add(this);
		return start.apply(this, args);
	});
	cleanups.push(async () => {
		await remote.close();
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			Promise.all(closed),
			new Promise((resolve) => {
				timer = setTimeout(resolve, 5_000);
			}),
		]);
		clearTimeout(timer);
		sm.beginQuit();
		await sm.shutdown();
		dbManager.close();
		tracking.mockRestore();
	});
	return { sm, ctx, sshMgr: internals.sshMgr, host, remote, window, heard };
}

/** Its agent, when connected. */
function agentOf(h: Harness): SshAgent | undefined {
	const agent = h.ctx.agents.get(h.host.id);
	return agent instanceof SshAgent && agent.connected ? agent : undefined;
}

/** Connect the host as its menu's Connect does, and wait for it. */
async function connected(h: Harness): Promise<SshAgent> {
	const outcome = h.sm.connectHost(h.host.id, { clientId: h.window.id });
	if (outcome.kind !== "connecting") throw new Error(`not connecting: ${outcome.kind}`);
	await expect(outcome.done).resolves.toBe(true);
	const agent = agentOf(h);
	if (agent === undefined) throw new Error("no agent after connecting");
	return agent;
}

/** Terminals of the host's session, running there, which its daemon (if any) holds. */
function terminalsOn(h: Harness, count: number): string[] {
	const session = h.ctx.sessions.get(h.host.id);
	if (session === undefined) throw new Error("no session");
	const ids = Array.from({ length: count }, () => generateId());
	for (const id of ids) {
		h.ctx.metaDal.createChannel({ id, sessionId: session.id, status: "live", shell: "bash" });
		h.ctx.channels.set(id, {
			sessionId: session.id,
			hostId: h.host.id,
			status: "live",
			clients: new Set(),
			shell: "bash",
			cols: 80,
			rows: 24,
			dynamicTitle: null,
			processTitle: null,
			displayTitle: "bash",
		});
	}
	h.remote.held = ids;
	return ids;
}

type HeardSessionState = {
	status: string;
	disconnectedByUser?: boolean;
	socketForwardingRefused?: boolean;
	remoteDaemonUnavailable?: string;
};

function sessionStates(h: Harness): HeardSessionState[] {
	return h.heard
		.filter((m) => m.type === "SESSION_STATE" && m.hostId === h.host.id)
		.map((m) => m as HeardSessionState);
}

function endsOf(h: Harness, channelId: string): ProtocolMessage[] {
	return h.heard.filter(
		(m) => m.type === "CHANNEL_STATE" && m.channelId === channelId && m.status === "dead",
	);
}

function sessionOf(h: Harness): SessionState | undefined {
	return h.ctx.sessions.get(h.host.id);
}

// ─── Connect ─────────────────────────────────────────────────────────────────

describe("Connect (#648)", { timeout: 20_000 }, () => {
	it("connects without a prompt to a host 0.14.3 pinned, once migration 022 ran (#717)", async () => {
		const h = await hubWith({ daemon: false, pinnedBy0143: true });
		expect(h.ctx.metaDal.getHost(h.host.id)?.sshFingerprint).toBe(HOST_FINGERPRINT);
		await connected(h);
		expect(h.heard.some((m) => m.type === "HOST_VERIFY")).toBe(false);
	});

	it("reports both fingerprints when the host presents another key than its pin", async () => {
		const parsed = ssh2.utils.parseKey(rsaPem());
		if (parsed instanceof Error || Array.isArray(parsed)) throw new Error("invalid key");
		const old = `SHA256:${createHash("sha256").update(parsed.getPublicSSH()).digest("base64").replace(/=+$/, "")}`;
		const h = await hubWith({ daemon: false, pin: old });
		h.window.send = (msg) => {
			h.heard.push(msg);
			if (msg.type === "HOST_VERIFY") {
				expect(msg).toMatchObject({
					fingerprint: HOST_FINGERPRINT,
					oldFingerprint: old,
				});
				queueMicrotask(() =>
					h.sm.handleHostVerifyResponse((msg as HostVerifyMessage).promptId, "reject", h.window.id),
				);
			}
		};
		const outcome = h.sm.connectHost(h.host.id, { clientId: h.window.id });
		if (outcome.kind !== "connecting") throw new Error(outcome.kind);
		await expect(outcome.done).resolves.toBe(false);
		expect(h.heard.filter((m) => m.type === "HOST_VERIFY")).toHaveLength(1);
	});

	it("prompts and writes an unpadded pin on first connection", async () => {
		const h = await hubWith({ daemon: false, pinned: false });
		const write = vi.spyOn(h.ctx.metaDal, "updateHostFingerprint");
		h.window.send = (msg) => {
			h.heard.push(msg);
			if (msg.type === "HOST_VERIFY") {
				expect(msg).toMatchObject({ fingerprint: HOST_FINGERPRINT, firstConnect: true });
				queueMicrotask(() =>
					h.sm.handleHostVerifyResponse(
						(msg as HostVerifyMessage).promptId,
						"trust_permanent",
						h.window.id,
					),
				);
			}
		};
		await connected(h);
		expect(h.heard.filter((m) => m.type === "HOST_VERIFY")).toHaveLength(1);
		expect(write).toHaveBeenCalledWith(h.host.id, HOST_FINGERPRINT, expect.any(String));
		expect(h.ctx.metaDal.getHost(h.host.id)?.sshFingerprint).toBe(HOST_FINGERPRINT);
		write.mockRestore();
	});

	it("refuses a pinned revoked key without prompting or changing the pin", async () => {
		const h = await hubWith({ daemon: false });
		const home = makeTempDir("lasterm-revoked-session-");
		cleanups.push(() => {
			vi.unstubAllEnvs();
			removeTempDir(home);
		});
		mkdirSync(join(home, ".ssh"));
		const key = ssh2.utils.parseKey(HOST_KEY);
		if (key instanceof Error || Array.isArray(key)) throw new Error("invalid mock key");
		const file = join(home, ".ssh", "known_hosts");
		writeFileSync(
			file,
			`@revoked [127.0.0.1]:${h.remote.port} ${key.type} ${key.getPublicSSH().toString("base64")}\n`,
		);
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		const outcome = h.sm.connectHost(h.host.id, { clientId: h.window.id });
		expect(outcome.kind).toBe("connecting");
		if (outcome.kind !== "connecting") throw new Error("expected connecting");
		await expect(outcome.done).resolves.toBe(false);
		expect(h.heard).toContainEqual(
			expect.objectContaining({
				type: "ERROR",
				code: "SSH_HOST_KEY_REVOKED",
				message: `This host's key is marked @revoked in ${file}:1. Refusing to connect.`,
			}),
		);
		expect(h.heard.some((m) => m.type === "HOST_VERIFY")).toBe(false);
		expect(h.ctx.metaDal.getHost(h.host.id)?.sshFingerprint).toBe(HOST_FINGERPRINT);
	});

	it("reaches the host and readies its agent, and starts no terminal", async () => {
		const h = await hubWith({ daemon: false });

		const outcome = h.sm.connectHost(h.host.id, { clientId: h.window.id });

		expect(outcome.kind).toBe("connecting");
		if (outcome.kind !== "connecting") return;
		await expect(outcome.done).resolves.toBe(true);
		expect(agentOf(h)).toBeDefined();
		expect(sessionOf(h)?.status).toBe("active");
		expect([...h.ctx.channels.values()].filter((c) => c.hostId === h.host.id)).toEqual([]);
		expect(h.heard.some((m) => m.type === "SPAWN_OK" || m.type === "CHANNEL_CREATED")).toBe(false);
		// The rail shows it being reached, then reached.
		expect(sessionStates(h).map((s) => s.status)).toEqual(["starting", "active"]);
		expect(h.remote.connections).toBe(1);
	});

	it("says it is connected already, and opens nothing more", async () => {
		const h = await hubWith({ daemon: false });
		await connected(h);

		expect(h.sm.connectHost(h.host.id).kind).toBe("connected");
		expect(h.remote.connections).toBe(1);
	});

	it("asks its questions of the window that asked, as a terminal's first connection does", async () => {
		// "c-b" sorts after "c-a": the one named, not the first there is, is asked.
		const h = await hubWith({ daemon: false, pinned: false, windowId: "c-b" });
		const other: ProtocolMessage[] = [];
		h.sm.addClient({ id: "c-a", send: (m) => other.push(m), attachedChannels: new Set() });
		const asked = new Promise<HostVerifyMessage>((resolve) => {
			h.window.send = (msg) => {
				h.heard.push(msg);
				if (msg.type === "HOST_VERIFY") resolve(msg as HostVerifyMessage);
			};
		});

		const outcome = h.sm.connectHost(h.host.id, { clientId: "c-b" });
		const question = await asked;
		expect(question.firstConnect).toBe(true);
		h.sm.handleHostVerifyResponse(question.promptId, "trust_once", "c-b");

		if (outcome.kind !== "connecting") throw new Error(outcome.kind);
		await expect(outcome.done).resolves.toBe(true);
		expect(other.some((m) => m.type === "HOST_VERIFY")).toBe(false);
	});

	it("says why it failed, to the window that asked, and leaves no session behind", async () => {
		const h = await hubWith({ daemon: false, pinned: false });
		h.window.send = (msg) => {
			h.heard.push(msg);
			if (msg.type === "HOST_VERIFY") {
				const { promptId } = msg as HostVerifyMessage;
				queueMicrotask(() => h.sm.handleHostVerifyResponse(promptId, "reject", h.window.id));
			}
		};

		const outcome = h.sm.connectHost(h.host.id, { clientId: h.window.id });
		if (outcome.kind !== "connecting") throw new Error(outcome.kind);

		await expect(outcome.done).resolves.toBe(false);
		expect(h.heard).toContainEqual(
			expect.objectContaining({ type: "ERROR", code: "SSH_HOST_KEY_REJECTED" }),
		);
		expect(sessionOf(h)).toBeUndefined();
		expect(sessionStates(h).at(-1)?.status).toBe("closed");
	});

	it("has nothing to do on the local host", async () => {
		const h = await hubWith({ daemon: false });
		const local = h.ctx.metaDal.createHost({ type: "local", label: "local" });

		expect(h.sm.connectHost(local.id).kind).toBe("not-ssh");
		expect(h.sm.reconnectHost(local.id).kind).toBe("not-ssh");
		expect(h.sm.disconnectHost(local.id).kind).toBe("not-ssh");
	});
});

// ─── Reconnect ───────────────────────────────────────────────────────────────

describe("Reconnect (#648)", { timeout: 20_000 }, () => {
	it("with a daemon: a new connection, and the terminals it holds are taken up, alive", async () => {
		const h = await hubWith({ daemon: true });
		const first = await connected(h);
		const [a, b] = terminalsOn(h, 2);
		const sessionId = sessionOf(h)?.id;

		const outcome = h.sm.reconnectHost(h.host.id, { clientId: h.window.id });

		expect(outcome).toMatchObject({ kind: "connecting", ended: 0 });
		if (outcome.kind !== "connecting") return;
		await expect(outcome.done).resolves.toBe(true);
		const second = agentOf(h);
		expect(second).toBeDefined();
		expect(second).not.toBe(first);
		expect(first.connected).toBe(false);
		expect(first.closedByHub).toBe(true);
		expect(h.remote.socketOpens).toBe(2);
		for (const id of [a, b] as string[]) {
			expect(h.ctx.channels.get(id)?.status).toBe("live");
			expect(endsOf(h, id)).toEqual([]);
		}
		expect(sessionOf(h)).toMatchObject({ id: sessionId, status: "active" });
	});

	it("without one: says how many terminals would end, and does nothing until told", async () => {
		const h = await hubWith({ daemon: false });
		const first = await connected(h);
		const ids = terminalsOn(h, 2);

		expect(h.sm.reconnectHost(h.host.id)).toEqual({ kind: "terminals-would-end", terminals: 2 });
		expect(agentOf(h)).toBe(first);
		for (const id of ids) expect(h.ctx.channels.get(id)?.status).toBe("live");
		expect(h.remote.connections).toBe(1);
	});

	it("without one, told: the terminals end with the old connection, and a new one opens", async () => {
		const h = await hubWith({ daemon: false });
		const first = await connected(h);
		const ids = terminalsOn(h, 2);

		const outcome = h.sm.reconnectHost(h.host.id, { clientId: h.window.id, force: true });

		expect(outcome).toMatchObject({ kind: "connecting", ended: 2 });
		if (outcome.kind !== "connecting") return;
		await expect(outcome.done).resolves.toBe(true);
		expect(agentOf(h)).not.toBe(first);
		expect(first.closedByHub).toBe(true);
		expect(h.remote.connections).toBe(2);
		for (const id of ids) {
			expect(h.ctx.channels.has(id)).toBe(false);
			expect(endsOf(h, id)).toEqual([expect.objectContaining({ endReason: "stopped" })]);
		}
		expect(sessionOf(h)?.status).toBe("active");
	});
});

// ─── A Windows host that keeps its daemon (#755) ────────────────────────────

describe("a Windows host that keeps its daemon (#755)", { timeout: 30_000 }, () => {
	/** The deploy says what a real one detects there: Windows. */
	function deployFindsWindows(): void {
		const deploy = vi.mocked(deployAgentIfNeeded);
		const remotePath = "C:UserspiAppDataLocallastermlasterm-agent.exe";
		deploy.mockResolvedValue({
			deployed: false,
			remoteMatchesHubVersionCache: false,
			remotePath,
			os: "windows",
			arch: "x64",
		});
		cleanups.push(() => {
			deploy.mockResolvedValue({
				deployed: false,
				remoteMatchesHubVersionCache: false,
				remotePath: "lasterm-agent",
				os: null,
				arch: null,
			});
		});
	}

	it("reaches it through the relay, started with --detach", async () => {
		deployFindsWindows();
		const h = await hubWith({ daemon: true, os: "windows" });
		h.remote.daemonSocket = "silent";

		const agent = await connected(h);

		expect(agent.usedRemoteDaemon).toBe(true);
		expect(agent.reachedThrough).toBe("relay");
		expect(h.remote.windowsArgs).toEqual([
			"--attach --wait 0",
			expect.stringMatching(/^--daemon --detach .* --idle-timeout 1800 /),
			expect.stringMatching(/^--attach --wait [1-9]\d*$/),
		]);
		expect(h.remote.execs.filter((c) => !c.startsWith(ENCODED_POWERSHELL))).toEqual([]);
		expect(sessionStates(h).at(-1)?.remoteDaemonUnavailable).toBeUndefined();
	});

	// AC-W2. Mutation: a field left out of the announcement condition, or a
	// field that outlives the connection that set it.
	it("runs on stdio where breakaway is refused, says why while that connection lasts, and forgets it", async () => {
		deployFindsWindows();
		const h = await hubWith({ daemon: true, os: "windows" });
		h.remote.daemonSocket = "silent";
		h.remote.detach = "breakaway-refused";

		const agent = await connected(h);

		expect(agent.reachedThrough).toBe("stdio");
		expect(h.remote.windowsArgs.at(-1)).toBe("--stdio");
		await until(
			"the host says why it keeps no daemon",
			() => sessionStates(h).at(-1)?.remoteDaemonUnavailable === BREAKAWAY_REFUSED,
		);
		expect(sessionStates(h).at(-1)).toMatchObject({ status: "active" });
		expect(h.sm.getStateSnapshot().sessions).toEqual([
			expect.objectContaining({ hostId: h.host.id, remoteDaemonUnavailable: BREAKAWAY_REFUSED }),
		]);

		// Disconnected: the field goes.
		expect(h.sm.disconnectHost(h.host.id)).toMatchObject({ kind: "disconnected" });
		expect(sessionStates(h).at(-1)?.remoteDaemonUnavailable).toBeUndefined();
		expect(
			h.sm.getStateSnapshot().sessions.filter((s) => s.remoteDaemonUnavailable !== undefined),
		).toEqual([]);

		// A later connection that reaches a daemon says nothing of it either.
		h.remote.detach = "started";
		const again = await connected(h);
		expect(again.reachedThrough).toBe("relay");
		expect(sessionStates(h).at(-1)).toMatchObject({ status: "active" });
		expect(sessionStates(h).at(-1)?.remoteDaemonUnavailable).toBeUndefined();
		expect(h.sm.getStateSnapshot().sessions).toEqual([
			expect.not.objectContaining({ remoteDaemonUnavailable: expect.anything() }),
		]);
	});
	// AC-W2 / cleared-by-daemon: the field goes with the daemon reach itself,
	// on the reconnect after a lost link, with no Disconnect in between.
	// Mutation: the reason kept per host and cleared only by a Disconnect.
	it("forgets why once the reconnect after a lost link reaches a daemon", async () => {
		deployFindsWindows();
		const h = await hubWith({ daemon: true, os: "windows" });
		h.remote.daemonSocket = "silent";
		h.remote.detach = "breakaway-refused";
		await connected(h);
		await until(
			"the host says why it keeps no daemon",
			() => sessionStates(h).at(-1)?.remoteDaemonUnavailable === BREAKAWAY_REFUSED,
		);

		h.remote.detach = "started";
		const launchesBefore = h.remote.daemonLaunches;
		h.remote.dropLinks();
		await until(
			"the reconnect reaches a daemon",
			() => agentOf(h)?.reachedThrough === "relay",
			15_000,
		);

		expect(h.remote.daemonLaunches).toBe(launchesBefore + 1);
		await until("the host says active again", () => sessionStates(h).at(-1)?.status === "active");
		expect(sessionStates(h).at(-1)?.remoteDaemonUnavailable).toBeUndefined();
		expect(
			h.sm.getStateSnapshot().sessions.filter((s) => s.remoteDaemonUnavailable !== undefined),
		).toEqual([]);
	});
});

// ─── A server that refuses socket forwarding ─────────────────────────────────

describe("a host whose SSH server refuses socket forwarding (#765)", { timeout: 30_000 }, () => {
	it("reaches the daemon through the relay, keeps it, and relays first until a person asks (#755)", async () => {
		const h = await hubWith({ daemon: true, refusesForwarding: true });

		const first = await connected(h);

		expect(first.usedRemoteDaemon).toBe(true);
		expect(first.reachedThrough).toBe("relay");
		expect(first.socketForwardingRefused).toBe(true);
		// The daemon it started is kept, and reached through the relay.
		expect(h.remote.daemonLaunches).toBe(1);
		expect(h.remote.daemonStops).toBe(0);
		expect(h.remote.relays).toBe(1);
		expect(h.remote.execs.filter((c) => c.includes("--stdio"))).toEqual([]);
		expect(sessionStates(h).at(-1)).toMatchObject({
			status: "active",
			socketForwardingRefused: true,
		});
		expect(h.sm.getStateSnapshot().sessions).toEqual([
			expect.objectContaining({ hostId: h.host.id, socketForwardingRefused: true }),
		]);
		// Its terminals outlive the connection: a Disconnect ends none.
		terminalsOn(h, 2);
		expect(h.sm.disconnectHost(h.host.id)).toMatchObject({ kind: "disconnected", ended: 0 });

		// A terminal opened there connects through the relay at once.
		const probesBefore = h.remote.execs.filter((c) => c.includes("/proc/net/unix")).length;
		await expect(
			h.sm.handleSpawn(h.window.id, { type: "SPAWN", hostId: h.host.id }),
		).resolves.not.toBeNull();
		expect(h.remote.connections).toBe(2);
		expect(agentOf(h)?.reachedThrough).toBe("relay");
		expect(h.remote.execs.filter((c) => c.includes("/proc/net/unix")).length).toBe(probesBefore);
		expect(h.remote.daemonLaunches).toBe(1);
		expect(h.remote.relays).toBe(2);

		// A dropped link's automatic reconnect relays first too.
		const relaysBefore = h.remote.relays;
		const probesBeforeDrop = h.remote.execs.filter((c) => c.includes("/proc/net/unix")).length;
		h.remote.dropLinks();
		await until(
			"the reconnect reaches the daemon again",
			() => h.remote.relays > relaysBefore,
			15_000,
		);
		await until(
			"the reconnected agent is the host's",
			() => agentOf(h)?.connected === true,
			15_000,
		);
		expect(agentOf(h)?.reachedThrough).toBe("relay");
		expect(h.remote.execs.filter((c) => c.includes("/proc/net/unix")).length).toBe(
			probesBeforeDrop,
		);

		// A person's Reconnect asks the server again: the channel first, then
		// the relay to the same daemon.
		const outcome = h.sm.reconnectHost(h.host.id, { clientId: h.window.id, force: true });
		if (outcome.kind !== "connecting") throw new Error(outcome.kind);
		await expect(outcome.done).resolves.toBe(true);
		expect(h.remote.execs.filter((c) => c.includes("/proc/net/unix")).length).toBeGreaterThan(
			probesBefore,
		);
		expect(agentOf(h)?.socketForwardingRefused).toBe(true);
		expect(h.remote.daemonLaunches).toBe(1);
		expect(h.remote.daemonStops).toBe(0);
	});
});

// ─── Disconnect ──────────────────────────────────────────────────────────────

describe("Disconnect (#648)", { timeout: 20_000 }, () => {
	it("with a daemon: its terminals keep running, and its session waits, marked", async () => {
		const h = await hubWith({ daemon: true });
		const agent = await connected(h);
		const [id] = terminalsOn(h, 1) as [string];

		expect(h.sm.disconnectHost(h.host.id)).toEqual({ kind: "disconnected", ended: 0 });

		expect(agentOf(h)).toBeUndefined();
		expect(agent.closedByHub).toBe(true);
		expect(sessionOf(h)?.status).toBe("disconnected");
		expect(h.ctx.channels.get(id)?.status).toBe("live");
		expect(endsOf(h, id)).toEqual([]);
		expect(sessionStates(h).at(-1)).toMatchObject({
			status: "disconnected",
			disconnectedByUser: true,
		});
		expect(h.sm.getStateSnapshot().userDisconnectedHosts).toEqual([h.host.id]);
	});

	it("without one: says how many would end, then ends them once told", async () => {
		const h = await hubWith({ daemon: false });
		await connected(h);
		const ids = terminalsOn(h, 3);

		expect(h.sm.disconnectHost(h.host.id)).toEqual({ kind: "terminals-would-end", terminals: 3 });
		expect(agentOf(h)).toBeDefined();

		expect(h.sm.disconnectHost(h.host.id, { force: true })).toEqual({
			kind: "disconnected",
			ended: 3,
		});
		expect(agentOf(h)).toBeUndefined();
		expect(sessionOf(h)).toBeUndefined();
		for (const id of ids) {
			expect(endsOf(h, id)).toEqual([expect.objectContaining({ endReason: "stopped" })]);
		}
		expect(sessionStates(h).at(-1)).toMatchObject({ status: "closed", disconnectedByUser: true });
		expect(h.sm.getStateSnapshot().userDisconnectedHosts).toEqual([h.host.id]);
	});

	it("is not undone by the hub: no reconnect for a lost link, an attach, or a start nobody asked for", async () => {
		const h = await hubWith({ daemon: true });
		await connected(h);
		const [id] = terminalsOn(h, 1) as [string];
		h.sm.disconnectHost(h.host.id);
		const sessionId = sessionOf(h)?.id ?? "";

		// What a lost link does, once its close is heard.
		h.sshMgr.scheduleReconnect(h.host.id, sessionId, 0, Date.now());
		expect(h.ctx.reconnectTimers.has(h.host.id)).toBe(false);

		// A window opening over its terminal: answered from what the hub remembers.
		await expect(h.sm.handleAttach(h.window.id, id)).resolves.toBe(true);
		expect(h.heard).toContainEqual(
			expect.objectContaining({ type: "ATTACH_OK", channelId: id, cached: true }),
		);

		// A pane following "When a terminal ends": it waits for the host.
		await expect(
			h.sm.handleSpawn(h.window.id, {
				type: "SPAWN",
				hostId: h.host.id,
				automatic: true,
			}),
		).resolves.toBeNull();
		expect(h.heard).toContainEqual(
			expect.objectContaining({
				type: "ERROR",
				code: "HOST_UNREACHABLE",
				hostId: h.host.id,
				hostStatus: "disconnected",
			}),
		);

		// A second longer than the first backoff: nothing dialled meanwhile.
		await new Promise((resolve) => setTimeout(resolve, 1_200));
		expect(h.remote.connections).toBe(1);
		expect(agentOf(h)).toBeUndefined();
		expect(h.sm.getStateSnapshot().userDisconnectedHosts).toEqual([h.host.id]);
	});

	it("is undone by Connect, which takes up what the daemon kept", async () => {
		const h = await hubWith({ daemon: true });
		await connected(h);
		const [id] = terminalsOn(h, 1) as [string];
		h.sm.disconnectHost(h.host.id);

		await connected(h);

		expect(h.remote.socketOpens).toBe(2);
		expect(h.ctx.channels.get(id)?.status).toBe("live");
		expect(sessionStates(h).at(-1)).toEqual(expect.objectContaining({ status: "active" }));
		expect(sessionStates(h).at(-1)?.disconnectedByUser).toBeUndefined();
		expect(h.sm.getStateSnapshot().userDisconnectedHosts).toBeUndefined();
	});

	it("is undone by a terminal opened there, which brings it back; a restart nobody asked for waits", async () => {
		const h = await hubWith({ daemon: false });
		await connected(h);
		const [ended] = terminalsOn(h, 1) as [string];
		h.sm.disconnectHost(h.host.id, { force: true });

		// Its terminal, ended with the connection, brought back by the setting: refused.
		await expect(
			h.sm.handleSpawn(h.window.id, {
				type: "SPAWN",
				hostId: h.host.id,
				reuseChannelId: ended,
				automatic: true,
			}),
		).resolves.toBeNull();
		expect(h.heard).toContainEqual(
			expect.objectContaining({
				type: "ERROR",
				code: "HOST_UNREACHABLE",
				channelId: ended,
				hostStatus: "closed",
			}),
		);
		expect(h.remote.connections).toBe(1);

		// Someone opens a terminal there.
		const opened = await h.sm.handleSpawn(h.window.id, { type: "SPAWN", hostId: h.host.id });

		expect(opened).not.toBeNull();
		expect(h.remote.connections).toBe(2);
		expect(agentOf(h)).toBeDefined();
		expect(h.sm.getStateSnapshot().userDisconnectedHosts).toBeUndefined();
	});

	it("has nothing to close on a host never connected, and marks nothing", async () => {
		const h = await hubWith({ daemon: false });

		expect(h.sm.disconnectHost(h.host.id)).toEqual({ kind: "disconnected", ended: 0 });
		expect(h.sm.getStateSnapshot().userDisconnectedHosts).toBeUndefined();
	});
});

// ─── A host that comes back on its own ───────────────────────────────────────

describe("a host its user did not disconnect", { timeout: 20_000 }, () => {
	it("is still reconnected after a lost link", async () => {
		const h = await hubWith({ daemon: true });
		const first = await connected(h);

		// The host ends the connection: the hub did not ask for it.
		await h.remote.close();
		await until("the connection to end", () => !first.connected);

		const timer = h.ctx.reconnectTimers.get(h.host.id);
		expect(timer, "the loss scheduled a reconnect").toBeDefined();
		expect(sessionOf(h)?.status).toBe("disconnected");
		expect(sessionStates(h).at(-1)?.disconnectedByUser).toBeUndefined();
		// Nothing more is under test once the reconnect is seen waiting.
		clearTimeout(timer);
		h.ctx.reconnectTimers.delete(h.host.id);
	});
});

describe("uploads to a host hold its connection (#833)", { timeout: 20_000 }, () => {
	/** `count` uploads running to the host until a gesture interrupts them. */
	function uploads(h: Harness, count: number): { interrupted: string[] } {
		let running = count;
		const interrupted: string[] = [];
		h.sm.setTransfers({
			activeOn: (hostId) => (hostId === h.host.id ? running : 0),
			interruptOn: (hostId) => {
				interrupted.push(hostId);
				running = 0;
			},
		});
		return { interrupted };
	}

	it("Disconnect and Reconnect say how many would stop, and interrupt them once told", async () => {
		const h = await hubWith({ daemon: true });
		await connected(h);
		const running = uploads(h, 2);

		expect(h.sm.disconnectHost(h.host.id)).toEqual({ kind: "transfers-would-stop", transfers: 2 });
		expect(h.sm.reconnectHost(h.host.id, { clientId: h.window.id })).toEqual({
			kind: "transfers-would-stop",
			transfers: 2,
		});
		expect(agentOf(h)).toBeDefined();
		expect(running.interrupted).toEqual([]);

		expect(h.sm.disconnectHost(h.host.id, { force: true })).toEqual({
			kind: "disconnected",
			ended: 0,
		});
		expect(running.interrupted).toEqual([h.host.id]);
		expect(agentOf(h)).toBeUndefined();
	});

	it("counts them beside the terminals that would end, in one answer", async () => {
		const h = await hubWith({ daemon: false });
		await connected(h);
		terminalsOn(h, 1);
		uploads(h, 1);
		expect(h.sm.disconnectHost(h.host.id)).toEqual({
			kind: "terminals-would-end",
			terminals: 1,
			transfers: 1,
		});
	});

	it("DELETE /api/sessions/:id stops them only when forced", async () => {
		const h = await hubWith({ daemon: true });
		await connected(h);
		const running = uploads(h, 1);
		const sessionId = sessionOf(h)?.id ?? "";
		expect(await h.sm.closeSession(sessionId)).toEqual({ transfersWouldStop: 1 });
		expect(agentOf(h)).toBeDefined();
		expect(await h.sm.closeSession(sessionId, { force: true })).toBe("closed");
		expect(running.interrupted).toEqual([h.host.id]);
		expect(sessionOf(h)).toBeUndefined();
	});

	it("Stop keeping and Replace refuse until told the uploads stop", async () => {
		const h = await hubWith({ daemon: true });
		await connected(h);
		const running = uploads(h, 1);
		expect(
			await h.sm.stopKeepingAgent(h.host.id, { endTerminals: false, force: false }),
		).toMatchObject({ kind: "error", code: "TRANSFERS_WOULD_STOP", transfers: 1 });
		expect(await h.sm.replaceAgent(h.host.id)).toMatchObject({
			replaced: false,
			code: "TRANSFERS_WOULD_STOP",
			transfers: 1,
		});
		expect(h.remote.stops).toEqual([]);
		expect(running.interrupted).toEqual([]);
		expect(
			await h.sm.stopKeepingAgent(h.host.id, {
				endTerminals: false,
				force: false,
				stopTransfers: true,
			}),
		).toMatchObject({ kind: "done", response: { outcome: "stopped" } });
		expect(running.interrupted).toEqual([h.host.id]);
	});

	it("an upload connects a host through the acquisition, a host its user disconnected included", async () => {
		const h = await hubWith({ daemon: true });
		await connected(h);
		h.sm.disconnectHost(h.host.id);
		expect(agentOf(h)).toBeUndefined();
		await expect(h.sm.connectForTransfer(h.host.id, h.window.id)).resolves.toEqual({
			connected: true,
		});
		expect(agentOf(h)).toBeDefined();
		expect(h.sm.getStateSnapshot().userDisconnectedHosts).toBeUndefined();
	});

	it("says why it could not connect for an upload: a host key not accepted (#860)", async () => {
		const h = await hubWith({ daemon: false, pinned: false });
		h.window.send = (msg) => {
			h.heard.push(msg);
			if (msg.type === "HOST_VERIFY") {
				queueMicrotask(() =>
					h.sm.handleHostVerifyResponse((msg as HostVerifyMessage).promptId, "reject", h.window.id),
				);
			}
		};
		await expect(h.sm.connectForTransfer(h.host.id, h.window.id)).resolves.toEqual({
			connected: false,
			reason: "host_key_not_accepted",
		});
		expect(agentOf(h)).toBeUndefined();
	});

	it("says why it could not connect for an upload: a passphrase asked of the window, and not given (#860)", async () => {
		const h = await hubWith({ daemon: false, keyPath: ENCRYPTED_KEY_PATH });
		h.window.send = (msg) => {
			h.heard.push(msg);
			if (msg.type === "AUTH_PROMPT") {
				const prompt = msg as AuthPromptMessage;
				queueMicrotask(() =>
					h.sm.handleAuthPromptResponse(h.window.id, {
						hostId: prompt.hostId,
						secret: null,
						promptId: prompt.promptId,
						deliveryEpoch: prompt.deliveryEpoch,
					}),
				);
			}
		};
		await expect(h.sm.connectForTransfer(h.host.id, h.window.id)).resolves.toEqual({
			connected: false,
			reason: "needs_passphrase",
		});
		expect(h.heard.filter((m) => m.type === "AUTH_PROMPT")).toMatchObject([
			{ promptType: "passphrase" },
		]);
		expect(agentOf(h)).toBeUndefined();
	});

	it("tells the uploads when a host's agent connects, lists the interrupted ones in STATE_SYNC, and has them saved as the hub quits (#860)", async () => {
		const h = await hubWith({ daemon: true });
		const told: string[] = [];
		let saved = 0;
		const entry = {
			transferId: "01HZ0000000000000000000TR1",
			channelId: "01HZ0000000000000000000CH1",
			hostId: h.host.id,
			dir: "/srv",
			state: "interrupted" as const,
			totals: { files: 1, bytes: 10, acked: 4, states: { interrupted: 1 } },
			updatedAt: "2026-11-06T00:00:00.000Z",
			fromThisDevice: true,
		};
		const viewers: (string | null | undefined)[] = [];
		h.sm.setTransfers({
			activeOn: () => 0,
			interruptOn: () => {},
			hostConnected: (hostId) => told.push(hostId),
			saveNow: () => {
				saved++;
			},
			interruptedUploads: (viewerTokenId) => {
				viewers.push(viewerTokenId);
				return [entry];
			},
		});
		await connected(h);
		await until("the uploads are told", () => told.length > 0);
		expect(told).toEqual([h.host.id]);
		// Listed for the window that reads them: whether each is from its device (#837).
		expect(h.sm.getStateSnapshot("tok-a").transfers).toEqual([entry]);
		expect(viewers).toEqual(["tok-a"]);
		h.sm.beginQuit();
		expect(saved).toBe(1);
	});
});

describe("Stop keeping (#674)", { timeout: 20_000 }, () => {
	it("stops the daemon, ends two terminals and saves No", async () => {
		const h = await hubWith({ daemon: true });
		await connected(h);
		const ids = terminalsOn(h, 2);
		expect(h.heard.filter((m) => m.type === "SESSION_STATE").at(-1)).toMatchObject({
			connectedThroughRemoteDaemon: true,
		});
		expect(
			await h.sm.stopKeepingAgent(h.host.id, { endTerminals: false, force: false }),
		).toMatchObject({ code: "TERMINALS_WOULD_END", terminals: 2 });
		expect(h.remote.stops).toEqual([]);
		expect(
			await h.sm.stopKeepingAgent(h.host.id, { endTerminals: true, force: false }),
		).toMatchObject({
			kind: "done",
			response: { outcome: "stopped", ended: 2, host: { sshRemoteDaemon: false } },
		});
		expect(h.remote.stops).toEqual([false]);
		for (const id of ids)
			expect(h.ctx.metaDal.getChannel(id)).toMatchObject({ status: "dead", endReason: "stopped" });
		expect(sessionStates(h).at(-1)).toMatchObject({ status: "closed" });
		expect(h.ctx.metaDal.getHost(h.host.id)?.sshRemoteDaemon).toBe(false);
	});
});

// ─── A stop counts only once the daemon says it took it (#700) ───────────────

describe("STOP_ACCEPTED over a remote daemon (#700)", { timeout: 20_000 }, () => {
	it("Replace reads a link that drops after STOP, with no STOP_ACCEPTED, as not confirmed", async () => {
		const h = await hubWith({ daemon: true });
		h.remote.acknowledgesStop = true;
		h.remote.dropsOnStop = true;
		await connected(h);
		const ids = terminalsOn(h, 1);
		expect(await h.sm.replaceAgent(h.host.id, { force: true })).toEqual({
			replaced: false,
			message: "The connection ended without confirming the agent stopped.",
		});
		expect(h.remote.stops).toEqual([true]);
		for (const id of ids) {
			expect(endsOf(h, id)).toEqual([]);
			expect(h.ctx.metaDal.getChannel(id)?.endReason).toBeUndefined();
		}
	});

	it("stop-keeping reads it so too, and leaves the agent possibly running", async () => {
		const h = await hubWith({ daemon: true });
		h.remote.acknowledgesStop = true;
		h.remote.dropsOnStop = true;
		await connected(h);
		expect(
			await h.sm.stopKeepingAgent(h.host.id, { endTerminals: true, force: true }),
		).toMatchObject({ kind: "done", response: { outcome: "disabled_not_stopped" } });
	});

	it("stop-keeping reads the close after STOP_ACCEPTED as the stop", async () => {
		const h = await hubWith({ daemon: true });
		h.remote.acknowledgesStop = true;
		await connected(h);
		expect(
			await h.sm.stopKeepingAgent(h.host.id, { endTerminals: true, force: false }),
		).toMatchObject({ kind: "done", response: { outcome: "stopped" } });
	});
});

// ─── Keep the agent left here and connect (#701) ────────────────────────────

/** A host stored No whose daemon a hub left running, with the OS known. */
async function leftOn(
	options: { os?: "linux" | "darwin" | "windows" | null; stored?: boolean | null } = {},
): Promise<Harness> {
	return hubWith({
		daemon: true,
		stored: options.stored === undefined ? false : options.stored,
		os: options.os === undefined ? "linux" : options.os,
	});
}

/** The menu's "Keep the agent left here and connect". */
function keepAndConnect(h: Harness, onHostStored?: () => void) {
	return h.sm.connectHost(h.host.id, {
		clientId: h.window.id,
		daemonOnly: true,
		...(onHostStored !== undefined && { onHostStored }),
	});
}

async function keptAndConnected(h: Harness): Promise<boolean> {
	const outcome = keepAndConnect(h);
	if (outcome.kind !== "connecting") throw new Error(`not connecting: ${outcome.kind}`);
	return outcome.done;
}

function errorsHeard(h: Harness): Array<{ code?: string; message?: string; hostId?: string }> {
	return h.heard
		.filter((m) => m.type === "ERROR")
		.map((m) => m as { code?: string; message?: string; hostId?: string });
}

/** Commands that would deploy, launch a daemon or run the agent on stdio. */
function startingCommands(h: Harness): string[] {
	return h.remote.execs.filter((c) => c.includes("--daemon") || c.includes("--stdio"));
}

const deployMock = vi.mocked(deployAgentIfNeeded);

describe("Keep the agent left here and connect (#701)", { timeout: 20_000 }, () => {
	it("controls: a plain connect deploys, and on a Yes host with no daemon launches one", async () => {
		const h = await hubWith({ daemon: true, os: "linux" });
		h.remote.daemonSocket = "silent";
		const before = deployMock.mock.calls.length;
		await connected(h);
		expect(deployMock.mock.calls.length).toBeGreaterThan(before);
		expect(h.remote.execs.some((c) => c.includes("--daemon"))).toBe(true);
	});

	it("says no agent runs where nothing listens, and starts, deploys and stores nothing", async () => {
		const h = await leftOn();
		h.remote.daemonSocket = "silent";
		const before = deployMock.mock.calls.length;
		expect(await keptAndConnected(h)).toBe(false);
		expect(errorsHeard(h)).toContainEqual(
			expect.objectContaining({
				code: "NO_AGENT_RUNNING",
				message: "No Lasterm agent is running on this host.",
			}),
		);
		expect(deployMock.mock.calls.length).toBe(before);
		expect(startingCommands(h)).toEqual([]);
		expect(h.ctx.metaDal.getHost(h.host.id)?.sshRemoteDaemon).toBe(false);
	});

	it("relays only through an agent it can verify, and runs nothing it cannot (#755)", async () => {
		const h = await leftOn();
		h.ctx.metaDal.updateHostOsArch(h.host.id, "linux", "x64");
		h.remote.daemonSocket = "refusing";
		const before = deployMock.mock.calls.length;
		expect(await keptAndConnected(h)).toBe(false);
		expect(errorsHeard(h)).toContainEqual(
			expect.objectContaining({
				code: "DAEMON_UNREACHABLE",
				message:
					"Lasterm could not reach an agent on this host: its relay failed: no Lasterm agent was found on this host.",
			}),
		);
		expect(startingCommands(h)).toEqual([]);
		// Never the bare `lasterm-agent` of PATH (#43).
		expect(h.remote.execs.filter((c) => c.includes("--attach"))).toEqual([]);
		expect(deployMock.mock.calls.length).toBe(before);
		expect(h.ctx.metaDal.getHost(h.host.id)?.sshRemoteDaemon).toBe(false);
	});

	it("says it cannot tell when the host cannot say what listens", async () => {
		const h = await leftOn();
		h.remote.daemonSocket = "unknown";
		expect(await keptAndConnected(h)).toBe(false);
		expect(errorsHeard(h)).toContainEqual(expect.objectContaining({ code: "DAEMON_UNREACHABLE" }));
		expect(startingCommands(h)).toEqual([]);
	});

	it("reaches a daemon on the retry a listening socket earns", async () => {
		const h = await leftOn();
		h.remote.rejectsOpens = 1;
		expect(await keptAndConnected(h)).toBe(true);
		expect(errorsHeard(h)).toEqual([]);
	});

	it("takes up what the daemon holds, stores Yes and says so, then stops it with today's consent", async () => {
		const h = await leftOn();
		h.remote.held = [];
		const stored = vi.fn();
		const before = deployMock.mock.calls.length;
		const outcome = keepAndConnect(h, stored);
		if (outcome.kind !== "connecting") throw new Error(outcome.kind);
		expect(await outcome.done).toBe(true);
		expect(agentOf(h)?.usedRemoteDaemon).toBe(true);
		expect(deployMock.mock.calls.length).toBe(before);
		expect(startingCommands(h)).toEqual([]);
		expect(h.ctx.metaDal.getHost(h.host.id)?.sshRemoteDaemon).toBe(true);
		expect(stored).toHaveBeenCalledOnce();
		terminalsOn(h, 1);
		expect(
			await h.sm.stopKeepingAgent(h.host.id, { endTerminals: false, force: false }),
		).toMatchObject({ code: "TERMINALS_WOULD_END", terminals: 1 });
		expect(
			await h.sm.stopKeepingAgent(h.host.id, { endTerminals: true, force: false }),
		).toMatchObject({
			kind: "done",
			response: { outcome: "stopped", host: { sshRemoteDaemon: false } },
		});
	});

	it("takes up the terminals this hub records there, and destroys what it has no record of", async () => {
		const h = await leftOn();
		expect(await keptAndConnected(h)).toBe(true);
		const [recorded] = terminalsOn(h, 1);
		if (recorded === undefined) throw new Error("no terminal");
		h.sm.disconnectHost(h.host.id, { force: true });
		await until("disconnected", () => agentOf(h) === undefined);
		const unknown = generateId();
		h.remote.held = [recorded, unknown];
		expect(await keptAndConnected(h)).toBe(true);
		expect(h.ctx.channels.get(recorded)?.status).not.toBe("dead");
		await until("the unknown terminal is destroyed", () => h.remote.destroys.includes(unknown));
		expect(h.remote.destroys).not.toContain(recorded);
	});

	it.each([
		["No", false],
		["no answer", null],
	] as const)(
		"keeps a refusal its relay proved once Yes is stored, from %s (#755)",
		async (_what, stored) => {
			const h = await leftOn({ stored });
			h.ctx.metaDal.updateHostOsArch(h.host.id, "linux", "x64");
			h.remote.daemonSocket = "refusing";
			h.remote.installedAgentSha = "c".repeat(64);
			h.ctx.metaDal.updateHostAgentSha256(h.host.id, "c".repeat(64));

			expect(await keptAndConnected(h)).toBe(true);

			expect(agentOf(h)?.reachedThrough).toBe("relay");
			expect(h.remote.execs.filter((c) => c.includes("--attach"))).toEqual([
				expect.stringMatching(/^\/usr\/local\/bin\/lasterm-agent --attach /),
			]);
			const now = h.ctx.metaDal.getHost(h.host.id);
			expect(now?.sshRemoteDaemon).toBe(true);
			expect(socketForwardingRefusedOn(now, false, h.ctx.socketForwardingRefusals)).toBe(true);
			await until("the refusal is announced", () =>
				sessionStates(h).some(
					(s) => (s as { socketForwardingRefused?: boolean }).socketForwardingRefused === true,
				),
			);
		},
	);

	describe("an agent the relay cannot run (#755)", () => {
		const pinned = "c".repeat(64);

		async function refusedWith(
			setup: (h: Harness) => void,
		): Promise<{ h: Harness; message: string }> {
			const h = await leftOn();
			h.ctx.metaDal.updateHostOsArch(h.host.id, "linux", "x64");
			h.remote.daemonSocket = "refusing";
			setup(h);
			expect(await keptAndConnected(h)).toBe(false);
			const error = errorsHeard(h).find((e) => e.code === "DAEMON_UNREACHABLE");
			expect(startingCommands(h)).toEqual([]);
			return { h, message: error?.message ?? "" };
		}

		it("says an agent older than the relay cannot be fixed by Connect when this hub has no copy", async () => {
			const { message } = await refusedWith((h) => {
				h.remote.installedAgentSha = pinned;
				h.remote.relayPredates = true;
				h.ctx.metaDal.updateHostAgentSha256(h.host.id, pinned);
			});
			expect(message).toBe(
				"Lasterm could not reach an agent on this host: its relay failed: the agent on this host predates the relay; this hub has no copy of its own agent to install.",
			);
		});

		it("says Connect installs this hub's agent when it has a copy of its own", async () => {
			const cached = join(getBinaryCacheDir(), `lasterm-agent-linux-x64-${HUB_VERSION}`);
			mkdirSync(getBinaryCacheDir(), { recursive: true });
			writeFileSync(cached, "this hub's own agent");
			try {
				const sha = createHash("sha256").update("this hub's own agent").digest("hex");
				const { message } = await refusedWith((h) => {
					h.remote.installedAgentSha = sha;
					h.remote.relayPredates = true;
				});
				expect(message).toBe(
					"Lasterm could not reach an agent on this host: its relay failed: the agent on this host predates the relay; Connect installs this hub's.",
				);
			} finally {
				rmSync(cached, { force: true });
			}
		});

		it("relays through an agent trusted this session, with no pin and no copy of its own", async () => {
			const h = await leftOn();
			h.ctx.metaDal.updateHostOsArch(h.host.id, "linux", "x64");
			h.remote.daemonSocket = "refusing";
			h.remote.installedAgentSha = pinned;
			h.ctx.trustedAgentSha256.set(h.host.id, pinned);
			expect(await keptAndConnected(h)).toBe(true);
			expect(h.remote.execs.filter((c) => c.includes("--attach"))).toEqual([
				expect.stringMatching(/^\/usr\/local\/bin\/lasterm-agent --attach /),
			]);
		});

		it("finds the agent off PATH where the deploy installs it", async () => {
			const h = await leftOn();
			h.ctx.metaDal.updateHostOsArch(h.host.id, "linux", "x64");
			h.remote.daemonSocket = "refusing";
			h.remote.installedAgentSha = pinned;
			h.remote.installedOffPath = true;
			h.ctx.metaDal.updateHostAgentSha256(h.host.id, pinned);
			expect(await keptAndConnected(h)).toBe(true);
			expect(h.remote.execs.filter((c) => c.includes("--attach"))).toEqual([
				expect.stringMatching(/^\/home\/pi\/\.local\/bin\/lasterm-agent --attach /),
			]);
		});

		it("with a copy of its own, refuses a file that matches only the pin", async () => {
			const cached = join(getBinaryCacheDir(), `lasterm-agent-linux-x64-${HUB_VERSION}`);
			mkdirSync(getBinaryCacheDir(), { recursive: true });
			writeFileSync(cached, "this hub's own agent");
			try {
				const { h, message } = await refusedWith((h) => {
					h.remote.installedAgentSha = pinned;
					h.ctx.metaDal.updateHostAgentSha256(h.host.id, pinned);
				});
				expect(message).toMatch(/not one this hub can vouch for .*Connect installs this hub's/);
				expect(h.remote.execs.filter((c) => c.includes("--attach"))).toEqual([]);
			} finally {
				rmSync(cached, { force: true });
			}
		});

		it("says the hash could not be read for an agent it found", async () => {
			const { h, message } = await refusedWith((h) => {
				h.remote.installedAgentSha = pinned;
				h.remote.installedHashUnreadable = true;
				h.ctx.metaDal.updateHostAgentSha256(h.host.id, pinned);
			});
			expect(message).toMatch(/could not be checked: its hash could not be read/);
			expect(h.remote.execs.filter((c) => c.includes("--attach"))).toEqual([]);
		});

		it("runs nothing whose hash matches neither this hub's agent nor the pin", async () => {
			const { h, message } = await refusedWith((h) => {
				h.remote.installedAgentSha = "d".repeat(64);
				h.ctx.metaDal.updateHostAgentSha256(h.host.id, pinned);
			});
			expect(message).toMatch(/could not be checked: this hub has no copy of its own agent/);
			expect(h.remote.execs.filter((c) => c.includes("--attach"))).toEqual([]);
		});
	});

	it("forgets an earlier forwarding refusal once the socket answered", async () => {
		const h = await leftOn();
		h.ctx.socketForwardingRefusals.set(h.host.id, "seen refused");
		expect(await keptAndConnected(h)).toBe(true);
		expect(h.ctx.socketForwardingRefusals.has(h.host.id)).toBe(false);
	});

	it("is then a Yes host: a dropped link is dialled again through the daemon, not stdio", async () => {
		const h = await leftOn();
		expect(await keptAndConnected(h)).toBe(true);
		const [held] = terminalsOn(h, 1);
		const opens = h.remote.socketOpens;
		h.remote.dropLinks();
		await until(
			"the reconnect reaches the daemon again",
			() => h.remote.socketOpens > opens,
			15_000,
		);
		expect(startingCommands(h).filter((c) => c.includes("--stdio"))).toEqual([]);
		// Taken up again, not started afresh.
		await until("the terminal is taken up again", () => agentOf(h) !== undefined);
		expect(h.remote.spawns).toBe(0);
		expect(h.ctx.channels.get(held ?? "")?.status).not.toBe("dead");
	});

	it("refuses a host connected over stdio", async () => {
		// Connected on stdio, as a No host is.
		const stdio = await hubWith({ daemon: false, os: "linux", stored: false });
		await connected(stdio);
		expect(keepAndConnect(stdio).kind).toBe("no-daemon-connection");
	});

	it("never joins another connect", async () => {
		const h = await hubWith({ daemon: true, os: "linux", stored: true, pinned: false });
		// The plain connect waits on a question nobody answers yet.
		let verify: HostVerifyMessage | undefined;
		h.window.send = (msg) => {
			h.heard.push(msg);
			if (msg.type === "HOST_VERIFY") verify = msg as HostVerifyMessage;
		};
		const plain = h.sm.connectHost(h.host.id, { clientId: h.window.id });
		await until("the plain connect asks about the key", () => verify !== undefined);
		const before = deployMock.mock.calls.length;
		expect(keepAndConnect(h).kind).toBe("connecting-already");
		expect(deployMock.mock.calls.length).toBe(before);
		if (verify !== undefined) h.sm.handleHostVerifyResponse(verify.promptId, "reject", h.window.id);
		if (plain.kind === "connecting") await plain.done;
	});

	it("answers connected, storing nothing, when the daemon is already the way there", async () => {
		const h = await hubWith({ daemon: true, os: "linux" });
		await connected(h);
		h.ctx.metaDal.updateHost(h.host.id, { sshRemoteDaemon: null });
		const connections = h.remote.connections;
		const write = vi.spyOn(h.ctx.metaDal, "updateHost");
		expect(keepAndConnect(h).kind).toBe("connected");
		expect(h.remote.connections).toBe(connections);
		expect(write).not.toHaveBeenCalled();
		expect(h.ctx.metaDal.getHost(h.host.id)?.sshRemoteDaemon ?? null).toBeNull();
	});

	it("stores nothing when the daemon refuses this hub", async () => {
		const h = await leftOn();
		h.remote.refusesAuth = true;
		expect(await keptAndConnected(h)).toBe(false);
		expect(errorsHeard(h)).toContainEqual(
			expect.objectContaining({
				code: "AGENT_REFUSED_HUB",
				message: expect.stringMatching(/^The agent on this host refused this hub\./),
			}),
		);
		expect(h.ctx.metaDal.getHost(h.host.id)?.sshRemoteDaemon).toBe(false);
	});

	it("stores nothing and takes up nothing when the daemon never lists", async () => {
		const h = await leftOn();
		h.remote.neverLists = true;
		expect(await keptAndConnected(h)).toBe(false);
		// This attempt's own connection was closed (close() marks it the hub's doing).
		expect([...SshAgentsSeen].at(-1)?.closedByHub).toBe(true);
		expect(errorsHeard(h)).toContainEqual(expect.objectContaining({ code: "DAEMON_UNREACHABLE" }));
		expect(h.ctx.metaDal.getHost(h.host.id)?.sshRemoteDaemon).toBe(false);
		expect(agentOf(h)).toBeUndefined();
	});

	it("closes and takes up nothing when the setting cannot be saved", async () => {
		const h = await leftOn();
		const update = h.ctx.metaDal.updateHost.bind(h.ctx.metaDal);
		vi.spyOn(h.ctx.metaDal, "updateHost").mockImplementation((id, input) => {
			if (input.sshRemoteDaemon === true) throw new Error("disk full");
			return update(id, input);
		});
		h.remote.held = [generateId()];
		expect(await keptAndConnected(h)).toBe(false);
		// This attempt's own connection was closed (close() marks it the hub's doing).
		expect([...SshAgentsSeen].at(-1)?.closedByHub).toBe(true);
		expect(h.remote.destroys).toEqual([]);
		expect(errorsHeard(h)).toContainEqual(expect.objectContaining({ code: "INTERNAL_ERROR" }));
		expect(agentOf(h)).toBeUndefined();
	});

	it("is nobody's until stored: a second connect is busy, and an open waits, then fails with it", async () => {
		const h = await leftOn();
		h.remote.holdsList = true;
		h.remote.held = [generateId()];
		const outcome = keepAndConnect(h);
		if (outcome.kind !== "connecting") throw new Error(outcome.kind);
		await until("the daemon is asked for its list", () => h.remote.listStream !== null);
		expect(sessionStates(h).some((state) => state.status === "active")).toBe(false);
		expect(h.sm.connectHost(h.host.id, { clientId: h.window.id }).kind).toBe("connecting-already");
		const opening = h.sm.handleSpawn(h.window.id, { type: "SPAWN", hostId: h.host.id });
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(h.remote.spawns).toBe(0);
		// Moved meanwhile: the attempt fails, and so does the open.
		h.ctx.metaDal.updateHost(h.host.id, { sshHost: "127.0.0.2" });
		h.remote.releaseList();
		expect(await outcome.done).toBe(false);
		expect(await opening).toBeNull();
		expect(h.remote.spawns).toBe(0);
		expect(errorsHeard(h)).toContainEqual(expect.objectContaining({ code: "HOST_CHANGED" }));
		expect(h.ctx.metaDal.getHost(h.host.id)?.sshRemoteDaemon).toBe(false);
		// This attempt's own connection was closed (close() marks it the hub's doing).
		expect([...SshAgentsSeen].at(-1)?.closedByHub).toBe(true);
		expect(h.remote.destroys).toEqual([]);
	});

	it.each(["close", "disconnect"] as const)(
		"writes nothing for a connection that went (%s) before its list arrived",
		async (how) => {
			const h = await leftOn();
			h.remote.holdsList = true;
			h.remote.held = [generateId()];
			const outcome = keepAndConnect(h);
			if (outcome.kind !== "connecting") throw new Error(outcome.kind);
			await until("the daemon is asked for its list", () => h.remote.listStream !== null);
			if (how === "disconnect") {
				h.sm.disconnectHost(h.host.id, { force: true });
			} else {
				const agent = [...SshAgentsSeen].at(-1);
				if (agent === undefined) throw new Error("no agent");
				Object.defineProperty(agent, "connected", { value: false, configurable: true });
			}
			h.remote.releaseList();
			expect(await outcome.done).toBe(false);
			expect(h.ctx.metaDal.getHost(h.host.id)?.sshRemoteDaemon).toBe(false);
			expect(sessionStates(h).some((state) => state.status === "active")).toBe(false);
			// Ended as an aborted attempt is, with nothing to tell anyone.
			if (how === "disconnect") expect(errorsHeard(h)).toEqual([]);
			// This attempt's own connection was closed (close() marks it the hub's doing).
			expect([...SshAgentsSeen].at(-1)?.closedByHub).toBe(true);
			expect(h.remote.destroys).toEqual([]);
		},
	);

	it("lets a label change pass while connecting", async () => {
		const h = await leftOn();
		h.remote.holdsList = true;
		const outcome = keepAndConnect(h);
		if (outcome.kind !== "connecting") throw new Error(outcome.kind);
		await until("the daemon is asked for its list", () => h.remote.listStream !== null);
		h.ctx.metaDal.updateHost(h.host.id, { label: "renamed" });
		h.remote.releaseList();
		expect(await outcome.done).toBe(true);
	});

	// #755 AC-W4: a Windows host is reached through the relay; only a system
	// nobody detected yet is refused. Mutation: today's Linux-or-macOS guard.
	it("refuses a host whose system is not known yet", async () => {
		const h = await leftOn({ os: null });
		expect(keepAndConnect(h).kind).toBe("daemon-not-possible");
		expect(h.remote.connections).toBe(0);
	});

	it("tries a Windows host, through the relay", async () => {
		const h = await leftOn({ os: "windows" });
		const outcome = keepAndConnect(h);
		expect(outcome.kind).toBe("connecting");
		if (outcome.kind === "connecting") await outcome.done;
		expect(h.remote.connections).toBe(1);
	});

	it("has no binary path for --stop: a forced stop it cannot send is not confirmed", async () => {
		const h = await leftOn();
		expect(await keptAndConnected(h)).toBe(true);
		const agent = agentOf(h);
		if (agent === undefined) throw new Error("no agent");
		const send = agent.send.bind(agent);
		vi.spyOn(agent, "send").mockImplementation((msg) => {
			if (msg.type === "STOP") throw new Error("socket gone");
			send(msg);
		});
		expect(
			await h.sm.stopKeepingAgent(h.host.id, { endTerminals: true, force: true }),
		).toMatchObject({ kind: "done", response: { outcome: "disabled_not_stopped" } });
		expect(h.remote.execs.filter((c) => c.includes("--stop"))).toEqual([]);
	});

	it("keeps to the daemon on the retry a first-seen host key causes", async () => {
		const h = await hubWith({ daemon: true, pinned: false, stored: false, os: "linux" });
		h.window.send = (msg) => {
			h.heard.push(msg);
			if (msg.type === "HOST_VERIFY") {
				queueMicrotask(() =>
					h.sm.handleHostVerifyResponse(
						(msg as HostVerifyMessage).promptId,
						"trust_permanent",
						h.window.id,
					),
				);
			}
		};
		h.remote.daemonSocket = "silent";
		const before = deployMock.mock.calls.length;
		expect(await keptAndConnected(h)).toBe(false);
		expect(h.heard.filter((m) => m.type === "HOST_VERIFY")).toHaveLength(1);
		expect(errorsHeard(h)).toContainEqual(expect.objectContaining({ code: "NO_AGENT_RUNNING" }));
		expect(deployMock.mock.calls.length).toBe(before);
		expect(startingCommands(h)).toEqual([]);
	});
});

// ─── What a daemon's own list forbids a stop (#701) ─────────────────────────

/** A second host record of the same hub, reaching the same daemon. */
function secondRecord(h: Harness): Host {
	const b = h.ctx.metaDal.createHost({
		type: "ssh",
		label: "pi-again",
		sshHost: "127.0.0.1",
		sshPort: h.remote.port,
		sshAuth: "key",
		sshKeyPath: CLIENT_KEY_PATH,
		sshRemoteDaemon: true,
		os: "linux",
	});
	h.ctx.metaDal.updateHostFingerprint(
		b.id,
		HOST_FINGERPRINT,
		targetRoute(b, (id) => sshAddress(h.ctx.metaDal.getHost(id))),
	);
	return b;
}

/** A terminal this hub tracks as ended, which the daemon still holds. */
function shownEndedOn(h: Harness): string {
	const session = h.ctx.sessions.get(h.host.id);
	if (session === undefined) throw new Error("no session");
	const id = generateId();
	h.ctx.metaDal.createChannel({ id, sessionId: session.id, status: "dead", shell: "bash" });
	h.ctx.channels.set(id, {
		sessionId: session.id,
		hostId: h.host.id,
		status: "dead",
		clients: new Set(),
		shell: "bash",
		cols: 80,
		rows: 24,
		dynamicTitle: null,
		processTitle: null,
		displayTitle: "bash",
	});
	return id;
}

/** Reconnect the host so that its daemon lists again. */
async function relisted(h: Harness): Promise<void> {
	const outcome = h.sm.reconnectHost(h.host.id, { force: true, clientId: h.window.id });
	if (outcome.kind !== "connecting") throw new Error(`not reconnecting: ${outcome.kind}`);
	await expect(outcome.done).resolves.toBe(true);
}

describe("A daemon's own list and the stops (#701)", { timeout: 25_000 }, () => {
	it("refuses to stop, from another record, a daemon holding a record's live terminal", async () => {
		const h = await hubWith({ daemon: true, os: "linux" });
		await connected(h);
		const [a] = terminalsOn(h, 1);
		const b = secondRecord(h);
		const outcome = h.sm.connectHost(b.id, { clientId: h.window.id });
		if (outcome.kind !== "connecting") throw new Error(outcome.kind);
		await expect(outcome.done).resolves.toBe(true);
		expect(h.remote.held).toContain(a);
		const stopsBefore = h.remote.stops.length;
		const message = "Terminals of pi run on this agent. Stop it from that host, or end them first.";
		expect(await h.sm.stopKeepingAgent(b.id, { endTerminals: true, force: true })).toMatchObject({
			code: "OTHER_HOST_TERMINALS",
			message,
		});
		expect(await h.sm.replaceAgent(b.id, { force: true })).toMatchObject({
			replaced: false,
			code: "OTHER_HOST_TERMINALS",
			message,
		});
		expect(h.remote.stops.length).toBe(stopsBefore);
	});

	it("does not retire an older daemon holding another record's terminal", async () => {
		const h = await hubWith({ daemon: true, os: "linux" });
		await connected(h);
		terminalsOn(h, 1);
		// What B meets is older than this hub; it holds nothing B tracks.
		h.remote.agentVersion = "0.0.1";
		const b = secondRecord(h);
		const outcome = h.sm.connectHost(b.id, { clientId: h.window.id });
		if (outcome.kind !== "connecting") throw new Error(outcome.kind);
		await outcome.done;
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(h.remote.stops).toEqual([]);
	});

	it("does not retire an older daemon before its list is complete", async () => {
		const h = await hubWith({ daemon: true, os: "linux" });
		h.remote.agentVersion = "0.0.1";
		h.remote.holdsList = true;
		const outcome = h.sm.connectHost(h.host.id, { clientId: h.window.id });
		await until("the daemon is asked for its list", () => h.remote.listStream !== null);
		h.remote.listStream?.write(
			Buffer.from(encodeFrame({ type: "CHANNEL_EXIT", channelId: generateId(), exitCode: 0 })),
		);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(h.remote.stops).toEqual([]);
		h.remote.releaseList();
		if (outcome.kind === "connecting") await outcome.done;
	});

	it("decides no stop on a list that never came", async () => {
		const h = await hubWith({ daemon: true, os: "linux" });
		h.remote.agentVersion = "0.0.1";
		h.remote.neverLists = true;
		await connected(h);
		expect(
			await h.sm.stopKeepingAgent(h.host.id, { endTerminals: true, force: true }),
		).toMatchObject({ code: "AGENT_INVENTORY_UNKNOWN" });
		expect(await h.sm.replaceAgent(h.host.id, { force: true })).toMatchObject({
			code: "AGENT_INVENTORY_UNKNOWN",
		});
		// A terminal of it ends: the retirement weighs it again, and still stops nothing.
		h.remote.listStream?.write(
			Buffer.from(encodeFrame({ type: "CHANNEL_EXIT", channelId: generateId(), exitCode: 0 })),
		);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(h.remote.stops).toEqual([]);
	});

	it("counts terminals shown as ended that the daemon holds, refuses Replace, and keeps an older daemon", async () => {
		const h = await hubWith({ daemon: true, os: "linux" });
		await connected(h);
		const live = terminalsOn(h, 1);
		const ended = shownEndedOn(h);
		h.remote.held = [...live, ended];
		h.remote.agentVersion = "0.0.1";
		await relisted(h);
		expect(
			await h.sm.stopKeepingAgent(h.host.id, { endTerminals: false, force: false }),
		).toMatchObject({ code: "TERMINALS_WOULD_END", terminals: 2 });
		expect(await h.sm.replaceAgent(h.host.id, { force: true })).toMatchObject({
			code: "TERMINALS_SHOWN_ENDED",
		});
		expect(h.remote.stops).toEqual([]);
	});

	it("counts it no more once it exits, and an older daemon then holding nothing is retired", async () => {
		const h = await hubWith({ daemon: true, os: "linux" });
		await connected(h);
		const ended = shownEndedOn(h);
		h.remote.held = [ended];
		h.remote.holdsList = true;
		await Promise.all([
			relisted(h),
			(async () => {
				await until("listed", () => h.remote.listStream !== null);
				h.remote.releaseList();
			})(),
		]);
		expect(
			await h.sm.stopKeepingAgent(h.host.id, { endTerminals: false, force: false }),
		).toMatchObject({ code: "TERMINALS_WOULD_END", terminals: 1 });
		h.remote.agentVersion = "0.0.1";
		const agent = agentOf(h);
		if (agent === undefined) throw new Error("no agent");
		agent.helloMessage = { ...(agent.helloMessage as HelloMessage), agentVersion: "0.0.1" };
		h.remote.listStream?.write(
			Buffer.from(encodeFrame({ type: "CHANNEL_EXIT", channelId: ended, exitCode: 0 })),
		);
		await until("the older daemon, holding nothing, is retired", () => h.remote.stops.length > 0);
	});

	it("retires an older daemon that held only what its adoption destroyed", async () => {
		const h = await hubWith({ daemon: true, os: "linux" });
		h.remote.agentVersion = "0.0.1";
		h.remote.held = [generateId()];
		await connected(h);
		await until("the older daemon is retired", () => h.remote.stops.length > 0);
	});

	it("keeps an exit that came before a stale state out of the list", async () => {
		const h = await hubWith({ daemon: true, os: "linux" });
		await connected(h);
		const ended = shownEndedOn(h);
		h.remote.held = [ended];
		h.remote.holdsList = true;
		await Promise.all([
			relisted(h),
			(async () => {
				await until("listed", () => h.remote.listStream !== null);
				h.remote.listStream?.write(
					Buffer.from(encodeFrame({ type: "CHANNEL_EXIT", channelId: ended, exitCode: 0 })),
				);
				h.remote.releaseList();
			})(),
		]);
		expect(
			await h.sm.stopKeepingAgent(h.host.id, { endTerminals: false, force: false }),
		).toMatchObject({ kind: "done" });
	});

	it("waits for a terminal that is starting before a stop, and counts it then", async () => {
		const h = await hubWith({ daemon: true, os: "linux" });
		await connected(h);
		h.remote.holdsSpawn = true;
		const opening = h.sm.handleSpawn(h.window.id, { type: "SPAWN", hostId: h.host.id });
		await until("the SPAWN is written", () => h.remote.spawns === 1);
		expect(
			await h.sm.stopKeepingAgent(h.host.id, { endTerminals: true, force: true }),
		).toMatchObject({ code: "HOST_BUSY" });
		expect(h.remote.stops).toEqual([]);
		h.remote.releaseSpawn();
		const channelId = await opening;
		expect(channelId).not.toBeNull();
		h.remote.holdsSpawn = false;
		const stillHeld = agentOf(h)?.daemonInventory;
		if (channelId) stillHeld?.listed.add(channelId);
		expect(
			await h.sm.stopKeepingAgent(h.host.id, { endTerminals: false, force: false }),
		).toMatchObject({ code: "TERMINALS_WOULD_END", terminals: 1 });
	});

	it("waits for a Restart's replacement too", async () => {
		const h = await hubWith({ daemon: true, os: "linux" });
		await connected(h);
		const [id] = terminalsOn(h, 1);
		if (id === undefined) throw new Error("no terminal");
		h.remote.holdsSpawn = true;
		const restarting = h.sm.restartChannel(id, h.window.id);
		await until("the replacement SPAWN is written", () => h.remote.spawns === 1);
		expect(
			await h.sm.stopKeepingAgent(h.host.id, { endTerminals: true, force: true }),
		).toMatchObject({ code: "HOST_BUSY" });
		expect(h.remote.stops).toEqual([]);
		h.remote.releaseSpawn();
		await restarting;
	});
});

describe("A daemon's own list, as it changes (#701)", { timeout: 30_000 }, () => {
	it("keeps an older daemon holding only a terminal shown as ended", async () => {
		const h = await hubWith({ daemon: true, os: "linux" });
		await connected(h);
		const ended = shownEndedOn(h);
		h.remote.held = [ended];
		h.remote.agentVersion = "0.0.1";
		await relisted(h);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(h.remote.stops).toEqual([]);
	});

	it("counts a terminal shown as ended no more once it exits", async () => {
		const h = await hubWith({ daemon: true, os: "linux" });
		await connected(h);
		const live = terminalsOn(h, 1);
		const ended = shownEndedOn(h);
		h.remote.held = [...live, ended];
		h.remote.holdsList = true;
		await Promise.all([
			relisted(h),
			(async () => {
				await until("listed", () => h.remote.listStream !== null);
				h.remote.releaseList();
			})(),
		]);
		expect(
			await h.sm.stopKeepingAgent(h.host.id, { endTerminals: false, force: false }),
		).toMatchObject({ code: "TERMINALS_WOULD_END", terminals: 2 });
		h.remote.listStream?.write(
			Buffer.from(encodeFrame({ type: "CHANNEL_EXIT", channelId: ended, exitCode: 0 })),
		);
		await until("the exit is heard", () => !agentOf(h)?.daemonInventory?.listed.has(ended));
		expect(
			await h.sm.stopKeepingAgent(h.host.id, { endTerminals: false, force: false }),
		).toMatchObject({ code: "TERMINALS_WOULD_END", terminals: 1 });
	});

	it("loses no exit that comes in the same frames as the end of the list", async () => {
		const h = await hubWith({ daemon: true, os: "linux" });
		await connected(h);
		const ended = shownEndedOn(h);
		h.remote.held = [];
		h.remote.holdsList = true;
		await Promise.all([
			relisted(h),
			(async () => {
				await until("listed", () => h.remote.listStream !== null);
				// One write: the state, the end of the list, then the exit.
				h.remote.listStream?.write(
					Buffer.concat([
						Buffer.from(
							encodeFrame({
								type: "AGENT_CHANNEL_STATE",
								channelId: ended,
								title: "bash",
								pid: 4242,
								alive: true,
							}),
						),
						Buffer.from(encodeFrame({ type: "CHANNEL_STATE_END", otherOwnerChannels: 0 })),
						Buffer.from(encodeFrame({ type: "CHANNEL_EXIT", channelId: ended, exitCode: 0 })),
					]),
				);
			})(),
		]);
		expect(agentOf(h)?.daemonInventory?.listed.has(ended)).toBe(false);
		expect(await h.sm.replaceAgent(h.host.id, { force: true })).not.toMatchObject({
			code: "TERMINALS_SHOWN_ENDED",
		});
	});

	it("decides no stop on a daemon a SPAWN went unanswered on", async () => {
		const h = await hubWith({ daemon: true, os: "linux" });
		await connected(h);
		h.remote.holdsSpawn = true;
		const opening = h.sm.handleSpawn(h.window.id, { type: "SPAWN", hostId: h.host.id });
		expect(await opening.catch(() => null)).toBeNull();
		expect(
			await h.sm.stopKeepingAgent(h.host.id, { endTerminals: true, force: true }),
		).toMatchObject({ code: "AGENT_INVENTORY_UNKNOWN" });
		expect(h.remote.stops).toEqual([]);
	});
});

describe("Keep the agent left here and connect, failing after Yes (#701)", {
	timeout: 20_000,
}, () => {
	it("puts the setting back and closes when taking the terminals up fails", async () => {
		const h = await leftOn();
		const announced = vi.fn();
		vi.spyOn(h.ctx.commits, "adoptAgent").mockImplementationOnce(() => {
			throw new Error("disk full");
		});
		const outcome = keepAndConnect(h, announced);
		if (outcome.kind !== "connecting") throw new Error(outcome.kind);
		expect(await outcome.done).toBe(false);
		expect(h.ctx.metaDal.getHost(h.host.id)?.sshRemoteDaemon).toBe(false);
		expect(announced).toHaveBeenCalledTimes(2);
		expect([...SshAgentsSeen].at(-1)?.closedByHub).toBe(true);
		expect(agentOf(h)).toBeUndefined();
	});
});
