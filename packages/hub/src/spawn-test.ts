import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { request } from "node:https";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { ProtocolMessage } from "@lasterm/shared";
import { decodeMessage, encodeMessage } from "@lasterm/shared";
import { hubTlsOptions } from "./hub-transport.js";

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
const auth = JSON.parse(readFileSync(join(configDir, "auth.json"), "utf8"));
const hostId = process.argv[2] || "local";
const hubRuntime = {
	port: runtimePort,
	...(typeof runtime.spki === "string" ? { spki: runtime.spki } : {}),
};

const key = randomBytes(16).toString("base64");
const req = request(`https://127.0.0.1:${runtimePort}/ws`, {
	...hubTlsOptions(hubRuntime, stateDir),
	headers: {
		Connection: "Upgrade",
		Upgrade: "websocket",
		"Sec-WebSocket-Key": key,
		"Sec-WebSocket-Version": "13",
	},
});

req.on("upgrade", (_, socket) => {
	function sendWs(msg: ProtocolMessage) {
		const payload = Buffer.from(encodeMessage(msg));
		const header = [0x82];
		const mask = randomBytes(4);
		if (payload.length < 126) header.push(0x80 | payload.length);
		else header.push(0x80 | 126, (payload.length >> 8) & 0xff, payload.length & 0xff);
		const masked = Buffer.alloc(payload.length);
		// biome-ignore lint/style/noNonNullAssertion: Buffer indexed access within bounds guaranteed by loop condition
		for (let i = 0; i < payload.length; i++) masked[i] = payload[i]! ^ mask[i % 4]!;
		socket.write(Buffer.concat([Buffer.from(header), mask, masked]));
	}

	let buf = Buffer.alloc(0);
	socket.on("data", (chunk: Buffer) => {
		buf = Buffer.concat([buf, chunk]);
		while (buf.length >= 2) {
			// biome-ignore lint/style/noNonNullAssertion: buf.length >= 2 guarantees indices 0,1 exist
			const firstByte = buf[0]!;
			// biome-ignore lint/style/noNonNullAssertion: buf.length >= 2 guarantees indices 0,1 exist
			let payloadLen = buf[1]! & 0x7f;
			let offset = 2;
			if (payloadLen === 126) {
				if (buf.length < 4) return;
				// biome-ignore lint/style/noNonNullAssertion: buf.length >= 4 guaranteed by the check above
				payloadLen = (buf[2]! << 8) | buf[3]!;
				offset = 4;
			} else if (payloadLen === 127) {
				offset = 10;
				if (buf.length < 10) return;
				payloadLen = buf.readUInt32BE(6);
			}
			if (buf.length < offset + payloadLen) return;
			const payload = buf.subarray(offset, offset + payloadLen);
			buf = buf.subarray(offset + payloadLen);
			const opcode = firstByte & 0x0f;
			if (opcode === 0x02) {
				try {
					const msg = decodeMessage(new Uint8Array(payload));
					if (msg.type === "AUTH_OK") {
						console.log("AUTH_OK — sending SPAWN for", hostId);
						setTimeout(
							() => sendWs({ type: "SPAWN", hostId, cols: 80, rows: 24 } as ProtocolMessage),
							500,
						);
					} else if (msg.type === "SPAWN_OK") {
						console.log(
							"✅ SPAWN_OK! channelId:",
							(msg as import("@lasterm/shared").UiSpawnOkMessage).channelId,
						);
						socket.end();
						process.exit(0);
					} else if (msg.type === "SPAWN_ERR" || msg.type === "ERROR") {
						console.log("❌", msg.type, JSON.stringify(msg).slice(0, 300));
					} else if (
						msg.type !== "STATE_SYNC" &&
						msg.type !== "SESSION_STATE" &&
						msg.type !== "CHANNEL_STATE"
					) {
						console.log("←", msg.type);
					}
				} catch (e) {
					console.error("decode err:", (e as Error).message);
				}
			}
		}
	});
	sendWs({ type: "AUTH", token: auth.token } as ProtocolMessage);
});
req.on("error", (e) => {
	console.error("ERR:", e.message);
});
req.end();
setTimeout(() => {
	console.log("❌ Timeout 15s");
	process.exit(1);
}, 15000);
