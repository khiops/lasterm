import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { generateId, type TestConnectMessage } from "@lasterm/shared";
import { Server, type Server as SshServer, utils } from "ssh2";
import { afterAll, afterEach, beforeAll, describe, expect, it, type Mock, vi } from "vitest";
import { readUserKnownHosts } from "../ssh/known-hosts.js";
import { sshAddress, targetRoute } from "../ssh-route.js";
import { makeTempDir, removeTempDir } from "../temp-dir.fixture.js";
import {
	type PromptContext,
	type SharedSessionContext,
	type TrustedOnceFingerprints,
	trustedOnceFor,
	trustOnce,
} from "./session-context.js";
import type { WsClient } from "./session-manager.js";
import { attemptSshTest, SshConnectionManager } from "./ssh-connection-manager.js";
import { probeTestConnectPlatform } from "./test-connect-platform.js";

// The known_hosts reader the test calls when it decides on a key: the real one,
// unless a test hands it what that read finds (#1217). The attempt's own
// revocation check reads through `findHostKeyRevocation`, inside the module,
// and is never affected.
vi.mock("../ssh/known-hosts.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../ssh/known-hosts.js")>();
	return { ...actual, readUserKnownHosts: vi.fn(actual.readUserKnownHosts) };
});

/**
 * How long a wait for what the hub sends may take: a guard against a hang. Vitest's
 * 1 s default ran out while the full suite loaded the machine (#936).
 */
const WAIT = { timeout: 10_000 };

const { privateKey: HOST_KEY } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	publicKeyEncoding: { type: "pkcs1", format: "pem" },
	privateKeyEncoding: { type: "pkcs1", format: "pem" },
});
const { privateKey: CLIENT_KEY } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	publicKeyEncoding: { type: "pkcs1", format: "pem" },
	privateKeyEncoding: { type: "pkcs1", format: "pem" },
});
const KEY_DIR = makeTempDir("lasterm-test-connect-");
const CLIENT_KEY_PATH = join(KEY_DIR, "client.pem");
writeFileSync(CLIENT_KEY_PATH, CLIENT_KEY, { mode: 0o600 });
const PASSPHRASE = "test-connect-passphrase-812";
const { privateKey: ENCRYPTED_CLIENT_KEY } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	publicKeyEncoding: { type: "pkcs1", format: "pem" },
	privateKeyEncoding: {
		type: "pkcs1",
		format: "pem",
		cipher: "aes-256-cbc",
		passphrase: PASSPHRASE,
	},
});
const ENCRYPTED_KEY_PATH = join(KEY_DIR, "encrypted-client.pem");
writeFileSync(ENCRYPTED_KEY_PATH, ENCRYPTED_CLIENT_KEY, { mode: 0o600 });

afterAll(() => removeTempDir(KEY_DIR));

/**
 * An SSH server that accepts any client and counts authentication attempts.
 * With `uname`, it answers `uname -sm` with that system; any other command fails.
 * With `password`, it takes that password and nothing else, as OpenSSH does,
 * and counts the connections it is dialled. `onConnection` runs as each
 * connection reaches it, on the client's ident line: the client is dialling,
 * and has not checked the server's key yet.
 */
function sshServer(
	uname?: string,
	password?: string,
	onConnection?: (connections: number) => void,
): Promise<{
	server: SshServer;
	port: number;
	auth: { attempts: number; usernames: string[]; connections: number };
}> {
	const auth = { attempts: 0, usernames: [] as string[], connections: 0 };
	return new Promise((resolve) => {
		const server = new Server({ hostKeys: [HOST_KEY] }, (client) => {
			auth.connections++;
			onConnection?.(auth.connections);
			client.on("error", () => {});
			client.on("authentication", (context) => {
				auth.attempts++;
				auth.usernames.push(context.username);
				if (
					password === undefined ||
					(context.method === "password" && context.password === password)
				) {
					context.accept();
				} else {
					context.reject(["password"]);
				}
			});
			client.on("ready", () => {
				client.on("session", (accept) => {
					accept().on("exec", (acceptExec, _reject, info) => {
						const stream = acceptExec();
						if (uname !== undefined && info.command === "uname -sm") {
							stream.write(`${uname}
`);
							stream.exit(0);
						} else {
							stream.exit(127);
						}
						stream.end();
					});
				});
			});
		});
		server.on("error", () => {});
		server.listen(0, "127.0.0.1", () => {
			resolve({ server, port: (server.address() as { port: number }).port, auth });
		});
	});
}

type SavedHost = {
	type: "ssh";
	sshHost: string;
	sshPort: number;
	fingerprint: string | null;
	sshConfigHost?: string;
};

/**
 * With `sshConfig`, the `[ssh]` settings the hub reads, which a test may change.
 * `other` is a second saved host, `other-host`, with a pin of its own (#1228).
 */
