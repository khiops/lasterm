import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { accessSync, constants } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocketServer } from "ws";

type SentinelRequest = {
	kind: "http" | "websocket";
	method: string;
	path: string;
};

const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL0eAAAAABJRU5ErkJggg==",
	"base64",
);
const requests: SentinelRequest[] = [];
const desktopRoot = resolve(process.cwd());
const application = process.env.LASTERM_DESKTOP_BINARY
	? resolve(process.env.LASTERM_DESKTOP_BINARY)
	: resolve(desktopRoot, "src-tauri/target/debug/lasterm-desktop");

function failMissing(name: string, detail: string): never {
	throw new Error(`Desktop boundary E2E prerequisite missing: ${name} (${detail})`);
}

function requireExecutable(name: string, path: string): void {
	try {
		accessSync(path, constants.X_OK);
	} catch (error) {
		failMissing(name, `${path} is not executable: ${String(error)}`);
	}
}

function requireCommand(name: string, installHint?: string): void {
	const probe = spawnSync("sh", ["-c", `command -v ${name}`], { stdio: "ignore" });
	if (probe.error || probe.status !== 0) {
		failMissing(name, `not found on PATH${installHint ? `; install ${installHint}` : ""}`);
	}
}

function quoteForShell(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function captureApplicationOutput(): Promise<{
	close(): Promise<void>;
	environment: NodeJS.ProcessEnv;
	logPath: string;
	wrapper: string;
}> {
	const directory = await mkdtemp(join(tmpdir(), "lasterm-desktop-e2e-"));
	const home = join(directory, "home");
	const config = join(directory, "config");
	const data = join(directory, "data");
	const state = join(directory, "state");
	const cache = join(directory, "cache");
	const logPath = join(directory, "application.log");
	const wrapper = join(directory, "lasterm-desktop-with-log.sh");
	await Promise.all(
		[home, config, data, state, cache].map((path) => mkdir(path, { recursive: true })),
	);
	await writeFile(
		wrapper,
		`#!/bin/sh\nexec ${quoteForShell(application)} "$@" >${quoteForShell(logPath)} 2>&1\n`,
		{ mode: 0o700 },
	);
	await chmod(wrapper, 0o700);
	return {
		environment: {
			HOME: home,
			XDG_CACHE_HOME: cache,
			XDG_CONFIG_HOME: config,
			XDG_DATA_HOME: data,
			XDG_STATE_HOME: state,
		},
		logPath,
		wrapper,
		close: async () => rm(directory, { force: true, recursive: true }),
	};
}

function rendererRequests(): SentinelRequest[] {
	return requests.filter((request) => request.path.includes("boundary-token="));
}

function reportSentinelEvidence(documentLoaded = false): SentinelRequest[] {
	const observed = rendererRequests();
	if (observed.length === 0) {
		process.stdout.write(
			documentLoaded
				? "Desktop boundary E2E: packaged document loaded; sentinel observed no renderer requests; renderer boundary held.\n"
				: "Desktop boundary E2E: sentinel observed no renderer requests.\n",
		);
	} else {
		process.stdout.write(
			`Desktop boundary E2E: sentinel observed renderer requests; boundary leaked: ${JSON.stringify(observed)}\n`,
		);
	}
	return observed;
}

async function printApplicationOutput(logPath: string): Promise<void> {
	let output = "";
	try {
		output = await readFile(logPath, "utf8");
	} catch (error) {
		output = `<could not read captured output: ${String(error)}>`;
	}
	process.stderr.write(
		`\n--- desktop application stdout/stderr (captured for this failed E2E run) ---\n${output || "<no output>"}\n--- end desktop application stdout/stderr ---\n`,
	);
}

async function startSentinel(): Promise<{ baseUrl: string; close(): Promise<void> }> {
	const server = createServer((request, response) => {
		const path = request.url ?? "/";
		requests.push({ kind: "http", method: request.method ?? "GET", path });
		// A missing CSP must make fetch, XHR, and EventSource succeed, not merely
		// replace one client-side failure with CORS. The route token below then
		// makes the unwanted request observable in this process.
		response.setHeader("access-control-allow-origin", "*");

		if (path === "/__health") {
			response.writeHead(200, { "content-type": "text/plain" }).end("sentinel reachable");
			return;
		}
		if (path === "/__records") {
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify(requests));
			return;
		}
		if (path.startsWith("/image")) {
			response.writeHead(200, { "content-type": "image/png" }).end(png);
			return;
		}
		if (path.startsWith("/event-source")) {
			response.writeHead(200, {
				"cache-control": "no-cache",
				"content-type": "text/event-stream",
			});
			response.write("data: reachable\\n\\n");
			return;
		}
		response.writeHead(200, { "content-type": "text/plain" }).end("reachable");
	});
	const webSocketServer = new WebSocketServer({ noServer: true });
	server.on("upgrade", (request, socket, head) => {
		requests.push({ kind: "websocket", method: request.method ?? "GET", path: request.url ?? "/" });
		webSocketServer.handleUpgrade(request, socket, head, (websocket) => {
			webSocketServer.emit("connection", websocket, request);
		});
	});
	webSocketServer.on("connection", (socket) => socket.close());

	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Desktop boundary sentinel did not bind a TCP port");
	}
	const baseUrl = `http://127.0.0.1:${address.port}`;
	const health = await fetch(`${baseUrl}/__health`);
	if (!health.ok || (await health.text()) !== "sentinel reachable")
		throw new Error(`Desktop boundary sentinel health check returned ${health.status}`);

	return {
		baseUrl,
		close: async () => {
			webSocketServer.close();
			server.close();
			await once(server, "close");
		},
	};
}

