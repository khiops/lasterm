import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HelloMessage, Host } from "@lasterm/shared";
import { encodeFrame, type ProtocolMessage } from "@lasterm/shared";
import { Server, type Server as SshServer } from "ssh2";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { type AuthPromptFn, SshAgent } from "./ssh-agent.js";

// ─── Mock agent-deployer.js for Fix B deploy-fallback tests ─────────────────
// The mock is hoisted but defaults to letting the real module through. Tests
// that need controlled deploy behaviour configure the mock per-test below.
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

const TEST_TIMEOUT = 10_000;

// Generate a host key once for all tests in this module.
const { privateKey: HOST_KEY } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	publicKeyEncoding: { type: "pkcs1", format: "pem" },
	privateKeyEncoding: { type: "pkcs1", format: "pem" },
});

// Generate a client key in PKCS#1 PEM format (required by ssh2).
// Write to a temp file so SshAgent.start() can read it via sshKeyPath.
const { privateKey: CLIENT_PRIVATE_KEY_PEM } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	publicKeyEncoding: { type: "pkcs1", format: "pem" },
	privateKeyEncoding: { type: "pkcs1", format: "pem" },
});
const KEY_TMPDIR = mkdtempSync(join(tmpdir(), "lasterm-ssh-agent-test-"));
const CLIENT_KEY_PATH = join(KEY_TMPDIR, "client.pem");
writeFileSync(CLIENT_KEY_PATH, CLIENT_PRIVATE_KEY_PEM, { mode: 0o600 });

// Generate an encrypted client key (passphrase-protected) for passphrase tests.
const PASSPHRASE = "test-passphrase-123";
const { privateKey: ENCRYPTED_PRIVATE_KEY_PEM } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	publicKeyEncoding: { type: "pkcs1", format: "pem" },
	privateKeyEncoding: {
		type: "pkcs1",
		format: "pem",
		cipher: "aes-256-cbc",
		passphrase: PASSPHRASE,
	},
});
const ENCRYPTED_KEY_PATH = join(KEY_TMPDIR, "encrypted-client.pem");
writeFileSync(ENCRYPTED_KEY_PATH, ENCRYPTED_PRIVATE_KEY_PEM, { mode: 0o600 });

/** Minimal HELLO payload used by the mock agent. */
const HELLO_MSG: HelloMessage = {
	type: "HELLO",
	version: 1,
	agentVersion: "0.0.0-test",
	capabilities: ["multiplex", "snapshot", "resize"],
};

/** Encode HELLO as a framed MessagePack buffer. */
function makeHelloFrame(): Buffer {
	return Buffer.from(encodeFrame(HELLO_MSG));
}

/**
 * Create a mock SSH server that accepts all authentication and dispatches
 * exec sessions to `onExec`.
 *
 * Returns the server and the port it is listening on.
 */
function createMockSshServer(
	onExec: (stream: NodeJS.ReadWriteStream, command: string) => void,
	opts: { rejectAuth?: boolean } = {},
): Promise<{ server: SshServer; port: number }> {
	return new Promise((resolve) => {
		const server = new Server({ hostKeys: [HOST_KEY] }, (client) => {
			// Suppress connection-level errors (e.g. KEY_EXCHANGE_FAILED when the
			// SSH client abruptly disconnects after rejecting the host key).
			client.on("error", () => {});

			client.on("authentication", (ctx) => {
				if (opts.rejectAuth) {
					ctx.reject(["publickey"]);
					return;
				}
				ctx.accept();
			});

			client.on("ready", () => {
				client.on("session", (accept) => {
					const session = accept();
					session.on("exec", (accept, _reject, info) => {
						const stream = accept();
						onExec(stream, info.command);
					});
				});
			});
		});

		// Suppress unhandled server-side errors (e.g. KEY_EXCHANGE_FAILED when
		// the client abruptly disconnects after hostVerifier returns false).
		server.on("error", () => {});

		server.listen(0, "127.0.0.1", () => {
			const addr = server.address() as { port: number };
			resolve({ server, port: addr.port });
		});
	});
}

/** Build a minimal Host object for a mock SSH server on localhost. */