function setup(saved?: SavedHost, sshConfig?: { trustKnownHosts: boolean }, other?: SavedHost) {
	const updateHostFingerprint = vi.fn().mockReturnValue(true);
	const savedById = (id: string): SavedHost | undefined =>
		id === "saved-host" ? saved : id === "other-host" ? other : undefined;
	const ctx = {
		...(sshConfig ? { configResolver: { sshConfig } } : {}),
		passphraseCache: new Map(),
		promptContexts: new Map<string, PromptContext>(),
		promptIndex: new Map<string, string>(),
		pendingPrompts: new Map() as SharedSessionContext["pendingPrompts"],
		clients: new Map(),
		channels: new Map() as SharedSessionContext["channels"],
		acquisitions: new Map() as SharedSessionContext["acquisitions"],
		trustedOnceFingerprints: new Map() as TrustedOnceFingerprints,
		metaDal: {
			getHost: (id: string) => {
				const host = savedById(id);
				return host ? { id, ...host } : undefined;
			},
			getHostFingerprint: (id: string, expectedRoute: string | null) => {
				const host = savedById(id);
				return host && targetRoute({ id, ...host }, () => undefined) === expectedRoute
					? host.fingerprint
					: null;
			},
			updateHostFingerprint,
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
	return { ctx, client, mgr, updateHostFingerprint };
}

function testedRoute(msg: TestConnectMessage, ctx?: ReturnType<typeof setup>["ctx"]): string {
	return targetRoute(
		{
			id: msg.hostId,
			type: "ssh",
			sshHost: msg.hostname,
			sshPort: msg.port,
			sshProxyHostId: msg.sshProxyHostId ?? null,
			sshProxySpec: msg.sshProxySpec ?? null,
			sshProxyPort: msg.sshProxyPort ?? null,
		},
		(id) => sshAddress(ctx?.metaDal.getHost(id)),
	)!;
}

/** Trust `fingerprint` once for the message's host id on the route it tests. */
function trustTested(
	ctx: ReturnType<typeof setup>["ctx"],
	msg: TestConnectMessage,
	fingerprint: string,
): void {
	trustOnce(ctx.trustedOnceFingerprints, msg.hostId, testedRoute(msg, ctx), fingerprint);
}

/** The key trusted once for the message's host id on the route it tests. */
function trustedTested(
	ctx: ReturnType<typeof setup>["ctx"],
	msg: TestConnectMessage,
): string | undefined {
	return trustedOnceFor(ctx.trustedOnceFingerprints, msg.hostId, testedRoute(msg, ctx));
}

/** Every entry of the run-long cache, copied: [host id, route, fingerprint]. */
function cachedEntries(cache: TrustedOnceFingerprints): Array<[string, string, string]> {
	return [...cache].flatMap(([hostId, routes]) =>
		[...routes].map(([route, fingerprint]): [string, string, string] => [
			hostId,
			route,
			fingerprint,
		]),
	);
}

function testMessage(hostId: string, port: number): TestConnectMessage {
	return {
		type: "TEST_CONNECT",
		hostId,
		hostname: "127.0.0.1",
		port,
		sshAuth: "key",
		sshKeyPath: CLIENT_KEY_PATH,
		sshUser: "tester",
	};
}

/** The fingerprint a server presents, read by a test attempt that trusts nothing. */
async function serverFingerprint(port: number): Promise<string> {
	const probe = await attemptSshTest(
		{ host: "127.0.0.1", port, username: "tester", privateKey: CLIENT_KEY },
		new Set(),
	);
	if (!probe.unverifiedFingerprint) throw new Error("the server presented no key");
	return probe.unverifiedFingerprint;
}

/** Answer the `index`th AUTH_PROMPT the client was sent, once it is. */
async function answerAuthPrompt(
	client: { send: Mock },
	mgr: SshConnectionManager,
	index: number,
	secret: string | null,
) {
	const prompt = await vi.waitFor(() => {
		const asked = client.send.mock.calls
			.map(([message]) => message)
			.filter((message) => message.type === "AUTH_PROMPT")[index];
		if (!asked) throw new Error("not asked yet");
		return asked as { hostId: string; promptId: string; deliveryEpoch: number; message: string };
	}, WAIT);
	mgr.handleAuthPromptResponse("c1", {
		hostId: prompt.hostId,
		secret,
		promptId: prompt.promptId,
		deliveryEpoch: prompt.deliveryEpoch,
	});
	return prompt;
}

async function hostVerifyPrompt(client: { send: Mock }) {
	return vi.waitFor(() => {
		const prompt = client.send.mock.calls
			.map(([message]) => message)
			.find((message) => message.type === "HOST_VERIFY");
		if (!prompt) throw new Error("no host key prompt yet");
		return prompt as {
			promptId: string;
			fingerprint: string;
			firstConnect?: boolean;
			hostname?: string;
		};
	}, WAIT);
}

/** A key as a `known_hosts` line names it, under `[name]:port`, after `marker` if any. */
function keyLine(pem: string, name: string, port: number, marker = ""): string {
	const key = utils.parseKey(pem);
	if (key instanceof Error || Array.isArray(key)) throw new Error("invalid mock key");
	return `${marker}[${name}]:${port} ${key.type} ${key.getPublicSSH().toString("base64")}\n`;
}

/** The fingerprint of a key, as the hub writes it. */
function fingerprintOfPem(pem: string): string {
	const key = utils.parseKey(pem);
	if (key instanceof Error || Array.isArray(key)) throw new Error("invalid mock key");
	return `SHA256:${createHash("sha256").update(key.getPublicSSH()).digest("base64").replace(/=+$/, "")}`;
}

/** Run `body` with a temporary HOME whose `~/.ssh` holds these files. */
async function withKnownHosts<T>(
	files: Record<string, string>,
	body: (ssh: string) => Promise<T>,
): Promise<T> {
	const home = makeTempDir("lasterm-known-hosts-home-");
	try {
		const ssh = join(home, ".ssh");
		mkdirSync(ssh);
		for (const [name, contents] of Object.entries(files)) writeFileSync(join(ssh, name), contents);
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		return await body(ssh);
	} finally {
		vi.unstubAllEnvs();
		removeTempDir(home);
	}
}

type Sent = { type: string; promptId?: string } & Record<string, unknown>;

/** The first key question or result the client was sent, whichever came first. */
async function firstOutcome(client: { send: Mock }): Promise<Sent> {
	return vi.waitFor(() => {
		const first = client.send.mock.calls
			.map(([message]) => message as Sent)
			.find((message) =>
				["HOST_VERIFY", "TEST_CONNECT_OK", "TEST_CONNECT_FAIL"].includes(message.type),
			);
		if (!first) throw new Error("nothing sent yet");
		return first;
	}, WAIT);
}

/**
 * Run a test connection to its end, `inspect` reading the first question or
 * result. A key question is answered `answer`, even when an assertion on it
 * failed, so that no prompt is left open.
 */
async function runTest(
	mgr: SshConnectionManager,
	client: { send: Mock },
	message: TestConnectMessage,
	inspect: (first: Sent) => void,
	answer: "reject" | "trust_once" | "trust_permanent" = "reject",
): Promise<void> {
	const done = mgr.handleTestConnect("c1", message);
	const first = await firstOutcome(client);
	try {
		inspect(first);
	} finally {
		if (first.type === "HOST_VERIFY")
			mgr.handleHostVerifyResponse(first.promptId ?? "", answer, "c1");
		await done;
	}
}

describe("TEST_CONNECT checks the host key like a session", { timeout: 20_000 }, () => {
	let server: SshServer | undefined;

	afterEach(() => {
		server?.close();
		server = undefined;
	});

	// message-alias: the alias a New Host test carries for a picked ~/.ssh/config
	// entry, on a host the hub has not saved; trusted-once, after an earlier test
	// sent with the same id left its key trusted for its route (#1037, #1228).
	it.each([
		"address",
		"saved-alias",
		"edited-alias",
		"pinned",
		"message-alias",
		"message-alias-trusted-once",
	])("checks target revocation under the eligible names (%s)", async (name) => {
		const mock = await sshServer();
		server = mock.server;
		const home = makeTempDir("lasterm-revoked-home-");
		try {
			mkdirSync(join(home, ".ssh"));
			const key = utils.parseKey(HOST_KEY);
			if (key instanceof Error || Array.isArray(key)) throw new Error("invalid mock key");
			const knownHosts = join(home, ".ssh", "known_hosts");
			writeFileSync(
				knownHosts,
				`@revoked [${name === "address" || name === "pinned" ? "127.0.0.1" : "alias"}]:${mock.port} ${key.type} ${key.getPublicSSH().toString("base64")}\n`,
			);
			vi.stubEnv("HOME", home);
			vi.stubEnv("USERPROFILE", home);
			const fingerprint = `SHA256:${createHash("sha256").update(key.getPublicSSH()).digest("base64").replace(/=+$/, "")}`;
			const { ctx, client, mgr, updateHostFingerprint } = setup({
				type: "ssh",
				sshHost: name === "edited-alias" ? "127.0.0.2" : "127.0.0.1",
				sshPort: mock.port,
				sshConfigHost: "alias",
				fingerprint: name === "pinned" ? fingerprint : null,
			});
			const fromMessage = name.startsWith("message-alias");
			const message: TestConnectMessage = fromMessage
				? { ...testMessage("new-host", mock.port), sshConfigHost: "alias" }
				: testMessage("saved-host", mock.port);
			if (name === "message-alias-trusted-once") {
				trustTested(ctx, message, fingerprint);
			}
			const done = mgr.handleTestConnect("c1", message);
			if (name === "edited-alias") {
				const prompt = await hostVerifyPrompt(client);
				mgr.handleHostVerifyResponse(prompt.promptId, "reject", "c1");
			}
			await done;
			if (name !== "edited-alias") {
				expect(client.send).toHaveBeenCalledWith({
					type: "TEST_CONNECT_FAIL",
					hostId: message.hostId,
					message: `This host's key is marked @revoked in ${knownHosts}:1. Refusing to connect.`,
				});
				expect(client.send).not.toHaveBeenCalledWith(
					expect.objectContaining({ type: "HOST_VERIFY" }),
				);
			}
			expect(mock.auth.attempts).toBe(0);
			expect(updateHostFingerprint).not.toHaveBeenCalled();
			expect(cachedEntries(ctx.trustedOnceFingerprints)).toEqual(
				name === "message-alias-trusted-once"
					? [["new-host", testedRoute(message, ctx), fingerprint]]
					: [],
			);
		} finally {
			vi.unstubAllEnvs();
			removeTempDir(home);
		}
	});

	// Nothing in known_hosts for the host: nothing to say about the key, and
	// trust_known_hosts has nothing to go on (#1217).
	it.each([false, true])(
		"asks about an unknown key before authenticating, and stops when it is rejected (trust_known_hosts %s)",
		async (trustKnownHosts) => {
			const mock = await sshServer();
			server = mock.server;
			const { ctx, client, mgr } = setup(undefined, { trustKnownHosts });
			// Another key trusted once for this id: a refusal leaves it (#1228).
			trustTested(ctx, testMessage("new-host", mock.port), "SHA256:trusted-before");

			await withKnownHosts({}, () =>
				runTest(mgr, client, testMessage("new-host", mock.port), (first) => {
					expect(first).toMatchObject({
						type: "HOST_VERIFY",
						firstConnect: true,
						fingerprint: expect.stringMatching(/^SHA256:/),
						// The host is not saved: its address is what the dialog can name it by.
						hostname: `127.0.0.1:${mock.port}`,
					});
					expect(first).not.toHaveProperty("knownHosts");
					expect(mock.auth.attempts, "credentials went to an unchecked server").toBe(0);
				}),
			);

			expect(client.send).toHaveBeenCalledWith({
				type: "TEST_CONNECT_FAIL",
				hostId: "new-host",
				message: "SSH host key rejected",
			});
			expect(mock.auth.attempts).toBe(0);
			expect(trustedTested(ctx, testMessage("new-host", mock.port))).toBe("SHA256:trusted-before");
		},
	);

	// An unsaved host has no row to record the key in: this hub run trusts it,
	// for the id the test was sent with, replacing what that id trusted there (#1228).
	it.each(["trust_once", "trust_permanent"] as const)(
		"retries under a trusted key, and keeps it for this id and route (%s)",
		async (action) => {
			const mock = await sshServer();
			server = mock.server;
			const { ctx, client, mgr, updateHostFingerprint } = setup();
			const message = testMessage("new-host", mock.port);
			trustTested(ctx, message, "SHA256:trusted-before");

			const done = mgr.handleTestConnect("c1", message);
			const prompt = await hostVerifyPrompt(client);
			mgr.handleHostVerifyResponse(prompt.promptId, action, "c1");
			await done;

			expect(client.send).toHaveBeenCalledWith({ type: "TEST_CONNECT_OK", hostId: "new-host" });
			expect(mock.auth.attempts).toBeGreaterThan(0);
			expect(updateHostFingerprint).not.toHaveBeenCalled();
			expect(cachedEntries(ctx.trustedOnceFingerprints)).toEqual([
				["new-host", testedRoute(message, ctx), prompt.fingerprint],
			]);
		},
	);

	// A key it trusted once before, another than the one shown, stays trusted
	// once: the answer about this key is a pin, not a cache write (#1228).
	it("records a trusted key on the saved host it was tested for", async () => {
		const mock = await sshServer();
		server = mock.server;
		const { ctx, client, mgr, updateHostFingerprint } = setup({
			type: "ssh",
			sshHost: "127.0.0.1",
			sshPort: mock.port,
			fingerprint: null,
		});
		const message = testMessage("saved-host", mock.port);
		trustTested(ctx, message, "SHA256:trusted-before");

		const done = mgr.handleTestConnect("c1", message);
		const prompt = await hostVerifyPrompt(client);
		mgr.handleHostVerifyResponse(prompt.promptId, "trust_permanent", "c1");
		await done;
		expect(trustedTested(ctx, message)).toBe("SHA256:trusted-before");

		expect(client.send).toHaveBeenCalledWith({ type: "TEST_CONNECT_OK", hostId: "saved-host" });
		expect(updateHostFingerprint).toHaveBeenCalledWith(
			"saved-host",
			prompt.fingerprint,
			expect.any(String),
		);
	});

	it.each(["trust_once", "trust_permanent"] as const)(
		"isolates an edited address from cached trust (%s)",
		async (action) => {
			const mock = await sshServer();
			server = mock.server;
			const { ctx, client, mgr, updateHostFingerprint } = setup({
				type: "ssh",
				sshHost: "127.0.0.2",
				sshPort: mock.port,
				fingerprint: "SHA256:recorded-for-another-address",
			});

			const savedRoute = targetRoute(
				{ id: "saved-host", type: "ssh", sshHost: "127.0.0.2", sshPort: mock.port },
				() => undefined,
			)!;
			const serverKey = await serverFingerprint(mock.port);
			trustOnce(ctx.trustedOnceFingerprints, "saved-host", savedRoute, serverKey);
			const done = mgr.handleTestConnect("c1", testMessage("saved-host", mock.port));
			const prompt = await hostVerifyPrompt(client);
			expect(prompt.firstConnect, "the edited address is a first connection").toBe(true);
			mgr.handleHostVerifyResponse(prompt.promptId, action, "c1");
			await done;
			expect(client.send).toHaveBeenCalledWith({ type: "TEST_CONNECT_OK", hostId: "saved-host" });
			expect(updateHostFingerprint).not.toHaveBeenCalled();
			expect(cachedEntries(ctx.trustedOnceFingerprints)).toEqual([
				["saved-host", savedRoute, serverKey],
				["saved-host", testedRoute(testMessage("saved-host", mock.port), ctx), prompt.fingerprint],
			]);
		},
	);

	it("accepts the key a saved host already recorded, without asking", async () => {
		const mock = await sshServer();
		server = mock.server;
		const probe = await attemptSshTest(
			{ host: "127.0.0.1", port: mock.port, username: "tester", privateKey: CLIENT_KEY },
			new Set(),
		);
		expect(probe.unverifiedFingerprint).toMatch(/^SHA256:/);
		const { ctx, client, mgr } = setup({
			type: "ssh",
			sshHost: "127.0.0.1",
			sshPort: mock.port,
			fingerprint: probe.unverifiedFingerprint ?? null,
		});
		// Another key trusted once for this host does not stand in for its pin (#1228).
		trustTested(ctx, testMessage("saved-host", mock.port), "SHA256:another-key-trusted-once");

		await mgr.handleTestConnect("c1", testMessage("saved-host", mock.port));

		expect(client.send).toHaveBeenCalledWith({ type: "TEST_CONNECT_OK", hostId: "saved-host" });
		expect(client.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "HOST_VERIFY" }));
	});

	// A "Trust once" answer is kept for the host it was given for, on its route,
	// and for nothing else (#1228).
	it.each([
		["pinned to another key", "SHA256:other-host-pin"],
		["with no pin", null],
	])(
		"does not let a host %s through with a key trusted once for another host on its route",
		async (_, pin) => {
			const mock = await sshServer();
			server = mock.server;
			const fingerprint = await serverFingerprint(mock.port);
			const route = { type: "ssh" as const, sshHost: "127.0.0.1", sshPort: mock.port };
			const { client, mgr, updateHostFingerprint } = setup(
				{ ...route, fingerprint: null },
				undefined,
				{ ...route, fingerprint: pin },
			);

			await runTest(
				mgr,
				client,
				testMessage("saved-host", mock.port),
				(first) => expect(first).toMatchObject({ type: "HOST_VERIFY", firstConnect: true }),
				"trust_once",
			);
			expect(client.send).toHaveBeenCalledWith({ type: "TEST_CONNECT_OK", hostId: "saved-host" });

			// The host it was given for: accepted again, without asking.
			client.send.mockClear();
			await runTest(mgr, client, testMessage("saved-host", mock.port), (first) =>
				expect(first).toEqual({ type: "TEST_CONNECT_OK", hostId: "saved-host" }),
			);

			// Another host on the same route decides its own key.
			client.send.mockClear();
			await runTest(mgr, client, testMessage("other-host", mock.port), (first) => {
				expect(first).toMatchObject({ type: "HOST_VERIFY", hostId: "other-host", fingerprint });
				if (pin === null) {
					expect(first.firstConnect).toBe(true);
				} else {
					expect(first.oldFingerprint).toBe(pin);
					expect(first.firstConnect).toBeUndefined();
				}
			});
			expect(client.send).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "TEST_CONNECT_FAIL",
					hostId: "other-host",
					message: "SSH host key rejected",
				}),
			);
			expect(updateHostFingerprint).not.toHaveBeenCalled();
		},
	);

	// A wrong passphrase is asked for again, as for a session (#812), and the
	// test caches none of them.
	it("asks again for a wrong passphrase, then connects", async () => {
		const mock = await sshServer();
		server = mock.server;
		const { ctx, client, mgr } = setup({
			type: "ssh",
			sshHost: "127.0.0.1",
			sshPort: mock.port,
			fingerprint: await serverFingerprint(mock.port),
		});
		const authPrompts = () =>
			client.send.mock.calls
				.map(([message]) => message)
				.filter((message) => message.type === "AUTH_PROMPT");
		const answer = async (index: number, secret: string) => {
			const prompt = await vi.waitFor(() => {
				const asked = authPrompts()[index];
				if (!asked) throw new Error("not asked yet");
				return asked as { promptId: string; deliveryEpoch: number; message: string };
			}, WAIT);
			mgr.handleAuthPromptResponse("c1", {
				hostId: "saved-host",
				secret,
				promptId: prompt.promptId,
				deliveryEpoch: prompt.deliveryEpoch,
			});
			return prompt;
		};

		const done = mgr.handleTestConnect("c1", {
			...testMessage("saved-host", mock.port),
			sshKeyPath: ENCRYPTED_KEY_PATH,
		});
		await answer(0, "not-the-passphrase");
		const again = await answer(1, PASSPHRASE);
		await done;

		expect(again.message).toBe(`Wrong passphrase for ${ENCRYPTED_KEY_PATH}. Try again.`);
		expect(client.send).toHaveBeenCalledWith({ type: "TEST_CONNECT_OK", hostId: "saved-host" });
		expect(ctx.passphraseCache.size).toBe(0);
	});

	/** A saved host whose key is known, tested with password authentication. */
	async function passwordHost() {
		const mock = await sshServer(undefined, "right-password");
		server = mock.server;
		const fingerprint = await serverFingerprint(mock.port);
		mock.auth.connections = 0;
		const harness = setup({ type: "ssh", sshHost: "127.0.0.1", sshPort: mock.port, fingerprint });
		const message: TestConnectMessage = {
			...testMessage("saved-host", mock.port),
			sshAuth: "password",
		};
		delete message.sshKeyPath;
		return { ...harness, mock, message };
	}

	// As for a session: a password the server refused is asked for again,
	// saying so, and the server dialled again; none of them is kept (#815).
	it("asks again for a password the server refused, then connects", async () => {
		const { ctx, client, mgr, mock, message } = await passwordHost();

		const done = mgr.handleTestConnect("c1", message);
		const first = await answerAuthPrompt(client, mgr, 0, "wrong-password");
		const again = await answerAuthPrompt(client, mgr, 1, "right-password");
		await done;

		expect(first.message).toBe("Enter password for tester@127.0.0.1");
		expect(again.message).toBe("Wrong password for tester@127.0.0.1. Try again.");
		expect(client.send).toHaveBeenCalledWith({ type: "TEST_CONNECT_OK", hostId: "saved-host" });
		expect(mock.auth.connections).toBe(2);
		expect(ctx.passphraseCache.size).toBe(0);
	});

	// A cancel is no failure: the test says it as a cancel, which the dialog
	// shows as nothing (#815).
	it.each([
		["asked first", ["cancel"]],
		["asked again", ["wrong-password", "cancel"]],
	] as const)("says a password prompt cancelled when %s as a cancel", async (_when, answers) => {
		const { client, mgr, mock, message } = await passwordHost();

		const done = mgr.handleTestConnect("c1", message);
		for (const [index, answer] of answers.entries()) {
			await answerAuthPrompt(client, mgr, index, answer === "cancel" ? null : answer);
		}
		await done;

		expect(client.send).toHaveBeenCalledWith({
			type: "TEST_CONNECT_FAIL",
			hostId: "saved-host",
			message: "Authentication cancelled by user",
			code: "AUTH_CANCELLED",
		});
		expect(mock.auth.connections).toBe(answers.length - 1);
	});

	// Only a refused password is asked for again: a host that cannot be reached
	// is a failure, asked once and said with its reason.
	it("does not ask again for a password when the host cannot be reached", async () => {
		const { client, mgr, message } = await passwordHost();
		await new Promise<void>((resolve) => server?.close(() => resolve()));
		server = undefined;

		const done = mgr.handleTestConnect("c1", message);
		await answerAuthPrompt(client, mgr, 0, "right-password");
		await done;

		const reply = client.send.mock.calls
			.map(([sent]) => sent)
			.find((sent) => sent.type === "TEST_CONNECT_FAIL");
		expect(reply).toMatchObject({ message: expect.stringContaining("ECONNREFUSED") });
		expect(reply).not.toHaveProperty("code");
		expect(client.send.mock.calls.filter(([sent]) => sent.type === "AUTH_PROMPT")).toHaveLength(1);
	});

	it("names a system no agent is built for, before any session (#401)", async () => {
		const mock = await sshServer("Linux armv7l");
		server = mock.server;
		const fingerprint = await serverFingerprint(mock.port);
		const { client, mgr } = setup({
			type: "ssh",
			sshHost: "127.0.0.1",
			sshPort: mock.port,
			fingerprint,
		});

		await mgr.handleTestConnect("c1", testMessage("saved-host", mock.port));

		expect(client.send).toHaveBeenCalledWith({
			type: "TEST_CONNECT_OK",
			hostId: "saved-host",
			platform: expect.objectContaining({ system: "Linux armv7l", agent: "unsupported" }),
		});
	});

	// What this machine's known_hosts says about the key, read as a session
	// reads it, and `[ssh] trust_known_hosts` applied as a session applies it
	// (#1217).
	describe("reads known_hosts as a session does", () => {
		const CACHED_OTHER = "SHA256:cached-other";
		const fingerprint = fingerprintOfPem(HOST_KEY);

		afterEach(() => {
			vi.mocked(readUserKnownHosts).mockReset();
		});

		it.each([
			["known_hosts", "", 1],
			["known_hosts2", "# a comment\n", 2],
		] as const)("says known_hosts already trusts the key (%s)", async (file, before, line) => {
			const mock = await sshServer();
			server = mock.server;
			const { client, mgr } = setup();

			await withKnownHosts({ [file]: before + keyLine(HOST_KEY, "127.0.0.1", mock.port) }, (ssh) =>
				runTest(mgr, client, testMessage("new-host", mock.port), (first) => {
					expect(first).toMatchObject({
						type: "HOST_VERIFY",
						firstConnect: true,
						knownHosts: { verdict: "trusted", file: join(ssh, file), line },
					});
				}),
			);
		});

		it("warns that known_hosts holds another key", async () => {
			const mock = await sshServer();
			server = mock.server;
			const { client, mgr } = setup();

			await withKnownHosts({ known_hosts: keyLine(CLIENT_KEY, "127.0.0.1", mock.port) }, (ssh) =>
				runTest(mgr, client, testMessage("new-host", mock.port), (first) => {
					expect(first).toMatchObject({
						type: "HOST_VERIFY",
						knownHosts: { verdict: "other-key", file: join(ssh, "known_hosts"), line: 1 },
					});
				}),
			);
		});

		// message-alias: a New Host test of a picked ~/.ssh/config entry. mixed:
		// the address lists another key, the alias the offered one. saved-alias:
		// the saved host's own alias on its saved route. edited-route: the saved
		// alias no longer applies once the address is edited (#1037).
		it.each([
			{
				name: "message-alias",
				saved: undefined,
				alias: "alias",
				lines: (port: number) => keyLine(HOST_KEY, "alias", port),
				expected: { verdict: "trusted", line: 1 },
			},
			{
				name: "mixed",
				saved: undefined,
				alias: "alias",
				lines: (port: number) =>
					keyLine(CLIENT_KEY, "127.0.0.1", port) + keyLine(HOST_KEY, "alias", port),
				expected: { verdict: "trusted", line: 2 },
			},
			{
				name: "saved-alias",
				saved: "127.0.0.1",
				alias: undefined,
				lines: (port: number) => keyLine(HOST_KEY, "alias", port),
				expected: { verdict: "trusted", line: 1 },
			},
			{
				name: "edited-route",
				saved: "127.0.0.2",
				alias: undefined,
				lines: (port: number) => keyLine(HOST_KEY, "alias", port),
				expected: undefined,
			},
		])("finds the key under the ~/.ssh/config alias ($name)", async (row) => {
			const mock = await sshServer();
			server = mock.server;
			const { client, mgr, updateHostFingerprint } = setup(
				row.saved === undefined
					? undefined
					: {
							type: "ssh",
							sshHost: row.saved,
							sshPort: mock.port,
							sshConfigHost: "alias",
							fingerprint: null,
						},
				{ trustKnownHosts: row.expected === undefined },
			);
			const hostId = row.saved === undefined ? "new-host" : "saved-host";
			const message: TestConnectMessage = {
				...testMessage(hostId, mock.port),
				...(row.alias ? { sshConfigHost: row.alias } : {}),
			};

			await withKnownHosts({ known_hosts: row.lines(mock.port) }, (ssh) =>
				runTest(mgr, client, message, (first) => {
					expect(first).toMatchObject({ type: "HOST_VERIFY", firstConnect: true });
					if (row.expected === undefined) expect(first).not.toHaveProperty("knownHosts");
					else
						expect(first.knownHosts).toEqual({
							verdict: row.expected.verdict,
							file: join(ssh, "known_hosts"),
							line: row.expected.line,
						});
				}),
			);
			expect(updateHostFingerprint).not.toHaveBeenCalled();
		});

		// Accepted without asking, as a session accepts it, and recorded nowhere,
		// not even for this host and route: a key nobody was asked about is never
		// cached (#1228).
		it.each([
			{ hostId: "new-host", saved: undefined },
			{ hostId: "saved-host", saved: "127.0.0.2" },
		])(
			"accepts a key known_hosts trusts without asking ($hostId, saved at $saved)",
			async (row) => {
				const mock = await sshServer();
				server = mock.server;
				const { ctx, client, mgr, updateHostFingerprint } = setup(
					row.saved === undefined
						? undefined
						: { type: "ssh", sshHost: row.saved, sshPort: mock.port, fingerprint: null },
					{ trustKnownHosts: true },
				);
				const message = testMessage(row.hostId, mock.port);
				trustTested(ctx, message, CACHED_OTHER);
				const cacheBefore = cachedEntries(ctx.trustedOnceFingerprints);

				await withKnownHosts({ known_hosts: keyLine(HOST_KEY, "127.0.0.1", mock.port) }, () =>
					runTest(mgr, client, message, (first) => {
						expect(first).toEqual({ type: "TEST_CONNECT_OK", hostId: row.hostId });
					}),
				);

				expect(mock.auth.attempts, "the test never connected").toBeGreaterThan(0);
				expect(updateHostFingerprint).not.toHaveBeenCalled();
				expect(cachedEntries(ctx.trustedOnceFingerprints)).toEqual(cacheBefore);
			},
		);

		// The setting is read when the key is decided on, not when the test
		// starts: it changes here as the dial reaches the server.
		it.each([
			[true, false],
			[false, true],
		])("reads trust_known_hosts when it decides (%s to %s)", async (from, to) => {
			const sshConfig = { trustKnownHosts: from };
			const mock = await sshServer(undefined, undefined, (connections) => {
				if (connections === 1) sshConfig.trustKnownHosts = to;
			});
			server = mock.server;
			const { client, mgr } = setup(undefined, sshConfig);

			await withKnownHosts({ known_hosts: keyLine(HOST_KEY, "127.0.0.1", mock.port) }, () =>
				runTest(mgr, client, testMessage("new-host", mock.port), (first) => {
					if (to) expect(first).toEqual({ type: "TEST_CONNECT_OK", hostId: "new-host" });
					else
						expect(first).toMatchObject({
							type: "HOST_VERIFY",
							knownHosts: { verdict: "trusted" },
						});
				}),
			);
			if (to) expect(mock.auth.attempts).toBeGreaterThan(0);
		});

		// On the saved host's own route the key is pinned, as a session pins it,
		// unless a pin appeared meanwhile: that one is never replaced here.
		it.each([
			{ name: "saved-host", meanwhile: undefined, writes: true, ok: true },
			{ name: "same-meanwhile", meanwhile: fingerprint, writes: true, ok: true },
			{ name: "refused", meanwhile: undefined, writes: false, ok: false },
			{ name: "pinned-meanwhile", meanwhile: "SHA256:pinned-meanwhile", writes: true, ok: false },
		])("pins a key known_hosts trusts on the saved host's route ($name)", async (row) => {
			let saved: SavedHost | undefined;
			const mock = await sshServer(undefined, undefined, (connections) => {
				if (connections === 1 && saved && row.meanwhile) saved.fingerprint = row.meanwhile;
			});
			server = mock.server;
			saved = { type: "ssh", sshHost: "127.0.0.1", sshPort: mock.port, fingerprint: null };
			const { ctx, client, mgr, updateHostFingerprint } = setup(saved, { trustKnownHosts: true });
			updateHostFingerprint.mockReturnValue(row.writes);
			const message = testMessage("saved-host", mock.port);
			const route = testedRoute(message, ctx);
			trustTested(ctx, message, CACHED_OTHER);
			const cacheBefore = cachedEntries(ctx.trustedOnceFingerprints);

			await withKnownHosts({ known_hosts: keyLine(HOST_KEY, "127.0.0.1", mock.port) }, () =>
				runTest(mgr, client, message, (first) => {
					expect(first).toEqual(
						row.ok
							? { type: "TEST_CONNECT_OK", hostId: "saved-host" }
							: {
									type: "TEST_CONNECT_FAIL",
									hostId: "saved-host",
									message: "The host changed while connecting. Connect again.",
								},
					);
				}),
			);

			if (row.ok) expect(mock.auth.attempts).toBeGreaterThan(0);
			else expect(mock.auth.attempts).toBe(0);
			if (row.name === "pinned-meanwhile") expect(updateHostFingerprint).not.toHaveBeenCalled();
			if (row.name === "saved-host") {
				expect(updateHostFingerprint).toHaveBeenCalledTimes(1);
				expect(updateHostFingerprint).toHaveBeenCalledWith("saved-host", fingerprint, route);
			}
			expect(cachedEntries(ctx.trustedOnceFingerprints)).toEqual(cacheBefore);
		});

		it("still asks about a key known_hosts does not hold, under trust_known_hosts", async () => {
			const mock = await sshServer();
			server = mock.server;
			const { client, mgr } = setup(undefined, { trustKnownHosts: true });

			await withKnownHosts({ known_hosts: keyLine(CLIENT_KEY, "127.0.0.1", mock.port) }, () =>
				runTest(mgr, client, testMessage("new-host", mock.port), (first) => {
					expect(first).toMatchObject({
						type: "HOST_VERIFY",
						knownHosts: { verdict: "other-key" },
					});
				}),
			);
			expect(mock.auth.attempts).toBe(0);
		});

		it("still asks when the key changed under a pin, under trust_known_hosts", async () => {
			const mock = await sshServer();
			server = mock.server;
			const { client, mgr, updateHostFingerprint } = setup(
				{
					type: "ssh",
					sshHost: "127.0.0.1",
					sshPort: mock.port,
					fingerprint: "SHA256:pinned-other",
				},
				{ trustKnownHosts: true },
			);

			await withKnownHosts({ known_hosts: keyLine(HOST_KEY, "127.0.0.1", mock.port) }, () =>
				runTest(mgr, client, testMessage("saved-host", mock.port), (first) => {
					expect(first).toMatchObject({
						type: "HOST_VERIFY",
						oldFingerprint: "SHA256:pinned-other",
						knownHosts: { verdict: "trusted" },
					});
					expect(first).not.toHaveProperty("firstConnect");
				}),
			);
			expect(updateHostFingerprint).not.toHaveBeenCalled();
		});

		// A revocation the read that decides sees, though the attempt's own read
		// did not: a file that changed, or became readable, in between.
		it("refuses a key found revoked when it decides", async () => {
			const mock = await sshServer();
			server = mock.server;
			const { ctx, client, mgr, updateHostFingerprint } = setup(
				{ type: "ssh", sshHost: "127.0.0.1", sshPort: mock.port, fingerprint: null },
				{ trustKnownHosts: true },
			);
			const message = testMessage("saved-host", mock.port);
			trustTested(ctx, message, CACHED_OTHER);
			const cacheBefore = cachedEntries(ctx.trustedOnceFingerprints);

			await withKnownHosts({}, async (ssh) => {
				const file = join(ssh, "known_hosts");
				vi.mocked(readUserKnownHosts).mockReturnValueOnce([
					{ file, contents: keyLine(HOST_KEY, "127.0.0.1", mock.port, "@revoked ") },
				]);
				await runTest(mgr, client, message, (first) => {
					expect(first).toEqual({
						type: "TEST_CONNECT_FAIL",
						hostId: "saved-host",
						message: `This host's key is marked @revoked in ${file}:1. Refusing to connect.`,
					});
				});
			});
			expect(mock.auth.attempts).toBe(0);
			expect(updateHostFingerprint).not.toHaveBeenCalled();
			expect(cachedEntries(ctx.trustedOnceFingerprints)).toEqual(cacheBefore);
		});
	});
});

