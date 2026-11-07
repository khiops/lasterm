/**
 * TEMPORARY (#896), removed before merge: a keystroke's round trip through a
 * remote terminal's SSH connection, and the writes it takes on the hub's
 * socket, with each turn's writes gathered and without (cork made a no-op, as
 * before #896). Nagle is off on both sides, as since #873, the mock server's
 * as OpenSSH writes each packet at once. Prints its numbers; asserts none.
 */

import { generateKeyPairSync } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
	encodeFrame,
	type HelloMessage,
	type Host,
	PROTOCOL_VERSION,
	type ProtocolMessage,
} from "@lasterm/shared";
import ssh2, { Server } from "ssh2";
import { afterAll, describe, expect, it, vi } from "vitest";
import { HUB_VERSION } from "../build-version.js";
import { fingerprintOf } from "../ssh/fingerprint.js";
import { makeTempDir, removeTempDir } from "../temp-dir.fixture.js";
import { SshAgent } from "./ssh-agent.js";

const ROUNDS = 60;
const CHANNEL = "01K6000000000000000000C896";

function rsaPem(): string {
	return generateKeyPairSync("rsa", {
		modulusLength: 2048,
		publicKeyEncoding: { type: "pkcs1", format: "pem" },
		privateKeyEncoding: { type: "pkcs1", format: "pem" },
	}).privateKey;
}

const HOST_KEY = rsaPem();
const KEY_DIR = makeTempDir("lasterm-echo-bench-896-");
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
		id: "01K6000000000000000000H896",
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

interface Measured {
	times: number[];
	writes: number[];
}

async function measure(gathered: boolean): Promise<Measured> {
	const { server, port } = await echoServer();
	if (!gathered) {
		vi.spyOn(net.Socket.prototype, "cork").mockImplementation(() => {});
	}
	const counts = new Map<net.Socket, number>();
	const proto = net.Socket.prototype as unknown as Record<
		"_write" | "_writev",
		(...args: unknown[]) => void
	>;
	for (const method of ["_write", "_writev"] as const) {
		const original = proto[method];
		vi.spyOn(proto, method).mockImplementation(function (this: net.Socket, ...args: unknown[]) {
			counts.set(this, (counts.get(this) ?? 0) + 1);
			return Reflect.apply(original, this, args);
		});
	}
	const hubWrites = () => {
		let total = 0;
		for (const [socket, count] of counts) if (socket.remotePort === port) total += count;
		return total;
	};
	const agent = new SshAgent(makeHost(port));
	try {
		await agent.start(HOST_FINGERPRINT);
		// Let whatever the connection sends first settle.
		await new Promise((resolve) => setTimeout(resolve, 300));
		const times: number[] = [];
		const writes: number[] = [];
		for (let i = 0; i < ROUNDS; i++) {
			const answered = new Promise<void>((resolve) => {
				const on = (message: ProtocolMessage) => {
					if (message.type !== "OUTPUT") return;
					agent.off("message", on);
					resolve();
				};
				agent.on("message", on);
			});
			const before = hubWrites();
			const started = performance.now();
			agent.send({ type: "INPUT", channelId: CHANNEL, data: new Uint8Array([0x61]) });
			await answered;
			times.push(performance.now() - started);
			writes.push(hubWrites() - before);
			// A typist's pace: the link is idle between keystrokes.
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		return { times, writes };
	} finally {
		vi.restoreAllMocks();
		agent.close();
		await new Promise<void>((done) => server.close(() => done()));
	}
}

function summary({ times, writes }: Measured): string {
	const sorted = [...times].sort((a, b) => a - b);
	const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
	const mean = times.reduce((sum, t) => sum + t, 0) / times.length;
	const perKey = writes.reduce((sum, n) => sum + n, 0) / writes.length;
	return `mean ${mean.toFixed(2)} ms, median ${at(0.5).toFixed(2)} ms, p90 ${at(0.9).toFixed(2)} ms, hub writes per keystroke ${perKey.toFixed(2)}`;
}

describe("TEMPORARY #896: a keystroke's round trip over SSH", { timeout: 60_000 }, () => {
	it("without and with each turn's writes gathered, twice each", async () => {
		const runs: Array<[string, Measured]> = [];
		for (const pass of [1, 2]) {
			runs.push([`pass ${pass} not gathered`, await measure(false)]);
			runs.push([`pass ${pass} gathered    `, await measure(true)]);
		}
		for (const [label, measured] of runs) {
			const line = `[echo-bench-896] ${process.platform} ${label}: ${summary(measured)}`;
			console.log(line);
			// The job's summary keeps it whatever the reporter shows of a passing test.
			const stepSummary = process.env.GITHUB_STEP_SUMMARY;
			if (stepSummary) appendFileSync(stepSummary, `    ${line}\n`);
			expect(measured.times).toHaveLength(ROUNDS);
		}
	});
});
