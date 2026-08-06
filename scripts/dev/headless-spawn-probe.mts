#!/usr/bin/env -S pnpm exec tsx
import { existsSync, readFileSync } from "node:fs";
import { decodeMessage, encodeMessage } from "../../packages/shared/src/index.js";
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

const port = process.argv[2] ?? "4100";
const base = `http://127.0.0.1:${port}`;
const authPath =
	process.env.TT_AUTH ??
	`${process.env.XDG_CONFIG_HOME ?? `${process.env.HOME}/.config`}/lasterm/auth.json`;
const token = readToken(authPath);
const hosts = await readHosts(base, token);
const local = hosts.find((h) => h.type === "local") ?? hosts[0];
if (!local) {
	throw new Error("No hosts returned by /api/hosts");
}

console.log(`[ws] local host: ${local.id} (${local.label})`);

const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
ws.binaryType = "arraybuffer";

const t0 = Date.now();
const deadline = setTimeout(() => {
	console.log(`[ws] overall timeout ${ms(t0)}`);
	process.exit(1);
}, 15_000);
let finished = false;

ws.addEventListener("open", () => {
	console.log(`[ws] open ${ms(t0)} -> AUTH`);
	const authMessage: AuthMessage = { type: "AUTH", token };
	send(ws, authMessage);
});

ws.addEventListener("message", (ev) => {
	const msg = decodeMessage(eventDataToBytes(ev.data));
	if (msg.type === "STATE_SYNC" || msg.type === "SESSION_STATE" || msg.type === "CHANNEL_STATE") {
		console.log(`[ws] recv ${msg.type} ${ms(t0)}`);
		return;
	}

	console.log(`[ws] recv ${msg.type} ${ms(t0)} ${JSON.stringify(msg).slice(0, 160)}`);

	if (msg.type === "AUTH_OK") {
		const spawnMessage: UiSpawnMessage = {
			type: "SPAWN",
			hostId: local.id,
			cols: 80,
			rows: 24,
		};
		console.log(`[ws] -> SPAWN on ${local.id} ${ms(t0)}`);
		send(ws, spawnMessage);
		return;
	}

	if (msg.type === "SPAWN_OK") {
		console.log(`[ws] DONE: SPAWN_OK ${ms(t0)}`);
		finish(0);
		return;
	}

	if (msg.type === "AUTH_FAIL" || msg.type === "ERROR") {
		console.log(`[ws] DONE: ${msg.type} ${ms(t0)}`);
		finish(1);
	}
});

ws.addEventListener("error", () => {
	console.log(`[ws] error ${ms(t0)}`);
	finish(1);
});

ws.addEventListener("close", () => {
	console.log(`[ws] close ${ms(t0)}`);
	if (!finished) {
		finish(1);
	}
});

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

async function readHosts(baseUrl: string, authToken: string): Promise<HostSummary[]> {
	const response = await fetch(`${baseUrl}/api/hosts`, {
		headers: { authorization: `Bearer ${authToken}` },
	});
	if (!response.ok) {
		throw new Error(`/api/hosts failed: ${response.status} ${response.statusText}`);
	}
	return (await response.json()) as HostSummary[];
}

function send(ws: WebSocket, msg: ProtocolMessage): void {
	ws.send(encodeMessage(msg));
}

function eventDataToBytes(data: unknown): Uint8Array {
	if (data instanceof ArrayBuffer) {
		return new Uint8Array(data);
	}
	if (ArrayBuffer.isView(data)) {
		return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	}
	throw new Error(`Unexpected WebSocket payload type: ${typeof data}`);
}

function finish(code: number): void {
	if (finished) return;
	finished = true;
	clearTimeout(deadline);
	try {
		ws.close();
	} catch {
		// Ignore close errors while exiting the probe.
	}
	setTimeout(() => process.exit(code), 100);
}

function ms(start: number): string {
	return `+${Date.now() - start}ms`;
}
