#!/usr/bin/env -S pnpm exec tsx
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { request } from "node:https";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { decodeMessage, encodeMessage } from "../../packages/shared/src/index.js";
import { createHubTlsAgent } from "../../packages/hub/src/hub-transport.js";
import { requestHub } from "../../packages/hub/src/cli.js";
import type {
	AuthMessage,
	ProtocolMessage,
	UiSpawnMessage,
} from "../../packages/shared/src/index.js";

interface HostSummary {
	id: string;
	type: string;
	label: string;
}

const stateDir =
	platform() === "win32"
		? join(process.env.LOCALAPPDATA ?? "", "lasterm")
		: join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "lasterm");
const configDir =
	platform() === "win32"
		? join(process.env.APPDATA ?? "", "lasterm")
		: join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "lasterm");
const runtime = JSON.parse(readFileSync(join(stateDir, "runtime.json"), "utf8")) as {
	port?: unknown;
	spki?: string;
};
const runtimePort = runtime.port;
if (
	typeof runtimePort !== "number" ||
	!Number.isInteger(runtimePort) ||
	runtimePort < 1 ||
	runtimePort > 65535
) {
	throw new Error("runtime.json has no usable hub port");
}
const port = runtimePort;
const hubRuntime = {
	pid: 0,
	port,
	started_at: "",
	...(typeof runtime.spki === "string" ? { spki: runtime.spki } : {}),
};
const authPath =
	process.env.TT_AUTH ??
	join(configDir, "auth.json");
const token = readToken(authPath);
const hosts = await readHosts(token);
const local = hosts.find((h) => h.type === "local") ?? hosts[0];
if (!local) {
	throw new Error("No hosts returned by /api/hosts");
}

console.log(`[ws] local host: ${local.id} (${local.label})`);

const t0 = Date.now();
const deadline = setTimeout(() => {
	console.log(`[ws] overall timeout ${ms(t0)}`);
	process.exit(1);
}, 15_000);
let finished = false;

const key = randomBytes(16).toString("base64");
const hubTlsAgent = createHubTlsAgent(hubRuntime);
const req = request(`https://127.0.0.1:${port}/ws`, {
	agent: hubTlsAgent,
	headers: {
		Connection: "Upgrade",
		Upgrade: "websocket",
		"Sec-WebSocket-Key": key,
		"Sec-WebSocket-Version": "13",
	},
});

req.on("upgrade", (_, socket) => {
	console.log(`[ws] open ${ms(t0)} -> AUTH`);
	let buffer = Buffer.alloc(0);
	socket.on("data", (chunk: Buffer) => {
		buffer = Buffer.concat([buffer, chunk]);
		while (buffer.length >= 2) {
			const firstByte = buffer[0]!;
			let payloadLength = buffer[1]! & 0x7f;
			let offset = 2;
			if (payloadLength === 126) {
				if (buffer.length < 4) return;
				payloadLength = (buffer[2]! << 8) | buffer[3]!;
				offset = 4;
			} else if (payloadLength === 127) {
				if (buffer.length < 10) return;
				payloadLength = buffer.readUInt32BE(6);
				offset = 10;
			}
			if (buffer.length < offset + payloadLength) return;
			const payload = buffer.subarray(offset, offset + payloadLength);
			buffer = buffer.subarray(offset + payloadLength);
			if ((firstByte & 0x0f) !== 0x02) continue;

			const msg = decodeMessage(new Uint8Array(payload));
			if (msg.type === "STATE_SYNC" || msg.type === "SESSION_STATE" || msg.type === "CHANNEL_STATE") {
				console.log(`[ws] recv ${msg.type} ${ms(t0)}`);
				continue;
			}
			console.log(`[ws] recv ${msg.type} ${ms(t0)} ${JSON.stringify(msg).slice(0, 160)}`);
			if (msg.type === "AUTH_OK") {
				console.log(`[ws] -> SPAWN on ${local.id} ${ms(t0)}`);
				send(socket, { type: "SPAWN", hostId: local.id, cols: 80, rows: 24 } as UiSpawnMessage);
			} else if (msg.type === "SPAWN_OK") {
				console.log(`[ws] DONE: SPAWN_OK ${ms(t0)}`);
				finish(socket, 0);
			} else if (msg.type === "AUTH_FAIL" || msg.type === "ERROR") {
				console.log(`[ws] DONE: ${msg.type} ${ms(t0)}`);
				finish(socket, 1);
			}
		}
	});
	socket.on("close", () => {
		console.log(`[ws] close ${ms(t0)}`);
		if (!finished) finish(socket, 1);
	});
	send(socket, { type: "AUTH", token } as AuthMessage);
});
req.on("error", (error) => {
	console.log(`[ws] error ${ms(t0)}: ${error.message}`);
	finish(undefined, 1);
});
req.end();

function readToken(path: string): string {
	if (!existsSync(path)) {
		throw new Error(`Auth token file not found: ${path}`);
	}
	const raw = JSON.parse(readFileSync(path, "utf8")) as { token?: unknown };
	if (typeof raw.token !== "string" || raw.token.length === 0) {
		throw new Error(`Auth token file does not contain a token: ${path}`);
	}
	return raw.token;
}

async function readHosts(authToken: string): Promise<HostSummary[]> {
	const response = await requestHub(hubRuntime, "/api/hosts", {
		headers: { authorization: `Bearer ${authToken}` },
	});
	if (!response.ok) {
		throw new Error(`/api/hosts failed: ${response.status} ${response.statusText}`);
	}
	return (await response.json()) as HostSummary[];
}

function send(socket: NodeJS.WritableStream, msg: ProtocolMessage): void {
	const payload = Buffer.from(encodeMessage(msg));
	const header = payload.length < 126 ? [0x82, 0x80 | payload.length] : [0x82, 0x80 | 126, payload.length >> 8, payload.length & 0xff];
	const mask = randomBytes(4);
	const masked = Buffer.alloc(payload.length);
	for (let index = 0; index < payload.length; index++) masked[index] = payload[index]! ^ mask[index % 4]!;
	socket.write(Buffer.concat([Buffer.from(header), mask, masked]));
}

function finish(socket: NodeJS.WritableStream | undefined, code: number): void {
	if (finished) return;
	finished = true;
	clearTimeout(deadline);
	try {
		socket?.end();
		hubTlsAgent.destroy();
	} catch {
		// Ignore close errors while exiting the probe.
	}
	setTimeout(() => process.exit(code), 100);
}

function ms(start: number): string {
	return `+${Date.now() - start}ms`;
}
