import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HelloMessage, Host } from "@lasterm/shared";
import { encodeFrame, type ProtocolMessage } from "@lasterm/shared";
import { Server, type Server as SshServer, utils } from "ssh2";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { fingerprintOf } from "../ssh/fingerprint.js";
import { makeTempDir, removeTempDir } from "../temp-dir.fixture.js";
import { windowsLaunchCommand } from "./agent-deployer.js";
import { type AuthPromptFn, SshAgent } from "./ssh-agent.js";
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
	options: { outright?: boolean; alreadyListening?: boolean; refusesStdio?: boolean } = {},
): {
	server: Promise<{ server: SshServer; port: number }>;
	commands: string[];
	listening: () => boolean;
} {
	const commands: string[] = [];
	let listening = options.alreadyListening === true;
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
						const stream = acceptExec() as unknown as NodeJS.ReadWriteStream & {
							exit: (code: number) => void;
						};
						if (command.includes("--stdio")) {
							stream.write(makeHelloFrame());
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
				).on("openssh.streamlocal", (_accept, reject) => reject());
			});
		});
		srv.on("error", () => {});
		srv.listen(0, "127.0.0.1", () => {
			resolve({ server: srv, port: (srv.address() as { port: number }).port });
		});
	});
	return { server, commands, listening: () => listening };
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
		const socket = "/home/pi/.local/state/lasterm/agent.sock";

		async function reach(
			server: Promise<{ server: SshServer; port: number }>,
		): Promise<{ agent: SshAgent; refused: ReturnType<typeof vi.fn>; start: Promise<unknown> }> {
			const { server: srv, port } = await server;
			servers.push(srv);
			const fp = await getServerFingerprint(port);
			const refused = vi.fn();
			const agent = new SshAgent(
				makeHost(port),
				undefined,
				{ binaryCache: "/tmp/fake-cache", onSocketForwardingRefused: refused },
				undefined,
				true,
			);
			agents.push(agent);
			return { agent, refused, start: agent.start(fp) };
		}

		it("stops the daemon it started, runs the agent on stdio, and says why", async () => {
			const remote = createForwardingRefusingServer();
			const logged = vi.spyOn(console, "error").mockImplementation(() => {});
			try {
				const { agent, refused, start } = await reach(remote.server);
				const { hello } = (await start) as { hello: HelloMessage };

				expect(hello.type).toBe("HELLO");
				expect(agent.socketForwardingRefused).toBe(true);
				expect(agent.usedRemoteDaemon).toBe(false);
				expect(refused).toHaveBeenCalledWith(expect.objectContaining({ id: makeHost(0).id }));
				// Started, seen listening, stopped through its own --stop, then stdio.
				const launch = remote.commands.findIndex((c) => c.includes("--daemon"));
				const stop = remote.commands.indexOf(`lasterm-agent --stop --socket ${socket}`);
				const stdio = remote.commands.indexOf("lasterm-agent --stdio");
				expect(launch).toBeGreaterThanOrEqual(0);
				expect(stop).toBeGreaterThan(launch);
				expect(stdio).toBeGreaterThan(stop);
				expect(remote.listening()).toBe(false);
				const said = logged.mock.calls.map((call) => String(call[0])).join("\n");
				expect(said).toMatch(
					/refuses socket forwarding \(AllowStreamLocalForwarding or DisableForwarding.*docs\/SSH_SERVER\.md\. The daemon this connection started there is stopped\./,
				);
			} finally {
				logged.mockRestore();
			}
		}, 15_000);

		it("starts nothing where the server refuses the channel type outright", async () => {
			const remote = createForwardingRefusingServer({ outright: true });
			const { agent, start } = await reach(remote.server);
			await start;

			expect(agent.socketForwardingRefused).toBe(true);
			expect(remote.commands.some((c) => c.includes("--daemon"))).toBe(false);
			expect(remote.commands.some((c) => c.includes("--stop"))).toBe(false);
			expect(remote.commands).toContain("lasterm-agent --stdio");
		}, 15_000);

		it("leaves a daemon that was already listening alone", async () => {
			// Another connection, through another key or from another address,
			// may reach it and hold terminals there.
			const remote = createForwardingRefusingServer({ alreadyListening: true });
			const { agent, start } = await reach(remote.server);
			await start;

			expect(agent.socketForwardingRefused).toBe(true);
			expect(remote.commands.some((c) => c.includes("--daemon"))).toBe(false);
			expect(remote.commands.some((c) => c.includes("--stop"))).toBe(false);
			expect(remote.listening()).toBe(true);
			expect(remote.commands).toContain("lasterm-agent --stdio");
		}, 15_000);

		it("says the forwarding was refused when stdio is refused too", async () => {
			const remote = createForwardingRefusingServer({ refusesStdio: true });
			const { start } = await reach(remote.server);

			await expect(start).rejects.toThrow(
				/refuses socket forwarding .* The daemon this connection started there is stopped\. Running the agent on stdio failed too/,
			);
			expect(remote.listening()).toBe(false);
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
