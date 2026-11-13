/**
 * Key auth signed by the SSH agent that holds the configured key (#876).
 *
 * Everything here is made for the test: keys generated into a temporary
 * directory, an SSH server that takes one key's verified signature and nothing
 * else, and a fake agent listening on a socket (a named pipe on Windows) that
 * `SSH_AUTH_SOCK` points at. The developer's own agent and `~/.ssh` are never
 * reached: the setup file points `SSH_AUTH_SOCK` at nothing, and the one test
 * that reads a `~/.ssh/config` gives the hub a home of its own.
 */
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import {
	connect as connectTcp,
	createServer,
	type Server as NetServer,
	type Socket,
} from "node:net";
import { join } from "node:path";
import type { HelloMessage, Host, TestConnectMessage } from "@lasterm/shared";
import { encodeFrame } from "@lasterm/shared";
import {
	AgentProtocol,
	BaseAgent,
	type IdentityCallback,
	type ParsedKey,
	type SignCallback,
	Server as SshServer,
	utils,
} from "ssh2";
import { afterAll, afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { fingerprintOf } from "../ssh/fingerprint.js";
import { generateEd25519KeyPair } from "../ssh/ssh2-key.fixture.js";
import { targetRoute } from "../ssh-route.js";
import { makeTempDir, removeTempDir } from "../temp-dir.fixture.js";
import { ConfiguredKeyAgent, configuredPublicKey } from "./key-agent-signer.js";
import type { PromptContext, SharedSessionContext } from "./session-context.js";
import type { WsClient } from "./session-manager.js";
import { type AuthPromptFn, SshAgent } from "./ssh-agent.js";
import { SshConnectionManager } from "./ssh-connection-manager.js";

// The agent binary is "already there": the mock server's exec answers HELLO.
vi.mock("./agent-deployer.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./agent-deployer.js")>();
	return {
		...actual,
		deployAgentIfNeeded: vi.fn().mockResolvedValue({
			deployed: false,
			remoteMatchesHubVersionCache: false,
			remotePath: "lasterm-agent",
			os: null,
			arch: null,
		}),
	};
});

const TEST_TIMEOUT = 20_000;
const PASSPHRASE = "a-test-passphrase";
/** The agent protocol's request types: list identities, sign. */
const REQUEST_IDENTITIES = 11;
const SIGN_REQUEST = 13;

function parsed(key: string | Buffer, passphrase?: string): ParsedKey {
	const result = utils.parseKey(key, passphrase);
	if (result instanceof Error) throw result;
	return Array.isArray(result) ? result[0] : result;
}

const HOST_KEY = generateEd25519KeyPair().private;
const HOST_FINGERPRINT = fingerprintOf(parsed(HOST_KEY).getPublicSSH());

const KEY_DIR = makeTempDir("lasterm-key-agent-signer-");

/** The configured key: an encrypted `openssh-key-v1` file, and no `.pub` beside it. */
const OPENSSH = generateEd25519KeyPair({
	passphrase: PASSPHRASE,
	cipher: "aes256-ctr",
	rounds: 4,
});
const OPENSSH_KEY_PATH = join(KEY_DIR, "id_ed25519");
writeFileSync(OPENSSH_KEY_PATH, OPENSSH.private, { mode: 0o600 });
const OPENSSH_PRIVATE = parsed(OPENSSH.private, PASSPHRASE);
const OPENSSH_PUBLIC = OPENSSH_PRIVATE.getPublicSSH();

