import { once } from "node:events";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

export type SentinelRequest = {
	kind: "http" | "websocket";
	method: string;
	path: string;
};

export type Sentinel = {
	baseUrl: string;
	close(): Promise<void>;
};

type SentinelHealthCheck = (baseUrl: string) => Promise<void>;

const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL0eAAAAABJRU5ErkJggg==",
	"base64",
);

async function checkSentinelHealth(baseUrl: string): Promise<void> {
	const health = await fetch(`${baseUrl}/__health`);
	if (!health.ok || (await health.text()) !== "sentinel reachable") {
		throw new Error(`Desktop boundary sentinel health check returned ${health.status}`);
	}
}

/** Starts the reachable endpoint used to prove the packaged renderer has no network access. */
export async function startSentinel(
	onRequest: (request: SentinelRequest) => void = () => undefined,
	records: () => SentinelRequest[] = () => [],
	healthCheck: SentinelHealthCheck = checkSentinelHealth,
): Promise<Sentinel> {
	const server = createServer((request, response) => {
		const path = request.url ?? "/";
		onRequest({ kind: "http", method: request.method ?? "GET", path });
		// A missing CSP must make fetch, XHR, and EventSource succeed, not merely
		// replace one client-side failure with CORS. The token makes leakage observable.
		response.setHeader("access-control-allow-origin", "*");

		if (path === "/__health") {
			response.writeHead(200, { "content-type": "text/plain" }).end("sentinel reachable");
			return;
		}
		if (path === "/__records") {
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify(records()));
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
		onRequest({ kind: "websocket", method: request.method ?? "GET", path: request.url ?? "/" });
		webSocketServer.handleUpgrade(request, socket, head, (websocket) => {
			webSocketServer.emit("connection", websocket, request);
		});
	});
	webSocketServer.on("connection", (socket) => socket.close());

	const close = async () => {
		await Promise.all([
			new Promise<void>((resolve, reject) => {
				webSocketServer.close((error) => (error ? reject(error) : resolve()));
			}),
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			}),
		]);
	};
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	try {
		const address = server.address();
		if (!address || typeof address === "string") {
			throw new Error("Desktop boundary sentinel did not bind a TCP port");
		}
		const baseUrl = `http://127.0.0.1:${address.port}`;
		await healthCheck(baseUrl);
		return { baseUrl, close };
	} catch (error) {
		await close();
		throw error;
	}
}