/**
 * Probe the mock server on `port` once with `start(null)` to capture its
 * host-key fingerprint via the SSH_TOFU rejection path, then return it.
 * Use this fingerprint as `storedFingerprint` in subsequent `start()` calls
 * so non-TOFU tests can authenticate without triggering TOFU rejection.
 */
async function getServerFingerprint(port: number, host?: Partial<Host>): Promise<string> {
	const probeAgent = new SshAgent(makeHost(port, host));
	try {
		await probeAgent.start(null);
		// Should not reach here — start(null) always rejects with SSH_TOFU now.
		const fp = probeAgent.lastKeyVerification.capturedFingerprint;
		probeAgent.close();
		return fp;
	} catch {
		// SSH_TOFU rejection — fingerprint is captured in lastKeyVerification.
		const fp = probeAgent.lastKeyVerification.capturedFingerprint;
		probeAgent.close();
		return fp;
	}
}

function makeHost(port: number, overrides: Partial<Host> = {}): Host {
	return {
		id: "01HZ000000000000000000001",
		type: "ssh",
		label: "test-host",
		sshHost: "127.0.0.1",
		sshPort: port,
		sshAuth: "key",
		sshKeyPath: CLIENT_KEY_PATH,
		iconType: "auto",
		trustRemoteHints: "ignore",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

afterAll(() => {
	// Remove the temp directory holding the generated client key.
	rmSync(KEY_TMPDIR, { recursive: true, force: true });
});

describe("SshAgent", () => {
	// Track agents created per test so they are cleaned up in afterEach.
	let agents: SshAgent[] = [];
	let servers: SshServer[] = [];

	afterEach(async () => {
		for (const agent of agents) {
			try {
				agent.close();
			} catch {
				// already closed
			}
		}
		agents = [];

		await Promise.all(
			servers.map(
				(srv) =>
					new Promise<void>((resolve) => {
						srv.close(() => resolve());
					}),
			),
		);
		servers = [];
	});

	it(
		"connects to mock SSH server and receives HELLO",
		async () => {
			const { server, port } = await createMockSshServer((stream) => {
				// Mock agent: immediately send HELLO frame, then stay open.
				stream.write(makeHelloFrame());
			});
			servers.push(server);

			const fp = await getServerFingerprint(port);
			const agent = new SshAgent(makeHost(port));
			agents.push(agent);

			const { hello } = await agent.start(fp);

			expect(hello.type).toBe("HELLO");
			expect(hello.version).toBe(1);
			expect(hello.capabilities).toContain("multiplex");
			expect(agent.connected).toBe(true);
		},
		TEST_TIMEOUT,
	);

	it(
		"execs remote stdio agent without logging args when support is unknown",
		async () => {
			let command = "";
			const { server, port } = await createMockSshServer((stream, execCommand) => {
				command = execCommand;
				stream.write(makeHelloFrame());
			});
			servers.push(server);

			const fp = await getServerFingerprint(port);
			const agent = new SshAgent(makeHost(port), undefined, undefined, {
				logLevel: "debug",
				logFormat: "text",
			});
			agents.push(agent);

			await agent.start(fp);

			expect(command).toBe("lasterm-agent --stdio");
			expect(command).not.toContain("--log-level");
			expect(command).not.toContain("--format");
		},
		TEST_TIMEOUT,
	);

	it(
		"quotes deployed Unix remote agent path and logging values for POSIX ssh exec",
		async () => {
			const { deployAgentIfNeeded } = await import("./agent-deployer.js");
			vi.mocked(deployAgentIfNeeded).mockResolvedValueOnce({
				deployed: true,
				remoteMatchesHubVersionCache: false,
				remotePath: "/opt/Lasterm Agent/bin/agent's test$HOME",
				os: "linux",
				arch: "x64",
			});

			let command = "";
			const { server, port } = await createMockSshServer((stream, execCommand) => {
				command = execCommand;
				stream.write(makeHelloFrame());
			});
			servers.push(server);

			const fp = await getServerFingerprint(port);
			const agent = new SshAgent(makeHost(port), undefined, { binaryCache: "/tmp/fake-cache" }, {
				logLevel: "debug trace",
				logFormat: "jsonl;rm",
			} as unknown as ConstructorParameters<typeof SshAgent>[3]);
			agents.push(agent);

			await agent.start(fp);

			expect(command).toBe(
				"'/opt/Lasterm Agent/bin/agent'\\''s test$HOME' --stdio --log-level 'debug trace' --format 'jsonl;rm'",
			);
			expect(agent.deployedThisSession).toBe(true);
			expect(agent.remoteMatchesHubVersionCache).toBe(false);
		},
		TEST_TIMEOUT,
	);

	it(
		"quotes deployed Windows remote agent command with cmd.exe conventions",
		async () => {
			const { deployAgentIfNeeded } = await import("./agent-deployer.js");
			vi.mocked(deployAgentIfNeeded).mockResolvedValueOnce({
				deployed: true,
				remoteMatchesHubVersionCache: false,
				remotePath: "%LOCALAPPDATA%\\lasterm\\lasterm-agent.exe",
				os: "windows",
				arch: "x64",
			});

			let command = "";
			const { server, port } = await createMockSshServer((stream, execCommand) => {
				command = execCommand;
				stream.write(makeHelloFrame());
			});
			servers.push(server);

			const fp = await getServerFingerprint(port);
			const agent = new SshAgent(
				makeHost(port),
				undefined,
				{ binaryCache: "/tmp/fake-cache" },
				{
					logLevel: "debug",
					logFormat: "text",
				},
			);
			agents.push(agent);

			await agent.start(fp);

			expect(command).toBe(
				'"%LOCALAPPDATA%\\lasterm\\lasterm-agent.exe" --stdio --log-level "debug" --format "text"',
			);
			expect(command).not.toContain("'");
		},
		TEST_TIMEOUT,
	);

	it(
		"omits logging args for found remote agents",
		async () => {
			const { deployAgentIfNeeded } = await import("./agent-deployer.js");
			vi.mocked(deployAgentIfNeeded).mockResolvedValueOnce({
				deployed: false,
				remoteMatchesHubVersionCache: false,
				remotePath: "/usr/local/bin/lasterm-agent",
				os: "linux",
				arch: "x64",
			});

			let command = "";
			const { server, port } = await createMockSshServer((stream, execCommand) => {
				command = execCommand;
				stream.write(makeHelloFrame());
			});
			servers.push(server);

			const fp = await getServerFingerprint(port);
			const agent = new SshAgent(
				makeHost(port),
				undefined,
				{ binaryCache: "/tmp/fake-cache" },
				{
					logLevel: "debug",
					logFormat: "text",
				},
			);
			agents.push(agent);

			await agent.start(fp);

			expect(command).toBe("/usr/local/bin/lasterm-agent --stdio");
			expect(command).not.toContain("--log-level");
			expect(command).not.toContain("--format");
			expect(agent.deployedThisSession).toBe(false);
			expect(agent.remoteMatchesHubVersionCache).toBe(false);
		},
		TEST_TIMEOUT,
	);

	it(
		"records when deployer found a remote agent matching the hub-version cache",
		async () => {
			const { deployAgentIfNeeded } = await import("./agent-deployer.js");
			vi.mocked(deployAgentIfNeeded).mockResolvedValueOnce({
				deployed: false,
				remoteMatchesHubVersionCache: true,
				remotePath: "/usr/local/bin/lasterm-agent",
				os: "linux",
				arch: "x64",
			});

			const { server, port } = await createMockSshServer((stream) => {
				stream.write(makeHelloFrame());
			});
			servers.push(server);

			const fp = await getServerFingerprint(port);
			const agent = new SshAgent(makeHost(port), undefined, { binaryCache: "/tmp/fake-cache" });
			agents.push(agent);

			await agent.start(fp);

			expect(agent.deployedThisSession).toBe(false);
			expect(agent.remoteMatchesHubVersionCache).toBe(true);
		},
		TEST_TIMEOUT,
	);

	it(
		"resets remoteMatchesHubVersionCache at the start of a new connection attempt",
		async () => {
			const { server, port } = await createMockSshServer((stream) => {
				stream.write(makeHelloFrame());
			});
			servers.push(server);

			const fp = await getServerFingerprint(port);
			const agent = new SshAgent(makeHost(port));
			agent.remoteMatchesHubVersionCache = true;
			agents.push(agent);

			await agent.start(fp);

			expect(agent.remoteMatchesHubVersionCache).toBe(false);
		},
		TEST_TIMEOUT,
	);

	it(
		"SPAWN → SPAWN_OK flows correctly through SSH",
		async () => {
			const { server, port } = await createMockSshServer((stream) => {
				// Mock agent: send HELLO, then listen for SPAWN and reply with SPAWN_OK.
				stream.write(makeHelloFrame());

				const chunks: Buffer[] = [];
				stream.on("data", (data: Buffer) => {
					chunks.push(data);
					// A real agent would parse frames — for simplicity we send SPAWN_OK
					// after receiving any data, which mimics the SPAWN message arriving.
					const spawnOkMsg: ProtocolMessage = {
						type: "SPAWN_OK",
						requestId: "req-001",
						channelId: "chan-01HZ000000000000000000001",
					};
					stream.write(Buffer.from(encodeFrame(spawnOkMsg)));
					// remove listener to avoid duplicate replies
					stream.removeAllListeners("data");
				});
			});
			servers.push(server);

			const fp = await getServerFingerprint(port);
			const agent = new SshAgent(makeHost(port));
			agents.push(agent);

			await agent.start(fp);

			const spawnOkPromise = new Promise<ProtocolMessage>((resolve, reject) => {
				const timeout = setTimeout(() => reject(new Error("Timeout waiting for SPAWN_OK")), 5_000);
				agent.on("message", (msg: ProtocolMessage) => {
					if (msg.type === "SPAWN_OK") {
						clearTimeout(timeout);
						resolve(msg);
					}
				});
			});

			agent.send({
				type: "SPAWN",
				requestId: "req-001",
				shell: "/bin/sh",
				cwd: "/tmp",
				env: {},
				cols: 80,
				rows: 24,
			});

			const spawnOk = await spawnOkPromise;
			expect(spawnOk.type).toBe("SPAWN_OK");
			if (spawnOk.type === "SPAWN_OK" && "requestId" in spawnOk) {
				expect(spawnOk.requestId).toBe("req-001");
				expect(typeof spawnOk.channelId).toBe("string");
			}
		},
		TEST_TIMEOUT,
	);

	it(
		"emits error on SSH connection failure (wrong port)",
		async () => {
			// Port 1 is reserved and should refuse connections quickly.
			const agent = new SshAgent(makeHost(1));
			agents.push(agent);

			await expect(agent.start()).rejects.toThrow();
		},
		TEST_TIMEOUT,
	);

	it(
		"emits error on SSH auth failure",
		async () => {
			const { server, port } = await createMockSshServer(
				() => {
					// never called — auth is rejected
				},
				{ rejectAuth: true },
			);
			servers.push(server);

			const agent = new SshAgent(makeHost(port));
			agents.push(agent);

			await expect(agent.start()).rejects.toThrow();
		},
		TEST_TIMEOUT,
	);

	it("rejects with HELLO timeout when agent never sends HELLO", async () => {
		const { server, port } = await createMockSshServer((stream) => {
			// Mock agent: connect but never send HELLO.
			// Keep the stream open so the timeout triggers.
			stream.on("data", () => {
				// ignore incoming data
			});
		});
		servers.push(server);

		const fp = await getServerFingerprint(port);
		const agent = new SshAgent(makeHost(port));
		agents.push(agent);

		// SshAgent uses 5 s HELLO timeout — give 6 s for the test.
		await expect(agent.start(fp)).rejects.toThrow("Agent HELLO timeout");
	}, 6_000);

	it(
		"close() terminates the SSH channel and connection",
		async () => {
			const { server, port } = await createMockSshServer((stream) => {
				stream.write(makeHelloFrame());
			});
			servers.push(server);

			const fp = await getServerFingerprint(port);
			const agent = new SshAgent(makeHost(port));
			agents.push(agent);

			await agent.start(fp);
			expect(agent.connected).toBe(true);

			const closePromise = new Promise<void>((resolve) => {
				agent.once("close", () => resolve());
			});

			agent.close();

			// After close(), connected must flip immediately
			expect(agent.connected).toBe(false);

			// Wait for the close event to propagate (SSH connection ends)
			await closePromise;

			// Prevent afterEach double-close
			agents = agents.filter((a) => a !== agent);
		},
		TEST_TIMEOUT,
	);
});

describe("SshAgent — auth prompting", () => {
	let agents: SshAgent[] = [];
	let servers: SshServer[] = [];

	afterEach(async () => {
		for (const agent of agents) {
			try {
				agent.close();
			} catch {
				// already closed
			}
		}
		agents = [];

		await Promise.all(
			servers.map(
				(srv) =>
					new Promise<void>((resolve) => {
						srv.close(() => resolve());
					}),
			),
		);
		servers = [];
	});

	it(
		"key auth with encrypted key: calls promptAuth with passphrase type, connects",
		async () => {
			const { server, port } = await createMockSshServer((stream) => {
				stream.write(makeHelloFrame());
			});
			servers.push(server);

			const fp = await getServerFingerprint(port);
			const promptAuth: AuthPromptFn = vi.fn().mockResolvedValue(PASSPHRASE);
			const agent = new SshAgent(makeHost(port, { sshKeyPath: ENCRYPTED_KEY_PATH }), promptAuth);
			agents.push(agent);

			const { hello } = await agent.start(fp);
			expect(hello.type).toBe("HELLO");
			expect(promptAuth).toHaveBeenCalledOnce();
			expect(promptAuth).toHaveBeenCalledWith(
				expect.any(String),
				"passphrase",
				expect.stringContaining(ENCRYPTED_KEY_PATH),
			);
			expect(agent.connected).toBe(true);
		},
		TEST_TIMEOUT,
	);

	it(
		"key auth with encrypted key: user cancels (null) → throws 'cancelled'",
		async () => {
			const { server, port } = await createMockSshServer(() => {
				// never called — cancelled before connect
			});
			servers.push(server);

			const promptAuth: AuthPromptFn = vi.fn().mockResolvedValue(null);
			const agent = new SshAgent(makeHost(port, { sshKeyPath: ENCRYPTED_KEY_PATH }), promptAuth);
			agents.push(agent);

			await expect(agent.start()).rejects.toThrow("Authentication cancelled by user");
			expect(promptAuth).toHaveBeenCalledOnce();
		},
		TEST_TIMEOUT,
	);

	it(
		"key auth with encrypted key: no promptAuth callback → throws",
		async () => {
			const { server, port } = await createMockSshServer(() => {
				// never called
			});
			servers.push(server);

			const agent = new SshAgent(makeHost(port, { sshKeyPath: ENCRYPTED_KEY_PATH }));
			agents.push(agent);

			await expect(agent.start()).rejects.toThrow(
				"Key is passphrase-protected but no prompt callback available",
			);
		},
		TEST_TIMEOUT,
	);

	it(
		"password auth: calls promptAuth with password type, connects",
		async () => {
			const { server, port } = await createMockSshServer((stream) => {
				stream.write(makeHelloFrame());
			});
			servers.push(server);

			// Probe with key auth (no promptAuth needed) to capture the server fingerprint.
			const fp = await getServerFingerprint(port);
			const promptAuth: AuthPromptFn = vi.fn().mockResolvedValue("hunter2");
			const agent = new SshAgent(makeHost(port, { sshAuth: "password" }), promptAuth);
			agents.push(agent);

			const { hello } = await agent.start(fp);
			expect(hello.type).toBe("HELLO");
			expect(promptAuth).toHaveBeenCalledOnce();
			expect(promptAuth).toHaveBeenCalledWith(
				expect.any(String),
				"password",
				expect.stringContaining("127.0.0.1"),
			);
		},
		TEST_TIMEOUT,
	);

	it(
		"password auth: user cancels (null) → throws 'cancelled'",
		async () => {
			const { server, port } = await createMockSshServer(() => {
				// never called
			});
			servers.push(server);

			const promptAuth: AuthPromptFn = vi.fn().mockResolvedValue(null);
			const agent = new SshAgent(makeHost(port, { sshAuth: "password" }), promptAuth);
			agents.push(agent);

			await expect(agent.start()).rejects.toThrow("Authentication cancelled by user");
			expect(promptAuth).toHaveBeenCalledOnce();
		},
		TEST_TIMEOUT,
	);

	it(
		"password auth without promptAuth callback → throws",
		async () => {
			const { server, port } = await createMockSshServer(() => {
				// never called
			});
			servers.push(server);

			const agent = new SshAgent(makeHost(port, { sshAuth: "password" }));
			agents.push(agent);

			await expect(agent.start()).rejects.toThrow(
				"password auth not yet supported without promptAuth callback",
			);
		},
		TEST_TIMEOUT,
	);
});

describe("SshAgent — TOFU host key verification", () => {
	let agents: SshAgent[] = [];
	let servers: SshServer[] = [];

	afterEach(async () => {
		for (const agent of agents) {
			try {
				agent.close();
			} catch {
				// already closed
			}
		}
		agents = [];
		await Promise.all(
			servers.map(
				(srv) =>
					new Promise<void>((resolve) => {
						srv.close(() => resolve());
					}),
			),
		);
		servers = [];
	});

	it(
		"TOFU: rejects with SSH_TOFU on first connect and captures fingerprint",
		async () => {
			const { server, port } = await createMockSshServer((stream) => {
				stream.write(makeHelloFrame());
			});
			servers.push(server);

			const agent = new SshAgent(makeHost(port));
			agents.push(agent);

			// null = no stored fingerprint → should reject with SSH_TOFU
			await expect(agent.start(null)).rejects.toThrow("SSH_TOFU");

			expect(agent.lastKeyVerification.tofu).toBe(true);
			expect(agent.lastKeyVerification.mismatch).toBe(false);
			expect(agent.lastKeyVerification.capturedFingerprint).toMatch(/^SHA256:/);
		},
		TEST_TIMEOUT,
	);

	it(
		"matching fingerprint: accepts when stored fingerprint equals server key",
		async () => {
			const { server, port } = await createMockSshServer((stream) => {
				stream.write(makeHelloFrame());
			});
			servers.push(server);

			// First connect: TOFU rejects, capture fingerprint from lastKeyVerification
			const agent1 = new SshAgent(makeHost(port));
			agents.push(agent1);
			await expect(agent1.start(null)).rejects.toThrow("SSH_TOFU");
			const capturedFingerprint = agent1.lastKeyVerification.capturedFingerprint;
			agent1.close();
			agents = agents.filter((a) => a !== agent1);

			// Second connect with the stored fingerprint — should match without mismatch
			const agent2 = new SshAgent(makeHost(port));
			agents.push(agent2);
			const { keyVerification: kv2 } = await agent2.start(capturedFingerprint);

			expect(kv2.tofu).toBe(false);
			expect(kv2.mismatch).toBe(false);
			expect(kv2.capturedFingerprint).toBe(capturedFingerprint);
		},
		TEST_TIMEOUT,
	);

	it(
		"mismatch: rejects and sets mismatch flag when stored fingerprint differs",
		async () => {
			const { server, port } = await createMockSshServer((stream) => {
				stream.write(makeHelloFrame());
			});
			servers.push(server);

			// A clearly different stored fingerprint to simulate a changed host key
			const wrongFingerprint = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

			const agent = new SshAgent(makeHost(port));
			agents.push(agent);

			await expect(agent.start(wrongFingerprint)).rejects.toThrow();

			expect(agent.lastKeyVerification.mismatch).toBe(true);
			expect(agent.lastKeyVerification.capturedFingerprint).toMatch(/^SHA256:/);
			expect(agent.lastKeyVerification.capturedFingerprint).not.toBe(wrongFingerprint);
		},
		TEST_TIMEOUT,
	);

	it(
		"fingerprint format: capturedFingerprint is SHA256:<base64>",
		async () => {
			const { server, port } = await createMockSshServer((stream) => {
				stream.write(makeHelloFrame());
			});
			servers.push(server);

			const agent = new SshAgent(makeHost(port));
			agents.push(agent);

			// TOFU rejects, but still captures the fingerprint in lastKeyVerification
			await expect(agent.start(null)).rejects.toThrow("SSH_TOFU");

			// SHA256: prefix followed by base64 (standard chars + padding)
			expect(agent.lastKeyVerification.capturedFingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]+=*$/);
		},
		TEST_TIMEOUT,
	);
});

// ─── Deploy failure rejects start() — no unverified-binary fallback ───────────
//
// On a non-DeployError infrastructure failure the deploy .catch() must REJECT.
// It must NOT fall back to exec'ing whatever `lasterm-agent` is on the remote PATH:
// the deployer may have detected a mismatched/unverified binary (the one the
// replacement was meant to overwrite), so running it would be a security bypass on
// first-use / unpinned hosts. DeployError (user rejection) propagates. Separately, a
// channel that closes before the agent HELLO must reject fast rather than hang.

describe("deploy failure rejects start() — no unverified-binary fallback", () => {
	let agentsB: SshAgent[] = [];
	let serversB: SshServer[] = [];

	afterEach(async () => {
		for (const agent of agentsB) {
			try {
				agent.close();
			} catch {
				// ignore
			}
		}
		agentsB = [];
		await Promise.all(
			serversB.map(
				(srv) =>
					new Promise<void>((resolve) => {
						srv.close(() => resolve());
					}),
			),
		);
		serversB = [];
		vi.resetAllMocks();
	});

	it(
		"non-DeployError infra failure → start() rejects (no fallback to an unverified binary)",
		async () => {
			// The mock SSH server WOULD answer HELLO if a fallback exec ran — so a resolve
			// here would prove an unverified binary was executed. start() must REJECT instead.
			const { deployAgentIfNeeded } = await import("./agent-deployer.js");
			vi.mocked(deployAgentIfNeeded).mockRejectedValueOnce(
				new Error("SFTP upload failed: connection reset"),
			);

			const { server, port } = await createMockSshServer((stream) => {
				stream.write(makeHelloFrame());
			});
			serversB.push(server);

			const storedFp = await getServerFingerprint(port);
			const deployOpts = {
				binaryCache: "/tmp/fake-cache",
				hostname: "127.0.0.1",
			};

			const agent = new SshAgent(makeHost(port), undefined, deployOpts);
			agentsB.push(agent);

			// Mutation: a runAgent fallback in the deploy catch would resolve with the HELLO.
			await expect(agent.start(storedFp, null)).rejects.toThrow(/deployment failed/i);
		},
		TEST_TIMEOUT,
	);

	it(
		"DeployError still rejects start() — user-initiated rejection propagates",
		async () => {
			// If DeployError were also caught and fell back to runAgent, user
			// rejections (e.g. user denied an unknown binary) would be silently
			// ignored — a security regression. DeployError must propagate.
			const { deployAgentIfNeeded, DeployError } = await import("./agent-deployer.js");
			vi.mocked(deployAgentIfNeeded).mockRejectedValueOnce(
				new DeployError("AGENT_BINARY_REJECTED", "user denied unknown agent binary"),
			);

			const { server, port } = await createMockSshServer((stream) => {
				stream.write(makeHelloFrame());
			});
			serversB.push(server);

			const storedFp = await getServerFingerprint(port);
			const deployOpts = {
				binaryCache: "/tmp/fake-cache",
				hostname: "127.0.0.1",
			};

			const agent = new SshAgent(makeHost(port), undefined, deployOpts);
			agentsB.push(agent);

			// start() must reject WITH the DeployError — it propagates, no runAgent fallback.
			await expect(agent.start(storedFp, null)).rejects.toThrow(DeployError);
		},
		TEST_TIMEOUT,
	);

	it(
		"channel closed before HELLO → start() rejects fast (no hang)",
		async () => {
			// No deployOptions → runAgent("lasterm-agent --stdio") runs directly. The server
			// ends the exec channel without sending HELLO (remote command exited / binary
			// missing). start() must reject via the channel-close guard, not hang.
			const { server, port } = await createMockSshServer((stream) => {
				stream.end();
			});
			serversB.push(server);

			const storedFp = await getServerFingerprint(port);

			const agent = new SshAgent(makeHost(port), undefined);
			agentsB.push(agent);

			// Mutation: removing the stream "close" rejectOnce makes start() hang to HELLO timeout.
			await expect(agent.start(storedFp, null)).rejects.toThrow(
				/closed before HELLO|HELLO timeout/i,
			);
		},
		TEST_TIMEOUT,
	);
});

// ─── Fix C: deploy failure must not leak the authenticated SSH connection ──
//
// Both DeployError (user rejection) and infra failures must call cleanup()
// before rejectOnce() so the authenticated ssh2 Client is destroyed/ended.
// Without cleanup(), repeated failed deploys exhaust the remote's connection
// and file-descriptor limits (socket/session exhaustion).
//
// Strategy: spy on the SshAgent `cleanup` method; arrange deploy to reject
// with each error kind; assert cleanup was called before the rejection settles.
// Mutation oracle: removing the cleanup() call(s) from the .catch() block
// leaves the spy un-called while start() still rejects — verifying the spy
// catches the omission.

describe("deploy failure → cleanup() called before rejection (Fix C)", () => {
	let agentsC: SshAgent[] = [];
	let serversC: SshServer[] = [];

	afterEach(async () => {
		for (const agent of agentsC) {
			try {
				agent.close();
			} catch {
				// ignore
			}
		}
		agentsC = [];
		await Promise.all(
			serversC.map(
				(srv) =>
					new Promise<void>((resolve) => {
						srv.close(() => resolve());
					}),
			),
		);
		serversC = [];
		vi.resetAllMocks();
	});

	it(
		"C1: infra failure (non-DeployError) → cleanup() called before rejection",
		async () => {
			const { deployAgentIfNeeded } = await import("./agent-deployer.js");
			vi.mocked(deployAgentIfNeeded).mockRejectedValueOnce(
				new Error("SFTP upload failed: connection reset"),
			);

			const { server, port } = await createMockSshServer((stream) => {
				// Would answer HELLO if runAgent fallback ran — verifies cleanup path
				stream.write(makeHelloFrame());
			});
			serversC.push(server);

			const storedFp = await getServerFingerprint(port);
			const deployOpts = { binaryCache: "/tmp/fake-cache", hostname: "127.0.0.1" };

			const agent = new SshAgent(makeHost(port), undefined, deployOpts);
			agentsC.push(agent);

			// Spy on cleanup — it should be called before start() rejects.
			const cleanupSpy = vi.spyOn(agent as unknown as { cleanup(): void }, "cleanup");

			// Mutation oracle: without the cleanup() call, cleanupSpy is never called
			// and the SSH connection stays open after the rejection.
			await expect(agent.start(storedFp, null)).rejects.toThrow(/deployment failed/i);

			expect(cleanupSpy).toHaveBeenCalled();
		},
		TEST_TIMEOUT,
	);

	it(
		"C2: DeployError (user rejection) → cleanup() called before rejection",
		async () => {
			const { deployAgentIfNeeded, DeployError } = await import("./agent-deployer.js");
			vi.mocked(deployAgentIfNeeded).mockRejectedValueOnce(
				new DeployError("AGENT_BINARY_REJECTED", "user denied unknown agent binary"),
			);

			const { server, port } = await createMockSshServer((stream) => {
				stream.write(makeHelloFrame());
			});
			serversC.push(server);

			const storedFp = await getServerFingerprint(port);
			const deployOpts = { binaryCache: "/tmp/fake-cache", hostname: "127.0.0.1" };

			const agent = new SshAgent(makeHost(port), undefined, deployOpts);
			agentsC.push(agent);

			// Spy on cleanup — it should be called before start() rejects.
			const cleanupSpy = vi.spyOn(agent as unknown as { cleanup(): void }, "cleanup");

			// Mutation oracle: without the cleanup() call, cleanupSpy is never called
			// and the authenticated SSH connection is leaked after user rejection.
			await expect(agent.start(storedFp, null)).rejects.toThrow(DeployError);

			expect(cleanupSpy).toHaveBeenCalled();
		},
		TEST_TIMEOUT,
	);
});