/** A legacy PEM key, encrypted, whose public half only its `.pub` gives. */
const PEM_PRIVATE_TEXT = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	publicKeyEncoding: { type: "pkcs1", format: "pem" },
	privateKeyEncoding: {
		type: "pkcs1",
		format: "pem",
		cipher: "aes-256-cbc",
		passphrase: PASSPHRASE,
	},
}).privateKey;
const PEM_PRIVATE = parsed(PEM_PRIVATE_TEXT, PASSPHRASE);
const PEM_PUBLIC = PEM_PRIVATE.getPublicSSH();
const PEM_KEY_PATH = join(KEY_DIR, "id_rsa.pem");
writeFileSync(PEM_KEY_PATH, PEM_PRIVATE_TEXT, { mode: 0o600 });
writeFileSync(`${PEM_KEY_PATH}.pub`, `${PEM_PRIVATE.type} ${PEM_PUBLIC.toString("base64")} test\n`);
const PEM_NO_PUB_PATH = join(KEY_DIR, "id_rsa_alone.pem");
writeFileSync(PEM_NO_PUB_PATH, PEM_PRIVATE_TEXT, { mode: 0o600 });

/** A key the agent holds that the host is not configured with. */
const OTHER_PRIVATE = parsed(generateEd25519KeyPair().private);
const OTHER_PUBLIC = OTHER_PRIVATE.getPublicSSH();

/** A key file that needs no passphrase. */
const PLAIN = generateEd25519KeyPair();
const PLAIN_KEY_PATH = join(KEY_DIR, "id_plain");
writeFileSync(PLAIN_KEY_PATH, PLAIN.private, { mode: 0o600 });
const PLAIN_PRIVATE = parsed(PLAIN.private);

const HELLO: HelloMessage = {
	type: "HELLO",
	version: 1,
	agentVersion: "0.0.0-test",
	capabilities: ["multiplex", "snapshot", "resize"],
};

afterAll(async () => {
	await removeTempDir(KEY_DIR);
});

describe("configuredPublicKey", () => {
	it("reads an encrypted openssh-key-v1 file's public section, with no .pub beside it", () => {
		expect(configuredPublicKey(OPENSSH_KEY_PATH, Buffer.from(OPENSSH.private))).toEqual(
			OPENSSH_PUBLIC,
		);
	});

	it("reads a PEM key's .pub", () => {
		expect(configuredPublicKey(PEM_KEY_PATH, Buffer.from(PEM_PRIVATE_TEXT))).toEqual(PEM_PUBLIC);
	});

	it("gives nothing for a legacy PEM key without .pub", () => {
		expect(configuredPublicKey(PEM_NO_PUB_PATH, Buffer.from(PEM_PRIVATE_TEXT))).toBeNull();
	});

	it("goes by an openssh-key-v1 file's own public section over a .pub of another key", () => {
		const path = join(KEY_DIR, "id_stale");
		writeFileSync(path, OPENSSH.private, { mode: 0o600 });
		writeFileSync(`${path}.pub`, `ssh-ed25519 ${OTHER_PUBLIC.toString("base64")}\n`);
		expect(configuredPublicKey(path, Buffer.from(OPENSSH.private))).toEqual(OPENSSH_PUBLIC);
	});
});

/** An agent held in memory: the keys it lists, and the keys it was asked to sign with. */
class MemoryAgent extends BaseAgent<ParsedKey> {
	signedWith: Buffer[] = [];
	constructor(private readonly keys: ParsedKey[]) {
		super();
	}
	getIdentities(cb: IdentityCallback<ParsedKey>): void {
		cb(null, this.keys);
	}
	sign(pubKey: ParsedKey, data: Buffer, _options: unknown, cb?: SignCallback): void {
		this.signedWith.push(pubKey.getPublicSSH());
		const key = this.keys.find((candidate) =>
			candidate.getPublicSSH().equals(pubKey.getPublicSSH()),
		);
		const signature = key?.sign(data);
		cb?.(signature instanceof Buffer ? null : new Error("no such key"), signature as Buffer);
	}
}

function listed(signer: ConfiguredKeyAgent): Promise<Buffer[]> {
	return new Promise((resolve, reject) => {
		signer.getIdentities((err, keys) => {
			if (err) reject(err);
			else resolve((keys ?? []).map((key) => (key as ParsedKey).getPublicSSH()));
		});
	});
}

