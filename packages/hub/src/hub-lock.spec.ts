import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { loadCachedAddon } from "@lasterm/shared/dist/sea-addon-loader.js";
import { afterEach, describe, expect, it } from "vitest";
import { acquireHubLock, getHubLockPath, HubLockInitializationError } from "./hub-lock.js";
import { startHub } from "./hub-startup.js";

const tempDirs: string[] = [];

// These tests start the real hub through tsx. Alone it listens in about 2.5 s
// on Windows; under the full parallel suite it took longer than the 5 s
// default, and a test aborted mid-wait left its hub holding the state
// directory, so cleanup then failed with EPERM.
/**
 * Spawning a hub and waiting for it to listen, with room for a loaded machine.
 * The `scripts` project settled on the same budget for the same reason: this
 * waits for readiness, it does not measure it.
 */
const HUB_PROCESS_TIMEOUT_MS = 60_000;
const HUB_LISTEN_TIMEOUT_MS = 20_000;

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.sequential("hub startup lock", () => {
	it("uses a separate, stable authority file rather than runtime.json", () => {
		const stateDir = makeStateDir();
		expect(getHubLockPath(stateDir)).toBe(path.join(stateDir, "hub.lock"));
		expect(getHubLockPath(stateDir)).not.toContain("runtime.json");
	});

	it("refuses a second hub before it can bind a port", {
		timeout: HUB_PROCESS_TIMEOUT_MS,
	}, async () => {
		const stateRoot = makeStateDir();
		const stateDir = path.join(stateRoot, "lasterm");
		// A discovery record cannot authorize or veto serving; only this lock does.
		mkdirSync(stateDir, { recursive: true, mode: 0o700 });
		writeFileSync(path.join(stateDir, "runtime.json"), "{");
		acquireHubLock(stateDir);
		const listener = await listen();
		try {
			const result = await runMain({
				...hermeticRootsEnv(stateRoot),
				LASTERM_PORT: String((listener.address() as net.AddressInfo).port),
			});
			// This catches a mutation that moves bind/openDatabases ahead of lock
			// acquisition: the occupied port would then yield exit 1, not 73.
			expect(result.code).toBe(73);
			expect(result.stderr).toContain("LASTERM_HUB_ALREADY_RUNNING");
			expect(readFileSync(path.join(stateDir, "runtime.json"), "utf8")).toBe("{");
		} finally {
			listener.close();
		}
	});

	it("refuses a malformed addon before databases or a server can be opened", async () => {
		const stateDir = path.join(makeStateDir(), "lasterm");
		let databasesOpened = 0;
		let serversCreated = 0;
		class FakeHubLock {}
		const malformedAddon = {
			HubLock: FakeHubLock,
			tryAcquire: () => ({}),
		};

		await expect(
			startHub(
				{ port: 4100 },
				{
					getStateDir: () => stateDir,
					getConfigDir: () => path.join(stateDir, "config"),
					// This exercises the lock, not the previous-installation probe, whose real
					// answer depends on whether the machine running the suite ever had Termora.
					describePreviousInstallation: () => undefined,
					acquireHubLock: (dir) =>
						acquireHubLock(dir, { loadAddon: () => malformedAddon as never }),
					openDatabases: (() => {
						databasesOpened += 1;
						throw new Error("database must not open without a proven lock");
					}) as never,
					createServer: (async () => {
						serversCreated += 1;
						throw new Error("server must not be created without a proven lock");
					}) as never,
				},
			),
		).rejects.toThrow(HubLockInitializationError);
		expect(databasesOpened).toBe(0);
		expect(serversCreated).toBe(0);
	});

	it.each([undefined, false, {}])("rejects the non-handle native result %#", (result) => {
		const stateDir = path.join(makeStateDir(), "lasterm");
		class FakeHubLock {}
		expect(() =>
			acquireHubLock(stateDir, {
				loadAddon: () => ({ HubLock: FakeHubLock, tryAcquire: () => result }) as never,
			}),
		).toThrow(HubLockInitializationError);
	});

	it("refuses a second startup entry in the same process", () => {
		const stateDir = path.join(makeStateDir(), "lasterm");
		acquireHubLock(stateDir);
		expect(() => acquireHubLock(stateDir)).toThrow("LASTERM_HUB_ALREADY_RUNNING");
	});

	// Mutation: withdraw the runtime record before closing the server, and `status`
	// reports a stopped hub while the socket and the databases are still live. The
	// order is the assertion; the counts alone passed either way.
	it("cleans databases, the listening server, and the runtime record after startup failure", async () => {
		const stateDir = path.join(makeStateDir(), "lasterm");
		const order: string[] = [];
		let databaseClosed = 0;
		let serverClosed = 0;
		let runtimePersisted = 0;
		let runtimeDeleted = 0;
		const server = {
			close: async () => {
				order.push("server");
				serverClosed += 1;
			},
		};
		const databases = {
			close: () => {
				order.push("databases");
				databaseClosed += 1;
			},
		};

		await expect(
			startHub(
				{
					port: 4100,
					announce: () => {
						throw new Error("injected failure after runtime publication");
					},
				},
				{
					getStateDir: () => stateDir,
					getConfigDir: () => path.join(stateDir, "config"),
					// This exercises the lock, not the previous-installation probe, whose real
					// answer depends on whether the machine running the suite ever had Termora.
					describePreviousInstallation: () => undefined,
					acquireHubLock: () => ({ path: path.join(stateDir, "hub.lock") }) as never,
					initAuth: () => "token",
					createOwnerToken: () => "owner",
					resolveHubTlsIdentity: () => ({
						tls: { cert: "certificate", key: "key" },
						certificate: "certificate",
						spki: "test-spki",
					}),
					openDatabases: () => databases as never,
					sweepNonPrimaryTokens: () => undefined,
					createServer: async () => server as never,
					startServer: async () => "127.0.0.1:4100",
					addStartupCorsOrigins: () => 4100,
					persistRuntime: () => {
						runtimePersisted += 1;
					},
					deleteRuntime: () => {
						order.push("record");
						runtimeDeleted += 1;
						return true;
					},
				},
			),
		).rejects.toThrow("injected failure after runtime publication");
		expect(databaseClosed).toBe(1);
		expect(serverClosed).toBe(1);
		expect(runtimePersisted).toBe(1);
		expect(runtimeDeleted).toBe(1);
		expect(order).toEqual(["server", "databases", "record"]);
	});

	it("starts with an unreadable runtime record when the authoritative lock is free", {
		timeout: HUB_PROCESS_TIMEOUT_MS,
	}, async () => {
		const stateRoot = makeStateDir();
		const stateDir = path.join(stateRoot, "lasterm");
		const port = await unusedPort();
		mkdirSync(stateDir, { recursive: true, mode: 0o700 });
		writeFileSync(path.join(stateDir, "runtime.json"), "{");
		const child = spawnMain({
			...hermeticRootsEnv(stateRoot),
			LASTERM_PORT: String(port),
		});
		try {
			// The record it replaces the unreadable one with names where it listens.
			await waitForListening(stateDir, child);
		} finally {
			child.kill("SIGTERM");
			await waitForExit(child);
		}
	});

	// What made the test above fail once under the full suite, reproduced on
	// purpose: the port asked for is taken before the hub binds it, so the hub
	// listens on the next one. Polling the port asked for then waits out the
	// deadline — or, as here where a listener holds it, reaches the wrong process
	// and passes for the wrong reason.
	it("is found where it listens when the port it asked for was taken", {
		timeout: HUB_PROCESS_TIMEOUT_MS,
	}, async () => {
		const stateRoot = makeStateDir();
		const stateDir = path.join(stateRoot, "lasterm");
		mkdirSync(stateDir, { recursive: true, mode: 0o700 });
		const squatter = await listen();
		const taken = (squatter.address() as net.AddressInfo).port;
		const child = spawnMain({
			...hermeticRootsEnv(stateRoot),
			LASTERM_PORT: String(taken),
		});
		try {
			const port = await waitForListening(stateDir, child);
			expect(port).not.toBe(taken);
		} finally {
			child.kill("SIGTERM");
			await waitForExit(child);
			await new Promise<void>((resolve) => squatter.close(() => resolve()));
		}
	});

	it("fails closed when the native addon cannot be loaded", {
		timeout: HUB_PROCESS_TIMEOUT_MS,
	}, async () => {
		const stateRoot = makeStateDir();
		const missingAddon = path.join(stateRoot, "missing-lasterm_hub_lock.node");
		const result = await runMain({
			...hermeticRootsEnv(stateRoot),
			LASTERM_HUB_LOCK_ADDON: missingAddon,
			LASTERM_PORT: "4100",
		});
		// Simulates extraction/load failure with a nonexistent addon path. The
		// startup process must not proceed unlocked or publish a runtime record.
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("LASTERM_HUB_LOCK_UNAVAILABLE");
		expect(existsSync(path.join(stateRoot, "lasterm", "runtime.json"))).toBe(false);
	});

	it("wraps a native loader failure as a fail-closed startup error", () => {
		const stateDir = path.join(makeStateDir(), "lasterm");
		expect(() =>
			acquireHubLock(stateDir, {
				loadAddon: () => {
					throw new Error("simulated dlopen failure");
				},
			}),
		).toThrow(HubLockInitializationError);
	});

	it("takes the lock with the addon loaded from the authenticated addon cache", () => {
		// The single executable's path: the embedded bytes go through the cache
		// and are loaded from there — on Linux through the descriptor they were
		// verified on — rather than from the build output.
		const cacheDir = mkdtempSync(path.join(os.tmpdir(), "lasterm-addon-cache-"));
		try {
			const exports = loadCachedAddon(
				"lasterm_hub_lock.node",
				path.join(cacheDir, "addons"),
				readFileSync(builtHubLockAddon()),
			);
			const stateDir = path.join(makeStateDir(), "lasterm");
			const lock = acquireHubLock(stateDir, { loadAddon: () => exports as never });
			expect(lock.path).toBe(path.resolve(getHubLockPath(stateDir)));
		} finally {
			try {
				rmSync(cacheDir, { recursive: true, force: true });
			} catch {
				// Windows keeps a loaded library until the process exits.
			}
		}
	});
});

