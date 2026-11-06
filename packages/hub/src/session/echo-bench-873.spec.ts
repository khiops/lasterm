/**
 * TEMPORARY (#873), removed before merge: a keystroke's round trip through a
 * remote terminal's SSH connection, with Nagle on and off on the hub's socket.
 * The mock server's own socket has Nagle off, as OpenSSH writes each packet
 * at once, so only the hub's side differs. Prints its numbers; asserts none.
 */

import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import type net from "node:net";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
	encodeFrame,
	type HelloMessage,
	type Host,
	PROTOCOL_VERSION,
	type ProtocolMessage,
} from "@lasterm/shared";
import ssh2, { Client, Server } from "ssh2";
import { afterAll, describe, expect, it, vi } from "vitest";
import { HUB_VERSION } from "../build-version.js";
import { fingerprintOf } from "../ssh/fingerprint.js";
import { makeTempDir, removeTempDir } from "../temp-dir.fixture.js";
import { SshAgent } from "./ssh-agent.js";

const ROUNDS = 60;
const CHANNEL = "01K6000000000000000000C873";

function rsaPem(): string {
	return generateKeyPairSync("rsa", {
		modulusLength: 2048,
		publicKeyEncoding: { type: "pkcs1", format: "pem" },
		privateKeyEncoding: { type: "pkcs1", format: "pem" },
	}).privateKey;
}

const HOST_KEY = rsaPem();
const KEY_DIR = makeTempDir("lasterm-echo-bench-");
const CLIENT_KEY_PATH = join(KEY_DIR, "client.pem");
writeFileSync(CLIENT_KEY_PATH, rsaPem(), { mode: 0o600 });
afterAll(() => removeTempDir(KEY_DIR));

const HOST_FINGERPRINT = (() => {
	const parsed = ssh2.utils.parseKey(HOST_KEY);
	if (parsed instanceof Error) throw parsed;
	const key = Array.isArray(parsed) ? parsed[0] : parsed;
	return fingerprintOf(key.getPublicSSH());
})();

const HELLO: HelloMessage = {
	type: "HELLO",
	version: PROTOCOL_VERSION,
	agentVersion: HUB_VERSION,
	capabilities: ["multiplex", "snapshot", "resize"],
};

/** An agent that answers every chunk it reads with one OUTPUT frame, as a shell's echo. */
function echoServer(): Promise<{ server: Server; port: number }> {
	return new Promise((resolve) => {
		const server = new Server({ hostKeys: [HOST_KEY] }, (client) => {
			// As OpenSSH: each packet leaves in one write, never held by Nagle.
			(client as unknown as { setNoDelay(noDelay: boolean): void }).setNoDelay(true);
			client.on("error", () => {});
			client.on("authentication", (ctx) => ctx.accept());
			client.on("ready", () => {
				client.on("session", (accept) => {
					accept().on("exec", (acceptExec) => {
						const stream = acceptExec();
						stream.write(Buffer.from(encodeFrame(HELLO)));
						let seq = 0;
						stream.on("data", () => {
							const output: ProtocolMessage = {
								type: "OUTPUT",
								channelId: CHANNEL,
								seq: seq++,
								ts: new Date().toISOString(),
								data: new Uint8Array([0x61]),
							};
							stream.write(Buffer.from(encodeFrame(output)));
						});
					});
				});
			});
		});
		server.listen(0, "127.0.0.1", () =>
			resolve({ server, port: (server.address() as net.AddressInfo).port }),
		);
	});
}

function makeHost(port: number): Host {
	return {
		id: "01K6000000000000000000H873",
		type: "ssh",
		label: "bench",
		sshHost: "127.0.0.1",
		sshPort: port,
		sshAuth: "key",
		sshKeyPath: CLIENT_KEY_PATH,
		iconType: "auto",
		trustRemoteHints: "ignore",
		sortOrder: 0,
		os: "linux",
		arch: "x64",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
}

async function measure(nagleOff: boolean): Promise<number[]> {
	const { server, port } = await echoServer();
	if (!nagleOff) {
		vi.spyOn(Client.prototype, "setNoDelay").mockImplementation(function (this: Client) {
			return this;
		});
	}
	const agent = new SshAgent(makeHost(port));
	try {
		await agent.start(HOST_FINGERPRINT);
		// Let whatever the connection sends first settle.
		await new Promise((resolve) => setTimeout(resolve, 300));
		const times: number[] = [];
		for (let i = 0; i < ROUNDS; i++) {
			const answered = new Promise<void>((resolve) => {
				const on = (message: ProtocolMessage) => {
					if (message.type !== "OUTPUT") return;
					agent.off("message", on);
					resolve();
				};
				agent.on("message", on);
			});
			const started = performance.now();
			agent.send({ type: "INPUT", channelId: CHANNEL, data: new Uint8Array([0x61]) });
			await answered;
			times.push(performance.now() - started);
			// A typist's pace: the link is idle between keystrokes.
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		return times;
	} finally {
		vi.restoreAllMocks();
		agent.close();
		await new Promise<void>((done) => server.close(() => done()));
	}
}

function summary(times: number[]): string {
	const sorted = [...times].sort((a, b) => a - b);
	const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
	const mean = times.reduce((sum, t) => sum + t, 0) / times.length;
	return `mean ${mean.toFixed(2)} ms, median ${at(0.5).toFixed(2)} ms, p90 ${at(0.9).toFixed(2)} ms`;
}

describe("TEMPORARY #873: a keystroke's round trip over SSH", { timeout: 60_000 }, () => {
	it("with Nagle on, then off, on the hub's socket", async () => {
		const on = await measure(false);
		const off = await measure(true);
		console.log(`[echo-bench-873] ${process.platform} Nagle on : ${summary(on)}`);
		console.log(`[echo-bench-873] ${process.platform} Nagle off: ${summary(off)}`);
		expect(on).toHaveLength(ROUNDS);
		expect(off).toHaveLength(ROUNDS);
	});
});