describe("ConfiguredKeyAgent", () => {
	it("lists the configured key alone, out of every key the agent holds", async () => {
		const signer = new ConfiguredKeyAgent(
			new MemoryAgent([OTHER_PRIVATE, OPENSSH_PRIVATE]),
			OPENSSH_PUBLIC,
		);
		expect(await listed(signer)).toEqual([OPENSSH_PUBLIC]);
		expect(signer.failure).toBeNull();
	});

	it("lists nothing, and says so, when the agent does not hold the key", async () => {
		const signer = new ConfiguredKeyAgent(new MemoryAgent([OTHER_PRIVATE]), OPENSSH_PUBLIC);
		expect(await listed(signer)).toEqual([]);
		expect(signer.failure).toBe("lacks_key");
	});

	it("signs with no other key, and does not ask the agent to", async () => {
		const memory = new MemoryAgent([OTHER_PRIVATE, OPENSSH_PRIVATE]);
		const signer = new ConfiguredKeyAgent(memory, OPENSSH_PUBLIC);
		const err = await new Promise<Error | null | undefined>((resolve) =>
			signer.sign(OTHER_PRIVATE, Buffer.from("data"), {}, (error) => resolve(error)),
		);
		expect(err).toBeInstanceOf(Error);
		expect(memory.signedWith).toEqual([]);
		expect(signer.failure).toBe("refused");
	});
});

// ─── Through a connection ─────────────────────────────────────────────────────

interface KeyServer {
	port: number;
	/** Every public key a client offered, in order. */
	offered: Buffer[];
	connections: number;
	server: SshServer;
}

/**
 * An SSH server that takes `allowed`'s verified signature, and no other method
 * or key. With `forwardTo`, it is a bastion: a forwarded channel reaches that
 * port.
 */
function startKeyServer(allowed: ParsedKey, forwardTo?: number): Promise<KeyServer> {
	const allowedBlob = allowed.getPublicSSH();
	const state: Omit<KeyServer, "port" | "server"> = { offered: [], connections: 0 };
	const server = new SshServer({ hostKeys: [HOST_KEY] }, (client) => {
		state.connections++;
		client.on("error", () => {});
		client.on("authentication", (ctx) => {
			if (ctx.method !== "publickey") {
				ctx.reject(["publickey"]);
				return;
			}
			state.offered.push(Buffer.from(ctx.key.data));
			if (!ctx.key.data.equals(allowedBlob)) {
				ctx.reject(["publickey"]);
				return;
			}
			// No signature: the client asks whether this key would do.
			if (!ctx.signature || !ctx.blob) {
				ctx.accept();
				return;
			}
			if (allowed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true) ctx.accept();
			else ctx.reject(["publickey"]);
		});
		client.on("ready", () => {
			if (forwardTo !== undefined) {
				client.on("tcpip", (accept) => {
					const stream = accept();
					const onward = connectTcp(forwardTo, "127.0.0.1");
					onward.on("error", () => stream.destroy());
					stream.on("error", () => onward.destroy());
					stream.pipe(onward).pipe(stream);
				});
			}
			client.on("session", (accept) => {
				accept().on("exec", (acceptExec, _reject, info) => {
					const stream = acceptExec();
					if (info.command.includes("--stdio")) {
						stream.write(Buffer.from(encodeFrame(HELLO)));
						return;
					}
					// A connection test's probe of the remote system: nothing to read.
					stream.exit(127);
					stream.end();
				});
			});
		});
	});
	server.on("error", () => {});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as { port: number }).port;
			resolve(Object.assign(state, { port, server }));
		});
	});
}

interface FakeAgent {
	address: string;
	/** The type of every request the hub sent, in order, read off the wire. */
	requests: number[];
	server: NetServer;
	sockets: Set<Socket>;
}