describe("the connection test's platform report", { timeout: 20_000 }, () => {
	let server: SshServer | undefined;

	afterEach(() => {
		server?.close();
		server = undefined;
	});

	async function probeWith(uname: string | undefined, state: string | undefined) {
		const mock = await sshServer(uname);
		server = mock.server;
		const fingerprint = await serverFingerprint(mock.port);
		const attempt = await attemptSshTest(
			{ host: "127.0.0.1", port: mock.port, username: "tester", privateKey: CLIENT_KEY },
			new Set([fingerprint]),
			(connected) => probeTestConnectPlatform(connected, async () => state as never, "9.9.9"),
		);
		return attempt.result;
	}

	it("says the agent is at hand when the hub holds it", async () => {
		expect(await probeWith("Linux aarch64", "cached")).toEqual({
			ok: true,
			platform: {
				system: "Linux aarch64",
				os: "linux",
				arch: "arm64",
				agent: "ready",
				agentVersion: "9.9.9",
			},
		});
	});

	it("says the agent will be downloaded when the hub does not hold it", async () => {
		expect((await probeWith("Linux x86_64", "missing")).platform).toMatchObject({
			arch: "x64",
			agent: "download",
			agentVersion: "9.9.9",
		});
	});

	it("reports nothing when the remote lets nothing be read", async () => {
		expect(await probeWith(undefined, "cached")).toEqual({ ok: true });
	});
});

