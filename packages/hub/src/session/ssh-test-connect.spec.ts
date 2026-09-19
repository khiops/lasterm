import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestConnectMessage } from "@lasterm/shared";
import { Server, type Server as SshServer } from "ssh2";
import { afterAll, afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { PromptContext, SharedSessionContext } from "./session-context.js";
import type { WsClient } from "./session-manager.js";
import { attemptSshTest, SshConnectionManager } from "./ssh-connection-manager.js";

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
const KEY_DIR = mkdtempSync(join(tmpdir(), "lasterm-test-connect-"));
const CLIENT_KEY_PATH = join(KEY_DIR, "client.pem");
writeFileSync(CLIENT_KEY_PATH, CLIENT_KEY, { mode: 0o600 });

afterAll(() => rmSync(KEY_DIR, { recursive: true, force: true }));

/** An SSH server that accepts any client, and counts authentication attempts. */
function sshServer(): Promise<{ server: SshServer; port: number; auth: { attempts: number } }> {
	const auth = { attempts: 0 };
	return new Promise((resolve) => {
		const server = new Server({ hostKeys: [HOST_KEY] }, (client) => {
			client.on("error", () => {});
			client.on("authentication", (context) => {
				auth.attempts++;
				context.accept();
			});
		});
		server.on("error", () => {});
		server.listen(0, "127.0.0.1", () => {
			resolve({ server, port: (server.address() as { port: number }).port, auth });
		});
	});
}

type SavedHost = { type: "ssh"; sshHost: string; sshPort: number; fingerprint: string | null };

function setup(saved?: SavedHost) {
	const updateHostFingerprint = vi.fn();
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
			getHostFingerprint: (id: string) => (saved && id === "saved-host" ? saved.fingerprint : null),
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

async function hostVerifyPrompt(client: { send: Mock }) {
	return vi.waitFor(() => {
		const prompt = client.send.mock.calls
			.map(([message]) => message)
			.find((message) => message.type === "HOST_VERIFY");
		if (!prompt) throw new Error("no host key prompt yet");
		return prompt as { promptId: string; fingerprint: string; firstConnect?: boolean };
	});
}

describe("TEST_CONNECT checks the host key like a session", { timeout: 20_000 }, () => {
	let server: SshServer | undefined;

	afterEach(() => {
		server?.close();
		server = undefined;
	});

	it("asks about an unknown key before authenticating, and stops when it is rejected", async () => {
		const mock = await sshServer();
		server = mock.server;
		const { client, mgr } = setup();

		const done = mgr.handleTestConnect("c1", testMessage("new-host", mock.port));
		const prompt = await hostVerifyPrompt(client);

		expect(prompt).toMatchObject({
			firstConnect: true,
			fingerprint: expect.stringMatching(/^SHA256:/),
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

	it("retries under a trusted key, and remembers it for the first session", async () => {
		const mock = await sshServer();
		server = mock.server;
		const { ctx, client, mgr, updateHostFingerprint } = setup();

		const done = mgr.handleTestConnect("c1", testMessage("new-host", mock.port));
		const prompt = await hostVerifyPrompt(client);
		mgr.handleHostVerifyResponse(prompt.promptId, "trust_permanent", "c1");
		await done;

		expect(client.send).toHaveBeenCalledWith({ type: "TEST_CONNECT_OK", hostId: "new-host" });
		expect(mock.auth.attempts).toBeGreaterThan(0);
		// An unsaved host has no row to record the key in: this hub run trusts it.
		expect(updateHostFingerprint).not.toHaveBeenCalled();
		expect(ctx.trustedOnceFingerprints.get(`127.0.0.1:${mock.port}`)).toBe(prompt.fingerprint);
	});

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
		expect(updateHostFingerprint).toHaveBeenCalledWith("saved-host", prompt.fingerprint);
	});

	it("does not apply a saved host's key to another address being tested", async () => {
		const mock = await sshServer();
		server = mock.server;
		const { client, mgr } = setup({
			type: "ssh",
			sshHost: "127.0.0.2",
			sshPort: mock.port,
			fingerprint: "SHA256:recorded-for-another-address",
		});

		const done = mgr.handleTestConnect("c1", testMessage("saved-host", mock.port));
		const prompt = await hostVerifyPrompt(client);
		expect(prompt.firstConnect, "the edited address is a first connection").toBe(true);
		mgr.handleHostVerifyResponse(prompt.promptId, "reject", "c1");
		await done;
	});

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
});