/** An SSH agent holding `keys`, on a socket of its own; `refuseSign` answers every signature with a failure. */
function startFakeAgent(
	keys: ParsedKey[],
	options: { refuseSign?: boolean } = {},
): Promise<FakeAgent> {
	const address =
		process.platform === "win32"
			? String.raw`\\.\pipe\lasterm-fake-agent-${randomUUID()}`
			: join(KEY_DIR, `agent-${randomUUID()}.sock`);
	const requests: number[] = [];
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => {});
		let pending = Buffer.alloc(0);
		socket.on("data", (chunk: Buffer) => {
			pending = Buffer.concat([pending, chunk]);
			while (pending.length >= 5) {
				const length = pending.readUInt32BE(0);
				if (pending.length < 4 + length) break;
				requests.push(pending[4] as number);
				pending = pending.subarray(4 + length);
			}
		});
		const protocol = new AgentProtocol(false);
		protocol.on("error", () => {});
		protocol.on("identities", (req) => protocol.getIdentitiesReply(req, keys));
		protocol.on("sign", (req, pubKey, data, signOptions) => {
			const key = keys.find((candidate) => candidate.getPublicSSH().equals(pubKey.getPublicSSH()));
			const signature =
				options.refuseSign || key === undefined ? undefined : key.sign(data, signOptions.hash);
			if (signature instanceof Buffer) protocol.signReply(req, signature);
			else protocol.failureReply(req);
		});
		socket.pipe(protocol).pipe(socket);
	});
	return new Promise((resolve) => {
		server.listen(address, () => resolve({ address, requests, server, sockets }));
	});
}