/** These loopback tests are run by the orchestrator, not the hermetic dispatch. */
describe("TEST_CONNECT travels the declared jump", { timeout: 25_000 }, () => {
	const key = utils.parseKey(HOST_KEY);
	if (key instanceof Error || Array.isArray(key)) throw new Error("invalid mock key");
	const publicKey = key.getPublicSSH();
	const keyType = key.type;
	const fingerprint = `SHA256:${createHash("sha256").update(publicKey).digest("base64").replace(/=+$/, "")}`;
	const cleanup: Array<() => void> = [];
	afterEach(() => {
		for (const close of cleanup.splice(0)) close();
		vi.unstubAllEnvs();
	});
	async function fixture(
		options: {
			unpinned?: boolean;
			known?: boolean;
			spec?: boolean;
			unsaved?: boolean;
			stale?: boolean;
			password?: boolean;
			/** With `password`: the one password the bastion takes. */
			jumpPassword?: string;
			refuseAuth?: boolean;
			stall?: boolean;
			revokedTarget?: boolean;
			revokedJump?: boolean;
			jumpAlias?: string;
		} = {},
	) {
		const target = await sshServer();
		cleanup.push(() => target.server.close());
		const routes: string[] = [];
		const bastionUsernames: string[] = [];
		const connections: Array<{ ended: boolean }> = [];
		const server = new Server({ hostKeys: [HOST_KEY] }, (conn) => {
			const state = { ended: false };
			connections.push(state);
			cleanup.push(() => conn.end());
			conn.on("error", () => {});
			conn.on("close", () => {
				state.ended = true;
			});
			conn.on("authentication", (auth) => {
				bastionUsernames.push(auth.username);
				if (options.refuseAuth) auth.reject();
				else if (options.password && auth.method !== "password") auth.reject(["password"]);
				else if (
					options.jumpPassword !== undefined &&
					!(auth.method === "password" && auth.password === options.jumpPassword)
				)
					auth.reject(["password"]);
				else auth.accept();
			});
			conn.on("ready", () =>
				conn.on("tcpip", (accept, _reject, info) => {
					routes.push(`${info.destIP}:${info.destPort}`);
					if (options.stall) return;
					const stream = accept();
					const onward = net.connect(target.port, "127.0.0.1");
					onward.on("error", () => stream.destroy());
					stream.on("error", () => onward.destroy());
					stream.on("close", () => onward.destroy());
					stream.pipe(onward).pipe(stream);
				}),
			);
		});
		server.on("error", () => {});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		cleanup.push(() => server.close());
		const port = (server.address() as net.AddressInfo).port;
		const spec = `tester@127.0.0.1:${port}`;
		const home = makeTempDir("lasterm-jump-home-");
		cleanup.push(() => removeTempDir(home));
		mkdirSync(join(home, ".ssh"));
		writeFileSync(
			join(home, ".ssh", "known_hosts"),
			(options.known || options.revokedJump
				? `${options.revokedJump ? "@revoked " : ""}[${options.jumpAlias ?? "127.0.0.1"}]:${port} ${keyType} ${publicKey.toString("base64")}\n`
				: "") +
				(options.revokedTarget
					? `@revoked [target]:2222 ${keyType} ${publicKey.toString("base64")}\n`
					: ""),
		);
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		// The mock accepts ssh2's initial none authentication, so it never queries
		// this agent. On Windows the address is a missing OpenSSH pipe rather than
		// a socket path, which ssh2 would read as a Cygwin agent.
		vi.stubEnv(
			"SSH_AUTH_SOCK",
			process.platform === "win32"
				? String.raw`\\.\pipe\lasterm-unused-agent-${generateId()}`
				: join(home, "unused-agent.sock"),
		);
		const { ctx, client, mgr, updateHostFingerprint } = setup();
		const updateHost = vi.fn().mockReturnValue(true);
		const hosts = new Map<string, Record<string, unknown>>();
		hosts.set("jump", {
			id: "jump",
			type: "ssh",
			sshHost: "127.0.0.1",
			sshConfigHost: options.jumpAlias,
			sshPort: port,
			sshUser: "tester",
			sshAuth: options.password ? "password" : "key",
			sshKeyPath: CLIENT_KEY_PATH,
		});
		if (!options.unsaved)
			hosts.set("saved-host", {
				id: "saved-host",
				type: "ssh",
				sshHost: "target",
				sshPort: 2222,
				sshProxySpec: options.stale ? "other-jump" : options.spec ? spec : null,
				sshProxyHostId: options.spec ? null : "jump",
				sshProxyFingerprint: options.stale ? fingerprint : null,
			});
		Object.assign(ctx.metaDal, {
			getHost: (id: string) => hosts.get(id),
			getHostFingerprint: (id: string, expectedRoute: string | null) =>
				expectedRoute !== null && id === "jump" && !options.unpinned ? fingerprint : null,
			updateHostProxyFingerprint: updateHost,
		});
		Object.assign(ctx, {
			configResolver: { sshConfig: { trustKnownHosts: options.known === true } },
		});
		const msg = {
			...testMessage(options.unsaved ? "unsaved" : "saved-host", 2222),
			hostname: "target",
			...(options.spec ? { sshProxySpec: spec } : { sshProxyHostId: "jump" }),
		};
		trustOnce(
			ctx.trustedOnceFingerprints,
			msg.hostId,
			JSON.stringify(["target", 2222, ["direct"]]),
			fingerprint,
		);
		return {
			ctx,
			client,
			mgr,
			msg,
			routes,
			hosts,
			bastionUsernames,
			connections,
			port,
			updateHost,
			updateHostFingerprint,
			targetAuth: target.auth,
			targetPort: target.port,
		};
	}
	function reply(f: Awaited<ReturnType<typeof fixture>>) {
		return f.client.send.mock.calls
			.map(([m]) => m)
			.find((m) => m.type === "TEST_CONNECT_OK" || m.type === "TEST_CONNECT_FAIL");
	}
	async function ended(f: Awaited<ReturnType<typeof fixture>>) {
		await vi.waitFor(() => expect(f.connections.every((c) => c.ended)).toBe(true), WAIT);
	}
	it("refuses a pinned revoked bastion without opening a route", async () => {
		const f = await fixture({ revokedJump: true });
		await f.mgr.handleTestConnect("c1", f.msg);
		expect(f.client.send).toHaveBeenCalledWith({
			type: "TEST_CONNECT_FAIL",
			hostId: "saved-host",
			message: `The jump host 127.0.0.1 presented a key marked @revoked in ${join(process.env.HOME!, ".ssh", "known_hosts")}:1. Nothing was connected.`,
		});
		expect(f.client.send).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: "HOST_VERIFY" }),
		);
		expect(f.routes).toEqual([]);
		expect(f.updateHostFingerprint).not.toHaveBeenCalled();
	});

	it("refuses a saved pinned bastion revoked under its config alias without opening a route", async () => {
		const f = await fixture({ revokedJump: true, jumpAlias: "alias" });
		await f.mgr.handleTestConnect("c1", f.msg);
		expect(f.client.send).toHaveBeenCalledWith({
			type: "TEST_CONNECT_FAIL",
			hostId: "saved-host",
			message: `The jump host 127.0.0.1 presented a key marked @revoked in ${join(process.env.HOME!, ".ssh", "known_hosts")}:1. Nothing was connected.`,
		});
		expect(f.client.send).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: "HOST_VERIFY" }),
		);
		expect(f.routes).toEqual([]);
		expect(f.updateHostFingerprint).not.toHaveBeenCalled();
	});

	it("routes an otherwise unreachable target through its pinned saved bastion", async () => {
		const f = await fixture({ unsaved: true });
		let dials = 0;
		const unreachable = net.createServer((socket) => {
			dials++;
			socket.destroy();
		});
		await new Promise<void>((resolve) => unreachable.listen(0, "127.0.0.1", resolve));
		cleanup.push(() => unreachable.close());
		const port = (unreachable.address() as net.AddressInfo).port;
		const msg: TestConnectMessage = { ...f.msg, hostname: "127.0.0.1", port };
		const direct = { ...msg };
		delete direct.sshProxyHostId;
		trustTested(f.ctx, direct, fingerprint);
		await f.mgr.handleTestConnect("c1", direct);
		expect(reply(f)).toMatchObject({ type: "TEST_CONNECT_FAIL" });
		expect(dials).toBe(1);
		f.client.send.mockClear();
		const done = f.mgr.handleTestConnect("c1", msg);
		const prompt = await hostVerifyPrompt(f.client);
		f.mgr.handleHostVerifyResponse(prompt.promptId, "trust_once", "c1");
		await done;
		expect(reply(f)).toMatchObject({ type: "TEST_CONNECT_OK" });
		expect(f.routes).toEqual([`127.0.0.1:${port}`, `127.0.0.1:${port}`]);
		expect(dials).toBe(1);
		await ended(f);
	});

	it.each([true, false])(
		"isolates direct trust and remembers trust through a jump (unsaved=%s)",
		async (unsaved) => {
			const f = await fixture({ unsaved });
			const cacheBefore = cachedEntries(f.ctx.trustedOnceFingerprints);
			const done = f.mgr.handleTestConnect("c1", f.msg);
			const prompt = await hostVerifyPrompt(f.client);
			expect(prompt.fingerprint).toBe(fingerprint);
			expect(f.targetAuth.attempts).toBe(0);
			f.mgr.handleHostVerifyResponse(prompt.promptId, "trust_once", "c1");
			await done;
			expect(reply(f)).toMatchObject({ type: "TEST_CONNECT_OK" });
			expect(cachedEntries(f.ctx.trustedOnceFingerprints)).toEqual([
				...cacheBefore,
				[f.msg.hostId, testedRoute(f.msg, f.ctx), fingerprint],
			]);
			f.client.send.mockClear();
			await f.mgr.handleTestConnect("c1", f.msg);
			expect(reply(f)).toMatchObject({ type: "TEST_CONNECT_OK" });
			expect(f.client.send).not.toHaveBeenCalledWith(
				expect.objectContaining({ type: "HOST_VERIFY" }),
			);
			expect(f.updateHostFingerprint).not.toHaveBeenCalled();
			await ended(f);
		},
	);

	it("reuses jump A trust, but asks through jump B and direct at the same address", async () => {
		const f = await fixture({ unsaved: true });
		const other = await fixture({ unsaved: true });
		f.hosts.set("jump-b", { ...other.hosts.get("jump")!, id: "jump-b" });
		f.ctx.metaDal.getHostFingerprint = (id: string, expectedRoute: string | null) =>
			expectedRoute !== null && (id === "jump" || id === "jump-b") ? fingerprint : null;
		f.ctx.trustedOnceFingerprints.clear();
		const msg = { ...f.msg, hostname: "127.0.0.1", port: f.targetPort };
		// One host id, four routes: each route is asked about once, then trusted.
		for (const [sshProxyHostId, questions] of [
			["jump", 1],
			["jump", 0],
			["jump-b", 1],
			[null, 1],
		] as const) {
			f.client.send.mockClear();
			const declaration: TestConnectMessage = { ...msg };
			if (sshProxyHostId) declaration.sshProxyHostId = sshProxyHostId;
			else delete declaration.sshProxyHostId;
			const done = f.mgr.handleTestConnect("c1", declaration);
			if (questions === 1) {
				const prompt = await hostVerifyPrompt(f.client);
				expect(prompt.fingerprint).toBe(fingerprint);
				f.mgr.handleHostVerifyResponse(prompt.promptId, "trust_once", "c1");
			}
			await done;
			expect(reply(f)).toMatchObject({ type: "TEST_CONNECT_OK" });
			expect(
				f.client.send.mock.calls.filter(([m]) => m.type === "HOST_VERIFY"),
				String(sshProxyHostId),
			).toHaveLength(questions);
		}
		await ended(f);
		await ended(other);
	});
	it("fails when a target pin write is refused after a route edit during the question", async () => {
		const f = await fixture();
		f.ctx.trustedOnceFingerprints.clear();
		f.updateHostFingerprint.mockReturnValue(false);
		const done = f.mgr.handleTestConnect("c1", f.msg);
		const prompt = await hostVerifyPrompt(f.client);
		f.hosts.get("saved-host")!.sshHost = "edited";
		f.mgr.handleHostVerifyResponse(prompt.promptId, "trust_permanent", "c1");
		await done;
		expect(reply(f)).toMatchObject({
			type: "TEST_CONNECT_FAIL",
			message: "The host changed while connecting. Connect again.",
		});
		expect(f.routes).toHaveLength(1);
		expect(f.updateHostFingerprint).toHaveBeenCalledWith(
			"saved-host",
			fingerprint,
			testedRoute(f.msg, f.ctx),
		);
	});

	it("refuses a revoked target through a jump before asking or writing", async () => {
		const f = await fixture({ revokedTarget: true });
		f.ctx.trustedOnceFingerprints.clear();
		await f.mgr.handleTestConnect("c1", f.msg);
		expect(reply(f)).toEqual({
			type: "TEST_CONNECT_FAIL",
			hostId: "saved-host",
			message: `This host's key is marked @revoked in ${join(process.env.HOME!, ".ssh", "known_hosts")}:1. Refusing to connect.`,
		});
		expect(f.client.send).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: "HOST_VERIFY" }),
		);
		expect(f.targetAuth.attempts).toBe(0);
		expect(f.updateHostFingerprint).not.toHaveBeenCalled();
		expect(f.updateHost).not.toHaveBeenCalled();
		expect(f.ctx.trustedOnceFingerprints.size).toBe(0);
		await ended(f);
	});

	// A spec jump reads only the jumping host's own pin, so the way out the
	// message names is a saved host chosen as the jump (#1040).
	it.each([false, true])(
		"refuses an unknown bastion without a route or pin (spec=%s)",
		async (spec) => {
			const f = await fixture({ unpinned: true, spec });
			await f.mgr.handleTestConnect("c1", f.msg);
			expect(reply(f)).toMatchObject({
				type: "TEST_CONNECT_FAIL",
				message: expect.stringContaining(
					"nothing here trusts it yet. Connect to it once as a saved host and choose that host as the jump, or let Lasterm trust what your known_hosts already does.",
				),
			});
			expect(f.routes).toEqual([]);
			expect(f.updateHostFingerprint).not.toHaveBeenCalled();
			expect(f.updateHost).not.toHaveBeenCalled();
			await ended(f);
		},
	);
	it.each([false, true])("pins a known_hosts trusted bastion (spec=%s)", async (spec) => {
		const f = await fixture({ unpinned: true, known: true, spec });
		const done = f.mgr.handleTestConnect("c1", f.msg);
		const prompt = await hostVerifyPrompt(f.client);
		f.mgr.handleHostVerifyResponse(prompt.promptId, "trust_once", "c1");
		await done;
		expect(reply(f)).toMatchObject({ type: "TEST_CONNECT_OK" });
		if (spec)
			expect(f.updateHost).toHaveBeenCalledWith(
				"saved-host",
				fingerprint,
				testedRoute(f.msg, f.ctx),
			);
		else
			expect(f.updateHostFingerprint).toHaveBeenCalledWith("jump", fingerprint, expect.any(String));
		await ended(f);
	});
	it.each([{ unsaved: true }, { stale: true }])(
		"never writes a spec pin to an ineligible row: %j",
		async (mode) => {
			const f = await fixture({ ...mode, spec: true, known: true });
			const done = f.mgr.handleTestConnect("c1", f.msg);
			const prompt = await hostVerifyPrompt(f.client);
			f.mgr.handleHostVerifyResponse(prompt.promptId, "trust_once", "c1");
			await done;
			expect(reply(f)).toMatchObject({ type: "TEST_CONNECT_OK" });
			expect(f.updateHost).not.toHaveBeenCalled();
			await ended(f);
		},
	);
	it("does not inherit a pin from another saved spec", async () => {
		const f = await fixture({ spec: true, stale: true });
		await f.mgr.handleTestConnect("c1", f.msg);
		expect(reply(f)).toMatchObject({
			type: "TEST_CONNECT_FAIL",
			message: expect.stringContaining("nothing here trusts it yet"),
		});
		expect(f.routes).toEqual([]);
	});
	it.each(
		["direct", "other-spec", "host-id"].flatMap((declaration) =>
			(["trust_once", "trust_permanent"] as const).flatMap((action) =>
				[true, false].map((matchingCache) => ({ declaration, action, matchingCache })),
			),
		),
	)(
		"isolates saved pins while caching the tested edited route (%j)",
		async ({ declaration, action, matchingCache }) => {
			const f = await fixture({ spec: true, known: true });
			const saved = f.hosts.get("saved-host")!;
			saved.sshProxySpec = declaration === "other-spec" ? "other-jump" : null;
			if (declaration === "host-id") {
				delete f.msg.sshProxySpec;
				f.msg.sshProxyHostId = "jump";
			}
			if (!matchingCache) trustTested(f.ctx, f.msg, "SHA256:previous-cache-key");
			const cacheBefore = cachedEntries(f.ctx.trustedOnceFingerprints);
			f.ctx.metaDal.getHostFingerprint = (id: string) =>
				id === "saved-host" ? "SHA256:saved-row-pin" : fingerprint;
			if (matchingCache) trustTested(f.ctx, f.msg, fingerprint);
			const done = f.mgr.handleTestConnect("c1", f.msg);
			if (!matchingCache) {
				const prompt = await hostVerifyPrompt(f.client);
				f.mgr.handleHostVerifyResponse(prompt.promptId, action, "c1");
			}
			await done;
			expect(reply(f)).toMatchObject({ type: "TEST_CONNECT_OK" });
			if (matchingCache)
				expect(f.client.send).not.toHaveBeenCalledWith(
					expect.objectContaining({ type: "HOST_VERIFY" }),
				);
			expect(f.updateHostFingerprint).not.toHaveBeenCalledWith(
				"saved-host",
				expect.anything(),
				expect.anything(),
			);
			const tested = testedRoute(f.msg, f.ctx);
			expect(cachedEntries(f.ctx.trustedOnceFingerprints)).toEqual([
				...cacheBefore.filter(([hostId, route]) => hostId !== f.msg.hostId || route !== tested),
				[f.msg.hostId, tested, fingerprint],
			]);
			await ended(f);
		},
	);
	it.each(["spec", "trimmed-spec", "host-id", "blank-spec"])(
		"records a target key learned through its saved declaration (%s)",
		async (declaration) => {
			const f = await fixture({ spec: true, known: true });
			const saved = f.hosts.get("saved-host")!;
			if (declaration === "trimmed-spec") saved.sshProxySpec = `  ${f.msg.sshProxySpec}  `;
			if (declaration === "host-id" || declaration === "blank-spec") {
				saved.sshProxyHostId = "jump";
				saved.sshProxySpec = declaration === "blank-spec" ? "  " : null;
				delete f.msg.sshProxySpec;
				f.msg.sshProxyHostId = "jump";
			}
			f.ctx.trustedOnceFingerprints.clear();
			const done = f.mgr.handleTestConnect("c1", f.msg);
			const prompt = await hostVerifyPrompt(f.client);
			f.mgr.handleHostVerifyResponse(prompt.promptId, "trust_permanent", "c1");
			await done;
			expect(reply(f)).toMatchObject({ type: "TEST_CONNECT_OK" });
			expect(f.updateHostFingerprint).toHaveBeenCalledWith(
				"saved-host",
				prompt.fingerprint,
				expect.any(String),
			);
			await ended(f);
		},
	);
	it("asks about a matching stored target key when the jump declaration differs", async () => {
		const f = await fixture({ spec: true, stale: true, known: true });
		f.ctx.metaDal.getHostFingerprint = (id: string) => (id === "saved-host" ? fingerprint : null);
		f.ctx.trustedOnceFingerprints.clear();
		const done = f.mgr.handleTestConnect("c1", f.msg);
		const prompt = await hostVerifyPrompt(f.client);
		expect(prompt).toMatchObject({ firstConnect: true, fingerprint });
		expect(f.targetAuth.attempts).toBe(0);
		f.mgr.handleHostVerifyResponse(prompt.promptId, "trust_permanent", "c1");
		await done;
		expect(reply(f)).toMatchObject({ type: "TEST_CONNECT_OK" });
		expect(f.updateHostFingerprint).not.toHaveBeenCalledWith(
			"saved-host",
			expect.anything(),
			expect.anything(),
		);
		await ended(f);
	});
	it("uses the parsed target user for a spec jump when sshUser is empty", async () => {
		const f = await fixture({ spec: true, known: true, unsaved: true });
		const done = f.mgr.handleTestConnect("c1", {
			...f.msg,
			hostname: "parsed-user@target",
			sshUser: "",
			sshProxySpec: `127.0.0.1:${f.port}`,
		});
		const prompt = await hostVerifyPrompt(f.client);
		f.mgr.handleHostVerifyResponse(prompt.promptId, "trust_once", "c1");
		await done;
		expect(reply(f)).toMatchObject({ type: "TEST_CONNECT_OK" });
		expect(f.bastionUsernames).toContain("parsed-user");
		expect(f.targetAuth.usernames).toContain("parsed-user");
		await ended(f);
	});
	// `relay@gw:2200` is `ssh -l relay -p 2200 gw`: the saved bastion's address,
	// the jump's own user and port (#1047).
	it("tests through a saved bastion as the jump's own user, on the jump's own port", async () => {
		const f = await fixture({ known: true, unsaved: true });
		const jump = f.hosts.get("jump");
		if (!jump) throw new Error("no saved bastion");
		// Saved on a port nothing listens on: only the jump's port reaches the server.
		jump.sshPort = 1;
		const done = f.mgr.handleTestConnect("c1", {
			...f.msg,
			sshProxyUser: "relay",
			sshProxyPort: f.port,
		});
		const prompt = await hostVerifyPrompt(f.client);
		f.mgr.handleHostVerifyResponse(prompt.promptId, "trust_once", "c1");
		await done;
		expect(reply(f)).toMatchObject({ type: "TEST_CONNECT_OK" });
		expect(f.bastionUsernames).toContain("relay");
		expect(f.bastionUsernames).not.toContain("tester");
		await ended(f);
	});
	it("rejecting the target key closes the bastion and pins nothing", async () => {
		const f = await fixture({ known: true, unpinned: true });
		f.ctx.trustedOnceFingerprints.clear();
		const done = f.mgr.handleTestConnect("c1", f.msg);
		const prompt = await hostVerifyPrompt(f.client);
		f.mgr.handleHostVerifyResponse(prompt.promptId, "reject", "c1");
		await done;
		expect(reply(f)).toMatchObject({ type: "TEST_CONNECT_FAIL", message: "SSH host key rejected" });
		expect(f.updateHostFingerprint).not.toHaveBeenCalled();
		expect(f.updateHost).not.toHaveBeenCalled();
		await ended(f);
	});
	it("accepting the target key opens two routes but prompts for the bastion password once by promptId", async () => {
		const f = await fixture({ password: true });
		f.ctx.trustedOnceFingerprints.clear();
		const done = f.mgr.handleTestConnect("c1", f.msg);
		const auth = await vi.waitFor(() => {
			const m = f.client.send.mock.calls.map(([m]) => m).find((m) => m.type === "AUTH_PROMPT");
			expect(m).toBeDefined();
			return m;
		}, WAIT);
		expect(auth.hostId).toBe("jump");
		f.mgr.handleAuthPromptResponse("c1", {
			hostId: "jump",
			secret: "password",
			rememberSession: true,
			promptId: auth.promptId,
			deliveryEpoch: auth.deliveryEpoch,
		});
		const prompt = await hostVerifyPrompt(f.client);
		f.mgr.handleHostVerifyResponse(prompt.promptId, "trust_once", "c1");
		await done;
		expect(reply(f)).toMatchObject({ type: "TEST_CONNECT_OK" });
		expect(f.routes).toEqual(["target:2222", "target:2222"]);
		expect(f.client.send.mock.calls.filter(([m]) => m.type === "AUTH_PROMPT")).toHaveLength(1);
		expect(f.ctx.passphraseCache.size).toBe(0);
		await ended(f);
	});
	it("cancelling the bastion password opens no route and pins nothing", async () => {
		const f = await fixture({ password: true });
		const done = f.mgr.handleTestConnect("c1", f.msg);
		const auth = await vi.waitFor(() => {
			const m = f.client.send.mock.calls.map(([m]) => m).find((m) => m.type === "AUTH_PROMPT");
			expect(m).toBeDefined();
			return m;
		}, WAIT);
		f.mgr.handleAuthPromptResponse("c1", {
			hostId: "jump",
			secret: null,
			promptId: auth.promptId,
			deliveryEpoch: auth.deliveryEpoch,
		});
		await done;
		// Said as a cancel, which the dialog shows as nothing (#815).
		expect(reply(f)).toMatchObject({ type: "TEST_CONNECT_FAIL", code: "AUTH_CANCELLED" });
		expect(f.routes).toEqual([]);
		expect(f.connections).toEqual([]);
		expect(f.updateHostFingerprint).not.toHaveBeenCalled();
	});
	// The bastion's refused password is asked for again, under the bastion's id,
	// and the route opened again (#815).
	it("asks again for the bastion's refused password, and opens the route again", async () => {
		const f = await fixture({ password: true, jumpPassword: "bastion-password" });
		const done = f.mgr.handleTestConnect("c1", f.msg);
		const first = await answerAuthPrompt(f.client, f.mgr, 0, "wrong-password");
		const again = await answerAuthPrompt(f.client, f.mgr, 1, "bastion-password");
		// The target's key, then, through the route the right password opened.
		const prompt = await hostVerifyPrompt(f.client);
		f.mgr.handleHostVerifyResponse(prompt.promptId, "trust_once", "c1");
		await done;
		expect(reply(f)).toMatchObject({ type: "TEST_CONNECT_OK" });
		expect([first.hostId, again.hostId]).toEqual(["jump", "jump"]);
		expect(again.message).toBe("Wrong password for tester@127.0.0.1. Try again.");
		// Refused, then the route the key was read through, then the trusted one:
		// the password was asked for twice, not once more for the last route.
		expect(f.connections).toHaveLength(3);
		expect(f.routes).toEqual(["target:2222", "target:2222"]);
		expect(f.client.send.mock.calls.filter(([m]) => m.type === "AUTH_PROMPT")).toHaveLength(2);
		expect(f.ctx.passphraseCache.size).toBe(0);
		await ended(f);
	});
	it("bounds a stalled channel open and closes the bastion", async () => {
		const f = await fixture({ stall: true });
		const started = Date.now();
		await f.mgr.handleTestConnect("c1", f.msg);
		expect(reply(f)).toEqual({
			type: "TEST_CONNECT_FAIL",
			hostId: f.msg.hostId,
			message: "The jump host 127.0.0.1 timed out after 10000ms",
		});
		expect(Date.now() - started).toBeLessThan(12_000);
		expect(f.updateHostFingerprint).not.toHaveBeenCalled();
		expect(f.updateHost).not.toHaveBeenCalled();
		await ended(f);
	});
	it("preserves authentication failure on a trusted bastion", async () => {
		const f = await fixture({ refuseAuth: true });
		await f.mgr.handleTestConnect("c1", f.msg);
		expect(reply(f)).toMatchObject({
			type: "TEST_CONNECT_FAIL",
			message: "Cannot reach the jump host 127.0.0.1: All configured authentication methods failed",
		});
		// A failure, not a cancel.
		expect(reply(f)).not.toHaveProperty("code");
		expect(f.routes).toEqual([]);
		await ended(f);
	});
	it("refuses a chain with the planJump message", async () => {
		const f = await fixture();
		const msg: TestConnectMessage = { ...f.msg, sshProxySpec: "a,b" };
		delete msg.sshProxyHostId;
		await f.mgr.handleTestConnect("c1", msg);
		expect(reply(f)).toMatchObject({
			type: "TEST_CONNECT_FAIL",
			message:
				"This host is reached through 2 jumps in a row, which Lasterm does not do yet. Name the last one, or add the chain as hosts of their own.",
		});
		expect(f.connections).toEqual([]);
	});
	it("parses user@target for the route, authentication and HOST_VERIFY label", async () => {
		const f = await fixture();
		f.ctx.trustedOnceFingerprints.clear();
		const done = f.mgr.handleTestConnect("c1", { ...f.msg, hostname: "user@target", sshUser: "" });
		const prompt = await hostVerifyPrompt(f.client);
		expect(prompt.hostname).toBe("target:2222");
		f.mgr.handleHostVerifyResponse(prompt.promptId, "trust_once", "c1");
		await done;
		expect(reply(f)).toMatchObject({ type: "TEST_CONNECT_OK" });
		expect(f.routes).toEqual(["target:2222", "target:2222"]);
		expect(f.targetAuth.usernames).toContain("user");
		await ended(f);
	});
});

