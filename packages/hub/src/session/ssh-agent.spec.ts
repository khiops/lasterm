import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import {
	createServer as createNetServer,
	type Server as NetServer,
	connect as netConnect,
	type Socket,
} from "node:net";
import { join } from "node:path";
import type { HelloMessage, Host } from "@lasterm/shared";
import { ErrorCode, encodeFrame, type ProtocolMessage } from "@lasterm/shared";
import { Server, type Server as SshServer, utils } from "ssh2";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fingerprintOf } from "../ssh/fingerprint.js";
import { makeTempDir, removeTempDir } from "../temp-dir.fixture.js";
import { windowsLaunchCommand } from "./agent-deployer.js";
import { AuthCancelledError } from "./auth-cancelled.js";
import { type ResolvedJump, resolveJump } from "./proxy-jump.js";
import { type AuthPromptFn, buildJumpAuth, SshAgent } from "./ssh-agent.js";
import { noSshAgentMessage, sshAgentAddress } from "./ssh-agent-address.js";
import { sshExec } from "./ssh-exec.js";

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

// Whether an agent answers is the machine's; a case that needs none says so.
vi.mock("./ssh-agent-address.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./ssh-agent-address.js")>();
	return { ...actual, sshAgentAddress: vi.fn(actual.sshAgentAddress) };
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
const KEY_TMPDIR = makeTempDir("lasterm-ssh-agent-test-");
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
	opts: {
		rejectAuth?: boolean;
		/** Takes this password and nothing else, as OpenSSH does. */
		password?: string;
		/** Counts the connections it is dialled, and the passwords it refuses. */
		seen?: { connections: number; refused: number };
	} = {},
): Promise<{ server: SshServer; port: number }> {
	return new Promise((resolve) => {
		const server = new Server({ hostKeys: [HOST_KEY] }, (client) => {
			if (opts.seen) opts.seen.connections++;
			// Suppress connection-level errors (e.g. KEY_EXCHANGE_FAILED when the
			// SSH client abruptly disconnects after rejecting the host key).
			client.on("error", () => {});

			client.on("authentication", (ctx) => {
				if (opts.rejectAuth) {
					ctx.reject(["publickey"]);
					return;
				}
				if (opts.password !== undefined) {
					if (ctx.method === "password" && ctx.password === opts.password) {
						ctx.accept();
						return;
					}
					if (ctx.method === "password" && opts.seen) opts.seen.refused++;
					ctx.reject(["password"]);
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

/**
 * A mock SSH server that also answers `direct-streamlocal` — the channel type
 * an `ssh -L` to a UNIX socket opens, and the one a remote daemon is reached
 * through (#79).
 *
 * `onExec` sees every command; `socketAnswers` decides whether the socket is
 * there. A test that wants the daemon "already running" says true from the
 * start, and one that wants it started says false until the launch command
 * has run.
 */
function createMockSshServerWithSocket(
	onExec: (stream: NodeJS.ReadWriteStream, command: string) => void,
	socketAnswers: () => boolean,
	onSocket: (stream: NodeJS.ReadWriteStream, socketPath: string) => void,
): Promise<{ server: SshServer; port: number }> {
	return new Promise((resolve) => {
		const server = new Server({ hostKeys: [HOST_KEY] }, (client) => {
			client.on("error", () => {});
			client.on("authentication", (ctx) => {
				ctx.accept();
			});
			client.on("ready", () => {
				client.on("session", (accept) => {
					const session = accept();
					session.on("exec", (accept, _reject, info) => {
						const stream = accept();
						// The relay (#755), reached where the host cannot say whether
						// its socket listens: it answers as the socket does.
						if (info.command.includes("--attach")) {
							const relay = stream as unknown as NodeJS.ReadWriteStream & {
								stderr: NodeJS.WritableStream;
								exit: (code: number) => void;
							};
							relay.stderr.write("lasterm-attach: start\n");
							if (socketAnswers()) {
								relay.write(makeHelloFrame());
								return;
							}
							relay.stderr.write("lasterm-attach: nothing-listens\n");
							relay.exit(3);
							relay.end();
							return;
						}
						onExec(stream, info.command);
					});
				});
				(
					client as unknown as {
						on: (
							event: "openssh.streamlocal",
							cb: (
								accept: () => NodeJS.ReadWriteStream,
								reject: () => void,
								info: { socketPath: string },
							) => void,
						) => void;
					}
				).on("openssh.streamlocal", (accept, reject, info) => {
					if (!socketAnswers()) {
						reject();
						return;
					}
					onSocket(accept(), info.socketPath);
				});
			});
		});

		server.on("error", () => {});
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address() as { port: number };
			resolve({ server, port: addr.port });
		});
	});
}

/**
 * A mock SSH server whose sshd refuses socket forwarding, as OpenSSH does for
 * `AllowStreamLocalForwarding no` or `DisableForwarding yes`: every
 * `direct-streamlocal` channel fails with CONNECT_FAILED, the answer it also
 * gives for a socket nobody listens on (#765). `outright` answers as a server
 * that prohibits the channel type, which ssh2 does with no handler for it.
 *
 * Its commands act as a host's would: the probe of `/proc/net/unix` sees the
 * daemon listening once launched, until `--stop` stops it, and `--stdio` runs
 * an agent unless `refusesStdio`.
 */
function createForwardingRefusingServer(
	options: {
		outright?: boolean;
		alreadyListening?: boolean;
		refusesStdio?: boolean;
		refusesAttach?: boolean;
		relayPrelude?: number;
	} = {},
): {
	server: Promise<{ server: SshServer; port: number }>;
	commands: string[];
	listening: () => boolean;
	streamlocalAttempts: () => number;
	relayReceived: () => Buffer;
} {
	const commands: string[] = [];
	let listening = options.alreadyListening === true;
	let streamlocalAttempts = 0;
	let relayReceived = Buffer.alloc(0);
	const server = new Promise<{ server: SshServer; port: number }>((resolve) => {
		const srv = new Server({ hostKeys: [HOST_KEY] }, (client) => {
			client.on("error", () => {});
			client.on("authentication", (ctx) => ctx.accept());
			client.on("ready", () => {
				client.on("session", (accept) => {
					const session = accept();
					session.on("exec", (acceptExec, rejectExec, info) => {
						const command = info.command;
						commands.push(command);
						if (command.includes("--stdio") && options.refusesStdio) {
							rejectExec();
							return;
						}
						if (command.includes("--attach") && options.refusesAttach) {
							rejectExec();
							return;
						}
						const stream = acceptExec() as unknown as NodeJS.ReadWriteStream & {
							exit: (code: number) => void;
						};
						if (command.includes("--stdio")) {
							stream.write(makeHelloFrame());
							return;
						}
						// The relay (#755): the daemon's HELLO when it listens, else what
						// the relay says on stderr, with the 1 a PowerShell shell leaves.
						if (command.includes("--attach")) {
							const relay = stream as unknown as NodeJS.ReadWriteStream & {
								stderr: NodeJS.WritableStream;
								exit: (code: number) => void;
							};
							relay.stderr.write("lasterm-attach: start\n");
							if (listening) {
								if (options.relayPrelude) relay.write(Buffer.alloc(options.relayPrelude, 0x2e));
								relay.write(makeHelloFrame());
								relay.on("data", (chunk: Buffer) => {
									relayReceived = Buffer.concat([relayReceived, chunk]);
								});
								return;
							}
							relay.stderr.write("lasterm-attach: nothing-listens\n");
							relay.exit(1);
							relay.end();
							return;
						}
						if (command.includes("XDG_STATE_HOME")) {
							stream.write("/home/pi/.local/state/lasterm");
						} else if (command.includes("/proc/net/unix")) {
							stream.write(`lasterm-socket: ${listening ? "listening" : "silent"}\n`);
						} else if (command.includes("--daemon")) {
							listening = true;
							stream.write("lasterm-daemon-placement: session no-systemd-run\n");
						} else if (command.includes("--stop")) {
							listening = false;
							stream.write("stopped\n");
						}
						stream.exit(0);
						stream.end();
					});
				});
				if (options.outright) return;
				(
					client as unknown as {
						on: (
							event: "openssh.streamlocal",
							cb: (accept: unknown, reject: () => void) => void,
						) => void;
					}
				).on("openssh.streamlocal", (_accept, reject) => {
					streamlocalAttempts += 1;
					reject();
				});
			});
		});
		srv.on("error", () => {});
		srv.listen(0, "127.0.0.1", () => {
			resolve({ server: srv, port: (srv.address() as { port: number }).port });
		});
	});
	return {
		server,
		commands,
		listening: () => listening,
		streamlocalAttempts: () => streamlocalAttempts,
		relayReceived: () => relayReceived,
	};
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
		sortOrder: 0,
		os: null,
		arch: null,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

afterAll(async () => {
	// Remove the temp directory holding the generated client key.
	await removeTempDir(KEY_TMPDIR);
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
		"starts a deployed Windows agent through PowerShell, its path and arguments as data (#714)",
		async () => {
			const { deployAgentIfNeeded } = await import("./agent-deployer.js");
			vi.mocked(deployAgentIfNeeded).mockResolvedValueOnce({
				deployed: true,
				remoteMatchesHubVersionCache: false,
				remotePath: "C:\\Users\\Rémi\\AppData\\Local\\lasterm\\lasterm-agent.exe",
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

			// One command for cmd.exe and a PowerShell DefaultShell alike: nothing
			// either shell reads but words.
			expect(command).toBe(
				windowsLaunchCommand("C:\\Users\\Rémi\\AppData\\Local\\lasterm\\lasterm-agent.exe", [
					"--stdio",
					"--log-level",
					"debug",
					"--format",
					"text",
				]),
			);
			expect(command).toMatch(
				/^powershell -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/]+={0,2}$/,
			);
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
		"resets reachedRunningDaemon at the start of a new connection attempt",
		async () => {
			const { server, port } = await createMockSshServer((stream) => {
				stream.write(makeHelloFrame());
			});
			servers.push(server);

			const fp = await getServerFingerprint(port);
			const agent = new SshAgent(makeHost(port));
			agent.reachedRunningDaemon = true;
			agents.push(agent);

			await agent.start(fp);

			expect(agent.reachedRunningDaemon).toBe(false);
		},
		TEST_TIMEOUT,
	);

	it("reaches a remote daemon through its socket, and execs no agent", async () => {
		const commands: string[] = [];
		let socketPath = "";
		const { server, port } = await createMockSshServerWithSocket(
			(stream, command) => {
				commands.push(command);
				if (command.includes("XDG_STATE_HOME")) {
					stream.write("/home/pi/.local/state/lasterm");
				}
				(stream as unknown as { exit: (code: number) => void }).exit(0);
				stream.end();
			},
			() => true, // the daemon is already there
			(stream, path) => {
				socketPath = path;
				stream.write(makeHelloFrame());
			},
		);
		servers.push(server);

		const fp = await getServerFingerprint(port);
		const agent = new SshAgent(makeHost(port), undefined, undefined, undefined, true);
		agents.push(agent);

		const { hello } = await agent.start(fp);

		expect(hello.type).toBe("HELLO");
		expect(socketPath).toBe("/home/pi/.local/state/lasterm/agent.sock");
		// The agent belongs to the remote machine now, not to this connection:
		// nothing was exec'd to run it.
		expect(commands.some((c) => c.includes("--stdio"))).toBe(false);
		expect(commands.some((c) => c.includes("--daemon"))).toBe(false);
		// It was running before this connection, from whatever binary was on
		// disk then: a deploy on this connection is not what answers (#555).
		expect(agent.reachedRunningDaemon).toBe(true);
	}, 15_000);

	it("starts the daemon when the socket answers nothing, then reaches it", async () => {
		const commands: string[] = [];
		let launched = false;
		const { server, port } = await createMockSshServerWithSocket(
			(stream, command) => {
				commands.push(command);
				if (command.includes("XDG_STATE_HOME")) {
					stream.write("/home/pi/.local/state/lasterm");
				}
				if (command.includes("--daemon")) launched = true;
				(stream as unknown as { exit: (code: number) => void }).exit(0);
				stream.end();
			},
			() => launched,
			(stream) => {
				stream.write(makeHelloFrame());
			},
		);
		servers.push(server);

		const fp = await getServerFingerprint(port);
		const agent = new SshAgent(
			makeHost(port),
			undefined,
			undefined,
			{ logLevel: "info", logFormat: "jsonl", logFilesKept: 12 },
			true,
		);
		agents.push(agent);

		const { hello } = await agent.start(fp);

		expect(hello.type).toBe("HELLO");
		const launch = commands.find((c) => c.includes("--daemon"));
		expect(launch).toBeDefined();
		expect(launch).toContain("--socket /home/pi/.local/state/lasterm/agent.sock");
		// The daemon log's file count it was built with (#646).
		expect(launch).toMatch(/ --log-files-kept 12 && /);
		// This connection started it, from the binary on disk now.
		expect(agent.reachedRunningDaemon).toBe(false);
	}, 15_000);

	// A re-upload is announced once the connection knows what it reached. Beside
	// a daemon that was already running, the new agent is only on disk: the old
	// one still answers, and the host says it is outdated (#559).
	describe("announces a re-uploaded agent with what the connection reached", () => {
		const remotePath = "/home/pi/.local/bin/lasterm-agent";

		/** The deploy replaces the agent on disk, as a hash mismatch has it do. */
		async function nextDeployReplacesTheAgent(): Promise<void> {
			const { deployAgentIfNeeded } = await import("./agent-deployer.js");
			vi.mocked(deployAgentIfNeeded).mockImplementationOnce(async (_client, _host, options) => {
				options.onAgentUpdated?.(options.hostId);
				return {
					deployed: true,
					remoteMatchesHubVersionCache: false,
					remotePath,
					os: "linux",
					arch: "arm64",
				};
			});
		}

		async function reachDaemon(alreadyRunning: boolean): Promise<ReturnType<typeof vi.fn>> {
			await nextDeployReplacesTheAgent();
			let launched = alreadyRunning;
			const { server, port } = await createMockSshServerWithSocket(
				(stream, command) => {
					if (command.includes("XDG_STATE_HOME")) {
						stream.write("/home/pi/.local/state/lasterm");
					}
					if (command.includes("--daemon")) launched = true;
					(stream as unknown as { exit: (code: number) => void }).exit(0);
					stream.end();
				},
				() => launched,
				(stream) => {
					stream.write(makeHelloFrame());
				},
			);
			servers.push(server);

			const fp = await getServerFingerprint(port);
			const onAgentUpdated = vi.fn();
			const agent = new SshAgent(
				makeHost(port),
				undefined,
				{ binaryCache: "/tmp/fake-cache", onAgentUpdated },
				undefined,
				true,
			);
			agents.push(agent);
			await agent.start(fp);
			return onAgentUpdated;
		}

		it("beside a daemon that was already running", async () => {
			const onAgentUpdated = await reachDaemon(true);

			expect(onAgentUpdated.mock.calls).toEqual([
				["01HZ000000000000000000001", { besideRunningDaemon: true }],
			]);
		}, 15_000);

		it("to a daemon this connection started from it", async () => {
			const onAgentUpdated = await reachDaemon(false);

			expect(onAgentUpdated.mock.calls).toEqual([
				["01HZ000000000000000000001", { besideRunningDaemon: false }],
			]);
		}, 15_000);
	});

	it("keeps a Windows remote on stdio: no SSH channel carries a named pipe", async () => {
		const commands: string[] = [];
		const { server, port } = await createMockSshServerWithSocket(
			(stream, command) => {
				commands.push(command);
				stream.write(makeHelloFrame());
			},
			() => false,
			() => {},
		);
		servers.push(server);

		const fp = await getServerFingerprint(port, { os: "windows" });
		const agent = new SshAgent(
			makeHost(port, { os: "windows" }),
			undefined,
			undefined,
			undefined,
			true,
		);
		agents.push(agent);

		const { hello } = await agent.start(fp);

		expect(hello.type).toBe("HELLO");
		expect(commands).toEqual([windowsLaunchCommand("lasterm-agent", ["--stdio"])]);
		expect(commands.some((c) => c.includes("--daemon"))).toBe(false);
	}, 15_000);

	// A host whose sshd refuses socket forwarding (#765): the daemon cannot be
	// reached, however long the hub waits for it.
	describe("on a server that refuses socket forwarding", () => {
		async function reach(
			server: Promise<{ server: SshServer; port: number }>,
			relayFirst = false,
		): Promise<{ agent: SshAgent; refused: ReturnType<typeof vi.fn>; start: Promise<unknown> }> {
			const { server: srv, port } = await server;
			servers.push(srv);
			const fp = await getServerFingerprint(port);
			const refused = vi.fn();
			const agent = new SshAgent(
				makeHost(port),
				undefined,
				{
					binaryCache: "/tmp/fake-cache",
					onSocketForwardingRefused: refused,
					relayFirst: () => relayFirst,
				},
				undefined,
				true,
			);
			agents.push(agent);
			return { agent, refused, start: agent.start(fp) };
		}

		const launches = (commands: string[]) => commands.filter((c) => c.includes("--daemon")).length;
		const stops = (commands: string[]) => commands.filter((c) => c.includes("--stop")).length;
		const stdio = (commands: string[]) => commands.filter((c) => c.includes("--stdio")).length;

		it("keeps the daemon it started and reaches it through the relay (#755)", async () => {
			const remote = createForwardingRefusingServer();
			const { agent, refused, start } = await reach(remote.server);
			const { hello } = (await start) as { hello: HelloMessage };

			expect(hello.type).toBe("HELLO");
			expect(agent.usedRemoteDaemon).toBe(true);
			expect(agent.reachedThrough).toBe("relay");
			expect(agent.socketForwardingRefused).toBe(true);
			expect(refused).toHaveBeenCalledWith(expect.objectContaining({ id: makeHost(0).id }));
			expect(launches(remote.commands)).toBe(1);
			expect(stops(remote.commands)).toBe(0);
			expect(stdio(remote.commands)).toBe(0);
			expect(remote.listening()).toBe(true);
			const relay = remote.commands.find((c) => c.includes("--attach")) ?? "";
			expect(relay).toMatch(
				/--attach --socket \/home\/pi\/\.local\/state\/lasterm\/agent\.sock --wait [1-9]/,
			);

			// The relay is the agent's transport: what the hub sends arrives on its stdin.
			agent.send({ type: "HEARTBEAT", ts: "2026-11-22T00:00:00Z" });
			await vi.waitFor(() => expect(remote.relayReceived().length).toBeGreaterThan(0));
		}, 15_000);

		it("relays first where the channel type is refused outright, launching once", async () => {
			const remote = createForwardingRefusingServer({ outright: true });
			const { agent, start } = await reach(remote.server);
			await start;

			expect(agent.reachedThrough).toBe("relay");
			expect(agent.socketForwardingRefused).toBe(true);
			expect(launches(remote.commands)).toBe(1);
			expect(stops(remote.commands)).toBe(0);
			expect(stdio(remote.commands)).toBe(0);
		}, 15_000);

		it("relays to a daemon that was already listening, and leaves it alone", async () => {
			const remote = createForwardingRefusingServer({ alreadyListening: true, relayPrelude: 40 });
			const { agent, start } = await reach(remote.server);
			await start;

			expect(agent.reachedThrough).toBe("relay");
			expect(agent.reachedRunningDaemon).toBe(true);
			expect(launches(remote.commands)).toBe(0);
			expect(stops(remote.commands)).toBe(0);
			expect(stdio(remote.commands)).toBe(0);
		}, 15_000);

		it("goes straight to the relay for a host remembered as refusing", async () => {
			const remote = createForwardingRefusingServer({ alreadyListening: true });
			const { agent, start } = await reach(remote.server, true);
			await start;

			expect(remote.streamlocalAttempts()).toBe(0);
			expect(agent.reachedThrough).toBe("relay");
		}, 15_000);

		it("fails with the relay's reason when the relay cannot run, and never falls back to stdio", async () => {
			const remote = createForwardingRefusingServer({
				alreadyListening: true,
				refusesAttach: true,
			});
			const { start } = await reach(remote.server);

			await expect(start).rejects.toThrow(
				/could not reach the agent through its relay: the SSH server refused the command/,
			);
			expect(stdio(remote.commands)).toBe(0);
			expect(launches(remote.commands)).toBe(0);
		}, 15_000);
	});

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
				envMode: "inherit",
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

	// An SSH host stored without a method, as an internal writer can leave it, is
	// not given either (#917), which would sign in one way here and another as a
	// jump.
	it(
		"refuses a host with no sign-in method before dialling",
		async () => {
			const seen = { connections: 0, refused: 0 };
			const { server, port } = await createMockSshServer(() => {}, { seen });
			servers.push(server);
			const host = makeHost(port);
			Reflect.deleteProperty(host, "sshAuth");
			const agent = new SshAgent(host);
			agents.push(agent);

			await expect(agent.start()).rejects.toThrow("Host has no sign-in method configured");
			expect(seen.connections).toBe(0);
		},
		TEST_TIMEOUT,
	);

	// A host stored as agent signs in with the agent, whatever key path it also
	// keeps: here no agent answers, so it says so, and never reads the key (#917).
	it(
		"signs in with the agent a host stored as agent, its key path notwithstanding",
		async () => {
			vi.mocked(sshAgentAddress).mockReturnValueOnce(null);
			const seen = { connections: 0, refused: 0 };
			const { server, port } = await createMockSshServer(() => {}, { seen });
			servers.push(server);
			const agent = new SshAgent(makeHost(port, { sshAuth: "agent" }));
			agents.push(agent);

			await expect(agent.start()).rejects.toThrow(noSshAgentMessage(process.platform));
			expect(seen.connections).toBe(0);
		},
		TEST_TIMEOUT,
	);

	// `IdentityAgent none` keeps the agent out of a host stored as agent too, as
	// ssh keeps it out of `ssh box`: refused before anything is dialled (#1038).
	it(
		"refuses the agent for a host whose alias says IdentityAgent none",
		async () => {
			const home = makeTempDir("lasterm-agent-none-");
			const actualAddress = vi.mocked(sshAgentAddress).getMockImplementation();
			try {
				mkdirSync(join(home, ".ssh"));
				writeFileSync(join(home, ".ssh", "config"), "Host box\n  IdentityAgent none\n");
				vi.stubEnv("HOME", home);
				vi.stubEnv("USERPROFILE", home);
				const seen = { connections: 0, refused: 0 };
				const { server, port } = await createMockSshServer(() => {}, { seen });
				servers.push(server);
				const refusal =
					"IdentityAgent none in ~/.ssh/config keeps the SSH agent out of box, and this host signs in with the agent. Choose a key or a password for it.";

				vi.mocked(sshAgentAddress).mockReturnValueOnce(join(home, "agent.sock"));
				const withAgent = new SshAgent(makeHost(port, { sshAuth: "agent", sshConfigHost: "box" }));
				agents.push(withAgent);
				await expect(withAgent.start()).rejects.toMatchObject({ message: refusal });

				vi.mocked(sshAgentAddress).mockClear();
				vi.mocked(sshAgentAddress).mockReturnValueOnce(null);
				const noAgent = new SshAgent(makeHost(port, { sshAuth: "agent", sshConfigHost: "box" }));
				agents.push(noAgent);
				await expect(noAgent.start()).rejects.toMatchObject({ message: refusal });
				expect(sshAgentAddress).not.toHaveBeenCalled();
				expect(seen.connections).toBe(0);
				// The null queued above was never taken: drop it.
				vi.mocked(sshAgentAddress).mockReset();

				// Another alias of the same file is not concerned: it dials as before,
				// with an agent that holds nothing, and the server refuses it.
				vi.mocked(sshAgentAddress).mockReturnValue(join(home, "agent.sock"));
				const other = new SshAgent(makeHost(port, { sshAuth: "agent", sshConfigHost: "other" }));
				agents.push(other);
				const otherFailure = await other.start().then(
					() => null,
					(error: unknown) => error,
				);
				expect(otherFailure).toBeInstanceOf(Error);
				expect((otherFailure as Error).message).not.toBe(refusal);
				expect(seen.connections).toBe(1);
			} finally {
				vi.mocked(sshAgentAddress).mockReset();
				if (actualAddress) vi.mocked(sshAgentAddress).mockImplementation(actualAddress);
				vi.unstubAllEnvs();
				await removeTempDir(home);
			}
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

	// A PowerShell starts a Windows agent, after the account's profile when the
	// DefaultShell is PowerShell: six seconds on a development machine (#714).
	it("waits past 5 s for the HELLO of a Windows agent, which a PowerShell starts (#714)", async () => {
		const { server, port } = await createMockSshServer((stream) => {
			setTimeout(() => {
				try {
					stream.write(makeHelloFrame());
				} catch {
					// The connection is gone: the assertion below says so.
				}
			}, 6_000);
		});
		servers.push(server);

		const fp = await getServerFingerprint(port, { os: "windows" });
		const agent = new SshAgent(makeHost(port, { os: "windows" }));
		agents.push(agent);

		const { hello } = await agent.start(fp);
		expect(hello.type).toBe("HELLO");
	}, 15_000);

	// ─── What the remote shell prints before the agent (#749) ────────────────
	// A PowerShell DefaultShell runs the account's profile before every command,
	// the agent's included, and cmd.exe its AutoRun: whatever they print reaches
	// the hub ahead of the agent's first frame.

	/** What a chatty profile prints: text, a prompt module's escapes, and bytes that look like a frame's start. */
	const PROFILE_PRELUDE = Buffer.concat([
		Buffer.from("Loading personal and system profiles took 6012ms.\r\n"),
		Buffer.from("\u001b]0;posh\u0007\u001b[32mWelcome, Zoë\u001b[0m\r\n"),
		// A length prefix of 5, then a msgpack map that is no HELLO; then one
		// whose length runs over the real frame.
		Buffer.from([5, 0, 0, 0, 0x81, 0xa1, 0x61, 0xa1, 0x62, 0x40, 0, 0, 0]),
	]);

	it("skips what the remote shell printed before the agent's HELLO (#749)", async () => {
		const hello = makeHelloFrame();
		const after = Buffer.from(encodeFrame({ type: "HEARTBEAT_ACK", ts: "after" }));
		const { server, port } = await createMockSshServer((stream) => {
			// In pieces, as a pipe hands them on: the profile's bytes, then HELLO
			// cut in two, the second half with the frame after it.
			stream.write(PROFILE_PRELUDE);
			setTimeout(() => stream.write(hello.subarray(0, 3)), 50);
			setTimeout(() => stream.write(Buffer.concat([hello.subarray(3), after])), 100);
		});
		servers.push(server);

		const fp = await getServerFingerprint(port, { os: "windows" });
		const agent = new SshAgent(makeHost(port, { os: "windows" }));
		agents.push(agent);
		const messages: ProtocolMessage[] = [];
		agent.on("message", (message: ProtocolMessage) => messages.push(message));

		const { hello: received } = await agent.start(fp);

		expect(received).toEqual(HELLO_MSG);
		await vi.waitFor(() => expect(messages.map((m) => m.type)).toEqual(["HELLO", "HEARTBEAT_ACK"]));
		expect(messages[1]).toEqual({ type: "HEARTBEAT_ACK", ts: "after" });
	}, 15_000);

	it.each([
		["windows", "check the PowerShell profile of zoë"],
		["linux", "check the shell startup files of zoë"],
	] as const)(
		"names the shell and the account when a %s host prints past the limit, never saying HELLO (#749)",
		async (os, check) => {
			const { server, port } = await createMockSshServer((stream) => {
				const line = Buffer.from(`${"profile output ".repeat(7)}\r\n`);
				const chunk = Buffer.concat(Array.from({ length: 64 }, () => line));
				for (let i = 0; i < 24; i++) stream.write(chunk);
			});
			servers.push(server);

			const fp = await getServerFingerprint(port, { os });
			const agent = new SshAgent(makeHost(port, { os, sshUser: "zoë" }));
			agents.push(agent);

			const error = await agent.start(fp).catch((error: unknown) => error);

			expect((error as Error).message).toMatch(
				new RegExp(
					`^Agent HELLO not found: the remote shell printed \\d+ bytes before the agent started; ${check}$`,
				),
			);
			const bytes = Number(/printed (\d+) bytes/.exec((error as Error).message)?.[1]);
			expect(bytes).toBeGreaterThan(128 * 1024);
		},
		15_000,
	);

	it("says what the shell printed when the channel closes before HELLO (#749)", async () => {
		const { server, port } = await createMockSshServer((stream) => {
			const channel = stream as NodeJS.ReadWriteStream & { exit: (code: number) => void };
			stream.write("Welcome!\r\n");
			setTimeout(() => {
				channel.exit(1);
				stream.end();
			}, 50);
		});
		servers.push(server);

		const fp = await getServerFingerprint(port, { os: "windows" });
		const agent = new SshAgent(makeHost(port, { os: "windows", sshUser: "zoe" }));
		agents.push(agent);

		await expect(agent.start(fp)).rejects.toThrow(
			"Agent channel closed before HELLO: the remote shell printed 10 bytes before the agent started; check the PowerShell profile of zoe",
		);
	}, 15_000);

	it("says what the shell printed when HELLO does not come in time (#749)", async () => {
		const { server, port } = await createMockSshServer((stream) => {
			stream.write(PROFILE_PRELUDE);
		});
		servers.push(server);

		const fp = await getServerFingerprint(port);
		const agent = new SshAgent(makeHost(port, { sshUser: "zoe" }));
		agents.push(agent);

		await expect(agent.start(fp)).rejects.toThrow(
			`Agent HELLO timeout: the remote shell printed ${PROFILE_PRELUDE.length} bytes before the agent started; check the shell startup files of zoe`,
		);
	}, 10_000);

	// Every command pays the shell's start-up, the agent's too: the deploy's
	// first command measured it, and the HELLO wait adds it (#749).
	it("waits for HELLO as long again as the deploy's first command took (#749)", async () => {
		const { deployAgentIfNeeded } = await import("./agent-deployer.js");
		vi.mocked(deployAgentIfNeeded).mockImplementationOnce(async (client) => {
			await sshExec(client, "first command");
			return {
				deployed: false,
				remoteMatchesHubVersionCache: false,
				remotePath: "lasterm-agent",
				os: "linux",
				arch: "x64",
			};
		});
		const { server, port } = await createMockSshServer((stream, command) => {
			const channel = stream as NodeJS.ReadWriteStream & { exit: (code: number) => void };
			if (command === "first command") {
				// A shell that takes three seconds to start.
				setTimeout(() => {
					channel.exit(0);
					stream.end();
				}, 3_000);
				return;
			}
			// The agent says HELLO past 5 s, within 5 s and the shell's three.
			setTimeout(() => {
				try {
					stream.write(makeHelloFrame());
				} catch {
					// The connection is gone: the assertion below says so.
				}
			}, 6_500);
		});
		servers.push(server);

		const fp = await getServerFingerprint(port);
		const agent = new SshAgent(makeHost(port), undefined, { binaryCache: "/tmp/fake-cache" });
		agents.push(agent);

		const { hello } = await agent.start(fp);
		expect(hello.type).toBe("HELLO");
	}, 20_000);

	// ─── A malformed frame from the agent (#763) ───────────────────────────────
	// A frame that does not decode used to throw out of the channel's "data"
	// listener, into ssh2's dispatch or past it, which could end the hub. It
	// ends that connection, and only that one.

	describe("a malformed frame from the agent (#763)", () => {
		/** What the agent types into a terminal: it must reach no log and no error. */
		const TYPED = "typed-by-the-user";

		/** `payload` behind its length prefix. */
		function frameOf(payload: Buffer): Buffer {
			const prefix = Buffer.alloc(4);
			prefix.writeUInt32LE(payload.length, 0);
			return Buffer.concat([prefix, payload]);
		}

		const MALFORMED = [
			[
				"a length prefix past the frame size limit",
				Buffer.from([0xff, 0xff, 0xff, 0xff]),
				"a length prefix of 4294967295 bytes, past the 10485760-byte limit",
			],
			[
				"a payload that is not MessagePack",
				frameOf(Buffer.concat([Buffer.from([0xc1]), Buffer.from(TYPED)])),
				"a payload that is not a protocol message",
			],
		] as const;

		/** Start an agent, and wait for it to end with the error it emits. */
		function ending(agent: SshAgent): Promise<Error[]> {
			const errors: Error[] = [];
			agent.on("error", (error: Error) => errors.push(error));
			return new Promise((resolve) => agent.once("close", () => resolve(errors)));
		}

		/** The other connection still reads what its agent says. */
		async function stillReads(agent: SshAgent, stream: NodeJS.ReadWriteStream): Promise<void> {
			expect(agent.connected).toBe(true);
			const ack = new Promise<ProtocolMessage>((resolve) => {
				agent.on("message", (msg: ProtocolMessage) => {
					if (msg.type === "HEARTBEAT_ACK") resolve(msg);
				});
			});
			stream.write(Buffer.from(encodeFrame({ type: "HEARTBEAT_ACK", ts: "still here" })));
			expect(await ack).toEqual({ type: "HEARTBEAT_ACK", ts: "still here" });
		}

		it.each(MALFORMED)(
			"closes that stdio connection alone on %s, and says so at WARN without its bytes",
			async (_what, bytes, reason) => {
				const streams: NodeJS.ReadWriteStream[] = [];
				const { server, port } = await createMockSshServer((stream) => {
					streams.push(stream);
					stream.write(makeHelloFrame());
				});
				servers.push(server);
				const fp = await getServerFingerprint(port);
				const agent = new SshAgent(makeHost(port));
				const other = new SshAgent(makeHost(port, { label: "other-host" }));
				agents.push(agent, other);
				await agent.start(fp);
				await other.start(fp);
				const warn = vi.spyOn(console, "warn");
				try {
					const ended = ending(agent);
					streams[0]?.write(bytes);
					const errors = await ended;

					const message = `The agent on test-host sent a malformed frame: ${reason}`;
					expect(errors.map((error) => error.message)).toEqual([message]);
					expect(agent.connected).toBe(false);
					expect(warn.mock.calls).toEqual([[`[lasterm-ssh] ${message}; closing the connection`]]);
					await stillReads(other, streams[1] as NodeJS.ReadWriteStream);
				} finally {
					warn.mockRestore();
				}
			},
			TEST_TIMEOUT,
		);

		it.each(MALFORMED)(
			"fails start() with that error when %s comes with HELLO",
			async (_what, bytes, reason) => {
				const { server, port } = await createMockSshServer((stream) => {
					stream.write(Buffer.concat([makeHelloFrame(), bytes]));
				});
				servers.push(server);
				const fp = await getServerFingerprint(port);
				const agent = new SshAgent(makeHost(port));
				agents.push(agent);

				await expect(agent.start(fp)).rejects.toThrow(
					`The agent on test-host sent a malformed frame: ${reason}`,
				);
			},
			TEST_TIMEOUT,
		);

		it.each(MALFORMED)(
			"closes that connection to a remote daemon's socket alone on %s",
			async (_what, bytes, reason) => {
				const { deployAgentIfNeeded } = await import("./agent-deployer.js");
				vi.mocked(deployAgentIfNeeded).mockResolvedValue({
					deployed: false,
					remoteMatchesHubVersionCache: false,
					remotePath: "/home/pi/.local/bin/lasterm-agent",
					os: "linux",
					arch: "arm64",
				});
				const sockets: NodeJS.ReadWriteStream[] = [];
				const { server, port } = await createMockSshServerWithSocket(
					(stream, command) => {
						if (command.includes("XDG_STATE_HOME")) {
							stream.write("/home/pi/.local/state/lasterm");
						}
						(stream as unknown as { exit: (code: number) => void }).exit(0);
						stream.end();
					},
					() => true,
					(stream) => {
						sockets.push(stream);
						stream.write(makeHelloFrame());
					},
				);
				servers.push(server);
				const fp = await getServerFingerprint(port);
				const daemonAgent = (label: string): SshAgent =>
					new SshAgent(
						makeHost(port, { label }),
						undefined,
						{ binaryCache: "/tmp/fake-cache" },
						undefined,
						true,
					);
				const agent = daemonAgent("test-host");
				const other = daemonAgent("other-host");
				agents.push(agent, other);
				try {
					await agent.start(fp);
					await other.start(fp);
					expect(agent.usedRemoteDaemon).toBe(true);

					const ended = ending(agent);
					sockets[0]?.write(bytes);
					const errors = await ended;

					expect(errors.map((error) => error.message)).toEqual([
						`The agent on test-host sent a malformed frame: ${reason}`,
					]);
					await stillReads(other, sockets[1] as NodeJS.ReadWriteStream);
				} finally {
					vi.mocked(deployAgentIfNeeded).mockResolvedValue({
						deployed: false,
						remoteMatchesHubVersionCache: false,
						remotePath: "lasterm-agent",
						os: null,
						arch: null,
					});
				}
			},
			15_000,
		);
	});

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

			const started = agent.start();
			await expect(started).rejects.toThrow("Authentication cancelled by user");
			// Said as a cancel, not a failure: the pane shows no reason for it (#812).
			await expect(started).rejects.toBeInstanceOf(AuthCancelledError);
			await expect(started).rejects.toMatchObject({ code: ErrorCode.AUTH_CANCELLED });
			expect(promptAuth).toHaveBeenCalledOnce();
		},
		TEST_TIMEOUT,
	);

	// As OpenSSH does: a wrong passphrase is asked for again, saying so, and the
	// prompt is told, so that a cache never gives the wrong one back (#812).
	it(
		"key auth with encrypted key: a wrong passphrase is asked for again, then connects",
		async () => {
			const { server, port } = await createMockSshServer((stream) => {
				stream.write(makeHelloFrame());
			});
			servers.push(server);

			const fp = await getServerFingerprint(port);
			const promptAuth = vi
				.fn<AuthPromptFn>()
				.mockResolvedValueOnce("not-the-passphrase")
				.mockResolvedValueOnce(PASSPHRASE);
			const host = makeHost(port, { sshKeyPath: ENCRYPTED_KEY_PATH });
			const agent = new SshAgent(host, promptAuth);
			agents.push(agent);

			const { hello } = await agent.start(fp);
			expect(hello.type).toBe("HELLO");
			expect(agent.connected).toBe(true);
			expect(promptAuth).toHaveBeenCalledTimes(2);
			expect(promptAuth).toHaveBeenNthCalledWith(
				1,
				host.id,
				"passphrase",
				`Enter passphrase for ${ENCRYPTED_KEY_PATH}`,
			);
			expect(promptAuth).toHaveBeenNthCalledWith(
				2,
				host.id,
				"passphrase",
				`Wrong passphrase for ${ENCRYPTED_KEY_PATH}. Try again.`,
				{ previousRejected: true },
			);
		},
		TEST_TIMEOUT,
	);

	it(
		"key auth with encrypted key: a wrong passphrase, then a cancel, throws the cancel",
		async () => {
			const { server, port } = await createMockSshServer(() => {
				// never called — cancelled before connect
			});
			servers.push(server);

			const promptAuth = vi
				.fn<AuthPromptFn>()
				.mockResolvedValueOnce("not-the-passphrase")
				.mockResolvedValueOnce(null);
			const agent = new SshAgent(makeHost(port, { sshKeyPath: ENCRYPTED_KEY_PATH }), promptAuth);
			agents.push(agent);

			await expect(agent.start()).rejects.toBeInstanceOf(AuthCancelledError);
			expect(promptAuth).toHaveBeenCalledTimes(2);
			expect(promptAuth).toHaveBeenLastCalledWith(
				expect.any(String),
				"passphrase",
				expect.stringMatching(/^Wrong passphrase/),
				{ previousRejected: true },
			);
		},
		TEST_TIMEOUT,
	);

	// A jump's key is asked for under the jump's id, and asked again the same way.
	it("a jump's wrong passphrase is asked for again, for the jump", async () => {
		const promptAuth = vi
			.fn<AuthPromptFn>()
			.mockResolvedValueOnce("not-the-passphrase")
			.mockResolvedValueOnce(PASSPHRASE);

		const config = await buildJumpAuth(
			{
				jump: { host: "bastion.example.test", port: 22, username: "ops" },
				knownHostsNames: ["bastion.example.test"],
				auth: { method: "key", keyPath: ENCRYPTED_KEY_PATH },
				promptHostId: "host-bastion",
				pinnedFingerprint: null,
				trustKnownHosts: false,
				pinTo: { kind: "host", hostId: "host-bastion", expectedRoute: null },
			},
			promptAuth,
		);

		expect(config.passphrase).toBe(PASSPHRASE);
		expect(promptAuth.mock.calls.map(([hostId, , , options]) => [hostId, options])).toEqual([
			["host-bastion", undefined],
			["host-bastion", { previousRejected: true }],
		]);
	});

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

			const started = agent.start();
			await expect(started).rejects.toThrow("Authentication cancelled by user");
			await expect(started).rejects.toBeInstanceOf(AuthCancelledError);
			expect(promptAuth).toHaveBeenCalledOnce();
		},
		TEST_TIMEOUT,
	);

	// As OpenSSH does: a password the server refused is asked for again, saying
	// so, and the host dialled again, under the key already checked (#815).
	it(
		"password auth: a password the server refused is asked for again, then connects",
		async () => {
			const seen = { connections: 0, refused: 0 };
			const { server, port } = await createMockSshServer(
				(stream) => {
					stream.write(makeHelloFrame());
				},
				{ password: "right-password", seen },
			);
			servers.push(server);

			const fp = await getServerFingerprint(port);
			seen.connections = 0;
			const promptAuth = vi
				.fn<AuthPromptFn>()
				.mockResolvedValueOnce("wrong-password")
				.mockResolvedValueOnce("right-password");
			const host = makeHost(port, { sshAuth: "password", sshUser: "tester" });
			const agent = new SshAgent(host, promptAuth);
			agents.push(agent);

			const { hello } = await agent.start(fp);
			expect(hello.type).toBe("HELLO");
			expect(agent.connected).toBe(true);
			expect(promptAuth.mock.calls).toEqual([
				[host.id, "password", "Enter password for tester@127.0.0.1"],
				[
					host.id,
					"password",
					"Wrong password for tester@127.0.0.1. Try again.",
					{ previousRejected: true },
				],
			]);
			expect(seen).toEqual({ connections: 2, refused: 1 });
		},
		TEST_TIMEOUT,
	);

	it(
		"password auth: a refused password, then a cancel, throws the cancel",
		async () => {
			const seen = { connections: 0, refused: 0 };
			const { server, port } = await createMockSshServer(() => {}, {
				password: "right-password",
				seen,
			});
			servers.push(server);

			const fp = await getServerFingerprint(port);
			seen.connections = 0;
			const promptAuth = vi
				.fn<AuthPromptFn>()
				.mockResolvedValueOnce("wrong-password")
				.mockResolvedValueOnce(null);
			const agent = new SshAgent(makeHost(port, { sshAuth: "password" }), promptAuth);
			agents.push(agent);

			const started = agent.start(fp);
			await expect(started).rejects.toBeInstanceOf(AuthCancelledError);
			await expect(started).rejects.toMatchObject({ code: ErrorCode.AUTH_CANCELLED });
			expect(promptAuth).toHaveBeenCalledTimes(2);
			// Nothing was dialled for the cancel.
			expect(seen).toEqual({ connections: 1, refused: 1 });
		},
		TEST_TIMEOUT,
	);

	// Only a password sent and refused is asked for again: a server that takes
	// none, or one that cannot be reached, fails as before, asked once.
	it.each([
		["a server that takes no password", "takes-none"],
		["a host that cannot be reached", "unreachable"],
	] as const)(
		"password auth: %s is not asked for another password",
		async (_name, kind) => {
			const { server, port } = await createMockSshServer(() => {}, { rejectAuth: true });
			servers.push(server);
			const fp = await getServerFingerprint(port);
			if (kind === "unreachable") {
				// Nothing listens on the port any more: the dial is refused.
				await new Promise<void>((resolve) => server.close(() => resolve()));
				servers = servers.filter((candidate) => candidate !== server);
			}

			const promptAuth = vi.fn<AuthPromptFn>().mockResolvedValue("some-password");
			const agent = new SshAgent(makeHost(port, { sshAuth: "password" }), promptAuth);
			agents.push(agent);

			await expect(agent.start(fp)).rejects.toThrow(
				kind === "takes-none" ? "All configured authentication methods failed" : /ECONNREFUSED/,
			);
			expect(promptAuth).toHaveBeenCalledOnce();
		},
		TEST_TIMEOUT,
	);

	// A jump's refused password is asked for again under the jump's id, and the
	// route opened again; the target's credentials are not asked for again.
	it(
		"password auth: a jump's refused password is asked for again, for the jump",
		async () => {
			const { server: target, port: targetPort } = await createMockSshServer((stream) => {
				stream.write(makeHelloFrame());
			});
			servers.push(target);
			const fp = await getServerFingerprint(targetPort);

			const seen = { connections: 0, refused: 0 };
			const bastion = new Server({ hostKeys: [HOST_KEY] }, (conn) => {
				seen.connections++;
				conn.on("error", () => {});
				conn.on("authentication", (ctx) => {
					if (ctx.method === "password" && ctx.password === "bastion-password") {
						ctx.accept();
						return;
					}
					if (ctx.method === "password") seen.refused++;
					ctx.reject(["password"]);
				});
				conn.on("ready", () => {
					conn.on("tcpip", (accept) => {
						const stream = accept();
						const onward = netConnect(targetPort, "127.0.0.1");
						onward.on("error", () => stream.destroy());
						stream.on("error", () => onward.destroy());
						stream.pipe(onward).pipe(stream);
					});
				});
			});
			bastion.on("error", () => {});
			await new Promise<void>((resolve) => bastion.listen(0, "127.0.0.1", resolve));
			servers.push(bastion);
			const bastionPort = (bastion.address() as { port: number }).port;

			const promptAuth = vi
				.fn<AuthPromptFn>()
				.mockResolvedValueOnce("wrong-password")
				.mockResolvedValueOnce("bastion-password");
			const agent = new SshAgent(makeHost(targetPort), promptAuth);
			agents.push(agent);

			const { hello } = await agent.start(fp, null, undefined, {
				jump: { host: "127.0.0.1", port: bastionPort, username: "ops" },
				knownHostsNames: ["127.0.0.1"],
				auth: { method: "password" },
				promptHostId: "host-bastion",
				pinnedFingerprint: fp,
				trustKnownHosts: false,
				pinTo: { kind: "host", hostId: "host-bastion", expectedRoute: null },
			});

			expect(hello.type).toBe("HELLO");
			expect(promptAuth.mock.calls).toEqual([
				["host-bastion", "password", "Enter password for ops@127.0.0.1"],
				[
					"host-bastion",
					"password",
					"Wrong password for ops@127.0.0.1. Try again.",
					{ previousRejected: true },
				],
			]);
			expect(seen).toEqual({ connections: 2, refused: 1 });
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

	it.each(["stored", "session", "unrevoked"])(
		"checks revocation before %s trust",
		async (trust) => {
			const { server, port } = await createMockSshServer((stream) => {
				stream.write(makeHelloFrame());
			});
			servers.push(server);
			const home = makeTempDir("lasterm-key-revocation-");
			try {
				mkdirSync(join(home, ".ssh"));
				const key = utils.parseKey(HOST_KEY);
				if (key instanceof Error || Array.isArray(key)) throw new Error("invalid mock key");
				const file = join(home, ".ssh", "known_hosts");
				writeFileSync(
					file,
					`${trust === "unrevoked" ? "" : "@revoked "}[127.0.0.1]:${port} ${key.type} ${key.getPublicSSH().toString("base64")}\n`,
				);
				vi.stubEnv("HOME", home);
				vi.stubEnv("USERPROFILE", home);
				const agent = new SshAgent(makeHost(port));
				agents.push(agent);
				const fingerprint = fingerprintOf(key.getPublicSSH());
				const start = agent.start(
					trust === "session" ? null : fingerprint,
					trust === "session" ? fingerprint : undefined,
				);
				if (trust === "unrevoked") {
					await expect(start).resolves.toHaveProperty("keyVerification.revoked", undefined);
				} else {
					await expect(start).rejects.toMatchObject({
						keyVerification: { revoked: { file, line: 1 } },
					});
					expect(agent.lastKeyVerification.revoked).toEqual({ file, line: 1 });
					expect(agent.lastKeyVerification.tofu).toBe(false);
					expect(agent.lastKeyVerification.mismatch).toBe(false);
				}
			} finally {
				vi.unstubAllEnvs();
				removeTempDir(home);
			}
		},
		TEST_TIMEOUT,
	);

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

// ─── The host's connection timeout (#1034) ──────────────────────────────────
//
// Each wait of a connection lasts up to the host's connection timeout T, from
// 20 to 120 s, instead of the hub's own limits. These cases wait in real time:
// ssh2 and the hub use real timers, and T is never under 20 s.

/** Listen on a free loopback port; resolves with the server and its port. */
function listenLoopback(server: NetServer): Promise<number> {
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
	});
}

/** A TCP front for `targetPort` that connects to it only `delayMs` after each accept: a slow link. */
async function slowLink(
	targetPort: number,
	delayMs: number,
): Promise<{ server: NetServer; port: number }> {
	const sockets: Socket[] = [];
	const server = createNetServer((socket) => {
		sockets.push(socket);
		socket.pause();
		socket.on("error", () => {});
		setTimeout(() => {
			if (socket.destroyed) return;
			const onward = netConnect(targetPort, "127.0.0.1");
			sockets.push(onward);
			onward.on("error", () => socket.destroy());
			socket.on("error", () => onward.destroy());
			socket.pipe(onward).pipe(socket);
			socket.resume();
		}, delayMs);
	});
	server.on("close", () => {
		for (const socket of sockets) socket.destroy();
	});
	return { server, port: await listenLoopback(server) };
}

/** A TCP server that accepts and says nothing, or says its banner then closes. */
async function rawServer(
	behaviour: "silent" | "banner-then-close",
): Promise<{ server: NetServer; port: number }> {
	const sockets: Socket[] = [];
	const server = createNetServer((socket) => {
		sockets.push(socket);
		socket.on("error", () => {});
		if (behaviour === "banner-then-close") {
			socket.write("SSH-2.0-lasterm-test\r\n");
			setTimeout(() => socket.end(), 100);
		}
	});
	server.on("close", () => {
		for (const socket of sockets) socket.destroy();
	});
	return { server, port: await listenLoopback(server) };
}

/**
 * A mock SSH server whose exec answers as told: `execDelayMs` before it is
 * accepted (never when null), then HELLO `helloDelayMs` after (never when
 * null). `closeOnReady` ends the connection once authentication succeeded.
 */
async function timedSshServer(options: {
	execDelayMs?: number | null;
	helloDelayMs?: number | null;
	closeOnReady?: boolean;
}): Promise<{ server: SshServer; port: number }> {
	const timers: ReturnType<typeof setTimeout>[] = [];
	const server = new Server({ hostKeys: [HOST_KEY] }, (client) => {
		client.on("error", () => {});
		client.on("authentication", (ctx) => ctx.accept());
		client.on("ready", () => {
			if (options.closeOnReady) {
				timers.push(setTimeout(() => client.end(), 50));
				return;
			}
			client.on("session", (accept) => {
				const session = accept();
				session.on("exec", (acceptExec) => {
					const execDelayMs = options.execDelayMs ?? 0;
					if (options.execDelayMs === null) return;
					timers.push(
						setTimeout(() => {
							const stream = acceptExec();
							if (options.helloDelayMs === null) return;
							timers.push(
								setTimeout(() => {
									try {
										stream.write(makeHelloFrame());
									} catch {
										// The connection is gone: the assertion says so.
									}
								}, options.helloDelayMs ?? 0),
							);
						}, execDelayMs),
					);
				});
			});
		});
	});
	server.on("error", () => {});
	server.on("close", () => {
		for (const timer of timers) clearTimeout(timer);
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			resolve({ server, port: (server.address() as { port: number }).port });
		});
	});
}

/**
 * A bastion that routes to `targetPort`: it answers a channel open
 * `channelDelayMs` after it is asked, never when null.
 */
async function timedBastion(
	targetPort: number,
	channelDelayMs: number | null,
): Promise<{ server: SshServer; port: number }> {
	const timers: ReturnType<typeof setTimeout>[] = [];
	const server = new Server({ hostKeys: [HOST_KEY] }, (conn) => {
		conn.on("error", () => {});
		conn.on("authentication", (ctx) => ctx.accept());
		conn.on("ready", () => {
			conn.on("tcpip", (accept) => {
				if (channelDelayMs === null) return;
				timers.push(
					setTimeout(() => {
						const stream = accept();
						const onward = netConnect(targetPort, "127.0.0.1");
						onward.on("error", () => stream.destroy());
						stream.on("error", () => onward.destroy());
						stream.pipe(onward).pipe(stream);
					}, channelDelayMs),
				);
			});
		});
	});
	server.on("error", () => {});
	server.on("close", () => {
		for (const timer of timers) clearTimeout(timer);
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			resolve({ server, port: (server.address() as { port: number }).port });
		});
	});
}

/** The jump `start` takes, for a bastion on `port` reached with its key. */
function jumpThrough(port: number, fingerprint: string): ResolvedJump {
	return {
		jump: { host: "127.0.0.1", port, username: "ops" },
		knownHostsNames: ["127.0.0.1"],
		auth: { method: "key", keyPath: CLIENT_KEY_PATH },
		promptHostId: "host-bastion",
		pinnedFingerprint: fingerprint,
		trustKnownHosts: false,
		pinTo: { kind: "host", hostId: "host-bastion", expectedRoute: null },
	};
}

/** How long `promise` takes to settle, and how: the value or the error's message. */
async function timed<T>(
	promise: Promise<T>,
): Promise<{ ms: number; ok: boolean; message: string }> {
	const started = Date.now();
	try {
		await promise;
		return { ms: Date.now() - started, ok: true, message: "" };
	} catch (err) {
		return {
			ms: Date.now() - started,
			ok: false,
			message: err instanceof Error ? err.message : String(err),
		};
	}
}

describe("SshAgent — the host's connection timeout (#1034)", () => {
	let fingerprint = "";
	const closers: Array<() => void> = [];
	const agents: SshAgent[] = [];
	/** An empty home: no ~/.ssh/config gives any of these hosts a timeout. */
	const emptyHome = makeTempDir("lasterm-1034-home-");
	const SLOW = 40_000;

	beforeAll(async () => {
		vi.stubEnv("HOME", emptyHome);
		vi.stubEnv("USERPROFILE", emptyHome);
		const { server, port } = await createMockSshServer((stream) => stream.write(makeHelloFrame()));
		fingerprint = await getServerFingerprint(port);
		server.close();
	});

	afterAll(async () => {
		for (const agent of agents) {
			try {
				agent.close();
			} catch {
				// already closed
			}
		}
		for (const close of closers) close();
		vi.unstubAllEnvs();
		await removeTempDir(emptyHome);
	});

	/** Keep `server` until the block ends. */
	function keep<S extends { close: () => unknown }>(server: S): S {
		closers.push(() => {
			try {
				server.close();
			} catch {
				// already closed
			}
		});
		return server;
	}

	function agentFor(port: number, overrides: Partial<Host> = {}, remoteDaemon = false): SshAgent {
		const agent = new SshAgent(
			makeHost(port, overrides),
			undefined,
			undefined,
			undefined,
			remoteDaemon,
		);
		agents.push(agent);
		return agent;
	}

	describe.concurrent("without ~/.ssh/config", () => {
		it(
			"waits for a slow server as long as the host's connection timeout (#1034)",
			async () => {
				const target = await timedSshServer({});
				keep(target.server);
				const link = await slowLink(target.port, 21_000);
				keep(link.server);
				const { hello } = await agentFor(link.port, { connectTimeoutSeconds: 25 }).start(
					fingerprint,
				);
				expect(hello.type).toBe("HELLO");
			},
			SLOW,
		);

		it(
			"still gives up on a silent server at the connection timeout (#1034)",
			async () => {
				const silent = await rawServer("silent");
				keep(silent.server);
				const result = await timed(
					agentFor(silent.port, { connectTimeoutSeconds: 20 }).start(fingerprint),
				);
				expect(result.ok).toBe(false);
				expect(result.message).toContain("Timed out while waiting for handshake");
				expect(result.ms).toBeGreaterThanOrEqual(19_000);
				expect(result.ms).toBeLessThan(23_000);
			},
			SLOW,
		);

		it(
			"keeps ssh2's 20 s without a connection timeout (#1034)",
			async () => {
				const target = await timedSshServer({});
				keep(target.server);
				const link = await slowLink(target.port, 21_000);
				keep(link.server);
				const result = await timed(agentFor(link.port).start(fingerprint));
				expect(result.ok).toBe(false);
				expect(result.message).toContain("Timed out while waiting for handshake");
			},
			SLOW,
		);

		it(
			"waits for HELLO as long as the connection timeout (#1034)",
			async () => {
				const target = await timedSshServer({ helloDelayMs: 21_000 });
				keep(target.server);
				const { hello } = await agentFor(target.port, {
					connectTimeoutSeconds: 25,
					os: "linux",
				}).start(fingerprint);
				expect(hello.type).toBe("HELLO");
			},
			SLOW,
		);

		it(
			"waits for a Windows agent's HELLO as long as the connection timeout (#1034)",
			async () => {
				const target = await timedSshServer({ helloDelayMs: 21_000 });
				keep(target.server);
				const { hello } = await agentFor(target.port, {
					connectTimeoutSeconds: 25,
					os: "windows",
				}).start(fingerprint);
				expect(hello.type).toBe("HELLO");
			},
			SLOW,
		);

		it(
			"still gives up on a silent agent at the connection timeout (#1034)",
			async () => {
				const target = await timedSshServer({ helloDelayMs: null });
				keep(target.server);
				const result = await timed(
					agentFor(target.port, { connectTimeoutSeconds: 20 }).start(fingerprint),
				);
				expect(result.ok).toBe(false);
				expect(result.message).toContain("Agent HELLO timeout");
				expect(result.ms).toBeGreaterThanOrEqual(19_000);
				expect(result.ms).toBeLessThan(23_000);
			},
			SLOW,
		);

		it(
			"waits for the agent's command as long as the connection timeout (#1034)",
			async () => {
				const target = await timedSshServer({ execDelayMs: 21_000 });
				keep(target.server);
				const { hello } = await agentFor(target.port, { connectTimeoutSeconds: 25 }).start(
					fingerprint,
				);
				expect(hello.type).toBe("HELLO");
			},
			SLOW,
		);

		it(
			"still gives up on an unanswered command at the connection timeout (#1034)",
			async () => {
				const target = await timedSshServer({ execDelayMs: null });
				keep(target.server);
				const result = await timed(
					agentFor(target.port, { connectTimeoutSeconds: 20 }).start(fingerprint),
				);
				expect(result.ok).toBe(false);
				expect(result.message).toContain("The remote agent could not be reached");
				expect(result.ms).toBeGreaterThanOrEqual(19_000);
				expect(result.ms).toBeLessThan(23_000);
			},
			SLOW,
		);

		it(
			"gives each wait its own connection timeout (#1034)",
			async () => {
				const target = await timedSshServer({ helloDelayMs: 12_000 });
				keep(target.server);
				const link = await slowLink(target.port, 12_000);
				keep(link.server);
				const { hello } = await agentFor(link.port, { connectTimeoutSeconds: 20 }).start(
					fingerprint,
				);
				expect(hello.type).toBe("HELLO");
			},
			SLOW,
		);

		for (const [label, overrides] of [
			["no T", {}],
			["T=20", { connectTimeoutSeconds: 20 }],
		] as const) {
			it(
				`fails when the server closes before the connection is ready, ${label} (#1034)`,
				async () => {
					const server = await rawServer("banner-then-close");
					keep(server.server);
					const result = await timed(agentFor(server.port, overrides).start(fingerprint));
					expect(result).toMatchObject({
						ok: false,
						message: "The SSH server closed the connection before it was ready",
					});
					expect(result.ms).toBeLessThan(2_000);
				},
				SLOW,
			);

			it(
				`fails when the jump closes before the route is open, ${label} (#1034)`,
				async () => {
					const target = await timedSshServer({});
					keep(target.server);
					const bastion = await rawServer("banner-then-close");
					keep(bastion.server);
					const result = await timed(
						agentFor(target.port, overrides).start(
							fingerprint,
							null,
							undefined,
							jumpThrough(bastion.port, fingerprint),
						),
					);
					expect(result).toMatchObject({
						ok: false,
						message: "The jump host 127.0.0.1 closed the connection before the route was open",
					});
					expect(result.ms).toBeLessThan(2_000);
				},
				SLOW,
			);
		}

		it(
			"fails when the server closes after it is ready and before HELLO (#1034)",
			async () => {
				const target = await timedSshServer({ closeOnReady: true });
				keep(target.server);
				const result = await timed(agentFor(target.port).start(fingerprint));
				expect(result.ok).toBe(false);
				expect(result.ms).toBeLessThan(2_000);
			},
			SLOW,
		);

		it(
			"gives the daemon its share of the connection timeout (#1034)",
			async () => {
				let launchedAt: number | null = null;
				const { server, port } = await createMockSshServerWithSocket(
					(stream, command) => {
						if (command.includes("XDG_STATE_HOME")) stream.write("/home/pi/.local/state/lasterm");
						if (command.includes("--daemon")) launchedAt = Date.now();
						(stream as unknown as { exit: (code: number) => void }).exit(0);
						stream.end();
					},
					() => launchedAt !== null && Date.now() - launchedAt >= 8_000,
					(stream) => stream.write(makeHelloFrame()),
				);
				keep(server);
				const { hello } = await agentFor(
					port,
					{ connectTimeoutSeconds: 25, os: "linux" },
					true,
				).start(fingerprint);
				expect(hello.type).toBe("HELLO");
			},
			SLOW,
		);

		it(
			"stops retrying a silent daemon 15 s short of the connection timeout (#1034)",
			async () => {
				const { server, port } = await createMockSshServerWithSocket(
					(stream, command) => {
						if (command.includes("XDG_STATE_HOME")) stream.write("/home/pi/.local/state/lasterm");
						(stream as unknown as { exit: (code: number) => void }).exit(0);
						stream.end();
					},
					() => false,
					() => {},
				);
				keep(server);
				const result = await timed(
					agentFor(port, { connectTimeoutSeconds: 25, os: "linux" }, true).start(fingerprint),
				);
				expect(result.ok).toBe(false);
				expect(result.message).toContain("within 10000ms");
				expect(result.ms).toBeGreaterThanOrEqual(10_000);
				expect(result.ms).toBeLessThan(15_000);
			},
			SLOW,
		);

		for (const [label, directoryMs, launchMs, reached] of [
			["a slow launch", 0, 15_000, true],
			["a slow directory then a slow launch", 6_000, 21_000, false],
		] as const) {
			it(
				`gives the daemon's launch command the connection timeout: ${label} (#1034)`,
				async () => {
					let launched = false;
					const { server, port } = await createMockSshServerWithSocket(
						(stream, command) => {
							const answer = (ms: number, text: string, after?: () => void) =>
								setTimeout(() => {
									try {
										if (text !== "") stream.write(text);
										after?.();
										(stream as unknown as { exit: (code: number) => void }).exit(0);
										stream.end();
									} catch {
										// The connection is gone: the assertion says so.
									}
								}, ms);
							if (command.includes("XDG_STATE_HOME"))
								answer(directoryMs, "/home/pi/.local/state/lasterm");
							else if (command.includes("--daemon"))
								answer(launchMs, "", () => {
									launched = true;
								});
							else answer(0, "");
						},
						() => launched,
						(stream) => stream.write(makeHelloFrame()),
					);
					keep(server);
					const result = await timed(
						agentFor(port, { connectTimeoutSeconds: 25, os: "linux" }, true).start(fingerprint),
					);
					if (reached) {
						expect(result).toMatchObject({ ok: true });
					} else {
						expect(result).toMatchObject({
							ok: false,
							message: "The remote agent could not be reached",
						});
						expect(result.ms).toBeGreaterThanOrEqual(24_000);
						expect(result.ms).toBeLessThan(28_000);
					}
				},
				SLOW,
			);
		}

		it(
			"waits for a slow jump as long as the host's connection timeout (#1034)",
			async () => {
				const target = await timedSshServer({});
				keep(target.server);
				const bastion = await timedBastion(target.port, 0);
				keep(bastion.server);
				const link = await slowLink(bastion.port, 21_000);
				keep(link.server);
				// The jump is a saved host with a connection timeout of its own, 20 s,
				// resolved as a session resolves it: the route to this target takes
				// the target's 25 s, not the jump's.
				const jumpHost = makeHost(link.port, {
					id: "01HZ00000000000000000JUMP1",
					label: "bastion",
					connectTimeoutSeconds: 20,
				});
				const targetHost = makeHost(target.port, {
					connectTimeoutSeconds: 25,
					sshProxyHostId: jumpHost.id,
				});
				const resolution = resolveJump(
					targetHost,
					{
						getHost: (id) => (id === jumpHost.id ? jumpHost : undefined),
						getHostFingerprint: () => fingerprint,
					},
					false,
				);
				if (resolution.kind !== "jump") throw new Error(`no jump: ${resolution.kind}`);
				const agent = new SshAgent(targetHost);
				agents.push(agent);
				const { hello } = await agent.start(fingerprint, null, undefined, resolution.jump);
				expect(hello.type).toBe("HELLO");
			},
			SLOW,
		);

		it(
			"gives up on a jump that never opens the route (#1034)",
			async () => {
				const target = await timedSshServer({});
				keep(target.server);
				const bastion = await timedBastion(target.port, null);
				keep(bastion.server);
				const result = await timed(
					agentFor(target.port, { connectTimeoutSeconds: 20 }).start(
						fingerprint,
						null,
						undefined,
						jumpThrough(bastion.port, fingerprint),
					),
				);
				expect(result.ok).toBe(false);
				expect(result.message).toContain("The jump host 127.0.0.1 did not open a route");
				expect(result.ms).toBeGreaterThanOrEqual(19_000);
				expect(result.ms).toBeLessThan(23_000);
			},
			SLOW,
		);

		it(
			"gives the jump's connection and its channel each the connection timeout (#1034)",
			async () => {
				const target = await timedSshServer({});
				keep(target.server);
				const bastion = await timedBastion(target.port, 12_000);
				keep(bastion.server);
				const link = await slowLink(bastion.port, 12_000);
				keep(link.server);
				const { hello } = await agentFor(target.port, { connectTimeoutSeconds: 20 }).start(
					fingerprint,
					null,
					undefined,
					jumpThrough(link.port, fingerprint),
				);
				expect(hello.type).toBe("HELLO");
			},
			SLOW,
		);

		it(
			"stops waiting for a jump's channel when the connection is cancelled (#1034)",
			async () => {
				const target = await timedSshServer({});
				keep(target.server);
				const bastion = await timedBastion(target.port, null);
				keep(bastion.server);
				const cancel = new AbortController();
				setTimeout(() => cancel.abort(), 1_000);
				const result = await timed(
					agentFor(target.port).start(
						fingerprint,
						null,
						cancel.signal,
						jumpThrough(bastion.port, fingerprint),
					),
				);
				expect(result).toMatchObject({ ok: false, message: "SSH connect aborted" });
				expect(result.ms).toBeLessThan(3_000);
			},
			SLOW,
		);

		it(
			"leaves a jump's channel unbounded without a connection timeout (#1034)",
			async () => {
				const target = await timedSshServer({});
				keep(target.server);
				const bastion = await timedBastion(target.port, 25_000);
				keep(bastion.server);
				const { hello } = await agentFor(target.port).start(
					fingerprint,
					null,
					undefined,
					jumpThrough(bastion.port, fingerprint),
				);
				expect(hello.type).toBe("HELLO");
			},
			SLOW,
		);
	});

	// These write ~/.ssh/config, so each has a home of its own, one after another.
	describe("with ~/.ssh/config", () => {
		async function withConfig(config: string, run: () => Promise<void>): Promise<void> {
			const home = makeTempDir("lasterm-1034-config-");
			mkdirSync(join(home, ".ssh"));
			writeFileSync(join(home, ".ssh", "config"), config);
			vi.stubEnv("HOME", home);
			vi.stubEnv("USERPROFILE", home);
			try {
				await run();
			} finally {
				vi.stubEnv("HOME", emptyHome);
				vi.stubEnv("USERPROFILE", emptyHome);
				await removeTempDir(home);
			}
		}

		async function slowTarget(): Promise<number> {
			const target = await timedSshServer({});
			keep(target.server);
			const link = await slowLink(target.port, 21_000);
			keep(link.server);
			return link.port;
		}

		it(
			"takes ConnectTimeout from ~/.ssh/config when the host sets none (#1034)",
			async () => {
				const port = await slowTarget();
				await withConfig(
					"Host slow\n  ConnectTimeout 25\nHost 127.0.0.1\n  ConnectTimeout 20\n",
					async () => {
						const { hello } = await agentFor(port, { sshConfigHost: "slow" }).start(fingerprint);
						expect(hello.type).toBe("HELLO");
					},
				);
			},
			SLOW,
		);

		it(
			"matches ~/.ssh/config against the hostname of a host not imported from it (#1034)",
			async () => {
				const port = await slowTarget();
				await withConfig(
					"Host other\n  User me\nHost 127.0.0.1\n  ConnectTimeout = 25 # slow link\n",
					async () => {
						const [plain, aliased] = await Promise.all([
							agentFor(port).start(fingerprint),
							agentFor(port, { sshConfigHost: "other" }).start(fingerprint),
						]);
						expect(plain.hello.type).toBe("HELLO");
						expect(aliased.hello.type).toBe("HELLO");
					},
				);
			},
			SLOW,
		);

		it(
			"prefers the host's own value to ~/.ssh/config (#1034)",
			async () => {
				const port = await slowTarget();
				await withConfig("Host 127.0.0.1\n  ConnectTimeout 120\n", async () => {
					const result = await timed(
						agentFor(port, { connectTimeoutSeconds: 20 }).start(fingerprint),
					);
					expect(result.ok).toBe(false);
					expect(result.message).toContain("Timed out while waiting for handshake");
				});
			},
			SLOW,
		);
	});
});
