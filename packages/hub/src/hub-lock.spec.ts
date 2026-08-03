import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireHubLock, getHubLockPath, HubLockInitializationError } from "./hub-lock.js";
import { startHub } from "./hub-startup.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.sequential("hub startup lock", () => {
	it("uses a separate, stable authority file rather than runtime.json", () => {
		const stateDir = makeStateDir();
		expect(getHubLockPath(stateDir)).toBe(path.join(stateDir, "hub.lock"));
		expect(getHubLockPath(stateDir)).not.toContain("runtime.json");
	});

	it("refuses a second hub before it can bind a port", async () => {
		const stateRoot = makeStateDir();
		const stateDir = path.join(stateRoot, "termora");
		// A discovery record cannot authorize or veto serving; only this lock does.
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(path.join(stateDir, "runtime.json"), "{");
		acquireHubLock(stateDir);
		const listener = await listen();
		try {
			const result = await runMain({
				...stateRootEnv(stateRoot),
				TERMORA_PORT: String((listener.address() as net.AddressInfo).port),
			});
			// This catches a mutation that moves bind/openDatabases ahead of lock
			// acquisition: the occupied port would then yield exit 1, not 73.
			expect(result.code).toBe(73);
			expect(result.stderr).toContain("TERMORA_HUB_ALREADY_RUNNING");
			expect(readFileSync(path.join(stateDir, "runtime.json"), "utf8")).toBe("{");
		} finally {
			listener.close();
		}
	});

	it("refuses a malformed addon before databases or a server can be opened", async () => {
		const stateDir = path.join(makeStateDir(), "termora");
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
		const stateDir = path.join(makeStateDir(), "termora");
		class FakeHubLock {}
		expect(() =>
			acquireHubLock(stateDir, {
				loadAddon: () => ({ HubLock: FakeHubLock, tryAcquire: () => result }) as never,
			}),
		).toThrow(HubLockInitializationError);
	});

	it("refuses a second startup entry in the same process", () => {
		const stateDir = path.join(makeStateDir(), "termora");
		acquireHubLock(stateDir);
		expect(() => acquireHubLock(stateDir)).toThrow("TERMORA_HUB_ALREADY_RUNNING");
	});

	// Mutation: withdraw the runtime record before closing the server, and `status`
	// reports a stopped hub while the socket and the databases are still live. The
	// order is the assertion; the counts alone passed either way.
	it("cleans databases, the listening server, and the runtime record after startup failure", async () => {
		const stateDir = path.join(makeStateDir(), "termora");
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
					acquireHubLock: () => ({ path: path.join(stateDir, "hub.lock") }) as never,
					initAuth: () => "token",
					createOwnerToken: () => "owner",
					openDatabases: () => databases as never,
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

	it("starts with an unreadable runtime record when the authoritative lock is free", async () => {
		const stateRoot = makeStateDir();
		const stateDir = path.join(stateRoot, "termora");
		const port = await unusedPort();
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(path.join(stateDir, "runtime.json"), "{");
		const child = spawnMain({
			...stateRootEnv(stateRoot),
			...configRootEnv(path.join(stateRoot, "config")),
			TERMORA_PORT: String(port),
		});
		try {
			await waitForPort(port, child);
		} finally {
			child.kill("SIGTERM");
			await waitForExit(child);
		}
	});

	it("fails closed when the native addon cannot be loaded", async () => {
		const stateRoot = makeStateDir();
		const missingAddon = path.join(stateRoot, "missing-termora_hub_lock.node");
		const result = await runMain({
			...stateRootEnv(stateRoot),
			TERMORA_HUB_LOCK_ADDON: missingAddon,
			TERMORA_PORT: "4100",
		});
		// Simulates extraction/load failure with a nonexistent addon path. The
		// startup process must not proceed unlocked or publish a runtime record.
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("TERMORA_HUB_LOCK_UNAVAILABLE");
		expect(existsSync(path.join(stateRoot, "termora", "runtime.json"))).toBe(false);
	});

	it("wraps a native loader failure as a fail-closed startup error", () => {
		const stateDir = path.join(makeStateDir(), "termora");
		expect(() =>
			acquireHubLock(stateDir, {
				loadAddon: () => {
					throw new Error("simulated dlopen failure");
				},
			}),
		).toThrow(HubLockInitializationError);
	});
});

function makeStateDir(): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "termora-hub-lock-"));
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
		stdio: ["ignore", "ignore", "pipe"],
	});
}

async function unusedPort(): Promise<number> {
	const server = await listen();
	const port = (server.address() as net.AddressInfo).port;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

function waitForPort(port: number, child: ChildProcess): Promise<void> {
	return new Promise((resolve, reject) => {
		let stderr = "";
		let settled = false;
		let timeout: NodeJS.Timeout | undefined;
		const finish = (error?: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			child.off("exit", onExit);
			if (error) reject(error);
			else resolve();
		};
		const onExit = (code: number | null) => finish(new Error(`hub exited ${code}: ${stderr}`));
		timeout = setTimeout(() => finish(new Error(`hub did not listen: ${stderr}`)), 5_000);
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		const poll = () => {
			if (settled) return;
			const socket = net.connect(port, "127.0.0.1");
			socket.once("connect", () => {
				socket.destroy();
				finish();
			});
			socket.once("error", () => {
				if (!settled) setTimeout(poll, 20);
			});
		};
		child.once("exit", onExit);
		poll();
	});
}

function stateRootEnv(stateRoot: string): NodeJS.ProcessEnv {
	return process.platform === "win32" ? { LOCALAPPDATA: stateRoot } : { XDG_STATE_HOME: stateRoot };
}

function configRootEnv(configRoot: string): NodeJS.ProcessEnv {
	return process.platform === "win32" ? { APPDATA: configRoot } : { XDG_CONFIG_HOME: configRoot };
}

function waitForExit(child: ChildProcess): Promise<void> {
	return new Promise((resolve) => child.once("exit", () => resolve()));
}