// ─── The connection timeout, in the form or ~/.ssh/config (#1034) ───────────
//
// These wait in real time, as the hub's timers do: the form's value is never
// under 20 s, and the test's own default is 10 s.

/** A TCP front for `targetPort` that connects to it only `delayMs` after each accept: a slow link. */
async function slowLink(
	targetPort: number,
	delayMs: number,
): Promise<{ close: () => void; port: number }> {
	const sockets: net.Socket[] = [];
	const server = net.createServer((socket) => {
		sockets.push(socket);
		socket.pause();
		socket.on("error", () => {});
		setTimeout(() => {
			if (socket.destroyed) return;
			const onward = net.connect(targetPort, "127.0.0.1");
			sockets.push(onward);
			onward.on("error", () => socket.destroy());
			socket.on("error", () => onward.destroy());
			socket.pipe(onward).pipe(socket);
			socket.resume();
		}, delayMs);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		port: (server.address() as net.AddressInfo).port,
		close: () => {
			for (const socket of sockets) socket.destroy();
			server.close();
		},
	};
}

/** A bastion routing to `targetPort`, answering a channel open after `channelDelayMs`, never when null. */
async function slowBastion(
	targetPort: number,
	channelDelayMs: number | null,
): Promise<{ close: () => void; port: number }> {
	const timers: ReturnType<typeof setTimeout>[] = [];
	const server = new Server({ hostKeys: [HOST_KEY] }, (conn) => {
		conn.on("error", () => {});
		conn.on("authentication", (auth) => auth.accept());
		conn.on("ready", () =>
			conn.on("tcpip", (accept) => {
				if (channelDelayMs === null) return;
				timers.push(
					setTimeout(() => {
						const stream = accept();
						const onward = net.connect(targetPort, "127.0.0.1");
						onward.on("error", () => stream.destroy());
						stream.on("error", () => onward.destroy());
						stream.pipe(onward).pipe(stream);
					}, channelDelayMs),
				);
			}),
		);
	});
	server.on("error", () => {});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		port: (server.address() as net.AddressInfo).port,
		close: () => {
			for (const timer of timers) clearTimeout(timer);
			server.close();
		},
	};
}