/** Where hub-lock.ts itself finds the addon outside the single executable. */
function builtHubLockAddon(): string {
	const override = process.env.LASTERM_HUB_LOCK_ADDON;
	if (override && override.length > 0) return override;
	const filename = process.platform === "win32" ? "lasterm_hub_lock.dll" : "liblasterm_hub_lock.so";
	const targetDir =
		process.env.CARGO_TARGET_DIR ?? path.resolve(import.meta.dirname, "../../../target");
	return path.resolve(targetDir, "release", filename);
}

function makeStateDir(): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "lasterm-hub-lock-"));
	tempDirs.push(dir);
	return dir;
}

function listen(): Promise<net.Server> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve(server));
	});
}

function runMain(extraEnv: NodeJS.ProcessEnv): Promise<{ code: number | null; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--import", "tsx", "packages/hub/src/main.ts"], {
			cwd: path.resolve(import.meta.dirname, "../../.."),
			env: { ...process.env, ...extraEnv },
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.once("error", reject);
		child.once("exit", (code) => resolve({ code, stderr }));
	});
}

function spawnMain(extraEnv: NodeJS.ProcessEnv): ChildProcess {
	return spawn(process.execPath, ["--import", "tsx", "packages/hub/src/main.ts"], {
		cwd: path.resolve(import.meta.dirname, "../../.."),
		env: { ...process.env, ...extraEnv },
		// stdout too: it is where the hub says it moved to another port.
		stdio: ["ignore", "pipe", "pipe"],
	});
}

