import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as http from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { platformDirEnv } from "./platform-dirs.fixture.js";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(sourceDirectory, "../../..");
const hubDirectory = join(repositoryRoot, "packages", "hub");
const webDirectory = join(repositoryRoot, "packages", "clients", "web");

interface RuntimeRecord {
	readonly port: number;
	readonly spki: string;
}

describe("Vite development proxy", () => {
	let stateRoot: string | undefined;
	let hub: ChildProcess | undefined;
	let vite: ChildProcess | undefined;

	afterEach(async () => {
		const processes = [vite, hub];
		vite = undefined;
		hub = undefined;
		for (const process of processes) await stopProcess(process);
		if (stateRoot !== undefined) {
			// On Windows a hub stopped by kill() is terminated outright, and its
			// databases and log can stay locked for a moment after the exit event
			// (EPERM seen on CI), so the removal retries rather than failing.
			rmSync(stateRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			stateRoot = undefined;
		}
	});

	it("uses the newly published hub port for HTTP and WebSocket requests after a hub restart", async () => {
		stateRoot = mkdtempSync(join(tmpdir(), "lasterm-vite-proxy-"));
		const vitePort = await reservePort();
		const firstHubPort = await reservePort();
		const secondHubPort = await reservePort();
		expect(secondHubPort).not.toBe(firstHubPort);

		hub = startHub(stateRoot, firstHubPort);
		await waitForRuntime(stateRoot, firstHubPort);
		vite = startVite(stateRoot, vitePort);
		await waitForHttp(`http://127.0.0.1:${vitePort}/api/health`);

		await expect(proxyHealth(vitePort)).resolves.toMatchObject({ status: "ok" });
		await expect(proxyStatus(vitePort, "/public/not-present")).resolves.toBe(404);
		await expect(openWebSocket(vitePort)).resolves.toBeUndefined();

		await stopProcess(hub);
		hub = undefined;
		// On Windows, kill("SIGTERM") terminates the process outright: no
		// shutdown handler runs, so the record stays until the next hub
		// overwrites it, which waitForRuntime below waits for.
		if (process.platform !== "win32") await waitForRuntimeRemoval(stateRoot);

		hub = startHub(stateRoot, secondHubPort);
		await waitForRuntime(stateRoot, secondHubPort);
		await expect(proxyHealth(vitePort)).resolves.toMatchObject({ status: "ok" });
		await expect(proxyStatus(vitePort, "/public/not-present")).resolves.toBe(404);
		await expect(openWebSocket(vitePort)).resolves.toBeUndefined();
		// Comfortably past the fixture's own deadline, so that when something is
		// really wrong the error says which fixture never came up rather than
		// that the test ran out of time.
	}, 90_000);
});

/**
 * Run the hub in the spawned process itself, through tsx's loader. The tsx CLI
 * would run it in a child of its own: on Windows `kill()` then ends only the
 * CLI, and the hub keeps the state directory's files open until it notices,
 * which under load outlasted the cleanup's retries (EPERM).
 */
function startHub(stateDirectory: string, port: number): ChildProcess {
	return spawn(
		process.execPath,
		[
			"--import",
			pathToFileURL(join(hubDirectory, "node_modules", "tsx", "dist", "loader.mjs")).href,
			"src/main.ts",
		],
		{
			cwd: hubDirectory,
			env: {
				...process.env,
				...platformDirEnv({ state: stateDirectory, config: join(stateDirectory, "config") }),
				LASTERM_OPEN: "0",
				LASTERM_PORT: String(port),
			},
			stdio: "ignore",
		},
	);
}

function startVite(stateDirectory: string, port: number): ChildProcess {
	return spawn(
		process.execPath,
		[
			join(webDirectory, "node_modules", "vite", "bin", "vite.js"),
			"--host",
			"127.0.0.1",
			"--port",
			String(port),
			"--strictPort",
		],
		{
			cwd: webDirectory,
			env: {
				...process.env,
				...platformDirEnv({ state: stateDirectory, config: join(stateDirectory, "config") }),
			},
			stdio: "ignore",
		},
	);
}

async function reservePort(): Promise<number> {
	const server = createNetServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (address === null || typeof address === "string")
		throw new Error("could not reserve a TCP port");
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
	return address.port;
}

async function waitForRuntime(stateDirectory: string, port: number): Promise<RuntimeRecord> {
	const path = join(stateDirectory, "lasterm", "runtime.json");
	return waitFor(async () => {
		if (!existsSync(path)) return undefined;
		const runtime = JSON.parse(readFileSync(path, "utf8")) as Partial<RuntimeRecord>;
		if (runtime.port !== port || typeof runtime.spki !== "string") return undefined;
		return { port: runtime.port, spki: runtime.spki };
	});
}

async function waitForRuntimeRemoval(stateDirectory: string): Promise<void> {
	const path = join(stateDirectory, "lasterm", "runtime.json");
	await waitFor(() => (existsSync(path) ? undefined : true));
}

async function waitForHttp(url: string): Promise<void> {
	await waitFor(async () => {
		try {
			const response = await fetch(url);
			return response.ok ? true : undefined;
		} catch {
			return undefined;
		}
	});
}

/**
 * Poll until the fixture is up, with room for a machine doing something else.
 *
 * This spec starts a Vite dev server and a hub and waits for both to listen.
 * The deadline guards against a hang; it does not measure how fast that is,
 * and at twenty seconds it was the last thing in this suite still failing for
 * being run on a busy machine.
 */
async function waitFor<T>(attempt: () => T | undefined | Promise<T | undefined>): Promise<T> {
	const deadline = Date.now() + 45_000;
	for (;;) {
		const result = await attempt();
		if (result !== undefined) return result;
		if (Date.now() >= deadline) throw new Error("timed out waiting for development proxy fixture");
		await new Promise<void>((resolve) => setTimeout(resolve, 25));
	}
}

async function proxyHealth(port: number): Promise<{ status: string }> {
	const response = await fetch(`http://127.0.0.1:${port}/api/health`);
	if (!response.ok) throw new Error(`proxy health returned HTTP ${response.status}`);
	return response.json() as Promise<{ status: string }>;
}

async function proxyStatus(port: number, path: string): Promise<number> {
	const response = await fetch(`http://127.0.0.1:${port}${path}`);
	return response.status;
}

async function openWebSocket(port: number): Promise<void> {
	const request = http.request({
		host: "127.0.0.1",
		port,
		path: "/ws",
		headers: {
			Connection: "Upgrade",
			Upgrade: "websocket",
			"Sec-WebSocket-Key": randomBytes(16).toString("base64"),
			"Sec-WebSocket-Version": "13",
		},
	});
	const upgraded = new Promise<
		[import("node:http").IncomingMessage, import("node:net").Socket, Buffer]
	>((resolve, reject) => {
		request.once("upgrade", (response, socket, head) => resolve([response, socket, head]));
		request.once("error", reject);
	});
	request.end();
	const [response, socket] = await upgraded;
	try {
		if (response.statusCode !== 101)
			throw new Error(`proxy WebSocket returned HTTP ${response.statusCode}`);
	} finally {
		socket.destroy();
	}
}

async function stopProcess(child: ChildProcess | undefined): Promise<void> {
	if (child === undefined || child.exitCode !== null) return;
	child.kill("SIGTERM");
	await Promise.race([
		once(child, "exit").then(() => undefined),
		new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error("development fixture did not exit after SIGTERM")), 10_000),
		),
	]);
}