async function main(): Promise<void> {
	if (process.platform === "linux" && !process.env.DISPLAY) {
		failMissing("DISPLAY", "run the suite under xvfb-run or a real display server");
	}
	requireExecutable("built application", application);
	requireCommand("tauri-driver");
	if (process.platform === "linux") {
		requireCommand("WebKitWebDriver", "webkit2gtk-driver or webkitgtk-webdriver");
	}

	let sentinel: Awaited<ReturnType<typeof startSentinel>> | undefined;
	let capturedApplication: Awaited<ReturnType<typeof captureApplicationOutput>> | undefined;
	let sentinelReported = false;
	let applicationOutputPrinted = false;
	try {
		sentinel = await startSentinel();
		capturedApplication = await captureApplicationOutput();
		const child = spawn("pnpm", ["exec", "wdio", "run", "e2e/wdio.conf.ts"], {
			cwd: desktopRoot,
			env: {
				...process.env,
				...capturedApplication.environment,
				LASTERM_E2E_APPLICATION: capturedApplication.wrapper,
				LASTERM_E2E_SENTINEL_URL: sentinel.baseUrl,
			},
			stdio: "inherit",
		});
		const [code, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
		// This is deliberately before either failure check. A non-zero WebDriver
		// exit must not hide the only direct observation of renderer traffic.
		if (code !== 0) {
			reportSentinelEvidence();
			sentinelReported = true;
			await printApplicationOutput(capturedApplication.logPath);
			applicationOutputPrinted = true;
			throw new Error(
				`Desktop boundary E2E runner exited with code ${code ?? "null"}, signal ${signal ?? "none"}`,
			);
		}
		const probeRequests = reportSentinelEvidence(true);
		sentinelReported = true;
		if (probeRequests.length > 0) {
			throw new Error(`The renderer reached the sentinel: ${JSON.stringify(probeRequests)}`);
		}
	} catch (error) {
		if (sentinel && !sentinelReported) reportSentinelEvidence();
		if (capturedApplication && !applicationOutputPrinted) {
			await printApplicationOutput(capturedApplication.logPath);
		}
		throw error;
	} finally {
		if (sentinel) await sentinel.close();
		if (capturedApplication) await capturedApplication.close();
	}
}

void main();