async function unusedPort(): Promise<number> {
	const server = await listen();
	const port = (server.address() as net.AddressInfo).port;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

/**
 * Wait for the hub to listen where it says it does.
 *
 * The port a test asks for is only where the hub starts looking: one taken
 * between `unusedPort()` closing it and the hub binding it — under the full
 * parallel suite, any outgoing connection can be handed it — makes the hub move
 * up to the next free one (zero_conf), and a test polling the port it asked for
 * then waits out its deadline with nothing on stderr to say why. The runtime
 * record is the hub's own statement of where it listens, written once it does.
 */
function waitForListening(stateDir: string, child: ChildProcess): Promise<number> {
	return new Promise((resolve, reject) => {
		let output = "";
		let settled = false;
		let timeout: NodeJS.Timeout | undefined;
		const finish = (error?: Error, port?: number): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			child.off("exit", onExit);
			if (error) reject(error);
			else resolve(port as number);
		};
		const tail = () => output.slice(-2_000);
		const onExit = (code: number | null) => finish(new Error(`hub exited ${code}: ${tail()}`));
		timeout = setTimeout(
			() => finish(new Error(`hub did not listen within ${HUB_LISTEN_TIMEOUT_MS} ms: ${tail()}`)),
			HUB_LISTEN_TIMEOUT_MS,
		);
		const collect = (chunk: Buffer) => {
			output += chunk.toString();
		};
		child.stdout?.on("data", collect);
		child.stderr?.on("data", collect);
		const publishedPort = (): number | undefined => {
			try {
				const record = JSON.parse(readFileSync(path.join(stateDir, "runtime.json"), "utf8")) as {
					pid?: unknown;
					port?: unknown;
				};
				return record.pid === child.pid && typeof record.port === "number"
					? record.port
					: undefined;
			} catch {
				return undefined;
			}
		};
		const poll = () => {
			if (settled) return;
			const port = publishedPort();
			if (port === undefined) {
				setTimeout(poll, 20);
				return;
			}
			const socket = net.connect(port, "127.0.0.1");
			socket.once("connect", () => {
				socket.destroy();
				finish(undefined, port);
			});
			socket.once("error", () => {
				if (!settled) setTimeout(poll, 20);
			});
		};
		child.once("exit", onExit);
		poll();
	});
}

/**
 * Both roots a spawned hub reads, from one temporary directory.
 *
 * One helper rather than two, because redirecting only the state root leaves the
 * child reading the real config home: a machine that once ran Termora then has a
 * previous installation in view, and `startHub` refuses before it ever reaches the
 * lock these tests are about. That is the refusal working, and a test must not be
 * able to ask for half of a hermetic environment.
 */
function hermeticRootsEnv(root: string): NodeJS.ProcessEnv {
	const configRoot = path.join(root, "config");
	return process.platform === "win32"
		? { LOCALAPPDATA: root, APPDATA: configRoot }
		: { XDG_STATE_HOME: root, XDG_CONFIG_HOME: configRoot };
}

function waitForExit(child: ChildProcess): Promise<void> {
	return new Promise((resolve) => child.once("exit", () => resolve()));
}