function keyHost(port: number, keyPath: string, overrides: Partial<Host> = {}): Host {
	return {
		id: "01HZ000000000000000000876",
		type: "ssh",
		label: "agent-signed",
		sshHost: "127.0.0.1",
		sshPort: port,
		sshUser: "tester",
		sshAuth: "key",
		sshKeyPath: keyPath,
		iconType: "auto",
		trustRemoteHints: "ignore",
		sortOrder: 0,
		os: null,
		arch: null,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

let connections: SshAgent[] = [];
let servers: SshServer[] = [];
let agents: FakeAgent[] = [];
let homes: string[] = [];

afterEach(async () => {
	vi.unstubAllEnvs();
	for (const connection of connections) connection.close();
	connections = [];
	await Promise.all(
		servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
	);
	servers = [];
	for (const agent of agents) for (const socket of agent.sockets) socket.destroy();
	await Promise.all(
		agents.map((agent) => new Promise<void>((resolve) => agent.server.close(() => resolve()))),
	);
	agents = [];
	await Promise.all(homes.map((home) => removeTempDir(home)));
	homes = [];
});

async function serve(allowed: ParsedKey, forwardTo?: number): Promise<KeyServer> {
	const server = await startKeyServer(allowed, forwardTo);
	servers.push(server.server);
	return server;
}

/** Start a fake agent holding `keys`, and point `SSH_AUTH_SOCK` at it. */
async function useAgent(keys: ParsedKey[], options?: { refuseSign?: boolean }): Promise<FakeAgent> {
	const agent = await startFakeAgent(keys, options);
	agents.push(agent);
	vi.stubEnv("SSH_AUTH_SOCK", agent.address);
	return agent;
}

describe("key auth signed by the SSH agent that holds the key (#876)", () => {
	function connect(host: Host, promptAuth: AuthPromptFn): SshAgent {
		const connection = new SshAgent(host, promptAuth);
		connections.push(connection);
		return connection;
	}

	it(
		"asks for no passphrase when the agent holds the key, and offers that key alone",
		async () => {
			const server = await serve(OPENSSH_PRIVATE);
			// The other key comes first: offered as agent auth offers keys, it would
			// be the first the server sees.
			const agent = await useAgent([OTHER_PRIVATE, OPENSSH_PRIVATE]);
			const promptAuth = vi.fn<AuthPromptFn>().mockResolvedValue(null);
			const connection = connect(keyHost(server.port, OPENSSH_KEY_PATH), promptAuth);

			const { hello } = await connection.start(HOST_FINGERPRINT);

			expect(hello.type).toBe("HELLO");
			expect(promptAuth).not.toHaveBeenCalled();
			expect(connection.keySigner).toBe("agent");
			expect(server.offered.length).toBeGreaterThan(0);
			expect(server.offered.every((blob) => blob.equals(OPENSSH_PUBLIC))).toBe(true);
			// Asked for its keys and for signatures, never to add or remove one.
			expect(new Set(agent.requests)).toEqual(new Set([REQUEST_IDENTITIES, SIGN_REQUEST]));
		},
		TEST_TIMEOUT,
	);

	it(
		"matches a PEM key through its .pub",
		async () => {
			const server = await serve(PEM_PRIVATE);
			await useAgent([PEM_PRIVATE]);
			const promptAuth = vi.fn<AuthPromptFn>().mockResolvedValue(null);
			const connection = connect(keyHost(server.port, PEM_KEY_PATH), promptAuth);

			await connection.start(HOST_FINGERPRINT);

			expect(promptAuth).not.toHaveBeenCalled();
			expect(connection.keySigner).toBe("agent");
		},
		TEST_TIMEOUT,
	);

	it(
		"offers none of an agent's other keys, and asks for the passphrase",
		async () => {
			const server = await serve(OPENSSH_PRIVATE);
			const agent = await useAgent([OTHER_PRIVATE]);
			const promptAuth = vi.fn<AuthPromptFn>().mockResolvedValue(PASSPHRASE);
			const host = keyHost(server.port, OPENSSH_KEY_PATH);
			const connection = connect(host, promptAuth);

			await connection.start(HOST_FINGERPRINT);

			expect(promptAuth.mock.calls).toEqual([
				[host.id, "passphrase", `Enter passphrase for ${OPENSSH_KEY_PATH}`],
			]);
			expect(connection.keySigner).toBe("file");
			expect(server.offered.every((blob) => blob.equals(OPENSSH_PUBLIC))).toBe(true);
			// The agent was asked whether it holds the key, and nothing else.
			expect(agent.requests).toEqual([REQUEST_IDENTITIES]);
		},
		TEST_TIMEOUT,
	);

	it(
		"decrypts the file when the agent refuses to sign, on a new connection",
		async () => {
			const server = await serve(OPENSSH_PRIVATE);
			const agent = await useAgent([OPENSSH_PRIVATE], { refuseSign: true });
			const promptAuth = vi.fn<AuthPromptFn>().mockResolvedValue(PASSPHRASE);
			const host = keyHost(server.port, OPENSSH_KEY_PATH);
			const connection = connect(host, promptAuth);

			const { hello } = await connection.start(HOST_FINGERPRINT);

			expect(hello.type).toBe("HELLO");
			expect(promptAuth.mock.calls).toEqual([
				[host.id, "passphrase", `Enter passphrase for ${OPENSSH_KEY_PATH}`],
			]);
			expect(connection.keySigner).toBe("file");
			expect(agent.requests.filter((type) => type === SIGN_REQUEST)).toHaveLength(1);
			// The connection the agent did not sign for was closed before the
			// passphrase was asked; the file's is a second one.
			expect(server.connections).toBe(2);
			expect(server.offered.every((blob) => blob.equals(OPENSSH_PUBLIC))).toBe(true);
		},
		TEST_TIMEOUT,
	);

	it(
		"ends the attempt as a cancel when the agent refuses and nobody gives the passphrase",
		async () => {
			const server = await serve(OPENSSH_PRIVATE);
			await useAgent([OPENSSH_PRIVATE], { refuseSign: true });
			const promptAuth = vi.fn<AuthPromptFn>().mockResolvedValue(null);
			const connection = connect(keyHost(server.port, OPENSSH_KEY_PATH), promptAuth);

			await expect(connection.start(HOST_FINGERPRINT)).rejects.toThrow(
				"Authentication cancelled by user",
			);
			expect(server.connections).toBe(1);
		},
		TEST_TIMEOUT,
	);

	it(
		"asks for the passphrase as before when there is no agent",
		async () => {
			// The setup file points SSH_AUTH_SOCK at an agent that does not exist.
			const server = await serve(OPENSSH_PRIVATE);
			const promptAuth = vi.fn<AuthPromptFn>().mockResolvedValue(PASSPHRASE);
			const connection = connect(keyHost(server.port, OPENSSH_KEY_PATH), promptAuth);

			await connection.start(HOST_FINGERPRINT);

			expect(promptAuth).toHaveBeenCalledOnce();
			expect(connection.keySigner).toBe("file");
			expect(server.connections).toBe(1);
		},
		TEST_TIMEOUT,
	);

	it(
		"keeps the agent out when the host's ~/.ssh/config block says IdentityAgent none",
		async () => {
			const home = makeTempDir("lasterm-key-agent-home-");
			homes.push(home);
			mkdirSync(join(home, ".ssh"));
			writeFileSync(
				join(home, ".ssh", "config"),
				"Host box\n  HostName 127.0.0.1\n  IdentityAgent none\n",
			);
			vi.stubEnv("HOME", home);
			vi.stubEnv("USERPROFILE", home);
			const server = await serve(OPENSSH_PRIVATE);
			const agent = await useAgent([OPENSSH_PRIVATE]);
			const promptAuth = vi.fn<AuthPromptFn>().mockResolvedValue(PASSPHRASE);
			const connection = connect(
				keyHost(server.port, OPENSSH_KEY_PATH, { sshConfigHost: "box" }),
				promptAuth,
			);

			await connection.start(HOST_FINGERPRINT);

			expect(promptAuth).toHaveBeenCalledOnce();
			expect(connection.keySigner).toBe("file");
			expect(agent.requests).toEqual([]);
		},
		TEST_TIMEOUT,
	);

	it(
		"signs from a key file that needs no passphrase, without asking the agent",
		async () => {
			const server = await serve(PLAIN_PRIVATE);
			const agent = await useAgent([PLAIN_PRIVATE]);
			const promptAuth = vi.fn<AuthPromptFn>().mockResolvedValue(null);
			const connection = connect(keyHost(server.port, PLAIN_KEY_PATH), promptAuth);

			await connection.start(HOST_FINGERPRINT);

			expect(promptAuth).not.toHaveBeenCalled();
			expect(connection.keySigner).toBe("file");
			expect(agent.requests).toEqual([]);
		},
		TEST_TIMEOUT,
	);

	// A jump's key is the jump's: the agent signs it as it would the target's,
	// and the passphrase asked when it does not is asked for the jump.
	it.each([
		["holds the jump's key", false, []],
		[
			"refuses to sign with the jump's key",
			true,
			[["host-bastion", "passphrase", `Enter passphrase for ${OPENSSH_KEY_PATH}`]],
		],
	] as const)(
		"through a jump whose agent %s",
		async (_name, refuseSign, prompts) => {
			const target = await serve(PLAIN_PRIVATE);
			const bastion = await serve(OPENSSH_PRIVATE, target.port);
			await useAgent([OPENSSH_PRIVATE], { refuseSign });
			const promptAuth = vi.fn<AuthPromptFn>().mockResolvedValue(PASSPHRASE);
			const connection = connect(keyHost(target.port, PLAIN_KEY_PATH), promptAuth);

			const { hello } = await connection.start(HOST_FINGERPRINT, null, undefined, {
				jump: { host: "127.0.0.1", port: bastion.port, username: "ops" },
				knownHostsNames: ["127.0.0.1"],
				auth: { method: "key", keyPath: OPENSSH_KEY_PATH },
				promptHostId: "host-bastion",
				pinnedFingerprint: HOST_FINGERPRINT,
				trustKnownHosts: false,
				pinTo: { kind: "host", hostId: "host-bastion", expectedRoute: null },
			});

			expect(hello.type).toBe("HELLO");
			expect(promptAuth.mock.calls).toEqual(prompts);
			expect(bastion.connections).toBe(refuseSign ? 2 : 1);
			expect(bastion.offered.every((blob) => blob.equals(OPENSSH_PUBLIC))).toBe(true);
		},
		TEST_TIMEOUT,
	);
});

describe("a host's connection test, with the key signed by the SSH agent (#876)", () => {
	/** A connection manager whose only host is the one tested, its key already trusted. */
	function harness(port: number) {
		const saved = { id: "saved-host", type: "ssh" as const, sshHost: "127.0.0.1", sshPort: port };
		const ctx = {
			passphraseCache: new Map(),
			promptContexts: new Map<string, PromptContext>(),
			promptIndex: new Map<string, string>(),
			pendingPrompts: new Map() as SharedSessionContext["pendingPrompts"],
			clients: new Map(),
			channels: new Map() as SharedSessionContext["channels"],
			acquisitions: new Map() as SharedSessionContext["acquisitions"],
			trustedOnceFingerprints: new Map<string, string>(),
			metaDal: {
				getHost: (id: string) => (id === saved.id ? saved : undefined),
				getHostFingerprint: (id: string, expectedRoute: string | null) =>
					id === saved.id && targetRoute(saved, () => undefined) === expectedRoute
						? HOST_FINGERPRINT
						: null,
				updateHostFingerprint: vi.fn().mockReturnValue(true),
			},
		};
		const client = { id: "c1", send: vi.fn() } as unknown as WsClient & { send: Mock };
		ctx.clients.set("c1", client as never);
		const mgr = new SshConnectionManager(
			ctx as unknown as SharedSessionContext,
			null as never,
			null as never,
			null as never,
		);
		const message: TestConnectMessage = {
			type: "TEST_CONNECT",
			hostId: saved.id,
			hostname: "127.0.0.1",
			port,
			sshAuth: "key",
			sshKeyPath: OPENSSH_KEY_PATH,
			sshUser: "tester",
		};
		const sent = (type: string) =>
			client.send.mock.calls.map(([sentMessage]) => sentMessage).filter((m) => m.type === type);
		return { client, mgr, message, sent };
	}

	it(
		"asks nothing when the agent holds the key",
		async () => {
			const server = await serve(OPENSSH_PRIVATE);
			await useAgent([OPENSSH_PRIVATE]);
			const { client, mgr, message, sent } = harness(server.port);

			await mgr.handleTestConnect("c1", message);

			expect(sent("AUTH_PROMPT")).toEqual([]);
			expect(client.send).toHaveBeenCalledWith({ type: "TEST_CONNECT_OK", hostId: "saved-host" });
		},
		TEST_TIMEOUT,
	);

	it(
		"asks for the passphrase and tests again with the file when the agent refuses to sign",
		async () => {
			const server = await serve(OPENSSH_PRIVATE);
			await useAgent([OPENSSH_PRIVATE], { refuseSign: true });
			const { client, mgr, message, sent } = harness(server.port);

			const done = mgr.handleTestConnect("c1", message);
			const prompt = await vi.waitFor(() => {
				const [asked] = sent("AUTH_PROMPT");
				if (!asked) throw new Error("not asked yet");
				return asked as { promptId: string; deliveryEpoch: number };
			});
			mgr.handleAuthPromptResponse("c1", {
				hostId: "saved-host",
				secret: PASSPHRASE,
				promptId: prompt.promptId,
				deliveryEpoch: prompt.deliveryEpoch,
			});
			await done;

			expect(sent("AUTH_PROMPT")).toHaveLength(1);
			expect(client.send).toHaveBeenCalledWith({ type: "TEST_CONNECT_OK", hostId: "saved-host" });
			expect(server.connections).toBe(2);
		},
		TEST_TIMEOUT,
	);
});
