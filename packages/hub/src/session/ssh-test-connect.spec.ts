import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { generateId, type TestConnectMessage } from "@lasterm/shared";
import { Server, type Server as SshServer, utils } from "ssh2";
import { afterAll, afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { sshAddress, targetRoute } from "../ssh-route.js";
import { makeTempDir, removeTempDir } from "../temp-dir.fixture.js";
import type { PromptContext, SharedSessionContext } from "./session-context.js";
import type { WsClient } from "./session-manager.js";
import { attemptSshTest, SshConnectionManager } from "./ssh-connection-manager.js";
import { probeTestConnectPlatform } from "./test-connect-platform.js";

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

afterAll(() => removeTempDir(KEY_DIR));

/**
 * An SSH server that accepts any client and counts authentication attempts.
 * With `uname`, it answers `uname -sm` with that system; any other command fails.
 */
function sshServer(
	uname?: string,
): Promise<{ server: SshServer; port: number; auth: { attempts: number; usernames: string[] } }> {
	const auth = { attempts: 0, usernames: [] as string[] };
	return new Promise((resolve) => {
		const server = new Server({ hostKeys: [HOST_KEY] }, (client) => {
			client.on("error", () => {});
			client.on("authentication", (context) => {
				auth.attempts++;
				auth.usernames.push(context.username);
				context.accept();
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

function setup(saved?: SavedHost) {
	const updateHostFingerprint = vi.fn().mockReturnValue(true);
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
			getHost: (id: string) => (saved && id === "saved-host" ? { id, ...saved } : undefined),
			getHostFingerprint: (id: string, expectedRoute: string | null) =>
				saved &&
				id === "saved-host" &&
				targetRoute({ id, ...saved }, () => undefined) === expectedRoute
					? saved.fingerprint
					: null,
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
		},
		(id) => sshAddress(ctx?.metaDal.getHost(id)),
	)!;
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
	});
}

describe("TEST_CONNECT checks the host key like a session", { timeout: 20_000 }, () => {
	let server: SshServer | undefined;

	afterEach(() => {
		server?.close();
		server = undefined;
	});

	it.each(["address", "saved-alias", "edited-alias"])(
		"checks target revocation under the eligible names (%s)",
		async (name) => {
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
					`@revoked [${name === "address" ? "127.0.0.1" : "alias"}]:${mock.port} ${key.type} ${key.getPublicSSH().toString("base64")}\n`,
				);
				vi.stubEnv("HOME", home);
				vi.stubEnv("USERPROFILE", home);
				const { ctx, client, mgr, updateHostFingerprint } = setup({
					type: "ssh",
					sshHost: name === "edited-alias" ? "127.0.0.2" : "127.0.0.1",
					sshPort: mock.port,
					sshConfigHost: "alias",
					fingerprint: null,
				});
				const done = mgr.handleTestConnect("c1", testMessage("saved-host", mock.port));
				if (name === "edited-alias") {
					const prompt = await hostVerifyPrompt(client);
					mgr.handleHostVerifyResponse(prompt.promptId, "reject", "c1");
				}
				await done;
				if (name !== "edited-alias") {
					expect(client.send).toHaveBeenCalledWith({
						type: "TEST_CONNECT_FAIL",
						hostId: "saved-host",
						message: `This host's key is marked @revoked in ${knownHosts}:1. Refusing to connect.`,
					});
					expect(client.send).not.toHaveBeenCalledWith(
						expect.objectContaining({ type: "HOST_VERIFY" }),
					);
				}
				expect(mock.auth.attempts).toBe(0);
				expect(updateHostFingerprint).not.toHaveBeenCalled();
				expect(ctx.trustedOnceFingerprints.size).toBe(0);
			} finally {
				vi.unstubAllEnvs();
				removeTempDir(home);
			}
		},
	);

	it("asks about an unknown key before authenticating, and stops when it is rejected", async () => {
		const mock = await sshServer();
		server = mock.server;
		const { client, mgr } = setup();

		const done = mgr.handleTestConnect("c1", testMessage("new-host", mock.port));
		const prompt = await hostVerifyPrompt(client);

		expect(prompt).toMatchObject({
			firstConnect: true,
			fingerprint: expect.stringMatching(/^SHA256:/),
			// The host is not saved: its address is what the dialog can name it by.
			hostname: `127.0.0.1:${mock.port}`,
		});
		expect(mock.auth.attempts, "credentials went to an unchecked server").toBe(0);
		mgr.handleHostVerifyResponse(prompt.promptId, "reject", "c1");
		await done;

		expect(client.send).toHaveBeenCalledWith({
			type: "TEST_CONNECT_FAIL",
			hostId: "new-host",
			message: "SSH host key rejected",
		});
		expect(mock.auth.attempts).toBe(0);
	});

	it.each(["trust_once", "trust_permanent"] as const)(
		"retries under a trusted key, and remembers it for the first session (%s)",
		async (action) => {
			const mock = await sshServer();
			server = mock.server;
			const { ctx, client, mgr, updateHostFingerprint } = setup();

			const done = mgr.handleTestConnect("c1", testMessage("new-host", mock.port));
			const prompt = await hostVerifyPrompt(client);
			mgr.handleHostVerifyResponse(prompt.promptId, action, "c1");
			await done;

			expect(client.send).toHaveBeenCalledWith({ type: "TEST_CONNECT_OK", hostId: "new-host" });
			expect(mock.auth.attempts).toBeGreaterThan(0);
			// An unsaved host has no row to record the key in: this hub run trusts it.
			expect(updateHostFingerprint).not.toHaveBeenCalled();
			expect(ctx.trustedOnceFingerprints.get(testedRoute(testMessage("new-host", mock.port)))).toBe(
				prompt.fingerprint,
			);
		},
	);

	it("records a trusted key on the saved host it was tested for", async () => {
		const mock = await sshServer();
		server = mock.server;
		const { client, mgr, updateHostFingerprint } = setup({
			type: "ssh",
			sshHost: "127.0.0.1",
			sshPort: mock.port,
			fingerprint: null,
		});

		const done = mgr.handleTestConnect("c1", testMessage("saved-host", mock.port));
		const prompt = await hostVerifyPrompt(client);
		mgr.handleHostVerifyResponse(prompt.promptId, "trust_permanent", "c1");
		await done;

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

			ctx.trustedOnceFingerprints.set(
				targetRoute(
					{ id: "saved-host", type: "ssh", sshHost: "127.0.0.2", sshPort: mock.port },
					() => undefined,
				)!,
				await serverFingerprint(mock.port),
			);
			const cacheBefore = new Map(ctx.trustedOnceFingerprints);
			const done = mgr.handleTestConnect("c1", testMessage("saved-host", mock.port));
			const prompt = await hostVerifyPrompt(client);
			expect(prompt.firstConnect, "the edited address is a first connection").toBe(true);
			mgr.handleHostVerifyResponse(prompt.promptId, action, "c1");
			await done;
			expect(client.send).toHaveBeenCalledWith({ type: "TEST_CONNECT_OK", hostId: "saved-host" });
			expect(updateHostFingerprint).not.toHaveBeenCalled();
			expect(ctx.trustedOnceFingerprints.size).toBe(cacheBefore.size + 1);
			expect(
				ctx.trustedOnceFingerprints.get(testedRoute(testMessage("saved-host", mock.port))),
			).toBe(prompt.fingerprint);
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
		const { client, mgr } = setup({
			type: "ssh",
			sshHost: "127.0.0.1",
			sshPort: mock.port,
			fingerprint: probe.unverifiedFingerprint ?? null,
		});

		await mgr.handleTestConnect("c1", testMessage("saved-host", mock.port));

		expect(client.send).toHaveBeenCalledWith({ type: "TEST_CONNECT_OK", hostId: "saved-host" });
		expect(client.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "HOST_VERIFY" }));
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
	const fingerprint = `SHA256:${createHash("sha256").update(publicKey).digest("base64")}`;
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
			refuseAuth?: boolean;
			stall?: boolean;
			revokedTarget?: boolean;
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
			(options.known ? `[127.0.0.1]:${port} ${keyType} ${publicKey.toString("base64")}\n` : "") +
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
		ctx.trustedOnceFingerprints.set(JSON.stringify(["target", 2222, ["direct"]]), fingerprint);
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
		await vi.waitFor(() => expect(f.connections.every((c) => c.ended)).toBe(true));
	}
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
		f.ctx.trustedOnceFingerprints.set(testedRoute(direct), fingerprint);
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
			const cacheBefore = new Map(f.ctx.trustedOnceFingerprints);
			const cacheWrite = vi.spyOn(f.ctx.trustedOnceFingerprints, "set");
			const done = f.mgr.handleTestConnect("c1", f.msg);
			const prompt = await hostVerifyPrompt(f.client);
			expect(prompt.fingerprint).toBe(fingerprint);
			expect(f.targetAuth.attempts).toBe(0);
			f.mgr.handleHostVerifyResponse(prompt.promptId, "trust_once", "c1");
			await done;
			expect(reply(f)).toMatchObject({ type: "TEST_CONNECT_OK" });
			expect(f.ctx.trustedOnceFingerprints.size).toBe(cacheBefore.size + 1);
			expect(f.ctx.trustedOnceFingerprints.get(testedRoute(f.msg, f.ctx))).toBe(fingerprint);
			expect(cacheWrite).toHaveBeenCalledWith(testedRoute(f.msg, f.ctx), fingerprint);
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
		for (const sshProxyHostId of ["jump", "jump", "jump-b", null]) {
			f.client.send.mockClear();
			const declaration: TestConnectMessage = { ...msg };
			if (sshProxyHostId) declaration.sshProxyHostId = sshProxyHostId;
			else delete declaration.sshProxyHostId;
			const cached = f.ctx.trustedOnceFingerprints.has(testedRoute(declaration, f.ctx));
			const done = f.mgr.handleTestConnect("c1", declaration);
			if (!cached) {
				const prompt = await hostVerifyPrompt(f.client);
				expect(prompt.fingerprint).toBe(fingerprint);
				f.mgr.handleHostVerifyResponse(prompt.promptId, "trust_once", "c1");
			}
			await done;
			expect(reply(f)).toMatchObject({ type: "TEST_CONNECT_OK" });
			if (cached)
				expect(f.client.send).not.toHaveBeenCalledWith(
					expect.objectContaining({ type: "HOST_VERIFY" }),
				);
		}
		expect(f.ctx.trustedOnceFingerprints.size).toBe(3);
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

	it("refuses an unknown bastion without a route or pin", async () => {
		const f = await fixture({ unpinned: true });
		await f.mgr.handleTestConnect("c1", f.msg);
		expect(reply(f)).toMatchObject({
			type: "TEST_CONNECT_FAIL",
			message: expect.stringContaining("nothing here trusts it yet"),
		});
		expect(f.routes).toEqual([]);
		expect(f.updateHostFingerprint).not.toHaveBeenCalled();
		expect(f.updateHost).not.toHaveBeenCalled();
		await ended(f);
	});
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
			if (!matchingCache)
				f.ctx.trustedOnceFingerprints.set(testedRoute(f.msg, f.ctx), "SHA256:previous-cache-key");
			const cacheBefore = new Map(f.ctx.trustedOnceFingerprints);
			f.ctx.metaDal.getHostFingerprint = (id: string) =>
				id === "saved-host" ? "SHA256:saved-row-pin" : fingerprint;
			if (matchingCache) f.ctx.trustedOnceFingerprints.set(testedRoute(f.msg, f.ctx), fingerprint);
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
			expect(f.ctx.trustedOnceFingerprints.get(testedRoute(f.msg, f.ctx))).toBe(fingerprint);
			expect(f.ctx.trustedOnceFingerprints.size).toBeGreaterThanOrEqual(cacheBefore.size);
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
		});
		expect(auth.hostId).toBe("jump");
		f.mgr.handleAuthPromptResponse("c1", "jump", "password", true, auth.promptId);
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
		});
		f.mgr.handleAuthPromptResponse("c1", "jump", null, false, auth.promptId);
		await done;
		expect(reply(f)).toMatchObject({ type: "TEST_CONNECT_FAIL" });
		expect(f.routes).toEqual([]);
		expect(f.connections).toEqual([]);
		expect(f.updateHostFingerprint).not.toHaveBeenCalled();
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