describe("TEST_CONNECT takes the host's connection timeout (#1034)", () => {
	const SLOW = 40_000;
	const closers: Array<() => void> = [];
	const emptyHome = makeTempDir("lasterm-1034-test-home-");
	let fingerprint = "";

	beforeAll(async () => {
		vi.stubEnv("HOME", emptyHome);
		vi.stubEnv("USERPROFILE", emptyHome);
		vi.stubEnv(
			"SSH_AUTH_SOCK",
			process.platform === "win32"
				? String.raw`\\.\pipe\lasterm-unused-agent-${generateId()}`
				: join(emptyHome, "unused-agent.sock"),
		);
		const mock = await sshServer();
		fingerprint = await serverFingerprint(mock.port);
		mock.server.close();
	});

	afterAll(async () => {
		for (const close of closers) close();
		vi.unstubAllEnvs();
		await removeTempDir(emptyHome);
	});

	/** A saved, pinned host behind a link that answers `delayMs` late. */
	async function slowSavedHost(delayMs: number) {
		const mock = await sshServer();
		closers.push(() => mock.server.close());
		const link = await slowLink(mock.port, delayMs);
		closers.push(link.close);
		const harness = setup({ type: "ssh", sshHost: "127.0.0.1", sshPort: link.port, fingerprint });
		return { ...harness, port: link.port };
	}

	/** The reply a test sent, and how long it took. */
	async function run(
		harness: { mgr: SshConnectionManager; client: { send: Mock } },
		msg: TestConnectMessage,
	): Promise<{ ms: number; reply: unknown }> {
		const started = Date.now();
		await harness.mgr.handleTestConnect("c1", msg);
		const reply = harness.client.send.mock.calls
			.map(([m]) => m)
			.find((m) => m.type === "TEST_CONNECT_OK" || m.type === "TEST_CONNECT_FAIL");
		return { ms: Date.now() - started, reply };
	}

	/** A saved target behind a saved, pinned bastion, both slow as told. */
	async function throughSlowJump(bannerDelayMs: number, channelDelayMs: number | null) {
		const target = await sshServer();
		closers.push(() => target.server.close());
		const bastion = await slowBastion(target.port, channelDelayMs);
		closers.push(bastion.close);
		const link = await slowLink(bastion.port, bannerDelayMs);
		closers.push(link.close);
		const harness = setup();
		const hosts = new Map<string, Record<string, unknown>>([
			[
				"jump",
				{
					id: "jump",
					type: "ssh",
					sshHost: "127.0.0.1",
					sshPort: link.port,
					sshUser: "tester",
					sshAuth: "key",
					sshKeyPath: CLIENT_KEY_PATH,
				},
			],
			[
				"saved-host",
				{
					id: "saved-host",
					type: "ssh",
					sshHost: "target",
					sshPort: 2222,
					sshProxyHostId: "jump",
					sshProxySpec: null,
				},
			],
		]);
		Object.assign(harness.ctx.metaDal, {
			getHost: (id: string) => hosts.get(id),
			getHostFingerprint: (id: string, expectedRoute: string | null) =>
				expectedRoute !== null && id === "jump" ? fingerprint : null,
			updateHostProxyFingerprint: vi.fn().mockReturnValue(true),
		});
		Object.assign(harness.ctx, { configResolver: { sshConfig: { trustKnownHosts: false } } });
		const msg: TestConnectMessage = {
			...testMessage("saved-host", 2222),
			hostname: "target",
			sshProxyHostId: "jump",
		};
		trustTested(harness.ctx, msg, fingerprint);
		return { harness, msg };
	}

	describe.concurrent("without ~/.ssh/config", () => {
		it(
			"tests a host with its connection timeout (#1034)",
			async () => {
				const host = await slowSavedHost(21_000);
				const { reply } = await run(host, {
					...testMessage("saved-host", host.port),
					connectTimeoutSeconds: 25,
				});
				expect(reply).toEqual({ type: "TEST_CONNECT_OK", hostId: "saved-host" });
			},
			SLOW,
		);

		it(
			"keeps 10 s without a connection timeout (#1034)",
			async () => {
				const host = await slowSavedHost(12_000);
				const { ms, reply } = await run(host, testMessage("saved-host", host.port));
				expect(reply).toEqual({
					type: "TEST_CONNECT_FAIL",
					hostId: "saved-host",
					message: "Connection timed out",
				});
				expect(ms).toBeGreaterThanOrEqual(9_000);
				expect(ms).toBeLessThan(12_000);
			},
			SLOW,
		);

		it(
			"ignores a connection timeout outside 20-120 seconds (#1034)",
			async () => {
				const results = await Promise.all(
					[0, 1_000_000_000, 30.5, "60"].map(async (value) => {
						const host = await slowSavedHost(12_000);
						const { ms, reply } = await run(host, {
							...testMessage("saved-host", host.port),
							connectTimeoutSeconds: value as number,
						});
						return [value, (reply as { type: string }).type, ms >= 9_000 && ms < 12_000];
					}),
				);
				expect(results).toEqual([
					[0, "TEST_CONNECT_FAIL", true],
					[1_000_000_000, "TEST_CONNECT_FAIL", true],
					[30.5, "TEST_CONNECT_FAIL", true],
					["60", "TEST_CONNECT_FAIL", true],
				]);
			},
			SLOW,
		);

		it(
			"tests through a slow jump with the connection timeout (#1034)",
			async () => {
				const { harness, msg } = await throughSlowJump(21_000, 0);
				const { reply } = await run(harness, { ...msg, connectTimeoutSeconds: 25 });
				expect(reply).toEqual({ type: "TEST_CONNECT_OK", hostId: "saved-host" });
			},
			SLOW,
		);

		it(
			"tests a jump's connection and channel each with the connection timeout (#1034)",
			async () => {
				const { harness, msg } = await throughSlowJump(12_000, 12_000);
				const { reply } = await run(harness, { ...msg, connectTimeoutSeconds: 20 });
				expect(reply).toEqual({ type: "TEST_CONNECT_OK", hostId: "saved-host" });
			},
			SLOW,
		);

		it(
			"gives up on a test's jump that never opens the route (#1034)",
			async () => {
				const { harness, msg } = await throughSlowJump(0, null);
				const { ms, reply } = await run(harness, { ...msg, connectTimeoutSeconds: 20 });
				expect(reply).toMatchObject({ type: "TEST_CONNECT_FAIL", hostId: "saved-host" });
				expect((reply as { message: string }).message).toContain(
					"The jump host 127.0.0.1 did not open a route",
				);
				expect(ms).toBeGreaterThanOrEqual(19_000);
				expect(ms).toBeLessThan(23_000);
			},
			SLOW,
		);
	});

	describe("with ~/.ssh/config", () => {
		it(
			"takes ConnectTimeout for the saved host's alias (#1034)",
			async () => {
				const home = makeTempDir("lasterm-1034-test-config-");
				try {
					mkdirSync(join(home, ".ssh"));
					writeFileSync(
						join(home, ".ssh", "config"),
						"Host slow\n  ConnectTimeout 25\nHost 127.0.0.1\n  ConnectTimeout 20\n",
					);
					vi.stubEnv("HOME", home);
					vi.stubEnv("USERPROFILE", home);
					const mock = await sshServer();
					closers.push(() => mock.server.close());
					const link = await slowLink(mock.port, 21_000);
					closers.push(link.close);
					// Saved on another port: the form changed it, and the alias stays.
					const harness = setup({
						type: "ssh",
						sshHost: "127.0.0.1",
						sshPort: 1,
						sshConfigHost: "slow",
						fingerprint,
					});
					const msg = testMessage("saved-host", link.port);
					trustTested(harness.ctx, msg, fingerprint);
					const { reply } = await run(harness, msg);
					expect(reply).toEqual({ type: "TEST_CONNECT_OK", hostId: "saved-host" });
				} finally {
					vi.stubEnv("HOME", emptyHome);
					vi.stubEnv("USERPROFILE", emptyHome);
					await removeTempDir(home);
				}
			},
			SLOW,
		);
	});
});
